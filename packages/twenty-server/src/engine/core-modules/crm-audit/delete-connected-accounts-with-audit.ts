import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource } from 'typeorm';
import {
  captureAccountDeletionBoundary,
  prepareAccountDeletionBoundary,
  type ConnectedAccountDeletionBoundary,
} from 'src/engine/core-modules/crm-audit/connected-account-deletion-boundary';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import {
  findOmniOwnedConnectedAccountIds,
  findOmniOwnedMessageFolderIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import { lockOmniMetadataAccounts } from 'src/modules/omnichannel/services/omni-metadata-transaction';

const TABLES = [
  'connectedAccount',
  'messageChannel',
  'calendarChannel',
  'messageFolder',
] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown> & { id: string; workspaceId: string };
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export type DeletedConnectedAccountGraph = {
  accounts: { id: string; userWorkspaceId: string }[];
  messageChannelIds: string[];
  calendarChannelIds: string[];
  messageFolderIds: string[];
};

// Authorization belongs to the calling entry point; this owner closes DB effects only.
export const deleteConnectedAccountsWithAudit = async ({
  dataSource,
  workspaceId,
  accountIds,
  operation,
  boundary,
}: {
  dataSource: DataSource;
  workspaceId: string;
  accountIds: readonly string[];
  operation: CrmAuditOperation;
  boundary: ConnectedAccountDeletionBoundary;
}): Promise<DeletedConnectedAccountGraph> => {
  if (
    !isUUID(workspaceId) ||
    !Array.isArray(accountIds) ||
    accountIds.some((id) => !isUUID(id))
  )
    throw new Error('Invalid connected account deletion scope');
  workspaceId = workspaceId.toLowerCase();
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  if (
    !operation ||
    operation.workspaceId !== workspaceId ||
    !isUUID(operation.operationId)
  )
    throw new Error(
      'Connected account deletion requires scoped audit operation',
    );
  const captured = {
    ...operation,
    operationId: randomUUID(),
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const capturedBoundary = captureAccountDeletionBoundary(boundary);

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    const audit = new CrmAuditTransactionContext(runner, captured);
    const scope = {
      executeRawQuery: (text: string, values?: unknown[]) =>
        runner.query(text, values),
    };
    const snapshots = new WeakMap<Row, string>();
    const decode = ({ snapshot }: { snapshot: string }): Row => {
      const row: Row = JSON.parse(snapshot);
      snapshots.set(row, snapshot);
      return row;
    };
    const exact = (rows: Row[]) =>
      canonicalAuditJson(rows.map((row) => snapshots.get(row)));
    await runner.query("SET LOCAL lock_timeout='8s'");
    await lockOmniNativeOwnership(scope, workspaceId, 'shared');
    const [workspace] = await runner.query(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Connected account deletion requires active workspace');
    // Freeze FK DDL while retaining compatibility with ordinary row-level writers.
    await runner.query(
      'LOCK TABLE ' +
        [...TABLES]
          .sort()
          .map((table) => 'core.' + quote(table))
          .join(',') +
        ' IN ROW EXCLUSIVE MODE',
    );
    const authorization = await prepareAccountDeletionBoundary(
      runner,
      workspaceId,
      capturedBoundary,
    );
    await lockOmniMetadataAccounts(runner.manager, workspaceId, ids, 'write');
    const before = new Map<Table, Row[]>();
    const read = async (table: Table, lock = false): Promise<Row[]> => {
      const column =
        table === 'connectedAccount'
          ? 'id'
          : table === 'messageFolder'
            ? 'messageChannelId'
            : 'connectedAccountId';
      const parentIds =
        table === 'messageFolder'
          ? before.get('messageChannel')!.map((row) => row.id)
          : ids;
      const originalIds = before.get(table)?.map((row) => row.id) ?? [];
      return (
        await runner.query(
          'SELECT to_jsonb(record)::text AS snapshot FROM core.' +
            quote(table) +
            ' record WHERE ' +
            quote(column) +
            '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
            (lock ? ' FOR UPDATE' : ''),
          [parentIds, originalIds],
        )
      ).map(decode);
    };
    for (const table of TABLES) {
      const rows = await read(table, true);
      if (rows.some((row) => row.workspaceId !== workspaceId))
        throw new Error('Connected account deletion graph workspace mismatch');
      before.set(table, rows);
    }
    if (
      before
        .get('connectedAccount')!
        .some(
          (row) =>
            typeof row.userWorkspaceId !== 'string' ||
            !isUUID(row.userWorkspaceId),
        )
    )
      throw new Error('Connected account deletion requires valid custodians');
    const assertOrdinary = async () => {
      if (
        (await findOmniOwnedConnectedAccountIds(scope, workspaceId, ids))
          .size ||
        (
          await findOmniOwnedMessageFolderIds(
            scope,
            workspaceId,
            before.get('messageFolder')!.map((row) => row.id),
          )
        ).size
      )
        throw new Error(
          'Connected account deletion excludes retained omni resources',
        );
    };
    await assertOrdinary();
    await authorization.authorize(
      before.get('connectedAccount')!,
      before.get('messageChannel')!,
    );
    for (const table of TABLES) {
      const references = await getIncomingRecordForeignKeys(
        scope,
        'core',
        table,
      );
      for (const reference of references) {
        if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
        const supported =
          reference.schemaName === 'core' &&
          reference.deleteAction === 'c' &&
          canonicalAuditJson(reference.parentColumns) === '["id"]' &&
          ((table === 'connectedAccount' &&
            ['messageChannel', 'calendarChannel'].includes(
              reference.tableName,
            ) &&
            canonicalAuditJson(reference.childColumns) ===
              '["connectedAccountId"]') ||
            (table === 'messageChannel' &&
              reference.tableName === 'messageFolder' &&
              canonicalAuditJson(reference.childColumns) ===
                '["messageChannelId"]'));
        if (supported) continue;
        const predicate = reference.childColumns
          .map(
            (column, index) =>
              'child.' +
              quote(column) +
              '=parent.' +
              quote(reference.parentColumns[index]),
          )
          .join(' AND ');
        const rows = await runner.query(
          'SELECT 1 FROM ' +
            quote(reference.schemaName) +
            '.' +
            quote(reference.tableName) +
            ' child JOIN core.' +
            quote(table) +
            ' parent ON ' +
            predicate +
            ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
          [before.get(table)!.map((row) => row.id)],
        );
        if (rows.length)
          throw new Error(
            'Connected account deletion excludes unsupported cascade effects',
          );
      }
    }
    const returned: { id: string }[] = await runner.query(
      'WITH deleted AS (DELETE FROM core."connectedAccount" WHERE id=ANY($1::uuid[]) RETURNING id) SELECT id FROM deleted ORDER BY id',
      [before.get('connectedAccount')!.map((row) => row.id)],
    );
    if (
      !Array.isArray(returned) ||
      returned.some(
        (row) =>
          !before.get('connectedAccount')!.some((old) => old.id === row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error('Connected account deletion returned unexpected records');
    const deleted = new Map<Table, Row[]>();
    if (
      capturedBoundary.kind !== 'administration' &&
      returned.length !== before.get('connectedAccount')!.length
    )
      throw new Error('Connected account deletion requires complete effects');
    const deletedAccountIds = new Set(returned.map((row) => row.id));
    for (const table of TABLES) {
      const rows = before.get(table)!;
      deleted.set(
        table,
        rows.filter((row) =>
          table === 'connectedAccount'
            ? deletedAccountIds.has(row.id)
            : table === 'messageFolder'
              ? deleted
                  .get('messageChannel')!
                  .some((channel) => channel.id === row.messageChannelId)
              : deletedAccountIds.has(row.connectedAccountId as string),
        ),
      );
    }
    const verify = async () => {
      await authorization.verify();
      const [currentWorkspace] = await runner.query(
        'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
        [workspaceId],
      );
      if (
        canonicalAuditJson(currentWorkspace) !== canonicalAuditJson(workspace)
      )
        throw new Error(
          'Connected account deletion workspace changed before commit',
        );
      for (const table of TABLES) {
        const expected = before
          .get(table)!
          .filter((row) => !deleted.get(table)!.includes(row));
        if (exact(await read(table)) !== exact(expected))
          throw new Error('Connected account deletion effects mismatch');
      }
      await assertOrdinary();
    };
    await verify();
    for (const table of TABLES)
      for (const row of deleted.get(table)!) {
        const safe =
          table === 'connectedAccount'
            ? {
                userWorkspaceId: row.userWorkspaceId,
                hasAccessToken: row.accessToken != null,
                hasRefreshToken: row.refreshToken != null,
                hasConnectionParameters: row.connectionParameters != null,
              }
            : table === 'messageFolder'
              ? {
                  messageChannelId: row.messageChannelId,
                  isSentFolder: row.isSentFolder,
                  isSynced: row.isSynced,
                  pendingSyncAction: row.pendingSyncAction,
                }
              : {
                  connectedAccountId: row.connectedAccountId,
                  isSyncEnabled: row.isSyncEnabled,
                  webhookSubscriptionStatus: row.webhookSubscriptionStatus,
                };
        audit.record({
          resourceKind: table,
          resourceId: row.id,
          action: 'delete',
          before: safe,
          after: null,
          securityDescriptor: {
            resourceKind: table,
            resourceId: row.id,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
    await audit.flush();
    await verify();
    return {
      accounts: deleted.get('connectedAccount')!.map((row) => ({
        id: row.id,
        userWorkspaceId: row.userWorkspaceId as string,
      })),
      messageChannelIds: deleted.get('messageChannel')!.map((row) => row.id),
      calendarChannelIds: deleted.get('calendarChannel')!.map((row) => row.id),
      messageFolderIds: deleted.get('messageFolder')!.map((row) => row.id),
    };
  });
};
