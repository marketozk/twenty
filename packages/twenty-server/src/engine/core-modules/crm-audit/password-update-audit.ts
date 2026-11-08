import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { acquireUserAuthenticationLock } from 'src/engine/core-modules/auth/utils/acquire-user-authentication-lock.util';
import {
  captureCurrentCrmAuditOperation,
  peekCurrentCrmAuditWorkspaceId,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditOperation,
  resolveRoleAuditInitiator,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';

export type PasswordUpdateAuditIdentity =
  | RoleUpdateAuditIdentity
  | CrmAuditOperation
  | {
      workspaceId?: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      impersonatorUserWorkspaceId?: string;
      correlationId?: string;
      causationId?: string;
    };

export type PasswordUpdateAuditRequest = {
  readonly expectedUserId: string;
  readonly actor: CrmAuditOperation['actor'];
  readonly initiator?: CrmAuditOperation['initiator'];
  readonly impersonatorUserWorkspaceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
};

type AppTokenRow = {
  id: string;
  userId: string | null;
  workspaceId: string | null;
  type: string;
  value: string | null;
  expiresAt: Date | string;
  deletedAt: Date | string | null;
  revokedAt: Date | string | null;
  context: Record<string, unknown> | null;
  createdAt: Date | string;
};

type ActiveMembershipRow = {
  id: string;
  userId: string;
  workspaceId: string;
  locale: string;
};

const storage = new AsyncLocalStorage<{ userId: string }>();
const consumed = new WeakSet<PasswordUpdateAuditRequest>();
const pendingResetTokenByUser = new Map<string, string>();

const uuid = (value: string): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Password update audit UUID is invalid');
  }

  return value.toLowerCase();
};

export const registerPendingPasswordResetTokenValidation = (
  userId: string,
  tokenHash: string,
): void => {
  if (
    typeof userId !== 'string' ||
    !isUUID(userId) ||
    typeof tokenHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(tokenHash)
  ) {
    throw new Error('Password reset token validation registration is invalid');
  }
  pendingResetTokenByUser.set(userId.toLowerCase(), tokenHash.toLowerCase());
};

export const peekPendingPasswordResetTokenValidation = (
  userId: string,
): string | undefined => {
  if (typeof userId !== 'string' || !isUUID(userId)) {
    return undefined;
  }

  return pendingResetTokenByUser.get(userId.toLowerCase());
};

export const clearPendingPasswordResetTokenValidation = (
  userId?: string,
): void => {
  if (userId === undefined) {
    pendingResetTokenByUser.clear();

    return;
  }
  if (typeof userId === 'string' && isUUID(userId)) {
    pendingResetTokenByUser.delete(userId.toLowerCase());
  }
};

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Password update audit timestamp is invalid');
  }

  return parsed.toISOString();
};

const normalizeAppTokenRow = (row: AppTokenRow): Record<string, unknown> => ({
  id: uuid(row.id),
  userId: row.userId === null ? null : uuid(row.userId),
  workspaceId: row.workspaceId === null ? null : uuid(row.workspaceId),
  type: row.type,
  value: row.value ?? null,
  expiresAt: toIso(row.expiresAt),
  deletedAt: toIso(row.deletedAt),
  revokedAt: toIso(row.revokedAt),
  context: row.context ?? null,
  createdAt: toIso(row.createdAt),
});

export const capturePasswordUpdateAudit = (
  userId: string,
  identity?: PasswordUpdateAuditIdentity,
): PasswordUpdateAuditRequest => {
  const normalizedUserId = uuid(userId);

  if (identity === undefined) {
    const ambientWorkspaceId = peekCurrentCrmAuditWorkspaceId();
    if (ambientWorkspaceId !== undefined) {
      try {
        const captured = captureCurrentCrmAuditOperation(ambientWorkspaceId);
        if (captured !== undefined) {
          return Object.freeze({
            expectedUserId: normalizedUserId,
            actor: { ...captured.operation.actor },
            ...(captured.operation.initiator
              ? { initiator: { ...captured.operation.initiator } }
              : {}),
            ...(captured.impersonatorUserWorkspaceId
              ? {
                  impersonatorUserWorkspaceId: uuid(
                    captured.impersonatorUserWorkspaceId,
                  ),
                }
              : {}),
            ...(captured.operation.correlationId
              ? { correlationId: captured.operation.correlationId }
              : {}),
            ...(captured.operation.causationId
              ? { causationId: captured.operation.causationId }
              : {}),
          });
        }
      } catch {
        // Fall through to self coreUser actor when ambient request has no workspace-scoped principal.
      }
    }

    return Object.freeze({
      expectedUserId: normalizedUserId,
      actor: { kind: 'coreUser' as const, id: normalizedUserId },
    });
  }

  if (!identity || typeof identity !== 'object') {
    throw new Error('Password update audit identity is required');
  }

  if ('auth' in identity) {
    const fallbackWorkspaceId =
      (typeof identity.auth?.workspace?.id === 'string' &&
      isUUID(identity.auth.workspace.id)
        ? identity.auth.workspace.id
        : undefined) ??
      peekCurrentCrmAuditWorkspaceId() ??
      normalizedUserId;
    const captured = captureRoleAuditOperation(fallbackWorkspaceId, {
      ...identity,
      auth: {
        ...identity.auth,
        workspace: { id: fallbackWorkspaceId },
      },
    });
    const rawImpersonatorUserWorkspaceId = identity.impersonatorUserWorkspaceId;

    return Object.freeze({
      expectedUserId: normalizedUserId,
      actor: { ...captured.actor },
      ...(captured.initiator ? { initiator: { ...captured.initiator } } : {}),
      ...(typeof rawImpersonatorUserWorkspaceId === 'string' &&
      isUUID(rawImpersonatorUserWorkspaceId)
        ? {
            impersonatorUserWorkspaceId: uuid(rawImpersonatorUserWorkspaceId),
          }
        : {}),
      ...(captured.correlationId
        ? { correlationId: captured.correlationId }
        : {}),
      ...(captured.causationId ? { causationId: captured.causationId } : {}),
    });
  }

  if (!('actor' in identity)) {
    throw new Error('Password update audit identity is required');
  }

  return Object.freeze({
    expectedUserId: normalizedUserId,
    actor: { ...identity.actor },
    ...(identity.initiator ? { initiator: { ...identity.initiator } } : {}),
    ...('impersonatorUserWorkspaceId' in identity &&
    identity.impersonatorUserWorkspaceId !== undefined
      ? {
          impersonatorUserWorkspaceId: uuid(
            identity.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
    ...(identity.correlationId
      ? { correlationId: identity.correlationId }
      : {}),
    ...(identity.causationId ? { causationId: identity.causationId } : {}),
  });
};

export const runAuditedPasswordUpdate = async ({
  dataSource,
  request,
  userId,
  newPasswordHash,
  onInvalidPassword,
  onInvalidResetToken,
  onUserNotFound,
  onUserWorkspaceNotFound,
  revokedReason = UserSessionRevokedReason.PasswordChanged,
  passwordResetTokenHash,
}: {
  dataSource: DataSource;
  request: PasswordUpdateAuditRequest;
  userId: string;
  newPasswordHash: string | null;
  onInvalidPassword?: () => never;
  onInvalidResetToken: () => never;
  onUserNotFound: () => never;
  onUserWorkspaceNotFound: () => never;
  revokedReason?: string;
  passwordResetTokenHash?: string;
}): Promise<{
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  firstUserWorkspace: {
    id: string;
    workspaceId: string;
    locale: string;
  };
}> => {
  if (!request || typeof request !== 'object') {
    throw new Error('Password update requires captured audit context');
  }
  if (consumed.has(request)) {
    throw new Error('Password update audit context was already consumed');
  }
  if (storage.getStore()) {
    throw new Error('Nested password update audit contexts are not supported');
  }

  const normalizedUserId = uuid(userId);
  if (request.expectedUserId !== normalizedUserId) {
    throw new Error('Password update user mismatch');
  }
  if (
    newPasswordHash !== null &&
    (typeof newPasswordHash !== 'string' || !newPasswordHash.length)
  ) {
    throw new Error('Password update hash is invalid');
  }
  if (newPasswordHash === null && typeof onInvalidPassword !== 'function') {
    throw new Error('Password update hash is invalid');
  }
  if (typeof revokedReason !== 'string' || !revokedReason.length) {
    throw new Error('Password update revocation reason is invalid');
  }
  if (
    passwordResetTokenHash !== undefined &&
    (typeof passwordResetTokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(passwordResetTokenHash))
  ) {
    return onInvalidResetToken();
  }

  consumed.add(request);
  const scope = { userId: normalizedUserId };

  return await storage.run(scope, () =>
    runInCoreAuditTransaction(dataSource, async (runner: QueryRunner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      await acquireUserAuthenticationLock({
        entityManager: runner.manager,
        userId: normalizedUserId,
        mode: 'exclusive',
      });

      const now = new Date();
      const nowIso = now.toISOString();

      if (passwordResetTokenHash !== undefined) {
        const resetCandidateRows: AppTokenRow[] = await runner.query(
          `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt"
             FROM core."appToken"
            WHERE value = $1
              AND type = 'PASSWORD_RESET_TOKEN'
            ORDER BY id
            FOR UPDATE`,
          [passwordResetTokenHash],
        );
        const validResetToken = resetCandidateRows.find((row) => {
          const expiresIso = toIso(row.expiresAt);

          return (
            row.deletedAt === null &&
            row.revokedAt === null &&
            row.userId !== null &&
            uuid(row.userId) === normalizedUserId &&
            expiresIso !== null &&
            expiresIso > nowIso
          );
        });
        if (!validResetToken) {
          return onInvalidResetToken();
        }
      }

      const readUserSnapshot = async (): Promise<
        Record<string, unknown> | undefined
      > => {
        const rows: { snapshot?: Record<string, unknown> }[] =
          await runner.query(
            'SELECT to_jsonb(account) AS snapshot FROM core."user" AS account WHERE id = $1',
            [normalizedUserId],
          );

        return rows[0]?.snapshot;
      };

      await runner.query(
        'SELECT id FROM core."user" WHERE id = $1 FOR UPDATE',
        [normalizedUserId],
      );
      const beforeUser = await readUserSnapshot();
      if (!beforeUser) {
        return onUserNotFound();
      }
      if (
        !Object.hasOwn(beforeUser, 'deletedAt') ||
        !Object.hasOwn(beforeUser, 'passwordHash')
      ) {
        throw new Error('Password update user snapshot is invalid');
      }
      if (beforeUser.deletedAt !== null) {
        return onUserNotFound();
      }

      const activeMemberships: ActiveMembershipRow[] = await runner.query(
        `SELECT uw.id, uw."userId", uw."workspaceId", uw.locale
           FROM core."userWorkspace" uw
           JOIN core.workspace w
             ON w.id = uw."workspaceId"
            AND w."deletedAt" IS NULL
          WHERE uw."userId" = $1
            AND uw."deletedAt" IS NULL
          ORDER BY uw.id ASC
          FOR KEY SHARE OF uw`,
        [normalizedUserId],
      );
      if (activeMemberships.length === 0) {
        return onUserWorkspaceNotFound();
      }
      if (newPasswordHash === null) {
        return onInvalidPassword!();
      }

      await runner.query(
        `UPDATE core."user"
            SET "passwordHash" = $1,
                "updatedAt" = $2
          WHERE id = $3
            AND "deletedAt" IS NULL`,
        [newPasswordHash, now, normalizedUserId],
      );

      const afterUser = await readUserSnapshot();
      const stripPasswordAndUpdated = (value: Record<string, unknown>) => {
        const {
          passwordHash: _passwordHash,
          updatedAt: _updatedAt,
          ...rest
        } = value;

        return canonicalAuditJson(rest);
      };
      if (
        !afterUser ||
        afterUser.deletedAt !== null ||
        afterUser.passwordHash !== newPasswordHash ||
        stripPasswordAndUpdated(beforeUser) !==
          stripPasswordAndUpdated(afterUser)
      ) {
        throw new Error('Password update user effects mismatch');
      }
      const pinnedAfterUser = canonicalAuditJson(afterUser);

      const resetTokenRows: AppTokenRow[] = await runner.query(
        `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt"
           FROM core."appToken"
          WHERE "userId" = $1
            AND type = 'PASSWORD_RESET_TOKEN'
          ORDER BY id
          FOR UPDATE`,
        [normalizedUserId],
      );
      const expectedResetById = new Map<string, Record<string, unknown>>();
      for (const resetRow of resetTokenRows) {
        const resetId = uuid(resetRow.id);
        const prevRevokedAt = toIso(resetRow.revokedAt);
        const nextRevokedAt = prevRevokedAt ?? nowIso;
        if (prevRevokedAt === null) {
          await runner.query(
            `UPDATE core."appToken"
                SET "revokedAt" = $1,
                    "updatedAt" = $1
              WHERE id = $2`,
            [now, resetId],
          );
        }
        expectedResetById.set(resetId, {
          ...normalizeAppTokenRow(resetRow),
          revokedAt: nextRevokedAt,
        });
      }

      const refreshRows: AppTokenRow[] = await runner.query(
        `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt"
           FROM core."appToken"
          WHERE "userId" = $1
            AND type = 'REFRESH_TOKEN'
            AND ("revokedAt" IS NULL OR "expiresAt" > $2)
          ORDER BY id
          FOR UPDATE`,
        [normalizedUserId, now],
      );

      const sharedCorrelationId = request.correlationId ?? randomUUID();
      const activeWorkspaceCache = new Map<string, boolean>();
      for (const m of activeMemberships) {
        activeWorkspaceCache.set(uuid(m.workspaceId), true);
      }
      const contextsByWorkspace = new Map<string, CrmAuditTransactionContext>();
      const getWorkspaceAuditContext = async (
        workspaceId: string,
      ): Promise<CrmAuditTransactionContext | undefined> => {
        const normalizedWorkspaceId = uuid(workspaceId);
        let isActiveWorkspace = activeWorkspaceCache.get(normalizedWorkspaceId);
        if (isActiveWorkspace === undefined) {
          const wsRows: { id: string }[] = await runner.query(
            'SELECT id FROM core.workspace WHERE id = $1 AND "deletedAt" IS NULL',
            [normalizedWorkspaceId],
          );
          isActiveWorkspace = wsRows.length === 1;
          activeWorkspaceCache.set(normalizedWorkspaceId, isActiveWorkspace);
        }
        if (!isActiveWorkspace) {
          return undefined;
        }
        const existing = contextsByWorkspace.get(normalizedWorkspaceId);
        if (existing) {
          return existing;
        }
        const operation = await resolveRoleAuditInitiator(
          runner,
          {
            workspaceId: normalizedWorkspaceId,
            operationId: randomUUID(),
            actor: { ...request.actor },
            ...(request.initiator
              ? { initiator: { ...request.initiator } }
              : {}),
            correlationId: sharedCorrelationId,
            ...(request.causationId
              ? { causationId: request.causationId }
              : {}),
          },
          request.impersonatorUserWorkspaceId,
        );
        const context = new CrmAuditTransactionContext(runner, operation);
        contextsByWorkspace.set(normalizedWorkspaceId, context);

        return context;
      };

      const expectedRefreshById = new Map<string, Record<string, unknown>>();
      for (const tokenRow of refreshRows) {
        if (
          tokenRow.context !== null &&
          (typeof tokenRow.context !== 'object' ||
            Array.isArray(tokenRow.context))
        ) {
          throw new Error('Refresh token context is invalid');
        }
        const tokenId = uuid(tokenRow.id);
        const prevRevokedAt = toIso(tokenRow.revokedAt);
        const rawPrevReason = (
          tokenRow.context as { revokedReason?: unknown } | null
        )?.revokedReason;
        if (
          rawPrevReason !== undefined &&
          rawPrevReason !== null &&
          (typeof rawPrevReason !== 'string' || !rawPrevReason.length)
        ) {
          throw new Error('Refresh token revokedReason is invalid');
        }
        const prevReason =
          typeof rawPrevReason === 'string' ? rawPrevReason : null;

        if (prevRevokedAt !== null && prevReason !== null) {
          expectedRefreshById.set(tokenId, normalizeAppTokenRow(tokenRow));
          continue;
        }

        const nextRevokedAt = prevRevokedAt ?? nowIso;
        const nextReason = prevReason ?? revokedReason;
        const nextContext = {
          ...(tokenRow.context ?? {}),
          revokedReason: nextReason,
        };

        await runner.query(
          `UPDATE core."appToken"
              SET "revokedAt" = COALESCE("revokedAt", $1),
                  context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('revokedReason', $2::text),
                  "updatedAt" = $1
            WHERE id = $3`,
          [now, nextReason, tokenId],
        );

        expectedRefreshById.set(tokenId, {
          ...normalizeAppTokenRow(tokenRow),
          revokedAt: nextRevokedAt,
          context: nextContext,
        });

        if (tokenRow.workspaceId !== null) {
          const audit = await getWorkspaceAuditContext(tokenRow.workspaceId);
          audit?.record({
            resourceKind: 'refreshToken',
            resourceId: tokenId,
            action: 'update',
            before: {
              revokedAt: prevRevokedAt,
              revokedReason: prevReason,
            },
            after: {
              revokedAt: nextRevokedAt,
              revokedReason: nextReason,
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

      const verifyPersistedState = async (): Promise<void> => {
        const currentUser = await readUserSnapshot();
        if (
          !currentUser ||
          canonicalAuditJson(currentUser) !== pinnedAfterUser
        ) {
          throw new Error('Password update user state changed before commit');
        }

        const currentResetRows: AppTokenRow[] = await runner.query(
          `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt"
             FROM core."appToken"
            WHERE "userId" = $1
              AND type = 'PASSWORD_RESET_TOKEN'
            ORDER BY id`,
          [normalizedUserId],
        );
        if (currentResetRows.length !== expectedResetById.size) {
          throw new Error('Password reset token count changed before commit');
        }
        for (const row of currentResetRows) {
          const normalized = normalizeAppTokenRow(row);
          const expected = expectedResetById.get(uuid(row.id));
          if (
            !expected ||
            row.revokedAt === null ||
            canonicalAuditJson(normalized) !== canonicalAuditJson(expected)
          ) {
            throw new Error('Password reset token state changed before commit');
          }
        }

        const currentRefreshRows: AppTokenRow[] = await runner.query(
          `SELECT id, "userId", "workspaceId", type, value, "expiresAt", "deletedAt", "revokedAt", context, "createdAt"
             FROM core."appToken"
            WHERE "userId" = $1
              AND type = 'REFRESH_TOKEN'
              AND ("revokedAt" IS NULL OR "expiresAt" > $2)
            ORDER BY id`,
          [normalizedUserId, now],
        );
        if (currentRefreshRows.length !== expectedRefreshById.size) {
          throw new Error('Refresh token count changed before commit');
        }
        for (const row of currentRefreshRows) {
          const normalized = normalizeAppTokenRow(row);
          const expected = expectedRefreshById.get(uuid(row.id));
          const reason = (row.context as { revokedReason?: unknown } | null)
            ?.revokedReason;
          if (
            !expected ||
            row.revokedAt === null ||
            typeof reason !== 'string' ||
            !reason.length ||
            canonicalAuditJson(normalized) !== canonicalAuditJson(expected)
          ) {
            throw new Error('Refresh token state changed before commit');
          }
        }
      };

      await verifyPersistedState();

      for (const audit of contextsByWorkspace.values()) {
        await audit.flush();
      }

      await verifyPersistedState();

      const firstMembership = activeMemberships[0];

      return {
        user: {
          id: normalizedUserId,
          email: String(afterUser.email ?? ''),
          firstName: String(afterUser.firstName ?? ''),
          lastName: String(afterUser.lastName ?? ''),
        },
        firstUserWorkspace: {
          id: uuid(firstMembership.id),
          workspaceId: uuid(firstMembership.workspaceId),
          locale: String(firstMembership.locale ?? 'en'),
        },
      };
    }),
  );
};
