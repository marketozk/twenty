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
  | 'frontComponent'
  | 'logicFunction'
  | 'timelineActivityType'
  | 'commandMenuItem'
  | 'pageLayout';

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
  expectedUpdatedObjectIds?: readonly string[];
  expectedCreatedFieldCount?: number;
  expectedUpdatedFieldCount?: number;
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
  expectedLogicFunctionCreateIds?: readonly string[];
  expectedLogicFunctionUpdateIds?: readonly string[];
  expectedLogicFunctionDeleteIds?: readonly string[];
  expectedParentWorkflowDeleteIds?: readonly string[];
  expectedParentWorkflowVersionDeleteIds?: readonly string[];
  expectedTimelineActivityTypeCreateIds?: readonly string[];
  expectedTimelineActivityTypeUpdateIds?: readonly string[];
  expectedTimelineActivityTypeDeleteIds?: readonly string[];
  expectedCommandMenuItemCreateIds?: readonly string[];
  expectedCommandMenuItemUpdateIds?: readonly string[];
  expectedCommandMenuItemDeleteIds?: readonly string[];
  expectedPageLayoutCreateIds?: readonly string[];
  expectedPageLayoutUpdateIds?: readonly string[];
  expectedPageLayoutDeleteIds?: readonly string[];
  expectedPageLayoutTabCreateIds?: readonly string[];
  expectedPageLayoutTabUpdateIds?: readonly string[];
  expectedPageLayoutTabDeleteIds?: readonly string[];
  expectedPageLayoutWidgetCreateIds?: readonly string[];
  expectedPageLayoutWidgetUpdateIds?: readonly string[];
  expectedPageLayoutWidgetDeleteIds?: readonly string[];
}>;

export type NavigationMenuItemAuditMappings = {
  application: { id: string; universalIdentifier: string };
  navigationMenuItems?: Record<string, { id: string } | undefined>;
  views?: Record<string, { id: string } | undefined>;
  pageLayouts?: Record<string, { id: string } | undefined>;
  pageLayoutTabs?: Record<string, { id: string } | undefined>;
  pageLayoutWidgets?: Record<string, { id: string } | undefined>;
  agentChatChannels?: Record<string, { id: string } | undefined>;
  agentChatChannelRoles?: Record<string, { id: string } | undefined>;
  webhooks?: Record<string, { id: string } | undefined>;
  skills?: Record<string, { id: string } | undefined>;
  frontComponents?: Record<string, { id: string } | undefined>;
  settingsMenuItems?: Record<string, { id: string } | undefined>;
  logicFunctions?: Record<string, { id: string } | undefined>;
  timelineActivityTypes?: Record<string, { id: string } | undefined>;
  commandMenuItems?: Record<string, { id: string } | undefined>;
  workflows?: Record<string, { id: string } | undefined>;
  workflowVersions?: Record<string, { id: string } | undefined>;
  roles?: Record<string, { id: string } | undefined>;
  objectMetadatas?: Record<string, { id: string } | undefined>;
  fieldMetadatas?: Record<string, { id: string } | undefined>;
  viewFieldGroups?: Record<string, { id: string } | undefined>;
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
  'commandMenuItem',
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

export const LOGIC_FUNCTION_TRIGGER_SETTINGS_KEYS = [
  'cronTriggerSettings',
  'databaseEventTriggerSettings',
  'httpRouteTriggerSettings',
  'serverRouteTriggerSettings',
  'toolTriggerSettings',
  'workflowActionTriggerSettings',
] as const;

export const assertLogicFunctionRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Logic function audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Logic function audit soft-deleted row is unsupported');
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Logic function audit name is invalid');
  }
  if (
    row.description !== null &&
    row.description !== undefined &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Logic function audit description is invalid');
  }
  if (row.runtime !== 'nodejs18.x' && row.runtime !== 'nodejs22.x') {
    throw new Error('Logic function audit runtime is invalid');
  }
  const timeoutSeconds =
    typeof row.timeoutSeconds === 'number'
      ? row.timeoutSeconds
      : Number(row.timeoutSeconds);
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 900
  ) {
    throw new Error('Logic function audit timeoutSeconds is invalid');
  }
  if (
    typeof row.sourceHandlerPath !== 'string' ||
    row.sourceHandlerPath.trim().length === 0
  ) {
    throw new Error('Logic function audit sourceHandlerPath is invalid');
  }
  if (
    typeof row.builtHandlerPath !== 'string' ||
    row.builtHandlerPath.trim().length === 0
  ) {
    throw new Error('Logic function audit builtHandlerPath is invalid');
  }
  if (
    typeof row.handlerName !== 'string' ||
    row.handlerName.trim().length === 0
  ) {
    throw new Error('Logic function audit handlerName is invalid');
  }
  if (
    row.checksum !== null &&
    row.checksum !== undefined &&
    (typeof row.checksum !== 'string' || row.checksum.trim().length === 0)
  ) {
    throw new Error('Logic function audit checksum is invalid');
  }
  if (typeof row.isBuildUpToDate !== 'boolean') {
    throw new Error('Logic function audit isBuildUpToDate is invalid');
  }
  if (row.executionMode !== 'LIVE' && row.executionMode !== 'PREBUILT') {
    throw new Error('Logic function audit executionMode is invalid');
  }
  for (const triggerKey of LOGIC_FUNCTION_TRIGGER_SETTINGS_KEYS) {
    const val = row[triggerKey];
    if (
      val !== null &&
      val !== undefined &&
      (typeof val !== 'object' || Array.isArray(val))
    ) {
      throw new Error(`Logic function audit ${triggerKey} is invalid`);
    }
  }
};

export const projectLogicFunction = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  runtime: String(row.runtime),
  timeoutSeconds:
    typeof row.timeoutSeconds === 'number'
      ? row.timeoutSeconds
      : Number(row.timeoutSeconds),
  isBuildUpToDate: Boolean(row.isBuildUpToDate),
  executionMode: String(row.executionMode),
  name: String(row.name),
  description:
    row.description === undefined || row.description === null
      ? null
      : String(row.description),
  sourceHandlerPath: String(row.sourceHandlerPath),
  builtHandlerPath: String(row.builtHandlerPath),
  handlerName: String(row.handlerName),
  checksum:
    row.checksum === undefined || row.checksum === null
      ? null
      : String(row.checksum),
  cronTriggerSettings:
    row.cronTriggerSettings === undefined || row.cronTriggerSettings === null
      ? null
      : row.cronTriggerSettings,
  databaseEventTriggerSettings:
    row.databaseEventTriggerSettings === undefined ||
    row.databaseEventTriggerSettings === null
      ? null
      : row.databaseEventTriggerSettings,
  httpRouteTriggerSettings:
    row.httpRouteTriggerSettings === undefined ||
    row.httpRouteTriggerSettings === null
      ? null
      : row.httpRouteTriggerSettings,
  serverRouteTriggerSettings:
    row.serverRouteTriggerSettings === undefined ||
    row.serverRouteTriggerSettings === null
      ? null
      : row.serverRouteTriggerSettings,
  toolTriggerSettings:
    row.toolTriggerSettings === undefined || row.toolTriggerSettings === null
      ? null
      : row.toolTriggerSettings,
  workflowActionTriggerSettings:
    row.workflowActionTriggerSettings === undefined ||
    row.workflowActionTriggerSettings === null
      ? null
      : row.workflowActionTriggerSettings,
});

export const computeCascadeDeletedCodeStepLogicFunctionIds = ({
  beforeWorkflowVersions,
  deletedWorkflowIds,
  deletedWorkflowVersionIds,
  beforeLogicFunctions,
}: {
  beforeWorkflowVersions: Map<string, Record<string, unknown>>;
  deletedWorkflowIds: ReadonlySet<string>;
  deletedWorkflowVersionIds: ReadonlySet<string>;
  beforeLogicFunctions: Map<string, Record<string, unknown>>;
}): Set<string> => {
  const deletedSteps: Array<Record<string, unknown>> = [];
  const remainingSteps: Array<Record<string, unknown>> = [];
  for (const [versionId, versionRow] of beforeWorkflowVersions.entries()) {
    const coreWfId = nullableUuid(versionRow.coreWorkflowId);
    const isDeleted =
      deletedWorkflowVersionIds.has(versionId) ||
      (coreWfId !== null && deletedWorkflowIds.has(coreWfId));
    const steps = Array.isArray(versionRow.steps) ? versionRow.steps : [];
    for (const step of steps) {
      if (step && typeof step === 'object' && !Array.isArray(step)) {
        if (isDeleted) {
          deletedSteps.push(step as Record<string, unknown>);
        } else {
          remainingSteps.push(step as Record<string, unknown>);
        }
      }
    }
  }
  const extractStepLogicFunctionId = (
    step: Record<string, unknown>,
    allowedTypes: ReadonlySet<string>,
  ): string | undefined => {
    if (typeof step.type !== 'string' || !allowedTypes.has(step.type)) {
      return undefined;
    }
    const settings = step.settings as Record<string, unknown> | undefined;
    const input = settings?.input as Record<string, unknown> | undefined;
    const rawId = input?.logicFunctionId;
    if (typeof rawId === 'string' && isUUID(rawId)) {
      return rawId.toLowerCase();
    }
    return undefined;
  };
  const codeAndLogicTypes = new Set<string>(['CODE', 'LOGIC_FUNCTION']);
  const codeOnlyTypes = new Set<string>(['CODE']);
  const stillReferencedIds = new Set<string>();
  for (const step of remainingSteps) {
    const id = extractStepLogicFunctionId(step, codeAndLogicTypes);
    if (id !== undefined) {
      stillReferencedIds.add(id);
    }
  }
  const cascadeDeleted = new Set<string>();
  for (const step of deletedSteps) {
    const id = extractStepLogicFunctionId(step, codeOnlyTypes);
    if (
      id !== undefined &&
      !stillReferencedIds.has(id) &&
      beforeLogicFunctions.has(id)
    ) {
      cascadeDeleted.add(id);
    }
  }
  return cascadeDeleted;
};

export const TIMELINE_ACTIVITY_TYPE_NULLABLE_UUID_KEYS = [
  'frontComponentUniversalIdentifier',
  'objectUniversalIdentifier',
  'targetRelationFieldUniversalIdentifier',
  'happensAtFieldUniversalIdentifier',
  'replacesTimelineActivityTypeUniversalIdentifier',
] as const;

export const assertTimelineActivityTypeRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Timeline activity type audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error(
      'Timeline activity type audit soft-deleted row is unsupported',
    );
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Timeline activity type audit name is invalid');
  }
  if (typeof row.label !== 'string' || row.label.trim().length === 0) {
    throw new Error('Timeline activity type audit label is invalid');
  }
  if (
    row.action !== null &&
    row.action !== undefined &&
    (typeof row.action !== 'string' || row.action.trim().length === 0)
  ) {
    throw new Error('Timeline activity type audit action is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Timeline activity type audit icon is invalid');
  }
  for (const uuidKey of TIMELINE_ACTIVITY_TYPE_NULLABLE_UUID_KEYS) {
    nullableUuid(row[uuidKey]);
  }
  if (
    row.triggerFieldUniversalIdentifiers !== null &&
    row.triggerFieldUniversalIdentifiers !== undefined
  ) {
    if (
      !Array.isArray(row.triggerFieldUniversalIdentifiers) ||
      row.triggerFieldUniversalIdentifiers.some(
        (item: unknown) => typeof item !== 'string' || !isUUID(item),
      )
    ) {
      throw new Error(
        'Timeline activity type audit triggerFieldUniversalIdentifiers is invalid',
      );
    }
  }
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Timeline activity type audit isActive is invalid');
  }
  if (
    row.overrides !== null &&
    row.overrides !== undefined &&
    (typeof row.overrides !== 'object' || Array.isArray(row.overrides))
  ) {
    throw new Error('Timeline activity type audit overrides is invalid');
  }
};

export const projectTimelineActivityType = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  action:
    row.action === undefined || row.action === null ? null : String(row.action),
  frontComponentUniversalIdentifier: nullableUuid(
    row.frontComponentUniversalIdentifier,
  ),
  objectUniversalIdentifier: nullableUuid(row.objectUniversalIdentifier),
  targetRelationFieldUniversalIdentifier: nullableUuid(
    row.targetRelationFieldUniversalIdentifier,
  ),
  triggerFieldUniversalIdentifiers: Array.isArray(
    row.triggerFieldUniversalIdentifiers,
  )
    ? row.triggerFieldUniversalIdentifiers.map((item: unknown) => uuid(item))
    : null,
  happensAtFieldUniversalIdentifier: nullableUuid(
    row.happensAtFieldUniversalIdentifier,
  ),
  replacesTimelineActivityTypeUniversalIdentifier: nullableUuid(
    row.replacesTimelineActivityTypeUniversalIdentifier,
  ),
  isActive: Boolean(row.isActive),
  name: String(row.name),
  label: String(row.label),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  overrides:
    row.overrides === undefined || row.overrides === null
      ? null
      : row.overrides,
});

const VALID_COMMAND_MENU_ITEM_AVAILABILITY_TYPES = new Set<string>([
  'GLOBAL',
  'RECORD_SELECTION',
  'FALLBACK',
]);

export const COMMAND_MENU_ITEM_NULLABLE_UUID_KEYS = [
  'workflowVersionId',
  'coreWorkflowVersionId',
  'frontComponentId',
  'availabilityObjectMetadataId',
  'navigationTargetObjectMetadataId',
  'pageLayoutId',
] as const;

export const assertCommandMenuItemRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Command menu item audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Command menu item audit soft-deleted row is unsupported');
  }
  for (const uuidKey of COMMAND_MENU_ITEM_NULLABLE_UUID_KEYS) {
    nullableUuid(row[uuidKey]);
  }
  if (
    typeof row.engineComponentKey !== 'string' ||
    row.engineComponentKey.trim().length === 0
  ) {
    throw new Error('Command menu item audit engineComponentKey is invalid');
  }
  if (typeof row.label !== 'string' || row.label.trim().length === 0) {
    throw new Error('Command menu item audit label is invalid');
  }
  for (const nullableTextKey of [
    'icon',
    'shortLabel',
    'conditionalAvailabilityExpression',
    'conditionalPinnedExpression',
  ] as const) {
    if (
      row[nullableTextKey] !== null &&
      row[nullableTextKey] !== undefined &&
      typeof row[nullableTextKey] !== 'string'
    ) {
      throw new Error(`Command menu item audit ${nullableTextKey} is invalid`);
    }
  }
  if (typeof row.position !== 'number' || !Number.isFinite(row.position)) {
    throw new Error('Command menu item audit position is invalid');
  }
  if (typeof row.isPinned !== 'boolean') {
    throw new Error('Command menu item audit isPinned is invalid');
  }
  if (
    typeof row.availabilityType !== 'string' ||
    !VALID_COMMAND_MENU_ITEM_AVAILABILITY_TYPES.has(row.availabilityType)
  ) {
    throw new Error('Command menu item audit availabilityType is invalid');
  }
  if (
    row.payload !== null &&
    row.payload !== undefined &&
    (typeof row.payload !== 'object' || Array.isArray(row.payload))
  ) {
    throw new Error('Command menu item audit payload is invalid');
  }
  if (row.hotKeys !== null && row.hotKeys !== undefined) {
    if (
      !Array.isArray(row.hotKeys) ||
      row.hotKeys.some((item: unknown) => typeof item !== 'string')
    ) {
      throw new Error('Command menu item audit hotKeys is invalid');
    }
  }
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Command menu item audit isActive is invalid');
  }
  if (typeof row.isSystemSideEffect !== 'boolean') {
    throw new Error('Command menu item audit isSystemSideEffect is invalid');
  }
  if (
    row.overrides !== null &&
    row.overrides !== undefined &&
    (typeof row.overrides !== 'object' || Array.isArray(row.overrides))
  ) {
    throw new Error('Command menu item audit overrides is invalid');
  }
};

export const projectCommandMenuItem = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  workflowVersionId: nullableUuid(row.workflowVersionId),
  coreWorkflowVersionId: nullableUuid(row.coreWorkflowVersionId),
  frontComponentId: nullableUuid(row.frontComponentId),
  engineComponentKey: String(row.engineComponentKey),
  isPinned: Boolean(row.isPinned),
  availabilityType: String(row.availabilityType),
  availabilityObjectMetadataId: nullableUuid(row.availabilityObjectMetadataId),
  navigationTargetObjectMetadataId: nullableUuid(
    row.navigationTargetObjectMetadataId,
  ),
  pageLayoutId: nullableUuid(row.pageLayoutId),
  isActive: Boolean(row.isActive),
  isSystemSideEffect: Boolean(row.isSystemSideEffect),
  label: String(row.label),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  shortLabel:
    row.shortLabel === undefined || row.shortLabel === null
      ? null
      : String(row.shortLabel),
  position: Number(row.position),
  payload:
    row.payload === undefined || row.payload === null ? null : row.payload,
  hotKeys: Array.isArray(row.hotKeys)
    ? row.hotKeys.map((item: unknown) => String(item))
    : null,
  conditionalAvailabilityExpression:
    row.conditionalAvailabilityExpression === undefined ||
    row.conditionalAvailabilityExpression === null
      ? null
      : String(row.conditionalAvailabilityExpression),
  conditionalPinnedExpression:
    row.conditionalPinnedExpression === undefined ||
    row.conditionalPinnedExpression === null
      ? null
      : String(row.conditionalPinnedExpression),
  overrides:
    row.overrides === undefined || row.overrides === null
      ? null
      : row.overrides,
});

const mapUniversalCommandMenuItemOverridesEntry = (
  entry: Record<string, unknown>,
  objectMetadatas?: Record<string, { id: string } | undefined>,
  pageLayouts?: Record<string, { id: string } | undefined>,
): Record<string, unknown> => {
  const {
    availabilityObjectMetadataUniversalIdentifier,
    pageLayoutUniversalIdentifier,
    ...rest
  } = entry;
  const mapped: Record<string, unknown> = { ...rest };
  if (availabilityObjectMetadataUniversalIdentifier !== undefined) {
    if (availabilityObjectMetadataUniversalIdentifier === null) {
      mapped.availabilityObjectMetadataId = null;
    } else {
      const resolvedId =
        objectMetadatas?.[uuid(availabilityObjectMetadataUniversalIdentifier)]
          ?.id;
      mapped.availabilityObjectMetadataId = resolvedId
        ? uuid(resolvedId)
        : null;
    }
  }
  if (pageLayoutUniversalIdentifier !== undefined) {
    if (pageLayoutUniversalIdentifier === null) {
      mapped.pageLayoutId = null;
    } else {
      const resolvedId = pageLayouts?.[uuid(pageLayoutUniversalIdentifier)]?.id;
      mapped.pageLayoutId = resolvedId ? uuid(resolvedId) : null;
    }
  }
  return mapped;
};

export const resolveExpectedCommandMenuItemOverrides = (
  source: Record<string, unknown>,
  objectMetadatas?: Record<string, { id: string } | undefined>,
  pageLayouts?: Record<string, { id: string } | undefined>,
): unknown => {
  if ('overrides' in source && source.overrides !== undefined) {
    return source.overrides === null ? null : source.overrides;
  }
  if (
    'universalOverrides' in source &&
    source.universalOverrides !== undefined
  ) {
    if (source.universalOverrides === null) {
      return null;
    }
    if (
      typeof source.universalOverrides !== 'object' ||
      Array.isArray(source.universalOverrides)
    ) {
      throw new Error(
        'Command menu item audit universalOverrides must be an object or null',
      );
    }
    const raw = source.universalOverrides as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    if (
      raw.workspaceCustom &&
      typeof raw.workspaceCustom === 'object' &&
      !Array.isArray(raw.workspaceCustom)
    ) {
      mapped.workspaceCustom = mapUniversalCommandMenuItemOverridesEntry(
        raw.workspaceCustom as Record<string, unknown>,
        objectMetadatas,
        pageLayouts,
      );
    }
    if (
      raw.application &&
      typeof raw.application === 'object' &&
      !Array.isArray(raw.application)
    ) {
      const appEntries: Record<string, unknown> = {};
      for (const [authorKey, authorEntry] of Object.entries(
        raw.application as Record<string, unknown>,
      )) {
        if (
          authorEntry &&
          typeof authorEntry === 'object' &&
          !Array.isArray(authorEntry)
        ) {
          appEntries[authorKey] = mapUniversalCommandMenuItemOverridesEntry(
            authorEntry as Record<string, unknown>,
            objectMetadatas,
            pageLayouts,
          );
        }
      }
      if (Object.keys(appEntries).length > 0) {
        mapped.application = appEntries;
      }
    }
    if (raw.translations !== undefined) {
      mapped.translations = raw.translations;
    }
    return Object.keys(mapped).length > 0 ? mapped : null;
  }
  return undefined;
};

export const VALID_PAGE_LAYOUT_TYPES = new Set<string>([
  'RECORD_INDEX',
  'RECORD_PAGE',
  'DASHBOARD',
  'STANDALONE_PAGE',
  'RECORD_FORM',
]);

export const VALID_PAGE_LAYOUT_TAB_LAYOUT_MODES = new Set<string>([
  'GRID',
  'VERTICAL_LIST',
  'CANVAS',
]);

export const VALID_PAGE_LAYOUT_WIDGET_TYPES = new Set<string>([
  'VIEW',
  'IFRAME',
  'FIELD',
  'FIELDS',
  'GRAPH',
  'STANDALONE_RICH_TEXT',
  'TIMELINE',
  'TASKS',
  'NOTES',
  'FILES',
  'EMAILS',
  'CALENDAR',
  'FIELD_RICH_TEXT',
  'WORKFLOW',
  'WORKFLOW_VERSION',
  'WORKFLOW_RUN',
  'FRONT_COMPONENT',
  'RECORD_TABLE',
  'EMAIL_THREAD',
  'CALL_RECORDING_SUMMARY',
  'CALL_RECORDING_TRANSCRIPT',
  'MESSAGE_CAMPAIGN_BODY',
  'MESSAGE_CAMPAIGN_DETAILS',
  'FORM_FIELD',
  'CHAT_THREADS',
  'CHAT',
]);

export const assertPageLayoutType = (value: unknown): string => {
  if (typeof value !== 'string' || !VALID_PAGE_LAYOUT_TYPES.has(value)) {
    throw new Error('Page layout audit type is invalid');
  }
  return value;
};

export const assertPageLayoutRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Page layout audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Page layout audit soft-deleted row is unsupported');
  }
  if (typeof row.name !== 'string' || row.name.trim().length === 0) {
    throw new Error('Page layout audit name is invalid');
  }
  assertPageLayoutType(row.type);
  nullableUuid(row.objectMetadataId);
  nullableUuid(row.defaultTabToFocusOnMobileAndSidePanelId);
  if (
    row.isSystemSideEffect !== undefined &&
    typeof row.isSystemSideEffect !== 'boolean'
  ) {
    throw new Error('Page layout audit isSystemSideEffect is invalid');
  }
  if (
    row.isFirstTabPinned !== undefined &&
    typeof row.isFirstTabPinned !== 'boolean'
  ) {
    throw new Error('Page layout audit isFirstTabPinned is invalid');
  }
};

export const projectPageLayout = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  type: assertPageLayoutType(row.type),
  objectMetadataId: nullableUuid(row.objectMetadataId),
  defaultTabToFocusOnMobileAndSidePanelId: nullableUuid(
    row.defaultTabToFocusOnMobileAndSidePanelId,
  ),
  isSystemSideEffect: Boolean(row.isSystemSideEffect ?? false),
  isFirstTabPinned:
    row.isFirstTabPinned === undefined ? true : Boolean(row.isFirstTabPinned),
  name: String(row.name),
});

export const assertPageLayoutTabLayoutMode = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !VALID_PAGE_LAYOUT_TAB_LAYOUT_MODES.has(value)
  ) {
    throw new Error('Page layout tab audit layoutMode is invalid');
  }
  return value;
};

export const assertPageLayoutTabRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Page layout tab audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Page layout tab audit soft-deleted row is unsupported');
  }
  uuid(row.pageLayoutId);
  if (typeof row.title !== 'string' || row.title.trim().length === 0) {
    throw new Error('Page layout tab audit title is invalid');
  }
  const position =
    typeof row.position === 'number' ? row.position : Number(row.position);
  if (!Number.isFinite(position)) {
    throw new Error('Page layout tab audit position is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Page layout tab audit icon is invalid');
  }
  assertPageLayoutTabLayoutMode(row.layoutMode);
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Page layout tab audit isActive is invalid');
  }
  if (typeof row.isSystemSideEffect !== 'boolean') {
    throw new Error('Page layout tab audit isSystemSideEffect is invalid');
  }
  if (
    row.overrides !== null &&
    row.overrides !== undefined &&
    (typeof row.overrides !== 'object' || Array.isArray(row.overrides))
  ) {
    throw new Error('Page layout tab audit overrides is invalid');
  }
};

export const projectPageLayoutTab = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  pageLayoutId: uuid(row.pageLayoutId),
  layoutMode: assertPageLayoutTabLayoutMode(row.layoutMode),
  isActive: Boolean(row.isActive),
  isSystemSideEffect: Boolean(row.isSystemSideEffect),
  title: String(row.title),
  position:
    typeof row.position === 'number' ? row.position : Number(row.position),
  icon: row.icon === undefined || row.icon === null ? null : String(row.icon),
  overrides:
    row.overrides === undefined || row.overrides === null
      ? null
      : row.overrides,
});

export const assertPageLayoutWidgetType = (value: unknown): string => {
  if (typeof value !== 'string' || !VALID_PAGE_LAYOUT_WIDGET_TYPES.has(value)) {
    throw new Error('Page layout widget audit type is invalid');
  }
  return value;
};

export const assertPageLayoutWidgetRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== workspaceId) {
    throw new Error('Page layout widget audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Page layout widget audit soft-deleted row is unsupported');
  }
  uuid(row.pageLayoutTabId);
  if (typeof row.title !== 'string') {
    throw new Error('Page layout widget audit title is invalid');
  }
  assertPageLayoutWidgetType(row.type);
  nullableUuid(row.objectMetadataId);
  if (
    row.conditionalDisplay !== null &&
    row.conditionalDisplay !== undefined &&
    (typeof row.conditionalDisplay !== 'object' ||
      Array.isArray(row.conditionalDisplay))
  ) {
    throw new Error('Page layout widget audit conditionalDisplay is invalid');
  }
  if (
    row.conditionalAvailabilityExpression !== null &&
    row.conditionalAvailabilityExpression !== undefined &&
    typeof row.conditionalAvailabilityExpression !== 'string'
  ) {
    throw new Error(
      'Page layout widget audit conditionalAvailabilityExpression is invalid',
    );
  }
  if (
    !row.gridPosition ||
    typeof row.gridPosition !== 'object' ||
    Array.isArray(row.gridPosition)
  ) {
    throw new Error('Page layout widget audit gridPosition is invalid');
  }
  if (
    row.position !== null &&
    row.position !== undefined &&
    (typeof row.position !== 'object' || Array.isArray(row.position))
  ) {
    throw new Error('Page layout widget audit position is invalid');
  }
  if (
    !row.configuration ||
    typeof row.configuration !== 'object' ||
    Array.isArray(row.configuration)
  ) {
    throw new Error('Page layout widget audit configuration is invalid');
  }
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Page layout widget audit isActive is invalid');
  }
  if (typeof row.isSystemSideEffect !== 'boolean') {
    throw new Error('Page layout widget audit isSystemSideEffect is invalid');
  }
  if (
    row.overrides !== null &&
    row.overrides !== undefined &&
    (typeof row.overrides !== 'object' || Array.isArray(row.overrides))
  ) {
    throw new Error('Page layout widget audit overrides is invalid');
  }
};

export const projectPageLayoutWidget = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  pageLayoutTabId: uuid(row.pageLayoutTabId),
  type: assertPageLayoutWidgetType(row.type),
  objectMetadataId: nullableUuid(row.objectMetadataId),
  isActive: Boolean(row.isActive),
  isSystemSideEffect: Boolean(row.isSystemSideEffect),
  title: String(row.title),
  conditionalDisplay:
    row.conditionalDisplay === undefined || row.conditionalDisplay === null
      ? null
      : row.conditionalDisplay,
  conditionalAvailabilityExpression:
    row.conditionalAvailabilityExpression === undefined ||
    row.conditionalAvailabilityExpression === null
      ? null
      : String(row.conditionalAvailabilityExpression),
  gridPosition: row.gridPosition,
  position:
    row.position === undefined || row.position === null ? null : row.position,
  configuration: row.configuration,
  overrides:
    row.overrides === undefined || row.overrides === null
      ? null
      : row.overrides,
});

export const stripUndefinedJson = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const stripped = stripUndefinedJson(item);
      return stripped === undefined ? null : stripped;
    });
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripUndefinedJson(v);
      if (stripped !== undefined) {
        out[k] = stripped;
      }
    }
    return out;
  }
  return value;
};

const mapUniversalPageLayoutWidgetOverridesEntry = (
  entry: Record<string, unknown>,
  pageLayoutTabs?: Record<string, { id: string } | undefined>,
): Record<string, unknown> => {
  const { pageLayoutTabUniversalIdentifier, ...rest } = entry;
  const mapped: Record<string, unknown> = { ...rest };
  if (pageLayoutTabUniversalIdentifier !== undefined) {
    if (pageLayoutTabUniversalIdentifier === null) {
      mapped.pageLayoutTabId = null;
    } else {
      const resolvedId =
        pageLayoutTabs?.[uuid(pageLayoutTabUniversalIdentifier)]?.id;
      mapped.pageLayoutTabId = resolvedId ? uuid(resolvedId) : null;
    }
  }
  return mapped;
};

const PAGE_LAYOUT_WIDGET_OVERRIDE_ENTRY_KEYS = new Set([
  'title',
  'position',
  'pageLayoutTabId',
  'pageLayoutTabUniversalIdentifier',
  'conditionalDisplay',
  'conditionalAvailabilityExpression',
  'isActive',
  'translations',
]);

export const resolveExpectedPageLayoutWidgetOverrides = (
  source: Record<string, unknown>,
  pageLayoutTabs?: Record<string, { id: string } | undefined>,
): unknown => {
  if ('overrides' in source && source.overrides !== undefined) {
    return source.overrides === null
      ? null
      : stripUndefinedJson(source.overrides);
  }
  if (
    'universalOverrides' in source &&
    source.universalOverrides !== undefined
  ) {
    if (source.universalOverrides === null) {
      return null;
    }
    if (
      typeof source.universalOverrides !== 'object' ||
      Array.isArray(source.universalOverrides)
    ) {
      throw new Error(
        'Page layout widget audit universalOverrides must be an object or null',
      );
    }
    const raw = source.universalOverrides as Record<string, unknown>;
    if (
      Object.keys(raw).some((key) =>
        PAGE_LAYOUT_WIDGET_OVERRIDE_ENTRY_KEYS.has(key),
      )
    ) {
      return stripUndefinedJson(
        mapUniversalPageLayoutWidgetOverridesEntry(raw, pageLayoutTabs),
      );
    }
    const mapped: Record<string, unknown> = {};
    for (const [authorKey, authorVal] of Object.entries(raw)) {
      if (
        authorKey === 'application' &&
        authorVal &&
        typeof authorVal === 'object' &&
        !Array.isArray(authorVal) &&
        !Object.keys(authorVal as Record<string, unknown>).some((innerKey) =>
          PAGE_LAYOUT_WIDGET_OVERRIDE_ENTRY_KEYS.has(innerKey),
        )
      ) {
        const appEntries: Record<string, unknown> = {};
        for (const [appAuthorKey, appAuthorEntry] of Object.entries(
          authorVal as Record<string, unknown>,
        )) {
          if (
            appAuthorEntry &&
            typeof appAuthorEntry === 'object' &&
            !Array.isArray(appAuthorEntry)
          ) {
            appEntries[appAuthorKey] =
              mapUniversalPageLayoutWidgetOverridesEntry(
                appAuthorEntry as Record<string, unknown>,
                pageLayoutTabs,
              );
          }
        }
        if (Object.keys(appEntries).length > 0) {
          mapped.application = appEntries;
        }
      } else if (
        authorVal &&
        typeof authorVal === 'object' &&
        !Array.isArray(authorVal)
      ) {
        mapped[authorKey] = mapUniversalPageLayoutWidgetOverridesEntry(
          authorVal as Record<string, unknown>,
          pageLayoutTabs,
        );
      }
    }
    return Object.keys(mapped).length > 0 ? stripUndefinedJson(mapped) : null;
  }
  return undefined;
};

export const resolveExpectedPageLayoutWidgetConfiguration = (
  source: Record<string, unknown>,
  maps: {
    fieldMetadatas?: Record<string, { id: string } | undefined>;
    frontComponents?: Record<string, { id: string } | undefined>;
    views?: Record<string, { id: string } | undefined>;
    viewFieldGroups?: Record<string, { id: string } | undefined>;
  },
): unknown => {
  if ('configuration' in source && source.configuration !== undefined) {
    return stripUndefinedJson(source.configuration);
  }
  if (
    !('universalConfiguration' in source) ||
    source.universalConfiguration === undefined
  ) {
    return undefined;
  }
  const uc = source.universalConfiguration;
  if (!uc || typeof uc !== 'object' || Array.isArray(uc)) {
    throw new Error(
      'Page layout widget audit universalConfiguration is invalid',
    );
  }
  const raw = uc as Record<string, unknown>;
  const resolveFieldId = (val: unknown): string => {
    const uid = uuid(val);
    const mapped = maps.fieldMetadatas?.[uid]?.id;
    return mapped ? uuid(mapped) : uid;
  };
  const resolveFilter = (filterVal: unknown): unknown => {
    if (!filterVal || typeof filterVal !== 'object' || Array.isArray(filterVal))
      return undefined;
    const fObj = filterVal as Record<string, unknown>;
    const recordFilters = Array.isArray(fObj.recordFilters)
      ? fObj.recordFilters.map((rf: unknown) => {
          const rfObj = rf as Record<string, unknown>;
          const {
            fieldMetadataUniversalIdentifier,
            relationTargetFieldMetadataUniversalIdentifier,
            ...restRf
          } = rfObj;
          return {
            ...restRf,
            fieldMetadataId: resolveFieldId(fieldMetadataUniversalIdentifier),
            ...(relationTargetFieldMetadataUniversalIdentifier !== undefined &&
            relationTargetFieldMetadataUniversalIdentifier !== null
              ? {
                  relationTargetFieldMetadataId: resolveFieldId(
                    relationTargetFieldMetadataUniversalIdentifier,
                  ),
                }
              : {}),
          };
        })
      : undefined;
    return {
      ...fObj,
      ...(recordFilters !== undefined ? { recordFilters } : {}),
    };
  };

  switch (raw.configurationType) {
    case 'AGGREGATE_CHART': {
      const {
        aggregateFieldMetadataUniversalIdentifier,
        ratioAggregateConfig,
        filter,
        ...rest
      } = raw;
      const ratioCfg =
        ratioAggregateConfig &&
        typeof ratioAggregateConfig === 'object' &&
        !Array.isArray(ratioAggregateConfig)
          ? {
              optionValue: (ratioAggregateConfig as Record<string, unknown>)
                .optionValue,
              fieldMetadataId: resolveFieldId(
                (ratioAggregateConfig as Record<string, unknown>)
                  .fieldMetadataUniversalIdentifier,
              ),
            }
          : undefined;
      return stripUndefinedJson({
        ...rest,
        aggregateFieldMetadataId: resolveFieldId(
          aggregateFieldMetadataUniversalIdentifier,
        ),
        ratioAggregateConfig: ratioCfg,
        filter: resolveFilter(filter),
      });
    }
    case 'PIE_CHART': {
      const {
        aggregateFieldMetadataUniversalIdentifier,
        groupByFieldMetadataUniversalIdentifier,
        filter,
        ...rest
      } = raw;
      return stripUndefinedJson({
        ...rest,
        aggregateFieldMetadataId: resolveFieldId(
          aggregateFieldMetadataUniversalIdentifier,
        ),
        groupByFieldMetadataId: resolveFieldId(
          groupByFieldMetadataUniversalIdentifier,
        ),
        filter: resolveFilter(filter),
      });
    }
    case 'BAR_CHART':
    case 'LINE_CHART': {
      const {
        aggregateFieldMetadataUniversalIdentifier,
        primaryAxisGroupByFieldMetadataUniversalIdentifier,
        secondaryAxisGroupByFieldMetadataUniversalIdentifier,
        filter,
        ...rest
      } = raw;
      return stripUndefinedJson({
        ...rest,
        aggregateFieldMetadataId: resolveFieldId(
          aggregateFieldMetadataUniversalIdentifier,
        ),
        primaryAxisGroupByFieldMetadataId: resolveFieldId(
          primaryAxisGroupByFieldMetadataUniversalIdentifier,
        ),
        secondaryAxisGroupByFieldMetadataId:
          secondaryAxisGroupByFieldMetadataUniversalIdentifier !== undefined &&
          secondaryAxisGroupByFieldMetadataUniversalIdentifier !== null
            ? resolveFieldId(
                secondaryAxisGroupByFieldMetadataUniversalIdentifier,
              )
            : undefined,
        filter: resolveFilter(filter),
      });
    }
    case 'FIELDS': {
      const { viewUniversalIdentifier, newFieldDefaultVisibility, ...rest } =
        raw;
      const resolvedViewId =
        viewUniversalIdentifier !== undefined &&
        viewUniversalIdentifier !== null
          ? (maps.views?.[uuid(viewUniversalIdentifier)]?.id ??
            uuid(viewUniversalIdentifier))
          : null;
      return stripUndefinedJson({
        ...rest,
        viewId: resolvedViewId ? uuid(resolvedViewId) : null,
        newFieldDefaultVisibility,
      });
    }
    case 'RECORD_TABLE': {
      const { viewUniversalIdentifier, ...rest } = raw;
      const resolvedViewId =
        viewUniversalIdentifier !== undefined &&
        viewUniversalIdentifier !== null
          ? (maps.views?.[uuid(viewUniversalIdentifier)]?.id ??
            uuid(viewUniversalIdentifier))
          : null;
      return stripUndefinedJson({
        ...rest,
        viewId: resolvedViewId ? uuid(resolvedViewId) : null,
      });
    }
    case 'FRONT_COMPONENT': {
      const {
        frontComponentUniversalIdentifier,
        configurationType,
        headerCommandMenuItemUniversalIdentifiers,
      } = raw;
      const fcUid = uuid(frontComponentUniversalIdentifier);
      const fcId = maps.frontComponents?.[fcUid]?.id ?? fcUid;
      return stripUndefinedJson({
        configurationType,
        frontComponentId: uuid(fcId),
        headerCommandMenuItemUniversalIdentifiers,
      });
    }
    case 'FORM_FIELD':
    case 'FIELD_RICH_TEXT': {
      const { fieldMetadataId: fieldUniversalId, ...rest } = raw;
      return stripUndefinedJson({
        ...rest,
        fieldMetadataId: resolveFieldId(fieldUniversalId),
      });
    }
    case 'VIEW_FIELD_GROUP': {
      const {
        viewId: viewUniversalId,
        viewFieldGroupId: groupUniversalId,
        ...rest
      } = raw;
      const vUid = uuid(viewUniversalId);
      const vId = maps.views?.[vUid]?.id ?? vUid;
      const gUid = uuid(groupUniversalId);
      const gId = maps.viewFieldGroups?.[gUid]?.id ?? gUid;
      return stripUndefinedJson({
        ...rest,
        viewId: uuid(vId),
        viewFieldGroupId: uuid(gId),
      });
    }
    case 'FIELD': {
      const {
        fieldMetadataId: fieldUniversalId,
        viewId: viewUniversalId,
        nestedRelationFieldMetadataId: nestedFieldUniversalId,
        ...rest
      } = raw;
      const resolvedViewId =
        viewUniversalId !== undefined && viewUniversalId !== null
          ? maps.views?.[uuid(viewUniversalId)]?.id
          : undefined;
      return stripUndefinedJson({
        ...rest,
        fieldMetadataId: resolveFieldId(fieldUniversalId),
        viewId: resolvedViewId ? uuid(resolvedViewId) : undefined,
        ...(nestedFieldUniversalId !== undefined &&
        nestedFieldUniversalId !== null
          ? {
              nestedRelationFieldMetadataId: resolveFieldId(
                nestedFieldUniversalId,
              ),
            }
          : {}),
      });
    }
    default:
      return stripUndefinedJson(raw);
  }
};

export const computeCascadeDeletedPageLayoutIds = ({
  beforePageLayouts,
  plannedPageLayoutDeletes,
  plannedObjectDeletes = new Set<string>(),
}: {
  beforePageLayouts: Map<string, Record<string, unknown>>;
  plannedPageLayoutDeletes: ReadonlySet<string>;
  plannedObjectDeletes?: ReadonlySet<string>;
}): Set<string> => {
  const cascadeDeleted = new Set<string>(plannedPageLayoutDeletes);
  if (plannedObjectDeletes.size > 0) {
    for (const [layoutId, layoutRow] of beforePageLayouts.entries()) {
      const objId = nullableUuid(layoutRow.objectMetadataId);
      if (objId !== null && plannedObjectDeletes.has(objId)) {
        cascadeDeleted.add(layoutId);
      }
    }
  }
  return cascadeDeleted;
};

export const computeCascadeDeletedPageLayoutTabIds = ({
  beforePageLayoutTabs,
  plannedPageLayoutTabDeletes,
  effectiveDeletedPageLayoutIds,
}: {
  beforePageLayoutTabs: Map<string, Record<string, unknown>>;
  plannedPageLayoutTabDeletes: ReadonlySet<string>;
  effectiveDeletedPageLayoutIds: ReadonlySet<string>;
}): Set<string> => {
  const cascadeDeleted = new Set<string>(plannedPageLayoutTabDeletes);
  if (effectiveDeletedPageLayoutIds.size > 0) {
    for (const [tabId, tabRow] of beforePageLayoutTabs.entries()) {
      const layoutId = nullableUuid(tabRow.pageLayoutId);
      if (layoutId !== null && effectiveDeletedPageLayoutIds.has(layoutId)) {
        cascadeDeleted.add(tabId);
      }
    }
  }
  return cascadeDeleted;
};

export const computeCascadeDeletedPageLayoutWidgetIds = ({
  beforePageLayoutWidgets,
  plannedPageLayoutWidgetDeletes,
  effectiveDeletedPageLayoutTabIds,
  plannedObjectDeletes = new Set<string>(),
}: {
  beforePageLayoutWidgets: Map<string, Record<string, unknown>>;
  plannedPageLayoutWidgetDeletes: ReadonlySet<string>;
  effectiveDeletedPageLayoutTabIds: ReadonlySet<string>;
  plannedObjectDeletes?: ReadonlySet<string>;
}): Set<string> => {
  const cascadeDeleted = new Set<string>(plannedPageLayoutWidgetDeletes);
  if (
    effectiveDeletedPageLayoutTabIds.size > 0 ||
    plannedObjectDeletes.size > 0
  ) {
    for (const [widgetId, widgetRow] of beforePageLayoutWidgets.entries()) {
      const tabId = nullableUuid(widgetRow.pageLayoutTabId);
      const objId = nullableUuid(widgetRow.objectMetadataId);
      if (
        (tabId !== null && effectiveDeletedPageLayoutTabIds.has(tabId)) ||
        (objId !== null && plannedObjectDeletes.has(objId))
      ) {
        cascadeDeleted.add(widgetId);
      }
    }
  }
  return cascadeDeleted;
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
  expectedUpdatedObjectIds?: readonly string[];
  expectedCreatedFieldCount?: number;
  expectedUpdatedFieldCount?: number;
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
  expectedLogicFunctionCreateIds?: readonly string[];
  expectedLogicFunctionUpdateIds?: readonly string[];
  expectedLogicFunctionDeleteIds?: readonly string[];
  expectedParentWorkflowDeleteIds?: readonly string[];
  expectedParentWorkflowVersionDeleteIds?: readonly string[];
  expectedTimelineActivityTypeCreateIds?: readonly string[];
  expectedTimelineActivityTypeUpdateIds?: readonly string[];
  expectedTimelineActivityTypeDeleteIds?: readonly string[];
  expectedCommandMenuItemCreateIds?: readonly string[];
  expectedCommandMenuItemUpdateIds?: readonly string[];
  expectedCommandMenuItemDeleteIds?: readonly string[];
  expectedPageLayoutCreateIds?: readonly string[];
  expectedPageLayoutUpdateIds?: readonly string[];
  expectedPageLayoutDeleteIds?: readonly string[];
  expectedPageLayoutTabCreateIds?: readonly string[];
  expectedPageLayoutTabUpdateIds?: readonly string[];
  expectedPageLayoutTabDeleteIds?: readonly string[];
  expectedPageLayoutWidgetCreateIds?: readonly string[];
  expectedPageLayoutWidgetUpdateIds?: readonly string[];
  expectedPageLayoutWidgetDeleteIds?: readonly string[];
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
  expectedUpdatedObjectIds,
  expectedCreatedFieldCount,
  expectedUpdatedFieldCount,
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
  expectedLogicFunctionCreateIds,
  expectedLogicFunctionUpdateIds,
  expectedLogicFunctionDeleteIds,
  expectedParentWorkflowDeleteIds,
  expectedParentWorkflowVersionDeleteIds,
  expectedTimelineActivityTypeCreateIds,
  expectedTimelineActivityTypeUpdateIds,
  expectedTimelineActivityTypeDeleteIds,
  expectedCommandMenuItemCreateIds,
  expectedCommandMenuItemUpdateIds,
  expectedCommandMenuItemDeleteIds,
  expectedPageLayoutCreateIds,
  expectedPageLayoutUpdateIds,
  expectedPageLayoutDeleteIds,
  expectedPageLayoutTabCreateIds,
  expectedPageLayoutTabUpdateIds,
  expectedPageLayoutTabDeleteIds,
  expectedPageLayoutWidgetCreateIds,
  expectedPageLayoutWidgetUpdateIds,
  expectedPageLayoutWidgetDeleteIds,
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
  const baseUpdatedObjectIds = normalizeIds(expectedUpdatedObjectIds);
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
  const baseLogicFunctionCreateIds = normalizeIds(
    expectedLogicFunctionCreateIds,
  );
  const baseLogicFunctionUpdateIds = normalizeIds(
    expectedLogicFunctionUpdateIds,
  );
  const baseLogicFunctionDeleteIds = normalizeIds(
    expectedLogicFunctionDeleteIds,
  );
  const baseParentWorkflowDeleteIds = normalizeIds(
    expectedParentWorkflowDeleteIds,
  );
  const baseParentWorkflowVersionDeleteIds = normalizeIds(
    expectedParentWorkflowVersionDeleteIds,
  );
  const baseTimelineActivityTypeCreateIds = normalizeIds(
    expectedTimelineActivityTypeCreateIds,
  );
  const baseTimelineActivityTypeUpdateIds = normalizeIds(
    expectedTimelineActivityTypeUpdateIds,
  );
  const baseTimelineActivityTypeDeleteIds = normalizeIds(
    expectedTimelineActivityTypeDeleteIds,
  );
  const baseCommandMenuItemCreateIds = normalizeIds(
    expectedCommandMenuItemCreateIds,
  );
  const baseCommandMenuItemUpdateIds = normalizeIds(
    expectedCommandMenuItemUpdateIds,
  );
  const baseCommandMenuItemDeleteIds = normalizeIds(
    expectedCommandMenuItemDeleteIds,
  );
  const basePageLayoutCreateIds = normalizeIds(expectedPageLayoutCreateIds);
  const basePageLayoutUpdateIds = normalizeIds(expectedPageLayoutUpdateIds);
  const basePageLayoutDeleteIds = normalizeIds(expectedPageLayoutDeleteIds);
  const basePageLayoutTabCreateIds = normalizeIds(
    expectedPageLayoutTabCreateIds,
  );
  const basePageLayoutTabUpdateIds = normalizeIds(
    expectedPageLayoutTabUpdateIds,
  );
  const basePageLayoutTabDeleteIds = normalizeIds(
    expectedPageLayoutTabDeleteIds,
  );
  const basePageLayoutWidgetCreateIds = normalizeIds(
    expectedPageLayoutWidgetCreateIds,
  );
  const basePageLayoutWidgetUpdateIds = normalizeIds(
    expectedPageLayoutWidgetUpdateIds,
  );
  const basePageLayoutWidgetDeleteIds = normalizeIds(
    expectedPageLayoutWidgetDeleteIds,
  );
  const baseCreatedFieldCount = expectedCreatedFieldCount;
  const baseUpdatedFieldCount = expectedUpdatedFieldCount;

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
    const resolvedUpdatedObjectIds =
      normalizeIds(overrides?.expectedUpdatedObjectIds) ?? baseUpdatedObjectIds;
    const resolvedCreatedFieldCount =
      overrides?.expectedCreatedFieldCount ?? baseCreatedFieldCount;
    const resolvedUpdatedFieldCount =
      overrides?.expectedUpdatedFieldCount ?? baseUpdatedFieldCount;
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
    const resolvedLogicFunctionCreateIds =
      normalizeIds(overrides?.expectedLogicFunctionCreateIds) ??
      baseLogicFunctionCreateIds;
    const resolvedLogicFunctionUpdateIds =
      normalizeIds(overrides?.expectedLogicFunctionUpdateIds) ??
      baseLogicFunctionUpdateIds;
    const resolvedLogicFunctionDeleteIds =
      normalizeIds(overrides?.expectedLogicFunctionDeleteIds) ??
      baseLogicFunctionDeleteIds;
    const resolvedParentWorkflowDeleteIds =
      normalizeIds(overrides?.expectedParentWorkflowDeleteIds) ??
      baseParentWorkflowDeleteIds;
    const resolvedParentWorkflowVersionDeleteIds =
      normalizeIds(overrides?.expectedParentWorkflowVersionDeleteIds) ??
      baseParentWorkflowVersionDeleteIds;
    const resolvedTimelineActivityTypeCreateIds =
      normalizeIds(overrides?.expectedTimelineActivityTypeCreateIds) ??
      baseTimelineActivityTypeCreateIds;
    const resolvedTimelineActivityTypeUpdateIds =
      normalizeIds(overrides?.expectedTimelineActivityTypeUpdateIds) ??
      baseTimelineActivityTypeUpdateIds;
    const resolvedTimelineActivityTypeDeleteIds =
      normalizeIds(overrides?.expectedTimelineActivityTypeDeleteIds) ??
      baseTimelineActivityTypeDeleteIds;
    const resolvedCommandMenuItemCreateIds =
      normalizeIds(overrides?.expectedCommandMenuItemCreateIds) ??
      baseCommandMenuItemCreateIds;
    const resolvedCommandMenuItemUpdateIds =
      normalizeIds(overrides?.expectedCommandMenuItemUpdateIds) ??
      baseCommandMenuItemUpdateIds;
    const resolvedCommandMenuItemDeleteIds =
      normalizeIds(overrides?.expectedCommandMenuItemDeleteIds) ??
      baseCommandMenuItemDeleteIds;
    const resolvedPageLayoutCreateIds =
      normalizeIds(overrides?.expectedPageLayoutCreateIds) ??
      basePageLayoutCreateIds;
    const resolvedPageLayoutUpdateIds =
      normalizeIds(overrides?.expectedPageLayoutUpdateIds) ??
      basePageLayoutUpdateIds;
    const resolvedPageLayoutDeleteIds =
      normalizeIds(overrides?.expectedPageLayoutDeleteIds) ??
      basePageLayoutDeleteIds;
    const resolvedPageLayoutTabCreateIds =
      normalizeIds(overrides?.expectedPageLayoutTabCreateIds) ??
      basePageLayoutTabCreateIds;
    const resolvedPageLayoutTabUpdateIds =
      normalizeIds(overrides?.expectedPageLayoutTabUpdateIds) ??
      basePageLayoutTabUpdateIds;
    const resolvedPageLayoutTabDeleteIds =
      normalizeIds(overrides?.expectedPageLayoutTabDeleteIds) ??
      basePageLayoutTabDeleteIds;
    const resolvedPageLayoutWidgetCreateIds =
      normalizeIds(overrides?.expectedPageLayoutWidgetCreateIds) ??
      basePageLayoutWidgetCreateIds;
    const resolvedPageLayoutWidgetUpdateIds =
      normalizeIds(overrides?.expectedPageLayoutWidgetUpdateIds) ??
      basePageLayoutWidgetUpdateIds;
    const resolvedPageLayoutWidgetDeleteIds =
      normalizeIds(overrides?.expectedPageLayoutWidgetDeleteIds) ??
      basePageLayoutWidgetDeleteIds;

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
      ...(resolvedUpdatedObjectIds !== undefined
        ? { expectedUpdatedObjectIds: resolvedUpdatedObjectIds }
        : {}),
      ...(resolvedCreatedFieldCount !== undefined
        ? { expectedCreatedFieldCount: resolvedCreatedFieldCount }
        : {}),
      ...(resolvedUpdatedFieldCount !== undefined
        ? { expectedUpdatedFieldCount: resolvedUpdatedFieldCount }
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
      ...(resolvedLogicFunctionCreateIds !== undefined
        ? { expectedLogicFunctionCreateIds: resolvedLogicFunctionCreateIds }
        : {}),
      ...(resolvedLogicFunctionUpdateIds !== undefined
        ? { expectedLogicFunctionUpdateIds: resolvedLogicFunctionUpdateIds }
        : {}),
      ...(resolvedLogicFunctionDeleteIds !== undefined
        ? { expectedLogicFunctionDeleteIds: resolvedLogicFunctionDeleteIds }
        : {}),
      ...(resolvedParentWorkflowDeleteIds !== undefined
        ? { expectedParentWorkflowDeleteIds: resolvedParentWorkflowDeleteIds }
        : {}),
      ...(resolvedParentWorkflowVersionDeleteIds !== undefined
        ? {
            expectedParentWorkflowVersionDeleteIds:
              resolvedParentWorkflowVersionDeleteIds,
          }
        : {}),
      ...(resolvedTimelineActivityTypeCreateIds !== undefined
        ? {
            expectedTimelineActivityTypeCreateIds:
              resolvedTimelineActivityTypeCreateIds,
          }
        : {}),
      ...(resolvedTimelineActivityTypeUpdateIds !== undefined
        ? {
            expectedTimelineActivityTypeUpdateIds:
              resolvedTimelineActivityTypeUpdateIds,
          }
        : {}),
      ...(resolvedTimelineActivityTypeDeleteIds !== undefined
        ? {
            expectedTimelineActivityTypeDeleteIds:
              resolvedTimelineActivityTypeDeleteIds,
          }
        : {}),
      ...(resolvedCommandMenuItemCreateIds !== undefined
        ? {
            expectedCommandMenuItemCreateIds: resolvedCommandMenuItemCreateIds,
          }
        : {}),
      ...(resolvedCommandMenuItemUpdateIds !== undefined
        ? {
            expectedCommandMenuItemUpdateIds: resolvedCommandMenuItemUpdateIds,
          }
        : {}),
      ...(resolvedCommandMenuItemDeleteIds !== undefined
        ? {
            expectedCommandMenuItemDeleteIds: resolvedCommandMenuItemDeleteIds,
          }
        : {}),
      ...(resolvedPageLayoutCreateIds !== undefined
        ? { expectedPageLayoutCreateIds: resolvedPageLayoutCreateIds }
        : {}),
      ...(resolvedPageLayoutUpdateIds !== undefined
        ? { expectedPageLayoutUpdateIds: resolvedPageLayoutUpdateIds }
        : {}),
      ...(resolvedPageLayoutDeleteIds !== undefined
        ? { expectedPageLayoutDeleteIds: resolvedPageLayoutDeleteIds }
        : {}),
      ...(resolvedPageLayoutTabCreateIds !== undefined
        ? { expectedPageLayoutTabCreateIds: resolvedPageLayoutTabCreateIds }
        : {}),
      ...(resolvedPageLayoutTabUpdateIds !== undefined
        ? { expectedPageLayoutTabUpdateIds: resolvedPageLayoutTabUpdateIds }
        : {}),
      ...(resolvedPageLayoutTabDeleteIds !== undefined
        ? { expectedPageLayoutTabDeleteIds: resolvedPageLayoutTabDeleteIds }
        : {}),
      ...(resolvedPageLayoutWidgetCreateIds !== undefined
        ? {
            expectedPageLayoutWidgetCreateIds:
              resolvedPageLayoutWidgetCreateIds,
          }
        : {}),
      ...(resolvedPageLayoutWidgetUpdateIds !== undefined
        ? {
            expectedPageLayoutWidgetUpdateIds:
              resolvedPageLayoutWidgetUpdateIds,
          }
        : {}),
      ...(resolvedPageLayoutWidgetDeleteIds !== undefined
        ? {
            expectedPageLayoutWidgetDeleteIds:
              resolvedPageLayoutWidgetDeleteIds,
          }
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

const readLogicFunctionSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(lf) AS row FROM core."logicFunction" lf WHERE lf."workspaceId"=$1 ORDER BY lf.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readWorkflowVersionSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(wv) AS row FROM core."workflowVersion" wv WHERE wv."workspaceId"=$1 ORDER BY wv.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readTimelineActivityTypeSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(tat) AS row FROM core."timelineActivityType" tat WHERE tat."workspaceId"=$1 ORDER BY tat.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readCommandMenuItemSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(cmi) AS row FROM core."commandMenuItem" cmi WHERE cmi."workspaceId"=$1 ORDER BY cmi.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readPageLayoutSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(pl) AS row FROM core."pageLayout" pl WHERE pl."workspaceId"=$1 ORDER BY pl.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readPageLayoutTabSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(plt) AS row FROM core."pageLayoutTab" plt WHERE plt."workspaceId"=$1 ORDER BY plt.id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readPageLayoutWidgetSnapshot = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = await runner.query(
    `SELECT to_jsonb(plw) AS row FROM core."pageLayoutWidget" plw WHERE plw."workspaceId"=$1 ORDER BY plw.id${lock ? ' FOR UPDATE' : ''}`,
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

const serializeLogicFunctionSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeTimelineActivityTypeSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializeCommandMenuItemSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializePageLayoutSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializePageLayoutTabSnapshot = (
  snapshot: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...snapshot.entries()].map(([id, row]) => [
      id,
      scalarNavigationMenuItemWithoutTimestamps(row),
    ]),
  );

const serializePageLayoutWidgetSnapshot = (
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
        to_regclass('core."pageLayoutTab"') IS NOT NULL AS "hasPageLayoutTabTable",
        to_regclass('core."pageLayoutWidget"') IS NOT NULL AS "hasPageLayoutWidgetTable",
        to_regclass('core."agentChatChannel"') IS NOT NULL AS "hasChannelTable",
        to_regclass('core."agentChatChannelRole"') IS NOT NULL AS "hasChannelRoleTable",
        to_regclass('core.role') IS NOT NULL AS "hasRoleTable",
        to_regclass('core.webhook') IS NOT NULL AS "hasWebhookTable",
        to_regclass('core.skill') IS NOT NULL AS "hasSkillTable",
        to_regclass('core."frontComponent"') IS NOT NULL AS "hasFrontComponentTable",
        to_regclass('core."settingsMenuItem"') IS NOT NULL AS "hasSettingsMenuItemTable",
        to_regclass('core."logicFunction"') IS NOT NULL AS "hasLogicFunctionTable",
        to_regclass('core."workflowVersion"') IS NOT NULL AS "hasWorkflowVersionTable",
        to_regclass('core."timelineActivityType"') IS NOT NULL AS "hasTimelineActivityTypeTable",
        to_regclass('core."commandMenuItem"') IS NOT NULL AS "hasCommandMenuItemTable"`,
    );
    if (
      request.mode !== 'webhook' &&
      request.mode !== 'skill' &&
      request.mode !== 'frontComponent' &&
      request.mode !== 'logicFunction' &&
      request.mode !== 'timelineActivityType' &&
      request.mode !== 'commandMenuItem' &&
      request.mode !== 'pageLayout' &&
      !(
        request.mode === 'cascade' &&
        (request.expectedUpdatedObjectIds !== undefined ||
          request.expectedCreatedFieldCount !== undefined ||
          request.expectedUpdatedFieldCount !== undefined)
      ) &&
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

    const requiresLogicFunctionTable =
      request.expectedLogicFunctionCreateIds !== undefined ||
      request.expectedLogicFunctionUpdateIds !== undefined ||
      request.expectedLogicFunctionDeleteIds !== undefined ||
      actions.some((action) => action.metadataName === 'logicFunction');
    if (requiresLogicFunctionTable && reg?.hasLogicFunctionTable !== true) {
      throw new Error(
        'Logic function audit table core.logicFunction unavailable',
      );
    }
    const touchesLogicFunctions =
      requiresLogicFunctionTable ||
      (request.mode === 'logicFunction' && reg?.hasLogicFunctionTable === true);

    const beforeLogicFunctions =
      touchesLogicFunctions && reg?.hasLogicFunctionTable === true
        ? await readLogicFunctionSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeLogicFunctions.values()) {
      assertLogicFunctionRowInvariants(row, request.workspaceId);
    }

    const isWorkflowCascadeMode =
      request.mode === 'logicFunction' &&
      (request.expectedParentWorkflowDeleteIds !== undefined ||
        request.expectedParentWorkflowVersionDeleteIds !== undefined);
    const beforeWorkflowVersionsForLogicFunctionCascade =
      isWorkflowCascadeMode && reg?.hasWorkflowVersionTable === true
        ? await readWorkflowVersionSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();

    const touchesTimelineActivityTypes =
      request.mode === 'timelineActivityType' ||
      request.expectedTimelineActivityTypeCreateIds !== undefined ||
      request.expectedTimelineActivityTypeUpdateIds !== undefined ||
      request.expectedTimelineActivityTypeDeleteIds !== undefined ||
      actions.some((action) => action.metadataName === 'timelineActivityType');
    if (
      touchesTimelineActivityTypes &&
      reg?.hasTimelineActivityTypeTable !== true
    ) {
      throw new Error(
        'Timeline activity type audit table core.timelineActivityType unavailable',
      );
    }

    const beforeTimelineActivityTypes =
      touchesTimelineActivityTypes && reg?.hasTimelineActivityTypeTable === true
        ? await readTimelineActivityTypeSnapshot(
            runner,
            request.workspaceId,
            true,
          )
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeTimelineActivityTypes.values()) {
      assertTimelineActivityTypeRowInvariants(row, request.workspaceId);
    }

    const requiresCommandMenuItemTable =
      request.mode === 'commandMenuItem' ||
      request.expectedCommandMenuItemCreateIds !== undefined ||
      request.expectedCommandMenuItemUpdateIds !== undefined ||
      request.expectedCommandMenuItemDeleteIds !== undefined ||
      actions.some((action) => action.metadataName === 'commandMenuItem');
    if (requiresCommandMenuItemTable && reg?.hasCommandMenuItemTable !== true) {
      throw new Error(
        'Command menu item audit table core.commandMenuItem unavailable',
      );
    }
    const touchesCommandMenuItems =
      requiresCommandMenuItemTable ||
      (reg?.hasCommandMenuItemTable === true &&
        (touchesFrontComponents ||
          isWorkflowCascadeMode ||
          request.expectedParentPageLayoutDeleteIds !== undefined ||
          request.expectedPageLayoutDeleteIds !== undefined ||
          request.expectedCreatedObjectId !== undefined ||
          request.expectedUpdatedObjectIds !== undefined ||
          actions.some(
            (action) =>
              action.metadataName === 'pageLayout' && action.type === 'delete',
          )));
    const beforeCommandMenuItems =
      touchesCommandMenuItems && reg?.hasCommandMenuItemTable === true
        ? await readCommandMenuItemSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforeCommandMenuItems.values()) {
      assertCommandMenuItemRowInvariants(row, request.workspaceId);
    }

    const requiresPageLayoutTable =
      request.expectedPageLayoutCreateIds !== undefined ||
      request.expectedPageLayoutUpdateIds !== undefined ||
      request.expectedPageLayoutDeleteIds !== undefined ||
      (request.mode === 'pageLayout' &&
        actions.some((action) => action.metadataName === 'pageLayout'));
    if (requiresPageLayoutTable && reg?.hasPageLayoutTable !== true) {
      throw new Error('Page layout audit table core.pageLayout unavailable');
    }
    const touchesPageLayouts =
      requiresPageLayoutTable ||
      (reg?.hasPageLayoutTable === true &&
        (request.mode === 'pageLayout' ||
          request.expectedParentPageLayoutDeleteIds !== undefined ||
          request.expectedCreatedObjectId !== undefined ||
          actions.some(
            (action) =>
              action.metadataName === 'pageLayout' ||
              (action.metadataName === 'pageLayoutTab' &&
                action.type === 'delete') ||
              (action.metadataName === 'objectMetadata' &&
                action.type === 'delete'),
          )));
    const beforePageLayouts =
      touchesPageLayouts && reg?.hasPageLayoutTable === true
        ? await readPageLayoutSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforePageLayouts.values()) {
      assertPageLayoutRowInvariants(row, request.workspaceId);
    }

    const requiresPageLayoutTabTable =
      request.mode === 'pageLayout' &&
      (request.expectedPageLayoutTabCreateIds !== undefined ||
        request.expectedPageLayoutTabUpdateIds !== undefined ||
        request.expectedPageLayoutTabDeleteIds !== undefined ||
        actions.some((action) => action.metadataName === 'pageLayoutTab'));
    if (requiresPageLayoutTabTable && reg?.hasPageLayoutTabTable !== true) {
      throw new Error(
        'Page layout tab audit table core.pageLayoutTab unavailable',
      );
    }
    const touchesPageLayoutTabs =
      requiresPageLayoutTabTable ||
      (reg?.hasPageLayoutTabTable === true &&
        (request.mode === 'pageLayout' ||
          touchesPageLayouts ||
          actions.some((action) => action.metadataName === 'pageLayoutTab')));
    const beforePageLayoutTabs =
      touchesPageLayoutTabs && reg?.hasPageLayoutTabTable === true
        ? await readPageLayoutTabSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforePageLayoutTabs.values()) {
      assertPageLayoutTabRowInvariants(row, request.workspaceId);
    }

    const requiresPageLayoutWidgetTable =
      request.mode === 'pageLayout' &&
      (request.expectedPageLayoutWidgetCreateIds !== undefined ||
        request.expectedPageLayoutWidgetUpdateIds !== undefined ||
        request.expectedPageLayoutWidgetDeleteIds !== undefined ||
        actions.some((action) => action.metadataName === 'pageLayoutWidget'));
    if (
      requiresPageLayoutWidgetTable &&
      reg?.hasPageLayoutWidgetTable !== true
    ) {
      throw new Error(
        'Page layout widget audit table core.pageLayoutWidget unavailable',
      );
    }
    const touchesPageLayoutWidgets =
      requiresPageLayoutWidgetTable ||
      (reg?.hasPageLayoutWidgetTable === true &&
        (request.mode === 'pageLayout' ||
          touchesPageLayoutTabs ||
          request.expectedCreatedFieldCount !== undefined ||
          request.expectedUpdatedFieldCount !== undefined ||
          actions.some(
            (action) => action.metadataName === 'pageLayoutWidget',
          )));
    const beforePageLayoutWidgets =
      touchesPageLayoutWidgets && reg?.hasPageLayoutWidgetTable === true
        ? await readPageLayoutWidgetSnapshot(runner, request.workspaceId, true)
        : new Map<string, Record<string, unknown>>();
    for (const row of beforePageLayoutWidgets.values()) {
      assertPageLayoutWidgetRowInvariants(row, request.workspaceId);
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

    const touchesNavItems =
      request.mode !== 'webhook' &&
      request.mode !== 'skill' &&
      request.mode !== 'frontComponent' &&
      request.mode !== 'logicFunction' &&
      request.mode !== 'timelineActivityType' &&
      request.mode !== 'commandMenuItem' &&
      (request.mode !== 'pageLayout' ||
        request.expectedParentPageLayoutDeleteIds !== undefined ||
        request.expectedPageLayoutDeleteIds !== undefined ||
        actions.some(
          (action) =>
            (action.metadataName === 'pageLayout' &&
              action.type === 'delete') ||
            action.metadataName === 'navigationMenuItem',
        )) &&
      reg?.hasNavTable === true;
    const beforeNavItems = touchesNavItems
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
    const plannedPageLayoutCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedPageLayoutUpdates = new Map<string, Record<string, unknown>>();
    const plannedPageLayoutDeletes = new Set<string>();
    const plannedPageLayoutTabCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedPageLayoutTabUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedPageLayoutTabDeletes = new Set<string>();
    const plannedPageLayoutWidgetCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedPageLayoutWidgetUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedPageLayoutWidgetDeletes = new Set<string>();
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
    const plannedLogicFunctionCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedLogicFunctionUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedLogicFunctionDeletes = new Set<string>();
    const plannedWorkflowDeletes = new Set<string>();
    const plannedWorkflowVersionDeletes = new Set<string>();
    const plannedTimelineActivityTypeCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedTimelineActivityTypeUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedTimelineActivityTypeDeletes = new Set<string>();
    const plannedCommandMenuItemCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedCommandMenuItemUpdates = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedCommandMenuItemDeletes = new Set<string>();
    const plannedObjectCreates = new Set<string>();
    const plannedObjectUpdates = new Set<string>();
    const plannedObjectDeletes = new Set<string>();
    const plannedFieldDeletes = new Set<string>();
    let plannedFieldCreateCount = 0;
    let plannedFieldUpdateCount = 0;

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
            (action.metadataName === 'settingsMenuItem' ||
              action.metadataName === 'commandMenuItem') &&
            action.type === 'delete'
          )
        ) {
          throw new Error(
            `Front component audit disallows ${action.metadataName} actions`,
          );
        }
      } else if (request.mode === 'logicFunction') {
        if (action.metadataName !== 'logicFunction') {
          const isAllowedWorkflowCascadeAction =
            isWorkflowCascadeMode &&
            action.type === 'delete' &&
            (action.metadataName === 'workflow' ||
              action.metadataName === 'workflowVersion' ||
              action.metadataName === 'commandMenuItem');
          if (!isAllowedWorkflowCascadeAction) {
            throw new Error(
              `Logic function audit disallows ${action.metadataName} actions`,
            );
          }
        }
      } else if (request.mode === 'timelineActivityType') {
        if (action.metadataName !== 'timelineActivityType') {
          throw new Error(
            `Timeline activity type audit disallows ${action.metadataName} actions`,
          );
        }
      } else if (request.mode === 'commandMenuItem') {
        if (action.metadataName !== 'commandMenuItem') {
          throw new Error(
            `Command menu item audit disallows ${action.metadataName} actions`,
          );
        }
      } else if (request.mode === 'pageLayout') {
        const isPageLayoutEntity =
          action.metadataName === 'pageLayout' ||
          action.metadataName === 'pageLayoutTab' ||
          action.metadataName === 'pageLayoutWidget' ||
          action.metadataName === 'viewFieldGroup' ||
          action.metadataName === 'viewField';
        const isAllowedCascadeDelete =
          action.type === 'delete' &&
          (action.metadataName === 'navigationMenuItem' ||
            action.metadataName === 'commandMenuItem');
        if (!isPageLayoutEntity && !isAllowedCascadeDelete) {
          throw new Error(
            `Page layout audit disallows ${action.metadataName} actions`,
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
      } else if (action.metadataName === 'pageLayout') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error('Page layout create action requires flatEntity');
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedPageLayoutCreatesByUniversalIdentifier.has(universalId)) {
            throw new Error(
              'Page layout create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error('Page layout create action application mismatch');
          }
          const explicitId =
            action.id !== undefined
              ? uuid(action.id)
              : action.flatEntity.id !== undefined
                ? uuid(action.flatEntity.id)
                : undefined;
          if (explicitId !== undefined && beforePageLayouts.has(explicitId)) {
            throw new Error('Page layout create target ID already exists');
          }
          plannedPageLayoutCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayouts?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Page layout update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutUpdates.has(targetId)) {
            throw new Error('Page layout update audit duplicate ID');
          }
          plannedPageLayoutUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayouts?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item cascade audit missing pageLayout mapping',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutDeletes.has(targetId)) {
            throw new Error('Page layout delete audit duplicate ID');
          }
          plannedPageLayoutDeletes.add(targetId);
        } else {
          throw new Error(`Unsupported pageLayout action type ${action.type}`);
        }
      } else if (action.metadataName === 'pageLayoutTab') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Page layout tab create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedPageLayoutTabCreatesByUniversalIdentifier.has(universalId)
          ) {
            throw new Error(
              'Page layout tab create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Page layout tab create action application mismatch',
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
            beforePageLayoutTabs.has(explicitId)
          ) {
            throw new Error('Page layout tab create target ID already exists');
          }
          plannedPageLayoutTabCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayoutTabs?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Page layout tab update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutTabUpdates.has(targetId)) {
            throw new Error('Page layout tab update audit duplicate ID');
          }
          plannedPageLayoutTabUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayoutTabs?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Page layout tab delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutTabDeletes.has(targetId)) {
            throw new Error('Page layout tab delete audit duplicate ID');
          }
          plannedPageLayoutTabDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported pageLayoutTab action type ${action.type}`,
          );
        }
      } else if (action.metadataName === 'pageLayoutWidget') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Page layout widget create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedPageLayoutWidgetCreatesByUniversalIdentifier.has(universalId)
          ) {
            throw new Error(
              'Page layout widget create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Page layout widget create action application mismatch',
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
            beforePageLayoutWidgets.has(explicitId)
          ) {
            throw new Error(
              'Page layout widget create target ID already exists',
            );
          }
          plannedPageLayoutWidgetCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayoutWidgets?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Page layout widget update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutWidgetUpdates.has(targetId)) {
            throw new Error('Page layout widget update audit duplicate ID');
          }
          plannedPageLayoutWidgetUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.pageLayoutWidgets?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Page layout widget delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedPageLayoutWidgetDeletes.has(targetId)) {
            throw new Error('Page layout widget delete audit duplicate ID');
          }
          plannedPageLayoutWidgetDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported pageLayoutWidget action type ${action.type}`,
          );
        }
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
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.objectMetadatas?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item cascade audit missing objectMetadata mapping',
            );
          }
          plannedObjectUpdates.add(uuid(mappedId));
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
      } else if (action.metadataName === 'fieldMetadata') {
        if (action.type === 'create') {
          plannedFieldCreateCount += 1;
        } else if (action.type === 'update') {
          plannedFieldUpdateCount += 1;
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.fieldMetadatas?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Navigation menu item cascade audit missing fieldMetadata mapping',
            );
          }
          plannedFieldDeletes.add(uuid(mappedId));
        }
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
      } else if (action.metadataName === 'logicFunction') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error('Logic function create action requires flatEntity');
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedLogicFunctionCreatesByUniversalIdentifier.has(universalId)
          ) {
            throw new Error(
              'Logic function create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Logic function create action application mismatch',
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
            beforeLogicFunctions.has(explicitId)
          ) {
            throw new Error('Logic function create target ID already exists');
          }
          plannedLogicFunctionCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.logicFunctions?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Logic function update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedLogicFunctionUpdates.has(targetId)) {
            throw new Error('Logic function update audit duplicate ID');
          }
          plannedLogicFunctionUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.logicFunctions?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Logic function delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedLogicFunctionDeletes.has(targetId)) {
            throw new Error('Logic function delete audit duplicate ID');
          }
          plannedLogicFunctionDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported logicFunction action type ${action.type}`,
          );
        }
      } else if (
        action.metadataName === 'workflow' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.workflows?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Logic function workflow cascade audit missing workflow mapping',
          );
        }
        plannedWorkflowDeletes.add(uuid(mappedId));
      } else if (
        action.metadataName === 'workflowVersion' &&
        action.type === 'delete'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.workflowVersions?.[universalId]?.id;
        if (!mappedId) {
          throw new Error(
            'Logic function workflowVersion cascade audit missing workflowVersion mapping',
          );
        }
        plannedWorkflowVersionDeletes.add(uuid(mappedId));
      } else if (action.metadataName === 'timelineActivityType') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Timeline activity type create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedTimelineActivityTypeCreatesByUniversalIdentifier.has(
              universalId,
            )
          ) {
            throw new Error(
              'Timeline activity type create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Timeline activity type create action application mismatch',
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
            beforeTimelineActivityTypes.has(explicitId)
          ) {
            throw new Error(
              'Timeline activity type create target ID already exists',
            );
          }
          plannedTimelineActivityTypeCreatesByUniversalIdentifier.set(
            universalId,
            {
              ...(explicitId !== undefined ? { id: explicitId } : {}),
              flatEntity: action.flatEntity,
            },
          );
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.timelineActivityTypes?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Timeline activity type update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedTimelineActivityTypeUpdates.has(targetId)) {
            throw new Error('Timeline activity type update audit duplicate ID');
          }
          plannedTimelineActivityTypeUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.timelineActivityTypes?.[universalId]?.id;
          if (!mappedId) {
            throw new Error(
              'Timeline activity type delete audit missing mapping',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedTimelineActivityTypeDeletes.has(targetId)) {
            throw new Error('Timeline activity type delete audit duplicate ID');
          }
          plannedTimelineActivityTypeDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported timelineActivityType action type ${action.type}`,
          );
        }
      } else if (action.metadataName === 'commandMenuItem') {
        if (action.type === 'create') {
          if (!action.flatEntity) {
            throw new Error(
              'Command menu item create action requires flatEntity',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (
            plannedCommandMenuItemCreatesByUniversalIdentifier.has(universalId)
          ) {
            throw new Error(
              'Command menu item create audit duplicate universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Command menu item create action application mismatch',
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
            beforeCommandMenuItems.has(explicitId)
          ) {
            throw new Error(
              'Command menu item create target ID already exists',
            );
          }
          plannedCommandMenuItemCreatesByUniversalIdentifier.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.commandMenuItems?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Command menu item update audit missing mapping or update payload',
            );
          }
          const targetId = uuid(mappedId);
          if (plannedCommandMenuItemUpdates.has(targetId)) {
            throw new Error('Command menu item update audit duplicate ID');
          }
          plannedCommandMenuItemUpdates.set(targetId, action.update);
        } else if (action.type === 'delete') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.commandMenuItems?.[universalId]?.id;
          if (!mappedId) {
            throw new Error('Command menu item delete audit missing mapping');
          }
          const targetId = uuid(mappedId);
          if (plannedCommandMenuItemDeletes.has(targetId)) {
            throw new Error('Command menu item delete audit duplicate ID');
          }
          plannedCommandMenuItemDeletes.add(targetId);
        } else {
          throw new Error(
            `Unsupported commandMenuItem action type ${action.type}`,
          );
        }
      }
    }

    if (request.mode === 'cascade') {
      const hasCascadeConstraint =
        request.expectedCreatedIds !== undefined ||
        request.expectedDeletedIds !== undefined ||
        request.expectedParentViewDeleteIds !== undefined ||
        request.expectedParentPageLayoutDeleteIds !== undefined ||
        request.expectedParentChannelDeleteIds !== undefined ||
        request.expectedCreatedObjectId !== undefined ||
        request.expectedUpdatedObjectIds !== undefined ||
        request.expectedCreatedFieldCount !== undefined ||
        request.expectedUpdatedFieldCount !== undefined;
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
    } else if (request.mode === 'logicFunction') {
      const hasLogicFunctionConstraint =
        request.expectedLogicFunctionCreateIds !== undefined ||
        request.expectedLogicFunctionUpdateIds !== undefined ||
        request.expectedLogicFunctionDeleteIds !== undefined ||
        request.expectedParentWorkflowDeleteIds !== undefined ||
        request.expectedParentWorkflowVersionDeleteIds !== undefined;
      if (!hasLogicFunctionConstraint) {
        throw new Error(
          'Logic function audit requires explicit expected scope',
        );
      }
    } else if (request.mode === 'timelineActivityType') {
      const hasTimelineActivityTypeConstraint =
        request.expectedTimelineActivityTypeCreateIds !== undefined ||
        request.expectedTimelineActivityTypeUpdateIds !== undefined ||
        request.expectedTimelineActivityTypeDeleteIds !== undefined;
      if (!hasTimelineActivityTypeConstraint) {
        throw new Error(
          'Timeline activity type audit requires explicit expected scope',
        );
      }
    } else if (request.mode === 'commandMenuItem') {
      const hasCommandMenuItemConstraint =
        request.expectedCommandMenuItemCreateIds !== undefined ||
        request.expectedCommandMenuItemUpdateIds !== undefined ||
        request.expectedCommandMenuItemDeleteIds !== undefined;
      if (!hasCommandMenuItemConstraint) {
        throw new Error(
          'Command menu item audit requires explicit expected scope',
        );
      }
    } else if (request.mode === 'pageLayout') {
      const hasPageLayoutConstraint =
        request.expectedPageLayoutCreateIds !== undefined ||
        request.expectedPageLayoutUpdateIds !== undefined ||
        request.expectedPageLayoutDeleteIds !== undefined ||
        request.expectedParentPageLayoutDeleteIds !== undefined ||
        request.expectedPageLayoutTabCreateIds !== undefined ||
        request.expectedPageLayoutTabUpdateIds !== undefined ||
        request.expectedPageLayoutTabDeleteIds !== undefined ||
        request.expectedPageLayoutWidgetCreateIds !== undefined ||
        request.expectedPageLayoutWidgetUpdateIds !== undefined ||
        request.expectedPageLayoutWidgetDeleteIds !== undefined;
      if (!hasPageLayoutConstraint) {
        throw new Error('Page layout audit requires explicit expected scope');
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

    if (request.expectedLogicFunctionCreateIds !== undefined) {
      const actualLogicFunctionCreateIds = [
        ...plannedLogicFunctionCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedLogicFunctionCreatesByUniversalIdentifier.size !==
          request.expectedLogicFunctionCreateIds.length ||
        actualLogicFunctionCreateIds.length !==
          request.expectedLogicFunctionCreateIds.length ||
        request.expectedLogicFunctionCreateIds.some(
          (id) => !actualLogicFunctionCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Logic function create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'logicFunction' &&
      plannedLogicFunctionCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Logic function audit detected unexpected logicFunction create',
      );
    }

    if (request.expectedLogicFunctionUpdateIds !== undefined) {
      if (
        plannedLogicFunctionUpdates.size !==
          request.expectedLogicFunctionUpdateIds.length ||
        request.expectedLogicFunctionUpdateIds.some(
          (id) => !plannedLogicFunctionUpdates.has(id),
        )
      ) {
        throw new Error(
          'Logic function update plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'logicFunction' &&
      plannedLogicFunctionUpdates.size > 0
    ) {
      throw new Error(
        'Logic function audit detected unexpected logicFunction update',
      );
    }

    if (request.expectedParentWorkflowDeleteIds !== undefined) {
      if (
        plannedWorkflowDeletes.size !==
          request.expectedParentWorkflowDeleteIds.length ||
        request.expectedParentWorkflowDeleteIds.some(
          (id) => !plannedWorkflowDeletes.has(id),
        )
      ) {
        throw new Error(
          'Logic function cascade workflow delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'logicFunction' &&
      plannedWorkflowDeletes.size > 0
    ) {
      throw new Error(
        'Logic function audit detected unexpected workflow delete',
      );
    }

    if (request.expectedParentWorkflowVersionDeleteIds !== undefined) {
      if (
        plannedWorkflowVersionDeletes.size !==
          request.expectedParentWorkflowVersionDeleteIds.length ||
        request.expectedParentWorkflowVersionDeleteIds.some(
          (id) => !plannedWorkflowVersionDeletes.has(id),
        )
      ) {
        throw new Error(
          'Logic function cascade workflowVersion delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'logicFunction' &&
      request.expectedParentWorkflowDeleteIds === undefined &&
      plannedWorkflowVersionDeletes.size > 0
    ) {
      throw new Error(
        'Logic function audit detected unexpected workflowVersion delete',
      );
    }

    if (request.expectedLogicFunctionDeleteIds !== undefined) {
      if (
        plannedLogicFunctionDeletes.size !==
          request.expectedLogicFunctionDeleteIds.length ||
        request.expectedLogicFunctionDeleteIds.some(
          (id) => !plannedLogicFunctionDeletes.has(id),
        )
      ) {
        throw new Error(
          'Logic function delete plan does not match expected IDs',
        );
      }
    } else if (isWorkflowCascadeMode) {
      const expectedCascadeLogicFunctionIds =
        computeCascadeDeletedCodeStepLogicFunctionIds({
          beforeWorkflowVersions: beforeWorkflowVersionsForLogicFunctionCascade,
          deletedWorkflowIds: plannedWorkflowDeletes,
          deletedWorkflowVersionIds: plannedWorkflowVersionDeletes,
          beforeLogicFunctions,
        });
      if (
        plannedLogicFunctionDeletes.size !==
          expectedCascadeLogicFunctionIds.size ||
        [...plannedLogicFunctionDeletes].some(
          (id) => !expectedCascadeLogicFunctionIds.has(id),
        )
      ) {
        throw new Error(
          'Logic function cascade delete plan does not match exclusively owned CODE step functions',
        );
      }
    } else if (
      request.mode === 'logicFunction' &&
      plannedLogicFunctionDeletes.size > 0
    ) {
      throw new Error(
        'Logic function audit detected unexpected logicFunction delete',
      );
    }

    const foreignLogicFunctionAppIds = new Set<string>();
    for (const targetId of plannedLogicFunctionUpdates.keys()) {
      const beforeLf = beforeLogicFunctions.get(targetId);
      if (!beforeLf) {
        throw new Error('Logic function update target row unavailable');
      }
      const lfAppId = uuid(beforeLf.applicationId);
      if (lfAppId !== applicationId) {
        if (request.mode !== 'logicFunction') {
          throw new Error(
            'Logic function update target row belongs to another application',
          );
        }
        foreignLogicFunctionAppIds.add(lfAppId);
      }
    }
    for (const targetId of plannedLogicFunctionDeletes) {
      const beforeLf = beforeLogicFunctions.get(targetId);
      if (!beforeLf) {
        throw new Error('Logic function delete target row unavailable');
      }
      const lfAppId = uuid(beforeLf.applicationId);
      if (lfAppId !== applicationId) {
        if (request.mode !== 'logicFunction') {
          throw new Error(
            'Logic function delete target row belongs to another application',
          );
        }
        foreignLogicFunctionAppIds.add(lfAppId);
      }
    }
    if (foreignLogicFunctionAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignLogicFunctionAppIds]],
      );
      if (activeApps.length !== foreignLogicFunctionAppIds.size) {
        throw new Error(
          'Logic function target row belongs to an unavailable application',
        );
      }
    }

    if (request.expectedTimelineActivityTypeCreateIds !== undefined) {
      const actualTimelineActivityTypeCreateIds = [
        ...plannedTimelineActivityTypeCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedTimelineActivityTypeCreatesByUniversalIdentifier.size !==
          request.expectedTimelineActivityTypeCreateIds.length ||
        actualTimelineActivityTypeCreateIds.length !==
          request.expectedTimelineActivityTypeCreateIds.length ||
        request.expectedTimelineActivityTypeCreateIds.some(
          (id) => !actualTimelineActivityTypeCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Timeline activity type create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'timelineActivityType' &&
      plannedTimelineActivityTypeCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Timeline activity type audit detected unexpected timelineActivityType create',
      );
    }

    if (request.expectedTimelineActivityTypeUpdateIds !== undefined) {
      if (
        plannedTimelineActivityTypeUpdates.size !==
          request.expectedTimelineActivityTypeUpdateIds.length ||
        request.expectedTimelineActivityTypeUpdateIds.some(
          (id) => !plannedTimelineActivityTypeUpdates.has(id),
        )
      ) {
        throw new Error(
          'Timeline activity type update plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'timelineActivityType' &&
      plannedTimelineActivityTypeUpdates.size > 0
    ) {
      throw new Error(
        'Timeline activity type audit detected unexpected timelineActivityType update',
      );
    }

    if (request.expectedTimelineActivityTypeDeleteIds !== undefined) {
      if (
        plannedTimelineActivityTypeDeletes.size !==
          request.expectedTimelineActivityTypeDeleteIds.length ||
        request.expectedTimelineActivityTypeDeleteIds.some(
          (id) => !plannedTimelineActivityTypeDeletes.has(id),
        )
      ) {
        throw new Error(
          'Timeline activity type delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'timelineActivityType' &&
      plannedTimelineActivityTypeDeletes.size > 0
    ) {
      throw new Error(
        'Timeline activity type audit detected unexpected timelineActivityType delete',
      );
    }

    const foreignTimelineActivityTypeAppIds = new Set<string>();
    for (const targetId of plannedTimelineActivityTypeUpdates.keys()) {
      const beforeTat = beforeTimelineActivityTypes.get(targetId);
      if (!beforeTat) {
        throw new Error('Timeline activity type update target row unavailable');
      }
      const tatAppId = uuid(beforeTat.applicationId);
      if (tatAppId !== applicationId) {
        if (request.mode !== 'timelineActivityType') {
          throw new Error(
            'Timeline activity type update target row belongs to another application',
          );
        }
        foreignTimelineActivityTypeAppIds.add(tatAppId);
      }
    }
    for (const targetId of plannedTimelineActivityTypeDeletes) {
      const beforeTat = beforeTimelineActivityTypes.get(targetId);
      if (!beforeTat) {
        throw new Error('Timeline activity type delete target row unavailable');
      }
      const tatAppId = uuid(beforeTat.applicationId);
      if (tatAppId !== applicationId) {
        if (request.mode !== 'timelineActivityType') {
          throw new Error(
            'Timeline activity type delete target row belongs to another application',
          );
        }
        foreignTimelineActivityTypeAppIds.add(tatAppId);
      }
    }
    if (foreignTimelineActivityTypeAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignTimelineActivityTypeAppIds]],
      );
      if (activeApps.length !== foreignTimelineActivityTypeAppIds.size) {
        throw new Error(
          'Timeline activity type target row belongs to an unavailable application',
        );
      }
    }

    if (request.expectedUpdatedObjectIds !== undefined) {
      if (
        plannedObjectUpdates.size !== request.expectedUpdatedObjectIds.length ||
        request.expectedUpdatedObjectIds.some(
          (id) => !plannedObjectUpdates.has(id),
        )
      ) {
        throw new Error(
          'Navigation menu item cascade object update plan does not match expected object IDs',
        );
      }
    } else if (request.mode === 'cascade' && plannedObjectUpdates.size > 0) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected objectMetadata update',
      );
    }

    if (request.expectedCommandMenuItemCreateIds !== undefined) {
      const actualCommandMenuItemCreateIds = [
        ...plannedCommandMenuItemCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedCommandMenuItemCreatesByUniversalIdentifier.size !==
          request.expectedCommandMenuItemCreateIds.length ||
        actualCommandMenuItemCreateIds.length !==
          request.expectedCommandMenuItemCreateIds.length ||
        request.expectedCommandMenuItemCreateIds.some(
          (id) => !actualCommandMenuItemCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Command menu item create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'commandMenuItem' &&
      plannedCommandMenuItemCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Command menu item audit detected unexpected commandMenuItem create',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedCommandMenuItemCreatesByUniversalIdentifier.size > 0
    ) {
      if (
        request.expectedCreatedObjectId === undefined ||
        plannedCommandMenuItemCreatesByUniversalIdentifier.size > 1 ||
        [...plannedCommandMenuItemCreatesByUniversalIdentifier.values()].some(
          (entry) => entry.flatEntity.isSystemSideEffect !== true,
        )
      ) {
        throw new Error(
          'Navigation menu item cascade audit detected unexpected commandMenuItem create',
        );
      }
    }

    if (request.expectedCommandMenuItemUpdateIds !== undefined) {
      if (
        plannedCommandMenuItemUpdates.size !==
          request.expectedCommandMenuItemUpdateIds.length ||
        request.expectedCommandMenuItemUpdateIds.some(
          (id) => !plannedCommandMenuItemUpdates.has(id),
        )
      ) {
        throw new Error(
          'Command menu item update plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'commandMenuItem' &&
      plannedCommandMenuItemUpdates.size > 0
    ) {
      throw new Error(
        'Command menu item audit detected unexpected commandMenuItem update',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedCommandMenuItemUpdates.size > 0
    ) {
      const allowedObjectIds = new Set(request.expectedUpdatedObjectIds ?? []);
      for (const targetId of plannedCommandMenuItemUpdates.keys()) {
        const beforeCmi = beforeCommandMenuItems.get(targetId);
        const navObjId = beforeCmi
          ? nullableUuid(beforeCmi.navigationTargetObjectMetadataId)
          : null;
        if (
          !beforeCmi ||
          beforeCmi.isSystemSideEffect !== true ||
          navObjId === null ||
          !allowedObjectIds.has(navObjId)
        ) {
          throw new Error(
            'Navigation menu item cascade audit detected unexpected commandMenuItem update',
          );
        }
      }
    }

    if (request.expectedCommandMenuItemDeleteIds !== undefined) {
      if (
        plannedCommandMenuItemDeletes.size !==
          request.expectedCommandMenuItemDeleteIds.length ||
        request.expectedCommandMenuItemDeleteIds.some(
          (id) => !plannedCommandMenuItemDeletes.has(id),
        )
      ) {
        throw new Error(
          'Command menu item delete plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'commandMenuItem' &&
      plannedCommandMenuItemDeletes.size > 0
    ) {
      throw new Error(
        'Command menu item audit detected unexpected commandMenuItem delete',
      );
    } else if (
      request.mode === 'frontComponent' &&
      plannedCommandMenuItemDeletes.size > 0
    ) {
      for (const cmiId of plannedCommandMenuItemDeletes) {
        const beforeCmi = beforeCommandMenuItems.get(cmiId);
        const fcId = beforeCmi
          ? nullableUuid(beforeCmi.frontComponentId)
          : null;
        if (
          !beforeCmi ||
          fcId === null ||
          !plannedFrontComponentDeletes.has(fcId)
        ) {
          throw new Error(
            'Front component audit cannot delete unrelated commandMenuItem',
          );
        }
      }
    } else if (
      isWorkflowCascadeMode &&
      plannedCommandMenuItemDeletes.size > 0
    ) {
      const deletedCoreVersionIds = new Set<string>(
        plannedWorkflowVersionDeletes,
      );
      const deletedWorkspaceVersionIds = new Set<string>();
      for (const [
        versionId,
        versionRow,
      ] of beforeWorkflowVersionsForLogicFunctionCascade.entries()) {
        const coreWfId = nullableUuid(versionRow.coreWorkflowId);
        if (
          deletedCoreVersionIds.has(versionId) ||
          (coreWfId !== null && plannedWorkflowDeletes.has(coreWfId))
        ) {
          deletedCoreVersionIds.add(versionId);
          const wsVerId = nullableUuid(versionRow.workspaceWorkflowVersionId);
          if (wsVerId !== null) {
            deletedWorkspaceVersionIds.add(wsVerId);
          }
        }
      }
      for (const cmiId of plannedCommandMenuItemDeletes) {
        const beforeCmi = beforeCommandMenuItems.get(cmiId);
        const coreVerId = beforeCmi
          ? nullableUuid(beforeCmi.coreWorkflowVersionId)
          : null;
        const wsVerId = beforeCmi
          ? nullableUuid(beforeCmi.workflowVersionId)
          : null;
        if (
          !beforeCmi ||
          ((coreVerId === null || !deletedCoreVersionIds.has(coreVerId)) &&
            (wsVerId === null || !deletedWorkspaceVersionIds.has(wsVerId)))
        ) {
          throw new Error(
            'Logic function workflow cascade audit cannot delete unrelated commandMenuItem',
          );
        }
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'pageLayout') &&
      plannedCommandMenuItemDeletes.size > 0
    ) {
      for (const cmiId of plannedCommandMenuItemDeletes) {
        const beforeCmi = beforeCommandMenuItems.get(cmiId);
        const plId = beforeCmi ? nullableUuid(beforeCmi.pageLayoutId) : null;
        if (
          !beforeCmi ||
          plId === null ||
          !plannedPageLayoutDeletes.has(plId)
        ) {
          throw new Error(
            'Navigation menu item cascade audit cannot delete unrelated commandMenuItem',
          );
        }
      }
    }

    const foreignCommandMenuItemAppIds = new Set<string>();
    for (const targetId of plannedCommandMenuItemUpdates.keys()) {
      const beforeCmi = beforeCommandMenuItems.get(targetId);
      if (!beforeCmi) {
        throw new Error('Command menu item update target row unavailable');
      }
      const cmiAppId = uuid(beforeCmi.applicationId);
      if (cmiAppId !== applicationId) {
        if (request.mode !== 'commandMenuItem' && request.mode !== 'cascade') {
          throw new Error(
            'Command menu item update target row belongs to another application',
          );
        }
        foreignCommandMenuItemAppIds.add(cmiAppId);
      }
    }
    for (const targetId of plannedCommandMenuItemDeletes) {
      const beforeCmi = beforeCommandMenuItems.get(targetId);
      if (!beforeCmi) {
        throw new Error('Command menu item delete target row unavailable');
      }
      const cmiAppId = uuid(beforeCmi.applicationId);
      if (cmiAppId !== applicationId) {
        if (
          request.mode !== 'commandMenuItem' &&
          request.mode !== 'frontComponent' &&
          request.mode !== 'cascade' &&
          request.mode !== 'pageLayout' &&
          !isWorkflowCascadeMode
        ) {
          throw new Error(
            'Command menu item delete target row belongs to another application',
          );
        }
        foreignCommandMenuItemAppIds.add(cmiAppId);
      }
    }
    if (foreignCommandMenuItemAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignCommandMenuItemAppIds]],
      );
      if (activeApps.length !== foreignCommandMenuItemAppIds.size) {
        throw new Error(
          'Command menu item target row belongs to an unavailable application',
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

    if (request.expectedCreatedFieldCount !== undefined) {
      if (
        plannedFieldCreateCount === 0 ||
        plannedFieldCreateCount > request.expectedCreatedFieldCount
      ) {
        throw new Error(
          'Navigation menu item cascade field create plan does not match expected count',
        );
      }
    } else if (
      request.mode === 'cascade' &&
      plannedFieldCreateCount > 0 &&
      request.expectedCreatedObjectId === undefined &&
      request.expectedUpdatedFieldCount === undefined
    ) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected fieldMetadata create',
      );
    }

    if (request.expectedUpdatedFieldCount !== undefined) {
      if (
        plannedFieldUpdateCount === 0 ||
        plannedFieldUpdateCount > request.expectedUpdatedFieldCount
      ) {
        throw new Error(
          'Navigation menu item cascade field update plan does not match expected count',
        );
      }
    } else if (
      request.mode === 'cascade' &&
      plannedFieldUpdateCount > 0 &&
      request.expectedUpdatedObjectIds === undefined &&
      request.expectedParentViewDeleteIds === undefined
    ) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected fieldMetadata update',
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

    if (request.expectedPageLayoutCreateIds !== undefined) {
      const actualPageLayoutCreateIds = [
        ...plannedPageLayoutCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedPageLayoutCreatesByUniversalIdentifier.size !==
          request.expectedPageLayoutCreateIds.length ||
        actualPageLayoutCreateIds.length !==
          request.expectedPageLayoutCreateIds.length ||
        request.expectedPageLayoutCreateIds.some(
          (id) => !actualPageLayoutCreateIds.includes(id),
        )
      ) {
        throw new Error('Page layout create plan does not match expected IDs');
      }
    } else if (
      request.mode === 'pageLayout' &&
      plannedPageLayoutCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Page layout audit detected unexpected pageLayout create',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedPageLayoutCreatesByUniversalIdentifier.size > 0 &&
      request.expectedCreatedObjectId !== undefined
    ) {
      if (
        [...plannedPageLayoutCreatesByUniversalIdentifier.values()].some(
          (entry) => entry.flatEntity.isSystemSideEffect !== true,
        )
      ) {
        throw new Error(
          'Navigation menu item cascade audit detected unexpected pageLayout create',
        );
      }
    }

    if (request.expectedPageLayoutUpdateIds !== undefined) {
      if (
        plannedPageLayoutUpdates.size !==
          request.expectedPageLayoutUpdateIds.length ||
        request.expectedPageLayoutUpdateIds.some(
          (id) => !plannedPageLayoutUpdates.has(id),
        )
      ) {
        throw new Error('Page layout update plan does not match expected IDs');
      }
    } else if (
      (request.mode === 'pageLayout' || request.mode === 'cascade') &&
      plannedPageLayoutUpdates.size > 0
    ) {
      throw new Error(
        'Page layout audit detected unexpected pageLayout update',
      );
    }

    const expectedLayoutDeleteIds =
      request.expectedPageLayoutDeleteIds ??
      request.expectedParentPageLayoutDeleteIds;
    if (expectedLayoutDeleteIds !== undefined) {
      if (
        plannedPageLayoutDeletes.size !== expectedLayoutDeleteIds.length ||
        expectedLayoutDeleteIds.some((id) => !plannedPageLayoutDeletes.has(id))
      ) {
        throw new Error(
          'Navigation menu item cascade pageLayout delete plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'cascade' || request.mode === 'pageLayout') &&
      plannedPageLayoutDeletes.size > 0
    ) {
      throw new Error(
        'Navigation menu item cascade audit detected unexpected pageLayout delete',
      );
    }

    if (request.expectedPageLayoutTabCreateIds !== undefined) {
      const actualPageLayoutTabCreateIds = [
        ...plannedPageLayoutTabCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedPageLayoutTabCreatesByUniversalIdentifier.size !==
          request.expectedPageLayoutTabCreateIds.length ||
        actualPageLayoutTabCreateIds.length !==
          request.expectedPageLayoutTabCreateIds.length ||
        request.expectedPageLayoutTabCreateIds.some(
          (id) => !actualPageLayoutTabCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Page layout tab create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'pageLayout' &&
      plannedPageLayoutTabCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Page layout tab audit detected unexpected pageLayoutTab create',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedPageLayoutTabCreatesByUniversalIdentifier.size > 0 &&
      request.expectedCreatedObjectId !== undefined
    ) {
      if (
        [...plannedPageLayoutTabCreatesByUniversalIdentifier.values()].some(
          (entry) => entry.flatEntity.isSystemSideEffect !== true,
        )
      ) {
        throw new Error(
          'Navigation menu item cascade audit detected unexpected pageLayoutTab create',
        );
      }
    }

    if (request.expectedPageLayoutTabUpdateIds !== undefined) {
      if (
        plannedPageLayoutTabUpdates.size !==
          request.expectedPageLayoutTabUpdateIds.length ||
        request.expectedPageLayoutTabUpdateIds.some(
          (id) => !plannedPageLayoutTabUpdates.has(id),
        )
      ) {
        throw new Error(
          'Page layout tab update plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'pageLayout' || request.mode === 'cascade') &&
      plannedPageLayoutTabUpdates.size > 0
    ) {
      throw new Error(
        'Page layout tab audit detected unexpected pageLayoutTab update',
      );
    }

    if (request.expectedPageLayoutTabDeleteIds !== undefined) {
      if (
        plannedPageLayoutTabDeletes.size !==
          request.expectedPageLayoutTabDeleteIds.length ||
        request.expectedPageLayoutTabDeleteIds.some(
          (id) => !plannedPageLayoutTabDeletes.has(id),
        )
      ) {
        throw new Error(
          'Page layout tab delete plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'pageLayout' || request.mode === 'cascade') &&
      plannedPageLayoutTabDeletes.size > 0
    ) {
      for (const tabId of plannedPageLayoutTabDeletes) {
        const beforeTab = beforePageLayoutTabs.get(tabId);
        const plId = beforeTab ? nullableUuid(beforeTab.pageLayoutId) : null;
        if (
          !beforeTab ||
          plId === null ||
          !plannedPageLayoutDeletes.has(plId)
        ) {
          throw new Error(
            'Page layout tab audit detected unexpected pageLayoutTab delete',
          );
        }
      }
    }

    if (request.expectedPageLayoutWidgetCreateIds !== undefined) {
      const actualPageLayoutWidgetCreateIds = [
        ...plannedPageLayoutWidgetCreatesByUniversalIdentifier.values(),
      ]
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      if (
        plannedPageLayoutWidgetCreatesByUniversalIdentifier.size !==
          request.expectedPageLayoutWidgetCreateIds.length ||
        actualPageLayoutWidgetCreateIds.length !==
          request.expectedPageLayoutWidgetCreateIds.length ||
        request.expectedPageLayoutWidgetCreateIds.some(
          (id) => !actualPageLayoutWidgetCreateIds.includes(id),
        )
      ) {
        throw new Error(
          'Page layout widget create plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'pageLayout' &&
      plannedPageLayoutWidgetCreatesByUniversalIdentifier.size > 0
    ) {
      throw new Error(
        'Page layout widget audit detected unexpected pageLayoutWidget create',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedPageLayoutWidgetCreatesByUniversalIdentifier.size > 0 &&
      (request.expectedCreatedObjectId !== undefined ||
        request.expectedCreatedFieldCount !== undefined ||
        request.expectedUpdatedFieldCount !== undefined)
    ) {
      if (
        [...plannedPageLayoutWidgetCreatesByUniversalIdentifier.values()].some(
          (entry) => entry.flatEntity.isSystemSideEffect !== true,
        )
      ) {
        throw new Error(
          'Navigation menu item cascade audit detected unexpected pageLayoutWidget create',
        );
      }
    }

    if (request.expectedPageLayoutWidgetUpdateIds !== undefined) {
      if (
        plannedPageLayoutWidgetUpdates.size !==
          request.expectedPageLayoutWidgetUpdateIds.length ||
        request.expectedPageLayoutWidgetUpdateIds.some(
          (id) => !plannedPageLayoutWidgetUpdates.has(id),
        )
      ) {
        throw new Error(
          'Page layout widget update plan does not match expected IDs',
        );
      }
    } else if (
      request.mode === 'pageLayout' &&
      plannedPageLayoutWidgetUpdates.size > 0
    ) {
      throw new Error(
        'Page layout widget audit detected unexpected pageLayoutWidget update',
      );
    } else if (
      request.mode === 'cascade' &&
      plannedPageLayoutWidgetUpdates.size > 0
    ) {
      for (const targetId of plannedPageLayoutWidgetUpdates.keys()) {
        const beforePlw = beforePageLayoutWidgets.get(targetId);
        if (!beforePlw || beforePlw.isSystemSideEffect !== true) {
          throw new Error(
            'Navigation menu item cascade audit detected unexpected pageLayoutWidget update',
          );
        }
      }
    }

    if (request.expectedPageLayoutWidgetDeleteIds !== undefined) {
      if (
        plannedPageLayoutWidgetDeletes.size !==
          request.expectedPageLayoutWidgetDeleteIds.length ||
        request.expectedPageLayoutWidgetDeleteIds.some(
          (id) => !plannedPageLayoutWidgetDeletes.has(id),
        )
      ) {
        throw new Error(
          'Page layout widget delete plan does not match expected IDs',
        );
      }
    } else if (
      (request.mode === 'pageLayout' || request.mode === 'cascade') &&
      plannedPageLayoutWidgetDeletes.size > 0
    ) {
      for (const widgetId of plannedPageLayoutWidgetDeletes) {
        const beforeWidget = beforePageLayoutWidgets.get(widgetId);
        const tabId = beforeWidget
          ? nullableUuid(beforeWidget.pageLayoutTabId)
          : null;
        const parentTab = tabId ? beforePageLayoutTabs.get(tabId) : undefined;
        const plId = parentTab ? nullableUuid(parentTab.pageLayoutId) : null;
        if (
          !beforeWidget ||
          tabId === null ||
          (!plannedPageLayoutTabDeletes.has(tabId) &&
            (plId === null || !plannedPageLayoutDeletes.has(plId)))
        ) {
          throw new Error(
            'Page layout widget audit detected unexpected pageLayoutWidget delete',
          );
        }
      }
    }

    const foreignPageLayoutAppIds = new Set<string>();
    const verifyPageLayoutEntityOwner = (
      targetId: string,
      beforeMap: Map<string, Record<string, unknown>>,
      errorMsg: string,
    ) => {
      const beforeRow = beforeMap.get(targetId);
      if (!beforeRow) {
        throw new Error(errorMsg);
      }
      const rowAppId = uuid(beforeRow.applicationId);
      if (rowAppId !== applicationId) {
        if (request.mode !== 'pageLayout' && request.mode !== 'cascade') {
          throw new Error(errorMsg);
        }
        foreignPageLayoutAppIds.add(rowAppId);
      }
    };
    for (const targetId of plannedPageLayoutUpdates.keys()) {
      verifyPageLayoutEntityOwner(
        targetId,
        beforePageLayouts,
        'Page layout update target row unavailable',
      );
    }
    for (const targetId of plannedPageLayoutDeletes) {
      verifyPageLayoutEntityOwner(
        targetId,
        beforePageLayouts,
        'Page layout delete target row unavailable',
      );
    }
    if (reg?.hasPageLayoutTabTable === true || request.mode === 'pageLayout') {
      for (const targetId of plannedPageLayoutTabUpdates.keys()) {
        verifyPageLayoutEntityOwner(
          targetId,
          beforePageLayoutTabs,
          'Page layout tab update target row unavailable',
        );
      }
      for (const targetId of plannedPageLayoutTabDeletes) {
        verifyPageLayoutEntityOwner(
          targetId,
          beforePageLayoutTabs,
          'Page layout tab delete target row unavailable',
        );
      }
    }
    if (
      reg?.hasPageLayoutWidgetTable === true ||
      request.mode === 'pageLayout'
    ) {
      for (const targetId of plannedPageLayoutWidgetUpdates.keys()) {
        verifyPageLayoutEntityOwner(
          targetId,
          beforePageLayoutWidgets,
          'Page layout widget update target row unavailable',
        );
      }
      for (const targetId of plannedPageLayoutWidgetDeletes) {
        verifyPageLayoutEntityOwner(
          targetId,
          beforePageLayoutWidgets,
          'Page layout widget delete target row unavailable',
        );
      }
    }
    if (foreignPageLayoutAppIds.size > 0) {
      const activeApps = await runner.query(
        `SELECT id FROM core.application a WHERE a."workspaceId"=$1 AND a.id=ANY($2::uuid[]) AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY a.id FOR NO KEY UPDATE`,
        [request.workspaceId, [...foreignPageLayoutAppIds]],
      );
      if (activeApps.length !== foreignPageLayoutAppIds.size) {
        throw new Error(
          'Page layout target row belongs to an unavailable application',
        );
      }
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
      (request.mode === 'cascade' ||
        request.mode === 'channel' ||
        request.mode === 'pageLayout') &&
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
    } else if (request.mode === 'pageLayout' && plannedNavDeletes.size > 0) {
      for (const navId of plannedNavDeletes) {
        const beforeNav = beforeNavItems.get(navId);
        const plId = beforeNav ? nullableUuid(beforeNav.pageLayoutId) : null;
        if (
          !beforeNav ||
          plId === null ||
          !plannedPageLayoutDeletes.has(plId)
        ) {
          throw new Error(
            'Page layout audit cannot delete unrelated navigationMenuItem',
          );
        }
      }
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

    const afterNavItems = touchesNavItems
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

    let expectedLogicFunctionsSerialized: string | undefined;
    if (touchesLogicFunctions && reg?.hasLogicFunctionTable === true) {
      const afterLogicFunctions = await readLogicFunctionSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdLogicFunctionsByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterLogicFunctions.entries()) {
        assertLogicFunctionRowInvariants(afterRow, request.workspaceId);
        if (!beforeLogicFunctions.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdLogicFunctionsByUniversalId.has(universalId)) {
            throw new Error(
              'Logic function audit detected duplicate created universalIdentifier',
            );
          }
          createdLogicFunctionsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdLogicFunctionsByUniversalId.size !==
        plannedLogicFunctionCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Logic function audit created row count mismatch');
      }
      for (const [
        universalId,
        planned,
      ] of plannedLogicFunctionCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdLogicFunctionsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error('Logic function create did not persist expected row');
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Logic function create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Logic function create persisted unexpected applicationId',
          );
        }
        const afterProj = projectLogicFunction(afterRow);
        for (const textKey of [
          'name',
          'sourceHandlerPath',
          'builtHandlerPath',
          'handlerName',
          'executionMode',
          'runtime',
        ] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(
              `Logic function create persisted unexpected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of ['description', 'checksum'] as const) {
          if (planned.flatEntity[nullableTextKey] !== undefined) {
            const expectedVal =
              planned.flatEntity[nullableTextKey] === null
                ? null
                : String(planned.flatEntity[nullableTextKey]);
            if (afterProj[nullableTextKey] !== expectedVal) {
              throw new Error(
                `Logic function create persisted unexpected ${nullableTextKey}`,
              );
            }
          }
        }
        if (
          planned.flatEntity.timeoutSeconds !== undefined &&
          afterProj.timeoutSeconds !== Number(planned.flatEntity.timeoutSeconds)
        ) {
          throw new Error(
            'Logic function create persisted unexpected timeoutSeconds',
          );
        }
        if (
          planned.flatEntity.isBuildUpToDate !== undefined &&
          afterProj.isBuildUpToDate !==
            Boolean(planned.flatEntity.isBuildUpToDate)
        ) {
          throw new Error(
            'Logic function create persisted unexpected isBuildUpToDate',
          );
        }
        for (const triggerKey of LOGIC_FUNCTION_TRIGGER_SETTINGS_KEYS) {
          if (planned.flatEntity[triggerKey] !== undefined) {
            const expectedTrigger =
              planned.flatEntity[triggerKey] === null
                ? null
                : planned.flatEntity[triggerKey];
            if (
              canonicalAuditJson(afterProj[triggerKey]) !==
              canonicalAuditJson(expectedTrigger)
            ) {
              throw new Error(
                `Logic function create persisted unexpected ${triggerKey}`,
              );
            }
          }
        }
        audit.record({
          resourceKind: 'logicFunction',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'logicFunction',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedLogicFunctionUpdates.entries()) {
        const beforeRow = beforeLogicFunctions.get(targetId);
        const afterRow = afterLogicFunctions.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Logic function update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          String(beforeRow.runtime) !== String(afterRow.runtime)
        ) {
          throw new Error('Logic function update modified immutable fields');
        }
        const beforeProj = projectLogicFunction(beforeRow);
        const afterProj = projectLogicFunction(afterRow);
        for (const textKey of [
          'name',
          'sourceHandlerPath',
          'builtHandlerPath',
          'handlerName',
          'executionMode',
        ] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Logic function update did not persist expected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of ['description', 'checksum'] as const) {
          const expectedVal =
            nullableTextKey in update && update[nullableTextKey] !== undefined
              ? update[nullableTextKey] === null
                ? null
                : String(update[nullableTextKey])
              : beforeProj[nullableTextKey];
          if (afterProj[nullableTextKey] !== expectedVal) {
            throw new Error(
              `Logic function update did not persist expected ${nullableTextKey}`,
            );
          }
        }
        const expectedTimeoutSeconds =
          'timeoutSeconds' in update && update.timeoutSeconds !== undefined
            ? Number(update.timeoutSeconds)
            : beforeProj.timeoutSeconds;
        if (afterProj.timeoutSeconds !== expectedTimeoutSeconds) {
          throw new Error(
            'Logic function update did not persist expected timeoutSeconds',
          );
        }
        const expectedIsBuildUpToDate =
          'isBuildUpToDate' in update && update.isBuildUpToDate !== undefined
            ? Boolean(update.isBuildUpToDate)
            : beforeProj.isBuildUpToDate;
        if (afterProj.isBuildUpToDate !== expectedIsBuildUpToDate) {
          throw new Error(
            'Logic function update did not persist expected isBuildUpToDate',
          );
        }
        for (const triggerKey of LOGIC_FUNCTION_TRIGGER_SETTINGS_KEYS) {
          const expectedTrigger =
            triggerKey in update && update[triggerKey] !== undefined
              ? update[triggerKey] === null
                ? null
                : update[triggerKey]
              : beforeProj[triggerKey];
          if (
            canonicalAuditJson(afterProj[triggerKey]) !==
            canonicalAuditJson(expectedTrigger)
          ) {
            throw new Error(
              `Logic function update did not persist expected ${triggerKey}`,
            );
          }
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'logicFunction',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'logicFunction',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedLogicFunctionDeletes) {
        const beforeRow = beforeLogicFunctions.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Logic function delete expected row missing before migration',
          );
        }
        if (afterLogicFunctions.has(deletedId)) {
          throw new Error('Logic function delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'logicFunction',
          resourceId: deletedId,
          action: 'delete',
          before: projectLogicFunction(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'logicFunction',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforeLogicFunctions.entries()) {
        if (plannedLogicFunctionDeletes.has(id)) continue;
        const afterRow = afterLogicFunctions.get(id);
        if (!afterRow) {
          throw new Error(
            'Logic function audit detected unplanned row deletion',
          );
        }
        if (!plannedLogicFunctionUpdates.has(id)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error(
              'Logic function audit detected unplanned row mutation',
            );
          }
        }
      }

      expectedLogicFunctionsSerialized =
        serializeLogicFunctionSnapshot(afterLogicFunctions);
    }

    let expectedTimelineActivityTypesSerialized: string | undefined;
    if (
      touchesTimelineActivityTypes &&
      reg?.hasTimelineActivityTypeTable === true
    ) {
      const afterTimelineActivityTypes = await readTimelineActivityTypeSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdTimelineActivityTypesByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterTimelineActivityTypes.entries()) {
        assertTimelineActivityTypeRowInvariants(afterRow, request.workspaceId);
        if (!beforeTimelineActivityTypes.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdTimelineActivityTypesByUniversalId.has(universalId)) {
            throw new Error(
              'Timeline activity type audit detected duplicate created universalIdentifier',
            );
          }
          createdTimelineActivityTypesByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdTimelineActivityTypesByUniversalId.size !==
        plannedTimelineActivityTypeCreatesByUniversalIdentifier.size
      ) {
        throw new Error(
          'Timeline activity type audit created row count mismatch',
        );
      }
      for (const [
        universalId,
        planned,
      ] of plannedTimelineActivityTypeCreatesByUniversalIdentifier.entries()) {
        const afterRow =
          createdTimelineActivityTypesByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error(
            'Timeline activity type create did not persist expected row',
          );
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error(
            'Timeline activity type create persisted unexpected ID',
          );
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Timeline activity type create persisted unexpected applicationId',
          );
        }
        const afterProj = projectTimelineActivityType(afterRow);
        for (const textKey of ['name', 'label'] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(
              `Timeline activity type create persisted unexpected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of ['action', 'icon'] as const) {
          if (planned.flatEntity[nullableTextKey] !== undefined) {
            const expectedVal =
              planned.flatEntity[nullableTextKey] === null
                ? null
                : String(planned.flatEntity[nullableTextKey]);
            if (afterProj[nullableTextKey] !== expectedVal) {
              throw new Error(
                `Timeline activity type create persisted unexpected ${nullableTextKey}`,
              );
            }
          }
        }
        for (const uuidKey of TIMELINE_ACTIVITY_TYPE_NULLABLE_UUID_KEYS) {
          if (
            planned.flatEntity[uuidKey] !== undefined &&
            afterProj[uuidKey] !== nullableUuid(planned.flatEntity[uuidKey])
          ) {
            throw new Error(
              `Timeline activity type create persisted unexpected ${uuidKey}`,
            );
          }
        }
        if (planned.flatEntity.triggerFieldUniversalIdentifiers !== undefined) {
          const expectedTriggerFields = Array.isArray(
            planned.flatEntity.triggerFieldUniversalIdentifiers,
          )
            ? planned.flatEntity.triggerFieldUniversalIdentifiers.map(
                (item: unknown) => uuid(item),
              )
            : null;
          if (
            canonicalAuditJson(afterProj.triggerFieldUniversalIdentifiers) !==
            canonicalAuditJson(expectedTriggerFields)
          ) {
            throw new Error(
              'Timeline activity type create persisted unexpected triggerFieldUniversalIdentifiers',
            );
          }
        }
        if (
          planned.flatEntity.isActive !== undefined &&
          afterProj.isActive !== Boolean(planned.flatEntity.isActive)
        ) {
          throw new Error(
            'Timeline activity type create persisted unexpected isActive',
          );
        }
        if (planned.flatEntity.overrides !== undefined) {
          const expectedOverrides =
            planned.flatEntity.overrides === null
              ? null
              : planned.flatEntity.overrides;
          if (
            canonicalAuditJson(afterProj.overrides) !==
            canonicalAuditJson(expectedOverrides)
          ) {
            throw new Error(
              'Timeline activity type create persisted unexpected overrides',
            );
          }
        }
        audit.record({
          resourceKind: 'timelineActivityType',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'timelineActivityType',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [
        targetId,
        update,
      ] of plannedTimelineActivityTypeUpdates.entries()) {
        const beforeRow = beforeTimelineActivityTypes.get(targetId);
        const afterRow = afterTimelineActivityTypes.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error(
            'Timeline activity type update removed or lost target row',
          );
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier)
        ) {
          throw new Error(
            'Timeline activity type update modified immutable fields',
          );
        }
        const beforeProj = projectTimelineActivityType(beforeRow);
        const afterProj = projectTimelineActivityType(afterRow);
        for (const textKey of ['name', 'label'] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Timeline activity type update did not persist expected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of ['action', 'icon'] as const) {
          const expectedVal =
            nullableTextKey in update && update[nullableTextKey] !== undefined
              ? update[nullableTextKey] === null
                ? null
                : String(update[nullableTextKey])
              : beforeProj[nullableTextKey];
          if (afterProj[nullableTextKey] !== expectedVal) {
            throw new Error(
              `Timeline activity type update did not persist expected ${nullableTextKey}`,
            );
          }
        }
        for (const uuidKey of TIMELINE_ACTIVITY_TYPE_NULLABLE_UUID_KEYS) {
          const expectedVal =
            uuidKey in update && update[uuidKey] !== undefined
              ? nullableUuid(update[uuidKey])
              : beforeProj[uuidKey];
          if (afterProj[uuidKey] !== expectedVal) {
            throw new Error(
              `Timeline activity type update did not persist expected ${uuidKey}`,
            );
          }
        }
        const expectedTriggerFields =
          'triggerFieldUniversalIdentifiers' in update &&
          update.triggerFieldUniversalIdentifiers !== undefined
            ? Array.isArray(update.triggerFieldUniversalIdentifiers)
              ? update.triggerFieldUniversalIdentifiers.map((item: unknown) =>
                  uuid(item),
                )
              : null
            : beforeProj.triggerFieldUniversalIdentifiers;
        if (
          canonicalAuditJson(afterProj.triggerFieldUniversalIdentifiers) !==
          canonicalAuditJson(expectedTriggerFields)
        ) {
          throw new Error(
            'Timeline activity type update did not persist expected triggerFieldUniversalIdentifiers',
          );
        }
        const expectedIsActive =
          'isActive' in update && update.isActive !== undefined
            ? Boolean(update.isActive)
            : beforeProj.isActive;
        if (afterProj.isActive !== expectedIsActive) {
          throw new Error(
            'Timeline activity type update did not persist expected isActive',
          );
        }
        const expectedOverrides =
          'overrides' in update && update.overrides !== undefined
            ? update.overrides === null
              ? null
              : update.overrides
            : beforeProj.overrides;
        if (
          canonicalAuditJson(afterProj.overrides) !==
          canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Timeline activity type update did not persist expected overrides',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'timelineActivityType',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'timelineActivityType',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedTimelineActivityTypeDeletes) {
        const beforeRow = beforeTimelineActivityTypes.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Timeline activity type delete expected row missing before migration',
          );
        }
        if (afterTimelineActivityTypes.has(deletedId)) {
          throw new Error(
            'Timeline activity type delete did not remove expected row',
          );
        }
        audit.record({
          resourceKind: 'timelineActivityType',
          resourceId: deletedId,
          action: 'delete',
          before: projectTimelineActivityType(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'timelineActivityType',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforeTimelineActivityTypes.entries()) {
        if (plannedTimelineActivityTypeDeletes.has(id)) continue;
        const afterRow = afterTimelineActivityTypes.get(id);
        if (!afterRow) {
          throw new Error(
            'Timeline activity type audit detected unplanned row deletion',
          );
        }
        if (!plannedTimelineActivityTypeUpdates.has(id)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterRow),
            )
          ) {
            throw new Error(
              'Timeline activity type audit detected unplanned row mutation',
            );
          }
        }
      }

      expectedTimelineActivityTypesSerialized =
        serializeTimelineActivityTypeSnapshot(afterTimelineActivityTypes);
    }

    let expectedCommandMenuItemsSerialized: string | undefined;
    if (touchesCommandMenuItems && reg?.hasCommandMenuItemTable === true) {
      const afterCommandMenuItems = await readCommandMenuItemSnapshot(
        runner,
        request.workspaceId,
        false,
      );
      const createdCommandMenuItemsByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterRow] of afterCommandMenuItems.entries()) {
        assertCommandMenuItemRowInvariants(afterRow, request.workspaceId);
        if (!beforeCommandMenuItems.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdCommandMenuItemsByUniversalId.has(universalId)) {
            throw new Error(
              'Command menu item audit detected duplicate created universalIdentifier',
            );
          }
          createdCommandMenuItemsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdCommandMenuItemsByUniversalId.size !==
        plannedCommandMenuItemCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Command menu item audit created row count mismatch');
      }

      const resolveMappedRelationId = (
        source: Record<string, unknown>,
        directKey: string,
        universalKey: string,
        map?: Record<string, { id: string } | undefined>,
      ): string | null | undefined => {
        if (universalKey in source && source[universalKey] !== undefined) {
          if (source[universalKey] === null) return null;
          const mappedId = map?.[uuid(source[universalKey])]?.id;
          return mappedId ? uuid(mappedId) : null;
        }
        if (directKey in source && source[directKey] !== undefined) {
          return nullableUuid(source[directKey]);
        }
        return undefined;
      };

      for (const [
        universalId,
        planned,
      ] of plannedCommandMenuItemCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdCommandMenuItemsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error(
            'Command menu item create did not persist expected row',
          );
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Command menu item create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Command menu item create persisted unexpected applicationId',
          );
        }
        const afterProj = projectCommandMenuItem(afterRow);
        for (const textKey of [
          'engineComponentKey',
          'label',
          'availabilityType',
        ] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(
              `Command menu item create persisted unexpected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of [
          'icon',
          'shortLabel',
          'conditionalAvailabilityExpression',
          'conditionalPinnedExpression',
        ] as const) {
          if (planned.flatEntity[nullableTextKey] !== undefined) {
            const expectedVal =
              planned.flatEntity[nullableTextKey] === null
                ? null
                : String(planned.flatEntity[nullableTextKey]);
            if (afterProj[nullableTextKey] !== expectedVal) {
              throw new Error(
                `Command menu item create persisted unexpected ${nullableTextKey}`,
              );
            }
          }
        }
        if (
          planned.flatEntity.position !== undefined &&
          afterProj.position !== Number(planned.flatEntity.position)
        ) {
          throw new Error(
            'Command menu item create persisted unexpected position',
          );
        }
        for (const boolKey of [
          'isPinned',
          'isActive',
          'isSystemSideEffect',
        ] as const) {
          if (
            planned.flatEntity[boolKey] !== undefined &&
            afterProj[boolKey] !== Boolean(planned.flatEntity[boolKey])
          ) {
            throw new Error(
              `Command menu item create persisted unexpected ${boolKey}`,
            );
          }
        }
        for (const directUuidKey of [
          'workflowVersionId',
          'coreWorkflowVersionId',
        ] as const) {
          if (
            planned.flatEntity[directUuidKey] !== undefined &&
            afterProj[directUuidKey] !==
              nullableUuid(planned.flatEntity[directUuidKey])
          ) {
            throw new Error(
              `Command menu item create persisted unexpected ${directUuidKey}`,
            );
          }
        }
        const expectedFrontComponentId = resolveMappedRelationId(
          planned.flatEntity,
          'frontComponentId',
          'frontComponentUniversalIdentifier',
          mappings.frontComponents,
        );
        if (
          expectedFrontComponentId !== undefined &&
          afterProj.frontComponentId !== expectedFrontComponentId
        ) {
          throw new Error(
            'Command menu item create persisted unexpected frontComponentId',
          );
        }
        const expectedAvailObjId = resolveMappedRelationId(
          planned.flatEntity,
          'availabilityObjectMetadataId',
          'availabilityObjectMetadataUniversalIdentifier',
          mappings.objectMetadatas,
        );
        if (
          expectedAvailObjId !== undefined &&
          afterProj.availabilityObjectMetadataId !== expectedAvailObjId
        ) {
          throw new Error(
            'Command menu item create persisted unexpected availabilityObjectMetadataId',
          );
        }
        const expectedNavObjId =
          request.mode === 'cascade' &&
          request.expectedCreatedObjectId !== undefined &&
          planned.flatEntity.navigationTargetObjectMetadataId === undefined
            ? request.expectedCreatedObjectId
            : resolveMappedRelationId(
                planned.flatEntity,
                'navigationTargetObjectMetadataId',
                'navigationTargetObjectMetadataUniversalIdentifier',
                mappings.objectMetadatas,
              );
        if (
          expectedNavObjId !== undefined &&
          afterProj.navigationTargetObjectMetadataId !== expectedNavObjId
        ) {
          throw new Error(
            'Command menu item create persisted unexpected navigationTargetObjectMetadataId',
          );
        }
        const expectedPageLayoutId = resolveMappedRelationId(
          planned.flatEntity,
          'pageLayoutId',
          'pageLayoutUniversalIdentifier',
          mappings.pageLayouts,
        );
        if (
          expectedPageLayoutId !== undefined &&
          afterProj.pageLayoutId !== expectedPageLayoutId
        ) {
          throw new Error(
            'Command menu item create persisted unexpected pageLayoutId',
          );
        }
        if (planned.flatEntity.payload !== undefined) {
          const expectedPayload =
            planned.flatEntity.payload === null
              ? null
              : planned.flatEntity.payload;
          if (
            canonicalAuditJson(afterProj.payload) !==
            canonicalAuditJson(expectedPayload)
          ) {
            throw new Error(
              'Command menu item create persisted unexpected payload',
            );
          }
        }
        if (planned.flatEntity.hotKeys !== undefined) {
          const expectedHotKeys = Array.isArray(planned.flatEntity.hotKeys)
            ? planned.flatEntity.hotKeys.map((item: unknown) => String(item))
            : null;
          if (
            canonicalAuditJson(afterProj.hotKeys) !==
            canonicalAuditJson(expectedHotKeys)
          ) {
            throw new Error(
              'Command menu item create persisted unexpected hotKeys',
            );
          }
        }
        const expectedOverrides = resolveExpectedCommandMenuItemOverrides(
          planned.flatEntity,
          mappings.objectMetadatas,
          mappings.pageLayouts,
        );
        if (
          expectedOverrides !== undefined &&
          canonicalAuditJson(afterProj.overrides) !==
            canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Command menu item create persisted unexpected overrides',
          );
        }
        audit.record({
          resourceKind: 'commandMenuItem',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'commandMenuItem',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [
        targetId,
        update,
      ] of plannedCommandMenuItemUpdates.entries()) {
        const beforeRow = beforeCommandMenuItems.get(targetId);
        const afterRow = afterCommandMenuItems.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error(
            'Command menu item update removed or lost target row',
          );
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          Boolean(beforeRow.isSystemSideEffect) !==
            Boolean(afterRow.isSystemSideEffect)
        ) {
          throw new Error('Command menu item update modified immutable fields');
        }
        const beforeProj = projectCommandMenuItem(beforeRow);
        const afterProj = projectCommandMenuItem(afterRow);
        for (const textKey of [
          'engineComponentKey',
          'label',
          'availabilityType',
        ] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Command menu item update did not persist expected ${textKey}`,
            );
          }
        }
        for (const nullableTextKey of [
          'icon',
          'shortLabel',
          'conditionalAvailabilityExpression',
          'conditionalPinnedExpression',
        ] as const) {
          const expectedVal =
            nullableTextKey in update && update[nullableTextKey] !== undefined
              ? update[nullableTextKey] === null
                ? null
                : String(update[nullableTextKey])
              : beforeProj[nullableTextKey];
          if (afterProj[nullableTextKey] !== expectedVal) {
            throw new Error(
              `Command menu item update did not persist expected ${nullableTextKey}`,
            );
          }
        }
        const expectedPosition =
          'position' in update && update.position !== undefined
            ? Number(update.position)
            : beforeProj.position;
        if (afterProj.position !== expectedPosition) {
          throw new Error(
            'Command menu item update did not persist expected position',
          );
        }
        for (const boolKey of ['isPinned', 'isActive'] as const) {
          const expectedVal =
            boolKey in update && update[boolKey] !== undefined
              ? Boolean(update[boolKey])
              : beforeProj[boolKey];
          if (afterProj[boolKey] !== expectedVal) {
            throw new Error(
              `Command menu item update did not persist expected ${boolKey}`,
            );
          }
        }
        for (const directUuidKey of [
          'workflowVersionId',
          'coreWorkflowVersionId',
        ] as const) {
          const expectedVal =
            directUuidKey in update && update[directUuidKey] !== undefined
              ? nullableUuid(update[directUuidKey])
              : beforeProj[directUuidKey];
          if (afterProj[directUuidKey] !== expectedVal) {
            throw new Error(
              `Command menu item update did not persist expected ${directUuidKey}`,
            );
          }
        }
        const resolvedFrontComponentId = resolveMappedRelationId(
          update,
          'frontComponentId',
          'frontComponentUniversalIdentifier',
          mappings.frontComponents,
        );
        const expectedFrontComponentId =
          resolvedFrontComponentId !== undefined
            ? resolvedFrontComponentId
            : beforeProj.frontComponentId;
        if (afterProj.frontComponentId !== expectedFrontComponentId) {
          throw new Error(
            'Command menu item update did not persist expected frontComponentId',
          );
        }
        const resolvedAvailObjId = resolveMappedRelationId(
          update,
          'availabilityObjectMetadataId',
          'availabilityObjectMetadataUniversalIdentifier',
          mappings.objectMetadatas,
        );
        const expectedAvailObjId =
          resolvedAvailObjId !== undefined
            ? resolvedAvailObjId
            : beforeProj.availabilityObjectMetadataId;
        if (afterProj.availabilityObjectMetadataId !== expectedAvailObjId) {
          throw new Error(
            'Command menu item update did not persist expected availabilityObjectMetadataId',
          );
        }
        const resolvedNavObjId = resolveMappedRelationId(
          update,
          'navigationTargetObjectMetadataId',
          'navigationTargetObjectMetadataUniversalIdentifier',
          mappings.objectMetadatas,
        );
        const expectedNavObjId =
          resolvedNavObjId !== undefined
            ? resolvedNavObjId
            : beforeProj.navigationTargetObjectMetadataId;
        if (afterProj.navigationTargetObjectMetadataId !== expectedNavObjId) {
          throw new Error(
            'Command menu item update did not persist expected navigationTargetObjectMetadataId',
          );
        }
        const resolvedPageLayoutId = resolveMappedRelationId(
          update,
          'pageLayoutId',
          'pageLayoutUniversalIdentifier',
          mappings.pageLayouts,
        );
        const expectedPageLayoutId =
          resolvedPageLayoutId !== undefined
            ? resolvedPageLayoutId
            : beforeProj.pageLayoutId;
        if (afterProj.pageLayoutId !== expectedPageLayoutId) {
          throw new Error(
            'Command menu item update did not persist expected pageLayoutId',
          );
        }
        const expectedPayload =
          'payload' in update && update.payload !== undefined
            ? update.payload === null
              ? null
              : update.payload
            : beforeProj.payload;
        if (
          canonicalAuditJson(afterProj.payload) !==
          canonicalAuditJson(expectedPayload)
        ) {
          throw new Error(
            'Command menu item update did not persist expected payload',
          );
        }
        const expectedHotKeys =
          'hotKeys' in update && update.hotKeys !== undefined
            ? Array.isArray(update.hotKeys)
              ? update.hotKeys.map((item: unknown) => String(item))
              : null
            : beforeProj.hotKeys;
        if (
          canonicalAuditJson(afterProj.hotKeys) !==
          canonicalAuditJson(expectedHotKeys)
        ) {
          throw new Error(
            'Command menu item update did not persist expected hotKeys',
          );
        }
        const resolvedOverrides = resolveExpectedCommandMenuItemOverrides(
          update,
          mappings.objectMetadatas,
          mappings.pageLayouts,
        );
        const expectedOverrides =
          resolvedOverrides !== undefined
            ? resolvedOverrides
            : beforeProj.overrides;
        if (
          canonicalAuditJson(afterProj.overrides) !==
          canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Command menu item update did not persist expected overrides',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'commandMenuItem',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'commandMenuItem',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of plannedCommandMenuItemDeletes) {
        if (!beforeCommandMenuItems.has(deletedId)) {
          throw new Error(
            'Command menu item delete expected row missing before migration',
          );
        }
      }

      for (const [cmiId, beforeCmi] of beforeCommandMenuItems.entries()) {
        const fcId = nullableUuid(beforeCmi.frontComponentId);
        const plId = nullableUuid(beforeCmi.pageLayoutId);
        const isExpectedDelete =
          plannedCommandMenuItemDeletes.has(cmiId) ||
          (fcId !== null && plannedFrontComponentDeletes.has(fcId)) ||
          (plId !== null && plannedPageLayoutDeletes.has(plId));
        const afterCmi = afterCommandMenuItems.get(cmiId);
        if (isExpectedDelete) {
          if (afterCmi) {
            throw new Error(
              'Command menu item delete did not remove expected row',
            );
          }
          audit.record({
            resourceKind: 'commandMenuItem',
            resourceId: cmiId,
            action: 'delete',
            before: projectCommandMenuItem(beforeCmi),
            after: null,
            securityDescriptor: {
              resourceKind: 'commandMenuItem',
              resourceId: cmiId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        } else {
          if (!afterCmi) {
            throw new Error(
              'Command menu item audit detected unplanned row deletion',
            );
          }
          if (!plannedCommandMenuItemUpdates.has(cmiId)) {
            if (
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(beforeCmi),
              ) !==
              canonicalAuditJson(
                scalarNavigationMenuItemWithoutTimestamps(afterCmi),
              )
            ) {
              throw new Error(
                'Command menu item audit detected unplanned row mutation',
              );
            }
          }
        }
      }

      expectedCommandMenuItemsSerialized = serializeCommandMenuItemSnapshot(
        afterCommandMenuItems,
      );
    }

    let expectedPageLayoutsSerialized: string | undefined;
    let expectedPageLayoutTabsSerialized: string | undefined;
    let expectedPageLayoutWidgetsSerialized: string | undefined;

    const afterPageLayouts =
      touchesPageLayouts && reg?.hasPageLayoutTable === true
        ? await readPageLayoutSnapshot(runner, request.workspaceId, false)
        : new Map<string, Record<string, unknown>>();
    const afterPageLayoutTabs =
      touchesPageLayoutTabs && reg?.hasPageLayoutTabTable === true
        ? await readPageLayoutTabSnapshot(runner, request.workspaceId, false)
        : new Map<string, Record<string, unknown>>();
    const afterPageLayoutWidgets =
      touchesPageLayoutWidgets && reg?.hasPageLayoutWidgetTable === true
        ? await readPageLayoutWidgetSnapshot(runner, request.workspaceId, false)
        : new Map<string, Record<string, unknown>>();

    const createdPageLayoutsByUniversalId = new Map<
      string,
      Record<string, unknown>
    >();
    if (touchesPageLayouts && reg?.hasPageLayoutTable === true) {
      for (const [id, afterRow] of afterPageLayouts.entries()) {
        assertPageLayoutRowInvariants(afterRow, request.workspaceId);
        if (!beforePageLayouts.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdPageLayoutsByUniversalId.has(universalId)) {
            throw new Error(
              'Page layout audit detected duplicate created universalIdentifier',
            );
          }
          createdPageLayoutsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdPageLayoutsByUniversalId.size !==
        plannedPageLayoutCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Page layout audit created row count mismatch');
      }
    }

    const createdPageLayoutTabsByUniversalId = new Map<
      string,
      Record<string, unknown>
    >();
    if (touchesPageLayoutTabs && reg?.hasPageLayoutTabTable === true) {
      for (const [id, afterRow] of afterPageLayoutTabs.entries()) {
        assertPageLayoutTabRowInvariants(afterRow, request.workspaceId);
        if (!beforePageLayoutTabs.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdPageLayoutTabsByUniversalId.has(universalId)) {
            throw new Error(
              'Page layout tab audit detected duplicate created universalIdentifier',
            );
          }
          createdPageLayoutTabsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdPageLayoutTabsByUniversalId.size !==
        plannedPageLayoutTabCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Page layout tab audit created row count mismatch');
      }
    }

    const createdPageLayoutWidgetsByUniversalId = new Map<
      string,
      Record<string, unknown>
    >();
    if (touchesPageLayoutWidgets && reg?.hasPageLayoutWidgetTable === true) {
      for (const [id, afterRow] of afterPageLayoutWidgets.entries()) {
        assertPageLayoutWidgetRowInvariants(afterRow, request.workspaceId);
        if (!beforePageLayoutWidgets.has(id)) {
          const universalId = uuid(afterRow.universalIdentifier);
          if (createdPageLayoutWidgetsByUniversalId.has(universalId)) {
            throw new Error(
              'Page layout widget audit detected duplicate created universalIdentifier',
            );
          }
          createdPageLayoutWidgetsByUniversalId.set(universalId, afterRow);
        }
      }
      if (
        createdPageLayoutWidgetsByUniversalId.size !==
        plannedPageLayoutWidgetCreatesByUniversalIdentifier.size
      ) {
        throw new Error('Page layout widget audit created row count mismatch');
      }
    }

    const effectiveObjectMetadatasMap: Record<
      string,
      { id: string } | undefined
    > = {
      ...mappings.objectMetadatas,
    };
    for (const action of actions) {
      if (
        action.metadataName === 'objectMetadata' &&
        action.type === 'create' &&
        action.flatEntity?.universalIdentifier !== undefined
      ) {
        const objId =
          action.id ?? action.flatEntity.id ?? request.expectedCreatedObjectId;
        if (typeof objId === 'string' && isUUID(objId)) {
          effectiveObjectMetadatasMap[
            uuid(action.flatEntity.universalIdentifier)
          ] = {
            id: uuid(objId),
          };
        }
      }
    }

    const effectivePageLayoutsMap: Record<string, { id: string } | undefined> =
      {
        ...mappings.pageLayouts,
      };
    for (const [uid, afterRow] of createdPageLayoutsByUniversalId.entries()) {
      effectivePageLayoutsMap[uid] = { id: uuid(afterRow.id) };
    }

    const effectivePageLayoutTabsMap: Record<
      string,
      { id: string } | undefined
    > = {
      ...mappings.pageLayoutTabs,
    };
    for (const [
      uid,
      afterRow,
    ] of createdPageLayoutTabsByUniversalId.entries()) {
      effectivePageLayoutTabsMap[uid] = { id: uuid(afterRow.id) };
    }

    const effectiveDeletedPageLayoutIds = computeCascadeDeletedPageLayoutIds({
      beforePageLayouts,
      plannedPageLayoutDeletes,
      plannedObjectDeletes,
    });
    const effectiveDeletedPageLayoutTabIds =
      computeCascadeDeletedPageLayoutTabIds({
        beforePageLayoutTabs,
        plannedPageLayoutTabDeletes,
        effectiveDeletedPageLayoutIds,
      });
    const effectiveDeletedPageLayoutWidgetIds =
      computeCascadeDeletedPageLayoutWidgetIds({
        beforePageLayoutWidgets,
        plannedPageLayoutWidgetDeletes,
        effectiveDeletedPageLayoutTabIds,
        plannedObjectDeletes,
      });

    const resolveEffectiveRelationId = (
      source: Record<string, unknown>,
      directKey: string,
      universalKey: string,
      map?: Record<string, { id: string } | undefined>,
    ): string | null | undefined => {
      if (universalKey in source && source[universalKey] !== undefined) {
        if (source[universalKey] === null) return null;
        const mappedId = map?.[uuid(source[universalKey])]?.id;
        return mappedId ? uuid(mappedId) : uuid(source[universalKey]);
      }
      if (directKey in source && source[directKey] !== undefined) {
        return nullableUuid(source[directKey]);
      }
      return undefined;
    };

    if (touchesPageLayouts && reg?.hasPageLayoutTable === true) {
      for (const [
        universalId,
        planned,
      ] of plannedPageLayoutCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdPageLayoutsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error('Page layout create did not persist expected row');
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Page layout create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Page layout create persisted unexpected applicationId',
          );
        }
        const afterProj = projectPageLayout(afterRow);
        if (
          planned.flatEntity.name !== undefined &&
          afterProj.name !== String(planned.flatEntity.name)
        ) {
          throw new Error('Page layout create persisted unexpected name');
        }
        if (
          planned.flatEntity.type !== undefined &&
          afterProj.type !== String(planned.flatEntity.type)
        ) {
          throw new Error('Page layout create persisted unexpected type');
        }
        const expectedObjId = resolveEffectiveRelationId(
          planned.flatEntity,
          'objectMetadataId',
          'objectMetadataUniversalIdentifier',
          effectiveObjectMetadatasMap,
        );
        if (
          expectedObjId !== undefined &&
          afterProj.objectMetadataId !== expectedObjId
        ) {
          throw new Error(
            'Page layout create persisted unexpected objectMetadataId',
          );
        }
        if ('defaultTabToFocusOnMobileAndSidePanelId' in afterRow) {
          const expectedDefaultTabId = resolveEffectiveRelationId(
            planned.flatEntity,
            'defaultTabToFocusOnMobileAndSidePanelId',
            'defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier',
            effectivePageLayoutTabsMap,
          );
          if (
            expectedDefaultTabId !== undefined &&
            afterProj.defaultTabToFocusOnMobileAndSidePanelId !==
              expectedDefaultTabId
          ) {
            throw new Error(
              'Page layout create persisted unexpected defaultTabToFocusOnMobileAndSidePanelId',
            );
          }
        }
        if (
          'isSystemSideEffect' in afterRow &&
          planned.flatEntity.isSystemSideEffect !== undefined &&
          afterProj.isSystemSideEffect !==
            Boolean(planned.flatEntity.isSystemSideEffect)
        ) {
          throw new Error(
            'Page layout create persisted unexpected isSystemSideEffect',
          );
        }
        if (
          'isFirstTabPinned' in afterRow &&
          planned.flatEntity.isFirstTabPinned !== undefined &&
          afterProj.isFirstTabPinned !==
            Boolean(planned.flatEntity.isFirstTabPinned)
        ) {
          throw new Error(
            'Page layout create persisted unexpected isFirstTabPinned',
          );
        }
        audit.record({
          resourceKind: 'pageLayout',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'pageLayout',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedPageLayoutUpdates.entries()) {
        const beforeRow = beforePageLayouts.get(targetId);
        const afterRow = afterPageLayouts.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Page layout update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          Boolean(beforeRow.isSystemSideEffect ?? false) !==
            Boolean(afterRow.isSystemSideEffect ?? false)
        ) {
          throw new Error('Page layout update modified immutable fields');
        }
        const beforeProj = projectPageLayout(beforeRow);
        const afterProj = projectPageLayout(afterRow);
        const expectedName =
          'name' in update && update.name !== undefined
            ? String(update.name)
            : beforeProj.name;
        if (afterProj.name !== expectedName) {
          throw new Error('Page layout update did not persist expected name');
        }
        const expectedType =
          'type' in update && update.type !== undefined
            ? String(update.type)
            : beforeProj.type;
        if (afterProj.type !== expectedType) {
          throw new Error('Page layout update did not persist expected type');
        }
        const resolvedObjId = resolveEffectiveRelationId(
          update,
          'objectMetadataId',
          'objectMetadataUniversalIdentifier',
          effectiveObjectMetadatasMap,
        );
        const expectedObjId =
          resolvedObjId !== undefined
            ? resolvedObjId
            : beforeProj.objectMetadataId;
        if (afterProj.objectMetadataId !== expectedObjId) {
          throw new Error(
            'Page layout update did not persist expected objectMetadataId',
          );
        }
        if ('defaultTabToFocusOnMobileAndSidePanelId' in afterRow) {
          const resolvedDefaultTabId = resolveEffectiveRelationId(
            update,
            'defaultTabToFocusOnMobileAndSidePanelId',
            'defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier',
            effectivePageLayoutTabsMap,
          );
          const expectedDefaultTabId =
            resolvedDefaultTabId !== undefined
              ? resolvedDefaultTabId
              : beforeProj.defaultTabToFocusOnMobileAndSidePanelId !== null &&
                  effectiveDeletedPageLayoutTabIds.has(
                    beforeProj.defaultTabToFocusOnMobileAndSidePanelId,
                  )
                ? null
                : beforeProj.defaultTabToFocusOnMobileAndSidePanelId;
          if (
            afterProj.defaultTabToFocusOnMobileAndSidePanelId !==
            expectedDefaultTabId
          ) {
            throw new Error(
              'Page layout update did not persist expected defaultTabToFocusOnMobileAndSidePanelId',
            );
          }
        }
        if ('isFirstTabPinned' in afterRow) {
          const expectedFirstTabPinned =
            'isFirstTabPinned' in update &&
            update.isFirstTabPinned !== undefined
              ? Boolean(update.isFirstTabPinned)
              : beforeProj.isFirstTabPinned;
          if (afterProj.isFirstTabPinned !== expectedFirstTabPinned) {
            throw new Error(
              'Page layout update did not persist expected isFirstTabPinned',
            );
          }
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'pageLayout',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'pageLayout',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of effectiveDeletedPageLayoutIds) {
        const beforeRow = beforePageLayouts.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Page layout delete expected row missing before migration',
          );
        }
        if (afterPageLayouts.has(deletedId)) {
          throw new Error('Page layout delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'pageLayout',
          resourceId: deletedId,
          action: 'delete',
          before: projectPageLayout(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'pageLayout',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforePageLayouts.entries()) {
        if (
          effectiveDeletedPageLayoutIds.has(id) ||
          plannedPageLayoutUpdates.has(id)
        ) {
          continue;
        }
        const afterRow = afterPageLayouts.get(id);
        if (!afterRow) {
          throw new Error('Page layout audit detected unplanned row deletion');
        }
        const beforeDefaultTabId = nullableUuid(
          beforeRow.defaultTabToFocusOnMobileAndSidePanelId,
        );
        if (
          beforeDefaultTabId !== null &&
          effectiveDeletedPageLayoutTabIds.has(beforeDefaultTabId)
        ) {
          const afterDefaultTabId = nullableUuid(
            afterRow.defaultTabToFocusOnMobileAndSidePanelId,
          );
          const beforeWithoutDefaultTab = {
            ...scalarNavigationMenuItemWithoutTimestamps(beforeRow),
            defaultTabToFocusOnMobileAndSidePanelId: null,
          };
          const afterWithoutDefaultTab = {
            ...scalarNavigationMenuItemWithoutTimestamps(afterRow),
            defaultTabToFocusOnMobileAndSidePanelId: null,
          };
          if (
            afterDefaultTabId !== null ||
            canonicalAuditJson(beforeWithoutDefaultTab) !==
              canonicalAuditJson(afterWithoutDefaultTab)
          ) {
            throw new Error(
              'Page layout audit detected unexpected mutation on defaultTabToFocusOnMobileAndSidePanelId cascade',
            );
          }
          audit.record({
            resourceKind: 'pageLayout',
            resourceId: id,
            action: 'update',
            before: projectPageLayout(beforeRow),
            after: projectPageLayout(afterRow),
            securityDescriptor: {
              resourceKind: 'pageLayout',
              resourceId: id,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        } else if (
          canonicalAuditJson(
            scalarNavigationMenuItemWithoutTimestamps(beforeRow),
          ) !==
          canonicalAuditJson(
            scalarNavigationMenuItemWithoutTimestamps(afterRow),
          )
        ) {
          throw new Error('Page layout audit detected unplanned row mutation');
        }
      }

      expectedPageLayoutsSerialized =
        serializePageLayoutSnapshot(afterPageLayouts);
    }

    if (touchesPageLayoutTabs && reg?.hasPageLayoutTabTable === true) {
      for (const [
        universalId,
        planned,
      ] of plannedPageLayoutTabCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdPageLayoutTabsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error(
            'Page layout tab create did not persist expected row',
          );
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Page layout tab create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Page layout tab create persisted unexpected applicationId',
          );
        }
        const afterProj = projectPageLayoutTab(afterRow);
        const expectedPlId = resolveEffectiveRelationId(
          planned.flatEntity,
          'pageLayoutId',
          'pageLayoutUniversalIdentifier',
          effectivePageLayoutsMap,
        );
        if (
          expectedPlId !== undefined &&
          afterProj.pageLayoutId !== expectedPlId
        ) {
          throw new Error(
            'Page layout tab create persisted unexpected pageLayoutId',
          );
        }
        if (
          planned.flatEntity.title !== undefined &&
          afterProj.title !== String(planned.flatEntity.title)
        ) {
          throw new Error('Page layout tab create persisted unexpected title');
        }
        if (
          planned.flatEntity.position !== undefined &&
          afterProj.position !== Number(planned.flatEntity.position)
        ) {
          throw new Error(
            'Page layout tab create persisted unexpected position',
          );
        }
        if (
          planned.flatEntity.layoutMode !== undefined &&
          afterProj.layoutMode !== String(planned.flatEntity.layoutMode)
        ) {
          throw new Error(
            'Page layout tab create persisted unexpected layoutMode',
          );
        }
        if (planned.flatEntity.icon !== undefined) {
          const expectedIcon =
            planned.flatEntity.icon === null
              ? null
              : String(planned.flatEntity.icon);
          if (afterProj.icon !== expectedIcon) {
            throw new Error('Page layout tab create persisted unexpected icon');
          }
        }
        for (const boolKey of ['isActive', 'isSystemSideEffect'] as const) {
          if (
            planned.flatEntity[boolKey] !== undefined &&
            afterProj[boolKey] !== Boolean(planned.flatEntity[boolKey])
          ) {
            throw new Error(
              `Page layout tab create persisted unexpected ${boolKey}`,
            );
          }
        }
        if (planned.flatEntity.overrides !== undefined) {
          const expectedOverrides =
            planned.flatEntity.overrides === null
              ? null
              : stripUndefinedJson(planned.flatEntity.overrides);
          if (
            canonicalAuditJson(afterProj.overrides) !==
            canonicalAuditJson(expectedOverrides)
          ) {
            throw new Error(
              'Page layout tab create persisted unexpected overrides',
            );
          }
        }
        audit.record({
          resourceKind: 'pageLayoutTab',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'pageLayoutTab',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [targetId, update] of plannedPageLayoutTabUpdates.entries()) {
        const beforeRow = beforePageLayoutTabs.get(targetId);
        const afterRow = afterPageLayoutTabs.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error('Page layout tab update removed or lost target row');
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          uuid(beforeRow.pageLayoutId) !== uuid(afterRow.pageLayoutId) ||
          Boolean(beforeRow.isSystemSideEffect) !==
            Boolean(afterRow.isSystemSideEffect)
        ) {
          throw new Error('Page layout tab update modified immutable fields');
        }
        const beforeProj = projectPageLayoutTab(beforeRow);
        const afterProj = projectPageLayoutTab(afterRow);
        for (const textKey of ['title', 'layoutMode'] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Page layout tab update did not persist expected ${textKey}`,
            );
          }
        }
        const expectedPosition =
          'position' in update && update.position !== undefined
            ? Number(update.position)
            : beforeProj.position;
        if (afterProj.position !== expectedPosition) {
          throw new Error(
            'Page layout tab update did not persist expected position',
          );
        }
        const expectedIcon =
          'icon' in update && update.icon !== undefined
            ? update.icon === null
              ? null
              : String(update.icon)
            : beforeProj.icon;
        if (afterProj.icon !== expectedIcon) {
          throw new Error(
            'Page layout tab update did not persist expected icon',
          );
        }
        const expectedIsActive =
          'isActive' in update && update.isActive !== undefined
            ? Boolean(update.isActive)
            : beforeProj.isActive;
        if (afterProj.isActive !== expectedIsActive) {
          throw new Error(
            'Page layout tab update did not persist expected isActive',
          );
        }
        const expectedOverrides =
          'overrides' in update && update.overrides !== undefined
            ? update.overrides === null
              ? null
              : stripUndefinedJson(update.overrides)
            : beforeProj.overrides;
        if (
          canonicalAuditJson(afterProj.overrides) !==
          canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Page layout tab update did not persist expected overrides',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'pageLayoutTab',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'pageLayoutTab',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of effectiveDeletedPageLayoutTabIds) {
        const beforeRow = beforePageLayoutTabs.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Page layout tab delete expected row missing before migration',
          );
        }
        if (afterPageLayoutTabs.has(deletedId)) {
          throw new Error('Page layout tab delete did not remove expected row');
        }
        audit.record({
          resourceKind: 'pageLayoutTab',
          resourceId: deletedId,
          action: 'delete',
          before: projectPageLayoutTab(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'pageLayoutTab',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforePageLayoutTabs.entries()) {
        if (
          effectiveDeletedPageLayoutTabIds.has(id) ||
          plannedPageLayoutTabUpdates.has(id)
        ) {
          continue;
        }
        const afterRow = afterPageLayoutTabs.get(id);
        if (!afterRow) {
          throw new Error(
            'Page layout tab audit detected unplanned row deletion',
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
            'Page layout tab audit detected unplanned row mutation',
          );
        }
      }

      expectedPageLayoutTabsSerialized =
        serializePageLayoutTabSnapshot(afterPageLayoutTabs);
    }

    if (touchesPageLayoutWidgets && reg?.hasPageLayoutWidgetTable === true) {
      const effectiveFieldMetadatasMap: Record<
        string,
        { id: string } | undefined
      > = {
        ...mappings.fieldMetadatas,
      };
      const effectiveViewsMap: Record<string, { id: string } | undefined> = {
        ...mappings.views,
      };
      const effectiveViewFieldGroupsMap: Record<
        string,
        { id: string } | undefined
      > = {
        ...mappings.viewFieldGroups,
      };
      for (const action of actions) {
        if (
          action.type === 'create' &&
          action.flatEntity?.universalIdentifier !== undefined
        ) {
          const createdEntityId = action.id ?? action.flatEntity.id;
          if (typeof createdEntityId === 'string' && isUUID(createdEntityId)) {
            const uid = uuid(action.flatEntity.universalIdentifier);
            const normalizedId = uuid(createdEntityId);
            if (action.metadataName === 'fieldMetadata') {
              effectiveFieldMetadatasMap[uid] = { id: normalizedId };
            } else if (action.metadataName === 'view') {
              effectiveViewsMap[uid] = { id: normalizedId };
            } else if (action.metadataName === 'viewFieldGroup') {
              effectiveViewFieldGroupsMap[uid] = { id: normalizedId };
            }
          }
        }
      }
      if (
        (plannedPageLayoutWidgetCreatesByUniversalIdentifier.size > 0 ||
          plannedPageLayoutWidgetUpdates.size > 0) &&
        (plannedObjectCreates.size > 0 || plannedFieldCreateCount > 0) &&
        reg?.hasFieldTable === true
      ) {
        const dbFields = await runner.query(
          `SELECT id, "universalIdentifier" FROM core."fieldMetadata" WHERE "workspaceId"=$1`,
          [request.workspaceId],
        );
        for (const fRow of dbFields) {
          if (
            typeof fRow.universalIdentifier === 'string' &&
            isUUID(fRow.universalIdentifier) &&
            typeof fRow.id === 'string' &&
            isUUID(fRow.id)
          ) {
            effectiveFieldMetadatasMap[uuid(fRow.universalIdentifier)] = {
              id: uuid(fRow.id),
            };
          }
        }
      }

      for (const [
        universalId,
        planned,
      ] of plannedPageLayoutWidgetCreatesByUniversalIdentifier.entries()) {
        const afterRow = createdPageLayoutWidgetsByUniversalId.get(universalId);
        if (!afterRow) {
          throw new Error(
            'Page layout widget create did not persist expected row',
          );
        }
        const createdId = uuid(afterRow.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error('Page layout widget create persisted unexpected ID');
        }
        if (uuid(afterRow.applicationId) !== applicationId) {
          throw new Error(
            'Page layout widget create persisted unexpected applicationId',
          );
        }
        const afterProj = projectPageLayoutWidget(afterRow);
        const expectedTabId = resolveEffectiveRelationId(
          planned.flatEntity,
          'pageLayoutTabId',
          'pageLayoutTabUniversalIdentifier',
          effectivePageLayoutTabsMap,
        );
        if (
          expectedTabId !== undefined &&
          afterProj.pageLayoutTabId !== expectedTabId
        ) {
          throw new Error(
            'Page layout widget create persisted unexpected pageLayoutTabId',
          );
        }
        const expectedObjId = resolveEffectiveRelationId(
          planned.flatEntity,
          'objectMetadataId',
          'objectMetadataUniversalIdentifier',
          effectiveObjectMetadatasMap,
        );
        if (
          expectedObjId !== undefined &&
          afterProj.objectMetadataId !== expectedObjId
        ) {
          throw new Error(
            'Page layout widget create persisted unexpected objectMetadataId',
          );
        }
        for (const textKey of ['title', 'type'] as const) {
          if (
            planned.flatEntity[textKey] !== undefined &&
            afterProj[textKey] !== String(planned.flatEntity[textKey])
          ) {
            throw new Error(
              `Page layout widget create persisted unexpected ${textKey}`,
            );
          }
        }
        if (
          planned.flatEntity.conditionalAvailabilityExpression !== undefined
        ) {
          const expectedExpr =
            planned.flatEntity.conditionalAvailabilityExpression === null
              ? null
              : String(planned.flatEntity.conditionalAvailabilityExpression);
          if (afterProj.conditionalAvailabilityExpression !== expectedExpr) {
            throw new Error(
              'Page layout widget create persisted unexpected conditionalAvailabilityExpression',
            );
          }
        }
        if (planned.flatEntity.conditionalDisplay !== undefined) {
          const expectedDisplay =
            planned.flatEntity.conditionalDisplay === null
              ? null
              : stripUndefinedJson(planned.flatEntity.conditionalDisplay);
          if (
            canonicalAuditJson(afterProj.conditionalDisplay) !==
            canonicalAuditJson(expectedDisplay)
          ) {
            throw new Error(
              'Page layout widget create persisted unexpected conditionalDisplay',
            );
          }
        }
        if (
          planned.flatEntity.gridPosition !== undefined &&
          planned.flatEntity.gridPosition !== null
        ) {
          if (
            canonicalAuditJson(afterProj.gridPosition) !==
            canonicalAuditJson(
              stripUndefinedJson(planned.flatEntity.gridPosition),
            )
          ) {
            throw new Error(
              'Page layout widget create persisted unexpected gridPosition',
            );
          }
        }
        if (planned.flatEntity.position !== undefined) {
          const expectedPos =
            planned.flatEntity.position === null
              ? null
              : stripUndefinedJson(planned.flatEntity.position);
          if (
            canonicalAuditJson(afterProj.position) !==
            canonicalAuditJson(expectedPos)
          ) {
            throw new Error(
              'Page layout widget create persisted unexpected position',
            );
          }
        }
        for (const boolKey of ['isActive', 'isSystemSideEffect'] as const) {
          if (
            planned.flatEntity[boolKey] !== undefined &&
            afterProj[boolKey] !== Boolean(planned.flatEntity[boolKey])
          ) {
            throw new Error(
              `Page layout widget create persisted unexpected ${boolKey}`,
            );
          }
        }
        const expectedConfig = resolveExpectedPageLayoutWidgetConfiguration(
          planned.flatEntity,
          {
            fieldMetadatas: effectiveFieldMetadatasMap,
            frontComponents: mappings.frontComponents,
            views: effectiveViewsMap,
            viewFieldGroups: effectiveViewFieldGroupsMap,
          },
        );
        if (
          expectedConfig !== undefined &&
          canonicalAuditJson(afterProj.configuration) !==
            canonicalAuditJson(expectedConfig)
        ) {
          throw new Error(
            'Page layout widget create persisted unexpected configuration',
          );
        }
        const expectedOverrides = resolveExpectedPageLayoutWidgetOverrides(
          planned.flatEntity,
          effectivePageLayoutTabsMap,
        );
        if (
          expectedOverrides !== undefined &&
          canonicalAuditJson(afterProj.overrides) !==
            canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Page layout widget create persisted unexpected overrides',
          );
        }
        audit.record({
          resourceKind: 'pageLayoutWidget',
          resourceId: createdId,
          action: 'create',
          before: null,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'pageLayoutWidget',
            resourceId: createdId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [
        targetId,
        update,
      ] of plannedPageLayoutWidgetUpdates.entries()) {
        const beforeRow = beforePageLayoutWidgets.get(targetId);
        const afterRow = afterPageLayoutWidgets.get(targetId);
        if (!beforeRow || !afterRow) {
          throw new Error(
            'Page layout widget update removed or lost target row',
          );
        }
        if (
          uuid(beforeRow.applicationId) !== uuid(afterRow.applicationId) ||
          uuid(beforeRow.universalIdentifier) !==
            uuid(afterRow.universalIdentifier) ||
          Boolean(beforeRow.isSystemSideEffect) !==
            Boolean(afterRow.isSystemSideEffect)
        ) {
          throw new Error(
            'Page layout widget update modified immutable fields',
          );
        }
        const beforeProj = projectPageLayoutWidget(beforeRow);
        const afterProj = projectPageLayoutWidget(afterRow);
        const resolvedTabId = resolveEffectiveRelationId(
          update,
          'pageLayoutTabId',
          'pageLayoutTabUniversalIdentifier',
          effectivePageLayoutTabsMap,
        );
        const expectedTabId =
          resolvedTabId !== undefined
            ? resolvedTabId
            : beforeProj.pageLayoutTabId;
        if (afterProj.pageLayoutTabId !== expectedTabId) {
          throw new Error(
            'Page layout widget update did not persist expected pageLayoutTabId',
          );
        }
        const resolvedObjId = resolveEffectiveRelationId(
          update,
          'objectMetadataId',
          'objectMetadataUniversalIdentifier',
          effectiveObjectMetadatasMap,
        );
        const expectedObjId =
          resolvedObjId !== undefined
            ? resolvedObjId
            : beforeProj.objectMetadataId;
        if (afterProj.objectMetadataId !== expectedObjId) {
          throw new Error(
            'Page layout widget update did not persist expected objectMetadataId',
          );
        }
        for (const textKey of ['title', 'type'] as const) {
          const expectedVal =
            textKey in update && update[textKey] !== undefined
              ? String(update[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Page layout widget update did not persist expected ${textKey}`,
            );
          }
        }
        const expectedExpr =
          'conditionalAvailabilityExpression' in update &&
          update.conditionalAvailabilityExpression !== undefined
            ? update.conditionalAvailabilityExpression === null
              ? null
              : String(update.conditionalAvailabilityExpression)
            : beforeProj.conditionalAvailabilityExpression;
        if (afterProj.conditionalAvailabilityExpression !== expectedExpr) {
          throw new Error(
            'Page layout widget update did not persist expected conditionalAvailabilityExpression',
          );
        }
        const expectedDisplay =
          'conditionalDisplay' in update &&
          update.conditionalDisplay !== undefined
            ? update.conditionalDisplay === null
              ? null
              : stripUndefinedJson(update.conditionalDisplay)
            : beforeProj.conditionalDisplay;
        if (
          canonicalAuditJson(afterProj.conditionalDisplay) !==
          canonicalAuditJson(expectedDisplay)
        ) {
          throw new Error(
            'Page layout widget update did not persist expected conditionalDisplay',
          );
        }
        const expectedGridPos =
          'gridPosition' in update && update.gridPosition !== undefined
            ? stripUndefinedJson(update.gridPosition)
            : beforeProj.gridPosition;
        if (
          canonicalAuditJson(afterProj.gridPosition) !==
          canonicalAuditJson(expectedGridPos)
        ) {
          throw new Error(
            'Page layout widget update did not persist expected gridPosition',
          );
        }
        const expectedPos =
          'position' in update && update.position !== undefined
            ? update.position === null
              ? null
              : stripUndefinedJson(update.position)
            : beforeProj.position;
        if (
          canonicalAuditJson(afterProj.position) !==
          canonicalAuditJson(expectedPos)
        ) {
          throw new Error(
            'Page layout widget update did not persist expected position',
          );
        }
        const expectedIsActive =
          'isActive' in update && update.isActive !== undefined
            ? Boolean(update.isActive)
            : beforeProj.isActive;
        if (afterProj.isActive !== expectedIsActive) {
          throw new Error(
            'Page layout widget update did not persist expected isActive',
          );
        }
        const resolvedConfig = resolveExpectedPageLayoutWidgetConfiguration(
          update,
          {
            fieldMetadatas: effectiveFieldMetadatasMap,
            frontComponents: mappings.frontComponents,
            views: effectiveViewsMap,
            viewFieldGroups: effectiveViewFieldGroupsMap,
          },
        );
        const expectedConfig =
          resolvedConfig !== undefined
            ? resolvedConfig
            : beforeProj.configuration;
        if (
          canonicalAuditJson(afterProj.configuration) !==
          canonicalAuditJson(expectedConfig)
        ) {
          throw new Error(
            'Page layout widget update did not persist expected configuration',
          );
        }
        const resolvedOverrides = resolveExpectedPageLayoutWidgetOverrides(
          update,
          effectivePageLayoutTabsMap,
        );
        const expectedOverrides =
          resolvedOverrides !== undefined
            ? resolvedOverrides
            : beforeProj.overrides;
        if (
          canonicalAuditJson(afterProj.overrides) !==
          canonicalAuditJson(expectedOverrides)
        ) {
          throw new Error(
            'Page layout widget update did not persist expected overrides',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          audit.record({
            resourceKind: 'pageLayoutWidget',
            resourceId: targetId,
            action: 'update',
            before: beforeProj,
            after: afterProj,
            securityDescriptor: {
              resourceKind: 'pageLayoutWidget',
              resourceId: targetId,
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
          recordedMutations += 1;
        }
      }

      for (const deletedId of effectiveDeletedPageLayoutWidgetIds) {
        const beforeRow = beforePageLayoutWidgets.get(deletedId);
        if (!beforeRow) {
          throw new Error(
            'Page layout widget delete expected row missing before migration',
          );
        }
        if (afterPageLayoutWidgets.has(deletedId)) {
          throw new Error(
            'Page layout widget delete did not remove expected row',
          );
        }
        audit.record({
          resourceKind: 'pageLayoutWidget',
          resourceId: deletedId,
          action: 'delete',
          before: projectPageLayoutWidget(beforeRow),
          after: null,
          securityDescriptor: {
            resourceKind: 'pageLayoutWidget',
            resourceId: deletedId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recordedMutations += 1;
      }

      for (const [id, beforeRow] of beforePageLayoutWidgets.entries()) {
        if (
          effectiveDeletedPageLayoutWidgetIds.has(id) ||
          plannedPageLayoutWidgetUpdates.has(id)
        ) {
          continue;
        }
        const afterRow = afterPageLayoutWidgets.get(id);
        if (!afterRow) {
          throw new Error(
            'Page layout widget audit detected unplanned row deletion',
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
            'Page layout widget audit detected unplanned row mutation',
          );
        }
      }

      expectedPageLayoutWidgetsSerialized = serializePageLayoutWidgetSnapshot(
        afterPageLayoutWidgets,
      );
    }

    if (recordedMutations > 0) {
      const expectedSerialized = touchesNavItems
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
      if (expectedLogicFunctionsSerialized !== undefined) {
        const postFlushLogicFunctions = await readLogicFunctionSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeLogicFunctionSnapshot(postFlushLogicFunctions) !==
          expectedLogicFunctionsSerialized
        ) {
          throw new Error('Logic function state changed during audit flush');
        }
      }
      if (expectedTimelineActivityTypesSerialized !== undefined) {
        const postFlushTimelineActivityTypes =
          await readTimelineActivityTypeSnapshot(
            runner,
            request.workspaceId,
            false,
          );
        if (
          serializeTimelineActivityTypeSnapshot(
            postFlushTimelineActivityTypes,
          ) !== expectedTimelineActivityTypesSerialized
        ) {
          throw new Error(
            'Timeline activity type state changed during audit flush',
          );
        }
      }
      if (expectedCommandMenuItemsSerialized !== undefined) {
        const postFlushCommandMenuItems = await readCommandMenuItemSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializeCommandMenuItemSnapshot(postFlushCommandMenuItems) !==
          expectedCommandMenuItemsSerialized
        ) {
          throw new Error('Command menu item state changed during audit flush');
        }
      }
      if (expectedPageLayoutsSerialized !== undefined) {
        const postFlushPageLayouts = await readPageLayoutSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializePageLayoutSnapshot(postFlushPageLayouts) !==
          expectedPageLayoutsSerialized
        ) {
          throw new Error('Page layout state changed during audit flush');
        }
      }
      if (expectedPageLayoutTabsSerialized !== undefined) {
        const postFlushPageLayoutTabs = await readPageLayoutTabSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializePageLayoutTabSnapshot(postFlushPageLayoutTabs) !==
          expectedPageLayoutTabsSerialized
        ) {
          throw new Error('Page layout tab state changed during audit flush');
        }
      }
      if (expectedPageLayoutWidgetsSerialized !== undefined) {
        const postFlushPageLayoutWidgets = await readPageLayoutWidgetSnapshot(
          runner,
          request.workspaceId,
          false,
        );
        if (
          serializePageLayoutWidgetSnapshot(postFlushPageLayoutWidgets) !==
          expectedPageLayoutWidgetsSerialized
        ) {
          throw new Error(
            'Page layout widget state changed during audit flush',
          );
        }
      }
    }

    return result;
  });
};
