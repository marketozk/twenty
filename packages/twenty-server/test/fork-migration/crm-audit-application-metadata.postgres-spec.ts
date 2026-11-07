import { randomUUID } from 'node:crypto';
import { type Manifest } from 'twenty-shared/application';
import { ALL_METADATA_NAME } from 'twenty-shared/metadata';
import {
  FieldMetadataType,
  RowLevelPermissionPredicateGroupLogicalOperator,
  RowLevelPermissionPredicateOperand,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureApplicationMetadataAudit,
  runAuditedApplicationMetadataMigration,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { systemMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: { ROLE: 'ROLE' },
  isAiModelTier: jest.fn(() => true),
}));
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration.entity',
  () => ({ ApplicationRegistrationEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-variable/application-variable.entity',
  () => ({ ApplicationVariableEntity: class {} }),
);
jest.mock('src/engine/core-modules/application/application.entity', () => ({
  ApplicationEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/application/application-lookup/application-lookup.service',
  () => ({ ApplicationLookupService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/utils/serialize-application-for-broadcast.util',
  () => ({
    serializeApplicationForBroadcast: jest.fn((app: unknown) => app),
  }),
);
jest.mock(
  'src/engine/core-modules/file-storage/services/file-storage.service',
  () => ({ FileStorageService: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock('src/engine/core-modules/logger/logger.service', () => ({
  LoggerService: class {},
}));
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/workflow/services/workflow-version-core-sync.service',
  () => ({ WorkflowVersionCoreSyncService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/ai/ai-agent/entities/agent.entity',
  () => ({ AgentEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/command-menu-item/entities/command-menu-item.entity',
  () => ({ CommandMenuItemEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
  () => ({ ConnectedAccountMetadataService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/front-component/entities/front-component.entity',
  () => ({ FrontComponentEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/logic-function/logic-function.entity',
  () => ({ LogicFunctionEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-metadata/object-metadata.entity',
  () => ({ ObjectMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/settings-menu-item/entities/settings-menu-item.entity',
  () => ({ SettingsMenuItemEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
  () => ({ WorkspaceMetadataVersionService: class {} }),
);
jest.mock(
  'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service',
  () => ({ WorkspaceEventBroadcaster: class {} }),
);
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/workspace-cache/services/workspace-cache.service',
  () => ({ WorkspaceCacheService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant',
  () => ({
    computeTwentyStandardApplicationAllFlatEntityMaps: jest.fn(),
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
  () => ({
    WorkspaceMigrationRunnerActionHandlerRegistryService: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
  () => ({
    DeferredWorkspaceMigrationActionRunnerService: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
  () => ({
    InFlightDeferredWorkspaceMigrationActionsService: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/services/application-uninstall.service',
  () => ({ ApplicationUninstallService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-translation/application-translation-sync.service',
  () => ({ ApplicationTranslationSyncService: class {} }),
);

const { ApplicationService } =
  require('src/engine/core-modules/application/application.service') as typeof import('src/engine/core-modules/application/application.service');
const {
  ComputeApplicationManifestAllUniversalFlatEntityMapsService,
} = require('src/engine/core-modules/application/application-manifest/services/compute-application-manifest-all-universal-flat-entity-maps.service');
const { ApplicationManifestMigrationService } =
  require('src/engine/core-modules/application/application-manifest/application-manifest-migration.service') as typeof import('src/engine/core-modules/application/application-manifest/application-manifest-migration.service');
const { ApplicationSyncService } =
  require('src/engine/core-modules/application/application-manifest/application-sync.service') as typeof import('src/engine/core-modules/application/application-manifest/application-sync.service');
const { TwentyStandardApplicationService } =
  require('src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service') as typeof import('src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service');
const {
  computeTwentyStandardApplicationAllFlatEntityMaps,
} = require('src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `app_meta_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorMemberId = randomUUID();
const actorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();

const standardAppId = randomUUID();
const customAppId = randomUUID();
const customAppUniversalId = randomUUID();
const manifestAppId = randomUUID();
const manifestAppUniversalId = randomUUID();

const adminRoleId = randomUUID();
const manifestRoleOneId = randomUUID();
const manifestRoleOneUniversalId = randomUUID();
const manifestRoleTwoId = randomUUID();
const manifestRoleTwoUniversalId = randomUUID();

const manifestAgentId = randomUUID();
const manifestAgentUniversalId = randomUUID();

const companyObjectId = randomUUID();
const companyObjectUniversalId = randomUUID();
const companyNameFieldId = randomUUID();
const companyNameFieldUniversalId = randomUUID();
const memberFieldId = randomUUID();
const memberFieldUniversalId = randomUUID();
const appPermissionFlagId = randomUUID();
const appPermissionFlagUniversalId = randomUUID();

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-app-meta-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const systemIdentity = (
  systemActorId: string,
  targetWorkspaceId = workspaceId,
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'system',
    workspace: { id: targetWorkspaceId },
  },
  systemActorId,
});

const userIdentity = (
  extra: Partial<RoleUpdateAuditIdentity> = {},
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorMemberId,
  },
  ...extra,
});

const emptyMap = () => ({
  byId: {} as Record<string, Row>,
  idByUniversalIdentifier: {} as Record<string, string>,
  universalIdentifierById: {} as Record<string, string>,
  universalIdentifiersByApplicationId: {} as Record<string, string[]>,
  byUniversalIdentifier: {} as Record<string, Row>,
});

const addEntityToMap = (
  map: ReturnType<typeof emptyMap>,
  entity: Row & {
    universalIdentifier: string;
    applicationId: string;
    applicationUniversalIdentifier: string;
  },
) => {
  map.byId[entity.id] = entity;
  map.idByUniversalIdentifier[entity.universalIdentifier] = entity.id;
  map.universalIdentifierById[entity.id] = entity.universalIdentifier;
  map.byUniversalIdentifier[entity.universalIdentifier] = entity;
  const list =
    map.universalIdentifiersByApplicationId[entity.applicationId] ?? [];
  if (!list.includes(entity.universalIdentifier)) {
    list.push(entity.universalIdentifier);
  }
  map.universalIdentifiersByApplicationId[entity.applicationId] = list;
};

const loadAllMapsFromDb = async (wsId: string) => {
  const apps: Row[] = await owner.query(
    'SELECT * FROM core.application WHERE "workspaceId"=$1 AND "deletedAt" IS NULL ORDER BY id',
    [wsId],
  );
  const appUidById = new Map<string, string>(
    apps.map((a) => [a.id, String(a.universalIdentifier)]),
  );

  const flatApplicationMaps = emptyMap();
  for (const app of apps) {
    addEntityToMap(flatApplicationMaps, {
      ...app,
      universalIdentifier: String(app.universalIdentifier),
      applicationId: app.id,
      applicationUniversalIdentifier: String(app.universalIdentifier),
    });
  }

  const roles: Row[] = await owner.query(
    'SELECT * FROM core.role WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const roleUidById = new Map<string, string>(
    roles.map((r) => [r.id, String(r.universalIdentifier)]),
  );
  const flatRoleMaps = emptyMap();
  for (const role of roles) {
    addEntityToMap(flatRoleMaps, {
      ...role,
      universalIdentifier: String(role.universalIdentifier),
      applicationId: String(role.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(role.applicationId),
      )!,
      roleTargetUniversalIdentifiers: [],
      objectPermissionUniversalIdentifiers: [],
      fieldPermissionUniversalIdentifiers: [],
      rolePermissionFlagUniversalIdentifiers: [],
      rowLevelPermissionPredicateUniversalIdentifiers: [],
      rowLevelPermissionPredicateGroupUniversalIdentifiers: [],
      agentChatChannelRoleUniversalIdentifiers: [],
    });
  }

  const agents: Row[] = await owner.query(
    'SELECT * FROM core.agent WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const agentUidById = new Map<string, string>(
    agents.map((a) => [a.id, String(a.universalIdentifier)]),
  );
  const flatAgentMaps = emptyMap();
  for (const agent of agents) {
    addEntityToMap(flatAgentMaps, {
      ...agent,
      universalIdentifier: String(agent.universalIdentifier),
      applicationId: String(agent.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(agent.applicationId),
      )!,
    });
  }

  const objects: Row[] = await owner.query(
    'SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const objUidById = new Map<string, string>(
    objects.map((o) => [o.id, String(o.universalIdentifier)]),
  );
  const flatObjectMetadataMaps = emptyMap();
  for (const obj of objects) {
    addEntityToMap(flatObjectMetadataMaps, {
      ...obj,
      universalIdentifier: String(obj.universalIdentifier),
      applicationId: String(obj.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(obj.applicationId),
      )!,
    });
  }

  const fields: Row[] = await owner.query(
    'SELECT * FROM core."fieldMetadata" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const fieldUidById = new Map<string, string>(
    fields.map((f) => [f.id, String(f.universalIdentifier)]),
  );
  const flatFieldMetadataMaps = emptyMap();
  for (const field of fields) {
    addEntityToMap(flatFieldMetadataMaps, {
      ...field,
      universalIdentifier: String(field.universalIdentifier),
      applicationId: String(field.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(field.applicationId),
      )!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(field.objectMetadataId),
      )!,
    });
  }

  const permFlags: Row[] = await owner.query(
    'SELECT * FROM core."permissionFlag" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const permFlagUidById = new Map<string, string>(
    permFlags.map((pf) => [pf.id, String(pf.universalIdentifier)]),
  );
  const flatPermissionFlagMaps = emptyMap();
  for (const pf of permFlags) {
    addEntityToMap(flatPermissionFlagMaps, {
      ...pf,
      universalIdentifier: String(pf.universalIdentifier),
      applicationId: String(pf.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(pf.applicationId))!,
    });
  }

  const roleTargets: Row[] = await owner.query(
    'SELECT * FROM core."roleTarget" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatRoleTargetMaps = emptyMap();
  for (const rt of roleTargets) {
    addEntityToMap(flatRoleTargetMaps, {
      ...rt,
      universalIdentifier: String(rt.universalIdentifier),
      applicationId: String(rt.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(rt.applicationId))!,
      roleUniversalIdentifier: roleUidById.get(String(rt.roleId))!,
      agentUniversalIdentifier: rt.agentId
        ? (agentUidById.get(String(rt.agentId)) ?? null)
        : null,
    });
  }

  const rolePermFlags: Row[] = await owner.query(
    'SELECT * FROM core."rolePermissionFlag" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatRolePermissionFlagMaps = emptyMap();
  for (const rpf of rolePermFlags) {
    addEntityToMap(flatRolePermissionFlagMaps, {
      ...rpf,
      universalIdentifier: String(rpf.universalIdentifier),
      applicationId: String(rpf.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(rpf.applicationId),
      )!,
      roleUniversalIdentifier: roleUidById.get(String(rpf.roleId))!,
      permissionFlagUniversalIdentifier: permFlagUidById.get(
        String(rpf.permissionFlagId),
      )!,
    });
  }

  const objPerms: Row[] = await owner.query(
    'SELECT * FROM core."objectPermission" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatObjectPermissionMaps = emptyMap();
  for (const op of objPerms) {
    addEntityToMap(flatObjectPermissionMaps, {
      ...op,
      universalIdentifier: String(op.universalIdentifier),
      applicationId: String(op.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(op.applicationId))!,
      roleUniversalIdentifier: roleUidById.get(String(op.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(op.objectMetadataId),
      )!,
    });
  }

  const fieldPerms: Row[] = await owner.query(
    'SELECT * FROM core."fieldPermission" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatFieldPermissionMaps = emptyMap();
  for (const fp of fieldPerms) {
    addEntityToMap(flatFieldPermissionMaps, {
      ...fp,
      universalIdentifier: String(fp.universalIdentifier),
      applicationId: String(fp.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(fp.applicationId))!,
      roleUniversalIdentifier: roleUidById.get(String(fp.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(fp.objectMetadataId),
      )!,
      fieldMetadataUniversalIdentifier: fieldUidById.get(
        String(fp.fieldMetadataId),
      )!,
    });
  }

  const groups: Row[] = await owner.query(
    'SELECT * FROM core."rowLevelPermissionPredicateGroup" WHERE "workspaceId"=$1 AND "deletedAt" IS NULL ORDER BY id',
    [wsId],
  );
  const groupUidById = new Map<string, string>(
    groups.map((g) => [g.id, String(g.universalIdentifier)]),
  );
  const flatRowLevelPermissionPredicateGroupMaps = emptyMap();
  for (const group of groups) {
    addEntityToMap(flatRowLevelPermissionPredicateGroupMaps, {
      ...group,
      universalIdentifier: String(group.universalIdentifier),
      applicationId: String(group.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(group.applicationId),
      )!,
      roleUniversalIdentifier: roleUidById.get(String(group.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(group.objectMetadataId),
      )!,
      parentRowLevelPermissionPredicateGroupUniversalIdentifier:
        group.parentRowLevelPermissionPredicateGroupId
          ? (groupUidById.get(
              String(group.parentRowLevelPermissionPredicateGroupId),
            ) ?? null)
          : null,
      childRowLevelPermissionPredicateGroupUniversalIdentifiers: [],
      rowLevelPermissionPredicateUniversalIdentifiers: [],
    });
  }

  const preds: Row[] = await owner.query(
    'SELECT * FROM core."rowLevelPermissionPredicate" WHERE "workspaceId"=$1 AND "deletedAt" IS NULL ORDER BY id',
    [wsId],
  );
  const flatRowLevelPermissionPredicateMaps = emptyMap();
  for (const pred of preds) {
    addEntityToMap(flatRowLevelPermissionPredicateMaps, {
      ...pred,
      universalIdentifier: String(pred.universalIdentifier),
      applicationId: String(pred.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(pred.applicationId),
      )!,
      roleUniversalIdentifier: roleUidById.get(String(pred.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(pred.objectMetadataId),
      )!,
      fieldMetadataUniversalIdentifier: fieldUidById.get(
        String(pred.fieldMetadataId),
      )!,
      workspaceMemberFieldMetadataUniversalIdentifier:
        pred.workspaceMemberFieldMetadataId
          ? (fieldUidById.get(String(pred.workspaceMemberFieldMetadataId)) ??
            null)
          : null,
      rowLevelPermissionPredicateGroupUniversalIdentifier:
        pred.rowLevelPermissionPredicateGroupId
          ? (groupUidById.get(
              String(pred.rowLevelPermissionPredicateGroupId),
            ) ?? null)
          : null,
    });
  }

  const base: Record<string, unknown> = {
    flatApplicationMaps,
    flatRoleMaps,
    flatAgentMaps,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    flatPermissionFlagMaps,
    flatRoleTargetMaps,
    flatRolePermissionFlagMaps,
    flatObjectPermissionMaps,
    flatFieldPermissionMaps,
    flatRowLevelPermissionPredicateGroupMaps,
    flatRowLevelPermissionPredicateMaps,
    featureFlagsMap: {},
    billingEntitlements: {},
  };
  for (const metadataName of Object.values(ALL_METADATA_NAME)) {
    const key = getMetadataFlatEntityMapsKey(metadataName);
    if (!(key in base)) {
      base[key] = emptyMap();
    }
  }
  return base;
};

const buildHarness = () => {
  const workspaceCacheService = {
    invalidateAndRecompute: jest.fn(async () => {}),
    getOrRecompute: jest.fn(async (wsId: string) => loadAllMapsFromDb(wsId)),
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(
      async ({ workspaceId: wsId }: { workspaceId: string }) =>
        loadAllMapsFromDb(wsId),
    ),
  };

  const executeSqlAction = async (
    action: {
      type: 'create' | 'update' | 'delete';
      metadataName: string;
      id?: string;
      universalIdentifier?: string;
      flatEntity?: Record<string, unknown>;
      update?: Record<string, unknown>;
    },
    context: {
      flatApplication: Row;
      allFlatEntityMaps: Record<string, ReturnType<typeof emptyMap>>;
      queryRunner: QueryRunner;
      workspaceId: string;
    },
  ) => {
    const {
      queryRunner: qr,
      workspaceId: wsId,
      flatApplication,
      allFlatEntityMaps,
    } = context;
    const resolveId = (
      mapsKey: string,
      uid: unknown,
      createdByKey: Map<string, string>,
    ): string | null => {
      if (!isDefined(uid)) return null;
      const str = String(uid);
      return (
        createdByKey.get(`${mapsKey}:${str}`) ??
        allFlatEntityMaps[mapsKey]?.idByUniversalIdentifier[str] ??
        null
      );
    };
    const createdByKey: Map<string, string> =
      (qr.data as { createdByKey?: Map<string, string> }).createdByKey ??
      new Map();
    qr.data = { ...qr.data, createdByKey };

    const m = action.metadataName;
    if (m === 'role') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        createdByKey.set(`flatRoleMaps:${e.universalIdentifier}`, id);
        await qr.query(
          `INSERT INTO core.role (
            id, "workspaceId", "applicationId", "universalIdentifier", label, description, icon,
            "isEditable", "canUpdateAllSettings", "canAccessAllTools", "canAccessAllAgentChatChannels",
            "canReadAllObjectRecords", "canUpdateAllObjectRecords", "canSoftDeleteAllObjectRecords",
            "canDestroyAllObjectRecords", "canBeAssignedToUsers", "canBeAssignedToAgents", "canBeAssignedToApiKeys"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            e.label,
            e.description ?? null,
            e.icon ?? null,
            e.isEditable ?? true,
            e.canUpdateAllSettings ?? false,
            e.canAccessAllTools ?? false,
            e.canAccessAllAgentChatChannels ?? false,
            e.canReadAllObjectRecords ?? false,
            e.canUpdateAllObjectRecords ?? false,
            e.canSoftDeleteAllObjectRecords ?? false,
            e.canDestroyAllObjectRecords ?? false,
            e.canBeAssignedToUsers ?? true,
            e.canBeAssignedToAgents ?? true,
            e.canBeAssignedToApiKeys ?? true,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatRoleMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        const u = action.update ?? {};
        for (const [col, val] of Object.entries(u)) {
          await qr.query(
            `UPDATE core.role SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
            [val, id, wsId],
          );
        }
      } else {
        const id = resolveId(
          'flatRoleMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'agent') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        createdByKey.set(`flatAgentMaps:${e.universalIdentifier}`, id);
        await qr.query(
          `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier", name, label)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            e.name ?? 'agent',
            e.label ?? 'Agent',
          ],
        );
      } else if (action.type === 'delete') {
        const id = resolveId(
          'flatAgentMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core.agent WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'roleTarget') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const agentId = resolveId(
          'flatAgentMaps',
          e.agentUniversalIdentifier,
          createdByKey,
        );
        await qr.query(
          `INSERT INTO core."roleTarget" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "agentId", "userWorkspaceId", "apiKeyId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            roleId,
            agentId,
            e.userWorkspaceId ?? null,
            e.apiKeyId ?? null,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatRoleTargetMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        const u = action.update ?? {};
        const roleId =
          resolveId(
            'flatRoleMaps',
            u.roleUniversalIdentifier ?? u.roleId,
            createdByKey,
          ) ?? u.roleId;
        await qr.query(
          'UPDATE core."roleTarget" SET "roleId"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3',
          [roleId, id, wsId],
        );
      } else {
        const id = resolveId(
          'flatRoleTargetMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'rolePermissionFlag') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const flagId = resolveId(
          'flatPermissionFlagMaps',
          e.permissionFlagUniversalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          `INSERT INTO core."rolePermissionFlag" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "permissionFlagId")
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, wsId, flatApplication.id, e.universalIdentifier, roleId, flagId],
        );
      } else if (action.type === 'delete') {
        const id = resolveId(
          'flatRolePermissionFlagMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."rolePermissionFlag" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'objectPermission') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const objId = resolveId(
          'flatObjectMetadataMaps',
          e.objectMetadataUniversalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          `INSERT INTO core."objectPermission" (
            id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId",
            "canReadObjectRecords", "canUpdateObjectRecords", "canSoftDeleteObjectRecords", "canDestroyObjectRecords"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            roleId,
            objId,
            e.canReadObjectRecords ?? null,
            e.canUpdateObjectRecords ?? null,
            e.canSoftDeleteObjectRecords ?? null,
            e.canDestroyObjectRecords ?? null,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatObjectPermissionMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        for (const [col, val] of Object.entries(action.update ?? {})) {
          await qr.query(
            `UPDATE core."objectPermission" SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
            [val, id, wsId],
          );
        }
      } else {
        const id = resolveId(
          'flatObjectPermissionMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."objectPermission" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'fieldPermission') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const objId = resolveId(
          'flatObjectMetadataMaps',
          e.objectMetadataUniversalIdentifier,
          createdByKey,
        )!;
        const fieldId = resolveId(
          'flatFieldMetadataMaps',
          e.fieldMetadataUniversalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          `INSERT INTO core."fieldPermission" (
            id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
            "canReadFieldValue", "canUpdateFieldValue"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            roleId,
            objId,
            fieldId,
            e.canReadFieldValue ?? null,
            e.canUpdateFieldValue ?? null,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatFieldPermissionMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        for (const [col, val] of Object.entries(action.update ?? {})) {
          await qr.query(
            `UPDATE core."fieldPermission" SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
            [val, id, wsId],
          );
        }
      } else {
        const id = resolveId(
          'flatFieldPermissionMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."fieldPermission" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'rowLevelPermissionPredicateGroup') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        createdByKey.set(
          `flatRowLevelPermissionPredicateGroupMaps:${e.universalIdentifier}`,
          id,
        );
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const objId = resolveId(
          'flatObjectMetadataMaps',
          e.objectMetadataUniversalIdentifier,
          createdByKey,
        )!;
        const parentId = resolveId(
          'flatRowLevelPermissionPredicateGroupMaps',
          e.parentRowLevelPermissionPredicateGroupUniversalIdentifier,
          createdByKey,
        );
        await qr.query(
          `INSERT INTO core."rowLevelPermissionPredicateGroup" (
            id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId",
            "parentRowLevelPermissionPredicateGroupId", "logicalOperator", "positionInRowLevelPermissionPredicateGroup"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            roleId,
            objId,
            parentId,
            e.logicalOperator ?? 'AND',
            e.positionInRowLevelPermissionPredicateGroup ?? null,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatRowLevelPermissionPredicateGroupMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        for (const [col, val] of Object.entries(action.update ?? {})) {
          await qr.query(
            `UPDATE core."rowLevelPermissionPredicateGroup" SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
            [val, id, wsId],
          );
        }
      } else {
        const id = resolveId(
          'flatRowLevelPermissionPredicateGroupMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."rowLevelPermissionPredicateGroup" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'rowLevelPermissionPredicate') {
      if (action.type === 'create') {
        const e = action.flatEntity!;
        const id = action.id!;
        const roleId = resolveId(
          'flatRoleMaps',
          e.roleUniversalIdentifier,
          createdByKey,
        )!;
        const objId = resolveId(
          'flatObjectMetadataMaps',
          e.objectMetadataUniversalIdentifier,
          createdByKey,
        )!;
        const fieldId = resolveId(
          'flatFieldMetadataMaps',
          e.fieldMetadataUniversalIdentifier,
          createdByKey,
        )!;
        const memberField = resolveId(
          'flatFieldMetadataMaps',
          e.workspaceMemberFieldMetadataUniversalIdentifier,
          createdByKey,
        );
        const groupId = resolveId(
          'flatRowLevelPermissionPredicateGroupMaps',
          e.rowLevelPermissionPredicateGroupUniversalIdentifier,
          createdByKey,
        );
        await qr.query(
          `INSERT INTO core."rowLevelPermissionPredicate" (
            id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
            operand, value, "subFieldName", "workspaceMemberFieldMetadataId", "workspaceMemberSubFieldName",
            "rowLevelPermissionPredicateGroupId", "positionInRowLevelPermissionPredicateGroup"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
          [
            id,
            wsId,
            flatApplication.id,
            e.universalIdentifier,
            roleId,
            objId,
            fieldId,
            e.operand ?? 'CONTAINS',
            e.value !== undefined && e.value !== null
              ? JSON.stringify(e.value)
              : null,
            e.subFieldName ?? null,
            memberField,
            e.workspaceMemberSubFieldName ?? null,
            groupId,
            e.positionInRowLevelPermissionPredicateGroup ?? null,
          ],
        );
      } else if (action.type === 'update') {
        const id = resolveId(
          'flatRowLevelPermissionPredicateMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        for (const [col, val] of Object.entries(action.update ?? {})) {
          if (col === 'value') {
            await qr.query(
              `UPDATE core."rowLevelPermissionPredicate" SET value=$1::jsonb, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
              [
                val !== null && val !== undefined ? JSON.stringify(val) : null,
                id,
                wsId,
              ],
            );
          } else {
            await qr.query(
              `UPDATE core."rowLevelPermissionPredicate" SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
              [val, id, wsId],
            );
          }
        }
      } else {
        const id = resolveId(
          'flatRowLevelPermissionPredicateMaps',
          action.universalIdentifier,
          createdByKey,
        )!;
        await qr.query(
          'DELETE FROM core."rowLevelPermissionPredicate" WHERE id=$1 AND "workspaceId"=$2',
          [id, wsId],
        );
      }
    } else if (m === 'fieldMetadata' && action.type === 'delete') {
      const id = resolveId(
        'flatFieldMetadataMaps',
        action.universalIdentifier,
        createdByKey,
      )!;
      await qr.query(
        'DELETE FROM core."fieldMetadata" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    }
  };

  const actionHandlerRegistry = {
    executeActionHandler: jest.fn(async ({ action, context }) => {
      await executeSqlAction(action, context);
      return {
        partialOptimisticCache: {},
        metadataEvents: [],
        deferredActions: [],
      };
    }),
    executeActionRollbackHandler: jest.fn(async () => {}),
  };

  const runnerService = new WorkspaceMigrationRunnerService(
    flatEntityMapsCacheService as never,
    runtime,
    actionHandlerRegistry as never,
    { incrementMetadataVersion: jest.fn(async () => {}) } as never,
    workspaceCacheService as never,
    { recordHistogram: jest.fn() } as never,
    {
      perfTime: jest.fn(),
      perfTimeEnd: jest.fn(),
      perf: jest.fn(),
      error: jest.fn(),
    } as never,
    { get: jest.fn(() => false) } as never,
    { getWorkspaceFeatureFlagsMap: jest.fn(async () => ({})) } as never,
    {
      persist: jest.fn(async () => {}),
      dispatchAfterCommit: jest.fn(async () => {}),
    } as never,
    {
      throwIfSchemaAffectingActionsAreInProgress: jest.fn(async () => {}),
    } as never,
  );

  const buildActionsFromRecord = (
    record: Record<
      string,
      | {
          flatEntityToCreate: Record<string, Record<string, unknown>>;
          flatEntityToUpdate: Record<string, Record<string, unknown>>;
          flatEntityToDelete: Record<string, Record<string, unknown>>;
        }
      | undefined
    >,
    currentMaps: Record<string, ReturnType<typeof emptyMap>>,
  ) => {
    const orderedMetadata = [
      'fieldMetadata',
      'objectMetadata',
      'role',
      'agent',
      'roleTarget',
      'objectPermission',
      'fieldPermission',
      'rolePermissionFlag',
      'permissionFlag',
      'rowLevelPermissionPredicateGroup',
      'rowLevelPermissionPredicate',
    ];
    const actions: Array<Record<string, unknown>> = [];
    if (record.roleTarget) {
      for (const entity of Object.values(
        record.roleTarget.flatEntityToDelete,
      )) {
        actions.push({
          type: 'delete',
          metadataName: 'roleTarget',
          universalIdentifier: entity.universalIdentifier,
        });
      }
    }
    for (const metadataName of orderedMetadata) {
      const bucket = record[metadataName];
      if (!bucket) continue;
      if (metadataName !== 'roleTarget') {
        for (const entity of Object.values(bucket.flatEntityToDelete)) {
          actions.push({
            type: 'delete',
            metadataName,
            universalIdentifier: entity.universalIdentifier,
          });
        }
      }
      for (const entity of Object.values(bucket.flatEntityToCreate)) {
        actions.push({
          type: 'create',
          metadataName,
          id:
            typeof entity.id === 'string' && entity.id.length > 0
              ? entity.id
              : randomUUID(),
          flatEntity: entity,
        });
      }
      for (const entity of Object.values(bucket.flatEntityToUpdate)) {
        const mapsKey = getMetadataFlatEntityMapsKey(metadataName as never);
        const beforeEntity =
          currentMaps[mapsKey]?.byUniversalIdentifier[
            String(entity.universalIdentifier)
          ] ?? {};
        const update: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(entity)) {
          if (
            [
              'id',
              'workspaceId',
              'applicationId',
              'applicationUniversalIdentifier',
              'universalIdentifier',
              'createdAt',
              'updatedAt',
              'roleUniversalIdentifier',
              'objectMetadataUniversalIdentifier',
              'fieldMetadataUniversalIdentifier',
              'permissionFlagUniversalIdentifier',
              'agentUniversalIdentifier',
              'parentRowLevelPermissionPredicateGroupUniversalIdentifier',
              'rowLevelPermissionPredicateGroupUniversalIdentifier',
              'workspaceMemberFieldMetadataUniversalIdentifier',
            ].includes(k) ||
            Array.isArray(v)
          ) {
            if (
              metadataName === 'roleTarget' &&
              k === 'roleUniversalIdentifier' &&
              beforeEntity[k] !== v
            ) {
              update.roleUniversalIdentifier = v;
            }
            continue;
          }
          if (JSON.stringify(beforeEntity[k]) !== JSON.stringify(v)) {
            update[k] = v;
          }
        }
        actions.push({
          type: 'update',
          metadataName,
          universalIdentifier: entity.universalIdentifier,
          update,
        });
      }
    }
    return actions;
  };

  const workspaceMigrationValidateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigrationFromRecord: jest.fn(
      async ({
        allFlatEntityOperationRecordByMetadataName,
        workspaceId: wsId,
        applicationUniversalIdentifier,
        dryRun,
      }: {
        allFlatEntityOperationRecordByMetadataName: Record<string, never>;
        workspaceId: string;
        applicationUniversalIdentifier: string;
        dryRun?: boolean;
      }) => {
        const currentMaps = (await loadAllMapsFromDb(wsId)) as Record<
          string,
          ReturnType<typeof emptyMap>
        >;
        const actions = buildActionsFromRecord(
          allFlatEntityOperationRecordByMetadataName,
          currentMaps,
        );
        const workspaceMigration = {
          actions,
          applicationUniversalIdentifier,
        };
        if (dryRun || actions.length === 0) {
          return {
            status: 'success',
            workspaceMigration,
            hasSchemaMetadataChanged: false,
          };
        }
        await runnerService.run({
          workspaceId: wsId,
          workspaceMigration: workspaceMigration as never,
        });
        return {
          status: 'success',
          workspaceMigration,
          hasSchemaMetadataChanged: false,
        };
      },
    ),
    validateBuildAndRunWorkspaceMigrationFromTo: jest.fn(
      async ({
        fromToAllFlatEntityMaps,
        workspaceId: wsId,
        buildOptions,
        idByUniversalIdentifierByMetadataName,
      }: {
        fromToAllFlatEntityMaps: Record<
          string,
          {
            from: ReturnType<typeof emptyMap>;
            to: ReturnType<typeof emptyMap>;
          }
        >;
        workspaceId: string;
        buildOptions: { applicationUniversalIdentifier: string };
        idByUniversalIdentifierByMetadataName?: Record<
          string,
          Record<string, string>
        >;
      }) => {
        const actions: Array<Record<string, unknown>> = [];
        const roleFromTo = fromToAllFlatEntityMaps.flatRoleMaps;
        if (roleFromTo) {
          for (const [uid, toRole] of Object.entries(
            roleFromTo.to.byUniversalIdentifier,
          )) {
            const fromRole = roleFromTo.from.byUniversalIdentifier[uid];
            if (!fromRole) {
              actions.push({
                type: 'create',
                metadataName: 'role',
                id:
                  idByUniversalIdentifierByMetadataName?.role?.[uid] ??
                  String(toRole.id ?? randomUUID()),
                flatEntity: {
                  ...toRole,
                  applicationUniversalIdentifier:
                    buildOptions.applicationUniversalIdentifier,
                },
              });
            } else if (fromRole.label !== toRole.label) {
              actions.push({
                type: 'update',
                metadataName: 'role',
                universalIdentifier: uid,
                update: { label: toRole.label },
              });
            }
          }
        }
        const workspaceMigration = {
          actions,
          applicationUniversalIdentifier:
            buildOptions.applicationUniversalIdentifier,
        };
        if (actions.length > 0) {
          await runnerService.run({
            workspaceId: wsId,
            workspaceMigration: workspaceMigration as never,
          });
        }
        return {
          status: 'success',
          workspaceMigration,
          hasSchemaMetadataChanged: false,
        };
      },
    ),
  };

  const applicationRepository = {
    update: jest.fn(
      async (
        wsId: string,
        criteria: { id: string },
        partial: Record<string, unknown>,
      ) => {
        for (const [col, val] of Object.entries(partial)) {
          if (col === 'workspaceId') continue;
          await runtime.query(
            `UPDATE core.application SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
            [val, criteria.id, wsId],
          );
        }
      },
    ),
    findOne: jest.fn(
      async (wsId: string, options: { where: { id: string } }) => {
        const [row] = await runtime.query(
          'SELECT * FROM core.application WHERE id=$1 AND "workspaceId"=$2',
          [options.where.id, wsId],
        );
        return row ?? null;
      },
    ),
  };

  const applicationLookupService = {
    findByUniversalIdentifier: jest.fn(
      async ({
        universalIdentifier,
        workspaceId: wsId,
      }: {
        universalIdentifier: string;
        workspaceId: string;
      }) => {
        const [row] = await owner.query(
          'SELECT * FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
          [universalIdentifier, wsId],
        );
        return row ? { ...row, canBeUninstalled: true } : null;
      },
    ),
  };

  const wrappedDataSource = {
    ...runtime,
    options: runtime.options,
    createQueryRunner: (mode?: 'master' | 'slave') => {
      const qr = runtime.createQueryRunner(mode);
      qr.manager.update = (async (
        _entity: unknown,
        criteria: { id: string; workspaceId?: string },
        partial: Record<string, unknown>,
      ) => {
        for (const [col, val] of Object.entries(partial)) {
          if (col === 'workspaceId') continue;
          if (criteria.workspaceId) {
            await qr.query(
              `UPDATE core.application SET "${col}"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3`,
              [val, criteria.id, criteria.workspaceId],
            );
          } else {
            await qr.query(
              `UPDATE core.application SET "${col}"=$1, "updatedAt"=now() WHERE id=$2`,
              [val, criteria.id],
            );
          }
        }
      }) as never;
      qr.manager.findOne = (async (
        _entity: unknown,
        opts: { where: { id: string; workspaceId: string } },
      ) => {
        const [row] = await qr.query(
          'SELECT * FROM core.application WHERE id=$1 AND "workspaceId"=$2',
          [opts.where.id, opts.where.workspaceId],
        );
        return row ?? null;
      }) as never;
      qr.manager.delete = (async (
        _entity: unknown,
        criteria: { universalIdentifier: string; workspaceId: string },
      ) => {
        await qr.query(
          'DELETE FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2',
          [criteria.universalIdentifier, criteria.workspaceId],
        );
      }) as never;
      return qr;
    },
  };

  const applicationService = Object.assign(
    Object.create(ApplicationService.prototype),
    {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      coreDataSource: wrappedDataSource,
      applicationRepository,
      applicationLookupService,
      workspaceCacheService,
      fileStorageService: {
        deleteApplicationFileRows: jest.fn(async () => {}),
        invalidateStorageStock: jest.fn(async () => {}),
        deleteApplicationFilesFromStorage: jest.fn(async () => {}),
      },
      workspaceEventBroadcaster: { broadcast: jest.fn(async () => {}) },
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
        async ({ workspaceId: wsId }: { workspaceId: string }) => {
          const maps = (await loadAllMapsFromDb(wsId)) as {
            flatApplicationMaps: ReturnType<typeof emptyMap>;
          };
          return {
            twentyStandardFlatApplication:
              maps.flatApplicationMaps.byId[standardAppId],
            workspaceCustomFlatApplication:
              maps.flatApplicationMaps.byId[customAppId],
          };
        },
      ),
      findOneApplicationWithRelationsOrThrow: jest.fn(
        async ({
          universalIdentifier,
          workspaceId: wsId,
        }: {
          universalIdentifier: string;
          workspaceId: string;
        }) => {
          const [row] = await owner.query(
            'SELECT * FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
            [universalIdentifier, wsId],
          );
          if (!row) throw new Error('Application not found');
          return { ...row, canBeUninstalled: true };
        },
      ),
    },
  ) as InstanceType<typeof ApplicationService>;

  const computeManifestService =
    new ComputeApplicationManifestAllUniversalFlatEntityMapsService();

  const applicationManifestMigrationService =
    new ApplicationManifestMigrationService(
      workspaceCacheService as never,
      workspaceMigrationValidateBuildAndRunService as never,
      applicationService,
      computeManifestService,
      { log: jest.fn(), perf: jest.fn() } as never,
      { publishCronTriggerCacheEntries: jest.fn(async () => {}) } as never,
      { deleteManyByConnectionProviderIds: jest.fn(async () => {}) } as never,
    );

  const applicationSyncService = new ApplicationSyncService(
    applicationService,
    applicationLookupService as never,
    applicationManifestMigrationService,
    workspaceMigrationValidateBuildAndRunService as never,
    workspaceCacheService as never,
    {} as never,
    { syncFromManifest: jest.fn(async () => {}) } as never,
    {
      getCurrentDriver: () => ({
        deleteApplicationResources: jest.fn(async () => {}),
      }),
    } as never,
    { runUninstallHookBestEffort: jest.fn(async () => {}) } as never,
    { find: jest.fn(async () => []) } as never,
    { broadcast: jest.fn(async () => {}) } as never,
  );

  const twentyStandardApplicationService = Object.assign(
    Object.create(TwentyStandardApplicationService.prototype),
    {
      applicationService,
      workspaceMigrationValidateBuildAndRunService,
      workspaceCacheService,
      workspaceOrmManager: {},
      seedStandardObjectInitialViewsOrThrow: jest.fn(async () => {}),
    },
  ) as InstanceType<typeof TwentyStandardApplicationService>;

  return {
    runnerService,
    actionHandlerRegistry,
    workspaceCacheService,
    applicationService,
    applicationManifestMigrationService,
    applicationSyncService,
    twentyStandardApplicationService,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.query(`
    CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "displayName" text NULL,
      subdomain text NULL,
      "databaseSchema" text NULL,
      "defaultRoleId" uuid NULL,
      "activationStatus" text NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.application (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL,
      description text NULL,
      version text NULL,
      "sourceType" text NOT NULL DEFAULT 'local',
      "sourcePath" text NOT NULL DEFAULT 'cli-sync',
      "defaultRoleId" uuid NULL,
      "settingsCustomTabFrontComponentId" uuid NULL,
      "healthCheckLogicFunctionId" uuid NULL,
      "uninstallLogicFunctionId" uuid NULL,
      "autoUpgrade" boolean NOT NULL DEFAULT false,
      "packageJsonFileId" uuid NULL,
      "yarnLockFileId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.role (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      label text NOT NULL,
      description text NULL,
      icon text NULL,
      "isEditable" boolean NOT NULL DEFAULT true,
      "canUpdateAllSettings" boolean NOT NULL DEFAULT false,
      "canAccessAllTools" boolean NOT NULL DEFAULT false,
      "canAccessAllAgentChatChannels" boolean NOT NULL DEFAULT false,
      "canReadAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canUpdateAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canSoftDeleteAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canDestroyAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canBeAssignedToUsers" boolean NOT NULL DEFAULT true,
      "canBeAssignedToAgents" boolean NOT NULL DEFAULT true,
      "canBeAssignedToApiKeys" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core.agent (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL,
      label text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."roleTarget" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "agentId" uuid NULL REFERENCES core.agent(id) ON DELETE CASCADE,
      "userWorkspaceId" uuid NULL,
      "apiKeyId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "IDX_ROLE_TARGET_UNIQUE_AGENT" UNIQUE ("workspaceId", "agentId")
    );
    CREATE TABLE core."permissionFlag" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      key text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."rolePermissionFlag" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "permissionFlagId" uuid NOT NULL REFERENCES core."permissionFlag"(id) ON DELETE CASCADE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."objectMetadata" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "nameSingular" text NOT NULL,
      "namePlural" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."fieldMetadata" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL DEFAULT 'TEXT',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."objectPermission" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "canReadObjectRecords" boolean NULL,
      "canUpdateObjectRecords" boolean NULL,
      "canSoftDeleteObjectRecords" boolean NULL,
      "canDestroyObjectRecords" boolean NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."fieldPermission" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
      "canReadFieldValue" boolean NULL,
      "canUpdateFieldValue" boolean NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."rowLevelPermissionPredicateGroup" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "parentRowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
      "logicalOperator" text NOT NULL DEFAULT 'AND',
      "positionInRowLevelPermissionPredicateGroup" double precision NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."rowLevelPermissionPredicate" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
      operand text NOT NULL DEFAULT 'CONTAINS',
      value jsonb NULL,
      "subFieldName" text NULL,
      "workspaceMemberFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE SET NULL,
      "workspaceMemberSubFieldName" text NULL,
      "rowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
      "positionInRowLevelPermissionPredicateGroup" double precision NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "deletedAt" timestamptz NULL
    );
  `);
  await owner.query(
    `INSERT INTO core.workspace (id, "displayName", subdomain, "databaseSchema", "activationStatus")
     VALUES ($1, 'Acme', 'acme', 'workspace_acme', $2)`,
    [workspaceId, WorkspaceActivationStatus.ACTIVE],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-app-meta-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}";
     GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    `TRUNCATE
      core."rowLevelPermissionPredicate",
      core."rowLevelPermissionPredicateGroup",
      core."fieldPermission",
      core."objectPermission",
      core."rolePermissionFlag",
      core."permissionFlag",
      core."roleTarget",
      core.agent,
      core.role,
      core."fieldMetadata",
      core."objectMetadata",
      core.application,
      core."userWorkspace",
      crm_audit."crmAuditEntry"`,
  );
  await owner.query(
    'UPDATE core.workspace SET "defaultRoleId"=NULL, "deletedAt"=NULL WHERE id=$1',
    [workspaceId],
  );
  await owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name, "defaultRoleId") VALUES
      ($1, $2, $3, 'Twenty Standard', NULL),
      ($4, $2, $5, 'Workspace Custom', NULL),
      ($6, $2, $7, 'Manifest App', NULL)`,
    [
      standardAppId,
      workspaceId,
      TWENTY_STANDARD_APPLICATION.universalIdentifier,
      customAppId,
      customAppUniversalId,
      manifestAppId,
      manifestAppUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural")
     VALUES ($1, $2, $3, $4, 'company', 'companies')`,
    [companyObjectId, workspaceId, standardAppId, companyObjectUniversalId],
  );
  await owner.query(
    `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type) VALUES
      ($1, $2, $3, $4, $5, 'name', $6),
      ($7, $2, $8, $9, $5, 'memberCode', $6)`,
    [
      companyNameFieldId,
      workspaceId,
      standardAppId,
      companyNameFieldUniversalId,
      companyObjectId,
      FieldMetadataType.TEXT,
      memberFieldId,
      manifestAppId,
      memberFieldUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."permissionFlag" (id, "workspaceId", "applicationId", "universalIdentifier", key)
     VALUES ($1, $2, $3, $4, 'APP_SETTINGS')`,
    [
      appPermissionFlagId,
      workspaceId,
      manifestAppId,
      appPermissionFlagUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt")
     VALUES ($1, $2, $3, NULL)`,
    [impersonatorUserWorkspaceId, workspaceId, impersonatorUserId],
  );
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

describe('Application metadata CRM audit (LOG165)', () => {
  it('audits standard Admin role creation and update in TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow', async () => {
    const { twentyStandardApplicationService } = buildHarness();

    const makeStandardMaps = (adminLabel: string) => {
      const flatRoleMaps = emptyMap();
      addEntityToMap(flatRoleMaps, {
        id: adminRoleId,
        workspaceId,
        applicationId: standardAppId,
        applicationUniversalIdentifier:
          TWENTY_STANDARD_APPLICATION.universalIdentifier,
        universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
        label: adminLabel,
        description: 'Admin role',
        icon: 'IconUserCog',
        isEditable: false,
        canUpdateAllSettings: true,
        canAccessAllTools: true,
        canAccessAllAgentChatChannels: true,
        canReadAllObjectRecords: true,
        canUpdateAllObjectRecords: true,
        canSoftDeleteAllObjectRecords: true,
        canDestroyAllObjectRecords: true,
        canBeAssignedToUsers: true,
        canBeAssignedToAgents: false,
        canBeAssignedToApiKeys: true,
      });
      return {
        allFlatEntityMaps: new Proxy(
          { flatRoleMaps, flatObjectMetadataMaps: emptyMap() },
          {
            get: (target, prop: string) =>
              prop in target ? target[prop as keyof typeof target] : emptyMap(),
          },
        ),
        idByUniversalIdentifierByMetadataName: {
          role: {
            [STANDARD_ROLE.admin.universalIdentifier]: adminRoleId,
          },
        },
      };
    };

    computeTwentyStandardApplicationAllFlatEntityMaps.mockImplementationOnce(
      () => makeStandardMaps('Admin'),
    );

    await twentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow(
      {
        workspaceId,
        auditIdentity: systemIdentity('workspace-manager:init'),
      },
    );

    computeTwentyStandardApplicationAllFlatEntityMaps.mockImplementationOnce(
      () => makeStandardMaps('Workspace Admin'),
    );

    await twentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow(
      {
        workspaceId,
      },
    );

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(
      entries.find((e) => e.resourceKind === 'role' && e.action === 'create'),
    ).toMatchObject({
      workspaceId,
      action: 'create',
      resourceKind: 'role',
      resourceId: adminRoleId,
      actor: { kind: 'system', id: 'workspace-manager:init' },
      redactedDiff: {
        values: {
          canUpdateAllSettings: { before: null, after: true },
          canBeAssignedToUsers: { before: null, after: true },
        },
      },
    });
    expect(
      entries.find(
        (e) => e.resourceKind === 'application' && e.action === 'update',
      ),
    ).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: standardAppId,
      actor: { kind: 'system', id: 'workspace-manager:init' },
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: adminRoleId },
        },
      },
    });
    expect(
      entries.find((e) => e.resourceKind === 'role' && e.action === 'update'),
    ).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'role',
      resourceId: adminRoleId,
      actor: { kind: 'system', id: 'twenty-standard-application:sync' },
      redactedDiff: {
        changedFields: ['label'],
      },
    });
  });

  it('audits manifest install and upgrade across roles, permissions, row-level predicates, and agent roleTarget in ApplicationManifestMigrationService', async () => {
    const { applicationManifestMigrationService, runnerService } =
      buildHarness();

    const objPermUniversalId = randomUUID();
    const fieldPermUniversalId = randomUUID();
    const predGroupUniversalId = randomUUID();
    const predUniversalId = randomUUID();

    const buildManifest = (options: {
      canUpdateObject: boolean;
      canReadField: boolean;
      predicateValue: string;
      agentRoleUniversalId: string;
    }): Manifest =>
      ({
        application: {
          universalIdentifier: manifestAppUniversalId,
          displayName: 'Manifest App',
          defaultRoleUniversalIdentifier: manifestRoleOneUniversalId,
        },
        objects: [],
        fields: [],
        logicFunctions: [],
        frontComponents: [],
        permissionFlags: [],
        roles: [
          {
            universalIdentifier: manifestRoleOneUniversalId,
            label: 'Manifest Role One',
            canUpdateAllSettings: false,
            canBeAssignedToUsers: true,
            canBeAssignedToAgents: true,
            canBeAssignedToApiKeys: true,
            permissionFlagUniversalIdentifiers: [appPermissionFlagUniversalId],
            objectPermissions: [
              {
                universalIdentifier: objPermUniversalId,
                objectUniversalIdentifier: companyObjectUniversalId,
                canReadObjectRecords: true,
                canUpdateObjectRecords: options.canUpdateObject,
                canSoftDeleteObjectRecords: false,
                canDestroyObjectRecords: false,
              },
            ],
            fieldPermissions: [
              {
                universalIdentifier: fieldPermUniversalId,
                objectUniversalIdentifier: companyObjectUniversalId,
                fieldUniversalIdentifier: companyNameFieldUniversalId,
                canReadFieldValue: options.canReadField,
                canUpdateFieldValue: false,
              },
            ],
            rowLevelPermissionPredicateGroups: [
              {
                universalIdentifier: predGroupUniversalId,
                objectUniversalIdentifier: companyObjectUniversalId,
                logicalOperator:
                  RowLevelPermissionPredicateGroupLogicalOperator.AND,
                positionInRowLevelPermissionPredicateGroup: 1,
              },
            ],
            rowLevelPermissionPredicates: [
              {
                universalIdentifier: predUniversalId,
                objectUniversalIdentifier: companyObjectUniversalId,
                fieldUniversalIdentifier: companyNameFieldUniversalId,
                operand: RowLevelPermissionPredicateOperand.CONTAINS,
                value: options.predicateValue,
                workspaceMemberFieldUniversalIdentifier: memberFieldUniversalId,
                rowLevelPermissionPredicateGroupUniversalIdentifier:
                  predGroupUniversalId,
                positionInRowLevelPermissionPredicateGroup: 1,
              },
            ],
          },
          {
            universalIdentifier: manifestRoleTwoUniversalId,
            label: 'Manifest Role Two',
            canBeAssignedToAgents: true,
          },
        ],
        skills: [],
        agents: [
          {
            universalIdentifier: manifestAgentUniversalId,
            name: 'manifest-agent',
            label: 'Manifest Agent',
            prompt: 'Help the user',
            roleUniversalIdentifier: options.agentRoleUniversalId,
          },
        ],
        publicAssets: [],
        views: [],
        viewFields: [],
        navigationMenuItems: [],
        pageLayouts: [],
        pageLayoutTabs: [],
        pageLayoutWidgets: [],
        commandMenuItems: [],
        timelineActivityTypes: [],
        settingsMenuItems: [],
        workflows: [],
      }) as unknown as Manifest;

    const ownerFlatApplication = {
      id: manifestAppId,
      workspaceId,
      universalIdentifier: manifestAppUniversalId,
      sourceType: 'local',
      defaultRoleId: null,
    };

    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        impersonationContext: { impersonatorUserWorkspaceId },
      }),
      () =>
        applicationManifestMigrationService.syncMetadataFromManifest({
          manifest: buildManifest({
            canUpdateObject: false,
            canReadField: false,
            predicateValue: 'secret-filter-v1',
            agentRoleUniversalId: manifestRoleOneUniversalId,
          }),
          workspaceId,
          ownerFlatApplication: ownerFlatApplication as never,
          inferDeletionFromMissingEntities: false,
        }),
    );

    const installEntries = await audits();
    const migrationOperationIds = new Set(
      installEntries
        .filter((e) => e.resourceKind !== 'application')
        .map((e) => e.operationId),
    );
    expect(migrationOperationIds.size).toBe(1);
    expect(
      installEntries.map((e) => `${e.resourceKind}:${e.action}`).sort(),
    ).toEqual(
      [
        'role:create',
        'role:create',
        'roleTarget:create',
        'objectPermission:create',
        'fieldPermission:create',
        'rolePermissionFlag:create',
        'rowLevelPermissionPredicateGroup:create',
        'rowLevelPermissionPredicate:create',
        'application:update',
      ].sort(),
    );
    for (const entry of installEntries) {
      expect(entry.actor).toEqual({ kind: 'coreUser', id: actorUserId });
      expect(entry.initiator).toEqual({
        kind: 'coreUser',
        id: impersonatorUserId,
      });
      expect(JSON.stringify(entry.redactedDiff)).not.toContain(
        'secret-filter-v1',
      );
    }

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    await withCrmAuditIdentity(
      workspaceId,
      systemMembershipCleanupIdentity(
        workspaceId,
        'UpgradeWorkspaceApplicationJob',
      ),
      () =>
        applicationManifestMigrationService.syncMetadataFromManifest({
          manifest: buildManifest({
            canUpdateObject: true,
            canReadField: null as unknown as boolean,
            predicateValue: 'secret-filter-v2',
            agentRoleUniversalId: manifestRoleTwoUniversalId,
          }),
          workspaceId,
          ownerFlatApplication: ownerFlatApplication as never,
          inferDeletionFromMissingEntities: false,
        }),
    );

    const upgradeEntries = await audits();
    expect(
      upgradeEntries.map((e) => `${e.resourceKind}:${e.action}`).sort(),
    ).toEqual(
      [
        'roleTarget:delete',
        'roleTarget:create',
        'objectPermission:update',
        'fieldPermission:update',
        'rowLevelPermissionPredicate:update',
      ].sort(),
    );
    for (const entry of upgradeEntries) {
      expect(entry.actor).toEqual({
        kind: 'system',
        id: 'UpgradeWorkspaceApplicationJob',
      });
      expect(JSON.stringify(entry.redactedDiff)).not.toContain(
        'secret-filter-v2',
      );
    }

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await withApplicationMetadataAudit(
      captureApplicationMetadataAudit({
        workspaceId,
        applicationId: manifestAppId,
        applicationUniversalIdentifier: manifestAppUniversalId,
        auditIdentity: userIdentity(),
      })(),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: manifestAppUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName: 'fieldMetadata',
                universalIdentifier: memberFieldUniversalId,
              },
            ],
          } as never,
        }),
    );

    const setNullEntries = await audits();
    expect(setNullEntries).toHaveLength(1);
    expect(setNullEntries[0]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'rowLevelPermissionPredicate',
      redactedDiff: {
        changedFields: ['workspaceMemberFieldMetadataId'],
        values: {
          workspaceMemberFieldMetadataId: {
            before: memberFieldId,
            after: null,
          },
        },
      },
    });
  });

  it('reconciles a custom-application roleTarget on an application agent during manifest sync without hitting IDX_ROLE_TARGET_UNIQUE_AGENT', async () => {
    const { applicationManifestMigrationService } = buildHarness();

    await owner.query(
      `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label, "canBeAssignedToAgents") VALUES
        ($1, $2, $3, $4, 'App Role 1', true),
        ($5, $2, $6, $7, 'Workspace Custom Role', true)`,
      [
        manifestRoleOneId,
        workspaceId,
        manifestAppId,
        manifestRoleOneUniversalId,
        manifestRoleTwoId,
        customAppId,
        manifestRoleTwoUniversalId,
      ],
    );
    await owner.query(
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier", name, label)
       VALUES ($1, $2, $3, $4, 'app-agent', 'App Agent')`,
      [manifestAgentId, workspaceId, manifestAppId, manifestAgentUniversalId],
    );

    const customRoleTargetId = randomUUID();
    const customRoleTargetUniversalId = randomUUID();
    await owner.query(
      `INSERT INTO core."roleTarget" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "agentId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        customRoleTargetId,
        workspaceId,
        customAppId,
        customRoleTargetUniversalId,
        manifestRoleTwoId,
        manifestAgentId,
      ],
    );

    const manifest: Manifest = {
      application: {
        universalIdentifier: manifestAppUniversalId,
        displayName: 'Manifest App',
      },
      objects: [],
      fields: [],
      logicFunctions: [],
      frontComponents: [],
      permissionFlags: [],
      roles: [
        {
          universalIdentifier: manifestRoleOneUniversalId,
          label: 'App Role 1',
          canBeAssignedToAgents: true,
        },
      ],
      skills: [],
      agents: [
        {
          universalIdentifier: manifestAgentUniversalId,
          name: 'app-agent',
          label: 'App Agent',
          prompt: 'Prompt',
          roleUniversalIdentifier: manifestRoleOneUniversalId,
        },
      ],
      publicAssets: [],
      views: [],
      viewFields: [],
      navigationMenuItems: [],
      pageLayouts: [],
      pageLayoutTabs: [],
      pageLayoutWidgets: [],
      commandMenuItems: [],
      timelineActivityTypes: [],
      settingsMenuItems: [],
      workflows: [],
    } as unknown as Manifest;

    await applicationManifestMigrationService.syncMetadataFromManifest({
      manifest,
      workspaceId,
      ownerFlatApplication: {
        id: manifestAppId,
        workspaceId,
        universalIdentifier: manifestAppUniversalId,
        sourceType: 'local',
        defaultRoleId: null,
      } as never,
      auditIdentity: userIdentity(),
    });

    const targetRows: Row[] = await owner.query(
      'SELECT * FROM core."roleTarget" WHERE "workspaceId"=$1',
      [workspaceId],
    );
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0].id).not.toBe(customRoleTargetId);
    expect(targetRows[0].applicationId).toBe(manifestAppId);
    expect(targetRows[0].roleId).toBe(manifestRoleOneId);

    const entries = await audits();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.action === 'delete')).toMatchObject({
      action: 'delete',
      resourceKind: 'roleTarget',
      resourceId: customRoleTargetId,
      redactedDiff: {
        values: {
          roleId: { before: manifestRoleTwoId, after: null },
          agentId: { before: manifestAgentId, after: null },
        },
      },
    });
    expect(entries.find((e) => e.action === 'create')).toMatchObject({
      action: 'create',
      resourceKind: 'roleTarget',
      resourceId: targetRows[0].id,
      redactedDiff: {
        values: {
          roleId: { before: null, after: manifestRoleOneId },
          agentId: { before: null, after: manifestAgentId },
        },
      },
    });

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    const manifestRoleThreeUniversalId = randomUUID();
    const manifestReplacingRoleOne: Manifest = {
      ...manifest,
      roles: [
        {
          universalIdentifier: manifestRoleThreeUniversalId,
          label: 'App Role 3',
          canBeAssignedToAgents: true,
        },
      ],
      agents: [
        {
          universalIdentifier: manifestAgentUniversalId,
          name: 'app-agent',
          label: 'App Agent',
          prompt: 'Prompt',
          roleUniversalIdentifier: manifestRoleThreeUniversalId,
        },
      ],
    } as unknown as Manifest;

    await applicationManifestMigrationService.syncMetadataFromManifest({
      manifest: manifestReplacingRoleOne,
      workspaceId,
      ownerFlatApplication: {
        id: manifestAppId,
        workspaceId,
        universalIdentifier: manifestAppUniversalId,
        sourceType: 'local',
        defaultRoleId: null,
      } as never,
      inferDeletionFromMissingEntities: true,
      auditIdentity: userIdentity(),
    });

    const targetRowsAfterRoleSwap: Row[] = await owner.query(
      'SELECT * FROM core."roleTarget" WHERE "workspaceId"=$1',
      [workspaceId],
    );
    expect(targetRowsAfterRoleSwap).toHaveLength(1);
    expect(targetRowsAfterRoleSwap[0].id).toBe(targetRows[0].id);

    const swapEntries = await audits();
    expect(
      swapEntries.map((e) => `${e.resourceKind}:${e.action}`).sort(),
    ).toEqual(
      [
        'role:delete',
        'role:create',
        'roleTarget:delete',
        'roleTarget:create',
      ].sort(),
    );
  });

  it('audits cross-application dependent deletions in ApplicationSyncService.uninstallApplication and blocks direct ApplicationService.delete while role/permission rows remain', async () => {
    const { applicationSyncService, applicationService } = buildHarness();

    await owner.query(
      `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label, "canBeAssignedToAgents")
       VALUES ($1, $2, $3, $4, 'App Role', true)`,
      [
        manifestRoleOneId,
        workspaceId,
        manifestAppId,
        manifestRoleOneUniversalId,
      ],
    );
    await owner.query(
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier", name, label)
       VALUES ($1, $2, $3, $4, 'app-agent', 'App Agent')`,
      [manifestAgentId, workspaceId, manifestAppId, manifestAgentUniversalId],
    );

    const customAgentTargetId = randomUUID();
    const customObjPermId = randomUUID();
    const customFieldPermId = randomUUID();
    const customFlagPermId = randomUUID();
    const customGroupId = randomUUID();
    const customPredId = randomUUID();

    await owner.query(
      `INSERT INTO core."roleTarget" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "agentId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        customAgentTargetId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        manifestAgentId,
      ],
    );
    await owner.query(
      `INSERT INTO core."objectPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "canReadObjectRecords")
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        customObjPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        companyObjectId,
      ],
    );
    await owner.query(
      `INSERT INTO core."fieldPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId", "canReadFieldValue")
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
      [
        customFieldPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        companyObjectId,
        companyNameFieldId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rolePermissionFlag" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "permissionFlagId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        customFlagPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        appPermissionFlagId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "logicalOperator")
       VALUES ($1, $2, $3, $4, $5, $6, 'AND')`,
      [
        customGroupId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        companyObjectId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId", operand, value, "rowLevelPermissionPredicateGroupId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONTAINS', '"confidential"'::jsonb, $8)`,
      [
        customPredId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        companyObjectId,
        companyNameFieldId,
        customGroupId,
      ],
    );

    await expect(
      applicationService.delete(manifestAppUniversalId, workspaceId),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    await applicationSyncService.uninstallApplication({
      workspaceId,
      applicationUniversalIdentifier: manifestAppUniversalId,
      auditIdentity: userIdentity(),
    });

    const remainingApps = await owner.query(
      'SELECT id FROM core.application WHERE id=$1',
      [manifestAppId],
    );
    expect(remainingApps).toHaveLength(0);

    const entries = await audits();
    expect(entries.map((e) => `${e.resourceKind}:${e.action}`).sort()).toEqual(
      [
        'role:delete',
        'roleTarget:delete',
        'objectPermission:delete',
        'fieldPermission:delete',
        'rolePermissionFlag:delete',
        'rowLevelPermissionPredicateGroup:delete',
        'rowLevelPermissionPredicate:delete',
      ].sort(),
    );
  });

  it('rejects unaudited role/permission migrations and rolls back on defaultRoleId deletion, member/apiKey role deletion, unplanned roleTarget cascade, or soft-deleted predicate cascade', async () => {
    const { runnerService } = buildHarness();

    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: manifestAppUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'role',
              id: randomUUID(),
              flatEntity: {
                universalIdentifier: randomUUID(),
                applicationUniversalIdentifier: manifestAppUniversalId,
                label: 'Unaudited Role',
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    await owner.query(
      `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label, "isEditable", "canBeAssignedToUsers", "canBeAssignedToAgents")
       VALUES ($1, $2, $3, $4, 'Protected Role', true, true, true)`,
      [
        manifestRoleOneId,
        workspaceId,
        manifestAppId,
        manifestRoleOneUniversalId,
      ],
    );
    await owner.query(
      'UPDATE core.workspace SET "defaultRoleId"=$1 WHERE id=$2',
      [manifestRoleOneId, workspaceId],
    );

    const runDeleteRole = () =>
      withApplicationMetadataAudit(
        captureApplicationMetadataAudit({
          workspaceId,
          applicationId: manifestAppId,
          applicationUniversalIdentifier: manifestAppUniversalId,
          auditIdentity: userIdentity(),
        })(),
        () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: manifestAppUniversalId,
              actions: [
                {
                  type: 'delete',
                  metadataName: 'role',
                  universalIdentifier: manifestRoleOneUniversalId,
                },
              ],
            } as never,
          }),
      );

    await expect(runDeleteRole()).rejects.toThrow(
      'Application metadata audit cannot delete an active default role',
    );

    await owner.query(
      'UPDATE core.workspace SET "defaultRoleId"=NULL WHERE id=$1',
      [workspaceId],
    );
    const memberTargetId = randomUUID();
    await owner.query(
      `INSERT INTO core."roleTarget" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "userWorkspaceId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        memberTargetId,
        workspaceId,
        customAppId,
        randomUUID(),
        manifestRoleOneId,
        impersonatorUserWorkspaceId,
      ],
    );
    await expect(runDeleteRole()).rejects.toThrow(
      'Application metadata audit cannot delete role assigned to workspace member or API key',
    );
    await owner.query('DELETE FROM core."roleTarget" WHERE id=$1', [
      memberTargetId,
    ]);

    await owner.query(
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier", name, label)
       VALUES ($1, $2, $3, $4, 'agent', 'Agent')`,
      [manifestAgentId, workspaceId, manifestAppId, manifestAgentUniversalId],
    );
    const unplannedAgentTargetId = randomUUID();
    await owner.query(
      `INSERT INTO core."roleTarget" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "agentId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        unplannedAgentTargetId,
        workspaceId,
        manifestAppId,
        randomUUID(),
        manifestRoleOneId,
        manifestAgentId,
      ],
    );
    await expect(runDeleteRole()).rejects.toThrow(
      'Application metadata audit detected unplanned roleTarget cascade',
    );
    await owner.query('DELETE FROM core."roleTarget" WHERE id=$1', [
      unplannedAgentTargetId,
    ]);

    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "logicalOperator", "deletedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'AND', now())`,
      [
        randomUUID(),
        workspaceId,
        manifestAppId,
        randomUUID(),
        manifestRoleOneId,
        companyObjectId,
      ],
    );
    await expect(runDeleteRole()).rejects.toThrow(
      'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
    );
    expect(await audits()).toHaveLength(0);
  });

  it('skips rollback handlers and invalidates cache on NativeTransactionOutcomeUnknownError and CoreAuditPostCommitError in WorkspaceMigrationRunnerService', async () => {
    const { runnerService, actionHandlerRegistry, workspaceCacheService } =
      buildHarness();

    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const statements: string[] = [];
    const clients = new WeakSet<object>();
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const connect = runner.connect.bind(runner);
      jest.spyOn(runner, 'connect').mockImplementationOnce(async () => {
        const client = await connect();
        if (!clients.has(client)) {
          clients.add(client);
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            statements.push(sql);
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('simulated commit ACK loss');
            return result;
          };
        }
        return client;
      });
      return runner;
    });

    await expect(
      withApplicationMetadataAudit(
        captureApplicationMetadataAudit({
          workspaceId,
          applicationId: manifestAppId,
          applicationUniversalIdentifier: manifestAppUniversalId,
          auditIdentity: userIdentity(),
        })(),
        () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: manifestAppUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'role',
                  id: manifestRoleOneId,
                  flatEntity: {
                    universalIdentifier: manifestRoleOneUniversalId,
                    applicationUniversalIdentifier: manifestAppUniversalId,
                    label: 'Ack Loss Role',
                    isEditable: true,
                  },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(
      actionHandlerRegistry.executeActionRollbackHandler,
    ).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalled();
    expect(await audits()).toHaveLength(1);

    workspaceCacheService.invalidateAndRecompute.mockClear();
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const realCommit = runner.commitTransaction.bind(runner);
      jest
        .spyOn(runner, 'commitTransaction')
        .mockImplementationOnce(async () => {
          await realCommit();
          throw new Error('simulated post-commit failure');
        });
      return runner;
    });

    await expect(
      withApplicationMetadataAudit(
        captureApplicationMetadataAudit({
          workspaceId,
          applicationId: manifestAppId,
          applicationUniversalIdentifier: manifestAppUniversalId,
          auditIdentity: userIdentity(),
        })(),
        () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: manifestAppUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'role',
                  id: manifestRoleTwoId,
                  flatEntity: {
                    universalIdentifier: manifestRoleTwoUniversalId,
                    applicationUniversalIdentifier: manifestAppUniversalId,
                    label: 'Post Commit Role',
                    isEditable: true,
                  },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(
      actionHandlerRegistry.executeActionRollbackHandler,
    ).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalled();
    expect(await audits()).toHaveLength(2);
  });
});
