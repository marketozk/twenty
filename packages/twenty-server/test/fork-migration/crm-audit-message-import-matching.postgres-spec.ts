import { randomUUID } from 'node:crypto';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import {
  type MessageImportMatchingContext,
  type MessageImportMatchingManifest,
} from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import { MessageParticipantRole } from 'twenty-shared/types';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);

const f = createOmniNativeCleanupFixture();
const matcher = new MatchParticipantService<MessageParticipantWorkspaceEntity>(
  f.manager,
  new ParticipantTargetReconciliationService(f.manager, f.owner),
  {} as never,
  f.owner,
);
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const startedAt = '2030-01-01T00:00:00.123456Z';
const rows = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const graph = () =>
  Promise.all(
    [
      'messageThread',
      'message',
      'messageParticipant',
      'messageThreadTarget',
      'person',
      'workspaceMember',
      'company',
      'opportunity',
      'messageChannelMessageAssociation',
    ].map(rows),
  );
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .insert({ id, ...fields }),
  );
  f.eventEmitter.mockClear();
  return id;
};
type Origin = 'provider' | 'inbound' | 'sent' | 'application';
const seed = async (origin: Origin = 'inbound') => {
  const userId = randomUUID(),
    userWorkspaceId = randomUUID(),
    applicationId = randomUUID();
  await f.owner.query('INSERT INTO core."user"(id) VALUES($1)', [userId]);
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [userWorkspaceId, userId, f.workspaceId],
  );
  await f.owner.query(
    'INSERT INTO core.application(id,"workspaceId") VALUES($1,$2)',
    [applicationId, f.workspaceId],
  );
  const accountId = await f.coreInsert('connectedAccount', {
    workspaceId: f.workspaceId,
    provider: origin === 'application' ? 'app' : 'google',
    scope: 'USER',
    userWorkspaceId,
    applicationId: origin === 'application' ? applicationId : null,
  });
  const channelType =
    origin === 'application'
      ? 'APP'
      : origin === 'inbound'
        ? 'EMAIL_GROUP'
        : 'EMAIL';
  const channelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    type: channelType,
    connectedAccountId: accountId,
    handle: 'inbound@example.test',
    isSyncEnabled: true,
    syncStage: 'MESSAGES_IMPORT_ONGOING',
    syncStageStartedAt: startedAt,
  });
  const oldPersonId = await insert('person', { name: { firstName: 'Manual' } });
  const personId = await insert('person', {
    name: { firstName: 'Match' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
  });
  const oldMemberId = await insert('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Old' },
    userEmail: 'old@example.test',
  });
  const memberId = await insert('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Match' },
    userEmail: 'client@example.test',
  });
  const threadId = await insert('messageThread', { subject: 'Saved import' });
  const messageId = await insert('message', {
    messageThreadId: threadId,
    headerMessageId: randomUUID(),
  });
  const participantId = await insert('messageParticipant', {
    messageId,
    personId: oldPersonId,
    workspaceMemberId: oldMemberId,
    handle: 'client@example.test',
    role: 'FROM',
  });
  const associationId = await insert('messageChannelMessageAssociation', {
    messageId,
    messageChannelId: channelId,
    messageExternalId: 'import',
    messageThreadExternalId: 'import-thread',
    direction: 'INCOMING',
  });
  const common = {
    workspaceId: f.workspaceId,
    connectedAccountId: accountId,
    channelId,
    channelType,
  };
  const authority: MessageImportMatchingContext['authority'] =
    origin === 'provider'
      ? {
          ...common,
          kind: 'provider',
          run: {
            workspaceId: f.workspaceId,
            connectedAccountId: accountId,
            channelId,
            kind: 'message',
            stage: 'MESSAGES_IMPORT_ONGOING',
            startedAt,
          },
        }
      : origin === 'inbound'
        ? { ...common, kind: 'inbound', recipient: 'inbound@example.test' }
        : origin === 'sent'
          ? {
              ...common,
              kind: 'sent',
              userWorkspaceId,
              effectiveUserId: userId,
            }
          : {
              ...common,
              kind: 'application',
              applicationId,
              requestUserWorkspaceId: userWorkspaceId,
            };
  const context: MessageImportMatchingContext = {
    authority,
    operation: {
      workspaceId: f.workspaceId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      actor:
        origin === 'application'
          ? { kind: 'application', id: applicationId }
          : origin === 'sent'
            ? { kind: 'coreUser', id: userId }
            : { kind: 'system', id: 'MessageImportTest' },
    },
  };
  const manifest: MessageImportMatchingManifest = {
    mode: origin === 'application' ? 'targetsOnly' : 'both',
    messages: [{ messageId, messageThreadId: threadId }],
    participants: [
      {
        id: participantId,
        messageId,
        handle: 'client@example.test',
        personId: oldPersonId,
        workspaceMemberId: oldMemberId,
      },
    ],
  };
  return {
    context,
    manifest,
    accountId,
    channelId,
    threadId,
    messageId,
    participantId,
    associationId,
    personId,
    oldPersonId,
    memberId,
    oldMemberId,
    userId,
    userWorkspaceId,
    applicationId,
  };
};
const apply = async (
  context: MessageImportMatchingContext,
  manifest: MessageImportMatchingManifest,
) =>
  matcher.matchMessageImportParticipantsWithAudit({
    workspaceId: f.workspaceId,
    context,
    manifest,
  });
const participant = async (id: string) =>
  (
    await f.owner.query(
      `SELECT * FROM ${table('messageParticipant')} WHERE id=$1`,
      [id],
    )
  )[0];
const capture = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const causes = (error: unknown) => {
  const messages: string[] = [],
    seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const current = error as { message?: unknown; cause?: unknown };
    if (typeof current.message === 'string') messages.push(current.message);
    error = current.cause;
  }
  return messages.join(' | ');
};
const trigger = async (body: string, deferred = false) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".import_matching_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER import_matching_test AFTER INSERT ON crm_audit."crmAuditEntry" ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".import_matching_test()`,
  );
const intercept = async (observe: (sql: string) => Promise<void>) => {
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  const spy = jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    await observe(sql);
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  return () => spy.mockRestore();
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD scope text,ADD "userWorkspaceId" uuid,ADD "archivedAt" timestamptz',
  );
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "isSyncEnabled" boolean,ADD "syncStage" text,ADD "syncStageStartedAt" timestamptz',
  );
  await f.owner.query(
    'CREATE TABLE core."user"(id uuid PRIMARY KEY,disabled boolean NOT NULL DEFAULT false,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid NOT NULL,"workspaceId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core.agent(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"applicationId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS import_matching_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".import_matching_test()`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core."user",core."userWorkspace",core.application,core.agent CASCADE',
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it.each(['provider', 'inbound', 'sent'] as const)(
  'actual %s authority matches both fields only for explicitly touched participants',
  async (origin) => {
    const s = await seed(origin);
    const untouchedId = await insert('messageParticipant', {
      messageId: s.messageId,
      personId: s.oldPersonId,
      workspaceMemberId: s.oldMemberId,
      handle: 'client@example.test',
      role: 'TO',
    });
    const untouched = await participant(untouchedId);
    expect(await apply(s.context, s.manifest)).toBe('applied');
    expect(await participant(s.participantId)).toMatchObject({
      personId: s.personId,
      workspaceMemberId: s.memberId,
    });
    expect(await participant(untouchedId)).toEqual(untouched);
    const targetRows = await f.owner.query(
      `SELECT "targetPersonId" FROM ${table('messageThreadTarget')} ORDER BY "targetPersonId"`,
    );
    expect(targetRows).toEqual(
      [s.personId, s.oldPersonId]
        .sort()
        .map((targetPersonId) => ({ targetPersonId })),
    );
    const entries = await audit();
    expect(
      entries.filter(
        (entry: { resourceId: string }) => entry.resourceId === s.participantId,
      ),
    ).toHaveLength(1);
    for (const entry of entries)
      expect(entry.actor).toEqual(s.context.operation.actor);
  },
);

it('empty touched list refreshes saved-message targets while preserving historical links', async () => {
  const s = await seed(),
    before = await rows('messageParticipant');
  await apply(s.context, { ...s.manifest, participants: [] });
  expect(await rows('messageParticipant')).toEqual(before);
  expect(
    await f.owner.query(
      `SELECT "targetPersonId" FROM ${table('messageThreadTarget')}`,
    ),
  ).toEqual([{ targetPersonId: s.oldPersonId }]);
  expect(await audit()).toHaveLength(1);
});

it('APP targetsOnly retains non-email identities and requires no member matching', async () => {
  const s = await seed('application');
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET handle='telegram:opaque' WHERE id=$1`,
    [s.participantId],
  );
  const before = await rows('messageParticipant');
  await apply(s.context, {
    ...s.manifest,
    participants: [
      { ...s.manifest.participants[0], handle: 'telegram:opaque' },
    ],
  });
  expect(await rows('messageParticipant')).toEqual(before);
  expect(
    await f.owner.query(
      `SELECT "targetPersonId" FROM ${table('messageThreadTarget')}`,
    ),
  ).toEqual([{ targetPersonId: s.oldPersonId }]);
});

it('a newer manual link skips touched matching but independently admitted message still refreshes its targets', async () => {
  const s = await seed();
  const manualPerson = await insert('person', {
    name: { firstName: 'New manual' },
  });
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET "personId"=$1 WHERE id=$2`,
    [manualPerson, s.participantId],
  );
  await apply(s.context, s.manifest);
  expect(await participant(s.participantId)).toMatchObject({
    personId: manualPerson,
    workspaceMemberId: s.oldMemberId,
  });
  expect(
    await f.owner.query(
      `SELECT "targetPersonId" FROM ${table('messageThreadTarget')}`,
    ),
  ).toEqual([{ targetPersonId: manualPerson }]);
});

it('a moved explicit Message cannot authorize the replacement Thread or clear the former Thread', async () => {
  const s = await seed();
  await insert('messageThreadTarget', {
    messageThreadId: s.threadId,
    targetPersonId: s.oldPersonId,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
  });
  const replacement = await insert('messageThread', { subject: 'Moved' });
  await f.owner.query(
    `UPDATE ${table('message')} SET "messageThreadId"=$1 WHERE id=$2`,
    [replacement, s.messageId],
  );
  const before = await graph();
  await apply(s.context, s.manifest);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('audit failure rolls back both identity fields and targets after a saved Message already exists', async () => {
  const s = await seed(),
    before = await graph();
  await trigger("RAISE EXCEPTION 'import matching audit refused';");
  const result = await capture(apply(s.context, s.manifest));
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(causes(result.error)).toContain('import matching audit refused');
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('provider matching rechecks exact run after save and returns stale without matching effects', async () => {
  const s = await seed('provider');
  await f.owner.query(
    'UPDATE core."messageChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval \'1 microsecond\' WHERE id=$1',
    [s.channelId],
  );
  const before = await graph();
  expect(await apply(s.context, s.manifest)).toBe('stale-run');
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('inbound EMAIL_GROUP preserves eligibility when ordinary provider sync is disabled', async () => {
  const s = await seed('inbound');
  await f.owner.query(
    'UPDATE core."messageChannel" SET "isSyncEnabled"=false WHERE id=$1',
    [s.channelId],
  );
  expect(await apply(s.context, s.manifest)).toBe('applied');
  expect(await participant(s.participantId)).toMatchObject({
    personId: s.personId,
    workspaceMemberId: s.memberId,
  });
});

it.each(['recipient', 'account', 'mode'] as const)(
  'inbound changed %s authority refuses before matching',
  async (kind) => {
    const s = await seed();
    if (kind === 'recipient')
      await f.owner.query(
        'UPDATE core."messageChannel" SET handle=\'changed@example.test\' WHERE id=$1',
        [s.channelId],
      );
    if (kind === 'account')
      await f.owner.query(
        'UPDATE core."messageChannel" SET "connectedAccountId"=$1 WHERE id=$2',
        [randomUUID(), s.channelId],
      );
    if (kind === 'mode')
      await f.owner.query(
        'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
        [s.channelId],
      );
    const before = await graph();
    const result = await capture(apply(s.context, s.manifest));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        kind === 'recipient'
          ? 'Native message import inbound channel changed'
          : 'Native message import channel changed',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it.each(['removed-member', 'disabled-user', 'private-transfer'] as const)(
  'sent current %s authority refuses matching after provider success',
  async (kind) => {
    const s = await seed('sent');
    if (kind === 'removed-member')
      await f.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [s.userWorkspaceId],
      );
    if (kind === 'disabled-user')
      await f.owner.query('UPDATE core."user" SET disabled=true WHERE id=$1', [
        s.userId,
      ]);
    if (kind === 'private-transfer')
      await f.owner.query(
        'UPDATE core."connectedAccount" SET "userWorkspaceId"=$1 WHERE id=$2',
        [randomUUID(), s.accountId],
      );
    const before = await graph();
    const result = await capture(apply(s.context, s.manifest));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        kind === 'private-transfer'
          ? 'Native message import account unavailable'
          : 'Native message import caller unavailable',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('sent WORKSPACE account remains usable by the current member after owner transfer', async () => {
  const s = await seed('sent');
  await f.owner.query(
    'UPDATE core."connectedAccount" SET scope=\'WORKSPACE\',"userWorkspaceId"=$1 WHERE id=$2',
    [randomUUID(), s.accountId],
  );
  expect(await apply(s.context, s.manifest)).toBe('applied');
});

it('background application reaches its own private account without a request member', async () => {
  const s = await seed('application');
  if (s.context.authority.kind !== 'application')
    throw new Error('Application fixture required');
  expect(
    await apply(
      {
        ...s.context,
        authority: { ...s.context.authority, requestUserWorkspaceId: null },
      },
      s.manifest,
    ),
  ).toBe('applied');
});

it.each(['foreign-application', 'removed-member', 'disabled-sync'] as const)(
  'application %s authority refuses matching',
  async (kind) => {
    const s = await seed('application');
    if (kind === 'foreign-application')
      await f.owner.query(
        'UPDATE core."connectedAccount" SET "applicationId"=$1 WHERE id=$2',
        [randomUUID(), s.accountId],
      );
    if (kind === 'removed-member')
      await f.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [s.userWorkspaceId],
      );
    if (kind === 'disabled-sync')
      await f.owner.query(
        'UPDATE core."messageChannel" SET "isSyncEnabled"=false WHERE id=$1',
        [s.channelId],
      );
    const before = await graph();
    const result = await capture(apply(s.context, s.manifest));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        kind === 'removed-member'
          ? 'Native message import caller unavailable'
          : 'Native message import application channel unavailable',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('lost COMMIT acknowledgement retains real committed matching and audit', async () => {
  const s = await seed();
  let committed = false;
  const restore = await intercept(async (sql) => {
    if (sql === 'COMMIT') {
      committed = true;
      throw new Error('import matching ACK lost');
    }
  });
  try {
    await expect(apply(s.context, s.manifest)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
  } finally {
    restore();
  }
  expect(committed).toBe(true);
  expect(await participant(s.participantId)).toMatchObject({
    personId: s.personId,
    workspaceMemberId: s.memberId,
  });
  expect((await audit()).length).toBeGreaterThan(0);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

const aggregateFixture = async () => {
  const s = await seed('inbound');
  const contacts = { add: jest.fn().mockResolvedValue(undefined) };
  const messageParticipants = new MessagingMessageParticipantService(
    f.manager,
    matcher,
  );
  const aggregate: MessagingSaveMessagesAndEnqueueContactCreationService =
    Object.assign(
      Object.create(
        MessagingSaveMessagesAndEnqueueContactCreationService.prototype,
      ),
      {
        workspaceOrmManager: f.manager,
        messageService: new MessagingMessageService(f.manager),
        messageParticipantService: messageParticipants,
        messageFolderAssociationService:
          new MessagingMessageFolderAssociationService(f.manager),
        messageQueueService: contacts,
      },
    );
  const headerMessageId = randomUUID();
  const payload = [
    {
      externalId: 'aggregate-message',
      headerMessageId,
      messageThreadExternalId: 'aggregate-thread',
      subject: 'Aggregate',
      text: 'Synthetic content',
      receivedAt: new Date('2030-01-01'),
      isDraft: false,
      direction: MessageDirection.INCOMING,
      attachments: [],
      messageFolderIds: [],
      participants: [
        {
          handle: 'client@example.test',
          displayName: 'Client',
          role: MessageParticipantRole.FROM,
        },
      ],
    },
  ];
  const channel = {
    id: s.channelId,
    workspaceId: f.workspaceId,
    connectedAccountId: s.accountId,
    type: 'EMAIL_GROUP',
    handle: 'inbound@example.test',
    isContactAutoCreationEnabled: true,
    contactAutoCreationPolicy: 'SENT_AND_RECEIVED',
    excludeNonProfessionalEmails: false,
    excludeGroupEmails: false,
  };
  const account = {
    id: s.accountId,
    workspaceId: f.workspaceId,
    handle: 'manager@example.test',
    handleAliases: [],
  };
  const run = () =>
    aggregate.saveMessagesAndEnqueueContactCreation(
      payload as never,
      channel as never,
      account as never,
      f.workspaceId,
      { context: s.context },
    );
  const savedParticipant = async () =>
    (
      await f.owner.query(
        `SELECT participant.* FROM ${table('messageParticipant')} participant JOIN ${table('message')} message ON message.id=participant."messageId" WHERE message."headerMessageId"=$1`,
        [headerMessageId],
      )
    )[0];
  return {
    ...s,
    contacts,
    aggregate,
    messageParticipants,
    run,
    savedParticipant,
  };
};

it('actual aggregate commits save before contact queue and actual audited matching', async () => {
  const s = await aggregateFixture();
  let queued = false;
  s.contacts.add.mockImplementationOnce(async () => {
    queued = true;
    expect(await s.savedParticipant()).toMatchObject({
      personId: null,
      workspaceMemberId: null,
    });
    expect(await audit()).toEqual([]);
  });
  const result = await s.run();
  expect(queued).toBe(true);
  expect(result).toBeDefined();
  expect(await s.savedParticipant()).toMatchObject({
    personId: s.personId,
    workspaceMemberId: s.memberId,
  });
  expect((await audit()).length).toBeGreaterThan(0);
});

it('a failed queue preserves saved rows and identical retry exposes the documented lost touched-set gap', async () => {
  const s = await aggregateFixture();
  const failure = new Error('contact queue failed after save');
  s.contacts.add.mockRejectedValueOnce(failure);
  await expect(s.run()).rejects.toBe(failure);
  expect(await s.savedParticipant()).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
  expect(await audit()).toEqual([]);
  const match = jest.spyOn(s.messageParticipants, 'matchMessageParticipants');
  await s.run();
  expect(match).toHaveBeenCalledTimes(1);
  expect(match.mock.calls[0][0].manifest.participants).toEqual([]);
  expect(match.mock.calls[0][0].manifest.messages).toHaveLength(1);
  expect(await s.savedParticipant()).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
});

it('actual matching failure rolls back matching while the aggregate save remains committed', async () => {
  const s = await aggregateFixture();
  await trigger("RAISE EXCEPTION 'post-save matching audit refused';");
  const result = await capture(s.run());
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(causes(result.error)).toContain('post-save matching audit refused');
  expect(await s.savedParticipant()).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
  expect(await audit()).toEqual([]);
  expect(s.contacts.add).toHaveBeenCalledTimes(1);
});

it('more than 200 touched participants share one Message across independent audited pages', async () => {
  const s = await seed();
  const additional = Array.from({ length: 200 }, () => ({
    id: randomUUID(),
    messageId: s.messageId,
    handle: 'client@example.test',
    personId: s.oldPersonId,
    workspaceMemberId: s.oldMemberId,
  }));
  await f.seedNative((scope) =>
    scope
      .getRepository('messageParticipant', {
        shouldBypassPermissionChecks: true,
      })
      .insert(additional.map((row) => ({ ...row, role: 'TO' }))),
  );
  f.eventEmitter.mockClear();
  await apply(s.context, {
    ...s.manifest,
    participants: [...s.manifest.participants, ...additional],
  });
  const actual = await f.owner.query(
    `SELECT "personId","workspaceMemberId" FROM ${table('messageParticipant')} WHERE "messageId"=$1`,
    [s.messageId],
  );
  expect(actual).toHaveLength(201);
  for (const row of actual)
    expect(row).toEqual({
      personId: s.personId,
      workspaceMemberId: s.memberId,
    });
  const entries = await audit();
  const participantIds = new Set<string>([
    s.participantId,
    ...additional.map((row) => row.id),
  ]);
  expect(
    entries.filter((entry: { resourceId: string }) =>
      participantIds.has(entry.resourceId),
    ),
  ).toHaveLength(201);
  expect(
    new Set(entries.map((entry: { operationId: string }) => entry.operationId))
      .size,
  ).toBe(2);
  expect(
    new Set(
      entries.map((entry: { correlationId: string }) => entry.correlationId),
    ),
  ).toEqual(new Set([s.context.operation.correlationId]));
});

it('deferred authority drift rolls back matching and audit after the initial channel proof', async () => {
  const s = await seed(),
    before = await graph();
  await trigger(
    `UPDATE core."messageChannel" SET handle='drift@example.test' WHERE id='${s.channelId}';`,
    true,
  );
  const result = await capture(apply(s.context, s.manifest));
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(causes(result.error)).toContain(
      'Native message import authority changed',
    );
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(
    (
      await f.owner.query(
        'SELECT handle FROM core."messageChannel" WHERE id=$1',
        [s.channelId],
      )
    )[0].handle,
  ).toBe('inbound@example.test');
});

it.each([false, true])(
  'sent-tool preserves authorized capability with nullable member (%s)',
  async (includeMember) => {
    const s = await seed('sent');
    const context: MessageImportMatchingContext = {
      operation: s.context.operation,
      authority: {
        workspaceId: f.workspaceId,
        connectedAccountId: s.accountId,
        channelId: s.channelId,
        channelType: 'EMAIL',
        kind: 'sent-tool',
        userWorkspaceId: includeMember ? s.userWorkspaceId : null,
        effectiveUserId: s.userId,
      },
    };
    await f.owner.query(
      'UPDATE core."connectedAccount" SET "userWorkspaceId"=$1 WHERE id=$2',
      [randomUUID(), s.accountId],
    );
    expect(await apply(context, s.manifest)).toBe('applied');
    expect(await participant(s.participantId)).toMatchObject({
      personId: s.personId,
      workspaceMemberId: s.memberId,
    });
  },
);

it.each(['application', 'agent'] as const)(
  'sent-tool retains %s attribution on an ordinary authorized account',
  async (kind) => {
    const s = await seed('sent');
    const actor = {
      kind,
      id: kind === 'application' ? s.applicationId : randomUUID(),
    };
    if (kind === 'agent')
      await f.owner.query(
        'INSERT INTO core.agent(id,"workspaceId","applicationId") VALUES($1,$2,$3)',
        [actor.id, f.workspaceId, s.applicationId],
      );
    const context: MessageImportMatchingContext = {
      operation: {
        ...s.context.operation,
        actor,
        initiator: { kind: 'coreUser', id: s.userId },
      },
      authority: {
        workspaceId: f.workspaceId,
        connectedAccountId: s.accountId,
        channelId: s.channelId,
        channelType: 'EMAIL',
        kind: 'sent-tool',
        userWorkspaceId: null,
        applicationId: s.applicationId,
      },
    };
    expect(await apply(context, s.manifest)).toBe('applied');
    for (const entry of await audit()) {
      expect(entry.actor).toEqual(actor);
      expect(entry.initiator).toEqual(context.operation.initiator);
    }
  },
);

it.each(['user', 'application'] as const)(
  'sent-tool rejects a stale current %s before matching',
  async (kind) => {
    const s = await seed('sent');
    const context: MessageImportMatchingContext = {
      operation: {
        ...s.context.operation,
        actor:
          kind === 'application'
            ? { kind: 'application', id: s.applicationId }
            : s.context.operation.actor,
      },
      authority: {
        workspaceId: f.workspaceId,
        connectedAccountId: s.accountId,
        channelId: s.channelId,
        channelType: 'EMAIL',
        kind: 'sent-tool',
        userWorkspaceId: null,
        ...(kind === 'application'
          ? { applicationId: s.applicationId }
          : { effectiveUserId: s.userId }),
      },
    };
    if (kind === 'user')
      await f.owner.query('UPDATE core."user" SET disabled=true WHERE id=$1', [
        s.userId,
      ]);
    else
      await f.owner.query(
        'UPDATE core.application SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [s.applicationId],
      );
    const before = await graph();
    const result = await capture(apply(context, s.manifest));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        kind === 'user'
          ? 'Native message import caller unavailable'
          : 'Native message import application unavailable',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it.each(['sent', 'sent-tool'] as const)(
  '%s matching refuses an archived account after provider send',
  async (kind) => {
    const s = await seed('sent');
    const context: MessageImportMatchingContext =
      kind === 'sent'
        ? s.context
        : {
            operation: s.context.operation,
            authority: {
              workspaceId: f.workspaceId,
              connectedAccountId: s.accountId,
              channelId: s.channelId,
              channelType: 'EMAIL',
              kind: 'sent-tool',
              userWorkspaceId: null,
              effectiveUserId: s.userId,
            },
          };
    await f.owner.query(
      'UPDATE core."connectedAccount" SET "archivedAt"=CURRENT_TIMESTAMP WHERE id=$1',
      [s.accountId],
    );
    const before = await graph(),
      result = await capture(apply(context, s.manifest));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        'Native message import account archived',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);
