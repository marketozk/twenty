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
}: {
  workspaceId?: string;
  auditIdentity?: WorkspaceDomainAuditIdentity;
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

  const {
    operation,
    impersonatorUserWorkspaceId,
    expectedUserId,
    expectedUserWorkspaceId,
    pendingUserWorkspaceActorId,
  } = resolveOperationFromIdentity(resolvedWorkspaceId, auditIdentity);

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
