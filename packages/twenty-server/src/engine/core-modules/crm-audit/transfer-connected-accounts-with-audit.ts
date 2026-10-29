import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import { lockOmniMetadataAccounts } from 'src/modules/omnichannel/services/omni-metadata-transaction';
import { hasReferencingRecords } from 'src/engine/twenty-orm/utils/has-referencing-records';

type Table = 'connectedAccount' | 'messageChannel' | 'calendarChannel';
type Row = Record<string, unknown> & { id: string };
const tables: Table[] = [
  'connectedAccount',
  'messageChannel',
  'calendarChannel',
];
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type Boundary =
  | { kind: 'transfer'; fromUserWorkspaceId: string; toUserWorkspaceId: string }
  | { kind: 'disconnect'; userWorkspaceId: string };
const changedColumns = (table: Table, boundary: Boundary) =>
  table === 'connectedAccount'
    ? [
        ...(boundary.kind === 'transfer'
          ? ['userWorkspaceId']
          : ['authFailedAt', 'authFailedReason']),
        'accessToken',
        'refreshToken',
        'connectionParameters',
        'archivedAt',
        'updatedAt',
      ]
    : ['isSyncEnabled', 'webhookSubscriptionStatus', 'updatedAt'];

type Options<T> = {
  dataSource: DataSource;
  workspaceId: string;
  accountIds: readonly string[];
  operation: CrmAuditOperation | undefined;
  mutate: (runner: QueryRunner) => Promise<T>;
};

export const transferConnectedAccountsWithAudit = (
  options: Options<void> & {
    fromUserWorkspaceId: string;
    toUserWorkspaceId: string;
  },
): Promise<void> =>
  mutateConnectedAccountsWithAudit({
    ...options,
    boundary: {
      kind: 'transfer',
      fromUserWorkspaceId: options.fromUserWorkspaceId,
      toUserWorkspaceId: options.toUserWorkspaceId,
    },
  });

export const disconnectConnectedAccountWithAudit = <T>(
  options: Options<T> & { userWorkspaceId: string },
): Promise<T> =>
  mutateConnectedAccountsWithAudit({
    ...options,
    boundary: { kind: 'disconnect', userWorkspaceId: options.userWorkspaceId },
  });

const mutateConnectedAccountsWithAudit = async <T>({
  dataSource,
  workspaceId,
  boundary,
  accountIds,
  operation,
  mutate,
}: Options<T> & { boundary: Boundary }): Promise<T> => {
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  const memberIds =
    boundary.kind === 'transfer'
      ? [boundary.fromUserWorkspaceId, boundary.toUserWorkspaceId].map((id) =>
          id.toLowerCase(),
        )
      : [boundary.userWorkspaceId.toLowerCase()];
  if (
    ![workspaceId, ...memberIds, ...ids].every((id) => isUUID(id)) ||
    (boundary.kind === 'transfer' && memberIds[0] === memberIds[1]) ||
    (boundary.kind === 'disconnect' && ids.length !== 1)
  )
    throw new Error('Connected account transfer identity invalid');
  workspaceId = workspaceId.toLowerCase();
  const captured = operation
    ? {
        ...operation,
        operationId: randomUUID(),
        actor: { ...operation.actor },
        ...(operation.initiator
          ? { initiator: { ...operation.initiator } }
          : {}),
      }
    : undefined;
  if (captured && captured.workspaceId !== workspaceId)
    throw new Error('Connected account transfer audit workspace mismatch');
  // Transfer can discover no accounts; there is no mutation result in that mode.
  if (!ids.length) return undefined as T;
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    const rawSnapshots = new WeakMap<Row, string>();
    const stableSnapshots = new WeakMap<Row, string>();
    const decode = ({
      snapshot,
      stable,
    }: {
      snapshot: string;
      stable?: string;
    }): Row => {
      const row: Row = JSON.parse(snapshot);
      rawSnapshots.set(row, snapshot);
      if (stable !== undefined) stableSnapshots.set(row, stable);
      return row;
    };
    const exact = (rows: Row[]) =>
      canonicalAuditJson(rows.map((row) => rawSnapshots.get(row)));
    const audit = captured
      ? new CrmAuditTransactionContext(runner, captured)
      : undefined;
    const scope = {
      executeRawQuery: (text: string, values?: unknown[]) =>
        runner.query(text, values),
    };
    await runner.query("SET LOCAL lock_timeout='8s'");
    await lockOmniNativeOwnership(scope, workspaceId, 'shared');
    const [workspace] = await runner.query(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [workspaceId],
    );
    const readMembers = async (lock = false): Promise<Row[]> =>
      (
        await runner.query(
          'SELECT to_jsonb(member)::text AS snapshot FROM core."userWorkspace" member WHERE id=ANY($1::uuid[]) ORDER BY id' +
            (lock ? ' FOR SHARE' : ''),
          [memberIds],
        )
      ).map(decode);
    const members = await readMembers(true);
    if (
      !workspace ||
      workspace.deletedAt !== null ||
      members.length !== memberIds.length ||
      members.some(
        (row) => row.workspaceId !== workspaceId || row.deletedAt !== null,
      )
    )
      throw new Error(
        'Connected account transfer requires active workspace memberships',
      );
    await lockOmniMetadataAccounts(runner.manager, workspaceId, ids, 'write');
    const read = async (table: Table, lock = false): Promise<Row[]> => {
      const column = table === 'connectedAccount' ? 'id' : 'connectedAccountId';
      return (
        await runner.query(
          'SELECT to_jsonb(record)::text AS snapshot, (to_jsonb(record) - $2::text[])::text AS stable FROM core.' +
            quote(table) +
            ' record WHERE ' +
            quote(column) +
            '=ANY($1::uuid[]) ORDER BY id' +
            (lock ? ' FOR UPDATE' : ''),
          [ids, changedColumns(table, boundary)],
        )
      ).map(decode);
    };
    const before = new Map<Table, Row[]>();
    for (const table of tables) {
      const rows = await read(table, true);
      if (rows.some((row) => row.workspaceId !== workspaceId))
        throw new Error('Connected account transfer child workspace mismatch');
      if (
        table === 'connectedAccount' &&
        (rows.length !== ids.length ||
          (boundary.kind === 'transfer' &&
            rows.some((row) => row.userWorkspaceId !== memberIds[0])))
      )
        throw new Error('CONNECTED_ACCOUNT_CUSTODIAN_CHANGED_RETRY');
      if (
        await hasReferencingRecords(
          scope,
          'core',
          table,
          rows.map((row) => row.id),
          new Set(changedColumns(table, boundary)),
        )
      )
        throw new Error(
          'Connected account transfer excludes transitive update effects',
        );
      before.set(table, rows);
    }
    const result = await mutate(runner);
    const after = new Map<Table, Row[]>();
    for (const table of tables) {
      const rows = await read(table),
        previous = before.get(table)!;
      if (rows.length !== previous.length)
        throw new Error('Connected account transfer effects mismatch');
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i],
          old = previous[i];
        const expected =
          table === 'connectedAccount'
            ? {
                ...old,
                ...(boundary.kind === 'transfer'
                  ? { userWorkspaceId: memberIds[1] }
                  : { authFailedAt: null, authFailedReason: null }),
                accessToken: null,
                refreshToken: null,
                connectionParameters: null,
                archivedAt: old.archivedAt ?? row.archivedAt,
                updatedAt: row.updatedAt,
              }
            : {
                ...old,
                isSyncEnabled: false,
                webhookSubscriptionStatus:
                  old.webhookSubscriptionStatus === 'PENDING'
                    ? 'EXPIRED'
                    : old.webhookSubscriptionStatus,
                updatedAt: row.updatedAt,
              };
        if (
          stableSnapshots.get(row) !== stableSnapshots.get(old) ||
          typeof row.updatedAt !== 'string' ||
          (table === 'connectedAccount' &&
            typeof row.archivedAt !== 'string') ||
          canonicalAuditJson(row) !== canonicalAuditJson(expected)
        )
          throw new Error('Connected account transfer effects mismatch');
      }
      after.set(table, rows);
    }
    const verify = async () => {
      const [currentWorkspace] = await runner.query(
        'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
        [workspaceId],
      );
      if (
        canonicalAuditJson(currentWorkspace) !==
          canonicalAuditJson(workspace) ||
        exact(await readMembers()) !== exact(members)
      )
        throw new Error(
          'Connected account transfer membership changed before commit',
        );
      for (const table of tables)
        if (exact(await read(table)) !== exact(after.get(table)!))
          throw new Error('Connected account transfer changed before commit');
    };
    const safe = (table: Table, row: Row) =>
      table === 'connectedAccount'
        ? {
            userWorkspaceId: row.userWorkspaceId,
            archivedAt: row.archivedAt,
            hasAccessToken: row.accessToken !== null,
            hasRefreshToken: row.refreshToken !== null,
            hasConnectionParameters: row.connectionParameters !== null,
            ...(boundary.kind === 'disconnect'
              ? {
                  authFailedAt: row.authFailedAt,
                  authFailedReason: row.authFailedReason,
                }
              : {}),
          }
        : {
            connectedAccountId: row.connectedAccountId,
            isSyncEnabled: row.isSyncEnabled,
            webhookSubscriptionStatus: row.webhookSubscriptionStatus,
          };
    await verify();
    let unavailable = !audit;
    if (audit) {
      await runner.query('SAVEPOINT connected_account_transfer_audit');
      try {
        for (const table of tables)
          for (let i = 0; i < before.get(table)!.length; i++) {
            const row = before.get(table)![i];
            const beforeSafe = safe(table, row),
              afterSafe = safe(table, after.get(table)![i]);
            if (
              canonicalAuditJson(beforeSafe) === canonicalAuditJson(afterSafe)
            )
              continue;
            audit.record({
              resourceKind: table,
              resourceId: row.id,
              action: 'update',
              before: beforeSafe,
              after: afterSafe,
              securityDescriptor: {
                resourceKind: table,
                resourceId: row.id,
                metadataAccess: 'currentWorkspaceAdministration',
              },
            });
          }
        await audit.flush();
        await verify();
      } catch {
        await runner.query(
          'ROLLBACK TO SAVEPOINT connected_account_transfer_audit',
        );
        unavailable = true;
      }
      await runner.query('RELEASE SAVEPOINT connected_account_transfer_audit');
    }
    await verify();
    if (unavailable)
      new Logger('ConnectedAccountTransfer').error(
        boundary.kind === 'transfer'
          ? 'CONNECTED_ACCOUNT_TRANSFER_AUDIT_UNAVAILABLE'
          : 'CONNECTED_ACCOUNT_DISCONNECT_AUDIT_UNAVAILABLE',
      );
    return result;
  });
};
