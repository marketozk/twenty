import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
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
  roleAuditIdentityFromRequest,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type CoreWorkflowAndViewRequestIdentity = {
  workspaceId?: string;
  workspace?: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  apiKey?: { id: string } | null;
  application?: { id: string } | null;
  agentId?: string;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  impersonatorUserWorkspaceId?: string;
  correlationId?: string;
  causationId?: string;
};

export type CoreWorkflowAndViewAuditIdentity =
  | RoleUpdateAuditIdentity
  | MembershipCleanupIdentity
  | Parameters<typeof roleAuditIdentityFromRequest>[0]
  | CoreWorkflowAndViewRequestIdentity;

export type CoreWorkflowVisibilityAuditRequest = Readonly<{
  kind: 'coreWorkflowVisibility';
  workspaceId: string;
  coreWorkflowId: string;
  userWorkspaceId: string;
  visibility: 'WORKSPACE' | 'UNLISTED';
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  runByVersion?: string | null;
}>;

export type CoreViewCreateAuditRequest = Readonly<{
  kind: 'coreViewCreate';
  workspaceId: string;
  viewId: string;
  userWorkspaceId?: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type CoreViewUpdateAuditRequest = Readonly<{
  kind: 'coreViewUpdate';
  workspaceId: string;
  viewId: string;
  userWorkspaceId?: string;
  expectDeactivate?: boolean;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type CoreViewAuditRequest =
  | CoreViewCreateAuditRequest
  | CoreViewUpdateAuditRequest;

export type CoreWorkflowAndViewAuditRequest =
  | CoreWorkflowVisibilityAuditRequest
  | CoreViewAuditRequest;

export type CoreViewAuditMappings = {
  application: { id: string; universalIdentifier: string };
  views: Record<string, { id: string } | undefined>;
};

type ViewMigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

const VALID_VISIBILITIES = new Set<string>(['WORKSPACE', 'UNLISTED']);

const VIEW_OVERRIDE_PROPERTY_KEYS = new Set<string>([
  'isActive',
  'name',
  'type',
  'icon',
  'position',
  'isCompact',
  'openRecordIn',
  'kanbanAggregateOperation',
  'kanbanAggregateOperationFieldMetadataId',
  'kanbanAggregateOperationFieldMetadataUniversalIdentifier',
  'anyFieldFilterValue',
  'calendarLayout',
  'calendarFieldMetadataId',
  'calendarFieldMetadataUniversalIdentifier',
  'calendarEndFieldMetadataId',
  'calendarEndFieldMetadataUniversalIdentifier',
  'visibility',
  'mainGroupByFieldMetadataId',
  'mainGroupByFieldMetadataUniversalIdentifier',
  'shouldHideEmptyGroups',
  'kanbanColumnWidth',
  'groupLoadLimit',
]);

const storage = new AsyncLocalStorage<CoreWorkflowAndViewAuditRequest>();
const active = new WeakSet<CoreWorkflowAndViewAuditRequest>();
const consumed = new WeakSet<CoreWorkflowAndViewAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Core workflow/view audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const assertWorkflowOrViewVisibility = (
  value: unknown,
): 'WORKSPACE' | 'UNLISTED' => {
  if (typeof value !== 'string' || !VALID_VISIBILITIES.has(value)) {
    throw new Error('Core workflow/view audit visibility is invalid');
  }

  return value as 'WORKSPACE' | 'UNLISTED';
};

const readViewOverrideProperty = (
  overrides: unknown,
  property: 'isActive' | 'visibility',
  ownerApplicationUniversalIdentifier?: string | null,
): unknown => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return undefined;
  }

  const record = overrides as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return undefined;
  }

  if (keys.some((key) => VIEW_OVERRIDE_PROPERTY_KEYS.has(key))) {
    return record[property];
  }

  const normalizedOwnerUid =
    typeof ownerApplicationUniversalIdentifier === 'string' &&
    isUUID(ownerApplicationUniversalIdentifier)
      ? ownerApplicationUniversalIdentifier.toLowerCase()
      : undefined;

  const nonOwnerEntries: unknown[] = [];
  let ownerEntry: unknown;
  for (const [authorKey, entry] of Object.entries(record)) {
    if (
      normalizedOwnerUid !== undefined &&
      authorKey.toLowerCase() === normalizedOwnerUid
    ) {
      ownerEntry = entry;
    } else {
      nonOwnerEntries.push(entry);
    }
  }

  for (const entry of [...nonOwnerEntries, ownerEntry]) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const candidate = (entry as Record<string, unknown>)[property];
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }

  return undefined;
};

export const resolveEffectiveViewIsActive = (
  row: Record<string, unknown>,
  ownerApplicationUniversalIdentifier?: string | null,
): boolean => {
  const overrideValue = readViewOverrideProperty(
    row.overrides !== undefined ? row.overrides : row.universalOverrides,
    'isActive',
    ownerApplicationUniversalIdentifier ??
      (typeof row.applicationUniversalIdentifier === 'string'
        ? row.applicationUniversalIdentifier
        : undefined),
  );
  if (typeof overrideValue === 'boolean') {
    return overrideValue;
  }

  return row.isActive === undefined || row.isActive === null
    ? true
    : Boolean(row.isActive);
};

export const resolveEffectiveViewVisibility = (
  row: Record<string, unknown>,
  ownerApplicationUniversalIdentifier?: string | null,
): 'WORKSPACE' | 'UNLISTED' => {
  const overrideValue = readViewOverrideProperty(
    row.overrides !== undefined ? row.overrides : row.universalOverrides,
    'visibility',
    ownerApplicationUniversalIdentifier ??
      (typeof row.applicationUniversalIdentifier === 'string'
        ? row.applicationUniversalIdentifier
        : undefined),
  );
  const raw = overrideValue !== undefined ? overrideValue : row.visibility;

  return assertWorkflowOrViewVisibility(raw ?? 'WORKSPACE');
};

export const projectCoreView = (
  row: Record<string, unknown>,
  ownerApplicationUniversalIdentifier?: string | null,
) => ({
  applicationId: nullableUuid(row.applicationId),
  objectMetadataId: uuid(row.objectMetadataId),
  type:
    row.type === undefined || row.type === null ? 'TABLE' : String(row.type),
  key: row.key === undefined || row.key === null ? null : String(row.key),
  isCustom: Boolean(row.isCustom ?? false),
  isActive: resolveEffectiveViewIsActive(
    row,
    ownerApplicationUniversalIdentifier,
  ),
  isSystemSideEffect: Boolean(row.isSystemSideEffect ?? false),
  createdByUserWorkspaceId: nullableUuid(row.createdByUserWorkspaceId),
  visibility: resolveEffectiveViewVisibility(
    row,
    ownerApplicationUniversalIdentifier,
  ),
  name: typeof row.name === 'string' ? row.name : '',
  icon:
    row.icon === undefined || row.icon === null ? null : String(row.icon),
  position:
    row.position === undefined || row.position === null
      ? 0
      : Number(row.position),
  anyFieldFilterValue:
    row.anyFieldFilterValue === undefined || row.anyFieldFilterValue === null
      ? null
      : String(row.anyFieldFilterValue),
  overrides:
    row.overrides === undefined || row.overrides === null
      ? null
      : row.overrides,
});

const lookupExistingView = (
  universalIdentifier: unknown,
  flatViewsByUniversalIdentifier?: Record<
    string,
    Record<string, unknown> | undefined
  >,
): Record<string, unknown> | undefined => {
  if (
    typeof universalIdentifier !== 'string' ||
    !flatViewsByUniversalIdentifier
  ) {
    return undefined;
  }

  const direct = flatViewsByUniversalIdentifier[universalIdentifier];
  if (direct) {
    return direct;
  }

  const lower = universalIdentifier.toLowerCase();
  if (flatViewsByUniversalIdentifier[lower]) {
    return flatViewsByUniversalIdentifier[lower];
  }

  for (const [key, value] of Object.entries(flatViewsByUniversalIdentifier)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  return undefined;
};

export const isAuditedCoreViewAction = (
  action: {
    type: string;
    metadataName: string;
    universalIdentifier?: string;
    update?: Record<string, unknown>;
  },
  flatViewsByUniversalIdentifier?: Record<
    string,
    Record<string, unknown> | undefined
  >,
): boolean => {
  if (action.metadataName !== 'view') {
    return false;
  }

  if (action.type === 'create' || action.type === 'delete') {
    return true;
  }

  if (action.type !== 'update' || !action.update) {
    return false;
  }

  const update = action.update;
  const touchesSecurityField =
    'visibility' in update ||
    'createdByUserWorkspaceId' in update ||
    'isActive' in update ||
    'overrides' in update ||
    'universalOverrides' in update;

  if (!touchesSecurityField) {
    return false;
  }

  const existing = lookupExistingView(
    action.universalIdentifier,
    flatViewsByUniversalIdentifier,
  );
  if (!existing) {
    return true;
  }

  const ownerUid =
    typeof existing.applicationUniversalIdentifier === 'string'
      ? existing.applicationUniversalIdentifier
      : undefined;

  const beforeCreatedBy = nullableUuid(existing.createdByUserWorkspaceId);
  const afterCreatedBy =
    'createdByUserWorkspaceId' in update &&
    update.createdByUserWorkspaceId !== undefined
      ? nullableUuid(update.createdByUserWorkspaceId)
      : beforeCreatedBy;

  const beforeVisibility = resolveEffectiveViewVisibility(existing, ownerUid);
  const beforeIsActive = resolveEffectiveViewIsActive(existing, ownerUid);

  const patched: Record<string, unknown> = {
    ...existing,
    ...('visibility' in update && update.visibility !== undefined
      ? { visibility: update.visibility }
      : {}),
    ...('isActive' in update && update.isActive !== undefined
      ? { isActive: update.isActive }
      : {}),
    ...('universalOverrides' in update
      ? {
          overrides: update.universalOverrides,
          universalOverrides: update.universalOverrides,
        }
      : 'overrides' in update
        ? { overrides: update.overrides }
        : {}),
  };

  const afterVisibility = resolveEffectiveViewVisibility(patched, ownerUid);
  const afterIsActive = resolveEffectiveViewIsActive(patched, ownerUid);

  return (
    beforeCreatedBy !== afterCreatedBy ||
    beforeVisibility !== afterVisibility ||
    beforeIsActive !== afterIsActive
  );
};

export const getCoreWorkflowAndViewAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Core workflow/view audit context mismatch');
  }

  return request;
};

export const getCoreViewAudit = (
  workspaceId: string,
): CoreViewAuditRequest | undefined => {
  const request = getCoreWorkflowAndViewAudit(workspaceId);
  if (!request) return undefined;
  if (request.kind !== 'coreViewCreate' && request.kind !== 'coreViewUpdate') {
    throw new Error('Core view audit context mismatch');
  }

  return request;
};

export const getCoreViewUpdateAudit = (
  workspaceId: string,
): CoreViewAuditRequest | undefined => getCoreViewAudit(workspaceId);

registerMetadataAuditScopeCheck(getCoreWorkflowAndViewAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: CoreWorkflowAndViewAuditIdentity | undefined,
  defaultSystemActorId?: string,
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
        throw new Error(
          'Core workflow/view mutation requires authenticated audit identity',
        );
      }

      return { operation };
    }

    const requestIdentity =
      identity && typeof identity === 'object' && !('auth' in identity)
        ? {
            ...(identity as CoreWorkflowAndViewRequestIdentity),
            workspace:
              (identity as CoreWorkflowAndViewRequestIdentity).workspace ?? {
                id: normalizedWorkspaceId,
              },
            ...(typeof (identity as CoreWorkflowAndViewRequestIdentity)
              .impersonatorUserWorkspaceId === 'string' &&
            !(identity as CoreWorkflowAndViewRequestIdentity)
              .impersonationContext
              ? {
                  impersonationContext: {
                    impersonatorUserWorkspaceId: (
                      identity as CoreWorkflowAndViewRequestIdentity
                    ).impersonatorUserWorkspaceId,
                  },
                }
              : {}),
          }
        : undefined;

    const roleIdentity =
      identity && typeof identity === 'object' && 'auth' in identity
        ? (identity as RoleUpdateAuditIdentity)
        : roleAuditIdentityFromRequest(
            requestIdentity as Parameters<
              typeof roleAuditIdentityFromRequest
            >[0],
          );
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
  if (ambient) {
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
  }

  if (defaultSystemActorId) {
    return {
      operation: captureCrmAuditOperation({
        workspaceId: normalizedWorkspaceId,
        operationId: randomUUID(),
        actor: { kind: 'system', id: defaultSystemActorId },
      }),
    };
  }

  throw new Error(
    'Core workflow/view mutation requires authenticated audit identity',
  );
};

export const captureCoreWorkflowVisibilityAudit = ({
  workspaceId,
  coreWorkflowId,
  userWorkspaceId,
  visibility,
  auditIdentity,
  runByVersion,
}: {
  workspaceId: string;
  coreWorkflowId: string;
  userWorkspaceId: string;
  visibility: string;
  auditIdentity?: CoreWorkflowAndViewAuditIdentity;
  runByVersion?: string | null;
}): (() => CoreWorkflowVisibilityAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const normalizedWorkflowId = uuid(coreWorkflowId);
    const normalizedUserWorkspaceId = uuid(userWorkspaceId);
    const normalizedVisibility = assertWorkflowOrViewVisibility(visibility);
    if (
      getCoreWorkflowAndViewAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getCoreWorkflowAndViewAudit,
      )
    ) {
      throw new Error('Nested core workflow/view audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );
    const request: CoreWorkflowVisibilityAuditRequest = Object.freeze({
      kind: 'coreWorkflowVisibility',
      workspaceId: normalizedWorkspaceId,
      coreWorkflowId: normalizedWorkflowId,
      userWorkspaceId: normalizedUserWorkspaceId,
      visibility: normalizedVisibility,
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      runByVersion: runByVersion ?? null,
    });

    return () => request;
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const captureCoreViewCreateAudit = ({
  workspaceId,
  userWorkspaceId,
  auditIdentity,
}: {
  workspaceId: string;
  userWorkspaceId?: string;
  auditIdentity?: CoreWorkflowAndViewAuditIdentity;
}): ((viewId: string) => CoreViewCreateAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const normalizedUserWorkspaceId =
      userWorkspaceId === undefined ? undefined : uuid(userWorkspaceId);
    if (
      getCoreWorkflowAndViewAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getCoreWorkflowAndViewAudit,
      )
    ) {
      throw new Error('Nested core workflow/view audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );

    return (viewId: string) =>
      Object.freeze({
        kind: 'coreViewCreate' as const,
        workspaceId: normalizedWorkspaceId,
        viewId: uuid(viewId),
        ...(normalizedUserWorkspaceId !== undefined
          ? { userWorkspaceId: normalizedUserWorkspaceId }
          : {}),
        operation,
        ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      });
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const captureCoreViewUpdateAudit = ({
  workspaceId,
  viewId,
  userWorkspaceId,
  expectDeactivate,
  auditIdentity,
  defaultSystemActorId,
}: {
  workspaceId: string;
  viewId: string;
  userWorkspaceId?: string;
  expectDeactivate?: boolean;
  auditIdentity?: CoreWorkflowAndViewAuditIdentity;
  defaultSystemActorId?: string;
}): (() => CoreViewUpdateAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const normalizedViewId = uuid(viewId);
    const normalizedUserWorkspaceId =
      userWorkspaceId === undefined ? undefined : uuid(userWorkspaceId);
    if (
      getCoreWorkflowAndViewAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getCoreWorkflowAndViewAudit,
      )
    ) {
      throw new Error('Nested core workflow/view audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
      defaultSystemActorId,
    );
    const request: CoreViewUpdateAuditRequest = Object.freeze({
      kind: 'coreViewUpdate',
      workspaceId: normalizedWorkspaceId,
      viewId: normalizedViewId,
      ...(normalizedUserWorkspaceId !== undefined
        ? { userWorkspaceId: normalizedUserWorkspaceId }
        : {}),
      ...(expectDeactivate ? { expectDeactivate: true } : {}),
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

export const withCoreViewAudit = async <TResult>(
  request: CoreViewAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    (request.kind !== 'coreViewCreate' && request.kind !== 'coreViewUpdate') ||
    consumed.has(request) ||
    getCoreWorkflowAndViewAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Nested core workflow/view audit is unsupported');
  }

  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

export const withCoreViewUpdateAudit = withCoreViewAudit;

const verifyActiveWorkspaceAndMembership = async (
  runner: QueryRunner,
  workspaceId: string,
  userWorkspaceId: string | undefined,
  operation: CrmAuditOperation,
  requireUserScopedActor = false,
): Promise<void> => {
  const [workspace] = await runner.query(
    `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR KEY SHARE`,
    [workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null) {
    throw new Error('Core workflow/view audit workspace unavailable');
  }

  if (requireUserScopedActor && userWorkspaceId === undefined) {
    throw new Error('Core workflow/view audit requires caller userWorkspaceId');
  }

  if (userWorkspaceId !== undefined) {
    const [membership] = await runner.query(
      `SELECT id,"userId","workspaceId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw.id=$1 FOR KEY SHARE`,
      [userWorkspaceId],
    );
    if (
      !membership ||
      membership.deletedAt !== null ||
      uuid(membership.workspaceId) !== workspaceId ||
      membership.userId === null ||
      membership.userId === undefined
    ) {
      throw new Error('Core workflow/view audit caller membership unavailable');
    }
    const normalizedMembershipUserId = uuid(membership.userId);
    const actor = operation.actor;
    const initiator = operation.initiator;
    const userPrincipal =
      actor.kind === 'coreUser' || actor.kind === 'workspaceMember'
        ? actor
        : initiator?.kind === 'coreUser' ||
            initiator?.kind === 'workspaceMember'
          ? initiator
          : undefined;

    if (!userPrincipal) {
      throw new Error(
        'Core workflow/view mutation with userWorkspaceId requires a user-scoped audit actor',
      );
    }

    if (userPrincipal.kind === 'coreUser') {
      if (uuid(userPrincipal.id) !== normalizedMembershipUserId) {
        throw new Error(
          'Core workflow/view audit caller membership user mismatch',
        );
      }
      return;
    }

    const workspaceSchema = `workspace_${workspaceId.replaceAll('-', '')}`;
    const [schemaReg] = await runner.query(
      `SELECT COALESCE(to_regclass($1), to_regclass($2)) AS "exists"`,
      [
        `"workspace_${workspaceId}"."workspaceMember"`,
        `"${workspaceSchema}"."workspaceMember"`,
      ],
    );
    if (schemaReg?.exists) {
      const [hyphenReg] = await runner.query(
        `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
        [`"workspace_${workspaceId}"."workspaceMember"`],
      );
      const targetSchema =
        hyphenReg?.exists === true
          ? `workspace_${workspaceId}`
          : workspaceSchema;
      const [member] = await runner.query(
        `SELECT "userId" FROM "${targetSchema}"."workspaceMember" WHERE id=$1 AND "deletedAt" IS NULL`,
        [uuid(userPrincipal.id)],
      );
      if (!member || uuid(member.userId) !== normalizedMembershipUserId) {
        throw new Error(
          'Core workflow/view audit workspaceMember actor does not match caller userWorkspace',
        );
      }
    }
  }
};

export const persistWorkflowRunShareReconciliationIntent = async ({
  runner,
  workspaceId,
  coreWorkflowId,
  applicationUniversalIdentifier,
  runByVersion,
  position = 0,
}: {
  runner: QueryRunner;
  workspaceId: string;
  coreWorkflowId: string;
  applicationUniversalIdentifier: string | null;
  runByVersion?: string | null;
  position?: number;
}): Promise<{ intentId: string; verify: () => Promise<void> } | undefined> => {
  const [tableReg] = await runner.query(
    `SELECT to_regclass('core."deferredWorkspaceMigrationAction"') IS NOT NULL AS "exists"`,
  );
  if (tableReg?.exists !== true) {
    return undefined;
  }

  let resolvedAppUid = applicationUniversalIdentifier;
  if (!resolvedAppUid) {
    const [fallbackApp] = await runner.query(
      `SELECT "universalIdentifier" FROM core.application a WHERE a."workspaceId"=$1 AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY id LIMIT 1`,
      [workspaceId],
    );
    resolvedAppUid = nullableUuid(fallbackApp?.universalIdentifier);
  }
  if (!resolvedAppUid) {
    throw new Error('Workflow reconciliation application unavailable');
  }

  const payloadJson = JSON.stringify({ version: 1, coreWorkflowId });
  const inserted = await runner.query(
    `INSERT INTO core."deferredWorkspaceMigrationAction"
      ("workspaceId", "applicationUniversalIdentifier", name, payload, position, "runByVersion")
     VALUES ($1,$2,'sync_workflowRunShares',$3::jsonb,$4,$5) RETURNING id`,
    [workspaceId, resolvedAppUid, payloadJson, position, runByVersion ?? null],
  );
  if (inserted.length !== 1 || !inserted[0]?.id) {
    throw new Error('Workflow reconciliation intent was not persisted');
  }
  const intentId = uuid(inserted[0].id);

  const verify = async () => {
    const rows = await runner.query(
      `SELECT id FROM core."deferredWorkspaceMigrationAction"
       WHERE id=$1 AND "workspaceId"=$2 AND "applicationUniversalIdentifier"=$3
         AND name='sync_workflowRunShares' AND payload=$4::jsonb
         AND status='PENDING' AND attempts=0`,
      [intentId, workspaceId, resolvedAppUid, payloadJson],
    );
    if (rows.length !== 1) {
      throw new Error('Workflow reconciliation intent changed before commit');
    }
  };
  await verify();

  return { intentId, verify };
};

export const completeWorkflowRunShareReconciliationIntent = async (
  dataSource: DataSource | undefined,
  workspaceId: string,
  intentId: string | undefined,
): Promise<void> => {
  if (!dataSource || !intentId) {
    return;
  }
  const [tableReg] = await dataSource.query(
    `SELECT to_regclass('core."deferredWorkspaceMigrationAction"') IS NOT NULL AS "exists"`,
  );
  if (tableReg?.exists !== true) {
    return;
  }
  await dataSource.query(
    `DELETE FROM core."deferredWorkspaceMigrationAction"
      WHERE id=$1 AND "workspaceId"=$2 AND name='sync_workflowRunShares' AND status='PENDING'`,
    [uuid(intentId), uuid(workspaceId)],
  );
};

export const runAuditedCoreWorkflowVisibilityUpdate = async (
  dataSource: DataSource | undefined,
  request: CoreWorkflowVisibilityAuditRequest,
  work: (runner: QueryRunner) => Promise<void>,
): Promise<
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'updated'; changed: boolean; intentId?: string }
> => {
  if (
    !request ||
    typeof request !== 'object' ||
    request.kind !== 'coreWorkflowVisibility' ||
    consumed.has(request) ||
    getCoreWorkflowAndViewAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Nested core workflow/view audit is unsupported');
  }
  if (!dataSource) {
    throw new Error('Core workflow visibility audit requires core DataSource');
  }

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await verifyActiveWorkspaceAndMembership(
          runner,
          request.workspaceId,
          request.userWorkspaceId,
          request.operation,
          true,
        );

        const readWorkflow = () =>
          runner.query(
            `SELECT w.id,
                    w."workspaceId",
                    to_jsonb(w)->>'createdByUserWorkspaceId' AS "createdByUserWorkspaceId",
                    to_jsonb(w)->>'visibility' AS "visibility",
                    to_jsonb(w)->>'deletedAt' AS "deletedAt",
                    to_jsonb(a)->>'workspaceId' AS "applicationWorkspaceId",
                    to_jsonb(a)->>'universalIdentifier' AS "applicationUniversalIdentifier"
               FROM core.workflow w
               LEFT JOIN core.application a ON a.id = w."applicationId"
              WHERE w.id=$1 AND w."workspaceId"=$2
                FOR NO KEY UPDATE OF w`,
            [request.coreWorkflowId, request.workspaceId],
          );

        const [beforeWorkflow] = await readWorkflow();
        if (!beforeWorkflow || beforeWorkflow.deletedAt !== null) {
          return { status: 'not_found' as const };
        }
        if (uuid(beforeWorkflow.workspaceId) !== request.workspaceId) {
          throw new Error('Core workflow visibility audit workspace mismatch');
        }

        const beforeCreatedBy = nullableUuid(
          beforeWorkflow.createdByUserWorkspaceId,
        );
        const beforeVisibility = assertWorkflowOrViewVisibility(
          beforeWorkflow.visibility,
        );

        if (
          beforeCreatedBy !== null &&
          beforeCreatedBy !== request.userWorkspaceId
        ) {
          return { status: 'forbidden' as const };
        }

        await work(runner);

        const [afterWorkflow] = await readWorkflow();
        if (
          !afterWorkflow ||
          afterWorkflow.deletedAt !== null ||
          uuid(afterWorkflow.workspaceId) !== request.workspaceId
        ) {
          throw new Error(
            'Core workflow visibility update removed or corrupted target workflow',
          );
        }

        const afterCreatedBy = nullableUuid(
          afterWorkflow.createdByUserWorkspaceId,
        );
        const afterVisibility = assertWorkflowOrViewVisibility(
          afterWorkflow.visibility,
        );

        if (
          afterCreatedBy !== request.userWorkspaceId ||
          afterVisibility !== request.visibility
        ) {
          throw new Error(
            'Core workflow visibility update did not persist expected state',
          );
        }

        const changed =
          beforeCreatedBy !== afterCreatedBy ||
          beforeVisibility !== afterVisibility;

        if (!changed) {
          return { status: 'updated' as const, changed: false };
        }

        const appWorkspaceId = nullableUuid(
          beforeWorkflow.applicationWorkspaceId,
        );
        if (appWorkspaceId !== null && appWorkspaceId !== request.workspaceId) {
          throw new Error(
            'Core workflow visibility audit application belongs to another workspace',
          );
        }

        const persistedIntent =
          await persistWorkflowRunShareReconciliationIntent({
            runner,
            workspaceId: request.workspaceId,
            coreWorkflowId: request.coreWorkflowId,
            applicationUniversalIdentifier: nullableUuid(
              beforeWorkflow.applicationUniversalIdentifier,
            ),
            runByVersion: request.runByVersion,
          });

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        audit.record({
          action: 'update',
          resourceKind: 'coreWorkflow',
          resourceId: request.coreWorkflowId,
          before: {
            createdByUserWorkspaceId: beforeCreatedBy,
            visibility: beforeVisibility,
          },
          after: {
            createdByUserWorkspaceId: afterCreatedBy,
            visibility: afterVisibility,
          },
          securityDescriptor: {
            resourceKind: 'coreWorkflow',
            resourceId: request.coreWorkflowId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();

        const [postFlushWorkflow] = await readWorkflow();
        if (
          !postFlushWorkflow ||
          postFlushWorkflow.deletedAt !== null ||
          uuid(postFlushWorkflow.workspaceId) !== request.workspaceId ||
          nullableUuid(postFlushWorkflow.createdByUserWorkspaceId) !==
            afterCreatedBy ||
          assertWorkflowOrViewVisibility(postFlushWorkflow.visibility) !==
            afterVisibility
        ) {
          throw new Error(
            'Core workflow visibility state changed during audit flush',
          );
        }
        if (persistedIntent) {
          await persistedIntent.verify();
        }

        return {
          status: 'updated' as const,
          changed: true,
          intentId: persistedIntent?.intentId,
        };
      }),
    );
  } finally {
    active.delete(request);
  }
};

const ALLOWED_CORE_VIEW_CHILD_METADATA_NAMES = new Set<string>([
  'viewGroup',
  'viewField',
  'viewFilter',
  'viewSort',
  'viewFilterGroup',
  'viewFieldGroup',
]);

export const runAuditedCoreViewMutation = async <TResult>(
  dataSource: DataSource | undefined,
  request: CoreViewAuditRequest,
  actions: ViewMigrationAction[],
  mappings: CoreViewAuditMappings | undefined,
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    (request.kind !== 'coreViewCreate' && request.kind !== 'coreViewUpdate') ||
    !active.has(request) ||
    consumed.has(request) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Core view audit scope is invalid or reused');
  }
  if (!dataSource) {
    throw new Error('Core view audit requires core DataSource');
  }
  if (!mappings?.views || !mappings.application) {
    throw new Error('Core view audit requires view and application mappings');
  }

  const expectedApplicationId = uuid(mappings.application.id);
  const expectedApplicationUniversalId = uuid(
    mappings.application.universalIdentifier,
  );
  const viewActions = actions.filter(
    (action) => action.metadataName === 'view',
  );
  for (const action of actions) {
    if (
      action.metadataName !== 'view' &&
      !ALLOWED_CORE_VIEW_CHILD_METADATA_NAMES.has(action.metadataName)
    ) {
      throw new Error(
        `Core view audit does not allow ${action.metadataName} ${action.type} action`,
      );
    }
  }

  if (request.kind === 'coreViewCreate') {
    if (viewActions.length !== 1 || viewActions[0].type !== 'create') {
      throw new Error(
        'Core view create audit requires exactly one create action on view',
      );
    }
    const plannedId = viewActions[0].id ?? viewActions[0].flatEntity?.id;
    if (plannedId !== undefined && uuid(plannedId) !== request.viewId) {
      throw new Error('Core view create audit resolved a different view ID');
    }
    if (
      viewActions[0].flatEntity?.applicationUniversalIdentifier !== undefined &&
      uuid(viewActions[0].flatEntity.applicationUniversalIdentifier) !==
        expectedApplicationUniversalId
    ) {
      throw new Error('Core view create audit application mismatch');
    }

    consumed.add(request);

    return runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      await verifyActiveWorkspaceAndMembership(
        runner,
        request.workspaceId,
        request.userWorkspaceId,
        request.operation,
        false,
      );

      const [appRow] = await runner.query(
        `SELECT id, "workspaceId", "universalIdentifier", to_jsonb(a)->>'deletedAt' AS "deletedAt"
           FROM core.application a
          WHERE a.id=$1
            FOR KEY SHARE`,
        [expectedApplicationId],
      );
      if (
        !appRow ||
        appRow.deletedAt !== null ||
        uuid(appRow.workspaceId) !== request.workspaceId ||
        uuid(appRow.universalIdentifier) !== expectedApplicationUniversalId
      ) {
        throw new Error('Core view create audit application unavailable');
      }

      const readWorkspaceViews = (lock: boolean) =>
        runner
          .query(
            `SELECT v.id,
                    v."workspaceId",
                    to_jsonb(v)->>'deletedAt' AS "deletedAt",
                    to_jsonb(v) AS row,
                    to_jsonb(a)->>'universalIdentifier' AS "ownerApplicationUniversalIdentifier"
               FROM core.view v
               LEFT JOIN core.application a ON a.id = v."applicationId"
              WHERE v."workspaceId"=$1
              ORDER BY v.id${lock ? ' FOR UPDATE OF v' : ''}`,
            [request.workspaceId],
          )
          .then(
            (
              rows: Array<{
                id: string;
                workspaceId: string;
                deletedAt: string | null;
                row: Record<string, unknown>;
                ownerApplicationUniversalIdentifier: string | null;
              }>,
            ) => new Map(rows.map((entry) => [uuid(entry.id), entry])),
          );

      const beforeViews = await readWorkspaceViews(true);
      if (beforeViews.has(request.viewId)) {
        throw new Error('Core view create target view ID already exists');
      }

      const result = await work(runner);

      const afterViews = await readWorkspaceViews(false);
      const afterView = afterViews.get(request.viewId);
      if (
        !afterView ||
        afterView.deletedAt !== null ||
        uuid(afterView.workspaceId) !== request.workspaceId
      ) {
        throw new Error('Core view create did not persist expected view');
      }
      if (afterViews.size !== beforeViews.size + 1) {
        throw new Error(
          'Core view create audit detected unexpected view row count change',
        );
      }
      for (const [id, beforeEntry] of beforeViews.entries()) {
        const currentEntry = afterViews.get(id);
        if (
          !currentEntry ||
          canonicalAuditJson(currentEntry.row) !==
            canonicalAuditJson(beforeEntry.row)
        ) {
          throw new Error(
            'Core view create audit detected unplanned mutation of another view',
          );
        }
      }

      const afterProj = projectCoreView(
        afterView.row,
        afterView.ownerApplicationUniversalIdentifier,
      );
      if (afterProj.applicationId !== expectedApplicationId) {
        throw new Error(
          'Core view create persisted unexpected applicationId',
        );
      }
      const expectedCreatedBy = request.userWorkspaceId ?? null;
      if (afterProj.createdByUserWorkspaceId !== expectedCreatedBy) {
        throw new Error(
          'Core view create persisted unexpected createdByUserWorkspaceId',
        );
      }
      if (
        afterProj.visibility === 'UNLISTED' &&
        afterProj.createdByUserWorkspaceId === null
      ) {
        throw new Error(
          'Unlisted view create requires an authenticated creator userWorkspaceId',
        );
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        action: 'create',
        resourceKind: 'coreView',
        resourceId: request.viewId,
        before: null,
        after: afterProj,
        securityDescriptor: {
          resourceKind: 'coreView',
          resourceId: request.viewId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      await audit.flush();

      const postFlushViews = await readWorkspaceViews(false);
      const expectedSerialized = canonicalAuditJson(
        [...afterViews.entries()].map(([id, entry]) => [id, entry.row]),
      );
      const postFlushSerialized = canonicalAuditJson(
        [...postFlushViews.entries()].map(([id, entry]) => [id, entry.row]),
      );
      if (postFlushSerialized !== expectedSerialized) {
        throw new Error('Core view state changed during audit flush');
      }

      return result;
    });
  }

  if (viewActions.some((action) => action.type !== 'update')) {
    throw new Error(
      'Core view update audit allows only update actions on view',
    );
  }
  for (const viewAction of viewActions) {
    const mappedView = lookupExistingView(
      viewAction.universalIdentifier,
      mappings.views as Record<string, Record<string, unknown> | undefined>,
    );
    const mappedViewId = mappedView?.id;
    if (!mappedViewId || uuid(mappedViewId) !== request.viewId) {
      throw new Error('Core view update audit resolved a different view ID');
    }
  }

  consumed.add(request);

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    await verifyActiveWorkspaceAndMembership(
      runner,
      request.workspaceId,
      request.userWorkspaceId,
      request.operation,
      false,
    );

    const readWorkspaceViews = (lock: boolean) =>
      runner
        .query(
          `SELECT v.id,
                  v."workspaceId",
                  to_jsonb(v)->>'deletedAt' AS "deletedAt",
                  to_jsonb(v) AS row,
                  to_jsonb(a)->>'universalIdentifier' AS "ownerApplicationUniversalIdentifier"
             FROM core.view v
             LEFT JOIN core.application a ON a.id = v."applicationId"
            WHERE v."workspaceId"=$1
            ORDER BY v.id${lock ? ' FOR UPDATE OF v' : ''}`,
          [request.workspaceId],
        )
        .then(
          (
            rows: Array<{
              id: string;
              workspaceId: string;
              deletedAt: string | null;
              row: Record<string, unknown>;
              ownerApplicationUniversalIdentifier: string | null;
            }>,
          ) => new Map(rows.map((entry) => [uuid(entry.id), entry])),
        );

    const beforeViews = await readWorkspaceViews(true);
    const beforeView = beforeViews.get(request.viewId);
    if (
      !beforeView ||
      beforeView.deletedAt !== null ||
      uuid(beforeView.workspaceId) !== request.workspaceId
    ) {
      throw new Error('Core view update target view is unavailable');
    }

    const ownerAppUid: string | null =
      beforeView.ownerApplicationUniversalIdentifier ?? null;
    const beforeProj = projectCoreView(beforeView.row, ownerAppUid);
    const beforeCreatedBy = beforeProj.createdByUserWorkspaceId;
    const beforeVisibility = beforeProj.visibility;
    const beforeIsActive = beforeProj.isActive;

    const mergedUpdate: Record<string, unknown> = {};
    for (const action of viewActions) {
      if (action.update) {
        Object.assign(mergedUpdate, action.update);
      }
    }

    const expectedPatchedRow: Record<string, unknown> = {
      ...beforeView.row,
      ...('visibility' in mergedUpdate && mergedUpdate.visibility !== undefined
        ? { visibility: mergedUpdate.visibility }
        : {}),
      ...('isActive' in mergedUpdate && mergedUpdate.isActive !== undefined
        ? { isActive: mergedUpdate.isActive }
        : {}),
      ...('universalOverrides' in mergedUpdate
        ? {
            overrides: mergedUpdate.universalOverrides,
            universalOverrides: mergedUpdate.universalOverrides,
          }
        : 'overrides' in mergedUpdate
          ? { overrides: mergedUpdate.overrides }
          : {}),
    };

    const expectedVisibility = resolveEffectiveViewVisibility(
      expectedPatchedRow,
      ownerAppUid,
    );
    const expectedIsActive = resolveEffectiveViewIsActive(
      expectedPatchedRow,
      ownerAppUid,
    );
    const expectedCreatedBy =
      'createdByUserWorkspaceId' in mergedUpdate &&
      mergedUpdate.createdByUserWorkspaceId !== undefined
        ? nullableUuid(mergedUpdate.createdByUserWorkspaceId)
        : beforeCreatedBy;

    if (
      beforeVisibility !== expectedVisibility ||
      beforeCreatedBy !== expectedCreatedBy
    ) {
      if (request.userWorkspaceId === undefined) {
        throw new Error(
          'Core view visibility or creator update requires an authenticated userWorkspaceId',
        );
      }
      if (
        beforeCreatedBy !== null &&
        beforeCreatedBy !== request.userWorkspaceId
      ) {
        throw new Error(
          'Core view visibility or creator can only be changed by its creator',
        );
      }
    }

    if (
      beforeVisibility === 'UNLISTED' &&
      (request.userWorkspaceId === undefined ||
        beforeCreatedBy !== request.userWorkspaceId)
    ) {
      throw new Error('Unlisted core view can only be modified by its creator');
    }

    const result = await work(runner);

    const afterViews = await readWorkspaceViews(false);
    const afterView = afterViews.get(request.viewId);
    if (
      !afterView ||
      afterView.deletedAt !== null ||
      uuid(afterView.workspaceId) !== request.workspaceId
    ) {
      throw new Error('Core view update removed or corrupted target view');
    }
    if (afterViews.size !== beforeViews.size) {
      throw new Error(
        'Core view update audit detected unexpected view row count change',
      );
    }
    for (const [id, beforeEntry] of beforeViews.entries()) {
      if (id === request.viewId) continue;
      const currentEntry = afterViews.get(id);
      if (
        !currentEntry ||
        canonicalAuditJson(currentEntry.row) !==
          canonicalAuditJson(beforeEntry.row)
      ) {
        throw new Error(
          'Core view update audit detected unplanned mutation of another view',
        );
      }
    }

    const afterProj = projectCoreView(
      afterView.row,
      afterView.ownerApplicationUniversalIdentifier,
    );
    const afterCreatedBy = afterProj.createdByUserWorkspaceId;
    const afterVisibility = afterProj.visibility;
    const afterIsActive = afterProj.isActive;

    if (afterVisibility !== expectedVisibility) {
      throw new Error('Core view update did not persist expected visibility');
    }
    if (afterCreatedBy !== expectedCreatedBy) {
      throw new Error(
        'Core view update did not persist expected createdByUserWorkspaceId',
      );
    }
    if (afterIsActive !== expectedIsActive) {
      throw new Error('Core view update did not persist expected isActive');
    }
    if (request.expectDeactivate && afterIsActive !== false) {
      throw new Error('Core view deactivation did not set isActive to false');
    }
    if (
      afterProj.applicationId !== beforeProj.applicationId ||
      afterProj.objectMetadataId !== beforeProj.objectMetadataId
    ) {
      throw new Error(
        'Core view update audit detected unplanned ownership or object change',
      );
    }

    if (afterVisibility === 'UNLISTED') {
      if (afterCreatedBy === null) {
        throw new Error(
          'Unlisted view requires a valid creator userWorkspaceId',
        );
      }
      if (
        request.userWorkspaceId === undefined ||
        afterCreatedBy !== request.userWorkspaceId
      ) {
        throw new Error(
          'Unlisted view transition must assign creator to the authenticated userWorkspaceId',
        );
      }
    }

    const securityChanged =
      beforeCreatedBy !== afterCreatedBy ||
      beforeVisibility !== afterVisibility ||
      beforeIsActive !== afterIsActive;

    if (
      securityChanged ||
      (request.expectDeactivate &&
        canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj))
    ) {
      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        action: 'update',
        resourceKind: 'coreView',
        resourceId: request.viewId,
        before: beforeProj,
        after: afterProj,
        securityDescriptor: {
          resourceKind: 'coreView',
          resourceId: request.viewId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      await audit.flush();

      const postFlushViews = await readWorkspaceViews(false);
      const expectedSerialized = canonicalAuditJson(
        [...afterViews.entries()].map(([id, entry]) => [id, entry.row]),
      );
      const postFlushSerialized = canonicalAuditJson(
        [...postFlushViews.entries()].map(([id, entry]) => [id, entry.row]),
      );
      if (postFlushSerialized !== expectedSerialized) {
        throw new Error('Core view state changed during audit flush');
      }
    }

    return result;
  });
};

export const runAuditedCoreViewUpdate = runAuditedCoreViewMutation;
