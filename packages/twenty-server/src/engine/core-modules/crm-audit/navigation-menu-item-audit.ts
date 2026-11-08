import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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

export type NavigationMenuItemAuditIdentity =
  | RoleUpdateAuditIdentity
  | MembershipCleanupIdentity
  | RequestLikeAuditIdentity;

export type NavigationMenuItemTypeValue =
  | 'FOLDER'
  | 'OBJECT'
  | 'VIEW'
  | 'RECORD'
  | 'LINK'
  | 'PAGE_LAYOUT'
  | 'AGENT_CHAT_CHANNEL';

export type NavigationMenuItemAuditMode =
  | 'create'
  | 'update'
  | 'delete'
  | 'cascade';

export type NavigationMenuItemAuditRequest = Readonly<{
  workspaceId: string;
  mode: NavigationMenuItemAuditMode;
  operation?: CrmAuditOperation;
  pendingAgentId?: string;
  pendingUserWorkspaceActor?: boolean;
  impersonatorUserWorkspaceId?: string;
  authUserWorkspaceId?: string;
  expectedCreatedIds?: readonly string[];
  expectedUpdatedIds?: readonly string[];
  expectedDeletedIds?: readonly string[];
  expectedParentViewDeleteIds?: readonly string[];
  expectedParentPageLayoutDeleteIds?: readonly string[];
  expectedParentChannelDeleteIds?: readonly string[];
  expectedCreatedObjectId?: string;
}>;

export type NavigationMenuItemAuditMappings = {
  application: { id: string; universalIdentifier: string };
  navigationMenuItems?: Record<string, { id: string } | undefined>;
  views?: Record<string, { id: string } | undefined>;
  pageLayouts?: Record<string, { id: string } | undefined>;
  agentChatChannels?: Record<string, { id: string } | undefined>;
  objectMetadatas?: Record<string, { id: string } | undefined>;
  fieldMetadatas?: Record<string, { id: string } | undefined>;
};

type MigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

const VALID_NAVIGATION_MENU_ITEM_TYPES = new Set<NavigationMenuItemTypeValue>([
  'FOLDER',
  'OBJECT',
  'VIEW',
  'RECORD',
  'LINK',
  'PAGE_LAYOUT',
  'AGENT_CHAT_CHANNEL',
]);

const CASCADE_ALLOWED_METADATA_NAMES = new Set<string>([
  'navigationMenuItem',
  'objectMetadata',
  'fieldMetadata',
  'index',
  'view',
  'viewField',
  'viewGroup',
  'viewFilter',
  'viewFilterGroup',
  'viewSort',
  'viewFieldGroup',
  'pageLayout',
  'pageLayoutTab',
  'pageLayoutWidget',
  'agentChatChannel',
  'agentChatChannelRole',
  'searchFieldMetadata',
]);

const storage = new AsyncLocalStorage<NavigationMenuItemAuditRequest>();
const active = new WeakSet<NavigationMenuItemAuditRequest>();
const consumed = new WeakSet<NavigationMenuItemAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Navigation menu item audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const assertNavigationMenuItemType = (
  value: unknown,
): NavigationMenuItemTypeValue => {
  if (
    typeof value !== 'string' ||
    !VALID_NAVIGATION_MENU_ITEM_TYPES.has(value as NavigationMenuItemTypeValue)
  ) {
    throw new Error('Navigation menu item audit type is invalid');
  }

  return value as NavigationMenuItemTypeValue;
};

export const assertNavigationMenuItemRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  const id = uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Navigation menu item audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  nullableUuid(row.userWorkspaceId);
  const folderId = nullableUuid(row.folderId);
  if (folderId !== null && folderId === id) {
    throw new Error('Navigation menu item cannot reference itself as folder');
  }
  const type = assertNavigationMenuItemType(row.type);
  const viewId = nullableUuid(row.viewId);
  const targetObjectMetadataId = nullableUuid(row.targetObjectMetadataId);
  const targetRecordId = nullableUuid(row.targetRecordId);
  const pageLayoutId = nullableUuid(row.pageLayoutId);
  const agentChatChannelId = nullableUuid(row.agentChatChannelId);
  const position =
    typeof row.position === 'number' ? row.position : Number(row.position);
  if (!Number.isFinite(position)) {
    throw new Error('Navigation menu item audit position is invalid');
  }

  if (type === 'OBJECT' && targetObjectMetadataId === null) {
    throw new Error(
      'Navigation menu item OBJECT requires targetObjectMetadataId',
    );
  }
  if (type === 'VIEW' && viewId === null) {
    throw new Error('Navigation menu item VIEW requires viewId');
  }
  if (
    type === 'RECORD' &&
    (targetRecordId === null || targetObjectMetadataId === null)
  ) {
    throw new Error(
      'Navigation menu item RECORD requires targetRecordId and targetObjectMetadataId',
    );
  }
  if (
    type === 'LINK' &&
    (typeof row.link !== 'string' || row.link.trim().length === 0)
  ) {
    throw new Error('Navigation menu item LINK requires non-empty link');
  }
  if (type === 'PAGE_LAYOUT' && pageLayoutId === null) {
    throw new Error('Navigation menu item PAGE_LAYOUT requires pageLayoutId');
  }
  if (type === 'AGENT_CHAT_CHANNEL' && agentChatChannelId === null) {
    throw new Error(
      'Navigation menu item AGENT_CHAT_CHANNEL requires agentChatChannelId',
    );
  }
};

export const projectNavigationMenuItem = (row: Record<string, unknown>) => ({
  userWorkspaceId: nullableUuid(row.userWorkspaceId),
  folderId: nullableUuid(row.folderId),
  type: assertNavigationMenuItemType(row.type),
  viewId: nullableUuid(row.viewId),
  targetObjectMetadataId: nullableUuid(row.targetObjectMetadataId),
  targetRecordId: nullableUuid(row.targetRecordId),
  pageLayoutId: nullableUuid(row.pageLayoutId),
  agentChatChannelId: nullableUuid(row.agentChatChannelId),
  name: row.name === undefined || row.name === null ? null : String(row.name),
  link: row.link === undefined || row.link === null ? null : String(row.link),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  color:
    row.color === undefined || row.color === null ? null : String(row.color),
  position:
    typeof row.position === 'number' ? row.position : Number(row.position),
});

export const scalarNavigationMenuItemWithoutTimestamps = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    copy[key] = row[key];
  }
  return copy;
};

export const getNavigationMenuItemAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Navigation menu item audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getNavigationMenuItemAudit);

export const withNavigationMenuItemAudit = async <T>(
  request: NavigationMenuItemAuditRequest,
  work: () => Promise<T>,
): Promise<T> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    active.has(request)
  ) {
    throw new Error('Navigation menu item audit request cannot be reused');
  }
  if (
    getNavigationMenuItemAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getNavigationMenuItemAudit,
    )
  ) {
    throw new Error('Nested navigation menu item audit is unsupported');
  }

  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
    consumed.add(request);
  }
};

type RequestLikeAuditIdentity = Partial<RoleUpdateAuditIdentity> & {
  workspace?: { id: string };
  apiKey?: { id: string } | null;
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  application?: { id: string } | null;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
};

const hasExplicitPrincipalFields = (
  identity: RequestLikeAuditIdentity,
): boolean =>
  Boolean(
    identity.auth !== undefined ||
      identity.user !== undefined ||
      identity.workspaceMemberId !== undefined ||
      identity.apiKey !== undefined ||
      identity.application !== undefined ||
      identity.agentId !== undefined ||
      identity.systemActorId !== undefined,
  );

const toRoleUpdateAuditIdentity = (
  normalizedWorkspaceId: string,
  identity: RequestLikeAuditIdentity,
): RoleUpdateAuditIdentity => {
  if (identity.auth !== undefined) {
    return identity as RoleUpdateAuditIdentity;
  }
  const base = {
    workspace: { id: identity.workspace?.id ?? normalizedWorkspaceId },
  };
  const auth: RoleUpdateAuditIdentity['auth'] = identity.apiKey?.id
    ? { ...base, type: 'apiKey', apiKey: { id: identity.apiKey.id } }
    : identity.workspaceMemberId
      ? {
          ...base,
          type: 'user',
          workspaceMemberId: identity.workspaceMemberId,
        }
      : identity.application?.id
        ? {
            ...base,
            type: 'application',
            application: { id: identity.application.id },
          }
        : identity.systemActorId !== undefined
          ? { ...base, type: 'system' }
          : { ...base, type: 'pendingActivationUser' };

  return {
    auth,
    agentId: identity.agentId,
    impersonatorUserWorkspaceId:
      identity.impersonatorUserWorkspaceId ??
      identity.impersonationContext?.impersonatorUserWorkspaceId,
    ...(identity.systemActorId !== undefined
      ? { systemActorId: identity.systemActorId }
      : {}),
  };
};

const resolveCapturedOperation = ({
  normalizedWorkspaceId,
  auditIdentity,
  authUserWorkspaceId,
  authApiKeyId,
  authApplicationId,
  authAgentId,
  defaultSystemActorId,
}: {
  normalizedWorkspaceId: string;
  auditIdentity?: NavigationMenuItemAuditIdentity;
  authUserWorkspaceId?: string;
  authApiKeyId?: string;
  authApplicationId?: string;
  authAgentId?: string;
  defaultSystemActorId?: string;
}): {
  operation?: CrmAuditOperation;
  pendingAgentId?: string;
  pendingUserWorkspaceActor?: boolean;
  impersonatorUserWorkspaceId?: string;
  resolvedAuthUserWorkspaceId?: string;
} => {
  const normalizedAuthUserWorkspaceId =
    authUserWorkspaceId !== undefined ? uuid(authUserWorkspaceId) : undefined;
  const normalizedAuthApiKeyId =
    authApiKeyId !== undefined ? uuid(authApiKeyId) : undefined;
  const normalizedAuthApplicationId =
    authApplicationId !== undefined ? uuid(authApplicationId) : undefined;
  const normalizedAuthAgentId =
    authAgentId !== undefined ? uuid(authAgentId) : undefined;

  if (
    normalizedAuthApiKeyId !== undefined &&
    (normalizedAuthUserWorkspaceId !== undefined ||
      normalizedAuthApplicationId !== undefined ||
      normalizedAuthAgentId !== undefined)
  ) {
    throw new Error('Ambiguous navigation menu item audit authentication');
  }

  if (
    auditIdentity !== undefined &&
    auditIdentity !== null &&
    typeof auditIdentity === 'object' &&
    'actor' in auditIdentity &&
    !('auth' in auditIdentity)
  ) {
    const cleanupIdentity = auditIdentity as MembershipCleanupIdentity;
    if (cleanupIdentity.workspaceId === undefined) {
      throw new Error('CRM audit context requires scoped identity');
    }
    const normalizedCleanupIdentity: MembershipCleanupIdentity = {
      ...cleanupIdentity,
      correlationId: cleanupIdentity.correlationId ?? randomUUID(),
    };
    const operation = membershipCleanupOperation(
      normalizedWorkspaceId,
      normalizedCleanupIdentity,
    );
    if (!operation) {
      throw new Error(
        'Navigation menu item mutation requires authenticated audit identity',
      );
    }

    return {
      operation,
      ...(normalizedAuthUserWorkspaceId !== undefined
        ? { resolvedAuthUserWorkspaceId: normalizedAuthUserWorkspaceId }
        : {}),
    };
  }

  const reqLike = (
    auditIdentity && typeof auditIdentity === 'object' ? auditIdentity : {}
  ) as RequestLikeAuditIdentity;

  const mergedIdentity: RequestLikeAuditIdentity = {
    ...reqLike,
    ...(reqLike.apiKey === undefined && normalizedAuthApiKeyId !== undefined
      ? { apiKey: { id: normalizedAuthApiKeyId } }
      : {}),
    ...(reqLike.application === undefined &&
    normalizedAuthApplicationId !== undefined &&
    reqLike.user === undefined &&
    reqLike.workspaceMemberId === undefined &&
    normalizedAuthUserWorkspaceId === undefined
      ? { application: { id: normalizedAuthApplicationId } }
      : {}),
    ...(reqLike.agentId === undefined && normalizedAuthAgentId !== undefined
      ? { agentId: normalizedAuthAgentId }
      : {}),
  };

  if (hasExplicitPrincipalFields(mergedIdentity)) {
    if (
      mergedIdentity.agentId !== undefined &&
      mergedIdentity.user === undefined &&
      mergedIdentity.workspaceMemberId === undefined &&
      mergedIdentity.application === undefined &&
      mergedIdentity.auth === undefined &&
      normalizedAuthUserWorkspaceId !== undefined
    ) {
      return {
        pendingAgentId: uuid(mergedIdentity.agentId),
        pendingUserWorkspaceActor: true,
        resolvedAuthUserWorkspaceId: normalizedAuthUserWorkspaceId,
      };
    }

    if (
      mergedIdentity.auth === undefined &&
      mergedIdentity.user?.id !== undefined &&
      mergedIdentity.workspaceMemberId === undefined &&
      mergedIdentity.apiKey === undefined &&
      mergedIdentity.application === undefined
    ) {
      const userId = uuid(mergedIdentity.user.id);
      const agentId =
        mergedIdentity.agentId !== undefined
          ? uuid(mergedIdentity.agentId)
          : undefined;
      return {
        operation: Object.freeze<CrmAuditOperation>({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: agentId
            ? { kind: 'agent', id: agentId }
            : { kind: 'coreUser', id: userId },
          ...(agentId ? { initiator: { kind: 'coreUser', id: userId } } : {}),
          correlationId: randomUUID(),
        }),
        ...((mergedIdentity.impersonatorUserWorkspaceId ??
        mergedIdentity.impersonationContext?.impersonatorUserWorkspaceId)
          ? {
              impersonatorUserWorkspaceId: uuid(
                mergedIdentity.impersonatorUserWorkspaceId ??
                  mergedIdentity.impersonationContext
                    ?.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
        ...(normalizedAuthUserWorkspaceId !== undefined
          ? { resolvedAuthUserWorkspaceId: normalizedAuthUserWorkspaceId }
          : {}),
      };
    }

    const capturedIdentity = captureRoleAuditIdentity(
      toRoleUpdateAuditIdentity(normalizedWorkspaceId, mergedIdentity),
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
      ...(normalizedAuthUserWorkspaceId !== undefined
        ? { resolvedAuthUserWorkspaceId: normalizedAuthUserWorkspaceId }
        : {}),
    };
  }

  if (normalizedAuthUserWorkspaceId !== undefined) {
    return {
      pendingUserWorkspaceActor: true,
      resolvedAuthUserWorkspaceId: normalizedAuthUserWorkspaceId,
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

  if (defaultSystemActorId !== undefined) {
    return {
      operation: Object.freeze<CrmAuditOperation>({
        workspaceId: normalizedWorkspaceId,
        operationId: randomUUID(),
        actor: { kind: 'system', id: defaultSystemActorId },
        correlationId: randomUUID(),
      }),
    };
  }

  throw new Error(
    'Navigation menu item mutation requires authenticated audit identity',
  );
};

export type NavigationMenuItemAuditExpectedScope = {
  expectedCreatedIds?: readonly string[];
  expectedUpdatedIds?: readonly string[];
  expectedDeletedIds?: readonly string[];
  expectedParentViewDeleteIds?: readonly string[];
  expectedParentPageLayoutDeleteIds?: readonly string[];
  expectedParentChannelDeleteIds?: readonly string[];
  expectedCreatedObjectId?: string;
};

export const captureNavigationMenuItemAudit = ({
  workspaceId,
  mode,
  auditIdentity,
  authUserWorkspaceId,
  authApiKeyId,
  authApplicationId,
  authAgentId,
  defaultSystemActorId,
  expectedCreatedIds,
  expectedUpdatedIds,
  expectedDeletedIds,
  expectedParentViewDeleteIds,
  expectedParentPageLayoutDeleteIds,
  expectedParentChannelDeleteIds,
  expectedCreatedObjectId,
}: {
  workspaceId: string;
  mode: NavigationMenuItemAuditMode;
  auditIdentity?: NavigationMenuItemAuditIdentity;
  authUserWorkspaceId?: string;
  authApiKeyId?: string;
  authApplicationId?: string;
  authAgentId?: string;
  defaultSystemActorId?: string;
} & NavigationMenuItemAuditExpectedScope): ((
  overrides?: NavigationMenuItemAuditExpectedScope,
) => NavigationMenuItemAuditRequest) => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getNavigationMenuItemAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getNavigationMenuItemAudit,
    )
  ) {
    throw new Error('Nested navigation menu item audit is unsupported');
  }

  const {
    operation,
    pendingAgentId,
    pendingUserWorkspaceActor,
    impersonatorUserWorkspaceId,
    resolvedAuthUserWorkspaceId,
  } = resolveCapturedOperation({
    normalizedWorkspaceId,
    auditIdentity,
    authUserWorkspaceId,
    authApiKeyId,
    authApplicationId,
    authAgentId,
    defaultSystemActorId,
  });

  const normalizeIds = (ids: readonly string[] | undefined) =>
    ids !== undefined ? Object.freeze(ids.map((id) => uuid(id))) : undefined;

  const baseCreatedIds = normalizeIds(expectedCreatedIds);
  const baseUpdatedIds = normalizeIds(expectedUpdatedIds);
  const baseDeletedIds = normalizeIds(expectedDeletedIds);
  const baseParentViewIds = normalizeIds(expectedParentViewDeleteIds);
  const baseParentPageLayoutIds = normalizeIds(
    expectedParentPageLayoutDeleteIds,
  );
  const baseParentChannelIds = normalizeIds(expectedParentChannelDeleteIds);
  const baseCreatedObjectId =
    expectedCreatedObjectId !== undefined
      ? uuid(expectedCreatedObjectId)
      : undefined;

  return (overrides) => {
    const resolvedCreatedIds =
      normalizeIds(overrides?.expectedCreatedIds) ?? baseCreatedIds;
    const resolvedUpdatedIds =
      normalizeIds(overrides?.expectedUpdatedIds) ?? baseUpdatedIds;
    const resolvedDeletedIds =
      normalizeIds(overrides?.expectedDeletedIds) ?? baseDeletedIds;
    const resolvedParentViewIds =
      normalizeIds(overrides?.expectedParentViewDeleteIds) ?? baseParentViewIds;
    const resolvedParentPageLayoutIds =
      normalizeIds(overrides?.expectedParentPageLayoutDeleteIds) ??
      baseParentPageLayoutIds;
    const resolvedParentChannelIds =
      normalizeIds(overrides?.expectedParentChannelDeleteIds) ??
      baseParentChannelIds;
    const resolvedCreatedObjectId =
      overrides?.expectedCreatedObjectId !== undefined
        ? uuid(overrides.expectedCreatedObjectId)
        : baseCreatedObjectId;

    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      mode,
      ...(operation !== undefined ? { operation } : {}),
      ...(pendingAgentId !== undefined ? { pendingAgentId } : {}),
      ...(pendingUserWorkspaceActor ? { pendingUserWorkspaceActor: true } : {}),
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      ...(resolvedAuthUserWorkspaceId !== undefined
        ? { authUserWorkspaceId: resolvedAuthUserWorkspaceId }
        : {}),
      ...(resolvedCreatedIds !== undefined
        ? { expectedCreatedIds: resolvedCreatedIds }
        : {}),
      ...(resolvedUpdatedIds !== undefined
        ? { expectedUpdatedIds: resolvedUpdatedIds }
        : {}),
      ...(resolvedDeletedIds !== undefined
        ? { expectedDeletedIds: resolvedDeletedIds }
        : {}),
      ...(resolvedParentViewIds !== undefined
        ? { expectedParentViewDeleteIds: resolvedParentViewIds }
        : {}),
      ...(resolvedParentPageLayoutIds !== undefined
        ? { expectedParentPageLayoutDeleteIds: resolvedParentPageLayoutIds }
        : {}),
      ...(resolvedParentChannelIds !== undefined
        ? { expectedParentChannelDeleteIds: resolvedParentChannelIds }
        : {}),
      ...(resolvedCreatedObjectId !== undefined
        ? { expectedCreatedObjectId: resolvedCreatedObjectId }
        : {}),
    });
  };
};

const verifyActorAndUserWorkspace = async ({
  runner,
  request,
  requireUserWorkspace,
}: {
  runner: QueryRunner;
  request: NavigationMenuItemAuditRequest;
  requireUserWorkspace: boolean;
}): Promise<{
  operation: CrmAuditOperation;
  verifiedUserWorkspaceId: string | undefined;
}> => {
  const [workspace] = await runner.query(
    `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
    [request.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null) {
    throw new Error('Navigation menu item audit workspace unavailable');
  }

  let baseOperation = request.operation;
  let verifiedUserWorkspaceId = request.authUserWorkspaceId;

  if (verifiedUserWorkspaceId !== undefined) {
    const [membership] = await runner.query(
      `SELECT id,"userId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw.id=$1 AND uw."workspaceId"=$2 FOR NO KEY UPDATE`,
      [verifiedUserWorkspaceId, request.workspaceId],
    );
    if (!membership || membership.deletedAt !== null) {
      throw new Error('Navigation menu item audit userWorkspace unavailable');
    }
    const membershipUserId = uuid(membership.userId);

    if (request.pendingUserWorkspaceActor) {
      baseOperation = Object.freeze(
        request.pendingAgentId !== undefined
          ? {
              workspaceId: request.workspaceId,
              operationId: randomUUID(),
              actor: { kind: 'agent' as const, id: request.pendingAgentId },
              initiator: { kind: 'coreUser' as const, id: membershipUserId },
              correlationId: randomUUID(),
            }
          : {
              workspaceId: request.workspaceId,
              operationId: randomUUID(),
              actor: { kind: 'coreUser' as const, id: membershipUserId },
              correlationId: randomUUID(),
            },
      );
    } else {
      if (!baseOperation) {
        throw new Error(
          'Navigation menu item mutation requires authenticated audit identity',
        );
      }
      const userPrincipal =
        baseOperation.actor.kind === 'coreUser' ||
        baseOperation.actor.kind === 'workspaceMember'
          ? baseOperation.actor
          : baseOperation.initiator?.kind === 'coreUser' ||
              baseOperation.initiator?.kind === 'workspaceMember'
            ? baseOperation.initiator
            : undefined;

      if (!userPrincipal) {
        throw new Error(
          'Navigation menu item audit userWorkspace requires user-scoped actor',
        );
      }

      if (userPrincipal.kind === 'coreUser') {
        if (uuid(userPrincipal.id) !== membershipUserId) {
          throw new Error(
            'Navigation menu item audit actor mismatch with userWorkspace',
          );
        }
      } else {
        const memberId = uuid(userPrincipal.id);
        const workspaceSchema = `workspace_${request.workspaceId.replace(/-/g, '')}`;
        const [memberReg] = await runner.query(
          `SELECT to_regclass($1) IS NOT NULL AS "hasWorkspaceMemberTable"`,
          [`"${workspaceSchema}"."workspaceMember"`],
        );
        if (memberReg?.hasWorkspaceMemberTable !== true) {
          throw new Error(
            'Navigation menu item audit workspaceMember table unavailable',
          );
        }
        const [memberRow] = await runner.query(
          `SELECT id,"userId",to_jsonb(m)->>'deletedAt' AS "deletedAt" FROM "${workspaceSchema}"."workspaceMember" m WHERE m.id=$1 FOR SHARE`,
          [memberId],
        );
        if (
          !memberRow ||
          memberRow.deletedAt !== null ||
          uuid(memberRow.userId) !== membershipUserId
        ) {
          throw new Error(
            'Navigation menu item audit workspaceMember mismatch with userWorkspace',
          );
        }
      }
    }
  } else if (
    baseOperation &&
    (baseOperation.actor.kind === 'coreUser' ||
      baseOperation.actor.kind === 'workspaceMember')
  ) {
    if (baseOperation.actor.kind === 'coreUser') {
      const [membership] = await runner.query(
        `SELECT id,"userId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw."userId"=$1 AND uw."workspaceId"=$2 AND to_jsonb(uw)->>'deletedAt' IS NULL ORDER BY uw.id LIMIT 1 FOR NO KEY UPDATE`,
        [uuid(baseOperation.actor.id), request.workspaceId],
      );
      if (!membership) {
        throw new Error('Navigation menu item audit userWorkspace unavailable');
      }
      verifiedUserWorkspaceId = uuid(membership.id);
    } else {
      const memberId = uuid(baseOperation.actor.id);
      const workspaceSchema = `workspace_${request.workspaceId.replace(/-/g, '')}`;
      const [memberReg] = await runner.query(
        `SELECT to_regclass($1) IS NOT NULL AS "hasWorkspaceMemberTable"`,
        [`"${workspaceSchema}"."workspaceMember"`],
      );
      if (memberReg?.hasWorkspaceMemberTable !== true) {
        throw new Error(
          'Navigation menu item audit workspaceMember table unavailable',
        );
      }
      const [memberRow] = await runner.query(
        `SELECT id,"userId",to_jsonb(m)->>'deletedAt' AS "deletedAt" FROM "${workspaceSchema}"."workspaceMember" m WHERE m.id=$1 FOR SHARE`,
        [memberId],
      );
      if (!memberRow || memberRow.deletedAt !== null) {
        throw new Error(
          'Navigation menu item audit workspaceMember unavailable',
        );
      }
      const [membership] = await runner.query(
        `SELECT id,"userId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw."userId"=$1 AND uw."workspaceId"=$2 AND to_jsonb(uw)->>'deletedAt' IS NULL ORDER BY uw.id LIMIT 1 FOR NO KEY UPDATE`,
        [uuid(memberRow.userId), request.workspaceId],
      );
      if (!membership) {
        throw new Error('Navigation menu item audit userWorkspace unavailable');
      }
      verifiedUserWorkspaceId = uuid(membership.id);
    }
  } else if (requireUserWorkspace) {
    throw new Error(
      'User-level navigation menu item mutation requires authenticated userWorkspace',
    );
  }

  if (!baseOperation) {
    throw new Error(
      'Navigation menu item mutation requires authenticated audit identity',
    );
  }

  if (baseOperation.actor.kind === 'apiKey') {
    const [apiKey] = await runner.query(
      `SELECT id,"revokedAt" FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE`,
      [uuid(baseOperation.actor.id), request.workspaceId],
    );
    if (!apiKey || apiKey.revokedAt !== null) {
      throw new Error('Navigation menu item audit apiKey unavailable');
    }
  } else if (baseOperation.actor.kind === 'application') {
    const [app] = await runner.query(
      `SELECT id,to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
      [uuid(baseOperation.actor.id), request.workspaceId],
    );
    if (!app || app.deletedAt !== null) {
      throw new Error('Navigation menu item audit application unavailable');
    }
  } else if (baseOperation.actor.kind === 'agent') {
    const [agent] = await runner.query(
      `SELECT id,to_jsonb(ag)->>'deletedAt' AS "deletedAt" FROM core.agent ag WHERE ag.id=$1 AND ag."workspaceId"=$2 FOR NO KEY UPDATE`,
      [uuid(baseOperation.actor.id), request.workspaceId],
    );
    if (!agent || agent.deletedAt !== null) {
      throw new Error('Navigation menu item audit agent unavailable');
    }
  }

  const resolvedOperation = await resolveRoleAuditInitiator(
    runner,
    baseOperation,
    request.impersonatorUserWorkspaceId,
  );

  return {
    operation: resolvedOperation,
    verifiedUserWorkspaceId,
  };
};

const readNavSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(n) AS row FROM core."navigationMenuItem" n WHERE n."workspaceId"=$1 ORDER BY n.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const serializeNavSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

export const computeCascadeDeletedNavigationMenuItemIds = ({
  beforeNavigationMenuItems,
  plannedNavDeletes,
  plannedObjectDeletes = new Set<string>(),
  plannedFieldDeletes = new Set<string>(),
  plannedViewDeletes = new Set<string>(),
  plannedPageLayoutDeletes = new Set<string>(),
  plannedAgentChatChannelDeletes = new Set<string>(),
  beforeViews = new Map<string, Record<string, unknown>>(),
  beforePageLayouts = new Map<string, Record<string, unknown>>(),
}: {
  beforeNavigationMenuItems: Map<string, Record<string, unknown>>;
  plannedNavDeletes: ReadonlySet<string>;
  plannedObjectDeletes?: ReadonlySet<string>;
  plannedFieldDeletes?: ReadonlySet<string>;
  plannedViewDeletes?: ReadonlySet<string>;
  plannedPageLayoutDeletes?: ReadonlySet<string>;
  plannedAgentChatChannelDeletes?: ReadonlySet<string>;
  beforeViews?: Map<string, Record<string, unknown>>;
  beforePageLayouts?: Map<string, Record<string, unknown>>;
}): Set<string> => {
  const effectiveDeletedViewIds = new Set<string>(plannedViewDeletes);
  if (plannedObjectDeletes.size > 0 || plannedFieldDeletes.size > 0) {
    for (const [viewId, viewRow] of beforeViews.entries()) {
      const objId = nullableUuid(viewRow.objectMetadataId);
      const calendarFieldId = nullableUuid(viewRow.calendarFieldMetadataId);
      const mainGroupByFieldId = nullableUuid(
        viewRow.mainGroupByFieldMetadataId,
      );
      if (
        (objId !== null && plannedObjectDeletes.has(objId)) ||
        (calendarFieldId !== null &&
          plannedFieldDeletes.has(calendarFieldId)) ||
        (mainGroupByFieldId !== null &&
          plannedFieldDeletes.has(mainGroupByFieldId))
      ) {
        effectiveDeletedViewIds.add(viewId);
      }
    }
  }

  const effectiveDeletedPageLayoutIds = new Set<string>(
    plannedPageLayoutDeletes,
  );
  if (plannedObjectDeletes.size > 0) {
    for (const [layoutId, layoutRow] of beforePageLayouts.entries()) {
      const objId = nullableUuid(layoutRow.objectMetadataId);
      if (objId !== null && plannedObjectDeletes.has(objId)) {
        effectiveDeletedPageLayoutIds.add(layoutId);
      }
    }
  }

  const cascadeDeleted = new Set<string>(plannedNavDeletes);
  for (const [navId, navRow] of beforeNavigationMenuItems.entries()) {
    const targetObjId = nullableUuid(navRow.targetObjectMetadataId);
    const viewId = nullableUuid(navRow.viewId);
    const pageLayoutId = nullableUuid(navRow.pageLayoutId);
    const channelId = nullableUuid(navRow.agentChatChannelId);
    if (
      (targetObjId !== null && plannedObjectDeletes.has(targetObjId)) ||
      (viewId !== null && effectiveDeletedViewIds.has(viewId)) ||
      (pageLayoutId !== null &&
        effectiveDeletedPageLayoutIds.has(pageLayoutId)) ||
      (channelId !== null && plannedAgentChatChannelDeletes.has(channelId))
    ) {
      cascadeDeleted.add(navId);
    }
  }

  let added = true;
  while (added) {
    added = false;
    for (const [navId, navRow] of beforeNavigationMenuItems.entries()) {
      if (cascadeDeleted.has(navId)) continue;
      const folderId = nullableUuid(navRow.folderId);
      if (folderId !== null && cascadeDeleted.has(folderId)) {
        cascadeDeleted.add(navId);
        added = true;
      }
    }
  }

  return cascadeDeleted;
};

export const runAuditedNavigationMenuItemMigration = async <TResult>(
  dataSource: DataSource,
  request: NavigationMenuItemAuditRequest,
  actions: MigrationAction[],
  mappings: NavigationMenuItemAuditMappings,
  execute: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");

    const [reg] = await runner.query(
      `SELECT
        to_regclass('core."navigationMenuItem"') IS NOT NULL AS "hasNavTable",
        to_regclass('core.view') IS NOT NULL AS "hasViewTable",
        to_regclass('core."pageLayout"') IS NOT NULL AS "hasPageLayoutTable",
        to_regclass('core."agentChatChannel"') IS NOT NULL AS "hasChannelTable"`,
    );
    if (reg?.hasNavTable !== true) {
      throw new Error(
        'Navigation menu item audit table core.navigationMenuItem unavailable',
      );
    }

    const applicationId = uuid(mappings.application.id);
    const applicationUniversalIdentifier = uuid(
      mappings.application.universalIdentifier,
    );

    const [appRow] = await runner.query(
      `SELECT id,"universalIdentifier",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR NO KEY UPDATE`,
      [applicationId, request.workspaceId],
    );
    if (
      !appRow ||
      appRow.deletedAt !== null ||
      uuid(appRow.universalIdentifier) !== applicationUniversalIdentifier
    ) {
      throw new Error('Navigation menu item audit application unavailable');
    }

    const beforeNavItems = await readNavSnapshot(
      runner,
      request.workspaceId,
      true,
    );
    for (const row of beforeNavItems.values()) {
      assertNavigationMenuItemRowInvariants(row, request.workspaceId);
    }

    const plannedNavCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedNavUpdates = new Map<string, Record<string, unknown>>();
    const plannedNavDeletes = new Set<string>();
    const plannedViewDeletes = new Set<string>();
    const plannedPageLayoutDeletes = new Set<string>();
    const plannedChannelDeletes = new Set<string>();
    const plannedObjectCreates = new Set<string>();
    const plannedObjectDeletes = new Set<string>();
    const plannedFieldDeletes = new Set<string>();

    for (const action of actions) {
      if (request.mode === 'create') {
        if (
          action.type !== 'create' ||
          action.metadataName !== 'navigationMenuItem'
        ) {
          throw new Error(
            'Navigation menu item create audit allows only create_navigation_menu_item actions',
          );
        }
      } else if (request.mode === 'update') {
        if (
          action.type !== 'update' ||
          action.metadataName !== 'navigationMenuItem'
        ) {
          throw new Error(
            'Navigation menu item update audit allows only update_navigation_menu_item actions',
          );
        }
      } else if (request.mode === 'delete') {
        if (
          action.type !== 'delete' ||
          action.metadataName !== 'navigationMenuItem'
        ) {
          throw new Error(
            'Navigation menu item delete audit allows only delete_navigation_menu_item actions',
          );
        }
      } else {
        if (!CASCADE_ALLOWED_METADATA_NAMES.has(action.metadataName)) {
          throw new Error(
            `Navigation menu item cascade audit disallows ${action.metadataName} actions`,
          );
        }
        if (
          action.metadataName === 'navigationMenuItem' &&
          action.type === 'update'
        ) {
          throw new Error(
            'Navigation menu item cascade audit disallows update_navigation_menu_item actions',
          );
        }
      }

      if (action.metadataName === 'navigationMenuItem') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Navigation menu item create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedNavCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error(
              'Navigation menu item create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Navigation menu item create action application mismatch',
            );
          }
          const explicitId =
            action.id !== undefined ? uuid(action.id) : undefined;
          if (explicitId !== undefined && beforeNavItems.has(explicitId)) {
            throw new Error(
              'Navigation menu item create target ID already exists',
            );
          }
          plannedNavCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.navigationMenuItems?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Navigation menu item update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedNavUpdates.has(targetId)) {
            throw new Error('Navigation menu item update audit duplicate ID');
          }
          plannedNavUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.navigationMenuItems?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item delete audit missing mapping',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedNavDeletes.has(targetId)) {
            throw new Error('Navigation menu item delete audit duplicate ID');
          }
          plannedNavDeletes.add(targetId);
        }
      } else if (action.metadataName === 'view' && action.type === 'delete') {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.views?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Navigation menu item cascade audit missing view mapping',
          );
        }
        plannedViewDeletes.add(uuid(mappedId));
      } else if (
        action.metadataName === 'pageLayout' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.pageLayouts?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Navigation menu item cascade audit missing pageLayout mapping',
          );
        }
        plannedPageLayoutDeletes.add(uuid(mappedId));
      } else if (
        action.metadataName === 'agentChatChannel' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.agentChatChannels?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Navigation menu item cascade audit missing agentChatChannel mapping',
          );
        }
        plannedChannelDeletes.add(uuid(mappedId));
      } else if (action.metadataName === 'objectMetadata') {
        if (action.type === 'create') {
          if (action.id !== undefined) {
            plannedObjectCreates.add(uuid(action.id));
          } else if (action.flatEntity?.id !== undefined) {
            plannedObjectCreates.add(uuid(action.flatEntity.id));
          }
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.objectMetadatas?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item cascade audit missing objectMetadata mapping',
            );
          }
          plannedObjectDeletes.add(uuid(mappedId));
        }
      } else if (
        action.metadataName === 'fieldMetadata' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.fieldMetadatas?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Navigation menu item cascade audit missing fieldMetadata mapping',
          );
        }
        plannedFieldDeletes.add(uuid(mappedId));
      }
    }

    if (request.mode === 'cascade') {
      const hasCascadeConstraint =
        request.expectedCreatedIds !== undefined ||
        request.expectedDeletedIds !== undefined ||
        request.expectedParentViewDeleteIds !== undefined ||
        request.expectedParentPageLayoutDeleteIds !== undefined ||
        request.expectedParentChannelDeleteIds !== undefined ||
        request.expectedCreatedObjectId !== undefined;
      if (!hasCascadeConstraint) {
        throw new Error(
          'Navigation menu item cascade audit requires explicit expected scope',
        );
      }
      if (plannedObjectDeletes.size > 0 || plannedFieldDeletes.size > 0) {
        throw new Error(
          'Navigation menu item cascade audit disallows objectMetadata or fieldMetadata delete actions',
        );
      }
    }

    if (request.expectedCreatedObjectId !== undefined) {
      if (
        plannedObjectCreates.size !== 1 ||
        !plannedObjectCreates.has(request.expectedCreatedObjectId)
      ) {
        throw new Error(
          'Navigation menu item cascade object create plan does not match expected object ID',
        );
      }
    } else if (request.mode === 'cascade' && plannedObjectCreates.size > 0) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected objectMetadata create',
      );
    }

    if (request.expectedParentViewDeleteIds !== undefined) {
      if (
        plannedViewDeletes.size !==
          request.expectedParentViewDeleteIds.length ||
        request.expectedParentViewDeleteIds.some(
          (id) => !plannedViewDeletes.has(id),
        )
      ) {
        throw new Error(
          'Navigation menu item cascade view delete plan does not match expected IDs',
        );
      }
    } else if (request.mode === 'cascade' && plannedViewDeletes.size > 0) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected view delete',
      );
    }

    if (request.expectedParentPageLayoutDeleteIds !== undefined) {
      if (
        plannedPageLayoutDeletes.size !==
          request.expectedParentPageLayoutDeleteIds.length ||
        request.expectedParentPageLayoutDeleteIds.some(
          (id) => !plannedPageLayoutDeletes.has(id),
        )
      ) {
        throw new Error(
          'Navigation menu item cascade pageLayout delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'cascade' &&
      plannedPageLayoutDeletes.size > 0
    ) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected pageLayout delete',
      );
    }

    if (request.expectedParentChannelDeleteIds !== undefined) {
      if (
        plannedChannelDeletes.size !==
          request.expectedParentChannelDeleteIds.length ||
        request.expectedParentChannelDeleteIds.some(
          (id) => !plannedChannelDeletes.has(id),
        )
      ) {
        throw new Error(
          'Navigation menu item cascade agentChatChannel delete plan does not match expected IDs',
        );
      }
    } else if (request.mode === 'cascade' && plannedChannelDeletes.size > 0) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected agentChatChannel delete',
      );
    }

    if (request.expectedCreatedIds !== undefined) {
      const actualCreatedIds = [
        ...plannedNavCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        actualCreatedIds.length !== request.expectedCreatedIds.length ||
        request.expectedCreatedIds.some((id) => !actualCreatedIds.includes(id))
      ) {
        throw new Error(
          'Navigation menu item create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'cascade' &&
      plannedNavCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected navigationMenuItem create',
      );
    }

    if (request.expectedUpdatedIds !== undefined) {
      if (
        plannedNavUpdates.size !== request.expectedUpdatedIds.length ||
        request.expectedUpdatedIds.some((id) => !plannedNavUpdates.has(id))
      ) {
        throw new Error(
          'Navigation menu item update plan does not match expected IDs',
        );
      }
    }

    if (request.expectedDeletedIds !== undefined) {
      if (
        plannedNavDeletes.size !== request.expectedDeletedIds.length ||
        request.expectedDeletedIds.some((id) => !plannedNavDeletes.has(id))
      ) {
        throw new Error(
          'Navigation menu item delete plan does not match expected IDs',
        );
      }
    } else if (request.mode === 'cascade' && plannedNavDeletes.size > 0) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected navigationMenuItem delete',
      );
    }

    const beforeViews =
      reg?.hasViewTable === true &&
      (plannedViewDeletes.size > 0 ||
        plannedObjectDeletes.size > 0 ||
        plannedFieldDeletes.size > 0)
        ? new Map<string, Record<string, unknown>>(
            (
              await runner.query(
                `SELECT to_jsonb(v) AS row FROM core.view v WHERE v."workspaceId"=$1 ORDER BY v.id FOR UPDATE`,
                [request.workspaceId],
              )
            ).map((entry: { row: Record<string, unknown> }) => [
              uuid(entry.row.id),
              entry.row,
            ]),
          )
        : new Map<string, Record<string, unknown>>();

    const beforePageLayouts =
      reg?.hasPageLayoutTable === true &&
      (plannedPageLayoutDeletes.size > 0 || plannedObjectDeletes.size > 0)
        ? new Map<string, Record<string, unknown>>(
            (
              await runner.query(
                `SELECT to_jsonb(pl) AS row FROM core."pageLayout" pl WHERE pl."workspaceId"=$1 ORDER BY pl.id FOR UPDATE`,
                [request.workspaceId],
              )
            ).map((entry: { row: Record<string, unknown> }) => [
              uuid(entry.row.id),
              entry.row,
            ]),
          )
        : new Map<string, Record<string, unknown>>();

    const expectedDeletedNavIds = computeCascadeDeletedNavigationMenuItemIds({
      beforeNavigationMenuItems: beforeNavItems,
      plannedNavDeletes,
      plannedObjectDeletes,
      plannedFieldDeletes,
      plannedViewDeletes,
      plannedPageLayoutDeletes,
      plannedAgentChatChannelDeletes: plannedChannelDeletes,
      beforeViews,
      beforePageLayouts,
    });

    let touchesUserScopedItem = false;
    for (const {
      flatEntity,
    } of plannedNavCreatesByUniversalIdentifier.values()) {
      if (nullableUuid(flatEntity.userWorkspaceId) !== null) {
        touchesUserScopedItem = true;
      }
    }
    for (const targetId of plannedNavUpdates.keys()) {
      const beforeRow = beforeNavItems.get(targetId);
      if (!beforeRow) {
        throw new Error('Navigation menu item update target row unavailable');
      }
      if (nullableUuid(beforeRow.userWorkspaceId) !== null) {
        touchesUserScopedItem = true;
      }
    }
    for (const targetId of expectedDeletedNavIds) {
      const beforeRow = beforeNavItems.get(targetId);
      if (!beforeRow) {
        throw new Error('Navigation menu item delete target row unavailable');
      }
      if (
        request.mode === 'delete' &&
        nullableUuid(beforeRow.userWorkspaceId) !== null
      ) {
        touchesUserScopedItem = true;
      }
    }

    const { operation, verifiedUserWorkspaceId } =
      await verifyActorAndUserWorkspace({
        runner,
        request,
        requireUserWorkspace: touchesUserScopedItem,
      });

    if (request.mode === 'create') {
      for (const {
        flatEntity,
      } of plannedNavCreatesByUniversalIdentifier.values()) {
        const itemUserWorkspaceId = nullableUuid(flatEntity.userWorkspaceId);
        if (
          itemUserWorkspaceId !== null &&
          itemUserWorkspaceId !== verifiedUserWorkspaceId
        ) {
          throw new Error(
            'User-level navigation menu item can only be created for the authenticated userWorkspace',
          );
        }
      }
    } else if (request.mode === 'update') {
      for (const targetId of plannedNavUpdates.keys()) {
        const beforeRow = beforeNavItems.get(targetId)!;
        const itemUserWorkspaceId = nullableUuid(beforeRow.userWorkspaceId);
        if (
          itemUserWorkspaceId !== null &&
          itemUserWorkspaceId !== verifiedUserWorkspaceId
        ) {
          throw new Error(
            'User-level navigation menu item can only be updated by its owner',
          );
        }
      }
    } else if (request.mode === 'delete') {
      for (const targetId of expectedDeletedNavIds) {
        const beforeRow = beforeNavItems.get(targetId)!;
        const itemUserWorkspaceId = nullableUuid(beforeRow.userWorkspaceId);
        if (
          itemUserWorkspaceId !== null &&
          itemUserWorkspaceId !== verifiedUserWorkspaceId
        ) {
          throw new Error(
            'User-level navigation menu item can only be deleted by its owner',
          );
        }
      }
    }

    const audit = new CrmAuditTransactionContext(runner, operation);
    let recordedMutations = 0;

    const result = await execute(runner);

    const afterNavItems = await readNavSnapshot(
      runner,
      request.workspaceId,
      false,
    );

    const createdByUniversalId = new Map<string, Record<string, unknown>>();
    for (const [id, afterRow] of afterNavItems.entries()) {
      assertNavigationMenuItemRowInvariants(afterRow, request.workspaceId);
      if (!beforeNavItems.has(id)) {
        const universalId = uuid(afterRow.universalIdentifier);
        if (createdByUniversalId.has(universalId)) {
          throw new Error(
            'Navigation menu item audit detected duplicate created universalIdentifier',
          );
        }
        createdByUniversalId.set(universalId, afterRow);
      }
    }

    if (
      createdByUniversalId.size !== plannedNavCreatesByUniversalIdentifier.size
    ) {
      throw new Error('Navigation menu item audit created row count mismatch');
    }

    for (const [
      universalId,
      planned,
    ] of plannedNavCreatesByUniversalIdentifier.entries()) {
      const afterRow = createdByUniversalId.get(universalId);
      if (!afterRow) {
        throw new Error(
          'Navigation menu item create did not persist expected row',
        );
      }
      const createdId = uuid(afterRow.id);
      if (planned.id !== undefined && createdId !== planned.id) {
        throw new Error('Navigation menu item create persisted unexpected ID');
      }
      if (uuid(afterRow.applicationId) !== applicationId) {
        throw new Error(
          'Navigation menu item create persisted unexpected applicationId',
        );
      }
      const afterProj = projectNavigationMenuItem(afterRow);
      if (
        afterProj.type !== assertNavigationMenuItemType(planned.flatEntity.type)
      ) {
        throw new Error(
          'Navigation menu item create persisted unexpected type',
        );
      }
      if (
        afterProj.userWorkspaceId !==
        nullableUuid(planned.flatEntity.userWorkspaceId)
      ) {
        throw new Error(
          'Navigation menu item create persisted unexpected userWorkspaceId',
        );
      }
      if (
        afterProj.userWorkspaceId !== null &&
        (request.mode !== 'create' ||
          afterProj.userWorkspaceId !== verifiedUserWorkspaceId)
      ) {
        throw new Error(
          'Navigation menu item create persisted unauthorized userWorkspaceId',
        );
      }
      if (
        afterProj.targetRecordId !==
        nullableUuid(planned.flatEntity.targetRecordId)
      ) {
        throw new Error(
          'Navigation menu item create persisted unexpected targetRecordId',
        );
      }
      for (const fkKey of [
        'folderId',
        'viewId',
        'targetObjectMetadataId',
        'pageLayoutId',
        'agentChatChannelId',
      ] as const) {
        if (
          planned.flatEntity[fkKey] !== undefined &&
          afterProj[fkKey] !== nullableUuid(planned.flatEntity[fkKey])
        ) {
          throw new Error(
            `Navigation menu item create persisted unexpected ${fkKey}`,
          );
        }
      }
      for (const textKey of ['name', 'link', 'icon', 'color'] as const) {
        if (planned.flatEntity[textKey] !== undefined) {
          const expectedText =
            planned.flatEntity[textKey] === null
              ? null
              : String(planned.flatEntity[textKey]);
          if (afterProj[textKey] !== expectedText) {
            throw new Error(
              `Navigation menu item create persisted unexpected ${textKey}`,
            );
          }
        }
      }
      if (
        planned.flatEntity.position !== undefined &&
        afterProj.position !== Number(planned.flatEntity.position)
      ) {
        throw new Error(
          'Navigation menu item create persisted unexpected position',
        );
      }

      audit.record({
        resourceKind: 'navigationMenuItem',
        resourceId: createdId,
        action: 'create',
        before: null,
        after: afterProj,
        securityDescriptor: {
          resourceKind: 'navigationMenuItem',
          resourceId: createdId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
    }

    for (const [targetId, update] of plannedNavUpdates.entries()) {
      const beforeRow = beforeNavItems.get(targetId);
      const afterRow = afterNavItems.get(targetId);
      if (!beforeRow || !afterRow) {
        throw new Error(
          'Navigation menu item update removed or lost target row',
        );
      }
      if (
        uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
        uuid(beforeRow.universalIdentifier) !==
          uuid(afterRow.universalIdentifier) ||
        nullableUuid(beforeRow.userWorkspaceId) !==
          nullableUuid(afterRow.userWorkspaceId) ||
        beforeRow.type !== afterRow.type ||
        nullableUuid(beforeRow.viewId) !== nullableUuid(afterRow.viewId) ||
        nullableUuid(beforeRow.targetObjectMetadataId) !==
          nullableUuid(afterRow.targetObjectMetadataId) ||
        nullableUuid(beforeRow.targetRecordId) !==
          nullableUuid(afterRow.targetRecordId) ||
        nullableUuid(beforeRow.agentChatChannelId) !==
          nullableUuid(afterRow.agentChatChannelId)
      ) {
        throw new Error(
          'Navigation menu item update modified immutable target or owner fields',
        );
      }
      const beforeProj = projectNavigationMenuItem(beforeRow);
      const afterProj = projectNavigationMenuItem(afterRow);
      if (afterProj.type !== 'PAGE_LAYOUT' && afterProj.pageLayoutId !== null) {
        throw new Error(
          'Navigation menu item update set pageLayoutId on non-PAGE_LAYOUT item',
        );
      }
      if (
        !('pageLayoutId' in update) &&
        !('pageLayoutUniversalIdentifier' in update) &&
        afterProj.pageLayoutId !== beforeProj.pageLayoutId
      ) {
        throw new Error(
          'Navigation menu item update modified pageLayoutId unexpectedly',
        );
      }
      if (
        'pageLayoutId' in update &&
        update.pageLayoutId !== undefined &&
        afterProj.pageLayoutId !== nullableUuid(update.pageLayoutId)
      ) {
        throw new Error(
          'Navigation menu item update did not persist expected pageLayoutId',
        );
      }
      if (
        !('folderId' in update) &&
        !('folderUniversalIdentifier' in update) &&
        afterProj.folderId !== beforeProj.folderId
      ) {
        throw new Error(
          'Navigation menu item update modified folderId unexpectedly',
        );
      }
      if (
        'folderId' in update &&
        update.folderId !== undefined &&
        afterProj.folderId !== nullableUuid(update.folderId)
      ) {
        throw new Error(
          'Navigation menu item update did not persist expected folderId',
        );
      }
      for (const textKey of ['name', 'link', 'icon', 'color'] as const) {
        const expectedVal =
          textKey in update && update[textKey] !== undefined
            ? update[textKey] === null
              ? null
              : String(update[textKey])
            : beforeProj[textKey];
        if (afterProj[textKey] !== expectedVal) {
          throw new Error(
            `Navigation menu item update did not persist expected ${textKey}`,
          );
        }
      }
      const expectedPos =
        'position' in update && update.position !== undefined
          ? Number(update.position)
          : beforeProj.position;
      if (afterProj.position !== expectedPos) {
        throw new Error(
          'Navigation menu item update did not persist expected position',
        );
      }
      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        audit.record({
          resourceKind: 'navigationMenuItem',
          resourceId: targetId,
          action: 'update',
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'navigationMenuItem',
            resourceId: targetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }
    }

    for (const deletedId of expectedDeletedNavIds) {
      const beforeRow = beforeNavItems.get(deletedId);
      if (!beforeRow) {
        throw new Error(
          'Navigation menu item delete expected row missing before migration',
        );
      }
      if (afterNavItems.has(deletedId)) {
        throw new Error(
          'Navigation menu item delete did not remove expected row',
        );
      }
      audit.record({
        resourceKind: 'navigationMenuItem',
        resourceId: deletedId,
        action: 'delete',
        before: projectNavigationMenuItem(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'navigationMenuItem',
          resourceId: deletedId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
    }

    for (const [id, beforeRow] of beforeNavItems.entries()) {
      if (expectedDeletedNavIds.has(id)) continue;
      const afterRow = afterNavItems.get(id);
      if (!afterRow) {
        throw new Error(
          'Navigation menu item audit detected unplanned row deletion',
        );
      }
      if (!plannedNavUpdates.has(id)) {
        if (
          canonicalAuditJson(
            scalarNavigationMenuItemWithoutTimestamps(beforeRow),
          ) !==
          canonicalAuditJson(
            scalarNavigationMenuItemWithoutTimestamps(afterRow),
          )
        ) {
          throw new Error(
            'Navigation menu item audit detected unplanned row mutation',
          );
        }
      }
    }

    if (recordedMutations > 0) {
      const expectedSerialized = serializeNavSnapshot(afterNavItems);
      await audit.flush();
      const postFlushNavItems = await readNavSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      if (serializeNavSnapshot(postFlushNavItems) !== expectedSerialized) {
        throw new Error(
          'Navigation menu item state changed during audit flush',
        );
      }
    }

    return result;
  });
};
