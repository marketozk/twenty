import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  withAgentRoleAssignmentAudit,
  withAgentRoleRemovalAudit,
  withApiKeyRoleAssignmentAudit,
} from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  withRoleDeleteAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));
for (const [path, name] of [
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
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
  ['core-modules/api-key/api-key.entity', 'ApiKeyEntity'],
  ['metadata-modules/ai/ai-agent/entities/agent.entity', 'AgentEntity'],
  ['core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
  ['metadata-modules/role/dtos/role.dto', 'RoleDTO'],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
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
          flatEntities: object[];
        }) {
          await queryRunner.manager.getRepository(RoleTargetEntity).insert(
            flatEntities.map((flatEntity) =>
              flatEntityToScalarFlatEntity({
                metadataName: 'roleTarget',
                flatEntity: flatEntity as never,
              }),
            ),
          );
        }
        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: {
            metadataName: 'role' | 'roleTarget';
            universalIdentifier: string;
          };
          allFlatEntityMaps: {
            flatRoleMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
            flatRoleTargetMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
          };
        }) {
          const map =
            context.action.metadataName === 'role'
              ? context.allFlatEntityMaps.flatRoleMaps.byUniversalIdentifier
              : context.allFlatEntityMaps.flatRoleTargetMaps
                  .byUniversalIdentifier;
          return {
            ...context.action,
            entityId: map[context.action.universalIdentifier].id,
          };
        }
      },
  }),
);

const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { DeleteRoleActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/delete-role-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/delete-role-action-handler.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { RoleService } =
  require('src/engine/metadata-modules/role/role.service') as typeof import('src/engine/metadata-modules/role/role.service');
const { DeleteRoleTool } =
  require('src/engine/metadata-modules/role/tools/delete-role.tool') as typeof import('src/engine/metadata-modules/role/tools/delete-role.tool');
const { AiAgentRoleService } =
  require('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service') as typeof import('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service');
const { ApiKeyRoleService } =
  require('src/engine/core-modules/api-key/services/api-key-role.service') as typeof import('src/engine/core-modules/api-key/services/api-key-role.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `role_delete_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const actorId = randomUUID();
const defaultRoleId = randomUUID();
const defaultRoleUniversalIdentifier = randomUUID();
const customRoleId = randomUUID();
const customRoleUniversalIdentifier = randomUUID();
const otherRoleId = randomUUID();
const otherRoleUniversalIdentifier = randomUUID();

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
      booleans.map((name) => [name, { type: Boolean, default: true }]),
    ),
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
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [roleSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-role-delete-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [roleSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & {
  id: string;
  universalIdentifier: string;
};

const application = {
  id: applicationId,
  universalIdentifier: applicationUniversalIdentifier,
};

const identity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
});

const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY id');
const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY id');
const agents = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.agent ORDER BY id');
const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const entityMaps = (records: Row[]) => ({
  byUniversalIdentifier: Object.fromEntries(
    records.map((r) => [
      r.universalIdentifier,
      {
        ...r,
        applicationUniversalIdentifier,
        roleUniversalIdentifier:
          r.roleId === defaultRoleId
            ? defaultRoleUniversalIdentifier
            : r.roleId === customRoleId
              ? customRoleUniversalIdentifier
              : otherRoleUniversalIdentifier,
      },
    ]),
  ),
  universalIdentifierById: Object.fromEntries(
    records.map((r) => [r.id, r.universalIdentifier]),
  ),
});

const flatMaps = async () => ({
  flatRoleMaps: entityMaps(await roles()),
  flatRoleTargetMaps: entityMaps(await targets()),
  flatAgentMaps: entityMaps(await agents()),
  flatApplicationMaps: {
    byId: { [applicationId]: application },
    idByUniversalIdentifier: {
      [applicationUniversalIdentifier]: applicationId,
    },
  },
});

const buildRunnerFixture = async (
  options: {
    fail?: boolean;
    deferred?: boolean;
    maps?: Awaited<ReturnType<typeof flatMaps>>;
  } = {},
) => {
  const maps = options.maps ?? (await flatMaps());
  const deleteRoleHandler = new DeleteRoleActionHandlerService();
  const createTargetHandler = new CreateRoleTargetActionHandlerService();
  const deleteTargetHandler = new DeleteRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      if (
        context.action.metadataName === 'role' &&
        context.action.type === 'delete'
      ) {
        const flatAction =
          await deleteRoleHandler.transpileUniversalActionToFlatAction(context);
        await deleteRoleHandler.executeForMetadata({ ...context, flatAction });
      } else if (
        context.action.metadataName === 'roleTarget' &&
        context.action.type === 'delete'
      ) {
        const flatAction =
          await deleteTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await deleteTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else if (
        context.action.metadataName === 'roleTarget' &&
        context.action.type === 'create'
      ) {
        const flatAction =
          await createTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await createTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else {
        throw new Error('Unexpected action in fixture');
      }
      if (options.fail) throw new Error('handler failure');
      return {
        partialOptimisticCache: {},
        metadataEvents: [{ marker: 'event' }],
        deferredActions: options.deferred ? [{}] : [],
      };
    }),
    executeActionRollbackHandler: jest.fn(),
  };
  const cache = {
    getOrRecompute: async () => ({
      flatApplicationMaps: {
        byId: { [applicationId]: application },
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
      },
    }),
    invalidateAndRecompute: jest.fn(async () => {}),
  };
  const logger = {
    perf: jest.fn(),
    perfTime: jest.fn(),
    perfTimeEnd: jest.fn(),
    error: jest.fn(),
  };
  const migration = new WorkspaceMigrationRunnerService(
    { getOrRecomputeManyOrAllFlatEntityMaps: async () => maps } as never,
    runtime,
    registry as never,
    {} as never,
    cache as never,
    { recordHistogram: jest.fn() } as never,
    logger as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    { persist: jest.fn(), dispatchAfterCommit: jest.fn() } as never,
    {} as never,
  );
  return { migration, registry, cache, maps, logger };
};

const buildServicesFixture = (
  runnerOptions: Parameters<typeof buildRunnerFixture>[0] = {},
) => {
  let lastRunner: Awaited<ReturnType<typeof buildRunnerFixture>> | undefined;
  const builder = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async (args) => {
      const roleOps = args.allFlatEntityOperationByMetadataName.role;
      const targetOps = args.allFlatEntityOperationByMetadataName.roleTarget;
      const actions = [
        ...(roleOps?.flatEntityToDelete ?? []).map((row: Row) => ({
          type: 'delete' as const,
          metadataName: 'role' as const,
          universalIdentifier: row.universalIdentifier,
        })),
        ...(targetOps?.flatEntityToDelete ?? []).map((row: Row) => ({
          type: 'delete' as const,
          metadataName: 'roleTarget' as const,
          universalIdentifier: row.universalIdentifier,
        })),
        ...(targetOps?.flatEntityToCreate ?? []).map((row: Row) => ({
          type: 'create' as const,
          metadataName: 'roleTarget' as const,
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
        })),
      ];
      lastRunner = await buildRunnerFixture(runnerOptions);
      await lastRunner.migration.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier,
          actions,
        } as never,
      });
      return { status: 'success' };
    }),
  };

  const roleTargetService = new RoleTargetService(
    { getOrRecomputeManyOrAllFlatEntityMaps: flatMaps } as never,
    builder as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: application,
      }),
    } as never,
  );

  const apiKeyRoleService = new ApiKeyRoleService(
    {
      findOne: async (
        _wsId: string,
        opts: { where: { apiKeyId: string; roleId: string } },
      ) =>
        (await targets()).find(
          (row) =>
            row.apiKeyId === opts.where.apiKeyId &&
            row.roleId === opts.where.roleId,
        ) ?? null,
      find: async (_wsId: string, opts: { where: { roleId: string } }) =>
        (await targets()).filter(
          (row) => row.roleId === opts.where.roleId && row.apiKeyId !== null,
        ),
    } as never,
    {
      findOne: async (_wsId: string, opts: { where: { id: string } }) =>
        (await roles()).find((row) => row.id === opts.where.id) ?? null,
    } as never,
    {
      findOne: async (_wsId: string, opts: { where: { id: string } }) => {
        const [row] = await owner.query(
          'SELECT * FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$2',
          [opts.where.id, workspaceId],
        );
        return row ?? null;
      },
      find: async () =>
        owner.query(
          'SELECT * FROM core."apiKey" WHERE "workspaceId"=$1 AND "revokedAt" IS NULL',
          [workspaceId],
        ),
    } as never,
    {} as never,
    roleTargetService,
  );

  const aiAgentRoleService = new AiAgentRoleService(
    {
      findOne: async (_wsId: string, opts: { where: { id: string } }) => {
        const [row] = await owner.query(
          'SELECT * FROM core.agent WHERE id=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
          [opts.where.id, workspaceId],
        );
        return row ?? null;
      },
    } as never,
    {
      findOne: async (_wsId: string, opts: { where: { id: string } }) =>
        (await roles()).find((row) => row.id === opts.where.id) ?? null,
    } as never,
    {
      findOne: async (
        _wsId: string,
        opts: { where: { agentId: string; roleId?: string } },
      ) =>
        (await targets()).find(
          (row) =>
            row.agentId === opts.where.agentId &&
            (opts.where.roleId === undefined ||
              row.roleId === opts.where.roleId),
        ) ?? null,
    } as never,
    roleTargetService,
    {} as never,
  );

  const roleService = new RoleService(
    builder as never,
    { getOrRecomputeManyOrAllFlatEntityMaps: flatMaps } as never,
    {
      findOne: async () => {
        const [row] = await owner.query(
          'SELECT * FROM core.workspace WHERE id=$1',
          [workspaceId],
        );
        return row ?? null;
      },
    } as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: application,
      }),
    } as never,
    apiKeyRoleService,
  );

  return {
    builder,
    roleService,
    aiAgentRoleService,
    apiKeyRoleService,
    getLastRunner: () => lastRunner,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(
    'ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE',
  );
  await owner.query(
    'CREATE TABLE core.workspace (id uuid PRIMARY KEY,"defaultRoleId" uuid,"databaseSchema" text,"deletedAt" timestamptz)',
  );
  await owner.query(
    'CREATE TABLE core.application (id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz)',
  );
  await owner.query(
    'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY,"workspaceId" uuid,"userId" uuid,"deletedAt" timestamptz)',
  );
  await owner.query(
    'CREATE TABLE core."apiKey" (id uuid PRIMARY KEY,"workspaceId" uuid,"revokedAt" timestamptz)',
  );
  await owner.query(
    'CREATE TABLE core.agent (id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-role-delete-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}";
     GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT INSERT,DELETE ON core.role,core."roleTarget" TO "${databaseRole}";
     GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.corrupt_audit(); TRUNCATE core.workspace,core.application,core."roleTarget",core.role,core."userWorkspace",core."apiKey",core.agent,crm_audit."crmAuditEntry" CASCADE',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"defaultRoleId","databaseSchema","deletedAt") VALUES($1,$2,$3,NULL)',
    [workspaceId, defaultRoleId, 'public'],
  );
  await owner.query('INSERT INTO core.application VALUES($1,$2,$3,NULL)', [
    applicationId,
    workspaceId,
    applicationUniversalIdentifier,
  ]);
  await owner.getRepository(RoleEntity).insert([
    {
      id: defaultRoleId,
      workspaceId,
      universalIdentifier: defaultRoleUniversalIdentifier,
      applicationId,
      label: 'Default Member Role',
      isEditable: true,
    },
    {
      id: customRoleId,
      workspaceId,
      universalIdentifier: customRoleUniversalIdentifier,
      applicationId,
      label: 'Private Custom Support Role',
      description: 'Private role description',
      icon: 'IconShield',
      isEditable: true,
    },
    {
      id: otherRoleId,
      workspaceId,
      universalIdentifier: otherRoleUniversalIdentifier,
      applicationId,
      label: 'Other Custom Role',
      isEditable: true,
    },
  ]);
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

describe('CRM audit role delete and agent/API-key role assignment (LOG156)', () => {
  it('deletes an editable role through RoleService and DeleteRoleTool, rebinding active member/agent/apiKey targets to defaultRoleId and skipping revoked/soft-deleted targets with atomic audit', async () => {
    const memberUserWorkspaceId = randomUUID();
    const activeApiKeyId = randomUUID();
    const revokedApiKeyId = randomUUID();
    const activeAgentId = randomUUID();
    const activeAgentUniversalId = randomUUID();
    const deletedAgentId = randomUUID();
    const deletedAgentUniversalId = randomUUID();

    await owner.query(
      'INSERT INTO core."userWorkspace"(id,"workspaceId","userId","deletedAt") VALUES($1,$2,$3,NULL)',
      [memberUserWorkspaceId, workspaceId, randomUUID()],
    );
    await owner.query(
      'INSERT INTO core."apiKey"(id,"workspaceId","revokedAt") VALUES($1,$2,NULL),($3,$2,now())',
      [activeApiKeyId, workspaceId, revokedApiKeyId],
    );
    await owner.query(
      'INSERT INTO core.agent(id,"workspaceId","universalIdentifier","deletedAt") VALUES($1,$2,$3,NULL),($4,$2,$5,now())',
      [
        activeAgentId,
        workspaceId,
        activeAgentUniversalId,
        deletedAgentId,
        deletedAgentUniversalId,
      ],
    );

    const memberTargetId = randomUUID();
    const activeKeyTargetId = randomUUID();
    const revokedKeyTargetId = randomUUID();
    const activeAgentTargetId = randomUUID();
    const deletedAgentTargetId = randomUUID();

    await owner.getRepository(RoleTargetEntity).insert([
      {
        id: memberTargetId,
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        userWorkspaceId: memberUserWorkspaceId,
      },
      {
        id: activeKeyTargetId,
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        apiKeyId: activeApiKeyId,
      },
      {
        id: revokedKeyTargetId,
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        apiKeyId: revokedApiKeyId,
      },
      {
        id: activeAgentTargetId,
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        agentId: activeAgentId,
      },
      {
        id: deletedAgentTargetId,
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        agentId: deletedAgentId,
      },
    ]);

    const { roleService } = buildServicesFixture();
    const tool = new DeleteRoleTool(roleService);
    const toolAgentId = randomUUID();
    const output = await tool.execute({
      input: { roleId: customRoleId },
      context: {
        workspaceId,
        userWorkspaceId: randomUUID(),
        authContext: identity().auth,
        agentId: toolAgentId,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    } as never);

    expect(output.success).toBe(true);
    expect(
      (await roles()).find((row) => row.id === customRoleId),
    ).toBeUndefined();

    const remainingTargets = await targets();
    expect(remainingTargets).toHaveLength(3);
    expect(remainingTargets.every((row) => row.roleId === defaultRoleId)).toBe(
      true,
    );
    expect(
      remainingTargets
        .map((row) => row.userWorkspaceId ?? row.apiKeyId ?? row.agentId)
        .sort(),
    ).toEqual([memberUserWorkspaceId, activeApiKeyId, activeAgentId].sort());

    const entries = await audits();
    // 5 deleted roleTargets + 3 created roleTargets + 1 deleted role = 9 entries
    expect(entries).toHaveLength(9);
    expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
    expect(entries[0].actor).toEqual({ kind: 'agent', id: toolAgentId });
    expect(entries[0].initiator).toEqual({
      kind: 'workspaceMember',
      id: actorId,
    });

    const roleDeleteEntry = entries.find(
      (entry) => entry.resourceKind === 'role' && entry.action === 'delete',
    )!;
    expect(roleDeleteEntry.resourceId).toBe(customRoleId);
    expect(JSON.stringify(roleDeleteEntry)).not.toContain(
      'Private Custom Support Role',
    );
    expect(JSON.stringify(roleDeleteEntry)).not.toContain(
      'Private role description',
    );
    expect(JSON.stringify(roleDeleteEntry.redactedDiff)).toContain('label');
  });

  it.each([
    'non-editable',
    'admin-standard',
    'default-role',
    'caller-acting-role',
    'caller-db-target',
    'unplanned-target',
    'missing-application',
  ])('rejects role deletion when %s', async (kind) => {
    const callerUserWorkspaceId = randomUUID();
    const { roleService } = buildServicesFixture();

    if (kind === 'non-editable') {
      await owner.query('UPDATE core.role SET "isEditable"=false WHERE id=$1', [
        customRoleId,
      ]);
    }
    if (kind === 'admin-standard') {
      await owner.query(
        'UPDATE core.role SET "universalIdentifier"=$2 WHERE id=$1',
        [customRoleId, STANDARD_ROLE.admin.universalIdentifier],
      );
    }
    if (kind === 'caller-db-target') {
      await owner.getRepository(RoleTargetEntity).insert({
        id: randomUUID(),
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        userWorkspaceId: callerUserWorkspaceId,
      });
    }
    if (kind === 'missing-application') {
      await owner.query('DELETE FROM core.application');
    }

    if (kind === 'unplanned-target') {
      const f = await buildRunnerFixture();
      await owner.getRepository(RoleTargetEntity).insert({
        id: randomUUID(),
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        userWorkspaceId: callerUserWorkspaceId,
      });
      await expect(
        withRoleDeleteAudit(
          { workspaceId, roleId: customRoleId },
          identity(),
          () =>
            f.migration.run({
              workspaceId,
              workspaceMigration: {
                applicationUniversalIdentifier,
                actions: [
                  {
                    type: 'delete',
                    metadataName: 'role',
                    universalIdentifier: customRoleUniversalIdentifier,
                  },
                ],
              } as never,
            }),
        ),
      ).rejects.toThrow('roleTarget set changed');
      expect(await audits()).toEqual([]);
      expect(
        (await roles()).find((row) => row.id === customRoleId),
      ).toBeDefined();
      return;
    }

    await expect(
      roleService.deleteRole({
        roleId: kind === 'default-role' ? defaultRoleId : customRoleId,
        workspaceId,
        actingRoleIds: kind === 'caller-acting-role' ? [customRoleId] : [],
        actingUserWorkspaceId: callerUserWorkspaceId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow();
    expect(await audits()).toEqual([]);
    expect(
      (await roles()).find((row) => row.id === customRoleId),
    ).toBeDefined();
  });

  it.each(['audit', 'handler', 'sql', 'deferred', 'trigger'])(
    'rolls back role delete and roleTarget rebinds on %s failure and preserves commit on lost ACK',
    async (failure) => {
      const userWorkspaceId = randomUUID();
      await owner.query(
        'INSERT INTO core."userWorkspace"(id,"workspaceId","userId","deletedAt") VALUES($1,$2,$3,NULL)',
        [userWorkspaceId, workspaceId, randomUUID()],
      );
      await owner.getRepository(RoleTargetEntity).insert({
        id: randomUUID(),
        workspaceId,
        universalIdentifier: randomUUID(),
        applicationId,
        roleId: customRoleId,
        userWorkspaceId,
      });

      const beforeRoles = await roles();
      const beforeTargets = await targets();
      const { roleService } = buildServicesFixture({
        fail: failure === 'handler',
        deferred: failure === 'deferred',
      });

      if (failure === 'audit') {
        await owner.query(
          `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
        );
      }
      if (failure === 'sql') {
        await owner.query(`REVOKE DELETE ON core.role FROM "${databaseRole}"`);
      }
      if (failure === 'trigger') {
        await owner.query(
          `CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core.application SET "deletedAt"=now(); RETURN NEW; END $$; CREATE TRIGGER corrupt_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()`,
        );
      }

      try {
        await expect(
          roleService.deleteRole({
            roleId: customRoleId,
            workspaceId,
            auditIdentity: identity(),
          }),
        ).rejects.toThrow();
      } finally {
        await owner.query(
          `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"; GRANT DELETE ON core.role TO "${databaseRole}"`,
        );
      }

      expect(await roles()).toEqual(beforeRoles);
      expect(await targets()).toEqual(beforeTargets);
      expect(await audits()).toEqual([]);
    },
  );

  it('preserves committed role deletion and invalidates cache after actual lost COMMIT acknowledgement', async () => {
    const create = runtime.createQueryRunner.bind(runtime);
    const statements: string[] = [];
    const clients = new WeakSet<object>();
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = create(mode);
      const connect = runner.connect.bind(runner);
      jest.spyOn(runner, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!clients.has(client)) {
          clients.add(client);
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            statements.push(sql);
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('lost role delete ACK');
            return result;
          };
        }
        return client;
      });
      return runner;
    });

    const { roleService, getLastRunner } = buildServicesFixture();
    await expect(
      roleService.deleteRole({
        roleId: customRoleId,
        workspaceId,
        auditIdentity: identity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(statements).not.toContain('ROLLBACK');
    expect(
      getLastRunner()?.registry.executeActionRollbackHandler,
    ).not.toHaveBeenCalled();
    expect(getLastRunner()?.cache.invalidateAndRecompute).toHaveBeenCalledTimes(
      1,
    );
    expect(
      (await roles()).find((row) => row.id === customRoleId),
    ).toBeUndefined();
    expect(await audits()).toHaveLength(1);
  });

  it('audits agent role assignment, replacement, same-role no-op, and removal with strict DB checks', async () => {
    const agentId = randomUUID();
    const agentUniversalId = randomUUID();
    await owner.query(
      'INSERT INTO core.agent(id,"workspaceId","universalIdentifier","deletedAt") VALUES($1,$2,$3,NULL)',
      [agentId, workspaceId, agentUniversalId],
    );

    const { aiAgentRoleService, builder } = buildServicesFixture();

    // 1. Explicit undefined auditIdentity is rejected before any DB write
    await expect(
      aiAgentRoleService.assignRoleToAgent({
        workspaceId,
        agentId,
        roleId: customRoleId,
        auditIdentity: undefined,
      }),
    ).rejects.toThrow('authenticated audit identity');
    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();

    // 2. Initial agent role assignment creates 1 roleTarget and 1 audit entry
    await aiAgentRoleService.assignRoleToAgent({
      workspaceId,
      agentId,
      roleId: customRoleId,
      auditIdentity: identity(),
    });
    const firstTargets = await targets();
    expect(firstTargets).toHaveLength(1);
    expect(firstTargets[0]).toMatchObject({
      agentId,
      roleId: customRoleId,
      userWorkspaceId: null,
      apiKeyId: null,
    });
    let entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      resourceId: firstTargets[0].id,
      redactedDiff: {
        changedFields: ['agentId', 'roleId'],
        values: {
          agentId: { before: null, after: agentId },
          roleId: { before: null, after: customRoleId },
        },
      },
    });

    // 3. Same-role assignment is a confirmed no-op without extra audit entries
    await aiAgentRoleService.assignRoleToAgent({
      workspaceId,
      agentId,
      roleId: customRoleId,
      auditIdentity: identity(),
    });
    expect(await audits()).toHaveLength(1);

    // 4. Replacing agent role records atomic delete + create with one operationId
    await aiAgentRoleService.assignRoleToAgent({
      workspaceId,
      agentId,
      roleId: otherRoleId,
      auditIdentity: identity(),
    });
    const replacedTargets = await targets();
    expect(replacedTargets).toHaveLength(1);
    expect(replacedTargets[0].roleId).toBe(otherRoleId);
    entries = await audits();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.slice(1).map((e) => e.operationId)).size).toBe(1);

    // 5. Removing agent role deletes roleTarget and records atomic delete audit entry
    await aiAgentRoleService.removeRoleFromAgent({
      workspaceId,
      agentId,
      auditIdentity: identity(),
    });
    expect(await targets()).toEqual([]);
    entries = await audits();
    expect(entries).toHaveLength(4);
    expect(entries[3]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
      resourceId: replacedTargets[0].id,
      redactedDiff: {
        changedFields: ['agentId', 'roleId'],
        values: {
          agentId: { before: agentId, after: null },
          roleId: { before: otherRoleId, after: null },
        },
      },
    });

    // 6. Non-assignable role or soft-deleted agent is rejected inside runner transaction
    await owner.query(
      'UPDATE core.role SET "canBeAssignedToAgents"=false WHERE id=$1',
      [customRoleId],
    );
    const f = await buildRunnerFixture();
    const now = new Date().toISOString();
    await expect(
      withAgentRoleAssignmentAudit(
        { workspaceId, agentId, roleId: customRoleId },
        identity(),
        () =>
          f.migration.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier,
              actions: [
                {
                  type: 'create',
                  metadataName: 'roleTarget',
                  id: randomUUID(),
                  flatEntity: {
                    universalIdentifier: randomUUID(),
                    roleUniversalIdentifier: customRoleUniversalIdentifier,
                    userWorkspaceId: null,
                    agentUniversalIdentifier: agentUniversalId,
                    apiKeyId: null,
                    applicationUniversalIdentifier,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow('not assignable');

    await owner.getRepository(RoleTargetEntity).insert(replacedTargets[0]);
    const f2 = await buildRunnerFixture();
    await owner.query('UPDATE core.agent SET "deletedAt"=now() WHERE id=$1', [
      agentId,
    ]);
    await expect(
      withAgentRoleRemovalAudit(
        { workspaceId, agentId, roleTargetId: replacedTargets[0].id },
        identity(),
        () =>
          f2.migration.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier,
              actions: [
                {
                  type: 'delete',
                  metadataName: 'roleTarget',
                  universalIdentifier: replacedTargets[0].universalIdentifier,
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow('agent unavailable');
  });

  it('audits API-key role assignment, replacement, same-role no-op, and rejects revoked API key or non-assignable role', async () => {
    const apiKeyId = randomUUID();
    await owner.query(
      'INSERT INTO core."apiKey"(id,"workspaceId","revokedAt") VALUES($1,$2,NULL)',
      [apiKeyId, workspaceId],
    );

    const { apiKeyRoleService } = buildServicesFixture();

    // 1. Initial API-key role assignment
    await apiKeyRoleService.assignRoleToApiKey({
      workspaceId,
      apiKeyId,
      roleId: customRoleId,
      auditIdentity: identity(),
    });
    const firstTargets = await targets();
    expect(firstTargets).toHaveLength(1);
    expect(firstTargets[0]).toMatchObject({
      apiKeyId,
      roleId: customRoleId,
      userWorkspaceId: null,
      agentId: null,
    });
    let entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      resourceId: firstTargets[0].id,
      redactedDiff: {
        changedFields: ['apiKeyId', 'roleId'],
        values: {
          apiKeyId: { before: null, after: apiKeyId },
          roleId: { before: null, after: customRoleId },
        },
      },
    });

    // 2. Same-role no-op
    await apiKeyRoleService.assignRoleToApiKey({
      workspaceId,
      apiKeyId,
      roleId: customRoleId,
      auditIdentity: identity(),
    });
    expect(await audits()).toHaveLength(1);

    // 3. Replacement API-key role assignment
    await apiKeyRoleService.assignRoleToApiKey({
      workspaceId,
      apiKeyId,
      roleId: otherRoleId,
      auditIdentity: identity(),
    });
    const replacedTargets = await targets();
    expect(replacedTargets).toHaveLength(1);
    expect(replacedTargets[0].roleId).toBe(otherRoleId);
    entries = await audits();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.slice(1).map((e) => e.operationId)).size).toBe(1);

    // 4. Revoked API key is rejected under DB lock
    await owner.query(
      'UPDATE core."apiKey" SET "revokedAt"=now() WHERE id=$1',
      [apiKeyId],
    );
    const f = await buildRunnerFixture();
    const now = new Date().toISOString();
    await expect(
      withApiKeyRoleAssignmentAudit(
        { workspaceId, apiKeyId, roleId: customRoleId },
        identity(),
        () =>
          f.migration.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier,
              actions: [
                {
                  type: 'delete',
                  metadataName: 'roleTarget',
                  universalIdentifier: replacedTargets[0].universalIdentifier,
                },
                {
                  type: 'create',
                  metadataName: 'roleTarget',
                  id: randomUUID(),
                  flatEntity: {
                    universalIdentifier: randomUUID(),
                    roleUniversalIdentifier: customRoleUniversalIdentifier,
                    userWorkspaceId: null,
                    agentUniversalIdentifier: null,
                    apiKeyId,
                    applicationUniversalIdentifier,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow('API key changed or unavailable');
    expect(await targets()).toEqual(replacedTargets);
    expect(await audits()).toHaveLength(3);
  });
});
