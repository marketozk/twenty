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
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';

const EVENT = 'calendarEvent';
const ASSOCIATION = 'calendarChannelEventAssociation';
const PARTICIPANT = 'calendarEventParticipant';
const TARGET = 'calendarEventTarget';
const RECORDING = 'callRecording';
const TABLES = [EVENT, ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const;
const DELETED_TABLES = [EVENT, ASSOCIATION, PARTICIPANT, TARGET] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type NativeCalendarEventCleanupScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0] & {
  getRepository: (
    name: string,
    permissions: { shouldBypassPermissionChecks: true },
  ) => {
    delete: (
      ids: string[],
      options: { columnsToReturn: string[] },
    ) => Promise<{ raw: unknown; affected?: number | null }>;
  };
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const table = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);
const eventId = (name: Table, row: Snapshot): string => {
  if (name === EVENT) return row.id;
  const value: unknown = JSON.parse(String(row.calendarEventId));
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Native orphan calendar cleanup invalid event reference');
  return value;
};
export type NativeCalendarEventCleanupResult = {
  deletedEventIds: string[];
  deletedAssociationIds: string[];
  deletedParticipantIds: string[];
  deletedTargetIds: string[];
  updatedCallRecordingIds: string[];
};

// Terminal owner: callers must propagate failure and perform no further graph writes in this transaction.
export const deleteOrphanNativeCalendarEventsWithAudit = async ({
  scope,
  operation,
  candidateEventIds,
}: {
  scope: NativeCalendarEventCleanupScope;
  operation: CrmAuditOperation;
  candidateEventIds: readonly string[];
}): Promise<NativeCalendarEventCleanupResult> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateEventIds) ||
    candidateEventIds.length > 500 ||
    candidateEventIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native orphan calendar cleanup requires bounded scoped system authority',
    );
  const ids = Object.freeze(
    [...new Set(candidateEventIds.map((id) => id.toLowerCase()))].sort(),
  );
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
        metadata.universalIdentifier ===
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
        metadata.applicationUniversalIdentifier ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
        metadata.workspaceId === scope.workspaceId &&
        !metadata.isRemote,
    );
    if (candidates.length !== 1)
      throw new Error(
        'Native orphan calendar cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native orphan calendar cleanup table metadata mismatch');
    shapes.set(name, shape);
  }
  if (new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1)
    throw new Error('Native orphan calendar cleanup schema mismatch');
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
    throw new Error('Native orphan calendar cleanup requires active workspace');
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...shapes.values()].map(table).sort().join(',') +
      ' IN ROW EXCLUSIVE MODE',
  );
  const referencesByTable = new Map<
    Table,
    Awaited<ReturnType<typeof getIncomingRecordForeignKeys>>
  >();
  for (const name of TABLES) {
    const shape = shapes.get(name)!;
    referencesByTable.set(
      name,
      await getIncomingRecordForeignKeys(
        scope,
        shape.schemaName,
        shape.tableName,
      ),
    );
  }
  const expectedEventReference = (
    reference: Awaited<ReturnType<typeof getIncomingRecordForeignKeys>>[number],
    name: Exclude<Table, typeof EVENT>,
  ) =>
    reference.schemaName === shapes.get(name)!.schemaName &&
    reference.tableName === shapes.get(name)!.tableName &&
    canonicalAuditJson(reference.parentColumns) === '["id"]' &&
    canonicalAuditJson(reference.childColumns) === '["calendarEventId"]' &&
    reference.deleteAction === (name === RECORDING ? 'n' : 'c');
  for (const name of [ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const)
    if (
      !referencesByTable
        .get(EVENT)!
        .some((reference) => expectedEventReference(reference, name))
    )
      throw new Error(
        'Native orphan calendar cleanup requires expected foreign keys',
      );
  const before = new Map<Table, Snapshot[]>();
  const read = async (name: Table, lock = false): Promise<Snapshot[]> => {
    const shape = shapes.get(name)!;
    const parentColumn = name === EVENT ? 'id' : 'calendarEventId';
    const originalIds = before.get(name)?.map((row) => row.id) ?? [];
    const currentIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(shape) +
          ' WHERE ' +
          quote(parentColumn) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
          (lock ? ' FOR UPDATE' : ''),
        [ids, originalIds],
      )
    ).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native orphan calendar cleanup invalid record identity',
        );
      return row.id;
    });
    // This read follows the row lock. A concurrent reparent-away is no longer a child and is not a claimed effect.
    const snapshots = await readNativeCrmAuditRows(sql, shape, currentIds);
    if (snapshots.length !== currentIds.length)
      throw new Error('Native orphan calendar cleanup graph changed');
    return snapshots;
  };
  for (const name of TABLES) before.set(name, await read(name, true));
  const blocked = new Set(
    before
      .get(ASSOCIATION)!
      .filter((row) => JSON.parse(String(row.deletedAt)) === null)
      .map((row) => eventId(ASSOCIATION, row)),
  );
  // Candidate API preserves legacy behavior: an explicitly supplied tombstoned Event can be deleted.
  const selectedIds = before
    .get(EVENT)!
    .filter((row) => !blocked.has(row.id))
    .map((row) => row.id);
  const selected = new Set(selectedIds);
  for (const name of DELETED_TABLES) {
    const shape = shapes.get(name)!;
    const records = before
      .get(name)!
      .filter((row) => selected.has(eventId(name, row)));
    assertNativeCrmDeleteFilesEmpty(shape, records);
    for (const reference of referencesByTable.get(name)!) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      if (
        name === EVENT &&
        ([ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const).some((child) =>
          expectedEventReference(reference, child),
        )
      )
        continue;
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
              table(shape) +
              ' parent ON ' +
              predicate +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [records.map((row) => row.id)],
          )
        ).length
      )
        throw new Error(
          'Native orphan calendar cleanup excludes unsupported cascade effects',
        );
    }
  }
  const recordingShape = shapes.get(RECORDING)!;
  const selectedRecordingIds = before
    .get(RECORDING)!
    .filter((row) => selected.has(eventId(RECORDING, row)))
    .map((row) => row.id);
  // FK SET NULL bypasses the ordinary repository UPDATE kernel; explicitly guard its downstream UPDATE effects.
  if (selectedRecordingIds.length)
    await assertNoReferentialUpdateEffects(
      sql,
      {
        kind: 'update',
        alias: 'audit_recording',
        tableShape: recordingShape,
        setClauses: [
          { columnName: 'calendarEventId', valueExpression: 'NULL' },
        ],
      },
      {},
      '"audit_recording"."id"=ANY($1::uuid[])',
      (text) => ({ text, values: [selectedRecordingIds] }),
    );
  const actualIds = new Set<string>();
  if (selectedIds.length) {
    const result = await scope
      .getRepository(EVENT, { shouldBypassPermissionChecks: true })
      .delete(selectedIds, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !selected.has(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native orphan calendar cleanup returned unexpected records',
      );
    for (const row of returned) actualIds.add(row.id);
  }
  const deleted = new Map<(typeof DELETED_TABLES)[number], Snapshot[]>();
  for (const name of DELETED_TABLES)
    deleted.set(
      name,
      before.get(name)!.filter((row) => actualIds.has(eventId(name, row))),
    );
  const changedRecordingIds = new Set(
    before
      .get(RECORDING)!
      .filter((row) => actualIds.has(eventId(RECORDING, row)))
      .map((row) => row.id),
  );
  const expectedRecordings = before
    .get(RECORDING)!
    .map((row) =>
      changedRecordingIds.has(row.id)
        ? { ...row, calendarEventId: 'null' }
        : row,
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
        'Native orphan calendar cleanup workspace changed before commit',
      );
    for (const name of TABLES) {
      const expected =
        name === RECORDING
          ? expectedRecordings
          : before
              .get(name)!
              .filter((row) => !actualIds.has(eventId(name, row)));
      if (canonicalAuditJson(await read(name)) !== canonicalAuditJson(expected))
        throw new Error('Native orphan calendar cleanup effects mismatch');
    }
  };
  await verify();
  for (const name of DELETED_TABLES) {
    const shape = shapes.get(name)!;
    for (const row of deleted.get(name)!)
      audit.record({
        resourceKind: 'crmRecord',
        resourceId: row.id,
        action: 'delete',
        before: captureNativeCrmAuditSnapshot(shape, row),
        after: null,
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: row.id,
          objectMetadataId: shape.objectMetadataId,
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        },
      });
  }
  for (const row of before
    .get(RECORDING)!
    .filter((row) => changedRecordingIds.has(row.id)))
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'update',
      before: captureNativeCrmAuditSnapshot(recordingShape, row),
      after: captureNativeCrmAuditSnapshot(recordingShape, {
        ...row,
        calendarEventId: 'null',
      }),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: recordingShape.objectMetadataId,
      },
    });
  await audit.flush();
  await scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  await verify();
  return {
    deletedEventIds: [...actualIds].sort(),
    deletedAssociationIds: deleted.get(ASSOCIATION)!.map((row) => row.id),
    deletedParticipantIds: deleted.get(PARTICIPANT)!.map((row) => row.id),
    deletedTargetIds: deleted.get(TARGET)!.map((row) => row.id),
    updatedCallRecordingIds: [...changedRecordingIds].sort(),
  };
};
