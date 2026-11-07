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

const storage = new AsyncLocalStorage<WorkspaceDefaultRoleAuditRequest>();
const active = new WeakSet<WorkspaceDefaultRoleAuditRequest>();
const consumed = new WeakSet<WorkspaceDefaultRoleAuditRequest>();

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

export const runAuditedWorkspaceDefaultRoleUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: WorkspaceDefaultRoleAuditRequest,
  defaultRoleId: string | null | undefined,
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

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const readWorkspace = () =>
          runner.query(
            `SELECT id,to_jsonb(w)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
            [request.workspaceId],
          );
        const [beforeWorkspace] = await readWorkspace();
        if (!beforeWorkspace || beforeWorkspace.deletedAt !== null) {
          throw new Error('Workspace default role audit workspace unavailable');
        }
        const beforeDefaultRoleId = nullableUuid(beforeWorkspace.defaultRoleId);

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

        const verifyState = async (stage: 'update' | 'flush') => {
          const [afterWorkspace] = await readWorkspace();
          if (
            !afterWorkspace ||
            afterWorkspace.deletedAt !== null ||
            nullableUuid(afterWorkspace.defaultRoleId) !==
              normalizedDefaultRoleId
          ) {
            throw new Error(
              stage === 'update'
                ? 'Workspace default role update did not persist expected value'
                : 'Workspace default role state changed during audit flush',
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

        if (beforeDefaultRoleId !== normalizedDefaultRoleId) {
          audit.record({
            resourceKind: 'workspace',
            resourceId: request.workspaceId,
            action: 'update',
            before: { defaultRoleId: beforeDefaultRoleId },
            after: { defaultRoleId: normalizedDefaultRoleId },
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
