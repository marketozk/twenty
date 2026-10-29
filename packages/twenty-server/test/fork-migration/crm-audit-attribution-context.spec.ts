import { randomUUID } from 'node:crypto';
import {
  captureCrmAuditRequest,
  captureCurrentCrmAuditIdentity,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { WorkspaceAuthContextMiddleware } from 'src/engine/core-modules/auth/middlewares/workspace-auth-context.middleware';
import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { buildWorkspaceAuthContextFromRequest } from 'src/engine/core-modules/auth/utils/build-workspace-auth-context-from-request.util';
jest.mock(
  'src/engine/core-modules/auth/utils/build-workspace-auth-context-from-request.util',
  () => ({
    buildWorkspaceAuthContextFromRequest: jest.fn((req) => ({
      type: 'user',
      workspace: req.workspace,
      user: req.user,
    })),
  }),
);
jest.mock(
  'src/engine/core-modules/sentry/utils/apply-workspace-sentry-context.util',
  () => ({ applyWorkspaceSentryContext: jest.fn() }),
);
jest.mock(
  'src/engine/core-modules/application/application-install/application-install.service',
  () => ({ ApplicationInstallService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-upgrade/application-upgrade.service',
  () => ({ ApplicationUpgradeService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-install/services/application-uninstall-runner.service',
  () => ({ ApplicationUninstallRunnerService: class {} }),
);
jest.mock('src/engine/core-modules/application/application.service', () => ({
  ApplicationService: class {},
}));
jest.mock(
  'src/engine/core-modules/application/application-marketplace/marketplace-query.service',
  () => ({ MarketplaceQueryService: class {} }),
);
jest.mock('src/engine/core-modules/cache-lock/cache-lock.service', () => ({
  CacheLockService: class {},
}));
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/utils/build-job-status.util',
  () => ({ buildJobStatus: jest.fn() }),
);
import { ApplicationLifecycleJobService } from 'src/engine/core-modules/application/application-install/services/application-lifecycle-job.service';
import { TriggerInstallApplicationJob } from 'src/engine/core-modules/application/application-install/jobs/trigger-install-application.job';
import { TriggerUpgradeApplicationJob } from 'src/engine/core-modules/application/application-upgrade/jobs/trigger-upgrade-application.job';
import { TriggerUninstallApplicationJob } from 'src/engine/core-modules/application/application-install/jobs/trigger-uninstall-application.job';

const request = () => ({
  workspace: { id: randomUUID() },
  user: { id: randomUUID() },
});
const resolve = jest.fn(
  async (_id: string): Promise<string | undefined> => undefined,
);
const current = (workspaceId: string) =>
  captureCurrentCrmAuditIdentity(workspaceId, resolve);
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
beforeEach(() => {
  jest.clearAllMocks();
  resolve.mockResolvedValue(undefined);
});

it('isolates concurrent request workspaces and keeps one correlation per request', async () => {
  const a = request(),
    b = request(),
    ready = gate();
  const first = withCrmAuditRequest(captureCrmAuditRequest(a), async () => {
    await ready.promise;
    return current(a.workspace.id);
  });
  const second = withCrmAuditRequest(captureCrmAuditRequest(b), async () => {
    const identity = await current(b.workspace.id);
    ready.release();
    return identity;
  });
  const [left, right] = await Promise.all([first, second]);
  expect(left?.actor).toEqual({ kind: 'coreUser', id: a.user.id });
  expect(right?.actor).toEqual({ kind: 'coreUser', id: b.user.id });
  expect(left?.correlationId).not.toBe(right?.correlationId);
  expect(await current(a.workspace.id)).toBeUndefined();
  const snapshot = captureCrmAuditRequest(a);
  await withCrmAuditRequest(snapshot, async () => {
    const one = membershipCleanupOperation(
      a.workspace.id,
      await current(a.workspace.id),
    )!;
    const two = membershipCleanupOperation(
      a.workspace.id,
      await current(a.workspace.id),
    )!;
    expect(one.operationId).not.toBe(two.operationId);
    expect(one.correlationId).toBe(two.correlationId);
  });
});

it('copies only primitive authentication and never stores request secrets or body actor', async () => {
  const req = {
    ...request(),
    headers: { authorization: 'secret-token' },
    body: { actor: { kind: 'system', id: 'spoof' } },
  };
  const workspace = req.workspace.id,
    actor = req.user.id,
    snapshot = captureCrmAuditRequest(req);
  req.workspace.id = randomUUID();
  req.user.id = randomUUID();
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.authentication.user)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(
    /secret-token|spoof|authorization/,
  );
  expect(
    await withCrmAuditRequest(snapshot, () => current(workspace)),
  ).toMatchObject({
    workspaceId: workspace,
    actor: { kind: 'coreUser', id: actor },
  });
});

it('restores a parent request after a nested named system context throws', async () => {
  const req = request(),
    other = randomUUID();
  await withCrmAuditRequest(captureCrmAuditRequest(req), async () => {
    await expect(
      withCrmAuditIdentity(
        other,
        systemMembershipCleanupIdentity(other, 'FixtureSystem'),
        async () => {
          expect((await current(other))?.actor).toEqual({
            kind: 'system',
            id: 'FixtureSystem',
          });
          throw new Error('fixture');
        },
      ),
    ).rejects.toThrow('fixture');
    expect((await current(req.workspace.id))?.actor.id).toBe(req.user.id);
  });
});

it('masks ambient attribution for a legacy job and refuses a foreign resolved identity', async () => {
  const req = request(),
    other = randomUUID(),
    work = jest.fn();
  await withCrmAuditRequest(captureCrmAuditRequest(req), async () => {
    expect(
      await withCrmAuditIdentity(req.workspace.id, undefined, () =>
        current(req.workspace.id),
      ),
    ).toBeUndefined();
    expect(() =>
      withCrmAuditIdentity(
        other,
        systemMembershipCleanupIdentity(req.workspace.id, 'Fixture'),
        work,
      ),
    ).toThrow('workspace mismatch');
    expect(work).not.toHaveBeenCalled();
    expect((await current(req.workspace.id))?.actor.id).toBe(req.user.id);
  });
});

it('refuses foreign request scope and anonymous mutation attribution without changing middleware capture', async () => {
  const req = request();
  await expect(
    withCrmAuditRequest(captureCrmAuditRequest(req), () =>
      current(randomUUID()),
    ),
  ).rejects.toThrow('workspace mismatch');
  const snapshot = captureCrmAuditRequest({ workspace: req.workspace });
  await expect(
    withCrmAuditRequest(snapshot, () => current(req.workspace.id)),
  ).rejects.toThrow('authentication is unavailable');
});

it('resolves impersonation from the captured membership even after request mutation', async () => {
  const membership = randomUUID(),
    initiator = randomUUID(),
    req = {
      ...request(),
      impersonationContext: { impersonatorUserWorkspaceId: membership },
    };
  resolve.mockResolvedValue(initiator);
  const snapshot = captureCrmAuditRequest(req);
  req.impersonationContext.impersonatorUserWorkspaceId = randomUUID();
  const identity = await withCrmAuditRequest(snapshot, () =>
    current(req.workspace.id),
  );
  expect(resolve).toHaveBeenCalledWith(membership);
  expect(identity).toMatchObject({
    actor: { kind: 'coreUser', id: req.user.id },
    initiator: { kind: 'coreUser', id: initiator },
  });
  resolve.mockResolvedValue(undefined);
  await expect(
    withCrmAuditRequest(snapshot, () => current(req.workspace.id)),
  ).rejects.toThrow('initiator unavailable');
});

it.each(['application', 'agent', 'apiKey'] as const)(
  'captures %s without substituting a target application',
  async (kind) => {
    const workspace = { id: randomUUID() },
      user = { id: randomUUID() },
      application = { id: randomUUID() },
      agentId = randomUUID(),
      apiKey = { id: randomUUID() };
    const snapshot = captureCrmAuditRequest(
      kind === 'apiKey'
        ? { workspace, apiKey }
        : {
            workspace,
            user,
            application,
            ...(kind === 'agent' ? { agentId } : {}),
          },
    );
    const identity = await withCrmAuditRequest(snapshot, () =>
      current(workspace.id),
    );
    expect(identity?.actor).toEqual({
      kind,
      id:
        kind === 'apiKey'
          ? apiKey.id
          : kind === 'agent'
            ? agentId
            : application.id,
    });
    if (kind !== 'apiKey')
      expect(identity?.initiator).toEqual({ kind: 'coreUser', id: user.id });
  },
);

it('rejects ambiguous agent provenance at consumption, not unrelated middleware entry', async () => {
  const req = { ...request(), agentId: randomUUID() },
    snapshot = captureCrmAuditRequest(req);
  await expect(
    withCrmAuditRequest(snapshot, () => current(req.workspace.id)),
  ).rejects.toThrow('agent requires');
});

it('actual middleware wraps next with both existing auth and immutable attribution', async () => {
  const req = request(),
    expected = req.user.id;
  let pending!: Promise<unknown>;
  new WorkspaceAuthContextMiddleware().use(req as never, {} as never, () => {
    expect(getWorkspaceAuthContext()).toMatchObject({
      workspace: req.workspace,
    });
    pending = Promise.resolve().then(() => current(req.workspace.id));
  });
  req.user.id = randomUUID();
  expect(await pending).toMatchObject({ actor: { id: expected } });
  expect(await current(req.workspace.id)).toBeUndefined();
});

it('middleware preserves the old no-workspace and hydration-failure behavior', async () => {
  const next = jest.fn();
  new WorkspaceAuthContextMiddleware().use({} as never, {} as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(buildWorkspaceAuthContextFromRequest).not.toHaveBeenCalled();
  jest
    .mocked(buildWorkspaceAuthContextFromRequest)
    .mockImplementationOnce(() => {
      throw new Error('authentication refused');
    });
  expect(() =>
    new WorkspaceAuthContextMiddleware().use(
      request() as never,
      {} as never,
      next,
    ),
  ).toThrow('authentication refused');
  expect(next).toHaveBeenCalledTimes(1);
});

const queueFixture = () => {
  const queue = {
    getInFlightJobs: jest.fn().mockResolvedValue([]),
    add: jest.fn().mockResolvedValue('queued-id'),
  };
  const application = {
    captureLifecycleAuditIdentity: current,
    findOneApplicationWithRelationsOrThrow: jest.fn().mockResolvedValue({}),
    assertUninstallIsNotBlockedByOtherWorkspaceInstallationsOrThrow: jest
      .fn()
      .mockResolvedValue(undefined),
  };
  const registration = {
    findRegistrationByUniversalIdentifier: jest
      .fn()
      .mockResolvedValue({ id: randomUUID() }),
  };
  const service = new ApplicationLifecycleJobService(
    application as never,
    registration as never,
    { withLock: (work: () => Promise<unknown>) => work() } as never,
    queue as never,
  );
  return { service, queue, registration };
};
const jobKinds = ['install', 'upgrade', 'uninstall'] as const;
const makeJob = (kind: (typeof jobKinds)[number], work: jest.Mock) =>
  kind === 'install'
    ? new TriggerInstallApplicationJob({ installApplication: work } as never)
    : kind === 'upgrade'
      ? new TriggerUpgradeApplicationJob({ upgradeApplication: work } as never)
      : new TriggerUninstallApplicationJob({
          uninstallApplication: work,
        } as never);

it.each(jobKinds)(
  'serializes %s attribution through its real enqueue and handler',
  async (kind) => {
    const req = request(),
      { service, queue } = queueFixture();
    const target = {
      workspaceId: req.workspace.id,
      universalIdentifier: randomUUID(),
      targetVersion: '2.0.0',
    };
    await withCrmAuditRequest(captureCrmAuditRequest(req), () =>
      kind === 'install'
        ? service.triggerInstallApplication(target)
        : kind === 'upgrade'
          ? service.triggerUpgradeApplication(target)
          : service.triggerUninstallApplication(target),
    );
    const payload = JSON.parse(JSON.stringify(queue.add.mock.calls[0][1]));
    expect(payload.auditIdentity.actor).toEqual({
      kind: 'coreUser',
      id: req.user.id,
    });
    const work = jest.fn(async (_input: unknown) => current(req.workspace.id)),
      updateProgress = jest.fn();
    await makeJob(kind, work).handle(payload, { updateProgress } as never);
    expect(await work.mock.results[0].value).toEqual(payload.auditIdentity);
    expect(work).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: req.workspace.id,
        updateProgress,
      }),
    );
    expect(work.mock.calls[0][0]).not.toHaveProperty('auditIdentity');
    expect(await current(req.workspace.id)).toBeUndefined();
  },
);

it.each(jobKinds)(
  'legacy %s job cannot borrow an ambient caller',
  async (kind) => {
    const req = request(),
      work = jest.fn(async () => current(req.workspace.id));
    await withCrmAuditRequest(captureCrmAuditRequest(req), () =>
      makeJob(kind, work).handle(
        {
          workspaceId: req.workspace.id,
          applicationRegistrationId: randomUUID(),
          universalIdentifier: randomUUID(),
          targetVersion: '2',
        },
        {} as never,
      ),
    );
    expect(await work.mock.results[0].value).toBeUndefined();
  },
);

it('in-flight dedup does not replace the original job attribution', async () => {
  const first = request(),
    second = { ...request(), workspace: first.workspace },
    { service, queue } = queueFixture(),
    universalIdentifier = randomUUID();
  const target = { workspaceId: first.workspace.id, universalIdentifier };
  await withCrmAuditRequest(captureCrmAuditRequest(first), () =>
    service.triggerInstallApplication(target),
  );
  const saved = JSON.stringify(queue.add.mock.calls[0][1]);
  const id = `install-application.${first.workspace.id}.${universalIdentifier}-${randomUUID()}`;
  queue.getInFlightJobs.mockResolvedValue([{ id }]);
  expect(
    await withCrmAuditRequest(captureCrmAuditRequest(second), () =>
      service.triggerInstallApplication(target),
    ),
  ).toEqual({ jobId: id });
  expect(queue.add).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(queue.add.mock.calls[0][1])).toBe(saved);
});

it('foreign serialized identity fails before a job reaches the application service', async () => {
  const workspaceId = randomUUID(),
    work = jest.fn();
  await expect(
    new TriggerInstallApplicationJob({
      installApplication: work,
    } as never).handle(
      {
        workspaceId,
        applicationRegistrationId: randomUUID(),
        auditIdentity: systemMembershipCleanupIdentity(randomUUID(), 'Foreign'),
      },
      {} as never,
    ),
  ).rejects.toThrow('workspace mismatch');
  expect(work).not.toHaveBeenCalled();
});

it('enqueue retains the first snapshot while registration lookup waits', async () => {
  const req = request(),
    workspaceId = req.workspace.id,
    userId = req.user.id,
    { service, queue, registration } = queueFixture(),
    reached = gate(),
    resume = gate();
  registration.findRegistrationByUniversalIdentifier.mockImplementationOnce(
    async () => {
      reached.release();
      await resume.promise;
      return { id: randomUUID() };
    },
  );
  const pending = withCrmAuditRequest(captureCrmAuditRequest(req), () =>
    service.triggerInstallApplication({
      workspaceId,
      universalIdentifier: randomUUID(),
    }),
  );
  await reached.promise;
  req.workspace.id = randomUUID();
  req.user.id = randomUUID();
  resume.release();
  await pending;
  expect(queue.add.mock.calls[0][1]).toMatchObject({
    workspaceId,
    auditIdentity: { workspaceId, actor: { id: userId } },
  });
});

it('running job copies serialized identity before yielding to its service', async () => {
  const workspaceId = randomUUID(),
    identity = systemMembershipCleanupIdentity(workspaceId, 'Original'),
    payload = {
      workspaceId,
      applicationRegistrationId: randomUUID(),
      auditIdentity: { ...identity, actor: { ...identity.actor } },
    },
    reached = gate(),
    resume = gate();
  const work = jest.fn(async () => {
    reached.release();
    await resume.promise;
    return current(workspaceId);
  });
  const pending = new TriggerInstallApplicationJob({
    installApplication: work,
  } as never).handle(payload, {} as never);
  await reached.promise;
  payload.auditIdentity.actor.id = 'Changed';
  resume.release();
  await pending;
  expect((await work.mock.results[0].value)?.actor).toEqual(identity.actor);
});
