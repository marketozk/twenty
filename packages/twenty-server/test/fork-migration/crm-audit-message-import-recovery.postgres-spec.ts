import { randomUUID } from 'node:crypto';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import {
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
  type MessageImportMatchingContext,
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
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const intents = () =>
  f.owner.query(
    'SELECT * FROM core."deferredWorkspaceMigrationAction" WHERE name=$1 ORDER BY "createdAt" ASC, id ASC',
    [MESSAGE_IMPORT_MATCHING_INTENT_NAME],
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

type Origin = 'provider' | 'inbound' | 'sent' | 'application';

const createHarness = async (
  origin: Origin = 'inbound',
  participantCount = 1,
) => {
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
  const personId = await insert('person', {
    name: { firstName: 'Match' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
  });
  const memberId = await insert('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Match' },
    userEmail: 'client@example.test',
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
            : { kind: 'system', id: 'MessageImportRecoveryTest' },
      ...(origin === 'application'
        ? { initiator: { kind: 'coreUser', id: userId } }
        : {}),
    },
  };
  const contacts = { add: jest.fn().mockResolvedValue(undefined) };
  const messageParticipants = new MessagingMessageParticipantService(
    f.manager,
    matcher as never,
  );
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    contacts as never,
    new MessagingMessageService(f.manager),
    messageParticipants,
    new MessagingMessageFolderAssociationService(f.manager),
    f.manager,
    f.owner as never,
  );
  const connectedAccount = {
    id: accountId,
    handle: 'owner@example.test',
    handleAliases: [],
  };
  const messageChannel = {
    id: channelId,
    connectedAccountId: accountId,
    type: channelType,
    isContactAutoCreationEnabled: true,
    contactAutoCreationPolicy: 'SENT_AND_RECEIVED',
    excludeNonProfessionalEmails: false,
    excludeGroupEmails: false,
  };
  const participants = Array.from({ length: participantCount }, (_, index) => ({
    role: index === 0 ? MessageParticipantRole.FROM : MessageParticipantRole.CC,
    handle: index === 0 ? 'client@example.test' : `extra-${index}@example.test`,
    displayName: `Client ${index}`,
  }));
  const messagesToSave = [
    {
      externalId: 'saved-external-1',
      headerMessageId: 'saved-header-1',
      subject: 'Saved subject',
      messageThreadExternalId: 'saved-thread-1',
      receivedAt: new Date('2030-01-01T00:00:00.000Z'),
      direction: MessageDirection.INCOMING,
      participants,
      attachments: [],
      text: 'Saved body',
      isDraft: false,
    },
  ];
  return {
    accountId,
    channelId,
    personId,
    memberId,
    context,
    contacts,
    messageParticipants,
    service,
    connectedAccount,
    messageChannel,
    messagesToSave,
    run: (overrideMessages = messagesToSave) =>
      service.saveMessagesAndEnqueueContactCreation(
        overrideMessages as never,
        messageChannel as never,
        connectedAccount as never,
        f.workspaceId,
        {
          context,
          ...(authority.kind === 'provider'
            ? { expectedRun: authority.run }
            : {}),
        },
      ),
    savedParticipants: () =>
      f.owner.query(
        `SELECT * FROM ${table('messageParticipant')} ORDER BY handle ASC`,
      ),
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
    'CREATE TABLE core.agent(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"applicationId" uuid,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
});

beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS import_recovery_test ON core."deferredWorkspaceMigrationAction"',
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS import_recovery_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".import_recovery_test()`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core."user",core."userWorkspace",core.application,core.agent CASCADE',
  );
});

afterAll(async () => f.dispose());

it('persists a PENDING durable matching intent inside the save transaction and deletes it inside the final matching commit', async () => {
  const h = await createHarness();
  let observedIntentsDuringQueue: Record<string, unknown>[] = [];
  h.contacts.add.mockImplementationOnce(async () => {
    observedIntentsDuringQueue = await intents();
  });
  const result = await h.run();
  expect(result).toBeDefined();
  expect(observedIntentsDuringQueue).toHaveLength(1);
  expect(observedIntentsDuringQueue[0]).toMatchObject({
    workspaceId: f.workspaceId,
    name: MESSAGE_IMPORT_MATCHING_INTENT_NAME,
    status: 'PENDING',
    attempts: 0,
  });
  expect(await intents()).toHaveLength(0);
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
});

it('inserts no durable matching intent when saving an empty batch or a message without participants', async () => {
  const h = await createHarness('inbound', 0);
  await h.run([]);
  expect(await intents()).toHaveLength(0);
  await h.run();
  expect(await intents()).toHaveLength(0);
});

it.each([
  ['skipped insert', 'RETURN NULL;'],
  ['rewritten status', "NEW.status := 'IN_PROGRESS'; RETURN NEW;"],
  [
    'rewritten nextPageIndex',
    "NEW.payload := jsonb_set(NEW.payload, '{nextPageIndex}', '1'::jsonb, true); RETURN NEW;",
  ],
])(
  'rolls back all five native tables and audit if a BEFORE INSERT trigger causes %s on the durable intent row',
  async (_label, body) => {
    const h = await createHarness();
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".import_recovery_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} END $$; CREATE TRIGGER import_recovery_test BEFORE INSERT ON core."deferredWorkspaceMigrationAction" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".import_recovery_test()`,
    );
    await expect(h.run()).rejects.toThrow(/matching intent/);
    expect(await h.savedParticipants()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
    expect(await intents()).toHaveLength(0);
  },
);

it('rolls back the entire message save if a deferred trigger deletes the durable intent row before COMMIT', async () => {
  const h = await createHarness();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".import_recovery_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id = NEW.id; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER import_recovery_test AFTER INSERT ON core."deferredWorkspaceMigrationAction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".import_recovery_test()`,
  );
  await expect(h.run()).rejects.toThrow(
    'Message save matching intent changed before commit',
  );
  expect(await h.savedParticipants()).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
  expect(await intents()).toHaveLength(0);
});

it('recovers a multi-page manifest from nextPageIndex = 1 without re-running Page 0 after Page 1 fails', async () => {
  const h = await createHarness('inbound', 201);
  let matchingPageCalls = 0;
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".import_recovery_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF (NEW.payload->>'nextPageIndex')::int = 1 THEN RAISE EXCEPTION 'page 0 committed, fail on page 1'; END IF; RETURN NEW; END $$`,
  );
  const originalRunInTx = f.manager.runInWorkspaceTransaction.bind(f.manager);
  const txSpy = jest
    .spyOn(f.manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      matchingPageCalls += 1;
      if (matchingPageCalls === 3) {
        throw new Error('transient failure before page 1');
      }
      return originalRunInTx(work as never, options as never);
    }) as typeof f.manager.runInWorkspaceTransaction);

  await expect(h.run()).rejects.toThrow('transient failure before page 1');
  txSpy.mockRestore();

  const pendingAfterPartial = await intents();
  expect(pendingAfterPartial).toHaveLength(1);
  expect(pendingAfterPartial[0]).toMatchObject({
    status: 'PENDING',
    attempts: 0,
    lastError: 'transient failure before page 1',
  });
  expect(
    (pendingAfterPartial[0].payload as { nextPageIndex: number }).nextPageIndex,
  ).toBe(1);

  const pageSpy = jest.spyOn(f.manager, 'runInWorkspaceTransaction');
  const recovered =
    await h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(recovered).toEqual({
    processedIntents: 1,
    completedIntents: 1,
    pagesApplied: 1,
  });
  expect(pageSpy).toHaveBeenCalledTimes(1);
  pageSpy.mockRestore();
  expect(await intents()).toHaveLength(0);
});

it('replays a provider intent after syncStage transitions to FAILED and refuses if sync is disabled or channel becomes omni-owned', async () => {
  const h = await createHarness('provider');
  h.contacts.add.mockRejectedValueOnce(new Error('queue outage'));
  await expect(h.run()).rejects.toThrow('queue outage');

  await f.owner.query(
    `UPDATE core."messageChannel" SET "syncStage"='FAILED',"syncStageStartedAt"='2030-01-02T00:00:00.000000Z' WHERE id=$1`,
    [h.channelId],
  );

  await f.owner.query(
    `UPDATE core."messageChannel" SET "isSyncEnabled"=false WHERE id=$1`,
    [h.channelId],
  );
  await expect(
    h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    }),
  ).rejects.toThrow('Native message import provider channel unavailable');
  await f.owner.query(
    `UPDATE core."messageChannel" SET "isSyncEnabled"=true WHERE id=$1`,
    [h.channelId],
  );

  const recovered =
    await h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(recovered).toEqual({
    processedIntents: 1,
    completedIntents: 1,
    pagesApplied: 1,
  });
  expect(await intents()).toHaveLength(0);
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
});

it('releases the intent back to PENDING when an in-band provider run becomes stale before matching', async () => {
  const h = await createHarness('provider');
  h.contacts.add.mockImplementationOnce(async () => {
    await f.owner.query(
      `UPDATE core."messageChannel" SET "syncStageStartedAt"='2030-01-03T00:00:00.000000Z' WHERE id=$1`,
      [h.channelId],
    );
  });
  const outcome = await h.run();
  expect(outcome).toBeUndefined();
  const remaining = await intents();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].status).toBe('PENDING');

  const recovered =
    await h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(recovered).toEqual({
    processedIntents: 1,
    completedIntents: 1,
    pagesApplied: 1,
  });
  expect(await intents()).toHaveLength(0);
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
});

it('fences an incomplete multi-page intent into FAILED with unsafeOutcome on lost COMMIT ACK and refuses automatic replay', async () => {
  const h = await createHarness('inbound', 201);
  let txCount = 0;
  const originalRunInTx = f.manager.runInWorkspaceTransaction.bind(f.manager);
  const unknownCommitError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('COMMIT ACK lost on page 1'),
  );
  const txSpy = jest
    .spyOn(f.manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      txCount += 1;
      if (txCount === 3) {
        throw unknownCommitError;
      }
      return originalRunInTx(work as never, options as never);
    }) as typeof f.manager.runInWorkspaceTransaction);

  await expect(h.run()).rejects.toBe(unknownCommitError);
  txSpy.mockRestore();

  const fenced = await intents();
  expect(fenced).toHaveLength(1);
  expect(fenced[0].status).toBe('FAILED');
  expect(fenced[0].payload).toMatchObject({
    nextPageIndex: 1,
    unsafeOutcome: {
      pageIndex: 1,
      reason: unknownCommitError.message,
    },
  });

  const retryResult =
    await h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(retryResult).toEqual({
    processedIntents: 0,
    completedIntents: 0,
    pagesApplied: 0,
  });
});

it('leaves no pending intent when COMMIT ACK is lost after the final matching page commit actually succeeded', async () => {
  const h = await createHarness('inbound');
  let txCount = 0;
  const originalRunInTx = f.manager.runInWorkspaceTransaction.bind(f.manager);
  const ackLostError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('COMMIT ACK lost after actual commit'),
  );
  const txSpy = jest
    .spyOn(f.manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      txCount += 1;
      const result = await originalRunInTx(work as never, options as never);
      if (txCount === 2) {
        throw ackLostError;
      }
      return result;
    }) as typeof f.manager.runInWorkspaceTransaction);

  await expect(h.run()).rejects.toBe(ackLostError);
  txSpy.mockRestore();

  expect(await intents()).toHaveLength(0);
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  const retryResult =
    await h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(retryResult).toEqual({
    processedIntents: 0,
    completedIntents: 0,
    pagesApplied: 0,
  });
});

it('rolls back the matching page if a deferred trigger resurrects the deleted intent row before COMMIT', async () => {
  const h = await createHarness('inbound');
  h.contacts.add.mockImplementationOnce(async () => {
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".import_recovery_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO core."deferredWorkspaceMigrationAction"(id,"workspaceId","applicationUniversalIdentifier",name,payload,position,status,attempts) VALUES(OLD.id,OLD."workspaceId",OLD."applicationUniversalIdentifier",OLD.name,OLD.payload,OLD.position,'IN_PROGRESS',OLD.attempts); RETURN OLD; END $$; CREATE CONSTRAINT TRIGGER import_recovery_test AFTER DELETE ON core."deferredWorkspaceMigrationAction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".import_recovery_test()`,
    );
  });
  await expect(h.run()).rejects.toThrow(
    'Native message import matching intent remained after completion',
  );
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
  const remaining = await intents();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].status).toBe('PENDING');
});

it('serializes concurrent recovery workers so the pending intent is applied once', async () => {
  const h = await createHarness('inbound');
  h.contacts.add.mockRejectedValueOnce(new Error('queue failed'));
  await expect(h.run()).rejects.toThrow('queue failed');

  const [r1, r2] = await Promise.all([
    h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    }),
    h.messageParticipants.reconcileMessageImportMatchingIntents({
      workspaceId: f.workspaceId,
    }),
  ]);
  expect(r1.completedIntents + r2.completedIntents).toBe(1);
  expect(r1.pagesApplied + r2.pagesApplied).toBe(1);
  expect(await intents()).toHaveLength(0);
});

it('transitions repeated ordinary recovery failures to FAILED after max attempts', async () => {
  const h2 = await createHarness('inbound');
  h2.messagesToSave[0].externalId = 'saved-external-2';
  h2.messagesToSave[0].headerMessageId = 'saved-header-2';
  h2.contacts.add.mockRejectedValueOnce(new Error('queue failed 2'));
  await expect(h2.run()).rejects.toThrow('queue failed 2');

  await f.owner.query(
    `UPDATE core."messageChannel" SET type='INVALID_TYPE' WHERE id=$1`,
    [h2.channelId],
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(
      h2.messageParticipants.reconcileMessageImportMatchingIntents({
        workspaceId: f.workspaceId,
      }),
    ).rejects.toThrow('Native message import channel changed');
    const [row] = await intents();
    expect(row.attempts).toBe(attempt);
    expect(row.status).toBe(attempt < 3 ? 'PENDING' : 'FAILED');
  }
});

it('observes background recovery completion cleanly if recovery finishes while contacts.add is still awaiting', async () => {
  const h = await createHarness('inbound');
  h.contacts.add.mockImplementationOnce(async () => {
    const recovered =
      await h.messageParticipants.reconcileMessageImportMatchingIntents({
        workspaceId: f.workspaceId,
      });
    expect(recovered.completedIntents).toBe(1);
  });
  const result = await h.run();
  expect(result).toBeDefined();
  expect(await intents()).toHaveLength(0);
  const [saved] = await h.savedParticipants();
  expect(saved).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  expect(causes(new Error('ok'))).toBe('ok');
});
