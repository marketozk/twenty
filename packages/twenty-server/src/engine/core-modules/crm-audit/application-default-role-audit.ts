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

export const runAuditedApplicationDefaultRoleUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: ApplicationDefaultRoleAuditRequest,
  defaultRoleId: string | null | undefined,
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

        const readApplication = () =>
          runner.query(
            `SELECT id,"workspaceId","universalIdentifier",to_jsonb(a)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`,
            [request.applicationId, request.workspaceId],
          );
        const [beforeApplication] = await readApplication();
        if (!beforeApplication || beforeApplication.deletedAt !== null) {
          throw new Error(
            'Application default role audit application unavailable',
          );
        }
        const beforeDefaultRoleId = nullableUuid(
          beforeApplication.defaultRoleId,
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

        const verifyState = async (stage: 'update' | 'flush') => {
          const [afterApplication] = await readApplication();
          if (
            !afterApplication ||
            afterApplication.deletedAt !== null ||
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

        if (beforeDefaultRoleId !== normalizedDefaultRoleId) {
          audit.record({
            resourceKind: 'application',
            resourceId: request.applicationId,
            action: 'update',
            before: { defaultRoleId: beforeDefaultRoleId },
            after: { defaultRoleId: normalizedDefaultRoleId },
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
