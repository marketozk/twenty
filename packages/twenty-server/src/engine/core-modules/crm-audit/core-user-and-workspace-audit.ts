import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

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

export type CoreUserAndWorkspaceAuditIdentity =
  | RoleUpdateAuditIdentity
  | CrmAuditOperation
  | {
      workspaceId?: string;
      operationId?: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      impersonatorUserWorkspaceId?: string;
      correlationId?: string;
      causationId?: string;
    };

export type CoreUserAndWorkspaceAuditRequest = {
  readonly workspaceId?: string;
  readonly operationId?: string;
  readonly actor: CrmAuditOperation['actor'];
  readonly initiator?: CrmAuditOperation['initiator'];
  readonly impersonatorUserWorkspaceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
};

type AmbientCoreUserAndWorkspaceAudit = {
  readonly workspaceId?: string;
  readonly actor?: CrmAuditOperation['actor'];
  readonly initiator?: CrmAuditOperation['initiator'];
  readonly impersonatorUserWorkspaceId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
};

type UserWorkspaceSnapshotRow = {
  id: string;
  userId: string;
  workspaceId: string;
  locale: string | null;
  defaultAvatarUrl: string | null;
  deletedAt: Date | string | null;
};

const ambientStorage =
  new AsyncLocalStorage<AmbientCoreUserAndWorkspaceAudit>();
const activeRequests = new WeakSet<CoreUserAndWorkspaceAuditRequest>();
const consumedRequests = new WeakSet<CoreUserAndWorkspaceAuditRequest>();

const uuid = (value: string): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Core user/workspace audit UUID is invalid');
  }

  return value.toLowerCase();
};

const optionalUuid = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !isUUID(value)) {
    return undefined;
  }

  return value.toLowerCase();
};

const consumeRequest = (request: CoreUserAndWorkspaceAuditRequest): void => {
  if (
    !request ||
    typeof request !== 'object' ||
    !activeRequests.has(request) ||
    consumedRequests.has(request)
  ) {
    throw new Error(
      'Core user/workspace audit request is invalid or already consumed',
    );
  }
  consumedRequests.add(request);
};

const makeRequest = (
  value: CoreUserAndWorkspaceAuditRequest,
): CoreUserAndWorkspaceAuditRequest => {
  const frozen = Object.freeze({
    ...(value.workspaceId !== undefined
      ? { workspaceId: uuid(value.workspaceId) }
      : {}),
    ...(value.operationId !== undefined
      ? { operationId: uuid(value.operationId) }
      : {}),
    actor: Object.freeze({
      kind: value.actor.kind,
      id:
        value.actor.kind === 'coreUser' ? uuid(value.actor.id) : value.actor.id,
    }),
    ...(value.initiator !== undefined
      ? {
          initiator: Object.freeze({
            kind: value.initiator.kind,
            id:
              value.initiator.kind === 'coreUser'
                ? uuid(value.initiator.id)
                : value.initiator.id,
          }),
        }
      : {}),
    ...(value.impersonatorUserWorkspaceId !== undefined
      ? {
          impersonatorUserWorkspaceId: uuid(value.impersonatorUserWorkspaceId),
        }
      : {}),
    ...(value.correlationId !== undefined
      ? { correlationId: value.correlationId }
      : {}),
    ...(value.causationId !== undefined
      ? { causationId: value.causationId }
      : {}),
  });
  activeRequests.add(frozen);

  return frozen;
};

export const withCoreUserAndWorkspaceAudit = <T>(
  identity: {
    workspaceId?: string;
    actor?: CrmAuditOperation['actor'];
    initiator?: CrmAuditOperation['initiator'];
    impersonatorUserWorkspaceId?: string;
    correlationId?: string;
    causationId?: string;
  },
  work: () => Promise<T>,
): Promise<T> => {
  const parent = ambientStorage.getStore();
  const normalizedWorkspaceId =
    optionalUuid(identity.workspaceId) ?? parent?.workspaceId;
  const normalizedImpersonator =
    optionalUuid(identity.impersonatorUserWorkspaceId) ??
    parent?.impersonatorUserWorkspaceId;
  const rawActor = identity.actor ?? parent?.actor;
  const actor =
    rawActor !== undefined &&
    (rawActor.kind !== 'coreUser' || isUUID(rawActor.id))
      ? Object.freeze({
          kind: rawActor.kind,
          id: rawActor.kind === 'coreUser' ? uuid(rawActor.id) : rawActor.id,
        })
      : undefined;
  const rawInitiator = identity.initiator ?? parent?.initiator;
  const initiator =
    rawInitiator !== undefined &&
    (rawInitiator.kind !== 'coreUser' || isUUID(rawInitiator.id))
      ? Object.freeze({
          kind: rawInitiator.kind,
          id:
            rawInitiator.kind === 'coreUser'
              ? uuid(rawInitiator.id)
              : rawInitiator.id,
        })
      : undefined;

  const scope: AmbientCoreUserAndWorkspaceAudit = Object.freeze({
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

export const captureCoreUserAndWorkspaceAudit = ({
  fallbackUserId,
  fallbackWorkspaceId,
  identity,
}: {
  fallbackUserId: string;
  fallbackWorkspaceId?: string;
  identity?: CoreUserAndWorkspaceAuditIdentity;
}): CoreUserAndWorkspaceAuditRequest => {
  const normalizedFallbackUserId = uuid(fallbackUserId);
  const normalizedFallbackWorkspaceId = optionalUuid(fallbackWorkspaceId);
  const ambientScope = ambientStorage.getStore();

  if (identity !== undefined) {
    if (!identity || typeof identity !== 'object') {
      throw new Error('Core user/workspace audit identity is invalid');
    }
    if (consumedRequests.has(identity as CoreUserAndWorkspaceAuditRequest)) {
      throw new Error(
        'Core user/workspace audit request is invalid or already consumed',
      );
    }
    if (activeRequests.has(identity as CoreUserAndWorkspaceAuditRequest)) {
      return identity as CoreUserAndWorkspaceAuditRequest;
    }

    if ('auth' in identity) {
      const targetWorkspaceId =
        optionalUuid(identity.auth?.workspace?.id) ??
        normalizedFallbackWorkspaceId ??
        ambientScope?.workspaceId ??
        peekCurrentCrmAuditWorkspaceId() ??
        normalizedFallbackUserId;
      const captured = captureRoleAuditOperation(targetWorkspaceId, {
        ...identity,
        auth: {
          ...identity.auth,
          workspace: { id: targetWorkspaceId },
        },
      });
      const explicitWorkspaceId =
        optionalUuid(identity.auth?.workspace?.id) ??
        normalizedFallbackWorkspaceId ??
        ambientScope?.workspaceId ??
        peekCurrentCrmAuditWorkspaceId();

      return makeRequest({
        ...(explicitWorkspaceId !== undefined
          ? { workspaceId: explicitWorkspaceId }
          : {}),
        actor: { ...captured.actor },
        ...(captured.initiator ? { initiator: { ...captured.initiator } } : {}),
        ...(optionalUuid(identity.impersonatorUserWorkspaceId) !== undefined
          ? {
              impersonatorUserWorkspaceId: optionalUuid(
                identity.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
        correlationId:
          captured.correlationId ??
          identity.correlationId ??
          ambientScope?.correlationId ??
          randomUUID(),
        ...(captured.causationId !== undefined
          ? { causationId: captured.causationId }
          : identity.causationId !== undefined
            ? { causationId: identity.causationId }
            : {}),
      });
    }

    if (!('actor' in identity)) {
      throw new Error('Core user/workspace audit identity is invalid');
    }

    const explicitWorkspaceId =
      optionalUuid(identity.workspaceId) ??
      normalizedFallbackWorkspaceId ??
      ambientScope?.workspaceId;
    const rawImpersonator =
      'impersonatorUserWorkspaceId' in identity
        ? optionalUuid(identity.impersonatorUserWorkspaceId)
        : undefined;

    return makeRequest({
      ...(explicitWorkspaceId !== undefined
        ? { workspaceId: explicitWorkspaceId }
        : {}),
      ...('operationId' in identity &&
      optionalUuid(identity.operationId) !== undefined
        ? { operationId: optionalUuid(identity.operationId) }
        : {}),
      actor: { ...identity.actor },
      ...(identity.initiator ? { initiator: { ...identity.initiator } } : {}),
      ...(rawImpersonator !== undefined
        ? { impersonatorUserWorkspaceId: rawImpersonator }
        : {}),
      correlationId:
        identity.correlationId ?? ambientScope?.correlationId ?? randomUUID(),
      ...(identity.causationId !== undefined
        ? { causationId: identity.causationId }
        : {}),
    });
  }

  if (ambientScope !== undefined) {
    const resolvedWorkspaceId =
      normalizedFallbackWorkspaceId ?? ambientScope.workspaceId;

    return makeRequest({
      ...(resolvedWorkspaceId !== undefined
        ? { workspaceId: resolvedWorkspaceId }
        : {}),
      actor: ambientScope.actor
        ? { ...ambientScope.actor }
        : { kind: 'coreUser', id: normalizedFallbackUserId },
      ...(ambientScope.initiator
        ? { initiator: { ...ambientScope.initiator } }
        : {}),
      ...(ambientScope.impersonatorUserWorkspaceId !== undefined
        ? {
            impersonatorUserWorkspaceId:
              ambientScope.impersonatorUserWorkspaceId,
          }
        : {}),
      correlationId: ambientScope.correlationId,
      ...(ambientScope.causationId !== undefined
        ? { causationId: ambientScope.causationId }
        : {}),
    });
  }

  const ambientWorkspaceId =
    normalizedFallbackWorkspaceId ?? peekCurrentCrmAuditWorkspaceId();
  if (ambientWorkspaceId !== undefined) {
    try {
      const captured = captureCurrentCrmAuditOperation(ambientWorkspaceId);
      if (captured !== undefined) {
        return makeRequest({
          workspaceId: ambientWorkspaceId,
          actor: { ...captured.operation.actor },
          ...(captured.operation.initiator
            ? { initiator: { ...captured.operation.initiator } }
            : {}),
          ...(optionalUuid(captured.impersonatorUserWorkspaceId) !== undefined
            ? {
                impersonatorUserWorkspaceId: optionalUuid(
                  captured.impersonatorUserWorkspaceId,
                ),
              }
            : {}),
          correlationId: captured.operation.correlationId ?? randomUUID(),
          ...(captured.operation.causationId !== undefined
            ? { causationId: captured.operation.causationId }
            : {}),
        });
      }
    } catch {
      // Fall through to self coreUser actor when ambient request has no workspace-scoped principal.
    }
  }

  return makeRequest({
    ...(normalizedFallbackWorkspaceId !== undefined
      ? { workspaceId: normalizedFallbackWorkspaceId }
      : {}),
    actor: { kind: 'coreUser', id: normalizedFallbackUserId },
    correlationId: randomUUID(),
  });
};

export const recordAuditedUserWorkspaceCreate = async ({
  runner,
  request,
  id,
  userId,
  workspaceId,
  expectedLocale,
  expectedDefaultAvatarUrl,
}: {
  runner: QueryRunner;
  request: CoreUserAndWorkspaceAuditRequest;
  id: string;
  userId: string;
  workspaceId: string;
  expectedLocale: string;
  expectedDefaultAvatarUrl: string | null | undefined;
}): Promise<void> => {
  consumeRequest(request);
  const normalizedId = uuid(id);
  const normalizedUserId = uuid(userId);
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    request.workspaceId !== undefined &&
    request.workspaceId !== normalizedWorkspaceId
  ) {
    throw new Error('Membership creation audit workspace mismatch');
  }

  const wsRows: { id: string; deletedAt: string | null }[] = await runner.query(
    `SELECT w.id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
         FROM core.workspace w
        WHERE w.id = $1`,
    [normalizedWorkspaceId],
  );
  if (wsRows.length > 0 && wsRows[0].deletedAt !== null) {
    throw new Error('Membership creation workspace is deleted');
  }

  const readPersistedMembership = async (): Promise<
    UserWorkspaceSnapshotRow | undefined
  > => {
    const rows: UserWorkspaceSnapshotRow[] = await runner.query(
      `SELECT membership.id,
              membership."userId",
              membership."workspaceId",
              to_jsonb(membership)->>'locale' AS locale,
              to_jsonb(membership)->>'defaultAvatarUrl' AS "defaultAvatarUrl",
              membership."deletedAt"
         FROM core."userWorkspace" membership
         JOIN core."user" account ON account.id = membership."userId"
        WHERE membership.id = $1
          AND membership."userId" = $2
          AND membership."workspaceId" = $3
          AND membership."deletedAt" IS NULL
          AND account."deletedAt" IS NULL`,
      [normalizedId, normalizedUserId, normalizedWorkspaceId],
    );

    return rows[0];
  };

  const verifyPersistedMembership =
    async (): Promise<UserWorkspaceSnapshotRow> => {
      const row = await readPersistedMembership();
      if (
        !row ||
        uuid(row.id) !== normalizedId ||
        uuid(row.userId) !== normalizedUserId ||
        uuid(row.workspaceId) !== normalizedWorkspaceId ||
        row.deletedAt !== null ||
        (row.locale ?? expectedLocale) !== expectedLocale ||
        (row.defaultAvatarUrl ?? null) !== (expectedDefaultAvatarUrl ?? null)
      ) {
        throw new Error('Membership creation effects mismatch');
      }

      return row;
    };

  const persisted = await verifyPersistedMembership();

  const operation = await resolveRoleAuditInitiator(
    runner,
    {
      workspaceId: normalizedWorkspaceId,
      operationId: request.operationId ?? randomUUID(),
      actor: { ...request.actor },
      ...(request.initiator ? { initiator: { ...request.initiator } } : {}),
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
      ...(request.causationId ? { causationId: request.causationId } : {}),
    },
    request.impersonatorUserWorkspaceId,
  );

  const context = new CrmAuditTransactionContext(runner, operation);
  context.record({
    resourceKind: 'userWorkspace',
    resourceId: normalizedId,
    action: 'create',
    before: null,
    after: {
      userId: normalizedUserId,
      locale: persisted.locale ?? expectedLocale,
      defaultAvatarUrl: persisted.defaultAvatarUrl ?? null,
      deletedAt: null,
    },
    securityDescriptor: {
      resourceKind: 'userWorkspace',
      resourceId: normalizedId,
      metadataAccess: 'currentWorkspaceAdministration',
    },
  });
  await context.flush();
  await verifyPersistedMembership();
};

export const runAuditedUserWorkspaceLocaleUpdate = async ({
  dataSource,
  request,
  userWorkspaceId,
  locale,
  updateEntity,
  invalidateCache,
  onCacheInvalidateError,
}: {
  dataSource: DataSource;
  request: CoreUserAndWorkspaceAuditRequest;
  userWorkspaceId: string;
  locale: string;
  updateEntity: (runner: QueryRunner) => Promise<{ affected?: number }>;
  invalidateCache: () => Promise<unknown>;
  onCacheInvalidateError: (error: unknown) => void;
}): Promise<void> => {
  consumeRequest(request);
  const normalizedUserWorkspaceId = uuid(userWorkspaceId);
  if (typeof locale !== 'string' || !locale.length) {
    throw new Error('Membership locale is invalid');
  }

  let shouldInvalidateCache = false;
  try {
    await runInCoreAuditTransaction(dataSource, async (runner: QueryRunner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");

      const readMembership = async (
        lock: boolean,
      ): Promise<UserWorkspaceSnapshotRow | undefined> => {
        const rows: UserWorkspaceSnapshotRow[] = await runner.query(
          `SELECT uw.id,
                  uw."userId",
                  uw."workspaceId",
                  to_jsonb(uw)->>'locale' AS locale,
                  to_jsonb(uw)->>'defaultAvatarUrl' AS "defaultAvatarUrl",
                  uw."deletedAt"
             FROM core."userWorkspace" uw
            WHERE uw.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
          [normalizedUserWorkspaceId],
        );

        return rows[0];
      };

      const before = await readMembership(true);
      if (!before || before.deletedAt !== null) {
        return;
      }

      const normalizedUserId = uuid(before.userId);
      const normalizedWorkspaceId = uuid(before.workspaceId);

      const userRows: { id: string; deletedAt: Date | string | null }[] =
        await runner.query(
          'SELECT id, "deletedAt" FROM core."user" WHERE id = $1',
          [normalizedUserId],
        );
      if (userRows.length !== 1 || userRows[0].deletedAt !== null) {
        return;
      }

      const wsRows: { id: string; deletedAt: string | null }[] =
        await runner.query(
          `SELECT w.id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
             FROM core.workspace w
            WHERE w.id = $1`,
          [normalizedWorkspaceId],
        );
      if (wsRows.length > 0 && wsRows[0].deletedAt !== null) {
        return;
      }

      if (
        request.workspaceId !== undefined &&
        request.workspaceId !== normalizedWorkspaceId
      ) {
        throw new Error('Membership locale update workspace mismatch');
      }

      const beforeLocale = before.locale ?? 'en';
      if (beforeLocale === locale) {
        return;
      }

      shouldInvalidateCache = true;
      const updateResult = await updateEntity(runner);

      const verifyAfter = async (): Promise<UserWorkspaceSnapshotRow> => {
        const after = await readMembership(false);
        if (
          updateResult.affected !== 1 ||
          !after ||
          after.deletedAt !== null ||
          uuid(after.id) !== normalizedUserWorkspaceId ||
          uuid(after.userId) !== normalizedUserId ||
          uuid(after.workspaceId) !== normalizedWorkspaceId ||
          after.locale !== locale ||
          (after.defaultAvatarUrl ?? null) !== (before.defaultAvatarUrl ?? null)
        ) {
          throw new Error('Membership locale update effects mismatch');
        }

        return after;
      };

      const after = await verifyAfter();

      const actorFromRequest =
        request.actor.kind === 'coreUser' &&
        request.actor.id === normalizedUserWorkspaceId
          ? { kind: 'coreUser' as const, id: normalizedUserId }
          : { ...request.actor };

      const operation = await resolveRoleAuditInitiator(
        runner,
        {
          workspaceId: normalizedWorkspaceId,
          operationId: request.operationId ?? randomUUID(),
          actor: actorFromRequest,
          ...(request.initiator ? { initiator: { ...request.initiator } } : {}),
          ...(request.correlationId
            ? { correlationId: request.correlationId }
            : {}),
          ...(request.causationId ? { causationId: request.causationId } : {}),
        },
        request.impersonatorUserWorkspaceId,
      );

      const context = new CrmAuditTransactionContext(runner, operation);
      context.record({
        resourceKind: 'userWorkspace',
        resourceId: normalizedUserWorkspaceId,
        action: 'update',
        before: {
          userId: normalizedUserId,
          locale: beforeLocale,
          defaultAvatarUrl: before.defaultAvatarUrl ?? null,
          deletedAt: null,
        },
        after: {
          userId: normalizedUserId,
          locale: after.locale,
          defaultAvatarUrl: after.defaultAvatarUrl ?? null,
          deletedAt: null,
        },
        securityDescriptor: {
          resourceKind: 'userWorkspace',
          resourceId: normalizedUserWorkspaceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      await context.flush();
      await verifyAfter();
    });
  } finally {
    if (shouldInvalidateCache) {
      try {
        await invalidateCache();
      } catch (error) {
        onCacheInvalidateError(error);
      }
    }
  }
};

const CORE_USER_TRACKED_FIELDS = [
  'isEmailVerified',
  'canAccessFullAdminPanel',
  'canImpersonate',
  'email',
  'passwordHash',
  'deletedAt',
] as const;

export const recordAuditedCoreUserUpdate = async ({
  runner,
  request,
  userId,
  beforeSnapshot,
  afterSnapshot,
  explicitWorkspaceIds = [],
}: {
  runner: QueryRunner;
  request: CoreUserAndWorkspaceAuditRequest;
  userId: string;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  explicitWorkspaceIds?: readonly string[];
}): Promise<void> => {
  consumeRequest(request);
  const normalizedUserId = uuid(userId);

  const hasTrackedChange = CORE_USER_TRACKED_FIELDS.some((field) =>
    Object.hasOwn(beforeSnapshot, field) || Object.hasOwn(afterSnapshot, field)
      ? canonicalAuditJson(beforeSnapshot[field] ?? null) !==
        canonicalAuditJson(afterSnapshot[field] ?? null)
      : false,
  );
  if (!hasTrackedChange) {
    return;
  }

  const membershipRows: { id: string; workspaceId: string | null }[] =
    await runner.query(
      `SELECT uw.id,
              to_jsonb(uw)->>'workspaceId' AS "workspaceId"
         FROM core."userWorkspace" uw
        WHERE uw."userId" = $1
          AND uw."deletedAt" IS NULL
        ORDER BY uw.id ASC
        FOR KEY SHARE OF uw`,
      [normalizedUserId],
    );

  const candidateWorkspaceIds = new Set<string>();
  for (const explicitWsId of explicitWorkspaceIds) {
    const normalized = optionalUuid(explicitWsId);
    if (normalized !== undefined) {
      candidateWorkspaceIds.add(normalized);
    }
  }
  if (request.workspaceId !== undefined) {
    candidateWorkspaceIds.add(uuid(request.workspaceId));
  }
  for (const row of membershipRows) {
    const normalized = optionalUuid(row.workspaceId);
    if (normalized !== undefined) {
      candidateWorkspaceIds.add(normalized);
    }
  }

  if (candidateWorkspaceIds.size === 0) {
    return;
  }

  const sortedCandidates = [...candidateWorkspaceIds].sort();
  const wsRows: { id: string; deletedAt: string | null }[] = await runner.query(
    `SELECT w.id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
         FROM core.workspace w
        WHERE w.id = ANY($1::uuid[])`,
    [sortedCandidates],
  );
  const deletedWorkspaceIds = new Set(
    wsRows.filter((row) => row.deletedAt !== null).map((row) => uuid(row.id)),
  );
  const targetWorkspaceIds = sortedCandidates.filter(
    (wsId) => !deletedWorkspaceIds.has(wsId),
  );
  if (targetWorkspaceIds.length === 0) {
    return;
  }

  const sharedCorrelationId = request.correlationId ?? randomUUID();

  for (const wsId of targetWorkspaceIds) {
    const operation = await resolveRoleAuditInitiator(
      runner,
      {
        workspaceId: wsId,
        operationId:
          targetWorkspaceIds.length === 1 && request.operationId !== undefined
            ? request.operationId
            : randomUUID(),
        actor: { ...request.actor },
        ...(request.initiator ? { initiator: { ...request.initiator } } : {}),
        correlationId: sharedCorrelationId,
        ...(request.causationId ? { causationId: request.causationId } : {}),
      },
      request.impersonatorUserWorkspaceId,
    );

    const context = new CrmAuditTransactionContext(runner, operation);
    context.record({
      resourceKind: 'coreUser',
      resourceId: normalizedUserId,
      action: 'update',
      before: beforeSnapshot,
      after: afterSnapshot,
      securityDescriptor: {
        resourceKind: 'coreUser',
        resourceId: normalizedUserId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await context.flush();
  }
};
