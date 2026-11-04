import { randomUUID } from 'node:crypto';
import {
  MessageChannelType,
  MessageParticipantRole,
} from 'twenty-shared/types';
import * as identity from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { MessagingMessagesImportService } from 'src/modules/messaging/message-import-manager/services/messaging-messages-import.service';
import { InboundEmailImportService } from 'src/modules/messaging/message-import-manager/drivers/inbound-email/services/inbound-email-import.service';
import { type MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';

jest.mock(
  'src/engine/core-modules/crm-audit/membership-cleanup-identity',
  () => {
    const actual = jest.requireActual(
      'src/engine/core-modules/crm-audit/membership-cleanup-identity',
    );
    return {
      ...actual,
      systemMembershipCleanupIdentity: jest.fn(
        actual.systemMembershipCleanupIdentity,
      ),
    };
  },
);
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
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service',
  () => ({ MessagingSaveMessagesAndEnqueueContactCreationService: class {} }),
);
jest.mock(
  'src/modules/messaging/common/services/message-channel-sync-status.service',
  () => ({ MessageChannelSyncStatusService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-get-messages.service',
  () => ({ MessagingGetMessagesService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/drivers/inbound-email/sources/inbound-email-message-source-resolver.service',
  () => ({ InboundEmailMessageSourceResolverService: class {} }),
);
jest.mock(
  'src/modules/messaging/monitoring/services/messaging-monitoring.service',
  () => ({ MessagingMonitoringService: class {} }),
);
jest.mock('src/modules/blocklist/repositories/blocklist.repository', () => ({
  BlocklistRepository: class {},
}));
jest.mock(
  'src/modules/connected-account/email-alias-manager/services/email-alias-manager.service',
  () => ({ EmailAliasManagerService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-import-exception-handler.service',
  () => ({
    MessageImportExceptionHandlerService: class {},
    MessageImportSyncStep: {
      RECENT_MESSAGES_IMPORT: 'recent',
      MESSAGES_IMPORT_ONGOING: 'ongoing',
    },
  }),
);

type SaveArgs = Parameters<
  MessagingSaveMessagesAndEnqueueContactCreationService['saveMessagesAndEnqueueContactCreation']
>;
const message = () =>
  ({
    externalId: 'provider-message',
    messageThreadExternalId: 'provider-thread',
    subject: 'Customer reply',
    text: 'Hello from a customer',
    messageHeaders: [],
    attachments: [],
    participants: [
      {
        handle: 'client@customer.test',
        role: MessageParticipantRole.FROM,
        displayName: 'Client',
      },
    ],
  }) as unknown as MessageWithParticipants;
const manager = () => ({
  executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
    work(),
  getRepository: () => ({ findOne: async () => null }),
});
const saveStub = () =>
  jest.fn(async (..._args: SaveArgs) => ({
    messageExternalIdsAndIdsMap: new Map<string, string>(),
    messageExternalIdToMessageThreadIdMap: new Map<string, string>(),
  }));
const logger = () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn() });

const providerFixture = () => {
  const workspaceId = randomUUID(),
    channelId = randomUUID(),
    accountId = randomUUID();
  const account = {
    id: accountId,
    handle: 'manager@business.test',
    handleAliases: [],
    userWorkspaceId: randomUUID(),
  };
  const channel = {
    id: channelId,
    workspaceId,
    connectedAccountId: accountId,
    type: MessageChannelType.EMAIL,
    handle: account.handle,
    excludeGroupEmails: false,
    messageFolders: [],
  };
  const run = {
    kind: 'message',
    workspaceId,
    channelId,
    connectedAccountId: accountId,
    stage: 'MESSAGES_IMPORT_ONGOING',
    startedAt: '2026-11-04T12:00:00.123456Z',
  } satisfies OrdinaryMetadataSyncRun;
  const admitted = {
    channel: { ...channel, connectedAccount: { ...account } },
    run: { ...run },
  };
  const status = {
    beginMessagesImport: jest.fn(async () => admitted),
    handoffRecentMessagesImport: jest.fn(async () => admitted),
    recoverLegacyMessageImport: jest.fn(async () => false),
    markAsMessageSyncCompleted: jest.fn(async () => true),
    markAsMessageBatchImported: jest.fn(async () => true),
    finishRecentMessagesImport: jest.fn(async () => true),
  };
  const cache = {
    setPop: jest.fn(async () => ['provider-message']),
    setAdd: jest.fn(),
    incrBy: jest.fn(),
    expire: jest.fn(),
  };
  const save = saveStub();
  const handler = jest.fn();
  const monitor = jest.fn();
  const provider = jest.fn(async () => [message()]);
  const service = Object.assign(
    Object.create(MessagingMessagesImportService.prototype),
    {
      messageChannelSyncStatusService: status,
      saveMessagesAndEnqueueContactCreationService: {
        saveMessagesAndEnqueueContactCreation: save,
      },
      workspaceOrmManager: manager(),
      cacheStorage: cache,
      messagingGetMessagesService: { getMessages: provider },
      messagingMonitoringService: { track: monitor },
      messageImportErrorHandlerService: { handleDriverException: handler },
      userWorkspaceRepository: { findOne: async () => null },
      workspaceRepository: {
        findOne: async () => ({ isInternalMessagesImportEnabled: true }),
      },
      blocklistRepository: {
        getEntriesApplicableToWorkspaceMember: async () => [],
      },
      emailAliasManagerService: { refreshHandleAliases: jest.fn() },
      twentyConfigService: { get: () => 10 },
      logger: logger(),
    },
  ) as MessagingMessagesImportService;
  const invoke = (recent: boolean) =>
    recent
      ? service.processRecentMessageBatchImport(run, 10)
      : service.processMessageBatchImport(
          channel as never,
          account as never,
          workspaceId,
          10,
        );
  return {
    workspaceId,
    channelId,
    accountId,
    channel,
    run,
    admitted,
    status,
    cache,
    save,
    handler,
    monitor,
    provider,
    invoke,
  };
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

it.each([false, true])(
  'actual provider origin captures named authority before admission awaits, recent=%s',
  async (recent) => {
    const f = providerFixture();
    const capture = jest.mocked(identity.systemMembershipCleanupIdentity);
    const admission = recent
      ? f.status.handoffRecentMessagesImport
      : f.status.beginMessagesImport;
    admission.mockImplementationOnce(async () => {
      expect(capture).toHaveBeenCalledWith(
        f.workspaceId,
        recent
          ? 'MessagingMessagesImportService.processRecentMessageBatchImport'
          : 'MessagingMessagesImportService.processMessageBatchImport',
      );
      f.channel.id = randomUUID();
      f.run.workspaceId = randomUUID();
      return f.admitted;
    });
    await f.invoke(recent);
    expect(f.save).toHaveBeenCalledTimes(1);
    const options = f.save.mock.calls[0][4];
    expect(options.context.operation).toMatchObject({
      workspaceId: f.workspaceId,
      actor: { kind: 'system' },
    });
    expect(options.context.authority).toEqual({
      kind: 'provider',
      workspaceId: f.workspaceId,
      connectedAccountId: f.accountId,
      channelId: f.channelId,
      channelType: MessageChannelType.EMAIL,
      run: f.admitted.run,
    });
    expect(options.expectedRun).toEqual(f.admitted.run);
    expect(f.handler).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'actual provider propagates confirmed matching failure without cache/status retry, recent=%s',
  async (recent) => {
    const f = providerFixture();
    const failure = new CoreAuditPostCommitError(
      new Error('matching postcommit callback'),
    );
    f.save.mockRejectedValueOnce(failure);
    await expect(f.invoke(recent)).rejects.toBe(failure);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.cache.setAdd).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.status.markAsMessageSyncCompleted).not.toHaveBeenCalled();
    expect(f.status.markAsMessageBatchImported).not.toHaveBeenCalled();
    expect(f.status.finishRecentMessagesImport).not.toHaveBeenCalled();
    expect(f.monitor.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: 'messages_import.completed' }),
      ]),
    );
  },
);

const inboundFixture = () => {
  const workspaceId = randomUUID(),
    channelId = randomUUID(),
    accountId = randomUUID();
  const recipient = 'group@inbound.example.test';
  const channel = {
    id: channelId,
    workspaceId,
    connectedAccountId: accountId,
    type: MessageChannelType.EMAIL_GROUP,
    handle: recipient,
    excludeGroupEmails: false,
  };
  const account = { id: accountId, handle: recipient };
  const save = saveStub();
  const source = {
    isConfigured: () => true,
    fetchMessage: jest.fn(async () => message()),
    cleanup: jest.fn(async () => undefined),
  };
  const service = Object.assign(
    Object.create(InboundEmailImportService.prototype),
    {
      twentyConfigService: { get: () => 'inbound.example.test' },
      inboundEmailMessageSourceResolverService: { resolve: () => source },
      messageChannelRepository: { findOne: async () => channel },
      connectedAccountRepository: { findOne: async () => account },
      messagingSaveMessagesAndEnqueueContactCreationService: {
        saveMessagesAndEnqueueContactCreation: save,
      },
      workspaceOrmManager: manager(),
      logger: logger(),
    },
  ) as InboundEmailImportService;
  const invoke = () =>
    service.importInboundMessage({
      messageReference: { source: 'RESEND', reference: 'source-ref' },
      envelopeRecipients: [recipient],
    });
  return {
    workspaceId,
    channelId,
    accountId,
    recipient,
    channel,
    save,
    source,
    invoke,
  };
};

it('actual inbound origin captures its resolved identity before fetching and cleans up after success', async () => {
  const f = inboundFixture();
  const capture = jest.mocked(identity.systemMembershipCleanupIdentity);
  f.source.fetchMessage.mockImplementationOnce(async () => {
    expect(capture).toHaveBeenCalledWith(
      f.workspaceId,
      'InboundEmailImportService.importInboundMessage',
    );
    f.channel.handle = 'mutated@inbound.example.test';
    return message();
  });
  expect(await f.invoke()).toMatchObject({
    kind: 'imported',
    workspaceId: f.workspaceId,
  });
  expect(f.save.mock.calls[0][4].context.authority).toEqual({
    kind: 'inbound',
    workspaceId: f.workspaceId,
    connectedAccountId: f.accountId,
    channelId: f.channelId,
    channelType: MessageChannelType.EMAIL_GROUP,
    recipient: f.recipient,
  });
  expect(f.source.cleanup).toHaveBeenCalledWith('source-ref');
  expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(
    f.source.cleanup.mock.invocationCallOrder[0],
  );
});

it.each([false, true])(
  'actual inbound matching failure prevents external cleanup, confirmed=%s',
  async (confirmed) => {
    const f = inboundFixture();
    const failure = confirmed
      ? new CoreAuditPostCommitError(new Error('matching callback'))
      : new Error('matching refused');
    f.save.mockRejectedValueOnce(failure);
    await expect(f.invoke()).rejects.toBe(failure);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.source.cleanup).not.toHaveBeenCalled();
  },
);
