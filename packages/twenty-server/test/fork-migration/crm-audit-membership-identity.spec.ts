import { randomUUID } from 'node:crypto';
import {
  captureMembershipCleanupIdentity,
  copyMembershipCleanupIdentity,
  membershipCleanupIdentityFromWorkspaceAuth,
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

const workspaceId = randomUUID(),
  userId = randomUUID(),
  applicationId = randomUUID();
const resolve = jest.fn<Promise<string | undefined>, [string]>();
beforeEach(() => resolve.mockReset());

it.each([
  [{ user: { id: userId } }, { kind: 'coreUser', id: userId }, undefined],
  [
    { application: { id: applicationId } },
    { kind: 'application', id: applicationId },
    undefined,
  ],
  [
    { application: { id: applicationId }, user: { id: userId } },
    { kind: 'application', id: applicationId },
    { kind: 'coreUser', id: userId },
  ],
  [
    { apiKey: { id: applicationId } },
    { kind: 'apiKey', id: applicationId },
    undefined,
  ],
])(
  'captures trusted authentication %j',
  async (authentication, actor, initiator) => {
    const result = await captureMembershipCleanupIdentity(
      { workspaceId, ...authentication },
      resolve,
    );
    expect(result).toMatchObject({ workspaceId, actor });
    expect(result.initiator).toEqual(initiator);
    expect(resolve).not.toHaveBeenCalled();
  },
);

it('captures all primitive IDs before impersonator lookup awaits', async () => {
  const impersonatorId = randomUUID(),
    initiatorId = randomUUID();
  const input = {
    workspaceId,
    user: { id: userId },
    impersonatorUserWorkspaceId: impersonatorId,
  };
  resolve.mockImplementation(async () => {
    input.user.id = randomUUID();
    input.workspaceId = randomUUID();
    input.impersonatorUserWorkspaceId = randomUUID();
    return initiatorId;
  });
  const identity = await captureMembershipCleanupIdentity(input, resolve);
  expect(identity).toMatchObject({
    workspaceId,
    actor: { kind: 'coreUser', id: userId },
    initiator: { kind: 'coreUser', id: initiatorId },
  });
  expect(resolve).toHaveBeenCalledWith(impersonatorId);
  expect(Object.isFrozen(identity)).toBe(true);
  expect(Object.isFrozen(identity.actor)).toBe(true);
  expect(Object.isFrozen(identity.initiator)).toBe(true);
});

it.each([
  {},
  { user: { id: userId }, apiKey: { id: applicationId } },
  { application: { id: applicationId }, apiKey: { id: applicationId } },
  {
    application: { id: applicationId },
    user: { id: userId },
    impersonatorUserWorkspaceId: randomUUID(),
  },
  { impersonatorUserWorkspaceId: randomUUID() },
  { user: { id: 'not-a-user-id' } },
])(
  'rejects missing, malformed or ambiguous authentication %j',
  async (authentication) => {
    await expect(
      captureMembershipCleanupIdentity(
        { workspaceId, ...authentication },
        resolve,
      ),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  },
);

it('does not fabricate an impersonation initiator when membership is gone', async () => {
  resolve.mockResolvedValue(undefined);
  await expect(
    captureMembershipCleanupIdentity(
      {
        workspaceId,
        user: { id: userId },
        impersonatorUserWorkspaceId: randomUUID(),
      },
      resolve,
    ),
  ).rejects.toThrow('initiator unavailable');
});
it('propagates a failed initiator lookup before any cleanup', async () => {
  resolve.mockRejectedValue(new Error('DB unavailable'));
  await expect(
    captureMembershipCleanupIdentity(
      {
        workspaceId,
        user: { id: userId },
        impersonatorUserWorkspaceId: randomUUID(),
      },
      resolve,
    ),
  ).rejects.toThrow('DB unavailable');
});
it('allows self-account deletion to fan out with common correlation and distinct operations', async () => {
  const identity = await captureMembershipCleanupIdentity(
    { user: { id: userId } },
    resolve,
  );
  const first = membershipCleanupOperation(workspaceId, identity)!;
  const second = membershipCleanupOperation(randomUUID(), identity)!;
  expect(first.correlationId).toBe(second.correlationId);
  expect(first.operationId).not.toBe(second.operationId);
  expect(first.actor).toEqual(second.actor);
});
it('never rebinds a scoped identity to another workspace', () => {
  const identity = systemMembershipCleanupIdentity(
    workspaceId,
    'CleanerWorkspaceService',
  );
  expect(() => membershipCleanupOperation(randomUUID(), identity)).toThrow(
    'workspace mismatch',
  );
});
it('leaves missing legacy identity unavailable for the owner to report', () => {
  expect(copyMembershipCleanupIdentity(undefined)).toBeUndefined();
  expect(membershipCleanupOperation(workspaceId, undefined)).toBeUndefined();
});
it('does not allow unscoped applications or malformed explicit identities', async () => {
  await expect(
    captureMembershipCleanupIdentity(
      { application: { id: applicationId } },
      resolve,
    ),
  ).rejects.toThrow('Unscoped');
  const identity = systemMembershipCleanupIdentity(
    workspaceId,
    'CleanerWorkspaceService',
  );
  expect(() =>
    copyMembershipCleanupIdentity({ ...identity, correlationId: 'bad' }),
  ).toThrow();
});
it('copies identity instead of retaining caller objects', () => {
  const actor = { kind: 'coreUser' as const, id: userId };
  const input = { actor, workspaceId, correlationId: randomUUID() };
  const operation = membershipCleanupOperation(workspaceId, input)!;
  actor.id = randomUUID();
  input.workspaceId = randomUUID();
  expect(operation.actor.id).toBe(userId);
  expect(operation.workspaceId).toBe(workspaceId);
});
it.each(['application', 'viaApplication'] as const)(
  'retains delegated %s as actor in post-hook context',
  (key) => {
    expect(
      membershipCleanupIdentityFromWorkspaceAuth({
        type: 'user',
        workspace: { id: workspaceId },
        user: { id: userId },
        [key]: { id: applicationId },
      }),
    ).toMatchObject({
      actor: { kind: 'application', id: applicationId },
      initiator: { kind: 'coreUser', id: userId },
    });
  },
);
it('attributes autonomous agent actions to agent with application initiator', () => {
  const agentId = randomUUID();
  expect(
    membershipCleanupIdentityFromWorkspaceAuth({
      type: 'application',
      workspace: { id: workspaceId },
      application: { id: applicationId },
      actingAgent: { id: agentId },
    }),
  ).toMatchObject({
    actor: { kind: 'agent', id: agentId },
    initiator: { kind: 'application', id: applicationId },
  });
});
it('rejects ambiguous delegated apps in post-hook context', () => {
  expect(() =>
    membershipCleanupIdentityFromWorkspaceAuth({
      type: 'user',
      workspace: { id: workspaceId },
      user: { id: userId },
      application: { id: applicationId },
      viaApplication: { id: randomUUID() },
    }),
  ).toThrow('Ambiguous');
});
it('rejects pending activation and records explicit system hook identity', () => {
  expect(() =>
    membershipCleanupIdentityFromWorkspaceAuth({
      type: 'pendingActivationUser',
      workspace: { id: workspaceId },
    }),
  ).toThrow('Pending');
  expect(
    membershipCleanupIdentityFromWorkspaceAuth({
      type: 'system',
      workspace: { id: workspaceId },
    }).actor,
  ).toEqual({ kind: 'system', id: 'WorkspaceMemberDeleteOnePostQueryHook' });
});
