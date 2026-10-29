import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
// Only the terminal boundary is substituted here. The companion PostgreSQL
// suite exercises the real owner; these cases exercise the real service/job.
jest.mock(
  'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit',
  () => ({ deleteNativeCalendarChannelAssociationsWithAudit: jest.fn() }),
);

import { deleteNativeCalendarChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit';
import { CalendarEventCleanerService } from 'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service';
import { CalendarChannelDeletionCleanupJob } from 'src/modules/calendar/calendar-event-cleaner/jobs/calendar-channel-deletion-cleanup.job';

const owner = deleteNativeCalendarChannelAssociationsWithAudit as jest.Mock;
const fixture = () => {
  const workspaceId = randomUUID();
  const calendarChannelId = randomUUID();
  const scope = { workspaceId };
  const transaction = jest.fn(
    async (
      work: (issued: typeof scope) => Promise<number>,
      _options?: unknown,
    ) => work(scope),
  );
  const enter = jest.fn(
    async (work: () => Promise<number>, _auth?: unknown, _options?: unknown) =>
      work(),
  );
  const manager = {
    getWorkspaceId: jest.fn(() => workspaceId),
    executeInWorkspaceContext: enter,
    runInWorkspaceTransaction: transaction,
  };
  const service = new CalendarEventCleanerService(manager as never);
  const job = new CalendarChannelDeletionCleanupJob(service);
  const sweep = jest
    .spyOn(service, 'cleanWorkspaceCalendarEvents')
    .mockResolvedValue(undefined);
  const operation = membershipCleanupOperation(
    workspaceId,
    systemMembershipCleanupIdentity(
      workspaceId,
      'CalendarChannelDeletionCleanupJob',
    ),
  )!;
  return {
    workspaceId,
    calendarChannelId,
    scope,
    transaction,
    enter,
    manager,
    service,
    job,
    sweep,
    operation,
  };
};

beforeEach(() => owner.mockReset());
afterEach(() => jest.restoreAllMocks());

it('service captures operation and scope before awaits and returns the actual owner count', async () => {
  const f = fixture();
  owner.mockResolvedValue(3);
  let enter!: () => Promise<number>;
  f.enter.mockImplementationOnce(
    (work) =>
      new Promise<number>((resolve, reject) => {
        enter = async () => {
          try {
            const value = await work();
            resolve(value);
            return value;
          } catch (error) {
            reject(error);
            throw error;
          }
        };
      }),
  );
  const input = {
    workspaceId: f.workspaceId,
    calendarChannelId: f.calendarChannelId,
    auditOperation: f.operation,
  };
  const captured = { ...f.operation, actor: { ...f.operation.actor } };
  const pending =
    f.service.deleteCalendarChannelEventAssociationsByChannelId(input);
  input.workspaceId = randomUUID();
  input.calendarChannelId = randomUUID();
  input.auditOperation.actor = {
    kind: 'system',
    id: 'untrusted-mutated-caller',
  };
  await enter();
  expect(await pending).toBe(3);
  expect(owner).toHaveBeenCalledWith({
    scope: f.scope,
    operation: captured,
    calendarChannelId: f.calendarChannelId,
  });
  expect(f.transaction.mock.calls[0][1]).toEqual({
    commitOutcome: 'strict',
    nativeOwnershipLock: 'exclusive',
  });
  expect(f.enter.mock.calls[0][2]).toEqual({ lite: true });
  expect(f.sweep).not.toHaveBeenCalled();
});

it.each(['missing', 'foreign'] as const)(
  'service refuses %s audit operation before opening context',
  async (kind) => {
    const f = fixture();
    await expect(
      f.service.deleteCalendarChannelEventAssociationsByChannelId({
        workspaceId: f.workspaceId,
        calendarChannelId: f.calendarChannelId,
        auditOperation:
          kind === 'missing'
            ? (undefined as never)
            : { ...f.operation, workspaceId: randomUUID() },
      }),
    ).rejects.toThrow('scoped audit operation');
    expect(f.enter).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
  },
);

it.each(['context', 'transaction'] as const)(
  'service refuses a mismatched %s workspace before invoking the owner',
  async (kind) => {
    const f = fixture();
    if (kind === 'context')
      f.manager.getWorkspaceId.mockReturnValue(randomUUID());
    else f.scope.workspaceId = randomUUID();
    await expect(
      f.service.deleteCalendarChannelEventAssociationsByChannelId({
        workspaceId: f.workspaceId,
        calendarChannelId: f.calendarChannelId,
        auditOperation: f.operation,
      }),
    ).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(owner).not.toHaveBeenCalled();
    expect(f.sweep).not.toHaveBeenCalled();
  },
);

it('actual job pins IDs and attributes the owner to itself, then retains the separate sweep', async () => {
  const f = fixture();
  const payload = {
    workspaceId: f.workspaceId,
    calendarChannelId: f.calendarChannelId,
    actor: { kind: 'coreUser', id: randomUUID() },
  };
  owner.mockImplementationOnce(async () => {
    payload.workspaceId = randomUUID();
    payload.calendarChannelId = randomUUID();
    return 0;
  });
  await f.job.handle(payload);
  const called = owner.mock.calls[0][0];
  expect(called.calendarChannelId).toBe(f.calendarChannelId);
  expect(called.operation).toMatchObject({
    workspaceId: f.workspaceId,
    actor: { kind: 'system', id: 'CalendarChannelDeletionCleanupJob' },
  });
  expect(called.operation.initiator).toBeUndefined();
  expect(isUUID(called.operation.operationId)).toBe(true);
  expect(isUUID(called.operation.correlationId)).toBe(true);
  expect(f.sweep).toHaveBeenCalledTimes(1);
  expect(f.sweep).toHaveBeenCalledWith(f.workspaceId);
  expect(owner.mock.invocationCallOrder[0]).toBeLessThan(
    f.sweep.mock.invocationCallOrder[0],
  );
});

it.each([
  new Error('ordinary owner failure'),
  new NativeTransactionOutcomeUnknownError('commit', new Error('lost ack')),
  new CoreAuditPostCommitError(new Error('postcommit failed')),
])(
  'actual job preserves owner failure and never sweeps or retries: %s',
  async (error) => {
    const f = fixture();
    owner.mockRejectedValueOnce(error);
    await expect(
      f.job.handle({
        workspaceId: f.workspaceId,
        calendarChannelId: f.calendarChannelId,
      }),
    ).rejects.toBe(error);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.sweep).not.toHaveBeenCalled();
  },
);
