import { randomUUID } from 'node:crypto';
import { type Request } from 'express';
import { WorkflowActionType } from 'twenty-shared/workflow';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { compareTwoFlatEntity } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/utils/compare-two-universal-flat-entity.util';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({
  ToolCategory: { AGENT: 'AGENT', ROLE: 'ROLE' },
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
  [
    'metadata-modules/logic-function/services/logic-function-from-source.service',
    'LogicFunctionFromSourceService',
  ],
  [
    'metadata-modules/ai/ai-models/services/ai-model-registry.service',
    'AiModelRegistryService',
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
    WorkspaceMigrationRunnerActionHandler: (
      _actionType: string,
      metadataName: 'agent' | 'roleTarget',
    ) =>
      class {
        async insertFlatEntitiesInRepository({
          queryRunner,
          flatEntities,
        }: {
          queryRunner: QueryRunner;
          flatEntities: Record<string, unknown>[];
        }) {
          if (flatEntities.length === 0) return;
          const targetEntity =
            metadataName === 'agent' ? AgentEntity : RoleTargetEntity;
          await queryRunner.manager.getRepository(targetEntity).insert(
            flatEntities.map((flatEntity) =>
              flatEntityToScalarFlatEntity({
                metadataName,
                flatEntity: flatEntity as never,
              }),
            ),
          );
        }
        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: { universalIdentifier: string };
          allFlatEntityMaps: {
            flatAgentMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
            flatRoleTargetMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
          };
        }) {
          const maps =
            metadataName === 'agent'
              ? context.allFlatEntityMaps.flatAgentMaps
              : context.allFlatEntityMaps.flatRoleTargetMaps;
          return {
            ...context.action,
            entityId:
              maps.byUniversalIdentifier[context.action.universalIdentifier].id,
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
  AgentEntity,
} = require('src/engine/metadata-modules/ai/ai-agent/entities/agent.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateAgentActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/create-agent-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/create-agent-action-handler.service');
const { UpdateAgentActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/update-agent-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/update-agent-action-handler.service');
const { DeleteAgentActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/delete-agent-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/agent/services/delete-agent-action-handler.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { AgentService } =
  require('src/engine/metadata-modules/ai/ai-agent/agent.service') as typeof import('src/engine/metadata-modules/ai/ai-agent/agent.service');
const { AgentResolver } =
  require('src/engine/metadata-modules/ai/ai-agent/agent.resolver') as typeof import('src/engine/metadata-modules/ai/ai-agent/agent.resolver');
const { CreateAgentTool } =
  require('src/engine/metadata-modules/ai/ai-agent/tools/create-agent.tool') as typeof import('src/engine/metadata-modules/ai/ai-agent/tools/create-agent.tool');
const { UpdateAgentTool } =
  require('src/engine/metadata-modules/ai/ai-agent/tools/update-agent.tool') as typeof import('src/engine/metadata-modules/ai/ai-agent/tools/update-agent.tool');
const { DeleteAgentTool } =
  require('src/engine/metadata-modules/ai/ai-agent/tools/delete-agent.tool') as typeof import('src/engine/metadata-modules/ai/ai-agent/tools/delete-agent.tool');
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

const databaseRole = `agent_svc_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const actorId = randomUUID();
const callingAgentId = randomUUID();
const agentRole1Id = randomUUID();
const agentRole1UniversalId = randomUUID();
const agentRole2Id = randomUUID();
const agentRole2UniversalId = randomUUID();
const userOnlyRoleId = randomUUID();
const userOnlyRoleUniversalId = randomUUID();

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

const agentSchema = new EntitySchema({
  name: 'AgentEntity',
  target: AgentEntity,
  tableName: 'agent',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    name: { type: 'text' },
    label: { type: 'text' },
    icon: { type: 'text', nullable: true },
    description: { type: 'text', nullable: true },
    prompt: { type: 'text' },
    modelId: { type: 'text', default: 'auto' },
    responseFormat: { type: 'jsonb', nullable: true },
    modelConfiguration: { type: 'jsonb', nullable: true },
    isCustom: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    triggers: { type: 'jsonb', default: [] },
    evaluationInputs: { type: 'text', array: true, default: '{}' },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true },
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
  entities: [roleSchema, agentSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-agent-service-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [roleSchema, agentSchema, targetSchema],
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
const agents = async (): Promise<Row[]> => {
  const rows: Row[] = await owner.query(
    'SELECT g.*,a."universalIdentifier" AS "applicationUniversalIdentifier" FROM core.agent g JOIN core.application a ON a.id=g."applicationId" ORDER BY g."createdAt",g.id',
  );
  return rows.map((row) => ({
    ...row,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
    deletedAt:
      row.deletedAt instanceof Date
        ? row.deletedAt.toISOString()
        : (row.deletedAt ?? null),
  }));
};
// Entries of one transaction share "createdAt"; deletes are recorded before creates.
const audits = (): Promise<Row[]> =>
  owner.query(
    `SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",CASE action WHEN 'delete' THEN 0 ELSE 1 END,id`,
  );

const userIdentity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
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

const flatMaps = async () => {
  const roleRows = await roles();
  const agentRows = await agents();
  const roleById = new Map(roleRows.map((r) => [r.id, r]));
  const agentById = new Map(agentRows.map((r) => [r.id, r]));
  const targetRows = (await targets()).map((row) => ({
    ...row,
    applicationUniversalIdentifier,
    roleUniversalIdentifier:
      roleById.get(String(row.roleId))?.universalIdentifier ?? null,
    agentUniversalIdentifier:
      row.agentId !== null
        ? (agentById.get(String(row.agentId))?.universalIdentifier ?? null)
        : null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  }));
  return {
    flatRoleMaps: entityMaps(roleRows),
    flatRoleTargetMaps: entityMaps(targetRows),
    flatAgentMaps: entityMaps(agentRows),
    flatApplicationMaps: {
      byId: { [applicationId]: application },
      idByUniversalIdentifier: {
        [applicationUniversalIdentifier]: applicationId,
      },
    },
  };
};

const buildHarness = (
  options: { beforeRunnerRun?: () => Promise<void> } = {},
) => {
  const createAgentHandler = new CreateAgentActionHandlerService();
  const updateAgentHandler = new UpdateAgentActionHandlerService();
  const deleteAgentHandler = new DeleteAgentActionHandlerService();
  const createTargetHandler = new CreateRoleTargetActionHandlerService();
  const deleteTargetHandler = new DeleteRoleTargetActionHandlerService();

  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      const { metadataName, type } = context.action;
      if (metadataName === 'agent' && type === 'create') {
        const flatAction =
          await createAgentHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await createAgentHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else if (metadataName === 'agent' && type === 'update') {
        const flatAction =
          await updateAgentHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await updateAgentHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else if (metadataName === 'agent' && type === 'delete') {
        const flatAction =
          await deleteAgentHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await deleteAgentHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else if (metadataName === 'roleTarget' && type === 'create') {
        const flatAction =
          await createTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await createTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else if (metadataName === 'roleTarget' && type === 'delete') {
        const flatAction =
          await deleteTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await deleteTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
      } else {
        throw new Error(`Unsupported action ${metadataName}:${type}`);
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
    getOrRecompute: jest.fn(async () => {
      const currentFlatMaps = await flatMaps();
      return {
        ...currentFlatMaps,
        flatRoleTargetByAgentIdMaps: Object.fromEntries(
          Object.values(
            currentFlatMaps.flatRoleTargetMaps.byUniversalIdentifier,
          )
            .filter((r) => r.agentId !== null)
            .map((r) => [r.agentId, r]),
        ),
      };
    }),
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
      const currentFlatMaps = await flatMaps();
      const agentOps = args.allFlatEntityOperationByMetadataName.agent ?? {
        flatEntityToCreate: [],
        flatEntityToDelete: [],
        flatEntityToUpdate: [],
      };
      const targetOps = args.allFlatEntityOperationByMetadataName
        .roleTarget ?? {
        flatEntityToCreate: [],
        flatEntityToDelete: [],
        flatEntityToUpdate: [],
      };

      const agentUpdateActions = (agentOps.flatEntityToUpdate as Row[])
        .map((toEntity) => {
          const fromEntity =
            currentFlatMaps.flatAgentMaps.byUniversalIdentifier[
              toEntity.universalIdentifier
            ];
          const diff = compareTwoFlatEntity({
            metadataName: 'agent',
            fromUniversalFlatEntity: fromEntity as never,
            toUniversalFlatEntity: toEntity as never,
          });
          if (!diff || Object.keys(diff).length === 0) return null;
          return {
            type: 'update',
            metadataName: 'agent',
            universalIdentifier: toEntity.universalIdentifier,
            update: diff,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      const actions = [
        ...(targetOps.flatEntityToDelete as Row[]).map((row) => ({
          type: 'delete',
          metadataName: 'roleTarget',
          universalIdentifier: row.universalIdentifier,
        })),
        ...(agentOps.flatEntityToDelete as Row[]).map((row) => ({
          type: 'delete',
          metadataName: 'agent',
          universalIdentifier: row.universalIdentifier,
        })),
        ...agentUpdateActions,
        ...(agentOps.flatEntityToCreate as Row[]).map((row) => ({
          type: 'create',
          metadataName: 'agent',
          id: row.id,
          flatEntity: Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => !['id', 'workspaceId', 'applicationId'].includes(key),
            ),
          ),
        })),
        ...(targetOps.flatEntityToCreate as Row[]).map((row) => ({
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

      if (options.beforeRunnerRun) {
        await options.beforeRunnerRun();
      }

      if (actions.length > 0) {
        await runner.run({
          workspaceId: args.workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: args.applicationUniversalIdentifier,
            actions,
          } as never,
        });
      }
      return { status: 'success' };
    }),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
      workspaceCustomFlatApplication: application,
    }),
  };

  const agentService = new AgentService(
    {} as never,
    builder as never,
    applicationService as never,
    cache as never,
  );

  const aiModelRegistryService = {
    validateModelAvailability: jest.fn(),
  };

  const agentResolver = new AgentResolver(
    agentService,
    aiModelRegistryService as never,
  );

  const createAgentTool = new CreateAgentTool(
    agentService,
    aiModelRegistryService as never,
  );
  const updateAgentTool = new UpdateAgentTool(
    agentService,
    aiModelRegistryService as never,
  );
  const deleteAgentTool = new DeleteAgentTool(agentService);

  const roleTargetService = new RoleTargetService(
    flatEntityMapsCache as never,
    builder as never,
    applicationService as never,
  );

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
        return (await targets()).filter(
          (row) => row.roleId === opts.where.roleId && row.id !== excludedId,
        ).length;
      },
    ),
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

  const aiAgentRoleService = new AiAgentRoleService(
    {} as never,
    roleRepository as never,
    roleTargetRepository as never,
    roleTargetService,
    cache as never,
    runtime,
  );

  const workflowStepOps = new WorkflowVersionStepOperationsWorkspaceService(
    {} as never,
    {} as never,
    {} as never,
    agentService as never,
    roleTargetRepository as never,
    {} as never,
    {} as never,
    aiAgentRoleService,
    cache as never,
    flatEntityMapsCache as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return {
    agentService,
    agentResolver,
    createAgentTool,
    updateAgentTool,
    deleteAgentTool,
    workflowStepOps,
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
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"defaultRoleId" uuid,"deletedAt" timestamptz); CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz); ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE; ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("agentId") REFERENCES core.agent(id) ON DELETE CASCADE',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"databaseSchema","defaultRoleId") VALUES($1,$2,NULL)',
    [workspaceId, 'synthetic_members'],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-agent-service-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core TO "${databaseRole}"; GRANT INSERT,DELETE ON core.role,core.agent,core."roleTarget" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
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
  await owner.getRepository(RoleEntity).insert([
    {
      id: agentRole1Id,
      workspaceId,
      universalIdentifier: agentRole1UniversalId,
      applicationId,
      label: 'Agent Role 1',
      description: 'First agent role',
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
      id: agentRole2Id,
      workspaceId,
      universalIdentifier: agentRole2UniversalId,
      applicationId,
      label: 'Agent Role 2',
      description: 'Second agent role',
      icon: 'IconRobot',
      isEditable: true,
      canUpdateAllSettings: false,
      canAccessAllTools: true,
      canAccessAllAgentChatChannels: false,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: true,
      canSoftDeleteAllObjectRecords: false,
      canDestroyAllObjectRecords: false,
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: false,
    },
    {
      id: userOnlyRoleId,
      workspaceId,
      universalIdentifier: userOnlyRoleUniversalId,
      applicationId,
      label: 'User Only Role',
      description: 'Cannot be assigned to agents',
      icon: 'IconUser',
      isEditable: true,
      canUpdateAllSettings: false,
      canAccessAllTools: false,
      canAccessAllAgentChatChannels: false,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: false,
      canSoftDeleteAllObjectRecords: false,
      canDestroyAllObjectRecords: false,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
  ]);
});

afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      `DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP ROLE IF EXISTS "${databaseRole}"`,
    );
    await owner.destroy();
  }
});

describe('AgentService inline roleTarget CRM audit (LOG162)', () => {
  it('audits roleTarget creation in AgentService.createOneAgent when roleId is provided and skips roleTarget audit when roleId is omitted', async () => {
    const { agentService } = buildHarness();

    const agentWithRole = await agentService.createOneAgent(
      {
        label: 'Deal Triage Agent',
        prompt: 'Triage incoming deals',
        modelId: 'auto',
        roleId: agentRole1Id,
      },
      workspaceId,
      userIdentity(),
    );

    expect(agentWithRole.roleId).toBe(agentRole1Id);
    const currentTargets = await targets();
    expect(currentTargets).toHaveLength(1);
    expect(currentTargets[0]).toMatchObject({
      agentId: agentWithRole.id,
      roleId: agentRole1Id,
    });

    const entriesAfterWithRole = await audits();
    expect(entriesAfterWithRole).toHaveLength(1);
    expect(entriesAfterWithRole[0]).toMatchObject({
      workspaceId,
      resourceKind: 'roleTarget',
      resourceId: currentTargets[0].id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: actorId },
      redactedDiff: {
        values: {
          agentId: { before: null, after: agentWithRole.id },
          roleId: { before: null, after: agentRole1Id },
        },
      },
    });

    const agentWithoutRole = await agentService.createOneAgent(
      {
        label: 'Unassigned Helper Agent',
        prompt: 'No role yet',
        modelId: 'auto',
      },
      workspaceId,
    );
    expect(agentWithoutRole.roleId).toBeNull();
    expect(await agents()).toHaveLength(2);
    expect(await targets()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('audits assign, same-role no-op, role replacement (both role-only and combined with label/prompt), and role removal in AgentService.updateOneAgent', async () => {
    const { agentService } = buildHarness();

    const agent = await agentService.createOneAgent(
      {
        label: 'Support Agent',
        prompt: 'Initial prompt',
        modelId: 'auto',
      },
      workspaceId,
    );
    expect(await audits()).toHaveLength(0);

    const afterAssign = await agentService.updateOneAgent({
      input: { id: agent.id, roleId: agentRole1Id },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(afterAssign.roleId).toBe(agentRole1Id);
    const [target1] = await targets();
    const auditsAfterAssign = await audits();
    expect(auditsAfterAssign).toHaveLength(1);
    expect(auditsAfterAssign[0]).toMatchObject({
      resourceKind: 'roleTarget',
      resourceId: target1.id,
      action: 'create',
      redactedDiff: {
        values: {
          agentId: { before: null, after: agent.id },
          roleId: { before: null, after: agentRole1Id },
        },
      },
    });

    const afterSameRole = await agentService.updateOneAgent({
      input: {
        id: agent.id,
        label: 'Support Agent Renamed',
        roleId: agentRole1Id,
      },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(afterSameRole.roleId).toBe(agentRole1Id);
    expect(afterSameRole.label).toBe('Support Agent Renamed');
    expect((await targets())[0].id).toBe(target1.id);
    expect(await audits()).toHaveLength(1);

    const afterReplace = await agentService.updateOneAgent({
      input: {
        id: agent.id,
        prompt: 'Updated prompt with role 2',
        roleId: agentRole2Id,
      },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(afterReplace.roleId).toBe(agentRole2Id);
    expect(afterReplace.prompt).toBe('Updated prompt with role 2');
    const [target2] = await targets();
    expect(target2.id).not.toBe(target1.id);

    const auditsAfterReplace = await audits();
    expect(auditsAfterReplace).toHaveLength(3);
    expect(auditsAfterReplace[1]).toMatchObject({
      resourceKind: 'roleTarget',
      resourceId: target1.id,
      action: 'delete',
      redactedDiff: {
        values: {
          agentId: { before: agent.id, after: null },
          roleId: { before: agentRole1Id, after: null },
        },
      },
    });
    expect(auditsAfterReplace[2]).toMatchObject({
      resourceKind: 'roleTarget',
      resourceId: target2.id,
      action: 'create',
      operationId: auditsAfterReplace[1].operationId,
      redactedDiff: {
        values: {
          agentId: { before: null, after: agent.id },
          roleId: { before: null, after: agentRole2Id },
        },
      },
    });

    const afterClear = await agentService.updateOneAgent({
      input: { id: agent.id, roleId: null },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(afterClear.roleId).toBeNull();
    expect(await targets()).toHaveLength(0);
    const auditsAfterClear = await audits();
    expect(auditsAfterClear).toHaveLength(4);
    expect(auditsAfterClear[3]).toMatchObject({
      resourceKind: 'roleTarget',
      resourceId: target2.id,
      action: 'delete',
      redactedDiff: {
        values: {
          agentId: { before: agent.id, after: null },
          roleId: { before: agentRole2Id, after: null },
        },
      },
    });
  });

  it('audits roleTarget deletion in deleteManyAgents and rolls back if a deleted agent gains a concurrent uncounted roleTarget before ON DELETE CASCADE', async () => {
    const { agentService } = buildHarness();

    const agentA = await agentService.createOneAgent(
      {
        label: 'Agent A',
        prompt: 'A',
        modelId: 'auto',
        roleId: agentRole1Id,
      },
      workspaceId,
      userIdentity(),
    );
    const agentB = await agentService.createOneAgent(
      {
        label: 'Agent B',
        prompt: 'B',
        modelId: 'auto',
        roleId: agentRole2Id,
      },
      workspaceId,
      userIdentity(),
    );
    const agentC = await agentService.createOneAgent(
      {
        label: 'Agent C (unassigned)',
        prompt: 'C',
        modelId: 'auto',
      },
      workspaceId,
    );

    const raceHarness = buildHarness({
      beforeRunnerRun: async () => {
        await owner.getRepository(RoleTargetEntity).insert({
          id: randomUUID(),
          workspaceId,
          universalIdentifier: randomUUID(),
          applicationId,
          roleId: agentRole1Id,
          agentId: agentC.id,
          userWorkspaceId: null,
          apiKeyId: null,
        });
      },
    });

    await expect(
      raceHarness.agentService.deleteManyAgents({
        ids: [agentA.id, agentB.id, agentC.id],
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow('Role assignment old target changed');

    await owner.query('DELETE FROM core."roleTarget" WHERE "agentId"=$1', [
      agentC.id,
    ]);
    const deleted = await agentService.deleteManyAgents({
      ids: [agentA.id, agentB.id, agentC.id],
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(deleted).toHaveLength(3);
    expect(await agents()).toHaveLength(0);
    expect(await targets()).toHaveLength(0);

    const allAudits = await audits();
    expect(allAudits).toHaveLength(4);
    expect(allAudits[2]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
    });
    expect(allAudits[3]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
      operationId: allAudits[2].operationId,
    });
  });

  it('rejects missing auditIdentity and conflicting audit scopes before the first await', async () => {
    const { agentService: setupService } = buildHarness();
    const unassignedAgent = await setupService.createOneAgent(
      { label: 'Valid Agent', prompt: 'Prompt', modelId: 'auto' },
      workspaceId,
    );
    const { agentService, cache } = buildHarness();

    await expect(
      agentService.createOneAgent(
        {
          label: 'No Identity Agent',
          prompt: 'Prompt',
          modelId: 'auto',
          roleId: agentRole1Id,
        },
        workspaceId,
      ),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    await expect(
      agentService.updateOneAgent({
        input: { id: unassignedAgent.id, roleId: agentRole1Id },
        workspaceId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    await expect(
      agentService.deleteOneAgent(unassignedAgent.id, workspaceId),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    await expect(
      withRoleUpdateAudit(workspaceId, agentRole1Id, userIdentity(), () =>
        agentService.updateOneAgent({
          input: { id: unassignedAgent.id, roleId: agentRole1Id },
          workspaceId,
          auditIdentity: userIdentity(),
        }),
      ),
    ).rejects.toThrow('Nested role assignment audit unsupported');

    expect(cache.getOrRecompute).not.toHaveBeenCalled();
    expect(await agents()).toHaveLength(1);
    expect(await targets()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('rolls back agent create and update when the role cannot be assigned to agents', async () => {
    const { agentService } = buildHarness();

    await expect(
      agentService.createOneAgent(
        {
          label: 'User Role Agent',
          prompt: 'Should roll back',
          modelId: 'auto',
          roleId: userOnlyRoleId,
        },
        workspaceId,
        userIdentity(),
      ),
    ).rejects.toThrow(
      'Role assignment destination is unavailable or not assignable',
    );
    expect(await agents()).toHaveLength(0);

    const agent = await agentService.createOneAgent(
      {
        label: 'Assigned Agent',
        prompt: 'Original prompt',
        modelId: 'auto',
        roleId: agentRole1Id,
      },
      workspaceId,
      userIdentity(),
    );
    const [originalTarget] = await targets();

    await expect(
      agentService.updateOneAgent({
        input: {
          id: agent.id,
          prompt: 'Should roll back',
          roleId: userOnlyRoleId,
        },
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Role assignment destination is unavailable or not assignable',
    );
    expect(await targets()).toEqual([originalTarget]);
    expect((await agents())[0].prompt).toBe('Original prompt');
    expect(await audits()).toHaveLength(1);
  });

  it('rejects deleting an agent whose role binding is missing from the cache instead of cascading it unaudited', async () => {
    const { agentService: setupService } = buildHarness();
    const agent = await setupService.createOneAgent(
      { label: 'Cache Lag Agent', prompt: 'No role yet', modelId: 'auto' },
      workspaceId,
    );
    const lateTargetId = randomUUID();
    const { agentService } = buildHarness({
      beforeRunnerRun: async () => {
        await owner.getRepository(RoleTargetEntity).insert({
          id: lateTargetId,
          workspaceId,
          universalIdentifier: randomUUID(),
          applicationId,
          roleId: agentRole1Id,
          agentId: agent.id,
          userWorkspaceId: null,
          apiKeyId: null,
        });
      },
    });

    await expect(
      agentService.deleteOneAgent(agent.id, workspaceId, userIdentity()),
    ).rejects.toThrow('Role assignment old target changed');

    expect(await agents()).toHaveLength(1);
    expect((await targets()).map((target) => target.id)).toEqual([
      lateTargetId,
    ]);
    expect(await audits()).toHaveLength(0);
  });

  it('wires auditIdentity end-to-end across AgentResolver, Create/Update/DeleteAgentTool, and WorkflowVersionStepOperationsWorkspaceService', async () => {
    const {
      agentResolver,
      createAgentTool,
      updateAgentTool,
      deleteAgentTool,
      workflowStepOps,
    } = buildHarness();

    const req = {
      workspace: { id: workspaceId },
      userWorkspaceId: randomUUID(),
      workspaceMemberId: actorId,
      user: { id: randomUUID() },
    } as unknown as Request;

    const createdViaResolver = await agentResolver.createOneAgent(
      {
        label: 'Resolver Agent',
        prompt: 'Resolver prompt',
        modelId: 'auto',
        roleId: agentRole1Id,
      } as never,
      { id: workspaceId } as never,
      { req },
    );
    expect(createdViaResolver.roleId).toBe(agentRole1Id);

    const toolContext = {
      workspaceId,
      agentId: callingAgentId,
      authContext: {
        type: 'user',
        workspace: { id: workspaceId },
        workspaceMemberId: actorId,
      },
    };

    const createdViaTool = await createAgentTool.execute({
      input: {
        label: 'Tool Agent',
        prompt: 'Tool prompt',
        modelId: 'auto',
        roleId: agentRole1Id,
      },
      context: toolContext as never,
    });
    const toolAgentId = (createdViaTool.result as { id: string }).id;

    await updateAgentTool.execute({
      input: {
        id: toolAgentId,
        roleId: agentRole2Id,
      },
      context: toolContext as never,
    });

    await deleteAgentTool.execute({
      input: { id: toolAgentId },
      context: toolContext as never,
    });

    await workflowStepOps.runWorkflowVersionStepDeletionSideEffects({
      step: {
        id: randomUUID(),
        name: 'Agent Step',
        type: WorkflowActionType.AI_AGENT,
        valid: true,
        settings: {
          input: { agentId: createdViaResolver.id, prompt: '' },
          outputSchema: {},
          errorHandlingOptions: {
            retryOnFailure: { value: 0 },
            continueOnFailure: { value: false },
          },
        },
      },
      workspaceId,
    });

    const entries = await audits();
    expect(entries).toHaveLength(7);
    expect(entries[0]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      actor: { kind: 'workspaceMember', id: actorId },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      actor: { kind: 'agent', id: callingAgentId },
      initiator: { kind: 'workspaceMember', id: actorId },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
      actor: { kind: 'agent', id: callingAgentId },
      initiator: { kind: 'workspaceMember', id: actorId },
    });
    expect(entries[3]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'create',
      operationId: entries[2].operationId,
      actor: { kind: 'agent', id: callingAgentId },
      initiator: { kind: 'workspaceMember', id: actorId },
    });
    expect(entries[4]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
      actor: { kind: 'agent', id: callingAgentId },
      initiator: { kind: 'workspaceMember', id: actorId },
    });
    expect(entries[5]).toMatchObject({
      resourceKind: 'roleTarget',
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workflow-version-step:delete-agent-step',
      },
    });
    expect(entries[6]).toMatchObject({
      resourceKind: 'role',
      resourceId: agentRole1Id,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workflow-version-step:delete-agent-step',
      },
    });
  });

  it('suppresses ROLLBACK and invalidates the cache when the COMMIT acknowledgement is lost', async () => {
    const { agentService, cache } = buildHarness();
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
      agentService.createOneAgent(
        {
          label: 'Commit Uncertainty Agent',
          prompt: 'Committed before the acknowledgement was lost',
          modelId: 'auto',
          roleId: agentRole1Id,
        },
        workspaceId,
        userIdentity(),
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(cache.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining(['flatRoleTargetMaps', 'rolesPermissions']),
    );
    expect(await agents()).toHaveLength(1);
    expect(await targets()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('wraps a failure after a confirmed COMMIT in CoreAuditPostCommitError without ROLLBACK', async () => {
    const { agentService } = buildHarness();
    const rollbacks: jest.SpyInstance[] = [];
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const commitTransaction = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commitTransaction();
        throw new Error('failure after confirmed commit');
      };
      rollbacks.push(jest.spyOn(runner, 'rollbackTransaction'));
      return runner;
    });

    await expect(
      agentService.createOneAgent(
        {
          label: 'Post Commit Failure Agent',
          prompt: 'Committed before the failure',
          modelId: 'auto',
          roleId: agentRole1Id,
        },
        workspaceId,
        userIdentity(),
      ),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(rollbacks.length).toBeGreaterThan(0);
    for (const rollback of rollbacks) expect(rollback).not.toHaveBeenCalled();
    expect(await agents()).toHaveLength(1);
    expect(await targets()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('keeps agent create and edits without role changes open to callers that cannot write audit entries, but not deletes', async () => {
    const { agentService } = buildHarness();
    const pendingActivationIdentity = {
      auth: { type: 'pendingActivationUser', workspace: { id: workspaceId } },
    } as unknown as RoleUpdateAuditIdentity;

    const agent = await agentService.createOneAgent(
      { label: 'Plain Agent', prompt: 'No role', modelId: 'auto' },
      workspaceId,
      pendingActivationIdentity,
    );
    const updated = await agentService.updateOneAgent({
      input: { id: agent.id, prompt: 'Still no role' },
      workspaceId,
      auditIdentity: pendingActivationIdentity,
    });
    expect(updated.prompt).toBe('Still no role');

    await expect(
      agentService.updateOneAgent({
        input: { id: agent.id, roleId: agentRole1Id },
        workspaceId,
        auditIdentity: pendingActivationIdentity,
      }),
    ).rejects.toThrow('Authentication cannot perform audited CRM writes');
    await expect(
      agentService.deleteOneAgent(
        agent.id,
        workspaceId,
        pendingActivationIdentity,
      ),
    ).rejects.toThrow('Authentication cannot perform audited CRM writes');
    expect(await agents()).toHaveLength(1);
    expect(await targets()).toHaveLength(0);

    await agentService.deleteOneAgent(agent.id, workspaceId, userIdentity());
    expect(await agents()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('audits role changes on agents owned by another application while the migration runs under the workspace application', async () => {
    const { agentService } = buildHarness();
    const otherApplicationId = randomUUID();
    const foreignAgentId = randomUUID();
    await owner.query('INSERT INTO core.application VALUES($1,$2,$3,NULL)', [
      otherApplicationId,
      workspaceId,
      randomUUID(),
    ]);
    await owner.getRepository(AgentEntity).insert({
      id: foreignAgentId,
      workspaceId,
      universalIdentifier: randomUUID(),
      applicationId: otherApplicationId,
      name: 'foreignAgent',
      label: 'Foreign Agent',
      prompt: 'Owned by another application',
    });

    await agentService.updateOneAgent({
      input: { id: foreignAgentId, roleId: agentRole1Id },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(await targets()).toEqual([
      expect.objectContaining({
        agentId: foreignAgentId,
        roleId: agentRole1Id,
        applicationId,
      }),
    ]);

    await agentService.updateOneAgent({
      input: { id: foreignAgentId, roleId: agentRole2Id },
      workspaceId,
      auditIdentity: userIdentity(),
    });
    expect(await targets()).toEqual([
      expect.objectContaining({
        agentId: foreignAgentId,
        roleId: agentRole2Id,
        applicationId,
      }),
    ]);

    await agentService.deleteOneAgent(
      foreignAgentId,
      workspaceId,
      userIdentity(),
    );
    expect(await agents()).toHaveLength(0);
    expect(await targets()).toHaveLength(0);
    expect((await audits()).map((entry) => entry.action)).toEqual([
      'create',
      'delete',
      'create',
      'delete',
    ]);
  });

  it('passes the request identity from AgentResolver update and delete', async () => {
    const { agentService, agentResolver } = buildHarness();
    const req = {
      workspace: { id: workspaceId },
      userWorkspaceId: randomUUID(),
      workspaceMemberId: actorId,
      user: { id: randomUUID() },
    } as unknown as Request;
    const agent = await agentService.createOneAgent(
      { label: 'Resolver Target', prompt: 'Prompt', modelId: 'auto' },
      workspaceId,
    );

    await agentResolver.updateOneAgent(
      { id: agent.id, roleId: agentRole1Id } as never,
      { id: workspaceId } as never,
      { req },
    );
    await agentResolver.deleteOneAgent(
      { id: agent.id } as never,
      { id: workspaceId } as never,
      { req },
    );

    expect(await agents()).toHaveLength(0);
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: 'create',
        actor: { kind: 'workspaceMember', id: actorId },
      }),
      expect.objectContaining({
        action: 'delete',
        actor: { kind: 'workspaceMember', id: actorId },
      }),
    ]);
  });
});
