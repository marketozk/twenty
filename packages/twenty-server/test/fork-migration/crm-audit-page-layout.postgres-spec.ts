import { randomUUID } from 'node:crypto';
import {
  AggregateOperations,
  CommandMenuItemAvailabilityType,
  FieldMetadataType,
  NavigationMenuItemType,
  ObjectRecordGroupByDateGranularity,
  PageLayoutTabLayoutMode,
  PageLayoutType,
  WidgetType,
} from 'twenty-shared/types';
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
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { EngineComponentKey } from 'src/engine/metadata-modules/command-menu-item/enums/engine-component-key.enum';
import { AxisNameDisplay } from 'src/engine/metadata-modules/page-layout-widget/enums/axis-name-display.enum';
import { WidgetConfigurationType } from 'src/engine/metadata-modules/page-layout-widget/enums/widget-configuration-type.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: {
    ROLE: 'ROLE',
    METADATA: 'METADATA',
    DASHBOARD: 'DASHBOARD',
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
  [
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
  ],
  [
    'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
    ['ApplicationTranslationCatalogService'],
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
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    ['WorkspaceMigrationValidateBuildAndRunService'],
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
  ['src/engine/twenty-orm/workspace-orm.manager', ['WorkspaceOrmManager']],
  [
    'src/modules/dashboard-sync/services/dashboard-sync.service',
    ['DashboardSyncService'],
  ],
  ['src/engine/metadata-modules/view/services/view.service', ['ViewService']],
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
  ['src/engine/decorators/locale/request-locale.decorator', ['RequestLocale']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { PageLayoutService } =
  require('src/engine/metadata-modules/page-layout/services/page-layout.service') as typeof import('src/engine/metadata-modules/page-layout/services/page-layout.service');
const { PageLayoutUpdateService } =
  require('src/engine/metadata-modules/page-layout/services/page-layout-update.service') as typeof import('src/engine/metadata-modules/page-layout/services/page-layout-update.service');
const { PageLayoutResetService } =
  require('src/engine/metadata-modules/page-layout/services/page-layout-reset.service') as typeof import('src/engine/metadata-modules/page-layout/services/page-layout-reset.service');
const { PageLayoutDuplicationService } =
  require('src/engine/metadata-modules/page-layout/services/page-layout-duplication.service') as typeof import('src/engine/metadata-modules/page-layout/services/page-layout-duplication.service');
const { PageLayoutResolver } =
  require('src/engine/metadata-modules/page-layout/resolvers/page-layout.resolver') as typeof import('src/engine/metadata-modules/page-layout/resolvers/page-layout.resolver');
const { PageLayoutController } =
  require('src/engine/metadata-modules/page-layout/controllers/page-layout.controller') as typeof import('src/engine/metadata-modules/page-layout/controllers/page-layout.controller');
const { PageLayoutTabService } =
  require('src/engine/metadata-modules/page-layout-tab/services/page-layout-tab.service') as typeof import('src/engine/metadata-modules/page-layout-tab/services/page-layout-tab.service');
const { PageLayoutTabResolver } =
  require('src/engine/metadata-modules/page-layout-tab/resolvers/page-layout-tab.resolver') as typeof import('src/engine/metadata-modules/page-layout-tab/resolvers/page-layout-tab.resolver');
const { PageLayoutTabController } =
  require('src/engine/metadata-modules/page-layout-tab/controllers/page-layout-tab.controller') as typeof import('src/engine/metadata-modules/page-layout-tab/controllers/page-layout-tab.controller');
const { PageLayoutWidgetService } =
  require('src/engine/metadata-modules/page-layout-widget/services/page-layout-widget.service') as typeof import('src/engine/metadata-modules/page-layout-widget/services/page-layout-widget.service');
const { PageLayoutWidgetResolver } =
  require('src/engine/metadata-modules/page-layout-widget/resolvers/page-layout-widget.resolver') as typeof import('src/engine/metadata-modules/page-layout-widget/resolvers/page-layout-widget.resolver');
const { PageLayoutWidgetController } =
  require('src/engine/metadata-modules/page-layout-widget/controllers/page-layout-widget.controller') as typeof import('src/engine/metadata-modules/page-layout-widget/controllers/page-layout-widget.controller');
const { DashboardToPageLayoutSyncService } =
  require('src/modules/dashboard/services/dashboard-to-page-layout-sync.service') as typeof import('src/modules/dashboard/services/dashboard-to-page-layout-sync.service');
const { DashboardToolWorkspaceService } =
  require('src/modules/dashboard/tools/services/dashboard-tool.workspace-service') as typeof import('src/modules/dashboard/tools/services/dashboard-tool.workspace-service');
const { FieldMetadataService } =
  require('src/engine/metadata-modules/field-metadata/services/field-metadata.service') as typeof import('src/engine/metadata-modules/field-metadata/services/field-metadata.service');
const { seedPageLayouts } =
  require('src/engine/workspace-manager/dev-seeder/core/utils/seed-page-layouts.util') as typeof import('src/engine/workspace-manager/dev-seeder/core/utils/seed-page-layouts.util');
const { getSeedFrontComponentDefinitions } =
  require('src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-front-component-definitions.util') as typeof import('src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-front-component-definitions.util');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { fromUniversalConfigurationToFlatPageLayoutWidgetConfiguration } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/page-layout-widget/services/utils/from-universal-configuration-to-flat-page-layout-widget-configuration.util') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/page-layout-widget/services/utils/from-universal-configuration-to-flat-page-layout-widget-configuration.util');
const { fromUniversalOverridesToPageLayoutWidgetOverrides } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/page-layout-widget/services/utils/from-universal-overrides-to-page-layout-widget-overrides.util') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/page-layout-widget/services/utils/from-universal-overrides-to-page-layout-widget-overrides.util');

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

const runtimeRole = `twenty_pl_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
const agentId = randomUUID().toLowerCase();
const agentUniversalId = randomUUID().toLowerCase();

const companyObjectId = randomUUID().toLowerCase();
const companyObjectUniversalId = randomUUID().toLowerCase();
const amountFieldId = randomUUID().toLowerCase();
const amountFieldUniversalId = randomUUID().toLowerCase();
const stageFieldId = randomUUID().toLowerCase();
const stageFieldUniversalId = randomUUID().toLowerCase();
const frontComponentId = randomUUID().toLowerCase();
const frontComponentUniversalId = randomUUID().toLowerCase();
const viewId = randomUUID().toLowerCase();
const viewUniversalId = randomUUID().toLowerCase();

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

describe('CRM audit pageLayout, pageLayoutTab, and pageLayoutWidget lifecycle and cascades (LOG183)', () => {
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

    const qr = ownerDataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`
        CREATE TABLE core.workspace (
          id uuid PRIMARY KEY,
          "activationStatus" text NOT NULL DEFAULT 'ACTIVE',
          "deletedAt" timestamptz
        );

        CREATE TABLE core."user" (
          id uuid PRIMARY KEY,
          "canImpersonate" boolean NOT NULL DEFAULT false,
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
          "canBeUninstalled" boolean NOT NULL DEFAULT true,
          "deletedAt" timestamptz
        );

        CREATE TABLE core."apiKey" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "revokedAt" timestamptz,
          "expiresAt" timestamptz
        );

        CREATE TABLE core.agent (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          name text NOT NULL DEFAULT 'agent',
          label text NOT NULL DEFAULT 'Agent',
          prompt text NOT NULL DEFAULT 'prompt',
          "modelId" text NOT NULL DEFAULT 'auto',
          "isCustom" boolean NOT NULL DEFAULT true,
          "deletedAt" timestamptz
        );

        CREATE TABLE core."objectMetadata" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "nameSingular" text NOT NULL DEFAULT 'company',
          "namePlural" text NOT NULL DEFAULT 'companies',
          "labelSingular" text NOT NULL DEFAULT 'Company',
          "labelPlural" text NOT NULL DEFAULT 'Companies',
          "isCustom" boolean NOT NULL DEFAULT true,
          "isActive" boolean NOT NULL DEFAULT true,
          "isSystem" boolean NOT NULL DEFAULT false,
          "labelIdentifierFieldMetadataId" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core."fieldMetadata" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
          type text NOT NULL DEFAULT 'TEXT',
          name text NOT NULL,
          label text NOT NULL,
          "isCustom" boolean NOT NULL DEFAULT true,
          "isActive" boolean NOT NULL DEFAULT true,
          "isSystem" boolean NOT NULL DEFAULT false,
          "isSystemSideEffect" boolean NOT NULL DEFAULT false,
          "relationTargetObjectMetadataId" uuid,
          "relationTargetFieldMetadataId" uuid,
          "morphId" uuid,
          settings jsonb,
          options jsonb,
          "defaultValue" jsonb,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core.view (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
          name text NOT NULL DEFAULT 'All',
          type text NOT NULL DEFAULT 'TABLE',
          visibility text NOT NULL DEFAULT 'WORKSPACE',
          "createdByUserWorkspaceId" uuid,
          "calendarFieldMetadataId" uuid,
          "mainGroupByFieldMetadataId" uuid,
          "deletedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core."viewFieldGroup" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "viewId" uuid NOT NULL REFERENCES core.view(id) ON DELETE CASCADE,
          name text NOT NULL DEFAULT 'General',
          position double precision NOT NULL DEFAULT 0,
          "isVisible" boolean NOT NULL DEFAULT true,
          "deletedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core."viewField" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "viewId" uuid NOT NULL REFERENCES core.view(id) ON DELETE CASCADE,
          "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
          "viewFieldGroupId" uuid REFERENCES core."viewFieldGroup"(id) ON DELETE SET NULL,
          position double precision NOT NULL DEFAULT 0,
          "isVisible" boolean NOT NULL DEFAULT true,
          size integer NOT NULL DEFAULT 150,
          "deletedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
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
          "usesSdkClient" boolean NOT NULL DEFAULT true,
          "widgetAvailability" jsonb NOT NULL DEFAULT '[]'::jsonb,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core."pageLayout" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          name text NOT NULL,
          type text NOT NULL DEFAULT 'RECORD_PAGE',
          "objectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
          "defaultTabToFocusOnMobileAndSidePanelId" uuid,
          "isSystemSideEffect" boolean NOT NULL DEFAULT false,
          "isFirstTabPinned" boolean NOT NULL DEFAULT true,
          "deletedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE core."pageLayoutTab" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          title text NOT NULL,
          position double precision NOT NULL DEFAULT 0,
          "pageLayoutId" uuid NOT NULL REFERENCES core."pageLayout"(id) ON DELETE CASCADE,
          "layoutMode" text NOT NULL DEFAULT 'GRID',
          icon text,
          "isActive" boolean NOT NULL DEFAULT true,
          "isSystemSideEffect" boolean NOT NULL DEFAULT false,
          overrides jsonb,
          "deletedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );

        ALTER TABLE core."pageLayout"
          ADD CONSTRAINT "FK_pageLayout_defaultTab"
          FOREIGN KEY ("defaultTabToFocusOnMobileAndSidePanelId")
          REFERENCES core."pageLayoutTab"(id)
          ON DELETE SET NULL;

        CREATE TABLE core."pageLayoutWidget" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          "pageLayoutTabId" uuid NOT NULL REFERENCES core."pageLayoutTab"(id) ON DELETE CASCADE,
          title text NOT NULL,
          type text NOT NULL DEFAULT 'FIELDS',
          "objectMetadataId" uuid REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
          "gridPosition" jsonb NOT NULL DEFAULT '{"row":0,"column":0,"rowSpan":1,"columnSpan":12}'::jsonb,
          position jsonb,
          configuration jsonb NOT NULL,
          "isActive" boolean NOT NULL DEFAULT true,
          "isSystemSideEffect" boolean NOT NULL DEFAULT false,
          overrides jsonb,
          "conditionalDisplay" jsonb,
          "conditionalAvailabilityExpression" text,
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
          "viewId" uuid REFERENCES core.view(id) ON DELETE CASCADE,
          "folderId" uuid REFERENCES core."navigationMenuItem"(id) ON DELETE CASCADE,
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

      const bootstrap = new OmniAuditBootstrapFastInstanceCommand();
      await bootstrap.up(qr);

      await qr.query(
        `DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${`'${runtimeRole}'`}) THEN
            CREATE ROLE ${quoteIdent(runtimeRole)} LOGIN PASSWORD 'twenty_test_pw';
          END IF;
        END $$;
        GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO ${quoteIdent(runtimeRole)};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, "${workspaceSchema}" TO ${quoteIdent(runtimeRole)};
        GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO ${quoteIdent(runtimeRole)};`,
      );
    } finally {
      await qr.release();
    }

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
        core."pageLayoutWidget",
        core."pageLayoutTab",
        core."pageLayout",
        core."viewField",
        core."viewFieldGroup",
        core.view,
        core."frontComponent",
        core."fieldMetadata",
        core."objectMetadata",
        core.agent,
        core."apiKey",
        core.application,
        "${workspaceSchema}"."workspaceMember",
        core."userWorkspace",
        core."user",
        core.workspace
      CASCADE;
    `);

    await ownerDataSource.query(
      `INSERT INTO core.workspace (id, "activationStatus") VALUES ($1, 'ACTIVE')`,
      [workspaceId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."user" (id, "canImpersonate") VALUES ($1, false), ($2, true)`,
      [ownerUserId, impersonatorUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId") VALUES ($1, $2, $3), ($4, $5, $3)`,
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
      `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", "canBeUninstalled")
       VALUES ($1, $2, $3, false), ($4, $2, $5, false), ($6, $2, $7, true)`,
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
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier", name, label, prompt, "modelId", "isCustom")
       VALUES ($1, $2, $3, $4, 'layoutAgent', 'Layout Agent', 'prompt', 'auto', true)`,
      [agentId, workspaceId, customApplicationId, agentUniversalId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "labelSingular", "labelPlural")
       VALUES ($1, $2, $3, $4, 'company', 'companies', 'Company', 'Companies')`,
      [
        companyObjectId,
        workspaceId,
        customApplicationId,
        companyObjectUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", type, name, label, "isActive", "isCustom", "isSystem")
       VALUES ($1, $2, $3, $4, $5, 'NUMBER', 'amount', 'Amount', true, true, false),
              ($6, $2, $3, $7, $5, 'TEXT', 'stage', 'Stage', true, true, false)`,
      [
        amountFieldId,
        workspaceId,
        customApplicationId,
        amountFieldUniversalId,
        companyObjectId,
        stageFieldId,
        stageFieldUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.view (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, $5, 'All Companies', 'FIELDS_WIDGET')`,
      [
        viewId,
        workspaceId,
        customApplicationId,
        viewUniversalId,
        companyObjectId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."frontComponent" (id, "workspaceId", "applicationId", "universalIdentifier", name, "sourceComponentPath", "builtComponentPath", "componentName", "builtComponentChecksum")
       VALUES ($1, $2, $3, $4, 'CustomWidgetFc', 'src/Fc.tsx', 'dist/Fc.mjs', 'CustomWidgetFc', 'sha256-fc')`,
      [
        frontComponentId,
        workspaceId,
        customApplicationId,
        frontComponentUniversalId,
      ],
    );
  });

  const buildMapsFromDb = async () => {
    const [
      apps,
      objs,
      fields,
      views,
      viewFieldGroups,
      viewFields,
      fcs,
      pls,
      plts,
      plws,
      navs,
      cmis,
    ] = await Promise.all([
      ownerDataSource.query(
        `SELECT * FROM core.application WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."fieldMetadata" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core.view WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."viewFieldGroup" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."viewField" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."frontComponent" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."pageLayout" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."pageLayoutTab" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."pageLayoutWidget" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."navigationMenuItem" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
      ownerDataSource.query(
        `SELECT * FROM core."commandMenuItem" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      ),
    ]);

    const toMap = (
      rows: Array<Record<string, any>>,
      enrich?: (row: Record<string, any>) => Record<string, any>,
    ) => {
      const byId: Record<string, any> = {};
      const byUniversalIdentifier: Record<string, any> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      const universalIdentifierById: Record<string, string> = {};
      for (const raw of rows) {
        const id = raw.id.toLowerCase();
        const uid = raw.universalIdentifier.toLowerCase();
        const item = enrich
          ? enrich({ ...raw, id, universalIdentifier: uid })
          : { ...raw, id, universalIdentifier: uid };
        byId[id] = item;
        byUniversalIdentifier[uid] = item;
        idByUniversalIdentifier[uid] = id;
        universalIdentifierById[id] = uid;
      }
      return {
        byId,
        byUniversalIdentifier,
        idByUniversalIdentifier,
        universalIdentifierById,
      };
    };

    const appMap = toMap(apps);
    const objMap = toMap(objs, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      pageLayoutIds: pls
        .filter(
          (pl: any) =>
            pl.objectMetadataId?.toLowerCase() === row.id.toLowerCase(),
        )
        .map((pl: any) => pl.id.toLowerCase()),
      fieldIds: fields
        .filter(
          (f: any) =>
            f.objectMetadataId?.toLowerCase() === row.id.toLowerCase(),
        )
        .map((f: any) => f.id.toLowerCase()),
      indexMetadataIds: [],
      viewIds: views
        .filter(
          (v: any) =>
            v.objectMetadataId?.toLowerCase() === row.id.toLowerCase(),
        )
        .map((v: any) => v.id.toLowerCase()),
    }));
    const fieldMap = toMap(fields, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      objectMetadataId: row.objectMetadataId.toLowerCase(),
      objectMetadataUniversalIdentifier:
        objMap.universalIdentifierById[row.objectMetadataId.toLowerCase()],
      viewFieldIds: [],
      viewFilterIds: [],
      kanbanAggregateOperationViewIds: [],
      calendarViewIds: [],
      mainGroupByFieldMetadataViewIds: [],
    }));
    const viewMap = toMap(views, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      objectMetadataId: row.objectMetadataId.toLowerCase(),
      objectMetadataUniversalIdentifier:
        objMap.universalIdentifierById[row.objectMetadataId.toLowerCase()],
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }));
    const vfgMap = toMap(viewFieldGroups, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      viewId: row.viewId.toLowerCase(),
      viewUniversalIdentifier:
        viewMap.universalIdentifierById[row.viewId.toLowerCase()],
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }));
    const vfMap = toMap(viewFields, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      viewId: row.viewId.toLowerCase(),
      viewUniversalIdentifier:
        viewMap.universalIdentifierById[row.viewId.toLowerCase()],
      fieldMetadataId: row.fieldMetadataId.toLowerCase(),
      fieldMetadataUniversalIdentifier:
        fieldMap.universalIdentifierById[row.fieldMetadataId.toLowerCase()],
      viewFieldGroupId: row.viewFieldGroupId
        ? row.viewFieldGroupId.toLowerCase()
        : null,
      viewFieldGroupUniversalIdentifier: row.viewFieldGroupId
        ? (vfgMap.universalIdentifierById[row.viewFieldGroupId.toLowerCase()] ??
          null)
        : null,
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }));
    const fcMap = toMap(fcs, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
    }));

    const pltUidById: Record<string, string> = {};
    for (const r of plts) {
      pltUidById[r.id.toLowerCase()] = r.universalIdentifier.toLowerCase();
    }

    const plMap = toMap(pls, (row) => {
      const tabRows = plts.filter(
        (t: any) => t.pageLayoutId.toLowerCase() === row.id.toLowerCase(),
      );
      const navRows = navs.filter(
        (n: any) => n.pageLayoutId?.toLowerCase() === row.id.toLowerCase(),
      );
      const defTabId = row.defaultTabToFocusOnMobileAndSidePanelId
        ? row.defaultTabToFocusOnMobileAndSidePanelId.toLowerCase()
        : null;
      return {
        ...row,
        applicationId: row.applicationId.toLowerCase(),
        applicationUniversalIdentifier:
          appMap.universalIdentifierById[row.applicationId.toLowerCase()],
        objectMetadataId: row.objectMetadataId
          ? row.objectMetadataId.toLowerCase()
          : null,
        objectMetadataUniversalIdentifier: row.objectMetadataId
          ? (objMap.universalIdentifierById[
              row.objectMetadataId.toLowerCase()
            ] ?? null)
          : null,
        defaultTabToFocusOnMobileAndSidePanelId: defTabId,
        defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier: defTabId
          ? (pltUidById[defTabId] ?? null)
          : null,
        tabIds: tabRows.map((t: any) => t.id.toLowerCase()),
        tabUniversalIdentifiers: tabRows.map((t: any) =>
          t.universalIdentifier.toLowerCase(),
        ),
        navigationMenuItemIds: navRows.map((n: any) => n.id.toLowerCase()),
        navigationMenuItemUniversalIdentifiers: navRows.map((n: any) =>
          n.universalIdentifier.toLowerCase(),
        ),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
      };
    });

    const pltMap = toMap(plts, (row) => {
      const widgetRows = plws.filter(
        (w: any) => w.pageLayoutTabId.toLowerCase() === row.id.toLowerCase(),
      );
      return {
        ...row,
        applicationId: row.applicationId.toLowerCase(),
        applicationUniversalIdentifier:
          appMap.universalIdentifierById[row.applicationId.toLowerCase()],
        pageLayoutId: row.pageLayoutId.toLowerCase(),
        pageLayoutUniversalIdentifier:
          plMap.universalIdentifierById[row.pageLayoutId.toLowerCase()],
        widgetIds: widgetRows.map((w: any) => w.id.toLowerCase()),
        widgetUniversalIdentifiers: widgetRows.map((w: any) =>
          w.universalIdentifier.toLowerCase(),
        ),
        overrides: row.overrides ?? null,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
      };
    });

    const plwMap = toMap(plws, (row) => {
      const overrides = row.overrides ?? null;
      const universalOverrides = overrides
        ? {
            ...overrides,
            ...(overrides.pageLayoutTabId
              ? {
                  pageLayoutTabUniversalIdentifier:
                    pltMap.universalIdentifierById[
                      overrides.pageLayoutTabId.toLowerCase()
                    ],
                }
              : {}),
          }
        : null;
      if (universalOverrides && 'pageLayoutTabId' in universalOverrides) {
        delete (universalOverrides as any).pageLayoutTabId;
      }
      const cfg = row.configuration ?? {};
      let universalConfiguration = { ...cfg };
      if (
        cfg.configurationType === WidgetConfigurationType.FORM_FIELD ||
        cfg.configurationType === WidgetConfigurationType.FIELD ||
        cfg.configurationType === WidgetConfigurationType.FIELD_RICH_TEXT
      ) {
        universalConfiguration = {
          ...cfg,
          fieldMetadataId:
            fieldMap.universalIdentifierById[
              String(cfg.fieldMetadataId).toLowerCase()
            ] ?? cfg.fieldMetadataId,
          ...(cfg.viewId
            ? {
                viewId:
                  viewMap.universalIdentifierById[
                    String(cfg.viewId).toLowerCase()
                  ] ?? cfg.viewId,
              }
            : {}),
        };
      } else if (cfg.configurationType === WidgetConfigurationType.FIELDS) {
        const { viewId: cfgViewId, ...restCfg } = cfg;
        universalConfiguration = {
          ...restCfg,
          viewUniversalIdentifier: cfgViewId
            ? (viewMap.universalIdentifierById[
                String(cfgViewId).toLowerCase()
              ] ?? null)
            : null,
        };
      } else if (
        cfg.configurationType === WidgetConfigurationType.FRONT_COMPONENT
      ) {
        const { frontComponentId: cfgFcId, ...restCfg } = cfg;
        universalConfiguration = {
          ...restCfg,
          frontComponentUniversalIdentifier:
            fcMap.universalIdentifierById[String(cfgFcId).toLowerCase()] ??
            cfgFcId,
        };
      } else if (
        cfg.configurationType === WidgetConfigurationType.AGGREGATE_CHART
      ) {
        const { aggregateFieldMetadataId, ...restCfg } = cfg;
        universalConfiguration = {
          ...restCfg,
          aggregateFieldMetadataUniversalIdentifier:
            fieldMap.universalIdentifierById[
              String(aggregateFieldMetadataId).toLowerCase()
            ] ?? aggregateFieldMetadataId,
        };
      }
      return {
        ...row,
        applicationId: row.applicationId.toLowerCase(),
        applicationUniversalIdentifier:
          appMap.universalIdentifierById[row.applicationId.toLowerCase()],
        pageLayoutTabId: row.pageLayoutTabId.toLowerCase(),
        pageLayoutTabUniversalIdentifier:
          pltMap.universalIdentifierById[row.pageLayoutTabId.toLowerCase()],
        objectMetadataId: row.objectMetadataId
          ? row.objectMetadataId.toLowerCase()
          : null,
        objectMetadataUniversalIdentifier: row.objectMetadataId
          ? (objMap.universalIdentifierById[
              row.objectMetadataId.toLowerCase()
            ] ?? null)
          : null,
        configuration: cfg,
        universalConfiguration,
        overrides,
        universalOverrides,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
      };
    });

    const navMap = toMap(navs, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      pageLayoutId: row.pageLayoutId ? row.pageLayoutId.toLowerCase() : null,
      pageLayoutUniversalIdentifier: row.pageLayoutId
        ? (plMap.universalIdentifierById[row.pageLayoutId.toLowerCase()] ??
          null)
        : null,
      targetObjectMetadataId: row.targetObjectMetadataId
        ? row.targetObjectMetadataId.toLowerCase()
        : null,
      targetObjectMetadataUniversalIdentifier: row.targetObjectMetadataId
        ? (objMap.universalIdentifierById[
            row.targetObjectMetadataId.toLowerCase()
          ] ?? null)
        : null,
    }));

    const cmiMap = toMap(cmis, (row) => ({
      ...row,
      applicationId: row.applicationId.toLowerCase(),
      applicationUniversalIdentifier:
        appMap.universalIdentifierById[row.applicationId.toLowerCase()],
      pageLayoutId: row.pageLayoutId ? row.pageLayoutId.toLowerCase() : null,
      pageLayoutUniversalIdentifier: row.pageLayoutId
        ? (plMap.universalIdentifierById[row.pageLayoutId.toLowerCase()] ??
          null)
        : null,
      frontComponentId: row.frontComponentId
        ? row.frontComponentId.toLowerCase()
        : null,
      frontComponentUniversalIdentifier: row.frontComponentId
        ? (fcMap.universalIdentifierById[row.frontComponentId.toLowerCase()] ??
          null)
        : null,
      availabilityObjectMetadataId: row.availabilityObjectMetadataId
        ? row.availabilityObjectMetadataId.toLowerCase()
        : null,
      availabilityObjectMetadataUniversalIdentifier:
        row.availabilityObjectMetadataId
          ? (objMap.universalIdentifierById[
              row.availabilityObjectMetadataId.toLowerCase()
            ] ?? null)
          : null,
      navigationTargetObjectMetadataId: row.navigationTargetObjectMetadataId
        ? row.navigationTargetObjectMetadataId.toLowerCase()
        : null,
      navigationTargetObjectMetadataUniversalIdentifier:
        row.navigationTargetObjectMetadataId
          ? (objMap.universalIdentifierById[
              row.navigationTargetObjectMetadataId.toLowerCase()
            ] ?? null)
          : null,
    }));

    const emptyMap = {
      byId: {},
      byUniversalIdentifier: {},
      idByUniversalIdentifier: {},
      universalIdentifierById: {},
    };

    return {
      flatApplicationMaps: appMap,
      flatObjectMetadataMaps: objMap,
      flatFieldMetadataMaps: fieldMap,
      flatIndexMaps: emptyMap,
      flatViewMaps: viewMap,
      flatViewFieldGroupMaps: vfgMap,
      flatViewFieldMaps: vfMap,
      flatViewFilterMaps: emptyMap,
      flatViewGroupMaps: emptyMap,
      flatFrontComponentMaps: fcMap,
      flatPageLayoutMaps: plMap,
      flatPageLayoutTabMaps: pltMap,
      flatPageLayoutWidgetMaps: plwMap,
      flatNavigationMenuItemMaps: navMap,
      flatCommandMenuItemMaps: cmiMap,
      flatObjectPermissionMaps: emptyMap,
      flatFieldPermissionMaps: emptyMap,
      flatRowLevelPermissionPredicateGroupMaps: emptyMap,
      flatRowLevelPermissionPredicateMaps: emptyMap,
    };
  };

  const buildHarness = () => {
    const cacheService = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest
        .fn()
        .mockImplementation(() => buildMapsFromDb()),
      invalidateFlatEntityMaps: jest.fn(),
    };
    const workspaceCacheService = {
      getOrRecompute: jest.fn().mockImplementation(() => buildMapsFromDb()),
      invalidateAndRecompute: jest.fn().mockResolvedValue(undefined),
    };
    const applicationService = {
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

    const actionHandlerRegistry = {
      executeActionHandler: jest.fn().mockImplementation(
        async ({
          action,
          context,
        }: {
          action: any;
          context: {
            queryRunner: QueryRunner;
            workspaceId: string;
            flatApplication: { id: string; universalIdentifier: string };
            allFlatEntityMaps: any;
          };
        }) => {
          const {
            queryRunner,
            workspaceId: wsId,
            flatApplication,
            allFlatEntityMaps,
          } = context;
          const resolveId = (
            map: any,
            uid: string | null | undefined,
          ): string | null => {
            if (!uid) return null;
            return (
              map?.idByUniversalIdentifier?.[uid.toLowerCase()] ??
              uid.toLowerCase()
            );
          };

          if (action.metadataName === 'pageLayout') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const objId =
                fe.objectMetadataId ??
                resolveId(
                  allFlatEntityMaps.flatObjectMetadataMaps,
                  fe.objectMetadataUniversalIdentifier,
                );
              const defTabId =
                fe.defaultTabToFocusOnMobileAndSidePanelId ??
                resolveId(
                  allFlatEntityMaps.flatPageLayoutTabMaps,
                  fe.defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier,
                );
              await queryRunner.query(
                `INSERT INTO core."pageLayout" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, type, "objectMetadataId",
                   "defaultTabToFocusOnMobileAndSidePanelId",
                   "isSystemSideEffect", "isFirstTabPinned"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  id,
                  wsId,
                  flatApplication.id,
                  fe.universalIdentifier.toLowerCase(),
                  fe.name,
                  fe.type ?? PageLayoutType.RECORD_PAGE,
                  objId,
                  defTabId,
                  fe.isSystemSideEffect ?? false,
                  fe.isFirstTabPinned ?? true,
                ],
              );
              const plItem = {
                id,
                universalIdentifier: fe.universalIdentifier.toLowerCase(),
                objectMetadataId: objId,
                defaultTabToFocusOnMobileAndSidePanelId: defTabId,
              };
              allFlatEntityMaps.flatPageLayoutMaps.byId[id] = plItem;
              allFlatEntityMaps.flatPageLayoutMaps.byUniversalIdentifier[
                plItem.universalIdentifier
              ] = plItem;
              allFlatEntityMaps.flatPageLayoutMaps.idByUniversalIdentifier[
                plItem.universalIdentifier
              ] = id;
              allFlatEntityMaps.flatPageLayoutMaps.universalIdentifierById[id] =
                plItem.universalIdentifier;
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatPageLayoutMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update;
              const nextName = 'name' in upd ? upd.name : existing.name;
              const nextType = 'type' in upd ? upd.type : existing.type;
              const nextObjId =
                'objectMetadataUniversalIdentifier' in upd
                  ? resolveId(
                      allFlatEntityMaps.flatObjectMetadataMaps,
                      upd.objectMetadataUniversalIdentifier,
                    )
                  : 'objectMetadataId' in upd
                    ? upd.objectMetadataId
                    : existing.objectMetadataId;
              const nextDefTabId =
                'defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier' in
                upd
                  ? resolveId(
                      allFlatEntityMaps.flatPageLayoutTabMaps,
                      upd.defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier,
                    )
                  : 'defaultTabToFocusOnMobileAndSidePanelId' in upd
                    ? upd.defaultTabToFocusOnMobileAndSidePanelId
                    : existing.defaultTabToFocusOnMobileAndSidePanelId;
              const nextPinned =
                'isFirstTabPinned' in upd
                  ? upd.isFirstTabPinned
                  : existing.isFirstTabPinned;
              await queryRunner.query(
                `UPDATE core."pageLayout"
                 SET name=$1, type=$2, "objectMetadataId"=$3,
                     "defaultTabToFocusOnMobileAndSidePanelId"=$4,
                     "isFirstTabPinned"=$5, "updatedAt"=now()
                 WHERE id=$6 AND "workspaceId"=$7`,
                [
                  nextName,
                  nextType,
                  nextObjId,
                  nextDefTabId,
                  nextPinned,
                  existing.id,
                  wsId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatPageLayoutMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."pageLayout" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
              );
            }
          } else if (action.metadataName === 'pageLayoutTab') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const plId =
                fe.pageLayoutId ??
                resolveId(
                  allFlatEntityMaps.flatPageLayoutMaps,
                  fe.pageLayoutUniversalIdentifier,
                );
              await queryRunner.query(
                `INSERT INTO core."pageLayoutTab" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   title, position, "pageLayoutId", "layoutMode",
                   icon, "isActive", "isSystemSideEffect", overrides
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  id,
                  wsId,
                  flatApplication.id,
                  fe.universalIdentifier.toLowerCase(),
                  fe.title,
                  fe.position ?? 0,
                  plId,
                  fe.layoutMode ?? PageLayoutTabLayoutMode.GRID,
                  fe.icon ?? null,
                  fe.isActive ?? true,
                  fe.isSystemSideEffect ?? false,
                  fe.overrides ?? null,
                ],
              );
              const tabItem = {
                id,
                universalIdentifier: fe.universalIdentifier.toLowerCase(),
                pageLayoutId: plId,
              };
              allFlatEntityMaps.flatPageLayoutTabMaps.byId[id] = tabItem;
              allFlatEntityMaps.flatPageLayoutTabMaps.byUniversalIdentifier[
                tabItem.universalIdentifier
              ] = tabItem;
              allFlatEntityMaps.flatPageLayoutTabMaps.idByUniversalIdentifier[
                tabItem.universalIdentifier
              ] = id;
              allFlatEntityMaps.flatPageLayoutTabMaps.universalIdentifierById[
                id
              ] = tabItem.universalIdentifier;
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatPageLayoutTabMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update;
              await queryRunner.query(
                `UPDATE core."pageLayoutTab"
                 SET title=$1, position=$2, "layoutMode"=$3, icon=$4,
                     "isActive"=$5, overrides=$6, "updatedAt"=now()
                 WHERE id=$7 AND "workspaceId"=$8`,
                [
                  'title' in upd ? upd.title : existing.title,
                  'position' in upd ? upd.position : existing.position,
                  'layoutMode' in upd ? upd.layoutMode : existing.layoutMode,
                  'icon' in upd ? upd.icon : existing.icon,
                  'isActive' in upd ? upd.isActive : existing.isActive,
                  'overrides' in upd ? upd.overrides : existing.overrides,
                  existing.id,
                  wsId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatPageLayoutTabMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."pageLayoutTab" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
              );
            }
          } else if (action.metadataName === 'pageLayoutWidget') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const tabId =
                fe.pageLayoutTabId ??
                resolveId(
                  allFlatEntityMaps.flatPageLayoutTabMaps,
                  fe.pageLayoutTabUniversalIdentifier,
                );
              const objId =
                fe.objectMetadataId ??
                resolveId(
                  allFlatEntityMaps.flatObjectMetadataMaps,
                  fe.objectMetadataUniversalIdentifier,
                );
              const cfg = fe.universalConfiguration
                ? fromUniversalConfigurationToFlatPageLayoutWidgetConfiguration(
                    {
                      universalConfiguration: fe.universalConfiguration,
                      flatFieldMetadataMaps:
                        allFlatEntityMaps.flatFieldMetadataMaps,
                      flatFrontComponentMaps:
                        allFlatEntityMaps.flatFrontComponentMaps,
                      flatViewMaps: allFlatEntityMaps.flatViewMaps,
                      flatViewFieldGroupMaps:
                        allFlatEntityMaps.flatViewFieldGroupMaps,
                    },
                  )
                : fe.configuration;
              const overrides = fe.universalOverrides
                ? fromUniversalOverridesToPageLayoutWidgetOverrides({
                    universalOverrides: fe.universalOverrides,
                    flatPageLayoutTabMaps:
                      allFlatEntityMaps.flatPageLayoutTabMaps,
                  })
                : (fe.overrides ?? null);
              const gridPosition = fe.gridPosition ?? {
                row: 0,
                column: 0,
                rowSpan: 1,
                columnSpan: 12,
              };
              await queryRunner.query(
                `INSERT INTO core."pageLayoutWidget" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "pageLayoutTabId", title, type, "objectMetadataId",
                   "gridPosition", position, configuration,
                   "isActive", "isSystemSideEffect", overrides,
                   "conditionalDisplay", "conditionalAvailabilityExpression"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [
                  id,
                  wsId,
                  flatApplication.id,
                  fe.universalIdentifier.toLowerCase(),
                  tabId,
                  fe.title,
                  fe.type,
                  objId,
                  gridPosition,
                  fe.position ?? null,
                  cfg,
                  fe.isActive ?? true,
                  fe.isSystemSideEffect ?? false,
                  overrides,
                  fe.conditionalDisplay ?? null,
                  fe.conditionalAvailabilityExpression ?? null,
                ],
              );
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatPageLayoutWidgetMaps
                  .byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update;
              const nextTabId =
                'pageLayoutTabUniversalIdentifier' in upd
                  ? resolveId(
                      allFlatEntityMaps.flatPageLayoutTabMaps,
                      upd.pageLayoutTabUniversalIdentifier,
                    )
                  : 'pageLayoutTabId' in upd
                    ? upd.pageLayoutTabId
                    : existing.pageLayoutTabId;
              const nextObjId =
                'objectMetadataUniversalIdentifier' in upd
                  ? resolveId(
                      allFlatEntityMaps.flatObjectMetadataMaps,
                      upd.objectMetadataUniversalIdentifier,
                    )
                  : 'objectMetadataId' in upd
                    ? upd.objectMetadataId
                    : existing.objectMetadataId;
              const nextCfg =
                'universalConfiguration' in upd &&
                upd.universalConfiguration !== undefined
                  ? fromUniversalConfigurationToFlatPageLayoutWidgetConfiguration(
                      {
                        universalConfiguration: upd.universalConfiguration,
                        flatFieldMetadataMaps:
                          allFlatEntityMaps.flatFieldMetadataMaps,
                        flatFrontComponentMaps:
                          allFlatEntityMaps.flatFrontComponentMaps,
                        flatViewMaps: allFlatEntityMaps.flatViewMaps,
                        flatViewFieldGroupMaps:
                          allFlatEntityMaps.flatViewFieldGroupMaps,
                      },
                    )
                  : 'configuration' in upd && upd.configuration !== undefined
                    ? upd.configuration
                    : existing.configuration;
              const nextOverrides =
                'universalOverrides' in upd &&
                upd.universalOverrides !== undefined
                  ? upd.universalOverrides === null
                    ? null
                    : fromUniversalOverridesToPageLayoutWidgetOverrides({
                        universalOverrides: upd.universalOverrides,
                        flatPageLayoutTabMaps:
                          allFlatEntityMaps.flatPageLayoutTabMaps,
                      })
                  : 'overrides' in upd && upd.overrides !== undefined
                    ? upd.overrides
                    : existing.overrides;
              await queryRunner.query(
                `UPDATE core."pageLayoutWidget"
                 SET "pageLayoutTabId"=$1, title=$2, type=$3, "objectMetadataId"=$4,
                     "gridPosition"=$5, position=$6, configuration=$7,
                     "isActive"=$8, overrides=$9,
                     "conditionalDisplay"=$10, "conditionalAvailabilityExpression"=$11,
                     "updatedAt"=now()
                 WHERE id=$12 AND "workspaceId"=$13`,
                [
                  nextTabId,
                  'title' in upd ? upd.title : existing.title,
                  'type' in upd ? upd.type : existing.type,
                  nextObjId,
                  'gridPosition' in upd
                    ? upd.gridPosition
                    : existing.gridPosition,
                  'position' in upd ? upd.position : existing.position,
                  nextCfg,
                  'isActive' in upd ? upd.isActive : existing.isActive,
                  nextOverrides,
                  'conditionalDisplay' in upd
                    ? upd.conditionalDisplay
                    : existing.conditionalDisplay,
                  'conditionalAvailabilityExpression' in upd
                    ? upd.conditionalAvailabilityExpression
                    : existing.conditionalAvailabilityExpression,
                  existing.id,
                  wsId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatPageLayoutWidgetMaps
                  .byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."pageLayoutWidget" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
              );
            }
          } else if (action.metadataName === 'navigationMenuItem') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const plId =
                fe.pageLayoutId ??
                resolveId(
                  allFlatEntityMaps.flatPageLayoutMaps,
                  fe.pageLayoutUniversalIdentifier,
                );
              await queryRunner.query(
                `INSERT INTO core."navigationMenuItem" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   type, name, icon, color, link, position, "pageLayoutId"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [
                  id,
                  wsId,
                  flatApplication.id,
                  fe.universalIdentifier.toLowerCase(),
                  fe.type ?? NavigationMenuItemType.PAGE_LAYOUT,
                  fe.name ?? null,
                  fe.icon ?? null,
                  fe.color ?? null,
                  fe.link ?? null,
                  fe.position ?? 0,
                  plId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatNavigationMenuItemMaps
                  .byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."navigationMenuItem" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
              );
            }
          } else if (action.metadataName === 'commandMenuItem') {
            if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatCommandMenuItemMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."commandMenuItem" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
              );
            }
          } else if (
            action.metadataName === 'objectMetadata' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
                action.universalIdentifier.toLowerCase()
              ];
            await queryRunner.query(
              `DELETE FROM core."objectMetadata" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, wsId],
            );
          } else if (action.metadataName === 'fieldMetadata') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const objId =
                fe.objectMetadataId ??
                resolveId(
                  allFlatEntityMaps.flatObjectMetadataMaps,
                  fe.objectMetadataUniversalIdentifier,
                );
              await queryRunner.query(
                `INSERT INTO core."fieldMetadata" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "objectMetadataId", type, name, label, "isActive", "isCustom", "isSystem"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true,false)`,
                [
                  id,
                  wsId,
                  flatApplication.id,
                  fe.universalIdentifier.toLowerCase(),
                  objId,
                  fe.type ?? 'TEXT',
                  fe.name ?? 'customField',
                  fe.label ?? 'Custom Field',
                ],
              );
              const fItem = {
                id,
                universalIdentifier: fe.universalIdentifier.toLowerCase(),
                objectMetadataId: objId,
              };
              allFlatEntityMaps.flatFieldMetadataMaps.byId[id] = fItem;
              allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
                fItem.universalIdentifier
              ] = fItem;
              allFlatEntityMaps.flatFieldMetadataMaps.idByUniversalIdentifier[
                fItem.universalIdentifier
              ] = id;
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update;
              await queryRunner.query(
                `UPDATE core."fieldMetadata"
                 SET "isActive"=$1, "updatedAt"=now()
                 WHERE id=$2 AND "workspaceId"=$3`,
                [
                  'isActive' in upd ? upd.isActive : existing.isActive,
                  existing.id,
                  wsId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."fieldMetadata" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, wsId],
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

    const buildDiffUpdate = (existing: any, updated: any) => {
      const diff: Record<string, any> = {};
      for (const key of Object.keys(updated)) {
        if (
          key === 'id' ||
          key === 'workspaceId' ||
          key === 'applicationId' ||
          key === 'applicationUniversalIdentifier' ||
          key === 'universalIdentifier' ||
          key === 'createdAt' ||
          key === 'updatedAt' ||
          key === 'deletedAt' ||
          key === 'tabIds' ||
          key === 'tabUniversalIdentifiers' ||
          key === 'widgetIds' ||
          key === 'widgetUniversalIdentifiers' ||
          key === 'navigationMenuItemIds' ||
          key === 'navigationMenuItemUniversalIdentifiers'
        ) {
          continue;
        }
        diff[key] = updated[key];
      }
      if ('configuration' in diff && !('universalConfiguration' in diff)) {
        delete diff.configuration;
      }
      if ('overrides' in diff && 'universalOverrides' in diff) {
        delete diff.overrides;
      }
      return diff;
    };

    const validateBuildAndRunMock = jest.fn().mockImplementation(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: targetWorkspaceId,
        applicationUniversalIdentifier,
      }: {
        allFlatEntityOperationByMetadataName: Record<
          string,
          {
            flatEntityToCreate?: any[];
            flatEntityToUpdate?: any[];
            flatEntityToDelete?: any[];
          }
        >;
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const currentMaps = await buildMapsFromDb();
        const actions: any[] = [];
        for (const [metadataName, ops] of Object.entries(
          allFlatEntityOperationByMetadataName,
        )) {
          for (const createEntity of ops.flatEntityToCreate ?? []) {
            actions.push({
              type: 'create',
              metadataName,
              id: createEntity.id,
              flatEntity: createEntity,
            });
          }
          for (const updateEntity of ops.flatEntityToUpdate ?? []) {
            const mapKey =
              metadataName === 'pageLayout'
                ? 'flatPageLayoutMaps'
                : metadataName === 'pageLayoutTab'
                  ? 'flatPageLayoutTabMaps'
                  : metadataName === 'pageLayoutWidget'
                    ? 'flatPageLayoutWidgetMaps'
                    : metadataName === 'fieldMetadata'
                      ? 'flatFieldMetadataMaps'
                      : undefined;
            const existing = mapKey
              ? (currentMaps as any)[mapKey]?.byUniversalIdentifier?.[
                  updateEntity.universalIdentifier.toLowerCase()
                ]
              : undefined;
            actions.push({
              type: 'update',
              metadataName,
              universalIdentifier: updateEntity.universalIdentifier,
              update: existing
                ? buildDiffUpdate(existing, updateEntity)
                : updateEntity,
            });
          }
          for (const deleteEntity of ops.flatEntityToDelete ?? []) {
            actions.push({
              type: 'delete',
              metadataName,
              universalIdentifier: deleteEntity.universalIdentifier,
            });
          }
        }
        await runnerService.run({
          workspaceId: targetWorkspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier,
            actions,
          } as never,
        });
        return {
          status: 'success',
          workspaceMigration: { actions },
        };
      },
    );

    const dashboardSyncMock = {
      updateLinkedDashboardsUpdatedAtByPageLayoutId: jest
        .fn()
        .mockResolvedValue(undefined),
      updateLinkedDashboardsUpdatedAtByTabId: jest
        .fn()
        .mockResolvedValue(undefined),
      updateLinkedDashboardsUpdatedAtByWidgetId: jest
        .fn()
        .mockResolvedValue(undefined),
    };

    const viewServiceMock = {
      destroyOne: jest.fn().mockResolvedValue(true),
    };

    const pageLayoutService = new PageLayoutService(
      { executeInWorkspaceContext: jest.fn() } as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
      dashboardSyncMock as never,
    );

    const pageLayoutUpdateService = new PageLayoutUpdateService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
      dashboardSyncMock as never,
      viewServiceMock as never,
    );

    const pageLayoutResetService = new PageLayoutResetService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
      dashboardSyncMock as never,
      viewServiceMock as never,
    );

    const pageLayoutDuplicationService = new PageLayoutDuplicationService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
    );

    const pageLayoutTabService = new PageLayoutTabService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
      dashboardSyncMock as never,
    );

    const pageLayoutWidgetService = new PageLayoutWidgetService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationService as never,
      dashboardSyncMock as never,
    );

    const pageLayoutResolver = new PageLayoutResolver(
      pageLayoutService,
      pageLayoutUpdateService,
      pageLayoutResetService,
      {
        buildEffectiveEntityI18nContext: jest.fn().mockResolvedValue({}),
      } as never,
    );

    const pageLayoutController = new PageLayoutController(pageLayoutService, {
      resolveTranslatablePropertiesForEntities: jest
        .fn()
        .mockImplementation(async ({ entities }) => entities),
    } as never);

    const pageLayoutTabResolver = new PageLayoutTabResolver(
      pageLayoutTabService,
      {
        buildEffectiveEntityI18nContext: jest.fn().mockResolvedValue({}),
      } as never,
    );

    const pageLayoutTabController = new PageLayoutTabController(
      pageLayoutTabService,
      {
        resolveTranslatablePropertiesForEntities: jest
          .fn()
          .mockImplementation(async ({ entities }) => entities),
      } as never,
    );

    const pageLayoutWidgetResolver = new PageLayoutWidgetResolver(
      pageLayoutWidgetService,
      {
        buildEffectiveEntityI18nContext: jest.fn().mockResolvedValue({}),
      } as never,
    );

    const pageLayoutWidgetController = new PageLayoutWidgetController(
      pageLayoutWidgetService,
      {
        resolveTranslatablePropertiesForEntities: jest
          .fn()
          .mockImplementation(async ({ entities }) => entities),
      } as never,
    );

    return {
      cacheService,
      workspaceCacheService,
      applicationService,
      actionHandlerRegistry,
      runnerService,
      validateBuildAndRunMock,
      pageLayoutService,
      pageLayoutUpdateService,
      pageLayoutResetService,
      pageLayoutDuplicationService,
      pageLayoutTabService,
      pageLayoutWidgetService,
      pageLayoutResolver,
      pageLayoutController,
      pageLayoutTabResolver,
      pageLayoutTabController,
      pageLayoutWidgetResolver,
      pageLayoutWidgetController,
    };
  };

  it('audits direct create, update, and destroy across PageLayout, PageLayoutTab, and PageLayoutWidget resolvers and controllers with redaction of content and configuration fields', async () => {
    const {
      pageLayoutResolver,
      pageLayoutController,
      pageLayoutTabResolver,
      pageLayoutTabController,
      pageLayoutWidgetResolver,
      pageLayoutWidgetController,
    } = buildHarness();

    const wsEntity = { id: workspaceId } as never;
    const memberReq = {
      workspace: { id: workspaceId },
      user: { id: ownerUserId },
      workspaceMemberId: ownerWorkspaceMemberId,
      userWorkspaceId: ownerUserWorkspaceId,
      impersonationContext: {
        impersonatorUserWorkspaceId,
      },
    };
    const apiKeyReq = {
      workspace: { id: workspaceId },
      apiKey: { id: apiKeyId },
    };

    // 1. Create pageLayout via GraphQL resolver (impersonated workspaceMember)
    const createdLayout = await pageLayoutResolver.createPageLayout(
      {
        name: 'Confidential Deal Layout',
        type: PageLayoutType.RECORD_PAGE,
        objectMetadataId: companyObjectId,
      },
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    // 2. Create pageLayoutTab via REST controller (apiKey)
    const createdTab = await pageLayoutTabController.create(
      {
        title: 'Secret Financial Tab',
        pageLayoutId: createdLayout.id,
        position: 10,
        icon: 'IconCurrencyDollar',
        layoutMode: PageLayoutTabLayoutMode.GRID,
      } as never,
      wsEntity,
      apiKeyReq as never,
    );

    // 3. Create pageLayoutWidget via GraphQL resolver
    const createdWidget = await pageLayoutWidgetResolver.createPageLayoutWidget(
      {
        pageLayoutTabId: createdTab.id,
        title: 'Secret Revenue Chart',
        type: WidgetType.GRAPH,
        objectMetadataId: companyObjectId,
        gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 6 },
        position: {
          layoutMode: PageLayoutTabLayoutMode.GRID,
          row: 0,
          column: 0,
          rowSpan: 4,
          columnSpan: 6,
        },
        conditionalAvailabilityExpression: 'record.amount > 1000',
        conditionalDisplay: {
          and: [{ field: 'amount', op: 'gt', value: 1000 }],
        },
        configuration: {
          configurationType: WidgetConfigurationType.AGGREGATE_CHART,
          aggregateFieldMetadataId: amountFieldId,
          aggregateOperation: AggregateOperations.SUM,
          displayDataLabel: true,
          label: 'Private Label',
        },
      } as never,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    // 4. Update pageLayoutWidget, pageLayoutTab, and pageLayout
    await pageLayoutWidgetController.update(
      createdWidget.id,
      {
        title: 'Updated Revenue Chart',
        gridPosition: { row: 1, column: 2, rowSpan: 3, columnSpan: 8 },
        conditionalAvailabilityExpression: 'record.amount > 5000',
      } as never,
      wsEntity,
      apiKeyReq as never,
    );

    await pageLayoutTabResolver.updatePageLayoutTab(
      createdTab.id,
      {
        title: 'Renamed Financial Tab',
        position: 20,
        layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      },
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    await pageLayoutController.update(
      createdLayout.id,
      {
        name: 'Renamed Deal Layout',
        type: PageLayoutType.DASHBOARD,
      },
      wsEntity,
      memberReq as never,
    );

    // 5. Destroy widget, tab, and layout
    await pageLayoutWidgetResolver.destroyPageLayoutWidget(
      createdWidget.id,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );
    await pageLayoutTabController.destroy(
      createdTab.id,
      wsEntity,
      apiKeyReq as never,
    );
    await pageLayoutResolver.destroyPageLayout(
      createdLayout.id,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    const entries = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action, actor, initiator, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(9);

    // Verify pageLayout create & update redaction
    expect(entries[0]).toMatchObject({
      resourceKind: 'pageLayout',
      resourceId: createdLayout.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'applicationId',
          'defaultTabToFocusOnMobileAndSidePanelId',
          'isFirstTabPinned',
          'isSystemSideEffect',
          'name',
          'objectMetadataId',
          'type',
        ]),
        values: {
          applicationId: { before: null, after: customApplicationId },
          type: { before: null, after: PageLayoutType.RECORD_PAGE },
          objectMetadataId: { before: null, after: companyObjectId },
          defaultTabToFocusOnMobileAndSidePanelId: {
            before: null,
            after: null,
          },
          isSystemSideEffect: { before: null, after: false },
          isFirstTabPinned: { before: null, after: true },
        },
      },
    });
    expect(entries[0].redactedDiff.values).not.toHaveProperty('name');

    // Verify pageLayoutTab create & update redaction
    expect(entries[1]).toMatchObject({
      resourceKind: 'pageLayoutTab',
      resourceId: createdTab.id,
      action: 'create',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'applicationId',
          'icon',
          'isActive',
          'isSystemSideEffect',
          'layoutMode',
          'overrides',
          'pageLayoutId',
          'position',
          'title',
        ]),
        values: {
          applicationId: { before: null, after: customApplicationId },
          pageLayoutId: { before: null, after: createdLayout.id },
          layoutMode: { before: null, after: PageLayoutTabLayoutMode.GRID },
          isActive: { before: null, after: true },
          isSystemSideEffect: { before: null, after: false },
        },
      },
    });
    expect(entries[1].redactedDiff.values).not.toHaveProperty('title');
    expect(entries[1].redactedDiff.values).not.toHaveProperty('position');
    expect(entries[1].redactedDiff.values).not.toHaveProperty('icon');
    expect(entries[1].redactedDiff.values).not.toHaveProperty('overrides');

    // Verify pageLayoutWidget create & update redaction
    expect(entries[2]).toMatchObject({
      resourceKind: 'pageLayoutWidget',
      resourceId: createdWidget.id,
      action: 'create',
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'applicationId',
          'conditionalAvailabilityExpression',
          'conditionalDisplay',
          'configuration',
          'gridPosition',
          'isActive',
          'isSystemSideEffect',
          'objectMetadataId',
          'overrides',
          'pageLayoutTabId',
          'position',
          'title',
          'type',
        ]),
        values: {
          applicationId: { before: null, after: customApplicationId },
          pageLayoutTabId: { before: null, after: createdTab.id },
          type: { before: null, after: WidgetType.GRAPH },
          objectMetadataId: { before: null, after: companyObjectId },
          isActive: { before: null, after: true },
          isSystemSideEffect: { before: null, after: false },
        },
      },
    });
    expect(entries[2].redactedDiff.values).not.toHaveProperty('title');
    expect(entries[2].redactedDiff.values).not.toHaveProperty('gridPosition');
    expect(entries[2].redactedDiff.values).not.toHaveProperty('position');
    expect(entries[2].redactedDiff.values).not.toHaveProperty('configuration');
    expect(entries[2].redactedDiff.values).not.toHaveProperty('overrides');
    expect(entries[2].redactedDiff.values).not.toHaveProperty(
      'conditionalDisplay',
    );
    expect(entries[2].redactedDiff.values).not.toHaveProperty(
      'conditionalAvailabilityExpression',
    );

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('Confidential Deal Layout');
    expect(serialized).not.toContain('Secret Financial Tab');
    expect(serialized).not.toContain('Secret Revenue Chart');
    expect(serialized).not.toContain('Private Label');
    expect(serialized).not.toContain('record.amount > 1000');

    // Missing auditIdentity fails closed
    await expect(
      pageLayoutResolver.createPageLayout(
        { name: 'Unaudited Layout', type: PageLayoutType.DASHBOARD },
        wsEntity,
      ),
    ).rejects.toThrow(/requires authenticated audit identity/);
  });

  it('audits composite updatePageLayoutWithTabs, resetPageLayoutWidgetToDefault, resetPageLayoutTabToDefault, resetPageLayoutToDefault, duplicate, DashboardToPageLayoutSyncService, dashboard tools, and seedPageLayouts', async () => {
    const {
      pageLayoutService,
      pageLayoutTabService,
      pageLayoutWidgetService,
      pageLayoutResolver,
      pageLayoutDuplicationService,
      validateBuildAndRunMock,
      cacheService,
      applicationService,
    } = buildHarness();

    const wsEntity = { id: workspaceId } as never;
    const memberReq = {
      workspace: { id: workspaceId },
      user: { id: ownerUserId },
      workspaceMemberId: ownerWorkspaceMemberId,
      userWorkspaceId: ownerUserWorkspaceId,
    };

    // Seed a standard RECORD_PAGE layout with a standard tab and FIELDS widget so we can override and reset them
    const stdLayoutId = randomUUID().toLowerCase();
    const stdLayoutUid = randomUUID().toLowerCase();
    const stdTabId = randomUUID().toLowerCase();
    const stdTabUid = randomUUID().toLowerCase();
    const stdWidgetId = randomUUID().toLowerCase();
    const stdWidgetUid = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."pageLayout" (id, "workspaceId", "applicationId", "universalIdentifier", name, type, "objectMetadataId", "isSystemSideEffect", "isFirstTabPinned")
       VALUES ($1,$2,$3,$4,'Standard Company Page','RECORD_PAGE',$5,true,true)`,
      [
        stdLayoutId,
        workspaceId,
        standardApplicationId,
        stdLayoutUid,
        companyObjectId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayoutTab" (id, "workspaceId", "applicationId", "universalIdentifier", title, position, "pageLayoutId", "layoutMode", "isActive", "isSystemSideEffect")
       VALUES ($1,$2,$3,$4,'Overview',0,$5,'GRID',true,true)`,
      [stdTabId, workspaceId, standardApplicationId, stdTabUid, stdLayoutId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayoutWidget" (id, "workspaceId", "applicationId", "universalIdentifier", "pageLayoutTabId", title, type, "objectMetadataId", "gridPosition", configuration, "isActive", "isSystemSideEffect")
       VALUES ($1,$2,$3,$4,$5,'Fields Widget','FIELDS',$6,'{"row":0,"column":0,"rowSpan":4,"columnSpan":12}'::jsonb,$7,true,true)`,
      [
        stdWidgetId,
        workspaceId,
        standardApplicationId,
        stdWidgetUid,
        stdTabId,
        companyObjectId,
        {
          configurationType: WidgetConfigurationType.FIELDS,
          viewId,
          newFieldDefaultVisibility: true,
        },
      ],
    );

    // 1. updatePageLayoutWithTabsAndWidgets: override stdTab title, override stdWidget title, add a new custom tab and custom widget
    const customTabId = randomUUID().toLowerCase();
    const customWidgetId = randomUUID().toLowerCase();

    await pageLayoutResolver.updatePageLayoutWithTabsAndWidgets(
      stdLayoutId,
      {
        name: 'Customized Company Page',
        type: PageLayoutType.RECORD_PAGE,
        objectMetadataId: companyObjectId,
        isFirstTabPinned: false,
        tabs: [
          {
            id: stdTabId,
            title: 'Overridden Overview',
            position: 0,
            widgets: [
              {
                id: stdWidgetId,
                pageLayoutTabId: stdTabId,
                title: 'Overridden Fields Widget',
                type: WidgetType.FIELDS,
                objectMetadataId: companyObjectId,
                gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 12 },
                configuration: {
                  configurationType: WidgetConfigurationType.FIELDS,
                  viewId,
                  newFieldDefaultVisibility: true,
                },
              },
            ],
          },
          {
            id: customTabId,
            title: 'Custom Extra Tab',
            position: 1,
            widgets: [
              {
                id: customWidgetId,
                pageLayoutTabId: customTabId,
                title: 'Custom Front Component Widget',
                type: WidgetType.FRONT_COMPONENT,
                objectMetadataId: null,
                gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 6 },
                configuration: {
                  configurationType: WidgetConfigurationType.FRONT_COMPONENT,
                  frontComponentId,
                },
              },
            ],
          },
        ],
      } as never,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    // 2. Reset widget, tab, and layout to default
    await pageLayoutResolver.resetPageLayoutWidgetToDefault(
      stdWidgetId,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );
    await pageLayoutResolver.resetPageLayoutTabToDefault(
      stdTabId,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );
    await pageLayoutResolver.resetPageLayoutToDefault(
      stdLayoutId,
      wsEntity,
      ownerUserWorkspaceId,
      { req: memberReq },
    );

    // 3. Duplicate layout via PageLayoutDuplicationService
    const dashLayoutToDup = await pageLayoutService.create({
      createPageLayoutInput: {
        name: 'Dashboard To Duplicate',
        type: PageLayoutType.DASHBOARD,
      },
      workspaceId,
      auditIdentity: memberReq,
    });
    const dashTabToDup = await pageLayoutTabService.create({
      createPageLayoutTabInput: {
        title: 'Dash Tab To Duplicate',
        pageLayoutId: dashLayoutToDup.id,
        position: 0,
      },
      workspaceId,
      auditIdentity: memberReq,
    });
    await pageLayoutWidgetService.create({
      input: {
        pageLayoutTabId: dashTabToDup.id,
        title: 'Dash Widget To Duplicate',
        type: WidgetType.FRONT_COMPONENT,
        gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 6 },
        configuration: {
          configurationType: WidgetConfigurationType.FRONT_COMPONENT,
          frontComponentId,
        },
      } as never,
      workspaceId,
      auditIdentity: memberReq,
    });
    const duplicated = await pageLayoutDuplicationService.duplicate({
      pageLayoutId: dashLayoutToDup.id,
      workspaceId,
      auditIdentity: memberReq,
    });
    expect(duplicated.id).not.toBe(dashLayoutToDup.id);

    // 4. DashboardToPageLayoutSyncService + DashboardToolWorkspaceService + seedPageLayouts
    const syncService = new DashboardToPageLayoutSyncService(
      {
        executeInWorkspaceContext: jest
          .fn()
          .mockImplementation(async (fn) => fn()),
        getRepository: jest.fn().mockReturnValue({
          find: jest.fn().mockResolvedValue([{ pageLayoutId: duplicated.id }]),
        }),
      } as never,
      pageLayoutService,
      pageLayoutTabService,
    );
    const syncedLayoutId = await syncService.createPageLayoutForDashboard({
      workspaceId,
      auditIdentity: memberReq,
    });
    expect(syncedLayoutId).toBeDefined();
    await syncService.destroyPageLayoutsForDashboards({
      dashboardIds: [randomUUID()],
      workspaceId,
      auditIdentity: memberReq,
    });

    const toolWorkspaceService = new DashboardToolWorkspaceService(
      pageLayoutService,
      pageLayoutTabService,
      pageLayoutWidgetService,
      {
        executeInWorkspaceContext: jest
          .fn()
          .mockImplementation(async (fn) => fn()),
        getRepository: jest.fn().mockReturnValue({
          insert: jest.fn().mockResolvedValue(undefined),
        }),
      } as never,
      { buildRecordPosition: jest.fn().mockResolvedValue(1) } as never,
      applicationService as never,
      cacheService as never,
    );
    const tools = toolWorkspaceService.generateDashboardTools(
      workspaceId,
      {} as never,
      {
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
          agentId,
        },
        authUserWorkspaceId: ownerUserWorkspaceId,
      },
    );
    const createdDashboardOut = await (
      tools.create_complete_dashboard as any
    ).execute({
      title: 'Agent Executive Dashboard',
      tabTitle: 'KPIs',
      widgets: [],
    });
    expect(createdDashboardOut.success).toBe(true);

    for (const def of getSeedFrontComponentDefinitions(workspaceId)) {
      await ownerDataSource.query(
        `INSERT INTO core."frontComponent" (id, "workspaceId", "applicationId", "universalIdentifier", name, "sourceComponentPath", "builtComponentPath", "componentName", "builtComponentChecksum")
         VALUES ($1, $2, $3, $4, $5, 'src/Seed.tsx', 'dist/Seed.mjs', 'Seed', 'sha256-seed')`,
        [
          def.id.toLowerCase(),
          workspaceId,
          customApplicationId,
          def.universalIdentifier.toLowerCase(),
          def.name,
        ],
      );
    }
    await seedPageLayouts({
      workspaceId,
      flatApplication: {
        id: customApplicationId,
        universalIdentifier: customApplicationUniversalId,
        workspaceId,
      } as never,
      objectMetadataItems: [],
      workspaceMigrationValidateBuildAndRunService: {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
    });

    const auditCounts = await ownerDataSource.query(
      `SELECT "resourceKind", action, count(*)::int AS cnt
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       GROUP BY "resourceKind", action`,
      [workspaceId],
    );
    const findCount = (kind: string, act: string) =>
      auditCounts.find((r: any) => r.resourceKind === kind && r.action === act)
        ?.cnt ?? 0;

    expect(findCount('pageLayout', 'create')).toBeGreaterThanOrEqual(7);
    expect(findCount('pageLayout', 'update')).toBeGreaterThanOrEqual(2);
    expect(findCount('pageLayout', 'delete')).toBeGreaterThanOrEqual(1);
    expect(findCount('pageLayoutTab', 'create')).toBeGreaterThanOrEqual(10);
    expect(findCount('pageLayoutTab', 'update')).toBeGreaterThanOrEqual(2);
    expect(findCount('pageLayoutTab', 'delete')).toBeGreaterThanOrEqual(1);
    expect(findCount('pageLayoutWidget', 'create')).toBeGreaterThanOrEqual(5);
    expect(findCount('pageLayoutWidget', 'update')).toBeGreaterThanOrEqual(2);
  });

  it('audits ON DELETE SET NULL on defaultTabToFocusOnMobileAndSidePanelId, ON DELETE CASCADE from pageLayout and objectMetadata, and FieldMetadataService side-effect widget mutations', async () => {
    const {
      runnerService,
      pageLayoutService,
      pageLayoutTabService,
      pageLayoutWidgetService,
      validateBuildAndRunMock,
      cacheService,
      workspaceCacheService,
      applicationService,
    } = buildHarness();

    const memberIdentity = {
      user: { id: ownerUserId },
      workspaceMemberId: ownerWorkspaceMemberId,
    };

    // Create a layout and two tabs, set defaultTabToFocusOnMobileAndSidePanelId to tab1, then delete tab1
    const layout = await pageLayoutService.create({
      createPageLayoutInput: {
        name: 'Mobile Focus Layout',
        type: PageLayoutType.STANDALONE_PAGE,
      },
      workspaceId,
      auditIdentity: memberIdentity,
    });
    const tab1 = await pageLayoutTabService.create({
      createPageLayoutTabInput: {
        title: 'Default Mobile Tab',
        pageLayoutId: layout.id,
        position: 0,
      },
      workspaceId,
      auditIdentity: memberIdentity,
    });
    const tab1Widget = await pageLayoutWidgetService.create({
      input: {
        pageLayoutTabId: tab1.id,
        title: 'Tab 1 Widget',
        type: WidgetType.FRONT_COMPONENT,
        gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 6 },
        configuration: {
          configurationType: WidgetConfigurationType.FRONT_COMPONENT,
          frontComponentId,
        },
      } as never,
      workspaceId,
      auditIdentity: memberIdentity,
    });

    const setDefaultTabAudit = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'pageLayout',
      auditIdentity: memberIdentity,
      expectedPageLayoutUpdateIds: [layout.id],
    });
    await withNavigationMenuItemAudit(setDefaultTabAudit(), () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'update',
              metadataName: 'pageLayout',
              universalIdentifier: layout.id,
              update: {
                defaultTabToFocusOnMobileAndSidePanelId: tab1.id,
              },
            },
          ],
        } as never,
      }),
    );

    // Deleting tab1 triggers ON DELETE SET NULL on layout.defaultTabToFocusOnMobileAndSidePanelId and ON DELETE CASCADE on tab1Widget
    await pageLayoutTabService.destroy({
      id: tab1.id,
      workspaceId,
      auditIdentity: memberIdentity,
    });

    const setNullUpdateEntries = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='pageLayout' AND "resourceId"=$2 AND action='update'
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId, layout.id],
    );
    expect(setNullUpdateEntries).toHaveLength(2);
    expect(setNullUpdateEntries[0].redactedDiff.values).toMatchObject({
      defaultTabToFocusOnMobileAndSidePanelId: {
        before: null,
        after: tab1.id,
      },
    });
    expect(setNullUpdateEntries[1].redactedDiff.values).toMatchObject({
      defaultTabToFocusOnMobileAndSidePanelId: {
        before: tab1.id,
        after: null,
      },
    });

    const cascadeWidgetDelete = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='pageLayoutWidget' AND "resourceId"=$2 AND action='delete'`,
      [workspaceId, tab1Widget.id],
    );
    expect(cascadeWidgetDelete).toHaveLength(1);

    // Pin a navigationMenuItem and commandMenuItem to layout, add tab2 + widget2, then destroy layout
    const tab2 = await pageLayoutTabService.create({
      createPageLayoutTabInput: {
        title: 'Tab 2',
        pageLayoutId: layout.id,
        position: 1,
      },
      workspaceId,
      auditIdentity: memberIdentity,
    });
    const widget2 = await pageLayoutWidgetService.create({
      input: {
        pageLayoutTabId: tab2.id,
        title: 'Widget 2',
        type: WidgetType.FRONT_COMPONENT,
        gridPosition: { row: 0, column: 0, rowSpan: 2, columnSpan: 6 },
        configuration: {
          configurationType: WidgetConfigurationType.FRONT_COMPONENT,
          frontComponentId,
        },
      } as never,
      workspaceId,
      auditIdentity: memberIdentity,
    });
    const navId = randomUUID().toLowerCase();
    const cmiId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."navigationMenuItem" (id, "workspaceId", "applicationId", "universalIdentifier", type, name, position, "pageLayoutId")
       VALUES ($1,$2,$3,$4,'PAGE_LAYOUT','Pinned Layout Nav',0,$5)`,
      [
        navId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        layout.id,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."commandMenuItem" (id, "workspaceId", "applicationId", "universalIdentifier", "engineComponentKey", label, "availabilityType", "pageLayoutId")
       VALUES ($1,$2,$3,$4,$5,'Edit Layout',$6,$7)`,
      [
        cmiId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        EngineComponentKey.EDIT_RECORD_PAGE_LAYOUT,
        CommandMenuItemAvailabilityType.GLOBAL,
        layout.id,
      ],
    );

    await pageLayoutService.destroy({
      id: layout.id,
      workspaceId,
      auditIdentity: memberIdentity,
    });

    const layoutDeleteCascades = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND action='delete' AND "resourceId"=ANY($2::text[])`,
      [workspaceId, [layout.id, tab2.id, widget2.id, navId, cmiId]],
    );
    expect(layoutDeleteCascades).toHaveLength(5);

    // FieldMetadataService.createOneField, updateOneField, and deleteOneField
    const formLayoutId = randomUUID().toLowerCase();
    const formLayoutUid = randomUUID().toLowerCase();
    const formTabId = randomUUID().toLowerCase();
    const formTabUid = randomUUID().toLowerCase();
    const stageFieldWidgetId = randomUUID().toLowerCase();
    const stageFieldWidgetUid = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."pageLayout" (id, "workspaceId", "applicationId", "universalIdentifier", name, type, "objectMetadataId", "isSystemSideEffect", "isFirstTabPinned")
       VALUES ($1,$2,$3,$4,'Company Form','RECORD_FORM',$5,true,true)`,
      [
        formLayoutId,
        workspaceId,
        customApplicationId,
        formLayoutUid,
        companyObjectId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayoutTab" (id, "workspaceId", "applicationId", "universalIdentifier", title, position, "pageLayoutId", "layoutMode", "isActive", "isSystemSideEffect")
       VALUES ($1,$2,$3,$4,'Form Tab',0,$5,'VERTICAL_LIST',true,true)`,
      [formTabId, workspaceId, customApplicationId, formTabUid, formLayoutId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayoutWidget" (id, "workspaceId", "applicationId", "universalIdentifier", "pageLayoutTabId", title, type, "objectMetadataId", "gridPosition", configuration, "isActive", "isSystemSideEffect")
       VALUES ($1,$2,$3,$4,$5,'Stage Field Widget','FIELD',$6,'{"row":0,"column":0,"rowSpan":1,"columnSpan":12}'::jsonb,$7,true,false)`,
      [
        stageFieldWidgetId,
        workspaceId,
        customApplicationId,
        stageFieldWidgetUid,
        formTabId,
        companyObjectId,
        {
          configurationType: WidgetConfigurationType.FIELD,
          fieldMetadataId: stageFieldId,
          fieldDisplayMode: 'CARD',
        },
      ],
    );

    const fieldMetadataService = new FieldMetadataService(
      {} as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      applicationService as never,
      workspaceCacheService as never,
    );

    const createdField = await fieldMetadataService.createOneField({
      createFieldInput: {
        objectMetadataId: companyObjectId,
        type: FieldMetadataType.TEXT,
        name: 'notes',
        label: 'Notes',
      },
      workspaceId,
      auditIdentity: memberIdentity,
    });
    expect(createdField.name).toBe('notes');

    await fieldMetadataService.updateOneField({
      updateFieldInput: {
        id: createdField.id,
        isActive: false,
      },
      workspaceId,
      auditIdentity: memberIdentity,
    });

    await fieldMetadataService.deleteOneField({
      deleteOneFieldInput: { id: stageFieldId },
      workspaceId,
      auditIdentity: memberIdentity,
    });

    const stageWidgetDeleteAudit = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='pageLayoutWidget' AND "resourceId"=$2 AND action='delete'`,
      [workspaceId, stageFieldWidgetId],
    );
    expect(stageWidgetDeleteAudit).toHaveLength(1);
  });

  it('audits manifest sync create/update/delete, objectDelete cascade, reconcileApplicationRoleAndPermissionOperations, assertNoRemainingApplicationRoleOrPermissionMetadata, and blocks unaudited runner execution', async () => {
    const { runnerService } = buildHarness();

    const plId = randomUUID().toLowerCase();
    const plUid = randomUUID().toLowerCase();
    const pltId = randomUUID().toLowerCase();
    const pltUid = randomUUID().toLowerCase();
    const plwId = randomUUID().toLowerCase();
    const plwUid = randomUUID().toLowerCase();

    // 1. Unaudited runner execution touching pageLayout, pageLayoutTab, or pageLayoutWidget fails closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'pageLayout',
              id: plId,
              flatEntity: {
                id: plId,
                universalIdentifier: plUid,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'App Layout',
                type: PageLayoutType.STANDALONE_PAGE,
                objectMetadataUniversalIdentifier: null,
                defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier: null,
                isSystemSideEffect: false,
                isFirstTabPinned: true,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(/requires an active CRM audit scope/);

    // 2. Manifest sync create
    const createOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      mode: 'manifest',
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
                metadataName: 'pageLayout',
                id: plId,
                flatEntity: {
                  id: plId,
                  universalIdentifier: plUid,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'App Layout',
                  type: PageLayoutType.RECORD_PAGE,
                  objectMetadataUniversalIdentifier: companyObjectUniversalId,
                  defaultTabToFocusOnMobileAndSidePanelUniversalIdentifier:
                    null,
                  isSystemSideEffect: false,
                  isFirstTabPinned: true,
                },
              },
              {
                type: 'create',
                metadataName: 'pageLayoutTab',
                id: pltId,
                flatEntity: {
                  id: pltId,
                  universalIdentifier: pltUid,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  title: 'App Tab',
                  position: 0,
                  pageLayoutUniversalIdentifier: plUid,
                  layoutMode: PageLayoutTabLayoutMode.GRID,
                  icon: 'IconLayout',
                  isActive: true,
                  isSystemSideEffect: false,
                  overrides: null,
                },
              },
              {
                type: 'create',
                metadataName: 'pageLayoutWidget',
                id: plwId,
                flatEntity: {
                  id: plwId,
                  universalIdentifier: plwUid,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  pageLayoutTabUniversalIdentifier: pltUid,
                  title: 'App Widget',
                  type: WidgetType.GRAPH,
                  objectMetadataUniversalIdentifier: companyObjectUniversalId,
                  gridPosition: {
                    row: 0,
                    column: 0,
                    rowSpan: 2,
                    columnSpan: 6,
                  },
                  position: null,
                  universalConfiguration: {
                    configurationType: WidgetConfigurationType.BAR_CHART,
                    aggregateFieldMetadataUniversalIdentifier:
                      amountFieldUniversalId,
                    aggregateOperation: AggregateOperations.SUM,
                    primaryAxisGroupByFieldMetadataUniversalIdentifier:
                      stageFieldUniversalId,
                    primaryAxisDateGranularity:
                      ObjectRecordGroupByDateGranularity.DAY,
                    axisNameDisplay: AxisNameDisplay.NONE,
                    displayDataLabel: false,
                  },
                  isActive: true,
                  isSystemSideEffect: false,
                  universalOverrides: null,
                  conditionalDisplay: null,
                  conditionalAvailabilityExpression: null,
                },
              },
            ],
          } as never,
        }),
    );

    // 3. Application delete barrier rejects while thirdPartyApplicationId still owns pageLayout/Tab/Widget
    const qr = runtimeDataSource.createQueryRunner();
    await qr.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          qr,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        /Application delete requires prior audited removal of role and permission metadata/,
      );
    } finally {
      await qr.release();
    }

    // 4. Reconcile operations on objectMetadata delete
    const reconciledRecord: Record<string, any> = {
      objectMetadata: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [companyObjectUniversalId]: {
            id: companyObjectId,
            universalIdentifier: companyObjectUniversalId,
          },
        },
      },
    };
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName: reconciledRecord,
      existingAllFlatEntityMaps: await buildMapsFromDb(),
    });
    expect(
      reconciledRecord.pageLayout?.flatEntityToDelete[plUid],
    ).toBeDefined();
    expect(
      reconciledRecord.pageLayoutTab?.flatEntityToDelete[pltUid],
    ).toBeDefined();
    expect(
      reconciledRecord.pageLayoutWidget?.flatEntityToDelete[plwUid],
    ).toBeDefined();

    // 5. Manifest sync update & delete of thirdPartyApplicationId pageLayout/Tab/Widget, then delete application
    const updateAndDeleteOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      mode: 'manifest',
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(updateAndDeleteOp, {
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
                metadataName: 'pageLayoutWidget',
                universalIdentifier: plwUid,
              },
              {
                type: 'delete',
                metadataName: 'pageLayoutTab',
                universalIdentifier: pltUid,
              },
              {
                type: 'delete',
                metadataName: 'pageLayout',
                universalIdentifier: plUid,
              },
            ],
          } as never,
        }),
    );

    const appDelOp = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await runAuditedApplicationDelete(runtimeDataSource, appDelOp, {
      applicationId: thirdPartyApplicationId,
      work: async (delQr) => {
        await delQr.query(
          `DELETE FROM core.application WHERE id=$1 AND "workspaceId"=$2`,
          [thirdPartyApplicationId, workspaceId],
        );
      },
    });

    const entries = await ownerDataSource.query(
      `SELECT "resourceKind", "resourceId", action
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(entries).toHaveLength(6);
    expect(entries).toEqual(
      expect.arrayContaining([
        { resourceKind: 'pageLayout', resourceId: plId, action: 'create' },
        { resourceKind: 'pageLayoutTab', resourceId: pltId, action: 'create' },
        {
          resourceKind: 'pageLayoutWidget',
          resourceId: plwId,
          action: 'create',
        },
        { resourceKind: 'pageLayout', resourceId: plId, action: 'delete' },
        { resourceKind: 'pageLayoutTab', resourceId: pltId, action: 'delete' },
        {
          resourceKind: 'pageLayoutWidget',
          resourceId: plwId,
          action: 'delete',
        },
      ]),
    );
  });

  it('rolls back on post-flush state tampering and invalidates cache while propagating NativeTransactionOutcomeUnknownError on lost COMMIT', async () => {
    const { pageLayoutService, workspaceCacheService } = buildHarness();
    const memberIdentity = {
      user: { id: ownerUserId },
      workspaceMemberId: ownerWorkspaceMemberId,
    };

    await ownerDataSource.query(
      `CREATE OR REPLACE FUNCTION core.tamper_pl_after_audit()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
       BEGIN
         IF NEW."resourceKind" = 'pageLayout' AND NEW.action = 'create' THEN
           UPDATE core."pageLayout"
           SET "isFirstTabPinned" = false
           WHERE id = NEW."resourceId"::uuid;
         END IF;
         RETURN NEW;
       END;
       $$;
       DROP TRIGGER IF EXISTS trg_tamper_pl_after_audit ON crm_audit."crmAuditEntry";
       CREATE TRIGGER trg_tamper_pl_after_audit
       AFTER INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION core.tamper_pl_after_audit();`,
    );

    try {
      await expect(
        pageLayoutService.create({
          createPageLayoutInput: {
            name: 'Tampered Layout',
            type: PageLayoutType.DASHBOARD,
          },
          workspaceId,
          auditIdentity: memberIdentity,
        }),
      ).rejects.toThrow(/Page layout state changed during audit flush/);
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_tamper_pl_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS core.tamper_pl_after_audit();`,
      );
    }

    const remainingLayouts = await ownerDataSource.query(
      `SELECT id FROM core."pageLayout" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(remainingLayouts).toHaveLength(0);

    // Lost COMMIT acknowledgement propagates NativeTransactionOutcomeUnknownError and invalidates cache
    const realCreateQueryRunner =
      runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    const createRunnerSpy = jest
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
              const res = await origClientQuery(sql, values);
              if (sql === 'COMMIT') {
                throw new Error('Simulated lost COMMIT acknowledgement');
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
        pageLayoutService.create({
          createPageLayoutInput: {
            name: 'Lost Commit Layout',
            type: PageLayoutType.DASHBOARD,
          },
          workspaceId,
          auditIdentity: memberIdentity,
        }),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
      expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
        workspaceId,
        expect.arrayContaining(['flatPageLayoutMaps']),
      );
    } finally {
      createRunnerSpy.mockRestore();
    }
  });
});
