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
// These tests execute the actual service and all three jobs. Only terminal
// owner boundaries are mocked; the companion PG suite executes their real SQL.
jest.mock(
  'src/engine/core-modules/crm-audit/clean-workspace-native-calendar-events-with-audit',
  () => ({ cleanWorkspaceNativeCalendarEventsWithAudit: jest.fn() }),
);
jest.mock(
  'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit',
  () => ({ deleteNativeCalendarChannelAssociationsWithAudit: jest.fn() }),
);

import { cleanWorkspaceNativeCalendarEventsWithAudit } from 'src/engine/core-modules/crm-audit/clean-workspace-native-calendar-events-with-audit';
import { deleteNativeCalendarChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit';
import { CalendarEventCleanerService } from 'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service';
import { CalendarChannelDeletionCleanupJob } from 'src/modules/calendar/calendar-event-cleaner/jobs/calendar-channel-deletion-cleanup.job';
import { DeleteConnectedAccountAssociatedCalendarDataJob } from 'src/modules/calendar/calendar-event-cleaner/jobs/delete-connected-account-associated-calendar-data.job';
import { BlocklistItemDeleteCalendarEventsJob } from 'src/modules/calendar/blocklist-manager/jobs/blocklist-item-delete-calendar-events.job';

const sweepOwner = cleanWorkspaceNativeCalendarEventsWithAudit as jest.Mock;
const associationOwner =
  deleteNativeCalendarChannelAssociationsWithAudit as jest.Mock;
const emptyResult = () => ({
  deletedEventIds: [],
  deletedAssociationIds: [],
  deletedParticipantIds: [],
  deletedTargetIds: [],
  updatedCallRecordingIds: [],
});
const fixture = () => {
  const workspaceId = randomUUID();
  const scope = { workspaceId };
  const transaction = jest.fn(
    async (
      work: (issued: typeof scope) => Promise<unknown>,
      _options?: unknown,
    ) => work(scope),
  );
  const enter = jest.fn(
    async (work: () => Promise<unknown>, _auth?: unknown, _options?: unknown) =>
      work(),
  );
  const manager = {
    getWorkspaceId: jest.fn(() => workspaceId),
    executeInWorkspaceContext: enter,
    runInWorkspaceTransaction: transaction,
    getRepository: jest.fn(() => {
      throw new Error(
        'Entry point must not classify calendar handles or mutate repositories',
      );
    }),
  };
  const service = new CalendarEventCleanerService(manager as never);
  const operation = membershipCleanupOperation(
    workspaceId,
    systemMembershipCleanupIdentity(
      workspaceId,
      'CalendarChannelDeletionCleanupJob',
    ),
  )!;
  return {
    workspaceId,
    scope,
    transaction,
    enter,
    manager,
    service,
    operation,
  };
};
const jobCases = [
  ['channel', 'CalendarChannelDeletionCleanupJob'],
  ['account', 'DeleteConnectedAccountAssociatedCalendarDataJob'],
  ['blocklist', 'BlocklistItemDeleteCalendarEventsJob'],
] as const;
type JobKind = (typeof jobCases)[number][0];
const runJob = (
  kind: JobKind,
  f: ReturnType<typeof fixture>,
  payload: unknown,
) => {
  if (kind === 'channel')
    return new CalendarChannelDeletionCleanupJob(f.service).handle(
      payload as never,
    );
  if (kind === 'account')
    return new DeleteConnectedAccountAssociatedCalendarDataJob(
      f.service,
    ).handle(payload as never);
  return new BlocklistItemDeleteCalendarEventsJob(f.service).handle(
    payload as never,
  );
};
const payloadFor = (workspaceId: string) => ({
  workspaceId,
  calendarChannelId: randomUUID(),
  connectedAccountId: randomUUID(),
  events: [{ recordId: randomUUID(), handle: 'do-not-classify@example.test' }],
  actor: { kind: 'coreUser', id: randomUUID() },
});
beforeEach(() => {
  sweepOwner.mockReset().mockResolvedValue(emptyResult());
  associationOwner.mockReset().mockResolvedValue(0);
});
afterEach(() => jest.restoreAllMocks());

it('real sweep service captures audit principals before awaiting and keeps its void result contract', async () => {
  const f = fixture();
  f.operation.initiator = { kind: 'coreUser', id: randomUUID() };
  const expectedOperation = {
    ...f.operation,
    actor: { ...f.operation.actor },
    initiator: { ...f.operation.initiator },
  };
  let release!: () => Promise<void>;
  f.enter.mockImplementationOnce(
    (work) =>
      new Promise<unknown>((resolve, reject) => {
        release = async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
  const pending = f.service.cleanWorkspaceCalendarEvents(
    f.workspaceId,
    f.operation,
  );
  f.operation.workspaceId = randomUUID();
  f.operation.actor = { kind: 'system', id: 'mutated-actor' };
  f.operation.initiator = { kind: 'coreUser', id: randomUUID() };
  await release();
  expect(await pending).toBeUndefined();
  expect(sweepOwner).toHaveBeenCalledWith({
    scope: f.scope,
    operation: expectedOperation,
  });
  expect(f.transaction.mock.calls[0][1]).toEqual({
    commitOutcome: 'strict',
    nativeOwnershipLock: 'exclusive',
  });
  expect(f.enter.mock.calls[0][1]).toMatchObject({
    type: 'system',
    workspace: { id: f.workspaceId },
  });
  expect(f.enter.mock.calls[0][2]).toEqual({ lite: true });
  expect(associationOwner).not.toHaveBeenCalled();
  expect(f.manager.getRepository).not.toHaveBeenCalled();
});

it.each(['missing', 'foreign'] as const)(
  'real sweep service refuses %s operation before entering context',
  async (kind) => {
    const f = fixture();
    await expect(
      f.service.cleanWorkspaceCalendarEvents(
        f.workspaceId,
        kind === 'missing'
          ? (undefined as never)
          : { ...f.operation, workspaceId: randomUUID() },
      ),
    ).rejects.toThrow();
    expect(f.enter).not.toHaveBeenCalled();
    expect(sweepOwner).not.toHaveBeenCalled();
  },
);

it.each(['context', 'transaction'] as const)(
  'real sweep service refuses mismatched %s workspace before the owner',
  async (kind) => {
    const f = fixture();
    if (kind === 'context')
      f.manager.getWorkspaceId.mockReturnValue(randomUUID());
    else f.scope.workspaceId = randomUUID();
    await expect(
      f.service.cleanWorkspaceCalendarEvents(f.workspaceId, f.operation),
    ).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(sweepOwner).not.toHaveBeenCalled();
  },
);

it.each(jobCases)(
  'real %s job captures workspace and uses its own named system actor (%s)',
  async (kind, actorId) => {
    const f = fixture(),
      payload = payloadFor(f.workspaceId);
    f.enter.mockImplementationOnce(async (work) => {
      payload.workspaceId = randomUUID();
      payload.actor.id = randomUUID();
      return work();
    });
    await runJob(kind, f, payload);
    expect(sweepOwner).toHaveBeenCalledTimes(1);
    const { scope, operation } = sweepOwner.mock.calls[0][0];
    expect(scope).toBe(f.scope);
    expect(operation).toMatchObject({
      workspaceId: f.workspaceId,
      actor: { kind: 'system', id: actorId },
    });
    expect(operation.initiator).toBeUndefined();
    expect(isUUID(operation.operationId)).toBe(true);
    expect(isUUID(operation.correlationId)).toBe(true);
    for (const [, options] of f.transaction.mock.calls)
      expect(options).toEqual({
        commitOutcome: 'strict',
        nativeOwnershipLock: 'exclusive',
      });
    expect(f.manager.getRepository).not.toHaveBeenCalled();
    expect(associationOwner).toHaveBeenCalledTimes(kind === 'channel' ? 1 : 0);
  },
);

it('channel zero-association result still starts a separate correlated audited sweep', async () => {
  const f = fixture();
  await runJob('channel', f, payloadFor(f.workspaceId));
  expect(associationOwner).toHaveBeenCalledTimes(1);
  expect(sweepOwner).toHaveBeenCalledTimes(1);
  const first = associationOwner.mock.calls[0][0].operation;
  const second = sweepOwner.mock.calls[0][0].operation;
  expect(second.actor).toEqual(first.actor);
  expect(second.correlationId).toBe(first.correlationId);
  expect(second.operationId).not.toBe(first.operationId);
  expect(f.transaction).toHaveBeenCalledTimes(2);
  expect(associationOwner.mock.invocationCallOrder[0]).toBeLessThan(
    sweepOwner.mock.invocationCallOrder[0],
  );
});

it('calendar blocklist job does not read event handles or perform messaging classification', async () => {
  const f = fixture();
  const payload = { workspaceId: f.workspaceId };
  Object.defineProperty(payload, 'events', {
    get: () => {
      throw new Error(
        'Calendar blocklist must not inspect attendees or handles',
      );
    },
  });
  await runJob('blocklist', f, payload);
  expect(sweepOwner).toHaveBeenCalledTimes(1);
  expect(associationOwner).not.toHaveBeenCalled();
  expect(f.manager.getRepository).not.toHaveBeenCalled();
});

const failureCases = jobCases.flatMap(([kind]) => [
  { kind, label: 'ordinary', error: new Error('sweep failure') },
  {
    kind,
    label: 'unknown commit',
    error: new NativeTransactionOutcomeUnknownError(
      'commit',
      new Error('lost ack'),
    ),
  },
  {
    kind,
    label: 'confirmed postcommit',
    error: new CoreAuditPostCommitError(new Error('postcommit failed')),
  },
]);
it.each(failureCases)(
  '$kind job preserves $label sweep failure without retrying either owner',
  async ({ kind, error }) => {
    const f = fixture();
    sweepOwner.mockRejectedValueOnce(error);
    await expect(runJob(kind, f, payloadFor(f.workspaceId))).rejects.toBe(
      error,
    );
    expect(sweepOwner).toHaveBeenCalledTimes(1);
    expect(associationOwner).toHaveBeenCalledTimes(kind === 'channel' ? 1 : 0);
    expect(f.transaction).toHaveBeenCalledTimes(kind === 'channel' ? 2 : 1);
    expect(f.manager.getRepository).not.toHaveBeenCalled();
  },
);
