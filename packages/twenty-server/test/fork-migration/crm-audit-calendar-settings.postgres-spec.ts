import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CalendarChannelSyncStage,
  CalendarChannelVisibility,
  CalendarChannelContactAutoCreationPolicy,
} from 'twenty-shared/types';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  updateCalendarChannelSettingsWithAudit,
  CalendarChannelSettingsError,
  type CalendarChannelSettingsUpdates,
} from 'src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CalendarChannelExceptionCode } from 'src/engine/metadata-modules/calendar-channel/calendar-channel.exception';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture();
// Real low-privilege core QueryRunner/audit owner. The suite uses SQL table
// projections, not a mocked repository transaction or a public server fixture.
const runtime = new DataSource({
  type: 'postgres',
  url: f.runtimeDatabaseUrl,
  extra: { max: 4, statement_timeout: 15000 },
});
let userId: string,
  memberId: string,
  otherUserId: string,
  otherMemberId: string,
  accountId: string,
  channelId: string,
  messageChannelId: string;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'coreUser', id: userId },
});
const update = async (
  updates: CalendarChannelSettingsUpdates,
  caller = { userWorkspaceId: memberId, userId },
  op = operation(),
) =>
  updateCalendarChannelSettingsWithAudit({
    dataSource: runtime,
    workspaceId: f.workspaceId,
    calendarChannelId: channelId,
    caller,
    updates,
    operation: op,
  });
const read = async () =>
  f.owner.query('SELECT * FROM core."calendarChannel" ORDER BY id');
const snapshot = async () =>
  Promise.all(
    [
      'workspace',
      'user',
      'userWorkspace',
      'connectedAccount',
      'calendarChannel',
    ].map((name) =>
      f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM core."${name}" row ORDER BY id`,
      ),
    ),
  );
const audits = async () =>
  f.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const trigger = async (timing: string, body: string, deferred = false) =>
  f.owner.query(
    `CREATE FUNCTION core.calendar_settings_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER calendar_settings_test ${timing} UPDATE ON core."calendarChannel" ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION core.calendar_settings_test()`,
  );
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION core.calendar_settings_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_settings_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.calendar_settings_test()`,
  );
const causeText = (error: unknown) => {
  const messages: string[] = [];
  for (let n = 0; n < 6 && error instanceof Error; n++) {
    messages.push(error.message);
    error = error.cause;
  }
  return messages.join(' | ');
};
const settingsWithoutUpdates = async () =>
  f.owner.query(
    `SELECT (to_jsonb(row)-ARRAY['visibility','isContactAutoCreationEnabled','contactAutoCreationPolicy','excludePrivateEvents','isSyncEnabled','syncCursor','syncStageStartedAt','throttleFailureCount','syncStage','updatedAt'])::text AS row FROM core."calendarChannel" row ORDER BY id`,
  );

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'CREATE TABLE core."user"(id uuid PRIMARY KEY,disabled boolean NOT NULL DEFAULT false,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES core."user"(id),"workspaceId" uuid NOT NULL REFERENCES core.workspace(id),"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD "userWorkspaceId" uuid REFERENCES core."userWorkspace"(id),ADD provider text,ADD scope text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "archivedAt" timestamptz',
  );
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid',
  );
  await f.owner.query(`CREATE TABLE core."calendarChannel"(
    id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id),"connectedAccountId" uuid NOT NULL REFERENCES core."connectedAccount"(id) ON DELETE CASCADE,
    handle text NOT NULL,"syncStatus" text NOT NULL,"syncStage" text NOT NULL,visibility text NOT NULL,
    "isContactAutoCreationEnabled" boolean NOT NULL DEFAULT true,"contactAutoCreationPolicy" text NOT NULL,"excludePrivateEvents" boolean NOT NULL DEFAULT false,"isSyncEnabled" boolean NOT NULL DEFAULT true,
    "syncCursor" text,"syncedAt" timestamptz,"syncStageStartedAt" timestamptz,"throttleFailureCount" integer NOT NULL DEFAULT 0,
    "webhookSubscriptionExternalId" text,"webhookSubscriptionExternalResourceId" text,"webhookSubscriptionClientState" text,"webhookSubscriptionStatus" text,"webhookSubscriptionExpiresAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_settings_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_settings_test ON core."calendarChannel"',
  );
  await f.owner.query('DROP FUNCTION IF EXISTS core.calendar_settings_test()');
  await f.owner.query('DROP TABLE IF EXISTS core.calendar_settings_child');
  await f.owner.query('DROP INDEX IF EXISTS core.calendar_settings_pair');
  await f.reset();
  await f.owner.query(
    'TRUNCATE core.workspace,core."user",core."userWorkspace",core."connectedAccount",core."messageChannel",core."calendarChannel" CASCADE',
  );
  userId = randomUUID();
  memberId = randomUUID();
  otherUserId = randomUUID();
  otherMemberId = randomUUID();
  accountId = randomUUID();
  channelId = randomUUID();
  messageChannelId = randomUUID();
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
  await f.owner.query('INSERT INTO core."user"(id) VALUES($1),($2)', [
    userId,
    otherUserId,
  ]);
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3),($4,$5,$3)',
    [memberId, userId, f.workspaceId, otherMemberId, otherUserId],
  );
  await f.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId","userWorkspaceId",provider,scope) VALUES($1,$2,$3,\'google\',\'WORKSPACE\')',
    [accountId, f.workspaceId, memberId],
  );
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId") VALUES($1,$2,\'EMAIL\',$3)',
    [messageChannelId, f.workspaceId, accountId],
  );
  await f.owner.query(
    `INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId",handle,"syncStatus","syncStage",visibility,"contactAutoCreationPolicy","syncCursor","syncStageStartedAt","syncedAt","throttleFailureCount","webhookSubscriptionClientState","updatedAt") VALUES($1,$2,$3,'owner@example.test','ONGOING',$4,'METADATA','AS_PARTICIPANT_AND_ORGANIZER','private-sync-cursor','2030-01-01T00:00:00.123456Z','2029-01-01T00:00:00.000123Z',7,'private-webhook-state','2029-01-01T00:00:00.000789Z')`,
    [
      channelId,
      f.workspaceId,
      accountId,
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    ],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await f.dispose();
});

it('returns the settings DTO before reset while committing one audited final settings/reset row', async () => {
  const beforeStable = await settingsWithoutUpdates();
  const result = await update({
    visibility: CalendarChannelVisibility.SHARE_EVERYTHING,
    isContactAutoCreationEnabled: false,
    contactAutoCreationPolicy:
      CalendarChannelContactAutoCreationPolicy.AS_ORGANIZER,
    excludePrivateEvents: true,
    isSyncEnabled: false,
  });
  expect(result.calendarChannel).toMatchObject({
    id: channelId,
    visibility: 'SHARE_EVERYTHING',
    isContactAutoCreationEnabled: false,
    contactAutoCreationPolicy: 'AS_ORGANIZER',
    excludePrivateEvents: true,
    isSyncEnabled: false,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    syncCursor: 'private-sync-cursor',
    throttleFailureCount: 7,
  });
  expect(result.resetChannel).toEqual({
    id: channelId,
    connectedAccountId: accountId,
  });
  expect((await read())[0]).toMatchObject({
    visibility: 'SHARE_EVERYTHING',
    excludePrivateEvents: true,
    isSyncEnabled: false,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    syncCursor: '',
    syncStageStartedAt: null,
    throttleFailureCount: 0,
    syncStatus: 'ONGOING',
  });
  expect(await settingsWithoutUpdates()).toEqual(beforeStable);
  const entries = await audits();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    resourceKind: 'calendarChannel',
    resourceId: channelId,
    action: 'update',
    actor: { kind: 'coreUser', id: userId },
  });
  expect(JSON.stringify(entries)).not.toContain('private-sync-cursor');
  expect(JSON.stringify(entries)).not.toContain('private-webhook-state');
});

it.each(['unchanged', 'omitted', 'pending-configuration'] as const)(
  'does not reset for %s private-event setting',
  async (kind) => {
    if (kind === 'pending-configuration')
      await f.owner.query(
        'UPDATE core."calendarChannel" SET "syncStage"=$1 WHERE id=$2',
        [CalendarChannelSyncStage.PENDING_CONFIGURATION, channelId],
      );
    const [before] = await read();
    const result = await update(
      kind === 'omitted'
        ? { visibility: CalendarChannelVisibility.SHARE_EVERYTHING }
        : { excludePrivateEvents: kind === 'pending-configuration' },
    );
    expect(result.resetChannel).toBeUndefined();
    const [after] = await read();
    expect(after).toMatchObject({
      syncStage: before.syncStage,
      syncCursor: before.syncCursor,
      syncStageStartedAt: before.syncStageStartedAt,
      throttleFailureCount: before.throttleFailureCount,
    });
    expect(await audits()).toHaveLength(kind === 'unchanged' ? 0 : 1);
  },
);

it.each(['reserved-app', 'retained-binding'] as const)(
  'allows owner settings but skips ordinary reset for %s',
  async (kind) => {
    await f.owner.query(
      'UPDATE core."connectedAccount" SET provider=\'app\' WHERE id=$1',
      [accountId],
    );
    if (kind === 'retained-binding') {
      await f.owner.query(
        'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
        [messageChannelId],
      );
      await bootstrapOmniAccountBinding(
        runtime,
        { kind: 'system', id: 'calendar-settings-fixture' },
        {
          workspaceId: f.workspaceId,
          platform: 'telegram',
          connectorInstanceId: 'settings-fixture',
          accountId,
          connectedAccountId: accountId,
          messageChannelId,
          idempotencyKey: randomUUID(),
          expectedRevision: '0',
        },
        async () => undefined,
      );
      await f.owner.query(
        'UPDATE core."connectedAccount" SET provider=\'google\' WHERE id=$1',
        [accountId],
      );
    }
    const count = (await audits()).length;
    const result = await update({ excludePrivateEvents: true });
    expect(result.resetChannel).toBeUndefined();
    expect((await read())[0]).toMatchObject({
      excludePrivateEvents: true,
      syncCursor: 'private-sync-cursor',
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    });
    expect(await audits()).toHaveLength(count + 1);
  },
);

it('keeps archived-account settings compatibility without introducing a new refusal', async () => {
  await f.owner.query(
    'UPDATE core."connectedAccount" SET "archivedAt"=clock_timestamp() WHERE id=$1',
    [accountId],
  );
  expect(
    (await update({ visibility: CalendarChannelVisibility.SHARE_EVERYTHING }))
      .calendarChannel.visibility,
  ).toBe('SHARE_EVERYTHING');
  expect(await audits()).toHaveLength(1);
});

it.each([
  'not-owner',
  'rebound-member',
  'deleted-member',
  'deleted-user',
  'disabled-user',
  'deleted-workspace',
  'foreign-channel',
  'missing-channel',
] as const)('refuses %s without mutation or success audit', async (kind) => {
  const caller = { userWorkspaceId: memberId, userId };
  if (kind === 'not-owner') {
    caller.userWorkspaceId = otherMemberId;
    caller.userId = otherUserId;
  }
  if (kind === 'rebound-member')
    await f.owner.query(
      'UPDATE core."userWorkspace" SET "userId"=$1 WHERE id=$2',
      [otherUserId, memberId],
    );
  if (kind === 'deleted-member')
    await f.owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE id=$1',
      [memberId],
    );
  if (kind === 'deleted-user')
    await f.owner.query(
      'UPDATE core."user" SET "deletedAt"=clock_timestamp() WHERE id=$1',
      [userId],
    );
  if (kind === 'disabled-user')
    await f.owner.query('UPDATE core."user" SET disabled=true WHERE id=$1', [
      userId,
    ]);
  if (kind === 'deleted-workspace')
    await f.owner.query(
      'UPDATE core.workspace SET "deletedAt"=clock_timestamp() WHERE id=$1',
      [f.workspaceId],
    );
  if (kind === 'foreign-channel') {
    const otherWorkspace = randomUUID();
    await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
      otherWorkspace,
    ]);
    await f.owner.query(
      'UPDATE core."calendarChannel" SET "workspaceId"=$1 WHERE id=$2',
      [otherWorkspace, channelId],
    );
  }
  if (kind === 'missing-channel')
    await f.owner.query('DELETE FROM core."calendarChannel" WHERE id=$1', [
      channelId,
    ]);
  const before = await snapshot(),
    failure = await update(
      { visibility: CalendarChannelVisibility.SHARE_EVERYTHING },
      caller,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
  if (kind === 'deleted-workspace') expect(failure).toBeInstanceOf(Error);
  else {
    expect(failure).toBeInstanceOf(CalendarChannelSettingsError);
    expect(failure).toMatchObject({
      code:
        kind === 'foreign-channel' || kind === 'missing-channel'
          ? CalendarChannelExceptionCode.CALENDAR_CHANNEL_NOT_FOUND
          : CalendarChannelExceptionCode.CALENDAR_CHANNEL_OWNERSHIP_VIOLATION,
    });
  }
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it.each([
  { visibility: 'INVALID' },
  { contactAutoCreationPolicy: 'INVALID' },
  { excludePrivateEvents: 'true' },
  { isSyncEnabled: null },
  { connectedAccountId: randomUUID() },
])('rejects malformed closed DTO %j', async (updates) => {
  const before = await snapshot(),
    failure = await update(
      updates as unknown as CalendarChannelSettingsUpdates,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(CalendarChannelSettingsError);
  expect(failure).toMatchObject({
    code: CalendarChannelExceptionCode.INVALID_CALENDAR_CHANNEL_INPUT,
  });
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('captures caller, settings and audit actor before acquiring a connection', async () => {
  const caller = { userWorkspaceId: memberId, userId },
    updates: CalendarChannelSettingsUpdates = {
      visibility: CalendarChannelVisibility.SHARE_EVERYTHING,
    },
    op = operation(),
    runner = runtime.createQueryRunner(),
    connect = runner.connect.bind(runner);
  let changed = false;
  jest.spyOn(runner, 'connect').mockImplementation(async () => {
    const client = await connect();
    if (!changed) {
      changed = true;
      caller.userWorkspaceId = otherMemberId;
      caller.userId = otherUserId;
      updates.visibility = CalendarChannelVisibility.METADATA;
      op.actor = { kind: 'system', id: 'changed-later' };
    }
    return client;
  });
  jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
  const result = await update(updates, caller, op);
  expect(changed).toBe(true);
  expect(result.calendarChannel.visibility).toBe('SHARE_EVERYTHING');
  expect((await audits())[0].actor).toEqual({ kind: 'coreUser', id: userId });
});

it('preserves legacy reset after a skipped primary setting UPDATE and audits only its actual effects', async () => {
  await trigger(
    'BEFORE',
    'IF NEW."excludePrivateEvents" IS DISTINCT FROM OLD."excludePrivateEvents" THEN RETURN NULL; END IF; RETURN NEW;',
  );
  const result = await update({ excludePrivateEvents: true });
  expect(result.calendarChannel).toMatchObject({
    excludePrivateEvents: false,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    syncCursor: 'private-sync-cursor',
    throttleFailureCount: 7,
  });
  expect(result.resetChannel).toEqual({
    id: channelId,
    connectedAccountId: accountId,
  });
  expect((await read())[0]).toMatchObject({
    excludePrivateEvents: false,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    syncCursor: '',
    syncStageStartedAt: null,
    throttleFailureCount: 0,
  });
  const entries = await audits();
  expect(entries).toHaveLength(1);
  expect(entries[0].redactedDiff.changedFields).not.toContain(
    'excludePrivateEvents',
  );
  expect(entries[0].redactedDiff.changedFields).toContain('syncStage');
});

it('returns the retained pre-reset row without audit or reset marker when both UPDATEs are skipped', async () => {
  const before = await snapshot();
  await trigger('BEFORE', 'RETURN NULL;');
  const result = await update({ excludePrivateEvents: true });
  expect(result.calendarChannel).toMatchObject({
    excludePrivateEvents: false,
    syncCursor: 'private-sync-cursor',
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
  });
  expect(result.resetChannel).toBeUndefined();
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('rolls back settings and reset when audit append fails', async () => {
  const before = await snapshot();
  await auditTrigger("RAISE EXCEPTION 'calendar settings audit refusal';");
  const failure = await update({ excludePrivateEvents: true }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain('calendar settings audit refusal');
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it.each(['membership', 'account-owner', 'channel-parent'] as const)(
  'rejects late %s authority mutation and rolls back all effects',
  async (kind) => {
    let newAccountId: string | undefined;
    if (kind === 'channel-parent') {
      newAccountId = randomUUID();
      await f.owner.query(
        'INSERT INTO core."connectedAccount"(id,"workspaceId","userWorkspaceId",provider,scope) VALUES($1,$2,$3,\'google\',\'WORKSPACE\')',
        [newAccountId, f.workspaceId, memberId],
      );
    }
    const before = await snapshot();
    const body =
      kind === 'membership'
        ? `UPDATE core."userWorkspace" SET "userId"='${otherUserId}' WHERE id='${memberId}';`
        : kind === 'account-owner'
          ? `UPDATE core."connectedAccount" SET "userWorkspaceId"='${otherMemberId}' WHERE id='${accountId}';`
          : `UPDATE core."calendarChannel" SET "connectedAccountId"='${newAccountId}' WHERE id='${channelId}';`;
    await auditTrigger(body);
    await expect(update({ excludePrivateEvents: true })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('refuses actual incoming composite ON UPDATE CASCADE before it can mutate an unaudited row', async () => {
  await f.owner.query(
    'CREATE UNIQUE INDEX calendar_settings_pair ON core."calendarChannel"(id,"isSyncEnabled")',
  );
  await f.owner.query(
    'CREATE TABLE core.calendar_settings_child(id uuid PRIMARY KEY,"channelId" uuid,enabled boolean,FOREIGN KEY("channelId",enabled) REFERENCES core."calendarChannel"(id,"isSyncEnabled") ON UPDATE CASCADE)',
  );
  await f.owner.query(
    `GRANT SELECT ON core.calendar_settings_child TO "${f.roleName}"`,
  );
  await f.owner.query(
    'INSERT INTO core.calendar_settings_child VALUES($1,$2,true)',
    [randomUUID(), channelId],
  );
  const probe = f.owner.createQueryRunner();
  await probe.connect();
  await probe.startTransaction();
  try {
    await probe.query(
      'UPDATE core."calendarChannel" SET "isSyncEnabled"=false WHERE id=$1',
      [channelId],
    );
    expect(
      await probe.query('SELECT enabled FROM core.calendar_settings_child'),
    ).toEqual([{ enabled: false }]);
  } finally {
    await probe.rollbackTransaction();
    await probe.release();
  }
  const before = await snapshot(),
    child = await f.owner.query('SELECT * FROM core.calendar_settings_child');
  await expect(update({ isSyncEnabled: false })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(
    await f.owner.query('SELECT * FROM core.calendar_settings_child'),
  ).toEqual(child);
  expect(await audits()).toEqual([]);
});

it('drains deferred channel corruption before confirming settings and audit', async () => {
  const before = await snapshot();
  await trigger(
    'AFTER',
    `IF NEW.visibility='SHARE_EVERYTHING' THEN UPDATE core."calendarChannel" SET visibility='METADATA' WHERE id=NEW.id; END IF; RETURN NEW;`,
    true,
  );
  expect(
    await f.owner.query(
      "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid='core.\"calendarChannel\"'::regclass AND tgname='calendar_settings_test'",
    ),
  ).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  await expect(
    update({ visibility: CalendarChannelVisibility.SHARE_EVERYTHING }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('reports real lost COMMIT ACK while retaining the actual committed audited row', async () => {
  const runner = runtime.createQueryRunner(),
    client = await runner.connect(),
    original = client.query.bind(client);
  let failed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const result = await original(statement as string, values);
    if (
      !failed &&
      (typeof statement === 'string' ? statement : statement.text) === 'COMMIT'
    ) {
      failed = true;
      throw new Error('calendar settings ACK lost');
    }
    return result;
  }) as typeof client.query);
  jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
  await expect(update({ excludePrivateEvents: true })).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect((await read())[0]).toMatchObject({
    excludePrivateEvents: true,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    syncCursor: '',
  });
  expect(await audits()).toHaveLength(1);
});

it('waits for an actual membership revocation and refuses settings after that transaction commits', async () => {
  const beforeChannel = await read(),
    writer = f.owner.createQueryRunner(),
    runner = runtime.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  await runner.connect();
  const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE id=$1',
      [memberId],
    );
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
    pending = update({
      visibility: CalendarChannelVisibility.SHARE_EVERYTHING,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const deadline = Date.now() + 5000;
    let observed = false;
    while (Date.now() < deadline) {
      const [activity] = await f.owner.query(
        'SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1',
        [pid],
      );
      if (
        activity?.wait_event_type === 'Lock' &&
        activity.query.includes('userWorkspace')
      ) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    await writer.commitTransaction();
    const outcome = await pending;
    expect(outcome).toEqual({ error: expect.any(Error) });
    expect(await read()).toEqual(beforeChannel);
    expect(await audits()).toEqual([]);
    expect(
      (
        await f.owner.query(
          'SELECT "deletedAt" FROM core."userWorkspace" WHERE id=$1',
          [memberId],
        )
      )[0].deletedAt,
    ).not.toBeNull();
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    if (pending) await pending;
    if (!runner.isReleased) await runner.release();
  }
}, 20000);
