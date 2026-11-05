import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  ApiKeyException,
  ApiKeyExceptionCode,
} from 'src/engine/core-modules/api-key/exceptions/api-key.exception';
import { withApiKeyCreateAudit } from 'src/engine/core-modules/crm-audit/api-key-audit';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { withApiKeyRoleAssignmentAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import { withRolePermissionFlagUpsertAudit } from 'src/engine/core-modules/crm-audit/role-permission-audit';
import {
  captureRoleAuditIdentity,
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { ForbiddenError } from 'src/engine/core-modules/graphql/utils/graphql-errors.util';
import { NodeEnvironment } from 'src/engine/core-modules/twenty-config/interfaces/node-environment.interface';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

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
  ['core-modules/jwt/services/jwt-wrapper.service', 'JwtWrapperService'],
  [
    'core-modules/auth/filters/auth-graphql-api-exception.filter',
    'AuthGraphqlApiExceptionFilter',
  ],
  [
    'core-modules/auth/filters/auth-rest-api-exception.filter',
    'AuthRestApiExceptionFilter',
  ],
  ['api/rest/rest-api-exception.filter', 'RestApiExceptionFilter'],
  [
    'metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    'PermissionsGraphqlApiExceptionFilter',
  ],
  [
    'metadata-modules/permissions/utils/permissions-rest-api-exception.filter',
    'PermissionsRestApiExceptionFilter',
  ],
  [
    'workspace-manager/workspace-migration/interceptors/workspace-migration-graphql-api-exception.interceptor',
    'WorkspaceMigrationGraphqlApiExceptionInterceptor',
  ],
  ['guards/jwt-auth.guard', 'JwtAuthGuard'],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));

jest.doMock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.doMock('src/engine/guards/settings-permission.guard', () => ({
  SettingsPermissionGuard: () => class {},
}));
jest.doMock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
jest.doMock('src/engine/decorators/auth/auth-workspace.decorator', () => ({
  AuthWorkspace: () => () => {},
}));

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
      },
  }),
);

const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const {
  ApiKeyEntity,
} = require('src/engine/core-modules/api-key/api-key.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { ApiKeyService } =
  require('src/engine/core-modules/api-key/services/api-key.service') as typeof import('src/engine/core-modules/api-key/services/api-key.service');
const { ApiKeyRoleService } =
  require('src/engine/core-modules/api-key/services/api-key-role.service') as typeof import('src/engine/core-modules/api-key/services/api-key-role.service');
const { ApiKeyResolver } =
  require('src/engine/core-modules/api-key/api-key.resolver') as typeof import('src/engine/core-modules/api-key/api-key.resolver');
const { ApiKeyController } =
  require('src/engine/core-modules/api-key/controllers/api-key.controller') as typeof import('src/engine/core-modules/api-key/controllers/api-key.controller');
const { GenerateApiKeyCommand } =
  require('src/engine/core-modules/api-key/commands/generate-api-key.command') as typeof import('src/engine/core-modules/api-key/commands/generate-api-key.command');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `api_key_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const actorId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const adminRoleId = randomUUID();
const adminRoleUniversalIdentifier = STANDARD_ROLE.admin.universalIdentifier;
const apiKeyAssignableRoleId = randomUUID();
const apiKeyAssignableRoleUniversalIdentifier = randomUUID();
const nonApiKeyRoleId = randomUUID();
const nonApiKeyRoleUniversalIdentifier = randomUUID();

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

const apiKeySchema = new EntitySchema({
  name: 'ApiKeyEntity',
  target: ApiKeyEntity,
  tableName: 'apiKey',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    name: { type: 'text' },
    expiresAt: { type: 'timestamptz' },
    revokedAt: { type: 'timestamptz', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [roleSchema, targetSchema, apiKeySchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-api-key-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [roleSchema, targetSchema, apiKeySchema],
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

const identity = (
  extra: Partial<RoleUpdateAuditIdentity> = {},
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
  ...extra,
});

const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY id');
const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY id');
const apiKeys = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."apiKey" ORDER BY id');
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
          r.roleId === adminRoleId
            ? adminRoleUniversalIdentifier
            : r.roleId === apiKeyAssignableRoleId
              ? apiKeyAssignableRoleUniversalIdentifier
              : nonApiKeyRoleUniversalIdentifier,
      } as Row,
    ]),
  ) as Record<string, Row>,
  universalIdentifierById: Object.fromEntries(
    records.map((r) => [r.id, r.universalIdentifier]),
  ),
  idByUniversalIdentifier: Object.fromEntries(
    records.map((r) => [r.universalIdentifier, r.id]),
  ),
  byId: Object.fromEntries(
    records.map((r) => [
      r.id,
      {
        ...r,
        applicationUniversalIdentifier,
      },
    ]),
  ),
});

const flatMaps = async () => ({
  flatRoleMaps: entityMaps(await roles()),
  flatRoleTargetMaps: entityMaps(await targets()),
  flatAgentMaps: entityMaps([]),
  flatApplicationMaps: {
    byId: { [applicationId]: application },
    idByUniversalIdentifier: {
      [applicationUniversalIdentifier]: applicationId,
    },
  },
});

const buildHarness = async (
  options: {
    beforeExecute?: (runner: QueryRunner) => Promise<void>;
    invalidateError?: Error;
  } = {},
) => {
  const createTargetHandler = new CreateRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(
      async ({
        context,
      }: {
        context: Parameters<
          InstanceType<
            typeof CreateRoleTargetActionHandlerService
          >['transpileUniversalActionToFlatAction']
        >[0] & { queryRunner: QueryRunner };
      }) => {
        if (options.beforeExecute) {
          await options.beforeExecute(context.queryRunner);
        }
        const flatAction =
          await createTargetHandler.transpileUniversalActionToFlatAction(
            context,
          );
        await createTargetHandler.executeForMetadata({
          ...context,
          flatAction,
        });
        return {
          partialOptimisticCache: {},
          metadataEvents: [],
          deferredActions: [],
        };
      },
    ),
  };

  const cacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => flatMaps()),
    invalidateFlatEntityMaps: jest.fn(async () => undefined),
  };
  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatApplicationMaps: {
        byId: { [applicationId]: application },
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
      },
    })),
    invalidateAndRecompute: jest.fn(async (_wsId: string, keys: string[]) => {
      if (options.invalidateError && keys.includes('apiKeyMap')) {
        throw options.invalidateError;
      }
    }),
  };

  const runnerService = new WorkspaceMigrationRunnerService(
    cacheService as never,
    runtime,
    registry as never,
    { incrementMetadataVersion: jest.fn(async () => undefined) } as never,
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
    {} as never,
    {
      throwIfSchemaAffectingActionsAreInProgress: jest.fn(
        async () => undefined,
      ),
    } as never,
  );

  const validateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: targetWorkspaceId,
        applicationUniversalIdentifier: appUid,
      }: {
        allFlatEntityOperationByMetadataName: {
          roleTarget: {
            flatEntityToCreate: Array<Record<string, unknown>>;
            flatEntityToDelete: Array<Record<string, unknown>>;
          };
        };
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const currentMaps = await flatMaps();
        for (const toCreate of allFlatEntityOperationByMetadataName.roleTarget
          .flatEntityToCreate) {
          const referencedRole =
            currentMaps.flatRoleMaps.byUniversalIdentifier[
              String(toCreate.roleUniversalIdentifier)
            ];
          if (!referencedRole || !referencedRole.canBeAssignedToApiKeys) {
            return {
              status: 'fail',
              errors: {
                roleTarget: [
                  {
                    type: 'create',
                    errors: [{ code: 'ROLE_CANNOT_BE_ASSIGNED_TO_API_KEYS' }],
                  },
                ],
              },
            };
          }
        }
        const actions =
          allFlatEntityOperationByMetadataName.roleTarget.flatEntityToCreate.map(
            (flatEntity) => ({
              type: 'create' as const,
              metadataName: 'roleTarget' as const,
              id: String(flatEntity.id),
              flatEntity,
            }),
          );
        await runnerService.run({
          workspaceId: targetWorkspaceId,
          workspaceMigration: {
            actions: actions as never,
            applicationUniversalIdentifier: appUid,
          },
        });
        return { status: 'success' };
      },
    ),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async () => ({
        workspaceCustomFlatApplication: application,
        twentyStandardFlatApplication: application,
      }),
    ),
  };

  const roleTargetService = new RoleTargetService(
    cacheService as never,
    validateBuildAndRunService as never,
    applicationService as never,
  );

  const apiKeyRepository = {
    createQueryBuilder: () => ({ connection: runtime }),
    findOne: jest.fn(async (wsId: string, opts: { where: { id: string } }) => {
      const rows = await runtime.query(
        'SELECT * FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$2',
        [opts.where.id, wsId],
      );
      return rows[0] ?? null;
    }),
    find: jest.fn(async (wsId: string) =>
      runtime.query(
        'SELECT * FROM core."apiKey" WHERE "workspaceId"=$1 ORDER BY "createdAt" ASC, id ASC',
        [wsId],
      ),
    ),
  };

  const jwtWrapperService = {
    signAsyncOrThrow: jest.fn(async () => 'signed-jwt-token'),
  };

  const apiKeyService = new ApiKeyService(
    apiKeyRepository as never,
    jwtWrapperService as never,
    roleTargetService,
    workspaceCacheService as never,
  );

  const apiKeyRoleService = new ApiKeyRoleService(
    {} as never,
    {} as never,
    apiKeyRepository as never,
    workspaceCacheService as never,
    roleTargetService,
  );

  const resolver = new ApiKeyResolver(apiKeyService, apiKeyRoleService);
  const controller = new ApiKeyController(apiKeyService);

  return {
    runnerService,
    roleTargetService,
    apiKeyService,
    resolver,
    controller,
    workspaceCacheService,
    validateBuildAndRunService,
  };
};

const resetFixture = async () => {
  await owner.query(
    'TRUNCATE core."roleTarget", core."apiKey", core."userWorkspace", core.role, core.application, core.workspace CASCADE',
  );
  await owner.query(
    'INSERT INTO core.workspace (id,"defaultRoleId","deletedAt") VALUES ($1,$2,NULL)',
    [workspaceId, adminRoleId],
  );
  await owner.query(
    'INSERT INTO core.application (id,"workspaceId","universalIdentifier","deletedAt") VALUES ($1,$2,$3,NULL)',
    [applicationId, workspaceId, applicationUniversalIdentifier],
  );
  await owner.query(
    'INSERT INTO core."userWorkspace" (id,"userId","workspaceId","deletedAt") VALUES ($1,$2,$3,NULL)',
    [impersonatorUserWorkspaceId, impersonatorUserId, workspaceId],
  );
  await owner.query(
    `INSERT INTO core.role (id,"workspaceId","universalIdentifier","applicationId",label,"isEditable","canBeAssignedToApiKeys")
     VALUES
       ($1,$2,$3,$4,'Admin',false,true),
       ($5,$2,$6,$4,'Integration Role',true,true),
       ($7,$2,$8,$4,'Users Only Role',true,false)`,
    [
      adminRoleId,
      workspaceId,
      adminRoleUniversalIdentifier,
      applicationId,
      apiKeyAssignableRoleId,
      apiKeyAssignableRoleUniversalIdentifier,
      nonApiKeyRoleId,
      nonApiKeyRoleUniversalIdentifier,
    ],
  );
  await owner.query('SET ROLE NONE');
  await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core; CREATE SCHEMA crm_audit',
  );
  await owner.query(`
    DROP TABLE IF EXISTS core."roleTarget", core."apiKey", core."userWorkspace", core.role, core.application, core.workspace CASCADE;
    CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "defaultRoleId" uuid,
      "deletedAt" timestamptz
    );
    CREATE TABLE core.application (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "universalIdentifier" uuid NOT NULL,
      "deletedAt" timestamptz
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "userId" uuid NOT NULL,
      "workspaceId" uuid NOT NULL,
      "deletedAt" timestamptz
    );
    CREATE TABLE core.role (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "universalIdentifier" uuid NOT NULL,
      "applicationId" uuid NOT NULL,
      label text NOT NULL,
      description text,
      icon text,
      "isEditable" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      ${booleans.map((name) => `"${name}" boolean NOT NULL DEFAULT true`).join(',\n      ')}
    );
    CREATE TABLE core."apiKey" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      name text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "revokedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."roleTarget" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "universalIdentifier" uuid NOT NULL,
      "applicationId" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "userWorkspaceId" uuid,
      "agentId" uuid,
      "apiKeyId" uuid REFERENCES core."apiKey"(id) ON DELETE CASCADE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
  `);
  const runner = owner.createQueryRunner();
  await runner.connect();
  try {
    await new OmniAuditBootstrapFastInstanceCommand().up(runner);
  } finally {
    await runner.release();
  }
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-api-key-fixture';
     GRANT USAGE ON SCHEMA core, crm_audit TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(resetFixture);

afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query('DROP SCHEMA IF EXISTS core, crm_audit CASCADE');
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

describe('LOG158 CRM audit for API-key creation, update, and revocation', () => {
  test('1. ApiKeyResolver.createApiKey atomically inserts apiKey, roleTarget, and both audit entries with shared operationId and impersonation initiator', async () => {
    const { resolver, workspaceCacheService } = await buildHarness();
    const expiresAt = '2027-06-01T12:00:00.000Z';

    const created = await resolver.createApiKey(
      { id: workspaceId } as never,
      {
        name: 'Production Integration Key',
        expiresAt,
        roleId: apiKeyAssignableRoleId,
      },
      {
        req: {
          workspace: { id: workspaceId },
          user: {},
          userWorkspaceId: randomUUID(),
          workspaceMemberId: actorId,
          impersonationContext: { impersonatorUserWorkspaceId },
        } as never,
      },
    );

    expect(created.name).toBe('Production Integration Key');
    expect(created.expiresAt.toISOString()).toBe(expiresAt);
    expect(created.revokedAt).toBeNull();
    expect(created.workspaceId).toBe(workspaceId);

    const dbKeys = await apiKeys();
    const dbTargets = await targets();
    const dbAudits = await audits();

    expect(dbKeys).toHaveLength(1);
    expect(dbKeys[0].id).toBe(created.id);
    expect(dbTargets).toHaveLength(1);
    expect(dbTargets[0].apiKeyId).toBe(created.id);
    expect(dbTargets[0].roleId).toBe(apiKeyAssignableRoleId);

    expect(dbAudits).toHaveLength(2);
    const apiKeyAudit = dbAudits.find(
      (entry) => entry.resourceKind === 'apiKey',
    );
    const roleTargetAudit = dbAudits.find(
      (entry) => entry.resourceKind === 'roleTarget',
    );
    expect(apiKeyAudit).toBeDefined();
    expect(roleTargetAudit).toBeDefined();
    expect(apiKeyAudit!.operationId).toBe(roleTargetAudit!.operationId);
    expect(apiKeyAudit!.action).toBe('create');
    expect(apiKeyAudit!.resourceId).toBe(created.id);
    expect(apiKeyAudit!.actor).toEqual({
      kind: 'workspaceMember',
      id: actorId,
    });
    expect(apiKeyAudit!.initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });
    expect(apiKeyAudit!.redactedDiff).toEqual({
      changedFields: ['expiresAt', 'name', 'revokedAt'],
      values: {},
    });
    expect(apiKeyAudit!.securityDescriptor).toEqual({
      resourceKind: 'apiKey',
      resourceId: created.id,
      metadataAccess: 'currentWorkspaceAdministration',
    });
    expect(roleTargetAudit!.action).toBe('create');
    expect(roleTargetAudit!.resourceId).toBe(dbTargets[0].id);
    expect(roleTargetAudit!.redactedDiff).toEqual({
      changedFields: ['apiKeyId', 'roleId'],
      values: {
        apiKeyId: { before: null, after: created.id },
        roleId: { before: null, after: apiKeyAssignableRoleId },
      },
    });
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['apiKeyMap'],
    );
  });

  test('2. ApiKeyController.create and GenerateApiKeyCommand record REST and CLI system actor audit entries atomically', async () => {
    const { controller, apiKeyService } = await buildHarness();
    const restKey = await controller.create(
      {
        name: 'REST Key',
        expiresAt: '2027-07-01T00:00:00.000Z',
        roleId: apiKeyAssignableRoleId,
      },
      { id: workspaceId } as never,
      {
        workspace: { id: workspaceId },
        user: {},
        userWorkspaceId: randomUUID(),
        workspaceMemberId: actorId,
      } as never,
    );
    expect(restKey.id).toBeDefined();

    const command = new GenerateApiKeyCommand(
      {
        findOne: jest.fn(async () => ({ id: workspaceId })),
      } as never,
      {
        findOne: jest.fn(async () => ({ id: adminRoleId })),
      } as never,
      apiKeyService,
      { get: jest.fn(() => NodeEnvironment.DEVELOPMENT) } as never,
    );

    await command.run([], {
      workspaceId,
      name: 'CLI Key',
      expiresIn: 30,
    });

    const dbKeys = await apiKeys();
    const dbAudits = await audits();
    expect(dbKeys).toHaveLength(2);
    expect(dbAudits).toHaveLength(4);
    const cliKeyAudit = dbAudits.find(
      (entry) =>
        entry.resourceKind === 'apiKey' && entry.resourceId !== restKey.id,
    );
    expect(cliKeyAudit?.actor).toEqual({
      kind: 'system',
      id: 'workspace:generate-api-key',
    });
  });

  test('3. Refuses API-key creation when role cannot be assigned to API keys (pre-migration and concurrent DB change) without leaving orphan core.apiKey rows', async () => {
    const { apiKeyService, workspaceCacheService } = await buildHarness();

    await expect(
      apiKeyService.create({
        name: 'Disallowed Role Key',
        expiresAt: new Date('2027-08-01T00:00:00.000Z'),
        workspaceId,
        roleId: nonApiKeyRoleId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Multiple validation errors occurred while creating role targets',
    );

    expect(await apiKeys()).toHaveLength(0);
    expect(await targets()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(
      workspaceCacheService.invalidateAndRecompute,
    ).not.toHaveBeenCalledWith(workspaceId, ['apiKeyMap']);

    const {
      apiKeyService: racingService,
      runnerService: racingRunnerService,
      validateBuildAndRunService,
    } = await buildHarness();
    validateBuildAndRunService.validateBuildAndRunWorkspaceMigration = jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: targetWorkspaceId,
        applicationUniversalIdentifier: appUid,
      }) => {
        await owner.query(
          'UPDATE core.role SET "canBeAssignedToApiKeys" = false WHERE id = $1',
          [apiKeyAssignableRoleId],
        );
        const actions =
          allFlatEntityOperationByMetadataName.roleTarget.flatEntityToCreate.map(
            (flatEntity: Record<string, unknown>) => ({
              type: 'create' as const,
              metadataName: 'roleTarget' as const,
              id: String(flatEntity.id),
              flatEntity,
            }),
          );
        await racingRunnerService.run({
          workspaceId: targetWorkspaceId,
          workspaceMigration: {
            actions: actions as never,
            applicationUniversalIdentifier: appUid,
          },
        });
        return { status: 'success' };
      },
    );

    await expect(
      racingService.create({
        name: 'Racing Disallowed Role Key',
        expiresAt: new Date('2027-08-01T00:00:00.000Z'),
        workspaceId,
        roleId: apiKeyAssignableRoleId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'API key create audit role is unavailable or not assignable to API keys',
    );

    expect(await apiKeys()).toHaveLength(0);
    expect(await targets()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  test('4. ApiKeyResolver.updateApiKey and ApiKeyController.update record exact changedFields without false timestamp diffs and return null for missing keys', async () => {
    const { resolver, controller, workspaceCacheService } =
      await buildHarness();
    const req = {
      workspace: { id: workspaceId },
      user: {},
      userWorkspaceId: randomUUID(),
      workspaceMemberId: actorId,
    };

    const created = await resolver.createApiKey(
      { id: workspaceId } as never,
      {
        name: 'Initial Key',
        expiresAt: '2027-09-01T10:20:30.000Z',
        roleId: apiKeyAssignableRoleId,
      },
      { req: req as never },
    );

    const updatedNameOnly = await resolver.updateApiKey(
      { id: workspaceId } as never,
      {
        id: created.id,
        name: 'Renamed Key',
        revokedAt: undefined,
      },
      { req: req as never },
    );
    expect(updatedNameOnly?.name).toBe('Renamed Key');

    const updatedBoth = await controller.update(
      created.id,
      {
        id: created.id,
        name: 'Renamed Key 2',
        expiresAt: '2028-01-01T00:00:00.000Z',
      },
      { id: workspaceId } as never,
      req as never,
    );
    expect(updatedBoth?.name).toBe('Renamed Key 2');
    expect(updatedBoth?.expiresAt.toISOString()).toBe(
      '2028-01-01T00:00:00.000Z',
    );

    workspaceCacheService.invalidateAndRecompute.mockClear();
    const missing = await resolver.updateApiKey(
      { id: workspaceId } as never,
      {
        id: randomUUID(),
        name: 'Does Not Exist',
      },
      { req: req as never },
    );
    expect(missing).toBeNull();
    expect(workspaceCacheService.invalidateAndRecompute).not.toHaveBeenCalled();

    const dbAudits = await audits();
    const apiKeyUpdateAudits = dbAudits.filter(
      (entry) => entry.resourceKind === 'apiKey' && entry.action === 'update',
    );
    expect(apiKeyUpdateAudits).toHaveLength(2);
    expect(apiKeyUpdateAudits[0].redactedDiff).toEqual({
      changedFields: ['name'],
      values: {},
    });
    expect(apiKeyUpdateAudits[1].redactedDiff).toEqual({
      changedFields: ['expiresAt', 'name'],
      values: {},
    });
  });

  test('5. ApiKeyResolver.revokeApiKey, ApiKeyController.remove, and renaming an already-revoked key record exact changedFields', async () => {
    const { resolver, controller, apiKeyService } = await buildHarness();
    const req = {
      workspace: { id: workspaceId },
      user: {},
      userWorkspaceId: randomUUID(),
      workspaceMemberId: actorId,
    };

    const key1 = await resolver.createApiKey(
      { id: workspaceId } as never,
      {
        name: 'Key To Revoke 1',
        expiresAt: '2027-10-01T00:00:00.000Z',
        roleId: apiKeyAssignableRoleId,
      },
      { req: req as never },
    );
    const key2 = await resolver.createApiKey(
      { id: workspaceId } as never,
      {
        name: 'Key To Revoke 2',
        expiresAt: '2027-10-01T00:00:00.000Z',
        roleId: apiKeyAssignableRoleId,
      },
      { req: req as never },
    );

    const activeClearRevoked = await apiKeyService.update(
      key1.id,
      workspaceId,
      { revokedAt: null },
      identity(),
    );
    expect(activeClearRevoked?.revokedAt).toBeNull();

    const revoked1 = await resolver.revokeApiKey(
      { id: workspaceId } as never,
      { id: key1.id },
      { req: req as never },
    );
    expect(revoked1?.revokedAt).toBeInstanceOf(Date);

    const renamedRevoked = await resolver.updateApiKey(
      { id: workspaceId } as never,
      { id: key1.id, name: 'Revoked Renamed Key' },
      { req: req as never },
    );
    expect(renamedRevoked?.name).toBe('Revoked Renamed Key');
    expect(renamedRevoked?.revokedAt?.toISOString()).toBe(
      revoked1?.revokedAt?.toISOString(),
    );

    const revoked2 = await controller.remove(
      key2.id,
      { id: workspaceId } as never,
      req as never,
    );
    expect(revoked2?.revokedAt).toBeInstanceOf(Date);

    const key1UpdateAudits = (await audits()).filter(
      (entry) =>
        entry.resourceKind === 'apiKey' &&
        entry.resourceId === key1.id &&
        entry.action === 'update',
    );
    expect(key1UpdateAudits).toHaveLength(3);
    expect(key1UpdateAudits[0].redactedDiff).toEqual({
      changedFields: [],
      values: {},
    });
    expect(key1UpdateAudits[1].redactedDiff).toEqual({
      changedFields: ['revokedAt'],
      values: {},
    });
    expect(key1UpdateAudits[2].redactedDiff).toEqual({
      changedFields: ['name'],
      values: {},
    });
  });

  test('6. Refuses reactivating a revoked API key (revokedAt: null) under FOR UPDATE lock with ApiKeyExceptionCode.API_KEY_REVOKED / ForbiddenError', async () => {
    const { resolver, apiKeyService } = await buildHarness();
    const req = {
      workspace: { id: workspaceId },
      user: {},
      userWorkspaceId: randomUUID(),
      workspaceMemberId: actorId,
    };

    const created = await resolver.createApiKey(
      { id: workspaceId } as never,
      {
        name: 'Revoked Key',
        expiresAt: '2027-11-01T00:00:00.000Z',
        revokedAt: '2026-11-01T00:00:00.000Z',
        roleId: apiKeyAssignableRoleId,
      },
      { req: req as never },
    );
    expect(created.revokedAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    const auditCountBefore = (await audits()).length;

    await expect(
      apiKeyService.update(
        created.id,
        workspaceId,
        { name: 'Attempt Reactivate', revokedAt: null },
        identity(),
      ),
    ).rejects.toMatchObject({
      code: ApiKeyExceptionCode.API_KEY_REVOKED,
    });

    await expect(
      resolver.updateApiKey(
        { id: workspaceId } as never,
        { id: created.id, revokedAt: '' },
        { req: req as never },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await audits()).toHaveLength(auditCountBefore);
    const [persisted] = await apiKeys();
    expect(persisted.name).toBe('Revoked Key');
    expect(new Date(String(persisted.revokedAt)).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  test('7. Clones mutable Date inputs before first await and rejects invalid auditIdentity or systemActorId before any cache or DB access', async () => {
    const { apiKeyService, validateBuildAndRunService } = await buildHarness();

    expect(() =>
      captureRoleAuditIdentity({
        auth: { workspace: { id: workspaceId }, type: 'system' },
      }),
    ).toThrow('System role audit requires a valid systemActorId');

    expect(() =>
      captureRoleAuditIdentity({
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: actorId,
        },
        systemActorId: 'illegal-for-user',
      }),
    ).toThrow('Only system authentication can name a systemActorId');

    await expect(
      apiKeyService.create({
        name: 'No Identity Key',
        expiresAt: new Date('2027-12-01T00:00:00.000Z'),
        workspaceId,
        roleId: apiKeyAssignableRoleId,
        auditIdentity: undefined as never,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    expect(
      validateBuildAndRunService.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();

    const mutableExpiresAt = new Date('2027-12-01T00:00:00.000Z');
    const createPromise = apiKeyService.create({
      name: 'Mutable Date Key',
      expiresAt: mutableExpiresAt,
      workspaceId,
      roleId: apiKeyAssignableRoleId,
      auditIdentity: identity(),
    });
    mutableExpiresAt.setUTCFullYear(2099);
    const created = await createPromise;
    expect(created.expiresAt.toISOString()).toBe('2027-12-01T00:00:00.000Z');

    const mutableUpdateDate = new Date('2028-06-15T00:00:00.000Z');
    const updatePromise = apiKeyService.update(
      created.id,
      workspaceId,
      { expiresAt: mutableUpdateDate },
      identity(),
    );
    mutableUpdateDate.setUTCFullYear(2099);
    const updated = await updatePromise;
    expect(updated?.expiresAt.toISOString()).toBe('2028-06-15T00:00:00.000Z');
  });

  test('8. Preserves NativeTransactionOutcomeUnknownError on lost COMMIT ACK while invalidating apiKeyMap in finally (even if cache invalidation throws)', async () => {
    const { apiKeyService, workspaceCacheService } = await buildHarness({
      invalidateError: new Error('redis cache down'),
    });

    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const interceptNextCommit = () => {
      jest
        .spyOn(runtime, 'createQueryRunner')
        .mockImplementationOnce((mode) => {
          const runner = originalCreateQueryRunner(mode);
          const originalConnect = runner.connect.bind(runner);
          runner.connect = async () => {
            const client = await originalConnect();
            const originalClientQuery = client.query.bind(client);
            client.query = (async (sql: unknown, ...rest: unknown[]) => {
              if (sql === 'COMMIT') {
                client.query = originalClientQuery;
                await originalClientQuery('COMMIT');
                throw new Error('simulated lost COMMIT ACK');
              }
              return (
                originalClientQuery as (
                  q: unknown,
                  ...args: unknown[]
                ) => Promise<unknown>
              )(sql, ...rest);
            }) as typeof client.query;
            return client;
          };
          return runner;
        });
    };

    interceptNextCommit();
    await expect(
      apiKeyService.create({
        name: 'Unknown Commit Key',
        expiresAt: new Date('2027-12-01T00:00:00.000Z'),
        workspaceId,
        roleId: apiKeyAssignableRoleId,
        auditIdentity: identity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['apiKeyMap'],
    );

    const [createdRow] = await apiKeys();
    expect(createdRow).toBeDefined();

    workspaceCacheService.invalidateAndRecompute.mockClear();
    interceptNextCommit();
    await expect(
      apiKeyService.update(
        createdRow.id,
        workspaceId,
        { name: 'Unknown Update Key' },
        identity(),
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['apiKeyMap'],
    );
  });

  test('9. Rolls back create and update when a post-flush trigger mutates core.apiKey during audit flush', async () => {
    const { apiKeyService } = await buildHarness();
    const created = await apiKeyService.create({
      name: 'Clean Key',
      expiresAt: new Date('2027-12-01T00:00:00.000Z'),
      workspaceId,
      roleId: apiKeyAssignableRoleId,
      auditIdentity: identity(),
    });

    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_api_key_on_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'apiKey' THEN
          UPDATE core."apiKey" SET name = name || '_corrupted' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_api_key_on_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_api_key_on_audit();
    `);

    try {
      await expect(
        apiKeyService.create({
          name: 'Corrupted Create Key',
          expiresAt: new Date('2027-12-01T00:00:00.000Z'),
          workspaceId,
          roleId: apiKeyAssignableRoleId,
          auditIdentity: identity(),
        }),
      ).rejects.toThrow('API key create audit state changed during flush');

      await expect(
        apiKeyService.update(
          created.id,
          workspaceId,
          { name: 'Corrupted Update Key' },
          identity(),
        ),
      ).rejects.toThrow('API key update audit state changed during flush');
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS trg_corrupt_api_key_on_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS core.corrupt_api_key_on_audit();',
      );
    }

    const dbKeys = await apiKeys();
    expect(dbKeys).toHaveLength(1);
    expect(dbKeys[0].name).toBe('Clean Key');
    expect(await audits()).toHaveLength(2);
  });

  test('10. Enforces mutual exclusion of withApiKeyCreateAudit with all metadata audit scopes and refuses unexecuted scopes', async () => {
    await expect(
      withApiKeyCreateAudit(
        {
          workspaceId,
          apiKeyId: randomUUID(),
          roleId: apiKeyAssignableRoleId,
          name: 'Noop Key',
          expiresAtIso: '2027-12-01T00:00:00.000Z',
          revokedAtIso: null,
        },
        identity(),
        async () => undefined,
      ),
    ).rejects.toThrow('API key create audit was not executed');

    await expect(
      withApiKeyCreateAudit(
        {
          workspaceId,
          apiKeyId: randomUUID(),
          roleId: apiKeyAssignableRoleId,
          name: 'Outer Key',
          expiresAtIso: '2027-12-01T00:00:00.000Z',
          revokedAtIso: null,
        },
        identity(),
        async () => {
          await withRoleUpdateAudit(
            workspaceId,
            apiKeyAssignableRoleId,
            identity(),
            async () => undefined,
          );
        },
      ),
    ).rejects.toThrow('Nested role audit is unsupported');

    await expect(
      withApiKeyRoleAssignmentAudit(
        {
          workspaceId,
          apiKeyId: randomUUID(),
          roleId: apiKeyAssignableRoleId,
        },
        identity(),
        async () => {
          await withApiKeyCreateAudit(
            {
              workspaceId,
              apiKeyId: randomUUID(),
              roleId: apiKeyAssignableRoleId,
              name: 'Inner Key',
              expiresAtIso: '2027-12-01T00:00:00.000Z',
              revokedAtIso: null,
            },
            identity(),
            async () => undefined,
          );
        },
      ),
    ).rejects.toThrow('Nested API key create audit is unsupported');

    await expect(
      withRolePermissionFlagUpsertAudit(
        {
          workspaceId,
          roleId: apiKeyAssignableRoleId,
          permissionFlagKeys: ['ROLES'],
        },
        identity(),
        async () => {
          await withApiKeyCreateAudit(
            {
              workspaceId,
              apiKeyId: randomUUID(),
              roleId: apiKeyAssignableRoleId,
              name: 'Inner Key 2',
              expiresAtIso: '2027-12-01T00:00:00.000Z',
              revokedAtIso: null,
            },
            identity(),
            async () => undefined,
          );
        },
      ),
    ).rejects.toThrow('Nested API key create audit is unsupported');
  });

  test('11. Enforces administrative security descriptor and catalog actions (create, update only) for apiKey resourceKind', async () => {
    const runner = runtime.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const ctx = new CrmAuditTransactionContext(runner, {
        workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'workspaceMember', id: actorId },
      });
      const resourceId = randomUUID();
      expect(() =>
        ctx.record({
          resourceKind: 'apiKey',
          resourceId,
          action: 'delete',
          before: {
            name: 'Key',
            expiresAt: '2027-01-01T00:00:00.000Z',
            revokedAt: null,
          },
          after: null,
          securityDescriptor: {
            resourceKind: 'apiKey',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        }),
      ).toThrow('Role audit requires exact current administrative scope');

      expect(() =>
        ctx.record({
          resourceKind: 'apiKey',
          resourceId,
          action: 'create',
          before: null,
          after: {
            name: 'Key',
            expiresAt: '2027-01-01T00:00:00.000Z',
            revokedAt: null,
          },
          securityDescriptor: {
            resourceKind: 'apiKey',
            resourceId,
          },
        }),
      ).toThrow('Role audit requires exact current administrative scope');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  test('12. Refuses API-key create and update when workspace is soft-deleted', async () => {
    const { apiKeyService } = await buildHarness();
    const created = await apiKeyService.create({
      name: 'Before Workspace Delete',
      expiresAt: new Date('2027-12-01T00:00:00.000Z'),
      workspaceId,
      roleId: apiKeyAssignableRoleId,
      auditIdentity: identity(),
    });

    await owner.query(
      'UPDATE core.workspace SET "deletedAt" = now() WHERE id = $1',
      [workspaceId],
    );

    await expect(
      apiKeyService.create({
        name: 'After Workspace Delete',
        expiresAt: new Date('2027-12-01T00:00:00.000Z'),
        workspaceId,
        roleId: apiKeyAssignableRoleId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow('API key create audit workspace unavailable');

    await expect(
      apiKeyService.update(
        created.id,
        workspaceId,
        { name: 'Update After Workspace Delete' },
        identity(),
      ),
    ).rejects.toThrow('API key update audit workspace unavailable');
  });
});
