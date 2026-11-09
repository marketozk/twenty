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
  | 'cascade'
  | 'channel'
  | 'webhook'
  | 'skill'
  | 'frontComponent';

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
  expectedChannelCreateIds?: readonly string[];
  expectedChannelUpdateIds?: readonly string[];
  expectedChannelRoleCreateKeys?: readonly string[];
  expectedChannelRoleDeleteIds?: readonly string[];
  expectedWebhookCreateIds?: readonly string[];
  expectedWebhookUpdateIds?: readonly string[];
  expectedWebhookDeleteIds?: readonly string[];
  expectedSkillCreateIds?: readonly string[];
  expectedSkillUpdateIds?: readonly string[];
  expectedSkillDeleteIds?: readonly string[];
  expectedFrontComponentCreateIds?: readonly string[];
  expectedFrontComponentUpdateIds?: readonly string[];
  expectedFrontComponentDeleteIds?: readonly string[];
}>;

export type NavigationMenuItemAuditMappings = {
  application: { id: string; universalIdentifier: string };
  navigationMenuItems?: Record<string, { id: string } | undefined>;
  views?: Record<string, { id: string } | undefined>;
  pageLayouts?: Record<string, { id: string } | undefined>;
  agentChatChannels?: Record<string, { id: string } | undefined>;
  agentChatChannelRoles?: Record<string, { id: string } | undefined>;
  webhooks?: Record<string, { id: string } | undefined>;
  skills?: Record<string, { id: string } | undefined>;
  frontComponents?: Record<string, { id: string } | undefined>;
  settingsMenuItems?: Record<string, { id: string } | undefined>;
  roles?: Record<string, { id: string } | undefined>;
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

export const assertAgentChatChannelRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Agent chat channel audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Agent chat channel audit name is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Agent chat channel audit icon is invalid');
  }
  if (
    row.color !== null &&
    row.color !== undefined &&
    typeof row.color !== 'string'
  ) {
    throw new Error('Agent chat channel audit color is invalid');
  }
  const position =
    typeof row.position === 'number' ? row.position : Number(row.position);
  if (!Number.isFinite(position)) {
    throw new Error('Agent chat channel audit position is invalid');
  }
  if (typeof row.isCustom !== 'boolean') {
    throw new Error('Agent chat channel audit isCustom is invalid');
  }
};

export const projectAgentChatChannel = (row: Record<string, unknown>) => ({
  isCustom: Boolean(row.isCustom),
  name: String(row.name),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  color:
    row.color === undefined || row.color === null ? null : String(row.color),
  position:
    typeof row.position === 'number' ? row.position : Number(row.position),
});

export const assertAgentChatChannelRoleRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Agent chat channel role audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  uuid(row.channelId);
  uuid(row.roleId);
};

export const projectAgentChatChannelRole = (row: Record<string, unknown>) => ({
  channelId: uuid(row.channelId),
  roleId: uuid(row.roleId),
});

export const assertWebhookRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Webhook audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Webhook audit soft-deleted row is unsupported');
  }
  if (typeof row.targetUrl !== 'string' || row.targetUrl.trim().length === 0) {
    throw new Error('Webhook audit targetUrl is invalid');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(row.targetUrl);
  } catch {
    throw new Error('Webhook audit targetUrl is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Webhook audit targetUrl protocol is invalid');
  }
  if (
    !Array.isArray(row.operations) ||
    row.operations.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Webhook audit operations is invalid');
  }
  if (
    row.description !== null &&
    row.description !== undefined &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Webhook audit description is invalid');
  }
  if (typeof row.secret !== 'string') {
    throw new Error('Webhook audit secret is invalid');
  }
};

export const projectWebhook = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  targetUrl: String(row.targetUrl),
  operations: (row.operations as unknown[]).map((item) => String(item)),
  description:
    row.description === undefined || row.description === null
      ? null
      : String(row.description),
  secret: String(row.secret),
});

export const assertSkillRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Skill audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Skill audit soft-deleted row is unsupported');
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Skill audit name is invalid');
  }
  if (typeof row.label !== 'string' || row.label.trim().length === 0) {
    throw new Error('Skill audit label is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Skill audit icon is invalid');
  }
  if (
    row.description !== null &&
    row.description !== undefined &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Skill audit description is invalid');
  }
  if (typeof row.content !== 'string' || row.content.trim().length === 0) {
    throw new Error('Skill audit content is invalid');
  }
  if (typeof row.isCustom !== 'boolean') {
    throw new Error('Skill audit isCustom is invalid');
  }
  if (typeof row.isSystem !== 'boolean') {
    throw new Error('Skill audit isSystem is invalid');
  }
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Skill audit isActive is invalid');
  }
};

export const projectSkill = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  isCustom: Boolean(row.isCustom),
  isSystem: Boolean(row.isSystem),
  isActive: Boolean(row.isActive),
  name: String(row.name),
  label: String(row.label),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  description:
    row.description === undefined || row.description === null
      ? null
      : String(row.description),
  content: String(row.content),
});

export const assertFrontComponentRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Front component audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Front component audit soft-deleted row is unsupported');
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Front component audit name is invalid');
  }
  if (
    row.description !== null &&
    row.description !== undefined &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Front component audit description is invalid');
  }
  if (
    typeof row.sourceComponentPath !== 'string' ||
    row.sourceComponentPath.trim().length === 0
  ) {
    throw new Error('Front component audit sourceComponentPath is invalid');
  }
  if (
    typeof row.builtComponentPath !== 'string' ||
    row.builtComponentPath.trim().length === 0
  ) {
    throw new Error('Front component audit builtComponentPath is invalid');
  }
  if (
    typeof row.componentName !== 'string' ||
    row.componentName.trim().length === 0
  ) {
    throw new Error('Front component audit componentName is invalid');
  }
  if (
    typeof row.builtComponentChecksum !== 'string' ||
    row.builtComponentChecksum.trim().length === 0
  ) {
    throw new Error('Front component audit builtComponentChecksum is invalid');
  }
  if (typeof row.isHeadless !== 'boolean') {
    throw new Error('Front component audit isHeadless is invalid');
  }
  if (!Array.isArray(row.widgetAvailability)) {
    throw new Error('Front component audit widgetAvailability is invalid');
  }
  if (typeof row.usesSdkClient !== 'boolean') {
    throw new Error('Front component audit usesSdkClient is invalid');
  }
};

export const projectFrontComponent = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  isHeadless: Boolean(row.isHeadless),
  usesSdkClient: Boolean(row.usesSdkClient),
  name: String(row.name),
  description:
    row.description === undefined || row.description === null
      ? null
      : String(row.description),
  sourceComponentPath: String(row.sourceComponentPath),
  builtComponentPath: String(row.builtComponentPath),
  componentName: String(row.componentName),
  builtComponentChecksum: String(row.builtComponentChecksum),
  widgetAvailability: Array.isArray(row.widgetAvailability)
    ? row.widgetAvailability
    : [],
});

export const resolveExpectedFrontComponentWidgetAvailability = (
  flatOrUpdate: Record<string, unknown>,
  objectMetadatas?: Record<string, { id: string } | undefined>,
): unknown[] | undefined => {
  if (Array.isArray(flatOrUpdate.universalWidgetAvailability)) {
    return flatOrUpdate.universalWidgetAvailability.flatMap(
      (rawEntry: unknown) => {
        if (
          !rawEntry ||
          typeof rawEntry !== 'object' ||
          Array.isArray(rawEntry)
        ) {
          throw new Error(
            'Front component widgetAvailability entry is invalid',
          );
        }
        const { objectMetadataUniversalIdentifier, ...rest } =
          rawEntry as Record<string, unknown>;
        if (objectMetadataUniversalIdentifier === undefined) {
          return [rest];
        }
        if (objectMetadataUniversalIdentifier === null) {
          return [];
        }
        const mappedObjectId =
          objectMetadatas?.[uuid(objectMetadataUniversalIdentifier)]?.id;
        if (!mappedObjectId) {
          throw new Error(
            'Front component widgetAvailability references unknown objectMetadataUniversalIdentifier',
          );
        }
        return [{ ...rest, objectMetadataId: uuid(mappedObjectId) }];
      },
    );
  }
  if (Array.isArray(flatOrUpdate.widgetAvailability)) {
    return flatOrUpdate.widgetAvailability;
  }
  return undefined;
};

export const assertSettingsMenuItemRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Settings menu item audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Settings menu item audit soft-deleted row is unsupported');
  }
  uuid(row.frontComponentId);
  if (typeof row.title !== 'string' || row.title.trim().length === 0) {
    throw new Error('Settings menu item audit title is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Settings menu item audit icon is invalid');
  }
  const position =
    typeof row.position === 'number' ? row.position : Number(row.position);
  if (!Number.isFinite(position)) {
    throw new Error('Settings menu item audit position is invalid');
  }
  if (row.scope !== 'WORKSPACE' && row.scope !== 'USER') {
    throw new Error('Settings menu item audit scope is invalid');
  }
};

export const projectSettingsMenuItem = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  frontComponentId: uuid(row.frontComponentId),
  scope: String(row.scope),
  title: String(row.title),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  position:
    typeof row.position === 'number' ? row.position : Number(row.position),
});

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
  expectedChannelCreateIds?: readonly string[];
  expectedChannelUpdateIds?: readonly string[];
  expectedChannelRoleCreateKeys?: readonly string[];
  expectedChannelRoleDeleteIds?: readonly string[];
  expectedWebhookCreateIds?: readonly string[];
  expectedWebhookUpdateIds?: readonly string[];
  expectedWebhookDeleteIds?: readonly string[];
  expectedSkillCreateIds?: readonly string[];
  expectedSkillUpdateIds?: readonly string[];
  expectedSkillDeleteIds?: readonly string[];
  expectedFrontComponentCreateIds?: readonly string[];
  expectedFrontComponentUpdateIds?: readonly string[];
  expectedFrontComponentDeleteIds?: readonly string[];
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
  expectedChannelCreateIds,
  expectedChannelUpdateIds,
  expectedChannelRoleCreateKeys,
  expectedChannelRoleDeleteIds,
  expectedWebhookCreateIds,
  expectedWebhookUpdateIds,
  expectedWebhookDeleteIds,
  expectedSkillCreateIds,
  expectedSkillUpdateIds,
  expectedSkillDeleteIds,
  expectedFrontComponentCreateIds,
  expectedFrontComponentUpdateIds,
  expectedFrontComponentDeleteIds,
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
  const normalizeRoleKeys = (keys: readonly string[] | undefined) =>
    keys !== undefined
      ? Object.freeze(
          keys.map((key) => {
            const parts = String(key).split(':');
            if (parts.length !== 2) {
              throw new Error(
                'Agent chat channel role audit key format is invalid',
              );
            }
            return `${uuid(parts[0])}:${uuid(parts[1])}`;
          }),
        )
      : undefined;

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
  const baseChannelCreateIds = normalizeIds(expectedChannelCreateIds);
  const baseChannelUpdateIds = normalizeIds(expectedChannelUpdateIds);
  const baseChannelRoleCreateKeys = normalizeRoleKeys(
    expectedChannelRoleCreateKeys,
  );
  const baseChannelRoleDeleteIds = normalizeIds(expectedChannelRoleDeleteIds);
  const baseWebhookCreateIds = normalizeIds(expectedWebhookCreateIds);
  const baseWebhookUpdateIds = normalizeIds(expectedWebhookUpdateIds);
  const baseWebhookDeleteIds = normalizeIds(expectedWebhookDeleteIds);
  const baseSkillCreateIds = normalizeIds(expectedSkillCreateIds);
  const baseSkillUpdateIds = normalizeIds(expectedSkillUpdateIds);
  const baseSkillDeleteIds = normalizeIds(expectedSkillDeleteIds);
  const baseFrontComponentCreateIds = normalizeIds(
    expectedFrontComponentCreateIds,
  );
  const baseFrontComponentUpdateIds = normalizeIds(
    expectedFrontComponentUpdateIds,
  );
  const baseFrontComponentDeleteIds = normalizeIds(
    expectedFrontComponentDeleteIds,
  );

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
    const resolvedChannelCreateIds =
      normalizeIds(overrides?.expectedChannelCreateIds) ?? baseChannelCreateIds;
    const resolvedChannelUpdateIds =
      normalizeIds(overrides?.expectedChannelUpdateIds) ?? baseChannelUpdateIds;
    const resolvedChannelRoleCreateKeys =
      normalizeRoleKeys(overrides?.expectedChannelRoleCreateKeys) ??
      baseChannelRoleCreateKeys;
    const resolvedChannelRoleDeleteIds =
      normalizeIds(overrides?.expectedChannelRoleDeleteIds) ??
      baseChannelRoleDeleteIds;
    const resolvedWebhookCreateIds =
      normalizeIds(overrides?.expectedWebhookCreateIds) ?? baseWebhookCreateIds;
    const resolvedWebhookUpdateIds =
      normalizeIds(overrides?.expectedWebhookUpdateIds) ?? baseWebhookUpdateIds;
    const resolvedWebhookDeleteIds =
      normalizeIds(overrides?.expectedWebhookDeleteIds) ?? baseWebhookDeleteIds;
    const resolvedSkillCreateIds =
      normalizeIds(overrides?.expectedSkillCreateIds) ?? baseSkillCreateIds;
    const resolvedSkillUpdateIds =
      normalizeIds(overrides?.expectedSkillUpdateIds) ?? baseSkillUpdateIds;
    const resolvedSkillDeleteIds =
      normalizeIds(overrides?.expectedSkillDeleteIds) ?? baseSkillDeleteIds;
    const resolvedFrontComponentCreateIds =
      normalizeIds(overrides?.expectedFrontComponentCreateIds) ??
      baseFrontComponentCreateIds;
    const resolvedFrontComponentUpdateIds =
      normalizeIds(overrides?.expectedFrontComponentUpdateIds) ??
      baseFrontComponentUpdateIds;
    const resolvedFrontComponentDeleteIds =
      normalizeIds(overrides?.expectedFrontComponentDeleteIds) ??
      baseFrontComponentDeleteIds;

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
      ...(resolvedChannelCreateIds !== undefined
        ? { expectedChannelCreateIds: resolvedChannelCreateIds }
        : {}),
      ...(resolvedChannelUpdateIds !== undefined
        ? { expectedChannelUpdateIds: resolvedChannelUpdateIds }
        : {}),
      ...(resolvedChannelRoleCreateKeys !== undefined
        ? { expectedChannelRoleCreateKeys: resolvedChannelRoleCreateKeys }
        : {}),
      ...(resolvedChannelRoleDeleteIds !== undefined
        ? { expectedChannelRoleDeleteIds: resolvedChannelRoleDeleteIds }
        : {}),
      ...(resolvedWebhookCreateIds !== undefined
        ? { expectedWebhookCreateIds: resolvedWebhookCreateIds }
        : {}),
      ...(resolvedWebhookUpdateIds !== undefined
        ? { expectedWebhookUpdateIds: resolvedWebhookUpdateIds }
        : {}),
      ...(resolvedWebhookDeleteIds !== undefined
        ? { expectedWebhookDeleteIds: resolvedWebhookDeleteIds }
        : {}),
      ...(resolvedSkillCreateIds !== undefined
        ? { expectedSkillCreateIds: resolvedSkillCreateIds }
        : {}),
      ...(resolvedSkillUpdateIds !== undefined
        ? { expectedSkillUpdateIds: resolvedSkillUpdateIds }
        : {}),
      ...(resolvedSkillDeleteIds !== undefined
        ? { expectedSkillDeleteIds: resolvedSkillDeleteIds }
        : {}),
      ...(resolvedFrontComponentCreateIds !== undefined
        ? { expectedFrontComponentCreateIds: resolvedFrontComponentCreateIds }
        : {}),
      ...(resolvedFrontComponentUpdateIds !== undefined
        ? { expectedFrontComponentUpdateIds: resolvedFrontComponentUpdateIds }
        : {}),
      ...(resolvedFrontComponentDeleteIds !== undefined
        ? { expectedFrontComponentDeleteIds: resolvedFrontComponentDeleteIds }
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

const readChannelSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(c) AS row FROM core."agentChatChannel" c WHERE c."workspaceId"=$1 ORDER BY c.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readChannelRoleSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(cr) AS row FROM core."agentChatChannelRole" cr WHERE cr."workspaceId"=$1 ORDER BY cr.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readWebhookSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(w) AS row FROM core.webhook w WHERE w."workspaceId"=$1 ORDER BY w.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readSkillSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(s) AS row FROM core.skill s WHERE s."workspaceId"=$1 ORDER BY s.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readFrontComponentSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(fc) AS row FROM core."frontComponent" fc WHERE fc."workspaceId"=$1 ORDER BY fc.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readSettingsMenuItemSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(smi) AS row FROM core."settingsMenuItem" smi WHERE smi."workspaceId"=$1 ORDER BY smi.id${lock ? ' FOR UPDATE' : ''}`,
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

const serializeWebhookSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeSkillSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeFrontComponentSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeSettingsMenuItemSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeChannelAndRoleSnapshot = (
  channels: Map<string, Record<string, unknown>>,
  channelRoles: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson({
    channels: [...channels.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
    channelRoles: [...channelRoles.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  });

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
  if (
    !active.has(request) ||
    consumed.has(request) ||
    getNavigationMenuItemAudit(request.workspaceId) !== request
  ) {
    throw new Error(
      'Navigation menu item audit context is inactive or already consumed',
    );
  }
  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");

    const [reg] = await runner.query(
      `SELECT
        to_regclass('core."navigationMenuItem"') IS NOT NULL AS "hasNavTable",
        to_regclass('core.view') IS NOT NULL AS "hasViewTable",
        to_regclass('core."pageLayout"') IS NOT NULL AS "hasPageLayoutTable",
        to_regclass('core."agentChatChannel"') IS NOT NULL AS "hasChannelTable",
        to_regclass('core."agentChatChannelRole"') IS NOT NULL AS "hasChannelRoleTable",
        to_regclass('core.role') IS NOT NULL AS "hasRoleTable",
        to_regclass('core.webhook') IS NOT NULL AS "hasWebhookTable",
        to_regclass('core.skill') IS NOT NULL AS "hasSkillTable",
        to_regclass('core."frontComponent"') IS NOT NULL AS "hasFrontComponentTable",
        to_regclass('core."settingsMenuItem"') IS NOT NULL AS "hasSettingsMenuItemTable"`,
    );
    if (
      request.mode !== 'webhook' &&
      request.mode !== 'skill' &&
      request.mode !== 'frontComponent' &&
      reg?.hasNavTable !== true
    ) {
      throw new Error(
        'Navigation menu item audit table core.navigationMenuItem unavailable',
      );
    }

    const [workspaceRow] = await runner.query(
      `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [request.workspaceId],
    );
    if (!workspaceRow || workspaceRow.deletedAt !== null) {
      throw new Error('Navigation menu item audit workspace unavailable');
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

    const touchesWebhooks =
      request.mode === 'webhook' ||
      request.expectedWebhookCreateIds !== undefined ||
      request.expectedWebhookUpdateIds !== undefined ||
      request.expectedWebhookDeleteIds !== undefined ||
      actions.some((action) => action.metadataName === 'webhook');
    if (touchesWebhooks && reg?.hasWebhookTable !== true) {
      throw new Error('Webhook audit table core.webhook unavailable');
    }

    const beforeWebhooks =
      touchesWebhooks && reg?.hasWebhookTable === true
        ? await readWebhookSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeWebhooks.values()) {
      assertWebhookRowInvariants(row, request.workspaceId);
    }

    const touchesSkills =
      request.mode === 'skill' ||
      request.expectedSkillCreateIds !== undefined ||
      request.expectedSkillUpdateIds !== undefined ||
      request.expectedSkillDeleteIds !== undefined ||
      actions.some((action) => action.metadataName === 'skill');
    if (touchesSkills && reg?.hasSkillTable !== true) {
      throw new Error('Skill audit table core.skill unavailable');
    }

    const beforeSkills =
      touchesSkills && reg?.hasSkillTable === true
        ? await readSkillSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeSkills.values()) {
      assertSkillRowInvariants(row, request.workspaceId);
    }

    const touchesFrontComponents =
      request.mode === 'frontComponent' ||
      request.expectedFrontComponentCreateIds !== undefined ||
      request.expectedFrontComponentUpdateIds !== undefined ||
      request.expectedFrontComponentDeleteIds !== undefined ||
      actions.some(
        (action) =>
          action.metadataName === 'frontComponent' ||
          action.metadataName === 'settingsMenuItem',
      );
    if (touchesFrontComponents && reg?.hasFrontComponentTable !== true) {
      throw new Error(
        'Front component audit table core.frontComponent unavailable',
      );
    }

    const beforeFrontComponents =
      touchesFrontComponents && reg?.hasFrontComponentTable === true
        ? await readFrontComponentSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeFrontComponents.values()) {
      assertFrontComponentRowInvariants(row, request.workspaceId);
    }

    const touchesSettingsMenuItems =
      touchesFrontComponents &&
      (request.expectedFrontComponentDeleteIds !== undefined ||
        actions.some(
          (action) =>
            (action.metadataName === 'frontComponent' &&
              action.type === 'delete') ||
            action.metadataName === 'settingsMenuItem',
        ));
    if (
      actions.some((action) => action.metadataName === 'settingsMenuItem') &&
      reg?.hasSettingsMenuItemTable !== true
    ) {
      throw new Error(
        'Settings menu item audit table core.settingsMenuItem unavailable',
      );
    }

    const beforeSettingsMenuItems =
      touchesSettingsMenuItems && reg?.hasSettingsMenuItemTable === true
        ? await readSettingsMenuItemSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeSettingsMenuItems.values()) {
      assertSettingsMenuItemRowInvariants(row, request.workspaceId);
    }

    const touchesChannelsOrRoles =
      request.mode === 'channel' ||
      request.expectedParentChannelDeleteIds !== undefined ||
      request.expectedChannelCreateIds !== undefined ||
      request.expectedChannelUpdateIds !== undefined ||
      request.expectedChannelRoleCreateKeys !== undefined ||
      request.expectedChannelRoleDeleteIds !== undefined ||
      actions.some(
        (action) =>
          action.metadataName === 'agentChatChannel' ||
          action.metadataName === 'agentChatChannelRole',
      );

    if (
      actions.some((action) => action.metadataName === 'agentChatChannel') &&
      reg?.hasChannelTable !== true
    ) {
      throw new Error(
        'Agent chat channel audit table core.agentChatChannel unavailable',
      );
    }
    if (
      actions.some(
        (action) => action.metadataName === 'agentChatChannelRole',
      ) &&
      reg?.hasChannelRoleTable !== true
    ) {
      throw new Error(
        'Agent chat channel role audit table core.agentChatChannelRole unavailable',
      );
    }

    const beforeChannels =
      touchesChannelsOrRoles && reg?.hasChannelTable === true
        ? await readChannelSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeChannels.values()) {
      assertAgentChatChannelRowInvariants(row, request.workspaceId);
    }

    const beforeChannelRoles =
      touchesChannelsOrRoles && reg?.hasChannelRoleTable === true
        ? await readChannelRoleSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeChannelRoles.values()) {
      assertAgentChatChannelRoleRowInvariants(row, request.workspaceId);
    }

    const beforeNavItems =
      request.mode !== 'webhook' &&
      request.mode !== 'skill' &&
      request.mode !== 'frontComponent' &&
      reg?.hasNavTable === true
        ? await readNavSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
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
    const plannedChannelCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedChannelUpdates = new Map<string, Record<string, unknown>>();
    const plannedChannelDeletes = new Set<string>();
    const plannedChannelRoleCreatesByUniversalIdentifier = new Map<
      string,
      {
        id?: string;
        channelUniversalIdentifier: string;
        roleUniversalIdentifier: string;
        flatEntity: Record<string, unknown>;
      }
    >();
    const plannedChannelRoleDeletes = new Set<string>();
    const plannedWebhookCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedWebhookUpdates = new Map<string, Record<string, unknown>>();
    const plannedWebhookDeletes = new Set<string>();
    const plannedSkillCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedSkillUpdates = new Map<string, Record<string, unknown>>();
    const plannedSkillDeletes = new Set<string>();
    const plannedFrontComponentCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedFrontComponentUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedFrontComponentDeletes = new Set<string>();
    const plannedSettingsMenuItemDeletes = new Set<string>();
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
      } else if (request.mode === 'channel') {
        if (
          action.metadataName !== 'agentChatChannel' &&
          action.metadataName !== 'agentChatChannelRole' &&
          action.metadataName !== 'navigationMenuItem'
        ) {
          throw new Error(
            `Agent chat channel audit disallows ${action.metadataName} actions`,
          );
        }
        if (
          action.metadataName === 'navigationMenuItem' &&
          action.type !== 'delete'
        ) {
          throw new Error(
            'Agent chat channel audit allows only delete actions on navigationMenuItem',
          );
        }
      } else if (request.mode === 'webhook') {
        if (action.metadataName !== 'webhook') {
          throw new Error(
            `Webhook audit disallows ${action.metadataName} actions`,
          );
        }
      } else if (request.mode === 'skill') {
        if (action.metadataName !== 'skill') {
          throw new Error(
            `Skill audit disallows ${action.metadataName} actions`,
          );
        }
      } else if (request.mode === 'frontComponent') {
        if (
          action.metadataName !== 'frontComponent' &&
          !(
            action.metadataName === 'settingsMenuItem' &&
            action.type === 'delete'
          )
        ) {
          throw new Error(
            `Front component audit disallows ${action.metadataName} actions`,
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
      } else if (action.metadataName === 'agentChatChannel') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Agent chat channel create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedChannelCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error(
              'Agent chat channel create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Agent chat channel create action application mismatch',
            );
          }
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (explicitId !== undefined && beforeChannels.has(explicitId)) {
            throw new Error(
              'Agent chat channel create target ID already exists',
            );
          }
          plannedChannelCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.agentChatChannels?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Agent chat channel update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedChannelUpdates.has(targetId)) {
            throw new Error('Agent chat channel update audit duplicate ID');
          }
          plannedChannelUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.agentChatChannels?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item cascade audit missing agentChatChannel mapping',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedChannelDeletes.has(targetId)) {
            throw new Error('Agent chat channel delete audit duplicate ID');
          }
          plannedChannelDeletes.add(targetId);
        }
      } else if (action.metadataName === 'agentChatChannelRole') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Agent chat channel role create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedChannelRoleCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error(
              'Agent chat channel role create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Agent chat channel role create action application mismatch',
            );
          }
          const channelUid = uuid(action.flatEntity.channelUniversalIdentifier);
          const roleUid = uuid(action.flatEntity.roleUniversalIdentifier);
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (explicitId !== undefined && beforeChannelRoles.has(explicitId)) {
            throw new Error(
              'Agent chat channel role create target ID already exists',
            );
          }
          plannedChannelRoleCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            channelUniversalIdentifier: channelUid,
            roleUniversalIdentifier: roleUid,
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.agentChatChannelRoles?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Agent chat channel role delete audit missing mapping',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedChannelRoleDeletes.has(targetId)) {
            throw new Error(
              'Agent chat channel role delete audit duplicate ID',
            );
          }
          plannedChannelRoleDeletes.add(targetId);
        } else {
          throw new Error('Agent chat channel role update is unsupported');
        }
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
      } else if (action.metadataName === 'webhook') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error('Webhook create action requires flatEntity');
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedWebhookCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error(
              'Webhook create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error('Webhook create action application mismatch');
          }
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (explicitId !== undefined && beforeWebhooks.has(explicitId)) {
            throw new Error('Webhook create target ID already exists');
          }
          plannedWebhookCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.webhooks?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Webhook update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedWebhookUpdates.has(targetId)) {
            throw new Error('Webhook update audit duplicate ID');
          }
          plannedWebhookUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.webhooks?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Webhook delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedWebhookDeletes.has(targetId)) {
            throw new Error('Webhook delete audit duplicate ID');
          }
          plannedWebhookDeletes.add(targetId);
        } else {
          throw new Error(`Unsupported webhook action type ${action.type}`);
        }
      } else if (action.metadataName === 'skill') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error('Skill create action requires flatEntity');
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedSkillCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error('Skill create audit duplicate universalIdentifier');
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error('Skill create action application mismatch');
          }
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (explicitId !== undefined && beforeSkills.has(explicitId)) {
            throw new Error('Skill create target ID already exists');
          }
          plannedSkillCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.skills?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Skill update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedSkillUpdates.has(targetId)) {
            throw new Error('Skill update audit duplicate ID');
          }
          plannedSkillUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.skills?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Skill delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedSkillDeletes.has(targetId)) {
            throw new Error('Skill delete audit duplicate ID');
          }
          plannedSkillDeletes.add(targetId);
        } else {
          throw new Error(`Unsupported skill action type ${action.type}`);
        }
      } else if (action.metadataName === 'frontComponent') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Front component create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedFrontComponentCreatesByUniversalIdentifier.has(universalId)
          ) {
            throw new Error(
              'Front component create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Front component create action application mismatch',
            );
          }
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (
            explicitId !== undefined &&
            beforeFrontComponents.has(explicitId)
          ) {
            throw new Error('Front component create target ID already exists');
          }
          plannedFrontComponentCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.frontComponents?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Front component update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedFrontComponentUpdates.has(targetId)) {
            throw new Error('Front component update audit duplicate ID');
          }
          plannedFrontComponentUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.frontComponents?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Front component delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedFrontComponentDeletes.has(targetId)) {
            throw new Error('Front component delete audit duplicate ID');
          }
          plannedFrontComponentDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported frontComponent action type ${action.type}`,
          );
        }
      } else if (
        action.metadataName === 'settingsMenuItem' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.settingsMenuItems?.[universalId]?.id;
        if (!mappedId) {
          throw new Error('Settings menu item delete audit missing mapping');
        }
        const targetId = uuid(mappedId);
        if (plannedSettingsMenuItemDeletes.has(targetId)) {
          throw new Error('Settings menu item delete audit duplicate ID');
        }
        plannedSettingsMenuItemDeletes.add(targetId);
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
    } else if (request.mode === 'channel') {
      const hasChannelConstraint =
        request.expectedChannelCreateIds !== undefined ||
        request.expectedChannelUpdateIds !== undefined ||
        request.expectedParentChannelDeleteIds !== undefined ||
        request.expectedChannelRoleCreateKeys !== undefined ||
        request.expectedChannelRoleDeleteIds !== undefined;
      if (!hasChannelConstraint) {
        throw new Error(
          'Agent chat channel audit requires explicit expected scope',
        );
      }
    } else if (request.mode === 'webhook') {
      const hasWebhookConstraint =
        request.expectedWebhookCreateIds !== undefined ||
        request.expectedWebhookUpdateIds !== undefined ||
        request.expectedWebhookDeleteIds !== undefined;
      if (!hasWebhookConstraint) {
        throw new Error('Webhook audit requires explicit expected scope');
      }
    } else if (request.mode === 'skill') {
      const hasSkillConstraint =
        request.expectedSkillCreateIds !== undefined ||
        request.expectedSkillUpdateIds !== undefined ||
        request.expectedSkillDeleteIds !== undefined;
      if (!hasSkillConstraint) {
        throw new Error('Skill audit requires explicit expected scope');
      }
    } else if (request.mode === 'frontComponent') {
      const hasFrontComponentConstraint =
        request.expectedFrontComponentCreateIds !== undefined ||
        request.expectedFrontComponentUpdateIds !== undefined ||
        request.expectedFrontComponentDeleteIds !== undefined;
      if (!hasFrontComponentConstraint) {
        throw new Error(
          'Front component audit requires explicit expected scope',
        );
      }
    }

    if (request.expectedWebhookCreateIds !== undefined) {
      const actualWebhookCreateIds = [
        ...plannedWebhookCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedWebhookCreatesByUniversalIdentifier.size !==
          request.expectedWebhookCreateIds.length ||
        actualWebhookCreateIds.length !==
          request.expectedWebhookCreateIds.length ||
        request.expectedWebhookCreateIds.some(
          (id) => !actualWebhookCreateIds.includes(id),
        )
      ) {
        throw new Error('Webhook create plan does not match expected IDs');
      }
    } else if (
      request.mode === 'webhook' &&
      plannedWebhookCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error('Webhook audit detected unexpected webhook create');
    }

    if (request.expectedWebhookUpdateIds !== undefined) {
      if (
        plannedWebhookUpdates.size !==
          request.expectedWebhookUpdateIds.length ||
        request.expectedWebhookUpdateIds.some(
          (id) => !plannedWebhookUpdates.has(id),
        )
      ) {
        throw new Error('Webhook update plan does not match expected IDs');
      }
    } else if (request.mode === 'webhook' && plannedWebhookUpdates.size > 0) {
      throw new Error('Webhook audit detected unexpected webhook update');
    }

    if (request.expectedWebhookDeleteIds !== undefined) {
      if (
        plannedWebhookDeletes.size !==
          request.expectedWebhookDeleteIds.length ||
        request.expectedWebhookDeleteIds.some(
          (id) => !plannedWebhookDeletes.has(id),
        )
      ) {
        throw new Error('Webhook delete plan does not match expected IDs');
      }
    } else if (request.mode === 'webhook' && plannedWebhookDeletes.size > 0) {
      throw new Error('Webhook audit detected unexpected webhook delete');
    }

    const foreignWebhookAppIds = new Set<string>();
    for (const targetId of plannedWebhookUpdates.keys()) {
      const beforeWh = beforeWebhooks.get(targetId);
      if (!beforeWh) {
        throw new Error('Webhook update target row unavailable');
      }
      const whAppId = uuid(beforeWh.applicationId);
      if (whAppId !== applicationId) {
        if (request.mode !== 'webhook') {
          throw new Error(
            'Webhook update target row belongs to another application',
          );
        }
        foreignWebhookAppIds.add(whAppId);
      }
    }
    for (const targetId of plannedWebhookDeletes) {
      const beforeWh = beforeWebhooks.get(targetId);
      if (!beforeWh) {
        throw new Error('Webhook delete target row unavailable');
      }
      const whAppId = uuid(beforeWh.applicationId);
      if (whAppId !== applicationId) {
        if (request.mode !== 'webhook') {
          throw new Error(
            'Webhook delete target row belongs to another application',
          );
        }
        foreignWebhookAppIds.add(whAppId);
      }
    }
    if (foreignWebhookAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignWebhookAppIds]],
      );
      if (activeApps.length !== foreignWebhookAppIds.size) {
        throw new Error(
          'Webhook target row belongs to an unavailable application',
        );
      }
    }

    if (request.expectedSkillCreateIds !== undefined) {
      const actualSkillCreateIds = [
        ...plannedSkillCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedSkillCreatesByUniversalIdentifier.size !==
          request.expectedSkillCreateIds.length ||
        actualSkillCreateIds.length !== request.expectedSkillCreateIds.length ||
        request.expectedSkillCreateIds.some(
          (id) => !actualSkillCreateIds.includes(id),
        )
      ) {
        throw new Error('Skill create plan does not match expected IDs');
      }
    } else if (
      request.mode === 'skill' &&
      plannedSkillCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error('Skill audit detected unexpected skill create');
    }

    if (request.expectedSkillUpdateIds !== undefined) {
      if (
        plannedSkillUpdates.size !== request.expectedSkillUpdateIds.length ||
        request.expectedSkillUpdateIds.some(
          (id) => !plannedSkillUpdates.has(id),
        )
      ) {
        throw new Error('Skill update plan does not match expected IDs');
      }
    } else if (request.mode === 'skill' && plannedSkillUpdates.size > 0) {
      throw new Error('Skill audit detected unexpected skill update');
    }

    if (request.expectedSkillDeleteIds !== undefined) {
      if (
        plannedSkillDeletes.size !== request.expectedSkillDeleteIds.length ||
        request.expectedSkillDeleteIds.some(
          (id) => !plannedSkillDeletes.has(id),
        )
      ) {
        throw new Error('Skill delete plan does not match expected IDs');
      }
    } else if (request.mode === 'skill' && plannedSkillDeletes.size > 0) {
      throw new Error('Skill audit detected unexpected skill delete');
    }

    const foreignSkillAppIds = new Set<string>();
    for (const [targetId, updatePayload] of plannedSkillUpdates.entries()) {
      const beforeSk = beforeSkills.get(targetId);
      if (!beforeSk) {
        throw new Error('Skill update target row unavailable');
      }
      if ('isCustom' in updatePayload || 'isSystem' in updatePayload) {
        throw new Error(
          'Skill audit disallows mutating isCustom or isSystem flags',
        );
      }
      const skAppId = uuid(beforeSk.applicationId);
      const isOnlyIsActiveUpdate = Object.keys(updatePayload).every(
        (key) => key === 'isActive',
      );
      if (beforeSk.isCustom !== true && !isOnlyIsActiveUpdate) {
        throw new Error(
          'Skill audit allows only isActive updates on non-custom skills',
        );
      }
      if (skAppId !== applicationId) {
        if (request.mode !== 'skill') {
          throw new Error(
            'Skill update target row belongs to another application',
          );
        }
        foreignSkillAppIds.add(skAppId);
      }
    }
    for (const targetId of plannedSkillDeletes) {
      const beforeSk = beforeSkills.get(targetId);
      if (!beforeSk) {
        throw new Error('Skill delete target row unavailable');
      }
      if (beforeSk.isCustom !== true) {
        throw new Error('Skill audit disallows deleting non-custom skills');
      }
      const skAppId = uuid(beforeSk.applicationId);
      if (skAppId !== applicationId) {
        if (request.mode !== 'skill') {
          throw new Error(
            'Skill delete target row belongs to another application',
          );
        }
        foreignSkillAppIds.add(skAppId);
      }
    }
    if (foreignSkillAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignSkillAppIds]],
      );
      if (activeApps.length !== foreignSkillAppIds.size) {
        throw new Error(
          'Skill target row belongs to an unavailable application',
        );
      }
    }

    if (request.expectedFrontComponentCreateIds !== undefined) {
      const actualFrontComponentCreateIds = [
        ...plannedFrontComponentCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedFrontComponentCreatesByUniversalIdentifier.size !==
          request.expectedFrontComponentCreateIds.length ||
        actualFrontComponentCreateIds.length !==
          request.expectedFrontComponentCreateIds.length ||
        request.expectedFrontComponentCreateIds.some(
          (id) => !actualFrontComponentCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Front component create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'frontComponent' &&
      plannedFrontComponentCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Front component audit detected unexpected frontComponent create',
      );
    }

    if (request.expectedFrontComponentUpdateIds !== undefined) {
      if (
        plannedFrontComponentUpdates.size !==
          request.expectedFrontComponentUpdateIds.length ||
        request.expectedFrontComponentUpdateIds.some(
          (id) => !plannedFrontComponentUpdates.has(id),
        )
      ) {
        throw new Error(
          'Front component update plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'frontComponent' &&
      plannedFrontComponentUpdates.size > 0
    ) {
      throw new Error(
        'Front component audit detected unexpected frontComponent update',
      );
    }

    if (request.expectedFrontComponentDeleteIds !== undefined) {
      if (
        plannedFrontComponentDeletes.size !==
          request.expectedFrontComponentDeleteIds.length ||
        request.expectedFrontComponentDeleteIds.some(
          (id) => !plannedFrontComponentDeletes.has(id),
        )
      ) {
        throw new Error(
          'Front component delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'frontComponent' &&
      plannedFrontComponentDeletes.size > 0
    ) {
      throw new Error(
        'Front component audit detected unexpected frontComponent delete',
      );
    }

    const foreignFrontComponentAppIds = new Set<string>();
    for (const targetId of plannedFrontComponentUpdates.keys()) {
      const beforeFc = beforeFrontComponents.get(targetId);
      if (!beforeFc) {
        throw new Error('Front component update target row unavailable');
      }
      const fcAppId = uuid(beforeFc.applicationId);
      if (fcAppId !== applicationId) {
        if (request.mode !== 'frontComponent') {
          throw new Error(
            'Front component update target row belongs to another application',
          );
        }
        foreignFrontComponentAppIds.add(fcAppId);
      }
    }
    for (const targetId of plannedFrontComponentDeletes) {
      const beforeFc = beforeFrontComponents.get(targetId);
      if (!beforeFc) {
        throw new Error('Front component delete target row unavailable');
      }
      const fcAppId = uuid(beforeFc.applicationId);
      if (fcAppId !== applicationId) {
        if (request.mode !== 'frontComponent') {
          throw new Error(
            'Front component delete target row belongs to another application',
          );
        }
        foreignFrontComponentAppIds.add(fcAppId);
      }
    }
    for (const smiId of plannedSettingsMenuItemDeletes) {
      const beforeSmi = beforeSettingsMenuItems.get(smiId);
      if (
        !beforeSmi ||
        !plannedFrontComponentDeletes.has(uuid(beforeSmi.frontComponentId))
      ) {
        throw new Error(
          'Front component audit cannot delete unrelated settingsMenuItem',
        );
      }
    }
    if (foreignFrontComponentAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignFrontComponentAppIds]],
      );
      if (activeApps.length !== foreignFrontComponentAppIds.size) {
        throw new Error(
          'Front component target row belongs to an unavailable application',
        );
      }
    }

    if (request.expectedChannelCreateIds !== undefined) {
      const actualChannelCreateIds = [
        ...plannedChannelCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedChannelCreatesByUniversalIdentifier.size !==
          request.expectedChannelCreateIds.length ||
        actualChannelCreateIds.length !==
          request.expectedChannelCreateIds.length ||
        request.expectedChannelCreateIds.some(
          (id) => !actualChannelCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Agent chat channel create plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedChannelCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Agent chat channel audit detected unexpected agentChatChannel create',
      );
    }

    if (request.expectedChannelUpdateIds !== undefined) {
      if (
        plannedChannelUpdates.size !==
          request.expectedChannelUpdateIds.length ||
        request.expectedChannelUpdateIds.some(
          (id) => !plannedChannelUpdates.has(id),
        )
      ) {
        throw new Error(
          'Agent chat channel update plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedChannelUpdates.size > 0
    ) {
      throw new Error(
        'Agent chat channel audit detected unexpected agentChatChannel update',
      );
    }

    if (request.expectedChannelRoleCreateKeys !== undefined) {
      const actualKeys = [
        ...plannedChannelRoleCreatesByUniversalIdentifier.values(),
      ].map(
        (entry) =>
          `${entry.channelUniversalIdentifier}:${entry.roleUniversalIdentifier}`,
      );
      if (
        actualKeys.length !== request.expectedChannelRoleCreateKeys.length ||
        new Set(actualKeys).size !==
          new Set(request.expectedChannelRoleCreateKeys).size ||
        request.expectedChannelRoleCreateKeys.some(
          (key) => !actualKeys.includes(key),
        ) ||
        actualKeys.some(
          (key) => !request.expectedChannelRoleCreateKeys!.includes(key),
        )
      ) {
        throw new Error(
          'Agent chat channel role create plan does not match expected keys',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedChannelRoleCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Agent chat channel audit detected unexpected agentChatChannelRole create',
      );
    }

    if (request.expectedChannelRoleDeleteIds !== undefined) {
      if (
        plannedChannelRoleDeletes.size !==
          request.expectedChannelRoleDeleteIds.length ||
        request.expectedChannelRoleDeleteIds.some(
          (id) => !plannedChannelRoleDeletes.has(id),
        )
      ) {
        throw new Error(
          'Agent chat channel role delete plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedChannelRoleDeletes.size > 0
    ) {
      throw new Error(
        'Agent chat channel audit detected unexpected agentChatChannelRole delete',
      );
    }

    const foreignChannelAppIds = new Set<string>();
    for (const targetId of plannedChannelUpdates.keys()) {
      const beforeCh = beforeChannels.get(targetId);
      if (!beforeCh) {
        throw new Error(
          'Agent chat channel update target row unavailable or belongs to another application',
        );
      }
      const chAppId = uuid(beforeCh.applicationId);
      if (chAppId !== applicationId) {
        if (request.mode !== 'channel') {
          throw new Error(
            'Agent chat channel update target row unavailable or belongs to another application',
          );
        }
        foreignChannelAppIds.add(chAppId);
      }
    }
    if (foreignChannelAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignChannelAppIds]],
      );
      if (activeApps.length !== foreignChannelAppIds.size) {
        throw new Error(
          'Agent chat channel update target row unavailable or belongs to another application',
        );
      }
    }

    for (const targetId of plannedChannelDeletes) {
      const beforeCh = beforeChannels.get(targetId);
      if (!beforeCh) {
        throw new Error('Agent chat channel delete target row unavailable');
      }
      if (beforeCh.isCustom !== true) {
        throw new Error(
          'Agent chat channel delete audit cannot delete standard channel',
        );
      }
      if (reg?.hasChannelRoleTable === true) {
        const dbChannelRoleIds = [...beforeChannelRoles.values()]
          .filter((row) => uuid(row.channelId) === targetId)
          .map((row) => uuid(row.id));
        if (
          dbChannelRoleIds.some(
            (roleLinkId) => !plannedChannelRoleDeletes.has(roleLinkId),
          )
        ) {
          throw new Error(
            'Agent chat channel delete audit persisted agentChatChannelRole set changed',
          );
        }
      }
    }

    for (const targetId of plannedChannelRoleDeletes) {
      if (!beforeChannelRoles.has(targetId)) {
        throw new Error(
          'Agent chat channel role delete target row unavailable',
        );
      }
    }

    const expectedChannelRoleIdsByUniversalId = new Map<
      string,
      { channelId: string; roleId: string }
    >();
    if (plannedChannelRoleCreatesByUniversalIdentifier.size > 0) {
      const referencedRoleIds = new Set<string>();
      for (const [
        universalId,
        plannedRoleCreate,
      ] of plannedChannelRoleCreatesByUniversalIdentifier.entries()) {
        const mappedChannelId =
          mappings.agentChatChannels?.[
            plannedRoleCreate.channelUniversalIdentifier
          ]?.id ??
          plannedChannelCreatesByUniversalIdentifier.get(
            plannedRoleCreate.channelUniversalIdentifier,
          )?.id;
        const mappedRoleId =
          mappings.roles?.[plannedRoleCreate.roleUniversalIdentifier]?.id ??
          (typeof plannedRoleCreate.flatEntity.roleId === 'string' &&
          isUUID(plannedRoleCreate.flatEntity.roleId)
            ? uuid(plannedRoleCreate.flatEntity.roleId)
            : undefined);
        if (!mappedChannelId || !mappedRoleId) {
          throw new Error(
            'Agent chat channel role create audit missing channel or role mapping',
          );
        }
        const normalizedChannelId = uuid(mappedChannelId);
        const normalizedRoleId = uuid(mappedRoleId);
        if (
          !beforeChannels.has(normalizedChannelId) &&
          !plannedChannelCreatesByUniversalIdentifier.has(
            plannedRoleCreate.channelUniversalIdentifier,
          )
        ) {
          throw new Error(
            'Agent chat channel role create target channel unavailable',
          );
        }
        referencedRoleIds.add(normalizedRoleId);
        expectedChannelRoleIdsByUniversalId.set(universalId, {
          channelId: normalizedChannelId,
          roleId: normalizedRoleId,
        });
      }
      if (referencedRoleIds.size > 0) {
        if (reg?.hasRoleTable !== true) {
          throw new Error(
            'Agent chat channel role audit table core.role unavailable',
          );
        }
        const lockedRoles = await runner.query(
          `SELECT id FROM core.role WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
          [request.workspaceId, [...referencedRoleIds]],
        );
        if (lockedRoles.length !== referencedRoleIds.size) {
          throw new Error(
            'Agent chat channel role create target role unavailable in workspace',
          );
        }
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
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedChannelDeletes.size > 0
    ) {
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
        plannedNavCreatesByUniversalIdentifier.size !==
          request.expectedCreatedIds.length ||
        actualCreatedIds.length !== request.expectedCreatedIds.length ||
        request.expectedCreatedIds.some((id) => !actualCreatedIds.includes(id))
      ) {
        throw new Error(
          'Navigation menu item create plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
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
    } else if (
      (request.mode === 'cascade' || request.mode === 'channel') &&
      plannedNavDeletes.size > 0
    ) {
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

    const afterNavItems =
      request.mode !== 'webhook' &&
      request.mode !== 'skill' &&
      request.mode !== 'frontComponent' &&
      reg?.hasNavTable === true
        ? await readNavSnapshot(runner, request.workspaceId, false)
        : new Map<string, Record<string, unknown>>();

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

    let expectedChannelsAndRolesSerialized: string | undefined;
    if (touchesChannelsOrRoles) {
      const afterChannels =
        reg?.hasChannelTable === true
          ? await readChannelSnapshot(runner, request.workspaceId, false)
          : new Map<string, Record<string, unknown>>();
      const afterChannelRoles =
        reg?.hasChannelRoleTable === true
          ? await readChannelRoleSnapshot(runner, request.workspaceId, false)
          : new Map<string, Record<string, unknown>>();

      if (reg?.hasChannelTable === true) {
        const createdChannelsByUniversalId = new Map<
          string,
          Record<string, unknown>
        >();
        for (const [id, afterRow] of afterChannels.entries()) {
          assertAgentChatChannelRowInvariants(afterRow, request.workspaceId);
          if (!beforeChannels.has(id)) {
            const universalId = uuid(afterRow.universalIdentifier);
            if (createdChannelsByUniversalId.has(universalId)) {
              throw new Error(
                'Agent chat channel audit detected duplicate created universalIdentifier',
              );
            }
            createdChannelsByUniversalId.set(universalId, afterRow);
          }
        }
        if (
          createdChannelsByUniversalId.size !==
          plannedChannelCreatesByUniversalIdentifier.size
        ) {
          throw new Error(
            'Agent chat channel audit created row count mismatch',
          );
        }
        for (const [
          universalId,
          planned,
        ] of plannedChannelCreatesByUniversalIdentifier.entries()) {
          const afterRow = createdChannelsByUniversalId.get(universalId);
          if (!afterRow) {
            throw new Error(
              'Agent chat channel create did not persist expected row',
            );
          }
          const createdId = uuid(afterRow.id);
          if (planned.id !== undefined && createdId !== planned.id) {
            throw new Error(
              'Agent chat channel create persisted unexpected ID',
            );
          }
          if (uuid(afterRow.applicationId) !== applicationId) {
            throw new Error(
              'Agent chat channel create persisted unexpected applicationId',
            );
          }
          const afterProj = projectAgentChatChannel(afterRow);
          if (
            planned.flatEntity.isCustom !== undefined &&
            afterProj.isCustom !== Boolean(planned.flatEntity.isCustom)
          ) {
            throw new Error(
              'Agent chat channel create persisted unexpected isCustom',
            );
          }
          for (const textKey of ['name', 'icon', 'color'] as const) {
            if (planned.flatEntity[textKey] !== undefined) {
              const expectedText =
                planned.flatEntity[textKey] === null
                  ? null
                  : String(planned.flatEntity[textKey]);
              if (afterProj[textKey] !== expectedText) {
                throw new Error(
                  `Agent chat channel create persisted unexpected ${textKey}`,
                );
              }
            }
          }
          if (
            planned.flatEntity.position !== undefined &&
            afterProj.position !== Number(planned.flatEntity.position)
          ) {
            throw new Error(
              'Agent chat channel create persisted unexpected position',
            );
          }
          audit.record({
            resourceKind: 'agentChatChannel',
            resourceId: createdId,
            action: 'create',
            before: null,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'agentChatChannel',
              resourceId: createdId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }

        for (const [targetId, update] of plannedChannelUpdates.entries()) {
          const beforeRow = beforeChannels.get(targetId);
          const afterRow = afterChannels.get(targetId);
          if (!beforeRow || !afterRow) {
            throw new Error(
              'Agent chat channel update removed or lost target row',
            );
          }
          if (
            uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
            uuid(beforeRow.universalIdentifier) !==
              uuid(afterRow.universalIdentifier) ||
            Boolean(beforeRow.isCustom) !== Boolean(afterRow.isCustom)
          ) {
            throw new Error(
              'Agent chat channel update modified immutable fields',
            );
          }
          const beforeProj = projectAgentChatChannel(beforeRow);
          const afterProj = projectAgentChatChannel(afterRow);
          for (const textKey of ['name', 'icon', 'color'] as const) {
            const expectedVal =
              textKey in update && update[textKey] !== undefined
                ? update[textKey] === null
                  ? null
                  : String(update[textKey])
                : beforeProj[textKey];
            if (afterProj[textKey] !== expectedVal) {
              throw new Error(
                `Agent chat channel update did not persist expected ${textKey}`,
              );
            }
          }
          const expectedPos =
            'position' in update && update.position !== undefined
              ? Number(update.position)
              : beforeProj.position;
          if (afterProj.position !== expectedPos) {
            throw new Error(
              'Agent chat channel update did not persist expected position',
            );
          }
          if (
            canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)
          ) {
            audit.record({
              resourceKind: 'agentChatChannel',
              resourceId: targetId,
              action: 'update',
              before: beforeProj,
              after: afterProj,
              securityDescriptor: {
                resourceKind: 'agentChatChannel',
                resourceId: targetId,
                metadataAccess: 'currentWorkspaceAdministration',
              },
            });
            recordedMutations += 1;
          }
        }

        for (const deletedId of plannedChannelDeletes) {
          const beforeRow = beforeChannels.get(deletedId);
          if (!beforeRow) {
            throw new Error(
              'Agent chat channel delete expected row missing before migration',
            );
          }
          if (afterChannels.has(deletedId)) {
            throw new Error(
              'Agent chat channel delete did not remove expected row',
            );
          }
          audit.record({
            resourceKind: 'agentChatChannel',
            resourceId: deletedId,
            action: 'delete',
            before: projectAgentChatChannel(beforeRow),
            after: null,
            securityDescriptor: {
              resourceKind: 'agentChatChannel',
              resourceId: deletedId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }

        for (const [id, beforeRow] of beforeChannels.entries()) {
          if (plannedChannelDeletes.has(id)) continue;
          const afterRow = afterChannels.get(id);
          if (!afterRow) {
            throw new Error(
              'Agent chat channel audit detected unplanned row deletion',
            );
          }
          if (!plannedChannelUpdates.has(id)) {
            if (
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(beforeRow),
              ) !==
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(afterRow),
              )
            ) {
              throw new Error(
                'Agent chat channel audit detected unplanned row mutation',
              );
            }
          }
        }
      }

      if (reg?.hasChannelRoleTable === true) {
        const createdChannelRolesByUniversalId = new Map<
          string,
          Record<string, unknown>
        >();
        for (const [id, afterRow] of afterChannelRoles.entries()) {
          assertAgentChatChannelRoleRowInvariants(
            afterRow,
            request.workspaceId,
          );
          if (!beforeChannelRoles.has(id)) {
            const universalId = uuid(afterRow.universalIdentifier);
            if (createdChannelRolesByUniversalId.has(universalId)) {
              throw new Error(
                'Agent chat channel role audit detected duplicate created universalIdentifier',
              );
            }
            createdChannelRolesByUniversalId.set(universalId, afterRow);
          }
        }
        if (
          createdChannelRolesByUniversalId.size !==
          plannedChannelRoleCreatesByUniversalIdentifier.size
        ) {
          throw new Error(
            'Agent chat channel role audit created row count mismatch',
          );
        }
        for (const [
          universalId,
          planned,
        ] of plannedChannelRoleCreatesByUniversalIdentifier.entries()) {
          const afterRow = createdChannelRolesByUniversalId.get(universalId);
          const expectedIds =
            expectedChannelRoleIdsByUniversalId.get(universalId);
          if (!afterRow || !expectedIds) {
            throw new Error(
              'Agent chat channel role create did not persist expected row',
            );
          }
          const createdId = uuid(afterRow.id);
          if (planned.id !== undefined && createdId !== planned.id) {
            throw new Error(
              'Agent chat channel role create persisted unexpected ID',
            );
          }
          if (uuid(afterRow.applicationId) !== applicationId) {
            throw new Error(
              'Agent chat channel role create persisted unexpected applicationId',
            );
          }
          const afterProj = projectAgentChatChannelRole(afterRow);
          if (
            afterProj.channelId !== expectedIds.channelId ||
            afterProj.roleId !== expectedIds.roleId
          ) {
            throw new Error(
              'Agent chat channel role create persisted unexpected channelId or roleId',
            );
          }
          audit.record({
            resourceKind: 'agentChatChannelRole',
            resourceId: createdId,
            action: 'create',
            before: null,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'agentChatChannelRole',
              resourceId: createdId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }

        for (const deletedId of plannedChannelRoleDeletes) {
          const beforeRow = beforeChannelRoles.get(deletedId);
          if (!beforeRow) {
            throw new Error(
              'Agent chat channel role delete expected row missing before migration',
            );
          }
          if (afterChannelRoles.has(deletedId)) {
            throw new Error(
              'Agent chat channel role delete did not remove expected row',
            );
          }
          audit.record({
            resourceKind: 'agentChatChannelRole',
            resourceId: deletedId,
            action: 'delete',
            before: projectAgentChatChannelRole(beforeRow),
            after: null,
            securityDescriptor: {
              resourceKind: 'agentChatChannelRole',
              resourceId: deletedId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }

        for (const [id, beforeRow] of beforeChannelRoles.entries()) {
          if (plannedChannelRoleDeletes.has(id)) continue;
          const afterRow = afterChannelRoles.get(id);
          if (!afterRow) {
            throw new Error(
              'Agent chat channel role audit detected unplanned row deletion',
            );
          }
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error(
              'Agent chat channel role audit detected unplanned row mutation',
            );
          }
        }
      }

      expectedChannelsAndRolesSerialized = serializeChannelAndRoleSnapshot(
        afterChannels,
        afterChannelRoles,
      );
    }

    let expectedWebhooksSerialized: string | undefined;
    if (touchesWebhooks && reg?.hasWebhookTable === true) {
      const afterWebhooks = await readWebhookSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdWebhooksByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterWebhooks.entries()) {
        assertWebhookRowInvariants(afterRow, request.workspaceId);
        if (!beforeWebhooks.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdWebhooksByUniversalId.has(universalId)) {
            throw new Error(
              'Webhook audit detected duplicate created universalIdentifier',
            );
          }
          createdWebhooksByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdWebhooksByUniversalId.size !==
        plannedWebhookCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Webhook audit created row count mismatch');
      }
      for (const [
        universalId,
        planned,
      ] of plannedWebhookCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdWebhooksByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error('Webhook create did not persist expected row');
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Webhook create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error('Webhook create persisted unexpected applicationId');
        }
        const afterProj = projectWebhook(afterRow);
        if (
          planned.flatEntity.targetUrl !== undefined &&
          afterProj.targetUrl !== String(planned.flatEntity.targetUrl)
        ) {
          throw new Error('Webhook create persisted unexpected targetUrl');
        }
        if (planned.flatEntity.operations !== undefined) {
          if (
            !Array.isArray(planned.flatEntity.operations) ||
            canonicalAuditJson(afterProj.operations) !==
              canonicalAuditJson(
                planned.flatEntity.operations.map((item: unknown) =>
                  String(item),
                ),
              )
          ) {
            throw new Error('Webhook create persisted unexpected operations');
          }
        }
        if (planned.flatEntity.description !== undefined) {
          const expectedDesc =
            planned.flatEntity.description === null
              ? null
              : String(planned.flatEntity.description);
          if (afterProj.description !== expectedDesc) {
            throw new Error('Webhook create persisted unexpected description');
          }
        }
        if (
          planned.flatEntity.secret !== undefined &&
          afterProj.secret !== String(planned.flatEntity.secret)
        ) {
          throw new Error('Webhook create persisted unexpected secret');
        }
        audit.record({
          resourceKind: 'webhook',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'webhook',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedWebhookUpdates.entries()) {
        const beforeRow = beforeWebhooks.get(targetId);
        const afterRow = afterWebhooks.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Webhook update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier)
        ) {
          throw new Error('Webhook update modified immutable fields');
        }
        const beforeProj = projectWebhook(beforeRow);
        const afterProj = projectWebhook(afterRow);
        const expectedTargetUrl =
          'targetUrl' in update && update.targetUrl !== undefined
            ? String(update.targetUrl)
            : beforeProj.targetUrl;
        if (afterProj.targetUrl !== expectedTargetUrl) {
          throw new Error('Webhook update did not persist expected targetUrl');
        }
        const expectedOperations =
          'operations' in update && update.operations !== undefined
            ? Array.isArray(update.operations)
              ? update.operations.map((item: unknown) => String(item))
              : null
            : beforeProj.operations;
        if (
          expectedOperations === null ||
          canonicalAuditJson(afterProj.operations) !==
            canonicalAuditJson(expectedOperations)
        ) {
          throw new Error('Webhook update did not persist expected operations');
        }
        const expectedDesc =
          'description' in update && update.description !== undefined
            ? update.description === null
              ? null
              : String(update.description)
            : beforeProj.description;
        if (afterProj.description !== expectedDesc) {
          throw new Error(
            'Webhook update did not persist expected description',
          );
        }
        const expectedSecret =
          'secret' in update && update.secret !== undefined
            ? String(update.secret)
            : beforeProj.secret;
        if (afterProj.secret !== expectedSecret) {
          throw new Error('Webhook update did not persist expected secret');
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'webhook',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'webhook',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedWebhookDeletes) {
        const beforeRow = beforeWebhooks.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Webhook delete expected row missing before migration',
          );
        }
        if (afterWebhooks.has(deletedId)) {
          throw new Error('Webhook delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'webhook',
          resourceId: deletedId,
          action: 'delete',
          before: projectWebhook(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'webhook',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforeWebhooks.entries()) {
        if (plannedWebhookDeletes.has(id)) continue;
        const afterRow = afterWebhooks.get(id);
        if (!afterRow) {
          throw new Error('Webhook audit detected unplanned row deletion');
        }
        if (!plannedWebhookUpdates.has(id)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error('Webhook audit detected unplanned row mutation');
          }
        }
      }

      expectedWebhooksSerialized = serializeWebhookSnapshot(afterWebhooks);
    }

    let expectedSkillsSerialized: string | undefined;
    if (touchesSkills && reg?.hasSkillTable === true) {
      const afterSkills = await readSkillSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdSkillsByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterSkills.entries()) {
        assertSkillRowInvariants(afterRow, request.workspaceId);
        if (!beforeSkills.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdSkillsByUniversalId.has(universalId)) {
            throw new Error(
              'Skill audit detected duplicate created universalIdentifier',
            );
          }
          createdSkillsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdSkillsByUniversalId.size !==
        plannedSkillCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Skill audit created row count mismatch');
      }
      for (const [
        universalId,
        planned,
      ] of plannedSkillCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdSkillsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error('Skill create did not persist expected row');
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Skill create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error('Skill create persisted unexpected applicationId');
        }
        const afterProj = projectSkill(afterRow);
        for (const textKey of ['name', 'label', 'content'] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(`Skill create persisted unexpected ${textKey}`);
          }
        }
        for (const optKey of ['icon', 'description'] as const) {
          if (planned.flatEntity[optKey] !== undefined) {
            const expectedVal =
              planned.flatEntity[optKey] === null
                ? null
                : String(planned.flatEntity[optKey]);
            if (afterProj[optKey] !== expectedVal) {
              throw new Error(`Skill create persisted unexpected ${optKey}`);
            }
          }
        }
        for (const boolKey of ['isCustom', 'isSystem', 'isActive'] as const) {
          if (
            planned.flatEntity[boolKey] !== undefined &&
            afterProj[boolKey] !== Boolean(planned.flatEntity[boolKey])
          ) {
            throw new Error(`Skill create persisted unexpected ${boolKey}`);
          }
        }
        audit.record({
          resourceKind: 'skill',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'skill',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedSkillUpdates.entries()) {
        const beforeRow = beforeSkills.get(targetId);
        const afterRow = afterSkills.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Skill update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          Boolean(beforeRow.isCustom) !== Boolean(afterRow.isCustom) ||
          Boolean(beforeRow.isSystem) !== Boolean(afterRow.isSystem)
        ) {
          throw new Error('Skill update modified immutable fields');
        }
        const beforeProj = projectSkill(beforeRow);
        const afterProj = projectSkill(afterRow);
        for (const textKey of ['name', 'label', 'content'] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(`Skill update did not persist expected ${textKey}`);
          }
        }
        for (const optKey of ['icon', 'description'] as const) {
          const expectedVal =
            optKey in update && update[optKey] !== undefined
              ? update[optKey] === null
                ? null
                : String(update[optKey])
              : beforeProj[optKey];
          if (afterProj[optKey] !== expectedVal) {
            throw new Error(`Skill update did not persist expected ${optKey}`);
          }
        }
        const expectedIsActive =
          'isActive' in update && update.isActive !== undefined
            ? Boolean(update.isActive)
            : beforeProj.isActive;
        if (afterProj.isActive !== expectedIsActive) {
          throw new Error('Skill update did not persist expected isActive');
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'skill',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'skill',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedSkillDeletes) {
        const beforeRow = beforeSkills.get(deletedId);
        if (!beforeRow) {
          throw new Error('Skill delete expected row missing before migration');
        }
        if (afterSkills.has(deletedId)) {
          throw new Error('Skill delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'skill',
          resourceId: deletedId,
          action: 'delete',
          before: projectSkill(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'skill',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforeSkills.entries()) {
        if (plannedSkillDeletes.has(id)) continue;
        const afterRow = afterSkills.get(id);
        if (!afterRow) {
          throw new Error('Skill audit detected unplanned row deletion');
        }
        if (!plannedSkillUpdates.has(id)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error('Skill audit detected unplanned row mutation');
          }
        }
      }

      expectedSkillsSerialized = serializeSkillSnapshot(afterSkills);
    }

    let expectedFrontComponentsSerialized: string | undefined;
    let expectedSettingsMenuItemsSerialized: string | undefined;
    if (touchesFrontComponents && reg?.hasFrontComponentTable === true) {
      const afterFrontComponents = await readFrontComponentSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdFrontComponentsByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterFrontComponents.entries()) {
        assertFrontComponentRowInvariants(afterRow, request.workspaceId);
        if (!beforeFrontComponents.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdFrontComponentsByUniversalId.has(universalId)) {
            throw new Error(
              'Front component audit detected duplicate created universalIdentifier',
            );
          }
          createdFrontComponentsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdFrontComponentsByUniversalId.size !==
        plannedFrontComponentCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Front component audit created row count mismatch');
      }
      for (const [
        universalId,
        planned,
      ] of plannedFrontComponentCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdFrontComponentsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error(
            'Front component create did not persist expected row',
          );
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Front component create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Front component create persisted unexpected applicationId',
          );
        }
        const afterProj = projectFrontComponent(afterRow);
        for (const textKey of [
          'name',
          'sourceComponentPath',
          'builtComponentPath',
          'componentName',
          'builtComponentChecksum',
        ] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(
              `Front component create persisted unexpected ${textKey}`,
            );
          }
        }
        if (planned.flatEntity.description !== undefined) {
          const expectedDesc =
            planned.flatEntity.description === null
              ? null
              : String(planned.flatEntity.description);
          if (afterProj.description !== expectedDesc) {
            throw new Error(
              'Front component create persisted unexpected description',
            );
          }
        }
        for (const boolKey of ['isHeadless', 'usesSdkClient'] as const) {
          if (
            planned.flatEntity[boolKey] !== undefined &&
            afterProj[boolKey] !== Boolean(planned.flatEntity[boolKey])
          ) {
            throw new Error(
              `Front component create persisted unexpected ${boolKey}`,
            );
          }
        }
        const expectedWidgets = resolveExpectedFrontComponentWidgetAvailability(
          planned.flatEntity,
          mappings.objectMetadatas,
        );
        if (
          expectedWidgets !== undefined &&
          canonicalAuditJson(afterProj.widgetAvailability) !==
            canonicalAuditJson(expectedWidgets)
        ) {
          throw new Error(
            'Front component create persisted unexpected widgetAvailability',
          );
        }
        audit.record({
          resourceKind: 'frontComponent',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'frontComponent',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedFrontComponentUpdates.entries()) {
        const beforeRow = beforeFrontComponents.get(targetId);
        const afterRow = afterFrontComponents.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Front component update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier)
        ) {
          throw new Error('Front component update modified immutable fields');
        }
        const beforeProj = projectFrontComponent(beforeRow);
        const afterProj = projectFrontComponent(afterRow);
        for (const textKey of [
          'name',
          'sourceComponentPath',
          'builtComponentPath',
          'componentName',
          'builtComponentChecksum',
        ] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Front component update did not persist expected ${textKey}`,
            );
          }
        }
        const expectedDesc =
          'description' in update && update.description !== undefined
            ? update.description === null
              ? null
              : String(update.description)
            : beforeProj.description;
        if (afterProj.description !== expectedDesc) {
          throw new Error(
            'Front component update did not persist expected description',
          );
        }
        for (const boolKey of ['isHeadless', 'usesSdkClient'] as const) {
          const expectedVal =
            boolKey in update && update[boolKey] !== undefined
              ? Boolean(update[boolKey])
              : beforeProj[boolKey];
          if (afterProj[boolKey] !== expectedVal) {
            throw new Error(
              `Front component update did not persist expected ${boolKey}`,
            );
          }
        }
        const resolvedUpdateWidgets =
          resolveExpectedFrontComponentWidgetAvailability(
            update,
            mappings.objectMetadatas,
          );
        const expectedWidgets =
          resolvedUpdateWidgets !== undefined
            ? resolvedUpdateWidgets
            : beforeProj.widgetAvailability;
        if (
          canonicalAuditJson(afterProj.widgetAvailability) !==
          canonicalAuditJson(expectedWidgets)
        ) {
          throw new Error(
            'Front component update did not persist expected widgetAvailability',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'frontComponent',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'frontComponent',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedFrontComponentDeletes) {
        const beforeRow = beforeFrontComponents.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Front component delete expected row missing before migration',
          );
        }
        if (afterFrontComponents.has(deletedId)) {
          throw new Error('Front component delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'frontComponent',
          resourceId: deletedId,
          action: 'delete',
          before: projectFrontComponent(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'frontComponent',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforeFrontComponents.entries()) {
        if (plannedFrontComponentDeletes.has(id)) continue;
        const afterRow = afterFrontComponents.get(id);
        if (!afterRow) {
          throw new Error(
            'Front component audit detected unplanned row deletion',
          );
        }
        if (!plannedFrontComponentUpdates.has(id)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error(
              'Front component audit detected unplanned row mutation',
            );
          }
        }
      }

      expectedFrontComponentsSerialized =
        serializeFrontComponentSnapshot(afterFrontComponents);

      if (touchesSettingsMenuItems && reg?.hasSettingsMenuItemTable === true) {
        const afterSettingsMenuItems = await readSettingsMenuItemSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        for (const [id, afterRow] of afterSettingsMenuItems.entries()) {
          assertSettingsMenuItemRowInvariants(afterRow, request.workspaceId);
          if (!beforeSettingsMenuItems.has(id)) {
            throw new Error(
              'Settings menu item audit detected unplanned row creation',
            );
          }
        }
        for (const [smiId, beforeSmi] of beforeSettingsMenuItems.entries()) {
          const isExpectedDelete =
            plannedSettingsMenuItemDeletes.has(smiId) ||
            plannedFrontComponentDeletes.has(uuid(beforeSmi.frontComponentId));
          const afterSmi = afterSettingsMenuItems.get(smiId);
          if (isExpectedDelete) {
            if (afterSmi) {
              throw new Error(
                'Settings menu item delete did not remove expected row',
              );
            }
            audit.record({
              resourceKind: 'settingsMenuItem',
              resourceId: smiId,
              action: 'delete',
              before: projectSettingsMenuItem(beforeSmi),
              after: null,
              securityDescriptor: {
                resourceKind: 'settingsMenuItem',
                resourceId: smiId,
                metadataAccess: 'currentWorkspaceAdministration',
              },
            });
            recordedMutations += 1;
          } else {
            if (!afterSmi) {
              throw new Error(
                'Settings menu item audit detected unplanned row deletion',
              );
            }
            if (
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(beforeSmi),
              ) !==
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(afterSmi),
              )
            ) {
              throw new Error(
                'Settings menu item audit detected unplanned row mutation',
              );
            }
          }
        }
        expectedSettingsMenuItemsSerialized = serializeSettingsMenuItemSnapshot(
          afterSettingsMenuItems,
        );
      }
    }

    if (recordedMutations > 0) {
      const expectedSerialized =
        request.mode !== 'webhook' &&
        request.mode !== 'skill' &&
        request.mode !== 'frontComponent' &&
        reg?.hasNavTable === true
          ? serializeNavSnapshot(afterNavItems)
          : undefined;
      await audit.flush();
      if (expectedSerialized !== undefined) {
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
      if (expectedChannelsAndRolesSerialized !== undefined) {
        const postFlushChannels =
          reg?.hasChannelTable === true
            ? await readChannelSnapshot(runner, request.workspaceId, false)
            : new Map<string, Record<string, unknown>>();
        const postFlushChannelRoles =
          reg?.hasChannelRoleTable === true
            ? await readChannelRoleSnapshot(runner, request.workspaceId, false)
            : new Map<string, Record<string, unknown>>();
        if (
          serializeChannelAndRoleSnapshot(
            postFlushChannels,
            postFlushChannelRoles,
          ) !== expectedChannelsAndRolesSerialized
        ) {
          throw new Error(
            'Agent chat channel state changed during audit flush',
          );
        }
      }
      if (expectedWebhooksSerialized !== undefined) {
        const postFlushWebhooks = await readWebhookSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeWebhookSnapshot(postFlushWebhooks) !==
          expectedWebhooksSerialized
        ) {
          throw new Error('Webhook state changed during audit flush');
        }
      }
      if (expectedSkillsSerialized !== undefined) {
        const postFlushSkills = await readSkillSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeSkillSnapshot(postFlushSkills) !== expectedSkillsSerialized
        ) {
          throw new Error('Skill state changed during audit flush');
        }
      }
      if (expectedFrontComponentsSerialized !== undefined) {
        const postFlushFrontComponents = await readFrontComponentSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeFrontComponentSnapshot(postFlushFrontComponents) !==
          expectedFrontComponentsSerialized
        ) {
          throw new Error('Front component state changed during audit flush');
        }
      }
      if (expectedSettingsMenuItemsSerialized !== undefined) {
        const postFlushSettingsMenuItems = await readSettingsMenuItemSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeSettingsMenuItemSnapshot(postFlushSettingsMenuItems) !==
          expectedSettingsMenuItemsSerialized
        ) {
          throw new Error(
            'Settings menu item state changed during audit flush',
          );
        }
      }
    }

    return result;
  });
};
