import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  type ApplicationMetadataAuditIdentity,
  type CapturedApplicationMetadataAuditOperation,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
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
  membershipCleanupOperation,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  registerMetadataAuditScopeCheck,
  resolveRoleAuditInitiator,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { projectPublicDomain } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';

export type ApplicationAuthorizationAuditIdentity =
  | ApplicationMetadataAuditIdentity
  | CapturedApplicationMetadataAuditOperation
  | {
      workspaceId: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      correlationId?: string;
      impersonatorUserWorkspaceId?: string;
    };

export type ApplicationAuthorizationAuditRequest = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  expectedUserId?: string;
  expectedUserWorkspaceId?: string;
}>;

export type OptionalApplicationDeleteAuditRequest = Readonly<{
  workspaceId: string;
  operation?: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  captureError?: unknown;
}>;

const storage = new AsyncLocalStorage<{ workspaceId: string }>();
const active = new WeakSet<object>();
const consumed = new WeakSet<object>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error(
      'Application authorization or variable audit identity is invalid',
    );
  }

  return value.toLowerCase();
};

export const getApplicationAuthorizationOrVariableAudit = (
  workspaceId: string,
) => {
  const current = storage.getStore();
  if (!current) return undefined;
  if (!active.has(current) || current.workspaceId !== uuid(workspaceId)) {
    throw new Error(
      'Application authorization or variable audit context mismatch',
    );
  }

  return current;
};

registerMetadataAuditScopeCheck(getApplicationAuthorizationOrVariableAudit);

const resolveOperationFromIdentity = (
  normalizedWorkspaceId: string,
  identity: ApplicationAuthorizationAuditIdentity | undefined,
  errorMessage: string,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
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

    if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      if ((identity as MembershipCleanupIdentity).workspaceId === undefined) {
        throw new Error('CRM audit context requires scoped identity');
      }
      const rawCorrelationId = (identity as { correlationId?: unknown })
        .correlationId;
      const rawCausationId = (identity as { causationId?: unknown })
        .causationId;
      const rawOperationId = (identity as { operationId?: unknown })
        .operationId;
      const normalizedIdentity: MembershipCleanupIdentity = {
        ...(identity as MembershipCleanupIdentity),
        correlationId:
          typeof rawCorrelationId === 'string' && isUUID(rawCorrelationId)
            ? rawCorrelationId
            : randomUUID(),
      };
      const baseOperation = membershipCleanupOperation(
        normalizedWorkspaceId,
        normalizedIdentity,
      );
      if (!baseOperation) {
        throw new Error(errorMessage);
      }
      const operation = Object.freeze(
        captureCrmAuditOperation({
          ...baseOperation,
          ...(typeof rawOperationId === 'string'
            ? { operationId: uuid(rawOperationId) }
            : {}),
          ...(typeof rawCorrelationId === 'string'
            ? { correlationId: rawCorrelationId }
            : {}),
          ...(typeof rawCausationId === 'string'
            ? { causationId: rawCausationId }
            : {}),
        }),
      );
      const impersonatorId = (
        identity as { impersonatorUserWorkspaceId?: unknown }
      ).impersonatorUserWorkspaceId;
      if (impersonatorId !== undefined && typeof impersonatorId !== 'string') {
        throw new Error(errorMessage);
      }

      return {
        operation,
        ...(typeof impersonatorId === 'string'
          ? { impersonatorUserWorkspaceId: uuid(impersonatorId) }
          : {}),
      };
    }

    const reqLike = identity as Partial<RoleUpdateAuditIdentity> & {
      workspace?: { id: string };
      apiKey?: { id: string } | null;
      user?: { id?: string } | null;
      workspaceMemberId?: string;
      application?: { id: string } | null;
      impersonationContext?: { impersonatorUserWorkspaceId?: string };
      auth?: {
        type?: string;
        workspace?: { id: string };
        workspaceMemberId?: string;
        user?: { id?: string } | null;
      };
    };

    const directCoreUserId =
      reqLike?.auth === undefined &&
      reqLike?.user?.id !== undefined &&
      reqLike?.workspaceMemberId === undefined &&
      reqLike?.apiKey === undefined &&
      reqLike?.application === undefined
        ? reqLike.user.id
        : reqLike?.auth?.type === 'user' &&
            reqLike.auth.workspaceMemberId === undefined &&
            reqLike.auth.user?.id !== undefined
          ? reqLike.auth.user.id
          : undefined;

    if (typeof directCoreUserId === 'string') {
      const authWorkspaceId =
        reqLike?.auth?.workspace?.id ??
        reqLike?.workspace?.id ??
        normalizedWorkspaceId;
      if (uuid(authWorkspaceId) !== normalizedWorkspaceId) {
        throw new Error('CRM audit context workspace mismatch');
      }
      const userId = uuid(directCoreUserId);
      const agentId =
        reqLike.agentId !== undefined ? uuid(reqLike.agentId) : undefined;
      const impersonatorId =
        reqLike.impersonatorUserWorkspaceId ??
        reqLike.impersonationContext?.impersonatorUserWorkspaceId;
      return {
        operation: Object.freeze(
          captureCrmAuditOperation({
            workspaceId: normalizedWorkspaceId,
            operationId: randomUUID(),
            actor: agentId
              ? { kind: 'agent', id: agentId }
              : { kind: 'coreUser', id: userId },
            ...(agentId ? { initiator: { kind: 'coreUser', id: userId } } : {}),
            correlationId:
              typeof reqLike.correlationId === 'string'
                ? reqLike.correlationId
                : randomUUID(),
            ...(typeof reqLike.causationId === 'string'
              ? { causationId: reqLike.causationId }
              : {}),
          }),
        ),
        ...(impersonatorId
          ? { impersonatorUserWorkspaceId: uuid(impersonatorId) }
          : {}),
      };
    }

    const roleIdentity: RoleUpdateAuditIdentity =
      reqLike && typeof reqLike === 'object' && reqLike.auth !== undefined
        ? (reqLike as RoleUpdateAuditIdentity)
        : {
            auth: reqLike?.apiKey?.id
              ? {
                  workspace: {
                    id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                  },
                  type: 'apiKey',
                  apiKey: { id: reqLike.apiKey.id },
                }
              : reqLike?.workspaceMemberId
                ? {
                    workspace: {
                      id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                    },
                    type: 'user',
                    workspaceMemberId: reqLike.workspaceMemberId,
                  }
                : reqLike?.application?.id
                  ? {
                      workspace: {
                        id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                      },
                      type: 'application',
                      application: { id: reqLike.application.id },
                    }
                  : {
                      workspace: {
                        id: reqLike?.workspace?.id ?? normalizedWorkspaceId,
                      },
                      type: 'pendingActivationUser',
                    },
            agentId: reqLike?.agentId,
            impersonatorUserWorkspaceId:
              reqLike?.impersonatorUserWorkspaceId ??
              reqLike?.impersonationContext?.impersonatorUserWorkspaceId,
          };

    const capturedIdentity = captureRoleAuditIdentity(roleIdentity);
    const operation = captureRoleAuditOperation(
      normalizedWorkspaceId,
      capturedIdentity,
    );

    return {
      operation,
      ...(capturedIdentity.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              capturedIdentity.impersonatorUserWorkspaceId,
            ),
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

const extractWorkspaceIdFromIdentityOrAmbient = (
  workspaceId: string | undefined,
  identity: ApplicationAuthorizationAuditIdentity | undefined,
): string => {
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
      'auth' in identity &&
      identity.auth &&
      typeof identity.auth === 'object' &&
      'workspace' in identity.auth &&
      identity.auth.workspace &&
      typeof identity.auth.workspace === 'object' &&
      'id' in identity.auth.workspace &&
      typeof identity.auth.workspace.id === 'string'
    ) {
      return uuid(identity.auth.workspace.id);
    }
  }
  const ambientWorkspaceId = peekCurrentCrmAuditWorkspaceId();
  if (ambientWorkspaceId !== undefined) {
    return uuid(ambientWorkspaceId);
  }
  throw new Error(
    'Application authorization mutation requires authenticated audit identity',
  );
};

export const captureApplicationAuthorizationAudit = ({
  workspaceId,
  auditIdentity,
}: {
  workspaceId?: string;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
}): ApplicationAuthorizationAuditRequest => {
  const normalizedWorkspaceId = extractWorkspaceIdFromIdentityOrAmbient(
    workspaceId,
    auditIdentity,
  );
  if (
    getApplicationAuthorizationOrVariableAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error(
      'Nested application authorization or variable audit is unsupported',
    );
  }

  const { operation, impersonatorUserWorkspaceId } =
    resolveOperationFromIdentity(
      normalizedWorkspaceId,
      auditIdentity,
      'Application authorization mutation requires authenticated audit identity',
    );

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
  });
};

const extractExpectedUserBinding = (
  identity: ApplicationAuthorizationAuditIdentity | undefined,
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

export const captureUserApplicationVariableValueAudit = ({
  workspaceId,
  auditIdentity,
}: {
  workspaceId: string;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
}): ApplicationAuthorizationAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getApplicationAuthorizationOrVariableAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error(
      'Nested application authorization or variable audit is unsupported',
    );
  }

  const { operation, impersonatorUserWorkspaceId } =
    resolveOperationFromIdentity(
      normalizedWorkspaceId,
      auditIdentity,
      'User application variable value mutation requires authenticated audit identity',
    );
  const { expectedUserId, expectedUserWorkspaceId } =
    extractExpectedUserBinding(auditIdentity);

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    ...(expectedUserId ? { expectedUserId } : {}),
    ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
  });
};

export const captureOptionalApplicationDeleteAudit = ({
  workspaceId,
  auditIdentity,
}: {
  workspaceId: string;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
}): OptionalApplicationDeleteAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getApplicationAuthorizationOrVariableAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error(
      'Nested application authorization or variable audit is unsupported',
    );
  }

  try {
    const { operation, impersonatorUserWorkspaceId } =
      resolveOperationFromIdentity(
        normalizedWorkspaceId,
        auditIdentity,
        'Application authorization mutation requires authenticated audit identity',
      );
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    });
  } catch (error) {
    if (auditIdentity !== undefined) {
      throw error;
    }
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      captureError: error,
    });
  }
};

const scalarWithoutTimestamps = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'createdAt' && key !== 'updatedAt',
    ),
  );

export const projectApplicationAuthorization = (
  row: Record<string, unknown>,
) => ({
  userId: uuid(row.userId),
  userWorkspaceId: uuid(row.userWorkspaceId),
  applicationId: uuid(row.applicationId),
  scopes: Array.isArray(row.scopes) ? row.scopes : null,
  revokedAt: row.revokedAt === undefined ? null : row.revokedAt,
  lastAuthorizedAt:
    row.lastAuthorizedAt === undefined ? null : row.lastAuthorizedAt,
  lastUsedAt: row.lastUsedAt === undefined ? null : row.lastUsedAt,
});

export const projectUserApplicationVariableValue = (
  row: Record<string, unknown>,
) => ({
  userWorkspaceId: uuid(row.userWorkspaceId),
  applicationVariableId: uuid(row.applicationVariableId),
  scope: String(row.scope),
  value: String(row.value),
});

export const projectApplicationVariable = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  scope: String(row.scope),
  isSecret: Boolean(row.isSecret),
  key: String(row.key),
  value:
    row.value === null || row.value === undefined ? null : String(row.value),
});

export const projectFeatureFlag = (row: Record<string, unknown>) => ({
  key: String(row.key),
  value: Boolean(row.value),
});

export const captureApplicationVariableUpdateAudit = ({
  workspaceId,
  auditIdentity,
}: {
  workspaceId: string;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
}): ApplicationAuthorizationAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getApplicationAuthorizationOrVariableAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error(
      'Nested application authorization or variable audit is unsupported',
    );
  }

  const { operation, impersonatorUserWorkspaceId } =
    resolveOperationFromIdentity(
      normalizedWorkspaceId,
      auditIdentity,
      'Application variable mutation requires authenticated audit identity',
    );
  const { expectedUserId, expectedUserWorkspaceId } =
    extractExpectedUserBinding(auditIdentity);

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    ...(expectedUserId ? { expectedUserId } : {}),
    ...(expectedUserWorkspaceId ? { expectedUserWorkspaceId } : {}),
  });
};

export const captureFeatureFlagAudit = ({
  workspaceId,
  auditIdentity,
  fallbackSystemActorId,
}: {
  workspaceId: string;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
  fallbackSystemActorId?: string;
}): ApplicationAuthorizationAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getApplicationAuthorizationOrVariableAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error('Nested feature flag audit is unsupported');
  }

  if (auditIdentity !== undefined) {
    const { operation, impersonatorUserWorkspaceId } =
      resolveOperationFromIdentity(
        normalizedWorkspaceId,
        auditIdentity,
        'Feature flag mutation requires authenticated audit identity',
      );
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    });
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  if (ambient) {
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operation: ambient.operation,
      ...(ambient.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              ambient.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    });
  }

  if (
    typeof fallbackSystemActorId === 'string' &&
    fallbackSystemActorId.length > 0 &&
    fallbackSystemActorId.length <= 256
  ) {
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operation: Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: { kind: 'system', id: fallbackSystemActorId },
          correlationId: randomUUID(),
        }),
      ),
    });
  }

  throw new Error(
    'Feature flag mutation requires authenticated audit identity',
  );
};

const withExclusiveAuditScope = async <TResult>(
  request: { workspaceId: string },
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getApplicationAuthorizationOrVariableAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getApplicationAuthorizationOrVariableAudit,
    )
  ) {
    throw new Error(
      'Application authorization or variable audit scope is invalid or reused',
    );
  }
  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

export const runAuditedApplicationAuthorizationUpsert = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  {
    userId,
    userWorkspaceId,
    applicationId,
    scopes,
    mode,
  }: {
    userId: string;
    userWorkspaceId: string;
    applicationId: string;
    scopes: string[] | null;
    mode: 'record' | 'backfill';
  },
): Promise<void> => {
  if (!dataSource) {
    throw new Error('Application authorization audit requires core DataSource');
  }
  const normalizedUserId = uuid(userId);
  const normalizedUserWorkspaceId = uuid(userWorkspaceId);
  const normalizedApplicationId = uuid(applicationId);

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error(
          'Application authorization audit workspace unavailable',
        );
      }

      const [application] = await runner.query(
        `SELECT id,to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedApplicationId, request.workspaceId],
      );
      if (!application || application.deletedAt !== null) {
        throw new Error(
          'Application authorization audit application unavailable',
        );
      }

      const [userWorkspace] = await runner.query(
        `SELECT id,"userId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw.id=$1 AND uw."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedUserWorkspaceId, request.workspaceId],
      );
      if (
        !userWorkspace ||
        userWorkspace.deletedAt !== null ||
        uuid(userWorkspace.userId) !== normalizedUserId
      ) {
        throw new Error(
          'Application authorization audit userWorkspace unavailable',
        );
      }

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa."userId"=$1 AND aa."applicationId"=$2 FOR UPDATE`,
        [normalizedUserId, normalizedApplicationId],
      );
      const beforeRow = beforeEntry?.row as Record<string, unknown> | undefined;
      if (beforeRow && uuid(beforeRow.workspaceId) !== request.workspaceId) {
        throw new Error(
          'Application authorization workspace mismatch on existing row',
        );
      }

      if (mode === 'backfill' && beforeRow) {
        return;
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);

      const now = new Date();
      let afterRow: Record<string, unknown>;
      if (mode === 'backfill') {
        const [inserted] = await runner.query(
          `INSERT INTO core."applicationAuthorization" ("id","userId","workspaceId","userWorkspaceId","applicationId","scopes","lastAuthorizedAt","lastUsedAt","revokedAt","createdAt","updatedAt")
           VALUES (gen_random_uuid(),$1,$2,$3,$4,NULL,NULL,$5::timestamptz,NULL,now(),now())
           ON CONFLICT ("userId","applicationId") DO NOTHING
           RETURNING to_jsonb("applicationAuthorization") AS row`,
          [
            normalizedUserId,
            request.workspaceId,
            normalizedUserWorkspaceId,
            normalizedApplicationId,
            now.toISOString(),
          ],
        );
        if (!inserted?.row) {
          return;
        }
        afterRow = inserted.row as Record<string, unknown>;
      } else {
        const normalizedScopes = Array.isArray(scopes) ? [...scopes] : [];
        const [upserted] = await runner.query(
          `INSERT INTO core."applicationAuthorization" ("id","userId","workspaceId","userWorkspaceId","applicationId","scopes","lastAuthorizedAt","lastUsedAt","revokedAt","createdAt","updatedAt")
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5::text[],$6::timestamptz,$6::timestamptz,NULL,now(),now())
           ON CONFLICT ("userId","applicationId") DO UPDATE SET
             "workspaceId"=EXCLUDED."workspaceId",
             "userWorkspaceId"=EXCLUDED."userWorkspaceId",
             "scopes"=EXCLUDED."scopes",
             "lastAuthorizedAt"=GREATEST(EXCLUDED."lastAuthorizedAt", COALESCE(core."applicationAuthorization"."lastAuthorizedAt", '-infinity'::timestamptz) + interval '1 microsecond'),
             "lastUsedAt"=GREATEST(EXCLUDED."lastUsedAt", COALESCE(core."applicationAuthorization"."lastUsedAt", '-infinity'::timestamptz) + interval '1 microsecond'),
             "revokedAt"=NULL,
             "updatedAt"=now()
           RETURNING to_jsonb("applicationAuthorization") AS row`,
          [
            normalizedUserId,
            request.workspaceId,
            normalizedUserWorkspaceId,
            normalizedApplicationId,
            normalizedScopes,
            now.toISOString(),
          ],
        );
        if (!upserted?.row) {
          throw new Error(
            'Application authorization upsert did not return row',
          );
        }
        afterRow = upserted.row as Record<string, unknown>;
      }

      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        uuid(afterRow.userId) !== normalizedUserId ||
        uuid(afterRow.userWorkspaceId) !== normalizedUserWorkspaceId ||
        uuid(afterRow.applicationId) !== normalizedApplicationId ||
        afterRow.revokedAt !== null
      ) {
        throw new Error(
          'Application authorization persisted row failed validation',
        );
      }

      const afterProj = projectApplicationAuthorization(afterRow);
      if (!beforeRow) {
        audit.record({
          resourceKind: 'applicationAuthorization',
          resourceId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'applicationAuthorization',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      } else {
        const beforeProj = projectApplicationAuthorization(beforeRow);
        audit.record({
          resourceKind: 'applicationAuthorization',
          resourceId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'applicationAuthorization',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'Application authorization state changed during audit flush',
        );
      }
    }),
  );
};

export const runAuditedApplicationAuthorizationRevoke = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  criteria:
    | { id: string; userId: string }
    | { userId: string; applicationId: string },
): Promise<boolean> => {
  if (!dataSource) {
    throw new Error('Application authorization audit requires core DataSource');
  }
  const normalizedUserId = uuid(criteria.userId);
  const normalizedId = 'id' in criteria ? uuid(criteria.id) : undefined;
  const normalizedApplicationId =
    'applicationId' in criteria ? uuid(criteria.applicationId) : undefined;

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error(
          'Application authorization audit workspace unavailable',
        );
      }

      if (normalizedApplicationId !== undefined) {
        const [application] = await runner.query(
          `SELECT id FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
          [normalizedApplicationId, request.workspaceId],
        );
        if (!application) {
          return false;
        }
      }

      const [beforeEntry] =
        normalizedId !== undefined
          ? await runner.query(
              `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa.id=$1 AND aa."userId"=$2 FOR UPDATE`,
              [normalizedId, normalizedUserId],
            )
          : await runner.query(
              `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa."userId"=$1 AND aa."applicationId"=$2 FOR UPDATE`,
              [normalizedUserId, normalizedApplicationId],
            );

      const beforeRow = beforeEntry?.row as Record<string, unknown> | undefined;
      if (!beforeRow) {
        return false;
      }

      if (uuid(beforeRow.workspaceId) !== request.workspaceId) {
        if (normalizedId !== undefined) {
          return false;
        }
        throw new Error('Application authorization workspace mismatch');
      }

      if (beforeRow.revokedAt !== null && beforeRow.revokedAt !== undefined) {
        return false;
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);

      const resourceId = uuid(beforeRow.id);
      const rawUpdated = await runner.query(
        `UPDATE core."applicationAuthorization"
         SET "revokedAt"=GREATEST(now(), COALESCE("lastAuthorizedAt", '-infinity'::timestamptz) + interval '1 microsecond'),
             "updatedAt"=now()
         WHERE id=$1 AND "workspaceId"=$2 AND "revokedAt" IS NULL
         RETURNING to_jsonb("applicationAuthorization") AS row`,
        [resourceId, request.workspaceId],
      );
      const updatedRows = Array.isArray(rawUpdated?.[0])
        ? rawUpdated[0]
        : rawUpdated;
      const updated = updatedRows?.[0];
      if (!updated?.row) {
        throw new Error('Application authorization revoke did not update row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      if (afterRow.revokedAt === null || afterRow.revokedAt === undefined) {
        throw new Error(
          'Application authorization revoke did not persist revokedAt',
        );
      }

      audit.record({
        resourceKind: 'applicationAuthorization',
        resourceId,
        action: 'update',
        before: projectApplicationAuthorization(beforeRow),
        after: projectApplicationAuthorization(afterRow),
        securityDescriptor: {
          resourceKind: 'applicationAuthorization',
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'Application authorization state changed during audit flush',
        );
      }

      return true;
    }),
  );
};

export const runAuditedUserApplicationVariableValueMutation = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  {
    applicationId,
    applicationUniversalIdentifier,
    applicationVariableId,
    userWorkspaceId,
    encryptedValue,
  }: {
    applicationId: string;
    applicationUniversalIdentifier: string;
    applicationVariableId: string;
    userWorkspaceId: string;
    encryptedValue: string | null;
  },
): Promise<void> => {
  if (!dataSource) {
    throw new Error(
      'User application variable value audit requires core DataSource',
    );
  }
  const normalizedApplicationId = uuid(applicationId);
  const normalizedApplicationUniversalId = uuid(applicationUniversalIdentifier);
  const normalizedVariableId = uuid(applicationVariableId);
  const normalizedUserWorkspaceId = uuid(userWorkspaceId);

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error(
          'User application variable value audit workspace unavailable',
        );
      }

      const [application] = await runner.query(
        `SELECT id,"universalIdentifier",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedApplicationId, request.workspaceId],
      );
      if (
        !application ||
        application.deletedAt !== null ||
        uuid(application.universalIdentifier) !==
          normalizedApplicationUniversalId
      ) {
        throw new Error(
          'User application variable value audit application unavailable',
        );
      }

      const [userWorkspace] = await runner.query(
        `SELECT id,"userId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw.id=$1 AND uw."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedUserWorkspaceId, request.workspaceId],
      );
      if (!userWorkspace || userWorkspace.deletedAt !== null) {
        throw new Error(
          'User application variable value audit userWorkspace unavailable',
        );
      }
      if (
        (request.operation.actor.kind === 'coreUser' &&
          uuid(userWorkspace.userId) !== uuid(request.operation.actor.id)) ||
        (request.expectedUserId !== undefined &&
          uuid(userWorkspace.userId) !== request.expectedUserId) ||
        (request.expectedUserWorkspaceId !== undefined &&
          normalizedUserWorkspaceId !== request.expectedUserWorkspaceId)
      ) {
        throw new Error(
          'User application variable value audit actor mismatch with userWorkspace',
        );
      }
      if (
        request.operation.actor.kind === 'application' &&
        request.operation.initiator?.kind === 'coreUser' &&
        uuid(userWorkspace.userId) !== uuid(request.operation.initiator.id)
      ) {
        throw new Error(
          'User application variable value audit initiator mismatch with userWorkspace',
        );
      }

      const [variable] = await runner.query(
        `SELECT id,"applicationId",scope FROM core."applicationVariable" av WHERE av.id=$1 AND av."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedVariableId, request.workspaceId],
      );
      if (
        !variable ||
        uuid(variable.applicationId) !== normalizedApplicationId ||
        variable.scope !== 'USER'
      ) {
        throw new Error(
          'User application variable value audit applicationVariable unavailable',
        );
      }

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(uavv) AS row FROM core."userApplicationVariableValue" uavv WHERE uavv."applicationVariableId"=$1 AND uavv."userWorkspaceId"=$2 FOR UPDATE`,
        [normalizedVariableId, normalizedUserWorkspaceId],
      );
      const beforeRow = beforeEntry?.row as Record<string, unknown> | undefined;
      if (beforeRow && uuid(beforeRow.workspaceId) !== request.workspaceId) {
        throw new Error(
          'User application variable value workspace mismatch on existing row',
        );
      }

      if (encryptedValue === null && !beforeRow) {
        return;
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);

      if (encryptedValue === null) {
        const resourceId = uuid(beforeRow!.id);
        await runner.query(
          `DELETE FROM core."userApplicationVariableValue" WHERE id=$1 AND "workspaceId"=$2`,
          [resourceId, request.workspaceId],
        );
        const [remaining] = await runner.query(
          `SELECT id FROM core."userApplicationVariableValue" WHERE id=$1`,
          [resourceId],
        );
        if (remaining) {
          throw new Error(
            'User application variable value delete did not remove row',
          );
        }

        audit.record({
          resourceKind: 'userApplicationVariableValue',
          resourceId,
          action: 'delete',
          before: projectUserApplicationVariableValue(beforeRow!),
          after: null,
          securityDescriptor: {
            resourceKind: 'userApplicationVariableValue',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();
        const [postFlush] = await runner.query(
          `SELECT id FROM core."userApplicationVariableValue" WHERE id=$1`,
          [resourceId],
        );
        if (postFlush) {
          throw new Error(
            'User application variable value state changed during audit flush',
          );
        }
        return;
      }

      const [upserted] = await runner.query(
        `INSERT INTO core."userApplicationVariableValue" ("id","workspaceId","applicationVariableId","userWorkspaceId","scope","value","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$3,'USER',$4,now(),now())
         ON CONFLICT ("applicationVariableId","userWorkspaceId") DO UPDATE SET
           "value"=EXCLUDED."value",
           "updatedAt"=now()
         RETURNING to_jsonb("userApplicationVariableValue") AS row`,
        [
          request.workspaceId,
          normalizedVariableId,
          normalizedUserWorkspaceId,
          encryptedValue,
        ],
      );
      if (!upserted?.row) {
        throw new Error(
          'User application variable value upsert did not return row',
        );
      }
      const afterRow = upserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        uuid(afterRow.applicationVariableId) !== normalizedVariableId ||
        uuid(afterRow.userWorkspaceId) !== normalizedUserWorkspaceId ||
        afterRow.scope !== 'USER' ||
        afterRow.value !== encryptedValue
      ) {
        throw new Error(
          'User application variable value persisted row failed validation',
        );
      }

      const afterProj = projectUserApplicationVariableValue(afterRow);
      if (!beforeRow) {
        audit.record({
          resourceKind: 'userApplicationVariableValue',
          resourceId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'userApplicationVariableValue',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      } else {
        const beforeProj = projectUserApplicationVariableValue(beforeRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'userApplicationVariableValue',
            resourceId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'userApplicationVariableValue',
              resourceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }
      }

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(uavv) AS row FROM core."userApplicationVariableValue" uavv WHERE uavv.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'User application variable value state changed during audit flush',
        );
      }
    }),
  );
};

export const runAuditedApplicationDelete = async <TResult>(
  dataSource: DataSource | undefined,
  request: OptionalApplicationDeleteAuditRequest,
  {
    applicationId,
    work,
  }: {
    applicationId: string;
    work: (runner: QueryRunner) => Promise<TResult>;
  },
): Promise<TResult> => {
  if (!dataSource) {
    throw new Error('Application delete audit requires core DataSource');
  }
  const normalizedApplicationId = uuid(applicationId);

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Application delete audit workspace unavailable');
      }

      const [appRow] = await runner.query(
        `SELECT id FROM core.application WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`,
        [normalizedApplicationId, request.workspaceId],
      );
      if (!appRow) {
        throw new Error('Application delete audit application unavailable');
      }

      await assertNoRemainingApplicationRoleOrPermissionMetadata(
        runner,
        request.workspaceId,
        normalizedApplicationId,
      );

      const [reg] = await runner.query(
        `SELECT
           to_regclass('core."applicationAuthorization"') IS NOT NULL AS "hasAuthTable",
           to_regclass('core."publicDomain"') IS NOT NULL AS "hasPublicDomainTable"`,
      );
      const hasAuthTable = reg?.hasAuthTable === true;
      const hasPublicDomainTable = reg?.hasPublicDomainTable === true;

      const beforeAuthorizations = new Map<string, Record<string, unknown>>();
      if (hasAuthTable) {
        const authRows = await runner.query(
          `SELECT to_jsonb(aa) AS row FROM core."applicationAuthorization" aa WHERE aa."applicationId"=$1 ORDER BY aa.id FOR UPDATE`,
          [normalizedApplicationId],
        );
        for (const entry of authRows) {
          const row = entry.row as Record<string, unknown>;
          if (uuid(row.workspaceId) !== request.workspaceId) {
            throw new Error(
              'Application delete audit detected cross-workspace applicationAuthorization',
            );
          }
          beforeAuthorizations.set(uuid(row.id), row);
        }
      }

      const beforePublicDomains = new Map<string, Record<string, unknown>>();
      if (hasPublicDomainTable) {
        const publicDomainRows = await runner.query(
          `SELECT to_jsonb(pd) AS row FROM core."publicDomain" pd WHERE pd."applicationId"=$1 ORDER BY pd.id FOR UPDATE`,
          [normalizedApplicationId],
        );
        for (const entry of publicDomainRows) {
          const row = entry.row as Record<string, unknown>;
          if (uuid(row.workspaceId) !== request.workspaceId) {
            throw new Error(
              'Application delete audit detected cross-workspace publicDomain',
            );
          }
          beforePublicDomains.set(uuid(row.id), row);
        }
      }

      const hasCascadedAuditRows =
        beforeAuthorizations.size > 0 || beforePublicDomains.size > 0;

      if (hasCascadedAuditRows && !request.operation) {
        throw (
          request.captureError ??
          new Error(
            'Application authorization mutation requires authenticated audit identity',
          )
        );
      }

      let audit: CrmAuditTransactionContext | undefined;
      if (hasCascadedAuditRows && request.operation) {
        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        audit = new CrmAuditTransactionContext(runner, operation);
      }

      const result = await work(runner);

      const [remainingApp] = await runner.query(
        `SELECT id FROM core.application WHERE id=$1`,
        [normalizedApplicationId],
      );
      if (remainingApp) {
        throw new Error('Application delete did not remove application row');
      }

      if (hasAuthTable) {
        const remainingAuth = await runner.query(
          `SELECT id FROM core."applicationAuthorization" WHERE "applicationId"=$1`,
          [normalizedApplicationId],
        );
        if (remainingAuth.length > 0) {
          throw new Error(
            'Application delete did not cascade-remove applicationAuthorization rows',
          );
        }
      }

      if (hasPublicDomainTable) {
        const remainingPublicDomains = await runner.query(
          `SELECT id FROM core."publicDomain" WHERE "applicationId"=$1`,
          [normalizedApplicationId],
        );
        if (remainingPublicDomains.length > 0) {
          throw new Error(
            'Application delete did not cascade-remove publicDomain rows',
          );
        }
      }

      if (audit && hasCascadedAuditRows) {
        for (const [id, beforeRow] of beforeAuthorizations.entries()) {
          audit.record({
            resourceKind: 'applicationAuthorization',
            resourceId: id,
            action: 'delete',
            before: projectApplicationAuthorization(beforeRow),
            after: null,
            securityDescriptor: {
              resourceKind: 'applicationAuthorization',
              resourceId: id,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }
        for (const [id, beforeRow] of beforePublicDomains.entries()) {
          audit.record({
            resourceKind: 'publicDomain',
            resourceId: id,
            action: 'delete',
            before: projectPublicDomain(beforeRow),
            after: null,
            securityDescriptor: {
              resourceKind: 'publicDomain',
              resourceId: id,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }
        await audit.flush();
        if (hasAuthTable) {
          const postFlushAuth = await runner.query(
            `SELECT id FROM core."applicationAuthorization" WHERE "applicationId"=$1`,
            [normalizedApplicationId],
          );
          if (postFlushAuth.length > 0) {
            throw new Error(
              'Application authorization state changed during audit flush',
            );
          }
        }
        if (hasPublicDomainTable) {
          const postFlushPublicDomains = await runner.query(
            `SELECT id FROM core."publicDomain" WHERE "applicationId"=$1`,
            [normalizedApplicationId],
          );
          if (postFlushPublicDomains.length > 0) {
            throw new Error('Public domain state changed during audit flush');
          }
        }
      }

      return result;
    }),
  );
};

export const runAuditedApplicationVariableUpdate = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  {
    applicationId,
    callingApplicationId,
    key,
    encryptedValue,
  }: {
    applicationId: string;
    callingApplicationId?: string;
    key: string;
    encryptedValue: string;
  },
): Promise<{ status: 'updated' | 'not_found' | 'user_variable' }> => {
  if (!dataSource) {
    throw new Error('Application variable audit requires core DataSource');
  }
  const normalizedApplicationId = uuid(applicationId);
  const normalizedCallingApplicationId =
    callingApplicationId !== undefined ? uuid(callingApplicationId) : undefined;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Application variable key is invalid');
  }
  if (
    typeof encryptedValue !== 'string' ||
    !encryptedValue.startsWith('enc:v2:')
  ) {
    throw new Error(
      'Application variable encryptedValue must use enc:v2 envelope',
    );
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Application variable audit workspace unavailable');
      }

      if (
        (normalizedCallingApplicationId !== undefined &&
          normalizedCallingApplicationId !== normalizedApplicationId) ||
        (request.operation.actor.kind === 'application' &&
          uuid(request.operation.actor.id) !== normalizedApplicationId)
      ) {
        throw new Error(
          'Application variable audit cannot target another application',
        );
      }

      const [application] = await runner.query(
        `SELECT id,to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
        [normalizedApplicationId, request.workspaceId],
      );
      if (!application || application.deletedAt !== null) {
        return { status: 'not_found' as const };
      }

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(av) AS row FROM core."applicationVariable" av WHERE av."applicationId"=$1 AND av.key=$2 FOR UPDATE`,
        [normalizedApplicationId, key],
      );
      const beforeRow = beforeEntry?.row as Record<string, unknown> | undefined;
      if (!beforeRow) {
        return { status: 'not_found' as const };
      }
      if (uuid(beforeRow.workspaceId) !== request.workspaceId) {
        throw new Error(
          'Application variable workspace mismatch on existing row',
        );
      }
      if (beforeRow.scope === 'USER') {
        return { status: 'user_variable' as const };
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);

      const resourceId = uuid(beforeRow.id);
      const rawUpdated = await runner.query(
        `UPDATE core."applicationVariable"
         SET "value"=$1, "updatedAt"=now()
         WHERE id=$2 AND "workspaceId"=$3 AND "applicationId"=$4 AND scope <> 'USER'
         RETURNING to_jsonb("applicationVariable") AS row`,
        [
          encryptedValue,
          resourceId,
          request.workspaceId,
          normalizedApplicationId,
        ],
      );
      const updatedRows = Array.isArray(rawUpdated?.[0])
        ? rawUpdated[0]
        : rawUpdated;
      const updated = updatedRows?.[0];
      if (!updated?.row) {
        throw new Error('Application variable update did not return row');
      }
      const afterRow = updated.row as Record<string, unknown>;
      if (
        uuid(afterRow.id) !== resourceId ||
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        uuid(afterRow.applicationId) !== normalizedApplicationId ||
        afterRow.key !== key ||
        afterRow.scope !== beforeRow.scope ||
        afterRow.scope === 'USER' ||
        afterRow.value !== encryptedValue ||
        canonicalAuditJson({
          ...scalarWithoutTimestamps(beforeRow),
          value: encryptedValue,
        }) !== canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        throw new Error('Application variable persisted row failed validation');
      }

      const beforeProj = projectApplicationVariable(beforeRow);
      const afterProj = projectApplicationVariable(afterRow);
      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        audit.record({
          resourceKind: 'applicationVariable',
          resourceId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'applicationVariable',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(av) AS row FROM core."applicationVariable" av WHERE av.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error(
          'Application variable state changed during audit flush',
        );
      }

      return { status: 'updated' as const };
    }),
  );
};

export const runAuditedFeatureFlagUpsert = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  {
    key,
    value,
  }: {
    key: string;
    value: boolean;
  },
): Promise<{ row: Record<string, unknown>; mutated: boolean }> => {
  if (!dataSource) {
    throw new Error('Feature flag audit requires core DataSource');
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new Error('Feature flag key is invalid');
  }
  if (typeof value !== 'boolean') {
    throw new Error('Feature flag value must be boolean');
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Feature flag audit workspace unavailable');
      }

      const [beforeEntry] = await runner.query(
        `SELECT to_jsonb(ff) AS row FROM core."featureFlag" ff WHERE ff."workspaceId"=$1 AND ff.key=$2 FOR UPDATE`,
        [request.workspaceId, key],
      );
      const beforeRow = beforeEntry?.row as Record<string, unknown> | undefined;
      if (beforeRow && uuid(beforeRow.workspaceId) !== request.workspaceId) {
        throw new Error('Feature flag workspace mismatch on existing row');
      }

      if (beforeRow && Boolean(beforeRow.value) === value) {
        return { row: beforeRow, mutated: false };
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);

      const [upserted] = await runner.query(
        `INSERT INTO core."featureFlag" ("id","workspaceId","key","value","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$3,now(),now())
         ON CONFLICT ("key","workspaceId") DO UPDATE SET
           "value"=EXCLUDED."value",
           "updatedAt"=now()
         RETURNING to_jsonb("featureFlag") AS row`,
        [request.workspaceId, key, value],
      );
      if (!upserted?.row) {
        throw new Error('Feature flag upsert did not return row');
      }
      const afterRow = upserted.row as Record<string, unknown>;
      const resourceId = uuid(afterRow.id);
      if (
        uuid(afterRow.workspaceId) !== request.workspaceId ||
        afterRow.key !== key ||
        afterRow.value !== value ||
        (beforeRow && uuid(beforeRow.id) !== resourceId)
      ) {
        throw new Error('Feature flag persisted row failed validation');
      }

      const afterProj = projectFeatureFlag(afterRow);
      if (!beforeRow) {
        audit.record({
          resourceKind: 'featureFlag',
          resourceId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'featureFlag',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      } else {
        audit.record({
          resourceKind: 'featureFlag',
          resourceId,
          action: 'update',
          before: projectFeatureFlag(beforeRow),
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'featureFlag',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }

      const expectedSerialized = canonicalAuditJson(
        scalarWithoutTimestamps(afterRow),
      );
      await audit.flush();
      const [postFlush] = await runner.query(
        `SELECT to_jsonb(ff) AS row FROM core."featureFlag" ff WHERE ff.id=$1`,
        [resourceId],
      );
      if (
        !postFlush?.row ||
        canonicalAuditJson(
          scalarWithoutTimestamps(postFlush.row as Record<string, unknown>),
        ) !== expectedSerialized
      ) {
        throw new Error('Feature flag state changed during audit flush');
      }

      return { row: afterRow, mutated: true };
    }),
  );
};

export const runAuditedFeatureFlagsEnable = async (
  dataSource: DataSource | undefined,
  request: ApplicationAuthorizationAuditRequest,
  {
    keys,
  }: {
    keys: readonly string[];
  },
): Promise<boolean> => {
  if (!dataSource) {
    throw new Error('Feature flag audit requires core DataSource');
  }
  const uniqueKeys = [...new Set(keys.map(String))].sort();
  if (uniqueKeys.length === 0) {
    return false;
  }
  for (const key of uniqueKeys) {
    if (key.length === 0 || key.length > 256) {
      throw new Error('Feature flag key is invalid');
    }
  }

  return withExclusiveAuditScope(request, () =>
    runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null) {
        throw new Error('Feature flag audit workspace unavailable');
      }

      const existingRows = await runner.query(
        `SELECT to_jsonb(ff) AS row FROM core."featureFlag" ff WHERE ff."workspaceId"=$1 AND ff.key=ANY($2::text[]) ORDER BY ff.id FOR UPDATE`,
        [request.workspaceId, uniqueKeys],
      );
      const beforeByKey = new Map<string, Record<string, unknown>>();
      for (const entry of existingRows) {
        const row = entry.row as Record<string, unknown>;
        if (uuid(row.workspaceId) !== request.workspaceId) {
          throw new Error('Feature flag workspace mismatch on existing row');
        }
        beforeByKey.set(String(row.key), row);
      }

      const keysToEnable = uniqueKeys.filter((key) => {
        const beforeRow = beforeByKey.get(key);
        return !beforeRow || Boolean(beforeRow.value) !== true;
      });
      if (keysToEnable.length === 0) {
        return false;
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      const expectedAfterById = new Map<string, string>();

      for (const key of keysToEnable) {
        const beforeRow = beforeByKey.get(key);
        const [upserted] = await runner.query(
          `INSERT INTO core."featureFlag" ("id","workspaceId","key","value","createdAt","updatedAt")
           VALUES (gen_random_uuid(),$1,$2,true,now(),now())
           ON CONFLICT ("key","workspaceId") DO UPDATE SET
             "value"=true,
             "updatedAt"=now()
           RETURNING to_jsonb("featureFlag") AS row`,
          [request.workspaceId, key],
        );
        if (!upserted?.row) {
          throw new Error('Feature flag enable upsert did not return row');
        }
        const afterRow = upserted.row as Record<string, unknown>;
        const resourceId = uuid(afterRow.id);
        if (
          uuid(afterRow.workspaceId) !== request.workspaceId ||
          afterRow.key !== key ||
          afterRow.value !== true ||
          (beforeRow && uuid(beforeRow.id) !== resourceId)
        ) {
          throw new Error('Feature flag persisted row failed validation');
        }

        expectedAfterById.set(
          resourceId,
          canonicalAuditJson(scalarWithoutTimestamps(afterRow)),
        );

        const afterProj = projectFeatureFlag(afterRow);
        if (!beforeRow) {
          audit.record({
            resourceKind: 'featureFlag',
            resourceId,
            action: 'create',
            before: null,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'featureFlag',
              resourceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        } else {
          audit.record({
            resourceKind: 'featureFlag',
            resourceId,
            action: 'update',
            before: projectFeatureFlag(beforeRow),
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'featureFlag',
              resourceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }
      }

      await audit.flush();
      const postFlushRows = await runner.query(
        `SELECT to_jsonb(ff) AS row FROM core."featureFlag" ff WHERE ff.id=ANY($1::uuid[]) ORDER BY ff.id`,
        [[...expectedAfterById.keys()]],
      );
      if (postFlushRows.length !== expectedAfterById.size) {
        throw new Error('Feature flag state changed during audit flush');
      }
      for (const entry of postFlushRows) {
        const row = entry.row as Record<string, unknown>;
        const id = uuid(row.id);
        if (
          canonicalAuditJson(scalarWithoutTimestamps(row)) !==
          expectedAfterById.get(id)
        ) {
          throw new Error('Feature flag state changed during audit flush');
        }
      }

      return true;
    }),
  );
};
