import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
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

export type ApplicationDefaultRoleAuditIdentity =
  | RoleUpdateAuditIdentity
  | MembershipCleanupIdentity;

export type ApplicationDefaultRoleAuditRequest = Readonly<{
  workspaceId: string;
  applicationId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type ApplicationSettingsAuditRequest =
  ApplicationDefaultRoleAuditRequest;

export const APPLICATION_AUDIT_UUID_KEYS = new Set([
  'defaultRoleId',
  'settingsCustomTabFrontComponentId',
  'uninstallLogicFunctionId',
  'healthCheckLogicFunctionId',
]);

export const APPLICATION_AUDIT_BOOLEAN_KEYS = new Set(['autoUpgrade']);

export const APPLICATION_AUDIT_ARRAY_KEYS = new Set(['grantedCapabilities']);

export const APPLICATION_AUDIT_ALL_KEYS = new Set<string>([
  ...APPLICATION_AUDIT_UUID_KEYS,
  ...APPLICATION_AUDIT_BOOLEAN_KEYS,
  ...APPLICATION_AUDIT_ARRAY_KEYS,
]);

export const APPLICATION_AUDIT_NON_ROLE_KEYS = new Set<string>([
  'settingsCustomTabFrontComponentId',
  'uninstallLogicFunctionId',
  'healthCheckLogicFunctionId',
  'autoUpgrade',
  'grantedCapabilities',
]);

const storage = new AsyncLocalStorage<ApplicationDefaultRoleAuditRequest>();
const active = new WeakSet<ApplicationDefaultRoleAuditRequest>();
const consumed = new WeakSet<ApplicationDefaultRoleAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Application default role audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const projectApplicationAuditFields = (
  row: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (!APPLICATION_AUDIT_ALL_KEYS.has(key)) {
      continue;
    }
    const raw = row[key];
    if (APPLICATION_AUDIT_UUID_KEYS.has(key)) {
      projected[key] = nullableUuid(raw);
    } else if (APPLICATION_AUDIT_BOOLEAN_KEYS.has(key)) {
      projected[key] = raw === undefined || raw === null ? false : Boolean(raw);
    } else if (APPLICATION_AUDIT_ARRAY_KEYS.has(key)) {
      projected[key] = Array.isArray(raw)
        ? [...new Set(raw.map((item) => String(item)))].sort()
        : [];
    }
  }

  return projected;
};

export const getApplicationDefaultRoleAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Application default role audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getApplicationDefaultRoleAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: ApplicationDefaultRoleAuditIdentity | undefined,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
  if (identity !== undefined) {
    if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      if ((identity as MembershipCleanupIdentity).workspaceId === undefined) {
        throw new Error('CRM audit context requires scoped identity');
      }
      const operation = membershipCleanupOperation(
        normalizedWorkspaceId,
        identity as MembershipCleanupIdentity,
      );
      if (!operation) {
        throw new Error('Role mutation requires authenticated audit identity');
      }

      return { operation };
    }

    const capturedIdentity = captureRoleAuditIdentity(
      identity as RoleUpdateAuditIdentity,
    );
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
    throw new Error('Role mutation requires authenticated audit identity');
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

export const captureApplicationDefaultRoleAudit = ({
  workspaceId,
  applicationId,
  auditIdentity,
}: {
  workspaceId: string;
  applicationId: string;
  auditIdentity?: ApplicationDefaultRoleAuditIdentity;
}): (() => ApplicationDefaultRoleAuditRequest) => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedApplicationId = uuid(applicationId);
  if (
    getApplicationDefaultRoleAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested application default role audit is unsupported');
  }

  try {
    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );
    const request: ApplicationDefaultRoleAuditRequest = Object.freeze({
      workspaceId: normalizedWorkspaceId,
      applicationId: normalizedApplicationId,
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    });

    return () => request;
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const captureApplicationSettingsAudit =
  captureApplicationDefaultRoleAudit;

export const runAuditedApplicationDefaultRoleUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: ApplicationDefaultRoleAuditRequest,
  defaultRoleId: string | null | undefined,
  work: (runner: QueryRunner) => Promise<TResult>,
  changedKeys: readonly string[] = ['defaultRoleId'],
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getApplicationDefaultRoleAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getApplicationDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested application default role audit is unsupported');
  }
  if (!dataSource) {
    throw new Error(
      'Application default role update audit requires core DataSource',
    );
  }
  if (
    defaultRoleId !== null &&
    (typeof defaultRoleId !== 'string' || !isUUID(defaultRoleId))
  ) {
    throw new Error(
      'Application default role is unavailable or not owned by application',
    );
  }
  const normalizedDefaultRoleId =
    defaultRoleId === null ? null : defaultRoleId.toLowerCase();
  const keysToProject = [
    ...new Set([
      'defaultRoleId',
      ...changedKeys.filter((key) => APPLICATION_AUDIT_ALL_KEYS.has(key)),
    ]),
  ];

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const [workspace] = await runner.query(
          `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
          [request.workspaceId],
        );
        if (!workspace || workspace.deletedAt !== null) {
          throw new Error(
            'Application default role audit workspace unavailable',
          );
        }

        const readApplication = async (): Promise<
          Record<string, unknown> | undefined
        > => {
          const [entry] = await runner.query(
            `SELECT to_jsonb(a) AS row FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`,
            [request.applicationId, request.workspaceId],
          );

          return entry?.row as Record<string, unknown> | undefined;
        };
        const beforeApplication = await readApplication();
        if (
          !beforeApplication ||
          (beforeApplication.deletedAt !== undefined &&
            beforeApplication.deletedAt !== null)
        ) {
          throw new Error(
            'Application default role audit application unavailable',
          );
        }
        const beforeProjected = projectApplicationAuditFields(
          beforeApplication,
          keysToProject,
        );
        const applicationUniversalIdentifier = uuid(
          beforeApplication.universalIdentifier,
        );

        let targetRole: Record<string, unknown> | undefined;
        if (normalizedDefaultRoleId !== null) {
          const roleRows = await runner.query(
            'SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
            [normalizedDefaultRoleId, request.workspaceId],
          );
          targetRole = roleRows[0]?.row;
          if (
            roleRows.length !== 1 ||
            !targetRole ||
            uuid(targetRole.applicationId) !== request.applicationId
          ) {
            throw new Error(
              'Application default role is unavailable or not owned by application',
            );
          }
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
          const afterApplication = await readApplication();
          if (
            !afterApplication ||
            (afterApplication.deletedAt !== undefined &&
              afterApplication.deletedAt !== null) ||
            uuid(afterApplication.universalIdentifier) !==
              applicationUniversalIdentifier ||
            nullableUuid(afterApplication.defaultRoleId) !==
              normalizedDefaultRoleId
          ) {
            throw new Error(
              stage === 'update'
                ? 'Application default role update did not persist expected value'
                : 'Application default role state changed during audit flush',
            );
          }
          const currentProjected = projectApplicationAuditFields(
            afterApplication,
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
              'Application default role state changed during audit flush',
            );
          }
          if (normalizedDefaultRoleId !== null) {
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
                'Application default role state changed during audit flush',
              );
            }
          }
        };

        await verifyState('update');

        if (
          expectedProjected &&
          canonicalAuditJson(beforeProjected) !==
            canonicalAuditJson(expectedProjected)
        ) {
          audit.record({
            resourceKind: 'application',
            resourceId: request.applicationId,
            action: 'update',
            before: beforeProjected,
            after: expectedProjected,
            securityDescriptor: {
              resourceKind: 'application',
              resourceId: request.applicationId,
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

export const runAuditedApplicationSettingsUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: ApplicationSettingsAuditRequest,
  changedKeys: readonly string[],
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getApplicationDefaultRoleAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getApplicationDefaultRoleAudit,
    )
  ) {
    throw new Error('Nested application default role audit is unsupported');
  }
  if (!dataSource) {
    throw new Error(
      'Application settings update audit requires core DataSource',
    );
  }
  const keysToProject = [
    ...new Set(
      changedKeys.filter((key) => APPLICATION_AUDIT_ALL_KEYS.has(key)),
    ),
  ];

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const [workspace] = await runner.query(
          `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
          [request.workspaceId],
        );
        if (!workspace || workspace.deletedAt !== null) {
          throw new Error(
            'Application default role audit workspace unavailable',
          );
        }

        const readApplication = async (): Promise<
          Record<string, unknown> | undefined
        > => {
          const [entry] = await runner.query(
            `SELECT to_jsonb(a) AS row FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`,
            [request.applicationId, request.workspaceId],
          );

          return entry?.row as Record<string, unknown> | undefined;
        };
        const beforeApplication = await readApplication();
        if (
          !beforeApplication ||
          (beforeApplication.deletedAt !== undefined &&
            beforeApplication.deletedAt !== null)
        ) {
          throw new Error(
            'Application default role audit application unavailable',
          );
        }
        const beforeProjected = projectApplicationAuditFields(
          beforeApplication,
          keysToProject,
        );
        const applicationUniversalIdentifier = uuid(
          beforeApplication.universalIdentifier,
        );

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        const result = await work(runner);

        const afterApplication = await readApplication();
        if (
          !afterApplication ||
          (afterApplication.deletedAt !== undefined &&
            afterApplication.deletedAt !== null) ||
          uuid(afterApplication.universalIdentifier) !==
            applicationUniversalIdentifier
        ) {
          throw new Error(
            'Application default role audit application unavailable',
          );
        }
        const afterProjected = projectApplicationAuditFields(
          afterApplication,
          keysToProject,
        );

        if (
          keysToProject.length > 0 &&
          canonicalAuditJson(beforeProjected) !==
            canonicalAuditJson(afterProjected)
        ) {
          audit.record({
            resourceKind: 'application',
            resourceId: request.applicationId,
            action: 'update',
            before: beforeProjected,
            after: afterProjected,
            securityDescriptor: {
              resourceKind: 'application',
              resourceId: request.applicationId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          await audit.flush();
          const postFlushApplication = await readApplication();
          if (
            !postFlushApplication ||
            (postFlushApplication.deletedAt !== undefined &&
              postFlushApplication.deletedAt !== null) ||
            uuid(postFlushApplication.universalIdentifier) !==
              applicationUniversalIdentifier ||
            canonicalAuditJson(
              projectApplicationAuditFields(
                postFlushApplication,
                keysToProject,
              ),
            ) !== canonicalAuditJson(afterProjected)
          ) {
            throw new Error(
              'Application settings state changed during audit flush',
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
