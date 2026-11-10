import { randomUUID } from 'node:crypto';
import { CommandMenuItemAvailabilityType } from 'twenty-shared/types';
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
import { CommandMenuItemExceptionCode } from 'src/engine/metadata-modules/command-menu-item/command-menu-item.exception';
import { EngineComponentKey } from 'src/engine/metadata-modules/command-menu-item/enums/engine-component-key.enum';
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
    'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
    ['ApplicationTranslationCatalogService'],
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
    'src/engine/metadata-modules/command-menu-item/interceptors/command-menu-item-graphql-api-exception.interceptor',
    ['CommandMenuItemGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/core-modules/workflow/services/core-workflow-access.service',
    ['CoreWorkflowAccessService'],
  ],
  [
    'src/engine/metadata-modules/front-component/front-component.service',
    ['FrontComponentService'],
  ],
  [
    'src/engine/metadata-modules/front-component/dtos/front-component.dto',
    ['FrontComponentDTO'],
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
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { CommandMenuItemService } =
  require('src/engine/metadata-modules/command-menu-item/command-menu-item.service') as typeof import('src/engine/metadata-modules/command-menu-item/command-menu-item.service');
const { CommandMenuItemResolver } =
  require('src/engine/metadata-modules/command-menu-item/command-menu-item.resolver') as typeof import('src/engine/metadata-modules/command-menu-item/command-menu-item.resolver');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

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

const runtimeRole = `twenty_cmi_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
const frontComponentId = randomUUID().toLowerCase();
const frontComponentUniversalId = randomUUID().toLowerCase();
const pageLayoutId = randomUUID().toLowerCase();
const pageLayoutUniversalId = randomUUID().toLowerCase();

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

describe('CRM audit commandMenuItem lifecycle and cascades', () => {
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

      CREATE TABLE core."fieldMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        type text NOT NULL DEFAULT 'TEXT',
        name text NOT NULL DEFAULT 'name',
        label text NOT NULL DEFAULT 'Name',
        "isActive" boolean NOT NULL DEFAULT true,
        "isCustom" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "isSystemSideEffect" boolean NOT NULL DEFAULT false,
        "relationTargetObjectMetadataId" uuid,
        "relationTargetFieldMetadataId" uuid,
        "morphId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core."frontComponent" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL DEFAULT 'DialerFrontComponent',
        description text,
        "sourceComponentPath" text NOT NULL DEFAULT 'src/Dialer.tsx',
        "builtComponentPath" text NOT NULL DEFAULT 'dist/Dialer.mjs',
        "componentName" text NOT NULL DEFAULT 'DialerComponent',
        "builtComponentChecksum" text NOT NULL DEFAULT 'sha256-dialer',
        "isHeadless" boolean NOT NULL DEFAULT false,
        "widgetAvailability" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "usesSdkClient" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core."pageLayout" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "objectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT 'Standalone Layout',
        type text NOT NULL DEFAULT 'STANDALONE_PAGE',
        "deletedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core."navigationMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "userWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
        "targetRecordId" uuid,
        "targetObjectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "viewId" uuid,
        "folderId" uuid,
        "pageLayoutId" uuid REFERENCES core."pageLayout"(id) ON DELETE CASCADE,
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
        "workspaceWorkflowVersionId" uuid,
        steps jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      );

      CREATE TABLE core."commandMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "workflowVersionId" uuid,
        "coreWorkflowVersionId" uuid,
        "frontComponentId" uuid REFERENCES core."frontComponent"(id) ON DELETE CASCADE,
        "engineComponentKey" text NOT NULL,
        label text NOT NULL,
        icon text,
        "shortLabel" text,
        position double precision NOT NULL DEFAULT 0,
        "isPinned" boolean NOT NULL DEFAULT false,
        "availabilityType" text NOT NULL DEFAULT 'GLOBAL',
        "conditionalAvailabilityExpression" text,
        "conditionalPinnedExpression" text,
        "availabilityObjectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "navigationTargetObjectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        payload jsonb,
        "hotKeys" text[],
        "pageLayoutId" uuid REFERENCES core."pageLayout"(id) ON DELETE CASCADE,
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystemSideEffect" boolean NOT NULL DEFAULT false,
        overrides jsonb,
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
        core."commandMenuItem",
        core."navigationMenuItem",
        core."workflowVersion",
        core.workflow,
        core."pageLayout",
        core."frontComponent",
        core."fieldMetadata",
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
        customApplicationId,
        companyObjectUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."frontComponent" (id, "workspaceId", "applicationId", "universalIdentifier") VALUES ($1, $2, $3, $4)`,
      [
        frontComponentId,
        workspaceId,
        customApplicationId,
        frontComponentUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayout" (id, "workspaceId", "applicationId", "universalIdentifier") VALUES ($1, $2, $3, $4)`,
      [pageLayoutId, workspaceId, customApplicationId, pageLayoutUniversalId],
    );
  });

  const buildHarness = () => {
    const appUniversalById: Record<string, string> = {
      [standardApplicationId]: STANDARD_APPLICATION_UNIVERSAL_ID,
      [customApplicationId]: customApplicationUniversalId,
      [thirdPartyApplicationId]: thirdPartyApplicationUniversalId,
    };

    const buildMapsFromDb = async () => {
      const cmiRows = await ownerDataSource.query(
        `SELECT * FROM core."commandMenuItem" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const objRows = await ownerDataSource.query(
        `SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const fcRows = await ownerDataSource.query(
        `SELECT * FROM core."frontComponent" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const plRows = await ownerDataSource.query(
        `SELECT * FROM core."pageLayout" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );

      const objUniversalById = Object.fromEntries(
        objRows.map((row: Record<string, any>) => [
          row.id.toLowerCase(),
          row.universalIdentifier.toLowerCase(),
        ]),
      );
      const fcUniversalById = Object.fromEntries(
        fcRows.map((row: Record<string, any>) => [
          row.id.toLowerCase(),
          row.universalIdentifier.toLowerCase(),
        ]),
      );
      const plUniversalById = Object.fromEntries(
        plRows.map((row: Record<string, any>) => [
          row.id.toLowerCase(),
          row.universalIdentifier.toLowerCase(),
        ]),
      );

      const flatCommandMenuItemMaps = {
        byUniversalIdentifier: Object.fromEntries(
          cmiRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            {
              id: row.id.toLowerCase(),
              workspaceId: row.workspaceId.toLowerCase(),
              applicationId: row.applicationId.toLowerCase(),
              universalIdentifier: row.universalIdentifier.toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[row.applicationId.toLowerCase()] ??
                customApplicationUniversalId,
              workflowVersionId: row.workflowVersionId
                ? row.workflowVersionId.toLowerCase()
                : null,
              coreWorkflowVersionId: row.coreWorkflowVersionId
                ? row.coreWorkflowVersionId.toLowerCase()
                : null,
              frontComponentId: row.frontComponentId
                ? row.frontComponentId.toLowerCase()
                : null,
              frontComponentUniversalIdentifier: row.frontComponentId
                ? (fcUniversalById[row.frontComponentId.toLowerCase()] ?? null)
                : null,
              engineComponentKey: row.engineComponentKey,
              label: row.label,
              icon: row.icon ?? null,
              shortLabel: row.shortLabel ?? null,
              position: Number(row.position),
              isPinned: Boolean(row.isPinned),
              availabilityType: row.availabilityType,
              conditionalAvailabilityExpression:
                row.conditionalAvailabilityExpression ?? null,
              conditionalPinnedExpression:
                row.conditionalPinnedExpression ?? null,
              availabilityObjectMetadataId: row.availabilityObjectMetadataId
                ? row.availabilityObjectMetadataId.toLowerCase()
                : null,
              availabilityObjectMetadataUniversalIdentifier:
                row.availabilityObjectMetadataId
                  ? (objUniversalById[
                      row.availabilityObjectMetadataId.toLowerCase()
                    ] ?? null)
                  : null,
              navigationTargetObjectMetadataId:
                row.navigationTargetObjectMetadataId
                  ? row.navigationTargetObjectMetadataId.toLowerCase()
                  : null,
              navigationTargetObjectMetadataUniversalIdentifier:
                row.navigationTargetObjectMetadataId
                  ? (objUniversalById[
                      row.navigationTargetObjectMetadataId.toLowerCase()
                    ] ?? null)
                  : null,
              payload: row.payload ?? null,
              hotKeys: Array.isArray(row.hotKeys) ? row.hotKeys : null,
              pageLayoutId: row.pageLayoutId
                ? row.pageLayoutId.toLowerCase()
                : null,
              pageLayoutUniversalIdentifier: row.pageLayoutId
                ? (plUniversalById[row.pageLayoutId.toLowerCase()] ?? null)
                : null,
              isActive: Boolean(row.isActive),
              isSystemSideEffect: Boolean(row.isSystemSideEffect),
              overrides: row.overrides ?? null,
              universalOverrides: row.overrides ?? null,
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
          cmiRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          cmiRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      const buildSimpleEntityMap = (rows: Record<string, any>[]) => ({
        byUniversalIdentifier: Object.fromEntries(
          rows.map((row: Record<string, any>) => [
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
          rows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          rows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      });

      const wfRows = await ownerDataSource.query(
        `SELECT * FROM core.workflow WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const wfvRows = await ownerDataSource.query(
        `SELECT * FROM core."workflowVersion" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );

      return {
        flatCommandMenuItemMaps,
        flatObjectMetadataMaps: buildSimpleEntityMap(objRows),
        flatFrontComponentMaps: buildSimpleEntityMap(fcRows),
        flatPageLayoutMaps: buildSimpleEntityMap(plRows),
        flatWorkflowMaps: buildSimpleEntityMap(wfRows),
        flatWorkflowVersionMaps: buildSimpleEntityMap(wfvRows),
        flatRoleMaps: buildSimpleEntityMap([]),
        flatRoleTargetMaps: buildSimpleEntityMap([]),
        flatAgentMaps: buildSimpleEntityMap([]),
        flatNavigationMenuItemMaps: buildSimpleEntityMap([]),
        flatTimelineActivityTypeMaps: buildSimpleEntityMap([]),
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
          if (action.metadataName === 'commandMenuItem') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const resolvedFrontComponentId =
                fe.frontComponentId ??
                (fe.frontComponentUniversalIdentifier
                  ? allFlatEntityMaps.flatFrontComponentMaps
                      ?.idByUniversalIdentifier[
                      fe.frontComponentUniversalIdentifier.toLowerCase()
                    ]
                  : null) ??
                null;
              const resolvedAvailabilityObjectId =
                fe.availabilityObjectMetadataId ??
                (fe.availabilityObjectMetadataUniversalIdentifier
                  ? allFlatEntityMaps.flatObjectMetadataMaps
                      ?.idByUniversalIdentifier[
                      fe.availabilityObjectMetadataUniversalIdentifier.toLowerCase()
                    ]
                  : null) ??
                null;
              const resolvedNavigationTargetObjectId =
                fe.navigationTargetObjectMetadataId ??
                (fe.navigationTargetObjectMetadataUniversalIdentifier
                  ? allFlatEntityMaps.flatObjectMetadataMaps
                      ?.idByUniversalIdentifier[
                      fe.navigationTargetObjectMetadataUniversalIdentifier.toLowerCase()
                    ]
                  : null) ??
                null;
              const resolvedPageLayoutId =
                fe.pageLayoutId ??
                (fe.pageLayoutUniversalIdentifier
                  ? allFlatEntityMaps.flatPageLayoutMaps
                      ?.idByUniversalIdentifier[
                      fe.pageLayoutUniversalIdentifier.toLowerCase()
                    ]
                  : null) ??
                null;
              await queryRunner.query(
                `INSERT INTO core."commandMenuItem" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "workflowVersionId", "coreWorkflowVersionId", "frontComponentId",
                   "engineComponentKey", label, icon, "shortLabel", position, "isPinned",
                   "availabilityType", "conditionalAvailabilityExpression", "conditionalPinnedExpression",
                   "availabilityObjectMetadataId", "navigationTargetObjectMetadataId",
                   payload, "hotKeys", "pageLayoutId", "isActive", "isSystemSideEffect", overrides
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::text[],$21,$22,$23,$24::jsonb)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.workflowVersionId ?? null,
                  fe.coreWorkflowVersionId ?? null,
                  resolvedFrontComponentId,
                  fe.engineComponentKey,
                  fe.label,
                  fe.icon ?? null,
                  fe.shortLabel ?? null,
                  fe.position ?? 0,
                  fe.isPinned ?? false,
                  fe.availabilityType ?? CommandMenuItemAvailabilityType.GLOBAL,
                  fe.conditionalAvailabilityExpression ?? null,
                  fe.conditionalPinnedExpression ?? null,
                  resolvedAvailabilityObjectId,
                  resolvedNavigationTargetObjectId,
                  fe.payload !== undefined && fe.payload !== null
                    ? JSON.stringify(fe.payload)
                    : null,
                  fe.hotKeys ?? null,
                  resolvedPageLayoutId,
                  fe.isActive ?? true,
                  fe.isSystemSideEffect ?? false,
                  fe.overrides !== undefined && fe.overrides !== null
                    ? JSON.stringify(fe.overrides)
                    : null,
                ],
              );
              allFlatEntityMaps.flatCommandMenuItemMaps.byUniversalIdentifier[
                fe.universalIdentifier.toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatCommandMenuItemMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update ?? {};
              const nextOverrides =
                'universalOverrides' in upd
                  ? upd.universalOverrides
                  : 'overrides' in upd
                    ? upd.overrides
                    : existing.overrides;
              const nextPayload =
                'payload' in upd ? upd.payload : existing.payload;
              await queryRunner.query(
                `UPDATE core."commandMenuItem"
                 SET label=$1, icon=$2, "shortLabel"=$3, position=$4, "isPinned"=$5,
                     "availabilityType"=$6, "conditionalAvailabilityExpression"=$7, "conditionalPinnedExpression"=$8,
                     payload=$9::jsonb, "hotKeys"=$10::text[], "isActive"=$11, overrides=$12::jsonb, "updatedAt"=now()
                 WHERE id=$13 AND "workspaceId"=$14`,
                [
                  'label' in upd ? upd.label : existing.label,
                  'icon' in upd ? upd.icon : existing.icon,
                  'shortLabel' in upd ? upd.shortLabel : existing.shortLabel,
                  'position' in upd ? upd.position : existing.position,
                  'isPinned' in upd ? upd.isPinned : existing.isPinned,
                  'availabilityType' in upd
                    ? upd.availabilityType
                    : existing.availabilityType,
                  'conditionalAvailabilityExpression' in upd
                    ? upd.conditionalAvailabilityExpression
                    : existing.conditionalAvailabilityExpression,
                  'conditionalPinnedExpression' in upd
                    ? upd.conditionalPinnedExpression
                    : existing.conditionalPinnedExpression,
                  nextPayload !== undefined && nextPayload !== null
                    ? JSON.stringify(nextPayload)
                    : null,
                  'hotKeys' in upd ? upd.hotKeys : existing.hotKeys,
                  'isActive' in upd ? upd.isActive : existing.isActive,
                  nextOverrides !== undefined && nextOverrides !== null
                    ? JSON.stringify(nextOverrides)
                    : null,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatCommandMenuItemMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."commandMenuItem" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (
            action.metadataName === 'objectMetadata' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatObjectMetadataMaps?.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core."objectMetadata" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'frontComponent' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatFrontComponentMaps?.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core."frontComponent" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'pageLayout' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core."pageLayout" WHERE id=$1 AND "workspaceId"=$2`,
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
        }
        for (const fe of ops.flatEntityToUpdate ?? []) {
          const existing =
            currentMaps.flatCommandMenuItemMaps?.byUniversalIdentifier[
              fe.universalIdentifier.toLowerCase()
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'label',
            'icon',
            'shortLabel',
            'position',
            'isPinned',
            'availabilityType',
            'conditionalAvailabilityExpression',
            'conditionalPinnedExpression',
            'payload',
            'hotKeys',
            'isActive',
            'overrides',
            'universalOverrides',
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

    const commandMenuItemService = new CommandMenuItemService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
      { buildEffectiveEntityI18nContext: jest.fn() } as never,
    );

    const commandMenuItemResolver = new CommandMenuItemResolver(
      commandMenuItemService,
      { getWorkspaceFeatureFlagsMap: jest.fn().mockResolvedValue({}) } as never,
      { resolveTranslatablePropertiesForEntities: jest.fn() } as never,
    );

    return {
      runnerService,
      commandMenuItemService,
      commandMenuItemResolver,
    };
  };

  it('audits standard and custom commandMenuItem create, update, reset, deactivate-on-delete, and hard delete through CommandMenuItemResolver and CommandMenuItemService', async () => {
    const { commandMenuItemResolver } = buildHarness();

    const standardCmiId = randomUUID().toLowerCase();
    const standardCmiUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."commandMenuItem" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "engineComponentKey", label, icon, "shortLabel", position, "isPinned",
         "availabilityType", "navigationTargetObjectMetadataId", "isActive", "isSystemSideEffect"
       ) VALUES ($1,$2,$3,$4,$5,'Go to Companies','IconBuildingSkyscraper','Companies',1,false,'GLOBAL',$6,true,true)`,
      [
        standardCmiId,
        workspaceId,
        standardApplicationId,
        standardCmiUniversalId,
        EngineComponentKey.NAVIGATION,
        companyObjectId,
      ],
    );

    // 1. Create custom commandMenuItem under impersonation
    const createdCustom = await commandMenuItemResolver.createCommandMenuItem(
      {
        engineComponentKey: EngineComponentKey.FRONT_COMPONENT_RENDERER,
        frontComponentId,
        label: 'Open Dialer Panel',
        shortLabel: 'Dialer',
        icon: 'IconPhone',
        position: 5,
        isPinned: true,
        availabilityType: CommandMenuItemAvailabilityType.RECORD_SELECTION,
        availabilityObjectMetadataId: companyObjectId,
        pageLayoutId,
        hotKeys: ['G', 'D'],
        payload: { path: '/dialer' },
        conditionalAvailabilityExpression: 'record.isActive == true',
        conditionalPinnedExpression: 'user.canCall == true',
      },
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
          impersonationContext: {
            impersonatorUserWorkspaceId,
          },
        },
      },
    );
    expect(createdCustom.frontComponentId).toBe(frontComponentId);
    expect(createdCustom.isPinned).toBe(true);

    // 2. Update standard commandMenuItem (writes overrides jsonb)
    const overriddenStandard =
      await commandMenuItemResolver.updateCommandMenuItem(
        {
          id: standardCmiId,
          label: 'Navigate to Accounts',
          shortLabel: 'Accounts',
          icon: 'IconBriefcase',
          isPinned: true,
        },
        { id: workspaceId } as never,
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        },
      );
    expect(overriddenStandard.id).toBe(standardCmiId);

    // 3. Idempotent update on standard commandMenuItem produces 0 new audit entries
    await commandMenuItemResolver.updateCommandMenuItem(
      {
        id: standardCmiId,
        label: 'Navigate to Accounts',
        shortLabel: 'Accounts',
        icon: 'IconBriefcase',
        isPinned: true,
      },
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    );

    // 4. Reset standard commandMenuItem under apiKey
    const resetStandard = await commandMenuItemResolver.resetCommandMenuItem(
      standardCmiId,
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          apiKey: { id: apiKeyId },
        },
      },
    );
    expect(resetStandard.overrides).toBeNull();

    // 5. Reject resetCommandMenuItem on custom commandMenuItem
    await expect(
      commandMenuItemResolver.resetCommandMenuItem(
        createdCustom.id,
        { id: workspaceId } as never,
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        },
      ),
    ).rejects.toMatchObject({
      code: CommandMenuItemExceptionCode.COMMAND_MENU_ITEM_CANNOT_BE_RESET,
    });

    // 6. Update custom commandMenuItem directly mutates columns
    const updatedCustom = await commandMenuItemResolver.updateCommandMenuItem(
      {
        id: createdCustom.id,
        label: 'Open Softphone',
        isPinned: false,
        hotKeys: ['G', 'S'],
      },
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    );
    expect(updatedCustom.label).toBe('Open Softphone');
    expect(updatedCustom.isPinned).toBe(false);

    // 7. Delete standard commandMenuItem deactivates it (action: 'update', isActive: false)
    const deactivatedStandard =
      await commandMenuItemResolver.deleteCommandMenuItem(
        standardCmiId,
        { id: workspaceId } as never,
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        },
      );
    expect(deactivatedStandard.isActive).toBe(false);

    // 8. Delete custom non-systemSideEffect commandMenuItem removes the row (action: 'delete')
    const deletedCustom = await commandMenuItemResolver.deleteCommandMenuItem(
      createdCustom.id,
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    );
    expect(deletedCustom.id).toBe(createdCustom.id);

    const entries = await ownerDataSource.query(
      `SELECT "operationId", "resourceKind", "resourceId", action,
              actor, initiator, "securityDescriptor", "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: createdCustom.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'commandMenuItem',
        resourceId: createdCustom.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'availabilityObjectMetadataId',
          'availabilityType',
          'conditionalAvailabilityExpression',
          'conditionalPinnedExpression',
          'coreWorkflowVersionId',
          'engineComponentKey',
          'frontComponentId',
          'hotKeys',
          'icon',
          'isActive',
          'isPinned',
          'isSystemSideEffect',
          'label',
          'navigationTargetObjectMetadataId',
          'overrides',
          'pageLayoutId',
          'payload',
          'position',
          'shortLabel',
          'workflowVersionId',
        ],
        values: {
          applicationId: {
            before: null,
            after: customApplicationId,
          },
          frontComponentId: {
            before: null,
            after: frontComponentId,
          },
          engineComponentKey: {
            before: null,
            after: EngineComponentKey.FRONT_COMPONENT_RENDERER,
          },
          isPinned: {
            before: null,
            after: true,
          },
          availabilityType: {
            before: null,
            after: CommandMenuItemAvailabilityType.RECORD_SELECTION,
          },
          availabilityObjectMetadataId: {
            before: null,
            after: companyObjectId,
          },
          navigationTargetObjectMetadataId: {
            before: null,
            after: null,
          },
          pageLayoutId: {
            before: null,
            after: pageLayoutId,
          },
          isActive: {
            before: null,
            after: true,
          },
          isSystemSideEffect: {
            before: null,
            after: false,
          },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: standardCmiId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['overrides'],
        values: {},
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: standardCmiId,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['overrides'],
        values: {},
      },
    });
    expect(entries[3]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: createdCustom.id,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['hotKeys', 'isPinned', 'label'],
        values: {
          isPinned: {
            before: true,
            after: false,
          },
        },
      },
    });
    expect(entries[4]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: standardCmiId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['overrides'],
        values: {},
      },
    });
    expect(entries[5]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: createdCustom.id,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
    });
  });

  it('audits cascade create/update/delete of commandMenuItem rows on objectMetadata, frontComponent, pageLayout, and workflowVersion mutations', async () => {
    const { runnerService } = buildHarness();

    const navCmiId = randomUUID().toLowerCase();
    const navCmiUniversalId = randomUUID().toLowerCase();
    const fcCmiId = randomUUID().toLowerCase();
    const fcCmiUniversalId = randomUUID().toLowerCase();
    const plCmiId = randomUUID().toLowerCase();
    const plCmiUniversalId = randomUUID().toLowerCase();
    const wfCmiId = randomUUID().toLowerCase();
    const wfCmiUniversalId = randomUUID().toLowerCase();
    const coreWorkflowVersionId = randomUUID().toLowerCase();
    const coreWorkflowVersionUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."workflowVersion" (id, "workspaceId", "applicationId", "universalIdentifier")
       VALUES ($1, $2, $3, $4)`,
      [
        coreWorkflowVersionId,
        workspaceId,
        customApplicationId,
        coreWorkflowVersionUniversalId,
      ],
    );

    // 1. Cascade create when creating objectMetadata (system side-effect navigation commandMenuItem)
    const createObjCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: {
        workspace: { id: workspaceId },
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      expectedCreatedObjectId: companyObjectId,
    });
    await withNavigationMenuItemAudit(createObjCascade(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'objectMetadata',
              id: companyObjectId,
              flatEntity: {
                id: companyObjectId,
                universalIdentifier: companyObjectUniversalId,
                applicationUniversalIdentifier: customApplicationUniversalId,
              },
              universalFlatFieldMetadatas: [],
            },
            {
              type: 'create',
              metadataName: 'commandMenuItem',
              id: navCmiId,
              flatEntity: {
                id: navCmiId,
                universalIdentifier: navCmiUniversalId,
                applicationUniversalIdentifier: customApplicationUniversalId,
                engineComponentKey: EngineComponentKey.NAVIGATION,
                label: 'Go to Companies',
                shortLabel: 'Companies',
                icon: 'IconBuildingSkyscraper',
                position: 10,
                isPinned: false,
                availabilityType: CommandMenuItemAvailabilityType.GLOBAL,
                navigationTargetObjectMetadataId: companyObjectId,
                isActive: true,
                isSystemSideEffect: true,
              },
            },
          ],
        } as never,
      }),
    );

    // 2. Cascade update when updating objectMetadata (icon + isActive on system side-effect navigation commandMenuItem)
    const updateObjCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: {
        workspace: { id: workspaceId },
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      expectedUpdatedObjectIds: [companyObjectId],
    });
    await withNavigationMenuItemAudit(updateObjCascade(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'update',
              metadataName: 'objectMetadata',
              universalIdentifier: companyObjectUniversalId,
              update: {
                icon: 'IconBuilding',
                isActive: false,
              },
            },
            {
              type: 'update',
              metadataName: 'commandMenuItem',
              universalIdentifier: navCmiUniversalId,
              update: {
                icon: 'IconBuilding',
                isActive: false,
              },
            },
          ],
        } as never,
      }),
    );

    // Seed frontComponent, pageLayout, and workflowVersion commandMenuItems for cascade delete tests
    await ownerDataSource.query(
      `INSERT INTO core."commandMenuItem" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "frontComponentId", "pageLayoutId", "coreWorkflowVersionId",
         "engineComponentKey", label, position, "isPinned", "availabilityType", "isActive", "isSystemSideEffect"
       ) VALUES
         ($1, $2, $3, $4, $5, null, null, $6, 'Front Component CMI', 1, false, 'GLOBAL', true, false),
         ($7, $2, $3, $8, null, $9, null, $10, 'Page Layout CMI', 2, false, 'GLOBAL', true, false),
         ($11, $2, $3, $12, null, null, $13, $14, 'Workflow Version CMI', 3, true, 'GLOBAL', true, false)`,
      [
        fcCmiId,
        workspaceId,
        customApplicationId,
        fcCmiUniversalId,
        frontComponentId,
        EngineComponentKey.FRONT_COMPONENT_RENDERER,
        plCmiId,
        plCmiUniversalId,
        pageLayoutId,
        EngineComponentKey.EDIT_RECORD_PAGE_LAYOUT,
        wfCmiId,
        wfCmiUniversalId,
        coreWorkflowVersionId,
        EngineComponentKey.TRIGGER_WORKFLOW_VERSION,
      ],
    );

    // 3. Cascade delete on frontComponent delete (ON DELETE CASCADE)
    const deleteFcCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'frontComponent',
      auditIdentity: {
        workspace: { id: workspaceId },
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      expectedFrontComponentDeleteIds: [frontComponentId],
    });
    await withNavigationMenuItemAudit(deleteFcCascade(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'frontComponent',
              universalIdentifier: frontComponentUniversalId,
            },
          ],
        } as never,
      }),
    );

    // 4. Cascade delete on pageLayout delete (ON DELETE CASCADE)
    const deletePlCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: {
        workspace: { id: workspaceId },
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      expectedParentPageLayoutDeleteIds: [pageLayoutId],
    });
    await withNavigationMenuItemAudit(deletePlCascade(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'pageLayout',
              universalIdentifier: pageLayoutUniversalId,
            },
          ],
        } as never,
      }),
    );

    // 5. Cascade delete on workflowVersion delete
    const deleteWfCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'logicFunction',
      auditIdentity: {
        workspace: { id: workspaceId },
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      expectedParentWorkflowVersionDeleteIds: [coreWorkflowVersionId],
    });
    await withNavigationMenuItemAudit(deleteWfCascade(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'workflowVersion',
              universalIdentifier: coreWorkflowVersionUniversalId,
            },
            {
              type: 'delete',
              metadataName: 'commandMenuItem',
              universalIdentifier: wfCmiUniversalId,
            },
          ],
        } as never,
      }),
    );

    // 6. Cascade delete on objectMetadata delete (ON DELETE CASCADE via application-metadata-audit objectDelete)
    const deleteObjOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      mode: 'objectDelete',
      expectedDeletedObjectIds: [companyObjectId],
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(deleteObjOp, {
        applicationId: customApplicationId,
        applicationUniversalIdentifier: customApplicationUniversalId,
      }),
      () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: customApplicationUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName: 'objectMetadata',
                universalIdentifier: companyObjectUniversalId,
              },
            ],
          } as never,
        }),
    );

    const entries = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='commandMenuItem'
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: navCmiId,
      action: 'create',
      redactedDiff: {
        values: {
          navigationTargetObjectMetadataId: {
            before: null,
            after: companyObjectId,
          },
          isSystemSideEffect: {
            before: null,
            after: true,
          },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: navCmiId,
      action: 'update',
      redactedDiff: {
        changedFields: ['icon', 'isActive'],
        values: {
          isActive: {
            before: true,
            after: false,
          },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: fcCmiId,
      action: 'delete',
    });
    expect(entries[3]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: plCmiId,
      action: 'delete',
    });
    expect(entries[4]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: wfCmiId,
      action: 'delete',
    });
    expect(entries[5]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: navCmiId,
      action: 'delete',
    });
  });

  it('audits application manifest commandMenuItem create/update/delete, blocks application delete until removed, and rejects unaudited runner mutations', async () => {
    const { runnerService } = buildHarness();

    const cmiId = randomUUID().toLowerCase();
    const cmiUniversalId = randomUUID().toLowerCase();

    // 1. Fail-closed without audit context
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'commandMenuItem',
              id: cmiId,
              flatEntity: {
                id: cmiId,
                universalIdentifier: cmiUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                engineComponentKey: EngineComponentKey.FRONT_COMPONENT_RENDERER,
                frontComponentUniversalIdentifier: frontComponentUniversalId,
                label: 'Third Party Command',
                shortLabel: 'TP Cmd',
                icon: 'IconBolt',
                position: 42,
                isPinned: false,
                availabilityType: CommandMenuItemAvailabilityType.GLOBAL,
                isActive: true,
                isSystemSideEffect: false,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Create commandMenuItem via application metadata audit
    const createOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      isSystemBuild: true,
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(createOp, {
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
                metadataName: 'commandMenuItem',
                id: cmiId,
                flatEntity: {
                  id: cmiId,
                  universalIdentifier: cmiUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  engineComponentKey:
                    EngineComponentKey.FRONT_COMPONENT_RENDERER,
                  frontComponentUniversalIdentifier: frontComponentUniversalId,
                  label: 'Third Party Command',
                  shortLabel: 'TP Cmd',
                  icon: 'IconBolt',
                  position: 42,
                  isPinned: false,
                  availabilityType: CommandMenuItemAvailabilityType.GLOBAL,
                  isActive: true,
                  isSystemSideEffect: false,
                },
              },
            ],
          } as never,
        }),
    );

    // 3. Update commandMenuItem via application metadata audit
    const updateOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      isSystemBuild: true,
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(updateOp, {
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
                metadataName: 'commandMenuItem',
                universalIdentifier: cmiUniversalId,
                update: {
                  label: 'Third Party Command Updated',
                  isPinned: true,
                  isActive: false,
                },
              },
            ],
          } as never,
        }),
    );

    // 4. Application delete barrier rejects while commandMenuItem row still exists
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

    const appDelAttempt = captureOptionalApplicationDeleteAudit({
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
      runAuditedApplicationDelete(runtimeDataSource, appDelAttempt, {
        applicationId: thirdPartyApplicationId,
        work: async (qr) => {
          await qr.query(
            `DELETE FROM core.application WHERE id=$1 AND "workspaceId"=$2`,
            [thirdPartyApplicationId, workspaceId],
          );
        },
      }),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // 5. Delete commandMenuItem via application metadata audit, then delete application
    const deleteCmiOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      isSystemBuild: true,
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(deleteCmiOp, {
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
                type: 'delete',
                metadataName: 'commandMenuItem',
                universalIdentifier: cmiUniversalId,
              },
            ],
          } as never,
        }),
    );

    const appDelSuccess = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await runAuditedApplicationDelete(runtimeDataSource, appDelSuccess, {
      applicationId: thirdPartyApplicationId,
      work: async (qr) => {
        await qr.query(
          `DELETE FROM core.application WHERE id=$1 AND "workspaceId"=$2`,
          [thirdPartyApplicationId, workspaceId],
        );
      },
    });

    const entries = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: cmiId,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: {
            before: null,
            after: thirdPartyApplicationId,
          },
          frontComponentId: {
            before: null,
            after: frontComponentId,
          },
          engineComponentKey: {
            before: null,
            after: EngineComponentKey.FRONT_COMPONENT_RENDERER,
          },
          isPinned: {
            before: null,
            after: false,
          },
          isActive: {
            before: null,
            after: true,
          },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: cmiId,
      action: 'update',
      redactedDiff: {
        changedFields: ['isActive', 'isPinned', 'label'],
        values: {
          isPinned: {
            before: false,
            after: true,
          },
          isActive: {
            before: true,
            after: false,
          },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'commandMenuItem',
      resourceId: cmiId,
      action: 'delete',
    });
  });

  it('rolls back on post-flush commandMenuItem mutation and propagates NativeTransactionOutcomeUnknownError on lost COMMIT ack', async () => {
    const { runnerService } = buildHarness();

    const cmiId = randomUUID().toLowerCase();
    const cmiUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `CREATE OR REPLACE FUNCTION crm_audit.tamper_cmi_after_audit()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
       BEGIN
         IF NEW."resourceKind" = 'commandMenuItem' THEN
           UPDATE core."commandMenuItem" SET "isActive" = false WHERE id = NEW."resourceId"::uuid;
         END IF;
         RETURN NEW;
       END;
       $$;
       DROP TRIGGER IF EXISTS trg_tamper_cmi_after_audit ON crm_audit."crmAuditEntry";
       CREATE TRIGGER trg_tamper_cmi_after_audit
       AFTER INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_cmi_after_audit();`,
    );

    try {
      const capturedTamper = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'commandMenuItem',
        auditIdentity: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedCommandMenuItemCreateIds: [cmiId],
      });
      await expect(
        withNavigationMenuItemAudit(capturedTamper(), () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'commandMenuItem',
                  id: cmiId,
                  flatEntity: {
                    id: cmiId,
                    universalIdentifier: cmiUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    engineComponentKey:
                      EngineComponentKey.FRONT_COMPONENT_RENDERER,
                    frontComponentId,
                    label: 'Tampered Command',
                    position: 1,
                    isPinned: false,
                    availabilityType: CommandMenuItemAvailabilityType.GLOBAL,
                    isActive: true,
                    isSystemSideEffect: false,
                  },
                },
              ],
            } as never,
          }),
        ),
      ).rejects.toThrow('Command menu item state changed during audit flush');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_tamper_cmi_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.tamper_cmi_after_audit();`,
      );
    }

    const rowsAfterRollback = await ownerDataSource.query(
      `SELECT id FROM core."commandMenuItem" WHERE id=$1`,
      [cmiId],
    );
    const auditAfterRollback = await ownerDataSource.query(
      `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(rowsAfterRollback).toHaveLength(0);
    expect(auditAfterRollback).toHaveLength(0);

    // Lost COMMIT acknowledgement propagates NativeTransactionOutcomeUnknownError without ROLLBACK
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
      const capturedCommitLoss = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'commandMenuItem',
        auditIdentity: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedCommandMenuItemCreateIds: [cmiId],
      });
      await expect(
        withNavigationMenuItemAudit(capturedCommitLoss(), () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'create',
                  metadataName: 'commandMenuItem',
                  id: cmiId,
                  flatEntity: {
                    id: cmiId,
                    universalIdentifier: cmiUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    engineComponentKey:
                      EngineComponentKey.FRONT_COMPONENT_RENDERER,
                    frontComponentId,
                    label: 'Commit Loss Command',
                    position: 1,
                    isPinned: false,
                    availabilityType: CommandMenuItemAvailabilityType.GLOBAL,
                    isActive: true,
                    isSystemSideEffect: false,
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
