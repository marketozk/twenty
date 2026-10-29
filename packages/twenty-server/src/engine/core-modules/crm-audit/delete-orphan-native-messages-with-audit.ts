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

const MESSAGE = 'message';
const PARTICIPANT = 'messageParticipant';
const ASSOCIATION = 'messageChannelMessageAssociation';
const TABLES = [MESSAGE, PARTICIPANT] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type NativeOrphanMessageCleanupScope = Parameters<
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
export const deleteOrphanNativeMessagesWithAudit = async ({
  scope,
  candidateMessageIds,
  operation,
}: {
  scope: NativeOrphanMessageCleanupScope;
  candidateMessageIds: readonly string[];
  operation: CrmAuditOperation;
}): Promise<{ deletedMessageIds: string[]; affectedThreadIds: string[] }> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !Array.isArray(candidateMessageIds) ||
    candidateMessageIds.length > 500 ||
    candidateMessageIds.some((id) => !isUUID(id)) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native orphan-message cleanup requires bounded scoped system authority',
    );
  const ids = [
    ...new Set(candidateMessageIds.map((id) => id.toLowerCase())),
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
  await audit.flush();
  await scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  await verify();
  return {
    deletedMessageIds: [...deletedIds].sort(),
    affectedThreadIds: [...affectedThreadIds].sort(),
  };
};
