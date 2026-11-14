import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  registerMetadataAuditScopeCheck,
  resolveRoleAuditInitiator,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type WorkspaceDefaultRoleAuditRequest = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type WorkspaceSettingsAuditRequest = WorkspaceDefaultRoleAuditRequest;

const storage = new AsyncLocalStorage<WorkspaceDefaultRoleAuditRequest>();
const active = new WeakSet<WorkspaceDefaultRoleAuditRequest>();
const consumed = new WeakSet<WorkspaceDefaultRoleAuditRequest>();

export const WORKSPACE_AUDIT_UUID_KEYS = new Set([
  'defaultRoleId',
  'logoFileId',
]);

export const WORKSPACE_AUDIT_BOOLEAN_KEYS = new Set([
  'allowImpersonation',
  'isPublicInviteLinkEnabled',
  'isCampaignClickTrackingEnabled',
  'isCampaignOpenTrackingEnabled',
  'isGoogleAuthEnabled',
  'isGoogleAuthBypassEnabled',
  'isTwoFactorAuthenticationEnforced',
  'isPasswordAuthEnabled',
  'isPasswordAuthBypassEnabled',
  'isMicrosoftAuthEnabled',
  'isMicrosoftAuthBypassEnabled',
  'isCustomDomainEnabled',
  'isInternalMessagesImportEnabled',
  'isAutoModelSelectionEnabled',
]);

export const WORKSPACE_AUDIT_NUMBER_KEYS = new Set([
  'trashRetentionDays',
  'eventLogRetentionDays',
]);

export const WORKSPACE_AUDIT_ARRAY_KEYS = new Set([
  'allowedIframeOrigins',
  'editableProfileFields',
]);

export const WORKSPACE_AUDIT_JSON_KEYS = new Set(['aiModelIdByTier']);

export const WORKSPACE_AUDIT_STRING_KEYS = new Set([
  'workspaceDiscoverability',
  'aiChatModelTier',
  'aiAgentModelTier',
  'aiEvaluationModelId',
  'displayName',
  'subdomain',
  'customDomain',
  'logo',
  'inviteHash',
  'aiAdditionalInstructions',
]);

export const WORKSPACE_AUDIT_ALL_KEYS = new Set<string>([
  ...WORKSPACE_AUDIT_UUID_KEYS,
  ...WORKSPACE_AUDIT_BOOLEAN_KEYS,
  ...WORKSPACE_AUDIT_NUMBER_KEYS,
  ...WORKSPACE_AUDIT_ARRAY_KEYS,
  ...WORKSPACE_AUDIT_JSON_KEYS,
  ...WORKSPACE_AUDIT_STRING_KEYS,
]);

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Workspace default role audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const projectWorkspaceAuditFields = (
  row: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (!WORKSPACE_AUDIT_ALL_KEYS.has(key)) {
      continue;
    }
    const raw = row[key];
    if (WORKSPACE_AUDIT_UUID_KEYS.has(key)) {
      projected[key] = nullableUuid(raw);
    } else if (WORKSPACE_AUDIT_BOOLEAN_KEYS.has(key)) {
      projected[key] = raw === undefined || raw === null ? null : Boolean(raw);
    } else if (WORKSPACE_AUDIT_NUMBER_KEYS.has(key)) {
      projected[key] = raw === undefined || raw === null ? null : Number(raw);
    } else if (WORKSPACE_AUDIT_ARRAY_KEYS.has(key)) {
      projected[key] = Array.isArray(raw)
        ? raw.map((item) => String(item))
        : raw === null
          ? null
          : [];
    } else if (WORKSPACE_AUDIT_JSON_KEYS.has(key)) {
      projected[key] =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : {};
    } else {
      projected[key] = raw === undefined || raw === null ? null : String(raw);
    }
  }

  return projected;
};

export const getWorkspaceDefaultRoleAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Workspace default role audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getWorkspaceDefaultRoleAudit);

export const captureWorkspaceDefaultRoleAudit = (
  workspaceId: string,
  identity: RoleUpdateAuditIdentity | undefined,
): (() => WorkspaceDefaultRoleAuditRequest) => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getWorkspaceDefaultRoleAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getWorkspaceDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested workspace default role audit is unsupported');
  }

  try {
    const capturedIdentity = captureRoleAuditIdentity(
      identity as RoleUpdateAuditIdentity,
    );
    const operation = captureRoleAuditOperation(
      normalizedWorkspaceId,
      capturedIdentity,
    );
    const request: WorkspaceDefaultRoleAuditRequest = Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operation,
      ...(capturedIdentity.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              capturedIdentity.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    });

    return () => request;
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const captureWorkspaceSettingsAudit = captureWorkspaceDefaultRoleAudit;

export const runAuditedWorkspaceDefaultRoleUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: WorkspaceDefaultRoleAuditRequest,
  defaultRoleId: string | null | undefined,
  work: (runner: QueryRunner) => Promise<TResult>,
  changedKeys: readonly string[] = ['defaultRoleId'],
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getWorkspaceDefaultRoleAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getWorkspaceDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested workspace default role audit is unsupported');
  }
  if (!dataSource) {
    throw new Error(
      'Workspace default role update audit requires core DataSource',
    );
  }
  if (typeof defaultRoleId !== 'string' || !isUUID(defaultRoleId)) {
    throw new Error(
      'Workspace default role is unavailable or not assignable to users',
    );
  }
  const normalizedDefaultRoleId = defaultRoleId.toLowerCase();
  const keysToProject = [
    ...new Set([
      'defaultRoleId',
      ...changedKeys.filter((key) => WORKSPACE_AUDIT_ALL_KEYS.has(key)),
    ]),
  ];

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const readWorkspace = async (): Promise<
          Record<string, unknown> | undefined
        > => {
          const [entry] = await runner.query(
            `SELECT to_jsonb(w) AS row FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
            [request.workspaceId],
          );

          return entry?.row as Record<string, unknown> | undefined;
        };
        const beforeWorkspace = await readWorkspace();
        if (
          !beforeWorkspace ||
          (beforeWorkspace.deletedAt !== undefined &&
            beforeWorkspace.deletedAt !== null)
        ) {
          throw new Error('Workspace default role audit workspace unavailable');
        }
        const beforeProjected = projectWorkspaceAuditFields(
          beforeWorkspace,
          keysToProject,
        );

        const roleRows = await runner.query(
          'SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
          [normalizedDefaultRoleId, request.workspaceId],
        );
        const targetRole: Record<string, unknown> | undefined =
          roleRows[0]?.row;
        if (
          roleRows.length !== 1 ||
          !targetRole ||
          targetRole.canBeAssignedToUsers !== true
        ) {
          throw new Error(
            'Workspace default role is unavailable or not assignable to users',
          );
        }

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        const result = await work(runner);

        let expectedProjected: Record<string, unknown> | undefined;

        const verifyState = async (stage: 'update' | 'flush') => {
          const afterWorkspace = await readWorkspace();
          if (
            !afterWorkspace ||
            (afterWorkspace.deletedAt !== undefined &&
              afterWorkspace.deletedAt !== null) ||
            nullableUuid(afterWorkspace.defaultRoleId) !==
              normalizedDefaultRoleId
          ) {
            throw new Error(
              stage === 'update'
                ? 'Workspace default role update did not persist expected value'
                : 'Workspace default role state changed during audit flush',
            );
          }
          const currentProjected = projectWorkspaceAuditFields(
            afterWorkspace,
            keysToProject,
          );
          if (stage === 'update') {
            expectedProjected = currentProjected;
          } else if (
            !expectedProjected ||
            canonicalAuditJson(currentProjected) !==
              canonicalAuditJson(expectedProjected)
          ) {
            throw new Error(
              'Workspace default role state changed during audit flush',
            );
          }
          const currentRoleRows = await runner.query(
            'SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2',
            [normalizedDefaultRoleId, request.workspaceId],
          );
          if (
            currentRoleRows.length !== 1 ||
            canonicalAuditJson(currentRoleRows[0].row) !==
              canonicalAuditJson(targetRole)
          ) {
            throw new Error(
              'Workspace default role state changed during audit flush',
            );
          }
        };

        await verifyState('update');

        if (
          expectedProjected &&
          canonicalAuditJson(beforeProjected) !==
            canonicalAuditJson(expectedProjected)
        ) {
          audit.record({
            resourceKind: 'workspace',
            resourceId: request.workspaceId,
            action: 'update',
            before: beforeProjected,
            after: expectedProjected,
            securityDescriptor: {
              resourceKind: 'workspace',
              resourceId: request.workspaceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          await audit.flush();
          await verifyState('flush');
        }

        return result;
      }),
    );
  } finally {
    active.delete(request);
  }
};

export const runAuditedWorkspaceSettingsUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: WorkspaceSettingsAuditRequest,
  changedKeys: readonly string[],
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getWorkspaceDefaultRoleAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getWorkspaceDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested workspace default role audit is unsupported');
  }
  if (!dataSource) {
    throw new Error('Workspace settings update audit requires core DataSource');
  }
  const keysToProject = [
    ...new Set(changedKeys.filter((key) => WORKSPACE_AUDIT_ALL_KEYS.has(key))),
  ];

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const readWorkspace = async (): Promise<
          Record<string, unknown> | undefined
        > => {
          const [entry] = await runner.query(
            `SELECT to_jsonb(w) AS row FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
            [request.workspaceId],
          );

          return entry?.row as Record<string, unknown> | undefined;
        };
        const beforeWorkspace = await readWorkspace();
        if (
          !beforeWorkspace ||
          (beforeWorkspace.deletedAt !== undefined &&
            beforeWorkspace.deletedAt !== null)
        ) {
          throw new Error('Workspace settings audit workspace unavailable');
        }
        const beforeProjected = projectWorkspaceAuditFields(
          beforeWorkspace,
          keysToProject,
        );

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        const result = await work(runner);

        const afterWorkspace = await readWorkspace();
        if (
          !afterWorkspace ||
          (afterWorkspace.deletedAt !== undefined &&
            afterWorkspace.deletedAt !== null)
        ) {
          throw new Error('Workspace settings audit workspace unavailable');
        }
        const afterProjected = projectWorkspaceAuditFields(
          afterWorkspace,
          keysToProject,
        );

        if (
          keysToProject.length > 0 &&
          canonicalAuditJson(beforeProjected) !==
            canonicalAuditJson(afterProjected)
        ) {
          audit.record({
            resourceKind: 'workspace',
            resourceId: request.workspaceId,
            action: 'update',
            before: beforeProjected,
            after: afterProjected,
            securityDescriptor: {
              resourceKind: 'workspace',
              resourceId: request.workspaceId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          await audit.flush();
          const postFlushWorkspace = await readWorkspace();
          if (
            !postFlushWorkspace ||
            (postFlushWorkspace.deletedAt !== undefined &&
              postFlushWorkspace.deletedAt !== null) ||
            canonicalAuditJson(
              projectWorkspaceAuditFields(postFlushWorkspace, keysToProject),
            ) !== canonicalAuditJson(afterProjected)
          ) {
            throw new Error(
              'Workspace settings state changed during audit flush',
            );
          }
        }

        return result;
      }),
    );
  } finally {
    active.delete(request);
  }
};
