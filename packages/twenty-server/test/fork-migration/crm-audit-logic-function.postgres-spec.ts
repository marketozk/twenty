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
import { LogicFunctionExceptionCode } from 'src/engine/metadata-modules/logic-function/logic-function.exception';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

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
  [
    'src/engine/core-modules/application/application-exception-filter',
    ['ApplicationExceptionFilter'],
  ],
  [
    'src/engine/core-modules/application/application-registration/application-registration.entity',
    ['ApplicationRegistrationEntity'],
  ],
  [
    'src/engine/core-modules/cache-lock/cache-lock.service',
    ['CacheLockService'],
  ],
  [
    'src/engine/core-modules/event-logs/live/event-log-live.service',
    ['EventLogLiveService'],
  ],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  [
    'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
    ['PreventNestToAutoLogGraphqlErrorsFilter'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  ['src/engine/core-modules/logger/logger.service', ['LoggerService']],
  [
    'src/engine/core-modules/logic-function/logic-function-executor/logic-function-executor.service',
    ['LogicFunctionExecutorService'],
  ],
  [
    'src/engine/core-modules/logic-function/logic-function-resource/logic-function-resource.service',
    ['LogicFunctionResourceService'],
  ],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/core-modules/usage-limit/filters/usage-limit-graphql-api-exception.filter',
    ['UsageLimitGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/workflow/entities/workflow.entity',
    ['WorkflowEntity'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
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
  ['src/engine/subscriptions/subscription.service', ['SubscriptionService']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
    ['WorkspaceScopedRepository'],
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
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  ['src/engine/guards/application-target.guard', ['ApplicationTargetGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  [
    'src/engine/decorators/auth/application-target-arg.decorator',
    ['ApplicationTargetArg'],
  ],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { LogicFunctionFromSourceHelperService } =
  require('src/engine/metadata-modules/logic-function/services/logic-function-from-source-helper.service') as typeof import('src/engine/metadata-modules/logic-function/services/logic-function-from-source-helper.service');
const { LogicFunctionFromSourceService } =
  require('src/engine/metadata-modules/logic-function/services/logic-function-from-source.service') as typeof import('src/engine/metadata-modules/logic-function/services/logic-function-from-source.service');
const { LogicFunctionResolver } =
  require('src/engine/metadata-modules/logic-function/logic-function.resolver') as typeof import('src/engine/metadata-modules/logic-function/logic-function.resolver');
const { CodeStepBuildService } =
  require('src/modules/workflow/workflow-builder/workflow-version-step/code-step/services/code-step-build.service') as typeof import('src/modules/workflow/workflow-builder/workflow-version-step/code-step/services/code-step-build.service');
const { WorkflowCoreSyncService } =
  require('src/engine/core-modules/workflow/services/workflow-core-sync.service') as typeof import('src/engine/core-modules/workflow/services/workflow-core-sync.service');
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

const runtimeRole = `twenty_lf_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

describe('CRM audit logicFunction lifecycle and application cascade', () => {
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

      CREATE TABLE core."apiKey" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "revokedAt" timestamptz
      );

      CREATE TABLE core.workflow (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text,
        visibility text NOT NULL DEFAULT 'WORKSPACE',
        "createdByUserWorkspaceId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      );

      CREATE TABLE core."workflowVersion" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "coreWorkflowId" uuid REFERENCES core.workflow(id) ON DELETE CASCADE,
        steps jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      );

      CREATE TABLE core."logicFunction" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        description text,
        runtime text NOT NULL DEFAULT 'nodejs22.x',
        "timeoutSeconds" integer NOT NULL DEFAULT 300,
        "sourceHandlerPath" text NOT NULL,
        "builtHandlerPath" text NOT NULL,
        "handlerName" text NOT NULL,
        checksum text,
        "isBuildUpToDate" boolean NOT NULL DEFAULT true,
        "executionMode" text NOT NULL DEFAULT 'LIVE',
        "cronTriggerSettings" jsonb,
        "databaseEventTriggerSettings" jsonb,
        "httpRouteTriggerSettings" jsonb,
        "serverRouteTriggerSettings" jsonb,
        "toolTriggerSettings" jsonb,
        "workflowActionTriggerSettings" jsonb,
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
        core."logicFunction",
        core."workflowVersion",
        core.workflow,
        core."apiKey",
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

    const sourceFiles = new Map<string, string>();
    const builtFiles = new Map<string, string>();

    const buildMapsFromDb = async () => {
      const lfRows = await ownerDataSource.query(
        `SELECT * FROM core."logicFunction" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const wfRows = await ownerDataSource.query(
        `SELECT * FROM core.workflow WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const wvRows = await ownerDataSource.query(
        `SELECT * FROM core."workflowVersion" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );

      const flatLogicFunctionMaps = {
        byUniversalIdentifier: Object.fromEntries(
          lfRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              name: row.name,
              description: row.description ?? null,
              runtime: row.runtime,
              timeoutSeconds: Number(row.timeoutSeconds),
              sourceHandlerPath: row.sourceHandlerPath,
              builtHandlerPath: row.builtHandlerPath,
              handlerName: row.handlerName,
              checksum: row.checksum ?? null,
              isBuildUpToDate: Boolean(row.isBuildUpToDate),
              executionMode: row.executionMode,
              cronTriggerSettings: row.cronTriggerSettings ?? null,
              databaseEventTriggerSettings:
                row.databaseEventTriggerSettings ?? null,
              httpRouteTriggerSettings: row.httpRouteTriggerSettings ?? null,
              serverRouteTriggerSettings:
                row.serverRouteTriggerSettings ?? null,
              toolTriggerSettings: row.toolTriggerSettings ?? null,
              workflowActionTriggerSettings:
                row.workflowActionTriggerSettings ?? null,
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
          lfRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          lfRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      const flatWorkflowMaps = {
        byUniversalIdentifier: Object.fromEntries(
          wfRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              name: row.name ?? null,
              visibility: row.visibility,
              createdByUserWorkspaceId: row.createdByUserWorkspaceId ?? null,
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          wfRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          wfRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      const flatWorkflowVersionMaps = {
        byUniversalIdentifier: Object.fromEntries(
          wvRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              coreWorkflowId: row.coreWorkflowId?.toLowerCase() ?? null,
              steps: row.steps ?? [],
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          wvRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          wvRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      return {
        flatLogicFunctionMaps,
        flatWorkflowMaps,
        flatWorkflowVersionMaps,
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
    const cacheService = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest
        .fn()
        .mockImplementation(async () => ({
          ...(await buildMapsFromDb()),
          flatApplicationMaps,
        })),
      invalidateFlatEntityMaps: invalidateCacheMock,
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
          action: Record<string, any>;
          context: {
            queryRunner: QueryRunner;
            allFlatEntityMaps: Record<string, any>;
            flatApplication: { id: string; universalIdentifier: string };
          };
        }) => {
          const { queryRunner, allFlatEntityMaps, flatApplication } = context;
          if (action.metadataName === 'logicFunction') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core."logicFunction" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, description, runtime, "timeoutSeconds",
                   "sourceHandlerPath", "builtHandlerPath", "handlerName",
                   checksum, "isBuildUpToDate", "executionMode",
                   "cronTriggerSettings", "databaseEventTriggerSettings",
                   "httpRouteTriggerSettings", "serverRouteTriggerSettings",
                   "toolTriggerSettings", "workflowActionTriggerSettings"
                 ) VALUES (
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                   $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb
                 )`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.description ?? null,
                  fe.runtime ?? 'nodejs22.x',
                  Number(fe.timeoutSeconds ?? 300),
                  fe.sourceHandlerPath,
                  fe.builtHandlerPath,
                  fe.handlerName,
                  fe.checksum ?? null,
                  Boolean(fe.isBuildUpToDate ?? true),
                  fe.executionMode ?? 'LIVE',
                  fe.cronTriggerSettings
                    ? JSON.stringify(fe.cronTriggerSettings)
                    : null,
                  fe.databaseEventTriggerSettings
                    ? JSON.stringify(fe.databaseEventTriggerSettings)
                    : null,
                  fe.httpRouteTriggerSettings
                    ? JSON.stringify(fe.httpRouteTriggerSettings)
                    : null,
                  fe.serverRouteTriggerSettings
                    ? JSON.stringify(fe.serverRouteTriggerSettings)
                    : null,
                  fe.toolTriggerSettings
                    ? JSON.stringify(fe.toolTriggerSettings)
                    : null,
                  fe.workflowActionTriggerSettings
                    ? JSON.stringify(fe.workflowActionTriggerSettings)
                    : null,
                ],
              );
              allFlatEntityMaps.flatLogicFunctionMaps.byUniversalIdentifier[
                fe.universalIdentifier.toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatLogicFunctionMaps?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update ?? {};
              const nextJson = (key: string) => {
                const val = key in upd ? upd[key] : existing[key];
                return val === null || val === undefined
                  ? null
                  : JSON.stringify(val);
              };
              await queryRunner.query(
                `UPDATE core."logicFunction"
                 SET name=$1, description=$2, "timeoutSeconds"=$3,
                     "sourceHandlerPath"=$4, "builtHandlerPath"=$5, "handlerName"=$6,
                     checksum=$7, "isBuildUpToDate"=$8, "executionMode"=$9,
                     "cronTriggerSettings"=$10::jsonb,
                     "databaseEventTriggerSettings"=$11::jsonb,
                     "httpRouteTriggerSettings"=$12::jsonb,
                     "serverRouteTriggerSettings"=$13::jsonb,
                     "toolTriggerSettings"=$14::jsonb,
                     "workflowActionTriggerSettings"=$15::jsonb,
                     "updatedAt"=now()
                 WHERE id=$16 AND "workspaceId"=$17`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'description' in upd ? upd.description : existing.description,
                  'timeoutSeconds' in upd
                    ? Number(upd.timeoutSeconds)
                    : existing.timeoutSeconds,
                  'sourceHandlerPath' in upd
                    ? upd.sourceHandlerPath
                    : existing.sourceHandlerPath,
                  'builtHandlerPath' in upd
                    ? upd.builtHandlerPath
                    : existing.builtHandlerPath,
                  'handlerName' in upd ? upd.handlerName : existing.handlerName,
                  'checksum' in upd ? upd.checksum : existing.checksum,
                  'isBuildUpToDate' in upd
                    ? Boolean(upd.isBuildUpToDate)
                    : existing.isBuildUpToDate,
                  'executionMode' in upd
                    ? upd.executionMode
                    : existing.executionMode,
                  nextJson('cronTriggerSettings'),
                  nextJson('databaseEventTriggerSettings'),
                  nextJson('httpRouteTriggerSettings'),
                  nextJson('serverRouteTriggerSettings'),
                  nextJson('toolTriggerSettings'),
                  nextJson('workflowActionTriggerSettings'),
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatLogicFunctionMaps?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."logicFunction" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (
            action.metadataName === 'workflow' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatWorkflowMaps?.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core.workflow WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'workflowVersion' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatWorkflowVersionMaps?.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core."workflowVersion" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
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
      const actions: Record<string, any>[] = [];
      for (const [metadataName, ops] of Object.entries(
        allFlatEntityOperationByMetadataName,
      )) {
        for (const fe of ops.flatEntityToDelete ?? []) {
          actions.push({
            type: 'delete',
            metadataName,
            universalIdentifier: fe.universalIdentifier,
          });
          if (metadataName === 'workflow') {
            for (const wv of Object.values(
              currentMaps.flatWorkflowVersionMaps.byUniversalIdentifier,
            ) as Record<string, any>[]) {
              if (wv.coreWorkflowId === fe.id) {
                actions.push({
                  type: 'delete',
                  metadataName: 'workflowVersion',
                  universalIdentifier: wv.universalIdentifier,
                });
                for (const step of wv.steps ?? []) {
                  if (step?.type === 'CODE') {
                    const lfId = step.settings?.input?.logicFunctionId;
                    const lfUid =
                      currentMaps.flatLogicFunctionMaps.universalIdentifierById[
                        lfId
                      ];
                    if (lfUid) {
                      actions.push({
                        type: 'delete',
                        metadataName: 'logicFunction',
                        universalIdentifier: lfUid,
                      });
                    }
                  }
                }
              }
            }
          }
        }
        for (const fe of ops.flatEntityToUpdate ?? []) {
          const existing =
            currentMaps.flatLogicFunctionMaps?.byUniversalIdentifier[
              fe.universalIdentifier.toLowerCase()
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'name',
            'description',
            'timeoutSeconds',
            'checksum',
            'sourceHandlerPath',
            'builtHandlerPath',
            'handlerName',
            'isBuildUpToDate',
            'executionMode',
            'cronTriggerSettings',
            'databaseEventTriggerSettings',
            'httpRouteTriggerSettings',
            'serverRouteTriggerSettings',
            'toolTriggerSettings',
            'workflowActionTriggerSettings',
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

    const resourceServiceMock = {
      seedSourceFiles: jest
        .fn()
        .mockImplementation(
          async ({
            sourceHandlerPath,
            builtHandlerPath,
          }: {
            sourceHandlerPath: string;
            builtHandlerPath: string;
          }) => {
            sourceFiles.set(
              sourceHandlerPath,
              'export const main = async () => ({ ok: true });',
            );
            builtFiles.set(
              builtHandlerPath,
              'export const main = async () => ({ ok: true });',
            );
            return {
              handlerName: 'main',
              checksum: 'md5_seed_initial_checksum_111',
            };
          },
        ),
      uploadSourceFile: jest
        .fn()
        .mockImplementation(
          async ({
            sourceHandlerPath,
            sourceHandlerCode,
          }: {
            sourceHandlerPath: string;
            sourceHandlerCode: string;
          }) => {
            sourceFiles.set(sourceHandlerPath, sourceHandlerCode);
          },
        ),
      getSourceFile: jest
        .fn()
        .mockImplementation(
          async ({ sourceHandlerPath }: { sourceHandlerPath: string }) =>
            sourceFiles.get(sourceHandlerPath) ??
            'export const main = async () => ({ rebuilt: true });',
        ),
      uploadBuiltFile: jest
        .fn()
        .mockImplementation(
          async ({
            builtHandlerPath,
            builtCode,
          }: {
            builtHandlerPath: string;
            builtCode: string;
          }) => {
            builtFiles.set(builtHandlerPath, builtCode);
          },
        ),
      copyResources: jest
        .fn()
        .mockImplementation(
          async ({
            fromSourceHandlerPath,
            toSourceHandlerPath,
            fromBuiltHandlerPath,
            toBuiltHandlerPath,
          }: {
            fromSourceHandlerPath: string;
            toSourceHandlerPath: string;
            fromBuiltHandlerPath: string;
            toBuiltHandlerPath: string;
          }) => {
            sourceFiles.set(
              toSourceHandlerPath,
              sourceFiles.get(fromSourceHandlerPath) ?? '',
            );
            builtFiles.set(
              toBuiltHandlerPath,
              builtFiles.get(fromBuiltHandlerPath) ?? '',
            );
          },
        ),
    };

    const executorServiceMock = {
      transpile: jest
        .fn()
        .mockImplementation(async ({ sourceCode }: { sourceCode: string }) => ({
          builtCode: `/* transpiled */\n${sourceCode}`,
        })),
      execute: jest.fn().mockResolvedValue({
        data: { executed: true },
        logs: '',
        duration: 12,
        status: 'SUCCESS',
      }),
    };

    const helperService = new LogicFunctionFromSourceHelperService(
      applicationServiceMock as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      { exists: jest.fn().mockResolvedValue(true) } as never,
    );

    const logicFunctionFromSourceService = new LogicFunctionFromSourceService(
      executorServiceMock as never,
      resourceServiceMock as never,
      applicationServiceMock as never,
      helperService,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
    );

    const logicFunctionResolver = new LogicFunctionResolver(
      logicFunctionFromSourceService,
      helperService,
      cacheService as never,
      {} as never,
      {} as never,
    );

    const codeStepBuildService = new CodeStepBuildService(
      cacheService as never,
      logicFunctionFromSourceService,
      helperService,
    );

    const workflowCoreSyncService = new WorkflowCoreSyncService(
      {
        find: jest
          .fn()
          .mockImplementation(async (wsId: string) =>
            ownerDataSource.query(
              `SELECT id FROM core.workflow WHERE "workspaceId"=$1`,
              [wsId],
            ),
          ),
      } as never,
      {} as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      applicationServiceMock as never,
      cacheService as never,
      {
        withLock: jest.fn(async (fn: () => Promise<unknown>) => fn()),
      } as never,
    );

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      flatApplicationMaps,
      helperService,
      logicFunctionFromSourceService,
      logicFunctionResolver,
      codeStepBuildService,
      workflowCoreSyncService,
    };
  };

  it('audits logicFunction create, update, no-op update, execute rebuild, code step prebuilt switch, workflow cascade delete, and direct delete', async () => {
    const {
      helperService,
      logicFunctionResolver,
      codeStepBuildService,
      workflowCoreSyncService,
      cacheService,
    } = buildHarness();

    // 1. Create logicFunction via LogicFunctionResolver under impersonation
    const created = await logicFunctionResolver.createOneLogicFunction(
      {
        name: 'sync-lead-webhook',
        description: 'Synchronizes inbound lead payload',
        timeoutSeconds: 300,
        toolTriggerSettings: {
          isTool: true,
        } as never,
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

    expect(created.name).toBe('sync-lead-webhook');
    expect(created.timeoutSeconds).toBe(300);

    // 2. Update logicFunction via LogicFunctionResolver under apiKey (changes sourceHandlerCode -> sets isBuildUpToDate=false)
    const updateOk = await logicFunctionResolver.updateOneLogicFunction(
      {
        id: created.id,
        update: {
          name: 'sync-lead-webhook-v2',
          description: 'Updated lead webhook description',
          timeoutSeconds: 120,
          sourceHandlerCode:
            'export const main = async () => ({ v: 2, secret: "top-secret-handler" });',
          cronTriggerSettings: {
            pattern: '0 */6 * * *',
          },
        },
      },
      { id: workspaceId } as never,
      undefined,
      { id: apiKeyId },
      {
        req: {
          apiKey: { id: apiKeyId },
        } as never,
      },
    );
    expect(updateOk).toBe(true);

    // 3. No-op update via helperService.updateOneFromMetadata produces 0 new audit entries
    const currentMaps =
      await cacheService.getOrRecomputeManyOrAllFlatEntityMaps();
    const currentFlat = Object.values(
      currentMaps.flatLogicFunctionMaps.byUniversalIdentifier,
    ).find((f: any) => f.id === created.id) as any;

    const countBeforeNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    await helperService.updateOneFromMetadata({
      flatLogicFunctionToUpdate: { ...currentFlat },
      workspaceId,
      applicationUniversalIdentifier: customApplicationUniversalId,
      defaultSystemActorId: 'test:noop',
    });
    const countAfterNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    expect(countAfterNoOp).toBe(countBeforeNoOp);

    // 4. executeOneLogicFunction rebuilds stale function (isBuildUpToDate false -> true) and audits the build update
    const execResult = await logicFunctionResolver.executeOneLogicFunction(
      {
        id: created.id,
        payload: { leadId: 'lead-1' } as never,
      },
      { id: workspaceId } as never,
      { id: ownerUserId } as never,
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
    expect(execResult.status).toBe('SUCCESS');

    // 5. Create a CODE step logic function via CodeStepBuildService, switch to PREBUILT, and cascade-delete via WorkflowCoreSyncService.deleteFromCore
    const codeStepLogicFunctionId = randomUUID().toLowerCase();
    await codeStepBuildService.createCodeStepLogicFunction({
      logicFunctionId: codeStepLogicFunctionId,
      workspaceId,
    });
    const stepsWithCode = [
      {
        id: 'step-code-1',
        name: 'Code Step',
        type: 'CODE',
        valid: true,
        nextStepIds: [],
        settings: {
          input: {
            logicFunctionId: codeStepLogicFunctionId,
            logicFunctionInput: {},
          },
          outputSchema: {},
          errorHandlingOptions: {
            retryOnFailure: { value: false },
            continueOnFailure: { value: false },
          },
        },
      },
    ];
    await codeStepBuildService.switchCodeStepLogicFunctionsToPrebuilt({
      workspaceId,
      steps: stepsWithCode as never,
    });

    const workflowId = randomUUID().toLowerCase();
    const workflowUniversalId = randomUUID().toLowerCase();
    const workflowVersionId = randomUUID().toLowerCase();
    const workflowVersionUniversalId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core.workflow (id, "workspaceId", "applicationId", "universalIdentifier", name)
       VALUES ($1,$2,$3,$4,'Code Workflow')`,
      [workflowId, workspaceId, customApplicationId, workflowUniversalId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."workflowVersion" (
         id, "workspaceId", "applicationId", "universalIdentifier", "coreWorkflowId", steps
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        workflowVersionId,
        workspaceId,
        customApplicationId,
        workflowVersionUniversalId,
        workflowId,
        JSON.stringify(stepsWithCode),
      ],
    );

    await workflowCoreSyncService.deleteFromCore(workspaceId, [workflowId], {
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
        userWorkspaceId: ownerUserWorkspaceId,
      },
    });

    const remainingCodeLf = await ownerDataSource.query(
      `SELECT id FROM core."logicFunction" WHERE id=$1`,
      [codeStepLogicFunctionId],
    );
    expect(remainingCodeLf).toHaveLength(0);

    // 6. Direct delete via LogicFunctionResolver.deleteOneLogicFunction
    const deleted = await logicFunctionResolver.deleteOneLogicFunction(
      { id: created.id },
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
    expect(deleted.id).toBe(created.id);

    // Non-existent logicFunction rejects before migration
    await expect(
      logicFunctionResolver.deleteOneLogicFunction(
        { id: randomUUID().toLowerCase() },
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
    ).rejects.toMatchObject({
      extensions: {
        code: 'NOT_FOUND',
      },
    });

    const entries = await ownerDataSource.query(
      `SELECT "operationId", "resourceKind", "resourceId", action,
              actor, initiator, "securityDescriptor", "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(entries).toHaveLength(7);

    const rawText = JSON.stringify(entries);
    expect(rawText).not.toContain('sync-lead-webhook');
    expect(rawText).not.toContain('md5_seed_initial_checksum_111');
    expect(rawText).not.toContain('0 */6 * * *');

    expect(entries[0]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'logicFunction',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'builtHandlerPath',
          'checksum',
          'cronTriggerSettings',
          'databaseEventTriggerSettings',
          'description',
          'executionMode',
          'handlerName',
          'httpRouteTriggerSettings',
          'isBuildUpToDate',
          'name',
          'runtime',
          'serverRouteTriggerSettings',
          'sourceHandlerPath',
          'timeoutSeconds',
          'toolTriggerSettings',
          'workflowActionTriggerSettings',
        ],
        values: {
          applicationId: { before: null, after: customApplicationId },
          executionMode: { before: null, after: 'LIVE' },
          isBuildUpToDate: { before: null, after: true },
          runtime: { before: null, after: 'nodejs22.x' },
          timeoutSeconds: { before: null, after: 300 },
        },
      },
    });

    expect(entries[1]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: [
          'cronTriggerSettings',
          'description',
          'isBuildUpToDate',
          'name',
          'timeoutSeconds',
        ],
        values: {
          isBuildUpToDate: { before: true, after: false },
          timeoutSeconds: { before: 300, after: 120 },
        },
      },
    });

    expect(entries[2]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['checksum', 'isBuildUpToDate'],
        values: {
          isBuildUpToDate: { before: false, after: true },
        },
      },
    });

    expect(entries[3]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: codeStepLogicFunctionId,
      action: 'create',
      actor: { kind: 'system', id: 'code-step-build:create' },
      redactedDiff: {
        values: {
          applicationId: { before: null, after: customApplicationId },
          executionMode: { before: null, after: 'LIVE' },
          isBuildUpToDate: { before: null, after: true },
          runtime: { before: null, after: 'nodejs22.x' },
          timeoutSeconds: { before: null, after: 300 },
        },
      },
    });

    expect(entries[4]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: codeStepLogicFunctionId,
      action: 'update',
      actor: { kind: 'system', id: 'code-step-build:switch-to-prebuilt' },
      redactedDiff: {
        changedFields: ['executionMode'],
        values: {
          executionMode: { before: 'LIVE', after: 'PREBUILT' },
        },
      },
    });

    expect(entries[5]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: codeStepLogicFunctionId,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        values: {
          applicationId: { before: customApplicationId, after: null },
          executionMode: { before: 'PREBUILT', after: null },
          isBuildUpToDate: { before: true, after: null },
          runtime: { before: 'nodejs22.x', after: null },
          timeoutSeconds: { before: 300, after: null },
        },
      },
    });

    expect(entries[6]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        values: {
          applicationId: { before: customApplicationId, after: null },
          executionMode: { before: 'LIVE', after: null },
          isBuildUpToDate: { before: true, after: null },
          runtime: { before: 'nodejs22.x', after: null },
          timeoutSeconds: { before: 120, after: null },
        },
      },
    });
  });

  it('audits logicFunction create/update/delete in application metadata migrations, enforces application delete barriers, and blocks unaudited runner calls', async () => {
    const { runnerService, cacheService, flatApplicationMaps } = buildHarness();

    const lfId = randomUUID().toLowerCase();
    const lfUniversalId = randomUUID().toLowerCase();

    // 1. Unaudited WorkspaceMigrationRunnerService.run touching logicFunction fails closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'logicFunction',
              id: lfId,
              flatEntity: {
                id: lfId,
                universalIdentifier: lfUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'unaudited-fn',
                description: null,
                runtime: 'nodejs22.x',
                timeoutSeconds: 60,
                sourceHandlerPath: 'src/fn.ts',
                builtHandlerPath: 'dist/fn.mjs',
                handlerName: 'main',
                checksum: 'chk_0',
                isBuildUpToDate: true,
                executionMode: 'PREBUILT',
                cronTriggerSettings: null,
                databaseEventTriggerSettings: null,
                httpRouteTriggerSettings: null,
                serverRouteTriggerSettings: null,
                toolTriggerSettings: null,
                workflowActionTriggerSettings: null,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Audited manifest migration creates logicFunction
    const capturedCreateOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(capturedCreateOp, {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
      }),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'create',
                metadataName: 'logicFunction',
                id: lfId,
                flatEntity: {
                  id: lfId,
                  universalIdentifier: lfUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'enrich-company-webhook',
                  description: 'Enriches company domain',
                  runtime: 'nodejs22.x',
                  timeoutSeconds: 180,
                  sourceHandlerPath: 'src/enrich/index.ts',
                  builtHandlerPath: 'dist/enrich/index.mjs',
                  handlerName: 'main',
                  checksum: 'md5_enrich_v1',
                  isBuildUpToDate: true,
                  executionMode: 'PREBUILT',
                  cronTriggerSettings: null,
                  databaseEventTriggerSettings: {
                    eventName: 'company.created',
                  },
                  httpRouteTriggerSettings: {
                    path: '/webhooks/enrich',
                    httpMethod: 'POST',
                    isAuthRequired: true,
                  },
                  serverRouteTriggerSettings: null,
                  toolTriggerSettings: null,
                  workflowActionTriggerSettings: null,
                },
              },
            ],
          } as never,
        }),
    );

    // 3. Audited manifest migration updates logicFunction
    const capturedUpdateOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(capturedUpdateOp, {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
      }),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'update',
                metadataName: 'logicFunction',
                universalIdentifier: lfUniversalId,
                update: {
                  description: 'Enriches company domain v2',
                  timeoutSeconds: 240,
                  checksum: 'md5_enrich_v2',
                  httpRouteTriggerSettings: {
                    path: '/webhooks/enrich-v2',
                    httpMethod: 'POST',
                    isAuthRequired: true,
                  },
                },
              },
            ],
          } as never,
        }),
    );

    // 4. Application delete barrier rejects while logicFunction row still exists
    const qrCheck = runtimeDataSource.createQueryRunner();
    await qrCheck.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          qrCheck,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await qrCheck.release();
    }

    const appDeleteAuditBlocked = captureOptionalApplicationDeleteAudit({
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
      runAuditedApplicationDelete(runtimeDataSource, appDeleteAuditBlocked, {
        applicationId: thirdPartyApplicationId,
        work: async (runner) => {
          await runner.query(
            `DELETE FROM core.application WHERE id=$1 AND "workspaceId"=$2`,
            [thirdPartyApplicationId, workspaceId],
          );
        },
      }),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // 5. Uninstall via isSystemBuild: true deletes logicFunction
    const mapsBeforeUninstall =
      await cacheService.getOrRecomputeManyOrAllFlatEntityMaps();
    const validateBuildAndRunService =
      new WorkspaceMigrationValidateBuildAndRunService(
        runnerService,
        {
          buildWorkspaceMigration: jest.fn().mockResolvedValue({
            status: 'success',
            workspaceMigration: {
              applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
              actions: [
                {
                  type: 'delete',
                  metadataName: 'logicFunction',
                  universalIdentifier: lfUniversalId,
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

    await validateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
      {
        allFlatEntityOperationByMetadataName: {
          logicFunction: {
            flatEntityToCreate: [],
            flatEntityToUpdate: [],
            flatEntityToDelete: [
              mapsBeforeUninstall.flatLogicFunctionMaps.byUniversalIdentifier[
                lfUniversalId
              ],
            ],
          },
        } as never,
        workspaceId,
        isSystemBuild: true,
        applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
      },
    );

    // 6. Now application delete succeeds cleanly
    const appDeleteAuditOk = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await runAuditedApplicationDelete(runtimeDataSource, appDeleteAuditOk, {
      applicationId: thirdPartyApplicationId,
      work: async (runner) => {
        await runner.query(
          `DELETE FROM core.application WHERE id=$1 AND "workspaceId"=$2`,
          [thirdPartyApplicationId, workspaceId],
        );
      },
    });

    const entries = await ownerDataSource.query(
      `SELECT "operationId", "resourceKind", "resourceId", action, actor, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: lfId,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          executionMode: { before: null, after: 'PREBUILT' },
          isBuildUpToDate: { before: null, after: true },
          runtime: { before: null, after: 'nodejs22.x' },
          timeoutSeconds: { before: null, after: 180 },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: lfId,
      action: 'update',
      redactedDiff: {
        changedFields: [
          'checksum',
          'description',
          'httpRouteTriggerSettings',
          'timeoutSeconds',
        ],
        values: {
          timeoutSeconds: { before: 180, after: 240 },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'logicFunction',
      resourceId: lfId,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workspace-migration:system-build',
      },
      redactedDiff: {
        values: {
          applicationId: { before: thirdPartyApplicationId, after: null },
          executionMode: { before: 'PREBUILT', after: null },
          isBuildUpToDate: { before: true, after: null },
          runtime: { before: 'nodejs22.x', after: null },
          timeoutSeconds: { before: 240, after: null },
        },
      },
    });
  });

  it('rolls back logicFunction mutation when a post-flush trigger mutates core.logicFunction and surfaces NativeTransactionOutcomeUnknownError without ROLLBACK on lost COMMIT acknowledgement', async () => {
    const { runnerService } = buildHarness();

    const triggerLfId = randomUUID().toLowerCase();
    const triggerLfUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.corrupt_logic_function_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'logicFunction' THEN
          UPDATE core."logicFunction"
          SET "timeoutSeconds" = 899
          WHERE id = (NEW."resourceId")::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_logic_function_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_logic_function_after_audit();
    `);

    try {
      const getTriggerAudit = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'logicFunction',
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedLogicFunctionCreateIds: [triggerLfId],
      });

      await expect(
        withNavigationMenuItemAudit(getTriggerAudit(), () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'logicFunction',
                  id: triggerLfId,
                  flatEntity: {
                    id: triggerLfId,
                    universalIdentifier: triggerLfUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'tampered-lf',
                    description: null,
                    runtime: 'nodejs22.x',
                    timeoutSeconds: 300,
                    sourceHandlerPath: 'src/tampered.ts',
                    builtHandlerPath: 'dist/tampered.mjs',
                    handlerName: 'main',
                    checksum: 'chk_tampered',
                    isBuildUpToDate: true,
                    executionMode: 'LIVE',
                  },
                },
              ],
            } as never,
          }),
        ),
      ).rejects.toThrow('Logic function state changed during audit flush');

      const lfRows = await ownerDataSource.query(
        `SELECT id FROM core."logicFunction" WHERE id=$1`,
        [triggerLfId],
      );
      expect(lfRows).toHaveLength(0);
    } finally {
      await ownerDataSource.query(`
        DROP TRIGGER IF EXISTS trg_corrupt_logic_function_after_audit ON crm_audit."crmAuditEntry";
        DROP FUNCTION IF EXISTS crm_audit.corrupt_logic_function_after_audit();
      `);
    }

    const realCreateQueryRunner =
      runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    let rollbackCalled = false;
    const createQueryRunnerSpy = jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementation(() => {
        const qr = realCreateQueryRunner();
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
              if (sql === 'ROLLBACK') {
                rollbackCalled = true;
              }
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
      const lostCommitLfId = randomUUID().toLowerCase();
      const lostCommitLfUniversalId = randomUUID().toLowerCase();
      const getLostCommitAudit = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'logicFunction',
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedLogicFunctionCreateIds: [lostCommitLfId],
      });

      await expect(
        withNavigationMenuItemAudit(getLostCommitAudit(), () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'logicFunction',
                  id: lostCommitLfId,
                  flatEntity: {
                    id: lostCommitLfId,
                    universalIdentifier: lostCommitLfUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'lost-commit-lf',
                    description: null,
                    runtime: 'nodejs22.x',
                    timeoutSeconds: 300,
                    sourceHandlerPath: 'src/lost.ts',
                    builtHandlerPath: 'dist/lost.mjs',
                    handlerName: 'main',
                    checksum: 'chk_lost',
                    isBuildUpToDate: true,
                    executionMode: 'LIVE',
                  },
                },
              ],
            } as never,
          }),
        ),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
      expect(rollbackCalled).toBe(false);
    } finally {
      createQueryRunnerSpy.mockRestore();
    }
  });
});
