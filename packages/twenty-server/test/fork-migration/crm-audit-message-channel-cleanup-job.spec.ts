import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { MessagingMessageChannelDeletionCleanupJob } from 'src/modules/messaging/message-cleaner/jobs/messaging-message-channel-deletion-cleanup.job';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

jest.mock(
  'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service',
  () => ({ MessagingMessageCleanerService: class {} }),
);

const fixture = () => {
  const data = { workspaceId: randomUUID(), messageChannelId: randomUUID() };
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const orphan = jest.fn().mockResolvedValue(undefined);
  const job = new MessagingMessageChannelDeletionCleanupJob({
    deleteMessageChannelMessageAssociationsByChannelId: cleanup,
    cleanOrphanMessagesAndThreads: orphan,
  } as never);
  return { data, cleanup, orphan, job };
};

it('captures scope and creates a worker identity before awaiting association cleanup', async () => {
  const f = fixture();
  const workspaceId = f.data.workspaceId,
    messageChannelId = f.data.messageChannelId;
  const spoofedActor = { kind: 'coreUser', id: randomUUID() };
  Object.assign(f.data, {
    actor: spoofedActor,
    initiator: spoofedActor,
    correlationId: 'client-controlled',
  });
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.cleanup.mockImplementationOnce(async () => pause);
  const work = f.job.handle(f.data);
  expect(f.orphan).not.toHaveBeenCalled();
  f.data.workspaceId = randomUUID();
  f.data.messageChannelId = randomUUID();
  spoofedActor.id = randomUUID();
  release();
  await work;
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  const [input] = f.cleanup.mock.calls[0];
  expect(input).toMatchObject({
    workspaceId,
    messageChannelId,
    auditOperation: {
      workspaceId,
      actor: {
        kind: 'system',
        id: 'MessagingMessageChannelDeletionCleanupJob',
      },
    },
  });
  expect(input.auditOperation.initiator).toBeUndefined();
  expect(isUUID(input.auditOperation.operationId)).toBe(true);
  expect(isUUID(input.auditOperation.correlationId)).toBe(true);
  expect(f.orphan).toHaveBeenCalledWith(workspaceId);
  expect(f.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
    f.orphan.mock.invocationCallOrder[0],
  );
});

it.each([
  new Error('audit append refused'),
  new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('lost acknowledgement'),
  ),
  new CoreAuditPostCommitError(new Error('postcommit hook failed')),
])(
  'preserves cleanup failure and does not start orphan cleanup: %s',
  async (error) => {
    const f = fixture();
    f.cleanup.mockRejectedValueOnce(error);
    await expect(f.job.handle(f.data)).rejects.toBe(error);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.orphan).not.toHaveBeenCalled();
  },
);

it('assigns independent operation and correlation IDs to separate job executions', async () => {
  const f = fixture();
  await f.job.handle(f.data);
  await f.job.handle(f.data);
  const first = f.cleanup.mock.calls[0][0].auditOperation;
  const second = f.cleanup.mock.calls[1][0].auditOperation;
  expect(first.operationId).not.toBe(second.operationId);
  expect(first.correlationId).not.toBe(second.correlationId);
  expect(first.actor).toEqual(second.actor);
});

it('rejects invalid workspace attribution before either cleanup stage', async () => {
  const f = fixture();
  await expect(
    f.job.handle({ ...f.data, workspaceId: 'invalid' }),
  ).rejects.toThrow();
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(f.orphan).not.toHaveBeenCalled();
});

it('preserves an orphan failure after successful audited association cleanup', async () => {
  const f = fixture(),
    error = new Error('orphan cleanup refused');
  f.orphan.mockRejectedValueOnce(error);
  await expect(f.job.handle(f.data)).rejects.toBe(error);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  expect(f.orphan).toHaveBeenCalledTimes(1);
});
