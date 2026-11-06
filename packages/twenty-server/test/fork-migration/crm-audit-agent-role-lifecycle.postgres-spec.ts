import { randomUUID } from 'node:crypto';
import { MEMBER_ROLE_UNIVERSAL_IDENTIFIER } from 'twenty-shared/constants';
import { WorkflowActionType } from 'twenty-shared/workflow';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER } from 'src/engine/core-modules/application/constants/workspace-custom-application-role.constant';
import {
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({
  ToolCategory: { ROLE: 'ROLE' },
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
}));
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
    'core-modules/record-crud/services/find-records.service',
    'FindRecordsService',
  ],
  [
    'core-modules/workflow/services/workflow-version-core-sync.service',
    'WorkflowVersionCoreSyncService',
  ],
  ['metadata-modules/ai/ai-agent/agent.service', 'AgentService'],
  [
    'metadata-modules/logic-function/services/logic-function-from-source.service',
    'LogicFunctionFromSourceService',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  [
    'workflow/common/workspace-services/workflow-common.workspace-service',
    'WorkflowCommonWorkspaceService',
  ],
  [
    'workflow/workflow-builder/workflow-version-step/code-step/services/code-step-build.service',
    'CodeStepBuildService',
  ],
])
  jest.doMock('src/modules/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  ['metadata-modules/ai/ai-agent/entities/agent.entity', 'AgentEntity'],
  [
    'metadata-modules/object-metadata/object-metadata.entity',
    'ObjectMetadataEntity',
  ],
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
          flatEntities: Record<string, unknown>[];
        }) {
          if (flatEntities.length === 0) return;
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
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { AiAgentRoleService } =
  require('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service') as typeof import('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service');
const { WorkflowVersionStepOperationsWorkspaceService } =
  require('src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service') as typeof import('src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `agent_role_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const actorId = randomUUID();
const agent1Id = randomUUID();
const agent1UniversalId = randomUUID();
const agent2Id = randomUUID();
const agent2UniversalId = randomUUID();
const agentOnlyRoleId = randomUUID();
const agentOnlyRoleUniversalId = randomUUID();
const sharedRoleId = randomUUID();
const sharedRoleUniversalId = randomUUID();

const application = {
  id: applicationId,
  universalIdentifier: applicationUniversalIdentifier,
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
    { columns: ['workspaceId', 'agentId'] },
    { columns: ['workspaceId', 'universalIdentifier'] },
  ],
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [roleSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-agent-role-fixture';
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

const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY "createdAt",id');
const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY "createdAt",id');
const agents = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.agent ORDER BY id');
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
  systemActorId = 'workflow-version-step:delete-agent-step',
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
  flatAgentMaps: entityMaps(await agents()),
  flatApplicationMaps: {
    byId: { [applicationId]: application },
    idByUniversalIdentifier: {
      [applicationUniversalIdentifier]: applicationId,
    },
  },
});

const buildHarness = (
  options: { beforeCountReturn?: () => Promise<void> } = {},
) => {
  const createTargetHandler = new CreateRoleTargetActionHandlerService();
  const deleteTargetHandler = new DeleteRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      if (context.action.type === 'create') {
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
        byId: { [applicationId]: application },
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
      },
      flatRoleTargetByAgentIdMaps: Object.fromEntries(
        (await targets())
          .filter((r) => r.agentId !== null)
          .map((r) => [r.agentId, r]),
      ),
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
      const targetOps = args.allFlatEntityOperationByMetadataName.roleTarget;
      const actions = [
        ...targetOps.flatEntityToDelete.map((row: Row) => ({
          type: 'delete',
          metadataName: 'roleTarget',
          universalIdentifier: row.universalIdentifier,
        })),
        ...targetOps.flatEntityToCreate.map((row: Row) => ({
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
        })),
      ];
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

  const roleTargetService = new RoleTargetService(
    flatEntityMapsCache as never,
    builder as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: application,
      }),
    } as never,
  );

  const agentRepository = {
    findOne: jest.fn(async (_wsId: string, opts: { where: { id: string } }) => {
      const [row] = await owner.query(
        'SELECT * FROM core.agent WHERE id=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
        [opts.where.id, workspaceId],
      );
      return row ?? null;
    }),
  };

  const roleRepository = {
    findOne: jest.fn(async (_wsId: string, opts: { where: { id: string } }) => {
      const [row] = await owner.query(
        'SELECT * FROM core.role WHERE id=$1 AND "workspaceId"=$2',
        [opts.where.id, workspaceId],
      );
      return row ?? null;
    }),
  };

  const roleTargetRepository = {
    findOne: jest.fn(
      async (
        _wsId: string,
        opts: { where: { agentId: string; roleId?: string } },
      ) =>
        (await targets()).find(
          (row) =>
            row.agentId === opts.where.agentId &&
            (opts.where.roleId === undefined ||
              row.roleId === opts.where.roleId),
        ) ?? null,
    ),
    count: jest.fn(
      async (
        _wsId: string,
        opts: { where: { roleId: string; id: { _value: string } } },
      ) => {
        const excludedId = opts.where.id._value;
        const count = (await targets()).filter(
          (row) => row.roleId === opts.where.roleId && row.id !== excludedId,
        ).length;
        if (options.beforeCountReturn) {
          await options.beforeCountReturn();
        }
        return count;
      },
    ),
  };

  const aiAgentRoleService = new AiAgentRoleService(
    agentRepository as never,
    roleRepository as never,
    roleTargetRepository as never,
    roleTargetService,
    cache as never,
    runtime,
  );

  return {
    aiAgentRoleService,
    roleTargetService,
    agentRepository,
    roleRepository,
    roleTargetRepository,
    cache,
    builder,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"defaultRoleId" uuid,"deletedAt" timestamptz); CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz); CREATE TABLE core.agent(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz); ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE; ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("agentId") REFERENCES core.agent(id) ON DELETE CASCADE',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"databaseSchema","defaultRoleId") VALUES($1,$2,NULL)',
    [workspaceId, 'synthetic_members'],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-agent-role-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core TO "${databaseRole}"; GRANT INSERT,DELETE ON core.role,core."roleTarget" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    'TRUNCATE core.application,core."roleTarget",core.role,core.agent,crm_audit."crmAuditEntry"',
  );
  await owner.query(
    'UPDATE core.workspace SET "defaultRoleId"=NULL,"deletedAt"=NULL',
  );
  await owner.query('INSERT INTO core.application VALUES($1,$2,$3,NULL)', [
    applicationId,
    workspaceId,
    applicationUniversalIdentifier,
  ]);
  await owner.query(
    'INSERT INTO core.agent VALUES($1,$2,$3,NULL),($4,$2,$5,NULL)',
    [agent1Id, workspaceId, agent1UniversalId, agent2Id, agent2UniversalId],
  );
  await owner.getRepository(RoleEntity).insert([
    {
      id: agentOnlyRoleId,
      workspaceId,
      universalIdentifier: agentOnlyRoleUniversalId,
      applicationId,
      label: 'Workflow Agent Role',
      description: 'Dedicated agent role',
      icon: 'IconRobot',
      isEditable: true,
      canUpdateAllSettings: false,
      canAccessAllTools: true,
      canAccessAllAgentChatChannels: false,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: false,
      canSoftDeleteAllObjectRecords: false,
      canDestroyAllObjectRecords: false,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: false,
    },
    {
      id: sharedRoleId,
      workspaceId,
      universalIdentifier: sharedRoleUniversalId,
      applicationId,
      label: 'Shared User & Agent Role',
      description: 'Shared role',
      icon: 'IconUsers',
      isEditable: true,
      canUpdateAllSettings: false,
      canAccessAllTools: true,
      canAccessAllAgentChatChannels: false,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: false,
      canSoftDeleteAllObjectRecords: false,
      canDestroyAllObjectRecords: false,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: false,
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

describe('LOG161 audited unused agent-only role deletion and workflow agent-step role operations', () => {
  it('deletes an unused agent-only role and records an atomic role delete audit entry', async () => {
    const { aiAgentRoleService, cache } = buildHarness();
    const roleTargetId = randomUUID();

    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      workspaceId,
      roleId: agentOnlyRoleId,
      roleTargetId,
      auditIdentity: systemIdentity('workflow-version-step:delete-agent-step'),
    });

    expect(
      (await roles()).find((r) => r.id === agentOnlyRoleId),
    ).toBeUndefined();
    expect(cache.invalidateAndRecompute).toHaveBeenCalledWith(workspaceId, [
      'flatRoleMaps',
      'flatRolePermissionFlagMaps',
      'rolesPermissions',
    ]);

    const auditRows = await audits();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'role',
      resourceId: agentOnlyRoleId,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workflow-version-step:delete-agent-step',
      },
      securityDescriptor: {
        resourceKind: 'role',
        resourceId: agentOnlyRoleId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(JSON.stringify(auditRows)).not.toContain('Workflow Agent Role');
  });

  it('explicitly deletes and audits a residual agent roleTargetId before deleting the role in one operation', async () => {
    const { aiAgentRoleService } = buildHarness();
    const roleTargetId = randomUUID();
    await owner.getRepository(RoleTargetEntity).insert({
      id: roleTargetId,
      workspaceId,
      applicationId,
      universalIdentifier: randomUUID(),
      roleId: agentOnlyRoleId,
      agentId: agent1Id,
      userWorkspaceId: null,
      apiKeyId: null,
    });

    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      workspaceId,
      roleId: agentOnlyRoleId,
      roleTargetId,
      auditIdentity: systemIdentity('workflow-version-step:delete-agent-step'),
    });

    expect(
      (await roles()).find((r) => r.id === agentOnlyRoleId),
    ).toBeUndefined();
    expect(await targets()).toEqual([]);

    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(new Set(auditRows.map((r) => r.operationId)).size).toBe(1);
    expect(
      auditRows.map((r) => `${r.resourceKind}:${r.action}`).sort(),
    ).toEqual(['role:delete', 'roleTarget:delete']);
    const targetDelete = auditRows.find(
      (r) => r.resourceKind === 'roleTarget',
    )!;
    expect(targetDelete).toMatchObject({
      resourceId: roleTargetId,
      action: 'delete',
      redactedDiff: {
        changedFields: ['agentId', 'roleId'],
        values: {
          agentId: { before: agent1Id, after: null },
          roleId: { before: agentOnlyRoleId, after: null },
        },
      },
    });
  });

  it('preserves shared, standard, non-editable, or default roles as a safe no-op without audit entries', async () => {
    const { aiAgentRoleService, cache } = buildHarness();
    const roleTargetId = randomUUID();

    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      workspaceId,
      roleId: sharedRoleId,
      roleTargetId,
      auditIdentity: systemIdentity(),
    });
    expect((await roles()).find((r) => r.id === sharedRoleId)).toBeDefined();

    for (const specialRole of [
      {
        id: randomUUID(),
        universalIdentifier: MEMBER_ROLE_UNIVERSAL_IDENTIFIER,
        isEditable: true,
      },
      {
        id: randomUUID(),
        universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
        isEditable: true,
      },
      {
        id: randomUUID(),
        universalIdentifier:
          WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
        isEditable: false,
      },
    ]) {
      await owner.getRepository(RoleEntity).insert({
        id: specialRole.id,
        workspaceId,
        universalIdentifier: specialRole.universalIdentifier,
        applicationId,
        label: 'Protected Role',
        description: null,
        icon: null,
        isEditable: specialRole.isEditable,
        canBeAssignedToUsers: false,
        canBeAssignedToAgents: true,
        canBeAssignedToApiKeys: false,
      });

      await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
        workspaceId,
        roleId: specialRole.id,
        roleTargetId,
        auditIdentity: systemIdentity(),
      });
      expect(
        (await roles()).find((r) => r.id === specialRole.id),
      ).toBeDefined();
    }

    await owner.query(
      'UPDATE core.workspace SET "defaultRoleId"=$1 WHERE id=$2',
      [agentOnlyRoleId, workspaceId],
    );
    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      workspaceId,
      roleId: agentOnlyRoleId,
      roleTargetId,
      auditIdentity: systemIdentity(),
    });
    expect((await roles()).find((r) => r.id === agentOnlyRoleId)).toBeDefined();
    expect(cache.invalidateAndRecompute).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('aborts deletion under lock if another agent is concurrently assigned to the role after pre-check', async () => {
    const roleTargetId = randomUUID();
    const concurrentTargetId = randomUUID();
    const { aiAgentRoleService, cache } = buildHarness({
      beforeCountReturn: async () => {
        await owner.getRepository(RoleTargetEntity).insert({
          id: concurrentTargetId,
          workspaceId,
          applicationId,
          universalIdentifier: randomUUID(),
          roleId: agentOnlyRoleId,
          agentId: agent2Id,
          userWorkspaceId: null,
          apiKeyId: null,
        });
      },
    });

    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      workspaceId,
      roleId: agentOnlyRoleId,
      roleTargetId,
      auditIdentity: systemIdentity(),
    });

    expect((await roles()).find((r) => r.id === agentOnlyRoleId)).toBeDefined();
    expect(
      (await targets()).find((t) => t.id === concurrentTargetId),
    ).toBeDefined();
    expect(cache.invalidateAndRecompute).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('rejects missing, invalid, or nested auditIdentity before the first await in assignRoleToAgent and deleteAgentOnlyRoleIfUnused', async () => {
    const { aiAgentRoleService, agentRepository, roleRepository } =
      buildHarness();
    const roleTargetId = randomUUID();

    await expect(
      aiAgentRoleService.assignRoleToAgent({
        workspaceId,
        agentId: agent1Id,
        roleId: agentOnlyRoleId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    expect(agentRepository.findOne).not.toHaveBeenCalled();

    await expect(
      aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
        workspaceId,
        roleId: agentOnlyRoleId,
        roleTargetId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    expect(roleRepository.findOne).not.toHaveBeenCalled();

    await expect(
      withRoleUpdateAudit(workspaceId, agentOnlyRoleId, userIdentity(), () =>
        aiAgentRoleService.assignRoleToAgent({
          workspaceId,
          agentId: agent1Id,
          roleId: agentOnlyRoleId,
          auditIdentity: userIdentity(),
        }),
      ),
    ).rejects.toThrow('Nested role assignment audit unsupported');

    await expect(
      withRoleUpdateAudit(workspaceId, agentOnlyRoleId, userIdentity(), () =>
        aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
          workspaceId,
          roleId: agentOnlyRoleId,
          roleTargetId,
          auditIdentity: systemIdentity(),
        }),
      ),
    ).rejects.toThrow('Nested role audit is unsupported');

    expect(await audits()).toEqual([]);
  });

  it('captures input and auditIdentity synchronously before the first await in assignRoleToAgent and deleteAgentOnlyRoleIfUnused', async () => {
    const { aiAgentRoleService } = buildHarness();
    const assignInput = {
      workspaceId,
      agentId: agent1Id,
      roleId: agentOnlyRoleId,
      auditIdentity: userIdentity(),
    };
    const pendingAssign = aiAgentRoleService.assignRoleToAgent(assignInput);
    assignInput.agentId = randomUUID();
    assignInput.roleId = randomUUID();
    (
      assignInput.auditIdentity.auth as { workspaceMemberId: string }
    ).workspaceMemberId = randomUUID();
    await pendingAssign;

    const assignedTarget = (await targets())[0];
    expect(assignedTarget).toMatchObject({
      agentId: agent1Id,
      roleId: agentOnlyRoleId,
    });

    await owner.query('DELETE FROM core."roleTarget" WHERE id=$1', [
      assignedTarget.id,
    ]);
    const deleteInput = {
      workspaceId,
      roleId: agentOnlyRoleId,
      roleTargetId: assignedTarget.id,
      auditIdentity: systemIdentity('workflow-version-step:delete-agent-step'),
    };
    const pendingDelete =
      aiAgentRoleService.deleteAgentOnlyRoleIfUnused(deleteInput);
    deleteInput.roleId = randomUUID();
    deleteInput.roleTargetId = randomUUID();
    deleteInput.auditIdentity.systemActorId = 'tampered-actor';
    await pendingDelete;

    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0].actor).toEqual({
      kind: 'workspaceMember',
      id: actorId,
    });
    expect(auditRows[1].actor).toEqual({
      kind: 'system',
      id: 'workflow-version-step:delete-agent-step',
    });
  });

  it('suppresses rollback and invalidates cache on NativeTransactionOutcomeUnknownError after commit', async () => {
    const { aiAgentRoleService, cache } = buildHarness();
    const statements: string[] = [];
    const clients = new WeakSet<object>();
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const connect = runner.connect.bind(runner);
      jest.spyOn(runner, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!clients.has(client)) {
          clients.add(client);
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            statements.push(sql);
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('commit ack lost');
            return result;
          };
        }
        return client;
      });
      return runner;
    });

    await expect(
      aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
        workspaceId,
        roleId: agentOnlyRoleId,
        roleTargetId: randomUUID(),
        auditIdentity: systemIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).not.toContain('ROLLBACK');
    expect(cache.invalidateAndRecompute).toHaveBeenCalledWith(workspaceId, [
      'flatRoleMaps',
      'flatRolePermissionFlagMaps',
      'rolesPermissions',
    ]);
    expect(
      (await roles()).find((r) => r.id === agentOnlyRoleId),
    ).toBeUndefined();
    expect(await audits()).toHaveLength(1);
  });

  it('audits WorkflowVersionStepOperationsWorkspaceService createDraftStep and runWorkflowVersionStepDeletionSideEffects end-to-end', async () => {
    const { aiAgentRoleService, roleTargetRepository } = buildHarness();
    const initialTargetId = randomUUID();
    await owner.getRepository(RoleTargetEntity).insert({
      id: initialTargetId,
      workspaceId,
      applicationId,
      universalIdentifier: randomUUID(),
      roleId: agentOnlyRoleId,
      agentId: agent1Id,
      userWorkspaceId: null,
      apiKeyId: null,
    });

    const agentService = {
      deleteManyAgents: jest.fn(async ({ ids }: { ids: string[] }) => {
        await owner.query(
          'DELETE FROM core."roleTarget" WHERE "agentId"=ANY($1::uuid[])',
          [ids],
        );
      }),
    };

    const stepOpsService = new WorkflowVersionStepOperationsWorkspaceService(
      {} as never,
      {} as never,
      {} as never,
      agentService as never,
      roleTargetRepository as never,
      {} as never,
      {} as never,
      aiAgentRoleService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(
        stepOpsService as unknown as {
          duplicateAgent: () => Promise<{ id: string }>;
        },
        'duplicateAgent',
      )
      .mockResolvedValue({ id: agent2Id });

    const draftStep = await stepOpsService.createDraftStep({
      workspaceId,
      step: {
        id: randomUUID(),
        name: 'AI Agent Step',
        type: WorkflowActionType.AI_AGENT,
        valid: true,
        nextStepIds: [],
        settings: {
          input: { agentId: agent1Id, prompt: 'test' },
          outputSchema: {},
          errorHandlingOptions: {
            continueOnFailure: { value: false },
            retryOnFailure: { value: 0 },
          },
        },
      } as never,
    });
    expect(draftStep.settings.input).toMatchObject({ agentId: agent2Id });

    await owner.query('DELETE FROM core."roleTarget" WHERE "agentId"=$1', [
      agent2Id,
    ]);

    await stepOpsService.runWorkflowVersionStepDeletionSideEffects({
      workspaceId,
      step: {
        id: randomUUID(),
        name: 'AI Agent Step',
        type: WorkflowActionType.AI_AGENT,
        valid: true,
        nextStepIds: [],
        settings: {
          input: { agentId: agent1Id, prompt: 'test' },
          outputSchema: {},
          errorHandlingOptions: {
            continueOnFailure: { value: false },
            retryOnFailure: { value: 0 },
          },
        },
      } as never,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      actor: {
        kind: 'system',
        id: 'workflow-version-step:clone-agent-step',
      },
    });
    expect(auditRows[1]).toMatchObject({
      resourceKind: 'role',
      resourceId: agentOnlyRoleId,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workflow-version-step:delete-agent-step',
      },
    });
  });
});
