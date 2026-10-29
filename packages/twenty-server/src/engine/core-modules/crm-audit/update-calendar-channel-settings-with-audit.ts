import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource } from 'typeorm';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

export class CalendarChannelSettingsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'CALENDAR_CHANNEL_NOT_FOUND'
      | 'CALENDAR_CHANNEL_OWNERSHIP_VIOLATION'
      | 'INVALID_CALENDAR_CHANNEL_INPUT',
  ) {
    super(message);
  }
}

const VISIBILITIES = ['METADATA', 'SHARE_EVERYTHING'] as const;
const CONTACT_CREATION_POLICIES = [
  'AS_PARTICIPANT_AND_ORGANIZER',
  'AS_PARTICIPANT',
  'AS_ORGANIZER',
  'NONE',
] as const;

export type CalendarChannelSettingsUpdates = {
  visibility?: (typeof VISIBILITIES)[number];
  isContactAutoCreationEnabled?: boolean;
  contactAutoCreationPolicy?: (typeof CONTACT_CREATION_POLICIES)[number];
  excludePrivateEvents?: boolean;
  isSyncEnabled?: boolean;
};
export type CalendarChannelSettingsResult = {
  calendarChannel: Record<string, unknown> & {
    id: string;
    workspaceId: string;
    connectedAccountId: string;
  };
  resetChannel?: { id: string; connectedAccountId: string };
};
type Row = Record<string, unknown> & { id: string };
const SETTINGS = [
  'visibility',
  'isContactAutoCreationEnabled',
  'contactAutoCreationPolicy',
  'excludePrivateEvents',
  'isSyncEnabled',
] as const;
const AUDIT_FIELDS = [
  ...SETTINGS,
  'connectedAccountId',
  'webhookSubscriptionStatus',
  'syncStage',
  'syncCursor',
  'syncStageStartedAt',
  'throttleFailureCount',
] as const;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const identifier = (value: string) => {
  if (!isUUID(value))
    throw new CalendarChannelSettingsError(
      'Calendar channel settings invalid identity',
      'INVALID_CALENDAR_CHANNEL_INPUT',
    );
  return value.toLowerCase();
};
const invalidUpdates = () =>
  new CalendarChannelSettingsError(
    'Calendar channel settings invalid updates',
    'INVALID_CALENDAR_CHANNEL_INPUT',
  );
const captureUpdates = (
  updates: CalendarChannelSettingsUpdates,
): Readonly<CalendarChannelSettingsUpdates> => {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates))
    throw invalidUpdates();
  const captured: Record<string, string | boolean> = {};
  for (const key of Reflect.ownKeys(updates)) {
    if (typeof key !== 'string' || !SETTINGS.some((field) => field === key))
      throw invalidUpdates();
    const descriptor = Object.getOwnPropertyDescriptor(updates, key)!;
    if ('get' in descriptor || 'set' in descriptor) throw invalidUpdates();
    const value: unknown = descriptor.value;
    if (value === undefined) continue;
    const valid =
      key === 'visibility'
        ? VISIBILITIES.some((entry) => entry === value)
        : key === 'contactAutoCreationPolicy'
          ? CONTACT_CREATION_POLICIES.some((entry) => entry === value)
          : typeof value === 'boolean';
    if (!valid) throw invalidUpdates();
    captured[key] = value as string | boolean;
  }
  return Object.freeze(captured) as Readonly<CalendarChannelSettingsUpdates>;
};
const safeAudit = (row: Row): Record<string, unknown> =>
  Object.fromEntries(AUDIT_FIELDS.map((field) => [field, row[field]]));

// One closed owner for the public settings operation and its conditional reset.
// The caller performs only the returned account-scoped cache invalidation after confirmed COMMIT.
export const updateCalendarChannelSettingsWithAudit = async ({
  dataSource,
  workspaceId,
  calendarChannelId,
  caller,
  updates,
  operation,
}: {
  dataSource: DataSource;
  workspaceId: string;
  calendarChannelId: string;
  caller: { userWorkspaceId: string; userId: string };
  updates: CalendarChannelSettingsUpdates;
  operation: CrmAuditOperation;
}): Promise<CalendarChannelSettingsResult> => {
  workspaceId = identifier(workspaceId);
  const channelId = identifier(calendarChannelId);
  const userWorkspaceId = identifier(caller.userWorkspaceId);
  const userId = identifier(caller.userId);
  const requested = captureUpdates(updates);
  if (
    !operation ||
    operation.workspaceId !== workspaceId ||
    !isUUID(operation.operationId)
  )
    throw new Error(
      'Calendar channel settings requires scoped audit operation',
    );
  const capturedOperation = {
    ...operation,
    operationId: randomUUID(),
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    const audit = new CrmAuditTransactionContext(runner, capturedOperation);
    const scope = {
      executeRawQuery: (text: string, values?: unknown[]) =>
        runner.query(text, values),
    };
    const sql = {
      execute: ({ text, values }: { text: string; values: unknown[] }) =>
        runner.query(text, values),
    };
    await runner.query("SET LOCAL lock_timeout='8s'");
    await lockOmniNativeOwnership(scope, workspaceId, 'shared');
    const readWorkspace = async (lock = false): Promise<Row | undefined> =>
      (
        await runner.query(
          'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1' +
            (lock ? ' FOR NO KEY UPDATE' : ''),
          [workspaceId],
        )
      )[0];
    const workspace = await readWorkspace(true);
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar channel settings requires active workspace');
    await runner.query(
      'LOCK TABLE core."calendarChannel" IN ROW EXCLUSIVE MODE',
    );

    const readUser = async (lock = false): Promise<Row | undefined> =>
      (
        await runner.query(
          'SELECT id,"deletedAt",disabled FROM core."user" WHERE id=$1' +
            (lock ? ' FOR SHARE' : ''),
          [userId],
        )
      )[0];
    const readMember = async (lock = false): Promise<Row | undefined> =>
      (
        await runner.query(
          'SELECT id,"workspaceId","userId","deletedAt" FROM core."userWorkspace" WHERE id=$1' +
            (lock ? ' FOR SHARE' : ''),
          [userWorkspaceId],
        )
      )[0];
    // User -> membership -> account -> channel, before either settings or reset writes.
    const user = await readUser(true);
    const member = await readMember(true);
    const validMembership = (
      currentUser: Row | undefined,
      currentMember: Row | undefined,
    ) =>
      currentUser?.id === userId &&
      currentUser.deletedAt === null &&
      currentUser.disabled === false &&
      currentMember?.id === userWorkspaceId &&
      currentMember.workspaceId === workspaceId &&
      currentMember.userId === userId &&
      currentMember.deletedAt === null;
    if (!validMembership(user, member))
      throw new CalendarChannelSettingsError(
        'Calendar channel settings authority changed',
        'CALENDAR_CHANNEL_OWNERSHIP_VIOLATION',
      );

    const [discovered] = await runner.query(
      'SELECT "connectedAccountId" FROM core."calendarChannel" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, channelId],
    );
    if (!discovered)
      throw new CalendarChannelSettingsError(
        `Calendar channel ${channelId} not found`,
        'CALENDAR_CHANNEL_NOT_FOUND',
      );
    if (typeof discovered.connectedAccountId !== 'string')
      throw new Error('Calendar channel settings authority changed');
    const accountId = identifier(discovered.connectedAccountId);
    const readAccount = async (lock = false): Promise<Row | undefined> =>
      (
        await runner.query(
          'SELECT id,"workspaceId","userWorkspaceId",provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE id=$1' +
            (lock ? ' FOR SHARE' : ''),
          [accountId],
        )
      )[0];
    const account = await readAccount(true);
    if (
      !account ||
      account.workspaceId !== workspaceId ||
      account.userWorkspaceId !== userWorkspaceId
    )
      throw new CalendarChannelSettingsError(
        'Calendar channel settings authority changed',
        'CALENDAR_CHANNEL_OWNERSHIP_VIOLATION',
      );

    const readChannel = async (lock = false): Promise<string> => {
      const rows: { snapshot: string }[] = await runner.query(
        'SELECT to_jsonb(record)::text AS snapshot FROM core."calendarChannel" record WHERE "workspaceId"=$1 AND id=$2' +
          (lock ? ' FOR UPDATE' : ''),
        [workspaceId, channelId],
      );
      if (rows.length !== 1)
        throw new Error('Calendar channel settings effects mismatch');
      return rows[0].snapshot;
    };
    const before = await readChannel(true);
    const beforeRow: Row = JSON.parse(before);
    if (beforeRow.connectedAccountId !== accountId)
      throw new Error('Calendar channel settings authority changed');
    const resetRequested =
      requested.excludePrivateEvents !== undefined &&
      requested.excludePrivateEvents !== beforeRow.excludePrivateEvents &&
      beforeRow.syncStage !== 'PENDING_CONFIGURATION';
    const ordinaryResetEligible = async () => {
      const currentAccount = await readAccount();
      if (
        !currentAccount ||
        currentAccount.workspaceId !== workspaceId ||
        currentAccount.userWorkspaceId !== userWorkspaceId
      )
        throw new Error('Calendar channel settings authority changed');
      const owned = await findOmniOwnedConnectedAccountIds(scope, workspaceId, [
        accountId,
      ]);
      return (
        !owned.has(accountId) &&
        !(
          currentAccount.provider === 'app' &&
          currentAccount.applicationId === null &&
          currentAccount.connectionProviderId === null
        )
      );
    };
    // The ordinary gate belongs only to reset. It is not the settings authorization policy.
    const resetEligible = resetRequested
      ? await ordinaryResetEligible()
      : false;
    let expected = before;
    const verify = async () => {
      const currentWorkspace = await readWorkspace();
      const currentUser = await readUser();
      const currentMember = await readMember();
      const currentAccount = await readAccount();
      if (!currentWorkspace || currentWorkspace.deletedAt !== null)
        throw new Error('Calendar channel settings requires active workspace');
      if (
        !validMembership(currentUser, currentMember) ||
        !currentAccount ||
        currentAccount.workspaceId !== workspaceId ||
        currentAccount.userWorkspaceId !== userWorkspaceId ||
        canonicalAuditJson(currentUser) !== canonicalAuditJson(user) ||
        canonicalAuditJson(currentMember) !== canonicalAuditJson(member) ||
        canonicalAuditJson(currentAccount) !== canonicalAuditJson(account) ||
        (resetRequested && (await ordinaryResetEligible()) !== resetEligible)
      )
        throw new Error('Calendar channel settings authority changed');
      if ((await readChannel()) !== expected)
        throw new Error('Calendar channel settings effects mismatch');
    };
    const apply = async (
      changes: Record<string, unknown>,
    ): Promise<boolean> => {
      await verify();
      const entries = Object.entries(changes);
      const values: unknown[] = [
        workspaceId,
        channelId,
        ...entries.map(([, value]) => value),
      ];
      const clauses = entries.map(([columnName], index) => ({
        columnName,
        valueExpression: '$' + (index + 3),
      }));
      clauses.push({
        columnName: 'updatedAt',
        valueExpression: 'CURRENT_TIMESTAMP',
      });
      // All values here are captured validated enum/boolean settings or fixed reset
      // literals. Keep the FK probe's parameters fixed even when only one SET field
      // participates in an incoming key.
      const guardClauses = entries.map(([columnName, value]) => ({
        columnName,
        valueExpression:
          value === null
            ? 'NULL'
            : typeof value === 'boolean'
              ? value
                ? 'TRUE'
                : 'FALSE'
              : typeof value === 'number'
                ? String(value)
                : "'" + String(value).replaceAll("'", "''") + "'",
      }));
      guardClauses.push({
        columnName: 'updatedAt',
        valueExpression: 'CURRENT_TIMESTAMP',
      });
      await assertNoReferentialUpdateEffects(
        sql,
        {
          kind: 'update',
          alias: 'settings_channel',
          tableShape: { schemaName: 'core', tableName: 'calendarChannel' },
          setClauses: guardClauses,
        },
        {},
        '"settings_channel"."workspaceId"=$1 AND "settings_channel"."id"=$2',
        (text) => ({ text, values: [workspaceId, channelId] }),
      );
      const [proposed] = await runner.query(
        "SELECT (($1::jsonb || $2::jsonb) || jsonb_build_object('updatedAt',CURRENT_TIMESTAMP))::text AS snapshot",
        [expected, JSON.stringify(changes)],
      );
      const returned: { id: string }[] = await runner.query(
        'WITH changed AS (UPDATE core."calendarChannel" SET ' +
          clauses
            .map(
              ({ columnName, valueExpression }) =>
                quote(columnName) + '=' + valueExpression,
            )
            .join(',') +
          ' WHERE "workspaceId"=$1 AND id=$2 RETURNING id) SELECT id FROM changed',
        values,
      );
      if (
        !Array.isArray(returned) ||
        returned.length > 1 ||
        returned.some((row) => row.id !== channelId)
      )
        throw new Error(
          'Calendar channel settings returned unexpected records',
        );
      if (returned.length) expected = proposed.snapshot;
      await verify();
      return returned.length === 1;
    };

    await apply({ ...requested });
    // Preserve the historical API result captured after settings, BEFORE conditional reset.
    const [calendarChannel] = await runner.query(
      'SELECT record.* FROM core."calendarChannel" record WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, channelId],
    );
    if (!calendarChannel || calendarChannel.connectedAccountId !== accountId)
      throw new Error('Calendar channel settings effects mismatch');

    let resetApplied = false;
    // Legacy control flow permits reset even if a BEFORE UPDATE trigger skipped settings.
    if (resetRequested && resetEligible)
      resetApplied = await apply({
        syncCursor: '',
        syncStageStartedAt: null,
        throttleFailureCount: 0,
        syncStage: 'CALENDAR_EVENT_LIST_FETCH_PENDING',
      });
    const afterRow: Row = JSON.parse(expected);
    const beforeSafe = safeAudit(beforeRow);
    const afterSafe = safeAudit(afterRow);
    if (canonicalAuditJson(beforeSafe) !== canonicalAuditJson(afterSafe))
      audit.record({
        resourceKind: 'calendarChannel',
        resourceId: channelId,
        action: 'update',
        before: beforeSafe,
        after: afterSafe,
        securityDescriptor: {
          resourceKind: 'calendarChannel',
          resourceId: channelId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    await verify();
    await audit.flush();
    await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
    await verify();
    return {
      calendarChannel:
        calendarChannel as CalendarChannelSettingsResult['calendarChannel'],
      ...(resetApplied
        ? { resetChannel: { id: channelId, connectedAccountId: accountId } }
        : {}),
    };
  });
};
