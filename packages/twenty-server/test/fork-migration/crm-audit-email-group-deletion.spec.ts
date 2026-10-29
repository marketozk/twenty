import { randomUUID } from 'node:crypto';
import { MessageChannelType } from 'twenty-shared/types';

// The orchestrator and its permission/domain decisions are real; unrelated DI
// classes are replaced to keep this focused suite independent of the Nest graph.
for (const [path, name] of [
  [
    'src/engine/core-modules/emailing-domain/services/emailing-domain.service',
    'EmailingDomainService',
  ],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    'TwentyConfigService',
  ],
  [
    'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
    'ConnectedAccountMetadataService',
  ],
  [
    'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
    'MessageChannelEntity',
  ],
  [
    'src/engine/metadata-modules/message-channel/dtos/create-email-group-channel.output',
    'CreateEmailGroupChannelOutput',
  ],
  [
    'src/engine/metadata-modules/message-channel/dtos/message-channel.dto',
    'MessageChannelDTO',
  ],
  [
    'src/engine/workspace-event-emitter/workspace-event-emitter',
    'WorkspaceEventEmitter',
  ],
  [
    'src/modules/messaging/common/services/message-channel-sync-status.service',
    'MessageChannelSyncStatusService',
  ],
])
  jest.doMock(path, () => ({ [name]: class {} }));

const { MessageChannelMetadataService } =
  require('src/engine/metadata-modules/message-channel/message-channel-metadata.service') as typeof import('src/engine/metadata-modules/message-channel/message-channel-metadata.service');

const fixture = () => {
  const workspaceId = randomUUID(),
    memberId = randomUUID(),
    accountId = randomUUID();
  const channel = {
    id: randomUUID(),
    workspaceId,
    connectedAccountId: accountId,
    type: MessageChannelType.EMAIL_GROUP,
  };
  const account = { id: accountId, handle: 'group@example.test' };
  const repository = {
    findOne: jest.fn().mockResolvedValue(channel),
    find: jest.fn().mockResolvedValue([]),
  };
  const accounts = {
    findById: jest.fn().mockResolvedValue(account),
    isAdministrableByCaller: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(account),
  };
  const domains = {
    validateNoCampaignSendingOrThrow: jest.fn().mockResolvedValue(undefined),
    deleteEmailingDomainByDomainIfExists: jest
      .fn()
      .mockResolvedValue(undefined),
  };
  const service = new MessageChannelMetadataService(
    repository as never,
    accounts as never,
    {} as never,
    domains as never,
    {} as never,
    {} as never,
  );
  const run = () =>
    service.deleteEmailGroupChannel({
      id: channel.id,
      userWorkspaceId: memberId,
      workspaceId,
    });
  return {
    workspaceId,
    memberId,
    accountId,
    channel,
    account,
    repository,
    accounts,
    domains,
    run,
  };
};

it('pins the email group account, channel and handle before deletion, then cleans its domain', async () => {
  const f = fixture();
  f.accounts.delete.mockImplementationOnce(async () => {
    f.account.handle = 'changed@other.test';
    return f.account;
  });
  await expect(f.run()).resolves.toBe(f.channel);
  expect(f.accounts.delete).toHaveBeenCalledWith({
    id: f.accountId,
    workspaceId: f.workspaceId,
    caller: { userWorkspaceId: f.memberId },
    emailGroup: {
      channelId: f.channel.id,
      expectedHandle: 'group@example.test',
    },
  });
  expect(f.domains.deleteEmailingDomainByDomainIfExists).toHaveBeenCalledWith(
    f.workspaceId,
    'example.test',
  );
  expect(
    f.domains.validateNoCampaignSendingOrThrow.mock.invocationCallOrder[0],
  ).toBeLessThan(f.accounts.delete.mock.invocationCallOrder[0]);
  expect(f.accounts.delete.mock.invocationCallOrder[0]).toBeLessThan(
    f.domains.deleteEmailingDomainByDomainIfExists.mock.invocationCallOrder[0],
  );
});

it.each([
  'audit refusal',
  'Email group deletion target changed',
  'Connected account deletion requires complete effects',
  'unknown COMMIT',
])(
  'preserves %s and performs no domain cleanup after failed deletion',
  async (message) => {
    const f = fixture(),
      error = new Error(message);
    f.accounts.delete.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.repository.find).not.toHaveBeenCalled();
    expect(
      f.domains.deleteEmailingDomainByDomainIfExists,
    ).not.toHaveBeenCalled();
  },
);

it.each(['permission', 'campaign', 'wrong channel type'])(
  'refuses %s before account deletion',
  async (kind) => {
    const f = fixture();
    if (kind === 'permission')
      f.accounts.isAdministrableByCaller.mockResolvedValueOnce(false);
    if (kind === 'campaign')
      f.domains.validateNoCampaignSendingOrThrow.mockRejectedValueOnce(
        new Error('campaign active'),
      );
    if (kind === 'wrong channel type') f.channel.type = MessageChannelType.APP;
    await expect(f.run()).rejects.toThrow();
    expect(f.accounts.delete).not.toHaveBeenCalled();
    expect(
      f.domains.deleteEmailingDomainByDomainIfExists,
    ).not.toHaveBeenCalled();
  },
);

it('retains a domain still used by another email group after committed account deletion', async () => {
  const f = fixture();
  f.repository.find.mockResolvedValueOnce([
    { connectedAccount: { handle: 'another@example.test' } },
  ]);
  await f.run();
  expect(f.accounts.delete).toHaveBeenCalledTimes(1);
  expect(f.domains.deleteEmailingDomainByDomainIfExists).not.toHaveBeenCalled();
});
