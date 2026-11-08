import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  reconcileApplicationRoleAndPermissionOperations,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { NavigationMenuItemType } from 'src/engine/metadata-modules/navigation-menu-item/enums/navigation-menu-item-type.enum';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: {
    ROLE: 'ROLE',
    METADATA: 'METADATA',
    NAVIGATION_MENU_ITEM: 'NAVIGATION_MENU_ITEM',
    VIEW: 'VIEW',
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
    'src/engine/core-modules/application/application-registration/application-registration.entity',
    ['ApplicationRegistrationEntity'],
  ],
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  ['src/engine/core-modules/api-key/api-key.entity', ['ApiKeyEntity']],
  [
    'src/engine/core-modules/application/application.entity',
    ['ApplicationEntity'],
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
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
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
    'src/engine/metadata-modules/navigation-menu-item/interceptors/navigation-menu-item-graphql-api-exception.interceptor',
    ['NavigationMenuItemGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/metadata-modules/navigation-menu-item/services/navigation-menu-item-access.service',
    ['NavigationMenuItemAccessService'],
  ],
  [
    'src/engine/metadata-modules/navigation-menu-item/services/navigation-menu-item-record-identifier.service',
    ['NavigationMenuItemRecordIdentifierService'],
  ],
  [
    'src/engine/metadata-modules/view/services/view-widget-upsert.service',
    ['ViewWidgetUpsertService'],
  ],
  [
    'src/engine/metadata-modules/page-layout/services/page-layout-reset.service',
    ['PageLayoutResetService'],
  ],
  [
    'src/engine/metadata-modules/page-layout/services/page-layout-update.service',
    ['PageLayoutUpdateService'],
  ],
  [
    'src/engine/metadata-modules/page-layout/services/page-layout-duplication.service',
    ['PageLayoutDuplicationService'],
  ],
  [
    'src/engine/metadata-modules/field-metadata/field-metadata.entity',
    ['FieldMetadataEntity'],
  ],
  [
    'src/engine/metadata-modules/object-metadata/object-metadata.entity',
    ['ObjectMetadataEntity'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
    ['WorkspaceScopedRepository'],
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
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    ['WorkspaceMigrationValidateBuildAndRunService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/interceptors/workspace-migration-graphql-api-exception.interceptor',
    ['WorkspaceMigrationGraphqlApiExceptionInterceptor'],
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
  ['src/engine/guards/custom-permission.guard', ['CustomPermissionGuard']],
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
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/process.decorator',
    ['Process'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/processor.decorator',
    ['Processor'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { AgentChatChannelMetadataService } =
  require('src/engine/metadata-modules/agent-chat-channel/services/agent-chat-channel-metadata.service') as typeof import('src/engine/metadata-modules/agent-chat-channel/services/agent-chat-channel-metadata.service');
const { FieldMetadataService } =
  require('src/engine/metadata-modules/field-metadata/services/field-metadata.service') as typeof import('src/engine/metadata-modules/field-metadata/services/field-metadata.service');
const { NavigationMenuItemDeletionJob } =
  require('src/engine/metadata-modules/navigation-menu-item/jobs/navigation-menu-item-deletion.job') as typeof import('src/engine/metadata-modules/navigation-menu-item/jobs/navigation-menu-item-deletion.job');
const { NavigationMenuItemResolver } =
  require('src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.resolver') as typeof import('src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.resolver');
const { NavigationMenuItemService } =
  require('src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.service') as typeof import('src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.service');
const { NavigationMenuItemDeletionService } =
  require('src/engine/metadata-modules/navigation-menu-item/services/navigation-menu-item-deletion.service') as typeof import('src/engine/metadata-modules/navigation-menu-item/services/navigation-menu-item-deletion.service');
const { CreateNavigationMenuItemTool } =
  require('src/engine/metadata-modules/navigation-menu-item/tools/create-navigation-menu-item.tool') as typeof import('src/engine/metadata-modules/navigation-menu-item/tools/create-navigation-menu-item.tool');
const { DeleteNavigationMenuItemTool } =
  require('src/engine/metadata-modules/navigation-menu-item/tools/delete-navigation-menu-item.tool') as typeof import('src/engine/metadata-modules/navigation-menu-item/tools/delete-navigation-menu-item.tool');
const { UpdateNavigationMenuItemTool } =
  require('src/engine/metadata-modules/navigation-menu-item/tools/update-navigation-menu-item.tool') as typeof import('src/engine/metadata-modules/navigation-menu-item/tools/update-navigation-menu-item.tool');
const { ObjectMetadataService } =
  require('src/engine/metadata-modules/object-metadata/object-metadata.service') as typeof import('src/engine/metadata-modules/object-metadata/object-metadata.service');
const { PageLayoutService } =
  require('src/engine/metadata-modules/page-layout/services/page-layout.service') as typeof import('src/engine/metadata-modules/page-layout/services/page-layout.service');
const { ViewService } =
  require('src/engine/metadata-modules/view/services/view.service') as typeof import('src/engine/metadata-modules/view/services/view.service');
const { seedPageLayouts } =
  require('src/engine/workspace-manager/dev-seeder/core/utils/seed-page-layouts.util') as typeof import('src/engine/workspace-manager/dev-seeder/core/utils/seed-page-layouts.util');
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

const runtimeRole = `twenty_nav_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

const otherUserId = randomUUID().toLowerCase();
const otherUserWorkspaceId = randomUUID().toLowerCase();
const otherWorkspaceMemberId = randomUUID().toLowerCase();

const agentId = randomUUID().toLowerCase();
const agentUniversalId = randomUUID().toLowerCase();

const objectMetadataId = randomUUID().toLowerCase();
const objectMetadataUniversalId = randomUUID().toLowerCase();

const viewId = randomUUID().toLowerCase();
const viewUniversalId = randomUUID().toLowerCase();

const pageLayoutId = randomUUID().toLowerCase();
const pageLayoutUniversalId = randomUUID().toLowerCase();

const channelId = randomUUID().toLowerCase();
const channelUniversalId = randomUUID().toLowerCase();

const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = runtimeRole;
restrictedUrl.password = 'twenty_rt_pass';

const ownerDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 6, statement_timeout: 15000 },
});
const runtimeDataSource = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 6, statement_timeout: 15000 },
});

describe('CRM audit navigationMenuItem lifecycle and cascade deletions (PostgreSQL)', () => {
  beforeAll(async () => {
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
        "defaultRoleId" uuid NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core."user" (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        "canImpersonate" boolean NOT NULL DEFAULT false,
        "canAccessFullAdminPanel" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core."userWorkspace" (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE "${workspaceSchema}"."workspaceMember" (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core.application (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "canBeUninstalled" boolean NOT NULL DEFAULT true,
        "defaultRoleId" uuid NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core.agent (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core."objectMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "nameSingular" text NOT NULL DEFAULT 'item',
        "namePlural" text NOT NULL DEFAULT 'items',
        "labelSingular" text NOT NULL DEFAULT 'Item',
        "labelPlural" text NOT NULL DEFAULT 'Items',
        "isCustom" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        "labelIdentifierFieldMetadataId" uuid NULL
      );
      CREATE TABLE core."fieldMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        type text NOT NULL DEFAULT 'TEXT',
        name text NOT NULL DEFAULT 'name',
        label text NOT NULL DEFAULT 'Name',
        "isActive" boolean NOT NULL DEFAULT true,
        "isCustom" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "isSystemSideEffect" boolean NOT NULL DEFAULT false,
        "relationTargetObjectMetadataId" uuid NULL,
        "relationTargetFieldMetadataId" uuid NULL,
        "morphId" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core.view (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "calendarFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
        "mainGroupByFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT 'All Items',
        type text NOT NULL DEFAULT 'TABLE',
        icon text NOT NULL DEFAULT 'IconList',
        position double precision NOT NULL DEFAULT 0,
        visibility text NOT NULL DEFAULT 'WORKSPACE',
        "createdByUserWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE SET NULL,
        "isCustom" boolean NOT NULL DEFAULT true,
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystemSideEffect" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core."pageLayout" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "objectMetadataId" uuid NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT 'Standalone Layout',
        type text NOT NULL DEFAULT 'STANDALONE_PAGE',
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core."agentChatChannel" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL DEFAULT 'Support Channel',
        icon text NULL,
        color text NULL,
        position double precision NOT NULL DEFAULT 0,
        "isCustom" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core."navigationMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "userWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
        "targetRecordId" uuid NULL,
        "targetObjectMetadataId" uuid NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "viewId" uuid NULL REFERENCES core.view(id) ON DELETE CASCADE,
        "folderId" uuid NULL REFERENCES core."navigationMenuItem"(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        "pageLayoutId" uuid NULL REFERENCES core."pageLayout"(id) ON DELETE CASCADE,
        "agentChatChannelId" uuid NULL REFERENCES core."agentChatChannel"(id) ON DELETE CASCADE,
        type text NOT NULL,
        name text NULL,
        link text NULL,
        icon text NULL,
        color text NULL,
        position double precision NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_navigation_menu_item_type_fields" CHECK (
          ("type" = 'FOLDER')
          OR ("type" = 'OBJECT' AND "targetObjectMetadataId" IS NOT NULL)
          OR ("type" = 'VIEW' AND "viewId" IS NOT NULL)
          OR ("type" = 'RECORD' AND "targetRecordId" IS NOT NULL AND "targetObjectMetadataId" IS NOT NULL)
          OR ("type" = 'LINK' AND "link" IS NOT NULL)
          OR ("type" = 'PAGE_LAYOUT' AND "pageLayoutId" IS NOT NULL)
          OR ("type" = 'AGENT_CHAT_CHANNEL' AND "agentChatChannelId" IS NOT NULL)
        )
      );
    `);

    await ownerDataSource.transaction((manager) =>
      new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
    );

    await ownerDataSource.query(`
      CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'twenty_rt_pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${runtimeRole}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${runtimeRole}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${runtimeRole}";
      GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${runtimeRole}";
    `);

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
         REASSIGN OWNED BY "${runtimeRole}" TO CURRENT_USER;
         DROP OWNED BY "${runtimeRole}";
         DROP ROLE IF EXISTS "${runtimeRole}";`,
      );
      await ownerDataSource.destroy();
    }
  });

  beforeEach(async () => {
    await ownerDataSource.query(`
      TRUNCATE TABLE
        crm_audit."crmAuditEntry",
        core."navigationMenuItem",
        core."agentChatChannel",
        core."pageLayout",
        core.view,
        core."fieldMetadata",
        core."objectMetadata",
        core.agent,
        core.application,
        "${workspaceSchema}"."workspaceMember",
        core."userWorkspace",
        core."user",
        core.workspace
      RESTART IDENTITY CASCADE
    `);

    await ownerDataSource.query(`INSERT INTO core.workspace (id) VALUES ($1)`, [
      workspaceId,
    ]);
    await ownerDataSource.query(
      `INSERT INTO core."user" (id, email) VALUES ($1, 'owner@example.test'), ($2, 'other@example.test')`,
      [ownerUserId, otherUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId")
       VALUES ($1, $2, $3), ($4, $5, $3)`,
      [
        ownerUserWorkspaceId,
        ownerUserId,
        workspaceId,
        otherUserWorkspaceId,
        otherUserId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId")
       VALUES ($1, $2), ($3, $4)`,
      [
        ownerWorkspaceMemberId,
        ownerUserId,
        otherWorkspaceMemberId,
        otherUserId,
      ],
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
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier")
       VALUES ($1, $2, $3, $4)`,
      [agentId, workspaceId, customApplicationId, agentUniversalId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "labelSingular", "labelPlural")
       VALUES ($1, $2, $3, $4, 'deal', 'deals', 'Deal', 'Deals')`,
      [
        objectMetadataId,
        workspaceId,
        customApplicationId,
        objectMetadataUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.view (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name)
       VALUES ($1, $2, $3, $4, $5, 'All Deals')`,
      [
        viewId,
        workspaceId,
        customApplicationId,
        viewUniversalId,
        objectMetadataId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."pageLayout" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, NULL, 'Standalone Overview', 'STANDALONE_PAGE')`,
      [pageLayoutId, workspaceId, customApplicationId, pageLayoutUniversalId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."agentChatChannel" (id, "workspaceId", "applicationId", "universalIdentifier", name)
       VALUES ($1, $2, $3, $4, 'General AI')`,
      [channelId, workspaceId, customApplicationId, channelUniversalId],
    );
  });

  const buildNavigationMapsFromDb = async () => {
    const navRows = await ownerDataSource.query(
      `SELECT * FROM core."navigationMenuItem" WHERE "workspaceId"=$1 ORDER BY position, id`,
      [workspaceId],
    );
    const objRows = await ownerDataSource.query(
      `SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    const fieldRows = await ownerDataSource.query(
      `SELECT * FROM core."fieldMetadata" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    const viewRows = await ownerDataSource.query(
      `SELECT * FROM core.view WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    const layoutRows = await ownerDataSource.query(
      `SELECT * FROM core."pageLayout" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    const channelRows = await ownerDataSource.query(
      `SELECT * FROM core."agentChatChannel" WHERE "workspaceId"=$1`,
      [workspaceId],
    );

    const buildSimpleMaps = (rows: Record<string, any>[]) => {
      const byId: Record<string, any> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      const byUniversalIdentifier: Record<string, any> = {};
      const universalIdentifierById: Record<string, string> = {};
      const universalIdentifiersByApplicationId: Record<string, string[]> = {};
      for (const r of rows) {
        const uid = String(r.universalIdentifier).toLowerCase();
        const id = String(r.id).toLowerCase();
        const appId = String(r.applicationId).toLowerCase();
        const appUid =
          appId === standardApplicationId
            ? STANDARD_APPLICATION_UNIVERSAL_ID
            : appId === thirdPartyApplicationId
              ? thirdPartyApplicationUniversalId
              : customApplicationUniversalId;
        const entity = {
          ...r,
          id,
          universalIdentifier: uid,
          applicationId: appId,
          applicationUniversalIdentifier: appUid,
          createdAt:
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : String(r.createdAt ?? new Date().toISOString()),
          updatedAt:
            r.updatedAt instanceof Date
              ? r.updatedAt.toISOString()
              : String(r.updatedAt ?? new Date().toISOString()),
          deletedAt: r.deletedAt
            ? r.deletedAt instanceof Date
              ? r.deletedAt.toISOString()
              : String(r.deletedAt)
            : null,
        };
        byId[id] = entity;
        idByUniversalIdentifier[uid] = id;
        byUniversalIdentifier[uid] = entity;
        universalIdentifierById[id] = uid;
        universalIdentifiersByApplicationId[appId] ??= [];
        universalIdentifiersByApplicationId[appId].push(uid);
      }
      return {
        byId,
        idByUniversalIdentifier,
        byUniversalIdentifier,
        universalIdentifierById,
        universalIdentifiersByApplicationId,
      };
    };

    const flatObjectMetadataMaps = buildSimpleMaps(objRows);
    const flatFieldMetadataMaps = buildSimpleMaps(fieldRows);
    const flatViewMaps = buildSimpleMaps(viewRows);
    const flatPageLayoutMaps = buildSimpleMaps(layoutRows);
    const flatAgentChatChannelMaps = buildSimpleMaps(channelRows);

    for (const obj of Object.values(flatObjectMetadataMaps.byId)) {
      const objFields = Object.values(flatFieldMetadataMaps.byId).filter(
        (f: any) => f.objectMetadataId === obj.id,
      );
      const objViews = Object.values(flatViewMaps.byId).filter(
        (v: any) => v.objectMetadataId === obj.id,
      );
      obj.fieldIds = objFields.map((f: any) => f.id);
      obj.fieldUniversalIdentifiers = objFields.map(
        (f: any) => f.universalIdentifier,
      );
      obj.indexMetadataIds = [];
      obj.indexMetadataUniversalIdentifiers = [];
      obj.viewIds = objViews.map((v: any) => v.id);
      obj.viewUniversalIdentifiers = objViews.map(
        (v: any) => v.universalIdentifier,
      );
    }

    for (const vw of Object.values(flatViewMaps.byId)) {
      vw.objectMetadataUniversalIdentifier = vw.objectMetadataId
        ? (flatObjectMetadataMaps.universalIdentifierById[
            vw.objectMetadataId
          ] ?? null)
        : null;
      vw.calendarFieldMetadataUniversalIdentifier = vw.calendarFieldMetadataId
        ? (flatFieldMetadataMaps.universalIdentifierById[
            vw.calendarFieldMetadataId
          ] ?? null)
        : null;
      vw.mainGroupByFieldMetadataUniversalIdentifier =
        vw.mainGroupByFieldMetadataId
          ? (flatFieldMetadataMaps.universalIdentifierById[
              vw.mainGroupByFieldMetadataId
            ] ?? null)
          : null;
      vw.viewGroupIds = [];
      vw.viewGroupUniversalIdentifiers = [];
      vw.viewFieldIds = [];
      vw.viewFieldUniversalIdentifiers = [];
      vw.viewFilterIds = [];
      vw.viewFilterUniversalIdentifiers = [];
      vw.viewSortIds = [];
      vw.viewSortUniversalIdentifiers = [];
    }

    for (const fld of Object.values(flatFieldMetadataMaps.byId)) {
      fld.objectMetadataUniversalIdentifier =
        flatObjectMetadataMaps.universalIdentifierById[fld.objectMetadataId] ??
        null;
      fld.relationTargetObjectMetadataUniversalIdentifier =
        fld.relationTargetObjectMetadataId
          ? (flatObjectMetadataMaps.universalIdentifierById[
              fld.relationTargetObjectMetadataId
            ] ?? null)
          : null;
      fld.relationTargetFieldMetadataUniversalIdentifier =
        fld.relationTargetFieldMetadataId
          ? (flatFieldMetadataMaps.universalIdentifierById[
              fld.relationTargetFieldMetadataId
            ] ?? null)
          : null;
      const calViews = Object.values(flatViewMaps.byId).filter(
        (v: any) => v.calendarFieldMetadataId === fld.id,
      );
      const grpViews = Object.values(flatViewMaps.byId).filter(
        (v: any) => v.mainGroupByFieldMetadataId === fld.id,
      );
      fld.calendarViewIds = calViews.map((v: any) => v.id);
      fld.calendarViewUniversalIdentifiers = calViews.map(
        (v: any) => v.universalIdentifier,
      );
      fld.mainGroupByFieldMetadataViewIds = grpViews.map((v: any) => v.id);
      fld.mainGroupByFieldMetadataViewUniversalIdentifiers = grpViews.map(
        (v: any) => v.universalIdentifier,
      );
      fld.kanbanAggregateOperationViewIds = [];
      fld.kanbanAggregateOperationViewUniversalIdentifiers = [];
      fld.calendarEndViewIds = [];
      fld.calendarEndViewUniversalIdentifiers = [];
      fld.viewFieldIds = [];
      fld.viewFieldUniversalIdentifiers = [];
      fld.viewFilterIds = [];
      fld.viewFilterUniversalIdentifiers = [];
      fld.viewSortIds = [];
      fld.viewSortUniversalIdentifiers = [];
    }

    const navBase = buildSimpleMaps(navRows);
    const byUserWorkspaceIdAndFolderId: Record<
      string,
      Record<string, any[]>
    > = {};
    for (const nav of Object.values(navBase.byUniversalIdentifier)) {
      nav.folderUniversalIdentifier = nav.folderId
        ? (navBase.universalIdentifierById[nav.folderId] ?? null)
        : null;
      nav.viewUniversalIdentifier = nav.viewId
        ? (flatViewMaps.universalIdentifierById[nav.viewId] ?? null)
        : null;
      nav.targetObjectMetadataUniversalIdentifier = nav.targetObjectMetadataId
        ? (flatObjectMetadataMaps.universalIdentifierById[
            nav.targetObjectMetadataId
          ] ?? null)
        : null;
      nav.pageLayoutUniversalIdentifier = nav.pageLayoutId
        ? (flatPageLayoutMaps.universalIdentifierById[nav.pageLayoutId] ?? null)
        : null;
      nav.agentChatChannelUniversalIdentifier = nav.agentChatChannelId
        ? (flatAgentChatChannelMaps.universalIdentifierById[
            nav.agentChatChannelId
          ] ?? null)
        : null;

      const uwKey = nav.userWorkspaceId ?? 'null';
      const folderKey = nav.folderId ?? 'null';
      byUserWorkspaceIdAndFolderId[uwKey] ??= {};
      byUserWorkspaceIdAndFolderId[uwKey][folderKey] ??= [];
      byUserWorkspaceIdAndFolderId[uwKey][folderKey].push(nav);
    }

    for (const ch of Object.values(
      flatAgentChatChannelMaps.byUniversalIdentifier,
    )) {
      ch.channelRoleIds = [];
      ch.channelRoleUniversalIdentifiers = [];
      const matchingNavs = Object.values(navBase.byUniversalIdentifier).filter(
        (n: any) => n.agentChatChannelId === ch.id,
      );
      ch.navigationMenuItemIds = matchingNavs.map((n: any) => n.id);
      ch.navigationMenuItemUniversalIdentifiers = matchingNavs.map(
        (n: any) => n.universalIdentifier,
      );
    }

    return {
      flatNavigationMenuItemMaps: {
        ...navBase,
        byUserWorkspaceIdAndFolderId,
      },
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatIndexMaps: buildSimpleMaps([]),
      flatViewMaps,
      flatViewFieldMaps: buildSimpleMaps([]),
      flatViewFilterMaps: buildSimpleMaps([]),
      flatViewGroupMaps: buildSimpleMaps([]),
      flatPageLayoutMaps,
      flatPageLayoutWidgetMaps: buildSimpleMaps([]),
      flatAgentChatChannelMaps,
      flatAgentChatChannelRoleMaps: buildSimpleMaps([]),
      flatObjectPermissionMaps: buildSimpleMaps([]),
      flatFieldPermissionMaps: buildSimpleMaps([]),
      flatRowLevelPermissionPredicateGroupMaps: buildSimpleMaps([]),
      flatRowLevelPermissionPredicateMaps: buildSimpleMaps([]),
    };
  };

  const buildRunnerHarness = () => {
    const invalidateCacheMock = jest.fn().mockResolvedValue(undefined);
    const cacheService = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest
        .fn()
        .mockImplementation(async () => buildNavigationMapsFromDb()),
      invalidateFlatEntityMaps: jest.fn().mockResolvedValue(undefined),
    };
    const workspaceCacheService = {
      getOrRecompute: jest.fn().mockImplementation(async () => ({
        ...(await buildNavigationMapsFromDb()),
        flatApplicationMaps: {
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
            [thirdPartyApplicationUniversalId]: {
              id: thirdPartyApplicationId,
              universalIdentifier: thirdPartyApplicationUniversalId,
              workspaceId,
            },
            [thirdPartyApplicationId]: {
              id: thirdPartyApplicationId,
              universalIdentifier: thirdPartyApplicationUniversalId,
              workspaceId,
            },
          },
        },
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
          if (action.metadataName === 'navigationMenuItem') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const folderId =
                fe.folderId ??
                (fe.folderUniversalIdentifier
                  ? allFlatEntityMaps.flatNavigationMenuItemMaps
                      ?.byUniversalIdentifier[fe.folderUniversalIdentifier]?.id
                  : null) ??
                null;
              const resolvedViewId =
                fe.viewId ??
                (fe.viewUniversalIdentifier
                  ? allFlatEntityMaps.flatViewMaps?.byUniversalIdentifier[
                      fe.viewUniversalIdentifier
                    ]?.id
                  : null) ??
                null;
              const resolvedObjId =
                fe.targetObjectMetadataId ??
                (fe.targetObjectMetadataUniversalIdentifier
                  ? allFlatEntityMaps.flatObjectMetadataMaps
                      ?.byUniversalIdentifier[
                      fe.targetObjectMetadataUniversalIdentifier
                    ]?.id
                  : null) ??
                null;
              const resolvedLayoutId =
                fe.pageLayoutId ??
                (fe.pageLayoutUniversalIdentifier
                  ? allFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier[
                      fe.pageLayoutUniversalIdentifier
                    ]?.id
                  : null) ??
                null;
              const resolvedChannelId =
                fe.agentChatChannelId ??
                (fe.agentChatChannelUniversalIdentifier
                  ? allFlatEntityMaps.flatAgentChatChannelMaps
                      ?.byUniversalIdentifier[
                      fe.agentChatChannelUniversalIdentifier
                    ]?.id
                  : null) ??
                null;

              await queryRunner.query(
                `INSERT INTO core."navigationMenuItem" (
                    id, "workspaceId", "applicationId", "universalIdentifier",
                    "userWorkspaceId", "targetRecordId", "targetObjectMetadataId",
                    "viewId", "folderId", "pageLayoutId", "agentChatChannelId",
                    type, name, link, icon, color, position
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.userWorkspaceId ?? null,
                  fe.targetRecordId ?? null,
                  resolvedObjId,
                  resolvedViewId,
                  folderId,
                  resolvedLayoutId,
                  resolvedChannelId,
                  fe.type,
                  fe.name ?? null,
                  fe.link ?? null,
                  fe.icon ?? null,
                  fe.color ?? null,
                  fe.position ?? 0,
                ],
              );
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatNavigationMenuItemMaps
                  ?.byUniversalIdentifier[action.universalIdentifier];
              const upd = action.update ?? {};
              const nextFolderId =
                'folderId' in upd
                  ? upd.folderId
                  : 'folderUniversalIdentifier' in upd
                    ? upd.folderUniversalIdentifier
                      ? (allFlatEntityMaps.flatNavigationMenuItemMaps
                          ?.byUniversalIdentifier[
                          upd.folderUniversalIdentifier as string
                        ]?.id ?? null)
                      : null
                    : existing.folderId;
              const nextPageLayoutId =
                'pageLayoutId' in upd
                  ? upd.pageLayoutId
                  : 'pageLayoutUniversalIdentifier' in upd
                    ? upd.pageLayoutUniversalIdentifier
                      ? (allFlatEntityMaps.flatPageLayoutMaps
                          ?.byUniversalIdentifier[
                          upd.pageLayoutUniversalIdentifier as string
                        ]?.id ?? null)
                      : null
                    : existing.pageLayoutId;
              await queryRunner.query(
                `UPDATE core."navigationMenuItem"
                   SET name=$1, link=$2, icon=$3, color=$4, position=$5, "folderId"=$6, "pageLayoutId"=$7, "updatedAt"=now()
                   WHERE id=$8 AND "workspaceId"=$9`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'link' in upd ? upd.link : existing.link,
                  'icon' in upd ? upd.icon : existing.icon,
                  'color' in upd ? upd.color : existing.color,
                  'position' in upd ? upd.position : existing.position,
                  nextFolderId,
                  nextPageLayoutId,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatNavigationMenuItemMaps
                  ?.byUniversalIdentifier[action.universalIdentifier];
              await queryRunner.query(
                `DELETE FROM core."navigationMenuItem" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (
            action.metadataName === 'view' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatViewMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            await queryRunner.query(
              `DELETE FROM core.view WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'view' &&
            action.type === 'update'
          ) {
            const existing =
              allFlatEntityMaps.flatViewMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            if (existing) {
              await queryRunner.query(
                `UPDATE core.view SET "updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (
            action.metadataName === 'pageLayout' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            await queryRunner.query(
              `DELETE FROM core."pageLayout" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'pageLayout' &&
            action.type === 'create'
          ) {
            const fe = action.flatEntity;
            await queryRunner.query(
              `INSERT INTO core."pageLayout" (id, "workspaceId", "applicationId", "universalIdentifier", name, type)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
              [
                action.id ?? fe.id ?? randomUUID(),
                workspaceId,
                flatApplication.id,
                fe.universalIdentifier,
                fe.name ?? 'Seeded Layout',
                fe.type ?? 'STANDALONE_PAGE',
              ],
            );
          } else if (
            action.metadataName === 'agentChatChannel' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatAgentChatChannelMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            await queryRunner.query(
              `DELETE FROM core."agentChatChannel" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'objectMetadata' &&
            action.type === 'create'
          ) {
            const fe = action.flatEntity;
            await queryRunner.query(
              `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "labelSingular", "labelPlural")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                action.id ?? fe.id,
                workspaceId,
                flatApplication.id,
                fe.universalIdentifier,
                fe.nameSingular ?? 'customObj',
                fe.namePlural ?? 'customObjs',
                fe.labelSingular ?? 'Custom Obj',
                fe.labelPlural ?? 'Custom Objs',
              ],
            );
          } else if (
            action.metadataName === 'objectMetadata' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatObjectMetadataMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            await queryRunner.query(
              `DELETE FROM core."objectMetadata" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'fieldMetadata' &&
            action.type === 'delete'
          ) {
            const existing =
              allFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            await queryRunner.query(
              `DELETE FROM core."fieldMetadata" WHERE id=$1 AND "workspaceId"=$2`,
              [existing.id, workspaceId],
            );
          } else if (
            action.metadataName === 'fieldMetadata' &&
            action.type === 'update'
          ) {
            const existing =
              allFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier[
                action.universalIdentifier
              ];
            if (existing) {
              await queryRunner.query(
                `UPDATE core."fieldMetadata" SET "updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2`,
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
              ...(metadataName === 'objectMetadata'
                ? { universalFlatFieldMetadatas: [] }
                : {}),
            });
          }
          for (const updateEntity of ops.flatEntityToUpdate ?? []) {
            actions.push({
              type: 'update',
              metadataName,
              universalIdentifier: updateEntity.universalIdentifier,
              update: updateEntity,
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

    const accessServiceMock = {
      canUserCreateNavigationMenuItem: jest.fn().mockResolvedValue(true),
      canUserUpdateNavigationMenuItem: jest.fn().mockResolvedValue(true),
      canUserDeleteNavigationMenuItem: jest.fn().mockResolvedValue(true),
    };

    const navigationMenuItemService = new NavigationMenuItemService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
      accessServiceMock as never,
      { resolveRecordIdentifier: jest.fn() } as never,
    );

    const navigationMenuItemResolver = new NavigationMenuItemResolver(
      navigationMenuItemService,
      {} as never,
    );

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      validateBuildAndRunMock,
      applicationServiceMock,
      navigationMenuItemService,
      navigationMenuItemResolver,
    };
  };

  it('audits navigationMenuItem create, update, no-op, and folder cascade delete across service, resolver, and AI tools with redacted display fields', async () => {
    const { navigationMenuItemResolver, navigationMenuItemService } =
      buildRunnerHarness();
    const createTool = new CreateNavigationMenuItemTool(
      navigationMenuItemService,
    );
    const updateTool = new UpdateNavigationMenuItemTool(
      navigationMenuItemService,
    );
    const deleteTool = new DeleteNavigationMenuItemTool(
      navigationMenuItemService,
    );

    const createdFolder =
      await navigationMenuItemResolver.createNavigationMenuItem(
        {
          type: NavigationMenuItemType.FOLDER,
          name: 'Secret Folder Name',
          icon: 'IconFolder',
          color: '#ff0000',
          position: 1,
          userWorkspaceId: ownerUserWorkspaceId,
        } as never,
        { id: workspaceId } as never,
        ownerUserWorkspaceId,
        undefined,
        {
          req: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        } as never,
      );

    const toolCreateOut = await createTool.execute({
      input: {
        type: NavigationMenuItemType.LINK,
        scope: 'user',
        name: 'Private Link Label',
        link: 'https://secret.example.test/ token',
        icon: 'IconLink',
        color: '#00ff00',
        position: 2,
        folderId: createdFolder.id,
      } as never,
      context: {
        workspaceId,
        userId: ownerUserId,
        userWorkspaceId: ownerUserWorkspaceId,
        actorContext: { workspaceMemberId: ownerWorkspaceMemberId } as never,
        agentId,
        application: { id: customApplicationId } as never,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    });
    expect(toolCreateOut.success).toBe(true);
    const createdLinkId = (toolCreateOut.result as { id: string }).id;

    const toolUpdateOut = await updateTool.execute({
      input: {
        id: createdLinkId,
        name: 'Renamed Link Label',
        link: 'https://updated-secret.example.test',
        position: 5,
      },
      context: {
        workspaceId,
        userId: ownerUserId,
        userWorkspaceId: ownerUserWorkspaceId,
        actorContext: { workspaceMemberId: ownerWorkspaceMemberId } as never,
        agentId,
        application: { id: customApplicationId } as never,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    });
    expect(toolUpdateOut.success).toBe(true);

    // Idempotent repeat with identical values emits 0 noisy audit rows
    await updateTool.execute({
      input: {
        id: createdLinkId,
        name: 'Renamed Link Label',
        link: 'https://updated-secret.example.test',
        position: 5,
      },
      context: {
        workspaceId,
        userId: ownerUserId,
        userWorkspaceId: ownerUserWorkspaceId,
        actorContext: { workspaceMemberId: ownerWorkspaceMemberId } as never,
        agentId,
        application: { id: customApplicationId } as never,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    });

    // Create a nested subfolder inside createdFolder and move createdLinkId into the subfolder to verify 2-level folder cascade
    const subFolder = await navigationMenuItemResolver.createNavigationMenuItem(
      {
        type: NavigationMenuItemType.FOLDER,
        name: 'Nested Subfolder',
        folderId: createdFolder.id,
        position: 3,
        userWorkspaceId: ownerUserWorkspaceId,
      } as never,
      { id: workspaceId } as never,
      ownerUserWorkspaceId,
      undefined,
      {
        req: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      } as never,
    );

    await navigationMenuItemResolver.updateNavigationMenuItem(
      {
        id: createdLinkId,
        update: {
          folderId: subFolder.id,
        },
      } as never,
      { id: workspaceId } as never,
      ownerUserWorkspaceId,
      undefined,
      {
        req: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      } as never,
    );

    // Deleting the root folder deletes the root folder, the nested subfolder, and its link item
    const toolDeleteOut = await deleteTool.execute({
      input: { id: createdFolder.id },
      context: {
        workspaceId,
        userId: ownerUserId,
        userWorkspaceId: ownerUserWorkspaceId,
        actorContext: { workspaceMemberId: ownerWorkspaceMemberId } as never,
        agentId,
        application: { id: customApplicationId } as never,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    });
    expect(toolDeleteOut.success).toBe(true);

    const remainingRows = await ownerDataSource.query(
      `SELECT id FROM core."navigationMenuItem" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(remainingRows).toHaveLength(0);

    const audits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action,actor,initiator,"redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(audits).toHaveLength(8);

    expect(audits[0]).toMatchObject({
      resourceKind: 'navigationMenuItem',
      resourceId: createdFolder.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'color',
          'folderId',
          'icon',
          'name',
          'position',
          'type',
          'userWorkspaceId',
        ]),
        values: {
          userWorkspaceId: { before: null, after: ownerUserWorkspaceId },
          folderId: { before: null, after: null },
          type: { before: null, after: 'FOLDER' },
        },
      },
    });
    expect(audits[0].redactedDiff.values.name).toBeUndefined();
    expect(audits[0].redactedDiff.values.icon).toBeUndefined();
    expect(audits[0].redactedDiff.values.color).toBeUndefined();
    expect(audits[0].redactedDiff.values.position).toBeUndefined();

    expect(audits[1]).toMatchObject({
      resourceKind: 'navigationMenuItem',
      resourceId: createdLinkId,
      action: 'create',
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'folderId',
          'link',
          'name',
          'position',
          'type',
          'userWorkspaceId',
        ]),
        values: {
          userWorkspaceId: { before: null, after: ownerUserWorkspaceId },
          folderId: { before: null, after: createdFolder.id },
          type: { before: null, after: 'LINK' },
        },
      },
    });
    expect(audits[1].redactedDiff.values.name).toBeUndefined();
    expect(audits[1].redactedDiff.values.link).toBeUndefined();

    expect(audits[2]).toMatchObject({
      resourceKind: 'navigationMenuItem',
      resourceId: createdLinkId,
      action: 'update',
      redactedDiff: {
        changedFields: ['link', 'name', 'position'],
        values: {},
      },
    });

    const deletedIds = audits
      .slice(5)
      .map((r: { resourceId: string }) => r.resourceId)
      .sort();
    expect(deletedIds).toEqual(
      [createdFolder.id, subFolder.id, createdLinkId].sort(),
    );

    const rawAuditJson = JSON.stringify(audits);
    expect(rawAuditJson).not.toContain('Secret Folder Name');
    expect(rawAuditJson).not.toContain('Private Link Label');
    expect(rawAuditJson).not.toContain('Renamed Link Label');
    expect(rawAuditJson).not.toContain('secret.example.test');
  });

  it('rejects cross-user ownership hijacking, actor-membership spoofing, and unaudited runner mutations fail-closed', async () => {
    const { navigationMenuItemService, runnerService } = buildRunnerHarness();

    const ownerItem = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.VIEW,
        viewId,
        userWorkspaceId: ownerUserWorkspaceId,
        name: 'Owner View Pin',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    // Actor-membership spoofing: otherUser's workspaceMemberId with ownerUserWorkspaceId
    await expect(
      navigationMenuItemService.update({
        input: {
          id: ownerItem.id,
          name: 'Spoofed Name',
        },
        workspaceId,
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: otherUserId },
          workspaceMemberId: otherWorkspaceMemberId,
        },
      }),
    ).rejects.toThrow(/mismatch with userWorkspace/);

    // Direct DB-level cross-user update attempt bypassing service pre-check
    await expect(
      withNavigationMenuItemAudit(
        captureNavigationMenuItemAudit({
          workspaceId,
          mode: 'update',
          authUserWorkspaceId: otherUserWorkspaceId,
          auditIdentity: {
            user: { id: otherUserId },
            workspaceMemberId: otherWorkspaceMemberId,
          },
        })(),
        () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'update',
                  metadataName: 'navigationMenuItem',
                  universalIdentifier: ownerItem.id,
                  update: { name: 'Hijacked' },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow();

    // Unaudited runner execution touching navigationMenuItem or deleting view/pageLayout/agentChatChannel is blocked
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'navigationMenuItem',
              universalIdentifier: randomUUID(),
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
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'view',
              universalIdentifier: viewUniversalId,
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );
  });

  it('audits NavigationMenuItemDeletionJob and parent cascades across ViewService, PageLayoutService, AgentChatChannelMetadataService, and seedPageLayouts', async () => {
    const {
      validateBuildAndRunMock,
      cacheService,
      applicationServiceMock,
      navigationMenuItemService,
    } = buildRunnerHarness();

    const targetRecordId = randomUUID().toLowerCase();
    const recordNav = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.RECORD,
        targetRecordId,
        targetObjectMetadataId: objectMetadataId,
        name: 'Pinned Deal Record',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const deletionService = new NavigationMenuItemDeletionService(
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      applicationServiceMock as never,
    );
    const deletionJob = new NavigationMenuItemDeletionJob(deletionService);
    await deletionJob.handle({
      workspaceId,
      deletedRecordIds: [targetRecordId],
    });

    // View cascade deletion via ViewService.destroyOne
    const viewNav = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.VIEW,
        viewId,
        name: 'Pinned View',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const viewService = new ViewService(
      {} as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
    );
    await viewService.deleteOne({
      deleteViewInput: { id: viewId },
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    // PageLayout cascade deletion via PageLayoutService.destroy
    const layoutNav = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.PAGE_LAYOUT,
        pageLayoutId,
        name: 'Pinned Standalone Page',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const pageLayoutService = new PageLayoutService(
      { executeInWorkspaceContext: jest.fn() } as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
      {
        updateLinkedDashboardsUpdatedAtByPageLayoutId: jest.fn(),
      } as never,
    );
    await pageLayoutService.destroy({
      id: pageLayoutId,
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    // AgentChatChannel cascade deletion via AgentChatChannelMetadataService.deleteChannel
    const channelNav = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.AGENT_CHAT_CHANNEL,
        agentChatChannelId: channelId,
        name: 'Pinned AI Channel',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const channelMetadataService = new AgentChatChannelMetadataService(
      applicationServiceMock as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
    );
    await channelMetadataService.deleteChannel({
      workspaceId,
      channelId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    // Seed page layouts creates seeded navigationMenuItems under dev-seeder:page-layouts
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

    const audits = await ownerDataSource.query(
      `SELECT "resourceId",action,actor
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='navigationMenuItem'
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(
      audits.find(
        (r: any) => r.resourceId === recordNav.id && r.action === 'delete',
      ),
    ).toMatchObject({
      actor: {
        kind: 'system',
        id: 'navigation-menu-item:deleted-records-cleanup',
      },
    });

    expect(
      audits.find(
        (r: any) => r.resourceId === viewNav.id && r.action === 'delete',
      ),
    ).toMatchObject({
      actor: {
        kind: 'workspaceMember',
        id: ownerWorkspaceMemberId,
      },
    });

    expect(
      audits.find(
        (r: any) => r.resourceId === layoutNav.id && r.action === 'delete',
      ),
    ).toMatchObject({
      actor: {
        kind: 'workspaceMember',
        id: ownerWorkspaceMemberId,
      },
    });

    expect(
      audits.find(
        (r: any) => r.resourceId === channelNav.id && r.action === 'delete',
      ),
    ).toMatchObject({
      actor: {
        kind: 'workspaceMember',
        id: ownerWorkspaceMemberId,
      },
    });

    expect(
      audits.some(
        (r: any) =>
          r.action === 'create' &&
          r.actor?.kind === 'system' &&
          r.actor?.id === 'dev-seeder:page-layouts',
      ),
    ).toBe(true);
  });

  it('audits ObjectMetadataService.createOneObject navigationMenuItem creation and rolls back on audit journal failure', async () => {
    const {
      validateBuildAndRunMock,
      cacheService,
      workspaceCacheService,
      applicationServiceMock,
      navigationMenuItemService,
    } = buildRunnerHarness();

    const objectMetadataService = new ObjectMetadataService(
      {} as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      workspaceCacheService as never,
      applicationServiceMock as never,
    );

    const createdObj = await objectMetadataService.createOneObject({
      createObjectInput: {
        nameSingular: 'project',
        namePlural: 'projects',
        labelSingular: 'Project',
        labelPlural: 'Projects',
        icon: 'IconBriefcase',
      } as never,
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    expect(createdObj.nameSingular).toBe('project');

    const navAfterCreateObj = await ownerDataSource.query(
      `SELECT id FROM core."navigationMenuItem" WHERE "workspaceId"=$1 AND "targetObjectMetadataId"=$2`,
      [workspaceId, createdObj.id],
    );
    expect(navAfterCreateObj).toHaveLength(1);

    const objNavAudit = await ownerDataSource.query(
      `SELECT "resourceId",action,actor
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='navigationMenuItem' AND "resourceId"=$2`,
      [workspaceId, navAfterCreateObj[0].id],
    );
    expect(objNavAudit).toEqual([
      {
        resourceId: navAfterCreateObj[0].id,
        action: 'create',
        actor: {
          kind: 'workspaceMember',
          id: ownerWorkspaceMemberId,
        },
      },
    ]);

    // Revoke INSERT on crm_audit."crmAuditEntry" and verify transaction rolls back
    await ownerDataSource.query(
      `REVOKE INSERT ON TABLE crm_audit."crmAuditEntry" FROM "${runtimeRole}"`,
    );
    try {
      await expect(
        navigationMenuItemService.create({
          input: {
            type: NavigationMenuItemType.FOLDER,
            name: 'Should Rollback',
            userWorkspaceId: ownerUserWorkspaceId,
          },
          workspaceId,
          authUserWorkspaceId: ownerUserWorkspaceId,
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await ownerDataSource.query(
        `GRANT INSERT ON TABLE crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
      );
    }

    const rolledBackRows = await ownerDataSource.query(
      `SELECT id FROM core."navigationMenuItem" WHERE "workspaceId"=$1 AND name='Should Rollback'`,
      [workspaceId],
    );
    expect(rolledBackRows).toHaveLength(0);

    // Service-level ObjectMetadataService.deleteOneObject cascades and audits navigationMenuItem deletion
    await objectMetadataService.deleteOneObject({
      deleteObjectInput: { id: createdObj.id },
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    const navDeleteAudit = await ownerDataSource.query(
      `SELECT action,actor
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='navigationMenuItem' AND "resourceId"=$2
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId, navAfterCreateObj[0].id],
    );
    expect(navDeleteAudit).toEqual([
      {
        action: 'create',
        actor: {
          kind: 'workspaceMember',
          id: ownerWorkspaceMemberId,
        },
      },
      {
        action: 'delete',
        actor: {
          kind: 'workspaceMember',
          id: ownerWorkspaceMemberId,
        },
      },
    ]);

    // FieldMetadataService.updateOneField (deactivation) and deleteOneField cascade view -> navigationMenuItem deletion
    const field1Id = randomUUID().toLowerCase();
    const field1Uid = randomUUID().toLowerCase();
    const field2Id = randomUUID().toLowerCase();
    const field2Uid = randomUUID().toLowerCase();
    const calView1Id = randomUUID().toLowerCase();
    const calView1Uid = randomUUID().toLowerCase();
    const calView2Id = randomUUID().toLowerCase();
    const calView2Uid = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", type, name, label, "isActive", "isCustom", "isSystem")
       VALUES ($1,$2,$3,$4,$5,'DATE_TIME','dueAt','Due At',true,true,false),
              ($6,$2,$3,$7,$5,'DATE_TIME','closedAt','Closed At',true,true,false)`,
      [
        field1Id,
        workspaceId,
        customApplicationId,
        field1Uid,
        objectMetadataId,
        field2Id,
        field2Uid,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.view (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, "calendarFieldMetadataId")
       VALUES ($1,$2,$3,$4,$5,'Calendar 1',$6),
              ($7,$2,$3,$8,$5,'Calendar 2',$9)`,
      [
        calView1Id,
        workspaceId,
        customApplicationId,
        calView1Uid,
        objectMetadataId,
        field1Id,
        calView2Id,
        calView2Uid,
        field2Id,
      ],
    );

    const calNav1 = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.VIEW,
        viewId: calView1Id,
        name: 'Cal 1 Nav',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    const calNav2 = await navigationMenuItemService.create({
      input: {
        type: NavigationMenuItemType.VIEW,
        viewId: calView2Id,
        name: 'Cal 2 Nav',
      },
      workspaceId,
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const fieldMetadataService = new FieldMetadataService(
      {} as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      applicationServiceMock as never,
      workspaceCacheService as never,
    );

    await fieldMetadataService.updateOneField({
      updateFieldInput: { id: field1Id, isActive: false },
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    await fieldMetadataService.deleteOneField({
      deleteOneFieldInput: { id: field2Id },
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const calNavAudits = await ownerDataSource.query(
      `SELECT "resourceId",action FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='navigationMenuItem' AND "resourceId"=ANY($2::text[]) AND action='delete'`,
      [workspaceId, [calNav1.id, calNav2.id]],
    );
    expect(calNavAudits).toHaveLength(2);
  });

  it('audits manifest sync create/update/delete, objectDelete cascade, reconcileApplicationRoleAndPermissionOperations, and assertNoRemainingApplicationRoleOrPermissionMetadata', async () => {
    const { runnerService } = buildRunnerHarness();

    const manifestNavUniversalId = randomUUID().toLowerCase();
    const manifestAuditOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        workspaceId,
        actor: { kind: 'system', id: 'app-sync' },
        correlationId: randomUUID(),
      },
      mode: 'manifest',
    });

    // 1. Manifest create without preallocated action.id
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(manifestAuditOp, {
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
                metadataName: 'navigationMenuItem',
                flatEntity: {
                  universalIdentifier: manifestNavUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  type: 'OBJECT',
                  targetObjectMetadataId: objectMetadataId,
                  name: 'Manifest Object Pin',
                  position: 10,
                },
              },
            ],
          } as never,
        }),
    );

    const [createdManifestNav] = await ownerDataSource.query(
      `SELECT id FROM core."navigationMenuItem" WHERE "universalIdentifier"=$1`,
      [manifestNavUniversalId],
    );
    expect(createdManifestNav).toBeDefined();

    // 2. Application delete guard blocks while navigationMenuItem remains
    const checkRunner = runtimeDataSource.createQueryRunner();
    await checkRunner.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await checkRunner.release();
    }

    // 3. Reconcile includes navigationMenuItem referencing deleted object and nested folder children
    const reconciledRecord: Record<string, any> = {
      objectMetadata: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [objectMetadataUniversalId]: {
            id: objectMetadataId,
            universalIdentifier: objectMetadataUniversalId,
          },
        },
      },
    };
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName: reconciledRecord,
      existingAllFlatEntityMaps: await buildNavigationMapsFromDb(),
    });
    expect(
      reconciledRecord.navigationMenuItem?.flatEntityToDelete[
        manifestNavUniversalId
      ],
    ).toBeDefined();

    // 4. Object delete (mode: 'objectDelete') cascades and audits navigationMenuItem deletion
    const objDeleteOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      mode: 'objectDelete',
      expectedDeletedObjectIds: [objectMetadataId],
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(objDeleteOp, {
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
                metadataName: 'view',
                universalIdentifier: viewUniversalId,
              },
              {
                type: 'delete',
                metadataName: 'objectMetadata',
                universalIdentifier: objectMetadataUniversalId,
              },
            ],
          } as never,
        }),
    );

    const audits = await ownerDataSource.query(
      `SELECT "resourceId",action FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1 AND "resourceKind"='navigationMenuItem' AND "resourceId"=$2
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId, createdManifestNav.id],
    );
    expect(audits).toEqual([
      { resourceId: createdManifestNav.id, action: 'create' },
      { resourceId: createdManifestNav.id, action: 'delete' },
    ]);
  });

  it('invalidates cache and propagates NativeTransactionOutcomeUnknownError and CoreAuditPostCommitError without masking, and detects post-flush tampering', async () => {
    const {
      navigationMenuItemService,
      invalidateCacheMock,
      actionHandlerRegistry,
    } = buildRunnerHarness() as any;

    const createRunnerSpy = jest.spyOn(runtimeDataSource, 'createQueryRunner');
    const realRunner = runtimeDataSource.createQueryRunner();
    createRunnerSpy.mockReturnValueOnce(
      new Proxy(realRunner, {
        get(target, prop, receiver) {
          if (prop === 'commitTransaction') {
            return async () => {
              await target.commitTransaction();
              throw new Error('Simulated lost COMMIT acknowledgement');
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );

    await expect(
      navigationMenuItemService.create({
        input: {
          type: NavigationMenuItemType.FOLDER,
          name: 'Post Commit Folder',
          userWorkspaceId: ownerUserWorkspaceId,
        },
        workspaceId,
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(invalidateCacheMock).toHaveBeenCalled();

    // Post-flush tamper detection: if navigationMenuItem table mutates during audit.flush(), transaction rolls back
    const origFlush = CrmAuditTransactionContext.prototype.flush;
    const flushSpy = jest
      .spyOn(CrmAuditTransactionContext.prototype, 'flush')
      .mockImplementationOnce(async function (this: any) {
        await origFlush.call(this);
        await this.queryRunner.query(
          `UPDATE core."navigationMenuItem" SET position = position + 999 WHERE "workspaceId"=$1`,
          [workspaceId],
        );
      });

    await expect(
      navigationMenuItemService.create({
        input: {
          type: NavigationMenuItemType.FOLDER,
          name: 'Tampered Folder',
          userWorkspaceId: ownerUserWorkspaceId,
        },
        workspaceId,
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      }),
    ).rejects.toThrow('Navigation menu item state changed during audit flush');

    flushSpy.mockRestore();
    createRunnerSpy.mockRestore();
  });
});
