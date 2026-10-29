import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  captureMembershipCleanupIdentity,
  copyMembershipCleanupIdentity,
  type MembershipCleanupAuthentication,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

type RequestFields = {
  workspace?: object;
  user?: object | null;
  apiKey?: object | null;
  application?: object | null;
  agentId?: unknown;
  impersonationContext?: object;
};
type RequestSnapshot = Readonly<{
  kind: 'request';
  authentication: Readonly<MembershipCleanupAuthentication>;
  agentId?: string;
  correlationId: string;
}>;
type ResolvedSnapshot = Readonly<{
  kind: 'resolved';
  workspaceId: string;
  identity: MembershipCleanupIdentity | undefined;
}>;
const storage = new AsyncLocalStorage<RequestSnapshot | ResolvedSnapshot>();
const stringField = (value: object | null | undefined, key: string) => {
  const field = value && (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
};
const identifier = (value: object | null | undefined) => {
  const id = stringField(value, 'id');
  return id === undefined ? undefined : Object.freeze({ id });
};

// Called only after request hydration; validation belongs to audit consumers,
// not to middleware for endpoints which do not mutate audited data.
export const captureCrmAuditRequest = (
  request: RequestFields,
): RequestSnapshot =>
  Object.freeze({
    kind: 'request',
    authentication: Object.freeze({
      workspaceId: stringField(request.workspace, 'id'),
      user: identifier(request.user),
      apiKey: identifier(request.apiKey),
      application: identifier(request.application),
      impersonatorUserWorkspaceId: stringField(
        request.impersonationContext,
        'impersonatorUserWorkspaceId',
      ),
    }),
    agentId: typeof request.agentId === 'string' ? request.agentId : undefined,
    correlationId: randomUUID(),
  });

export const withCrmAuditRequest = <T>(
  snapshot: RequestSnapshot,
  work: () => T,
): T => storage.run(snapshot, work);

export const withCrmAuditIdentity = <T>(
  workspaceId: string,
  identity: MembershipCleanupIdentity | undefined,
  work: () => T,
): T => {
  const captured = copyMembershipCleanupIdentity(identity, workspaceId);
  const scope = workspaceId.toLowerCase();
  if (captured && captured.workspaceId !== scope)
    throw new Error('CRM audit context requires scoped identity');
  // An old job without identity must mask, rather than inherit, its caller context.
  return storage.run(
    Object.freeze({ kind: 'resolved', workspaceId: scope, identity: captured }),
    work,
  );
};

export const captureCurrentCrmAuditIdentity = async (
  workspaceId: string,
  resolveImpersonator: (membershipId: string) => Promise<string | undefined>,
): Promise<MembershipCleanupIdentity | undefined> => {
  const snapshot = storage.getStore();
  if (!snapshot) return undefined;
  const scope = workspaceId.toLowerCase();
  const snapshotWorkspace =
    snapshot.kind === 'request'
      ? snapshot.authentication.workspaceId?.toLowerCase()
      : snapshot.workspaceId;
  if (snapshotWorkspace !== scope)
    throw new Error('CRM audit context workspace mismatch');
  if (snapshot.kind === 'resolved')
    return copyMembershipCleanupIdentity(snapshot.identity, scope);
  const identity = await captureMembershipCleanupIdentity(
    snapshot.authentication,
    resolveImpersonator,
  );
  if (snapshot.agentId && identity.actor.kind !== 'application')
    throw new Error('CRM audit agent requires an authenticated application');
  return copyMembershipCleanupIdentity(
    {
      ...identity,
      ...(snapshot.agentId
        ? {
            actor: { kind: 'agent', id: snapshot.agentId },
            initiator: identity.initiator ?? identity.actor,
          }
        : {}),
      correlationId: snapshot.correlationId,
    },
    scope,
  );
};
