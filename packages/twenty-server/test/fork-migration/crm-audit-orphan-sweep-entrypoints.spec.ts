import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    red: (s: string) => s,
    blue: (s: string) => s,
    yellow: (s: string) => s,
  },
}));
for (const [path, name] of [
  ['src/engine/core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
  ['src/engine/twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    'WorkspaceCacheService',
  ],
  [
    'src/database/commands/command-runners/command-shutdown.service',
    'CommandShutdownService',
  ],
  [
    'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service',
    'MessagingMessageCleanerService',
  ],
  [
    'src/modules/messaging/common/services/message-channel-sync-status.service',
    'MessageChannelSyncStatusService',
  ],
  [
    'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
    'MessageChannelEntity',
  ],
  [
    'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
    'ConnectedAccountEntity',
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    'UserWorkspaceEntity',
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-runner.exception',
    'WorkspaceMigrationRunnerException',
  ],
])
  jest.doMock(path, () => ({ [name]: class {} }));

const { MessagingMessageChannelDeletionCleanupJob } =
  require('src/modules/messaging/message-cleaner/jobs/messaging-message-channel-deletion-cleanup.job') as typeof import('src/modules/messaging/message-cleaner/jobs/messaging-message-channel-deletion-cleanup.job');
const { MessagingConnectedAccountDeletionCleanupJob } =
  require('src/modules/messaging/message-cleaner/jobs/messaging-connected-account-deletion-cleanup.job') as typeof import('src/modules/messaging/message-cleaner/jobs/messaging-connected-account-deletion-cleanup.job');
const { MessagingMessageCleanerRemoveOrphansCommand } =
  require('src/modules/messaging/message-cleaner/commands/messaging-message-clearner-remove-orphans.command') as typeof import('src/modules/messaging/message-cleaner/commands/messaging-message-clearner-remove-orphans.command');
const { MessagingResetChannelCommand } =
  require('src/modules/messaging/message-cleaner/commands/messaging-reset-channel.command') as typeof import('src/modules/messaging/message-cleaner/commands/messaging-reset-channel.command');
// This suite checks the real job boundary; PostgreSQL owner semantics are
// exercised separately in crm-audit-blocklist-cleanup.postgres-spec.ts.
jest.doMock(
  'src/engine/core-modules/crm-audit/delete-ordinary-blocklisted-message-associations-with-audit',
  () => ({ deleteOrdinaryBlocklistedMessageAssociationsWithAudit: jest.fn() }),
);
const blocklistOwner =
  require('src/engine/core-modules/crm-audit/delete-ordinary-blocklisted-message-associations-with-audit')
    .deleteOrdinaryBlocklistedMessageAssociationsWithAudit as jest.Mock;
beforeEach(() => blocklistOwner.mockReset());

const { BlocklistItemDeleteMessagesJob } =
  require('src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-item-delete-messages.job') as typeof import('src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-item-delete-messages.job');
const { WorkspaceIteratorService } =
  require('src/database/commands/command-runners/workspace-iterator.service') as typeof import('src/database/commands/command-runners/workspace-iterator.service');

const cleaner = () => ({
  cleanOrphanMessagesAndThreads: jest.fn().mockResolvedValue(undefined),
  deleteMessageChannelMessageAssociationsByChannelId: jest
    .fn()
    .mockResolvedValue(undefined),
});
const expectOperation = (
  operation: {
    workspaceId: string;
    actor: unknown;
    initiator?: unknown;
    operationId: string;
    correlationId?: string;
  },
  workspaceId: string,
  source: string,
) => {
  expect(operation).toMatchObject({
    workspaceId,
    actor: { kind: 'system', id: source },
  });
  expect(operation.initiator).toBeUndefined();
  expect(isUUID(operation.operationId)).toBe(true);
  expect(isUUID(operation.correlationId)).toBe(true);
};
afterEach(() => jest.restoreAllMocks());

it('channel job uses captured scope, two operations and one correlation', async () => {
  const service = cleaner(),
    workspaceId = randomUUID(),
    channelId = randomUUID();
  const data = { workspaceId, messageChannelId: channelId };
  let release!: () => void;
  service.deleteMessageChannelMessageAssociationsByChannelId.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const job = new MessagingMessageChannelDeletionCleanupJob(service as never);
  const pending = job.handle(data);
  data.workspaceId = randomUUID();
  data.messageChannelId = randomUUID();
  release();
  await pending;
  const association =
    service.deleteMessageChannelMessageAssociationsByChannelId.mock.calls[0][0];
  const [scope, sweep] = service.cleanOrphanMessagesAndThreads.mock.calls[0];
  expect(scope).toBe(workspaceId);
  expect(association.messageChannelId).toBe(channelId);
  expectOperation(
    sweep,
    workspaceId,
    MessagingMessageChannelDeletionCleanupJob.name,
  );
  expect(sweep.operationId).not.toBe(association.auditOperation.operationId);
  expect(sweep.correlationId).toBe(association.auditOperation.correlationId);
});

it('account job attributes the workspace sweep to itself, never a payload actor', async () => {
  const service = cleaner(),
    workspaceId = randomUUID();
  const job = new MessagingConnectedAccountDeletionCleanupJob(service as never);
  await job.handle({
    workspaceId,
    connectedAccountId: randomUUID(),
    actor: { kind: 'coreUser', id: randomUUID() },
  } as never);
  expect(service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(1);
  expectOperation(
    service.cleanOrphanMessagesAndThreads.mock.calls[0][1],
    workspaceId,
    MessagingConnectedAccountDeletionCleanupJob.name,
  );
});

it('blocklist captures its event IDs before entering asynchronous workspace context', async () => {
  const service = cleaner(),
    workspaceId = randomUUID(),
    recordId = randomUUID();
  const find = jest.fn().mockResolvedValue([]);
  let enter!: () => Promise<void>;
  const manager = {
    getWorkspaceId: () => workspaceId,
    getRepository: () => ({ find }),
    executeInWorkspaceContext: (work: () => Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        enter = async () => {
          try {
            await work();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      }),
  };
  const job = new BlocklistItemDeleteMessagesJob(
    service as never,
    manager as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const data = { workspaceId, events: [{ recordId }] };
  const pending = job.handle(data as never);
  data.workspaceId = randomUUID();
  data.events[0].recordId = randomUUID();
  await enter();
  await pending;
  expect(JSON.stringify(find.mock.calls)).toContain(recordId);
  expect(JSON.stringify(find.mock.calls)).not.toContain(
    data.events[0].recordId,
  );
  expectOperation(
    service.cleanOrphanMessagesAndThreads.mock.calls[0][1],
    workspaceId,
    BlocklistItemDeleteMessagesJob.name,
  );
});

it('reset command uses fresh sweep operations per channel and captured workspace identity', async () => {
  const service = cleaner(),
    workspaceId = randomUUID(),
    channels = [{ id: randomUUID() }, { id: randomUUID() }];
  const options = { workspaceId };
  const reset = jest.fn().mockImplementation(async () => {
    options.workspaceId = randomUUID();
  });
  const command = new MessagingResetChannelCommand(
    {
      executeInWorkspaceContext: (work: () => Promise<void>) => work(),
    } as never,
    { find: async () => channels } as never,
    { resetAndMarkAsMessagesListFetchPending: reset } as never,
    service as never,
  );
  await command.run([], options);
  expect(service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(2);
  const operations = service.cleanOrphanMessagesAndThreads.mock.calls.map(
    ([id, operation]) => {
      expect(id).toBe(workspaceId);
      expectOperation(
        operation,
        workspaceId,
        MessagingResetChannelCommand.name,
      );
      return operation;
    },
  );
  expect(operations[0].operationId).not.toBe(operations[1].operationId);
  expect(operations[0].correlationId).toBe(operations[1].correlationId);
});

const cliFixture = () => {
  const workspaceIds = [randomUUID(), randomUUID()];
  const repository = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      databaseSchema: 'test_workspace',
    })),
    exists: jest.fn().mockResolvedValue(true),
  };
  const evict = jest.fn().mockResolvedValue(undefined);
  const iterator = new WorkspaceIteratorService(
    repository as never,
    {} as never,
    {
      executeInWorkspaceContext: (work: () => Promise<void>) => work(),
    } as never,
    {
      listenToShutdownSignals: jest.fn(),
      isShutdownRequested: () => false,
    } as never,
    { evictWorkspaceFromLocalCache: evict } as never,
  );
  const service = cleaner();
  const command = new MessagingMessageCleanerRemoveOrphansCommand(
    iterator,
    service as never,
  );
  const run = (dryRun = false) =>
    command.run([], { workspaceId: new Set(workspaceIds), dryRun });
  return { workspaceIds, repository, evict, iterator, service, command, run };
};

it('actual remove-orphans runner dry run never invokes sweep despite iterator callbacks', async () => {
  const f = cliFixture();
  await f.run(true);
  expect(f.repository.findOne).toHaveBeenCalledTimes(2);
  expect(f.service.cleanOrphanMessagesAndThreads).not.toHaveBeenCalled();
  expect(f.evict).toHaveBeenCalledTimes(2);
});

it('actual remove-orphans runner creates named operations per workspace', async () => {
  const f = cliFixture();
  await f.run();
  for (const [workspaceId, operation] of f.service.cleanOrphanMessagesAndThreads
    .mock.calls)
    expectOperation(
      operation,
      workspaceId,
      MessagingMessageCleanerRemoveOrphansCommand.name,
    );
  expect(f.service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(2);
});

const errors = () => [
  new NativeTransactionOutcomeUnknownError('commit', new Error('lost ack')),
  new OmniCoreTransactionOutcomeUnknownError(new Error('lost core ack')),
  new CoreAuditPostCommitError(new Error('postcommit failed')),
];
it.each(errors())(
  'actual iterator and runner preserve unsafe instance and stop remaining work: %s',
  async (error) => {
    const f = cliFixture();
    f.service.cleanOrphanMessagesAndThreads.mockRejectedValueOnce(error);
    f.repository.exists.mockRejectedValue(
      new Error('must not consult existence after unsafe outcome'),
    );
    f.evict.mockRejectedValue(new Error('cache eviction unavailable'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('warning backend failed');
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      throw new Error('error backend failed');
    });
    await expect(f.run()).rejects.toBe(error);
    expect(f.service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(1);
    expect(f.repository.findOne).toHaveBeenCalledTimes(1);
    expect(f.repository.exists).not.toHaveBeenCalled();
    expect(f.evict).toHaveBeenCalledTimes(1);
  },
);

it('ordinary workspace failure remains an iterator report and subsequent work still runs', async () => {
  const f = cliFixture(),
    error = new Error('ordinary failure');
  f.service.cleanOrphanMessagesAndThreads.mockRejectedValueOnce(error);
  await expect(f.run()).rejects.toThrow('Command failed for 1 workspace(s)');
  expect(f.service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(2);
  expect(f.repository.exists).toHaveBeenCalledTimes(1);
  expect(f.evict).toHaveBeenCalledTimes(2);
});

const blocklistBoundary = (eventCount = 1) => {
  const service = cleaner();
  const workspaceId = randomUUID();
  const eventIds = Array.from({ length: eventCount }, () => randomUUID());
  const channelIds = [randomUUID(), randomUUID()];
  const candidateId = randomUUID();
  const findRules = jest.fn().mockResolvedValue(
    eventIds.map((id) => ({
      id,
      scope: 'WORKSPACE',
      handle: 'blocked@example.test',
    })),
  );
  const findAssociations = jest.fn().mockResolvedValue([{ id: candidateId }]);
  const scope = { workspaceId };
  const transaction = jest.fn(
    async (
      work: (issued: typeof scope) => Promise<unknown>,
      _options?: unknown,
    ) => work(scope),
  );
  const manager = {
    getWorkspaceId: () => workspaceId,
    getRepository: (name: string) =>
      name === 'blocklist' ? { find: findRules } : { find: findAssociations },
    executeInWorkspaceContext: (work: () => Promise<void>) => work(),
    runInWorkspaceTransaction: transaction,
  };
  const channelRepository = {
    find: jest.fn().mockResolvedValue(channelIds.map((id) => ({ id }))),
  };
  const job = new BlocklistItemDeleteMessagesJob(
    service as never,
    manager as never,
    channelRepository as never,
    {} as never,
    {} as never,
    {} as never,
  );
  blocklistOwner.mockResolvedValue({ primaryDeletedAssociationIds: [] });
  const data = {
    workspaceId,
    events: eventIds.map((recordId) => ({ recordId })),
  };
  return {
    service,
    workspaceId,
    eventIds,
    channelIds,
    candidateId,
    findRules,
    findAssociations,
    scope,
    transaction,
    manager,
    channelRepository,
    job,
    data,
  };
};

it('blocklist pages capture event IDs and system identity, then use a separate correlated sweep', async () => {
  const f = blocklistBoundary();
  f.channelRepository.find.mockResolvedValue([{ id: f.channelIds[0] }]);
  f.findRules.mockImplementationOnce(async () => {
    f.data.workspaceId = randomUUID();
    f.data.events[0].recordId = randomUUID();
    return [
      { id: f.eventIds[0], scope: 'WORKSPACE', handle: 'blocked@example.test' },
    ];
  });
  await f.job.handle(f.data as never);
  expect(blocklistOwner).toHaveBeenCalledTimes(1);
  const owner = blocklistOwner.mock.calls[0][0];
  expect(owner.scope).toBe(f.scope);
  expect(owner.messageChannelId).toBe(f.channelIds[0]);
  expect(owner.blocklistItemIds).toEqual(f.eventIds);
  expect(owner.candidateAssociationIds).toEqual([f.candidateId]);
  expectOperation(
    owner.operation,
    f.workspaceId,
    BlocklistItemDeleteMessagesJob.name,
  );
  expect(f.transaction.mock.calls[0][1]).toEqual({
    commitOutcome: 'strict',
    nativeOwnershipLock: 'exclusive',
  });
  const [workspaceId, sweep] =
    f.service.cleanOrphanMessagesAndThreads.mock.calls[0];
  expect(workspaceId).toBe(f.workspaceId);
  expectOperation(sweep, f.workspaceId, BlocklistItemDeleteMessagesJob.name);
  expect(sweep.operationId).not.toBe(owner.operation.operationId);
  expect(sweep.correlationId).toBe(owner.operation.correlationId);
});

it('blocklist advances through full nonmatching pages and passes all candidate IDs to the owner', async () => {
  const f = blocklistBoundary();
  f.channelRepository.find.mockResolvedValue([{ id: f.channelIds[0] }]);
  const first = Array.from({ length: 200 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
  }));
  f.findAssociations
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce([{ id: f.candidateId }]);
  await f.job.handle(f.data as never);
  expect(blocklistOwner).toHaveBeenCalledTimes(2);
  expect(blocklistOwner.mock.calls[0][0].candidateAssociationIds).toEqual(
    first.map(({ id }) => id),
  );
  expect(blocklistOwner.mock.calls[1][0].candidateAssociationIds).toEqual([
    f.candidateId,
  ]);
  expect(f.findAssociations.mock.calls[1][0].where.id.value).toBe(
    first[199].id,
  );
  expect(f.findAssociations.mock.calls[0][0].where).toEqual({
    messageChannelId: f.channelIds[0],
  });
  expect(f.service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(1);
});

it('blocklist stale first rule chunk does not discard later rule chunks', async () => {
  const f = blocklistBoundary(201);
  f.channelRepository.find.mockResolvedValue([{ id: f.channelIds[0] }]);
  blocklistOwner.mockResolvedValueOnce(null);
  await f.job.handle(f.data as never);
  expect(blocklistOwner).toHaveBeenCalledTimes(2);
  expect(blocklistOwner.mock.calls[0][0].blocklistItemIds).toEqual(
    f.eventIds.slice(0, 200),
  );
  expect(blocklistOwner.mock.calls[1][0].blocklistItemIds).toEqual(
    f.eventIds.slice(200),
  );
  expect(f.service.cleanOrphanMessagesAndThreads).toHaveBeenCalledTimes(1);
});

it.each(errors())(
  'blocklist preserves unsafe page failure and skips every later channel and final sweep: %s',
  async (error) => {
    const f = blocklistBoundary();
    blocklistOwner.mockRejectedValueOnce(error);
    await expect(f.job.handle(f.data as never)).rejects.toBe(error);
    expect(blocklistOwner).toHaveBeenCalledTimes(1);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.findAssociations).toHaveBeenCalledTimes(1);
    expect(f.service.cleanOrphanMessagesAndThreads).not.toHaveBeenCalled();
  },
);
