import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { type CapturedApplicationMetadataAuditOperation } from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureCurrentCrmAuditOperation,
  peekCurrentCrmAuditWorkspaceId,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  registerMetadataAuditScopeCheck,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type WorkspaceDomainRequestAuditIdentity = {
  workspaceId?: string;
  workspace?: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  apiKey?: { id?: string } | null;
  application?: { id?: string } | null;
  agentId?: string;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  impersonatorUserWorkspaceId?: string;
  correlationId?: string;
  causationId?: string;
};

export type WorkspaceDomainAuditIdentity =
  | WorkspaceDomainAuditRequest
  | RoleUpdateAuditIdentity
  | CapturedApplicationMetadataAuditOperation
  | CrmAuditOperation
  | {
      workspaceId: string;
      operationId?: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      impersonatorUserWorkspaceId?: string;
      correlationId?: string;
      causationId?: string;
    }
  | WorkspaceDomainRequestAuditIdentity;

export type WorkspaceDomainAuditRequest = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  expectedUserId?: string;
  expectedUserWorkspaceId?: string;
  pendingUserWorkspaceActorId?: string;
}>;

export type PersistedApprovedAccessDomainRow = Readonly<{
  id: string;
  workspaceId: string;
  domain: string;
  isValidated: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PersistedPublicDomainRow = Readonly<{
  id: string;
  workspaceId: string;
  applicationId: string;
  domain: string;
  isValidated: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type EmailingDomainStatusValue =
  | 'PENDING'
  | 'VERIFIED'
  | 'FAILED'
  | 'TEMPORARY_FAILURE';

export type EmailingDomainTenantStatusValue =
  | 'ACTIVE'
  | 'UNDER_REVIEW'
  | 'PAUSED'
  | 'SANDBOX';

export type UnsubscribeHostnameStatusValue = 'PENDING' | 'ACTIVE';

export type PersistedEmailingDomainRow = Readonly<{
  id: string;
  workspaceId: string;
  domain: string;
  status: EmailingDomainStatusValue;
  verificationRecords: Array<Record<string, unknown>> | null;
  verifiedAt: Date | null;
  tenantStatus: EmailingDomainTenantStatusValue;
  unsubscribeHostname: string | null;
  unsubscribeHostnameId: string | null;
  unsubscribeHostnameStatus: UnsubscribeHostnameStatusValue | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type DpaAgreementTypeValue = 'CLICK_THROUGH' | 'SIGNED';

export type PersistedDpaAgreementRow = Readonly<{
  id: string;
  workspaceId: string;
  type: DpaAgreementTypeValue;
  templateVersion: string;
  region: string;
  processorEntity: string;
  customerLegalEntityName?: string;
  signatoryName?: string;
  signatoryTitle?: string;
  signedFileId?: string;
  acceptedByUserId?: string;
  acceptedByEmail?: string;
  acceptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

export type UnsubscribeTopicVisibilityValue = 'PUBLIC' | 'PRIVATE';

export type PersistedUnsubscribeTopicRow = Readonly<{
  id: string;
  workspaceId: string;
  name: string | null;
  description: string | null;
  visibility: UnsubscribeTopicVisibilityValue;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SsoIdentityProviderTypeValue = 'OIDC' | 'SAML';

export type SsoIdentityProviderStatusValue = 'Active' | 'Inactive' | 'Error';

export type PersistedSsoIdentityProviderRow = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  status: SsoIdentityProviderStatusValue;
  type: SsoIdentityProviderTypeValue;
  issuer: string;
  clientID?: string;
  clientSecret?: string;
  ssoURL?: string;
  certificate?: string;
  fingerprint?: string;
  createdAt: Date;
  updatedAt: Date;
}>;

type AmbientWorkspaceDomainAudit = Readonly<{
  workspaceId?: string;
  actor?: CrmAuditOperation['actor'];
  initiator?: CrmAuditOperation['initiator'];
  impersonatorUserWorkspaceId?: string;
  correlationId: string;
  causationId?: string;
}>;

const ambientStorage = new AsyncLocalStorage<AmbientWorkspaceDomainAudit>();
const exclusiveStorage = new AsyncLocalStorage<{ workspaceId: string }>();
const activeScopes = new WeakSet<object>();
const activeRequests = new WeakSet<WorkspaceDomainAuditRequest>();
const consumedRequests = new WeakSet<WorkspaceDomainAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Workspace domain audit identity is invalid');
  }

  return value.toLowerCase();
};

const optionalUuid = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !isUUID(value)) {
    return undefined;
  }

  return value.toLowerCase();
};

const normalizeDirectPrincipal = (
  principal: CrmAuditOperation['actor'],
): CrmAuditOperation['actor'] => {
  if (!principal || typeof principal !== 'object') {
    throw new Error('Workspace domain audit identity is invalid');
  }
  const requiresUuid =
    principal.kind === 'coreUser' ||
    principal.kind === 'workspaceMember' ||
    principal.kind === 'apiKey' ||
    principal.kind === 'application' ||
    principal.kind === 'agent' ||
    principal.kind === 'workflow';

  return Object.freeze({
    kind: principal.kind,
    id: requiresUuid ? uuid(principal.id) : String(principal.id),
  });
};

export const consumeWorkspaceDomainAuditRequest = (
  request: WorkspaceDomainAuditRequest | undefined,
): void => {
  if (request && typeof request === 'object') {
    consumedRequests.add(request);
  }
};

export const getWorkspaceDomainAudit = (workspaceId: string) => {
  const current = exclusiveStorage.getStore();
  if (!current) return undefined;
  if (!activeScopes.has(current) || current.workspaceId !== uuid(workspaceId)) {
    throw new Error('Workspace domain audit context mismatch');
  }

  return current;
};

registerMetadataAuditScopeCheck(getWorkspaceDomainAudit);

export const withWorkspaceDomainAudit = <TResult>(
  identity: {
    workspaceId?: string;
    actor?: CrmAuditOperation['actor'];
    initiator?: CrmAuditOperation['initiator'];
    impersonatorUserWorkspaceId?: string;
    correlationId?: string;
    causationId?: string;
  },
  work: () => Promise<TResult>,
): Promise<TResult> => {
  const parent = ambientStorage.getStore();
  const normalizedWorkspaceId =
    optionalUuid(identity.workspaceId) ?? parent?.workspaceId;
  const normalizedImpersonator =
    identity.impersonatorUserWorkspaceId !== undefined
      ? uuid(identity.impersonatorUserWorkspaceId)
      : parent?.impersonatorUserWorkspaceId;
  const rawActor = identity.actor ?? parent?.actor;
  const actor =
    rawActor !== undefined ? normalizeDirectPrincipal(rawActor) : undefined;
  const rawInitiator = identity.initiator ?? parent?.initiator;
  const initiator =
    rawInitiator !== undefined
      ? normalizeDirectPrincipal(rawInitiator)
      : undefined;

  const scope: AmbientWorkspaceDomainAudit = Object.freeze({
    ...(normalizedWorkspaceId !== undefined
      ? { workspaceId: normalizedWorkspaceId }
      : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(initiator !== undefined ? { initiator } : {}),
    ...(normalizedImpersonator !== undefined
      ? { impersonatorUserWorkspaceId: normalizedImpersonator }
      : {}),
    correlationId:
      identity.correlationId ?? parent?.correlationId ?? randomUUID(),
    ...(identity.causationId !== undefined
      ? { causationId: identity.causationId }
      : parent?.causationId !== undefined
        ? { causationId: parent.causationId }
        : {}),
  });

  return ambientStorage.run(scope, work);
};

export const extractWorkspaceIdFromDomainAuditIdentity = (
  workspaceId: string | undefined,
  identity: WorkspaceDomainAuditIdentity | undefined,
): string | undefined => {
  if (workspaceId !== undefined) {
    return uuid(workspaceId);
  }
  if (identity && typeof identity === 'object') {
    if (
      'workspaceId' in identity &&
      typeof identity.workspaceId === 'string' &&
      isUUID(identity.workspaceId)
    ) {
      return uuid(identity.workspaceId);
    }
    if (
      'workspace' in identity &&
      identity.workspace &&
      typeof identity.workspace === 'object' &&
      'id' in identity.workspace &&
      typeof identity.workspace.id === 'string' &&
      isUUID(identity.workspace.id)
    ) {
      return uuid(identity.workspace.id);
    }
    if (
      'auth' in identity &&
      identity.auth &&
      typeof identity.auth === 'object' &&
      'workspace' in identity.auth &&
      identity.auth.workspace &&
      typeof identity.auth.workspace === 'object' &&
      'id' in identity.auth.workspace &&
      typeof identity.auth.workspace.id === 'string' &&
      isUUID(identity.auth.workspace.id)
    ) {
      return uuid(identity.auth.workspace.id);
    }
  }
  const ambientScope = ambientStorage.getStore();
  if (ambientScope?.workspaceId !== undefined) {
    return ambientScope.workspaceId;
  }
  const ambientWorkspaceId = peekCurrentCrmAuditWorkspaceId();
  if (ambientWorkspaceId !== undefined && isUUID(ambientWorkspaceId)) {
    return uuid(ambientWorkspaceId);
  }

  return undefined;
};

const isRequestLikeIdentity = (
  identity: WorkspaceDomainAuditIdentity,
): identity is WorkspaceDomainRequestAuditIdentity =>
  Boolean(
    identity &&
      typeof identity === 'object' &&
      !('actor' in identity) &&
      !('auth' in identity) &&
      !('operation' in identity),
  );

const resolveFromRequestLikeIdentity = (
  normalizedWorkspaceId: string,
  identity: WorkspaceDomainRequestAuditIdentity,
  ambientCorrelationId?: string,
):
  | {
      operation: CrmAuditOperation;
      impersonatorUserWorkspaceId?: string;
      expectedUserId?: string;
      expectedUserWorkspaceId?: string;
      pendingUserWorkspaceActorId?: string;
    }
  | undefined => {
  if (
    identity.workspace?.id !== undefined &&
    uuid(identity.workspace.id) !== normalizedWorkspaceId
  ) {
    throw new Error('CRM audit context workspace mismatch');
  }
  if (
    identity.workspaceId !== undefined &&
    uuid(identity.workspaceId) !== normalizedWorkspaceId
  ) {
    throw new Error('CRM audit context workspace mismatch');
  }

  const userId =
    identity.user && typeof identity.user === 'object'
      ? identity.user.id
      : undefined;
  const userWorkspaceId = identity.userWorkspaceId;
  const workspaceMemberId = identity.workspaceMemberId;
  const apiKeyId =
    identity.apiKey && typeof identity.apiKey === 'object'
      ? identity.apiKey.id
      : undefined;
  const applicationId =
    identity.application && typeof identity.application === 'object'
      ? identity.application.id
      : undefined;
  const agentId = identity.agentId;
  const impersonatorRaw =
    identity.impersonatorUserWorkspaceId ??
    identity.impersonationContext?.impersonatorUserWorkspaceId;

  const hasAnyPrincipal =
    userId !== undefined ||
    userWorkspaceId !== undefined ||
    workspaceMemberId !== undefined ||
    apiKeyId !== undefined ||
    applicationId !== undefined ||
    agentId !== undefined ||
    impersonatorRaw !== undefined;

  if (!hasAnyPrincipal) {
    return undefined;
  }

  if (
    apiKeyId !== undefined &&
    (userId !== undefined ||
      userWorkspaceId !== undefined ||
      workspaceMemberId !== undefined ||
      applicationId !== undefined ||
      agentId !== undefined)
  ) {
    throw new Error('Ambiguous workspace domain audit authentication');
  }

  if (
    impersonatorRaw !== undefined &&
    (apiKeyId !== undefined ||
      applicationId !== undefined ||
      agentId !== undefined ||
      (userId === undefined &&
        userWorkspaceId === undefined &&
        workspaceMemberId === undefined))
  ) {
    throw new Error('Ambiguous workspace domain audit authentication');
  }

  if (agentId !== undefined && applicationId === undefined) {
    throw new Error('CRM audit agent requires an authenticated application');
  }

  const correlationId =
    identity.correlationId ?? ambientCorrelationId ?? randomUUID();
  const causationId = identity.causationId;
  const impersonatorUserWorkspaceId =
    impersonatorRaw !== undefined ? uuid(impersonatorRaw) : undefined;
  const expectedUserId = userId !== undefined ? uuid(userId) : undefined;
  const expectedUserWorkspaceId =
    userWorkspaceId !== undefined ? uuid(userWorkspaceId) : undefined;

  if (applicationId !== undefined) {
    const normalizedAppId = uuid(applicationId);
    const baseActor = Object.freeze({
      kind: 'application' as const,
      id: normalizedAppId,
    });
    const baseInitiator =
      expectedUserId !== undefined
        ? Object.freeze({ kind: 'coreUser' as const, id: expectedUserId })
        : undefined;
    const actor =
      agentId !== undefined
        ? Object.freeze({ kind: 'agent' as const, id: uuid(agentId) })
        : baseActor;
    const initiator =
      agentId !== undefined ? (baseInitiator ?? baseActor) : baseInitiator;

    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor,
          ...(initiator ? { initiator } : {}),
          correlationId,
          ...(causationId !== undefined ? { causationId } : {}),
        }),
      ),
      ...(expectedUserId ? { expectedUserId } : {}),
      ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
    };
  }

  if (apiKeyId !== undefined) {
    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: Object.freeze({
            kind: 'apiKey' as const,
            id: uuid(apiKeyId),
          }),
          correlationId,
          ...(causationId !== undefined ? { causationId } : {}),
        }),
      ),
    };
  }

  if (expectedUserId !== undefined) {
    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: Object.freeze({
            kind: 'coreUser' as const,
            id: expectedUserId,
          }),
          correlationId,
          ...(causationId !== undefined ? { causationId } : {}),
        }),
      ),
      expectedUserId,
      ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    };
  }

  if (workspaceMemberId !== undefined) {
    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: Object.freeze({
            kind: 'workspaceMember' as const,
            id: uuid(workspaceMemberId),
          }),
          correlationId,
          ...(causationId !== undefined ? { causationId } : {}),
        }),
      ),
      ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    };
  }

  if (expectedUserWorkspaceId !== undefined) {
    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: Object.freeze({
            kind: 'coreUser' as const,
            id: expectedUserWorkspaceId,
          }),
          correlationId,
          ...(causationId !== undefined ? { causationId } : {}),
        }),
      ),
      expectedUserWorkspaceId,
      pendingUserWorkspaceActorId: expectedUserWorkspaceId,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    };
  }

  throw new Error(
    'Workspace domain mutation requires authenticated audit identity',
  );
};

const extractExpectedUserBindingFromRoleIdentity = (
  identity: WorkspaceDomainAuditIdentity | undefined,
): { expectedUserId?: string; expectedUserWorkspaceId?: string } => {
  if (!identity || typeof identity !== 'object') {
    return {};
  }
  if (
    'auth' in identity &&
    identity.auth &&
    typeof identity.auth === 'object'
  ) {
    const authRecord = identity.auth as Record<string, unknown>;
    const userObj = authRecord.user as Record<string, unknown> | undefined;
    const expectedUserId =
      userObj && typeof userObj.id === 'string' && isUUID(userObj.id)
        ? uuid(userObj.id)
        : undefined;
    const expectedUserWorkspaceId =
      typeof authRecord.userWorkspaceId === 'string' &&
      isUUID(authRecord.userWorkspaceId)
        ? uuid(authRecord.userWorkspaceId)
        : undefined;

    return {
      ...(expectedUserId ? { expectedUserId } : {}),
      ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
    };
  }

  return {};
};

const resolveOperationFromIdentity = (
  normalizedWorkspaceId: string,
  identity: WorkspaceDomainAuditIdentity | undefined,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  expectedUserId?: string;
  expectedUserWorkspaceId?: string;
  pendingUserWorkspaceActorId?: string;
} => {
  const ambientScope = ambientStorage.getStore();
  const errorMessage =
    'Workspace domain mutation requires authenticated audit identity';

  if (identity !== undefined) {
    if (
      identity &&
      typeof identity === 'object' &&
      'operation' in identity &&
      'mode' in identity
    ) {
      const capturedOp = identity as CapturedApplicationMetadataAuditOperation;
      if (uuid(capturedOp.workspaceId) !== normalizedWorkspaceId) {
        throw new Error('CRM audit context workspace mismatch');
      }

      return {
        operation: Object.freeze({
          ...capturedOp.operation,
          operationId: randomUUID(),
        }),
        ...(capturedOp.impersonatorUserWorkspaceId
          ? {
              impersonatorUserWorkspaceId: uuid(
                capturedOp.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
      };
    }

    if (isRequestLikeIdentity(identity)) {
      const resolvedRequestLike = resolveFromRequestLikeIdentity(
        normalizedWorkspaceId,
        identity,
        ambientScope?.correlationId,
      );
      if (resolvedRequestLike) {
        return resolvedRequestLike;
      }
    } else if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      const directIdentity = identity as {
        workspaceId?: string;
        operationId?: string;
        actor: CrmAuditOperation['actor'];
        initiator?: CrmAuditOperation['initiator'];
        impersonatorUserWorkspaceId?: string;
        correlationId?: string;
        causationId?: string;
      };
      if (directIdentity.workspaceId === undefined) {
        throw new Error('CRM audit context requires scoped identity');
      }
      if (uuid(directIdentity.workspaceId) !== normalizedWorkspaceId) {
        throw new Error('CRM audit context workspace mismatch');
      }
      const actor = normalizeDirectPrincipal(directIdentity.actor);
      const initiator =
        directIdentity.initiator !== undefined
          ? normalizeDirectPrincipal(directIdentity.initiator)
          : undefined;
      const impersonatorUserWorkspaceId =
        directIdentity.impersonatorUserWorkspaceId !== undefined
          ? uuid(directIdentity.impersonatorUserWorkspaceId)
          : undefined;
      const operation = Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId:
            directIdentity.operationId !== undefined
              ? uuid(directIdentity.operationId)
              : randomUUID(),
          actor,
          ...(initiator ? { initiator } : {}),
          correlationId:
            directIdentity.correlationId ??
            ambientScope?.correlationId ??
            randomUUID(),
          ...(directIdentity.causationId !== undefined
            ? { causationId: directIdentity.causationId }
            : ambientScope?.causationId !== undefined
              ? { causationId: ambientScope.causationId }
              : {}),
        }),
      );

      return {
        operation,
        ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      };
    } else {
      const capturedIdentity = captureRoleAuditIdentity(
        identity as RoleUpdateAuditIdentity,
      );
      const operation = captureRoleAuditOperation(
        normalizedWorkspaceId,
        capturedIdentity,
      );
      const { expectedUserId, expectedUserWorkspaceId } =
        extractExpectedUserBindingFromRoleIdentity(identity);

      return {
        operation,
        ...(capturedIdentity.impersonatorUserWorkspaceId
          ? {
              impersonatorUserWorkspaceId: uuid(
                capturedIdentity.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
        ...(expectedUserId ? { expectedUserId } : {}),
        ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
      };
    }
  }

  if (ambientScope?.actor !== undefined) {
    if (
      ambientScope.workspaceId !== undefined &&
      ambientScope.workspaceId !== normalizedWorkspaceId
    ) {
      throw new Error('CRM audit context workspace mismatch');
    }

    return {
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: ambientScope.actor,
          ...(ambientScope.initiator
            ? { initiator: ambientScope.initiator }
            : {}),
          correlationId: ambientScope.correlationId,
          ...(ambientScope.causationId !== undefined
            ? { causationId: ambientScope.causationId }
            : {}),
        }),
      ),
      ...(ambientScope.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId:
              ambientScope.impersonatorUserWorkspaceId,
          }
        : {}),
    };
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  if (!ambient) {
    throw new Error(errorMessage);
  }

  return {
    operation: ambient.operation,
    ...(ambient.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            ambient.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
  };
};

export const captureWorkspaceDomainAudit = ({
  workspaceId,
  auditIdentity,
  defaultSystemActorId,
}: {
  workspaceId?: string;
  auditIdentity?: WorkspaceDomainAuditIdentity;
  defaultSystemActorId?: string;
}): WorkspaceDomainAuditRequest => {
  if (auditIdentity && typeof auditIdentity === 'object') {
    if (consumedRequests.has(auditIdentity as WorkspaceDomainAuditRequest)) {
      throw new Error('Workspace domain audit request cannot be reused');
    }
    if (activeRequests.has(auditIdentity as WorkspaceDomainAuditRequest)) {
      const existing = auditIdentity as WorkspaceDomainAuditRequest;
      if (
        workspaceId !== undefined &&
        uuid(workspaceId) !== existing.workspaceId
      ) {
        consumedRequests.add(existing);
        throw new Error('CRM audit context workspace mismatch');
      }

      return existing;
    }
  }

  const resolvedWorkspaceId = extractWorkspaceIdFromDomainAuditIdentity(
    workspaceId,
    auditIdentity,
  );
  if (!resolvedWorkspaceId) {
    throw new Error(
      'Workspace domain mutation requires authenticated audit identity',
    );
  }

  if (
    getWorkspaceDomainAudit(resolvedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      resolvedWorkspaceId,
      getWorkspaceDomainAudit,
    )
  ) {
    throw new Error('Nested workspace domain audit is unsupported');
  }

  const effectiveIdentity: WorkspaceDomainAuditIdentity | undefined =
    auditIdentity !== undefined
      ? auditIdentity
      : defaultSystemActorId !== undefined &&
          ambientStorage.getStore()?.actor === undefined &&
          captureCurrentCrmAuditOperation(resolvedWorkspaceId) === undefined
        ? {
            workspaceId: resolvedWorkspaceId,
            actor: { kind: 'system', id: defaultSystemActorId },
          }
        : undefined;

  const {
    operation,
    impersonatorUserWorkspaceId,
    expectedUserId,
    expectedUserWorkspaceId,
    pendingUserWorkspaceActorId,
  } = resolveOperationFromIdentity(resolvedWorkspaceId, effectiveIdentity);

  const request: WorkspaceDomainAuditRequest = Object.freeze({
    workspaceId: resolvedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    ...(expectedUserId ? { expectedUserId } : {}),
    ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
    ...(pendingUserWorkspaceActorId ? { pendingUserWorkspaceActorId } : {}),
  });
  activeRequests.add(request);

  return request;
};

const withExclusiveAuditScope = async <TResult>(
  request: WorkspaceDomainAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    !activeRequests.has(request) ||
    consumedRequests.has(request)
  ) {
    throw new Error('Workspace domain audit request cannot be reused');
  }
  if (
    getWorkspaceDomainAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getWorkspaceDomainAudit,
    )
  ) {
    consumedRequests.add(request);
    throw new Error('Nested workspace domain audit is unsupported');
  }

  consumedRequests.add(request);
  const scopeToken = Object.freeze({ workspaceId: request.workspaceId });
  activeScopes.add(scopeToken);
  try {
    return await exclusiveStorage.run(scopeToken, work);
  } finally {
    activeScopes.delete(scopeToken);
  }
};

const scalarWithoutTimestamps = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'createdAt' && key !== 'updatedAt',
    ),
  );

export const projectApprovedAccessDomain = (row: Record<string, unknown>) => {
  if (typeof row.domain !== 'string' || row.domain.trim().length === 0) {
    throw new Error('Approved access domain audit row domain is invalid');
  }
  if (typeof row.isValidated !== 'boolean') {
    throw new Error('Approved access domain audit row isValidated is invalid');
  }

  return {
    domain: row.domain,
    isValidated: row.isValidated,
  };
};

export const projectPublicDomain = (row: Record<string, unknown>) => {
  if (typeof row.domain !== 'string' || row.domain.trim().length === 0) {
    throw new Error('Public domain audit row domain is invalid');
  }
  if (typeof row.isValidated !== 'boolean') {
    throw new Error('Public domain audit row isValidated is invalid');
  }

  return {
    applicationId: uuid(row.applicationId),
    domain: row.domain,
    isValidated: row.isValidated,
  };
};

const hydrateApprovedAccessDomainRow = (
  row: Record<string, unknown>,
): PersistedApprovedAccessDomainRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    domain: String(row.domain),
    isValidated: Boolean(row.isValidated),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const hydratePublicDomainRow = (
  row: Record<string, unknown>,
): PersistedPublicDomainRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    applicationId: uuid(row.applicationId),
    domain: String(row.domain),
    isValidated: Boolean(row.isValidated),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const EMAILING_DOMAIN_STATUS_VALUES = new Set<EmailingDomainStatusValue>([
  'PENDING',
  'VERIFIED',
  'FAILED',
  'TEMPORARY_FAILURE',
]);

const EMAILING_DOMAIN_TENANT_STATUS_VALUES =
  new Set<EmailingDomainTenantStatusValue>([
    'ACTIVE',
    'UNDER_REVIEW',
    'PAUSED',
    'SANDBOX',
  ]);

const UNSUBSCRIBE_HOSTNAME_STATUS_VALUES =
  new Set<UnsubscribeHostnameStatusValue>(['PENDING', 'ACTIVE']);

const DPA_AGREEMENT_TYPE_VALUES = new Set<DpaAgreementTypeValue>([
  'CLICK_THROUGH',
  'SIGNED',
]);

const UNSUBSCRIBE_TOPIC_VISIBILITY_VALUES =
  new Set<UnsubscribeTopicVisibilityValue>(['PUBLIC', 'PRIVATE']);

const SSO_IDENTITY_PROVIDER_TYPE_VALUES = new Set<SsoIdentityProviderTypeValue>(
  ['OIDC', 'SAML'],
);

const SSO_IDENTITY_PROVIDER_STATUS_VALUES =
  new Set<SsoIdentityProviderStatusValue>(['Active', 'Inactive', 'Error']);

export const projectEmailingDomain = (row: Record<string, unknown>) => {
  if (typeof row.domain !== 'string' || row.domain.trim().length === 0) {
    throw new Error('Emailing domain audit row domain is invalid');
  }
  if (
    typeof row.status !== 'string' ||
    !EMAILING_DOMAIN_STATUS_VALUES.has(row.status as EmailingDomainStatusValue)
  ) {
    throw new Error('Emailing domain audit row status is invalid');
  }
  if (
    typeof row.tenantStatus !== 'string' ||
    !EMAILING_DOMAIN_TENANT_STATUS_VALUES.has(
      row.tenantStatus as EmailingDomainTenantStatusValue,
    )
  ) {
    throw new Error('Emailing domain audit row tenantStatus is invalid');
  }
  if (
    row.unsubscribeHostnameStatus !== null &&
    row.unsubscribeHostnameStatus !== undefined &&
    (typeof row.unsubscribeHostnameStatus !== 'string' ||
      !UNSUBSCRIBE_HOSTNAME_STATUS_VALUES.has(
        row.unsubscribeHostnameStatus as UnsubscribeHostnameStatusValue,
      ))
  ) {
    throw new Error(
      'Emailing domain audit row unsubscribeHostnameStatus is invalid',
    );
  }
  if (
    row.verificationRecords !== null &&
    row.verificationRecords !== undefined &&
    !Array.isArray(row.verificationRecords)
  ) {
    throw new Error('Emailing domain audit row verificationRecords is invalid');
  }
  if (
    row.unsubscribeHostname !== null &&
    row.unsubscribeHostname !== undefined &&
    typeof row.unsubscribeHostname !== 'string'
  ) {
    throw new Error('Emailing domain audit row unsubscribeHostname is invalid');
  }
  if (
    row.unsubscribeHostnameId !== null &&
    row.unsubscribeHostnameId !== undefined &&
    typeof row.unsubscribeHostnameId !== 'string'
  ) {
    throw new Error(
      'Emailing domain audit row unsubscribeHostnameId is invalid',
    );
  }

  return {
    status: row.status as EmailingDomainStatusValue,
    tenantStatus: row.tenantStatus as EmailingDomainTenantStatusValue,
    unsubscribeHostnameStatus:
      row.unsubscribeHostnameStatus === undefined ||
      row.unsubscribeHostnameStatus === null
        ? null
        : (row.unsubscribeHostnameStatus as UnsubscribeHostnameStatusValue),
    domain: row.domain,
    verificationRecords:
      row.verificationRecords === undefined || row.verificationRecords === null
        ? null
        : row.verificationRecords,
    verifiedAt:
      row.verifiedAt === undefined || row.verifiedAt === null
        ? null
        : row.verifiedAt instanceof Date
          ? row.verifiedAt.toISOString()
          : String(row.verifiedAt),
    unsubscribeHostname:
      row.unsubscribeHostname === undefined || row.unsubscribeHostname === null
        ? null
        : String(row.unsubscribeHostname),
    unsubscribeHostnameId:
      row.unsubscribeHostnameId === undefined ||
      row.unsubscribeHostnameId === null
        ? null
        : String(row.unsubscribeHostnameId),
  };
};

export const projectDpaAgreement = (row: Record<string, unknown>) => {
  if (
    typeof row.type !== 'string' ||
    !DPA_AGREEMENT_TYPE_VALUES.has(row.type as DpaAgreementTypeValue)
  ) {
    throw new Error('DPA agreement audit row type is invalid');
  }
  if (
    typeof row.templateVersion !== 'string' ||
    row.templateVersion.trim().length === 0
  ) {
    throw new Error('DPA agreement audit row templateVersion is invalid');
  }
  if (typeof row.region !== 'string' || row.region.trim().length === 0) {
    throw new Error('DPA agreement audit row region is invalid');
  }
  if (
    typeof row.processorEntity !== 'string' ||
    row.processorEntity.trim().length === 0
  ) {
    throw new Error('DPA agreement audit row processorEntity is invalid');
  }
  if (
    row.signedFileId !== null &&
    row.signedFileId !== undefined &&
    (typeof row.signedFileId !== 'string' || !isUUID(row.signedFileId))
  ) {
    throw new Error('DPA agreement audit row signedFileId is invalid');
  }
  if (
    row.acceptedByUserId !== null &&
    row.acceptedByUserId !== undefined &&
    (typeof row.acceptedByUserId !== 'string' || !isUUID(row.acceptedByUserId))
  ) {
    throw new Error('DPA agreement audit row acceptedByUserId is invalid');
  }
  if (row.acceptedAt === null || row.acceptedAt === undefined) {
    throw new Error('DPA agreement audit row acceptedAt is invalid');
  }

  return {
    type: row.type as DpaAgreementTypeValue,
    templateVersion: String(row.templateVersion),
    region: String(row.region),
    signedFileId:
      row.signedFileId === undefined || row.signedFileId === null
        ? null
        : uuid(row.signedFileId),
    acceptedByUserId:
      row.acceptedByUserId === undefined || row.acceptedByUserId === null
        ? null
        : uuid(row.acceptedByUserId),
    processorEntity: String(row.processorEntity),
    customerLegalEntityName:
      row.customerLegalEntityName === undefined ||
      row.customerLegalEntityName === null
        ? null
        : String(row.customerLegalEntityName),
    signatoryName:
      row.signatoryName === undefined || row.signatoryName === null
        ? null
        : String(row.signatoryName),
    signatoryTitle:
      row.signatoryTitle === undefined || row.signatoryTitle === null
        ? null
        : String(row.signatoryTitle),
    acceptedByEmail:
      row.acceptedByEmail === undefined || row.acceptedByEmail === null
        ? null
        : String(row.acceptedByEmail),
    acceptedAt:
      row.acceptedAt instanceof Date
        ? row.acceptedAt.toISOString()
        : String(row.acceptedAt),
  };
};

export const projectUnsubscribeTopic = (row: Record<string, unknown>) => {
  if (
    typeof row.visibility !== 'string' ||
    !UNSUBSCRIBE_TOPIC_VISIBILITY_VALUES.has(
      row.visibility as UnsubscribeTopicVisibilityValue,
    )
  ) {
    throw new Error('Unsubscribe topic audit row visibility is invalid');
  }
  if (
    row.name !== undefined &&
    row.name !== null &&
    typeof row.name !== 'string'
  ) {
    throw new Error('Unsubscribe topic audit row name is invalid');
  }
  if (
    row.description !== undefined &&
    row.description !== null &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Unsubscribe topic audit row description is invalid');
  }

  return {
    visibility: row.visibility as UnsubscribeTopicVisibilityValue,
    name: row.name === undefined || row.name === null ? null : row.name,
    description:
      row.description === undefined || row.description === null
        ? null
        : row.description,
  };
};

export const projectSsoIdentityProvider = (row: Record<string, unknown>) => {
  if (
    typeof row.type !== 'string' ||
    !SSO_IDENTITY_PROVIDER_TYPE_VALUES.has(
      row.type as SsoIdentityProviderTypeValue,
    )
  ) {
    throw new Error('SSO identity provider audit row type is invalid');
  }
  if (
    typeof row.status !== 'string' ||
    !SSO_IDENTITY_PROVIDER_STATUS_VALUES.has(
      row.status as SsoIdentityProviderStatusValue,
    )
  ) {
    throw new Error('SSO identity provider audit row status is invalid');
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('SSO identity provider audit row name is invalid');
  }
  if (typeof row.issuer !== 'string' || row.issuer.trim().length === 0) {
    throw new Error('SSO identity provider audit row issuer is invalid');
  }

  return {
    type: row.type as SsoIdentityProviderTypeValue,
    status: row.status as SsoIdentityProviderStatusValue,
    name: row.name,
    issuer: row.issuer,
    clientID:
      row.clientID === undefined || row.clientID === null
        ? null
        : String(row.clientID),
    clientSecret:
      row.clientSecret === undefined || row.clientSecret === null
        ? null
        : String(row.clientSecret),
    ssoURL:
      row.ssoURL === undefined || row.ssoURL === null
        ? null
        : String(row.ssoURL),
    certificate:
      row.certificate === undefined || row.certificate === null
        ? null
        : String(row.certificate),
    fingerprint:
      row.fingerprint === undefined || row.fingerprint === null
        ? null
        : String(row.fingerprint),
  };
};

export const projectApplicationTranslation = (row: Record<string, unknown>) => {
  if (typeof row.locale !== 'string' || row.locale.trim().length === 0) {
    throw new Error('Application translation audit row locale is invalid');
  }
  const messages =
    row.messages !== null &&
    typeof row.messages === 'object' &&
    !Array.isArray(row.messages)
      ? (row.messages as Record<string, string>)
      : {};

  return {
    applicationRegistrationId:
      row.applicationRegistrationId === undefined ||
      row.applicationRegistrationId === null
        ? null
        : uuid(row.applicationRegistrationId),
    locale: row.locale,
    messages,
    deletedAt:
      row.deletedAt === undefined || row.deletedAt === null
        ? null
        : String(row.deletedAt),
  };
};

const hydrateUnsubscribeTopicRow = (
  row: Record<string, unknown>,
): PersistedUnsubscribeTopicRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    name: row.name === undefined || row.name === null ? null : String(row.name),
    description:
      row.description === undefined || row.description === null
        ? null
        : String(row.description),
    visibility: row.visibility as UnsubscribeTopicVisibilityValue,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const hydrateSsoIdentityProviderRow = (
  row: Record<string, unknown>,
): PersistedSsoIdentityProviderRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    name: String(row.name),
    status: row.status as SsoIdentityProviderStatusValue,
    type: row.type as SsoIdentityProviderTypeValue,
    issuer: String(row.issuer),
    ...(row.clientID !== undefined && row.clientID !== null
      ? { clientID: String(row.clientID) }
      : {}),
    ...(row.clientSecret !== undefined && row.clientSecret !== null
      ? { clientSecret: String(row.clientSecret) }
      : {}),
    ...(row.ssoURL !== undefined && row.ssoURL !== null
      ? { ssoURL: String(row.ssoURL) }
      : {}),
    ...(row.certificate !== undefined && row.certificate !== null
      ? { certificate: String(row.certificate) }
      : {}),
    ...(row.fingerprint !== undefined && row.fingerprint !== null
      ? { fingerprint: String(row.fingerprint) }
      : {}),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const hydrateEmailingDomainRow = (
  row: Record<string, unknown>,
): PersistedEmailingDomainRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    domain: String(row.domain),
    status: row.status as EmailingDomainStatusValue,
    verificationRecords:
      row.verificationRecords === undefined || row.verificationRecords === null
        ? null
        : (row.verificationRecords as Array<Record<string, unknown>>),
    verifiedAt:
      row.verifiedAt === undefined || row.verifiedAt === null
        ? null
        : row.verifiedAt instanceof Date
          ? row.verifiedAt
          : new Date(String(row.verifiedAt)),
    tenantStatus: row.tenantStatus as EmailingDomainTenantStatusValue,
    unsubscribeHostname:
      row.unsubscribeHostname === undefined || row.unsubscribeHostname === null
        ? null
        : String(row.unsubscribeHostname),
    unsubscribeHostnameId:
      row.unsubscribeHostnameId === undefined ||
      row.unsubscribeHostnameId === null
        ? null
        : String(row.unsubscribeHostnameId),
    unsubscribeHostnameStatus:
      row.unsubscribeHostnameStatus === undefined ||
      row.unsubscribeHostnameStatus === null
        ? null
        : (row.unsubscribeHostnameStatus as UnsubscribeHostnameStatusValue),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const hydrateDpaAgreementRow = (
  row: Record<string, unknown>,
): PersistedDpaAgreementRow =>
  Object.freeze({
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    type: row.type as DpaAgreementTypeValue,
    templateVersion: String(row.templateVersion),
    region: String(row.region),
    processorEntity: String(row.processorEntity),
    ...(row.customerLegalEntityName !== undefined &&
    row.customerLegalEntityName !== null
      ? { customerLegalEntityName: String(row.customerLegalEntityName) }
      : {}),
    ...(row.signatoryName !== undefined && row.signatoryName !== null
      ? { signatoryName: String(row.signatoryName) }
      : {}),
    ...(row.signatoryTitle !== undefined && row.signatoryTitle !== null
      ? { signatoryTitle: String(row.signatoryTitle) }
      : {}),
    ...(row.signedFileId !== undefined && row.signedFileId !== null
      ? { signedFileId: uuid(row.signedFileId) }
      : {}),
    ...(row.acceptedByUserId !== undefined && row.acceptedByUserId !== null
      ? { acceptedByUserId: uuid(row.acceptedByUserId) }
      : {}),
    ...(row.acceptedByEmail !== undefined && row.acceptedByEmail !== null
      ? { acceptedByEmail: String(row.acceptedByEmail) }
      : {}),
    acceptedAt:
      row.acceptedAt instanceof Date
        ? row.acceptedAt
        : new Date(String(row.acceptedAt)),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(String(row.updatedAt)),
  });

const resolveWorkspaceDomainOperation = async (
  runner: QueryRunner,
  request: WorkspaceDomainAuditRequest,
): Promise<CrmAuditOperation> => {
  let operation = request.operation;

  const [tableFlags] = await runner.query(
    `SELECT
       to_regclass('core."userWorkspace"') IS NOT NULL AS "hasUserWorkspace",
       to_regclass('core."user"') IS NOT NULL AS "hasUser",
       to_regclass('core."apiKey"') IS NOT NULL AS "hasApiKey",
       to_regclass('core.application') IS NOT NULL AS "hasApplication"`,
  );

  const actorUwId =
    request.pendingUserWorkspaceActorId ?? request.expectedUserWorkspaceId;
  const impersonatorUwId = request.impersonatorUserWorkspaceId;

  if (
    request.pendingUserWorkspaceActorId !== undefined &&
    tableFlags?.hasUserWorkspace !== true
  ) {
    throw new Error('Workspace domain audit userWorkspace actor unavailable');
  }
  if (impersonatorUwId !== undefined && tableFlags?.hasUserWorkspace !== true) {
    throw new Error('Role audit impersonation initiator unavailable');
  }

  if (
    tableFlags?.hasUserWorkspace === true &&
    (actorUwId !== undefined || impersonatorUwId !== undefined)
  ) {
    const uwIdsToLock = [
      ...new Set(
        [actorUwId, impersonatorUwId].filter(
          (id): id is string => id !== undefined,
        ),
      ),
    ].sort();
    const uwRows: Array<{
      id: string;
      userId: string;
      workspaceId: string | null;
      deletedAt: string | null;
    }> = await runner.query(
      `SELECT id,"userId",to_jsonb(uw)->>'workspaceId' AS "workspaceId",to_jsonb(uw)->>'deletedAt' AS "deletedAt"
         FROM core."userWorkspace" uw
        WHERE uw.id = ANY($1::uuid[])
        ORDER BY uw.id ASC
        FOR KEY SHARE`,
      [uwIdsToLock],
    );
    const uwById = new Map(uwRows.map((row) => [uuid(row.id), row]));

    if (actorUwId !== undefined) {
      const uwRow = uwById.get(actorUwId);
      if (
        !uwRow ||
        uwRow.deletedAt !== null ||
        (uwRow.workspaceId !== null &&
          uuid(uwRow.workspaceId) !== request.workspaceId)
      ) {
        throw new Error(
          'Workspace domain audit userWorkspace actor unavailable',
        );
      }
      const resolvedUserId = uuid(uwRow.userId);
      if (
        request.expectedUserId !== undefined &&
        resolvedUserId !== request.expectedUserId
      ) {
        throw new Error(
          'Workspace domain audit actor mismatch with userWorkspace',
        );
      }
      if (request.pendingUserWorkspaceActorId !== undefined) {
        operation = Object.freeze({
          ...operation,
          actor: Object.freeze({
            kind: 'coreUser' as const,
            id: resolvedUserId,
          }),
        });
      }
    }

    if (impersonatorUwId !== undefined) {
      const impRow = uwById.get(impersonatorUwId);
      if (!impRow || impRow.deletedAt !== null) {
        throw new Error('Role audit impersonation initiator unavailable');
      }
      operation = Object.freeze({
        ...operation,
        initiator: Object.freeze({
          kind: 'coreUser' as const,
          id: uuid(impRow.userId),
        }),
      });
    }
  }

  if (tableFlags?.hasUser === true) {
    const coreUserIdsToVerify = new Set<string>();
    if (operation.actor.kind === 'coreUser') {
      coreUserIdsToVerify.add(uuid(operation.actor.id));
    }
    if (operation.initiator?.kind === 'coreUser') {
      coreUserIdsToVerify.add(uuid(operation.initiator.id));
    }
    for (const verifyUserId of [...coreUserIdsToVerify].sort()) {
      const [userRow] = await runner.query(
        `SELECT id,to_jsonb(u)->>'deletedAt' AS "deletedAt"
           FROM core."user" u
          WHERE u.id=$1
          FOR KEY SHARE`,
        [verifyUserId],
      );
      if (!userRow || userRow.deletedAt !== null) {
        throw new Error('Workspace domain audit coreUser actor unavailable');
      }
    }
  }

  if (operation.actor.kind === 'apiKey' && tableFlags?.hasApiKey === true) {
    const [apiKeyRow] = await runner.query(
      `SELECT id,"workspaceId",to_jsonb(ak)->>'revokedAt' AS "revokedAt"
         FROM core."apiKey" ak
        WHERE ak.id=$1
        FOR KEY SHARE`,
      [uuid(operation.actor.id)],
    );
    if (
      !apiKeyRow ||
      uuid(apiKeyRow.workspaceId) !== request.workspaceId ||
      apiKeyRow.revokedAt !== null
    ) {
      throw new Error('Workspace domain audit apiKey actor unavailable');
    }
  }

  if (tableFlags?.hasApplication === true) {
    const appIdsToVerify = new Set<string>();
    if (operation.actor.kind === 'application') {
      appIdsToVerify.add(uuid(operation.actor.id));
    }
    if (operation.initiator?.kind === 'application') {
      appIdsToVerify.add(uuid(operation.initiator.id));
    }
    for (const appActorId of [...appIdsToVerify].sort()) {
      const [appRow] = await runner.query(
        `SELECT id,"workspaceId",to_jsonb(a)->>'deletedAt' AS "deletedAt"
           FROM core.application a
          WHERE a.id=$1
          FOR KEY SHARE`,
        [appActorId],
      );
      if (
        !appRow ||
        uuid(appRow.workspaceId) !== request.workspaceId ||
        appRow.deletedAt !== null
      ) {
        throw new Error('Workspace domain audit application actor unavailable');
      }
    }
  }

  return operation;
};

export const runAuditedApprovedAccessDomainCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    domain,
    senderUserId,
    senderMemberId,
    onAlreadyRegistered,
    onAfterAuditFlush,
  }: {
    domain: string;
    senderUserId?: string;
    senderMemberId?: string;
    onAlreadyRegistered: () => never;
    onAfterAuditFlush?: (
      created: PersistedApprovedAccessDomainRow,
    ) => Promise<void>;
  },
): Promise<PersistedApprovedAccessDomainRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Approved access domain audit requires core DataSource');
  }
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Approved access domain is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtext('approved_access_domain'), hashtext($1))`,
        [`${request.workspaceId}:${domain}`],
      );

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Approved access domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);
      const expectedSenderUserId =
        request.expectedUserId ??
        (operation.actor.kind === 'coreUser'
          ? uuid(operation.actor.id)
          : undefined);
      if (
        expectedSenderUserId !== undefined &&
        senderUserId !== undefined &&
        (!isUUID(senderUserId) || uuid(senderUserId) !== expectedSenderUserId)
      ) {
        throw new Error(
          'Approved access domain audit actor mismatch with sender userId',
        );
      }
      if (
        operation.actor.kind === 'workspaceMember' &&
        senderMemberId !== undefined &&
        (!isUUID(senderMemberId) ||
          uuid(senderMemberId) !== uuid(operation.actor.id))
      ) {
        throw new Error(
          'Approved access domain audit actor mismatch with sender workspaceMember',
        );
      }

      const [existing] = await runner.query(
        `SELECT id FROM core."approvedAccessDomain" WHERE domain=$1 AND "workspaceId"=$2 FOR UPDATE`,
        [domain, request.workspaceId],
      );
      if (existing) {
        return onAlreadyRegistered();
      }

      const [inserted] = await runner.query(
        `INSERT INTO core."approvedAccessDomain" ("id","workspaceId","domain","isValidated","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,false,now(),now())
         RETURNING to_jsonb("approvedAccessDomain") AS row`,
        [request.workspaceId, domain],
      );
      if (!inserted?.row) {
        throw new Error('Approved access domain insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.domain !== domain ||
        afterRow.isValidated !== false
      ) {
        throw new Error(
          'Approved access domain persisted row failed validation',
        );
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'approvedAccessDomain',
        resourceId,
        action: 'create',
        before: null,
        after: projectApprovedAccessDomain(afterRow),
        securityDescriptor: {
          resourceKind: 'approvedAccessDomain',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();

      const verifyPostFlushState = async () => {
        const [postFlush] = await runner.query(
          `SELECT to_jsonb(aad) AS row FROM core."approvedAccessDomain" aad WHERE aad.id=$1`,
          [resourceId],
        );
        if (
          !postFlush?.row ||
          canonicalAuditJson(
            scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
          ) !== expectedSerialized
        ) {
          throw new Error(
            'Approved access domain state changed during audit flush',
          );
        }
      };

      await verifyPostFlushState();
      const createdEntity = hydrateApprovedAccessDomainRow(afterRow);

      if (onAfterAuditFlush) {
        await onAfterAuditFlush(createdEntity);
        await verifyPostFlushState();
      }

      return createdEntity;
    }),
  );
};

export const runAuditedApprovedAccessDomainValidate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    approvedAccessDomainId,
    expectedDomain,
    expectedWorkspaceId,
    onNotFound,
    onInvalidToken,
    onAlreadyValidated,
  }: {
    approvedAccessDomainId: string;
    expectedDomain: string;
    expectedWorkspaceId: string;
    onNotFound: () => never;
    onInvalidToken: () => never;
    onAlreadyValidated: () => never;
  },
): Promise<PersistedApprovedAccessDomainRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Approved access domain audit requires core DataSource');
  }
  let normalizedDomainId: string;
  try {
    normalizedDomainId = uuid(approvedAccessDomainId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }
  if (
    !isUUID(expectedWorkspaceId) ||
    uuid(expectedWorkspaceId) !== request.workspaceId
  ) {
    consumeWorkspaceDomainAuditRequest(request);
    return onInvalidToken();
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Approved access domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(aad) AS row FROM core."approvedAccessDomain" aad WHERE aad.id=$1 FOR UPDATE`,
        [normalizedDomainId],
      );
      if (!beforeEntry?.row) {
        return onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      if (
        uuid(beforeRow.workspaceId) !== request.workspaceId ||
        beforeRow.domain !== expectedDomain
      ) {
        return onInvalidToken();
      }
      if (beforeRow.isValidated === true) {
        return onAlreadyValidated();
      }

      await runner.query(
        `UPDATE core."approvedAccessDomain"
            SET "isValidated"=true,
                "updatedAt"=now()
          WHERE id=$1 AND "workspaceId"=$2`,
        [normalizedDomainId, request.workspaceId],
      );
      const [updated] = await runner.query(
        `SELECT to_jsonb(aad) AS row FROM core."approvedAccessDomain" aad WHERE aad.id=$1 AND aad."workspaceId"=$2`,
        [normalizedDomainId, request.workspaceId],
      );
      if (!updated?.row) {
        throw new Error('Approved access domain update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      if (
        uuid(afterRow.id) !== normalizedDomainId ||
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.domain !== expectedDomain ||
        afterRow.isValidated !== true
      ) {
        throw new Error('Approved access domain updated row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'approvedAccessDomain',
        resourceId: normalizedDomainId,
        action: 'update',
        before: projectApprovedAccessDomain(beforeRow),
        after: projectApprovedAccessDomain(afterRow),
        securityDescriptor: {
          resourceKind: 'approvedAccessDomain',
          resourceId: normalizedDomainId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(aad) AS row FROM core."approvedAccessDomain" aad WHERE aad.id=$1`,
        [normalizedDomainId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'Approved access domain state changed during audit flush',
        );
      }

      return hydrateApprovedAccessDomainRow(afterRow);
    }),
  );
};

export const runAuditedApprovedAccessDomainDelete = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    approvedAccessDomainId,
    onNotFound,
  }: {
    approvedAccessDomainId: string;
    onNotFound: () => never;
  },
): Promise<void> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Approved access domain audit requires core DataSource');
  }
  let normalizedDomainId: string;
  try {
    normalizedDomainId = uuid(approvedAccessDomainId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Approved access domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(aad) AS row FROM core."approvedAccessDomain" aad WHERE aad.id=$1 AND aad."workspaceId"=$2 FOR UPDATE`,
        [normalizedDomainId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;

      await runner.query(
        `DELETE FROM core."approvedAccessDomain" WHERE id=$1 AND "workspaceId"=$2`,
        [normalizedDomainId, request.workspaceId],
      );
      const [remaining] = await runner.query(
        `SELECT id FROM core."approvedAccessDomain" WHERE id=$1`,
        [normalizedDomainId],
      );
      if (remaining) {
        throw new Error('Approved access domain delete did not remove row');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'approvedAccessDomain',
        resourceId: normalizedDomainId,
        action: 'delete',
        before: projectApprovedAccessDomain(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'approvedAccessDomain',
          resourceId: normalizedDomainId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT id FROM core."approvedAccessDomain" WHERE id=$1`,
        [normalizedDomainId],
      );
      if (postFlush) {
        throw new Error(
          'Approved access domain state changed during audit flush',
        );
      }
    }),
  );
};

export const runAuditedPublicDomainCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    domain,
    applicationId,
    onApplicationNotFound,
    onCustomDomainCollision,
    onAlreadyRegistered,
  }: {
    domain: string;
    applicationId: string;
    onApplicationNotFound: () => never;
    onCustomDomainCollision: () => never;
    onAlreadyRegistered: () => never;
  },
): Promise<PersistedPublicDomainRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain audit requires core DataSource');
  }
  const formattedDomain = domain.trim().toLowerCase();
  if (formattedDomain.length === 0) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain is invalid');
  }
  let normalizedApplicationId: string;
  try {
    normalizedApplicationId = uuid(applicationId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtext('public_domain'), hashtext($1))`,
        [formattedDomain],
      );

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Public domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [application] = await runner.query(
        `SELECT id,to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedApplicationId, request.workspaceId],
      );
      if (!application || application.deletedAt !== null) {
        return onApplicationNotFound();
      }

      const [workspaceWithCustomDomain] = await runner.query(
        `SELECT id FROM core.workspace w WHERE to_jsonb(w)->>'customDomain'=$1 AND to_jsonb(w)->>'deletedAt' IS NULL LIMIT 1`,
        [formattedDomain],
      );
      if (workspaceWithCustomDomain) {
        return onCustomDomainCollision();
      }

      const [existingPublicDomain] = await runner.query(
        `SELECT id FROM core."publicDomain" WHERE domain=$1 LIMIT 1`,
        [formattedDomain],
      );
      if (existingPublicDomain) {
        return onAlreadyRegistered();
      }

      const [inserted] = await runner.query(
        `INSERT INTO core."publicDomain" ("id","workspaceId","applicationId","domain","isValidated","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$3,false,now(),now())
         RETURNING to_jsonb("publicDomain") AS row`,
        [request.workspaceId, normalizedApplicationId, formattedDomain],
      );
      if (!inserted?.row) {
        throw new Error('Public domain insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        uuid(afterRow.applicationId) !== normalizedApplicationId ||
        afterRow.domain !== formattedDomain ||
        afterRow.isValidated !== false
      ) {
        throw new Error('Public domain persisted row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'publicDomain',
        resourceId,
        action: 'create',
        before: null,
        after: projectPublicDomain(afterRow),
        securityDescriptor: {
          resourceKind: 'publicDomain',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('Public domain state changed during audit flush');
      }

      return hydratePublicDomainRow(afterRow);
    }),
  );
};

export const runAuditedPublicDomainValidationUpdate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    publicDomainId,
    isValidated,
    onNotFound,
    onApplicationNotFound,
  }: {
    publicDomainId: string;
    isValidated: boolean;
    onNotFound: () => never;
    onApplicationNotFound: () => never;
  },
): Promise<boolean> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain audit requires core DataSource');
  }
  let normalizedPublicDomainId: string;
  try {
    normalizedPublicDomainId = uuid(publicDomainId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }
  if (typeof isValidated !== 'boolean') {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain validation status is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Public domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [lookupRow] = await runner.query(
        `SELECT "applicationId" FROM core."publicDomain" WHERE id=$1 AND "workspaceId"=$2`,
        [normalizedPublicDomainId, request.workspaceId],
      );
      if (!lookupRow?.applicationId) {
        return onNotFound();
      }

      const [application] = await runner.query(
        `SELECT id,to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
        [uuid(lookupRow.applicationId), request.workspaceId],
      );
      if (!application || application.deletedAt !== null) {
        return onApplicationNotFound();
      }

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd.id=$1 AND pd."workspaceId"=$2 FOR UPDATE`,
        [normalizedPublicDomainId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      if (Boolean(beforeRow.isValidated) === isValidated) {
        return false;
      }

      await runner.query(
        `UPDATE core."publicDomain"
            SET "isValidated"=$1,
                "updatedAt"=now()
          WHERE id=$2 AND "workspaceId"=$3`,
        [isValidated, normalizedPublicDomainId, request.workspaceId],
      );
      const [updated] = await runner.query(
        `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd.id=$1 AND pd."workspaceId"=$2`,
        [normalizedPublicDomainId, request.workspaceId],
      );
      if (!updated?.row) {
        throw new Error('Public domain update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      if (
        uuid(afterRow.id) !== normalizedPublicDomainId ||
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.isValidated !== isValidated
      ) {
        throw new Error('Public domain updated row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'publicDomain',
        resourceId: normalizedPublicDomainId,
        action: 'update',
        before: projectPublicDomain(beforeRow),
        after: projectPublicDomain(afterRow),
        securityDescriptor: {
          resourceKind: 'publicDomain',
          resourceId: normalizedPublicDomainId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd.id=$1`,
        [normalizedPublicDomainId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('Public domain state changed during audit flush');
      }

      return true;
    }),
  );
};

export const runAuditedPublicDomainDelete = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  { domain }: { domain: string },
): Promise<{ deleted: boolean }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain audit requires core DataSource');
  }
  const formattedDomain = domain.trim().toLowerCase();
  if (formattedDomain.length === 0) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Public domain is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Public domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [lookupRow] = await runner.query(
        `SELECT id,"applicationId" FROM core."publicDomain" WHERE domain=$1 AND "workspaceId"=$2`,
        [formattedDomain, request.workspaceId],
      );
      if (!lookupRow?.id) {
        return { deleted: false };
      }

      await runner.query(
        `SELECT id FROM core.application WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE`,
        [uuid(lookupRow.applicationId), request.workspaceId],
      );

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd.id=$1 AND pd."workspaceId"=$2 FOR UPDATE`,
        [uuid(lookupRow.id), request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return { deleted: false };
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const resourceId = uuid(beforeRow.id);

      await runner.query(
        `DELETE FROM core."publicDomain" WHERE id=$1 AND "workspaceId"=$2`,
        [resourceId, request.workspaceId],
      );
      const [remaining] = await runner.query(
        `SELECT id FROM core."publicDomain" WHERE id=$1`,
        [resourceId],
      );
      if (remaining) {
        throw new Error('Public domain delete did not remove row');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'publicDomain',
        resourceId,
        action: 'delete',
        before: projectPublicDomain(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'publicDomain',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT id FROM core."publicDomain" WHERE id=$1`,
        [resourceId],
      );
      if (postFlush) {
        throw new Error('Public domain state changed during audit flush');
      }

      return { deleted: true };
    }),
  );
};

export const runAuditedEmailingDomainCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    domain,
    status,
    verificationRecords,
    verifiedAt,
    onAlreadyRegistered,
  }: {
    domain: string;
    status: EmailingDomainStatusValue;
    verificationRecords: Array<Record<string, unknown>> | null;
    verifiedAt: Date | null;
    onAlreadyRegistered: (existingWorkspaceId: string) => never;
  },
): Promise<PersistedEmailingDomainRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain audit requires core DataSource');
  }
  const formattedDomain = domain.trim().toLowerCase();
  if (formattedDomain.length === 0) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain is invalid');
  }
  if (!EMAILING_DOMAIN_STATUS_VALUES.has(status)) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain status is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtext('emailing_domain'), hashtext($1))`,
        [formattedDomain],
      );

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Emailing domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [existing] = await runner.query(
        `SELECT id,"workspaceId" FROM core."emailingDomain" WHERE domain=$1 FOR UPDATE`,
        [formattedDomain],
      );
      if (existing) {
        return onAlreadyRegistered(uuid(existing.workspaceId));
      }

      const [inserted] = await runner.query(
        `INSERT INTO core."emailingDomain" (
           "id","workspaceId","domain","status","verificationRecords","verifiedAt",
           "tenantStatus","unsubscribeHostname","unsubscribeHostnameId","unsubscribeHostnameStatus",
           "createdAt","updatedAt"
         )
         VALUES (
           gen_random_uuid(),$1,$2,$3,$4::jsonb,$5,'ACTIVE',NULL,NULL,NULL,now(),now()
         )
         RETURNING to_jsonb("emailingDomain") AS row`,
        [
          request.workspaceId,
          formattedDomain,
          status,
          verificationRecords === null
            ? null
            : JSON.stringify(verificationRecords),
          verifiedAt,
        ],
      );
      if (!inserted?.row) {
        throw new Error('Emailing domain insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.domain !== formattedDomain ||
        afterRow.status !== status ||
        afterRow.tenantStatus !== 'ACTIVE'
      ) {
        throw new Error('Emailing domain persisted row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'emailingDomain',
        resourceId,
        action: 'create',
        before: null,
        after: projectEmailingDomain(afterRow),
        securityDescriptor: {
          resourceKind: 'emailingDomain',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('Emailing domain state changed during audit flush');
      }

      return hydrateEmailingDomainRow(afterRow);
    }),
  );
};

export const runAuditedEmailingDomainUpdate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    emailingDomainId,
    patch,
    onNotFound,
  }: {
    emailingDomainId: string;
    patch: {
      status?: EmailingDomainStatusValue;
      verificationRecords?: Array<Record<string, unknown>> | null;
      verifiedAt?: Date | null;
      unsubscribeHostname?: string | null;
      unsubscribeHostnameId?: string | null;
      unsubscribeHostnameStatus?: UnsubscribeHostnameStatusValue | null;
    };
    onNotFound?: () => never;
  },
): Promise<{ updated: boolean; row: PersistedEmailingDomainRow | null }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain audit requires core DataSource');
  }
  let normalizedId: string;
  try {
    normalizedId = uuid(emailingDomainId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Emailing domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.id=$1 AND ed."workspaceId"=$2 FOR UPDATE`,
        [normalizedId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        if (onNotFound) {
          return onNotFound();
        }
        return { updated: false, row: null };
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const beforeProj = projectEmailingDomain(beforeRow);

      const nextStatus =
        patch.status !== undefined ? patch.status : beforeProj.status;
      const nextVerificationRecords =
        patch.verificationRecords !== undefined
          ? patch.verificationRecords
          : beforeProj.verificationRecords;
      const nextVerifiedAt =
        patch.verifiedAt !== undefined
          ? patch.verifiedAt
          : beforeRow.verifiedAt === undefined || beforeRow.verifiedAt === null
            ? null
            : new Date(String(beforeRow.verifiedAt));
      const nextUnsubscribeHostname =
        patch.unsubscribeHostname !== undefined
          ? patch.unsubscribeHostname
          : beforeProj.unsubscribeHostname;
      const nextUnsubscribeHostnameId =
        patch.unsubscribeHostnameId !== undefined
          ? patch.unsubscribeHostnameId
          : beforeProj.unsubscribeHostnameId;
      const nextUnsubscribeHostnameStatus =
        patch.unsubscribeHostnameStatus !== undefined
          ? patch.unsubscribeHostnameStatus
          : beforeProj.unsubscribeHostnameStatus;

      await runner.query(
        `UPDATE core."emailingDomain"
            SET status=$1,
                "verificationRecords"=$2::jsonb,
                "verifiedAt"=$3,
                "unsubscribeHostname"=$4,
                "unsubscribeHostnameId"=$5,
                "unsubscribeHostnameStatus"=$6,
                "updatedAt"=now()
          WHERE id=$7 AND "workspaceId"=$8`,
        [
          nextStatus,
          nextVerificationRecords === null
            ? null
            : JSON.stringify(nextVerificationRecords),
          nextVerifiedAt,
          nextUnsubscribeHostname,
          nextUnsubscribeHostnameId,
          nextUnsubscribeHostnameStatus,
          normalizedId,
          request.workspaceId,
        ],
      );

      const [updated] = await runner.query(
        `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.id=$1 AND ed."workspaceId"=$2`,
        [normalizedId, request.workspaceId],
      );
      if (!updated?.row) {
        throw new Error('Emailing domain update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      const afterProj = projectEmailingDomain(afterRow);

      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        const audit = new CrmAuditTransactionContext(runner, operation);
        audit.record({
          resourceKind: 'emailingDomain',
          resourceId: normalizedId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'emailingDomain',
            resourceId: normalizedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });

        const expectedSerialized = canonicalAuditJson(
          scalarWithoutTimestamps(afterRow),
        );
        await audit.flush();
        const [postFlush] = await runner.query(
          `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.id=$1`,
          [normalizedId],
        );
        if (
          !postFlush?.row ||
          canonicalAuditJson(
            scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
          ) !== expectedSerialized
        ) {
          throw new Error('Emailing domain state changed during audit flush');
        }
      }

      return {
        updated:
          canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj),
        row: hydrateEmailingDomainRow(afterRow),
      };
    }),
  );
};

export const runAuditedEmailingDomainTenantStatusUpdate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    tenantStatus,
  }: {
    tenantStatus: EmailingDomainTenantStatusValue;
  },
): Promise<{ affected: number }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain audit requires core DataSource');
  }
  if (!EMAILING_DOMAIN_TENANT_STATUS_VALUES.has(tenantStatus)) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain tenantStatus is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Emailing domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const beforeEntries: Array<{ row: Record<string, unknown> }> =
        await runner.query(
          `SELECT to_jsonb(ed) AS row
             FROM core."emailingDomain" ed
            WHERE ed."workspaceId"=$1 AND ed."tenantStatus"::text <> 'SANDBOX'
            ORDER BY ed.id ASC
            FOR UPDATE`,
          [request.workspaceId],
        );
      if (beforeEntries.length === 0) {
        return { affected: 0 };
      }

      const beforeById = new Map<string, Record<string, unknown>>();
      for (const entry of beforeEntries) {
        const row = entry.row;
        beforeById.set(uuid(row.id), row);
      }

      await runner.query(
        `UPDATE core."emailingDomain"
            SET "tenantStatus"=$1,
                "updatedAt"=now()
          WHERE "workspaceId"=$2 AND "tenantStatus"::text <> 'SANDBOX'`,
        [tenantStatus, request.workspaceId],
      );

      const afterEntries: Array<{ row: Record<string, unknown> }> =
        await runner.query(
          `SELECT to_jsonb(ed) AS row
             FROM core."emailingDomain" ed
            WHERE ed."workspaceId"=$1 AND ed."tenantStatus"::text <> 'SANDBOX'
            ORDER BY ed.id ASC`,
          [request.workspaceId],
        );

      const audit = new CrmAuditTransactionContext(runner, operation);
      let recordedCount = 0;
      const expectedSerializedById = new Map<string, string>();
      for (const entry of afterEntries) {
        const afterRow = entry.row;
        const rowId = uuid(afterRow.id);
        const beforeRow = beforeById.get(rowId);
        if (!beforeRow) {
          throw new Error(
            'Emailing domain tenantStatus update changed candidate set',
          );
        }
        const beforeProj = projectEmailingDomain(beforeRow);
        const afterProj = projectEmailingDomain(afterRow);
        expectedSerializedById.set(
          rowId,
          canonicalAuditJson(scalarWithoutTimestamps(afterRow)),
        );
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'emailingDomain',
            resourceId: rowId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'emailingDomain',
              resourceId: rowId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedCount += 1;
        }
      }

      if (recordedCount > 0) {
        await audit.flush();
        const postFlushEntries: Array<{ row: Record<string, unknown> }> =
          await runner.query(
            `SELECT to_jsonb(ed) AS row
               FROM core."emailingDomain" ed
              WHERE ed."workspaceId"=$1 AND ed.id = ANY($2::uuid[])
              ORDER BY ed.id ASC`,
            [request.workspaceId, [...expectedSerializedById.keys()]],
          );
        if (postFlushEntries.length !== expectedSerializedById.size) {
          throw new Error('Emailing domain state changed during audit flush');
        }
        for (const entry of postFlushEntries) {
          const pfRow = entry.row;
          const rowId = uuid(pfRow.id);
          if (
            canonicalAuditJson(scalarWithoutTimestamps(pfRow)) !==
            expectedSerializedById.get(rowId)
          ) {
            throw new Error('Emailing domain state changed during audit flush');
          }
        }
      }

      return { affected: beforeEntries.length };
    }),
  );
};

export const runAuditedEmailingDomainDelete = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    emailingDomainId,
    domain,
    onNotFound,
  }: {
    emailingDomainId?: string;
    domain?: string;
    onNotFound?: () => never;
  },
): Promise<{ deleted: boolean; row: PersistedEmailingDomainRow | null }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain audit requires core DataSource');
  }
  const normalizedId =
    emailingDomainId !== undefined ? uuid(emailingDomainId) : undefined;
  const formattedDomain =
    domain !== undefined ? domain.trim().toLowerCase() : undefined;
  if (normalizedId === undefined && !formattedDomain) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Emailing domain delete requires id or domain');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Emailing domain audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] =
        normalizedId !== undefined
          ? await runner.query(
              `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.id=$1 AND ed."workspaceId"=$2 FOR UPDATE`,
              [normalizedId, request.workspaceId],
            )
          : await runner.query(
              `SELECT to_jsonb(ed) AS row FROM core."emailingDomain" ed WHERE ed.domain=$1 AND ed."workspaceId"=$2 FOR UPDATE`,
              [formattedDomain, request.workspaceId],
            );
      if (!beforeEntry?.row) {
        if (onNotFound) {
          return onNotFound();
        }
        return { deleted: false, row: null };
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const resourceId = uuid(beforeRow.id);

      await runner.query(
        `DELETE FROM core."emailingDomain" WHERE id=$1 AND "workspaceId"=$2`,
        [resourceId, request.workspaceId],
      );
      const [remaining] = await runner.query(
        `SELECT id FROM core."emailingDomain" WHERE id=$1`,
        [resourceId],
      );
      if (remaining) {
        throw new Error('Emailing domain delete did not remove row');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'emailingDomain',
        resourceId,
        action: 'delete',
        before: projectEmailingDomain(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'emailingDomain',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT id FROM core."emailingDomain" WHERE id=$1`,
        [resourceId],
      );
      if (postFlush) {
        throw new Error('Emailing domain state changed during audit flush');
      }

      return { deleted: true, row: hydrateEmailingDomainRow(beforeRow) };
    }),
  );
};

export const runAuditedDpaAgreementCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    record,
    expectedUserId,
  }: {
    record: {
      workspaceId: string;
      type: DpaAgreementTypeValue;
      templateVersion: string;
      region: string;
      processorEntity: string;
      customerLegalEntityName?: string;
      signatoryName?: string;
      signatoryTitle?: string;
      signedFileId?: string;
      acceptedByUserId?: string;
      acceptedByEmail?: string;
      acceptedAt: Date;
    };
    expectedUserId?: string;
  },
): Promise<PersistedDpaAgreementRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('DPA agreement audit requires core DataSource');
  }
  if (uuid(record.workspaceId) !== request.workspaceId) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('DPA agreement workspace mismatch');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('DPA agreement audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);
      const operationUserId =
        request.expectedUserId ??
        (operation.actor.kind === 'coreUser'
          ? uuid(operation.actor.id)
          : undefined);
      if (
        operationUserId !== undefined &&
        ((expectedUserId !== undefined &&
          uuid(expectedUserId) !== operationUserId) ||
          (record.acceptedByUserId !== undefined &&
            uuid(record.acceptedByUserId) !== operationUserId))
      ) {
        throw new Error(
          'DPA agreement audit actor mismatch with acceptedByUserId',
        );
      }

      const [inserted] = await runner.query(
        `INSERT INTO core."dpaAgreement" (
           "id","workspaceId","type","templateVersion","region","processorEntity",
           "customerLegalEntityName","signatoryName","signatoryTitle","signedFileId",
           "acceptedByUserId","acceptedByEmail","acceptedAt","createdAt","updatedAt"
         )
         VALUES (
           gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now()
         )
         RETURNING to_jsonb("dpaAgreement") AS row`,
        [
          request.workspaceId,
          record.type,
          record.templateVersion,
          record.region,
          record.processorEntity,
          record.customerLegalEntityName ?? null,
          record.signatoryName ?? null,
          record.signatoryTitle ?? null,
          record.signedFileId ? uuid(record.signedFileId) : null,
          record.acceptedByUserId ? uuid(record.acceptedByUserId) : null,
          record.acceptedByEmail ?? null,
          record.acceptedAt,
        ],
      );
      if (!inserted?.row) {
        throw new Error('DPA agreement insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.type !== record.type ||
        afterRow.templateVersion !== record.templateVersion ||
        afterRow.region !== record.region
      ) {
        throw new Error('DPA agreement persisted row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'dpaAgreement',
        resourceId,
        action: 'create',
        before: null,
        after: projectDpaAgreement(afterRow),
        securityDescriptor: {
          resourceKind: 'dpaAgreement',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(da) AS row FROM core."dpaAgreement" da WHERE da.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('DPA agreement state changed during audit flush');
      }

      return hydrateDpaAgreementRow(afterRow);
    }),
  );
};

export const runAuditedUnsubscribeTopicCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    name,
    description = null,
    visibility,
  }: {
    name: string;
    description?: string | null;
    visibility: UnsubscribeTopicVisibilityValue;
  },
): Promise<PersistedUnsubscribeTopicRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Unsubscribe topic audit requires core DataSource');
  }
  if (!UNSUBSCRIBE_TOPIC_VISIBILITY_VALUES.has(visibility)) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Unsubscribe topic visibility is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Unsubscribe topic audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [inserted] = await runner.query(
        `INSERT INTO core."unsubscribeTopic" (
           "id","workspaceId","name","description","visibility","createdAt","updatedAt"
         )
         VALUES (
           gen_random_uuid(),$1,$2,$3,$4,now(),now()
         )
         RETURNING to_jsonb("unsubscribeTopic") AS row`,
        [request.workspaceId, name, description ?? null, visibility],
      );
      if (!inserted?.row) {
        throw new Error('Unsubscribe topic insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.name !== name ||
        (afterRow.description ?? null) !== (description ?? null) ||
        afterRow.visibility !== visibility
      ) {
        throw new Error('Unsubscribe topic persisted row failed validation');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'unsubscribeTopic',
        resourceId,
        action: 'create',
        before: null,
        after: projectUnsubscribeTopic(afterRow),
        securityDescriptor: {
          resourceKind: 'unsubscribeTopic',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(ut) AS row FROM core."unsubscribeTopic" ut WHERE ut.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('Unsubscribe topic state changed during audit flush');
      }

      return hydrateUnsubscribeTopicRow(afterRow);
    }),
  );
};

export const runAuditedUnsubscribeTopicUpdate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    unsubscribeTopicId,
    patch,
    onNotFound,
  }: {
    unsubscribeTopicId: string;
    patch: {
      name?: string | null;
      description?: string | null;
      visibility?: UnsubscribeTopicVisibilityValue;
    };
    onNotFound: () => Promise<never> | never;
  },
): Promise<PersistedUnsubscribeTopicRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Unsubscribe topic audit requires core DataSource');
  }
  let normalizedId: string;
  try {
    normalizedId = uuid(unsubscribeTopicId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }
  if (
    patch.visibility !== undefined &&
    !UNSUBSCRIBE_TOPIC_VISIBILITY_VALUES.has(patch.visibility)
  ) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Unsubscribe topic visibility is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Unsubscribe topic audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(ut) AS row FROM core."unsubscribeTopic" ut WHERE ut.id=$1 AND ut."workspaceId"=$2 FOR UPDATE`,
        [normalizedId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return await onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const beforeProj = projectUnsubscribeTopic(beforeRow);

      const nextName = patch.name !== undefined ? patch.name : beforeProj.name;
      const nextDescription =
        patch.description !== undefined
          ? patch.description
          : beforeProj.description;
      const nextVisibility =
        patch.visibility !== undefined
          ? patch.visibility
          : beforeProj.visibility;

      await runner.query(
        `UPDATE core."unsubscribeTopic"
            SET name=$1,
                description=$2,
                visibility=$3,
                "updatedAt"=now()
          WHERE id=$4 AND "workspaceId"=$5`,
        [
          nextName,
          nextDescription,
          nextVisibility,
          normalizedId,
          request.workspaceId,
        ],
      );

      const [updated] = await runner.query(
        `SELECT to_jsonb(ut) AS row FROM core."unsubscribeTopic" ut WHERE ut.id=$1 AND ut."workspaceId"=$2`,
        [normalizedId, request.workspaceId],
      );
      if (!updated?.row) {
        throw new Error('Unsubscribe topic update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      const afterProj = projectUnsubscribeTopic(afterRow);

      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        const audit = new CrmAuditTransactionContext(runner, operation);
        audit.record({
          resourceKind: 'unsubscribeTopic',
          resourceId: normalizedId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'unsubscribeTopic',
            resourceId: normalizedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });

        const expectedSerialized = canonicalAuditJson(
          scalarWithoutTimestamps(afterRow),
        );
        await audit.flush();
        const [postFlush] = await runner.query(
          `SELECT to_jsonb(ut) AS row FROM core."unsubscribeTopic" ut WHERE ut.id=$1`,
          [normalizedId],
        );
        if (
          !postFlush?.row ||
          canonicalAuditJson(
            scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
          ) !== expectedSerialized
        ) {
          throw new Error('Unsubscribe topic state changed during audit flush');
        }
      }

      return hydrateUnsubscribeTopicRow(afterRow);
    }),
  );
};

export const runAuditedUnsubscribeTopicDelete = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    unsubscribeTopicId,
  }: {
    unsubscribeTopicId: string;
  },
): Promise<{ deleted: boolean }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Unsubscribe topic audit requires core DataSource');
  }
  let normalizedId: string;
  try {
    normalizedId = uuid(unsubscribeTopicId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Unsubscribe topic audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(ut) AS row FROM core."unsubscribeTopic" ut WHERE ut.id=$1 AND ut."workspaceId"=$2 FOR UPDATE`,
        [normalizedId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return { deleted: false };
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const resourceId = uuid(beforeRow.id);

      await runner.query(
        `DELETE FROM core."unsubscribeTopic" WHERE id=$1 AND "workspaceId"=$2`,
        [resourceId, request.workspaceId],
      );
      const [remaining] = await runner.query(
        `SELECT id FROM core."unsubscribeTopic" WHERE id=$1`,
        [resourceId],
      );
      if (remaining) {
        throw new Error('Unsubscribe topic delete did not remove row');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'unsubscribeTopic',
        resourceId,
        action: 'delete',
        before: projectUnsubscribeTopic(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'unsubscribeTopic',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT id FROM core."unsubscribeTopic" WHERE id=$1`,
        [resourceId],
      );
      if (postFlush) {
        throw new Error('Unsubscribe topic state changed during audit flush');
      }

      return { deleted: true };
    }),
  );
};

export const runAuditedSsoIdentityProviderCreate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    record,
  }: {
    record: {
      id?: string;
      type: SsoIdentityProviderTypeValue;
      name: string;
      issuer: string;
      clientID?: string;
      clientSecret?: string;
      ssoURL?: string;
      certificate?: string;
      fingerprint?: string;
    };
  },
): Promise<PersistedSsoIdentityProviderRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('SSO identity provider audit requires core DataSource');
  }
  if (!SSO_IDENTITY_PROVIDER_TYPE_VALUES.has(record.type)) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('SSO identity provider type is invalid');
  }
  const normalizedExplicitId =
    record.id !== undefined ? uuid(record.id) : undefined;

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('SSO identity provider audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [inserted] =
        normalizedExplicitId !== undefined
          ? await runner.query(
              `INSERT INTO core."workspaceSSOIdentityProvider" (
                 "id","workspaceId","name","status","type","issuer",
                 "clientID","clientSecret","ssoURL","certificate","fingerprint",
                 "createdAt","updatedAt"
               )
               VALUES ($1,$2,$3,'Active',$4,$5,$6,$7,$8,$9,$10,now(),now())
               RETURNING to_jsonb("workspaceSSOIdentityProvider") AS row`,
              [
                normalizedExplicitId,
                request.workspaceId,
                record.name,
                record.type,
                record.issuer,
                record.clientID ?? null,
                record.clientSecret ?? null,
                record.ssoURL ?? null,
                record.certificate ?? null,
                record.fingerprint ?? null,
              ],
            )
          : await runner.query(
              `INSERT INTO core."workspaceSSOIdentityProvider" (
                 "id","workspaceId","name","status","type","issuer",
                 "clientID","clientSecret","ssoURL","certificate","fingerprint",
                 "createdAt","updatedAt"
               )
               VALUES (gen_random_uuid(),$1,$2,'Active',$3,$4,$5,$6,$7,$8,$9,now(),now())
               RETURNING to_jsonb("workspaceSSOIdentityProvider") AS row`,
              [
                request.workspaceId,
                record.name,
                record.type,
                record.issuer,
                record.clientID ?? null,
                record.clientSecret ?? null,
                record.ssoURL ?? null,
                record.certificate ?? null,
                record.fingerprint ?? null,
              ],
            );
      if (!inserted?.row) {
        throw new Error('SSO identity provider insert did not return row');
      }
      const afterRow = inserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.type !== record.type ||
        afterRow.name !== record.name ||
        afterRow.issuer !== record.issuer
      ) {
        throw new Error(
          'SSO identity provider persisted row failed validation',
        );
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'ssoIdentityProvider',
        resourceId,
        action: 'create',
        before: null,
        after: projectSsoIdentityProvider(afterRow),
        securityDescriptor: {
          resourceKind: 'ssoIdentityProvider',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(idp) AS row FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'SSO identity provider state changed during audit flush',
        );
      }

      return hydrateSsoIdentityProviderRow(afterRow);
    }),
  );
};

export const runAuditedSsoIdentityProviderUpdate = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    identityProviderId,
    patch,
    onNotFound,
  }: {
    identityProviderId: string;
    patch: {
      name?: string;
      status?: SsoIdentityProviderStatusValue;
      issuer?: string;
      clientID?: string;
      clientSecret?: string;
      ssoURL?: string;
      certificate?: string;
      fingerprint?: string;
    };
    onNotFound: () => never;
  },
): Promise<PersistedSsoIdentityProviderRow> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('SSO identity provider audit requires core DataSource');
  }
  let normalizedId: string;
  try {
    normalizedId = uuid(identityProviderId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }
  if (
    patch.status !== undefined &&
    !SSO_IDENTITY_PROVIDER_STATUS_VALUES.has(patch.status)
  ) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('SSO identity provider status is invalid');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('SSO identity provider audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(idp) AS row FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1 AND idp."workspaceId"=$2 FOR UPDATE`,
        [normalizedId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const beforeProj = projectSsoIdentityProvider(beforeRow);

      const nextName = patch.name !== undefined ? patch.name : beforeProj.name;
      const nextStatus =
        patch.status !== undefined ? patch.status : beforeProj.status;
      const nextIssuer =
        patch.issuer !== undefined ? patch.issuer : beforeProj.issuer;
      const nextClientID =
        patch.clientID !== undefined ? patch.clientID : beforeProj.clientID;
      const nextClientSecret =
        patch.clientSecret !== undefined
          ? patch.clientSecret
          : beforeProj.clientSecret;
      const nextSsoURL =
        patch.ssoURL !== undefined ? patch.ssoURL : beforeProj.ssoURL;
      const nextCertificate =
        patch.certificate !== undefined
          ? patch.certificate
          : beforeProj.certificate;
      const nextFingerprint =
        patch.fingerprint !== undefined
          ? patch.fingerprint
          : beforeProj.fingerprint;

      await runner.query(
        `UPDATE core."workspaceSSOIdentityProvider"
            SET name=$1,
                status=$2,
                issuer=$3,
                "clientID"=$4,
                "clientSecret"=$5,
                "ssoURL"=$6,
                certificate=$7,
                fingerprint=$8,
                "updatedAt"=now()
          WHERE id=$9 AND "workspaceId"=$10`,
        [
          nextName,
          nextStatus,
          nextIssuer,
          nextClientID,
          nextClientSecret,
          nextSsoURL,
          nextCertificate,
          nextFingerprint,
          normalizedId,
          request.workspaceId,
        ],
      );

      const [updated] = await runner.query(
        `SELECT to_jsonb(idp) AS row FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1 AND idp."workspaceId"=$2`,
        [normalizedId, request.workspaceId],
      );
      if (!updated?.row) {
        throw new Error('SSO identity provider update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      const afterProj = projectSsoIdentityProvider(afterRow);

      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        const audit = new CrmAuditTransactionContext(runner, operation);
        audit.record({
          resourceKind: 'ssoIdentityProvider',
          resourceId: normalizedId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'ssoIdentityProvider',
            resourceId: normalizedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });

        const expectedSerialized = canonicalAuditJson(
          scalarWithoutTimestamps(afterRow),
        );
        await audit.flush();
        const [postFlush] = await runner.query(
          `SELECT to_jsonb(idp) AS row FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1`,
          [normalizedId],
        );
        if (
          !postFlush?.row ||
          canonicalAuditJson(
            scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
          ) !== expectedSerialized
        ) {
          throw new Error(
            'SSO identity provider state changed during audit flush',
          );
        }
      }

      return hydrateSsoIdentityProviderRow(afterRow);
    }),
  );
};

export const runAuditedSsoIdentityProviderDelete = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    identityProviderId,
    onNotFound,
  }: {
    identityProviderId: string;
    onNotFound: () => never;
  },
): Promise<{ identityProviderId: string }> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('SSO identity provider audit requires core DataSource');
  }
  let normalizedId: string;
  try {
    normalizedId = uuid(identityProviderId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('SSO identity provider audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(idp) AS row FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1 AND idp."workspaceId"=$2 FOR UPDATE`,
        [normalizedId, request.workspaceId],
      );
      if (!beforeEntry?.row) {
        return onNotFound();
      }
      const beforeRow = beforeEntry.row as Record<string, unknown>;
      const resourceId = uuid(beforeRow.id);

      await runner.query(
        `DELETE FROM core."workspaceSSOIdentityProvider" WHERE id=$1 AND "workspaceId"=$2`,
        [resourceId, request.workspaceId],
      );
      const [remaining] = await runner.query(
        `SELECT id FROM core."workspaceSSOIdentityProvider" WHERE id=$1`,
        [resourceId],
      );
      if (remaining) {
        throw new Error('SSO identity provider delete did not remove row');
      }

      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        resourceKind: 'ssoIdentityProvider',
        resourceId,
        action: 'delete',
        before: projectSsoIdentityProvider(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'ssoIdentityProvider',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT id FROM core."workspaceSSOIdentityProvider" idp WHERE idp.id=$1`,
        [resourceId],
      );
      if (postFlush) {
        throw new Error(
          'SSO identity provider state changed during audit flush',
        );
      }

      return { identityProviderId: resourceId };
    }),
  );
};

export const runAuditedApplicationTranslationSync = async (
  dataSource: DataSource | undefined,
  request: WorkspaceDomainAuditRequest,
  {
    applicationRegistrationId,
    translations,
  }: {
    applicationRegistrationId: string;
    translations: Record<string, Record<string, string>>;
  },
): Promise<void> => {
  if (!dataSource) {
    consumeWorkspaceDomainAuditRequest(request);
    throw new Error('Application translation audit requires core DataSource');
  }
  let normalizedRegistrationId: string;
  try {
    normalizedRegistrationId = uuid(applicationRegistrationId);
  } catch (error) {
    consumeWorkspaceDomainAuditRequest(request);
    throw error;
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Application translation audit workspace unavailable');
      }

      const operation = await resolveWorkspaceDomainOperation(runner, request);

      const readTranslationRows = async (): Promise<
        Array<Record<string, unknown>>
      > => {
        const entries = await runner.query(
          `SELECT to_jsonb(at) AS row
             FROM core."applicationTranslation" at
            WHERE at."applicationRegistrationId"=$1
            ORDER BY at.id
            FOR UPDATE`,
          [normalizedRegistrationId],
        );

        return entries.map(
          (entry: { row: Record<string, unknown> }) => entry.row,
        );
      };

      const existingRows = await readTranslationRows();
      const rowByLocale = new Map<string, Record<string, unknown>>();
      for (const row of existingRows) {
        const locale = String(row.locale);
        const current = rowByLocale.get(locale);
        const shouldPrefer =
          !current ||
          (current.deletedAt !== null &&
            current.deletedAt !== undefined &&
            (row.deletedAt === null || row.deletedAt === undefined));
        if (shouldPrefer) {
          rowByLocale.set(locale, row);
        }
      }

      const manifestEntries = Object.entries(translations).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const manifestLocales = new Set(
        manifestEntries.map(([locale]) => locale),
      );

      const mutations: Array<{
        resourceId: string;
        action: 'create' | 'update' | 'delete';
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }> = [];

      for (const [locale, messages] of manifestEntries) {
        const existingRow = rowByLocale.get(locale);
        if (existingRow) {
          const rowId = uuid(existingRow.id);
          const wasDeleted =
            existingRow.deletedAt !== null &&
            existingRow.deletedAt !== undefined;
          const beforeProj = projectApplicationTranslation(existingRow);

          await runner.query(
            `UPDATE core."applicationTranslation"
                SET messages=$1::jsonb,
                    "deletedAt"=NULL,
                    "updatedAt"=now()
              WHERE id=$2`,
            [JSON.stringify(messages ?? {}), rowId],
          );

          const [updatedEntry] = await runner.query(
            `SELECT to_jsonb(at) AS row FROM core."applicationTranslation" at WHERE at.id=$1`,
            [rowId],
          );
          if (!updatedEntry?.row) {
            throw new Error(
              'Application translation update did not return row',
            );
          }
          const afterRow = updatedEntry.row as Record<string, unknown>;
          const afterProj = projectApplicationTranslation(afterRow);

          if (wasDeleted) {
            mutations.push({
              resourceId: rowId,
              action: 'create',
              before: null,
              after: afterProj,
            });
          } else if (
            canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)
          ) {
            mutations.push({
              resourceId: rowId,
              action: 'update',
              before: beforeProj,
              after: afterProj,
            });
          }
        } else {
          const [insertedEntry] = await runner.query(
            `INSERT INTO core."applicationTranslation"
               (id,"applicationRegistrationId",locale,messages,"createdAt","updatedAt","deletedAt")
             VALUES (gen_random_uuid(),$1,$2,$3::jsonb,now(),now(),NULL)
             RETURNING to_jsonb("applicationTranslation") AS row`,
            [normalizedRegistrationId, locale, JSON.stringify(messages ?? {})],
          );
          if (!insertedEntry?.row) {
            throw new Error(
              'Application translation insert did not return row',
            );
          }
          const afterRow = insertedEntry.row as Record<string, unknown>;
          const rowId = uuid(afterRow.id);
          mutations.push({
            resourceId: rowId,
            action: 'create',
            before: null,
            after: projectApplicationTranslation(afterRow),
          });
        }
      }

      for (const row of existingRows) {
        const locale = String(row.locale);
        const isDeleted = row.deletedAt !== null && row.deletedAt !== undefined;
        if (!manifestLocales.has(locale) && !isDeleted) {
          const rowId = uuid(row.id);
          const beforeProj = projectApplicationTranslation(row);
          await runner.query(
            `UPDATE core."applicationTranslation"
                SET "deletedAt"=now(),
                    "updatedAt"=now()
              WHERE id=$1`,
            [rowId],
          );
          mutations.push({
            resourceId: rowId,
            action: 'delete',
            before: beforeProj,
            after: null,
          });
        }
      }

      const afterRows = await readTranslationRows();
      const expectedSerialized = canonicalAuditJson(
        afterRows.map((row) => ({
          id: uuid(row.id),
          ...projectApplicationTranslation(row),
        })),
      );

      if (mutations.length > 0) {
        const audit = new CrmAuditTransactionContext(runner, operation);
        for (const mutation of mutations) {
          audit.record({
            resourceKind: 'applicationTranslation',
            resourceId: mutation.resourceId,
            action: mutation.action,
            before: mutation.before,
            after: mutation.after,
            securityDescriptor: {
              resourceKind: 'applicationTranslation',
              resourceId: mutation.resourceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }
        await audit.flush();

        const postFlushRows = await readTranslationRows();
        const postFlushSerialized = canonicalAuditJson(
          postFlushRows.map((row) => ({
            id: uuid(row.id),
            ...projectApplicationTranslation(row),
          })),
        );
        if (postFlushSerialized !== expectedSerialized) {
          throw new Error(
            'Application translation state changed during audit flush',
          );
        }
      }
    }),
  );
};
