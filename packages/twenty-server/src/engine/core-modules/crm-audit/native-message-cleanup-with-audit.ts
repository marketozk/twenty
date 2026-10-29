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

type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type NativeDeleteCleanupScope = Parameters<
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

const MESSAGE_PAGE_SIZE = 500;
const EMPTY_THREAD_TABLES = [
  'messageThread',
  'messageThreadTarget',
  'messageChannelMessageAssociation',
  'messageChannelMessageAssociationMessageFolder',
  'message',
] as const;
const ORPHAN_MESSAGE_TABLES = [
  'message',
  'messageParticipant',
  'messageChannelMessageAssociation',
] as const;
const TARGET_RECONCILIATION_TABLES = [
  'messageThread',
  'message',
  'messageParticipant',
  'person',
  'company',
  'opportunity',
  'messageThreadTarget',
] as const;
type CleanupTableName =
  | (typeof EMPTY_THREAD_TABLES)[number]
  | (typeof ORPHAN_MESSAGE_TABLES)[number]
  | (typeof TARGET_RECONCILIATION_TABLES)[number];
type CleanupSession<TScope extends NativeDeleteCleanupScope> = {
  scope: TScope;
  operation: CrmAuditOperation;
  audit: CrmAuditTransactionContext;
  validators: (() => Promise<void>)[];
  shapes: Map<CleanupTableName, NativeCrmAuditTableShape>;
  actualDeletedThreadIds: Set<string>;
};

const captureCandidates = (
  ids: readonly string[],
  prefix: string,
): readonly string[] => {
  if (
    !Array.isArray(ids) ||
    ids.length > MESSAGE_PAGE_SIZE ||
    ids.some((id) => !isUUID(id))
  )
    throw new Error(prefix + ' requires bounded scoped system authority');
  return Object.freeze([...new Set(ids.map((id) => id.toLowerCase()))].sort());
};

const createSession = <TScope extends NativeDeleteCleanupScope>(
  scope: TScope,
  operation: CrmAuditOperation,
  names: readonly CleanupTableName[],
): CleanupSession<TScope> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native message cleanup requires bounded scoped system authority',
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
  const shapes = new Map<CleanupTableName, NativeCrmAuditTableShape>();
  for (const name of [...new Set(names)]) {
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
        'Native message cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native message cleanup table metadata mismatch');
    shapes.set(name, shape);
  }
  if (new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1)
    throw new Error('Native message cleanup schema mismatch');
  return {
    scope,
    operation: capturedOperation,
    audit,
    validators: [],
    shapes,
    actualDeletedThreadIds: new Set(),
  };
};

const prepareSession = async <TScope extends NativeDeleteCleanupScope>(
  session: CleanupSession<TScope>,
) => {
  const { scope } = session;
  await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
  const [workspace] = await scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
    [scope.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error('Native message cleanup requires active workspace');
  // Every stage uses the same DDL lock order before any graph mutation or row lock.
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...session.shapes.values()].map(tableExpression).sort().join(',') +
      ' IN ROW EXCLUSIVE MODE',
  );
  session.validators.push(async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error('Native message cleanup workspace changed before commit');
  });
};

const finalizeSession = async <TScope extends NativeDeleteCleanupScope>(
  session: CleanupSession<TScope>,
) => {
  for (const verify of session.validators) await verify();
  await session.audit.flush();
  await session.scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  for (const verify of session.validators) await verify();
};

const deleteEmptyThreadsStage = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  candidateThreadIds: readonly string[],
): Promise<{ deletedThreadIds: string[]; deletedTargetIds: string[] }> => {
  const { scope, audit } = session;
  const THREAD = 'messageThread';
  const TARGET = 'messageThreadTarget';
  const ASSOCIATION = 'messageChannelMessageAssociation';
  const JUNCTION = 'messageChannelMessageAssociationMessageFolder';
  const MESSAGE = 'message';
  const TABLES = [THREAD, TARGET, ASSOCIATION, JUNCTION] as const;
  type Table = (typeof TABLES)[number];
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateThreadIds) ||
    candidateThreadIds.length > 500 ||
    candidateThreadIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    session.operation.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native empty-thread cleanup requires bounded scoped system authority',
    );
  const ids = [
    ...new Set(candidateThreadIds.map((id) => id.toLowerCase())),
  ].sort();
  const shapeFor = (name: Table | typeof MESSAGE) => {
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
        'Native empty-thread cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native empty-thread cleanup table metadata mismatch');
    return shape;
  };
  const shapes = new Map<Table, NativeCrmAuditTableShape>(
    TABLES.map((name) => [name, shapeFor(name)]),
  );
  const messageShape = shapeFor(MESSAGE);
  if (
    [...shapes.values()].some(
      (shape) => shape.schemaName !== messageShape.schemaName,
    )
  )
    throw new Error('Native empty-thread cleanup schema mismatch');
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
    throw new Error('Native empty-thread cleanup requires active workspace');
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...shapes.values(), messageShape].map(tableExpression).sort().join(',') +
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
  const requiredReferences = [
    {
      parent: THREAD,
      child: MESSAGE,
      column: 'messageThreadId',
      cascade: false,
    },
    { parent: THREAD, child: TARGET, column: 'messageThreadId', cascade: true },
    {
      parent: THREAD,
      child: ASSOCIATION,
      column: 'messageThreadId',
      cascade: true,
    },
    {
      parent: ASSOCIATION,
      child: JUNCTION,
      column: 'messageChannelMessageAssociationId',
      cascade: true,
    },
  ] as const;
  for (const required of requiredReferences) {
    if (
      !referencesByTable
        .get(required.parent)!
        .some(
          (reference) =>
            reference.schemaName === messageShape.schemaName &&
            reference.tableName === required.child &&
            canonicalAuditJson(reference.parentColumns) === '["id"]' &&
            canonicalAuditJson(reference.childColumns) ===
              canonicalAuditJson([required.column]) &&
            (!required.cascade || reference.deleteAction === 'c'),
        )
    )
      throw new Error(
        'Native empty-thread cleanup requires expected foreign keys',
      );
  }
  const before = new Map<Table, Snapshot[]>();
  const read = async (name: Table, lock = false): Promise<Snapshot[]> => {
    const shape = shapes.get(name)!;
    const parentColumn =
      name === THREAD
        ? 'id'
        : name === JUNCTION
          ? 'messageChannelMessageAssociationId'
          : 'messageThreadId';
    const parentIds =
      name === JUNCTION ? before.get(ASSOCIATION)!.map((row) => row.id) : ids;
    const originalIds = before.get(name)?.map((row) => row.id) ?? [];
    const rows = await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(shape) +
        ' WHERE ' +
        quote(parentColumn) +
        '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
        (lock ? ' FOR UPDATE' : ''),
      [parentIds, originalIds],
    );
    const rowIds = rows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Native empty-thread cleanup invalid record identity');
      return row.id;
    });
    const snapshots = await readNativeCrmAuditRows(sql, shape, rowIds);
    if (snapshots.length !== rowIds.length)
      throw new Error('Native empty-thread cleanup graph changed');
    return snapshots;
  };
  for (const name of TABLES) before.set(name, await read(name, true));
  const findThreadsWithMessages = async (threadIds: string[]) => {
    const rows = await scope.executeRawQuery(
      'SELECT DISTINCT "messageThreadId" FROM ' +
        tableExpression(messageShape) +
        ' WHERE "messageThreadId"=ANY($1::uuid[])',
      [threadIds],
    );
    return new Set(rows.map((row) => String(row.messageThreadId)));
  };
  // A trashed message is still a real cascade reference and prevents empty-thread cleanup.
  const retainedIds = await findThreadsWithMessages(ids);
  const associationById = new Map(
    before.get(ASSOCIATION)!.map((row) => [row.id, decode(row)]),
  );
  const rootId = (name: Table, row: Record<string, unknown>): string => {
    const id =
      name === THREAD
        ? row.id
        : name === JUNCTION
          ? associationById.get(String(row.messageChannelMessageAssociationId))
              ?.messageThreadId
          : row.messageThreadId;
    if (typeof id !== 'string' || !ids.includes(id))
      throw new Error('Native empty-thread cleanup child parent mismatch');
    return id;
  };
  for (const name of TABLES) {
    const owned = await findOmniNativeWriteOwnedRecords(
      scope,
      scope.workspaceId,
      name,
      before.get(name)!.map(decode),
    );
    for (const row of owned) retainedIds.add(rootId(name, row));
  }
  const selectedIds = before
    .get(THREAD)!
    .filter((row) => decode(row).deletedAt === null && !retainedIds.has(row.id))
    .map((row) => row.id);
  const selectedSet = new Set(selectedIds);
  for (const name of TABLES) {
    const records = before
      .get(name)!
      .filter((row) => selectedSet.has(rootId(name, decode(row))));
    const shape = shapes.get(name)!;
    assertNativeCrmDeleteFilesEmpty(shape, records);
    for (const reference of referencesByTable.get(name)!) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      const expectedChild =
        name === THREAD &&
        [TARGET, ASSOCIATION].some((child) => child === reference.tableName)
          ? reference.tableName
          : name === ASSOCIATION && reference.tableName === JUNCTION
            ? JUNCTION
            : undefined;
      const expectedColumn =
        name === THREAD
          ? 'messageThreadId'
          : 'messageChannelMessageAssociationId';
      if (
        expectedChild &&
        reference.schemaName === shape.schemaName &&
        reference.deleteAction === 'c' &&
        canonicalAuditJson(reference.parentColumns) === '["id"]' &&
        canonicalAuditJson(reference.childColumns) ===
          canonicalAuditJson([expectedColumn])
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
              tableExpression(shape) +
              ' parent ON ' +
              predicate +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [records.map((row) => row.id)],
          )
        ).length
      )
        throw new Error(
          'Native empty-thread cleanup excludes unsupported cascade effects',
        );
    }
  }
  const deletedIds = new Set<string>();
  if (selectedIds.length) {
    const result = await scope
      .getRepository(THREAD, { shouldBypassPermissionChecks: true })
      .delete(selectedIds, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !selectedSet.has(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native empty-thread cleanup returned unexpected records',
      );
    for (const row of returned) deletedIds.add(row.id);
  }
  const deleted = new Map<Table, Snapshot[]>();
  for (const name of TABLES)
    deleted.set(
      name,
      before
        .get(name)!
        .filter((row) => deletedIds.has(rootId(name, decode(row)))),
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
        'Native empty-thread cleanup workspace changed before commit',
      );
    if ((await findThreadsWithMessages([...deletedIds])).size)
      throw new Error('Native empty-thread cleanup message reference appeared');
    for (const name of TABLES) {
      const removed = deleted.get(name)!;
      if (
        (
          await findOmniNativeWriteOwnedRecords(
            scope,
            scope.workspaceId,
            name,
            removed.map(decode),
          )
        ).length
      )
        throw new Error(
          'Native empty-thread cleanup ownership changed before commit',
        );
      const removedIds = new Set(removed.map((row) => row.id));
      const expected = before
        .get(name)!
        .filter((row) => !removedIds.has(row.id));
      if (canonicalAuditJson(await read(name)) !== canonicalAuditJson(expected))
        throw new Error('Native empty-thread cleanup effects mismatch');
    }
  };
  await verify();
  for (const name of TABLES) {
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
  for (const id of deletedIds) session.actualDeletedThreadIds.add(id);
  session.validators.push(verify);
  return {
    deletedThreadIds: [...deletedIds].sort(),
    deletedTargetIds: deleted
      .get(TARGET)!
      .map((row) => row.id)
      .sort(),
  };
};

const deleteOrphanMessagesStage = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  candidateMessageIds: readonly string[],
): Promise<{ deletedMessageIds: string[]; affectedThreadIds: string[] }> => {
  const { scope, audit } = session;
  const MESSAGE = 'message';
  const PARTICIPANT = 'messageParticipant';
  const ASSOCIATION = 'messageChannelMessageAssociation';
  const TABLES = [MESSAGE, PARTICIPANT] as const;
  type Table = (typeof TABLES)[number];
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateMessageIds) ||
    candidateMessageIds.length > 500 ||
    candidateMessageIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    session.operation.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native orphan-message cleanup requires bounded scoped system authority',
    );
  const ids = [
    ...new Set(candidateMessageIds.map((id) => id.toLowerCase())),
  ].sort();
  const shapeFor = (name: Table | typeof ASSOCIATION) => {
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
        'Native orphan-message cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native orphan-message cleanup table metadata mismatch');
    return shape;
  };
  const shapes = new Map<Table, NativeCrmAuditTableShape>(
    TABLES.map((name) => [name, shapeFor(name)]),
  );
  const associationShape = shapeFor(ASSOCIATION);
  if (
    [...shapes.values()].some(
      (shape) => shape.schemaName !== associationShape.schemaName,
    )
  )
    throw new Error('Native orphan-message cleanup schema mismatch');
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
    throw new Error('Native orphan-message cleanup requires active workspace');
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...shapes.values(), associationShape]
        .map(tableExpression)
        .sort()
        .join(',') +
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
  for (const child of [PARTICIPANT, ASSOCIATION]) {
    if (
      !referencesByTable
        .get(MESSAGE)!
        .some(
          (reference) =>
            reference.schemaName === associationShape.schemaName &&
            reference.tableName === child &&
            canonicalAuditJson(reference.parentColumns) === '["id"]' &&
            canonicalAuditJson(reference.childColumns) === '["messageId"]' &&
            (child === ASSOCIATION || reference.deleteAction === 'c'),
        )
    )
      throw new Error(
        'Native orphan-message cleanup requires expected foreign keys',
      );
  }
  const before = new Map<Table, Snapshot[]>();
  const read = async (name: Table, lock = false): Promise<Snapshot[]> => {
    const shape = shapes.get(name)!;
    const parentColumn = name === MESSAGE ? 'id' : 'messageId';
    const originalIds = before.get(name)?.map((row) => row.id) ?? [];
    const rows = await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(shape) +
        ' WHERE ' +
        quote(parentColumn) +
        '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
        (lock ? ' FOR UPDATE' : ''),
      [ids, originalIds],
    );
    const rowIds = rows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native orphan-message cleanup invalid record identity',
        );
      return row.id;
    });
    const snapshots = await readNativeCrmAuditRows(sql, shape, rowIds);
    if (snapshots.length !== rowIds.length)
      throw new Error('Native orphan-message cleanup graph changed');
    return snapshots;
  };
  for (const name of TABLES) before.set(name, await read(name, true));
  const findMessagesWithAssociations = async (messageIds: string[]) => {
    const rows = await scope.executeRawQuery(
      'SELECT DISTINCT "messageId" FROM ' +
        tableExpression(associationShape) +
        ' WHERE "messageId"=ANY($1::uuid[])',
      [messageIds],
    );
    return new Set(rows.map((row) => String(row.messageId)));
  };
  // Trashed associations still reference a real message and must retain it.
  const retainedIds = await findMessagesWithAssociations(ids);
  const rootId = (name: Table, row: Record<string, unknown>): string => {
    const id = name === MESSAGE ? row.id : row.messageId;
    if (typeof id !== 'string' || !ids.includes(id))
      throw new Error('Native orphan-message cleanup child parent mismatch');
    return id;
  };
  for (const name of TABLES) {
    const owned = await findOmniNativeWriteOwnedRecords(
      scope,
      scope.workspaceId,
      name,
      before.get(name)!.map(decode),
    );
    for (const row of owned) retainedIds.add(rootId(name, row));
  }
  const selectedIds = before
    .get(MESSAGE)!
    .filter((row) => decode(row).deletedAt === null && !retainedIds.has(row.id))
    .map((row) => row.id);
  const selectedSet = new Set(selectedIds);
  for (const name of TABLES) {
    const records = before
      .get(name)!
      .filter((row) => selectedSet.has(rootId(name, decode(row))));
    const shape = shapes.get(name)!;
    assertNativeCrmDeleteFilesEmpty(shape, records);
    for (const reference of referencesByTable.get(name)!) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      if (
        name === MESSAGE &&
        reference.schemaName === shape.schemaName &&
        reference.tableName === PARTICIPANT &&
        reference.deleteAction === 'c' &&
        canonicalAuditJson(reference.parentColumns) === '["id"]' &&
        canonicalAuditJson(reference.childColumns) === '["messageId"]'
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
              tableExpression(shape) +
              ' parent ON ' +
              predicate +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [records.map((row) => row.id)],
          )
        ).length
      )
        throw new Error(
          'Native orphan-message cleanup excludes unsupported cascade effects',
        );
    }
  }
  const deletedIds = new Set<string>();
  if (selectedIds.length) {
    const result = await scope
      .getRepository(MESSAGE, { shouldBypassPermissionChecks: true })
      .delete(selectedIds, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !selectedSet.has(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native orphan-message cleanup returned unexpected records',
      );
    for (const row of returned) deletedIds.add(row.id);
  }
  const deleted = new Map<Table, Snapshot[]>();
  for (const name of TABLES)
    deleted.set(
      name,
      before
        .get(name)!
        .filter((row) => deletedIds.has(rootId(name, decode(row)))),
    );
  const affectedThreadIds = new Set<string>();
  for (const row of deleted.get(MESSAGE)!) {
    const threadId = decode(row).messageThreadId;
    if (threadId === null) continue;
    if (typeof threadId !== 'string' || !isUUID(threadId))
      throw new Error('Native orphan-message cleanup invalid thread reference');
    affectedThreadIds.add(threadId.toLowerCase());
  }
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
        'Native orphan-message cleanup workspace changed before commit',
      );
    if ((await findMessagesWithAssociations([...deletedIds])).size)
      throw new Error(
        'Native orphan-message cleanup association reference appeared',
      );
    for (const name of TABLES) {
      const removed = deleted.get(name)!;
      if (
        (
          await findOmniNativeWriteOwnedRecords(
            scope,
            scope.workspaceId,
            name,
            removed.map(decode),
          )
        ).length
      )
        throw new Error(
          'Native orphan-message cleanup ownership changed before commit',
        );
      const removedIds = new Set(removed.map((row) => row.id));
      const expected = before
        .get(name)!
        .filter((row) => !removedIds.has(row.id));
      if (canonicalAuditJson(await read(name)) !== canonicalAuditJson(expected))
        throw new Error('Native orphan-message cleanup effects mismatch');
    }
  };
  await verify();
  for (const name of TABLES) {
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
  session.validators.push(verify);
  return {
    deletedMessageIds: [...deletedIds].sort(),
    affectedThreadIds: [...affectedThreadIds].sort(),
  };
};

const reconcileTargetsStage = async (
  session: CleanupSession<TargetReconciliationScope>,
  candidateThreadIds: readonly string[],
): Promise<{
  createdTargetIds: string[];
  updatedTargetIds: string[];
  deletedTargetIds: string[];
}> => {
  const { scope, audit } = session;
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
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateThreadIds) ||
    candidateThreadIds.length > 500 ||
    candidateThreadIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    session.operation.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native target reconciliation requires bounded scoped system authority',
    );
  const ids = [
    ...new Set(candidateThreadIds.map((id) => id.toLowerCase())),
  ].sort();
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
  session.validators.push(verify);
  return {
    createdTargetIds: [...created].sort(),
    updatedTargetIds: [...updated.keys()].sort(),
    deletedTargetIds: [...deleted].sort(),
  };
};

// Each public entry point is terminal; only this module can compose unflushed stages.
export const deleteEmptyNativeMessageThreadsWithAudit = async ({
  scope,
  candidateThreadIds,
  operation,
}: {
  scope: NativeDeleteCleanupScope;
  candidateThreadIds: readonly string[];
  operation: CrmAuditOperation;
}): Promise<string[]> => {
  const ids = captureCandidates(
    candidateThreadIds,
    'Native empty-thread cleanup',
  );
  const session = createSession(scope, operation, EMPTY_THREAD_TABLES);
  await prepareSession(session);
  const result = await deleteEmptyThreadsStage(session, ids);
  await finalizeSession(session);
  return result.deletedThreadIds;
};

export const deleteOrphanNativeMessagesWithAudit = async ({
  scope,
  candidateMessageIds,
  operation,
}: {
  scope: NativeDeleteCleanupScope;
  candidateMessageIds: readonly string[];
  operation: CrmAuditOperation;
}): Promise<{ deletedMessageIds: string[]; affectedThreadIds: string[] }> => {
  const ids = captureCandidates(
    candidateMessageIds,
    'Native orphan-message cleanup',
  );
  const session = createSession(scope, operation, ORPHAN_MESSAGE_TABLES);
  await prepareSession(session);
  const result = await deleteOrphanMessagesStage(session, ids);
  await finalizeSession(session);
  return result;
};

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
  const ids = captureCandidates(
    candidateThreadIds,
    'Native target reconciliation',
  );
  const session = createSession(scope, operation, TARGET_RECONCILIATION_TABLES);
  await prepareSession(session);
  const result = await reconcileTargetsStage(session, ids);
  await finalizeSession(session);
  return result;
};

const readCandidatePage = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  name: 'message' | 'messageThread',
  cursor: string | null,
): Promise<string[]> => {
  const rows = await session.scope.executeRawQuery(
    'SELECT id FROM ' +
      tableExpression(session.shapes.get(name)!) +
      ' WHERE "deletedAt" IS NULL AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT ' +
      MESSAGE_PAGE_SIZE,
    [cursor],
  );
  const ids = rows.map((row) => {
    if (
      typeof row.id !== 'string' ||
      !isUUID(row.id) ||
      (cursor !== null && row.id <= cursor)
    )
      throw new Error('Native message cleanup invalid keyset page');
    return row.id;
  });
  if (
    ids.length > MESSAGE_PAGE_SIZE ||
    new Set(ids).size !== ids.length ||
    canonicalAuditJson(ids) !== canonicalAuditJson([...ids].sort())
  )
    throw new Error('Native message cleanup invalid keyset page');
  return ids;
};

const lockLiveAffectedThreads = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  ids: readonly string[],
): Promise<string[]> => {
  const threadShape = session.shapes.get('messageThread')!;
  const messageShape = session.shapes.get('message')!;
  const references = await getIncomingRecordForeignKeys(
    session.scope,
    threadShape.schemaName,
    threadShape.tableName,
  );
  if (
    !references.some(
      (reference) =>
        reference.schemaName === messageShape.schemaName &&
        reference.tableName === messageShape.tableName &&
        canonicalAuditJson(reference.parentColumns) === '["id"]' &&
        canonicalAuditJson(reference.childColumns) === '["messageThreadId"]',
    )
  )
    throw new Error('Native message cleanup requires expected foreign keys');
  const threads = await session.scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM ' +
      tableExpression(threadShape) +
      ' WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  if (
    threads.some((row) => typeof row.id !== 'string' || !ids.includes(row.id))
  )
    throw new Error('Native message cleanup invalid surviving thread');
  const lockedThreadIds = threads.map((row) => String(row.id));
  const liveThreadIds = new Set(
    threads
      .filter((row) => row.deletedAt === null)
      .map((row) => String(row.id)),
  );
  const messages = await session.scope.executeRawQuery(
    'SELECT id,"messageThreadId","deletedAt" FROM ' +
      tableExpression(messageShape) +
      ' WHERE "messageThreadId"=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [lockedThreadIds],
  );
  if (
    messages.some(
      (row) =>
        typeof row.id !== 'string' ||
        !isUUID(row.id) ||
        typeof row.messageThreadId !== 'string' ||
        !lockedThreadIds.includes(row.messageThreadId),
    )
  )
    throw new Error('Native message cleanup invalid surviving message');
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      session.scope.executeRawQuery(text, values),
  };
  const threadSnapshots = await readNativeCrmAuditRows(
    sql,
    threadShape,
    lockedThreadIds,
  );
  const messageSnapshots = await readNativeCrmAuditRows(
    sql,
    messageShape,
    messages.map((row) => String(row.id)),
  );
  if (
    threadSnapshots.length !== threads.length ||
    messageSnapshots.length !== messages.length
  )
    throw new Error('Native message cleanup retained filter sources changed');
  const originalMessageIds = messageSnapshots.map((row) => row.id);
  // Only a later proven thread deletion may remove a filtering source; skipped roots stay protected.
  session.validators.push(async () => {
    const currentThreads = await readNativeCrmAuditRows(sql, threadShape, [
      ...ids,
    ]);
    const expectedThreads = threadSnapshots.filter(
      (row) => !session.actualDeletedThreadIds.has(row.id),
    );
    const currentMessageRows = await session.scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(messageShape) +
        ' WHERE "messageThreadId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id',
      [ids, originalMessageIds],
    );
    if (
      currentMessageRows.some(
        (row) => typeof row.id !== 'string' || !isUUID(row.id),
      )
    )
      throw new Error('Native message cleanup retained filter sources changed');
    const currentMessages = await readNativeCrmAuditRows(
      sql,
      messageShape,
      currentMessageRows.map((row) => String(row.id)),
    );
    if (
      currentMessages.length !== currentMessageRows.length ||
      canonicalAuditJson(currentThreads) !==
        canonicalAuditJson(expectedThreads) ||
      canonicalAuditJson(currentMessages) !==
        canonicalAuditJson(messageSnapshots)
    )
      throw new Error('Native message cleanup retained filter sources changed');
  });
  // Hold both parent and existing children before deciding which target-source snapshots must survive.
  return [
    ...new Set(
      messages
        .filter(
          (row) =>
            row.deletedAt === null &&
            liveThreadIds.has(String(row.messageThreadId)),
        )
        .map((row) => String(row.messageThreadId)),
    ),
  ].sort();
};

export const cleanOrphanNativeMessagesAndThreadsWithAudit = async ({
  scope,
  operation,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
}): Promise<{
  deletedMessageIds: string[];
  affectedThreadIds: string[];
  deletedThreadIds: string[];
  createdTargetIds: string[];
  updatedTargetIds: string[];
  deletedTargetIds: string[];
}> => {
  const session = createSession(scope, operation, [
    ...EMPTY_THREAD_TABLES,
    ...ORPHAN_MESSAGE_TABLES,
    ...TARGET_RECONCILIATION_TABLES,
  ]);
  await prepareSession(session);
  const deletedMessages = new Set<string>();
  const affectedThreads = new Set<string>();
  const deletedThreads = new Set<string>();
  const createdTargets = new Set<string>();
  const updatedTargets = new Set<string>();
  const deletedTargets = new Set<string>();
  let messageCursor: string | null = null;
  while (true) {
    const page = await readCandidatePage(session, 'message', messageCursor);
    if (!page.length) break;
    const result = await deleteOrphanMessagesStage(session, page);
    for (const id of result.deletedMessageIds) deletedMessages.add(id);
    for (const id of result.affectedThreadIds) affectedThreads.add(id);
    messageCursor = page[page.length - 1];
    if (page.length < MESSAGE_PAGE_SIZE) break;
  }
  // Reconcile once after all message pages, avoiding intermediate target creation/deletion churn.
  const affectedThreadIds = [...affectedThreads].sort();
  for (
    let offset = 0;
    offset < affectedThreadIds.length;
    offset += MESSAGE_PAGE_SIZE
  ) {
    const page = affectedThreadIds.slice(offset, offset + MESSAGE_PAGE_SIZE);
    const liveThreadIds = await lockLiveAffectedThreads(session, page);
    if (!liveThreadIds.length) continue;
    const result = await reconcileTargetsStage(session, liveThreadIds);
    for (const id of result.createdTargetIds) createdTargets.add(id);
    for (const id of result.updatedTargetIds) updatedTargets.add(id);
    for (const id of result.deletedTargetIds) deletedTargets.add(id);
  }
  let threadCursor: string | null = null;
  while (true) {
    const page = await readCandidatePage(
      session,
      'messageThread',
      threadCursor,
    );
    if (!page.length) break;
    const result = await deleteEmptyThreadsStage(session, page);
    for (const id of result.deletedThreadIds) deletedThreads.add(id);
    for (const id of result.deletedTargetIds) deletedTargets.add(id);
    threadCursor = page[page.length - 1];
    if (page.length < MESSAGE_PAGE_SIZE) break;
  }
  await finalizeSession(session);
  return {
    deletedMessageIds: [...deletedMessages].sort(),
    affectedThreadIds,
    deletedThreadIds: [...deletedThreads].sort(),
    createdTargetIds: [...createdTargets].sort(),
    updatedTargetIds: [...updatedTargets].sort(),
    deletedTargetIds: [...deletedTargets].sort(),
  };
};
