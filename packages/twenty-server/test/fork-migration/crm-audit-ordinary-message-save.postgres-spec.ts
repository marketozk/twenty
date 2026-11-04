import { randomUUID } from 'node:crypto';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { type MessageImportMatchingContext } from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import {
  MessageChannelContactAutoCreationPolicy,
  MessageChannelType,
  MessageParticipantRole,
} from 'twenty-shared/types';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';

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
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt", "resourceId"',
  );
const graph = () =>
  Promise.all(
    [
      'messageThread',
      'message',
      'messageParticipant',
      'messageChannelMessageAssociation',
      'messageChannelMessageAssociationMessageFolder',
      'messageThreadTarget',
      'person',
      'workspaceMember',
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
const capture = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const causes = (error: unknown) => {
  const messages: string[] = [],
    seen = new Set<object>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ');
};

type Origin = 'provider' | 'inbound' | 'sent' | 'sent-tool' | 'application';

const seed = async (origin: Origin = 'inbound') => {
  const userId = randomUUID(),
    userWorkspaceId = randomUUID(),
    applicationId = randomUUID(),
    folderId = randomUUID();
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
      ? MessageChannelType.APP
      : origin === 'inbound'
        ? MessageChannelType.EMAIL_GROUP
        : MessageChannelType.EMAIL;
  const channelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    type: channelType,
    connectedAccountId: accountId,
    handle: 'inbound@example.test',
    isSyncEnabled: true,
    syncStage: 'MESSAGES_IMPORT_ONGOING',
    syncStageStartedAt: startedAt,
  });
  await f.owner.query(
    'INSERT INTO core."messageFolder"(id,"workspaceId","messageChannelId") VALUES($1,$2,$3)',
    [folderId, f.workspaceId, channelId],
  );
  const personId = await insert('person', {
    name: { firstName: 'Match' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
  });
  const memberId = await insert('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Member' },
    userEmail: 'client@example.test',
  });
  const expectedRun: OrdinaryMetadataSyncRun | undefined =
    origin === 'provider'
      ? {
          workspaceId: f.workspaceId,
          connectedAccountId: accountId,
          channelId,
          kind: 'message',
          stage: 'MESSAGES_IMPORT_ONGOING' as never,
          startedAt,
        }
      : undefined;
  const common = {
    workspaceId: f.workspaceId,
    connectedAccountId: accountId,
    channelId,
    channelType,
  };
  const authority: MessageImportMatchingContext['authority'] =
    origin === 'provider'
      ? { ...common, kind: 'provider', run: expectedRun! }
      : origin === 'inbound'
        ? { ...common, kind: 'inbound', recipient: 'inbound@example.test' }
        : origin === 'sent'
          ? {
              ...common,
              kind: 'sent',
              userWorkspaceId,
              effectiveUserId: userId,
            }
          : origin === 'sent-tool'
            ? {
                ...common,
                kind: 'sent-tool',
                userWorkspaceId: null,
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
          : origin === 'sent' || origin === 'sent-tool'
            ? { kind: 'coreUser', id: userId }
            : { kind: 'system', id: 'MessageSaveTest' },
    },
  };
  const contacts = { add: jest.fn().mockResolvedValue(undefined) };
  const messageParticipants = new MessagingMessageParticipantService(
    f.manager,
    matcher,
  );
  const matchSpy = jest
    .spyOn(messageParticipants, 'matchMessageParticipants')
    .mockResolvedValue('applied');
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
  const channel = {
    id: channelId,
    workspaceId: f.workspaceId,
    connectedAccountId: accountId,
    type: channelType,
    handle: 'inbound@example.test',
    isContactAutoCreationEnabled: true,
    contactAutoCreationPolicy:
      MessageChannelContactAutoCreationPolicy.SENT_AND_RECEIVED,
    excludeNonProfessionalEmails: false,
    excludeGroupEmails: false,
  };
  const account = {
    id: accountId,
    workspaceId: f.workspaceId,
    handle: 'manager@example.test',
    handleAliases: ['alias@example.test'],
  };
  const makeMessage = (
    overrides: Partial<MessageWithParticipants> = {},
  ): MessageWithParticipants => ({
    externalId: 'ext-1',
    headerMessageId: 'hdr-1',
    messageThreadExternalId: 'thr-1',
    subject: 'Private subject',
    text: 'Private message body',
    receivedAt: new Date('2030-01-02T10:00:00.000Z'),
    isDraft: false,
    direction: MessageDirection.INCOMING,
    attachments: [],
    messageFolderIds: [folderId],
    participants: [
      {
        handle: 'client@example.test',
        displayName: 'Private Client Name',
        role: MessageParticipantRole.FROM,
      },
    ],
    ...overrides,
  });
  const save = (
    batch: MessageWithParticipants[] = [makeMessage()],
    customContext: MessageImportMatchingContext = context,
    customRun: OrdinaryMetadataSyncRun | undefined = expectedRun,
  ) =>
    aggregate.saveMessagesAndEnqueueContactCreation(
      batch,
      channel as never,
      account as never,
      f.workspaceId,
      {
        context: customContext,
        ...(customRun ? { expectedRun: customRun } : {}),
      },
    );

  return {
    userId,
    userWorkspaceId,
    applicationId,
    accountId,
    channelId,
    folderId,
    personId,
    memberId,
    context,
    expectedRun,
    contacts,
    messageParticipants,
    matchSpy,
    aggregate,
    channel,
    account,
    makeMessage,
    save,
  };
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
  for (const target of [
    'crm_audit."crmAuditEntry"',
    table('messageThread'),
    table('message'),
    table('messageChannelMessageAssociation'),
    table('messageParticipant'),
    table('messageChannelMessageAssociationMessageFolder'),
  ]) {
    await f.owner.query(
      `DROP TRIGGER IF EXISTS save_test_trigger ON ${target}`,
    );
  }
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".save_test_trigger()`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core."user",core."userWorkspace",core.application,core.agent CASCADE',
  );
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it.each(['provider', 'inbound', 'sent', 'sent-tool', 'application'] as const)(
  'commits five native tables with one redacted audit operation for %s authority',
  async (origin) => {
    const s = await seed(origin);
    const result = await s.save();
    expect(result).toBeDefined();
    expect(await f.read('messageThread')).toHaveLength(1);
    expect(await f.read('message')).toHaveLength(1);
    expect(await f.read('messageChannelMessageAssociation')).toHaveLength(1);
    expect(await f.read('messageParticipant')).toHaveLength(1);
    expect(
      await f.read('messageChannelMessageAssociationMessageFolder'),
    ).toHaveLength(1);
    const entries = await audit();
    expect(entries).toHaveLength(5);
    expect(
      entries.every(
        (entry: { action: string; resourceKind: string; outcome: string }) =>
          entry.action === 'create' &&
          entry.resourceKind === 'crmRecord' &&
          entry.outcome === 'success',
      ),
    ).toBe(true);
    expect(
      new Set(
        entries.map((entry: { operationId: string }) => entry.operationId),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        entries.map((entry: { correlationId: string }) => entry.correlationId),
      ),
    ).toEqual(new Set([s.context.operation.correlationId]));
    expect(
      new Set(
        entries.map((entry: { actor: { kind: string } }) => entry.actor.kind),
      ),
    ).toEqual(new Set([s.context.operation.actor.kind]));
    expect(JSON.stringify(entries)).not.toContain('Private subject');
    expect(JSON.stringify(entries)).not.toContain('Private message body');
    expect(JSON.stringify(entries)).not.toContain('Private Client Name');
    expect(JSON.stringify(entries)).not.toContain('client@example.test');
    expect(s.contacts.add).toHaveBeenCalledTimes(1);
    expect(s.matchSpy).toHaveBeenCalledTimes(1);
  },
);

it('retains the latest receivedAt subject across multiple messages sharing a new or existing Thread', async () => {
  const s = await seed();
  await s.save([
    s.makeMessage({
      externalId: 'msg-newer',
      headerMessageId: 'hdr-newer',
      subject: 'Newer subject',
      receivedAt: new Date('2030-01-03T10:00:00.000Z'),
    }),
    s.makeMessage({
      externalId: 'msg-older',
      headerMessageId: 'hdr-older',
      subject: 'Older subject',
      receivedAt: new Date('2030-01-01T10:00:00.000Z'),
    }),
  ]);
  const threadsAfterCreate = await f.read('messageThread');
  expect(threadsAfterCreate).toHaveLength(1);
  expect(threadsAfterCreate[0].subject).toBe('Newer subject');
  const threadAuditAfterCreate = (await audit()).filter(
    (entry: { resourceId: string }) =>
      entry.resourceId === threadsAfterCreate[0].id,
  );
  expect(threadAuditAfterCreate).toHaveLength(1);
  expect(threadAuditAfterCreate[0].action).toBe('create');

  await s.save([
    s.makeMessage({
      externalId: 'msg-latest',
      headerMessageId: 'hdr-latest',
      subject: 'Latest subject on existing thread',
      receivedAt: new Date('2030-01-05T10:00:00.000Z'),
    }),
  ]);
  const threadsAfterUpdate = await f.read('messageThread');
  expect(threadsAfterUpdate).toHaveLength(1);
  expect(threadsAfterUpdate[0].subject).toBe(
    'Latest subject on existing thread',
  );
  const threadAuditAfterUpdate = (await audit()).filter(
    (entry: { resourceId: string }) =>
      entry.resourceId === threadsAfterUpdate[0].id,
  );
  expect(
    threadAuditAfterUpdate.map((e: { action: string }) => e.action),
  ).toEqual(['create', 'update']);
});

it('re-delivery of an existing message reuses Thread and Message without fabricated diffs and updates participant identity when supplied', async () => {
  const s = await seed();
  await s.save();
  const initialAuditCount = (await audit()).length;
  expect(initialAuditCount).toBe(5);

  await s.save();
  expect((await audit()).length).toBe(initialAuditCount);
  expect(s.matchSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({
      manifest: expect.objectContaining({ participants: [] }),
    }),
  );

  await s.save([
    s.makeMessage({
      participants: [
        {
          handle: 'client@example.test',
          displayName: 'Updated Display Name',
          role: MessageParticipantRole.FROM,
          personId: s.personId,
          workspaceMemberId: s.memberId,
        },
      ],
    }),
  ]);
  const entries = await audit();
  expect(entries).toHaveLength(initialAuditCount + 1);
  expect(entries[entries.length - 1]).toMatchObject({
    action: 'update',
    resourceKind: 'crmRecord',
  });
  expect(s.matchSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({
      manifest: expect.objectContaining({
        participants: [
          expect.objectContaining({
            personId: s.personId,
            workspaceMemberId: s.memberId,
          }),
        ],
      }),
    }),
  );
});

it('skipped optional participant update retains old image and omits participant from touched manifest', async () => {
  const s = await seed();
  await s.save();
  const initialAudit = await audit();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".save_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER save_test_trigger BEFORE UPDATE ON ${table('messageParticipant')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".save_test_trigger()`,
  );
  await s.save([
    s.makeMessage({
      participants: [
        {
          handle: 'client@example.test',
          displayName: 'Skipped Update',
          role: MessageParticipantRole.FROM,
          personId: s.personId,
        },
      ],
    }),
  ]);
  const stored = (await f.read('messageParticipant'))[0];
  expect(stored.personId).toBeNull();
  expect(stored.displayName).toBe('Private Client Name');
  expect(await audit()).toEqual(initialAudit);
  expect(s.matchSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({
      manifest: expect.objectContaining({ participants: [] }),
    }),
  );
});

it.each([
  ['messageThread', 'RETURN NULL', 'skipped thread required by dependent plan'],
  ['message', 'RETURN NULL', 'skipped message required by dependent plan'],
  [
    'messageChannelMessageAssociation',
    'RETURN NULL',
    'skipped association required by dependent plan',
  ],
  [
    'messageParticipant',
    'RETURN NULL',
    'skipped participant required by dependent plan',
  ],
  [
    'messageChannelMessageAssociationMessageFolder',
    'RETURN NULL',
    'skipped folder junction required by dependent plan',
  ],
  ['message', 'NEW."isDraft" := true; RETURN NEW', 'inserted values mismatch'],
] as const)(
  'rolls back all tables when BEFORE INSERT on %s executes %s',
  async (targetTable, body, expectedMessage) => {
    const s = await seed();
    const before = await graph();
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".save_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$; CREATE TRIGGER save_test_trigger BEFORE INSERT ON ${table(targetTable)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".save_test_trigger()`,
    );
    const outcome = await capture(s.save());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(causes(outcome.error)).toContain(expectedMessage);
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(s.contacts.add).not.toHaveBeenCalled();
    expect(s.matchSpy).not.toHaveBeenCalled();
  },
);

it.each([
  [
    'target-insert',
    (schema: string, s: Awaited<ReturnType<typeof seed>>) =>
      `INSERT INTO "${schema}"."messageThreadTarget"(id,"messageThreadId","targetPersonId") SELECT '${randomUUID()}',id,'${s.personId}' FROM "${schema}"."messageThread" LIMIT 1 ON CONFLICT (id) DO NOTHING`,
    'Message save graph effects mismatch',
  ],
  [
    'person-source-mutation',
    (schema: string, s: Awaited<ReturnType<typeof seed>>) =>
      `UPDATE "${schema}".person SET "nameFirstName"='Tampered' WHERE id='${s.personId}'`,
    'Message save participant source changed before commit',
  ],
  [
    'folder-authority-mutation',
    (_schema: string, s: Awaited<ReturnType<typeof seed>>) =>
      `UPDATE core."messageFolder" SET "workspaceId"='${randomUUID()}' WHERE id='${s.folderId}'`,
    'Message save folder authority changed before commit',
  ],
  [
    'channel-authority-mutation',
    (_schema: string, s: Awaited<ReturnType<typeof seed>>) =>
      `UPDATE core."messageChannel" SET handle='tampered@example.test' WHERE id='${s.channelId}'`,
    'Native message import authority changed',
  ],
] as const)(
  'rolls back save and audit when deferred trigger causes %s',
  async (_kind, buildSql, expectedMessage) => {
    const s = await seed();
    const before = await graph();
    const statement = buildSql(f.schemaName, s);
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".save_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${statement}; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER save_test_trigger AFTER INSERT ON crm_audit."crmAuditEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".save_test_trigger()`,
    );
    const outcome = await capture(
      s.save([
        s.makeMessage({
          participants: [
            {
              handle: 'client@example.test',
              displayName: 'Client',
              role: MessageParticipantRole.FROM,
              personId: s.personId,
            },
          ],
        }),
      ]),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(causes(outcome.error)).toContain(expectedMessage);
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(s.contacts.add).not.toHaveBeenCalled();
    expect(s.matchSpy).not.toHaveBeenCalled();
  },
);

it.each([
  'missing-folder',
  'foreign-channel-folder',
  'unresolved-person',
  'deleted-person',
  'unresolved-member',
  'duplicate-external-id',
] as const)(
  'refuses %s before committing any native records or audit',
  async (kind) => {
    const s = await seed();
    if (kind === 'deleted-person') {
      await f.owner.query(
        `UPDATE ${table('person')} SET "deletedAt"=now() WHERE id=$1`,
        [s.personId],
      );
    }
    const foreignFolderId = randomUUID();
    if (kind === 'foreign-channel-folder') {
      const otherChannelId = await f.coreInsert('messageChannel', {
        workspaceId: f.workspaceId,
        type: 'EMAIL',
        connectedAccountId: s.accountId,
        handle: 'other@example.test',
      });
      await f.owner.query(
        'INSERT INTO core."messageFolder"(id,"workspaceId","messageChannelId") VALUES($1,$2,$3)',
        [foreignFolderId, f.workspaceId, otherChannelId],
      );
    }
    const before = await graph();
    const batch =
      kind === 'duplicate-external-id'
        ? [
            s.makeMessage({ externalId: 'dup-1', headerMessageId: 'h-1' }),
            s.makeMessage({ externalId: 'dup-1', headerMessageId: 'h-2' }),
          ]
        : [
            s.makeMessage({
              messageFolderIds:
                kind === 'missing-folder'
                  ? [randomUUID()]
                  : kind === 'foreign-channel-folder'
                    ? [foreignFolderId]
                    : [s.folderId],
              participants: [
                {
                  handle: 'client@example.test',
                  displayName: 'Client',
                  role: MessageParticipantRole.FROM,
                  ...(kind === 'unresolved-person'
                    ? { personId: randomUUID() }
                    : kind === 'deleted-person'
                      ? { personId: s.personId }
                      : {}),
                  ...(kind === 'unresolved-member'
                    ? { workspaceMemberId: randomUUID() }
                    : {}),
                },
              ],
            }),
          ];
    const outcome = await capture(s.save(batch));
    expect(outcome.ok).toBe(false);
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(s.contacts.add).not.toHaveBeenCalled();
    expect(s.matchSpy).not.toHaveBeenCalled();
  },
);

it('captures input messages, dates, participants, folders and channel settings before the first await', async () => {
  const s = await seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executeInWorkspaceContext = f.manager.executeInWorkspaceContext.bind(
    f.manager,
  );
  jest
    .spyOn(f.manager, 'executeInWorkspaceContext')
    .mockImplementationOnce(async (work) => {
      await gate;
      return executeInWorkspaceContext(work);
    });
  const receivedAt = new Date('2030-01-02T10:00:00.000Z');
  const participant = {
    handle: 'client@example.test',
    displayName: 'Original Name',
    role: MessageParticipantRole.FROM,
  };
  const folders = [s.folderId];
  const message = s.makeMessage({
    subject: 'Original Subject',
    text: 'Original Text',
    receivedAt,
    messageFolderIds: folders,
    participants: [participant],
  });
  const batch = [message];
  const pending = s.save(batch);

  receivedAt.setUTCFullYear(1999);
  participant.handle = 'mutated@example.test';
  participant.displayName = 'Mutated Name';
  folders.push(randomUUID());
  message.subject = 'Mutated Subject';
  message.text = 'Mutated Text';
  batch.push(s.makeMessage({ externalId: 'mutated-ext' }));
  s.channel.isContactAutoCreationEnabled = false;
  s.account.handleAliases.push('client@example.test');
  release();

  const result = await pending;
  expect(result).toBeDefined();
  const savedMessages = await f.read('message');
  expect(savedMessages).toHaveLength(1);
  expect(savedMessages[0]).toMatchObject({
    subject: 'Original Subject',
    text: 'Original Text',
    receivedAt: new Date('2030-01-02T10:00:00.000Z'),
  });
  const savedParticipants = await f.read('messageParticipant');
  expect(savedParticipants).toHaveLength(1);
  expect(savedParticipants[0]).toMatchObject({
    handle: 'client@example.test',
    displayName: 'Original Name',
  });
  expect(s.contacts.add).toHaveBeenCalledTimes(1);
  expect(s.contacts.add.mock.calls[0][1].contactsToCreate).toEqual([
    { handle: 'client@example.test', displayName: 'Original Name' },
  ]);
});

it('cross-channel delivery of the same headerMessageId reuses Thread and Message and audits only the new channel association', async () => {
  const s = await seed('inbound');
  const firstResult = await s.save();
  const initialThreadId =
    firstResult!.messageExternalIdToMessageThreadIdMap.get('ext-1');
  const initialMessageId =
    firstResult!.messageExternalIdsAndIdsMap.get('ext-1');
  const initialAuditCount = (await audit()).length;

  const secondChannelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    type: MessageChannelType.EMAIL_GROUP,
    connectedAccountId: s.accountId,
    handle: 'second-inbound@example.test',
    isSyncEnabled: true,
    syncStage: 'MESSAGES_IMPORT_ONGOING',
    syncStageStartedAt: startedAt,
  });
  const secondChannel = {
    ...s.channel,
    id: secondChannelId,
    handle: 'second-inbound@example.test',
  };
  const secondContext: MessageImportMatchingContext = {
    operation: {
      ...s.context.operation,
      operationId: randomUUID(),
    },
    authority: {
      workspaceId: f.workspaceId,
      connectedAccountId: s.accountId,
      channelId: secondChannelId,
      channelType: MessageChannelType.EMAIL_GROUP,
      kind: 'inbound',
      recipient: 'second-inbound@example.test',
    },
  };
  const secondResult = await s.aggregate.saveMessagesAndEnqueueContactCreation(
    [
      s.makeMessage({
        externalId: 'ext-second-channel',
        headerMessageId: 'hdr-1',
        messageThreadExternalId: 'thr-second-channel',
        messageFolderIds: [],
      }),
    ],
    secondChannel as never,
    s.account as never,
    f.workspaceId,
    { context: secondContext },
  );
  expect(
    secondResult?.messageExternalIdsAndIdsMap.get('ext-second-channel'),
  ).toBe(initialMessageId);
  expect(
    secondResult?.messageExternalIdToMessageThreadIdMap.get(
      'ext-second-channel',
    ),
  ).toBe(initialThreadId);
  expect(await f.read('messageThread')).toHaveLength(1);
  expect(await f.read('message')).toHaveLength(1);
  expect(await f.read('messageChannelMessageAssociation')).toHaveLength(2);
  const newEntries = (await audit()).slice(initialAuditCount);
  expect(newEntries).toHaveLength(1);
});

it('repeated participant updates for the same existing row in one batch execute sequentially and emit one combined update audit', async () => {
  const s = await seed();
  await s.save();
  const initialAuditCount = (await audit()).length;

  await s.save([
    s.makeMessage({
      participants: [
        {
          handle: 'client@example.test',
          displayName: 'First Name',
          role: MessageParticipantRole.FROM,
          personId: s.personId,
        },
        {
          handle: 'client@example.test',
          displayName: 'Second Name',
          role: MessageParticipantRole.FROM,
          personId: s.personId,
          workspaceMemberId: s.memberId,
        },
      ],
    }),
  ]);
  const stored = await f.read('messageParticipant');
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    personId: s.personId,
    workspaceMemberId: s.memberId,
    displayName: 'Second Name',
  });
  const newEntries = (await audit()).slice(initialAuditCount);
  expect(newEntries).toHaveLength(1);
  expect(newEntries[0].action).toBe('update');
});

it('refuses mutating incoming foreign keys on messageThread updates before DML', async () => {
  const s = await seed();
  await s.save();
  const fkTable = `"${f.schemaName}"."_test_thread_cascade_ref"`;
  await f.owner.query(
    `ALTER TABLE ${table('messageThread')} ADD CONSTRAINT "_test_thread_id_subject_uniq" UNIQUE (id, subject)`,
  );
  await f.owner.query(
    `CREATE TABLE ${fkTable}(id uuid PRIMARY KEY, "threadId" uuid, "threadSubject" text, FOREIGN KEY ("threadId", "threadSubject") REFERENCES ${table('messageThread')}(id, subject) ON UPDATE CASCADE)`,
  );
  await f.owner.query(`GRANT SELECT ON ${fkTable} TO "${f.roleName}"`);
  const thread = (await f.read('messageThread'))[0];
  await f.owner.query(
    `INSERT INTO ${fkTable}(id,"threadId","threadSubject") VALUES ($1,$2,$3)`,
    [randomUUID(), thread.id, thread.subject],
  );
  const before = await graph();
  const beforeAudit = await audit();
  try {
    const outcome = await capture(
      s.save([
        s.makeMessage({
          externalId: 'ext-2',
          headerMessageId: 'hdr-2',
          subject: 'Updated Subject',
          receivedAt: new Date('2030-01-05T00:00:00.000Z'),
        }),
      ]),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(causes(outcome.error)).toContain(
        'Native audit excludes referential UPDATE effects',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual(beforeAudit);
  } finally {
    await f.owner.query(`DROP TABLE IF EXISTS ${fkTable}`);
    await f.owner.query(
      `ALTER TABLE ${table('messageThread')} DROP CONSTRAINT IF EXISTS "_test_thread_id_subject_uniq"`,
    );
  }
});

it('stale provider sync run returns undefined without native DML, audit, queue or matching', async () => {
  const s = await seed('provider');
  await f.owner.query(
    'UPDATE core."messageChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval \'1 microsecond\' WHERE id=$1',
    [s.channelId],
  );
  const before = await graph();
  expect(await s.save()).toBeUndefined();
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(s.contacts.add).not.toHaveBeenCalled();
  expect(s.matchSpy).not.toHaveBeenCalled();
});

it('lost COMMIT acknowledgement leaves saved graph and audit while skipping contact queue and matching', async () => {
  const s = await seed();
  const client = await f.pool.connect(),
    query = client.query.bind(client);
  jest.spyOn(client, 'query').mockImplementation((async (
    sql: string,
    values?: unknown[],
  ) => {
    const result = await query(sql, values);
    if (sql === 'COMMIT') throw new Error('commit ACK lost');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(s.save()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await f.read('message')).toHaveLength(1);
  expect(await audit()).toHaveLength(5);
  expect(s.contacts.add).not.toHaveBeenCalled();
  expect(s.matchSpy).not.toHaveBeenCalled();
});
