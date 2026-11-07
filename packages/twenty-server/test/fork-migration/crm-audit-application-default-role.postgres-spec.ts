import { randomUUID } from 'node:crypto';
import { type Manifest } from 'twenty-shared/application';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureApplicationDefaultRoleAudit,
  runAuditedApplicationDefaultRoleUpdate,
} from 'src/engine/core-modules/crm-audit/application-default-role-audit';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { systemMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER } from 'src/engine/core-modules/application/constants/workspace-custom-application-role.constant';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';

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
jest.mock('src/engine/core-modules/logger/logger.service', () => ({
  LoggerService: class {},
}));
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
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
  'src/engine/metadata-modules/object-permission/field-permission/field-permission.service',
  () => ({ FieldPermissionService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-permission/object-permission.service',
  () => ({ ObjectPermissionService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/permissions/permissions.service',
  () => ({ PermissionsService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-permission-flag/role-permission-flag.service',
  () => ({ RolePermissionFlagService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-target/services/role-target.service',
  () => ({ RoleTargetService: class {} }),
);
jest.mock('src/engine/metadata-modules/role/role.entity', () => ({
  RoleEntity: class {},
}));
jest.mock(
  'src/engine/metadata-modules/settings-menu-item/entities/settings-menu-item.entity',
  () => ({ SettingsMenuItemEntity: class {} }),
);
jest.mock('src/engine/metadata-modules/user-role/user-role.service', () => ({
  UserRoleService: class {},
}));
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
    computeTwentyStandardApplicationAllFlatEntityMaps: jest.fn(() => ({
      allFlatEntityMaps: new Proxy(
        {
          flatObjectMetadataMaps: {
            byId: {},
            idByUniversalIdentifier: {},
            universalIdentifierById: {},
            universalIdentifiersByApplicationId: {},
            byUniversalIdentifier: {},
          },
        },
        {
          get: (target, prop: string) =>
            prop in target
              ? target[prop as keyof typeof target]
              : {
                  byId: {},
                  idByUniversalIdentifier: {},
                  universalIdentifierById: {},
                  universalIdentifiersByApplicationId: {},
                  byUniversalIdentifier: {},
                },
        },
      ),
      idByUniversalIdentifierByMetadataName: {},
    })),
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/services/compute-application-manifest-all-universal-flat-entity-maps.service',
  () => ({
    ComputeApplicationManifestAllUniversalFlatEntityMapsService: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/utils/get-application-sub-all-flat-entity-maps.util',
  () => ({
    getApplicationSubAllFlatEntityMaps: jest.fn(() => ({
      flatConnectionProviderMaps: { byUniversalIdentifier: {} },
      flatLogicFunctionMaps: { byUniversalIdentifier: {} },
    })),
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/utils/assert-connection-provider-logic-functions-are-own.util',
  () => ({
    assertConnectionProviderLogicFunctionsAreOwn: jest.fn(),
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/utils/add-workflow-manifests-to-flat-entity-maps-or-throw.util',
  () => ({
    addWorkflowManifestsToFlatEntityMapsOrThrow: jest.fn(() => []),
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-manifest/utils/build-all-flat-entity-operation-record-by-metadata-name-from-from-to.util',
  () => ({
    buildAllFlatEntityOperationRecordByMetadataNameFromFromTo: jest.fn(
      () => ({}),
    ),
  }),
);

const {
  WorkspaceEntity,
} = require('src/engine/core-modules/workspace/workspace.entity');
const {
  ApplicationEntity,
} = require('src/engine/core-modules/application/application.entity');
const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { ApplicationService } =
  require('src/engine/core-modules/application/application.service') as typeof import('src/engine/core-modules/application/application.service');
const { ApplicationManifestMigrationService } =
  require('src/engine/core-modules/application/application-manifest/application-manifest-migration.service') as typeof import('src/engine/core-modules/application/application-manifest/application-manifest-migration.service');
const { RoleService } =
  require('src/engine/metadata-modules/role/role.service') as typeof import('src/engine/metadata-modules/role/role.service');
const { TwentyStandardApplicationService } =
  require('src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service') as typeof import('src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `app_default_role_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
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
const customAppRoleId = randomUUID();
const manifestRoleOneId = randomUUID();
const manifestRoleOneUniversalId = randomUUID();
const manifestRoleTwoId = randomUUID();
const manifestRoleTwoUniversalId = randomUUID();

const workspaceSchema = new EntitySchema({
  name: 'WorkspaceEntity',
  target: WorkspaceEntity,
  tableName: 'workspace',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    displayName: { type: 'text', nullable: true },
    subdomain: { type: 'text', nullable: true },
    databaseSchema: { type: 'text', nullable: true },
    defaultRoleId: { type: 'uuid', nullable: true },
    activationStatus: { type: 'text', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});

const applicationSchema = new EntitySchema({
  name: 'ApplicationEntity',
  target: ApplicationEntity,
  tableName: 'application',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    name: { type: 'text' },
    description: { type: 'text', nullable: true },
    version: { type: 'text', nullable: true },
    sourceType: { type: 'text', default: 'local' },
    sourcePath: { type: 'text', default: 'cli-sync' },
    defaultRoleId: { type: 'uuid', nullable: true },
    settingsCustomTabFrontComponentId: { type: 'uuid', nullable: true },
    healthCheckLogicFunctionId: { type: 'uuid', nullable: true },
    uninstallLogicFunctionId: { type: 'uuid', nullable: true },
    autoUpgrade: { type: Boolean, default: false },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});

const roleSchema = new EntitySchema({
  name: 'RoleEntity',
  target: RoleEntity,
  tableName: 'role',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    applicationId: { type: 'uuid', nullable: true },
    universalIdentifier: { type: 'uuid' },
    label: { type: 'text' },
    isEditable: { type: Boolean, default: true },
    canUpdateAllSettings: { type: Boolean, default: false },
    canAccessAllTools: { type: Boolean, default: false },
    canReadAllObjectRecords: { type: Boolean, default: false },
    canUpdateAllObjectRecords: { type: Boolean, default: false },
    canSoftDeleteAllObjectRecords: { type: Boolean, default: false },
    canDestroyAllObjectRecords: { type: Boolean, default: false },
    canBeAssignedToUsers: { type: Boolean, default: true },
    canBeAssignedToAgents: { type: Boolean, default: false },
    canBeAssignedToApiKeys: { type: Boolean, default: false },
  },
});

const membershipSchema = new EntitySchema({
  name: 'UserWorkspaceEntity',
  target: UserWorkspaceEntity,
  tableName: 'userWorkspace',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [workspaceSchema, applicationSchema, roleSchema, membershipSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-app-default-role-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [workspaceSchema, applicationSchema, roleSchema, membershipSchema],
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const readApplication = async (id: string): Promise<Row> => {
  const [row] = await owner.query(
    'SELECT * FROM core.application WHERE id=$1',
    [id],
  );
  return row;
};
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

const buildHarness = () => {
  const appRepo = runtime.getRepository(ApplicationEntity);
  const applicationRepository = {
    update: jest.fn(
      async (
        wsId: string,
        criteria: { id: string },
        partial: Record<string, unknown>,
      ) => {
        await appRepo.update({ id: criteria.id, workspaceId: wsId }, partial);
      },
    ),
    findOne: jest.fn(async (wsId: string, options: { where: { id: string } }) =>
      appRepo.findOne({
        where: { id: options.where.id, workspaceId: wsId },
      }),
    ),
  };

  const buildFlatRoleMaps = async (wsId: string) => {
    const roleRows: Row[] = await owner.query(
      'SELECT * FROM core.role WHERE "workspaceId"=$1',
      [wsId],
    );
    const byId: Record<string, Row> = {};
    const idByUniversalIdentifier: Record<string, string> = {};
    const universalIdentifierById: Record<string, string> = {};
    const byUniversalIdentifier: Record<string, Row> = {};
    for (const row of roleRows) {
      byId[row.id] = row;
      idByUniversalIdentifier[row.universalIdentifier as string] = row.id;
      universalIdentifierById[row.id] = row.universalIdentifier as string;
      byUniversalIdentifier[row.universalIdentifier as string] = row;
    }
    return {
      byId,
      idByUniversalIdentifier,
      universalIdentifierById,
      universalIdentifiersByApplicationId: {},
      byUniversalIdentifier,
    };
  };

  const buildFlatApplicationMaps = async (wsId: string) => {
    const appRows: Row[] = await owner.query(
      'SELECT * FROM core.application WHERE "workspaceId"=$1',
      [wsId],
    );
    const byId: Record<string, Row> = {};
    const idByUniversalIdentifier: Record<string, string> = {};
    const universalIdentifierById: Record<string, string> = {};
    const byUniversalIdentifier: Record<string, Row> = {};
    for (const row of appRows) {
      byId[row.id] = row;
      idByUniversalIdentifier[row.universalIdentifier as string] = row.id;
      universalIdentifierById[row.id] = row.universalIdentifier as string;
      byUniversalIdentifier[row.universalIdentifier as string] = row;
    }
    return {
      byId,
      idByUniversalIdentifier,
      universalIdentifierById,
      universalIdentifiersByApplicationId: {},
      byUniversalIdentifier,
    };
  };

  const emptyFlatMaps = () => ({
    byId: {},
    idByUniversalIdentifier: {},
    universalIdentifierById: {},
    universalIdentifiersByApplicationId: {},
    byUniversalIdentifier: {},
  });

  const workspaceCacheService = {
    invalidateAndRecompute: jest.fn(async () => {}),
    getOrRecompute: jest.fn(async (wsId: string, keys: string[] = []) => {
      const base: Record<string, unknown> = {
        flatRoleMaps: await buildFlatRoleMaps(wsId),
        flatApplicationMaps: await buildFlatApplicationMaps(wsId),
        flatFrontComponentMaps: emptyFlatMaps(),
        flatLogicFunctionMaps: emptyFlatMaps(),
        featureFlagsMap: {},
        billingEntitlements: {},
      };
      for (const key of keys) {
        if (!(key in base)) {
          base[key] = emptyFlatMaps();
        }
      }
      return base;
    }),
  };

  const workspaceEventBroadcaster = {
    broadcast: jest.fn(async () => {}),
  };

  const applicationService = Object.assign(
    Object.create(ApplicationService.prototype),
    {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      coreDataSource: runtime,
      applicationRepository,
      workspaceCacheService,
      workspaceEventBroadcaster,
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
        async ({ workspaceId: wsId }: { workspaceId: string }) => {
          const apps = await buildFlatApplicationMaps(wsId);
          return {
            twentyStandardFlatApplication: apps.byId[standardAppId],
            workspaceCustomFlatApplication: apps.byId[customAppId],
          };
        },
      ),
    },
  ) as InstanceType<typeof ApplicationService>;

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(
      async ({ workspaceId: wsId }: { workspaceId: string }) => ({
        flatRoleMaps: await buildFlatRoleMaps(wsId),
      }),
    ),
  };

  const workspaceMigrationValidateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async () => ({
      status: 'success',
    })),
    validateBuildAndRunWorkspaceMigrationFromTo: jest.fn(async () => ({
      status: 'success',
    })),
    validateBuildAndRunWorkspaceMigrationFromRecord: jest.fn(async () => ({
      status: 'success',
      workspaceMigration: { actions: [] },
      hasSchemaMetadataChanged: false,
    })),
  };

  const roleService = Object.assign(Object.create(RoleService.prototype), {
    flatEntityMapsCacheService,
    applicationService,
    roleRepository: runtime.getRepository(RoleEntity),
    workspaceMigrationValidateBuildAndRunService,
    coreDataSource: runtime,
  }) as InstanceType<typeof RoleService>;

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

  const applicationManifestMigrationService =
    new ApplicationManifestMigrationService(
      workspaceCacheService as never,
      workspaceMigrationValidateBuildAndRunService as never,
      applicationService,
      { compute: jest.fn(() => ({})) } as never,
      { log: jest.fn(), perf: jest.fn() } as never,
      { publishCronTriggerCacheEntries: jest.fn(async () => {}) } as never,
      { deleteManyByConnectionProviderIds: jest.fn(async () => {}) } as never,
    );

  return {
    applicationService,
    applicationRepository,
    workspaceCacheService,
    workspaceEventBroadcaster,
    roleService,
    twentyStandardApplicationService,
    applicationManifestMigrationService,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.getRepository(WorkspaceEntity).insert([
    {
      id: workspaceId,
      displayName: 'Acme',
      subdomain: 'acme',
      databaseSchema: 'workspace_acme',
      activationStatus: WorkspaceActivationStatus.ACTIVE,
    },
    {
      id: foreignWorkspaceId,
      displayName: 'Foreign',
      subdomain: 'foreign',
      databaseSchema: 'workspace_foreign',
      activationStatus: WorkspaceActivationStatus.ACTIVE,
    },
  ]);
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-app-default-role-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT,INSERT,UPDATE,DELETE ON core.workspace,core.application,core.role,core."userWorkspace" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    'TRUNCATE core.application,core.role,core."userWorkspace",crm_audit."crmAuditEntry"',
  );
  await owner.getRepository(ApplicationEntity).insert([
    {
      id: standardAppId,
      workspaceId,
      universalIdentifier: TWENTY_STANDARD_APPLICATION.universalIdentifier,
      name: 'Twenty Standard',
      defaultRoleId: null,
    },
    {
      id: customAppId,
      workspaceId,
      universalIdentifier: customAppUniversalId,
      name: 'Workspace Custom',
      defaultRoleId: null,
    },
    {
      id: manifestAppId,
      workspaceId,
      universalIdentifier: manifestAppUniversalId,
      name: 'Third-Party Manifest App',
      defaultRoleId: null,
    },
  ]);
  await owner.getRepository(RoleEntity).insert([
    {
      id: adminRoleId,
      workspaceId,
      applicationId: standardAppId,
      universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
      label: 'Admin',
      isEditable: false,
      canUpdateAllSettings: true,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
    {
      id: customAppRoleId,
      workspaceId,
      applicationId: customAppId,
      universalIdentifier:
        WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
      label: 'Workspace Custom Application Role',
      isEditable: false,
      canUpdateAllSettings: true,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
    {
      id: manifestRoleOneId,
      workspaceId,
      applicationId: manifestAppId,
      universalIdentifier: manifestRoleOneUniversalId,
      label: 'Manifest Role One',
      isEditable: false,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: true,
    },
    {
      id: manifestRoleTwoId,
      workspaceId,
      applicationId: manifestAppId,
      universalIdentifier: manifestRoleTwoUniversalId,
      label: 'Manifest Role Two',
      isEditable: false,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: true,
    },
  ]);
  await owner.getRepository(UserWorkspaceEntity).insert({
    id: impersonatorUserWorkspaceId,
    workspaceId,
    userId: impersonatorUserId,
    deletedAt: null,
  });
  await owner.getRepository(WorkspaceEntity).update(workspaceId, {
    displayName: 'Acme',
    subdomain: 'acme',
    databaseSchema: 'workspace_acme',
    defaultRoleId: null,
    activationStatus: WorkspaceActivationStatus.ACTIVE,
    deletedAt: null,
  });
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

describe('Application defaultRoleId CRM audit (LOG164)', () => {
  it('audits TwentyStandardApplicationService and RoleService.createWorkspaceCustomApplicationRole defaultRoleId bootstrap', async () => {
    const {
      twentyStandardApplicationService,
      roleService,
      workspaceCacheService,
      workspaceEventBroadcaster,
    } = buildHarness();

    await twentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow(
      {
        workspaceId,
        auditIdentity: systemIdentity('workspace-manager:init'),
      },
    );

    const standardApp = await readApplication(standardAppId);
    expect(standardApp.defaultRoleId).toBe(adminRoleId);

    await twentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow(
      {
        workspaceId,
      },
    );
    expect(await audits()).toHaveLength(1);

    await owner.query(
      'UPDATE core.application SET "defaultRoleId"=NULL WHERE id=$1',
      [standardAppId],
    );
    await twentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow(
      {
        workspaceId,
      },
    );
    expect((await readApplication(standardAppId)).defaultRoleId).toBe(
      adminRoleId,
    );

    const customFlatApp = await readApplication(customAppId);
    await roleService.createWorkspaceCustomApplicationRole({
      workspaceId,
      workspaceCustomFlatApplication: customFlatApp as never,
      auditIdentity: systemIdentity('workspace-manager:init'),
    });

    const updatedCustomApp = await readApplication(customAppId);
    expect(updatedCustomApp.defaultRoleId).toBe(customAppRoleId);
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationMaps'],
    );
    expect(workspaceEventBroadcaster.broadcast).toHaveBeenCalledTimes(3);

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: standardAppId,
      outcome: 'success',
      actor: { kind: 'system', id: 'workspace-manager:init' },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: adminRoleId },
        },
      },
      securityDescriptor: {
        resourceKind: 'application',
        resourceId: standardAppId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(entries[1]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: standardAppId,
      outcome: 'success',
      actor: { kind: 'system', id: 'twenty-standard-application:sync' },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: adminRoleId },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: customAppId,
      outcome: 'success',
      actor: { kind: 'system', id: 'workspace-manager:init' },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: customAppRoleId },
        },
      },
      securityDescriptor: {
        resourceKind: 'application',
        resourceId: customAppId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
  });

  it('audits ApplicationManifestMigrationService.syncMetadataFromManifest under request and background job audit contexts and supports clearing to null', async () => {
    const { applicationManifestMigrationService } = buildHarness();

    const buildManifest = (defaultRoleUniversalIdentifier?: string): Manifest =>
      ({
        application: {
          universalIdentifier: manifestAppUniversalId,
          displayName: 'Manifest App',
          ...(defaultRoleUniversalIdentifier !== undefined
            ? { defaultRoleUniversalIdentifier }
            : {}),
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
          },
          {
            universalIdentifier: manifestRoleTwoUniversalId,
            label: 'Manifest Role Two',
          },
        ],
        skills: [],
        agents: [],
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
      defaultRoleId: null as string | null,
    };

    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        impersonationContext: { impersonatorUserWorkspaceId },
      }),
      () =>
        applicationManifestMigrationService.syncMetadataFromManifest({
          manifest: buildManifest(manifestRoleOneUniversalId),
          workspaceId,
          ownerFlatApplication: ownerFlatApplication as never,
        }),
    );

    expect((await readApplication(manifestAppId)).defaultRoleId).toBe(
      manifestRoleOneId,
    );

    await withCrmAuditIdentity(
      workspaceId,
      systemMembershipCleanupIdentity(
        workspaceId,
        'UpgradeWorkspaceApplicationJob',
      ),
      () =>
        applicationManifestMigrationService.syncMetadataFromManifest({
          manifest: buildManifest(manifestRoleTwoUniversalId),
          workspaceId,
          ownerFlatApplication: {
            ...ownerFlatApplication,
            defaultRoleId: manifestRoleOneId,
          } as never,
        }),
    );

    expect((await readApplication(manifestAppId)).defaultRoleId).toBe(
      manifestRoleTwoId,
    );

    await applicationManifestMigrationService.syncMetadataFromManifest({
      manifest: buildManifest(undefined),
      workspaceId,
      ownerFlatApplication: {
        ...ownerFlatApplication,
        defaultRoleId: manifestRoleTwoId,
      } as never,
      inferDeletionFromMissingEntities: true,
      auditIdentity: userIdentity(),
    });

    expect((await readApplication(manifestAppId)).defaultRoleId).toBeNull();

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: manifestAppId,
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: manifestRoleOneId },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: manifestAppId,
      actor: { kind: 'system', id: 'UpgradeWorkspaceApplicationJob' },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: {
            before: manifestRoleOneId,
            after: manifestRoleTwoId,
          },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'application',
      resourceId: manifestAppId,
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: {
            before: manifestRoleTwoId,
            after: null,
          },
        },
      },
    });
  });

  it('skips writing an audit entry when defaultRoleId is unchanged (case-insensitive) while still persisting other application fields', async () => {
    const { applicationService } = buildHarness();

    await applicationService.update(
      manifestAppId,
      {
        workspaceId,
        defaultRoleId: manifestRoleOneId,
      },
      {
        auditIdentity: userIdentity(),
      },
    );
    expect(await audits()).toHaveLength(1);

    const updated = await applicationService.update(
      manifestAppId,
      {
        workspaceId,
        version: '2.1.0',
        defaultRoleId: manifestRoleOneId.toUpperCase(),
      },
      {
        auditIdentity: userIdentity(),
      },
    );

    expect(updated.version).toBe('2.1.0');
    expect(updated.defaultRoleId).toBe(manifestRoleOneId);
    expect(await audits()).toHaveLength(1);
  });

  it('rejects missing, foreign-workspace, or foreign-application roles under DB lock without mutating application or writing audit rows', async () => {
    const { applicationService, applicationManifestMigrationService } =
      buildHarness();

    const foreignRoleId = randomUUID();
    await owner.getRepository(RoleEntity).insert({
      id: foreignRoleId,
      workspaceId: foreignWorkspaceId,
      applicationId: null,
      universalIdentifier: randomUUID(),
      label: 'Foreign Role',
      canBeAssignedToUsers: true,
    });

    for (const invalidRoleId of [
      randomUUID(),
      foreignRoleId,
      adminRoleId,
      customAppRoleId,
      'not-a-uuid',
    ]) {
      await expect(
        applicationService.update(
          manifestAppId,
          {
            workspaceId,
            version: '9.9.9',
            defaultRoleId: invalidRoleId,
          },
          {
            auditIdentity: userIdentity(),
          },
        ),
      ).rejects.toThrow(
        'Application default role is unavailable or not owned by application',
      );
    }

    await expect(
      withCrmAuditIdentity(
        workspaceId,
        systemMembershipCleanupIdentity(
          workspaceId,
          'InstallApplicationCommand',
        ),
        () =>
          applicationManifestMigrationService.syncMetadataFromManifest({
            manifest: {
              application: {
                universalIdentifier: manifestAppUniversalId,
                displayName: 'Hijack Attempt',
                defaultRoleUniversalIdentifier:
                  STANDARD_ROLE.admin.universalIdentifier,
              },
              objects: [],
              fields: [],
              logicFunctions: [],
              frontComponents: [],
              permissionFlags: [],
              roles: [
                {
                  universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
                  label: 'Admin',
                },
              ],
              skills: [],
              agents: [],
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
            } as unknown as Manifest,
            workspaceId,
            ownerFlatApplication: {
              id: manifestAppId,
              workspaceId,
              universalIdentifier: manifestAppUniversalId,
            } as never,
          }),
      ),
    ).rejects.toThrow('Failed to resolve role');

    const app = await readApplication(manifestAppId);
    expect(app.defaultRoleId).toBeNull();
    expect(app.version).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it('fails closed before the first await when auditIdentity is missing or invalid on defaultRoleId updates, while keeping non-role updates unaffected and TOCTOU-safe', async () => {
    const { applicationService, applicationRepository, workspaceCacheService } =
      buildHarness();

    await expect(
      applicationService.update(manifestAppId, {
        workspaceId,
        defaultRoleId: manifestRoleOneId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      withCrmAuditIdentity(workspaceId, undefined, () =>
        applicationService.update(manifestAppId, {
          workspaceId,
          defaultRoleId: manifestRoleOneId,
        }),
      ),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      applicationService.create({
        workspaceId,
        universalIdentifier: randomUUID(),
        name: 'Unaudited Default Role App',
        defaultRoleId: manifestRoleOneId,
      }),
    ).rejects.toThrow(
      'Application creation cannot assign defaultRoleId without audit',
    );

    await expect(
      applicationService.update(
        manifestAppId,
        {
          workspaceId,
          defaultRoleId: manifestRoleOneId,
        },
        {
          auditIdentity: {
            actor: { kind: 'coreUser', id: actorUserId },
            correlationId: randomUUID(),
          },
        },
      ),
    ).rejects.toThrow('CRM audit context requires scoped identity');

    await expect(
      applicationService.update(
        manifestAppId,
        {
          workspaceId,
          defaultRoleId: manifestRoleOneId,
        },
        {
          auditIdentity: {
            auth: {
              type: 'pendingActivationUser',
              workspace: { id: workspaceId },
            },
          },
        },
      ),
    ).rejects.toThrow('Authentication cannot perform audited CRM writes');

    await expect(
      withRoleUpdateAudit(workspaceId, manifestRoleOneId, userIdentity(), () =>
        applicationService.update(
          manifestAppId,
          {
            workspaceId,
            defaultRoleId: manifestRoleOneId,
          },
          {
            auditIdentity: userIdentity(),
          },
        ),
      ),
    ).rejects.toThrow('Nested application default role audit is unsupported');

    const token = captureApplicationDefaultRoleAudit({
      workspaceId,
      applicationId: manifestAppId,
      auditIdentity: userIdentity(),
    })();
    await runAuditedApplicationDefaultRoleUpdate(
      runtime,
      token,
      manifestRoleOneId,
      async (runner) => {
        await runner.query(
          'UPDATE core.application SET "defaultRoleId"=$1 WHERE id=$2',
          [manifestRoleOneId, manifestAppId],
        );
      },
    );
    await expect(
      runAuditedApplicationDefaultRoleUpdate(
        runtime,
        token,
        manifestRoleTwoId,
        async () => {},
      ),
    ).rejects.toThrow('Nested application default role audit is unsupported');
    expect(await audits()).toHaveLength(1);

    const mutablePayload: {
      workspaceId: string;
      version?: string;
      defaultRoleId?: string;
    } = {
      workspaceId,
      version: '3.0.0',
    };
    applicationRepository.update.mockImplementationOnce(
      async (
        wsId: string,
        criteria: { id: string },
        partial: Record<string, unknown>,
      ) => {
        mutablePayload.defaultRoleId = manifestRoleTwoId;
        await runtime
          .getRepository(ApplicationEntity)
          .update({ id: criteria.id, workspaceId: wsId }, partial);
      },
    );

    const nonRoleUpdated = await applicationService.update(
      manifestAppId,
      mutablePayload,
    );
    expect(nonRoleUpdated.version).toBe('3.0.0');
    expect(nonRoleUpdated.defaultRoleId).toBe(manifestRoleOneId);
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationMaps'],
    );
    expect(await audits()).toHaveLength(1);
  });

  it('rolls back both application update and audit entry when work or post-flush verification detects unexpected state drift', async () => {
    const requestOne = captureApplicationDefaultRoleAudit({
      workspaceId,
      applicationId: manifestAppId,
      auditIdentity: userIdentity(),
    })();

    await expect(
      runAuditedApplicationDefaultRoleUpdate(
        runtime,
        requestOne,
        manifestRoleOneId,
        async (runner) => {
          await runner.query(
            'UPDATE core.application SET "defaultRoleId"=$1 WHERE id=$2',
            [manifestRoleTwoId, manifestAppId],
          );
        },
      ),
    ).rejects.toThrow(
      'Application default role update did not persist expected value',
    );
    expect((await readApplication(manifestAppId)).defaultRoleId).toBeNull();
    expect(await audits()).toHaveLength(0);

    const requestTwo = captureApplicationDefaultRoleAudit({
      workspaceId,
      applicationId: manifestAppId,
      auditIdentity: userIdentity(),
    })();
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const realQuery = runner.query.bind(runner);
      jest
        .spyOn(runner, 'query')
        .mockImplementation(async (sql: string, params?: unknown[]) => {
          const res = await realQuery(sql, params);
          if (sql.includes('INSERT INTO crm_audit."crmAuditEntry"')) {
            await realQuery(
              'UPDATE core.application SET "defaultRoleId"=$1 WHERE id=$2',
              [manifestRoleTwoId, manifestAppId],
            );
          }
          return res;
        });
      return runner;
    });

    await expect(
      runAuditedApplicationDefaultRoleUpdate(
        runtime,
        requestTwo,
        manifestRoleOneId,
        async (runner) => {
          await runner.query(
            'UPDATE core.application SET "defaultRoleId"=$1 WHERE id=$2',
            [manifestRoleOneId, manifestAppId],
          );
        },
      ),
    ).rejects.toThrow(
      'Application default role state changed during audit flush',
    );
    expect((await readApplication(manifestAppId)).defaultRoleId).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it('invalidates flatApplicationMaps cache without rollback or false broadcast on commit ACK loss or post-commit failure', async () => {
    const {
      applicationService,
      workspaceCacheService,
      workspaceEventBroadcaster,
    } = buildHarness();

    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const statements: string[] = [];
    const clients = new WeakSet<object>();
    let rollbackSpy: jest.SpyInstance | undefined;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const connect = runner.connect.bind(runner);
      rollbackSpy = jest.spyOn(runner, 'rollbackTransaction');
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
      applicationService.update(
        manifestAppId,
        {
          workspaceId,
          defaultRoleId: manifestRoleOneId,
        },
        {
          auditIdentity: userIdentity(),
        },
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationMaps'],
    );
    expect(workspaceEventBroadcaster.broadcast).not.toHaveBeenCalled();
    expect((await readApplication(manifestAppId)).defaultRoleId).toBe(
      manifestRoleOneId,
    );
    expect(await audits()).toHaveLength(1);

    workspaceCacheService.invalidateAndRecompute.mockClear();
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const realCommit = runner.commitTransaction.bind(runner);
      rollbackSpy = jest.spyOn(runner, 'rollbackTransaction');
      jest
        .spyOn(runner, 'commitTransaction')
        .mockImplementationOnce(async () => {
          await realCommit();
          throw new Error('simulated post-commit hook error');
        });
      return runner;
    });

    await expect(
      applicationService.update(
        manifestAppId,
        {
          workspaceId,
          defaultRoleId: manifestRoleTwoId,
        },
        {
          auditIdentity: userIdentity(),
        },
      ),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationMaps'],
    );
    expect(workspaceEventBroadcaster.broadcast).not.toHaveBeenCalled();
  });
});
