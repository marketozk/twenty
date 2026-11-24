import { randomUUID } from 'node:crypto';

import { type DataSource } from 'typeorm';

import { reportCrmAuditUnavailable } from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type NativeCrmAuditBinding } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID_INPUT_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_QUERY_INPUT',
  'INVALID_ARGS_DATA',
  'INVALID_ARGS_FIRST',
  'INVALID_ARGS_LAST',
  'INVALID_ARGS_FILTER',
  'INVALID_ARG_PERMISSIONS',
  'ARGS_CONFLICT',
  'BAD_REQUEST',
  'UPSERT_MULTIPLE_MATCHING_RECORDS_CONFLICT',
  'TOO_MANY_RECORDS_TO_UPDATE',
]);

const PERMISSION_DENIED_CODES = new Set([
  'PERMISSION_DENIED',
  'METHOD_NOT_ALLOWED',
  'NO_ROLE_FOUND_FOR_USER_WORKSPACE',
  'API_KEY_ROLE_NOT_FOUND',
  'APPLICATION_ROLE_NOT_FOUND',
  'NO_AUTHENTICATION_CONTEXT',
]);

const NON_DENIAL_AUTH_OR_PERMISSION_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'INVALID_INPUT',
  'INVALID_ARG_PERMISSIONS',
  'OBJECT_METADATA_NOT_FOUND_PERMISSIONS',
  'FIELD_METADATA_NOT_FOUND',
  'USER_WORKSPACE_NOT_FOUND',
  'ROLE_NOT_FOUND',
  'WORKSPACE_MEMBER_NOT_FOUND',
]);

const INVALID_NATIVE_ATTRIBUTION_MESSAGES = new Set([
  'Native audit impersonation initiator unavailable',
  'Native audit impersonation context conflict',
  'Native audit workspace mismatch',
  'Native audit impersonation requires a user actor',
  'Native audit operation was already committed',
  'Native audit authUserWorkspaceId unavailable',
  'Native audit userWorkspace mismatch',
  'Untrusted native audit binding',
  'Native audit binding was already consumed',
  'Trusted native audit binding requires system context',
]);

const SQLSTATE_REGEX = /^[0-9A-Z]{5}$/;

type CrmAuditAttemptParam = Parameters<typeof appendCrmAuditAttempt>[2];

export type CrmAuditAttemptClassification = {
  readonly outcome: 'denied' | 'failed';
  readonly reasonCode: string;
};

export type PostRollbackAuditAttemptResult =
  | {
      readonly recorded: true;
      readonly attemptId: string;
      readonly outcome: 'denied' | 'failed';
      readonly reasonCode: string;
    }
  | {
      readonly recorded: false;
      readonly skippedUnknownOutcome?: true;
      readonly skippedInvalidAttribution?: true;
      readonly alertReported?: true;
    };

export type NativePostRollbackWorkspaceTransactionRunner = <T>(
  work: (
    scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  ) => Promise<T>,
  options: {
    commitOutcome: 'strict';
    nativeOwnershipLock: 'none';
  },
) => Promise<T>;

const normalizeUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID_REGEX.test(value)
    ? value.toLowerCase()
    : undefined;

const isInvalidNativeAuditAttributionError = (error: unknown): boolean =>
  error instanceof Error &&
  INVALID_NATIVE_ATTRIBUTION_MESSAGES.has(error.message);

export const classifyCrmAuditAttemptOutcome = (
  error: unknown,
): CrmAuditAttemptClassification => {
  const ctorName =
    error instanceof Error ? error.constructor?.name : undefined;
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : '';

  if (
    (ctorName === 'PermissionsException' &&
      (code === undefined || !NON_DENIAL_AUTH_OR_PERMISSION_CODES.has(code))) ||
    (code !== undefined && PERMISSION_DENIED_CODES.has(code))
  ) {
    return {
      outcome: 'denied',
      reasonCode: 'crm.mutation.permission_denied',
    };
  }

  if (code === 'RLS_VALIDATION_FAILED') {
    return {
      outcome: 'denied',
      reasonCode: 'crm.mutation.rls_denied',
    };
  }

  if (
    (ctorName === 'AuthException' &&
      (code === undefined || !NON_DENIAL_AUTH_OR_PERMISSION_CODES.has(code))) ||
    code === 'FORBIDDEN_EXCEPTION' ||
    code === 'UNAUTHENTICATED'
  ) {
    return {
      outcome: 'denied',
      reasonCode: 'crm.mutation.auth_denied',
    };
  }

  if (
    message.includes('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND') ||
    message.includes('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND')
  ) {
    return {
      outcome: 'denied',
      reasonCode: 'crm.mutation.domain_command_required',
    };
  }

  if (code === 'RECORD_NOT_FOUND') {
    return {
      outcome: 'failed',
      reasonCode: 'crm.mutation.record_not_found',
    };
  }

  if (
    message.startsWith('Merging files from duplicate records') ||
    message.startsWith('Merging records that share the same file') ||
    message.includes('Native audit') ||
    message.includes('Native file') ||
    message.includes('Native delete') ||
    message.includes('Nested public CREATE exceeds native audit coverage')
  ) {
    return {
      outcome: 'failed',
      reasonCode: 'crm.mutation.audit_coverage_rejected',
    };
  }

  if (code !== undefined && INVALID_INPUT_CODES.has(code)) {
    return {
      outcome: 'failed',
      reasonCode: 'crm.mutation.invalid_input',
    };
  }

  if (code === 'INVALID_AUTH_CONTEXT') {
    return {
      outcome: 'failed',
      reasonCode: 'crm.mutation.invalid_auth_context',
    };
  }

  if (
    ctorName === 'TwentyOrmException' ||
    ctorName === 'PostgresException' ||
    ctorName === 'QueryFailedError' ||
    (code !== undefined && SQLSTATE_REGEX.test(code))
  ) {
    return {
      outcome: 'failed',
      reasonCode: 'crm.mutation.database_error',
    };
  }

  return {
    outcome: 'failed',
    reasonCode: 'crm.mutation.execution_failed',
  };
};

export const resolveNativeCrmAttemptTarget = (input: {
  operationName: string;
  args: Record<string, unknown>;
  objectMetadataId: string;
}): {
  readonly action: 'create' | 'update' | 'delete';
  readonly resourceId: string;
  readonly objectMetadataId: string;
} => {
  const objectMetadataId = input.objectMetadataId.toLowerCase();

  switch (input.operationName) {
    case 'createOne': {
      const data = input.args.data as { id?: unknown } | undefined;

      return {
        action: 'create',
        resourceId: normalizeUuid(data?.id) ?? objectMetadataId,
        objectMetadataId,
      };
    }
    case 'createMany':
      return {
        action: 'create',
        resourceId: objectMetadataId,
        objectMetadataId,
      };
    case 'updateOne':
    case 'deleteOne':
    case 'restoreOne':
      return {
        action: 'update',
        resourceId: normalizeUuid(input.args.id) ?? objectMetadataId,
        objectMetadataId,
      };
    case 'updateMany':
    case 'deleteMany':
    case 'restoreMany':
      return {
        action: 'update',
        resourceId: objectMetadataId,
        objectMetadataId,
      };
    case 'destroyOne':
      return {
        action: 'delete',
        resourceId: normalizeUuid(input.args.id) ?? objectMetadataId,
        objectMetadataId,
      };
    case 'destroyMany':
      return {
        action: 'delete',
        resourceId: objectMetadataId,
        objectMetadataId,
      };
    case 'mergeMany': {
      const ids = Array.isArray(input.args.ids) ? input.args.ids : [];
      const index =
        typeof input.args.conflictPriorityIndex === 'number'
          ? input.args.conflictPriorityIndex
          : 0;

      return {
        action: 'delete',
        resourceId: normalizeUuid(ids[index]) ?? objectMetadataId,
        objectMetadataId,
      };
    }
    default:
      return {
        action: 'update',
        resourceId: objectMetadataId,
        objectMetadataId,
      };
  }
};

export const recordPostRollbackNativeCrmAuditAttempt = async (input: {
  runInAuditTransaction: NativePostRollbackWorkspaceTransactionRunner;
  binding: NativeCrmAuditBinding;
  action: 'create' | 'update' | 'delete';
  resourceId: string;
  objectMetadataId: string;
  error: unknown;
}): Promise<PostRollbackAuditAttemptResult> => {
  if (isTransactionUnsafeToRetry(input.error)) {
    reportCrmAuditUnavailable({
      code: 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED',
      loggerContext: 'PostRollbackCrmAudit',
      workspaceId: input.binding.operation.workspaceId,
      operationId: input.binding.operation.operationId,
      resourceKind: 'crmRecord',
      action: input.action,
    });

    return { recorded: false, skippedUnknownOutcome: true };
  }

  if (isInvalidNativeAuditAttributionError(input.error)) {
    return { recorded: false, skippedInvalidAttribution: true };
  }

  const resourceId = normalizeUuid(input.resourceId);
  const objectMetadataId = normalizeUuid(input.objectMetadataId);

  if (!resourceId || !objectMetadataId) {
    return { recorded: false, skippedInvalidAttribution: true };
  }

  let normalizedImpersonator: string | undefined;

  if (input.binding.impersonatorUserWorkspaceId !== undefined) {
    normalizedImpersonator = normalizeUuid(
      input.binding.impersonatorUserWorkspaceId,
    );

    if (
      !normalizedImpersonator ||
      (input.binding.operation.actor.kind !== 'workspaceMember' &&
        input.binding.operation.actor.kind !== 'coreUser')
    ) {
      return { recorded: false, skippedInvalidAttribution: true };
    }
  }

  let normalizedPendingAuthUserWorkspaceId: string | undefined;
  let normalizedPendingAgentId: string | undefined;
  let normalizedPendingExpectedUserId: string | undefined;

  if (input.binding.pendingAuthUserWorkspaceId !== undefined) {
    normalizedPendingAuthUserWorkspaceId = normalizeUuid(
      input.binding.pendingAuthUserWorkspaceId,
    );
    if (!normalizedPendingAuthUserWorkspaceId) {
      return { recorded: false, skippedInvalidAttribution: true };
    }
  }
  if (input.binding.pendingAgentId !== undefined) {
    normalizedPendingAgentId = normalizeUuid(input.binding.pendingAgentId);
    if (!normalizedPendingAgentId) {
      return { recorded: false, skippedInvalidAttribution: true };
    }
  }
  if (input.binding.pendingUserWorkspaceExpectedUserId !== undefined) {
    normalizedPendingExpectedUserId = normalizeUuid(
      input.binding.pendingUserWorkspaceExpectedUserId,
    );
    if (!normalizedPendingExpectedUserId) {
      return { recorded: false, skippedInvalidAttribution: true };
    }
  }

  const classification = classifyCrmAuditAttemptOutcome(input.error);
  const attemptId = randomUUID();

  try {
    let skippedInvalidAttribution = false;

    await input.runInAuditTransaction(
      async (scope) => {
        const executor = createCrmAuditWorkspaceExecutor(scope);

        await executor.query("SET LOCAL lock_timeout = '3s'");
        await executor.query("SET LOCAL statement_timeout = '5s'");

        let operation: CrmAuditOperation = {
          ...input.binding.operation,
          actor: { ...input.binding.operation.actor },
          ...(input.binding.operation.initiator
            ? { initiator: { ...input.binding.operation.initiator } }
            : {}),
        };

        if (normalizedPendingAuthUserWorkspaceId !== undefined) {
          const rows = await executor.query(
            'SELECT "userId" FROM core."userWorkspace" WHERE id = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
            [normalizedPendingAuthUserWorkspaceId, operation.workspaceId],
          );
          const row = rows[0] as { userId?: unknown } | undefined;
          const resolvedUserId = normalizeUuid(row?.userId);

          if (rows.length !== 1 || !resolvedUserId) {
            skippedInvalidAttribution = true;

            return;
          }

          if (
            normalizedPendingExpectedUserId !== undefined &&
            normalizedPendingExpectedUserId !== resolvedUserId
          ) {
            skippedInvalidAttribution = true;

            return;
          }

          if (input.binding.pendingUserWorkspaceActor) {
            operation =
              normalizedPendingAgentId !== undefined
                ? {
                    ...operation,
                    actor: { kind: 'agent', id: normalizedPendingAgentId },
                    initiator: { kind: 'coreUser', id: resolvedUserId },
                  }
                : {
                    ...operation,
                    actor: { kind: 'coreUser', id: resolvedUserId },
                  };
          } else {
            if (
              (operation.actor.kind === 'coreUser' &&
                normalizeUuid(operation.actor.id) !== resolvedUserId) ||
              (operation.initiator?.kind === 'coreUser' &&
                normalizeUuid(operation.initiator.id) !== resolvedUserId)
            ) {
              skippedInvalidAttribution = true;

              return;
            }
            const workspaceMemberPrincipal =
              operation.actor.kind === 'workspaceMember'
                ? operation.actor
                : operation.initiator?.kind === 'workspaceMember'
                  ? operation.initiator
                  : undefined;
            if (workspaceMemberPrincipal !== undefined) {
              const memberId = normalizeUuid(workspaceMemberPrincipal.id);
              const normalizedWorkspace = normalizeUuid(operation.workspaceId);
              if (!memberId || !normalizedWorkspace) {
                skippedInvalidAttribution = true;

                return;
              }
              const workspaceSchema = `workspace_${BigInt('0x' + normalizedWorkspace.replaceAll('-', '')).toString(36)}`;
              const memberRows = await executor.query(
                `SELECT "userId" FROM "${workspaceSchema}"."workspaceMember" WHERE id = $1 AND "deletedAt" IS NULL`,
                [memberId],
              );
              const memberRow = memberRows[0] as
                | { userId?: unknown }
                | undefined;
              if (
                memberRows.length !== 1 ||
                normalizeUuid(memberRow?.userId) !== resolvedUserId
              ) {
                skippedInvalidAttribution = true;

                return;
              }
            }
          }
        }

        if (normalizedImpersonator !== undefined) {
          if (
            operation.actor.kind !== 'workspaceMember' &&
            operation.actor.kind !== 'coreUser'
          ) {
            skippedInvalidAttribution = true;

            return;
          }
          const rows = await executor.query(
            'SELECT "userId" FROM core."userWorkspace" WHERE id = $1 AND "deletedAt" IS NULL',
            [normalizedImpersonator],
          );
          const row = rows[0] as { userId?: unknown } | undefined;
          const resolvedInitiatorId = normalizeUuid(row?.userId);

          if (rows.length !== 1 || !resolvedInitiatorId) {
            skippedInvalidAttribution = true;

            return;
          }

          if (
            operation.initiator &&
            (operation.initiator.kind !== 'coreUser' ||
              normalizeUuid(operation.initiator.id) !== resolvedInitiatorId)
          ) {
            skippedInvalidAttribution = true;

            return;
          }

          operation = {
            ...operation,
            initiator: { kind: 'coreUser', id: resolvedInitiatorId },
          };
        }

        // For action === 'delete' on failed/denied attempts, deletedRecord sets
        // fail-closed admin visibility for ROB-767 without implying deletion occurred.
        const attempt: CrmAuditAttemptParam = {
          attemptId,
          resourceKind: 'crmRecord',
          resourceId,
          action: input.action,
          outcome: classification.outcome,
          reasonCode: classification.reasonCode,
          securityDescriptor: {
            resourceKind: 'crmRecord',
            resourceId,
            objectMetadataId,
            ...(input.action === 'delete'
              ? {
                  deletedRecord: {
                    access: 'currentWorkspaceAdministration',
                  },
                }
              : {}),
          },
        };

        await appendCrmAuditAttempt(executor, operation, attempt);
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'none' },
    );

    if (skippedInvalidAttribution) {
      return { recorded: false, skippedInvalidAttribution: true };
    }

    return {
      recorded: true,
      attemptId,
      outcome: classification.outcome,
      reasonCode: classification.reasonCode,
    };
  } catch {
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      loggerContext: 'PostRollbackCrmAudit',
      workspaceId: input.binding.operation.workspaceId,
      operationId: input.binding.operation.operationId,
      attemptId,
      resourceKind: 'crmRecord',
      action: input.action,
    });

    return { recorded: false, alertReported: true };
  }
};

export const recordPostRollbackCoreAuditAttempt = async (input: {
  dataSource: DataSource;
  operation: CrmAuditOperation;
  attempt: Omit<CrmAuditAttemptParam, 'attemptId'> & {
    attemptId?: string;
  };
  error: unknown;
}): Promise<PostRollbackAuditAttemptResult> => {
  if (isTransactionUnsafeToRetry(input.error)) {
    reportCrmAuditUnavailable({
      code: 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED',
      loggerContext: 'PostRollbackCoreAudit',
      workspaceId: input.operation.workspaceId,
      operationId: input.operation.operationId,
      resourceKind: input.attempt.resourceKind,
      action: input.attempt.action,
    });

    return { recorded: false, skippedUnknownOutcome: true };
  }

  const attemptId = input.attempt.attemptId ?? randomUUID();

  try {
    await runInCoreAuditTransaction(input.dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '3s'");
      await runner.query("SET LOCAL statement_timeout = '5s'");
      await appendCrmAuditAttempt(runner, input.operation, {
        ...input.attempt,
        attemptId,
      });
    });

    return {
      recorded: true,
      attemptId,
      outcome: input.attempt.outcome,
      reasonCode: input.attempt.reasonCode,
    };
  } catch {
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      loggerContext: 'PostRollbackCoreAudit',
      workspaceId: input.operation.workspaceId,
      operationId: input.operation.operationId,
      attemptId,
      resourceKind: input.attempt.resourceKind,
      action: input.attempt.action,
    });

    return { recorded: false, alertReported: true };
  }
};
