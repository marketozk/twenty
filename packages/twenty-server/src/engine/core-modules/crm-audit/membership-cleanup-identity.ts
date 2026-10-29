import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';

import {
  type CrmAuditOperation,
  type CrmAuditPrincipal,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

export type MembershipCleanupIdentity = Readonly<{
  workspaceId?: string;
  actor: Readonly<CrmAuditPrincipal>;
  initiator?: Readonly<CrmAuditPrincipal>;
  correlationId: string;
}>;

export type MembershipCleanupAuthentication = {
  workspaceId?: string;
  user?: { id: string } | null;
  apiKey?: { id: string } | null;
  application?: { id: string } | null;
  impersonatorUserWorkspaceId?: string;
};

const uuid = (value: string): string => {
  if (!isUUID(value)) throw new Error('Membership audit identity is invalid');
  return value.toLowerCase();
};

const principal = (value: CrmAuditPrincipal): Readonly<CrmAuditPrincipal> => {
  if (
    !['coreUser', 'system', 'application', 'apiKey', 'agent'].includes(
      value?.kind,
    )
  )
    throw new Error('Membership audit principal is invalid');
  if (
    value.kind === 'system' &&
    !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,159}$/.test(value.id)
  )
    throw new Error('Membership audit system identity is invalid');
  return Object.freeze({
    kind: value.kind,
    id: value.kind === 'system' ? value.id : uuid(value.id),
  });
};

export const copyMembershipCleanupIdentity = (
  identity: MembershipCleanupIdentity | undefined,
  workspaceId?: string,
): MembershipCleanupIdentity | undefined => {
  // Older jobs can lack attribution; the cleanup owner reports this explicitly.
  if (identity === undefined) return undefined;
  const scope =
    identity.workspaceId === undefined ? undefined : uuid(identity.workspaceId);
  if (
    workspaceId !== undefined &&
    scope !== undefined &&
    scope !== uuid(workspaceId)
  )
    throw new Error('Membership audit workspace mismatch');
  const actor = principal(identity.actor);
  if (scope === undefined && actor.kind !== 'coreUser')
    throw new Error('Unscoped membership audit requires a core user');
  return Object.freeze({
    ...(scope ? { workspaceId: scope } : {}),
    actor,
    ...(identity.initiator ? { initiator: principal(identity.initiator) } : {}),
    correlationId: uuid(identity.correlationId),
  });
};

export const captureMembershipCleanupIdentity = async (
  authentication: MembershipCleanupAuthentication,
  resolveImpersonator: (membershipId: string) => Promise<string | undefined>,
): Promise<MembershipCleanupIdentity> => {
  const workspaceId = authentication.workspaceId;
  const userId = authentication.user?.id;
  const apiKeyId = authentication.apiKey?.id;
  const applicationId = authentication.application?.id;
  const impersonatorId = authentication.impersonatorUserWorkspaceId;
  if (
    (apiKeyId && (userId || applicationId)) ||
    (impersonatorId && (!userId || apiKeyId || applicationId))
  )
    throw new Error('Ambiguous membership audit authentication');
  if (!userId && !apiKeyId && !applicationId)
    throw new Error('Membership audit authentication is unavailable');
  const actor: CrmAuditPrincipal = applicationId
    ? { kind: 'application', id: applicationId }
    : apiKeyId
      ? { kind: 'apiKey', id: apiKeyId }
      : { kind: 'coreUser', id: userId! };
  const captured = copyMembershipCleanupIdentity({
    workspaceId,
    actor,
    ...(applicationId && userId
      ? { initiator: { kind: 'coreUser' as const, id: userId } }
      : {}),
    correlationId: randomUUID(),
  })!;
  if (!impersonatorId) return captured;
  const initiatorUserId = await resolveImpersonator(uuid(impersonatorId));
  if (!initiatorUserId)
    throw new Error('Membership audit impersonation initiator unavailable');
  return copyMembershipCleanupIdentity({
    ...captured,
    initiator: { kind: 'coreUser', id: initiatorUserId },
  })!;
};

export const systemMembershipCleanupIdentity = (
  workspaceId: string,
  source: string,
): MembershipCleanupIdentity =>
  copyMembershipCleanupIdentity({
    workspaceId,
    actor: { kind: 'system', id: source },
    correlationId: randomUUID(),
  })!;

export const membershipCleanupOperation = (
  workspaceId: string,
  identity: MembershipCleanupIdentity | undefined,
): CrmAuditOperation | undefined => {
  const captured = copyMembershipCleanupIdentity(identity, workspaceId);
  if (!captured) return undefined;
  return {
    workspaceId: uuid(workspaceId),
    operationId: randomUUID(),
    actor: captured.actor,
    initiator: captured.initiator,
    correlationId: captured.correlationId,
  };
};

type CleanupWorkspaceAuthentication = { workspace: { id: string } } & (
  | {
      type: 'user';
      user: { id: string };
      application?: { id: string };
      viaApplication?: { id: string };
    }
  | {
      type: 'application';
      application: { id: string };
      actingAgent?: { id: string };
    }
  | { type: 'apiKey'; apiKey: { id: string } }
  | { type: 'system' }
  | { type: 'pendingActivationUser' }
);

export const membershipCleanupIdentityFromWorkspaceAuth = (
  authentication: CleanupWorkspaceAuthentication,
): MembershipCleanupIdentity => {
  const workspaceId = authentication.workspace.id;
  if (authentication.type === 'system')
    return systemMembershipCleanupIdentity(
      workspaceId,
      'WorkspaceMemberDeleteOnePostQueryHook',
    );
  if (authentication.type === 'pendingActivationUser')
    throw new Error('Pending membership cannot initiate cleanup');
  let actor: CrmAuditPrincipal;
  let initiator: CrmAuditPrincipal | undefined;
  if (authentication.type === 'user') {
    const application =
      authentication.viaApplication ?? authentication.application;
    if (
      authentication.viaApplication &&
      authentication.application &&
      authentication.viaApplication.id !== authentication.application.id
    )
      throw new Error('Ambiguous membership audit application');
    actor = application
      ? { kind: 'application', id: application.id }
      : { kind: 'coreUser', id: authentication.user.id };
    if (application)
      initiator = { kind: 'coreUser', id: authentication.user.id };
  } else if (authentication.type === 'apiKey') {
    actor = { kind: 'apiKey', id: authentication.apiKey.id };
  } else {
    actor = authentication.actingAgent
      ? { kind: 'agent', id: authentication.actingAgent.id }
      : { kind: 'application', id: authentication.application.id };
    if (authentication.actingAgent)
      initiator = { kind: 'application', id: authentication.application.id };
  }
  return copyMembershipCleanupIdentity({
    workspaceId,
    actor,
    initiator,
    correlationId: randomUUID(),
  })!;
};
