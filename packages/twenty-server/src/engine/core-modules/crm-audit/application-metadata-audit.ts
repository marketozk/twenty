import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  type CrmAuditAction,
  type CrmAuditOperation,
  type CrmAuditResourceKind,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';
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
import {
  assertWorkflowOrViewVisibility,
  persistWorkflowRunShareReconciliationIntent,
} from 'src/engine/core-modules/crm-audit/core-workflow-and-view-audit';
import {
  assertAgentChatChannelRoleRowInvariants,
  assertAgentChatChannelRowInvariants,
  assertNavigationMenuItemRowInvariants,
  assertWebhookRowInvariants,
  computeCascadeDeletedNavigationMenuItemIds,
  projectAgentChatChannel,
  projectAgentChatChannelRole,
  projectNavigationMenuItem,
  projectWebhook,
  scalarNavigationMenuItemWithoutTimestamps,
  type NavigationMenuItemAuditIdentity,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';

const TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER =
  '20202020-64aa-4b6f-b003-9c74b97cee20';

export type ApplicationMetadataAuditIdentity = NavigationMenuItemAuditIdentity;

export type ApplicationMetadataAuditMode =
  | 'manifest'
  | 'objectDelete'
  | 'fieldDelete';

export type ApplicationMetadataAuditRequest = Readonly<{
  workspaceId: string;
  applicationId: string;
  applicationUniversalIdentifier: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  mode?: ApplicationMetadataAuditMode;
  expectedDeletedObjectIds?: readonly string[];
  expectedDeletedFieldId?: string;
  isSystemBuild?: boolean;
}>;

export type CapturedApplicationMetadataAuditOperation = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  mode: ApplicationMetadataAuditMode;
  expectedDeletedObjectIds?: readonly string[];
  expectedDeletedFieldId?: string;
  isSystemBuild: boolean;
}>;

export type ApplicationMetadataAuditMappings = {
  application: { id: string; universalIdentifier: string };
  roles: Record<string, { id: string } | undefined>;
  targets: Record<string, { id: string } | undefined>;
  agents: Record<string, { id: string } | undefined>;
  permissionFlags: Record<string, { id: string } | undefined>;
  rolePermissionFlags: Record<string, { id: string } | undefined>;
  objectMetadatas: Record<string, { id: string } | undefined>;
  fieldMetadatas: Record<string, { id: string } | undefined>;
  objectPermissions: Record<string, { id: string } | undefined>;
  fieldPermissions: Record<string, { id: string } | undefined>;
  rowLevelPermissionPredicates: Record<string, { id: string } | undefined>;
  rowLevelPermissionPredicateGroups: Record<string, { id: string } | undefined>;
  applicationVariables?: Record<string, { id: string } | undefined>;
  workflows?: Record<string, { id: string } | undefined>;
  views?: Record<string, { id: string } | undefined>;
  navigationMenuItems?: Record<string, { id: string } | undefined>;
  pageLayouts?: Record<string, { id: string } | undefined>;
  agentChatChannels?: Record<string, { id: string } | undefined>;
  agentChatChannelRoles?: Record<string, { id: string } | undefined>;
  webhooks?: Record<string, { id: string } | undefined>;
};

type MigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

export const isAuditedWorkflowOrViewUpdateAction = (action: {
  type: string;
  metadataName: string;
  update?: Record<string, unknown>;
}): boolean =>
  action.type === 'update' &&
  (action.metadataName === 'workflow' || action.metadataName === 'view') &&
  Boolean(
    action.update &&
      ('createdByUserWorkspaceId' in action.update ||
        'visibility' in action.update),
  );

export const AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES = new Set<string>([
  'role',
  'roleTarget',
  'rolePermissionFlag',
  'objectPermission',
  'fieldPermission',
  'rowLevelPermissionPredicateGroup',
  'rowLevelPermissionPredicate',
  'navigationMenuItem',
  'agentChatChannel',
  'agentChatChannelRole',
  'webhook',
]);

export const AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES =
  new Set<string>([
    'objectMetadata',
    'fieldMetadata',
    'permissionFlag',
    'agent',
    'applicationVariable',
    'view',
    'pageLayout',
    'agentChatChannel',
  ]);

const ROLE_BOOLEAN_FIELDS = [
  'canUpdateAllSettings',
  'canAccessAllTools',
  'canAccessAllAgentChatChannels',
  'canReadAllObjectRecords',
  'canUpdateAllObjectRecords',
  'canSoftDeleteAllObjectRecords',
  'canDestroyAllObjectRecords',
  'canBeAssignedToUsers',
  'canBeAssignedToAgents',
  'canBeAssignedToApiKeys',
] as const;

const ROLE_TEXT_FIELDS = ['label', 'description', 'icon'] as const;

const storage = new AsyncLocalStorage<ApplicationMetadataAuditRequest>();
const active = new WeakSet<ApplicationMetadataAuditRequest>();
const consumed = new WeakSet<ApplicationMetadataAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Application metadata audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const getApplicationMetadataAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Application metadata audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getApplicationMetadataAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: ApplicationMetadataAuditIdentity | undefined,
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

    const reqLike = identity as Partial<RoleUpdateAuditIdentity> & {
      workspace?: { id: string };
      apiKey?: { id: string } | null;
      user?: { id?: string } | null;
      workspaceMemberId?: string;
      application?: { id: string } | null;
      impersonationContext?: { impersonatorUserWorkspaceId?: string };
    };
    if (
      reqLike &&
      typeof reqLike === 'object' &&
      reqLike.auth === undefined &&
      reqLike.user?.id !== undefined &&
      reqLike.workspaceMemberId === undefined &&
      reqLike.apiKey === undefined &&
      reqLike.application === undefined
    ) {
      const userId = uuid(reqLike.user.id);
      const agentId =
        reqLike.agentId !== undefined ? uuid(reqLike.agentId) : undefined;
      const impersonatorId =
        reqLike.impersonatorUserWorkspaceId ??
        reqLike.impersonationContext?.impersonatorUserWorkspaceId;
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
        ...(impersonatorId
          ? { impersonatorUserWorkspaceId: uuid(impersonatorId) }
          : {}),
      };
    }
    const roleIdentity: RoleUpdateAuditIdentity =
      reqLike && typeof reqLike === 'object' && reqLike.auth !== undefined
        ? (reqLike as RoleUpdateAuditIdentity)
        : {
            auth: reqLike?.apiKey?.id
              ? {
                  workspace: {
                    id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                  },
                  type: 'apiKey',
                  apiKey: { id: reqLike.apiKey.id },
                }
              : reqLike?.workspaceMemberId
                ? {
                    workspace: {
                      id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                    },
                    type: 'user',
                    workspaceMemberId: reqLike.workspaceMemberId,
                  }
                : reqLike?.application?.id
                  ? {
                      workspace: {
                        id: reqLike.workspace?.id ?? normalizedWorkspaceId,
                      },
                      type: 'application',
                      application: { id: reqLike.application.id },
                    }
                  : {
                      workspace: {
                        id: reqLike?.workspace?.id ?? normalizedWorkspaceId,
                      },
                      type: 'pendingActivationUser',
                    },
            agentId: reqLike?.agentId,
            impersonatorUserWorkspaceId:
              reqLike?.impersonatorUserWorkspaceId ??
              reqLike?.impersonationContext?.impersonatorUserWorkspaceId,
          };
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

export const captureApplicationMetadataAuditOperation = ({
  workspaceId,
  auditIdentity,
  mode = 'manifest',
  expectedDeletedObjectIds,
  expectedDeletedFieldId,
  isSystemBuild = false,
  defaultSystemActorId,
}: {
  workspaceId: string;
  auditIdentity?: ApplicationMetadataAuditIdentity;
  mode?: ApplicationMetadataAuditMode;
  expectedDeletedObjectIds?: readonly string[];
  expectedDeletedFieldId?: string;
  isSystemBuild?: boolean;
  defaultSystemActorId?: string;
}): CapturedApplicationMetadataAuditOperation => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getApplicationMetadataAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationMetadataAudit,
    )
  ) {
    throw new Error('Nested application metadata audit is unsupported');
  }

  const normalizedObjectIds =
    expectedDeletedObjectIds !== undefined
      ? Object.freeze(expectedDeletedObjectIds.map((id) => uuid(id)))
      : undefined;
  if (
    mode === 'objectDelete' &&
    normalizedObjectIds !== undefined &&
    new Set(normalizedObjectIds).size !== normalizedObjectIds.length
  ) {
    throw new Error(
      'Application metadata audit duplicate expected object delete ID',
    );
  }
  const normalizedFieldId =
    expectedDeletedFieldId !== undefined
      ? uuid(expectedDeletedFieldId)
      : undefined;

  const resolvedIdentity =
    auditIdentity !== undefined
      ? auditIdentity
      : isSystemBuild &&
          defaultSystemActorId !== undefined &&
          captureCurrentCrmAuditOperation(normalizedWorkspaceId) === undefined
        ? {
            auth: {
              workspace: { id: normalizedWorkspaceId },
              type: 'system' as const,
            },
            systemActorId: defaultSystemActorId,
          }
        : undefined;

  const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
    normalizedWorkspaceId,
    resolvedIdentity,
  );

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    mode,
    ...(normalizedObjectIds !== undefined
      ? { expectedDeletedObjectIds: normalizedObjectIds }
      : {}),
    ...(normalizedFieldId !== undefined
      ? { expectedDeletedFieldId: normalizedFieldId }
      : {}),
    isSystemBuild: Boolean(isSystemBuild),
  });
};

export const bindApplicationMetadataAuditOperation = (
  captured: CapturedApplicationMetadataAuditOperation,
  {
    applicationId,
    applicationUniversalIdentifier,
  }: {
    applicationId: string;
    applicationUniversalIdentifier: string;
  },
): ApplicationMetadataAuditRequest => {
  if (!captured || typeof captured !== 'object') {
    throw new Error('Application metadata audit operation is invalid');
  }
  const normalizedApplicationId = uuid(applicationId);
  const normalizedApplicationUniversalId = uuid(applicationUniversalIdentifier);
  return Object.freeze({
    workspaceId: uuid(captured.workspaceId),
    applicationId: normalizedApplicationId,
    applicationUniversalIdentifier: normalizedApplicationUniversalId,
    operation: captured.operation,
    ...(captured.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            captured.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
    mode: captured.mode,
    ...(captured.expectedDeletedObjectIds !== undefined
      ? {
          expectedDeletedObjectIds: Object.freeze(
            captured.expectedDeletedObjectIds.map((id) => uuid(id)),
          ),
        }
      : {}),
    ...(captured.expectedDeletedFieldId !== undefined
      ? { expectedDeletedFieldId: uuid(captured.expectedDeletedFieldId) }
      : {}),
    isSystemBuild: Boolean(captured.isSystemBuild),
  });
};

export const captureApplicationMetadataAudit = ({
  workspaceId,
  applicationId,
  applicationUniversalIdentifier,
  auditIdentity,
}: {
  workspaceId: string;
  applicationId: string;
  applicationUniversalIdentifier: string;
  auditIdentity?: ApplicationMetadataAuditIdentity;
}): (() => ApplicationMetadataAuditRequest) => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedApplicationId = uuid(applicationId);
  const normalizedApplicationUniversalId = uuid(applicationUniversalIdentifier);
  if (
    getApplicationMetadataAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getApplicationMetadataAudit,
    )
  ) {
    throw new Error('Nested application metadata audit is unsupported');
  }

  try {
    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );
    const request: ApplicationMetadataAuditRequest = Object.freeze({
      workspaceId: normalizedWorkspaceId,
      applicationId: normalizedApplicationId,
      applicationUniversalIdentifier: normalizedApplicationUniversalId,
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

export const withApplicationMetadataAudit = async <TResult>(
  request: ApplicationMetadataAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getApplicationMetadataAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getApplicationMetadataAudit,
    )
  ) {
    throw new Error('Nested application metadata audit is unsupported');
  }

  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

const scalarWithoutTimestamps = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'createdAt' && key !== 'updatedAt',
    ),
  );

const projectRole = (row: Record<string, unknown>) =>
  Object.fromEntries(
    [...ROLE_BOOLEAN_FIELDS, ...ROLE_TEXT_FIELDS].map((key) => [
      key,
      key === 'canAccessAllAgentChatChannels' ? Boolean(row[key]) : row[key],
    ]),
  );

const projectRoleTarget = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  userWorkspaceId: nullableUuid(row.userWorkspaceId),
  agentId: nullableUuid(row.agentId),
  apiKeyId: nullableUuid(row.apiKeyId),
});

const projectRolePermissionFlag = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  permissionFlagId: uuid(row.permissionFlagId),
});

const projectObjectPermission = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  objectMetadataId: uuid(row.objectMetadataId),
  canReadObjectRecords:
    row.canReadObjectRecords === undefined ? null : row.canReadObjectRecords,
  canUpdateObjectRecords:
    row.canUpdateObjectRecords === undefined
      ? null
      : row.canUpdateObjectRecords,
  canSoftDeleteObjectRecords:
    row.canSoftDeleteObjectRecords === undefined
      ? null
      : row.canSoftDeleteObjectRecords,
  canDestroyObjectRecords:
    row.canDestroyObjectRecords === undefined
      ? null
      : row.canDestroyObjectRecords,
});

const projectFieldPermission = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  objectMetadataId: uuid(row.objectMetadataId),
  fieldMetadataId: uuid(row.fieldMetadataId),
  canReadFieldValue:
    row.canReadFieldValue === undefined ? null : row.canReadFieldValue,
  canUpdateFieldValue:
    row.canUpdateFieldValue === undefined ? null : row.canUpdateFieldValue,
});

const projectPredicateGroup = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  objectMetadataId: uuid(row.objectMetadataId),
  parentRowLevelPermissionPredicateGroupId: nullableUuid(
    row.parentRowLevelPermissionPredicateGroupId,
  ),
  logicalOperator: row.logicalOperator,
  positionInRowLevelPermissionPredicateGroup:
    row.positionInRowLevelPermissionPredicateGroup === undefined
      ? null
      : row.positionInRowLevelPermissionPredicateGroup,
  deletedAt: row.deletedAt === undefined ? null : row.deletedAt,
});

const projectPredicate = (row: Record<string, unknown>) => ({
  roleId: uuid(row.roleId),
  objectMetadataId: uuid(row.objectMetadataId),
  fieldMetadataId: uuid(row.fieldMetadataId),
  operand: row.operand,
  value: row.value === undefined ? null : row.value,
  subFieldName: row.subFieldName === undefined ? null : row.subFieldName,
  workspaceMemberFieldMetadataId: nullableUuid(
    row.workspaceMemberFieldMetadataId,
  ),
  workspaceMemberSubFieldName:
    row.workspaceMemberSubFieldName === undefined
      ? null
      : row.workspaceMemberSubFieldName,
  rowLevelPermissionPredicateGroupId: nullableUuid(
    row.rowLevelPermissionPredicateGroupId,
  ),
  positionInRowLevelPermissionPredicateGroup:
    row.positionInRowLevelPermissionPredicateGroup === undefined
      ? null
      : row.positionInRowLevelPermissionPredicateGroup,
  deletedAt: row.deletedAt === undefined ? null : row.deletedAt,
});

const projectUserApplicationVariableValue = (row: Record<string, unknown>) => ({
  userWorkspaceId: uuid(row.userWorkspaceId),
  applicationVariableId: uuid(row.applicationVariableId),
  scope: String(row.scope),
  value: String(row.value),
});

const projectCoreWorkflowOrView = (row: Record<string, unknown>) => ({
  createdByUserWorkspaceId: nullableUuid(row.createdByUserWorkspaceId),
  visibility: assertWorkflowOrViewVisibility(row.visibility),
});

type TableSnapshot = Map<string, Record<string, unknown>>;

type FullMetadataSnapshot = {
  roles: TableSnapshot;
  roleTargets: TableSnapshot;
  rolePermissionFlags: TableSnapshot;
  objectPermissions: TableSnapshot;
  fieldPermissions: TableSnapshot;
  predicateGroups: TableSnapshot;
  predicates: TableSnapshot;
  applicationVariables: TableSnapshot;
  userApplicationVariableValues: TableSnapshot;
};

const readExistingTables = async (
  runner: QueryRunner,
): Promise<Set<string>> => {
  const [reg] = await runner.query(
    `SELECT
      to_regclass('core.role') IS NOT NULL AS "role",
      to_regclass('core."roleTarget"') IS NOT NULL AS "roleTarget",
      to_regclass('core."rolePermissionFlag"') IS NOT NULL AS "rolePermissionFlag",
      to_regclass('core."objectPermission"') IS NOT NULL AS "objectPermission",
      to_regclass('core."fieldPermission"') IS NOT NULL AS "fieldPermission",
      to_regclass('core."rowLevelPermissionPredicateGroup"') IS NOT NULL AS "rowLevelPermissionPredicateGroup",
      to_regclass('core."rowLevelPermissionPredicate"') IS NOT NULL AS "rowLevelPermissionPredicate",
      to_regclass('core.agent') IS NOT NULL AS "agent",
      to_regclass('core."objectMetadata"') IS NOT NULL AS "objectMetadata",
      to_regclass('core."fieldMetadata"') IS NOT NULL AS "fieldMetadata",
      to_regclass('core."permissionFlag"') IS NOT NULL AS "permissionFlag",
      to_regclass('core."applicationVariable"') IS NOT NULL AS "applicationVariable",
      to_regclass('core."userApplicationVariableValue"') IS NOT NULL AS "userApplicationVariableValue",
      to_regclass('core.workflow') IS NOT NULL AS "workflow",
      to_regclass('core.view') IS NOT NULL AS "view",
      to_regclass('core."navigationMenuItem"') IS NOT NULL AS "navigationMenuItem",
      to_regclass('core."pageLayout"') IS NOT NULL AS "pageLayout",
      to_regclass('core."agentChatChannel"') IS NOT NULL AS "agentChatChannel",
      to_regclass('core."agentChatChannelRole"') IS NOT NULL AS "agentChatChannelRole",
      to_regclass('core.webhook') IS NOT NULL AS "webhook"`,
  );
  const existing = new Set<string>();
  for (const [key, present] of Object.entries(reg ?? {})) {
    if (present === true) existing.add(key);
  }
  return existing;
};

const readTableSnapshot = async (
  runner: QueryRunner,
  existingTables: Set<string>,
  tableName: string,
  workspaceId: string,
  lock: boolean,
): Promise<TableSnapshot> => {
  if (!existingTables.has(tableName)) {
    return new Map();
  }
  const rows = await runner.query(
    `SELECT to_jsonb(t) AS row FROM core."${tableName}" t WHERE "workspaceId"=$1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );
  return new Map(
    rows.map((entry: { row: Record<string, unknown> }) => [
      uuid(entry.row.id),
      entry.row,
    ]),
  );
};

const readFullMetadataSnapshot = async (
  runner: QueryRunner,
  existingTables: Set<string>,
  workspaceId: string,
  lock: boolean,
): Promise<FullMetadataSnapshot> => ({
  roles: await readTableSnapshot(
    runner,
    existingTables,
    'role',
    workspaceId,
    lock,
  ),
  roleTargets: await readTableSnapshot(
    runner,
    existingTables,
    'roleTarget',
    workspaceId,
    lock,
  ),
  rolePermissionFlags: await readTableSnapshot(
    runner,
    existingTables,
    'rolePermissionFlag',
    workspaceId,
    lock,
  ),
  objectPermissions: await readTableSnapshot(
    runner,
    existingTables,
    'objectPermission',
    workspaceId,
    lock,
  ),
  fieldPermissions: await readTableSnapshot(
    runner,
    existingTables,
    'fieldPermission',
    workspaceId,
    lock,
  ),
  predicateGroups: await readTableSnapshot(
    runner,
    existingTables,
    'rowLevelPermissionPredicateGroup',
    workspaceId,
    lock,
  ),
  predicates: await readTableSnapshot(
    runner,
    existingTables,
    'rowLevelPermissionPredicate',
    workspaceId,
    lock,
  ),
  applicationVariables: await readTableSnapshot(
    runner,
    existingTables,
    'applicationVariable',
    workspaceId,
    lock,
  ),
  userApplicationVariableValues: await readTableSnapshot(
    runner,
    existingTables,
    'userApplicationVariableValue',
    workspaceId,
    lock,
  ),
});

const serializeFullSnapshot = (snapshot: FullMetadataSnapshot): string =>
  canonicalAuditJson(
    Object.fromEntries(
      Object.entries(snapshot).map(([tableKey, map]) => [
        tableKey,
        [...map.entries()].map(([id, row]) => [
          id,
          scalarWithoutTimestamps(row),
        ]),
      ]),
    ),
  );

const resolveMappedIds = (
  actions: MigrationAction[],
  metadataName: string,
  type: 'create' | 'update' | 'delete',
  mappingRecord: Record<string, { id: string } | undefined>,
  expectedApplicationUniversalIdentifier?: string,
): Set<string> => {
  const matched = actions.filter(
    (action) => action.metadataName === metadataName && action.type === type,
  );
  const ids = new Set<string>();
  for (const action of matched) {
    if (type === 'create') {
      if (!action.id || !action.flatEntity) {
        throw new Error(
          `Application metadata audit requires enriched ${metadataName} create action`,
        );
      }
      if (
        expectedApplicationUniversalIdentifier !== undefined &&
        uuid(action.flatEntity.applicationUniversalIdentifier) !==
          expectedApplicationUniversalIdentifier
      ) {
        throw new Error(
          `Application metadata audit ${metadataName} create belongs to another application`,
        );
      }
      const id = uuid(action.id);
      if (ids.has(id)) {
        throw new Error(
          `Application metadata audit duplicate ${metadataName} create ID`,
        );
      }
      ids.add(id);
    } else {
      const universalIdentifier = uuid(action.universalIdentifier);
      const mappedId = mappingRecord[universalIdentifier]?.id;
      if (!mappedId) {
        throw new Error(
          `Application metadata audit missing ${metadataName} ${type} mapping`,
        );
      }
      const id = uuid(mappedId);
      if (ids.has(id)) {
        throw new Error(
          `Application metadata audit duplicate ${metadataName} ${type} ID`,
        );
      }
      ids.add(id);
    }
  }
  return ids;
};

export const runAuditedApplicationMetadataMigration = async <TResult>(
  dataSource: DataSource | undefined,
  request: ApplicationMetadataAuditRequest,
  actions: MigrationAction[],
  mappings: ApplicationMetadataAuditMappings | undefined,
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    !active.has(request) ||
    consumed.has(request) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getApplicationMetadataAudit,
    )
  ) {
    throw new Error('Application metadata audit scope is invalid or reused');
  }
  if (!dataSource) {
    throw new Error('Application metadata audit requires core DataSource');
  }
  if (
    !mappings?.application?.id ||
    !mappings?.application?.universalIdentifier ||
    uuid(mappings.application.id) !== request.applicationId ||
    uuid(mappings.application.universalIdentifier) !==
      request.applicationUniversalIdentifier
  ) {
    throw new Error('Application metadata audit application mapping mismatch');
  }

  consumed.add(request);
  const { workspaceId, applicationId, applicationUniversalIdentifier } =
    request;
  const isStandardApplication =
    applicationUniversalIdentifier ===
    TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER;

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");

    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null) {
      throw new Error('Application metadata audit workspace unavailable');
    }
    const workspaceDefaultRoleId = nullableUuid(workspace.defaultRoleId);

    const appRows = await runner.query(
      `SELECT id,"universalIdentifier",to_jsonb(a)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a."workspaceId"=$1 ORDER BY id FOR UPDATE`,
      [workspaceId],
    );
    const targetApp = appRows.find(
      (row: { id: string }) => uuid(row.id) === applicationId,
    );
    if (
      !targetApp ||
      targetApp.deletedAt !== null ||
      uuid(targetApp.universalIdentifier) !== applicationUniversalIdentifier
    ) {
      throw new Error('Application metadata audit application unavailable');
    }
    const otherAppDefaultRoleIds = new Set<string>(
      appRows
        .filter(
          (row: { id: string; deletedAt: string | null }) =>
            uuid(row.id) !== applicationId && row.deletedAt === null,
        )
        .map((row: { defaultRoleId: string | null }) =>
          nullableUuid(row.defaultRoleId),
        )
        .filter((id: string | null): id is string => id !== null),
    );

    const existingTables = await readExistingTables(runner);
    for (const action of actions) {
      if (
        AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES.has(action.metadataName) &&
        !existingTables.has(action.metadataName)
      ) {
        throw new Error(
          `Application metadata audit table ${action.metadataName} is unavailable`,
        );
      }
    }

    const mode = request.mode ?? 'manifest';
    const standardAppRow = appRows.find(
      (row: { universalIdentifier: string; deletedAt: string | null }) =>
        row.deletedAt === null &&
        uuid(row.universalIdentifier) ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
    );
    const standardAppId = standardAppRow ? uuid(standardAppRow.id) : null;

    if (
      (mode === 'objectDelete' || mode === 'fieldDelete') &&
      (!existingTables.has('objectMetadata') ||
        !existingTables.has('fieldMetadata'))
    ) {
      throw new Error(
        'Application metadata audit objectMetadata or fieldMetadata table is unavailable',
      );
    }

    const before = await readFullMetadataSnapshot(
      runner,
      existingTables,
      workspaceId,
      true,
    );

    const beforeObjects =
      mode === 'objectDelete' || mode === 'fieldDelete'
        ? await readTableSnapshot(
            runner,
            existingTables,
            'objectMetadata',
            workspaceId,
            true,
          )
        : new Map<string, Record<string, unknown>>();
    const beforeFields =
      mode === 'objectDelete' || mode === 'fieldDelete'
        ? await readTableSnapshot(
            runner,
            existingTables,
            'fieldMetadata',
            workspaceId,
            true,
          )
        : new Map<string, Record<string, unknown>>();

    const plannedRoleCreates = resolveMappedIds(
      actions,
      'role',
      'create',
      mappings.roles,
      applicationUniversalIdentifier,
    );
    const plannedRoleUpdates = resolveMappedIds(
      actions,
      'role',
      'update',
      mappings.roles,
    );
    const plannedRoleDeletes = resolveMappedIds(
      actions,
      'role',
      'delete',
      mappings.roles,
    );

    for (const action of actions) {
      if (action.metadataName !== 'role') continue;
      if (action.type === 'create') {
        const flatEntity = action.flatEntity!;
        if (flatEntity.isEditable === false) {
          if (
            !isStandardApplication ||
            request.operation.actor.kind !== 'system'
          ) {
            throw new Error(
              'Non-editable role creation requires system twenty-standard sync',
            );
          }
        } else if (flatEntity.isEditable !== true) {
          throw new Error(
            'Application metadata role requires boolean isEditable',
          );
        }
      } else if (action.type === 'update') {
        const id = uuid(mappings.roles[uuid(action.universalIdentifier)]?.id);
        const existingRole = before.roles.get(id);
        if (
          !existingRole ||
          uuid(existingRole.applicationId) !== applicationId ||
          (!isStandardApplication &&
            (existingRole.isEditable !== true ||
              action.update?.isEditable === false))
        ) {
          throw new Error(
            'Application metadata role update targets an unavailable or non-editable role',
          );
        }
      } else if (action.type === 'delete') {
        const id = uuid(mappings.roles[uuid(action.universalIdentifier)]?.id);
        const existingRole = before.roles.get(id);
        if (
          !existingRole ||
          uuid(existingRole.applicationId) !== applicationId ||
          (!isStandardApplication && existingRole.isEditable !== true)
        ) {
          throw new Error(
            'Application metadata role delete targets an unavailable or non-editable role',
          );
        }
        if (id === workspaceDefaultRoleId || otherAppDefaultRoleIds.has(id)) {
          throw new Error(
            'Application metadata audit cannot delete an active default role',
          );
        }
      }
    }

    const plannedTargetCreates = resolveMappedIds(
      actions,
      'roleTarget',
      'create',
      mappings.targets,
      applicationUniversalIdentifier,
    );
    const plannedTargetUpdates = resolveMappedIds(
      actions,
      'roleTarget',
      'update',
      mappings.targets,
    );
    const plannedTargetDeletes = resolveMappedIds(
      actions,
      'roleTarget',
      'delete',
      mappings.targets,
    );

    const plannedAgentDeletes = resolveMappedIds(
      actions,
      'agent',
      'delete',
      mappings.agents,
    );
    const plannedObjectDeletes = resolveMappedIds(
      actions,
      'objectMetadata',
      'delete',
      mappings.objectMetadatas,
    );
    const plannedFieldDeletes = resolveMappedIds(
      actions,
      'fieldMetadata',
      'delete',
      mappings.fieldMetadatas,
    );
    const plannedPermissionFlagDeletes = resolveMappedIds(
      actions,
      'permissionFlag',
      'delete',
      mappings.permissionFlags,
    );
    const plannedApplicationVariableDeletes = resolveMappedIds(
      actions,
      'applicationVariable',
      'delete',
      mappings.applicationVariables ?? {},
    );

    const auditedWorkflowUpdateActions = actions.filter(
      (action) =>
        action.metadataName === 'workflow' &&
        isAuditedWorkflowOrViewUpdateAction(action),
    );
    const auditedViewUpdateActions = actions.filter(
      (action) =>
        action.metadataName === 'view' &&
        isAuditedWorkflowOrViewUpdateAction(action),
    );
    const plannedAuditedWorkflowUpdates = new Set<string>();
    for (const action of auditedWorkflowUpdateActions) {
      if (mode !== 'manifest') {
        throw new Error(
          'Application metadata objectDelete/fieldDelete cannot mutate workflow visibility or creator',
        );
      }
      if (!existingTables.has('workflow')) {
        throw new Error(
          'Application metadata audit table workflow is unavailable',
        );
      }
      const mappedId =
        mappings.workflows?.[uuid(action.universalIdentifier)]?.id;
      if (!mappedId) {
        throw new Error(
          'Application metadata audit missing workflow update mapping',
        );
      }
      plannedAuditedWorkflowUpdates.add(uuid(mappedId));
    }
    const plannedAuditedViewUpdates = new Set<string>();
    for (const action of auditedViewUpdateActions) {
      if (mode !== 'manifest') {
        throw new Error(
          'Application metadata objectDelete/fieldDelete cannot mutate view visibility or creator',
        );
      }
      if (!existingTables.has('view')) {
        throw new Error('Application metadata audit table view is unavailable');
      }
      const mappedId = mappings.views?.[uuid(action.universalIdentifier)]?.id;
      if (!mappedId) {
        throw new Error(
          'Application metadata audit missing view update mapping',
        );
      }
      plannedAuditedViewUpdates.add(uuid(mappedId));
    }

    const hasWorkflowTable = existingTables.has('workflow');
    const hasViewTable = existingTables.has('view');
    const beforeWorkflows = hasWorkflowTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'workflow',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const wfId of plannedAuditedWorkflowUpdates) {
      const beforeWf = beforeWorkflows.get(wfId);
      if (
        !beforeWf ||
        beforeWf.deletedAt !== null ||
        uuid(beforeWf.applicationId) !== applicationId
      ) {
        throw new Error(
          'Application metadata audit cannot update missing or foreign workflow',
        );
      }
    }

    const beforeViews = hasViewTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'view',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const viewId of plannedAuditedViewUpdates) {
      const beforeVw = beforeViews.get(viewId);
      if (
        !beforeVw ||
        beforeVw.deletedAt !== null ||
        uuid(beforeVw.applicationId) !== applicationId
      ) {
        throw new Error(
          'Application metadata audit cannot update missing or foreign view',
        );
      }
    }

    const hasNavTable = existingTables.has('navigationMenuItem');
    const hasPageLayoutTable = existingTables.has('pageLayout');
    const beforeNavigationMenuItems = hasNavTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'navigationMenuItem',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const navRow of beforeNavigationMenuItems.values()) {
      assertNavigationMenuItemRowInvariants(navRow, workspaceId);
    }
    const beforePageLayouts = hasPageLayoutTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'pageLayout',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();

    const plannedViewDeletes = resolveMappedIds(
      actions,
      'view',
      'delete',
      mappings.views ?? {},
    );
    const plannedPageLayoutDeletes = resolveMappedIds(
      actions,
      'pageLayout',
      'delete',
      mappings.pageLayouts ?? {},
    );
    const plannedAgentChatChannelDeletes = resolveMappedIds(
      actions,
      'agentChatChannel',
      'delete',
      mappings.agentChatChannels ?? {},
    );
    const plannedAgentChatChannelUpdates = resolveMappedIds(
      actions,
      'agentChatChannel',
      'update',
      mappings.agentChatChannels ?? {},
    );
    const plannedAgentChatChannelRoleDeletes = resolveMappedIds(
      actions,
      'agentChatChannelRole',
      'delete',
      mappings.agentChatChannelRoles ?? {},
    );
    if (
      actions.some(
        (action) =>
          action.metadataName === 'agentChatChannelRole' &&
          action.type === 'update',
      )
    ) {
      throw new Error(
        'Application metadata agentChatChannelRole cannot be updated',
      );
    }

    const hasChannelTable = existingTables.has('agentChatChannel');
    const hasChannelRoleTable = existingTables.has('agentChatChannelRole');
    const beforeAgentChatChannels = hasChannelTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'agentChatChannel',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const channelRow of beforeAgentChatChannels.values()) {
      assertAgentChatChannelRowInvariants(channelRow, workspaceId);
    }
    const beforeAgentChatChannelRoles = hasChannelRoleTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'agentChatChannelRole',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const channelRoleRow of beforeAgentChatChannelRoles.values()) {
      assertAgentChatChannelRoleRowInvariants(channelRoleRow, workspaceId);
    }

    const plannedAgentChatChannelCreatesByUniversalId = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedAgentChatChannelUpdatePayloads = new Map<
      string,
      Record<string, unknown>
    >();
    const plannedAgentChatChannelRoleCreatesByUniversalId = new Map<
      string,
      {
        id?: string;
        channelUniversalIdentifier: string;
        roleUniversalIdentifier: string;
        flatEntity: Record<string, unknown>;
      }
    >();

    for (const action of actions) {
      if (action.metadataName === 'agentChatChannel') {
        if (action.type === 'create') {
          if (!hasChannelTable) {
            throw new Error(
              'Application metadata audit table agentChatChannel is unavailable',
            );
          }
          if (!action.flatEntity) {
            throw new Error(
              'Application metadata audit requires flatEntity on agentChatChannel create action',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedAgentChatChannelCreatesByUniversalId.has(universalId)) {
            throw new Error(
              'Application metadata audit duplicate agentChatChannel create universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Application metadata audit agentChatChannel create belongs to another application',
            );
          }
          const explicitId =
            action.id !== undefined ? uuid(action.id) : undefined;
          if (
            explicitId !== undefined &&
            beforeAgentChatChannels.has(explicitId)
          ) {
            throw new Error(
              'Application metadata audit agentChatChannel create ID already exists',
            );
          }
          plannedAgentChatChannelCreatesByUniversalId.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.agentChatChannels?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Application metadata audit agentChatChannel update missing mapping or update payload',
            );
          }
          plannedAgentChatChannelUpdatePayloads.set(
            uuid(mappedId),
            action.update,
          );
        }
      } else if (
        action.metadataName === 'agentChatChannelRole' &&
        action.type === 'create'
      ) {
        if (!hasChannelRoleTable) {
          throw new Error(
            'Application metadata audit table agentChatChannelRole is unavailable',
          );
        }
        if (!action.flatEntity) {
          throw new Error(
            'Application metadata audit requires flatEntity on agentChatChannelRole create action',
          );
        }
        const universalId = uuid(action.flatEntity.universalIdentifier);
        if (plannedAgentChatChannelRoleCreatesByUniversalId.has(universalId)) {
          throw new Error(
            'Application metadata audit duplicate agentChatChannelRole create universalIdentifier',
          );
        }
        if (
          action.flatEntity.applicationUniversalIdentifier !== undefined &&
          uuid(action.flatEntity.applicationUniversalIdentifier) !==
            applicationUniversalIdentifier
        ) {
          throw new Error(
            'Application metadata audit agentChatChannelRole create belongs to another application',
          );
        }
        const explicitId =
          action.id !== undefined ? uuid(action.id) : undefined;
        if (
          explicitId !== undefined &&
          beforeAgentChatChannelRoles.has(explicitId)
        ) {
          throw new Error(
            'Application metadata audit agentChatChannelRole create ID already exists',
          );
        }
        plannedAgentChatChannelRoleCreatesByUniversalId.set(universalId, {
          ...(explicitId !== undefined ? { id: explicitId } : {}),
          channelUniversalIdentifier: uuid(
            action.flatEntity.channelUniversalIdentifier,
          ),
          roleUniversalIdentifier: uuid(
            action.flatEntity.roleUniversalIdentifier,
          ),
          flatEntity: action.flatEntity,
        });
      }
    }

    for (const channelId of plannedAgentChatChannelUpdates) {
      const beforeCh = beforeAgentChatChannels.get(channelId);
      if (!beforeCh || uuid(beforeCh.applicationId) !== applicationId) {
        throw new Error(
          'Application metadata audit cannot update missing or foreign agentChatChannel',
        );
      }
    }
    for (const channelId of plannedAgentChatChannelDeletes) {
      const beforeCh = beforeAgentChatChannels.get(channelId);
      if (!beforeCh || uuid(beforeCh.applicationId) !== applicationId) {
        throw new Error(
          'Application metadata audit cannot delete missing or foreign agentChatChannel',
        );
      }
      if (
        beforeCh.isCustom !== true &&
        !isStandardApplication &&
        request.isSystemBuild !== true
      ) {
        throw new Error(
          'Application metadata audit cannot delete standard agentChatChannel',
        );
      }
    }
    for (const channelRoleId of plannedAgentChatChannelRoleDeletes) {
      const beforeCr = beforeAgentChatChannelRoles.get(channelRoleId);
      if (!beforeCr) {
        throw new Error(
          'Application metadata audit cannot delete missing agentChatChannelRole',
        );
      }
      const isPlannedCascade =
        plannedRoleDeletes.has(uuid(beforeCr.roleId)) ||
        plannedAgentChatChannelDeletes.has(uuid(beforeCr.channelId));
      if (uuid(beforeCr.applicationId) !== applicationId && !isPlannedCascade) {
        throw new Error(
          'Application metadata audit cannot delete foreign agentChatChannelRole',
        );
      }
    }

    const hasWebhookTable = existingTables.has('webhook');
    const beforeWebhooks = hasWebhookTable
      ? await readTableSnapshot(
          runner,
          existingTables,
          'webhook',
          workspaceId,
          true,
        )
      : new Map<string, Record<string, unknown>>();
    for (const webhookRow of beforeWebhooks.values()) {
      assertWebhookRowInvariants(webhookRow, workspaceId);
    }

    const plannedWebhookCreatesByUniversalId = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    const plannedWebhookUpdatePayloads = new Map<
      string,
      Record<string, unknown>
    >();
    for (const action of actions) {
      if (action.metadataName === 'webhook') {
        if (action.type === 'create') {
          if (!hasWebhookTable) {
            throw new Error(
              'Application metadata audit table webhook is unavailable',
            );
          }
          if (!action.flatEntity) {
            throw new Error(
              'Application metadata audit requires flatEntity on webhook create action',
            );
          }
          const universalId = uuid(action.flatEntity.universalIdentifier);
          if (plannedWebhookCreatesByUniversalId.has(universalId)) {
            throw new Error(
              'Application metadata audit duplicate webhook create universalIdentifier',
            );
          }
          if (
            action.flatEntity.applicationUniversalIdentifier !== undefined &&
            uuid(action.flatEntity.applicationUniversalIdentifier) !==
              applicationUniversalIdentifier
          ) {
            throw new Error(
              'Application metadata audit webhook create belongs to another application',
            );
          }
          const explicitId =
            action.id !== undefined ? uuid(action.id) : undefined;
          if (explicitId !== undefined && beforeWebhooks.has(explicitId)) {
            throw new Error(
              'Application metadata audit webhook create ID already exists',
            );
          }
          plannedWebhookCreatesByUniversalId.set(universalId, {
            ...(explicitId !== undefined ? { id: explicitId } : {}),
            flatEntity: action.flatEntity,
          });
        } else if (action.type === 'update') {
          const universalId = uuid(action.universalIdentifier);
          const mappedId = mappings.webhooks?.[universalId]?.id;
          if (!mappedId || !action.update) {
            throw new Error(
              'Application metadata audit webhook update missing mapping or update payload',
            );
          }
          plannedWebhookUpdatePayloads.set(uuid(mappedId), action.update);
        }
      }
    }
    const plannedWebhookUpdates = resolveMappedIds(
      actions,
      'webhook',
      'update',
      mappings.webhooks ?? {},
    );
    const plannedWebhookDeletes = resolveMappedIds(
      actions,
      'webhook',
      'delete',
      mappings.webhooks ?? {},
    );
    for (const webhookId of plannedWebhookUpdates) {
      const beforeWh = beforeWebhooks.get(webhookId);
      if (!beforeWh || uuid(beforeWh.applicationId) !== applicationId) {
        throw new Error(
          'Application metadata audit cannot update missing or foreign webhook',
        );
      }
    }
    for (const webhookId of plannedWebhookDeletes) {
      const beforeWh = beforeWebhooks.get(webhookId);
      if (!beforeWh || uuid(beforeWh.applicationId) !== applicationId) {
        throw new Error(
          'Application metadata audit cannot delete missing or foreign webhook',
        );
      }
    }

    const plannedNavCreatesByUniversalIdentifier = new Map<
      string,
      { id?: string; flatEntity: Record<string, unknown> }
    >();
    for (const action of actions) {
      if (
        action.metadataName === 'navigationMenuItem' &&
        action.type === 'create'
      ) {
        if (!hasNavTable) {
          throw new Error(
            'Application metadata audit table navigationMenuItem is unavailable',
          );
        }
        if (!action.flatEntity) {
          throw new Error(
            'Application metadata audit requires flatEntity on navigationMenuItem create action',
          );
        }
        const universalId = uuid(action.flatEntity.universalIdentifier);
        if (plannedNavCreatesByUniversalIdentifier.has(universalId)) {
          throw new Error(
            'Application metadata audit duplicate navigationMenuItem create universalIdentifier',
          );
        }
        if (
          action.flatEntity.applicationUniversalIdentifier !== undefined &&
          uuid(action.flatEntity.applicationUniversalIdentifier) !==
            applicationUniversalIdentifier
        ) {
          throw new Error(
            'Application metadata audit navigationMenuItem create belongs to another application',
          );
        }
        const explicitId =
          action.id !== undefined ? uuid(action.id) : undefined;
        if (
          explicitId !== undefined &&
          beforeNavigationMenuItems.has(explicitId)
        ) {
          throw new Error(
            'Application metadata audit navigationMenuItem create ID already exists',
          );
        }
        plannedNavCreatesByUniversalIdentifier.set(universalId, {
          ...(explicitId !== undefined ? { id: explicitId } : {}),
          flatEntity: action.flatEntity,
        });
      }
    }
    const plannedNavUpdatePayloads = new Map<string, Record<string, unknown>>();
    for (const action of actions) {
      if (
        action.metadataName === 'navigationMenuItem' &&
        action.type === 'update'
      ) {
        const universalId = uuid(action.universalIdentifier);
        const mappedId = mappings.navigationMenuItems?.[universalId]?.id;
        if (!mappedId || !action.update) {
          throw new Error(
            'Application metadata audit navigationMenuItem update missing mapping or update payload',
          );
        }
        plannedNavUpdatePayloads.set(uuid(mappedId), action.update);
      }
    }
    const plannedNavUpdates = resolveMappedIds(
      actions,
      'navigationMenuItem',
      'update',
      mappings.navigationMenuItems ?? {},
    );
    const plannedNavDeletes = resolveMappedIds(
      actions,
      'navigationMenuItem',
      'delete',
      mappings.navigationMenuItems ?? {},
    );
    if (
      (plannedNavUpdates.size > 0 || plannedNavDeletes.size > 0) &&
      !hasNavTable
    ) {
      throw new Error(
        'Application metadata audit table navigationMenuItem is unavailable',
      );
    }
    for (const navId of plannedNavUpdates) {
      const beforeNav = beforeNavigationMenuItems.get(navId);
      if (!beforeNav || uuid(beforeNav.applicationId) !== applicationId) {
        throw new Error(
          'Application metadata audit cannot update missing or foreign navigationMenuItem',
        );
      }
    }
    const parentCascadeDeletedNavIds =
      computeCascadeDeletedNavigationMenuItemIds({
        beforeNavigationMenuItems,
        plannedNavDeletes: new Set<string>(),
        plannedObjectDeletes,
        plannedFieldDeletes,
        plannedViewDeletes,
        plannedPageLayoutDeletes,
        plannedAgentChatChannelDeletes,
        beforeViews,
        beforePageLayouts,
      });
    const cascadeDeletedNavIds = computeCascadeDeletedNavigationMenuItemIds({
      beforeNavigationMenuItems,
      plannedNavDeletes,
      plannedObjectDeletes,
      plannedFieldDeletes,
      plannedViewDeletes,
      plannedPageLayoutDeletes,
      plannedAgentChatChannelDeletes,
      beforeViews,
      beforePageLayouts,
    });
    for (const navId of plannedNavDeletes) {
      const beforeNav = beforeNavigationMenuItems.get(navId);
      if (!beforeNav) {
        throw new Error(
          'Application metadata audit cannot delete missing navigationMenuItem',
        );
      }
      if (mode === 'objectDelete' || mode === 'fieldDelete') {
        if (!parentCascadeDeletedNavIds.has(navId)) {
          throw new Error(
            `Application metadata ${mode} cannot delete unrelated navigationMenuItem`,
          );
        }
      } else if (
        uuid(beforeNav.applicationId) !== applicationId &&
        !parentCascadeDeletedNavIds.has(navId)
      ) {
        throw new Error(
          'Application metadata audit cannot delete foreign navigationMenuItem',
        );
      }
    }

    if (plannedApplicationVariableDeletes.size > 0) {
      if (!existingTables.has('applicationVariable')) {
        throw new Error(
          'Application metadata audit table applicationVariable is unavailable',
        );
      }
      for (const varId of plannedApplicationVariableDeletes) {
        const beforeVar = before.applicationVariables.get(varId);
        if (!beforeVar || uuid(beforeVar.applicationId) !== applicationId) {
          throw new Error(
            'Application metadata audit cannot delete missing or foreign applicationVariable',
          );
        }
      }
      if (existingTables.has('userApplicationVariableValue')) {
        const [foreignVarVal] = await runner.query(
          `SELECT id FROM core."userApplicationVariableValue" WHERE "applicationVariableId"=ANY($1::uuid[]) AND "workspaceId"<>$2 LIMIT 1`,
          [[...plannedApplicationVariableDeletes], workspaceId],
        );
        if (foreignVarVal) {
          throw new Error(
            'Application metadata audit detected cross-workspace userApplicationVariableValue',
          );
        }
      }
    }

    if (mode === 'objectDelete') {
      const expectedIds = request.expectedDeletedObjectIds ?? [];
      if (
        expectedIds.length === 0 ||
        plannedObjectDeletes.size !== expectedIds.length ||
        expectedIds.some((id) => !plannedObjectDeletes.has(uuid(id)))
      ) {
        throw new Error(
          'Application metadata objectDelete plan does not match expected object IDs',
        );
      }
      for (const action of actions) {
        if (
          action.metadataName === 'role' ||
          action.metadataName === 'roleTarget' ||
          action.metadataName === 'agent' ||
          action.metadataName === 'permissionFlag' ||
          action.metadataName === 'rolePermissionFlag' ||
          action.metadataName === 'applicationVariable' ||
          action.metadataName === 'agentChatChannel' ||
          action.metadataName === 'agentChatChannelRole' ||
          action.metadataName === 'webhook'
        ) {
          throw new Error(
            'Application metadata objectDelete cannot mutate roles, targets, agents, or permission flags',
          );
        }
        if (
          (action.metadataName === 'objectMetadata' ||
            action.metadataName === 'fieldMetadata' ||
            action.metadataName === 'objectPermission' ||
            action.metadataName === 'fieldPermission' ||
            action.metadataName === 'rowLevelPermissionPredicateGroup' ||
            action.metadataName === 'rowLevelPermissionPredicate' ||
            action.metadataName === 'view' ||
            action.metadataName === 'pageLayout' ||
            action.metadataName === 'navigationMenuItem') &&
          action.type !== 'delete'
        ) {
          throw new Error(
            'Application metadata objectDelete allows only delete actions on object, field, and permission metadata',
          );
        }
      }
      for (const viewId of plannedViewDeletes) {
        const viewRow = beforeViews.get(viewId);
        const objId = viewRow ? nullableUuid(viewRow.objectMetadataId) : null;
        const calendarFieldId = viewRow
          ? nullableUuid(viewRow.calendarFieldMetadataId)
          : null;
        const mainGroupByFieldId = viewRow
          ? nullableUuid(viewRow.mainGroupByFieldMetadataId)
          : null;
        if (
          !viewRow ||
          ((objId === null || !plannedObjectDeletes.has(objId)) &&
            (calendarFieldId === null ||
              !plannedFieldDeletes.has(calendarFieldId)) &&
            (mainGroupByFieldId === null ||
              !plannedFieldDeletes.has(mainGroupByFieldId)))
        ) {
          throw new Error(
            'Application metadata objectDelete cannot delete unrelated view',
          );
        }
      }
      for (const layoutId of plannedPageLayoutDeletes) {
        const layoutRow = beforePageLayouts.get(layoutId);
        const objId = layoutRow
          ? nullableUuid(layoutRow.objectMetadataId)
          : null;
        if (!layoutRow || objId === null || !plannedObjectDeletes.has(objId)) {
          throw new Error(
            'Application metadata objectDelete cannot delete unrelated pageLayout',
          );
        }
      }
      for (const objId of plannedObjectDeletes) {
        const objRow = beforeObjects.get(objId);
        if (!objRow) {
          throw new Error(
            'Application metadata objectDelete target object unavailable',
          );
        }
        if (
          !request.isSystemBuild &&
          (objRow.isSystem === true ||
            (standardAppId !== null &&
              uuid(objRow.applicationId) === standardAppId))
        ) {
          throw new Error(
            'Application metadata objectDelete cannot delete standard or system object',
          );
        }
      }
      for (const [fieldId, fieldRow] of beforeFields.entries()) {
        const fieldObjectId = uuid(fieldRow.objectMetadataId);
        const targetObjectId = nullableUuid(
          fieldRow.relationTargetObjectMetadataId,
        );
        if (
          (plannedObjectDeletes.has(fieldObjectId) ||
            (targetObjectId !== null &&
              plannedObjectDeletes.has(targetObjectId))) &&
          !plannedFieldDeletes.has(fieldId)
        ) {
          throw new Error(
            'Application metadata objectDelete detected unplanned fieldMetadata cascade',
          );
        }
      }
      const deletedMorphHeadKeys = new Set<string>();
      for (const fieldId of plannedFieldDeletes) {
        const fieldRow = beforeFields.get(fieldId);
        if (!fieldRow) {
          throw new Error(
            'Application metadata objectDelete target field unavailable',
          );
        }
        const morphId = nullableUuid(fieldRow.morphId);
        const fieldUid = uuid(fieldRow.universalIdentifier);
        if (morphId !== null && morphId !== fieldUid) {
          const objId = uuid(fieldRow.objectMetadataId);
          const hasSurvivingTarget = [...beforeFields.entries()].some(
            ([otherId, otherRow]) =>
              !plannedFieldDeletes.has(otherId) &&
              uuid(otherRow.objectMetadataId) === objId &&
              nullableUuid(otherRow.morphId) === morphId &&
              uuid(otherRow.universalIdentifier) !== morphId,
          );
          if (!hasSurvivingTarget) {
            deletedMorphHeadKeys.add(`${objId}:${morphId}`);
          }
        }
      }
      for (const fieldId of plannedFieldDeletes) {
        const fieldRow = beforeFields.get(fieldId)!;
        const fieldObjectId = uuid(fieldRow.objectMetadataId);
        const targetObjectId = nullableUuid(
          fieldRow.relationTargetObjectMetadataId,
        );
        const targetFieldId = nullableUuid(
          fieldRow.relationTargetFieldMetadataId,
        );
        const fieldUid = uuid(fieldRow.universalIdentifier);
        const isAllowed =
          plannedObjectDeletes.has(fieldObjectId) ||
          (targetObjectId !== null &&
            plannedObjectDeletes.has(targetObjectId)) ||
          (targetFieldId !== null && plannedFieldDeletes.has(targetFieldId)) ||
          deletedMorphHeadKeys.has(`${fieldObjectId}:${fieldUid}`);
        if (!isAllowed) {
          throw new Error(
            'Application metadata objectDelete detected unauthorized fieldMetadata deletion',
          );
        }
      }
    } else if (mode === 'fieldDelete') {
      const expectedFieldId = request.expectedDeletedFieldId
        ? uuid(request.expectedDeletedFieldId)
        : undefined;
      if (
        !expectedFieldId ||
        plannedObjectDeletes.size > 0 ||
        !plannedFieldDeletes.has(expectedFieldId)
      ) {
        throw new Error(
          'Application metadata fieldDelete plan does not match expected field ID',
        );
      }
      for (const action of actions) {
        if (
          action.metadataName === 'role' ||
          action.metadataName === 'roleTarget' ||
          action.metadataName === 'agent' ||
          action.metadataName === 'permissionFlag' ||
          action.metadataName === 'rolePermissionFlag' ||
          action.metadataName === 'objectMetadata' ||
          action.metadataName === 'objectPermission' ||
          action.metadataName === 'rowLevelPermissionPredicateGroup' ||
          action.metadataName === 'applicationVariable' ||
          action.metadataName === 'pageLayout' ||
          action.metadataName === 'agentChatChannel' ||
          action.metadataName === 'agentChatChannelRole' ||
          action.metadataName === 'webhook'
        ) {
          throw new Error(
            'Application metadata fieldDelete cannot mutate roles, objects, object permissions, or predicate groups',
          );
        }
        if (
          (action.metadataName === 'fieldMetadata' ||
            action.metadataName === 'fieldPermission' ||
            action.metadataName === 'rowLevelPermissionPredicate' ||
            action.metadataName === 'view' ||
            action.metadataName === 'navigationMenuItem') &&
          action.type !== 'delete'
        ) {
          throw new Error(
            'Application metadata fieldDelete allows only delete actions on field and field permission metadata',
          );
        }
      }
      for (const viewId of plannedViewDeletes) {
        const viewRow = beforeViews.get(viewId);
        const calendarFieldId = viewRow
          ? nullableUuid(viewRow.calendarFieldMetadataId)
          : null;
        const mainGroupByFieldId = viewRow
          ? nullableUuid(viewRow.mainGroupByFieldMetadataId)
          : null;
        if (
          !viewRow ||
          ((calendarFieldId === null ||
            !plannedFieldDeletes.has(calendarFieldId)) &&
            (mainGroupByFieldId === null ||
              !plannedFieldDeletes.has(mainGroupByFieldId)))
        ) {
          throw new Error(
            'Application metadata fieldDelete cannot delete unrelated view',
          );
        }
      }
      const primaryField = beforeFields.get(expectedFieldId);
      if (!primaryField) {
        throw new Error(
          'Application metadata fieldDelete target field unavailable',
        );
      }
      const primaryObjectId = uuid(primaryField.objectMetadataId);
      const parentObj = beforeObjects.get(primaryObjectId);
      if (!parentObj) {
        throw new Error(
          'Application metadata fieldDelete parent object unavailable',
        );
      }
      const primaryUid = uuid(primaryField.universalIdentifier);
      const primaryMorphId = nullableUuid(primaryField.morphId);
      const isPrimaryMorphHead =
        primaryMorphId !== null && primaryMorphId === primaryUid;
      if (!request.isSystemBuild) {
        if (
          (standardAppId !== null &&
            uuid(primaryField.applicationId) === standardAppId) ||
          (primaryField.isSystem === true && !isPrimaryMorphHead) ||
          (primaryField.isSystemSideEffect === true && !isPrimaryMorphHead)
        ) {
          throw new Error(
            'Application metadata fieldDelete cannot delete standard or system field',
          );
        }
        if (
          nullableUuid(parentObj.labelIdentifierFieldMetadataId) ===
          expectedFieldId
        ) {
          throw new Error(
            'Application metadata fieldDelete cannot delete label identifier field',
          );
        }
      }
      const allowedFieldIds = new Set<string>([expectedFieldId]);
      if (primaryMorphId !== null) {
        for (const [fid, frow] of beforeFields.entries()) {
          if (
            uuid(frow.objectMetadataId) === primaryObjectId &&
            (nullableUuid(frow.morphId) === primaryMorphId ||
              uuid(frow.universalIdentifier) === primaryMorphId)
          ) {
            allowedFieldIds.add(fid);
          }
        }
      }
      for (const fid of [...allowedFieldIds]) {
        const frow = beforeFields.get(fid);
        const relTargetId = frow
          ? nullableUuid(frow.relationTargetFieldMetadataId)
          : null;
        if (relTargetId !== null) {
          allowedFieldIds.add(relTargetId);
        }
      }
      for (const [fid, frow] of beforeFields.entries()) {
        const relTargetId = nullableUuid(frow.relationTargetFieldMetadataId);
        if (relTargetId !== null && allowedFieldIds.has(relTargetId)) {
          allowedFieldIds.add(fid);
        }
      }
      for (const fid of [...allowedFieldIds]) {
        const frow = beforeFields.get(fid);
        if (!frow) continue;
        const morphId = nullableUuid(frow.morphId);
        if (morphId !== null) {
          const objId = uuid(frow.objectMetadataId);
          for (const [hid, hrow] of beforeFields.entries()) {
            if (
              uuid(hrow.objectMetadataId) === objId &&
              uuid(hrow.universalIdentifier) === morphId
            ) {
              allowedFieldIds.add(hid);
            }
          }
        }
      }
      const primaryRelTargetId = nullableUuid(
        primaryField.relationTargetFieldMetadataId,
      );
      if (
        primaryRelTargetId !== null &&
        beforeFields.has(primaryRelTargetId) &&
        !plannedFieldDeletes.has(primaryRelTargetId)
      ) {
        throw new Error(
          'Application metadata fieldDelete requires paired relation target field deletion',
        );
      }
      for (const fieldId of plannedFieldDeletes) {
        if (!beforeFields.has(fieldId) || !allowedFieldIds.has(fieldId)) {
          throw new Error(
            'Application metadata fieldDelete detected unauthorized fieldMetadata deletion',
          );
        }
      }
    }

    for (const [targetId, targetRow] of before.roleTargets.entries()) {
      const roleId = uuid(targetRow.roleId);
      const agentId = nullableUuid(targetRow.agentId);
      const userWorkspaceId = nullableUuid(targetRow.userWorkspaceId);
      const apiKeyId = nullableUuid(targetRow.apiKeyId);
      if (plannedRoleDeletes.has(roleId)) {
        if (userWorkspaceId !== null || apiKeyId !== null) {
          throw new Error(
            'Application metadata audit cannot delete role assigned to workspace member or API key',
          );
        }
        if (
          !plannedTargetDeletes.has(targetId) &&
          !plannedTargetUpdates.has(targetId)
        ) {
          throw new Error(
            'Application metadata audit detected unplanned roleTarget cascade',
          );
        }
      }
      if (
        agentId !== null &&
        plannedAgentDeletes.has(agentId) &&
        !plannedTargetDeletes.has(targetId)
      ) {
        throw new Error(
          'Application metadata audit detected unplanned roleTarget cascade',
        );
      }
    }

    for (const id of [...plannedTargetUpdates, ...plannedTargetDeletes]) {
      const existingTarget = before.roleTargets.get(id);
      if (
        !existingTarget ||
        nullableUuid(existingTarget.userWorkspaceId) !== null ||
        nullableUuid(existingTarget.apiKeyId) !== null ||
        nullableUuid(existingTarget.agentId) === null
      ) {
        throw new Error(
          'Application metadata roleTarget action must target an existing agent binding',
        );
      }
    }

    for (const action of actions) {
      if (action.metadataName === 'roleTarget' && action.type === 'create') {
        const flatEntity = action.flatEntity!;
        if (
          nullableUuid(flatEntity.userWorkspaceId) !== null ||
          nullableUuid(flatEntity.apiKeyId) !== null ||
          typeof flatEntity.agentUniversalIdentifier !== 'string' ||
          !isUUID(flatEntity.agentUniversalIdentifier)
        ) {
          throw new Error(
            'Application metadata roleTarget create must target an agent',
          );
        }
      }
    }

    const plannedFlagCreates = resolveMappedIds(
      actions,
      'rolePermissionFlag',
      'create',
      mappings.rolePermissionFlags,
      applicationUniversalIdentifier,
    );
    const plannedFlagDeletes = resolveMappedIds(
      actions,
      'rolePermissionFlag',
      'delete',
      mappings.rolePermissionFlags,
    );
    if (
      actions.some(
        (action) =>
          action.metadataName === 'rolePermissionFlag' &&
          action.type === 'update',
      )
    ) {
      throw new Error(
        'Application metadata rolePermissionFlag cannot be updated',
      );
    }

    const plannedObjPermCreates = resolveMappedIds(
      actions,
      'objectPermission',
      'create',
      mappings.objectPermissions,
      applicationUniversalIdentifier,
    );
    const plannedObjPermUpdates = resolveMappedIds(
      actions,
      'objectPermission',
      'update',
      mappings.objectPermissions,
    );
    const plannedObjPermDeletes = resolveMappedIds(
      actions,
      'objectPermission',
      'delete',
      mappings.objectPermissions,
    );

    const plannedFieldPermCreates = resolveMappedIds(
      actions,
      'fieldPermission',
      'create',
      mappings.fieldPermissions,
      applicationUniversalIdentifier,
    );
    const plannedFieldPermUpdates = resolveMappedIds(
      actions,
      'fieldPermission',
      'update',
      mappings.fieldPermissions,
    );
    const plannedFieldPermDeletes = resolveMappedIds(
      actions,
      'fieldPermission',
      'delete',
      mappings.fieldPermissions,
    );

    const plannedGroupCreates = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicateGroup',
      'create',
      mappings.rowLevelPermissionPredicateGroups,
      applicationUniversalIdentifier,
    );
    const plannedGroupUpdates = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicateGroup',
      'update',
      mappings.rowLevelPermissionPredicateGroups,
    );
    const plannedGroupDeletes = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicateGroup',
      'delete',
      mappings.rowLevelPermissionPredicateGroups,
    );

    const plannedPredCreates = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicate',
      'create',
      mappings.rowLevelPermissionPredicates,
      applicationUniversalIdentifier,
    );
    const plannedPredUpdates = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicate',
      'update',
      mappings.rowLevelPermissionPredicates,
    );
    const plannedPredDeletes = resolveMappedIds(
      actions,
      'rowLevelPermissionPredicate',
      'delete',
      mappings.rowLevelPermissionPredicates,
    );

    const expectedDeletedGroupIds = new Set<string>();
    for (const id of plannedGroupDeletes) {
      const groupRow = before.predicateGroups.get(id);
      if (!groupRow) {
        throw new Error(
          'Application metadata audit rowLevelPermissionPredicateGroup to delete not found',
        );
      }
      if (groupRow.deletedAt !== null && groupRow.deletedAt !== undefined) {
        throw new Error(
          'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
        );
      }
      if (uuid(groupRow.applicationId) === applicationId) {
        expectedDeletedGroupIds.add(id);
      }
    }
    let addedGroupDelete = true;
    while (addedGroupDelete) {
      addedGroupDelete = false;
      for (const [groupId, groupRow] of before.predicateGroups.entries()) {
        if (expectedDeletedGroupIds.has(groupId)) continue;
        const roleId = uuid(groupRow.roleId);
        const objectMetadataId = uuid(groupRow.objectMetadataId);
        const parentGroupId = nullableUuid(
          groupRow.parentRowLevelPermissionPredicateGroupId,
        );
        if (
          plannedRoleDeletes.has(roleId) ||
          plannedObjectDeletes.has(objectMetadataId) ||
          (parentGroupId !== null && expectedDeletedGroupIds.has(parentGroupId))
        ) {
          if (groupRow.deletedAt !== null && groupRow.deletedAt !== undefined) {
            throw new Error(
              'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
            );
          }
          expectedDeletedGroupIds.add(groupId);
          addedGroupDelete = true;
        }
      }
    }
    for (const id of plannedGroupDeletes) {
      if (!expectedDeletedGroupIds.has(id)) {
        throw new Error(
          'Application metadata audit cannot delete another application rowLevelPermissionPredicateGroup without parent cascade',
        );
      }
    }

    for (const id of plannedPredDeletes) {
      const predRow = before.predicates.get(id);
      if (!predRow) {
        throw new Error(
          'Application metadata audit rowLevelPermissionPredicate to delete not found',
        );
      }
      if (predRow.deletedAt !== null && predRow.deletedAt !== undefined) {
        throw new Error(
          'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
        );
      }
    }

    for (const [, predRow] of before.predicates.entries()) {
      if (predRow.deletedAt !== null && predRow.deletedAt !== undefined) {
        const roleId = uuid(predRow.roleId);
        const objectMetadataId = uuid(predRow.objectMetadataId);
        const fieldMetadataId = uuid(predRow.fieldMetadataId);
        const memberFieldMetadataId = nullableUuid(
          predRow.workspaceMemberFieldMetadataId,
        );
        const groupId = nullableUuid(
          predRow.rowLevelPermissionPredicateGroupId,
        );
        if (
          plannedRoleDeletes.has(roleId) ||
          plannedObjectDeletes.has(objectMetadataId) ||
          plannedFieldDeletes.has(fieldMetadataId) ||
          (memberFieldMetadataId !== null &&
            plannedFieldDeletes.has(memberFieldMetadataId)) ||
          (groupId !== null && expectedDeletedGroupIds.has(groupId))
        ) {
          throw new Error(
            'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
          );
        }
      }
    }

    const roleIdByUniversalIdentifier = new Map<string, string>();
    for (const [uid, mapped] of Object.entries(mappings.roles)) {
      if (mapped?.id) {
        roleIdByUniversalIdentifier.set(uuid(uid), uuid(mapped.id));
      }
    }
    for (const action of actions) {
      if (action.metadataName === 'role' && action.type === 'create') {
        const flatEntity = action.flatEntity!;
        const createdId = uuid(action.id ?? flatEntity.id);
        roleIdByUniversalIdentifier.set(
          uuid(flatEntity.universalIdentifier),
          createdId,
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

    for (const action of actions) {
      if (action.metadataName === 'roleTarget' && action.type === 'update') {
        const targetId = uuid(
          mappings.targets[uuid(action.universalIdentifier)]?.id,
        );
        const beforeRow = before.roleTargets.get(targetId);
        if (beforeRow && plannedRoleDeletes.has(uuid(beforeRow.roleId))) {
          const updateRecord = action.update ?? {};
          const nextRoleId =
            updateRecord.roleUniversalIdentifier !== undefined
              ? roleIdByUniversalIdentifier.get(
                  uuid(updateRecord.roleUniversalIdentifier),
                )
              : updateRecord.roleId !== undefined
                ? uuid(updateRecord.roleId)
                : undefined;
          if (!nextRoleId || plannedRoleDeletes.has(nextRoleId)) {
            throw new Error(
              'Application metadata audit detected invalid roleTarget update',
            );
          }
          await runner.query(
            `INSERT INTO core."roleTarget" ("id","universalIdentifier","workspaceId","roleId","userWorkspaceId","agentId","apiKeyId","applicationId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT ("id") DO UPDATE SET "roleId"=EXCLUDED."roleId","updatedAt"=now()`,
            [
              targetId,
              uuid(beforeRow.universalIdentifier),
              workspaceId,
              nextRoleId,
              nullableUuid(beforeRow.userWorkspaceId),
              nullableUuid(beforeRow.agentId),
              nullableUuid(beforeRow.apiKeyId),
              nullableUuid(beforeRow.applicationId),
              beforeRow.createdAt,
            ],
          );
        }
      }
    }

    const after = await readFullMetadataSnapshot(
      runner,
      existingTables,
      workspaceId,
      false,
    );

    let expectedObjectsAndFieldsSerialized: string | undefined;
    if (mode === 'objectDelete' || mode === 'fieldDelete') {
      const afterObjects = await readTableSnapshot(
        runner,
        existingTables,
        'objectMetadata',
        workspaceId,
        false,
      );
      const afterFields = await readTableSnapshot(
        runner,
        existingTables,
        'fieldMetadata',
        workspaceId,
        false,
      );
      for (const objId of plannedObjectDeletes) {
        if (afterObjects.has(objId)) {
          throw new Error(
            'Application metadata objectDelete did not remove target object',
          );
        }
      }
      for (const [objId, beforeObj] of beforeObjects.entries()) {
        const afterObj = afterObjects.get(objId);
        if (!afterObj) {
          if (!plannedObjectDeletes.has(objId)) {
            throw new Error(
              'Application metadata audit detected unexpected objectMetadata deletion',
            );
          }
        } else if (
          canonicalAuditJson(scalarWithoutTimestamps(beforeObj)) !==
          canonicalAuditJson(scalarWithoutTimestamps(afterObj))
        ) {
          throw new Error(
            'Application metadata audit detected unexpected objectMetadata mutation',
          );
        }
      }
      for (const objId of afterObjects.keys()) {
        if (!beforeObjects.has(objId)) {
          throw new Error(
            'Application metadata audit detected unexpected objectMetadata creation',
          );
        }
      }
      for (const fieldId of plannedFieldDeletes) {
        if (afterFields.has(fieldId)) {
          throw new Error(
            'Application metadata delete did not remove target fieldMetadata',
          );
        }
      }
      for (const [fieldId, beforeField] of beforeFields.entries()) {
        const afterField = afterFields.get(fieldId);
        if (!afterField) {
          if (!plannedFieldDeletes.has(fieldId)) {
            throw new Error(
              'Application metadata audit detected unexpected fieldMetadata deletion',
            );
          }
        } else if (
          canonicalAuditJson(scalarWithoutTimestamps(beforeField)) !==
          canonicalAuditJson(scalarWithoutTimestamps(afterField))
        ) {
          throw new Error(
            'Application metadata audit detected unexpected fieldMetadata mutation',
          );
        }
      }
      for (const fieldId of afterFields.keys()) {
        if (!beforeFields.has(fieldId)) {
          throw new Error(
            'Application metadata audit detected unexpected fieldMetadata creation',
          );
        }
      }
      expectedObjectsAndFieldsSerialized = canonicalAuditJson({
        objects: [...afterObjects.entries()].map(([id, row]) => [
          id,
          scalarWithoutTimestamps(row),
        ]),
        fields: [...afterFields.entries()].map(([id, row]) => [
          id,
          scalarWithoutTimestamps(row),
        ]),
      });
    }

    let recordedMutations = 0;
    const recordMutation = (
      resourceKind: CrmAuditResourceKind,
      resourceId: string,
      action: CrmAuditAction,
      beforeValue: Record<string, unknown> | null,
      afterValue: Record<string, unknown> | null,
    ) => {
      audit.record({
        resourceKind,
        resourceId,
        action,
        before: beforeValue,
        after: afterValue,
        securityDescriptor: {
          resourceKind,
          resourceId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
    };

    // 1. Verify and record core.role
    for (const id of plannedRoleDeletes) {
      if (after.roles.has(id)) {
        throw new Error('Application metadata role delete did not remove row');
      }
    }
    for (const id of plannedRoleCreates) {
      if (!after.roles.has(id)) {
        throw new Error('Application metadata role create did not persist row');
      }
    }
    for (const [id, beforeRow] of before.roles.entries()) {
      const afterRow = after.roles.get(id);
      if (!afterRow) {
        if (!plannedRoleDeletes.has(id)) {
          throw new Error(
            'Application metadata audit detected unexpected role deletion',
          );
        }
        recordMutation('role', id, 'delete', projectRole(beforeRow), null);
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        if (
          !plannedRoleUpdates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected role update',
          );
        }
        const beforeProj = projectRole(beforeRow);
        const afterProj = projectRole(afterRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation('role', id, 'update', beforeProj, afterProj);
        }
      }
    }
    for (const [id, afterRow] of after.roles.entries()) {
      if (!before.roles.has(id)) {
        if (
          !plannedRoleCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected role creation',
          );
        }
        recordMutation('role', id, 'create', null, projectRole(afterRow));
      }
    }

    // 2. Verify and record core."roleTarget"
    for (const id of plannedTargetDeletes) {
      if (after.roleTargets.has(id)) {
        throw new Error(
          'Application metadata roleTarget delete did not remove row',
        );
      }
    }
    for (const id of plannedTargetCreates) {
      if (!after.roleTargets.has(id)) {
        throw new Error(
          'Application metadata roleTarget create did not persist row',
        );
      }
    }
    for (const [id, beforeRow] of before.roleTargets.entries()) {
      const afterRow = after.roleTargets.get(id);
      if (!afterRow) {
        if (!plannedTargetDeletes.has(id)) {
          throw new Error(
            'Application metadata audit detected unexpected roleTarget deletion',
          );
        }
        recordMutation(
          'roleTarget',
          id,
          'delete',
          projectRoleTarget(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        const afterRole = after.roles.get(uuid(afterRow.roleId));
        if (
          !plannedTargetUpdates.has(id) ||
          nullableUuid(afterRow.userWorkspaceId) !== null ||
          nullableUuid(afterRow.apiKeyId) !== null ||
          nullableUuid(afterRow.agentId) !== nullableUuid(beforeRow.agentId) ||
          !afterRole ||
          afterRole.canBeAssignedToAgents !== true
        ) {
          throw new Error(
            'Application metadata audit detected invalid roleTarget update',
          );
        }
        const beforeProj = projectRoleTarget(beforeRow);
        const afterProj = projectRoleTarget(afterRow);
        if (beforeProj.roleId !== afterProj.roleId) {
          recordMutation('roleTarget', id, 'delete', beforeProj, null);
          recordMutation('roleTarget', id, 'create', null, afterProj);
        }
      }
    }
    for (const [id, afterRow] of after.roleTargets.entries()) {
      if (!before.roleTargets.has(id)) {
        const afterRole = after.roles.get(uuid(afterRow.roleId));
        if (
          !plannedTargetCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId ||
          nullableUuid(afterRow.userWorkspaceId) !== null ||
          nullableUuid(afterRow.apiKeyId) !== null ||
          nullableUuid(afterRow.agentId) === null ||
          !afterRole ||
          afterRole.canBeAssignedToAgents !== true
        ) {
          throw new Error(
            'Application metadata audit detected invalid roleTarget creation',
          );
        }
        recordMutation(
          'roleTarget',
          id,
          'create',
          null,
          projectRoleTarget(afterRow),
        );
      }
    }

    // 3. Verify and record core."rolePermissionFlag"
    for (const [id, beforeRow] of before.rolePermissionFlags.entries()) {
      const afterRow = after.rolePermissionFlags.get(id);
      if (!afterRow) {
        const isPlannedCascade =
          plannedRoleDeletes.has(uuid(beforeRow.roleId)) ||
          plannedPermissionFlagDeletes.has(uuid(beforeRow.permissionFlagId));
        const isPlannedDirectDelete =
          plannedFlagDeletes.has(id) &&
          uuid(beforeRow.applicationId) === applicationId;
        if (!isPlannedDirectDelete && !isPlannedCascade) {
          throw new Error(
            'Application metadata audit detected unexpected rolePermissionFlag deletion',
          );
        }
        recordMutation(
          'rolePermissionFlag',
          id,
          'delete',
          projectRolePermissionFlag(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        throw new Error(
          'Application metadata audit detected unexpected rolePermissionFlag mutation',
        );
      }
    }
    for (const [id, afterRow] of after.rolePermissionFlags.entries()) {
      if (!before.rolePermissionFlags.has(id)) {
        if (
          !plannedFlagCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected rolePermissionFlag creation',
          );
        }
        recordMutation(
          'rolePermissionFlag',
          id,
          'create',
          null,
          projectRolePermissionFlag(afterRow),
        );
      }
    }

    // 4. Verify and record core."objectPermission"
    for (const [id, beforeRow] of before.objectPermissions.entries()) {
      const afterRow = after.objectPermissions.get(id);
      if (!afterRow) {
        const isPlannedCascade =
          plannedRoleDeletes.has(uuid(beforeRow.roleId)) ||
          plannedObjectDeletes.has(uuid(beforeRow.objectMetadataId));
        const isPlannedDirectDelete =
          plannedObjPermDeletes.has(id) &&
          uuid(beforeRow.applicationId) === applicationId;
        if (!isPlannedDirectDelete && !isPlannedCascade) {
          throw new Error(
            'Application metadata audit detected unexpected objectPermission deletion',
          );
        }
        recordMutation(
          'objectPermission',
          id,
          'delete',
          projectObjectPermission(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        if (
          !plannedObjPermUpdates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected objectPermission update',
          );
        }
        const beforeProj = projectObjectPermission(beforeRow);
        const afterProj = projectObjectPermission(afterRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation(
            'objectPermission',
            id,
            'update',
            beforeProj,
            afterProj,
          );
        }
      }
    }
    for (const [id, afterRow] of after.objectPermissions.entries()) {
      if (!before.objectPermissions.has(id)) {
        if (
          !plannedObjPermCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected objectPermission creation',
          );
        }
        recordMutation(
          'objectPermission',
          id,
          'create',
          null,
          projectObjectPermission(afterRow),
        );
      }
    }

    // 5. Verify and record core."fieldPermission"
    for (const [id, beforeRow] of before.fieldPermissions.entries()) {
      const afterRow = after.fieldPermissions.get(id);
      if (!afterRow) {
        const isPlannedCascade =
          plannedRoleDeletes.has(uuid(beforeRow.roleId)) ||
          plannedObjectDeletes.has(uuid(beforeRow.objectMetadataId)) ||
          plannedFieldDeletes.has(uuid(beforeRow.fieldMetadataId));
        const isPlannedDirectDelete =
          plannedFieldPermDeletes.has(id) &&
          uuid(beforeRow.applicationId) === applicationId;
        if (!isPlannedDirectDelete && !isPlannedCascade) {
          throw new Error(
            'Application metadata audit detected unexpected fieldPermission deletion',
          );
        }
        recordMutation(
          'fieldPermission',
          id,
          'delete',
          projectFieldPermission(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        if (
          !plannedFieldPermUpdates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected fieldPermission update',
          );
        }
        const beforeProj = projectFieldPermission(beforeRow);
        const afterProj = projectFieldPermission(afterRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation(
            'fieldPermission',
            id,
            'update',
            beforeProj,
            afterProj,
          );
        }
      }
    }
    for (const [id, afterRow] of after.fieldPermissions.entries()) {
      if (!before.fieldPermissions.has(id)) {
        if (
          !plannedFieldPermCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected fieldPermission creation',
          );
        }
        recordMutation(
          'fieldPermission',
          id,
          'create',
          null,
          projectFieldPermission(afterRow),
        );
      }
    }

    // 6. Verify and record core."rowLevelPermissionPredicateGroup"
    for (const [id, beforeRow] of before.predicateGroups.entries()) {
      const afterRow = after.predicateGroups.get(id);
      if (!afterRow) {
        if (!expectedDeletedGroupIds.has(id)) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicateGroup deletion',
          );
        }
        recordMutation(
          'rowLevelPermissionPredicateGroup',
          id,
          'delete',
          projectPredicateGroup(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        if (
          !plannedGroupUpdates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicateGroup update',
          );
        }
        const beforeProj = projectPredicateGroup(beforeRow);
        const afterProj = projectPredicateGroup(afterRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation(
            'rowLevelPermissionPredicateGroup',
            id,
            'update',
            beforeProj,
            afterProj,
          );
        }
      }
    }
    for (const [id, afterRow] of after.predicateGroups.entries()) {
      if (!before.predicateGroups.has(id)) {
        if (
          !plannedGroupCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicateGroup creation',
          );
        }
        recordMutation(
          'rowLevelPermissionPredicateGroup',
          id,
          'create',
          null,
          projectPredicateGroup(afterRow),
        );
      }
    }

    // 7. Verify and record core."rowLevelPermissionPredicate"
    for (const [id, beforeRow] of before.predicates.entries()) {
      const afterRow = after.predicates.get(id);
      if (!afterRow) {
        const groupId = nullableUuid(
          beforeRow.rowLevelPermissionPredicateGroupId,
        );
        const isPlannedCascade =
          plannedRoleDeletes.has(uuid(beforeRow.roleId)) ||
          plannedObjectDeletes.has(uuid(beforeRow.objectMetadataId)) ||
          plannedFieldDeletes.has(uuid(beforeRow.fieldMetadataId)) ||
          (groupId !== null && expectedDeletedGroupIds.has(groupId));
        const isPlannedDirectDelete =
          plannedPredDeletes.has(id) &&
          uuid(beforeRow.applicationId) === applicationId;
        if (!isPlannedDirectDelete && !isPlannedCascade) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicate deletion',
          );
        }
        recordMutation(
          'rowLevelPermissionPredicate',
          id,
          'delete',
          projectPredicate(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        const beforeMemberFieldId = nullableUuid(
          beforeRow.workspaceMemberFieldMetadataId,
        );
        const isOnlyMemberFieldSetNull =
          beforeMemberFieldId !== null &&
          plannedFieldDeletes.has(beforeMemberFieldId) &&
          nullableUuid(afterRow.workspaceMemberFieldMetadataId) === null &&
          canonicalAuditJson({
            ...scalarWithoutTimestamps(beforeRow),
            workspaceMemberFieldMetadataId: null,
          }) === canonicalAuditJson(scalarWithoutTimestamps(afterRow));
        if (
          !isOnlyMemberFieldSetNull &&
          (!plannedPredUpdates.has(id) ||
            uuid(afterRow.applicationId) !== applicationId)
        ) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicate update',
          );
        }
        const beforeProj = projectPredicate(beforeRow);
        const afterProj = projectPredicate(afterRow);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation(
            'rowLevelPermissionPredicate',
            id,
            'update',
            beforeProj,
            afterProj,
          );
        }
      }
    }
    for (const [id, afterRow] of after.predicates.entries()) {
      if (!before.predicates.has(id)) {
        if (
          !plannedPredCreates.has(id) ||
          uuid(afterRow.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata audit detected unexpected rowLevelPermissionPredicate creation',
          );
        }
        recordMutation(
          'rowLevelPermissionPredicate',
          id,
          'create',
          null,
          projectPredicate(afterRow),
        );
      }
    }

    // 8. Verify core."applicationVariable" and verify/record core."userApplicationVariableValue"
    for (const varId of plannedApplicationVariableDeletes) {
      if (after.applicationVariables.has(varId)) {
        throw new Error(
          'Application metadata applicationVariable delete did not remove row',
        );
      }
    }
    for (const [varId] of before.applicationVariables.entries()) {
      if (
        !after.applicationVariables.has(varId) &&
        !plannedApplicationVariableDeletes.has(varId)
      ) {
        throw new Error(
          'Application metadata audit detected unexpected applicationVariable deletion',
        );
      }
    }
    for (const [
      id,
      beforeRow,
    ] of before.userApplicationVariableValues.entries()) {
      const afterRow = after.userApplicationVariableValues.get(id);
      if (!afterRow) {
        if (
          !plannedApplicationVariableDeletes.has(
            uuid(beforeRow.applicationVariableId),
          )
        ) {
          throw new Error(
            'Application metadata audit detected unexpected userApplicationVariableValue deletion',
          );
        }
        recordMutation(
          'userApplicationVariableValue',
          id,
          'delete',
          projectUserApplicationVariableValue(beforeRow),
          null,
        );
      } else if (
        canonicalAuditJson(scalarWithoutTimestamps(beforeRow)) !==
        canonicalAuditJson(scalarWithoutTimestamps(afterRow))
      ) {
        throw new Error(
          'Application metadata audit detected unexpected userApplicationVariableValue mutation',
        );
      }
    }
    for (const [id] of after.userApplicationVariableValues.entries()) {
      if (!before.userApplicationVariableValues.has(id)) {
        throw new Error(
          'Application metadata audit detected unexpected userApplicationVariableValue creation',
        );
      }
    }

    // 9. Verify and record audited core.workflow and core.view visibility/ownership updates
    let expectedWorkflowsAndViewsSerialized: string | undefined;
    const verifyWorkflowShareIntents: (() => Promise<void>)[] = [];
    if (hasWorkflowTable || hasViewTable) {
      const afterWorkflows = hasWorkflowTable
        ? await readTableSnapshot(
            runner,
            existingTables,
            'workflow',
            workspaceId,
            false,
          )
        : new Map<string, Record<string, unknown>>();
      const afterViews = hasViewTable
        ? await readTableSnapshot(
            runner,
            existingTables,
            'view',
            workspaceId,
            false,
          )
        : new Map<string, Record<string, unknown>>();

      for (const wfId of plannedAuditedWorkflowUpdates) {
        const afterWf = afterWorkflows.get(wfId);
        if (
          !afterWf ||
          afterWf.deletedAt !== null ||
          uuid(afterWf.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata workflow update removed or corrupted target workflow',
          );
        }
      }
      for (const [wfId, beforeWf] of beforeWorkflows.entries()) {
        const afterWf = afterWorkflows.get(wfId);
        if (!afterWf || afterWf.deletedAt !== null) continue;
        const beforeProj = projectCoreWorkflowOrView(beforeWf);
        const afterProj = projectCoreWorkflowOrView(afterWf);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          if (
            !plannedAuditedWorkflowUpdates.has(wfId) ||
            uuid(afterWf.applicationId) !== applicationId
          ) {
            throw new Error(
              'Application metadata audit detected unplanned workflow visibility or creator mutation',
            );
          }
          if (
            afterProj.visibility === 'UNLISTED' &&
            afterProj.createdByUserWorkspaceId === null
          ) {
            throw new Error(
              'Application metadata audit cannot set workflow to UNLISTED without creator',
            );
          }
          const persistedIntent =
            await persistWorkflowRunShareReconciliationIntent({
              runner,
              workspaceId,
              coreWorkflowId: wfId,
              applicationUniversalIdentifier,
            });
          if (persistedIntent) {
            verifyWorkflowShareIntents.push(persistedIntent.verify);
          }
          recordMutation('coreWorkflow', wfId, 'update', beforeProj, afterProj);
        }
      }
      for (const [wfId, afterWf] of afterWorkflows.entries()) {
        if (!beforeWorkflows.has(wfId)) {
          const afterProj = projectCoreWorkflowOrView(afterWf);
          if (
            afterProj.visibility !== 'WORKSPACE' ||
            afterProj.createdByUserWorkspaceId !== null
          ) {
            throw new Error(
              'Application metadata audit cannot create workflow with non-workspace visibility or creator',
            );
          }
        }
      }

      for (const viewId of plannedAuditedViewUpdates) {
        const afterVw = afterViews.get(viewId);
        if (
          !afterVw ||
          afterVw.deletedAt !== null ||
          uuid(afterVw.applicationId) !== applicationId
        ) {
          throw new Error(
            'Application metadata view update removed or corrupted target view',
          );
        }
      }
      for (const [viewId, beforeVw] of beforeViews.entries()) {
        const afterVw = afterViews.get(viewId);
        if (!afterVw || afterVw.deletedAt !== null) continue;
        const beforeProj = projectCoreWorkflowOrView(beforeVw);
        const afterProj = projectCoreWorkflowOrView(afterVw);
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          if (
            !plannedAuditedViewUpdates.has(viewId) ||
            uuid(afterVw.applicationId) !== applicationId
          ) {
            throw new Error(
              'Application metadata audit detected unplanned view visibility or creator mutation',
            );
          }
          if (
            afterProj.visibility === 'UNLISTED' &&
            afterProj.createdByUserWorkspaceId === null
          ) {
            throw new Error(
              'Application metadata audit cannot set view to UNLISTED without creator',
            );
          }
          recordMutation('coreView', viewId, 'update', beforeProj, afterProj);
        }
      }
      for (const [viewId, afterVw] of afterViews.entries()) {
        if (!beforeViews.has(viewId)) {
          const afterProj = projectCoreWorkflowOrView(afterVw);
          if (
            afterProj.visibility !== 'WORKSPACE' ||
            afterProj.createdByUserWorkspaceId !== null
          ) {
            throw new Error(
              'Application metadata audit cannot create view with non-workspace visibility or creator',
            );
          }
        }
      }

      expectedWorkflowsAndViewsSerialized = canonicalAuditJson({
        workflows: [...afterWorkflows.entries()].map(([id, row]) => [
          id,
          projectCoreWorkflowOrView(row),
        ]),
        views: [...afterViews.entries()].map(([id, row]) => [
          id,
          projectCoreWorkflowOrView(row),
        ]),
      });
    }

    // 10. Verify and record core.navigationMenuItem lifecycle and cascade deletions
    let expectedNavigationMenuItemsSerialized: string | undefined;
    if (hasNavTable) {
      const afterNavigationMenuItems = await readTableSnapshot(
        runner,
        existingTables,
        'navigationMenuItem',
        workspaceId,
        false,
      );
      const createdNavByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterNav] of afterNavigationMenuItems.entries()) {
        assertNavigationMenuItemRowInvariants(afterNav, workspaceId);
        if (!beforeNavigationMenuItems.has(id)) {
          const universalId = uuid(afterNav.universalIdentifier);
          if (createdNavByUniversalId.has(universalId)) {
            throw new Error(
              'Application metadata audit detected duplicate created navigationMenuItem universalIdentifier',
            );
          }
          createdNavByUniversalId.set(universalId, afterNav);
        }
      }

      if (
        createdNavByUniversalId.size !==
        plannedNavCreatesByUniversalIdentifier.size
      ) {
        throw new Error(
          'Application metadata audit navigationMenuItem created row count mismatch',
        );
      }

      for (const [
        universalId,
        planned,
      ] of plannedNavCreatesByUniversalIdentifier.entries()) {
        const afterNav = createdNavByUniversalId.get(universalId);
        if (!afterNav) {
          throw new Error(
            'Application metadata navigationMenuItem create did not persist expected row',
          );
        }
        const createdId = uuid(afterNav.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error(
            'Application metadata navigationMenuItem create persisted unexpected ID',
          );
        }
        if (uuid(afterNav.applicationId) !== applicationId) {
          throw new Error(
            'Application metadata navigationMenuItem create persisted unexpected applicationId',
          );
        }
        const afterProj = projectNavigationMenuItem(afterNav);
        if (afterProj.userWorkspaceId !== null) {
          throw new Error(
            'Application metadata navigationMenuItem create cannot set userWorkspaceId',
          );
        }
        if (afterProj.type !== planned.flatEntity.type) {
          throw new Error(
            'Application metadata navigationMenuItem create persisted unexpected type',
          );
        }
        if (
          afterProj.targetRecordId !==
          nullableUuid(planned.flatEntity.targetRecordId)
        ) {
          throw new Error(
            'Application metadata navigationMenuItem create persisted unexpected targetRecordId',
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
              `Application metadata navigationMenuItem create persisted unexpected ${fkKey}`,
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
                `Application metadata navigationMenuItem create persisted unexpected ${textKey}`,
              );
            }
          }
        }
        if (
          planned.flatEntity.position !== undefined &&
          afterProj.position !== Number(planned.flatEntity.position)
        ) {
          throw new Error(
            'Application metadata navigationMenuItem create persisted unexpected position',
          );
        }
        recordMutation(
          'navigationMenuItem',
          createdId,
          'create',
          null,
          afterProj,
        );
      }

      for (const navId of plannedNavUpdates) {
        if (cascadeDeletedNavIds.has(navId)) continue;
        const beforeNav = beforeNavigationMenuItems.get(navId);
        const afterNav = afterNavigationMenuItems.get(navId);
        if (
          !beforeNav ||
          !afterNav ||
          uuid(afterNav.applicationId) !== applicationId ||
          uuid(beforeNav.universalIdentifier) !==
            uuid(afterNav.universalIdentifier)
        ) {
          throw new Error(
            'Application metadata navigationMenuItem update removed or corrupted target row',
          );
        }
        const beforeProj = projectNavigationMenuItem(beforeNav);
        const afterProj = projectNavigationMenuItem(afterNav);
        if (
          beforeProj.userWorkspaceId !== afterProj.userWorkspaceId ||
          afterProj.userWorkspaceId !== null ||
          beforeProj.type !== afterProj.type ||
          beforeProj.viewId !== afterProj.viewId ||
          beforeProj.targetObjectMetadataId !==
            afterProj.targetObjectMetadataId ||
          beforeProj.targetRecordId !== afterProj.targetRecordId ||
          beforeProj.agentChatChannelId !== afterProj.agentChatChannelId
        ) {
          throw new Error(
            'Application metadata navigationMenuItem update modified immutable target or owner fields',
          );
        }
        const updatePayload = plannedNavUpdatePayloads.get(navId) ?? {};
        if (
          afterProj.type !== 'PAGE_LAYOUT' &&
          afterProj.pageLayoutId !== null
        ) {
          throw new Error(
            'Application metadata navigationMenuItem update set pageLayoutId on non-PAGE_LAYOUT item',
          );
        }
        if (
          !('pageLayoutId' in updatePayload) &&
          !('pageLayoutUniversalIdentifier' in updatePayload) &&
          afterProj.pageLayoutId !== beforeProj.pageLayoutId
        ) {
          throw new Error(
            'Application metadata navigationMenuItem update modified pageLayoutId unexpectedly',
          );
        }
        if (
          !('folderId' in updatePayload) &&
          !('folderUniversalIdentifier' in updatePayload) &&
          afterProj.folderId !== beforeProj.folderId
        ) {
          throw new Error(
            'Application metadata navigationMenuItem update modified folderId unexpectedly',
          );
        }
        for (const textKey of ['name', 'link', 'icon', 'color'] as const) {
          const expectedVal =
            textKey in updatePayload && updatePayload[textKey] !== undefined
              ? updatePayload[textKey] === null
                ? null
                : String(updatePayload[textKey])
              : beforeProj[textKey];
          if (afterProj[textKey] !== expectedVal) {
            throw new Error(
              `Application metadata navigationMenuItem update did not persist expected ${textKey}`,
            );
          }
        }
        const expectedPos =
          'position' in updatePayload && updatePayload.position !== undefined
            ? Number(updatePayload.position)
            : beforeProj.position;
        if (afterProj.position !== expectedPos) {
          throw new Error(
            'Application metadata navigationMenuItem update did not persist expected position',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation(
            'navigationMenuItem',
            navId,
            'update',
            beforeProj,
            afterProj,
          );
        }
      }

      for (const navId of cascadeDeletedNavIds) {
        const beforeNav = beforeNavigationMenuItems.get(navId);
        if (!beforeNav) {
          throw new Error(
            'Application metadata navigationMenuItem delete expected row missing before migration',
          );
        }
        if (afterNavigationMenuItems.has(navId)) {
          throw new Error(
            'Application metadata navigationMenuItem delete did not remove expected row',
          );
        }
        recordMutation(
          'navigationMenuItem',
          navId,
          'delete',
          projectNavigationMenuItem(beforeNav),
          null,
        );
      }

      for (const [navId, beforeNav] of beforeNavigationMenuItems.entries()) {
        if (cascadeDeletedNavIds.has(navId)) continue;
        const afterNav = afterNavigationMenuItems.get(navId);
        if (!afterNav) {
          throw new Error(
            'Application metadata audit detected unplanned navigationMenuItem deletion',
          );
        }
        if (!plannedNavUpdates.has(navId)) {
          if (
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(beforeNav),
            ) !==
            canonicalAuditJson(
              scalarNavigationMenuItemWithoutTimestamps(afterNav),
            )
          ) {
            throw new Error(
              'Application metadata audit detected unplanned navigationMenuItem mutation',
            );
          }
        }
      }

      expectedNavigationMenuItemsSerialized = canonicalAuditJson(
        [...afterNavigationMenuItems.entries()].map(([id, row]) => [
          id,
          scalarNavigationMenuItemWithoutTimestamps(row),
        ]),
      );
    }

    // 11. Verify and record core.agentChatChannel and core.agentChatChannelRole lifecycle and cascade deletions
    let expectedAgentChatChannelsAndRolesSerialized: string | undefined;
    if (hasChannelTable || hasChannelRoleTable) {
      const afterAgentChatChannels = hasChannelTable
        ? await readTableSnapshot(
            runner,
            existingTables,
            'agentChatChannel',
            workspaceId,
            false,
          )
        : new Map<string, Record<string, unknown>>();
      const afterAgentChatChannelRoles = hasChannelRoleTable
        ? await readTableSnapshot(
            runner,
            existingTables,
            'agentChatChannelRole',
            workspaceId,
            false,
          )
        : new Map<string, Record<string, unknown>>();

      if (hasChannelTable) {
        const createdChannelByUniversalId = new Map<
          string,
          Record<string, unknown>
        >();
        for (const [id, afterCh] of afterAgentChatChannels.entries()) {
          assertAgentChatChannelRowInvariants(afterCh, workspaceId);
          if (!beforeAgentChatChannels.has(id)) {
            const universalId = uuid(afterCh.universalIdentifier);
            if (createdChannelByUniversalId.has(universalId)) {
              throw new Error(
                'Application metadata audit detected duplicate created agentChatChannel universalIdentifier',
              );
            }
            createdChannelByUniversalId.set(universalId, afterCh);
          }
        }
        if (
          createdChannelByUniversalId.size !==
          plannedAgentChatChannelCreatesByUniversalId.size
        ) {
          throw new Error(
            'Application metadata audit agentChatChannel created row count mismatch',
          );
        }
        for (const [
          universalId,
          planned,
        ] of plannedAgentChatChannelCreatesByUniversalId.entries()) {
          const afterCh = createdChannelByUniversalId.get(universalId);
          if (!afterCh) {
            throw new Error(
              'Application metadata agentChatChannel create did not persist expected row',
            );
          }
          const createdId = uuid(afterCh.id);
          if (planned.id !== undefined && createdId !== planned.id) {
            throw new Error(
              'Application metadata agentChatChannel create persisted unexpected ID',
            );
          }
          if (uuid(afterCh.applicationId) !== applicationId) {
            throw new Error(
              'Application metadata agentChatChannel create persisted unexpected applicationId',
            );
          }
          const afterProj = projectAgentChatChannel(afterCh);
          if (
            afterProj.isCustom === false &&
            !isStandardApplication &&
            request.isSystemBuild !== true
          ) {
            throw new Error(
              'Application metadata non-standard application cannot create standard agentChatChannel',
            );
          }
          if (
            planned.flatEntity.isCustom !== undefined &&
            afterProj.isCustom !== Boolean(planned.flatEntity.isCustom)
          ) {
            throw new Error(
              'Application metadata agentChatChannel create persisted unexpected isCustom',
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
                  `Application metadata agentChatChannel create persisted unexpected ${textKey}`,
                );
              }
            }
          }
          if (
            planned.flatEntity.position !== undefined &&
            afterProj.position !== Number(planned.flatEntity.position)
          ) {
            throw new Error(
              'Application metadata agentChatChannel create persisted unexpected position',
            );
          }
          recordMutation(
            'agentChatChannel',
            createdId,
            'create',
            null,
            afterProj,
          );
        }

        for (const channelId of plannedAgentChatChannelUpdates) {
          if (plannedAgentChatChannelDeletes.has(channelId)) continue;
          const beforeCh = beforeAgentChatChannels.get(channelId);
          const afterCh = afterAgentChatChannels.get(channelId);
          if (
            !beforeCh ||
            !afterCh ||
            uuid(afterCh.applicationId) !== applicationId ||
            uuid(beforeCh.universalIdentifier) !==
              uuid(afterCh.universalIdentifier) ||
            Boolean(beforeCh.isCustom) !== Boolean(afterCh.isCustom)
          ) {
            throw new Error(
              'Application metadata agentChatChannel update removed or corrupted target row',
            );
          }
          const beforeProj = projectAgentChatChannel(beforeCh);
          const afterProj = projectAgentChatChannel(afterCh);
          const updatePayload =
            plannedAgentChatChannelUpdatePayloads.get(channelId) ?? {};
          for (const textKey of ['name', 'icon', 'color'] as const) {
            const expectedVal =
              textKey in updatePayload && updatePayload[textKey] !== undefined
                ? updatePayload[textKey] === null
                  ? null
                  : String(updatePayload[textKey])
                : beforeProj[textKey];
            if (afterProj[textKey] !== expectedVal) {
              throw new Error(
                `Application metadata agentChatChannel update did not persist expected ${textKey}`,
              );
            }
          }
          const expectedPos =
            'position' in updatePayload && updatePayload.position !== undefined
              ? Number(updatePayload.position)
              : beforeProj.position;
          if (afterProj.position !== expectedPos) {
            throw new Error(
              'Application metadata agentChatChannel update did not persist expected position',
            );
          }
          if (
            canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)
          ) {
            recordMutation(
              'agentChatChannel',
              channelId,
              'update',
              beforeProj,
              afterProj,
            );
          }
        }

        for (const channelId of plannedAgentChatChannelDeletes) {
          const beforeCh = beforeAgentChatChannels.get(channelId);
          if (!beforeCh) {
            throw new Error(
              'Application metadata agentChatChannel delete expected row missing before migration',
            );
          }
          if (afterAgentChatChannels.has(channelId)) {
            throw new Error(
              'Application metadata agentChatChannel delete did not remove expected row',
            );
          }
          recordMutation(
            'agentChatChannel',
            channelId,
            'delete',
            projectAgentChatChannel(beforeCh),
            null,
          );
        }

        for (const [channelId, beforeCh] of beforeAgentChatChannels.entries()) {
          if (plannedAgentChatChannelDeletes.has(channelId)) continue;
          const afterCh = afterAgentChatChannels.get(channelId);
          if (!afterCh) {
            throw new Error(
              'Application metadata audit detected unplanned agentChatChannel deletion',
            );
          }
          if (!plannedAgentChatChannelUpdates.has(channelId)) {
            if (
              canonicalAuditJson(scalarWithoutTimestamps(beforeCh)) !==
              canonicalAuditJson(scalarWithoutTimestamps(afterCh))
            ) {
              throw new Error(
                'Application metadata audit detected unplanned agentChatChannel mutation',
              );
            }
          }
        }
      }

      if (hasChannelRoleTable) {
        const channelIdByUniversalIdentifier = new Map<string, string>();
        for (const [uid, mapped] of Object.entries(
          mappings.agentChatChannels ?? {},
        )) {
          if (mapped?.id) {
            channelIdByUniversalIdentifier.set(uuid(uid), uuid(mapped.id));
          }
        }
        for (const [id, afterCh] of afterAgentChatChannels.entries()) {
          channelIdByUniversalIdentifier.set(
            uuid(afterCh.universalIdentifier),
            id,
          );
        }

        const createdChannelRoleByUniversalId = new Map<
          string,
          Record<string, unknown>
        >();
        for (const [id, afterCr] of afterAgentChatChannelRoles.entries()) {
          assertAgentChatChannelRoleRowInvariants(afterCr, workspaceId);
          if (!beforeAgentChatChannelRoles.has(id)) {
            const universalId = uuid(afterCr.universalIdentifier);
            if (createdChannelRoleByUniversalId.has(universalId)) {
              throw new Error(
                'Application metadata audit detected duplicate created agentChatChannelRole universalIdentifier',
              );
            }
            createdChannelRoleByUniversalId.set(universalId, afterCr);
          }
        }
        if (
          createdChannelRoleByUniversalId.size !==
          plannedAgentChatChannelRoleCreatesByUniversalId.size
        ) {
          throw new Error(
            'Application metadata audit agentChatChannelRole created row count mismatch',
          );
        }
        for (const [
          universalId,
          planned,
        ] of plannedAgentChatChannelRoleCreatesByUniversalId.entries()) {
          const afterCr = createdChannelRoleByUniversalId.get(universalId);
          const expectedChannelId = channelIdByUniversalIdentifier.get(
            planned.channelUniversalIdentifier,
          );
          const expectedRoleId = roleIdByUniversalIdentifier.get(
            planned.roleUniversalIdentifier,
          );
          if (!afterCr || !expectedChannelId || !expectedRoleId) {
            throw new Error(
              'Application metadata agentChatChannelRole create did not persist expected row',
            );
          }
          const createdId = uuid(afterCr.id);
          if (planned.id !== undefined && createdId !== planned.id) {
            throw new Error(
              'Application metadata agentChatChannelRole create persisted unexpected ID',
            );
          }
          if (uuid(afterCr.applicationId) !== applicationId) {
            throw new Error(
              'Application metadata agentChatChannelRole create persisted unexpected applicationId',
            );
          }
          const afterProj = projectAgentChatChannelRole(afterCr);
          if (
            afterProj.channelId !== expectedChannelId ||
            afterProj.roleId !== expectedRoleId ||
            !afterAgentChatChannels.has(afterProj.channelId) ||
            !after.roles.has(afterProj.roleId)
          ) {
            throw new Error(
              'Application metadata agentChatChannelRole create persisted unexpected channelId or roleId',
            );
          }
          recordMutation(
            'agentChatChannelRole',
            createdId,
            'create',
            null,
            afterProj,
          );
        }

        for (const [crId, beforeCr] of beforeAgentChatChannelRoles.entries()) {
          const afterCr = afterAgentChatChannelRoles.get(crId);
          if (!afterCr) {
            const isPlannedCascade =
              plannedRoleDeletes.has(uuid(beforeCr.roleId)) ||
              plannedAgentChatChannelDeletes.has(uuid(beforeCr.channelId));
            const isPlannedDirectDelete =
              plannedAgentChatChannelRoleDeletes.has(crId) &&
              uuid(beforeCr.applicationId) === applicationId;
            if (!isPlannedDirectDelete && !isPlannedCascade) {
              throw new Error(
                'Application metadata audit detected unexpected agentChatChannelRole deletion',
              );
            }
            recordMutation(
              'agentChatChannelRole',
              crId,
              'delete',
              projectAgentChatChannelRole(beforeCr),
              null,
            );
          } else {
            if (plannedAgentChatChannelRoleDeletes.has(crId)) {
              throw new Error(
                'Application metadata agentChatChannelRole delete did not remove expected row',
              );
            }
            if (
              canonicalAuditJson(scalarWithoutTimestamps(beforeCr)) !==
              canonicalAuditJson(scalarWithoutTimestamps(afterCr))
            ) {
              throw new Error(
                'Application metadata audit detected unplanned agentChatChannelRole mutation',
              );
            }
          }
        }
      }

      expectedAgentChatChannelsAndRolesSerialized = canonicalAuditJson({
        channels: [...afterAgentChatChannels.entries()].map(([id, row]) => [
          id,
          scalarWithoutTimestamps(row),
        ]),
        channelRoles: [...afterAgentChatChannelRoles.entries()].map(
          ([id, row]) => [id, scalarWithoutTimestamps(row)],
        ),
      });
    }

    // 12. Verify and record core.webhook lifecycle and deletions
    let expectedWebhooksSerialized: string | undefined;
    if (hasWebhookTable) {
      const afterWebhooks = await readTableSnapshot(
        runner,
        existingTables,
        'webhook',
        workspaceId,
        false,
      );
      const createdWebhookByUniversalId = new Map<
        string,
        Record<string, unknown>
      >();
      for (const [id, afterWh] of afterWebhooks.entries()) {
        assertWebhookRowInvariants(afterWh, workspaceId);
        if (!beforeWebhooks.has(id)) {
          const universalId = uuid(afterWh.universalIdentifier);
          if (createdWebhookByUniversalId.has(universalId)) {
            throw new Error(
              'Application metadata audit detected duplicate created webhook universalIdentifier',
            );
          }
          createdWebhookByUniversalId.set(universalId, afterWh);
        }
      }
      if (
        createdWebhookByUniversalId.size !==
        plannedWebhookCreatesByUniversalId.size
      ) {
        throw new Error(
          'Application metadata audit webhook created row count mismatch',
        );
      }
      for (const [
        universalId,
        planned,
      ] of plannedWebhookCreatesByUniversalId.entries()) {
        const afterWh = createdWebhookByUniversalId.get(universalId);
        if (!afterWh) {
          throw new Error(
            'Application metadata webhook create did not persist expected row',
          );
        }
        const createdId = uuid(afterWh.id);
        if (planned.id !== undefined && createdId !== planned.id) {
          throw new Error(
            'Application metadata webhook create persisted unexpected ID',
          );
        }
        if (uuid(afterWh.applicationId) !== applicationId) {
          throw new Error(
            'Application metadata webhook create persisted unexpected applicationId',
          );
        }
        const afterProj = projectWebhook(afterWh);
        if (
          planned.flatEntity.targetUrl !== undefined &&
          afterProj.targetUrl !== String(planned.flatEntity.targetUrl)
        ) {
          throw new Error(
            'Application metadata webhook create persisted unexpected targetUrl',
          );
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
            throw new Error(
              'Application metadata webhook create persisted unexpected operations',
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
              'Application metadata webhook create persisted unexpected description',
            );
          }
        }
        if (
          planned.flatEntity.secret !== undefined &&
          afterProj.secret !== String(planned.flatEntity.secret)
        ) {
          throw new Error(
            'Application metadata webhook create persisted unexpected secret',
          );
        }
        recordMutation('webhook', createdId, 'create', null, afterProj);
      }

      for (const webhookId of plannedWebhookUpdates) {
        if (plannedWebhookDeletes.has(webhookId)) continue;
        const beforeWh = beforeWebhooks.get(webhookId);
        const afterWh = afterWebhooks.get(webhookId);
        if (
          !beforeWh ||
          !afterWh ||
          uuid(afterWh.applicationId) !== applicationId ||
          uuid(beforeWh.universalIdentifier) !==
            uuid(afterWh.universalIdentifier)
        ) {
          throw new Error(
            'Application metadata webhook update removed or corrupted target row',
          );
        }
        const beforeProj = projectWebhook(beforeWh);
        const afterProj = projectWebhook(afterWh);
        const updatePayload = plannedWebhookUpdatePayloads.get(webhookId) ?? {};
        const expectedTargetUrl =
          'targetUrl' in updatePayload && updatePayload.targetUrl !== undefined
            ? String(updatePayload.targetUrl)
            : beforeProj.targetUrl;
        if (afterProj.targetUrl !== expectedTargetUrl) {
          throw new Error(
            'Application metadata webhook update did not persist expected targetUrl',
          );
        }
        const expectedOperations =
          'operations' in updatePayload &&
          updatePayload.operations !== undefined
            ? Array.isArray(updatePayload.operations)
              ? updatePayload.operations.map((item: unknown) => String(item))
              : null
            : beforeProj.operations;
        if (
          expectedOperations === null ||
          canonicalAuditJson(afterProj.operations) !==
            canonicalAuditJson(expectedOperations)
        ) {
          throw new Error(
            'Application metadata webhook update did not persist expected operations',
          );
        }
        const expectedDesc =
          'description' in updatePayload &&
          updatePayload.description !== undefined
            ? updatePayload.description === null
              ? null
              : String(updatePayload.description)
            : beforeProj.description;
        if (afterProj.description !== expectedDesc) {
          throw new Error(
            'Application metadata webhook update did not persist expected description',
          );
        }
        const expectedSecret =
          'secret' in updatePayload && updatePayload.secret !== undefined
            ? String(updatePayload.secret)
            : beforeProj.secret;
        if (afterProj.secret !== expectedSecret) {
          throw new Error(
            'Application metadata webhook update did not persist expected secret',
          );
        }
        if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
          recordMutation('webhook', webhookId, 'update', beforeProj, afterProj);
        }
      }

      for (const webhookId of plannedWebhookDeletes) {
        const beforeWh = beforeWebhooks.get(webhookId);
        if (!beforeWh) {
          throw new Error(
            'Application metadata webhook delete expected row missing before migration',
          );
        }
        if (afterWebhooks.has(webhookId)) {
          throw new Error(
            'Application metadata webhook delete did not remove expected row',
          );
        }
        recordMutation(
          'webhook',
          webhookId,
          'delete',
          projectWebhook(beforeWh),
          null,
        );
      }

      for (const [webhookId, beforeWh] of beforeWebhooks.entries()) {
        if (plannedWebhookDeletes.has(webhookId)) continue;
        const afterWh = afterWebhooks.get(webhookId);
        if (!afterWh) {
          throw new Error(
            'Application metadata audit detected unplanned webhook deletion',
          );
        }
        if (!plannedWebhookUpdates.has(webhookId)) {
          if (
            canonicalAuditJson(scalarWithoutTimestamps(beforeWh)) !==
            canonicalAuditJson(scalarWithoutTimestamps(afterWh))
          ) {
            throw new Error(
              'Application metadata audit detected unplanned webhook mutation',
            );
          }
        }
      }

      expectedWebhooksSerialized = canonicalAuditJson(
        [...afterWebhooks.entries()].map(([id, row]) => [
          id,
          scalarWithoutTimestamps(row),
        ]),
      );
    }

    if (recordedMutations > 0) {
      const expectedSerialized = serializeFullSnapshot(after);
      await audit.flush();
      const postFlush = await readFullMetadataSnapshot(
        runner,
        existingTables,
        workspaceId,
        false,
      );
      if (serializeFullSnapshot(postFlush) !== expectedSerialized) {
        throw new Error(
          'Application metadata state changed during audit flush',
        );
      }
      if (expectedObjectsAndFieldsSerialized !== undefined) {
        const postFlushObjects = await readTableSnapshot(
          runner,
          existingTables,
          'objectMetadata',
          workspaceId,
          false,
        );
        const postFlushFields = await readTableSnapshot(
          runner,
          existingTables,
          'fieldMetadata',
          workspaceId,
          false,
        );
        const postFlushSerialized = canonicalAuditJson({
          objects: [...postFlushObjects.entries()].map(([id, row]) => [
            id,
            scalarWithoutTimestamps(row),
          ]),
          fields: [...postFlushFields.entries()].map(([id, row]) => [
            id,
            scalarWithoutTimestamps(row),
          ]),
        });
        if (postFlushSerialized !== expectedObjectsAndFieldsSerialized) {
          throw new Error(
            'Application metadata state changed during audit flush',
          );
        }
      }
      if (expectedWorkflowsAndViewsSerialized !== undefined) {
        const postFlushWorkflows = hasWorkflowTable
          ? await readTableSnapshot(
              runner,
              existingTables,
              'workflow',
              workspaceId,
              false,
            )
          : new Map<string, Record<string, unknown>>();
        const postFlushViews = hasViewTable
          ? await readTableSnapshot(
              runner,
              existingTables,
              'view',
              workspaceId,
              false,
            )
          : new Map<string, Record<string, unknown>>();
        const postFlushSerialized = canonicalAuditJson({
          workflows: [...postFlushWorkflows.entries()].map(([id, row]) => [
            id,
            projectCoreWorkflowOrView(row),
          ]),
          views: [...postFlushViews.entries()].map(([id, row]) => [
            id,
            projectCoreWorkflowOrView(row),
          ]),
        });
        if (postFlushSerialized !== expectedWorkflowsAndViewsSerialized) {
          throw new Error(
            'Application metadata state changed during audit flush',
          );
        }
        for (const verifyIntent of verifyWorkflowShareIntents) {
          await verifyIntent();
        }
      }
      if (expectedNavigationMenuItemsSerialized !== undefined) {
        const postFlushNavItems = await readTableSnapshot(
          runner,
          existingTables,
          'navigationMenuItem',
          workspaceId,
          false,
        );
        const postFlushSerialized = canonicalAuditJson(
          [...postFlushNavItems.entries()].map(([id, row]) => [
            id,
            scalarNavigationMenuItemWithoutTimestamps(row),
          ]),
        );
        if (postFlushSerialized !== expectedNavigationMenuItemsSerialized) {
          throw new Error(
            'Application metadata state changed during audit flush',
          );
        }
      }
      if (expectedAgentChatChannelsAndRolesSerialized !== undefined) {
        const postFlushChannels = hasChannelTable
          ? await readTableSnapshot(
              runner,
              existingTables,
              'agentChatChannel',
              workspaceId,
              false,
            )
          : new Map<string, Record<string, unknown>>();
        const postFlushChannelRoles = hasChannelRoleTable
          ? await readTableSnapshot(
              runner,
              existingTables,
              'agentChatChannelRole',
              workspaceId,
              false,
            )
          : new Map<string, Record<string, unknown>>();
        const postFlushSerialized = canonicalAuditJson({
          channels: [...postFlushChannels.entries()].map(([id, row]) => [
            id,
            scalarWithoutTimestamps(row),
          ]),
          channelRoles: [...postFlushChannelRoles.entries()].map(
            ([id, row]) => [id, scalarWithoutTimestamps(row)],
          ),
        });
        if (
          postFlushSerialized !== expectedAgentChatChannelsAndRolesSerialized
        ) {
          throw new Error(
            'Application metadata state changed during audit flush',
          );
        }
      }
      if (expectedWebhooksSerialized !== undefined) {
        const postFlushWebhooks = await readTableSnapshot(
          runner,
          existingTables,
          'webhook',
          workspaceId,
          false,
        );
        const postFlushSerialized = canonicalAuditJson(
          [...postFlushWebhooks.entries()].map(([id, row]) => [
            id,
            scalarWithoutTimestamps(row),
          ]),
        );
        if (postFlushSerialized !== expectedWebhooksSerialized) {
          throw new Error(
            'Application metadata state changed during audit flush',
          );
        }
      }
    }

    return result;
  });
};

export const assertNoRemainingApplicationRoleOrPermissionMetadata = async (
  runner: QueryRunner,
  workspaceId: string,
  applicationId: string,
): Promise<void> => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedApplicationId = uuid(applicationId);
  const existingTables = await readExistingTables(runner);

  if (existingTables.has('role')) {
    const [roleRow] = await runner.query(
      'SELECT id FROM core.role WHERE "workspaceId"=$1 AND "applicationId"=$2 LIMIT 1',
      [normalizedWorkspaceId, normalizedApplicationId],
    );
    if (roleRow) {
      throw new Error(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    }
  }

  for (const tableName of [
    'roleTarget',
    'rolePermissionFlag',
    'objectPermission',
    'fieldPermission',
    'rowLevelPermissionPredicateGroup',
    'rowLevelPermissionPredicate',
    'navigationMenuItem',
    'agentChatChannel',
    'agentChatChannelRole',
    'webhook',
  ]) {
    if (!existingTables.has(tableName)) continue;
    const [ownRow] = await runner.query(
      `SELECT id FROM core."${tableName}" WHERE "workspaceId"=$1 AND "applicationId"=$2 LIMIT 1`,
      [normalizedWorkspaceId, normalizedApplicationId],
    );
    if (ownRow) {
      throw new Error(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    }
  }

  if (existingTables.has('agentChatChannelRole')) {
    if (existingTables.has('role')) {
      const [depRow] = await runner.query(
        `SELECT cr.id FROM core."agentChatChannelRole" cr INNER JOIN core.role r ON r.id=cr."roleId" WHERE cr."workspaceId"=$1 AND r."workspaceId"=$1 AND r."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('agentChatChannel')) {
      const [depRow] = await runner.query(
        `SELECT cr.id FROM core."agentChatChannelRole" cr INNER JOIN core."agentChatChannel" acc ON acc.id=cr."channelId" WHERE cr."workspaceId"=$1 AND acc."workspaceId"=$1 AND acc."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
  }

  if (existingTables.has('roleTarget') && existingTables.has('agent')) {
    const [agentTargetRow] = await runner.query(
      `SELECT rt.id FROM core."roleTarget" rt INNER JOIN core.agent a ON a.id=rt."agentId" WHERE rt."workspaceId"=$1 AND a."workspaceId"=$1 AND a."applicationId"=$2 LIMIT 1`,
      [normalizedWorkspaceId, normalizedApplicationId],
    );
    if (agentTargetRow) {
      throw new Error(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    }
  }

  if (existingTables.has('objectMetadata')) {
    for (const tableName of [
      'objectPermission',
      'fieldPermission',
      'rowLevelPermissionPredicateGroup',
      'rowLevelPermissionPredicate',
    ]) {
      if (!existingTables.has(tableName)) continue;
      const [depRow] = await runner.query(
        `SELECT p.id FROM core."${tableName}" p INNER JOIN core."objectMetadata" o ON o.id=p."objectMetadataId" WHERE p."workspaceId"=$1 AND o."workspaceId"=$1 AND o."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
  }

  if (existingTables.has('fieldMetadata')) {
    if (existingTables.has('fieldPermission')) {
      const [depRow] = await runner.query(
        `SELECT p.id FROM core."fieldPermission" p INNER JOIN core."fieldMetadata" f ON f.id=p."fieldMetadataId" WHERE p."workspaceId"=$1 AND f."workspaceId"=$1 AND f."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('rowLevelPermissionPredicate')) {
      const [depRow] = await runner.query(
        `SELECT p.id FROM core."rowLevelPermissionPredicate" p INNER JOIN core."fieldMetadata" f ON (f.id=p."fieldMetadataId" OR f.id=p."workspaceMemberFieldMetadataId") WHERE p."workspaceId"=$1 AND f."workspaceId"=$1 AND f."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
  }

  if (
    existingTables.has('permissionFlag') &&
    existingTables.has('rolePermissionFlag')
  ) {
    const [depRow] = await runner.query(
      `SELECT rf.id FROM core."rolePermissionFlag" rf INNER JOIN core."permissionFlag" pf ON pf.id=rf."permissionFlagId" WHERE rf."workspaceId"=$1 AND pf."workspaceId"=$1 AND pf."applicationId"=$2 LIMIT 1`,
      [normalizedWorkspaceId, normalizedApplicationId],
    );
    if (depRow) {
      throw new Error(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    }
  }

  if (
    existingTables.has('applicationVariable') &&
    existingTables.has('userApplicationVariableValue')
  ) {
    const [depRow] = await runner.query(
      `SELECT uavv.id FROM core."userApplicationVariableValue" uavv INNER JOIN core."applicationVariable" av ON av.id=uavv."applicationVariableId" WHERE av."workspaceId"=$1 AND av."applicationId"=$2 LIMIT 1`,
      [normalizedWorkspaceId, normalizedApplicationId],
    );
    if (depRow) {
      throw new Error(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    }
  }

  if (existingTables.has('navigationMenuItem')) {
    if (existingTables.has('objectMetadata')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core."objectMetadata" o ON o.id=n."targetObjectMetadataId" WHERE n."workspaceId"=$1 AND o."workspaceId"=$1 AND o."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('view')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core.view v ON v.id=n."viewId" WHERE n."workspaceId"=$1 AND v."workspaceId"=$1 AND v."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('pageLayout')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core."pageLayout" pl ON pl.id=n."pageLayoutId" WHERE n."workspaceId"=$1 AND pl."workspaceId"=$1 AND pl."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('agentChatChannel')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core."agentChatChannel" acc ON acc.id=n."agentChatChannelId" WHERE n."workspaceId"=$1 AND acc."workspaceId"=$1 AND acc."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('view') && existingTables.has('objectMetadata')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core.view v ON v.id=n."viewId" INNER JOIN core."objectMetadata" o ON o.id=v."objectMetadataId" WHERE n."workspaceId"=$1 AND v."workspaceId"=$1 AND o."workspaceId"=$1 AND o."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (existingTables.has('view') && existingTables.has('fieldMetadata')) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core.view v ON v.id=n."viewId" INNER JOIN core."fieldMetadata" f ON (f.id=v."calendarFieldMetadataId" OR f.id=v."mainGroupByFieldMetadataId") WHERE n."workspaceId"=$1 AND v."workspaceId"=$1 AND f."workspaceId"=$1 AND f."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
    if (
      existingTables.has('pageLayout') &&
      existingTables.has('objectMetadata')
    ) {
      const [depRow] = await runner.query(
        `SELECT n.id FROM core."navigationMenuItem" n INNER JOIN core."pageLayout" pl ON pl.id=n."pageLayoutId" INNER JOIN core."objectMetadata" o ON o.id=pl."objectMetadataId" WHERE n."workspaceId"=$1 AND pl."workspaceId"=$1 AND o."workspaceId"=$1 AND o."applicationId"=$2 LIMIT 1`,
        [normalizedWorkspaceId, normalizedApplicationId],
      );
      if (depRow) {
        throw new Error(
          'Application delete requires prior audited removal of role and permission metadata',
        );
      }
    }
  }
};

type ReconcilableEntity = {
  id?: string;
  universalIdentifier: string;
  roleUniversalIdentifier?: string;
  agentUniversalIdentifier?: string | null;
  userWorkspaceId?: string | null;
  apiKeyId?: string | null;
  permissionFlagUniversalIdentifier?: string;
  objectMetadataUniversalIdentifier?: string | null;
  fieldMetadataUniversalIdentifier?: string;
  relationTargetObjectMetadataUniversalIdentifier?: string | null;
  relationTargetFieldMetadataUniversalIdentifier?: string | null;
  morphId?: string | null;
  parentRowLevelPermissionPredicateGroupUniversalIdentifier?: string | null;
  rowLevelPermissionPredicateGroupUniversalIdentifier?: string | null;
  targetObjectMetadataUniversalIdentifier?: string | null;
  viewUniversalIdentifier?: string | null;
  pageLayoutUniversalIdentifier?: string | null;
  agentChatChannelUniversalIdentifier?: string | null;
  channelUniversalIdentifier?: string | null;
  folderUniversalIdentifier?: string | null;
  calendarFieldMetadataUniversalIdentifier?: string | null;
  mainGroupByFieldMetadataUniversalIdentifier?: string | null;
  deletedAt?: string | Date | null;
};

type ReconcilableBucket = {
  flatEntityToCreate: Record<string, ReconcilableEntity>;
  flatEntityToUpdate: Record<string, ReconcilableEntity>;
  flatEntityToDelete: Record<string, ReconcilableEntity>;
};

const ensureOperationBucket = (
  record: Record<string, ReconcilableBucket | undefined>,
  metadataName: string,
): ReconcilableBucket => {
  const existing = record[metadataName];
  if (existing !== undefined && existing !== null) {
    return existing;
  }
  const created: ReconcilableBucket = {
    flatEntityToCreate: {},
    flatEntityToUpdate: {},
    flatEntityToDelete: {},
  };
  record[metadataName] = created;
  return created;
};

const isPresent = <TValue>(value: TValue | null | undefined): value is TValue =>
  value !== null && value !== undefined;

export const reconcileApplicationRoleAndPermissionOperations = ({
  allFlatEntityOperationRecordByMetadataName,
  existingAllFlatEntityMaps,
  ownedAgentUniversalIdentifiers = [],
  toRoleTargetByAgentUniversalIdentifier = {},
  inferDeletionFromMissingEntities = true,
}: {
  allFlatEntityOperationRecordByMetadataName: object;
  existingAllFlatEntityMaps: {
    flatFieldMetadataMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatRoleTargetMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatRolePermissionFlagMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatObjectPermissionMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatFieldPermissionMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatRowLevelPermissionPredicateGroupMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatRowLevelPermissionPredicateMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatViewMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatPageLayoutMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatAgentChatChannelMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatAgentChatChannelRoleMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
    flatNavigationMenuItemMaps?: {
      byUniversalIdentifier: Partial<Record<string, ReconcilableEntity>>;
    };
  };
  ownedAgentUniversalIdentifiers?: readonly string[];
  toRoleTargetByAgentUniversalIdentifier?: Readonly<
    Record<string, { universalIdentifier: string } | undefined>
  >;
  inferDeletionFromMissingEntities?: boolean;
}): void => {
  const record = allFlatEntityOperationRecordByMetadataName as Record<
    string,
    ReconcilableBucket | undefined
  >;
  const ownedAgentSet = new Set(ownedAgentUniversalIdentifiers);
  const deletedRoleUniversalIdentifiers = new Set(
    Object.keys(record.role?.flatEntityToDelete ?? {}),
  );
  const deletedAgentUniversalIdentifiers = new Set(
    Object.keys(record.agent?.flatEntityToDelete ?? {}),
  );
  const deletedObjectUniversalIdentifiers = new Set(
    Object.keys(record.objectMetadata?.flatEntityToDelete ?? {}),
  );
  const deletedFieldUniversalIdentifiers = new Set(
    Object.keys(record.fieldMetadata?.flatEntityToDelete ?? {}),
  );
  const deletedPermissionFlagUniversalIdentifiers = new Set(
    Object.keys(record.permissionFlag?.flatEntityToDelete ?? {}),
  );

  const allExistingFields = Object.values(
    existingAllFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier ??
      {},
  ).filter(isPresent);
  const createdFields = Object.values(
    record.fieldMetadata?.flatEntityToCreate ?? {},
  ).filter(isPresent);
  let fieldAdded = true;
  while (fieldAdded) {
    fieldAdded = false;
    for (const existingField of allExistingFields) {
      if (
        deletedFieldUniversalIdentifiers.has(existingField.universalIdentifier)
      ) {
        continue;
      }
      const objUid = existingField.objectMetadataUniversalIdentifier;
      const relTargetObjUid =
        existingField.relationTargetObjectMetadataUniversalIdentifier;
      const relTargetFieldUid =
        existingField.relationTargetFieldMetadataUniversalIdentifier;
      if (
        (isPresent(objUid) && deletedObjectUniversalIdentifiers.has(objUid)) ||
        (isPresent(relTargetObjUid) &&
          deletedObjectUniversalIdentifiers.has(relTargetObjUid)) ||
        (isPresent(relTargetFieldUid) &&
          deletedFieldUniversalIdentifiers.has(relTargetFieldUid))
      ) {
        deletedFieldUniversalIdentifiers.add(existingField.universalIdentifier);
        fieldAdded = true;
      }
    }
    for (const existingField of allExistingFields) {
      if (
        !deletedFieldUniversalIdentifiers.has(existingField.universalIdentifier)
      ) {
        continue;
      }
      const relTargetFieldUid =
        existingField.relationTargetFieldMetadataUniversalIdentifier;
      if (
        isPresent(relTargetFieldUid) &&
        !deletedFieldUniversalIdentifiers.has(relTargetFieldUid)
      ) {
        deletedFieldUniversalIdentifiers.add(relTargetFieldUid);
        fieldAdded = true;
      }
      const morphId = existingField.morphId;
      const objUid = existingField.objectMetadataUniversalIdentifier;
      if (
        !isPresent(morphId) ||
        !isPresent(objUid) ||
        morphId === existingField.universalIdentifier ||
        deletedFieldUniversalIdentifiers.has(morphId)
      ) {
        continue;
      }
      const hasRemainingTarget = [
        ...allExistingFields.filter(
          (f) => !deletedFieldUniversalIdentifiers.has(f.universalIdentifier),
        ),
        ...createdFields,
      ].some(
        (f) =>
          f.objectMetadataUniversalIdentifier === objUid &&
          f.morphId === morphId &&
          f.universalIdentifier !== morphId,
      );
      if (!hasRemainingTarget) {
        deletedFieldUniversalIdentifiers.add(morphId);
        fieldAdded = true;
      }
    }
  }

  for (const existingTarget of Object.values(
    existingAllFlatEntityMaps.flatRoleTargetMaps?.byUniversalIdentifier ?? {},
  )) {
    if (!isPresent(existingTarget)) continue;
    const agentUid = existingTarget.agentUniversalIdentifier;
    if (!isPresent(agentUid)) continue;
    if (
      isPresent(existingTarget.userWorkspaceId) ||
      isPresent(existingTarget.apiKeyId)
    ) {
      continue;
    }

    const desiredTarget = toRoleTargetByAgentUniversalIdentifier[agentUid];
    const isReplacedOwnedAgentBinding =
      ownedAgentSet.has(agentUid) &&
      (isPresent(desiredTarget)
        ? desiredTarget.universalIdentifier !==
          existingTarget.universalIdentifier
        : inferDeletionFromMissingEntities);
    const isCascadeDeletedBinding =
      deletedAgentUniversalIdentifiers.has(agentUid) ||
      (isPresent(existingTarget.roleUniversalIdentifier) &&
        deletedRoleUniversalIdentifiers.has(
          existingTarget.roleUniversalIdentifier,
        ));

    if (
      (isReplacedOwnedAgentBinding || isCascadeDeletedBinding) &&
      !isPresent(
        record.roleTarget?.flatEntityToCreate[
          existingTarget.universalIdentifier
        ],
      ) &&
      !isPresent(
        record.roleTarget?.flatEntityToUpdate[
          existingTarget.universalIdentifier
        ],
      )
    ) {
      const bucket = ensureOperationBucket(record, 'roleTarget');
      bucket.flatEntityToDelete[existingTarget.universalIdentifier] =
        existingTarget;
    }
  }

  for (const existingRoleFlag of Object.values(
    existingAllFlatEntityMaps.flatRolePermissionFlagMaps
      ?.byUniversalIdentifier ?? {},
  )) {
    if (!isPresent(existingRoleFlag)) continue;
    if (
      (isPresent(existingRoleFlag.roleUniversalIdentifier) &&
        deletedRoleUniversalIdentifiers.has(
          existingRoleFlag.roleUniversalIdentifier,
        )) ||
      (isPresent(existingRoleFlag.permissionFlagUniversalIdentifier) &&
        deletedPermissionFlagUniversalIdentifiers.has(
          existingRoleFlag.permissionFlagUniversalIdentifier,
        ))
    ) {
      const bucket = ensureOperationBucket(record, 'rolePermissionFlag');
      bucket.flatEntityToDelete[existingRoleFlag.universalIdentifier] =
        existingRoleFlag;
    }
  }

  for (const existingObjPerm of Object.values(
    existingAllFlatEntityMaps.flatObjectPermissionMaps?.byUniversalIdentifier ??
      {},
  )) {
    if (!isPresent(existingObjPerm)) continue;
    if (
      (isPresent(existingObjPerm.roleUniversalIdentifier) &&
        deletedRoleUniversalIdentifiers.has(
          existingObjPerm.roleUniversalIdentifier,
        )) ||
      (isPresent(existingObjPerm.objectMetadataUniversalIdentifier) &&
        deletedObjectUniversalIdentifiers.has(
          existingObjPerm.objectMetadataUniversalIdentifier,
        ))
    ) {
      const bucket = ensureOperationBucket(record, 'objectPermission');
      bucket.flatEntityToDelete[existingObjPerm.universalIdentifier] =
        existingObjPerm;
    }
  }

  for (const existingFieldPerm of Object.values(
    existingAllFlatEntityMaps.flatFieldPermissionMaps?.byUniversalIdentifier ??
      {},
  )) {
    if (!isPresent(existingFieldPerm)) continue;
    if (
      (isPresent(existingFieldPerm.roleUniversalIdentifier) &&
        deletedRoleUniversalIdentifiers.has(
          existingFieldPerm.roleUniversalIdentifier,
        )) ||
      (isPresent(existingFieldPerm.objectMetadataUniversalIdentifier) &&
        deletedObjectUniversalIdentifiers.has(
          existingFieldPerm.objectMetadataUniversalIdentifier,
        )) ||
      (isPresent(existingFieldPerm.fieldMetadataUniversalIdentifier) &&
        deletedFieldUniversalIdentifiers.has(
          existingFieldPerm.fieldMetadataUniversalIdentifier,
        ))
    ) {
      const bucket = ensureOperationBucket(record, 'fieldPermission');
      bucket.flatEntityToDelete[existingFieldPerm.universalIdentifier] =
        existingFieldPerm;
    }
  }

  const deletedGroupUniversalIdentifiers = new Set(
    Object.keys(
      record.rowLevelPermissionPredicateGroup?.flatEntityToDelete ?? {},
    ),
  );
  const allGroups = Object.values(
    existingAllFlatEntityMaps.flatRowLevelPermissionPredicateGroupMaps
      ?.byUniversalIdentifier ?? {},
  )
    .filter(isPresent)
    .filter((group) => !isPresent(group.deletedAt));

  let groupAdded = true;
  while (groupAdded) {
    groupAdded = false;
    for (const existingGroup of allGroups) {
      if (
        deletedGroupUniversalIdentifiers.has(existingGroup.universalIdentifier)
      ) {
        continue;
      }
      const parentGroupUid =
        existingGroup.parentRowLevelPermissionPredicateGroupUniversalIdentifier;
      if (
        (isPresent(existingGroup.roleUniversalIdentifier) &&
          deletedRoleUniversalIdentifiers.has(
            existingGroup.roleUniversalIdentifier,
          )) ||
        (isPresent(existingGroup.objectMetadataUniversalIdentifier) &&
          deletedObjectUniversalIdentifiers.has(
            existingGroup.objectMetadataUniversalIdentifier,
          )) ||
        (isPresent(parentGroupUid) &&
          deletedGroupUniversalIdentifiers.has(parentGroupUid))
      ) {
        const bucket = ensureOperationBucket(
          record,
          'rowLevelPermissionPredicateGroup',
        );
        bucket.flatEntityToDelete[existingGroup.universalIdentifier] =
          existingGroup;
        deletedGroupUniversalIdentifiers.add(existingGroup.universalIdentifier);
        groupAdded = true;
      }
    }
  }

  for (const existingPredicate of Object.values(
    existingAllFlatEntityMaps.flatRowLevelPermissionPredicateMaps
      ?.byUniversalIdentifier ?? {},
  )) {
    if (!isPresent(existingPredicate) || isPresent(existingPredicate.deletedAt))
      continue;
    const groupUid =
      existingPredicate.rowLevelPermissionPredicateGroupUniversalIdentifier;
    if (
      (isPresent(existingPredicate.roleUniversalIdentifier) &&
        deletedRoleUniversalIdentifiers.has(
          existingPredicate.roleUniversalIdentifier,
        )) ||
      (isPresent(existingPredicate.objectMetadataUniversalIdentifier) &&
        deletedObjectUniversalIdentifiers.has(
          existingPredicate.objectMetadataUniversalIdentifier,
        )) ||
      (isPresent(existingPredicate.fieldMetadataUniversalIdentifier) &&
        deletedFieldUniversalIdentifiers.has(
          existingPredicate.fieldMetadataUniversalIdentifier,
        )) ||
      (isPresent(groupUid) && deletedGroupUniversalIdentifiers.has(groupUid))
    ) {
      const bucket = ensureOperationBucket(
        record,
        'rowLevelPermissionPredicate',
      );
      bucket.flatEntityToDelete[existingPredicate.universalIdentifier] =
        existingPredicate;
    }
  }

  const deletedChannelUniversalIdentifiers = new Set(
    Object.keys(record.agentChatChannel?.flatEntityToDelete ?? {}),
  );
  if (existingAllFlatEntityMaps.flatAgentChatChannelRoleMaps) {
    for (const existingChannelRole of Object.values(
      existingAllFlatEntityMaps.flatAgentChatChannelRoleMaps
        .byUniversalIdentifier,
    )) {
      if (!isPresent(existingChannelRole)) continue;
      if (
        (isPresent(existingChannelRole.roleUniversalIdentifier) &&
          deletedRoleUniversalIdentifiers.has(
            existingChannelRole.roleUniversalIdentifier,
          )) ||
        (isPresent(existingChannelRole.channelUniversalIdentifier) &&
          deletedChannelUniversalIdentifiers.has(
            existingChannelRole.channelUniversalIdentifier,
          ))
      ) {
        const bucket = ensureOperationBucket(record, 'agentChatChannelRole');
        bucket.flatEntityToDelete[existingChannelRole.universalIdentifier] =
          existingChannelRole;
      }
    }
  }

  if (existingAllFlatEntityMaps.flatNavigationMenuItemMaps) {
    const deletedViewUniversalIdentifiers = new Set(
      Object.keys(record.view?.flatEntityToDelete ?? {}),
    );
    for (const existingView of Object.values(
      existingAllFlatEntityMaps.flatViewMaps?.byUniversalIdentifier ?? {},
    )) {
      if (!isPresent(existingView)) continue;
      if (
        (isPresent(existingView.objectMetadataUniversalIdentifier) &&
          deletedObjectUniversalIdentifiers.has(
            existingView.objectMetadataUniversalIdentifier,
          )) ||
        (isPresent(existingView.calendarFieldMetadataUniversalIdentifier) &&
          deletedFieldUniversalIdentifiers.has(
            existingView.calendarFieldMetadataUniversalIdentifier,
          )) ||
        (isPresent(existingView.mainGroupByFieldMetadataUniversalIdentifier) &&
          deletedFieldUniversalIdentifiers.has(
            existingView.mainGroupByFieldMetadataUniversalIdentifier,
          ))
      ) {
        deletedViewUniversalIdentifiers.add(existingView.universalIdentifier);
      }
    }

    const deletedPageLayoutUniversalIdentifiers = new Set(
      Object.keys(record.pageLayout?.flatEntityToDelete ?? {}),
    );
    for (const existingLayout of Object.values(
      existingAllFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier ?? {},
    )) {
      if (!isPresent(existingLayout)) continue;
      if (
        isPresent(existingLayout.objectMetadataUniversalIdentifier) &&
        deletedObjectUniversalIdentifiers.has(
          existingLayout.objectMetadataUniversalIdentifier,
        )
      ) {
        deletedPageLayoutUniversalIdentifiers.add(
          existingLayout.universalIdentifier,
        );
      }
    }

    const deletedNavUniversalIdentifiers = new Set(
      Object.keys(record.navigationMenuItem?.flatEntityToDelete ?? {}),
    );
    const allNavItems = Object.values(
      existingAllFlatEntityMaps.flatNavigationMenuItemMaps
        .byUniversalIdentifier,
    ).filter(isPresent);

    for (const navItem of allNavItems) {
      if (deletedNavUniversalIdentifiers.has(navItem.universalIdentifier)) {
        continue;
      }
      const targetObjUid = navItem.targetObjectMetadataUniversalIdentifier;
      const viewUid = navItem.viewUniversalIdentifier;
      const layoutUid = navItem.pageLayoutUniversalIdentifier;
      const channelUid = navItem.agentChatChannelUniversalIdentifier;
      if (
        (isPresent(targetObjUid) &&
          deletedObjectUniversalIdentifiers.has(targetObjUid)) ||
        (isPresent(viewUid) && deletedViewUniversalIdentifiers.has(viewUid)) ||
        (isPresent(layoutUid) &&
          deletedPageLayoutUniversalIdentifiers.has(layoutUid)) ||
        (isPresent(channelUid) &&
          deletedChannelUniversalIdentifiers.has(channelUid))
      ) {
        const bucket = ensureOperationBucket(record, 'navigationMenuItem');
        bucket.flatEntityToDelete[navItem.universalIdentifier] = navItem;
        deletedNavUniversalIdentifiers.add(navItem.universalIdentifier);
      }
    }

    let navAdded = true;
    while (navAdded) {
      navAdded = false;
      for (const navItem of allNavItems) {
        if (deletedNavUniversalIdentifiers.has(navItem.universalIdentifier)) {
          continue;
        }
        const folderUid = navItem.folderUniversalIdentifier;
        if (
          isPresent(folderUid) &&
          deletedNavUniversalIdentifiers.has(folderUid)
        ) {
          const bucket = ensureOperationBucket(record, 'navigationMenuItem');
          bucket.flatEntityToDelete[navItem.universalIdentifier] = navItem;
          deletedNavUniversalIdentifiers.add(navItem.universalIdentifier);
          navAdded = true;
        }
      }
    }
  }
};
