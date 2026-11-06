import { randomUUID } from 'node:crypto';
import { MEMBER_ROLE_UNIVERSAL_IDENTIFIER } from 'twenty-shared/constants';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER } from 'src/engine/core-modules/application/constants/workspace-custom-application-role.constant';
import { withApiKeyRoleAssignmentAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  withRoleCreateAudit,
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { buildWorkspaceCustomApplicationFlatRole } from 'src/engine/metadata-modules/flat-role/utils/build-workspace-custom-application-flat-role.util';
import { fromCreateRoleInputToFlatRoleToCreate } from 'src/engine/metadata-modules/flat-role/utils/from-create-role-input-to-flat-role-to-create.util';
import { SEED_YCOMBINATOR_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_WORKSPACE_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-user-workspaces.util';
import { API_KEY_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/api-key-data-seeds.constant';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));
for (const [path, name] of [
  ['core-modules/api-key/services/api-key-role.service', 'ApiKeyRoleService'],
  ['core-modules/application/application.service', 'ApplicationService'],
  [
    'workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    'WorkspaceMigrationValidateBuildAndRunService',
  ],
  [
    'core-modules/feature-flag/services/feature-flag.service',
    'FeatureFlagService',
  ],
  ['core-modules/logger/logger.service', 'LoggerService'],
  ['core-modules/metrics/metrics.service', 'MetricsService'],
  ['core-modules/twenty-config/twenty-config.service', 'TwentyConfigService'],
  [
    'metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    'WorkspaceManyOrAllFlatEntityMapsCacheService',
  ],
  [
    'metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    'WorkspaceMetadataVersionService',
  ],
  ['workspace-cache/services/workspace-cache.service', 'WorkspaceCacheService'],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    'InFlightDeferredWorkspaceMigrationActionsService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    'DeferredWorkspaceMigrationActionRunnerService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    'WorkspaceMigrationRunnerActionHandlerRegistryService',
  ],
  ['twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    'RoleAssignmentValidationService',
  ],
  ['workspace-datasource/workspace-schema.service', 'WorkspaceSchemaService'],
  [
    'workspace-manager/twenty-standard-application/services/twenty-standard-application.service',
    'TwentyStandardApplicationService',
  ],
  [
    'metadata-modules/object-permission/field-permission/field-permission.service',
    'FieldPermissionService',
  ],
  [
    'metadata-modules/object-permission/object-permission.service',
    'ObjectPermissionService',
  ],
  [
    'metadata-modules/role-permission-flag/role-permission-flag.service',
    'RolePermissionFlagService',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
  ['core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
  [
    'metadata-modules/object-metadata/object-metadata.entity',
    'ObjectMetadataEntity',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
jest.mock('src/engine/metadata-modules/role/dtos/role.dto', () => ({
  RoleDTO: class {},
}));
jest.mock('src/engine/twenty-orm/utils/build-system-auth-context.util', () => ({
  buildSystemAuthContext: (wsId: string) => ({
    workspace: { id: wsId },
    type: 'system',
  }),
}));
jest.mock(
  'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
  () => ({ WorkspaceMemberWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({
    WorkspaceMigrationRunnerActionHandler: () =>
      class {
        async insertFlatEntitiesInRepository({
          queryRunner,
          flatEntities,
        }: {
          queryRunner: QueryRunner;
          flatEntities: Record<string, unknown>[];
        }) {
          if (flatEntities.length === 0) return;
          const first = flatEntities[0];
          if ('canBeAssignedToUsers' in first) {
            await queryRunner.manager.getRepository(RoleEntity).insert(
              flatEntities.map((flatEntity) =>
                flatEntityToScalarFlatEntity({
                  metadataName: 'role',
                  flatEntity: flatEntity as never,
                }),
              ),
            );
          } else {
            await queryRunner.manager.getRepository(RoleTargetEntity).insert(
              flatEntities.map((flatEntity) =>
                flatEntityToScalarFlatEntity({
                  metadataName: 'roleTarget',
                  flatEntity: flatEntity as never,
                }),
              ),
            );
          }
        }
        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: { universalIdentifier: string };
          allFlatEntityMaps: {
            flatRoleTargetMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
          };
        }) {
          return {
            ...context.action,
            entityId:
              context.allFlatEntityMaps.flatRoleTargetMaps
                .byUniversalIdentifier[context.action.universalIdentifier].id,
          };
        }
      },
  }),
);

const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRoleActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/create-role-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/create-role-action-handler.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { RoleService } =
  require('src/engine/metadata-modules/role/role.service') as typeof import('src/engine/metadata-modules/role/role.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { UserRoleService } =
  require('src/engine/metadata-modules/user-role/user-role.service') as typeof import('src/engine/metadata-modules/user-role/user-role.service');
const { WorkspaceManagerService } =
  require('src/engine/workspace-manager/workspace-manager.service') as typeof import('src/engine/workspace-manager/workspace-manager.service');
const { DevSeederPermissionsService } =
  require('src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service') as typeof import('src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `sys_role_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = SEED_YCOMBINATOR_WORKSPACE_ID;
const customAppId = randomUUID();
const customAppUniversalIdentifier = randomUUID();
const standardAppId = randomUUID();
const standardAppUniversalIdentifier = randomUUID();
const adminRoleId = randomUUID();
const actorId = randomUUID();

const customApplication = {
  id: customAppId,
  universalIdentifier: customAppUniversalIdentifier,
  defaultRoleId: null as string | null,
};
const standardApplication = {
  id: standardAppId,
  universalIdentifier: standardAppUniversalIdentifier,
  defaultRoleId: null as string | null,
};

const booleans = [
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
];

const roleSchema = new EntitySchema({
  name: 'RoleEntity',
  target: RoleEntity,
  tableName: 'role',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    label: { type: 'text' },
    description: { type: 'text', nullable: true },
    icon: { type: 'text', nullable: true },
    isEditable: { type: Boolean, default: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    ...Object.fromEntries(
      booleans.map((name) => [name, { type: Boolean, default: false }]),
    ),
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

const targetSchema = new EntitySchema({
  name: 'RoleTargetEntity',
  target: RoleTargetEntity,
  tableName: 'roleTarget',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    userWorkspaceId: { type: 'uuid', nullable: true },
    agentId: { type: 'uuid', nullable: true },
    apiKeyId: { type: 'uuid', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
  uniques: [
    { columns: ['workspaceId', 'userWorkspaceId'] },
    { columns: ['workspaceId', 'universalIdentifier'] },
  ],
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [roleSchema, membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-sys-role-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [roleSchema, membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & {
  id: string;
  universalIdentifier: string;
};

const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY "createdAt",id');
const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY "createdAt",id');
const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const userIdentity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
});

const systemIdentity = (
  systemActorId = 'workspace-manager:init',
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'system',
    workspace: { id: workspaceId },
  },
  systemActorId,
});

const entityMaps = (records: Row[]) => ({
  byUniversalIdentifier: Object.fromEntries(
    records.map((r) => [r.universalIdentifier, r]),
  ),
  universalIdentifierById: Object.fromEntries(
    records.map((r) => [r.id, r.universalIdentifier]),
  ),
  byId: Object.fromEntries(records.map((r) => [r.id, r])),
});

const flatMaps = async () => ({
  flatRoleMaps: entityMaps(await roles()),
  flatRoleTargetMaps: entityMaps(await targets()),
  flatAgentMaps: entityMaps([]),
  flatApplicationMaps: {
    byId: {
      [customAppId]: customApplication,
      [standardAppId]: standardApplication,
    },
    idByUniversalIdentifier: {
      [customAppUniversalIdentifier]: customAppId,
      [standardAppUniversalIdentifier]: standardAppId,
    },
  },
});

const buildHarness = (options: { failMigration?: boolean } = {}) => {
  const createRoleHandler = new CreateRoleActionHandlerService();
  const createTargetHandler = new CreateRoleTargetActionHandlerService();
  const deleteTargetHandler = new DeleteRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      if (context.action.metadataName === 'role') {
        const flatAction =
          await createRoleHandler.transpileUniversalActionToFlatAction(context);
        await createRoleHandler.executeForMetadata({ ...context, flatAction });
      } else if (context.action.type === 'create') {
        const flatAction =
          await createTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await createTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else {
        const flatAction =
          await deleteTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await deleteTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      }
      if (options.failMigration) throw new Error('handler failure');
      return {
        partialOptimisticCache: {},
        metadataEvents: [{}],
        deferredActions: [],
      };
    }),
    executeActionRollbackHandler: jest.fn(),
  };

  const cache = {
    getOrRecompute: jest.fn(async () => ({
      flatApplicationMaps: {
        byId: {
          [customAppId]: customApplication,
          [standardAppId]: standardApplication,
        },
        idByUniversalIdentifier: {
          [customAppUniversalIdentifier]: customAppId,
          [standardAppUniversalIdentifier]: standardAppId,
        },
      },
      userWorkspaceRoleMap: Object.fromEntries(
        (await targets()).map((r) => [r.userWorkspaceId, r.roleId]),
      ),
      flatWorkspaceMemberMaps: { byId: {}, idByUserWorkspaceId: {} },
    })),
    invalidateAndRecompute: jest.fn(async () => {}),
  };

  const flatEntityMapsCache = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => flatMaps()),
  };

  const runner = new WorkspaceMigrationRunnerService(
    flatEntityMapsCache as never,
    runtime,
    registry as never,
    {} as never,
    cache as never,
    { recordHistogram: jest.fn() } as never,
    {
      perf: jest.fn(),
      perfTime: jest.fn(),
      perfTimeEnd: jest.fn(),
      error: jest.fn(),
    } as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    { persist: jest.fn(), dispatchAfterCommit: jest.fn() } as never,
    {} as never,
  );

  const builder = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async (args) => {
      const actions: Record<string, unknown>[] = [];
      const roleOps = args.allFlatEntityOperationByMetadataName.role;
      if (roleOps) {
        for (const flatRole of roleOps.flatEntityToCreate) {
          actions.push({
            type: 'create',
            metadataName: 'role',
            id: flatRole.id,
            flatEntity: Object.fromEntries(
              Object.entries(flatRole).filter(
                ([key]) =>
                  ![
                    'id',
                    'workspaceId',
                    'applicationId',
                    'roleTargetIds',
                    'roleTargetUniversalIdentifiers',
                    'objectPermissionIds',
                    'rolePermissionFlagIds',
                    'objectPermissionUniversalIdentifiers',
                    'rolePermissionFlagUniversalIdentifiers',
                    'fieldPermissionIds',
                    'fieldPermissionUniversalIdentifiers',
                    'rowLevelPermissionPredicateIds',
                    'rowLevelPermissionPredicateUniversalIdentifiers',
                    'rowLevelPermissionPredicateGroupIds',
                    'rowLevelPermissionPredicateGroupUniversalIdentifiers',
                    'agentChatChannelRoleIds',
                    'agentChatChannelRoleUniversalIdentifiers',
                  ].includes(key),
              ),
            ),
          });
        }
      }
      const targetOps = args.allFlatEntityOperationByMetadataName.roleTarget;
      if (targetOps) {
        for (const row of targetOps.flatEntityToDelete) {
          actions.push({
            type: 'delete',
            metadataName: 'roleTarget',
            universalIdentifier: row.universalIdentifier,
          });
        }
        for (const row of targetOps.flatEntityToCreate) {
          actions.push({
            type: 'create',
            metadataName: 'roleTarget',
            id: row.id,
            flatEntity: Object.fromEntries(
              Object.entries(row).filter(
                ([key]) =>
                  ![
                    'id',
                    'workspaceId',
                    'applicationId',
                    'roleId',
                    'agentId',
                  ].includes(key),
              ),
            ),
          });
        }
      }
      await runner.run({
        workspaceId: args.workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: args.applicationUniversalIdentifier,
          actions,
        } as never,
      });
      return { status: 'success' };
    }),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async () => ({
        workspaceCustomFlatApplication: customApplication,
        twentyStandardFlatApplication: standardApplication,
      }),
    ),
    update: jest.fn(
      async (_appId: string, update: { defaultRoleId: string }) => {
        customApplication.defaultRoleId = update.defaultRoleId;
      },
    ),
  };

  const roleService = new RoleService(
    builder as never,
    flatEntityMapsCache as never,
    { update: jest.fn(async () => {}) } as never,
    applicationService as never,
    {} as never,
  );

  const roleTargetService = new RoleTargetService(
    flatEntityMapsCache as never,
    builder as never,
    applicationService as never,
  );

  const roleTargetRepository = {
    findOne: async (
      _ws: string,
      opts: { where: { userWorkspaceId: string; roleId: string } },
    ) =>
      (await targets()).find(
        (r) =>
          r.userWorkspaceId === opts.where.userWorkspaceId &&
          r.roleId === opts.where.roleId,
      ),
    find: async (
      _ws: string,
      opts: { where: { userWorkspaceId: { value: string[] } } },
    ) => {
      const roleRows = await roles();
      return (await targets())
        .filter((r) =>
          opts.where.userWorkspaceId.value.includes(String(r.userWorkspaceId)),
        )
        .map((r) => ({
          ...r,
          role: roleRows.find((role) => role.id === r.roleId),
        }));
    },
  };

  const userRoleService = new UserRoleService(
    roleTargetRepository as never,
    owner.getRepository(UserWorkspaceEntity),
    {} as never,
    roleTargetService,
    cache as never,
    { validateRoleAssignableToUsersOrThrow: jest.fn(async () => {}) } as never,
  );

  const roleScopedRepository = {
    findOne: async (
      _ws: string,
      opts: { where: { universalIdentifier: string } },
    ) =>
      (await roles()).find(
        (r) => r.universalIdentifier === opts.where.universalIdentifier,
      ) ?? null,
  };

  return {
    roleService,
    roleTargetService,
    userRoleService,
    roleScopedRepository,
    applicationService,
    builder,
    flatEntityMapsCache,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE; CREATE SCHEMA core; CREATE SCHEMA synthetic_members',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"defaultRoleId" uuid,"activationStatus" text,"deletedAt" timestamptz); CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz); CREATE TABLE core."apiKey"(id uuid PRIMARY KEY,"workspaceId" uuid,"revokedAt" timestamptz); ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE; CREATE TABLE synthetic_members."workspaceMember"(id uuid PRIMARY KEY,"userId" uuid,"deletedAt" timestamptz)',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"databaseSchema") VALUES($1,$2)',
    [workspaceId, 'synthetic_members'],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-sys-role-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit,synthetic_members TO "${databaseRole}"; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core,synthetic_members TO "${databaseRole}"; GRANT INSERT,DELETE ON core.role,core."roleTarget" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  customApplication.defaultRoleId = null;
  standardApplication.defaultRoleId = null;
  await owner.query(
    'TRUNCATE core.application,core."apiKey",core."roleTarget",core.role,core."userWorkspace",synthetic_members."workspaceMember",crm_audit."crmAuditEntry"',
  );
  await owner.query(
    'INSERT INTO core.application VALUES($1,$2,$3,NULL),($4,$2,$5,NULL)',
    [
      customAppId,
      workspaceId,
      customAppUniversalIdentifier,
      standardAppId,
      standardAppUniversalIdentifier,
    ],
  );
  await owner.query('INSERT INTO core."apiKey" VALUES($1,$2,NULL)', [
    API_KEY_DATA_SEED_IDS.ID_1,
    workspaceId,
  ]);
  await owner.getRepository(RoleEntity).insert({
    id: adminRoleId,
    workspaceId,
    universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
    applicationId: standardAppId,
    label: 'Admin',
    description: 'Admin role',
    icon: 'IconKey',
    isEditable: false,
    canUpdateAllSettings: true,
    canAccessAllTools: true,
    canAccessAllAgentChatChannels: true,
    canReadAllObjectRecords: true,
    canUpdateAllObjectRecords: true,
    canSoftDeleteAllObjectRecords: true,
    canDestroyAllObjectRecords: true,
    canBeAssignedToUsers: true,
    canBeAssignedToAgents: true,
    canBeAssignedToApiKeys: true,
  });
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

describe('LOG160 audited system and bootstrap role creation and roleTarget bindings', () => {
  it('audits createMemberRole and createGuestRole with system actor attribution', async () => {
    const { roleService } = buildHarness();

    const memberRole = await roleService.createMemberRole({
      workspaceId,
      ownerFlatApplication: customApplication as never,
      auditIdentity: systemIdentity('workspace-manager:setup-default-roles'),
    });
    const guestRole = await roleService.createGuestRole({
      workspaceId,
      ownerFlatApplication: customApplication as never,
      auditIdentity: systemIdentity('dev-seeder:init-permissions'),
    });

    const roleRows = await roles();
    expect(roleRows.find((r) => r.id === memberRole.id)).toMatchObject({
      universalIdentifier: MEMBER_ROLE_UNIVERSAL_IDENTIFIER,
      label: 'Member',
      isEditable: true,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    });
    expect(roleRows.find((r) => r.id === guestRole.id)).toMatchObject({
      label: 'Guest',
      isEditable: true,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: false,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toMatchObject({
      action: 'create',
      resourceKind: 'role',
      resourceId: memberRole.id,
      actor: {
        kind: 'system',
        id: 'workspace-manager:setup-default-roles',
      },
    });
    expect(auditRows[1]).toMatchObject({
      action: 'create',
      resourceKind: 'role',
      resourceId: guestRole.id,
      actor: {
        kind: 'system',
        id: 'dev-seeder:init-permissions',
      },
    });
  });

  it('audits createWorkspaceCustomApplicationRole (isEditable: false) and enforces auditIdentity on idempotent retry', async () => {
    const { roleService, applicationService, flatEntityMapsCache } =
      buildHarness();

    await roleService.createWorkspaceCustomApplicationRole({
      workspaceId,
      workspaceCustomFlatApplication: customApplication as never,
      auditIdentity: systemIdentity('workspace-manager:init'),
    });

    const customAppRole = (await roles()).find(
      (r) =>
        r.universalIdentifier ===
        WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
    );
    expect(customAppRole).toBeDefined();
    expect(customAppRole).toMatchObject({
      isEditable: false,
      canUpdateAllSettings: true,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    });
    expect(applicationService.update).toHaveBeenCalledWith(customAppId, {
      workspaceId,
      defaultRoleId: customAppRole!.id,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'create',
      resourceKind: 'role',
      resourceId: customAppRole!.id,
      actor: {
        kind: 'system',
        id: 'workspace-manager:init',
      },
    });

    await roleService.createWorkspaceCustomApplicationRole({
      workspaceId,
      workspaceCustomFlatApplication: customApplication as never,
      auditIdentity: systemIdentity('workspace-manager:init'),
    });
    expect(await audits()).toHaveLength(1);

    flatEntityMapsCache.getOrRecomputeManyOrAllFlatEntityMaps.mockClear();
    await expect(
      roleService.createWorkspaceCustomApplicationRole({
        workspaceId,
        workspaceCustomFlatApplication: customApplication as never,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    expect(
      flatEntityMapsCache.getOrRecomputeManyOrAllFlatEntityMaps,
    ).not.toHaveBeenCalled();

    await expect(
      withRoleUpdateAudit(workspaceId, adminRoleId, userIdentity(), () =>
        roleService.createWorkspaceCustomApplicationRole({
          workspaceId,
          workspaceCustomFlatApplication: customApplication as never,
          auditIdentity: systemIdentity('workspace-manager:init'),
        }),
      ),
    ).rejects.toThrow('Nested role audit is unsupported');
  });

  it('rejects isEditable: false in withRoleCreateAudit for non-system actors or non-custom-application universalIdentifier', async () => {
    const customAppFlatRole = buildWorkspaceCustomApplicationFlatRole({
      workspaceId,
      workspaceCustomFlatApplication: customApplication,
    });

    await expect(
      withRoleCreateAudit(customAppFlatRole, userIdentity(), async () => {}),
    ).rejects.toThrow('Role create audit requires normalized scalar fields');

    const arbitraryNonEditableRole = {
      ...fromCreateRoleInputToFlatRoleToCreate({
        createRoleInput: { label: 'Non-editable spoof' },
        workspaceId,
        flatApplication: customApplication as never,
      }),
      isEditable: false,
    };

    await expect(
      withRoleCreateAudit(
        arbitraryNonEditableRole,
        systemIdentity('workspace-manager:init'),
        async () => {},
      ),
    ).rejects.toThrow('Role create audit requires normalized scalar fields');
  });

  it('rejects missing or invalid auditIdentity across createRole, createMemberRole, and createGuestRole', async () => {
    const { roleService, builder } = buildHarness();

    await expect(
      roleService.createRole({
        workspaceId,
        ownerFlatApplication: customApplication as never,
        input: { label: 'Role without identity' },
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      roleService.createMemberRole({
        workspaceId,
        ownerFlatApplication: customApplication as never,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      roleService.createGuestRole({
        workspaceId,
        ownerFlatApplication: customApplication as never,
        auditIdentity: {
          auth: {
            type: 'system',
            workspace: { id: workspaceId },
          },
        },
      }),
    ).rejects.toThrow('System role audit requires a valid systemActorId');

    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('audits API-key roleTarget creation with explicit twentyStandardFlatApplication.id in RoleTargetService.createMany', async () => {
    const { roleTargetService } = buildHarness();

    await withApiKeyRoleAssignmentAudit(
      {
        workspaceId,
        apiKeyId: API_KEY_DATA_SEED_IDS.ID_1,
        roleId: adminRoleId,
      },
      systemIdentity('dev-seeder:init-permissions'),
      () =>
        roleTargetService.create({
          createRoleTargetInput: {
            roleId: adminRoleId,
            targetId: API_KEY_DATA_SEED_IDS.ID_1,
            targetMetadataForeignKey: 'apiKeyId',
            applicationId: standardAppId,
          },
          workspaceId,
        }),
    );

    const targetRows = await targets();
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]).toMatchObject({
      workspaceId,
      applicationId: standardAppId,
      roleId: adminRoleId,
      apiKeyId: API_KEY_DATA_SEED_IDS.ID_1,
      userWorkspaceId: null,
      agentId: null,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'create',
      resourceKind: 'roleTarget',
      resourceId: targetRows[0].id,
      actor: {
        kind: 'system',
        id: 'dev-seeder:init-permissions',
      },
      redactedDiff: {
        changedFields: ['apiKeyId', 'roleId'],
        values: {
          apiKeyId: { before: null, after: API_KEY_DATA_SEED_IDS.ID_1 },
          roleId: { before: null, after: adminRoleId },
        },
      },
    });
  });

  it('audits WorkspaceManagerService setupDefaultRoles and DevSeederPermissionsService initPermissions end-to-end', async () => {
    const {
      roleService,
      userRoleService,
      roleTargetService,
      roleScopedRepository,
    } = buildHarness();

    for (const seedId of [
      USER_WORKSPACE_DATA_SEED_IDS.TIM_ACME,
      USER_WORKSPACE_DATA_SEED_IDS.JONY_ACME,
      USER_WORKSPACE_DATA_SEED_IDS.JANE_ACME,
      USER_WORKSPACE_DATA_SEED_IDS.PHIL_ACME,
    ]) {
      await owner.query(
        'INSERT INTO core."userWorkspace" (id,"workspaceId","userId") VALUES($1,$2,$3)',
        [seedId, workspaceId, randomUUID()],
      );
    }

    const seeder = new DevSeederPermissionsService(
      roleService,
      userRoleService,
      {} as never,
      {} as never,
      roleScopedRepository as never,
      {} as never,
      roleTargetService,
      {} as never,
      {
        getRepository: () => ({ update: jest.fn(async () => {}) }),
      } as never,
    );

    await seeder.initPermissions({
      workspaceId,
      twentyStandardFlatApplication: standardApplication as never,
      workspaceCustomFlatApplication: customApplication as never,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(7);
    expect(auditRows.map((r) => `${r.resourceKind}:${r.action}`)).toEqual([
      'roleTarget:create',
      'roleTarget:create',
      'role:create',
      'role:create',
      'roleTarget:create',
      'roleTarget:create',
      'roleTarget:create',
    ]);

    const setupUserId = randomUUID();
    const setupUserWorkspaceId = randomUUID();
    await owner.query(
      'INSERT INTO core."userWorkspace" (id,"workspaceId","userId") VALUES($1,$2,$3)',
      [setupUserWorkspaceId, workspaceId, setupUserId],
    );
    const workspaceManager = new WorkspaceManagerService(
      {} as never,
      owner.getRepository(UserWorkspaceEntity),
      roleService,
      userRoleService,
      {} as never,
      { update: jest.fn(async () => {}) } as never,
      roleScopedRepository as never,
      {} as never,
    );

    await (
      workspaceManager as unknown as {
        setupDefaultRoles: (args: {
          workspaceId: string;
          userId: string;
          workspaceCustomFlatApplication: unknown;
        }) => Promise<void>;
      }
    ).setupDefaultRoles({
      workspaceId,
      userId: setupUserId,
      workspaceCustomFlatApplication: customApplication,
    });

    const afterSetupAudits = await audits();
    expect(afterSetupAudits).toHaveLength(8);
    expect(afterSetupAudits[7]).toMatchObject({
      action: 'create',
      resourceKind: 'roleTarget',
      actor: {
        kind: 'system',
        id: 'workspace-manager:setup-default-roles',
      },
    });
  });

  it('rolls back core.role and crm_audit.crmAuditEntry when system role creation fails in handler', async () => {
    const { roleService } = buildHarness({ failMigration: true });

    await expect(
      roleService.createWorkspaceCustomApplicationRole({
        workspaceId,
        workspaceCustomFlatApplication: customApplication as never,
        auditIdentity: systemIdentity('workspace-manager:init'),
      }),
    ).rejects.toThrow('handler failure');

    expect(
      (await roles()).find(
        (r) =>
          r.universalIdentifier ===
          WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
      ),
    ).toBeUndefined();
    expect(await audits()).toEqual([]);
  });

  it('audits DevSeederPermissionsService createImpersonateOnlyRoleForSeedWorkspace and createLimitedRoleForSeedWorkspace with permission upserts', async () => {
    const {
      roleService,
      userRoleService,
      roleTargetService,
      roleScopedRepository,
    } = buildHarness();

    const petObjId = randomUUID();
    const rocketObjId = randomUUID();
    const personObjId = randomUUID();
    const jobTitleFieldId = randomUUID();
    const companyObjId = randomUUID();
    const linkedinFieldId = randomUUID();

    const objectPermissionService = {
      upsertObjectPermissions: jest.fn(async () => []),
    };
    const fieldPermissionService = {
      upsertFieldPermissions: jest.fn(async () => []),
    };
    const rolePermissionFlagService = {
      upsertPermissionFlags: jest.fn(async () => []),
    };
    const objectMetadataRepository = {
      findOneOrFail: jest.fn(
        async (_ws: string, opts: { where: { nameSingular: string } }) => {
          switch (opts.where.nameSingular) {
            case 'pet':
              return { id: petObjId, fields: [] };
            case 'rocket':
              return { id: rocketObjId, fields: [] };
            case 'person':
              return {
                id: personObjId,
                fields: [{ id: jobTitleFieldId, name: 'jobTitle' }],
              };
            default:
              return {
                id: companyObjId,
                fields: [{ id: linkedinFieldId, name: 'linkedinLink' }],
              };
          }
        },
      ),
    };

    const seeder = new DevSeederPermissionsService(
      roleService,
      userRoleService,
      objectPermissionService as never,
      objectMetadataRepository as never,
      roleScopedRepository as never,
      fieldPermissionService as never,
      roleTargetService,
      rolePermissionFlagService as never,
      {} as never,
    );

    const impersonateRole = await (
      seeder as unknown as {
        createImpersonateOnlyRoleForSeedWorkspace: (args: {
          workspaceId: string;
          ownerFlatApplication: unknown;
        }) => Promise<{ id: string }>;
      }
    ).createImpersonateOnlyRoleForSeedWorkspace({
      workspaceId,
      ownerFlatApplication: customApplication,
    });

    const limitedRole = await (
      seeder as unknown as {
        createLimitedRoleForSeedWorkspace: (args: {
          workspaceId: string;
          ownerFlatApplication: unknown;
        }) => Promise<{ id: string }>;
      }
    ).createLimitedRoleForSeedWorkspace({
      workspaceId,
      ownerFlatApplication: customApplication,
    });

    expect(
      rolePermissionFlagService.upsertPermissionFlags,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        auditIdentity: {
          auth: { workspace: { id: workspaceId }, type: 'system' },
          systemActorId: 'dev-seeder:init-permissions',
        },
      }),
    );
    expect(
      objectPermissionService.upsertObjectPermissions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        auditIdentity: {
          auth: { workspace: { id: workspaceId }, type: 'system' },
          systemActorId: 'dev-seeder:init-permissions',
        },
      }),
    );
    expect(fieldPermissionService.upsertFieldPermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        auditIdentity: {
          auth: { workspace: { id: workspaceId }, type: 'system' },
          systemActorId: 'dev-seeder:init-permissions',
        },
      }),
    );

    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((r) => r.resourceId)).toEqual([
      impersonateRole.id,
      limitedRole.id,
    ]);
    expect(auditRows[0].actor).toEqual({
      kind: 'system',
      id: 'dev-seeder:init-permissions',
    });
    expect(auditRows[1].actor).toEqual({
      kind: 'system',
      id: 'dev-seeder:init-permissions',
    });
  });
});
