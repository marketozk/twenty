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
import { findOmniNativeWriteOwnedRecords } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';

const THREAD = 'messageThread';
const TARGET = 'messageThreadTarget';
const ASSOCIATION = 'messageChannelMessageAssociation';
const JUNCTION = 'messageChannelMessageAssociationMessageFolder';
const MESSAGE = 'message';
const TABLES = [THREAD, TARGET, ASSOCIATION, JUNCTION] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type NativeEmptyThreadCleanupScope = Parameters<
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
const tableExpression = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);
const decode = (row: Snapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'id' ? value : JSON.parse(String(value)),
    ]),
  );

// Terminal mutation: the transaction owner must propagate errors and preserve the verified graph.
export const deleteEmptyNativeMessageThreadsWithAudit = async ({
  scope,
  candidateThreadIds,
  operation,
}: {
  scope: NativeEmptyThreadCleanupScope;
  candidateThreadIds: readonly string[];
  operation: CrmAuditOperation;
}): Promise<string[]> => {
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
      'Native empty-thread cleanup requires bounded scoped system authority',
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
  await audit.flush();
  await scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  await verify();
  return [...deletedIds].sort();
};
