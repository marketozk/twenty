import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureOptionalApplicationDeleteAudit,
  runAuditedApplicationDelete,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';
import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: {
    WEBHOOK: 'WEBHOOK',
  },
  isAiModelTier: jest.fn(() => true),
}));
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/core-resolver.decorator',
  () => ({
    CoreResolver: () => () => {},
  }),
);
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  ['src/engine/core-modules/logger/logger.service', ['LoggerService']],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-rest-api-exception.filter',
    ['AuthRestApiExceptionFilter'],
  ],
  ['src/engine/api/rest/rest-api-exception.filter', ['RestApiExceptionFilter']],
  [
    'src/engine/metadata-modules/flat-entity/filters/flat-entity-maps-rest-api-exception.filter',
    ['FlatEntityMapsRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-rest-api-exception.filter',
    ['PermissionsRestApiExceptionFilter'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/filters/workspace-migration-runner-rest-api-exception.filter',
    ['WorkspaceMigrationRunnerRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
  ],
  [
    'src/engine/metadata-modules/metadata-side-effect/services/metadata-side-effect-engine.service',
    ['MetadataSideEffectEngineService'],
  ],
  [
    'src/engine/subscriptions/metadata-event/metadata-event-emitter',
    ['MetadataEventEmitter'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-build-orchestrator.service',
    ['WorkspaceMigrationBuildOrchestratorService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-flat-entity-maps.service',
    ['WorkspaceMigrationFlatEntityMapsService'],
  ],
  [
    'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    ['WorkspaceMetadataVersionService'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/interceptors/workspace-migration-graphql-api-exception.interceptor',
    ['WorkspaceMigrationGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/metadata-modules/webhook/interceptors/webhook-graphql-api-exception.interceptor',
    ['WebhookGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    ['InFlightDeferredWorkspaceMigrationActionsService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    ['WorkspaceMigrationRunnerActionHandlerRegistryService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    ['DeferredWorkspaceMigrationActionRunnerService'],
  ],
  ['src/engine/guards/jwt-auth.guard', ['JwtAuthGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { WebhookService } =
  require('src/engine/metadata-modules/webhook/webhook.service') as typeof import('src/engine/metadata-modules/webhook/webhook.service');
const { WebhookResolver } =
  require('src/engine/metadata-modules/webhook/webhook.resolver') as typeof import('src/engine/metadata-modules/webhook/webhook.resolver');
const { WebhookController } =
  require('src/engine/metadata-modules/webhook/controllers/webhook.controller') as typeof import('src/engine/metadata-modules/webhook/controllers/webhook.controller');
const { CreateWebhookTool } =
  require('src/engine/metadata-modules/webhook/tools/create-webhook.tool') as typeof import('src/engine/metadata-modules/webhook/tools/create-webhook.tool');
const { UpdateWebhookTool } =
  require('src/engine/metadata-modules/webhook/tools/update-webhook.tool') as typeof import('src/engine/metadata-modules/webhook/tools/update-webhook.tool');
const { DeleteWebhookTool } =
  require('src/engine/metadata-modules/webhook/tools/delete-webhook.tool') as typeof import('src/engine/metadata-modules/webhook/tools/delete-webhook.tool');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { WorkspaceMigrationValidateBuildAndRunService } =
  require('src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service') as typeof import('src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service');

jest.setTimeout(120000);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated fork test database required');
}

const STANDARD_APPLICATION_UNIVERSAL_ID =
  '20202020-64aa-4b6f-b003-9c74b97cee20';

const runtimeRole = `twenty_wh_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const workspaceId = randomUUID().toLowerCase();
const workspaceSchema = `workspace_${workspaceId.replace(/-/g, '')}`;
const standardApplicationId = randomUUID().toLowerCase();
const customApplicationId = randomUUID().toLowerCase();
const customApplicationUniversalId = randomUUID().toLowerCase();
const thirdPartyApplicationId = randomUUID().toLowerCase();
const thirdPartyApplicationUniversalId = randomUUID().toLowerCase();

const ownerUserId = randomUUID().toLowerCase();
const ownerUserWorkspaceId = randomUUID().toLowerCase();
const ownerWorkspaceMemberId = randomUUID().toLowerCase();

const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();

const agentId = randomUUID().toLowerCase();
const agentUniversalId = randomUUID().toLowerCase();
const apiKeyId = randomUUID().toLowerCase();

const createDataSource = (url: string) =>
  new DataSource({
    type: 'postgres',
    url,
    extra: { max: 8 },
  });

const withRole = (url: string, username: string) => {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = 'twenty_test_pw';
  return parsed.toString();
};

const quoteIdent = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

describe('CRM audit webhook lifecycle and application cascade', () => {
  let ownerDataSource: DataSource;
  let runtimeDataSource: DataSource;

  beforeAll(async () => {
    ownerDataSource = createDataSource(databaseUrl);
    await ownerDataSource.initialize();

    await ownerDataSource.query(
      `DROP SCHEMA IF EXISTS core CASCADE;
       DROP SCHEMA IF EXISTS crm_audit CASCADE;
       DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
       CREATE SCHEMA core;
       CREATE SCHEMA "${workspaceSchema}";`,
    );

    await ownerDataSource.query(`
      CREATE TABLE core.workspace (
        id uuid PRIMARY KEY,
        "defaultRoleId" uuid,
        "deletedAt" timestamptz
      );

      CREATE TABLE core."user" (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        "canImpersonate" boolean NOT NULL DEFAULT false,
        "canAccessFullAdminPanel" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz
      );

      CREATE TABLE core."userWorkspace" (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "deletedAt" timestamptz
      );

      CREATE TABLE "${workspaceSchema}"."workspaceMember" (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL,
        "deletedAt" timestamptz
      );

      CREATE TABLE core.application (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "defaultRoleId" uuid,
        "deletedAt" timestamptz
      );

      CREATE TABLE core.agent (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "deletedAt" timestamptz
      );

      CREATE TABLE core."apiKey" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "revokedAt" timestamptz
      );

      CREATE TABLE core."navigationMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "userWorkspaceId" uuid,
        "folderId" uuid,
        "viewId" uuid,
        "targetObjectMetadataId" uuid,
        "targetRecordId" uuid,
        "pageLayoutId" uuid,
        "agentChatChannelId" uuid,
        type text NOT NULL,
        name text,
        link text,
        icon text,
        color text,
        position double precision NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core.webhook (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "targetUrl" text NOT NULL,
        operations text[] NOT NULL DEFAULT ARRAY['*.*'],
        description text,
        secret text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      );
    `);

    await ownerDataSource.transaction((manager) =>
      new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
    );

    await ownerDataSource.query(
      `DROP ROLE IF EXISTS ${quoteIdent(runtimeRole)};
       CREATE ROLE ${quoteIdent(runtimeRole)} LOGIN PASSWORD 'twenty_test_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
       GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO ${quoteIdent(runtimeRole)};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, "${workspaceSchema}" TO ${quoteIdent(runtimeRole)};
       GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO ${quoteIdent(runtimeRole)};`,
    );

    runtimeDataSource = createDataSource(withRole(databaseUrl, runtimeRole));
    await runtimeDataSource.initialize();
  });

  afterAll(async () => {
    if (runtimeDataSource?.isInitialized) {
      await runtimeDataSource.destroy();
    }
    if (ownerDataSource?.isInitialized) {
      await ownerDataSource.query(
        `DROP SCHEMA IF EXISTS core CASCADE;
         DROP SCHEMA IF EXISTS crm_audit CASCADE;
         DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
         REASSIGN OWNED BY ${quoteIdent(runtimeRole)} TO CURRENT_USER;
         DROP OWNED BY ${quoteIdent(runtimeRole)};
         DROP ROLE IF EXISTS ${quoteIdent(runtimeRole)};`,
      );
      await ownerDataSource.destroy();
    }
  });

  beforeEach(async () => {
    await ownerDataSource.query(`
      TRUNCATE TABLE
        crm_audit."crmAuditEntry",
        core.webhook,
        core."navigationMenuItem",
        core."apiKey",
        core.agent,
        core.application,
        "${workspaceSchema}"."workspaceMember",
        core."userWorkspace",
        core."user",
        core.workspace
      CASCADE;
    `);

    await ownerDataSource.query(`INSERT INTO core.workspace (id) VALUES ($1)`, [
      workspaceId,
    ]);
    await ownerDataSource.query(
      `INSERT INTO core."user" (id, email) VALUES
         ($1, 'owner@example.com'),
         ($2, 'impersonator@example.com')`,
      [ownerUserId, impersonatorUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId") VALUES
         ($1, $2, $3),
         ($4, $5, $3)`,
      [
        ownerUserWorkspaceId,
        ownerUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId") VALUES ($1, $2)`,
      [ownerWorkspaceMemberId, ownerUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core.application (id, "workspaceId", "universalIdentifier") VALUES
         ($1, $2, $3),
         ($4, $2, $5),
         ($6, $2, $7)`,
      [
        standardApplicationId,
        workspaceId,
        STANDARD_APPLICATION_UNIVERSAL_ID,
        customApplicationId,
        customApplicationUniversalId,
        thirdPartyApplicationId,
        thirdPartyApplicationUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier")
       VALUES ($1, $2, $3, $4)`,
      [agentId, workspaceId, customApplicationId, agentUniversalId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."apiKey" (id, "workspaceId") VALUES ($1, $2)`,
      [apiKeyId, workspaceId],
    );
  });

  const buildHarness = () => {
    const appUniversalById: Record<string, string> = {
      [standardApplicationId]: STANDARD_APPLICATION_UNIVERSAL_ID,
      [customApplicationId]: customApplicationUniversalId,
      [thirdPartyApplicationId]: thirdPartyApplicationUniversalId,
    };

    const buildMapsFromDb = async () => {
      const webhookRows = await ownerDataSource.query(
        `SELECT * FROM core.webhook WHERE "workspaceId"=$1 AND "deletedAt" IS NULL ORDER BY id`,
        [workspaceId],
      );
      const flatWebhookMaps = {
        byUniversalIdentifier: Object.fromEntries(
          webhookRows.map((row: any) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              targetUrl: row.targetUrl,
              operations: row.operations,
              description: row.description ?? null,
              secret: row.secret,
              createdAt:
                row.createdAt instanceof Date
                  ? row.createdAt.toISOString()
                  : String(row.createdAt),
              updatedAt:
                row.updatedAt instanceof Date
                  ? row.updatedAt.toISOString()
                  : String(row.updatedAt),
              deletedAt: null,
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          webhookRows.map((row: any) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          webhookRows.map((row: any) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      return {
        flatWebhookMaps,
        flatRoleMaps: {
          byUniversalIdentifier: {},
          idByUniversalIdentifier: {},
          universalIdentifierById: {},
          universalIdentifiersByApplicationId: {},
        },
        flatRoleTargetMaps: {
          byUniversalIdentifier: {},
          idByUniversalIdentifier: {},
          universalIdentifierById: {},
          universalIdentifiersByApplicationId: {},
        },
        flatAgentMaps: {
          byUniversalIdentifier: {},
          idByUniversalIdentifier: {},
          universalIdentifierById: {},
          universalIdentifiersByApplicationId: {},
        },
        flatNavigationMenuItemMaps: {
          byUniversalIdentifier: {},
          idByUniversalIdentifier: {},
          universalIdentifierById: {},
          universalIdentifiersByApplicationId: {},
        },
      };
    };

    const invalidateCacheMock = jest.fn().mockResolvedValue(undefined);
    const cacheService = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest
        .fn()
        .mockImplementation(() => buildMapsFromDb()),
      invalidateFlatEntityMaps: invalidateCacheMock,
    };

    const flatApplicationMaps = {
      idByUniversalIdentifier: {
        [customApplicationUniversalId]: customApplicationId,
        [STANDARD_APPLICATION_UNIVERSAL_ID]: standardApplicationId,
        [thirdPartyApplicationUniversalId]: thirdPartyApplicationId,
      },
      byId: {
        [customApplicationId]: {
          id: customApplicationId,
          universalIdentifier: customApplicationUniversalId,
          workspaceId,
        },
        [standardApplicationId]: {
          id: standardApplicationId,
          universalIdentifier: STANDARD_APPLICATION_UNIVERSAL_ID,
          workspaceId,
        },
        [thirdPartyApplicationId]: {
          id: thirdPartyApplicationId,
          universalIdentifier: thirdPartyApplicationUniversalId,
          workspaceId,
        },
      },
    };
    const workspaceCacheService = {
      getOrRecompute: jest.fn().mockImplementation(async () => ({
        ...(await buildMapsFromDb()),
        flatApplicationMaps,
      })),
      invalidateAndRecompute: invalidateCacheMock,
    };

    const actionHandlerRegistry = {
      executeActionHandler: jest.fn().mockImplementation(
        async ({
          action,
          context,
        }: {
          action: any;
          context: {
            queryRunner: QueryRunner;
            allFlatEntityMaps: any;
            flatApplication: { id: string; universalIdentifier: string };
          };
        }) => {
          const { queryRunner, allFlatEntityMaps, flatApplication } = context;
          if (action.metadataName === 'webhook') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core.webhook (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "targetUrl", operations, description, secret
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.targetUrl,
                  fe.operations ?? ['*.*'],
                  fe.description ?? null,
                  fe.secret ?? 'generated-secret',
                ],
              );
              allFlatEntityMaps.flatWebhookMaps.byUniversalIdentifier[
                fe.universalIdentifier
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatWebhookMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              const upd = action.update ?? {};
              await queryRunner.query(
                `UPDATE core.webhook
                 SET "targetUrl"=$1, operations=$2, description=$3, secret=$4, "updatedAt"=now()
                 WHERE id=$5 AND "workspaceId"=$6`,
                [
                  'targetUrl' in upd ? upd.targetUrl : existing.targetUrl,
                  'operations' in upd ? upd.operations : existing.operations,
                  'description' in upd ? upd.description : existing.description,
                  'secret' in upd ? upd.secret : existing.secret,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatWebhookMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              await queryRunner.query(
                `DELETE FROM core.webhook WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          }
          return {
            partialOptimisticCache: {},
            metadataEvents: [],
            deferredActions: [],
          };
        },
      ),
      executeActionRollbackHandler: jest.fn().mockResolvedValue(undefined),
    };

    const runnerService = new WorkspaceMigrationRunnerService(
      cacheService as never,
      runtimeDataSource,
      actionHandlerRegistry as never,
      { incrementMetadataVersion: jest.fn() } as never,
      workspaceCacheService as never,
      { recordHistogram: jest.fn() } as never,
      {
        perfTime: jest.fn(),
        perfTimeEnd: jest.fn(),
        perf: jest.fn(),
        error: jest.fn(),
      } as never,
      { get: jest.fn() } as never,
      { getWorkspaceFeatureFlagsMap: jest.fn().mockResolvedValue({}) } as never,
      {
        persist: jest.fn().mockResolvedValue(undefined),
        dispatchAfterCommit: jest.fn().mockResolvedValue(undefined),
        enqueue: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        executeWithPendingDeferredActions: jest.fn(
          async (_wsId: string, fn: () => Promise<unknown>) => fn(),
        ),
      } as never,
    );

    const buildActionsFromMatrice = async (
      allFlatEntityOperationByMetadataName: Record<string, any>,
    ) => {
      const currentMaps = await buildMapsFromDb();
      const actions: any[] = [];
      for (const [metadataName, ops] of Object.entries(
        allFlatEntityOperationByMetadataName,
      )) {
        for (const fe of ops.flatEntityToDelete ?? []) {
          actions.push({
            type: 'delete',
            metadataName,
            universalIdentifier: fe.universalIdentifier,
          });
        }
        for (const fe of ops.flatEntityToUpdate ?? []) {
          const existing =
            currentMaps.flatWebhookMaps?.byUniversalIdentifier[
              fe.universalIdentifier
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'targetUrl',
            'operations',
            'description',
            'secret',
          ]) {
            if (
              key in fe &&
              JSON.stringify(fe[key]) !== JSON.stringify(existing[key])
            ) {
              update[key] = fe[key];
            }
          }
          if (Object.keys(update).length > 0) {
            actions.push({
              type: 'update',
              metadataName,
              universalIdentifier: fe.universalIdentifier,
              update,
            });
          }
        }
        for (const fe of ops.flatEntityToCreate ?? []) {
          actions.push({
            type: 'create',
            metadataName,
            id: fe.id ?? randomUUID().toLowerCase(),
            flatEntity: fe,
          });
        }
      }
      return actions;
    };

    const validateBuildAndRunMock = jest
      .fn()
      .mockImplementation(
        async ({
          allFlatEntityOperationByMetadataName,
          workspaceId: wsId,
          applicationUniversalIdentifier,
        }: {
          allFlatEntityOperationByMetadataName: Record<string, any>;
          workspaceId: string;
          applicationUniversalIdentifier: string;
        }) => {
          const actions = await buildActionsFromMatrice(
            allFlatEntityOperationByMetadataName,
          );
          if (actions.length > 0) {
            await runnerService.run({
              workspaceId: wsId,
              workspaceMigration: {
                applicationUniversalIdentifier,
                actions,
              } as never,
            });
          }
          return {
            status: 'success',
            workspaceMigration: {
              applicationUniversalIdentifier,
              actions,
            },
            hasSchemaMetadataChanged: false,
          };
        },
      );

    const applicationServiceMock = {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
        .fn()
        .mockResolvedValue({
          workspaceCustomFlatApplication: {
            id: customApplicationId,
            universalIdentifier: customApplicationUniversalId,
            workspaceId,
          },
          twentyStandardFlatApplication: {
            id: standardApplicationId,
            universalIdentifier: STANDARD_APPLICATION_UNIVERSAL_ID,
            workspaceId,
          },
        }),
    };

    const webhookService = new WebhookService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
    );
    const webhookResolver = new WebhookResolver(webhookService);
    const webhookController = new WebhookController(webhookService);
    const createWebhookTool = new CreateWebhookTool(webhookService);
    const updateWebhookTool = new UpdateWebhookTool(webhookService);
    const deleteWebhookTool = new DeleteWebhookTool(webhookService);

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      flatApplicationMaps,
      applicationServiceMock,
      validateBuildAndRunMock,
      webhookService,
      webhookResolver,
      webhookController,
      createWebhookTool,
      updateWebhookTool,
      deleteWebhookTool,
    };
  };

  it('audits webhook create, update, no-op update, and delete across resolver, controller, and AI tools with secret/URL redaction', async () => {
    const {
      webhookResolver,
      webhookController,
      createWebhookTool,
      updateWebhookTool,
      deleteWebhookTool,
    } = buildHarness();

    // 1. Create webhook via GraphQL resolver under impersonation
    const created = await webhookResolver.createWebhook(
      {
        targetUrl: 'https://hooks.example.com/crm?token=top-secret-url-token',
        operations: ['person.created', 'company.updated'],
        description: 'Outbound CRM sync webhook',
        secret: 'whsec_initial_super_secret_123',
      },
      { id: workspaceId } as never,
      ownerUserWorkspaceId,
      undefined,
      {
        req: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
          userWorkspaceId: ownerUserWorkspaceId,
          impersonationContext: {
            impersonatorUserWorkspaceId,
          },
        },
      },
    );

    expect(created.targetUrl).toBe(
      'https://hooks.example.com/crm?token=top-secret-url-token',
    );
    expect(created.operations).toEqual(['person.created', 'company.updated']);

    // 2. Update webhook via REST controller (authenticated via apiKey)
    const updatedViaController = await webhookController.update(
      created.id,
      {
        targetUrl: 'https://hooks.example.com/v2/crm',
        operations: ['person.created', 'person.deleted'],
        secret: 'whsec_rotated_secret_456',
      },
      { id: workspaceId } as never,
      {
        apiKey: { id: apiKeyId },
      } as never,
    );
    expect(updatedViaController.targetUrl).toBe(
      'https://hooks.example.com/v2/crm',
    );
    expect(updatedViaController.operations).toEqual([
      'person.created',
      'person.deleted',
    ]);

    // 3. No-op update produces 0 additional audit entries
    const countBeforeNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    await webhookResolver.updateWebhook(
      {
        id: created.id,
        update: {
          targetUrl: 'https://hooks.example.com/v2/crm',
          operations: ['person.created', 'person.deleted'],
        },
      },
      { id: workspaceId } as never,
      ownerUserWorkspaceId,
      undefined,
      {
        req: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
          userWorkspaceId: ownerUserWorkspaceId,
        },
      },
    );
    const countAfterNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    expect(countAfterNoOp).toBe(countBeforeNoOp);

    // 4. Delete first webhook via REST controller
    const removed = await webhookController.remove(
      created.id,
      { id: workspaceId } as never,
      {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
        userWorkspaceId: ownerUserWorkspaceId,
      } as never,
    );
    expect(removed).toBe(true);

    // 5. Create, update, and delete a second webhook via AI tools with agent attribution
    const toolCreated = await createWebhookTool.execute({
      input: {
        targetUrl: 'https://ai-hooks.example.com/events',
        operations: [
          { kind: 'record', object: 'person', event: 'created' },
          { kind: 'metadata', metadataName: 'workflow', operation: 'updated' },
        ],
        description: 'AI tool webhook',
        secret: 'whsec_ai_tool_secret_789',
      },
      context: {
        workspaceId,
        userWorkspaceId: ownerUserWorkspaceId,
        userId: ownerUserId,
        agentId,
        actorContext: {
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      } as never,
    });
    expect(toolCreated.success).toBe(true);
    const toolWebhookId = (toolCreated.result as { id: string }).id;

    const toolUpdated = await updateWebhookTool.execute({
      input: {
        id: toolWebhookId,
        description: 'AI tool webhook updated',
      },
      context: {
        workspaceId,
        userWorkspaceId: ownerUserWorkspaceId,
        userId: ownerUserId,
        agentId,
      } as never,
    });
    expect(toolUpdated.success).toBe(true);

    const toolDeleted = await deleteWebhookTool.execute({
      input: {
        id: toolWebhookId,
      },
      context: {
        workspaceId,
        userWorkspaceId: ownerUserWorkspaceId,
        userId: ownerUserId,
        agentId,
      } as never,
    });
    expect(toolDeleted.success).toBe(true);

    const audits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action,actor,initiator,"redactedDiff","securityDescriptor"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(audits).toHaveLength(6);

    expect(audits[0]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'webhook',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'description',
          'operations',
          'secret',
          'targetUrl',
        ],
        values: {
          applicationId: { before: null, after: customApplicationId },
        },
      },
    });
    expect(audits[0].redactedDiff.values.targetUrl).toBeUndefined();
    expect(audits[0].redactedDiff.values.operations).toBeUndefined();
    expect(audits[0].redactedDiff.values.description).toBeUndefined();
    expect(audits[0].redactedDiff.values.secret).toBeUndefined();
    expect(JSON.stringify(audits[0])).not.toContain('top-secret-url-token');
    expect(JSON.stringify(audits[0])).not.toContain(
      'whsec_initial_super_secret_123',
    );

    expect(audits[1]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['operations', 'secret', 'targetUrl'],
        values: {},
      },
    });
    expect(JSON.stringify(audits[1])).not.toContain('whsec_rotated_secret_456');

    expect(audits[2]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'description',
          'operations',
          'secret',
          'targetUrl',
        ],
        values: {
          applicationId: { before: customApplicationId, after: null },
        },
      },
    });

    expect(audits[3]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: toolWebhookId,
      action: 'create',
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
    });
    expect(audits[4]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: toolWebhookId,
      action: 'update',
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'coreUser', id: ownerUserId },
      redactedDiff: {
        changedFields: ['description'],
        values: {},
      },
    });
    expect(audits[5]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: toolWebhookId,
      action: 'delete',
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'coreUser', id: ownerUserId },
    });
  });

  it('audits application metadata migrations, system builds, and blocks application deletion until webhook rows are removed', async () => {
    const { runnerService, flatApplicationMaps } = buildHarness();

    const appWebhookId = randomUUID().toLowerCase();
    const appWebhookUniversalId = randomUUID().toLowerCase();

    // 1. Create webhook in thirdPartyApplication via withApplicationMetadataAudit
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(
        captureApplicationMetadataAuditOperation({
          workspaceId,
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        }),
        {
          applicationId: thirdPartyApplicationId,
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
        },
      ),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'create',
                metadataName: 'webhook',
                id: appWebhookId,
                flatEntity: {
                  id: appWebhookId,
                  universalIdentifier: appWebhookUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  targetUrl: 'https://third-party.example.com/webhook',
                  operations: ['company.created'],
                  description: 'App webhook',
                  secret: 'whsec_app_secret_1',
                },
              },
            ],
          } as never,
        }),
    );

    // 2. Update webhook via withApplicationMetadataAudit
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(
        captureApplicationMetadataAuditOperation({
          workspaceId,
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        }),
        {
          applicationId: thirdPartyApplicationId,
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
        },
      ),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'update',
                metadataName: 'webhook',
                universalIdentifier: appWebhookUniversalId,
                update: {
                  targetUrl: 'https://third-party.example.com/v2/webhook',
                  operations: ['company.created', 'company.updated'],
                },
              },
            ],
          } as never,
        }),
    );

    // 3. assertNoRemainingApplicationRoleOrPermissionMetadata and runAuditedApplicationDelete block while webhook remains
    const runner = runtimeDataSource.createQueryRunner();
    await runner.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          runner,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await runner.release();
    }

    const deleteAppRequest = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await expect(
      runAuditedApplicationDelete(runtimeDataSource, deleteAppRequest, {
        applicationId: thirdPartyApplicationId,
        work: async (qr) => {
          await qr.query(`DELETE FROM core.application WHERE id=$1`, [
            thirdPartyApplicationId,
          ]);
        },
      }),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // 4. Delete webhook via withApplicationMetadataAudit (as ApplicationSyncService.uninstallApplication does), then delete application
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(
        captureApplicationMetadataAuditOperation({
          workspaceId,
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        }),
        {
          applicationId: thirdPartyApplicationId,
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
        },
      ),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName: 'webhook',
                universalIdentifier: appWebhookUniversalId,
              },
            ],
          } as never,
        }),
    );

    const deleteAppRequestAfter = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await runAuditedApplicationDelete(
      runtimeDataSource,
      deleteAppRequestAfter,
      {
        applicationId: thirdPartyApplicationId,
        work: async (qr) => {
          await qr.query(`DELETE FROM core.application WHERE id=$1`, [
            thirdPartyApplicationId,
          ]);
        },
      },
    );

    // 5. System build auto-wraps webhook migration in system application metadata audit
    const sysWebhookId = randomUUID().toLowerCase();
    const sysWebhookUniversalId = randomUUID().toLowerCase();
    const validateBuildAndRunService =
      new WorkspaceMigrationValidateBuildAndRunService(
        runnerService,
        {
          buildWorkspaceMigration: jest.fn().mockResolvedValue({
            status: 'success',
            workspaceMigration: {
              applicationUniversalIdentifier: STANDARD_APPLICATION_UNIVERSAL_ID,
              actions: [
                {
                  type: 'create',
                  metadataName: 'webhook',
                  id: sysWebhookId,
                  flatEntity: {
                    id: sysWebhookId,
                    universalIdentifier: sysWebhookUniversalId,
                    applicationUniversalIdentifier:
                      STANDARD_APPLICATION_UNIVERSAL_ID,
                    targetUrl: 'https://standard.example.com/webhook',
                    operations: ['*.*'],
                    description: null,
                    secret: 'whsec_system_secret',
                  },
                },
              ],
            },
          }),
        } as never,
        {
          getOrRecomputeAllRelatedFlatEntityMaps: jest.fn().mockResolvedValue({
            flatApplicationMaps,
            allRelatedFlatEntityMaps: {},
            allMetadataNameCacheToCompute: [],
          }),
          computeFromToAllFlatEntityMapsAndBuildOptions: jest
            .fn()
            .mockReturnValue({
              fromToAllFlatEntityMaps: {},
              inferDeletionFromMissingEntities: false,
              dependencyAllFlatEntityMaps: {},
              additionalCacheDataMaps: {},
              idByUniversalIdentifierByMetadataName: {},
            }),
        } as never,
        { emitMetadataEvents: jest.fn() } as never,
        { expandWithSideEffects: jest.fn() } as never,
        { recordHistogram: jest.fn() } as never,
        {
          perf: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
        } as never,
        { get: jest.fn().mockReturnValue([]) } as never,
      );

    const sysResult =
      await validateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
        {
          workspaceId,
          isSystemBuild: true,
          applicationUniversalIdentifier: STANDARD_APPLICATION_UNIVERSAL_ID,
          allFlatEntityOperationByMetadataName: {
            webhook: {
              flatEntityToCreate: [
                {
                  id: sysWebhookId,
                  universalIdentifier: sysWebhookUniversalId,
                  applicationUniversalIdentifier:
                    STANDARD_APPLICATION_UNIVERSAL_ID,
                  targetUrl: 'https://standard.example.com/webhook',
                  operations: ['*.*'],
                  description: null,
                  secret: 'whsec_system_secret',
                } as never,
              ],
              flatEntityToUpdate: [],
              flatEntityToDelete: [],
            },
          },
        },
      );
    expect(sysResult.status).toBe('success');

    const audits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action,actor,"redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: appWebhookId,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
        },
      },
    });
    expect(audits[1]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: appWebhookId,
      action: 'update',
      redactedDiff: {
        changedFields: ['operations', 'targetUrl'],
        values: {},
      },
    });
    expect(audits[2]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: appWebhookId,
      action: 'delete',
      redactedDiff: {
        values: {
          applicationId: { before: thirdPartyApplicationId, after: null },
        },
      },
    });
    expect(audits[3]).toMatchObject({
      resourceKind: 'webhook',
      resourceId: sysWebhookId,
      action: 'create',
      actor: { kind: 'system', id: 'workspace-migration:system-build' },
      redactedDiff: {
        values: {
          applicationId: { before: null, after: standardApplicationId },
        },
      },
    });
  });

  it('enforces fail-closed barriers, rolls back on post-flush trigger corruption, and invalidates cache on NativeTransactionOutcomeUnknownError', async () => {
    const {
      runnerService,
      webhookService,
      webhookResolver,
      invalidateCacheMock,
    } = buildHarness();

    // 1. Unaudited runner execution touching webhook is rejected fail-closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'webhook',
              id: randomUUID().toLowerCase(),
              flatEntity: {
                universalIdentifier: randomUUID().toLowerCase(),
                applicationUniversalIdentifier: customApplicationUniversalId,
                targetUrl: 'https://unaudited.example.com/webhook',
                operations: ['*.*'],
                description: null,
                secret: 'whsec_unaudited',
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Unauthenticated WebhookService.create is rejected before any DB write
    await expect(
      webhookService.create(
        {
          targetUrl: 'https://unauth.example.com/webhook',
          operations: ['*.*'],
        },
        workspaceId,
      ),
    ).rejects.toThrow(
      'Navigation menu item mutation requires authenticated audit identity',
    );

    // 3. Reusing a one-shot NavigationMenuItemAuditRequest is rejected
    const getAudit = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'webhook',
      expectedWebhookCreateIds: [randomUUID().toLowerCase()],
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    const req = getAudit();
    await withNavigationMenuItemAudit(req, async () => undefined);
    await expect(
      withNavigationMenuItemAudit(req, async () => undefined),
    ).rejects.toThrow('Navigation menu item audit request cannot be reused');

    // 4. Post-flush trigger corruption rolls back both core.webhook and crm_audit."crmAuditEntry"
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_webhook_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'webhook' THEN
          UPDATE core.webhook
          SET "targetUrl" = 'https://tampered.example.com/evil'
          WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_webhook_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_webhook_after_audit();
    `);
    try {
      await expect(
        webhookResolver.createWebhook(
          {
            targetUrl: 'https://legit.example.com/webhook',
            operations: ['*.*'],
          },
          { id: workspaceId } as never,
          ownerUserWorkspaceId,
          undefined,
          {
            req: {
              user: { id: ownerUserId },
              workspaceMemberId: ownerWorkspaceMemberId,
              userWorkspaceId: ownerUserWorkspaceId,
            },
          },
        ),
      ).rejects.toThrow('Webhook state changed during audit flush');
    } finally {
      await ownerDataSource.query(`
        DROP TRIGGER IF EXISTS trg_corrupt_webhook_after_audit ON crm_audit."crmAuditEntry";
        DROP FUNCTION IF EXISTS core.corrupt_webhook_after_audit();
      `);
    }

    const webhooksAfterRollback = await ownerDataSource.query(
      `SELECT id FROM core.webhook WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(webhooksAfterRollback).toHaveLength(0);

    // 5. Lost COMMIT ACK (NativeTransactionOutcomeUnknownError) preserves committed row + audit and invalidates cache
    const originalCreateQueryRunner =
      runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    const createQueryRunnerSpy = jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementation(() => {
        const qr = originalCreateQueryRunner();
        const origConnect = qr.connect.bind(qr);
        qr.connect = async () => {
          const client = (await origConnect()) as {
            query: (sql: unknown, values?: unknown) => Promise<unknown>;
            __commitHooked?: boolean;
          };
          if (client && !client.__commitHooked) {
            client.__commitHooked = true;
            const origClientQuery = client.query.bind(client);
            client.query = async (sql: unknown, values?: unknown) => {
              const res = await origClientQuery(sql, values);
              if (sql === 'COMMIT') {
                throw new Error('terminating connection due to network drop');
              }
              return res;
            };
          }
          return client;
        };
        return qr;
      });

    try {
      await expect(
        webhookResolver.createWebhook(
          {
            targetUrl: 'https://commit-ack-lost.example.com/webhook',
            operations: ['person.created'],
            secret: 'whsec_commit_ack_lost',
          },
          { id: workspaceId } as never,
          ownerUserWorkspaceId,
          undefined,
          {
            req: {
              user: { id: ownerUserId },
              workspaceMemberId: ownerWorkspaceMemberId,
              userWorkspaceId: ownerUserWorkspaceId,
            },
          },
        ),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    } finally {
      createQueryRunnerSpy.mockRestore();
    }

    expect(invalidateCacheMock).toHaveBeenCalled();

    const committedWebhooks = await ownerDataSource.query(
      `SELECT id,"targetUrl" FROM core.webhook WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(committedWebhooks).toHaveLength(1);
    expect(committedWebhooks[0].targetUrl).toBe(
      'https://commit-ack-lost.example.com/webhook',
    );

    const committedAudits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(committedAudits).toEqual([
      {
        resourceKind: 'webhook',
        resourceId: committedWebhooks[0].id,
        action: 'create',
      },
    ]);
  });
});
