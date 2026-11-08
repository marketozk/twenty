import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { acquireUserAuthenticationLock } from 'src/engine/core-modules/auth/utils/acquire-user-authentication-lock.util';
import { type CapturedApplicationMetadataAuditOperation } from 'src/engine/core-modules/crm-audit/application-metadata-audit';
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

export type TwoFactorAuthenticationAuditIdentity =
  | RoleUpdateAuditIdentity
  | CapturedApplicationMetadataAuditOperation
  | {
      workspaceId: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      correlationId?: string;
      impersonatorUserWorkspaceId?: string;
    };

export type TwoFactorAuthenticationAuditRequest = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  expectedUserId?: string;
  expectedUserWorkspaceId?: string;
}>;

const storage = new AsyncLocalStorage<{ workspaceId: string }>();
const active = new WeakSet<object>();
const consumed = new WeakSet<object>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Two-factor authentication audit identity is invalid');
  }

  return value.toLowerCase();
};

export const getTwoFactorAuthenticationAudit = (workspaceId: string) => {
  const current = storage.getStore();
  if (!current) return undefined;
  if (!active.has(current) || current.workspaceId !== uuid(workspaceId)) {
    throw new Error('Two-factor authentication audit context mismatch');
  }

  return current;
};

registerMetadataAuditScopeCheck(getTwoFactorAuthenticationAudit);

const resolveOperationFromIdentity = (
  normalizedWorkspaceId: string,
  identity: TwoFactorAuthenticationAuditIdentity | undefined,
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
      const normalizedIdentity: MembershipCleanupIdentity = {
        ...(identity as MembershipCleanupIdentity),
        correlationId:
          typeof (identity as { correlationId?: unknown }).correlationId ===
          'string'
            ? (identity as MembershipCleanupIdentity).correlationId
            : randomUUID(),
      };
      const operation = membershipCleanupOperation(
        normalizedWorkspaceId,
        normalizedIdentity,
      );
      if (!operation) {
        throw new Error(errorMessage);
      }
      const impersonatorId = (
        identity as { impersonatorUserWorkspaceId?: unknown }
      ).impersonatorUserWorkspaceId;

      return {
        operation,
        ...(typeof impersonatorId === 'string' && isUUID(impersonatorId)
          ? { impersonatorUserWorkspaceId: uuid(impersonatorId) }
          : {}),
      };
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

export const captureTwoFactorAuthenticationAudit = (
  workspaceId: string,
  identity: TwoFactorAuthenticationAuditIdentity | undefined,
  options?: {
    expectedUserId?: string;
    expectedUserWorkspaceId?: string;
  },
): TwoFactorAuthenticationAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const resolved = resolveOperationFromIdentity(
    normalizedWorkspaceId,
    identity,
    'Two-factor authentication mutation requires authenticated audit identity',
  );

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation: Object.freeze({ ...resolved.operation }),
    ...(resolved.impersonatorUserWorkspaceId
      ? { impersonatorUserWorkspaceId: resolved.impersonatorUserWorkspaceId }
      : {}),
    ...(options?.expectedUserId !== undefined
      ? { expectedUserId: uuid(options.expectedUserId) }
      : {}),
    ...(options?.expectedUserWorkspaceId !== undefined
      ? { expectedUserWorkspaceId: uuid(options.expectedUserWorkspaceId) }
      : {}),
  });
};

type TwoFactorMethodRow = {
  id: string;
  workspaceId: string;
  userWorkspaceId: string;
  secret: string;
  status: string;
  strategy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
};

type RefreshTokenRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  type: string;
  value: string | null;
  expiresAt: Date | string;
  deletedAt: Date | string | null;
  revokedAt: Date | string | null;
  context: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const toMethodSnapshot = (row: TwoFactorMethodRow): Record<string, unknown> => {
  const toIso = (val: Date | string | null) =>
    val === null
      ? null
      : val instanceof Date
        ? val.toISOString()
        : new Date(val).toISOString();

  return {
    id: uuid(row.id),
    workspaceId: uuid(row.workspaceId),
    userWorkspaceId: uuid(row.userWorkspaceId),
    secret: String(row.secret),
    status: String(row.status),
    strategy: String(row.strategy),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    deletedAt: toIso(row.deletedAt),
  };
};

const normalizeRefreshRow = (row: RefreshTokenRow): Record<string, unknown> => {
  const toIso = (val: Date | string | null) =>
    val === null
      ? null
      : val instanceof Date
        ? val.toISOString()
        : new Date(val).toISOString();

  return {
    id: uuid(row.id),
    userId: uuid(row.userId),
    workspaceId: row.workspaceId ? uuid(row.workspaceId) : null,
    type: String(row.type),
    value: row.value ?? null,
    expiresAt: toIso(row.expiresAt),
    deletedAt: toIso(row.deletedAt),
    revokedAt: toIso(row.revokedAt),
    context: row.context ?? null,
    createdAt: toIso(row.createdAt),
  };
};

const assertActorMatchesUserWorkspace = async (
  runner: QueryRunner,
  request: TwoFactorAuthenticationAuditRequest,
  userWorkspace: { id: string; userId: string; workspaceId: string },
) => {
  const normalizedUwId = uuid(userWorkspace.id);
  const normalizedUserId = uuid(userWorkspace.userId);
  if (uuid(userWorkspace.workspaceId) !== request.workspaceId) {
    throw new Error(
      'Two-factor authentication userWorkspace workspace mismatch',
    );
  }
  if (
    request.expectedUserWorkspaceId !== undefined &&
    normalizedUwId !== request.expectedUserWorkspaceId
  ) {
    throw new Error('Two-factor authentication userWorkspace mismatch');
  }
  if (
    request.expectedUserId !== undefined &&
    normalizedUserId !== request.expectedUserId
  ) {
    throw new Error('Two-factor authentication user mismatch');
  }

  const actor = request.operation.actor;
  const initiator = request.operation.initiator;
  const userPrincipal =
    actor.kind === 'coreUser' || actor.kind === 'workspaceMember'
      ? actor
      : initiator?.kind === 'coreUser' || initiator?.kind === 'workspaceMember'
        ? initiator
        : undefined;

  if (!userPrincipal) {
    throw new Error(
      'Two-factor authentication mutation requires a user-scoped audit actor',
    );
  }

  if (userPrincipal.kind === 'coreUser') {
    if (uuid(userPrincipal.id) !== normalizedUserId) {
      throw new Error(
        'Two-factor authentication actor does not match target userWorkspace',
      );
    }
    return;
  }

  const schemaRows: { exists: string | null }[] = await runner.query(
    'SELECT to_regclass($1) AS exists',
    [`"workspace_${request.workspaceId}"."workspaceMember"`],
  );
  if (schemaRows[0]?.exists) {
    const memberRows: { userId: string }[] = await runner.query(
      `SELECT "userId" FROM "workspace_${request.workspaceId}"."workspaceMember" WHERE id = $1 AND "deletedAt" IS NULL`,
      [uuid(userPrincipal.id)],
    );
    if (!memberRows[0] || uuid(memberRows[0].userId) !== normalizedUserId) {
      throw new Error(
        'Two-factor authentication workspaceMember actor does not match target userWorkspace',
      );
    }
  }
};

export const runAuditedTwoFactorProvisioning = async ({
  dataSource,
  request,
  userId,
  strategy,
  pendingMethodReuseWindowMs,
  generateCandidate,
  onUserWorkspaceMissing,
  onAlreadyProvisioned,
  onRecoveryEnrollmentRestricted,
}: {
  dataSource: DataSource;
  request: TwoFactorAuthenticationAuditRequest;
  userId: string;
  strategy: string;
  pendingMethodReuseWindowMs: number;
  generateCandidate: () => {
    uri: string;
    encryptedSecret: string;
    status: string;
  };
  onUserWorkspaceMissing: () => never;
  onAlreadyProvisioned: () => never;
  onRecoveryEnrollmentRestricted: () => never;
}): Promise<
  { reused: true; existingSecret: string } | { reused: false; uri: string }
> => {
  if (!request || typeof request !== 'object') {
    throw new Error(
      'Two-factor authentication provisioning requires captured audit context',
    );
  }
  if (consumed.has(request)) {
    throw new Error(
      'Two-factor authentication audit context was already consumed',
    );
  }
  if (
    storage.getStore() ||
    hasConflictingMetadataAuditScope(request.workspaceId)
  ) {
    throw new Error(
      'Nested two-factor authentication audit contexts are not supported',
    );
  }

  const normalizedUserId = uuid(userId);
  if (
    request.expectedUserId !== undefined &&
    request.expectedUserId !== normalizedUserId
  ) {
    throw new Error('Two-factor authentication provisioning user mismatch');
  }
  if (typeof strategy !== 'string' || strategy.length === 0) {
    throw new Error('Two-factor authentication strategy is invalid');
  }

  consumed.add(request);
  const scope = { workspaceId: request.workspaceId };
  active.add(scope);

  try {
    return await storage.run(scope, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: normalizedUserId,
          mode: 'exclusive',
        });

        const wsRows: { id: string }[] = await runner.query(
          'SELECT id FROM core.workspace WHERE id = $1 AND "deletedAt" IS NULL FOR NO KEY UPDATE',
          [request.workspaceId],
        );
        if (wsRows.length !== 1) {
          throw new Error('Two-factor authentication workspace is unavailable');
        }

        const uwRows: {
          id: string;
          userId: string;
          workspaceId: string;
          createdAt: Date | string;
          deletedAt: Date | string | null;
        }[] = await runner.query(
          'SELECT id, "userId", "workspaceId", "createdAt", "deletedAt" FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2 ORDER BY id FOR NO KEY UPDATE',
          [normalizedUserId, request.workspaceId],
        );
        const uw = uwRows.find((row) => row.deletedAt === null);
        if (!uw) {
          return onUserWorkspaceMissing();
        }
        await assertActorMatchesUserWorkspace(runner, request, uw);

        const existingRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE "userWorkspaceId" = $1 AND strategy = $2
            ORDER BY id FOR UPDATE`,
          [uuid(uw.id), strategy],
        );
        if (existingRows.length > 1) {
          throw new Error(
            'Multiple two-factor authentication methods matched unique (userWorkspaceId, strategy)',
          );
        }
        const existing = existingRows[0];
        if (existing && uuid(existing.workspaceId) !== request.workspaceId) {
          throw new Error(
            'Two-factor authentication method workspace mismatch',
          );
        }

        if (
          existing &&
          existing.deletedAt === null &&
          existing.status !== 'PENDING'
        ) {
          return onAlreadyProvisioned();
        }

        const appTokenTableRows: { exists: string | null }[] =
          await runner.query('SELECT to_regclass($1) AS exists', [
            'core."appToken"',
          ]);
        if (appTokenTableRows[0]?.exists) {
          const reservedRows: { id: string }[] = await runner.query(
            `SELECT id FROM core."appToken"
              WHERE "userId" = $1
                AND "workspaceId" = $2
                AND type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE'
                AND "deletedAt" IS NOT NULL
                AND "revokedAt" IS NULL
                AND "createdAt" >= $3
              LIMIT 1`,
            [normalizedUserId, request.workspaceId, uw.createdAt],
          );
          if (reservedRows.length > 0) {
            return onRecoveryEnrollmentRestricted();
          }
        }

        if (
          existing &&
          existing.deletedAt === null &&
          existing.status === 'PENDING' &&
          existing.createdAt &&
          Date.now() - new Date(existing.createdAt).getTime() <
            pendingMethodReuseWindowMs
        ) {
          return {
            reused: true as const,
            existingSecret: String(existing.secret),
          };
        }

        const candidate = generateCandidate();
        if (
          typeof candidate.encryptedSecret !== 'string' ||
          !candidate.encryptedSecret.startsWith('enc:v2:')
        ) {
          throw new Error(
            'Two-factor authentication secret must be encrypted with enc:v2 envelope',
          );
        }

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);

        const beforeSnapshot =
          existing && existing.deletedAt === null
            ? toMethodSnapshot(existing)
            : null;

        let targetId: string;
        if (existing) {
          targetId = uuid(existing.id);
          await runner.query(
            `UPDATE core."twoFactorAuthenticationMethod"
                SET secret = $1,
                    status = $2,
                    "deletedAt" = NULL,
                    "updatedAt" = GREATEST(now(), "updatedAt" + interval '1 microsecond')
              WHERE id = $3`,
            [candidate.encryptedSecret, candidate.status, targetId],
          );
        } else {
          targetId = randomUUID();
          await runner.query(
            `INSERT INTO core."twoFactorAuthenticationMethod"
              (id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt")
             VALUES ($1, $2, $3, $4, $5, $6, now(), now(), NULL)`,
            [
              targetId,
              request.workspaceId,
              uuid(uw.id),
              candidate.encryptedSecret,
              candidate.status,
              strategy,
            ],
          );
        }

        const afterRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE id = $1`,
          [targetId],
        );
        const afterRow = afterRows[0];
        if (
          !afterRow ||
          afterRow.deletedAt !== null ||
          uuid(afterRow.workspaceId) !== request.workspaceId ||
          uuid(afterRow.userWorkspaceId) !== uuid(uw.id) ||
          String(afterRow.secret) !== candidate.encryptedSecret ||
          String(afterRow.status) !== candidate.status ||
          String(afterRow.strategy) !== strategy
        ) {
          throw new Error(
            'Two-factor authentication provisioning persisted state does not match',
          );
        }
        if (
          beforeSnapshot &&
          String(beforeSnapshot.secret) === String(afterRow.secret)
        ) {
          throw new Error(
            'Two-factor authentication provisioning did not rotate secret',
          );
        }

        const afterSnapshot = toMethodSnapshot(afterRow);

        audit.record({
          resourceKind: 'twoFactorAuthenticationMethod',
          resourceId: targetId,
          action: beforeSnapshot ? 'update' : 'create',
          before: beforeSnapshot,
          after: afterSnapshot,
          securityDescriptor: {
            resourceKind: 'twoFactorAuthenticationMethod',
            resourceId: targetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();

        const verifyRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE id = $1`,
          [targetId],
        );
        if (
          !verifyRows[0] ||
          canonicalAuditJson(toMethodSnapshot(verifyRows[0])) !==
            canonicalAuditJson(afterSnapshot)
        ) {
          throw new Error(
            'Two-factor authentication method changed after audit flush',
          );
        }

        return { reused: false as const, uri: candidate.uri };
      }),
    );
  } finally {
    active.delete(scope);
  }
};

export const runAuditedTwoFactorValidation = async ({
  dataSource,
  request,
  methodId,
  userId,
  expectedSecret,
  verifiedStatus,
  onMethodNotFound,
}: {
  dataSource: DataSource;
  request: TwoFactorAuthenticationAuditRequest;
  methodId: string;
  userId: string;
  expectedSecret: string;
  verifiedStatus: string;
  onMethodNotFound: () => never;
}): Promise<void> => {
  if (!request || typeof request !== 'object') {
    throw new Error(
      'Two-factor authentication validation requires captured audit context',
    );
  }
  if (consumed.has(request)) {
    throw new Error(
      'Two-factor authentication audit context was already consumed',
    );
  }
  if (
    storage.getStore() ||
    hasConflictingMetadataAuditScope(request.workspaceId)
  ) {
    throw new Error(
      'Nested two-factor authentication audit contexts are not supported',
    );
  }

  const normalizedMethodId = uuid(methodId);
  const normalizedUserId = uuid(userId);
  if (
    request.expectedUserId !== undefined &&
    request.expectedUserId !== normalizedUserId
  ) {
    throw new Error('Two-factor authentication validation user mismatch');
  }

  consumed.add(request);
  const scope = { workspaceId: request.workspaceId };
  active.add(scope);

  try {
    await storage.run(scope, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: normalizedUserId,
          mode: 'exclusive',
        });

        const wsRows: { id: string }[] = await runner.query(
          'SELECT id FROM core.workspace WHERE id = $1 AND "deletedAt" IS NULL FOR NO KEY UPDATE',
          [request.workspaceId],
        );
        if (wsRows.length !== 1) {
          throw new Error('Two-factor authentication workspace is unavailable');
        }

        const methodRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE id = $1
            FOR UPDATE`,
          [normalizedMethodId],
        );
        const beforeRow = methodRows[0];
        if (!beforeRow || beforeRow.deletedAt !== null) {
          return onMethodNotFound();
        }
        if (uuid(beforeRow.workspaceId) !== request.workspaceId) {
          throw new Error(
            'Two-factor authentication method workspace mismatch',
          );
        }
        if (String(beforeRow.secret) !== expectedSecret) {
          return onMethodNotFound();
        }

        const uwRows: {
          id: string;
          userId: string;
          workspaceId: string;
          deletedAt: Date | string | null;
        }[] = await runner.query(
          'SELECT id, "userId", "workspaceId", "deletedAt" FROM core."userWorkspace" WHERE id = $1 FOR NO KEY UPDATE',
          [uuid(beforeRow.userWorkspaceId)],
        );
        const uw = uwRows[0];
        if (
          !uw ||
          uw.deletedAt !== null ||
          uuid(uw.workspaceId) !== request.workspaceId ||
          uuid(uw.userId) !== normalizedUserId
        ) {
          return onMethodNotFound();
        }
        await assertActorMatchesUserWorkspace(runner, request, uw);

        const beforeSnapshot = toMethodSnapshot(beforeRow);
        const statusChanged = String(beforeRow.status) !== verifiedStatus;

        let expectedAfterSnapshot = beforeSnapshot;
        if (statusChanged) {
          const updateRes:
            | [TwoFactorMethodRow[], number]
            | TwoFactorMethodRow[] = await runner.query(
            `UPDATE core."twoFactorAuthenticationMethod"
                  SET status = $1,
                      "updatedAt" = GREATEST(now(), "updatedAt" + interval '1 microsecond')
                WHERE id = $2 AND "workspaceId" = $3 AND secret = $4 AND "deletedAt" IS NULL
                RETURNING id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"`,
            [
              verifiedStatus,
              normalizedMethodId,
              request.workspaceId,
              expectedSecret,
            ],
          );
          const updatedRows = Array.isArray(updateRes?.[0])
            ? (updateRes[0] as TwoFactorMethodRow[])
            : (updateRes as TwoFactorMethodRow[]);
          if (updatedRows.length !== 1) {
            return onMethodNotFound();
          }
          expectedAfterSnapshot = toMethodSnapshot(updatedRows[0]);
          if (expectedAfterSnapshot.status !== verifiedStatus) {
            throw new Error(
              'Two-factor authentication validation did not persist VERIFIED status',
            );
          }
        }

        const appTokenTableRows: { exists: string | null }[] =
          await runner.query('SELECT to_regclass($1) AS exists', [
            'core."appToken"',
          ]);
        if (appTokenTableRows[0]?.exists) {
          await runner.query(
            `UPDATE core."appToken"
                SET "revokedAt" = now(),
                    "updatedAt" = now()
              WHERE "workspaceId" = $1
                AND "userId" = $2
                AND type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE'
                AND "revokedAt" IS NULL`,
            [request.workspaceId, normalizedUserId],
          );
        }

        if (statusChanged) {
          const operation = await resolveRoleAuditInitiator(
            runner,
            request.operation,
            request.impersonatorUserWorkspaceId,
          );
          const audit = new CrmAuditTransactionContext(runner, operation);
          audit.record({
            resourceKind: 'twoFactorAuthenticationMethod',
            resourceId: normalizedMethodId,
            action: 'update',
            before: beforeSnapshot,
            after: expectedAfterSnapshot,
            securityDescriptor: {
              resourceKind: 'twoFactorAuthenticationMethod',
              resourceId: normalizedMethodId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          await audit.flush();
        }

        const verifyRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE id = $1`,
          [normalizedMethodId],
        );
        if (
          !verifyRows[0] ||
          canonicalAuditJson(toMethodSnapshot(verifyRows[0])) !==
            canonicalAuditJson(expectedAfterSnapshot)
        ) {
          throw new Error(
            'Two-factor authentication method changed after validation',
          );
        }
      }),
    );
  } finally {
    active.delete(scope);
  }
};

export const runAuditedTwoFactorDeletion = async ({
  dataSource,
  request,
  methodId,
  userId,
  onMethodNotFound,
  onForbiddenOwner,
}: {
  dataSource: DataSource;
  request: TwoFactorAuthenticationAuditRequest;
  methodId: string;
  userId: string;
  onMethodNotFound: () => never;
  onForbiddenOwner: () => never;
}): Promise<void> => {
  if (!request || typeof request !== 'object') {
    throw new Error(
      'Two-factor authentication deletion requires captured audit context',
    );
  }
  if (consumed.has(request)) {
    throw new Error(
      'Two-factor authentication audit context was already consumed',
    );
  }
  if (
    storage.getStore() ||
    hasConflictingMetadataAuditScope(request.workspaceId)
  ) {
    throw new Error(
      'Nested two-factor authentication audit contexts are not supported',
    );
  }

  const normalizedMethodId = uuid(methodId);
  const normalizedUserId = uuid(userId);
  if (
    request.expectedUserId !== undefined &&
    request.expectedUserId !== normalizedUserId
  ) {
    throw new Error('Two-factor authentication deletion user mismatch');
  }

  consumed.add(request);
  const scope = { workspaceId: request.workspaceId };
  active.add(scope);

  try {
    await storage.run(scope, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: normalizedUserId,
          mode: 'exclusive',
        });

        const wsRows: { id: string }[] = await runner.query(
          'SELECT id FROM core.workspace WHERE id = $1 AND "deletedAt" IS NULL FOR NO KEY UPDATE',
          [request.workspaceId],
        );
        if (wsRows.length !== 1) {
          throw new Error('Two-factor authentication workspace is unavailable');
        }

        const methodRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE id = $1
            FOR UPDATE`,
          [normalizedMethodId],
        );
        const beforeRow = methodRows[0];
        if (!beforeRow || beforeRow.deletedAt !== null) {
          return onMethodNotFound();
        }
        if (uuid(beforeRow.workspaceId) !== request.workspaceId) {
          throw new Error(
            'Two-factor authentication method workspace mismatch',
          );
        }

        const uwRows: {
          id: string;
          userId: string;
          workspaceId: string;
        }[] = await runner.query(
          'SELECT id, "userId", "workspaceId" FROM core."userWorkspace" WHERE id = $1 FOR NO KEY UPDATE',
          [uuid(beforeRow.userWorkspaceId)],
        );
        const uw = uwRows[0];
        if (!uw || uuid(uw.workspaceId) !== request.workspaceId) {
          throw new Error(
            'Two-factor authentication userWorkspace workspace mismatch',
          );
        }
        if (uuid(uw.userId) !== normalizedUserId) {
          return onForbiddenOwner();
        }
        await assertActorMatchesUserWorkspace(runner, request, uw);

        const beforeSnapshot = toMethodSnapshot(beforeRow);
        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);

        await runner.query(
          'DELETE FROM core."twoFactorAuthenticationMethod" WHERE id = $1 AND "workspaceId" = $2',
          [normalizedMethodId, request.workspaceId],
        );

        const afterDelete: { id: string }[] = await runner.query(
          'SELECT id FROM core."twoFactorAuthenticationMethod" WHERE id = $1',
          [normalizedMethodId],
        );
        if (afterDelete.length > 0) {
          throw new Error(
            'Two-factor authentication deletion retained target row',
          );
        }

        audit.record({
          resourceKind: 'twoFactorAuthenticationMethod',
          resourceId: normalizedMethodId,
          action: 'delete',
          before: beforeSnapshot,
          after: null,
          securityDescriptor: {
            resourceKind: 'twoFactorAuthenticationMethod',
            resourceId: normalizedMethodId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();

        const verifyDelete: { id: string }[] = await runner.query(
          'SELECT id FROM core."twoFactorAuthenticationMethod" WHERE id = $1',
          [normalizedMethodId],
        );
        if (verifyDelete.length > 0) {
          throw new Error(
            'Two-factor authentication method reappeared after audit flush',
          );
        }
      }),
    );
  } finally {
    active.delete(scope);
  }
};

export const runAuditedTwoFactorRecoveryRedemption = async ({
  dataSource,
  request,
  userId,
  userWorkspaceId,
  userWorkspaceCreatedAt,
  hashedRecoveryCode,
  isTwoFactorAuthenticationEnforced,
  revokedReason,
  generateReplacementCandidate,
}: {
  dataSource: DataSource;
  request: TwoFactorAuthenticationAuditRequest;
  userId: string;
  userWorkspaceId: string;
  userWorkspaceCreatedAt: Date;
  hashedRecoveryCode: string;
  isTwoFactorAuthenticationEnforced: boolean;
  revokedReason: string;
  generateReplacementCandidate: () => {
    uri: string;
    encryptedSecret: string;
    status: string;
    strategy: string;
  };
}): Promise<{ provisioningUri: string | null } | null> => {
  if (!request || typeof request !== 'object') {
    throw new Error(
      'Two-factor authentication recovery requires captured audit context',
    );
  }
  if (consumed.has(request)) {
    throw new Error(
      'Two-factor authentication audit context was already consumed',
    );
  }
  if (
    storage.getStore() ||
    hasConflictingMetadataAuditScope(request.workspaceId)
  ) {
    throw new Error(
      'Nested two-factor authentication audit contexts are not supported',
    );
  }

  const normalizedUserId = uuid(userId);
  const normalizedUserWorkspaceId = uuid(userWorkspaceId);
  if (
    request.expectedUserId !== undefined &&
    request.expectedUserId !== normalizedUserId
  ) {
    throw new Error('Two-factor authentication recovery user mismatch');
  }
  if (
    request.expectedUserWorkspaceId !== undefined &&
    request.expectedUserWorkspaceId !== normalizedUserWorkspaceId
  ) {
    throw new Error(
      'Two-factor authentication recovery userWorkspace mismatch',
    );
  }
  if (typeof hashedRecoveryCode !== 'string' || !hashedRecoveryCode.length) {
    throw new Error('Two-factor authentication recovery code hash is invalid');
  }

  consumed.add(request);
  const scope = { workspaceId: request.workspaceId };
  active.add(scope);

  try {
    return await storage.run(scope, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: normalizedUserId,
          mode: 'exclusive',
        });

        const wsRows: { id: string }[] = await runner.query(
          'SELECT id FROM core.workspace WHERE id = $1 AND "deletedAt" IS NULL FOR NO KEY UPDATE',
          [request.workspaceId],
        );
        if (wsRows.length !== 1) {
          throw new Error('Two-factor authentication workspace is unavailable');
        }

        const uwRows: {
          id: string;
          userId: string;
          workspaceId: string;
          createdAt: Date | string;
          deletedAt: Date | string | null;
        }[] = await runner.query(
          'SELECT id, "userId", "workspaceId", "createdAt", "deletedAt" FROM core."userWorkspace" WHERE id = $1 FOR NO KEY UPDATE',
          [normalizedUserWorkspaceId],
        );
        const uw = uwRows[0];
        if (
          !uw ||
          uw.deletedAt !== null ||
          uuid(uw.workspaceId) !== request.workspaceId ||
          uuid(uw.userId) !== normalizedUserId
        ) {
          throw new Error(
            'Two-factor authentication recovery userWorkspace is unavailable',
          );
        }
        await assertActorMatchesUserWorkspace(runner, request, uw);

        const now = new Date();
        const consumeRaw: [{ id: string }[], number] | { id: string }[] =
          await runner.query(
            isTwoFactorAuthenticationEnforced
              ? `UPDATE core."appToken"
                    SET "deletedAt" = $1,
                        "updatedAt" = $1
                  WHERE "userId" = $2
                    AND "workspaceId" = $3
                    AND type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE'
                    AND value = $4
                    AND "deletedAt" IS NULL
                    AND "revokedAt" IS NULL
                    AND "expiresAt" > $1
                    AND "createdAt" >= $5
                  RETURNING id`
              : `UPDATE core."appToken"
                    SET "deletedAt" = $1,
                        "revokedAt" = $1,
                        "updatedAt" = $1
                  WHERE "userId" = $2
                    AND "workspaceId" = $3
                    AND type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE'
                    AND value = $4
                    AND "deletedAt" IS NULL
                    AND "revokedAt" IS NULL
                    AND "expiresAt" > $1
                    AND "createdAt" >= $5
                  RETURNING id`,
            [
              now,
              normalizedUserId,
              request.workspaceId,
              hashedRecoveryCode,
              userWorkspaceCreatedAt,
            ],
          );
        const consumedTokens = Array.isArray(consumeRaw?.[0])
          ? (consumeRaw[0] as { id: string }[])
          : (consumeRaw as { id: string }[]);
        if (consumedTokens.length === 0) {
          return null;
        }

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);

        const methodRows: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE "userWorkspaceId" = $1
            ORDER BY id FOR UPDATE`,
          [normalizedUserWorkspaceId],
        );
        for (const row of methodRows) {
          if (uuid(row.workspaceId) !== request.workspaceId) {
            throw new Error(
              'Two-factor authentication method workspace mismatch',
            );
          }
        }
        const beforeMethods = methodRows.map((row) => ({
          id: uuid(row.id),
          snapshot: toMethodSnapshot(row),
        }));

        if (beforeMethods.length > 0) {
          await runner.query(
            'DELETE FROM core."twoFactorAuthenticationMethod" WHERE "workspaceId" = $1 AND "userWorkspaceId" = $2',
            [request.workspaceId, normalizedUserWorkspaceId],
          );
          const remaining: { id: string }[] = await runner.query(
            'SELECT id FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
            [normalizedUserWorkspaceId],
          );
          if (remaining.length > 0) {
            throw new Error(
              'Two-factor authentication recovery retained old method rows',
            );
          }
          for (const item of beforeMethods) {
            audit.record({
              resourceKind: 'twoFactorAuthenticationMethod',
              resourceId: item.id,
              action: 'delete',
              before: item.snapshot,
              after: null,
              securityDescriptor: {
                resourceKind: 'twoFactorAuthenticationMethod',
                resourceId: item.id,
                metadataAccess: 'currentWorkspaceAdministration',
              },
            });
          }
        }

        const refreshBeforeRows: RefreshTokenRow[] = await runner.query(
          `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt", "updatedAt"
             FROM core."appToken"
            WHERE "userId" = $1
              AND "workspaceId" = $2
              AND type = 'REFRESH_TOKEN'
              AND "expiresAt" > $3
            ORDER BY id FOR UPDATE`,
          [normalizedUserId, request.workspaceId, now],
        );

        const expectedRefreshById = new Map<string, Record<string, unknown>>();
        for (const tokenRow of refreshBeforeRows) {
          if (
            tokenRow.context !== null &&
            (typeof tokenRow.context !== 'object' ||
              Array.isArray(tokenRow.context))
          ) {
            throw new Error('Refresh token context is invalid');
          }
          const tokenId = uuid(tokenRow.id);
          const prevRevokedAt =
            tokenRow.revokedAt === null
              ? null
              : tokenRow.revokedAt instanceof Date
                ? tokenRow.revokedAt.toISOString()
                : new Date(tokenRow.revokedAt).toISOString();
          const prevReason =
            (tokenRow.context as { revokedReason?: unknown } | null)
              ?.revokedReason ?? null;
          const nextRevokedAt = prevRevokedAt ?? now.toISOString();
          const nextContext = {
            ...(tokenRow.context ?? {}),
            revokedReason,
          };

          await runner.query(
            `UPDATE core."appToken"
                SET "revokedAt" = COALESCE("revokedAt", $1),
                    context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('revokedReason', $2::text),
                    "updatedAt" = now()
              WHERE id = $3`,
            [now, revokedReason, tokenId],
          );

          const expectedNormalized = {
            ...normalizeRefreshRow(tokenRow),
            revokedAt: nextRevokedAt,
            context: nextContext,
          };
          expectedRefreshById.set(tokenId, expectedNormalized);

          if (prevRevokedAt !== nextRevokedAt || prevReason !== revokedReason) {
            audit.record({
              resourceKind: 'refreshToken',
              resourceId: tokenId,
              action: 'update',
              before: {
                revokedAt: prevRevokedAt,
                revokedReason: prevReason,
              },
              after: {
                revokedAt: nextRevokedAt,
                revokedReason,
              },
              securityDescriptor: {
                resourceKind: 'refreshToken',
                resourceId: tokenId,
                tokenOwner: {
                  userId: normalizedUserId,
                  access: 'currentWorkspaceAdministration',
                },
              },
            });
          }
        }

        let replacementId: string | null = null;
        let replacementSnapshot: Record<string, unknown> | null = null;
        let provisioningUri: string | null = null;

        if (isTwoFactorAuthenticationEnforced) {
          const replacement = generateReplacementCandidate();
          if (
            typeof replacement.encryptedSecret !== 'string' ||
            !replacement.encryptedSecret.startsWith('enc:v2:')
          ) {
            throw new Error(
              'Replacement two-factor authentication secret must be encrypted with enc:v2 envelope',
            );
          }
          do {
            replacementId = randomUUID();
          } while (beforeMethods.some((item) => item.id === replacementId));

          await runner.query(
            `INSERT INTO core."twoFactorAuthenticationMethod"
              (id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt")
             VALUES ($1, $2, $3, $4, $5, $6, now(), now(), NULL)`,
            [
              replacementId,
              request.workspaceId,
              normalizedUserWorkspaceId,
              replacement.encryptedSecret,
              replacement.status,
              replacement.strategy,
            ],
          );

          const insertedRows: TwoFactorMethodRow[] = await runner.query(
            `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
               FROM core."twoFactorAuthenticationMethod"
              WHERE id = $1`,
            [replacementId],
          );
          if (
            !insertedRows[0] ||
            insertedRows[0].deletedAt !== null ||
            uuid(insertedRows[0].workspaceId) !== request.workspaceId ||
            uuid(insertedRows[0].userWorkspaceId) !==
              normalizedUserWorkspaceId ||
            String(insertedRows[0].secret) !== replacement.encryptedSecret ||
            String(insertedRows[0].status) !== replacement.status ||
            String(insertedRows[0].strategy) !== replacement.strategy
          ) {
            throw new Error(
              'Replacement two-factor authentication method persisted state does not match',
            );
          }

          replacementSnapshot = toMethodSnapshot(insertedRows[0]);
          provisioningUri = replacement.uri;

          audit.record({
            resourceKind: 'twoFactorAuthenticationMethod',
            resourceId: replacementId,
            action: 'create',
            before: null,
            after: replacementSnapshot,
            securityDescriptor: {
              resourceKind: 'twoFactorAuthenticationMethod',
              resourceId: replacementId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        }

        await audit.flush();

        const finalMethods: TwoFactorMethodRow[] = await runner.query(
          `SELECT id, "workspaceId", "userWorkspaceId", secret, status, strategy, "createdAt", "updatedAt", "deletedAt"
             FROM core."twoFactorAuthenticationMethod"
            WHERE "userWorkspaceId" = $1
            ORDER BY id`,
          [normalizedUserWorkspaceId],
        );
        if (replacementId && replacementSnapshot) {
          if (
            finalMethods.length !== 1 ||
            uuid(finalMethods[0].id) !== replacementId ||
            canonicalAuditJson(toMethodSnapshot(finalMethods[0])) !==
              canonicalAuditJson(replacementSnapshot)
          ) {
            throw new Error(
              'Replacement two-factor authentication method changed after audit flush',
            );
          }
        } else if (finalMethods.length !== 0) {
          throw new Error(
            'Two-factor authentication method reappeared after recovery audit flush',
          );
        }

        if (expectedRefreshById.size > 0) {
          const finalRefreshRows: RefreshTokenRow[] = await runner.query(
            `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt", "updatedAt"
               FROM core."appToken"
              WHERE id = ANY($1::uuid[])
              ORDER BY id`,
            [Array.from(expectedRefreshById.keys())],
          );
          if (finalRefreshRows.length !== expectedRefreshById.size) {
            throw new Error(
              'Revoked refresh token vanished during two-factor recovery',
            );
          }
          for (const row of finalRefreshRows) {
            const expected = expectedRefreshById.get(uuid(row.id));
            if (
              !expected ||
              canonicalAuditJson(normalizeRefreshRow(row)) !==
                canonicalAuditJson(expected)
            ) {
              throw new Error(
                'Revoked refresh token changed after two-factor recovery audit flush',
              );
            }
          }
        }

        return { provisioningUri };
      }),
    );
  } finally {
    active.delete(scope);
  }
};
