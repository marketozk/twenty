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
  reconcileApplicationRoleAndPermissionOperations,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureNavigationMenuItemAudit,
  resolveExpectedFrontComponentWidgetAvailability,
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { FrontComponentExceptionCode } from 'src/engine/metadata-modules/front-component/front-component.exception';
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
    'src/engine/core-modules/application/application-oauth/dtos/application-token-pair.dto',
    ['ApplicationTokenPairDTO'],
  ],
  [
    'src/engine/core-modules/application/application-variable/user-application-variable-value.service',
    ['UserApplicationVariableValueService'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable.service',
    ['ApplicationVariableEntityService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/application-token.service',
    ['ApplicationTokenService'],
  ],
  [
    'src/engine/core-modules/file-storage/services/file-storage.service',
    ['FileStorageService'],
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
    'src/engine/metadata-modules/front-component/interceptors/front-component-graphql-api-exception.interceptor',
    ['FrontComponentGraphqlApiExceptionInterceptor'],
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
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { FrontComponentService } =
  require('src/engine/metadata-modules/front-component/front-component.service') as typeof import('src/engine/metadata-modules/front-component/front-component.service');
const { FrontComponentResolver } =
  require('src/engine/metadata-modules/front-component/front-component.resolver') as typeof import('src/engine/metadata-modules/front-component/front-component.resolver');
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

const runtimeRole = `twenty_fc_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

const companyObjectId = randomUUID().toLowerCase();
const companyObjectUniversalId = randomUUID().toLowerCase();

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

describe('CRM audit frontComponent and settingsMenuItem lifecycle and application cascade', () => {
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

      CREATE TABLE core."objectMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL
      );

      CREATE TABLE core."frontComponent" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        description text,
        "sourceComponentPath" text NOT NULL,
        "builtComponentPath" text NOT NULL,
        "componentName" text NOT NULL,
        "builtComponentChecksum" text NOT NULL,
        "isHeadless" boolean NOT NULL DEFAULT false,
        "widgetAvailability" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "usesSdkClient" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core."settingsMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "frontComponentId" uuid NOT NULL REFERENCES core."frontComponent"(id) ON DELETE CASCADE,
        title text NOT NULL,
        icon text,
        position double precision NOT NULL DEFAULT 0,
        scope text NOT NULL DEFAULT 'WORKSPACE',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
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
        core."settingsMenuItem",
        core."frontComponent",
        core."objectMetadata",
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
    await ownerDataSource.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier") VALUES ($1, $2, $3, $4)`,
      [
        companyObjectId,
        workspaceId,
        standardApplicationId,
        companyObjectUniversalId,
      ],
    );
  });

  const buildHarness = () => {
    const appUniversalById: Record<string, string> = {
      [standardApplicationId]: STANDARD_APPLICATION_UNIVERSAL_ID,
      [customApplicationId]: customApplicationUniversalId,
      [thirdPartyApplicationId]: thirdPartyApplicationUniversalId,
    };

    const buildMapsFromDb = async () => {
      const fcRows = await ownerDataSource.query(
        `SELECT * FROM core."frontComponent" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const smiRows = await ownerDataSource.query(
        `SELECT * FROM core."settingsMenuItem" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const objRows = await ownerDataSource.query(
        `SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );

      const fcUniversalById: Record<string, string> = Object.fromEntries(
        fcRows.map((row: Record<string, any>) => [
          row.id.toLowerCase(),
          row.universalIdentifier.toLowerCase(),
        ]),
      );

      const flatFrontComponentMaps = {
        byUniversalIdentifier: Object.fromEntries(
          fcRows.map((row: Record<string, any>) => [
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
              sourceComponentPath: row.sourceComponentPath,
              builtComponentPath: row.builtComponentPath,
              componentName: row.componentName,
              builtComponentChecksum: row.builtComponentChecksum,
              isHeadless: Boolean(row.isHeadless),
              widgetAvailability: Array.isArray(row.widgetAvailability)
                ? row.widgetAvailability
                : [],
              universalWidgetAvailability: [],
              usesSdkClient: Boolean(row.usesSdkClient),
              createdAt:
                row.createdAt instanceof Date
                  ? row.createdAt.toISOString()
                  : String(row.createdAt),
              updatedAt:
                row.updatedAt instanceof Date
                  ? row.updatedAt.toISOString()
                  : String(row.updatedAt),
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          fcRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: fcUniversalById,
        universalIdentifiersByApplicationId: {},
      };

      const flatSettingsMenuItemMaps = {
        byUniversalIdentifier: Object.fromEntries(
          smiRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              frontComponentId: row.frontComponentId.toLowerCase(),
              frontComponentUniversalIdentifier:
                fcUniversalById[row.frontComponentId.toLowerCase()],
              title: row.title,
              icon: row.icon ?? null,
              position: Number(row.position),
              scope: row.scope,
              createdAt:
                row.createdAt instanceof Date
                  ? row.createdAt.toISOString()
                  : String(row.createdAt),
              updatedAt:
                row.updatedAt instanceof Date
                  ? row.updatedAt.toISOString()
                  : String(row.updatedAt),
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          smiRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          smiRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      const flatObjectMetadataMaps = {
        byUniversalIdentifier: Object.fromEntries(
          objRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
            },
          ]),
        ),
        idByUniversalIdentifier: Object.fromEntries(
          objRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          objRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      return {
        flatFrontComponentMaps,
        flatSettingsMenuItemMaps,
        flatObjectMetadataMaps,
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
          action: Record<string, any>;
          context: {
            queryRunner: QueryRunner;
            allFlatEntityMaps: Record<string, any>;
            flatApplication: { id: string; universalIdentifier: string };
          };
        }) => {
          const { queryRunner, allFlatEntityMaps, flatApplication } = context;
          if (action.metadataName === 'frontComponent') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const resolvedWidgets =
                resolveExpectedFrontComponentWidgetAvailability(
                  fe,
                  allFlatEntityMaps.flatObjectMetadataMaps
                    ?.byUniversalIdentifier ?? {},
                ) ?? [];
              await queryRunner.query(
                `INSERT INTO core."frontComponent" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, description, "sourceComponentPath", "builtComponentPath",
                   "componentName", "builtComponentChecksum",
                   "isHeadless", "widgetAvailability", "usesSdkClient"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11::jsonb,$12)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.description ?? null,
                  fe.sourceComponentPath,
                  fe.builtComponentPath,
                  fe.builtComponentChecksum,
                  Boolean(fe.isHeadless),
                  JSON.stringify(resolvedWidgets),
                  Boolean(fe.usesSdkClient),
                ],
              );
              await queryRunner.query(
                `UPDATE core."frontComponent" SET "componentName"=$1 WHERE id=$2`,
                [fe.componentName, id],
              );
              allFlatEntityMaps.flatFrontComponentMaps.byUniversalIdentifier[
                fe.universalIdentifier.toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
                widgetAvailability: resolvedWidgets,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatFrontComponentMaps?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update ?? {};
              const resolvedWidgets =
                resolveExpectedFrontComponentWidgetAvailability(
                  upd,
                  allFlatEntityMaps.flatObjectMetadataMaps
                    ?.byUniversalIdentifier ?? {},
                ) ?? existing.widgetAvailability;
              await queryRunner.query(
                `UPDATE core."frontComponent"
                 SET name=$1, description=$2, "sourceComponentPath"=$3, "builtComponentPath"=$4,
                     "componentName"=$5, "builtComponentChecksum"=$6, "isHeadless"=$7,
                     "widgetAvailability"=$8::jsonb, "usesSdkClient"=$9, "updatedAt"=now()
                 WHERE id=$10 AND "workspaceId"=$11`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'description' in upd ? upd.description : existing.description,
                  'sourceComponentPath' in upd
                    ? upd.sourceComponentPath
                    : existing.sourceComponentPath,
                  'builtComponentPath' in upd
                    ? upd.builtComponentPath
                    : existing.builtComponentPath,
                  'componentName' in upd
                    ? upd.componentName
                    : existing.componentName,
                  'builtComponentChecksum' in upd
                    ? upd.builtComponentChecksum
                    : existing.builtComponentChecksum,
                  'isHeadless' in upd ? upd.isHeadless : existing.isHeadless,
                  JSON.stringify(resolvedWidgets),
                  'usesSdkClient' in upd
                    ? upd.usesSdkClient
                    : existing.usesSdkClient,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatFrontComponentMaps?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."frontComponent" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (action.metadataName === 'settingsMenuItem') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const fcId =
                fe.frontComponentId ??
                allFlatEntityMaps.flatFrontComponentMaps?.byUniversalIdentifier[
                  fe.frontComponentUniversalIdentifier.toLowerCase()
                ]?.id;
              await queryRunner.query(
                `INSERT INTO core."settingsMenuItem" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "frontComponentId", title, icon, position, scope
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fcId,
                  fe.title,
                  fe.icon ?? null,
                  Number(fe.position ?? 0),
                  fe.scope ?? 'WORKSPACE',
                ],
              );
              allFlatEntityMaps.flatSettingsMenuItemMaps.byUniversalIdentifier[
                fe.universalIdentifier.toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
                frontComponentId: fcId,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatSettingsMenuItemMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update ?? {};
              const fcId =
                'frontComponentUniversalIdentifier' in upd
                  ? allFlatEntityMaps.flatFrontComponentMaps
                      ?.byUniversalIdentifier[
                      upd.frontComponentUniversalIdentifier.toLowerCase()
                    ]?.id
                  : 'frontComponentId' in upd
                    ? upd.frontComponentId
                    : existing.frontComponentId;
              await queryRunner.query(
                `UPDATE core."settingsMenuItem"
                 SET "frontComponentId"=$1, title=$2, icon=$3, position=$4, scope=$5, "updatedAt"=now()
                 WHERE id=$6 AND "workspaceId"=$7`,
                [
                  fcId,
                  'title' in upd ? upd.title : existing.title,
                  'icon' in upd ? upd.icon : existing.icon,
                  'position' in upd ? Number(upd.position) : existing.position,
                  'scope' in upd ? upd.scope : existing.scope,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatSettingsMenuItemMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."settingsMenuItem" WHERE id=$1 AND "workspaceId"=$2`,
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
        }
        for (const fe of ops.flatEntityToUpdate ?? []) {
          const existing =
            currentMaps.flatFrontComponentMaps?.byUniversalIdentifier[
              fe.universalIdentifier.toLowerCase()
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'name',
            'description',
            'builtComponentChecksum',
            'sourceComponentPath',
            'builtComponentPath',
            'componentName',
            'isHeadless',
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

    const frontComponentService = new FrontComponentService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
      {} as never,
      {} as never,
    );
    const frontComponentResolver = new FrontComponentResolver(
      frontComponentService,
      {} as never,
      {} as never,
      {} as never,
      workspaceCacheService as never,
    );

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      flatApplicationMaps,
      applicationServiceMock,
      validateBuildAndRunMock,
      frontComponentService,
      frontComponentResolver,
    };
  };

  it('audits frontComponent create, update, no-op update, system prefill create, and delete with cascade settingsMenuItem deletion via FrontComponentResolver and FrontComponentService', async () => {
    const { frontComponentResolver, frontComponentService } = buildHarness();

    // 1. Create frontComponent via GraphQL resolver under impersonation
    const created = await frontComponentResolver.createFrontComponent(
      {
        name: '  hello-world-panel  ',
        description: 'Custom greeting panel',
        sourceComponentPath: 'src/front-components/hello-world/index.tsx',
        builtComponentPath: 'dist/front-components/hello-world/index.mjs',
        componentName: 'HelloWorldPanel',
        builtComponentChecksum: 'sha256_initial_bundle_checksum_111',
        isHeadless: false,
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

    expect(created.name).toBe('hello-world-panel');
    expect(created.isHeadless).toBe(false);
    expect(created.usesSdkClient).toBe(false);

    // Attach a settingsMenuItem pointing to created.id so we can verify ON DELETE CASCADE audit
    const cascadedSettingsMenuItemId = randomUUID().toLowerCase();
    const cascadedSettingsMenuItemUniversalId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."settingsMenuItem" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "frontComponentId", title, icon, position, scope
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        cascadedSettingsMenuItemId,
        workspaceId,
        customApplicationId,
        cascadedSettingsMenuItemUniversalId,
        created.id,
        'Hello World Settings Tab',
        'IconSettings',
        12.5,
        'WORKSPACE',
      ],
    );

    // 2. Update frontComponent via GraphQL resolver authenticated by apiKey
    const updated = await frontComponentResolver.updateFrontComponent(
      {
        id: created.id,
        update: {
          name: 'hello-world-panel-v2',
          description: 'Updated greeting panel description',
          builtComponentChecksum: 'sha256_rotated_bundle_checksum_222',
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
    expect(updated.name).toBe('hello-world-panel-v2');
    expect(updated.builtComponentChecksum).toBe(
      'sha256_rotated_bundle_checksum_222',
    );

    // 3. No-op update produces 0 additional audit entries
    const countBeforeNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    await frontComponentResolver.updateFrontComponent(
      {
        id: created.id,
        update: {
          name: 'hello-world-panel-v2',
          builtComponentChecksum: 'sha256_rotated_bundle_checksum_222',
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

    // 4. System prefill create via FrontComponentService.createOne
    const prefilled = await frontComponentService.createOne({
      workspaceId,
      defaultSystemActorId: 'dev-seeder:prefill-front-component',
      input: {
        name: 'show-notification',
        description: 'Headless notification trigger',
        sourceComponentPath: 'seed/show-notification/index.tsx',
        builtComponentPath: 'seed/show-notification/index.mjs',
        componentName: 'ShowNotification',
        builtComponentChecksum: 'sha256_seed_checksum_333',
        isHeadless: true,
      },
    });
    expect(prefilled.isHeadless).toBe(true);

    // 5. Delete frontComponent via GraphQL resolver -> cascades settingsMenuItem deletion in same operation
    const deleted = await frontComponentResolver.deleteFrontComponent(
      created.id,
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

    const remainingSmi = await ownerDataSource.query(
      `SELECT id FROM core."settingsMenuItem" WHERE id=$1`,
      [cascadedSettingsMenuItemId],
    );
    expect(remainingSmi).toHaveLength(0);

    // Non-existent frontComponent rejects before opening migration
    await expect(
      frontComponentResolver.deleteFrontComponent(
        randomUUID().toLowerCase(),
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
      code: FrontComponentExceptionCode.FRONT_COMPONENT_NOT_FOUND,
    });

    const entries = await ownerDataSource.query(
      `SELECT "operationId", "resourceKind", "resourceId", action,
              actor, initiator, "securityDescriptor", "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(entries).toHaveLength(5);

    const rawText = JSON.stringify(entries);
    expect(rawText).not.toContain('hello-world-panel');
    expect(rawText).not.toContain('sha256_initial_bundle_checksum_111');
    expect(rawText).not.toContain('sha256_rotated_bundle_checksum_222');
    expect(rawText).not.toContain('Hello World Settings Tab');

    expect(entries[0]).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'frontComponent',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'builtComponentChecksum',
          'builtComponentPath',
          'componentName',
          'description',
          'isHeadless',
          'name',
          'sourceComponentPath',
          'usesSdkClient',
          'widgetAvailability',
        ],
        values: {
          applicationId: { before: null, after: customApplicationId },
          isHeadless: { before: null, after: false },
          usesSdkClient: { before: null, after: false },
        },
      },
    });

    expect(entries[1]).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['builtComponentChecksum', 'description', 'name'],
        values: {},
      },
    });

    expect(entries[2]).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: prefilled.id,
      action: 'create',
      actor: { kind: 'system', id: 'dev-seeder:prefill-front-component' },
      redactedDiff: {
        values: {
          applicationId: { before: null, after: customApplicationId },
          isHeadless: { before: null, after: true },
          usesSdkClient: { before: null, after: false },
        },
      },
    });

    const deleteFcEntry = entries
      .slice(3)
      .find(
        (e: Record<string, unknown>) =>
          e.resourceKind === 'frontComponent' && e.resourceId === created.id,
      );
    const deleteSmiEntry = entries
      .slice(3)
      .find(
        (e: Record<string, unknown>) =>
          e.resourceKind === 'settingsMenuItem' &&
          e.resourceId === cascadedSettingsMenuItemId,
      );
    expect(deleteFcEntry).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        values: {
          applicationId: { before: customApplicationId, after: null },
          isHeadless: { before: false, after: null },
          usesSdkClient: { before: false, after: null },
        },
      },
    });
    expect(deleteSmiEntry).toMatchObject({
      operationId: deleteFcEntry.operationId,
      resourceKind: 'settingsMenuItem',
      resourceId: cascadedSettingsMenuItemId,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'frontComponentId',
          'icon',
          'position',
          'scope',
          'title',
        ],
        values: {
          applicationId: { before: customApplicationId, after: null },
          frontComponentId: { before: created.id, after: null },
          scope: { before: 'WORKSPACE', after: null },
        },
      },
    });
  });

  it('audits frontComponent and settingsMenuItem create/update/delete in application metadata migrations, enforces application delete barriers, and blocks unaudited runner calls', async () => {
    const { runnerService, cacheService, flatApplicationMaps } = buildHarness();

    const fcId1 = randomUUID().toLowerCase();
    const fcUniversalId1 = randomUUID().toLowerCase();
    const fcId2 = randomUUID().toLowerCase();
    const fcUniversalId2 = randomUUID().toLowerCase();
    const smiId = randomUUID().toLowerCase();
    const smiUniversalId = randomUUID().toLowerCase();

    // 1. Unaudited WorkspaceMigrationRunnerService.run touching frontComponent or settingsMenuItem fails closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'frontComponent',
              id: fcId1,
              flatEntity: {
                id: fcId1,
                universalIdentifier: fcUniversalId1,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'unaudited-fc',
                description: null,
                sourceComponentPath: 'src/fc.tsx',
                builtComponentPath: 'dist/fc.mjs',
                componentName: 'UnauditedFc',
                builtComponentChecksum: 'chk_0',
                isHeadless: false,
                universalWidgetAvailability: [],
                usesSdkClient: false,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'settingsMenuItem',
              id: smiId,
              flatEntity: {
                id: smiId,
                universalIdentifier: smiUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                frontComponentUniversalIdentifier: fcUniversalId1,
                title: 'Unaudited Settings',
                icon: 'IconSettings',
                position: 1,
                scope: 'WORKSPACE',
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Audited manifest migration creates 2 frontComponents + 1 settingsMenuItem
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
                metadataName: 'frontComponent',
                id: fcId1,
                flatEntity: {
                  id: fcId1,
                  universalIdentifier: fcUniversalId1,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'billing-settings-tab',
                  description: 'Workspace billing configuration UI',
                  sourceComponentPath: 'src/billing/index.tsx',
                  builtComponentPath: 'dist/billing/index.mjs',
                  componentName: 'BillingSettingsTab',
                  builtComponentChecksum: 'sha256_billing_v1',
                  isHeadless: false,
                  universalWidgetAvailability: [
                    {
                      pageLayoutType: 'RECORD_PAGE',
                      objectMetadataUniversalIdentifier:
                        companyObjectUniversalId,
                    },
                  ],
                  usesSdkClient: true,
                },
              },
              {
                type: 'create',
                metadataName: 'frontComponent',
                id: fcId2,
                flatEntity: {
                  id: fcId2,
                  universalIdentifier: fcUniversalId2,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'user-profile-extension',
                  description: null,
                  sourceComponentPath: 'src/profile/index.tsx',
                  builtComponentPath: 'dist/profile/index.mjs',
                  componentName: 'UserProfileExtension',
                  builtComponentChecksum: 'sha256_profile_v1',
                  isHeadless: false,
                  universalWidgetAvailability: [],
                  usesSdkClient: false,
                },
              },
              {
                type: 'create',
                metadataName: 'settingsMenuItem',
                id: smiId,
                flatEntity: {
                  id: smiId,
                  universalIdentifier: smiUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  frontComponentUniversalIdentifier: fcUniversalId1,
                  title: 'Billing & Usage',
                  icon: 'IconCreditCard',
                  position: 5,
                  scope: 'WORKSPACE',
                },
              },
            ],
          } as never,
        }),
    );

    // 3. Audited manifest migration updates frontComponent and settingsMenuItem (switching frontComponentUniversalIdentifier and scope)
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
                metadataName: 'frontComponent',
                universalIdentifier: fcUniversalId1,
                update: {
                  description: 'Updated billing UI v2',
                  usesSdkClient: false,
                  universalWidgetAvailability: [
                    { pageLayoutType: 'DASHBOARD' },
                  ],
                },
              },
              {
                type: 'update',
                metadataName: 'settingsMenuItem',
                universalIdentifier: smiUniversalId,
                update: {
                  frontComponentUniversalIdentifier: fcUniversalId2,
                  title: 'Personal Profile Extension',
                  icon: 'IconUser',
                  position: 10,
                  scope: 'USER',
                },
              },
            ],
          } as never,
        }),
    );

    // 4. Application delete barrier rejects while frontComponent or settingsMenuItem rows still exist
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

    // 5. Reconcile and uninstall via isSystemBuild: true (deleting fcId1 and fcId2 cascades smiId)
    const mapsBeforeUninstall =
      await cacheService.getOrRecomputeManyOrAllFlatEntityMaps();
    const uninstallRecord: Record<string, any> = {
      frontComponent: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [fcUniversalId1]:
            mapsBeforeUninstall.flatFrontComponentMaps.byUniversalIdentifier[
              fcUniversalId1
            ],
          [fcUniversalId2]:
            mapsBeforeUninstall.flatFrontComponentMaps.byUniversalIdentifier[
              fcUniversalId2
            ],
        },
      },
    };
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName: uninstallRecord,
      existingAllFlatEntityMaps: mapsBeforeUninstall,
    });
    expect(
      Object.keys(uninstallRecord.settingsMenuItem?.flatEntityToDelete ?? {}),
    ).toEqual([smiUniversalId]);

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
                  metadataName: 'settingsMenuItem',
                  universalIdentifier: smiUniversalId,
                },
                {
                  type: 'delete',
                  metadataName: 'frontComponent',
                  universalIdentifier: fcUniversalId1,
                },
                {
                  type: 'delete',
                  metadataName: 'frontComponent',
                  universalIdentifier: fcUniversalId2,
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
          settingsMenuItem: {
            flatEntityToCreate: [],
            flatEntityToUpdate: [],
            flatEntityToDelete: [
              mapsBeforeUninstall.flatSettingsMenuItemMaps
                .byUniversalIdentifier[smiUniversalId],
            ],
          },
          frontComponent: {
            flatEntityToCreate: [],
            flatEntityToUpdate: [],
            flatEntityToDelete: [
              mapsBeforeUninstall.flatFrontComponentMaps.byUniversalIdentifier[
                fcUniversalId1
              ],
              mapsBeforeUninstall.flatFrontComponentMaps.byUniversalIdentifier[
                fcUniversalId2
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
    expect(entries).toHaveLength(8);
    const findEntry = (
      resourceKind: string,
      resourceId: string,
      action: string,
    ) =>
      entries.find(
        (e: Record<string, unknown>) =>
          e.resourceKind === resourceKind &&
          e.resourceId === resourceId &&
          e.action === action,
      );

    expect(findEntry('frontComponent', fcId1, 'create')).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: fcId1,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          isHeadless: { before: null, after: false },
          usesSdkClient: { before: null, after: true },
        },
      },
    });
    expect(findEntry('frontComponent', fcId2, 'create')).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: fcId2,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          isHeadless: { before: null, after: false },
          usesSdkClient: { before: null, after: false },
        },
      },
    });
    expect(findEntry('settingsMenuItem', smiId, 'create')).toMatchObject({
      resourceKind: 'settingsMenuItem',
      resourceId: smiId,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          frontComponentId: { before: null, after: fcId1 },
          scope: { before: null, after: 'WORKSPACE' },
        },
      },
    });
    expect(findEntry('frontComponent', fcId1, 'update')).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: fcId1,
      action: 'update',
      redactedDiff: {
        changedFields: ['description', 'usesSdkClient', 'widgetAvailability'],
        values: {
          usesSdkClient: { before: true, after: false },
        },
      },
    });
    expect(findEntry('settingsMenuItem', smiId, 'update')).toMatchObject({
      resourceKind: 'settingsMenuItem',
      resourceId: smiId,
      action: 'update',
      redactedDiff: {
        changedFields: [
          'frontComponentId',
          'icon',
          'position',
          'scope',
          'title',
        ],
        values: {
          frontComponentId: { before: fcId1, after: fcId2 },
          scope: { before: 'WORKSPACE', after: 'USER' },
        },
      },
    });
    expect(findEntry('frontComponent', fcId1, 'delete')).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: fcId1,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workspace-migration:system-build',
      },
    });
    expect(findEntry('frontComponent', fcId2, 'delete')).toMatchObject({
      resourceKind: 'frontComponent',
      resourceId: fcId2,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workspace-migration:system-build',
      },
    });
    expect(findEntry('settingsMenuItem', smiId, 'delete')).toMatchObject({
      resourceKind: 'settingsMenuItem',
      resourceId: smiId,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'workspace-migration:system-build',
      },
    });
  });

  it('rolls back frontComponent mutation when a post-flush trigger mutates core.frontComponent and surfaces NativeTransactionOutcomeUnknownError without ROLLBACK on lost COMMIT acknowledgement', async () => {
    const { runnerService } = buildHarness();

    const triggerFcId = randomUUID().toLowerCase();
    const triggerFcUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.corrupt_front_component_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'frontComponent' THEN
          UPDATE core."frontComponent"
          SET "isHeadless" = NOT "isHeadless"
          WHERE id = (NEW."resourceId")::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_front_component_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_front_component_after_audit();
    `);

    try {
      const getTriggerAudit = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'frontComponent',
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedFrontComponentCreateIds: [triggerFcId],
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
                  metadataName: 'frontComponent',
                  id: triggerFcId,
                  flatEntity: {
                    id: triggerFcId,
                    universalIdentifier: triggerFcUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'tampered-fc',
                    description: null,
                    sourceComponentPath: 'src/tampered.tsx',
                    builtComponentPath: 'dist/tampered.mjs',
                    componentName: 'TamperedFc',
                    builtComponentChecksum: 'chk_tampered',
                    isHeadless: false,
                    universalWidgetAvailability: [],
                    usesSdkClient: false,
                  },
                },
              ],
            } as never,
          }),
        ),
      ).rejects.toThrow('Front component state changed during audit flush');

      const fcRows = await ownerDataSource.query(
        `SELECT id FROM core."frontComponent" WHERE id=$1`,
        [triggerFcId],
      );
      expect(fcRows).toHaveLength(0);
    } finally {
      await ownerDataSource.query(`
        DROP TRIGGER IF EXISTS trg_corrupt_front_component_after_audit ON crm_audit."crmAuditEntry";
        DROP FUNCTION IF EXISTS crm_audit.corrupt_front_component_after_audit();
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
      const lostCommitFcId = randomUUID().toLowerCase();
      const lostCommitFcUniversalId = randomUUID().toLowerCase();
      const getLostCommitAudit = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'frontComponent',
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedFrontComponentCreateIds: [lostCommitFcId],
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
                  metadataName: 'frontComponent',
                  id: lostCommitFcId,
                  flatEntity: {
                    id: lostCommitFcId,
                    universalIdentifier: lostCommitFcUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'lost-commit-fc',
                    description: null,
                    sourceComponentPath: 'src/lost.tsx',
                    builtComponentPath: 'dist/lost.mjs',
                    componentName: 'LostCommitFc',
                    builtComponentChecksum: 'chk_lost',
                    isHeadless: false,
                    universalWidgetAvailability: [],
                    usesSdkClient: false,
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
