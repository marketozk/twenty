import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  assertNativeCrmDeleteFilesEmpty,
  captureNativeCrmAuditSnapshot,
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import {
  computeTargetReconciliationOperations,
  type ExistingTarget,
  type TargetIdentity,
} from 'src/modules/match-participant/utils/compute-target-reconciliation-operations.util';
import { findOmniNativeWriteOwnedRecords } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';

const TARGET_RECONCILIATION_PAGE_SIZE = 200;
const THREAD = 'messageThread';
const MESSAGE = 'message';
const PARTICIPANT = 'messageParticipant';
const PERSON = 'person';
const COMPANY = 'company';
const OPPORTUNITY = 'opportunity';
const TARGET = 'messageThreadTarget';
const SOURCES = [
  THREAD,
  MESSAGE,
  PARTICIPANT,
  PERSON,
  COMPANY,
  OPPORTUNITY,
] as const;
const TABLES = [...SOURCES, TARGET] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type TargetReconciliationScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0] & {
  getRepository: (
    name: string,
    permissions: { shouldBypassPermissionChecks: true },
  ) => {
    insert: (
      records: Record<string, unknown>[],
      options: { onConflictDoNothing: true },
    ) => Promise<{ raw: unknown }>;
    updateMany: (
      inputs: {
        criteria: string;
        partialEntity: { isAutomaticallyAssigned: boolean };
      }[],
    ) => Promise<{ raw: unknown; affected?: number | null }>;
    delete: (
      ids: string[],
      options: { columnsToReturn: string[] },
    ) => Promise<{ raw: unknown; affected?: number | null }>;
  };
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const tableExpression = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);
const decode = (row: Snapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'id' ? value : JSON.parse(String(value)),
    ]),
  );
const referenceIds = (rows: Snapshot[], column: string) => [
  ...new Set(
    rows.flatMap((row) => {
      const value = decode(row)[column];
      if (value === null) return [];
      if (typeof value !== 'string' || !isUUID(value))
        throw new Error(
          'Native target reconciliation invalid source reference',
        );
      return [value.toLowerCase()];
    }),
  ),
];

// Terminal mutation: callers must propagate failures and preserve the verified sources and targets.
export const reconcileNativeMessageThreadTargetsWithAudit = async ({
  scope,
  candidateThreadIds,
  operation,
}: {
  scope: TargetReconciliationScope;
  candidateThreadIds: readonly string[];
  operation: CrmAuditOperation;
}): Promise<{
  createdTargetIds: string[];
  updatedTargetIds: string[];
  deletedTargetIds: string[];
}> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateThreadIds) ||
    candidateThreadIds.length > 500 ||
    candidateThreadIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native target reconciliation requires bounded scoped system authority',
    );
  const ids = [
    ...new Set(candidateThreadIds.map((id) => id.toLowerCase())),
  ].sort();
  const capturedOperation = {
    ...operation,
    operationId: randomUUID(),
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const audit = new CrmAuditTransactionContext(
    createCrmAuditWorkspaceExecutor(scope),
    capturedOperation,
  );
  const shapes = new Map<Table, NativeCrmAuditTableShape>();
  for (const name of TABLES) {
    const candidates = context.objects.filter(
      ({ metadata }) =>
        metadata.nameSingular === name &&
        metadata.workspaceId === scope.workspaceId &&
        !metadata.isRemote &&
        metadata.universalIdentifier ===
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
        metadata.applicationUniversalIdentifier ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
    );
    if (candidates.length !== 1)
      throw new Error(
        'Native target reconciliation requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native target reconciliation table metadata mismatch');
    shapes.set(name, shape);
  }
  const targetShape = shapes.get(TARGET)!;
  if (
    [...shapes.values()].some(
      (shape) => shape.schemaName !== targetShape.schemaName,
    )
  )
    throw new Error('Native target reconciliation schema mismatch');
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
  const [workspace] = await scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
    [scope.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error('Native target reconciliation requires active workspace');
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...shapes.values()].map(tableExpression).sort().join(',') +
      ' IN ROW EXCLUSIVE MODE',
  );
  const references = new Map<
    Table,
    Awaited<ReturnType<typeof getIncomingRecordForeignKeys>>
  >();
  for (const name of TABLES) {
    const shape = shapes.get(name)!;
    references.set(
      name,
      await getIncomingRecordForeignKeys(
        scope,
        shape.schemaName,
        shape.tableName,
      ),
    );
  }
  const requiredReferences: { parent: Table; child: Table; column: string }[] =
    [
      { parent: THREAD, child: MESSAGE, column: 'messageThreadId' },
      { parent: MESSAGE, child: PARTICIPANT, column: 'messageId' },
      { parent: PERSON, child: PARTICIPANT, column: 'personId' },
      { parent: COMPANY, child: PERSON, column: 'companyId' },
      { parent: PERSON, child: OPPORTUNITY, column: 'pointOfContactId' },
      { parent: THREAD, child: TARGET, column: 'messageThreadId' },
      { parent: PERSON, child: TARGET, column: 'targetPersonId' },
      { parent: COMPANY, child: TARGET, column: 'targetCompanyId' },
      { parent: OPPORTUNITY, child: TARGET, column: 'targetOpportunityId' },
    ];
  for (const required of requiredReferences) {
    if (
      !references
        .get(required.parent)!
        .some(
          (reference) =>
            reference.schemaName === targetShape.schemaName &&
            reference.tableName === required.child &&
            canonicalAuditJson(reference.parentColumns) === '["id"]' &&
            canonicalAuditJson(reference.childColumns) ===
              canonicalAuditJson([required.column]),
        )
    )
      throw new Error(
        'Native target reconciliation requires expected foreign keys',
      );
  }
  const before = new Map<Table, Snapshot[]>();
  const proposedCreateIds: string[] = [];
  const read = async (name: Table, lock = false): Promise<Snapshot[]> => {
    let column = 'id';
    let parentIds = ids;
    if (name === MESSAGE || name === TARGET) column = 'messageThreadId';
    if (name === PARTICIPANT) {
      column = 'messageId';
      parentIds = before.get(MESSAGE)!.map((row) => row.id);
    }
    if (name === PERSON)
      parentIds = referenceIds(before.get(PARTICIPANT)!, 'personId');
    if (name === COMPANY)
      parentIds = referenceIds(before.get(PERSON)!, 'companyId');
    if (name === OPPORTUNITY) {
      column = 'pointOfContactId';
      parentIds = before.get(PERSON)!.map((row) => row.id);
    }
    const originalIds = [
      ...(before.get(name)?.map((row) => row.id) ?? []),
      ...(name === TARGET ? proposedCreateIds : []),
    ];
    // Company is read-only: SHARE freezes it without blocking an Opportunity FK's KEY SHARE.
    const rowLock = name === COMPANY ? ' FOR SHARE' : ' FOR UPDATE';
    const rows = await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(shapes.get(name)!) +
        ' WHERE ' +
        quote(column) +
        '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
        (lock ? rowLock : ''),
      [parentIds, originalIds],
    );
    const rowIds = rows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Native target reconciliation invalid record identity');
      return row.id;
    });
    const snapshots = await readNativeCrmAuditRows(
      sql,
      shapes.get(name)!,
      rowIds,
    );
    if (snapshots.length !== rowIds.length)
      throw new Error('Native target reconciliation graph changed');
    return snapshots;
  };
  for (const name of TABLES) before.set(name, await read(name, true));
  // Missing FK parents cannot be fenced against a later insertion repairing old invalid data.
  for (const [name, referencedIds] of [
    [PERSON, referenceIds(before.get(PARTICIPANT)!, 'personId')],
    [COMPANY, referenceIds(before.get(PERSON)!, 'companyId')],
  ] as const) {
    const found = new Set(before.get(name)!.map((row) => row.id));
    if (referencedIds.some((id) => !found.has(id)))
      throw new Error('Native target reconciliation missing source parent');
  }
  const ownedThreads = new Set(
    (
      await findOmniNativeWriteOwnedRecords(
        scope,
        scope.workspaceId,
        THREAD,
        before.get(THREAD)!.map(decode),
      )
    ).map((row) => String(row.id)),
  );
  const selectedThreads = new Set(
    before
      .get(THREAD)!
      .filter(
        (row) => decode(row).deletedAt === null && !ownedThreads.has(row.id),
      )
      .map((row) => row.id),
  );
  const liveMessages = new Map(
    before
      .get(MESSAGE)!
      .map(decode)
      .filter(
        (row) =>
          row.deletedAt === null &&
          selectedThreads.has(String(row.messageThreadId)),
      )
      .map((row) => [String(row.id), String(row.messageThreadId)]),
  );
  const livePeople = new Map(
    before
      .get(PERSON)!
      .map(decode)
      .filter((row) => row.deletedAt === null)
      .map((row) => [String(row.id), row]),
  );
  const opportunitiesByPerson = new Map<string, string[]>();
  for (const row of before.get(OPPORTUNITY)!.map(decode)) {
    if (row.deletedAt !== null) continue;
    const personId = String(row.pointOfContactId);
    opportunitiesByPerson.set(personId, [
      ...(opportunitiesByPerson.get(personId) ?? []),
      String(row.id),
    ]);
  }
  const desiredTargets: TargetIdentity[] = [];
  for (const row of before.get(PARTICIPANT)!.map(decode)) {
    const parentId = liveMessages.get(String(row.messageId));
    const person = livePeople.get(String(row.personId));
    if (row.deletedAt !== null || !parentId || !person) continue;
    desiredTargets.push({
      parentId,
      targetPersonId: String(person.id),
      targetCompanyId: null,
      targetOpportunityId: null,
    });
    // Existing policy keeps a company link even when that company is soft-deleted.
    if (person.companyId !== null)
      desiredTargets.push({
        parentId,
        targetPersonId: null,
        targetCompanyId: String(person.companyId),
        targetOpportunityId: null,
      });
    for (const opportunityId of opportunitiesByPerson.get(String(person.id)) ??
      [])
      desiredTargets.push({
        parentId,
        targetPersonId: null,
        targetCompanyId: null,
        targetOpportunityId: opportunityId,
      });
  }
  const existingTargets: ExistingTarget[] = before
    .get(TARGET)!
    .map(decode)
    .filter((row) => selectedThreads.has(String(row.messageThreadId)))
    .map((row) => {
      if (
        typeof row.isAutomaticallyAssigned !== 'boolean' ||
        typeof row.isManuallyAssigned !== 'boolean'
      )
        throw new Error(
          'Native target reconciliation invalid assignment flags',
        );
      const nullableId = (value: unknown) => {
        if (value === null) return null;
        if (typeof value !== 'string' || !isUUID(value))
          throw new Error(
            'Native target reconciliation invalid target reference',
          );
        return value;
      };
      return {
        id: String(row.id),
        parentId: String(row.messageThreadId),
        targetPersonId: nullableId(row.targetPersonId),
        targetCompanyId: nullableId(row.targetCompanyId),
        targetOpportunityId: nullableId(row.targetOpportunityId),
        deletedAt: row.deletedAt === null ? null : String(row.deletedAt),
        isAutomaticallyAssigned: row.isAutomaticallyAssigned,
        isManuallyAssigned: row.isManuallyAssigned,
      };
    });
  const operations = computeTargetReconciliationOperations({
    desiredTargets,
    existingTargets,
  });
  const proposedCreates = operations.targetsToCreate.map(
    ({ parentId, ...target }) => ({
      id: randomUUID(),
      ...target,
      messageThreadId: parentId,
      isAutomaticallyAssigned: true,
      isManuallyAssigned: false,
    }),
  );
  proposedCreateIds.push(...proposedCreates.map((row) => row.id));
  const proposedById = new Map<string, (typeof proposedCreates)[number]>(
    proposedCreates.map((row) => [row.id, row]),
  );
  const targetBeforeById = new Map(
    before.get(TARGET)!.map((row) => [row.id, row]),
  );
  const deleteSet = new Set(operations.targetIdsToDelete);
  assertNativeCrmDeleteFilesEmpty(
    targetShape,
    before.get(TARGET)!.filter((row) => deleteSet.has(row.id)),
  );
  for (const reference of references.get(TARGET)!) {
    if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
    const predicate = reference.childColumns
      .map(
        (column, index) =>
          'child.' +
          quote(column) +
          '=parent.' +
          quote(reference.parentColumns[index]),
      )
      .join(' AND ');
    if (
      (
        await scope.executeRawQuery(
          'SELECT 1 FROM ' +
            quote(reference.schemaName) +
            '.' +
            quote(reference.tableName) +
            ' child JOIN ' +
            tableExpression(targetShape) +
            ' parent ON ' +
            predicate +
            ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
          [operations.targetIdsToDelete],
        )
      ).length
    )
      throw new Error(
        'Native target reconciliation excludes unsupported cascade effects',
      );
  }
  const repository = scope.getRepository(TARGET, {
    shouldBypassPermissionChecks: true,
  });
  const created = new Set<string>();
  const updated = new Map<string, boolean>();
  const deleted = new Set<string>();
  const returnedIds = (
    result: { raw: unknown; affected?: number | null },
    allowed: Set<string>,
    checkAffected: boolean,
  ): string[] => {
    const rows = result.raw;
    if (
      !Array.isArray(rows) ||
      (checkAffected && result.affected !== rows.length) ||
      rows.some(
        (row) => !row || typeof row.id !== 'string' || !allowed.has(row.id),
      ) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw new Error(
        'Native target reconciliation returned unexpected records',
      );
    return rows.map((row) => row.id);
  };
  for (
    let offset = 0;
    offset < proposedCreates.length;
    offset += TARGET_RECONCILIATION_PAGE_SIZE
  ) {
    const page = proposedCreates.slice(
      offset,
      offset + TARGET_RECONCILIATION_PAGE_SIZE,
    );
    const result = await repository.insert(page, { onConflictDoNothing: true });
    for (const id of returnedIds(
      result,
      new Set(page.map((row) => row.id)),
      false,
    ))
      created.add(id);
  }
  for (const [targetIds, automatic] of [
    [operations.targetsToMarkAutomatic, true],
    [operations.targetsToMarkNotAutomatic, false],
  ] as const) {
    for (
      let offset = 0;
      offset < targetIds.length;
      offset += TARGET_RECONCILIATION_PAGE_SIZE
    ) {
      const page = targetIds.slice(
        offset,
        offset + TARGET_RECONCILIATION_PAGE_SIZE,
      );
      await assertNoReferentialUpdateEffects(
        sql,
        {
          kind: 'update',
          alias: 'audit_target',
          tableShape: targetShape,
          setClauses: [
            {
              columnName: 'isAutomaticallyAssigned',
              valueExpression: automatic ? 'TRUE' : 'FALSE',
            },
            ...(targetShape.columnShapeByColumnName.updatedAt
              ? [
                  {
                    columnName: 'updatedAt',
                    valueExpression: 'CURRENT_TIMESTAMP',
                  },
                ]
              : []),
          ],
        },
        {},
        '"audit_target"."id"=ANY($1::uuid[])',
        (text) => ({ text, values: [page] }),
      );
      const result = await repository.updateMany(
        page.map((id) => ({
          criteria: id,
          partialEntity: { isAutomaticallyAssigned: automatic },
        })),
      );
      for (const id of returnedIds(result, new Set(page), true))
        updated.set(id, automatic);
    }
  }
  for (
    let offset = 0;
    offset < operations.targetIdsToDelete.length;
    offset += TARGET_RECONCILIATION_PAGE_SIZE
  ) {
    const page = operations.targetIdsToDelete.slice(
      offset,
      offset + TARGET_RECONCILIATION_PAGE_SIZE,
    );
    const result = await repository.delete(page, { columnsToReturn: ['id'] });
    for (const id of returnedIds(result, new Set(page), true)) deleted.add(id);
  }
  if (
    targetShape.columnShapeByColumnName.updatedAt &&
    updated.size &&
    (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          tableExpression(targetShape) +
          ' WHERE id=ANY($1::uuid[]) AND "updatedAt" IS DISTINCT FROM CURRENT_TIMESTAMP LIMIT 1',
        [[...updated.keys()]],
      )
    ).length
  )
    throw new Error('Native target reconciliation unexpected update timestamp');
  const afterTargets = await read(TARGET);
  const afterById = new Map(afterTargets.map((row) => [row.id, row]));
  for (const row of before.get(TARGET)!) {
    const actual = afterById.get(row.id);
    if (deleted.has(row.id)) {
      if (actual)
        throw new Error('Native target reconciliation effects mismatch');
      continue;
    }
    if (!actual)
      throw new Error('Native target reconciliation effects mismatch');
    const expected = { ...row };
    if (updated.has(row.id)) {
      expected.isAutomaticallyAssigned = JSON.stringify(updated.get(row.id));
      if (targetShape.columnShapeByColumnName.updatedAt)
        expected.updatedAt = actual.updatedAt;
    }
    if (canonicalAuditJson(actual) !== canonicalAuditJson(expected))
      throw new Error('Native target reconciliation effects mismatch');
  }
  for (const row of afterTargets) {
    if (targetBeforeById.has(row.id)) continue;
    const proposed = proposedById.get(row.id);
    const actual = decode(row);
    if (
      !created.has(row.id) ||
      !proposed ||
      actual.deletedAt !== null ||
      Object.entries(proposed).some(([key, value]) => actual[key] !== value)
    )
      throw new Error('Native target reconciliation effects mismatch');
  }
  if ([...created].some((id) => !afterById.has(id)))
    throw new Error('Native target reconciliation effects mismatch');
  const changedBefore = [...updated.keys(), ...deleted].map(
    (id) => targetBeforeById.get(id)!,
  );
  const changedAfter = [...created, ...updated.keys()].map(
    (id) => afterById.get(id)!,
  );
  const verify = async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error(
        'Native target reconciliation workspace changed before commit',
      );
    for (const name of SOURCES)
      if (
        canonicalAuditJson(await read(name)) !==
        canonicalAuditJson(before.get(name)!)
      )
        throw new Error('Native target reconciliation sources changed');
    if (
      canonicalAuditJson(await read(TARGET)) !==
      canonicalAuditJson(afterTargets)
    )
      throw new Error('Native target reconciliation effects mismatch');
    if (
      (
        await findOmniNativeWriteOwnedRecords(
          scope,
          scope.workspaceId,
          TARGET,
          [...changedBefore, ...changedAfter].map(decode),
        )
      ).length
    )
      throw new Error(
        'Native target reconciliation ownership changed before commit',
      );
  };
  await verify();
  const snapshot = (row: Snapshot) =>
    captureNativeCrmAuditSnapshot(targetShape, row);
  for (const id of created)
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: id,
      action: 'create',
      before: null,
      after: snapshot(afterById.get(id)!),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: id,
        objectMetadataId: targetShape.objectMetadataId,
      },
    });
  for (const id of updated.keys())
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: id,
      action: 'update',
      before: snapshot(targetBeforeById.get(id)!),
      after: snapshot(afterById.get(id)!),
      ...(targetShape.columnShapeByColumnName.updatedAt
        ? {
            implicitUpdatedAtFieldId:
              targetShape.columnShapeByColumnName.updatedAt.fieldMetadataId,
          }
        : {}),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: id,
        objectMetadataId: targetShape.objectMetadataId,
      },
    });
  for (const id of deleted)
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: id,
      action: 'delete',
      before: snapshot(targetBeforeById.get(id)!),
      after: null,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: id,
        objectMetadataId: targetShape.objectMetadataId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  await audit.flush();
  await scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  await verify();
  return {
    createdTargetIds: [...created].sort(),
    updatedTargetIds: [...updated.keys()].sort(),
    deletedTargetIds: [...deleted].sort(),
  };
};
