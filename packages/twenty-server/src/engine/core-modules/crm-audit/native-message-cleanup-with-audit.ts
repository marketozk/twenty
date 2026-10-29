import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import {
  lockCurrentGroupEmailAction,
  type OrdinaryGroupEmailAction,
} from 'src/modules/omnichannel/services/lock-current-group-email-action';
import {
  lockCurrentFolderAction,
  type OrdinaryFolderAction,
} from 'src/modules/omnichannel/services/lock-current-folder-action';
import { isGroupEmail } from 'src/modules/messaging/message-import-manager/utils/is-group-email';
import { BLOCKLISTED_PARTICIPANT_ROLES } from 'src/modules/messaging/blocklist-manager/constants/blocklisted-participant-roles.constant';
import { isConnectedAccountUsableByCaller } from 'src/engine/metadata-modules/connected-account/utils/is-connected-account-usable-by-caller.util';
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
  | (typeof TARGET_RECONCILIATION_TABLES)[number]
  | 'blocklist'
  | 'workspaceMember';
type CleanupSession<TScope extends NativeDeleteCleanupScope> = {
  scope: TScope;
  operation: CrmAuditOperation;
  audit: CrmAuditTransactionContext;
  validators: (() => Promise<void>)[];
  shapes: Map<CleanupTableName, NativeCrmAuditTableShape>;
  actualDeletedMessageIds: Set<string>;
  actualDeletedParticipantIds: Set<string>;
  actualDeletedThreadIds: Set<string>;
  actualDeletedAssociationIds: Set<string>;
  actualDeletedJunctionIds: Set<string>;
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
    actualDeletedMessageIds: new Set(),
    actualDeletedParticipantIds: new Set(),
    actualDeletedThreadIds: new Set(),
    actualDeletedAssociationIds: new Set(),
    actualDeletedJunctionIds: new Set(),
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
  // A later cascade may remove retained records, but must not adopt changes hidden from earlier stages.
  for (const verify of session.validators) await verify();
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
  for (const row of deleted.get(ASSOCIATION)!)
    session.actualDeletedAssociationIds.add(row.id);
  for (const row of deleted.get(JUNCTION)!)
    session.actualDeletedJunctionIds.add(row.id);
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
  for (const verify of session.validators) await verify();
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
  for (const row of deleted.get(MESSAGE)!)
    session.actualDeletedMessageIds.add(row.id);
  for (const row of deleted.get(PARTICIPANT)!)
    session.actualDeletedParticipantIds.add(row.id);
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

export const deleteOrdinaryBlocklistedMessageAssociationsWithAudit = async ({
  scope,
  operation,
  messageChannelId,
  blocklistItemIds,
  candidateAssociationIds,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
  messageChannelId: string;
  blocklistItemIds: readonly string[];
  candidateAssociationIds: readonly string[];
}): Promise<NativeMessageCleanupResult | null> => {
  const channelId = captureChannelId(messageChannelId);
  const ruleIds = captureActionCandidates(blocklistItemIds);
  const candidateIds = captureActionCandidates(candidateAssociationIds);
  // Only this boundary requires policy metadata; existing cleanup owners keep their exact object requirements.
  const session = createSession(scope, operation, [
    ...EMPTY_THREAD_TABLES,
    ...ORPHAN_MESSAGE_TABLES,
    ...TARGET_RECONCILIATION_TABLES,
    'blocklist',
    'workspaceMember',
  ]);
  await prepareSession(session);
  await requireSourceForeignKey(
    session,
    'workspaceMember',
    'blocklist',
    'workspaceMemberId',
    true,
  );
  const [discoveredChannel] = await scope.executeRawQuery(
    'SELECT "connectedAccountId" FROM core."messageChannel" WHERE id=$1 AND "workspaceId"=$2',
    [channelId, scope.workspaceId],
  );
  const accountId = discoveredChannel?.connectedAccountId;
  if (typeof accountId !== 'string' || !isUUID(accountId)) return null;

  const discoveredRules = await snapshotRows(
    session,
    'blocklist',
    'id=ANY($1::uuid[])',
    [ruleIds],
  );
  // The legacy grouping helper treats every non-WORKSPACE row with a member as member-scoped.
  const memberIds = referenceIds(
    discoveredRules.filter((row) => decode(row).scope !== 'WORKSPACE'),
    'workspaceMemberId',
  );
  const discoveredMembers = await snapshotRows(
    session,
    'workspaceMember',
    'id=ANY($1::uuid[])',
    [memberIds],
  );
  const userIds = referenceIds(discoveredMembers, 'userId');
  const readMemberships = async (lock = false) => {
    if (!userIds.length) return [];
    return scope.executeRawQuery(
      'SELECT id,"userId","workspaceId",to_jsonb("deletedAt")::text AS "deletedAt" FROM core."userWorkspace" ' +
        'WHERE "workspaceId"=$1 AND "userId"=ANY($2::uuid[]) ORDER BY id' +
        (lock ? ' FOR SHARE' : ''),
      [scope.workspaceId, userIds],
    );
  };
  // Workspace fence first, then core membership prerequisites before account/channel. SHARE keeps FK KEY SHARE compatible.
  const memberships = await readMemberships(true);
  if (memberIds.length)
    await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(session.shapes.get('workspaceMember')!) +
        ' WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [memberIds],
    );
  const members = await snapshotRows(
    session,
    'workspaceMember',
    'id=ANY($1::uuid[])',
    [memberIds],
  );
  const rules = await snapshotRows(
    session,
    'blocklist',
    'id=ANY($1::uuid[])',
    [ruleIds],
    true,
  );
  if (
    canonicalAuditJson(members) !== canonicalAuditJson(discoveredMembers) ||
    canonicalAuditJson(rules) !== canonicalAuditJson(discoveredRules)
  )
    throw new Error(
      'Native blocklist cleanup policy sources changed while locking',
    );

  const readAccount = async (lock = false) =>
    (
      await scope.executeRawQuery(
        'SELECT id,"workspaceId","userWorkspaceId","handleAliases",provider,"applicationId","connectionProviderId" ' +
          'FROM core."connectedAccount" WHERE id=$1 AND "workspaceId"=$2' +
          (lock ? ' FOR SHARE' : ''),
        [accountId, scope.workspaceId],
      )
    )[0];
  const readChannel = async (lock = false) =>
    (
      await scope.executeRawQuery(
        'SELECT id,"workspaceId","connectedAccountId",handle FROM core."messageChannel" ' +
          'WHERE id=$1 AND "workspaceId"=$2' +
          (lock ? ' FOR UPDATE' : ''),
        [channelId, scope.workspaceId],
      )
    )[0];
  const account = await readAccount(true),
    channel = await readChannel(true);
  if (
    !account ||
    !channel ||
    channel.connectedAccountId !== accountId ||
    typeof account.provider !== 'string' ||
    (account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null) ||
    (
      await scope.executeRawQuery(
        'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND ("connectedAccountId"=$2 OR "messageChannelId"=$3) LIMIT 1',
        [scope.workspaceId, accountId, channelId],
      )
    ).length
  )
    return null;
  await lockTargetedChannelAuthority(session, channelId);
  const aliases = account.handleAliases ?? [];
  if (
    !Array.isArray(aliases) ||
    aliases.some((alias) => alias !== null && typeof alias !== 'string') ||
    (channel.handle !== null && typeof channel.handle !== 'string')
  )
    throw new Error('Native blocklist cleanup invalid channel policy source');
  const ownHandles = [channel.handle, ...aliases];
  const verifyPolicySources = async () => {
    const currentRules = await snapshotRows(
      session,
      'blocklist',
      'id=ANY($1::uuid[])',
      [ruleIds],
    );
    const currentMembers = await snapshotRows(
      session,
      'workspaceMember',
      'id=ANY($1::uuid[])',
      [memberIds],
    );
    if (
      canonicalAuditJson(currentRules) !== canonicalAuditJson(rules) ||
      canonicalAuditJson(currentMembers) !== canonicalAuditJson(members) ||
      canonicalAuditJson(await readMemberships()) !==
        canonicalAuditJson(memberships)
    )
      throw new Error('Native blocklist cleanup policy sources changed');
    const currentAccount = await readAccount(),
      currentChannel = await readChannel();
    if (
      !currentAccount ||
      !currentChannel ||
      canonicalAuditJson(currentAccount) !== canonicalAuditJson(account) ||
      canonicalAuditJson(currentChannel) !== canonicalAuditJson(channel)
    )
      throw new Error('Native blocklist cleanup channel policy changed');
  };
  // Includes tombstoned/missing requested rules and memberships, so a later resurrection is not silently accepted.
  await verifyPolicySources();
  session.validators.push(verifyPolicySources);
  const applicableHandles: string[] = [];
  for (const snapshot of rules) {
    const rule = decode(snapshot);
    if (rule.deletedAt !== null || rule.handle === null) continue;
    if (typeof rule.handle !== 'string')
      throw new Error('Native blocklist cleanup invalid policy source');
    if (rule.scope === 'WORKSPACE') {
      applicableHandles.push(rule.handle);
      continue;
    }
    const member = members.find((row) => row.id === rule.workspaceMemberId);
    if (!member || decode(member).deletedAt !== null) continue;
    const memberUserId = decode(member).userId;
    const activeMemberships = memberships.filter(
      (row) => row.userId === memberUserId && row.deletedAt === null,
    );
    if (activeMemberships.length > 1)
      throw new Error(
        'Native blocklist cleanup ambiguous member policy source',
      );
    if (
      activeMemberships.length === 1 &&
      activeMemberships[0].id === account.userWorkspaceId
    )
      applicableHandles.push(rule.handle);
  }
  if (!applicableHandles.length) return null;

  const sources = await captureAssociationSources(
    session,
    channelId,
    candidateIds,
  );
  const exactHandles = [
    ...new Set(applicableHandles.filter((handle) => !handle.startsWith('@'))),
  ];
  const domainPatterns = [
    ...new Set(
      applicableHandles
        .filter((handle) => handle.startsWith('@'))
        .flatMap((handle) => ['%' + handle, '%.' + handle.slice(1)]),
    ),
  ];
  // Keep PostgreSQL equality, ILIKE wildcard/escape and NOT IN NULL semantics. Self-exclusion applies only to domains.
  const matching = await scope.executeRawQuery(
    'SELECT DISTINCT "messageId" FROM ' +
      tableExpression(session.shapes.get('messageParticipant')!) +
      ' WHERE id=ANY($1::uuid[]) AND "deletedAt" IS NULL AND role=ANY($5)' +
      ' AND (handle=ANY($2::text[]) OR (handle ILIKE ANY($3::text[]) AND handle<>ALL($4::text[])))',
    [
      sources.participants.map((row) => row.id),
      exactHandles,
      domainPatterns,
      ownHandles,
      [...BLOCKLISTED_PARTICIPANT_ROLES],
    ],
  );
  const matchingMessageIds = new Set(
    matching.map((row) => String(row.messageId)),
  );
  const selectedIds = sources.roots
    .filter((row) => {
      const root = decode(row);
      return (
        root.deletedAt === null &&
        matchingMessageIds.has(String(root.messageId))
      );
    })
    .map((row) => row.id);
  const associations = await deleteTargetedAssociationsStage(
    session,
    channelId,
    { associationIds: selectedIds },
  );
  const result = await cleanupRelatedOrphansStage(session, associations);
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

const lockTargetedChannelAuthority = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  messageChannelId: string,
): Promise<void> => {
  const { scope } = session;
  const [discovered] = await scope.executeRawQuery(
    'SELECT "connectedAccountId" FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2',
    [scope.workspaceId, messageChannelId],
  );
  const connectedAccountId = discovered?.connectedAccountId;
  if (typeof connectedAccountId !== 'string' || !isUUID(connectedAccountId))
    throw new Error(
      'Native targeted cleanup requires live ordinary channel authority',
    );
  const readAccount = async (lock = false) => {
    const rows = await scope.executeRawQuery(
      'SELECT id,"workspaceId",provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2' +
        (lock ? ' FOR SHARE' : ''),
      [scope.workspaceId, connectedAccountId],
    );
    return rows[0];
  };
  const readChannel = async (lock = false) => {
    const rows = await scope.executeRawQuery(
      'SELECT id,"workspaceId","connectedAccountId" FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2' +
        (lock ? ' FOR UPDATE' : ''),
      [scope.workspaceId, messageChannelId],
    );
    return rows[0];
  };
  const directlyBound = async () =>
    (
      await scope.executeRawQuery(
        'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND ("connectedAccountId"=$2 OR "messageChannelId"=$3) LIMIT 1',
        [scope.workspaceId, connectedAccountId, messageChannelId],
      )
    ).length > 0;
  const account = await readAccount(true);
  const channel = await readChannel(true);
  if (
    !account ||
    !channel ||
    account.id !== connectedAccountId ||
    account.workspaceId !== scope.workspaceId ||
    channel.id !== messageChannelId ||
    channel.workspaceId !== scope.workspaceId ||
    channel.connectedAccountId !== connectedAccountId ||
    typeof account.provider !== 'string' ||
    (account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null) ||
    (await directlyBound())
  )
    throw new Error(
      'Native targeted cleanup requires live ordinary channel authority',
    );
  // This mutation boundary excludes direct bindings; caller run/action eligibility remains a separate stricter gate.
  session.validators.push(async () => {
    const currentAccount = await readAccount();
    const currentChannel = await readChannel();
    if (
      !currentAccount ||
      !currentChannel ||
      canonicalAuditJson(currentAccount) !== canonicalAuditJson(account) ||
      canonicalAuditJson(currentChannel) !== canonicalAuditJson(channel) ||
      (await directlyBound())
    )
      throw new Error('Native targeted cleanup channel authority changed');
  });
};

const deleteTargetedAssociationsStage = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  messageChannelId: string,
  selector:
    | { externalIds: readonly string[] }
    | { associationIds: readonly string[] },
): Promise<{
  deletedAssociationIds: string[];
  deletedJunctionIds: string[];
  candidateMessageIds: string[];
}> => {
  const { scope, audit } = session;
  const selectorColumn =
    'externalIds' in selector ? '"messageExternalId"' : 'id';
  const selectorCast = 'externalIds' in selector ? 'text' : 'uuid';
  const selectorIds =
    'externalIds' in selector ? selector.externalIds : selector.associationIds;
  const ROOT = 'messageChannelMessageAssociation';
  const CHILD = 'messageChannelMessageAssociationMessageFolder';
  const PARENT_COLUMN = 'messageChannelMessageAssociationId';
  const PAGE_SIZE = 500;
  const rootShape = session.shapes.get(ROOT)!;
  const childShape = session.shapes.get(CHILD)!;
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  const rootIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(rootShape) +
        ' WHERE "messageChannelId"=$1 AND ' +
        selectorColumn +
        '=ANY($2::' +
        selectorCast +
        '[])' +
        (cursor ? ' AND id>$3::uuid' : '') +
        ' ORDER BY id LIMIT ' +
        PAGE_SIZE +
        ' FOR UPDATE',
      cursor
        ? [messageChannelId, selectorIds, cursor]
        : [messageChannelId, selectorIds],
    );
    if (!page.length) break;
    for (const row of page) {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Invalid cleanup root identity');
      rootIds.push(row.id);
    }
    cursor = String(page[page.length - 1].id);
  }
  const childIds = (
    await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(childShape) +
        ' WHERE ' +
        quote(PARENT_COLUMN) +
        '=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [rootIds],
    )
  ).map((row) => {
    if (typeof row.id !== 'string' || !isUUID(row.id))
      throw new Error('Invalid cleanup child identity');
    return row.id;
  });
  const roots = await readNativeCrmAuditRows(sql, rootShape, rootIds);
  const children = await readNativeCrmAuditRows(sql, childShape, childIds);
  if (roots.length !== rootIds.length || children.length !== childIds.length)
    throw new Error('Native targeted cleanup graph changed');
  const ownedRoots = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    ROOT,
    roots.map(decode),
  );
  const ownedChildren = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    CHILD,
    children.map(decode),
  );
  const retainedIds = new Set([
    ...ownedRoots.map((row) => String(row.id)),
    ...ownedChildren.map((row) => String(row[PARENT_COLUMN])),
  ]);
  const selected = roots.filter(
    (row) => !retainedIds.has(row.id) && decode(row).deletedAt === null,
  );
  const selectedIds = selected.map((row) => row.id);
  const selectedSet = new Set(selectedIds);
  const selectedChildren = children.filter((row) =>
    selectedSet.has(String(decode(row)[PARENT_COLUMN])),
  );
  assertNativeCrmDeleteFilesEmpty(rootShape, selected);
  assertNativeCrmDeleteFilesEmpty(childShape, selectedChildren);
  for (const [shape, records] of [
    [rootShape, selected],
    [childShape, selectedChildren],
  ] as const) {
    const references = await getIncomingRecordForeignKeys(
      scope,
      shape.schemaName,
      shape.tableName,
    );
    const isExpectedJunctionCascade = (
      reference: (typeof references)[number],
    ) =>
      shape === rootShape &&
      reference.schemaName === childShape.schemaName &&
      reference.tableName === childShape.tableName &&
      reference.deleteAction === 'c' &&
      canonicalAuditJson(reference.parentColumns) === '["id"]' &&
      canonicalAuditJson(reference.childColumns) ===
        canonicalAuditJson([PARENT_COLUMN]);
    if (shape === rootShape && !references.some(isExpectedJunctionCascade))
      throw new Error(
        'Native targeted cleanup requires the folder junction cascade',
      );
    for (const reference of references) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      if (isExpectedJunctionCascade(reference)) continue;
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
          'Native targeted cleanup excludes unsupported cascade effects',
        );
    }
  }
  const repository = scope.getRepository(ROOT, {
    shouldBypassPermissionChecks: true,
  });
  const actualIds = new Set<string>();
  for (let index = 0; index < selectedIds.length; index += PAGE_SIZE) {
    const ids = selectedIds.slice(index, index + PAGE_SIZE);
    const result = await repository.delete(ids, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !ids.includes(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error('Native targeted cleanup returned unexpected records');
    for (const row of returned) actualIds.add(row.id);
  }
  const deletedRoots = roots.filter((row) => actualIds.has(row.id));
  const deletedChildren = children.filter((row) =>
    actualIds.has(String(decode(row)[PARENT_COLUMN])),
  );
  const deletedChildIds = new Set(deletedChildren.map((row) => row.id));
  const verify = async () => {
    for (const [name, records] of [
      [ROOT, deletedRoots],
      [CHILD, deletedChildren],
    ] as const) {
      if (
        (
          await findOmniNativeWriteOwnedRecords(
            scope,
            scope.workspaceId,
            name,
            records.map(decode),
          )
        ).length
      )
        throw new Error(
          'Native targeted cleanup ownership changed before commit',
        );
    }
    const currentRootIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          tableExpression(rootShape) +
          ' WHERE ("messageChannelId"=$1 AND ' +
          selectorColumn +
          '=ANY($2::' +
          selectorCast +
          '[])) OR id=ANY($3::uuid[]) ORDER BY id',
        [messageChannelId, selectorIds, rootIds],
      )
    ).map((row) => String(row.id));
    const currentChildIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          tableExpression(childShape) +
          ' WHERE ' +
          quote(PARENT_COLUMN) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id',
        [rootIds, childIds],
      )
    ).map((row) => String(row.id));
    const currentRoots = await readNativeCrmAuditRows(
      sql,
      rootShape,
      currentRootIds,
    );
    const currentChildren = await readNativeCrmAuditRows(
      sql,
      childShape,
      currentChildIds,
    );
    if (
      canonicalAuditJson(currentRoots) !==
        canonicalAuditJson(
          roots.filter(
            (row) =>
              !actualIds.has(row.id) &&
              !session.actualDeletedAssociationIds.has(row.id),
          ),
        ) ||
      canonicalAuditJson(currentChildren) !==
        canonicalAuditJson(
          children.filter(
            (row) =>
              !deletedChildIds.has(row.id) &&
              !session.actualDeletedJunctionIds.has(row.id),
          ),
        )
    )
      throw new Error('Native targeted cleanup effects mismatch');
  };
  await verify();
  for (const [shape, records] of [
    [rootShape, deletedRoots],
    [childShape, deletedChildren],
  ] as const)
    for (const row of records)
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
  for (const id of actualIds) session.actualDeletedAssociationIds.add(id);
  for (const id of deletedChildIds) session.actualDeletedJunctionIds.add(id);
  session.validators.push(verify);
  const candidateMessageIds = referenceIds(deletedRoots, 'messageId');
  return {
    deletedAssociationIds: [...actualIds].sort(),
    deletedJunctionIds: [...deletedChildIds].sort(),
    candidateMessageIds,
  };
};

export type NativeMessageCleanupResult = {
  primaryDeletedAssociationIds: string[];
  deletedAssociationIds: string[];
  deletedJunctionIds: string[];
  deletedMessageIds: string[];
  affectedThreadIds: string[];
  deletedThreadIds: string[];
  createdTargetIds: string[];
  updatedTargetIds: string[];
  deletedTargetIds: string[];
};
const cleanupRelatedOrphansStage = async (
  session: CleanupSession<TargetReconciliationScope>,
  associations: Awaited<ReturnType<typeof deleteTargetedAssociationsStage>>,
): Promise<NativeMessageCleanupResult> => {
  const deletedMessages = new Set<string>();
  const affectedThreads = new Set<string>();
  const deletedThreads = new Set<string>();
  const createdTargets = new Set<string>();
  const updatedTargets = new Set<string>();
  const deletedTargets = new Set<string>();
  const messageIds = [...new Set(associations.candidateMessageIds)].sort();
  for (
    let offset = 0;
    offset < messageIds.length;
    offset += MESSAGE_PAGE_SIZE
  ) {
    const result = await deleteOrphanMessagesStage(
      session,
      messageIds.slice(offset, offset + MESSAGE_PAGE_SIZE),
    );
    for (const id of result.deletedMessageIds) deletedMessages.add(id);
    for (const id of result.affectedThreadIds) affectedThreads.add(id);
  }
  const affectedThreadIds = [...affectedThreads].sort();
  for (
    let offset = 0;
    offset < affectedThreadIds.length;
    offset += MESSAGE_PAGE_SIZE
  ) {
    const liveThreadIds = await lockLiveAffectedThreads(
      session,
      affectedThreadIds.slice(offset, offset + MESSAGE_PAGE_SIZE),
    );
    if (!liveThreadIds.length) continue;
    const result = await reconcileTargetsStage(session, liveThreadIds);
    for (const id of result.createdTargetIds) createdTargets.add(id);
    for (const id of result.updatedTargetIds) updatedTargets.add(id);
    for (const id of result.deletedTargetIds) deletedTargets.add(id);
  }
  for (
    let offset = 0;
    offset < affectedThreadIds.length;
    offset += MESSAGE_PAGE_SIZE
  ) {
    const result = await deleteEmptyThreadsStage(
      session,
      affectedThreadIds.slice(offset, offset + MESSAGE_PAGE_SIZE),
    );
    for (const id of result.deletedThreadIds) deletedThreads.add(id);
    for (const id of result.deletedTargetIds) deletedTargets.add(id);
  }
  return {
    primaryDeletedAssociationIds: [...associations.deletedAssociationIds],
    deletedAssociationIds: [
      ...new Set([
        ...associations.deletedAssociationIds,
        ...session.actualDeletedAssociationIds,
      ]),
    ].sort(),
    deletedJunctionIds: [
      ...new Set([
        ...associations.deletedJunctionIds,
        ...session.actualDeletedJunctionIds,
      ]),
    ].sort(),
    deletedMessageIds: [...deletedMessages].sort(),
    affectedThreadIds,
    deletedThreadIds: [...deletedThreads].sort(),
    createdTargetIds: [...createdTargets].sort(),
    updatedTargetIds: [...updatedTargets].sort(),
    deletedTargetIds: [...deletedTargets].sort(),
  };
};

export const deleteNativeMessageAssociationsAndRelatedOrphansWithAudit =
  async ({
    scope,
    operation,
    messageChannelId,
    messageExternalIds,
  }: {
    scope: TargetReconciliationScope;
    operation: CrmAuditOperation;
    messageChannelId: string;
    messageExternalIds: readonly string[];
  }) => {
    const channelId = captureChannelId(messageChannelId);
    const externalIds = captureExternalIds(messageExternalIds);
    const session = createCompleteSession(scope, operation);
    await prepareSession(session);
    await lockTargetedChannelAuthority(session, channelId);
    const associations = await deleteTargetedAssociationsStage(
      session,
      channelId,
      { externalIds },
    );
    const result = await cleanupRelatedOrphansStage(session, associations);
    await finalizeSession(session);
    // Preserve the established LOG135 public result shape.
    const { primaryDeletedAssociationIds: _primary, ...legacyResult } = result;
    return legacyResult;
  };

const createCompleteSession = (
  scope: TargetReconciliationScope,
  operation: CrmAuditOperation,
) =>
  createSession(scope, operation, [
    ...EMPTY_THREAD_TABLES,
    ...ORPHAN_MESSAGE_TABLES,
    ...TARGET_RECONCILIATION_TABLES,
  ]);
const captureChannelId = (id: string) => {
  if (typeof id !== 'string' || !isUUID(id))
    throw new Error(
      'Native targeted cleanup requires exact channel and external identifiers',
    );
  return id.toLowerCase();
};
const captureExternalIds = (ids: readonly string[]) => {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || id.length === 0)
  )
    throw new Error(
      'Native targeted cleanup requires exact channel and external identifiers',
    );
  return Object.freeze([...new Set(ids)].sort());
};
const captureActionCandidates = (ids: readonly string[]) => {
  if (!Array.isArray(ids) || ids.length > 200)
    throw new Error('Native ordinary cleanup requires bounded candidates');
  return captureCandidates(ids, 'Native ordinary cleanup');
};
const snapshotRows = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  name: CleanupTableName,
  predicate: string,
  values: unknown[],
  lock = false,
): Promise<Snapshot[]> => {
  const shape = session.shapes.get(name)!;
  const rows = await session.scope.executeRawQuery(
    'SELECT id FROM ' +
      tableExpression(shape) +
      ' WHERE ' +
      predicate +
      ' ORDER BY id' +
      (lock ? ' FOR UPDATE' : ''),
    values,
  );
  const ids = rows.map((row) => {
    if (typeof row.id !== 'string' || !isUUID(row.id))
      throw new Error('Native ordinary cleanup invalid record identity');
    return row.id;
  });
  const snapshots = await readNativeCrmAuditRows(
    {
      execute: ({ text, values }) =>
        session.scope.executeRawQuery(text, values),
    },
    shape,
    ids,
  );
  if (snapshots.length !== ids.length)
    throw new Error('Native ordinary cleanup source changed');
  return snapshots;
};
const requireSourceForeignKey = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  parent: CleanupTableName,
  child: CleanupTableName,
  column: string,
  cascade = false,
) => {
  const parentShape = session.shapes.get(parent)!,
    childShape = session.shapes.get(child)!;
  const references = await getIncomingRecordForeignKeys(
    session.scope,
    parentShape.schemaName,
    parentShape.tableName,
  );
  if (
    !references.some(
      (ref) =>
        ref.schemaName === childShape.schemaName &&
        ref.tableName === childShape.tableName &&
        canonicalAuditJson(ref.parentColumns) === '["id"]' &&
        canonicalAuditJson(ref.childColumns) === canonicalAuditJson([column]) &&
        (!cascade || ref.deleteAction === 'c'),
    )
  )
    throw new Error(
      'Native ordinary cleanup requires expected source foreign keys',
    );
};
const captureAssociationSources = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  channelId: string,
  candidateIds: readonly string[],
) => {
  const ROOT = 'messageChannelMessageAssociation';
  const MESSAGE = 'message',
    PARTICIPANT = 'messageParticipant';
  await requireSourceForeignKey(session, MESSAGE, ROOT, 'messageId');
  await requireSourceForeignKey(
    session,
    MESSAGE,
    PARTICIPANT,
    'messageId',
    true,
  );
  const discovered = await snapshotRows(
    session,
    ROOT,
    'id=ANY($1::uuid[]) AND "messageChannelId"=$2',
    [candidateIds, channelId],
  );
  const messageIds = referenceIds(discovered, 'messageId');
  const messages = await snapshotRows(
    session,
    MESSAGE,
    'id=ANY($1::uuid[])',
    [messageIds],
    true,
  );
  const roots = await snapshotRows(
    session,
    ROOT,
    'id=ANY($1::uuid[]) AND "messageChannelId"=$2',
    [candidateIds, channelId],
    true,
  );
  if (canonicalAuditJson(discovered) !== canonicalAuditJson(roots))
    throw new Error('Native ordinary cleanup source changed while locking');
  const participants = await snapshotRows(
    session,
    PARTICIPANT,
    '"messageId"=ANY($1::uuid[])',
    [messageIds],
    true,
  );
  if (messages.length !== messageIds.length)
    throw new Error('Native ordinary cleanup source message missing');
  session.validators.push(async () => {
    const currentRoots = await snapshotRows(
      session,
      ROOT,
      '(id=ANY($1::uuid[]) AND "messageChannelId"=$2) OR id=ANY($3::uuid[])',
      [candidateIds, channelId, roots.map((row) => row.id)],
    );
    const currentMessages = await snapshotRows(
      session,
      MESSAGE,
      'id=ANY($1::uuid[])',
      [messageIds],
    );
    const currentParticipants = await snapshotRows(
      session,
      PARTICIPANT,
      '"messageId"=ANY($1::uuid[]) OR id=ANY($2::uuid[])',
      [messageIds, participants.map((row) => row.id)],
    );
    if (
      canonicalAuditJson(currentRoots) !==
        canonicalAuditJson(
          roots.filter(
            (row) => !session.actualDeletedAssociationIds.has(row.id),
          ),
        ) ||
      canonicalAuditJson(currentMessages) !==
        canonicalAuditJson(
          messages.filter(
            (row) => !session.actualDeletedMessageIds.has(row.id),
          ),
        ) ||
      canonicalAuditJson(currentParticipants) !==
        canonicalAuditJson(
          participants.filter(
            (row) => !session.actualDeletedParticipantIds.has(row.id),
          ),
        )
    )
      throw new Error('Native ordinary cleanup selection sources changed');
  });
  return { roots, messages, participants };
};

export const deleteOrdinarySyncMessageAssociationsWithAudit = async ({
  scope,
  operation,
  expectedRun,
  messageExternalIds,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
  expectedRun: OrdinaryMetadataSyncRun;
  messageExternalIds: readonly string[];
}): Promise<NativeMessageCleanupResult | null> => {
  const run = Object.freeze({ ...expectedRun });
  const externalIds = captureExternalIds(messageExternalIds);
  if (run.kind !== 'message' || run.workspaceId !== scope.workspaceId)
    throw new Error('Native ordinary cleanup invalid sync proof');
  const session = createCompleteSession(scope, operation);
  await prepareSession(session);
  if (!(await lockOrdinaryNativeSyncRun(scope, run))) return null;
  session.validators.push(async () => {
    if (!(await lockOrdinaryNativeSyncRun(scope, run)))
      throw new Error('Native ordinary cleanup sync proof changed');
  });
  await lockTargetedChannelAuthority(session, run.channelId);
  const associations = await deleteTargetedAssociationsStage(
    session,
    run.channelId,
    { externalIds },
  );
  const result = await cleanupRelatedOrphansStage(session, associations);
  await finalizeSession(session);
  return result;
};

export const deleteOrdinaryGroupEmailMessageAssociationsWithAudit = async ({
  scope,
  operation,
  action,
  candidateAssociationIds,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
  action: OrdinaryGroupEmailAction;
  candidateAssociationIds: readonly string[];
}): Promise<NativeMessageCleanupResult | null> => {
  const expected = Object.freeze({ ...action });
  const candidates = captureActionCandidates(candidateAssociationIds);
  if (
    expected.workspaceId !== scope.workspaceId ||
    expected.action !== 'GROUP_EMAILS_DELETION'
  )
    throw new Error('Native ordinary cleanup invalid group proof');
  const session = createCompleteSession(scope, operation);
  await prepareSession(session);
  if (!(await lockCurrentGroupEmailAction(scope, expected))) return null;
  session.validators.push(async () => {
    if (!(await lockCurrentGroupEmailAction(scope, expected)))
      throw new Error('Native ordinary cleanup group proof changed');
  });
  await lockTargetedChannelAuthority(session, expected.messageChannelId);
  const sources = await captureAssociationSources(
    session,
    expected.messageChannelId,
    candidates,
  );
  const groupMessages = new Set(
    sources.participants
      .filter((row) => {
        const value = decode(row);
        return (
          value.deletedAt === null &&
          value.role === 'FROM' &&
          typeof value.handle === 'string' &&
          value.handle.length > 0 &&
          isGroupEmail(value.handle)
        );
      })
      .map((row) => String(decode(row).messageId)),
  );
  const selectedIds = sources.roots
    .filter((row) => {
      const value = decode(row);
      return (
        value.deletedAt === null &&
        typeof value.messageExternalId === 'string' &&
        value.messageExternalId.length > 0 &&
        groupMessages.has(String(value.messageId))
      );
    })
    .map((row) => row.id);
  const associations = await deleteTargetedAssociationsStage(
    session,
    expected.messageChannelId,
    { associationIds: selectedIds },
  );
  const result = await cleanupRelatedOrphansStage(session, associations);
  await finalizeSession(session);
  return result;
};

const deleteFolderJunctionRemainderStage = async (
  session: CleanupSession<NativeDeleteCleanupScope>,
  candidates: Snapshot[],
  parentSnapshots: Snapshot[],
) => {
  for (const verify of session.validators) await verify();
  const name = 'messageChannelMessageAssociationMessageFolder';
  const shape = session.shapes.get(name)!;
  const remainingIds = candidates
    .filter((row) => !session.actualDeletedJunctionIds.has(row.id))
    .map((row) => row.id);
  const before = await snapshotRows(
    session,
    name,
    'id=ANY($1::uuid[])',
    [remainingIds],
    true,
  );
  if (
    canonicalAuditJson(before) !==
    canonicalAuditJson(
      candidates.filter((row) => remainingIds.includes(row.id)),
    )
  )
    throw new Error('Native folder cleanup junction source changed');
  const owned = await findOmniNativeWriteOwnedRecords(
    session.scope,
    session.scope.workspaceId,
    name,
    before.map(decode),
  );
  if (owned.length) throw new Error('Native folder cleanup ownership changed');
  assertNativeCrmDeleteFilesEmpty(shape, before);
  const references = await getIncomingRecordForeignKeys(
    session.scope,
    shape.schemaName,
    shape.tableName,
  );
  for (const ref of references) {
    if (!['c', 'n', 'd'].includes(ref.deleteAction)) continue;
    const predicate = ref.childColumns
      .map(
        (column, index) =>
          'child.' +
          quote(column) +
          '=parent.' +
          quote(ref.parentColumns[index]),
      )
      .join(' AND ');
    if (
      (
        await session.scope.executeRawQuery(
          'SELECT 1 FROM ' +
            quote(ref.schemaName) +
            '.' +
            quote(ref.tableName) +
            ' child JOIN ' +
            tableExpression(shape) +
            ' parent ON ' +
            predicate +
            ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
          [remainingIds],
        )
      ).length
    )
      throw new Error(
        'Native folder cleanup excludes unsupported cascade effects',
      );
  }
  const actual = new Set<string>();
  if (remainingIds.length) {
    const result = await session.scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .delete(remainingIds, { columnsToReturn: ['id'] });
    const raw: unknown = result.raw;
    if (
      !Array.isArray(raw) ||
      result.affected !== raw.length ||
      raw.some(
        (row) =>
          !row || typeof row.id !== 'string' || !remainingIds.includes(row.id),
      ) ||
      new Set(raw.map((row) => row.id)).size !== raw.length
    )
      throw new Error('Native folder cleanup returned unexpected records');
    for (const row of raw) actual.add(row.id);
  }
  const removed = before.filter((row) => actual.has(row.id));
  const removedParentIds = referenceIds(
    removed,
    'messageChannelMessageAssociationId',
  );
  const removedParents = parentSnapshots.filter((row) =>
    removedParentIds.includes(row.id),
  );
  const verify = async () => {
    if (
      (
        await findOmniNativeWriteOwnedRecords(
          session.scope,
          session.scope.workspaceId,
          name,
          removed.map(decode),
        )
      ).length ||
      (
        await findOmniNativeWriteOwnedRecords(
          session.scope,
          session.scope.workspaceId,
          'messageChannelMessageAssociation',
          removedParents.map(decode),
        )
      ).length
    )
      throw new Error('Native folder cleanup ownership changed before commit');
    const current = await snapshotRows(session, name, 'id=ANY($1::uuid[])', [
      remainingIds,
    ]);
    if (
      canonicalAuditJson(current) !==
      canonicalAuditJson(
        before.filter(
          (row) =>
            !actual.has(row.id) &&
            !session.actualDeletedJunctionIds.has(row.id),
        ),
      )
    )
      throw new Error('Native folder cleanup junction effects mismatch');
  };
  await verify();
  for (const row of removed)
    session.audit.record({
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
  for (const id of actual) session.actualDeletedJunctionIds.add(id);
  session.validators.push(verify);
};

export const deleteOrdinaryFolderMessagePageWithAudit = async ({
  scope,
  operation,
  action,
  cursor,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
  action: OrdinaryFolderAction;
  cursor?: string;
}): Promise<{
  cursor: string | null;
  done: boolean;
  deletedAssociationCount: number;
} | null> => {
  const expected = {
    ...action,
    hierarchy: action.hierarchy.map((item) => ({ ...item })),
  };
  const after = cursor === undefined ? null : captureChannelId(cursor);
  if (
    expected.workspaceId !== scope.workspaceId ||
    expected.action !== 'FOLDER_DELETION'
  )
    throw new Error('Native ordinary cleanup invalid folder proof');
  const session = createCompleteSession(scope, operation);
  await prepareSession(session);
  if (!(await lockCurrentFolderAction(scope, expected))) return null;
  session.validators.push(async () => {
    if (!(await lockCurrentFolderAction(scope, expected)))
      throw new Error('Native ordinary cleanup folder proof changed');
  });
  await lockTargetedChannelAuthority(session, expected.messageChannelId);
  const ROOT = 'messageChannelMessageAssociation',
    CHILD = 'messageChannelMessageAssociationMessageFolder';
  await requireSourceForeignKey(
    session,
    ROOT,
    CHILD,
    'messageChannelMessageAssociationId',
    true,
  );
  const pageIds = (
    await scope.executeRawQuery(
      'SELECT id FROM ' +
        tableExpression(session.shapes.get(CHILD)!) +
        ' WHERE "messageFolderId"=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 200',
      [expected.messageFolderId, after],
    )
  ).map((row) => String(row.id));
  const discovered = await snapshotRows(session, CHILD, 'id=ANY($1::uuid[])', [
    pageIds,
  ]);
  const parentIds = referenceIds(
    discovered,
    'messageChannelMessageAssociationId',
  );
  const parents = await snapshotRows(
    session,
    ROOT,
    'id=ANY($1::uuid[])',
    [parentIds],
    true,
  );
  const allChildren = await snapshotRows(
    session,
    CHILD,
    '"messageChannelMessageAssociationId"=ANY($1::uuid[]) OR id=ANY($2::uuid[])',
    [parentIds, pageIds],
    true,
  );
  const page = allChildren.filter((row) => pageIds.includes(row.id));
  if (
    canonicalAuditJson(page) !== canonicalAuditJson(discovered) ||
    parents.length !== parentIds.length
  )
    throw new Error('Native folder cleanup page changed while locking');
  const verifyFolderPageSources = async () => {
    const currentRange = await snapshotRows(
      session,
      CHILD,
      '"messageFolderId"=$1 AND ($2::uuid IS NULL OR id>$2::uuid)' +
        (pageIds.length === 200 ? ' AND id<=$3::uuid' : ''),
      pageIds.length === 200
        ? [expected.messageFolderId, after, pageIds.at(-1)]
        : [expected.messageFolderId, after],
    );
    if (
      canonicalAuditJson(currentRange) !==
      canonicalAuditJson(
        page.filter((row) => !session.actualDeletedJunctionIds.has(row.id)),
      )
    )
      throw new Error('Native folder cleanup page range changed');
    const currentPage = await snapshotRows(
      session,
      CHILD,
      '"messageChannelMessageAssociationId"=ANY($1::uuid[]) OR id=ANY($2::uuid[])',
      [parentIds, allChildren.map((row) => row.id)],
    );
    const currentParents = await snapshotRows(
      session,
      ROOT,
      'id=ANY($1::uuid[])',
      [parentIds],
    );
    if (
      canonicalAuditJson(currentPage) !==
        canonicalAuditJson(
          allChildren.filter(
            (row) => !session.actualDeletedJunctionIds.has(row.id),
          ),
        ) ||
      canonicalAuditJson(currentParents) !==
        canonicalAuditJson(
          parents.filter(
            (row) => !session.actualDeletedAssociationIds.has(row.id),
          ),
        )
    )
      throw new Error('Native folder cleanup page sources changed');
  };
  // Discovery itself was not locked: prove the selected folder/range now, before any deletion can mask a stale row.
  await verifyFolderPageSources();
  session.validators.push(verifyFolderPageSources);
  const ownedParents = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    ROOT,
    parents.map(decode),
  );
  const ownedChildren = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    CHILD,
    allChildren.map(decode),
  );
  const excluded = new Set([
    ...ownedParents.map((row) => String(row.id)),
    ...ownedChildren.map((row) =>
      String(row.messageChannelMessageAssociationId),
    ),
  ]);
  const allowedParents = parents.filter(
    (row) =>
      decode(row).messageChannelId === expected.messageChannelId &&
      !excluded.has(row.id),
  );
  const allowedIds = new Set(allowedParents.map((row) => row.id));
  const allowedJunctions = page.filter((row) =>
    allowedIds.has(String(decode(row).messageChannelMessageAssociationId)),
  );
  const selectedIds = allowedParents
    .filter(
      (row) =>
        decode(row).deletedAt === null &&
        typeof decode(row).messageExternalId === 'string',
    )
    .map((row) => row.id);
  const associations = await deleteTargetedAssociationsStage(
    session,
    expected.messageChannelId,
    { associationIds: selectedIds },
  );
  await deleteFolderJunctionRemainderStage(
    session,
    allowedJunctions,
    allowedParents,
  );
  await cleanupRelatedOrphansStage(session, associations);
  await finalizeSession(session);
  return {
    cursor: pageIds.at(-1) ?? null,
    done: pageIds.length < 200,
    deletedAssociationCount: associations.deletedAssociationIds.length,
  };
};

export type SentDraftCleanupTarget = {
  associationId: string;
  messageChannelId: string;
  messageExternalId: string;
};
export const deleteSentDraftMessageWithAudit = async ({
  scope,
  operation,
  caller,
  connectedAccountId,
  draftMessageId,
  target,
}: {
  scope: TargetReconciliationScope;
  operation: CrmAuditOperation;
  caller: { userWorkspaceId: string; userId: string };
  connectedAccountId: string;
  draftMessageId: string;
  target: SentDraftCleanupTarget;
}): Promise<NativeMessageCleanupResult | null> => {
  const memberId = captureChannelId(caller.userWorkspaceId),
    userId = captureChannelId(caller.userId);
  const accountId = captureChannelId(connectedAccountId),
    draftId = captureChannelId(draftMessageId);
  const associationId = captureChannelId(target.associationId),
    channelId = captureChannelId(target.messageChannelId);
  const externalId = captureExternalIds([target.messageExternalId])[0];
  const session = createCompleteSession(scope, operation);
  await prepareSession(session);
  const readUser = async (lock = false) =>
    (
      await scope.executeRawQuery(
        'SELECT id,"deletedAt",disabled FROM core."user" WHERE id=$1' +
          (lock ? ' FOR SHARE' : ''),
        [userId],
      )
    )[0];
  const readMember = async (lock = false) =>
    (
      await scope.executeRawQuery(
        'SELECT id,"workspaceId","userId","deletedAt" FROM core."userWorkspace" WHERE id=$1' +
          (lock ? ' FOR SHARE' : ''),
        [memberId],
      )
    )[0];
  const readAccount = async (lock = false) =>
    (
      await scope.executeRawQuery(
        'SELECT id,"workspaceId",scope,"userWorkspaceId" FROM core."connectedAccount" WHERE id=$1 AND "workspaceId"=$2' +
          (lock ? ' FOR SHARE' : ''),
        [accountId, scope.workspaceId],
      )
    )[0];
  // User -> membership -> account -> channel: attribution never substitutes for these fresh authority rows.
  const user = await readUser(true),
    member = await readMember(true),
    account = await readAccount(true);
  if (
    !user ||
    user.deletedAt !== null ||
    user.disabled !== false ||
    !member ||
    member.deletedAt !== null ||
    member.workspaceId !== scope.workspaceId ||
    member.userId !== userId ||
    !account ||
    !['USER', 'WORKSPACE'].includes(String(account.scope)) ||
    !isConnectedAccountUsableByCaller({
      connectedAccount: {
        scope: account.scope as 'USER' | 'WORKSPACE',
        userWorkspaceId: String(account.userWorkspaceId),
      },
      userWorkspaceId: memberId,
    })
  )
    return null;
  session.validators.push(async () => {
    const currentUser = await readUser(),
      currentMember = await readMember(),
      currentAccount = await readAccount();
    if (
      !currentUser ||
      currentUser.deletedAt !== null ||
      currentUser.disabled !== false ||
      !currentMember ||
      currentMember.deletedAt !== null ||
      currentMember.workspaceId !== scope.workspaceId ||
      currentMember.userId !== userId ||
      !currentAccount ||
      currentAccount.workspaceId !== scope.workspaceId ||
      canonicalAuditJson(currentUser) !== canonicalAuditJson(user) ||
      canonicalAuditJson(currentMember) !== canonicalAuditJson(member) ||
      canonicalAuditJson(currentAccount) !== canonicalAuditJson(account)
    )
      throw new Error('Native sent-draft cleanup caller authority changed');
  });
  const channels = await scope.executeRawQuery(
    'SELECT id FROM core."messageChannel" WHERE "workspaceId"=$1 AND "connectedAccountId"=$2 AND id=$3 FOR UPDATE',
    [scope.workspaceId, accountId, channelId],
  );
  if (channels.length !== 1) return null;
  await lockTargetedChannelAuthority(session, channelId);
  await requireSourceForeignKey(
    session,
    'message',
    'messageChannelMessageAssociation',
    'messageId',
  );
  const draft = await snapshotRows(
    session,
    'message',
    'id=$1',
    [draftId],
    true,
  );
  if (
    draft.length !== 1 ||
    decode(draft[0]).deletedAt !== null ||
    decode(draft[0]).isDraft !== true
  )
    return null;
  const targetRows = await snapshotRows(
    session,
    'messageChannelMessageAssociation',
    'id=$1',
    [associationId],
    true,
  );
  if (
    targetRows.length !== 1 ||
    decode(targetRows[0]).deletedAt !== null ||
    decode(targetRows[0]).messageId !== draftId ||
    decode(targetRows[0]).messageChannelId !== channelId ||
    decode(targetRows[0]).messageExternalId !== externalId
  )
    return null;
  const sources = await captureAssociationSources(session, channelId, [
    associationId,
  ]);
  if (
    sources.roots.length !== 1 ||
    decode(sources.roots[0]).messageId !== draftId ||
    sources.messages.length !== 1 ||
    decode(sources.messages[0]).isDraft !== true ||
    decode(sources.messages[0]).deletedAt !== null
  )
    throw new Error('Native sent-draft cleanup exact draft source changed');
  const associations = await deleteTargetedAssociationsStage(
    session,
    channelId,
    { associationIds: [associationId] },
  );
  const result = await cleanupRelatedOrphansStage(session, associations);
  await finalizeSession(session);
  return result;
};
