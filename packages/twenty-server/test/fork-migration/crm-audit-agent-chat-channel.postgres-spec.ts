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
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel-access.service',
    ['AgentChatChannelAccessService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel-grant.service',
    ['AgentChatChannelGrantService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service',
    ['AgentChatSharingService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-record-event.service',
    ['AgentChatThreadRecordEventService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel-threads.service',
    ['AgentChatChannelThreadsService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-triage.service',
    ['AgentChatThreadTriageService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread.service',
    ['AgentChatThreadService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository',
    ['AgentHistoryRepository'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity',
    ['AgentChatThreadWorkspaceEntity'],
  ],
  [
    'src/engine/metadata-modules/ai/interceptors/ai-graphql-api-exception.interceptor',
    ['AiGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-agent/entities/agent.entity',
    ['AgentEntity'],
  ],
  [
    'src/engine/metadata-modules/role-target/role-target.entity',
    ['RoleTargetEntity'],
  ],
  [
    'src/engine/metadata-modules/role-target/services/role-target.service',
    ['RoleTargetService'],
  ],
  ['src/engine/metadata-modules/role/role.entity', ['RoleEntity']],
  [
    'src/engine/metadata-modules/object-permission/object-permission.service',
    ['ObjectPermissionService'],
  ],
  [
    'src/engine/metadata-modules/permission-flag/permission-flag.service',
    ['PermissionFlagService'],
  ],
  [
    'src/engine/metadata-modules/user-role/user-role.service',
    ['UserRoleService'],
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
  [
    'src/database/typeorm/postgres-advisory-lock.service',
    ['PostgresAdvisoryLockService'],
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
  [
    'src/engine/decorators/auth/auth-workspace-member-id.decorator',
    ['AuthWorkspaceMemberId'],
  ],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/repositories/inject-agent-history-repository.decorator',
    ['InjectAgentHistoryRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { AgentChatChannelMetadataService } =
  require('src/engine/metadata-modules/agent-chat-channel/services/agent-chat-channel-metadata.service') as typeof import('src/engine/metadata-modules/agent-chat-channel/services/agent-chat-channel-metadata.service');
const { AgentChatChannelService } =
  require('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel.service') as typeof import('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel.service');
const { AgentChatChannelResolver } =
  require('src/engine/metadata-modules/ai/ai-chat/resolvers/agent-chat-channel.resolver') as typeof import('src/engine/metadata-modules/ai/ai-chat/resolvers/agent-chat-channel.resolver');
const { AgentChatChannelRoleAccessListener } =
  require('src/engine/metadata-modules/ai/ai-chat/listeners/agent-chat-channel-role-access.listener') as typeof import('src/engine/metadata-modules/ai/ai-chat/listeners/agent-chat-channel-role-access.listener');
const { AiAgentRoleService } =
  require('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service') as typeof import('src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service');
const { RoleService } =
  require('src/engine/metadata-modules/role/role.service') as typeof import('src/engine/metadata-modules/role/role.service');
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

const runtimeRole = `twenty_acc_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
const impersonatorWorkspaceMemberId = randomUUID().toLowerCase();

const memberUserId = randomUUID().toLowerCase();
const memberUserWorkspaceId = randomUUID().toLowerCase();
const memberWorkspaceMemberId = randomUUID().toLowerCase();

const defaultRoleId = randomUUID().toLowerCase();
const defaultRoleUniversalId = randomUUID().toLowerCase();

const supportRoleId = randomUUID().toLowerCase();
const supportRoleUniversalId = randomUUID().toLowerCase();

const salesRoleId = randomUUID().toLowerCase();
const salesRoleUniversalId = randomUUID().toLowerCase();

const agentId = randomUUID().toLowerCase();
const agentUniversalId = randomUUID().toLowerCase();

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

describe('CRM audit agentChatChannel and agentChatChannelRole lifecycle and cascades (PostgreSQL)', () => {
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
      CREATE TABLE "${workspaceSchema}"."agentChatThread" (
        id uuid PRIMARY KEY,
        "channelId" uuid NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core.application (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "canBeUninstalled" boolean NOT NULL DEFAULT true,
        "defaultRoleId" uuid NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core.role (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        label text NOT NULL,
        description text NULL,
        icon text NULL,
        "isEditable" boolean NOT NULL DEFAULT true,
        "canUpdateAllSettings" boolean NOT NULL DEFAULT false,
        "canAccessAllTools" boolean NOT NULL DEFAULT true,
        "canAccessAllAgentChatChannels" boolean NOT NULL DEFAULT true,
        "canReadAllObjectRecords" boolean NOT NULL DEFAULT true,
        "canUpdateAllObjectRecords" boolean NOT NULL DEFAULT true,
        "canSoftDeleteAllObjectRecords" boolean NOT NULL DEFAULT true,
        "canDestroyAllObjectRecords" boolean NOT NULL DEFAULT true,
        "canBeAssignedToUsers" boolean NOT NULL DEFAULT true,
        "canBeAssignedToAgents" boolean NOT NULL DEFAULT true,
        "canBeAssignedToApiKeys" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core.agent (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      );
      CREATE TABLE core."apiKey" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "revokedAt" timestamptz NULL
      );
      CREATE TABLE core."roleTarget" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "userWorkspaceId" uuid NULL,
        "agentId" uuid NULL,
        "apiKeyId" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core."agentChatChannel" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        icon text NULL,
        color text NULL,
        position double precision NOT NULL DEFAULT 0,
        "isCustom" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE core."agentChatChannelRole" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "channelId" uuid NOT NULL REFERENCES core."agentChatChannel"(id) ON DELETE CASCADE,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "IDX_AGENT_CHAT_CHANNEL_ROLE_CHANNEL_ID_ROLE_ID_UNIQUE" UNIQUE ("channelId", "roleId")
      );
      CREATE TABLE core."navigationMenuItem" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "userWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
        "targetRecordId" uuid NULL,
        "targetObjectMetadataId" uuid NULL,
        "viewId" uuid NULL,
        "folderId" uuid NULL REFERENCES core."navigationMenuItem"(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        "pageLayoutId" uuid NULL,
        "agentChatChannelId" uuid NULL REFERENCES core."agentChatChannel"(id) ON DELETE CASCADE,
        type text NOT NULL,
        name text NULL,
        link text NULL,
        icon text NULL,
        color text NULL,
        position double precision NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
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
        "${workspaceSchema}"."agentChatThread",
        core."navigationMenuItem",
        core."agentChatChannelRole",
        core."agentChatChannel",
        core."roleTarget",
        core.role,
        core.agent,
        core."apiKey",
        core.application,
        "${workspaceSchema}"."workspaceMember",
        core."userWorkspace",
        core."user",
        core.workspace
      RESTART IDENTITY CASCADE
    `);

    await ownerDataSource.query(
      `INSERT INTO core.workspace (id, "defaultRoleId") VALUES ($1, $2)`,
      [workspaceId, defaultRoleId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."user" (id, email, "canImpersonate", "canAccessFullAdminPanel")
       VALUES ($1, 'owner@example.test', false, false),
              ($2, 'impersonator@example.test', true, true),
              ($3, 'member@example.test', false, false)`,
      [ownerUserId, impersonatorUserId, memberUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId")
       VALUES ($1, $2, $3), ($4, $5, $3), ($6, $7, $3)`,
      [
        ownerUserWorkspaceId,
        ownerUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
        memberUserWorkspaceId,
        memberUserId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId")
       VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [
        ownerWorkspaceMemberId,
        ownerUserId,
        impersonatorWorkspaceMemberId,
        impersonatorUserId,
        memberWorkspaceMemberId,
        memberUserId,
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
      `INSERT INTO core.role (
         id, "workspaceId", "applicationId", "universalIdentifier",
         label, description, icon, "isEditable",
         "canUpdateAllSettings", "canAccessAllAgentChatChannels",
         "canBeAssignedToUsers", "canBeAssignedToAgents", "canBeAssignedToApiKeys"
       ) VALUES
         ($1, $2, $3, $4, 'Default Role', 'Default', 'IconUser', true, false, true, true, true, true),
         ($5, $2, $3, $6, 'Support Role', 'Support', 'IconHeadset', true, false, false, true, true, true),
         ($7, $2, $3, $8, 'Sales Role', 'Sales', 'IconBriefcase', true, false, false, true, true, true)`,
      [
        defaultRoleId,
        workspaceId,
        customApplicationId,
        defaultRoleUniversalId,
        supportRoleId,
        supportRoleUniversalId,
        salesRoleId,
        salesRoleUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.agent (id, "workspaceId", "applicationId", "universalIdentifier")
       VALUES ($1, $2, $3, $4)`,
      [agentId, workspaceId, customApplicationId, agentUniversalId],
    );
  });

  const buildMapsFromDb = async () => {
    const roleRows = await ownerDataSource.query(
      `SELECT * FROM core.role WHERE "workspaceId"=$1 ORDER BY id`,
      [workspaceId],
    );
    const roleTargetRows = await ownerDataSource.query(
      `SELECT * FROM core."roleTarget" WHERE "workspaceId"=$1 ORDER BY id`,
      [workspaceId],
    );
    const agentRows = await ownerDataSource.query(
      `SELECT * FROM core.agent WHERE "workspaceId"=$1 ORDER BY id`,
      [workspaceId],
    );
    const channelRows = await ownerDataSource.query(
      `SELECT * FROM core."agentChatChannel" WHERE "workspaceId"=$1 ORDER BY position, id`,
      [workspaceId],
    );
    const channelRoleRows = await ownerDataSource.query(
      `SELECT * FROM core."agentChatChannelRole" WHERE "workspaceId"=$1 ORDER BY id`,
      [workspaceId],
    );
    const navRows = await ownerDataSource.query(
      `SELECT * FROM core."navigationMenuItem" WHERE "workspaceId"=$1 ORDER BY position, id`,
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

    const flatRoleMaps = buildSimpleMaps(roleRows);
    const flatRoleTargetMaps = buildSimpleMaps(roleTargetRows);
    const flatAgentMaps = buildSimpleMaps(agentRows);
    const flatAgentChatChannelMaps = buildSimpleMaps(channelRows);
    const flatAgentChatChannelRoleMaps = buildSimpleMaps(channelRoleRows);
    const navBase = buildSimpleMaps(navRows);

    for (const rt of Object.values(flatRoleTargetMaps.byUniversalIdentifier)) {
      rt.roleUniversalIdentifier =
        flatRoleMaps.universalIdentifierById[rt.roleId] ?? null;
      rt.agentUniversalIdentifier = rt.agentId
        ? (flatAgentMaps.universalIdentifierById[rt.agentId] ?? null)
        : null;
    }

    for (const cr of Object.values(
      flatAgentChatChannelRoleMaps.byUniversalIdentifier,
    )) {
      cr.channelUniversalIdentifier =
        flatAgentChatChannelMaps.universalIdentifierById[cr.channelId] ?? null;
      cr.roleUniversalIdentifier =
        flatRoleMaps.universalIdentifierById[cr.roleId] ?? null;
    }

    for (const role of Object.values(flatRoleMaps.byUniversalIdentifier)) {
      const targets = Object.values(
        flatRoleTargetMaps.byUniversalIdentifier,
      ).filter((t: any) => t.roleId === role.id);
      const chRoles = Object.values(
        flatAgentChatChannelRoleMaps.byUniversalIdentifier,
      ).filter((cr: any) => cr.roleId === role.id);
      role.roleTargetIds = targets.map((t: any) => t.id);
      role.roleTargetUniversalIdentifiers = targets.map(
        (t: any) => t.universalIdentifier,
      );
      role.agentChatChannelRoleIds = chRoles.map((cr: any) => cr.id);
      role.agentChatChannelRoleUniversalIdentifiers = chRoles.map(
        (cr: any) => cr.universalIdentifier,
      );
      role.permissionFlagIds = [];
      role.permissionFlagUniversalIdentifiers = [];
      role.objectPermissionIds = [];
      role.objectPermissionUniversalIdentifiers = [];
      role.fieldPermissionIds = [];
      role.fieldPermissionUniversalIdentifiers = [];
      role.rowLevelPermissionPredicateIds = [];
      role.rowLevelPermissionPredicateUniversalIdentifiers = [];
      role.rowLevelPermissionPredicateGroupIds = [];
      role.rowLevelPermissionPredicateGroupUniversalIdentifiers = [];
    }

    const byUserWorkspaceIdAndFolderId: Record<
      string,
      Record<string, any[]>
    > = {};
    for (const nav of Object.values(navBase.byUniversalIdentifier)) {
      nav.folderUniversalIdentifier = nav.folderId
        ? (navBase.universalIdentifierById[nav.folderId] ?? null)
        : null;
      nav.agentChatChannelUniversalIdentifier = nav.agentChatChannelId
        ? (flatAgentChatChannelMaps.universalIdentifierById[
            nav.agentChatChannelId
          ] ?? null)
        : null;
      nav.viewUniversalIdentifier = null;
      nav.targetObjectMetadataUniversalIdentifier = null;
      nav.pageLayoutUniversalIdentifier = null;

      const uwKey = nav.userWorkspaceId ?? 'null';
      const folderKey = nav.folderId ?? 'null';
      byUserWorkspaceIdAndFolderId[uwKey] ??= {};
      byUserWorkspaceIdAndFolderId[uwKey][folderKey] ??= [];
      byUserWorkspaceIdAndFolderId[uwKey][folderKey].push(nav);
    }

    for (const ch of Object.values(
      flatAgentChatChannelMaps.byUniversalIdentifier,
    )) {
      const chRoles = Object.values(
        flatAgentChatChannelRoleMaps.byUniversalIdentifier,
      ).filter((cr: any) => cr.channelId === ch.id);
      ch.channelRoleIds = chRoles.map((cr: any) => cr.id);
      ch.channelRoleUniversalIdentifiers = chRoles.map(
        (cr: any) => cr.universalIdentifier,
      );
      const matchingNavs = Object.values(navBase.byUniversalIdentifier).filter(
        (n: any) => n.agentChatChannelId === ch.id,
      );
      ch.navigationMenuItemIds = matchingNavs.map((n: any) => n.id);
      ch.navigationMenuItemUniversalIdentifiers = matchingNavs.map(
        (n: any) => n.universalIdentifier,
      );
    }

    return {
      flatRoleMaps,
      flatRoleTargetMaps,
      flatAgentMaps,
      flatPermissionFlagMaps: buildSimpleMaps([]),
      flatRolePermissionFlagMaps: buildSimpleMaps([]),
      flatObjectMetadataMaps: buildSimpleMaps([]),
      flatFieldMetadataMaps: buildSimpleMaps([]),
      flatIndexMaps: buildSimpleMaps([]),
      flatViewMaps: buildSimpleMaps([]),
      flatPageLayoutMaps: buildSimpleMaps([]),
      flatNavigationMenuItemMaps: {
        ...navBase,
        byUserWorkspaceIdAndFolderId,
      },
      flatAgentChatChannelMaps,
      flatAgentChatChannelRoleMaps,
      flatObjectPermissionMaps: buildSimpleMaps([]),
      flatFieldPermissionMaps: buildSimpleMaps([]),
      flatRowLevelPermissionPredicateGroupMaps: buildSimpleMaps([]),
      flatRowLevelPermissionPredicateMaps: buildSimpleMaps([]),
    };
  };

  const buildHarness = () => {
    const invalidateCacheMock = jest.fn().mockResolvedValue(undefined);
    const cacheService = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest
        .fn()
        .mockImplementation(async () => buildMapsFromDb()),
      invalidateFlatEntityMaps: jest.fn().mockResolvedValue(undefined),
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
          if (action.metadataName === 'agentChatChannel') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core."agentChatChannel" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, icon, color, position, "isCustom"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.icon ?? null,
                  fe.color ?? null,
                  fe.position ?? 0,
                  fe.isCustom ?? true,
                ],
              );
              allFlatEntityMaps.flatAgentChatChannelMaps.byUniversalIdentifier[
                fe.universalIdentifier
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatAgentChatChannelMaps
                  ?.byUniversalIdentifier[action.universalIdentifier];
              const upd = action.update ?? {};
              await queryRunner.query(
                `UPDATE core."agentChatChannel"
                 SET name=$1, icon=$2, color=$3, position=$4, "updatedAt"=now()
                 WHERE id=$5 AND "workspaceId"=$6`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'icon' in upd ? upd.icon : existing.icon,
                  'color' in upd ? upd.color : existing.color,
                  'position' in upd ? upd.position : existing.position,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatAgentChatChannelMaps
                  ?.byUniversalIdentifier[action.universalIdentifier];
              await queryRunner.query(
                `DELETE FROM core."agentChatChannel" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (action.metadataName === 'agentChatChannelRole') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const resolvedChannelId =
                fe.channelId ??
                allFlatEntityMaps.flatAgentChatChannelMaps
                  ?.byUniversalIdentifier[fe.channelUniversalIdentifier]?.id;
              const resolvedRoleId =
                fe.roleId ??
                allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier[
                  fe.roleUniversalIdentifier
                ]?.id;
              await queryRunner.query(
                `INSERT INTO core."agentChatChannelRole" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "channelId", "roleId"
                 ) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  resolvedChannelId,
                  resolvedRoleId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatAgentChatChannelRoleMaps
                  ?.byUniversalIdentifier[action.universalIdentifier];
              await queryRunner.query(
                `DELETE FROM core."agentChatChannelRole" WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (action.metadataName === 'navigationMenuItem') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const resolvedChannelId =
                fe.agentChatChannelId ??
                (fe.agentChatChannelUniversalIdentifier
                  ? allFlatEntityMaps.flatAgentChatChannelMaps
                      ?.byUniversalIdentifier[
                      fe.agentChatChannelUniversalIdentifier
                    ]?.id
                  : null) ??
                null;
              const resolvedFolderId =
                fe.folderId ??
                (fe.folderUniversalIdentifier
                  ? allFlatEntityMaps.flatNavigationMenuItemMaps
                      ?.byUniversalIdentifier[fe.folderUniversalIdentifier]?.id
                  : null) ??
                null;
              await queryRunner.query(
                `INSERT INTO core."navigationMenuItem" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "userWorkspaceId", "folderId", "agentChatChannelId",
                   type, name, icon, color, position
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.userWorkspaceId ?? null,
                  resolvedFolderId,
                  resolvedChannelId,
                  fe.type,
                  fe.name ?? null,
                  fe.icon ?? null,
                  fe.color ?? null,
                  fe.position ?? 0,
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
          } else if (action.metadataName === 'role') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core.role (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   label, description, icon, "isEditable",
                   "canUpdateAllSettings", "canAccessAllTools", "canAccessAllAgentChatChannels",
                   "canReadAllObjectRecords", "canUpdateAllObjectRecords",
                   "canSoftDeleteAllObjectRecords", "canDestroyAllObjectRecords",
                   "canBeAssignedToUsers", "canBeAssignedToAgents", "canBeAssignedToApiKeys"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.label,
                  fe.description ?? null,
                  fe.icon ?? null,
                  fe.isEditable ?? true,
                  fe.canUpdateAllSettings ?? false,
                  fe.canAccessAllTools ?? true,
                  fe.canAccessAllAgentChatChannels ?? true,
                  fe.canReadAllObjectRecords ?? true,
                  fe.canUpdateAllObjectRecords ?? true,
                  fe.canSoftDeleteAllObjectRecords ?? true,
                  fe.canDestroyAllObjectRecords ?? true,
                  fe.canBeAssignedToUsers ?? true,
                  fe.canBeAssignedToAgents ?? true,
                  fe.canBeAssignedToApiKeys ?? true,
                ],
              );
              allFlatEntityMaps.flatRoleMaps.byUniversalIdentifier[
                fe.universalIdentifier
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              await queryRunner.query(
                `DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2`,
                [existing.id, workspaceId],
              );
            }
          } else if (action.metadataName === 'roleTarget') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              const resolvedRoleId =
                fe.roleId ??
                allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier[
                  fe.roleUniversalIdentifier
                ]?.id;
              const resolvedAgentId =
                fe.agentId ??
                (fe.agentUniversalIdentifier
                  ? allFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier[
                      fe.agentUniversalIdentifier
                    ]?.id
                  : null) ??
                null;
              await queryRunner.query(
                `INSERT INTO core."roleTarget" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   "roleId", "userWorkspaceId", "agentId", "apiKeyId",
                   "createdAt", "updatedAt"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  resolvedRoleId,
                  fe.userWorkspaceId ?? null,
                  resolvedAgentId,
                  fe.apiKeyId ?? null,
                  fe.createdAt ?? new Date().toISOString(),
                  fe.updatedAt ?? new Date().toISOString(),
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatRoleTargetMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              await queryRunner.query(
                `DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2`,
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
          const mapKey =
            metadataName === 'agentChatChannel'
              ? 'flatAgentChatChannelMaps'
              : metadataName === 'navigationMenuItem'
                ? 'flatNavigationMenuItemMaps'
                : 'flatRoleMaps';
          const existing =
            (currentMaps as any)[mapKey]?.byUniversalIdentifier[
              fe.universalIdentifier
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of ['name', 'icon', 'color', 'position']) {
            if (key in fe && fe[key] !== existing[key]) {
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

    const channelMetadataService = new AgentChatChannelMetadataService(
      applicationServiceMock as never,
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
    );

    const rewriteChannelGrantsMock = jest.fn().mockResolvedValue(undefined);
    const enqueueChannelGrantsRewriteMock = jest
      .fn()
      .mockResolvedValue(undefined);

    const channelService = new AgentChatChannelService(
      {
        query: jest.fn().mockImplementation(async (_wsId: string, fn: any) =>
          runtimeDataSource.transaction(async (manager) =>
            fn({
              manager,
              table: () => `"${workspaceSchema}"."agentChatThread"`,
            }),
          ),
        ),
      } as never,
      channelMetadataService,
      {
        findMemberRole: jest.fn().mockResolvedValue(null),
        assertChannelAccess: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        rewriteChannelGrants: rewriteChannelGrantsMock,
        enqueueChannelGrantsRewrite: enqueueChannelGrantsRewriteMock,
        rewriteThreadGrantsInTransaction: jest
          .fn()
          .mockResolvedValue(undefined),
      } as never,
      {
        hasChannels: jest.fn().mockResolvedValue(true),
      } as never,
      {
        emitThreadsUpdated: jest.fn().mockResolvedValue(undefined),
      } as never,
      workspaceCacheService as never,
      {
        tryWithLock: jest
          .fn()
          .mockImplementation(
            async (_key: unknown, fn: () => Promise<void>) => {
              await fn();
              return { acquired: true, result: undefined };
            },
          ),
      } as never,
    );

    const channelResolver = new AgentChatChannelResolver(
      channelService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      flatApplicationMaps,
      applicationServiceMock,
      validateBuildAndRunMock,
      buildActionsFromMatrice,
      channelMetadataService,
      channelService,
      channelResolver,
      rewriteChannelGrantsMock,
      enqueueChannelGrantsRewriteMock,
    };
  };

  it('audits create, update, role replacement, and delete of agentChatChannel and agentChatChannelRole with impersonation initiator', async () => {
    const {
      channelResolver,
      rewriteChannelGrantsMock,
      enqueueChannelGrantsRewriteMock,
    } = buildHarness();

    const created = await channelResolver.createAgentChatChannel(
      {
        name: 'VIP Support',
        icon: 'IconSparkles',
        color: 'blue',
        roleIds: [supportRoleId],
      },
      { id: workspaceId } as never,
      ownerWorkspaceMemberId,
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

    expect(created.name).toBe('VIP Support');
    expect(created.roleIds).toEqual([supportRoleId]);

    const [initialRoleLink] = await ownerDataSource.query(
      `SELECT id FROM core."agentChatChannelRole" WHERE "channelId"=$1 AND "roleId"=$2`,
      [created.id, supportRoleId],
    );
    expect(initialRoleLink).toBeDefined();

    // Update channel properties + replace roleIds (supportRoleId -> salesRoleId)
    const updated = await channelResolver.updateAgentChatChannel(
      created.id,
      {
        name: 'Enterprise Support',
        icon: 'IconShield',
        color: 'green',
        position: 5,
        roleIds: [salesRoleId],
      },
      { id: workspaceId } as never,
      ownerWorkspaceMemberId,
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
    expect(updated.name).toBe('Enterprise Support');
    expect(updated.roleIds).toEqual([salesRoleId]);
    expect(rewriteChannelGrantsMock).toHaveBeenCalledWith({
      workspaceId,
      channelId: created.id,
    });

    const [replacementRoleLink] = await ownerDataSource.query(
      `SELECT id FROM core."agentChatChannelRole" WHERE "channelId"=$1 AND "roleId"=$2`,
      [created.id, salesRoleId],
    );
    expect(replacementRoleLink).toBeDefined();

    // No-op update produces no extra audit entries
    const auditCountBeforeNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    await channelResolver.updateAgentChatChannel(
      created.id,
      {
        name: 'Enterprise Support',
        icon: 'IconShield',
        color: 'green',
        position: 5,
        roleIds: [salesRoleId],
      },
      { id: workspaceId } as never,
      ownerWorkspaceMemberId,
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
    const auditCountAfterNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    expect(auditCountAfterNoOp).toBe(auditCountBeforeNoOp);

    // Pin a navigationMenuItem to the channel before deleting the channel
    const pinnedNavId = randomUUID().toLowerCase();
    const pinnedNavUniversalId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."navigationMenuItem" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "agentChatChannelId", type, name, position
       ) VALUES ($1, $2, $3, $4, $5, $6, 'Channel Shortcut', 0)`,
      [
        pinnedNavId,
        workspaceId,
        customApplicationId,
        pinnedNavUniversalId,
        created.id,
        NavigationMenuItemType.AGENT_CHAT_CHANNEL,
      ],
    );

    const deletedOk = await channelResolver.deleteAgentChatChannel(
      created.id,
      null,
      ownerWorkspaceMemberId,
      ownerUserWorkspaceId,
      { id: workspaceId } as never,
      undefined,
      {
        req: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
          userWorkspaceId: ownerUserWorkspaceId,
        },
      },
    );
    expect(deletedOk).toBe(true);

    // Listener also enqueues grant rewrites on metadata.agentChatChannelRole.created/deleted
    const listener = new AgentChatChannelRoleAccessListener({
      enqueueChannelGrantsRewrite: enqueueChannelGrantsRewriteMock,
    } as never);
    await listener.handleCreatedChannelRoles({
      workspaceId,
      name: 'metadata.agentChatChannelRole.created',
      metadataName: 'agentChatChannelRole',
      type: 'created',
      events: [{ type: 'created' } as never],
    });
    await listener.handleDeletedChannelRoles({
      workspaceId,
      name: 'metadata.agentChatChannelRole.deleted',
      metadataName: 'agentChatChannelRole',
      type: 'deleted',
      events: [{ type: 'deleted' } as never],
    });
    expect(enqueueChannelGrantsRewriteMock).toHaveBeenCalledTimes(2);

    const audits = await ownerDataSource.query(
      `SELECT "operationId","resourceKind","resourceId",action,actor,initiator,"redactedDiff","securityDescriptor"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(audits).toHaveLength(8);

    // 1-2: create channel + create initial role link share the same operationId and impersonator initiator
    expect(audits[0].operationId).toBe(audits[1].operationId);
    const createGroup = audits.slice(0, 2);
    const createChannelAudit = createGroup.find(
      (r: any) => r.resourceKind === 'agentChatChannel',
    );
    const createChannelRoleAudit = createGroup.find(
      (r: any) => r.resourceKind === 'agentChatChannelRole',
    );
    expect(createChannelAudit).toMatchObject({
      resourceKind: 'agentChatChannel',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'agentChatChannel',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: ['color', 'icon', 'isCustom', 'name', 'position'],
        values: {
          isCustom: { before: null, after: true },
        },
      },
    });
    expect(createChannelAudit.redactedDiff.values.name).toBeUndefined();
    expect(createChannelAudit.redactedDiff.values.icon).toBeUndefined();
    expect(createChannelAudit.redactedDiff.values.color).toBeUndefined();
    expect(createChannelAudit.redactedDiff.values.position).toBeUndefined();

    expect(createChannelRoleAudit).toMatchObject({
      resourceKind: 'agentChatChannelRole',
      resourceId: initialRoleLink.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['channelId', 'roleId'],
        values: {
          channelId: { before: null, after: created.id },
          roleId: { before: null, after: supportRoleId },
        },
      },
    });

    // 3-5: update channel + create sales role link + delete support role link share one operationId
    expect(audits[2].operationId).toBe(audits[3].operationId);
    expect(audits[3].operationId).toBe(audits[4].operationId);
    const updateGroup = audits.slice(2, 5);
    expect(
      updateGroup.find((r: any) => r.resourceKind === 'agentChatChannel'),
    ).toMatchObject({
      resourceKind: 'agentChatChannel',
      resourceId: created.id,
      action: 'update',
      redactedDiff: {
        changedFields: ['color', 'icon', 'name', 'position'],
        values: {},
      },
    });
    expect(
      updateGroup.find(
        (r: any) =>
          r.resourceKind === 'agentChatChannelRole' && r.action === 'create',
      ),
    ).toMatchObject({
      resourceKind: 'agentChatChannelRole',
      resourceId: replacementRoleLink.id,
      action: 'create',
      redactedDiff: {
        changedFields: ['channelId', 'roleId'],
        values: {
          channelId: { before: null, after: created.id },
          roleId: { before: null, after: salesRoleId },
        },
      },
    });
    expect(
      updateGroup.find(
        (r: any) =>
          r.resourceKind === 'agentChatChannelRole' && r.action === 'delete',
      ),
    ).toMatchObject({
      resourceKind: 'agentChatChannelRole',
      resourceId: initialRoleLink.id,
      action: 'delete',
      redactedDiff: {
        changedFields: ['channelId', 'roleId'],
        values: {
          channelId: { before: created.id, after: null },
          roleId: { before: supportRoleId, after: null },
        },
      },
    });

    // 6-8: delete channel cascades navigationMenuItem:delete, agentChatChannel:delete, agentChatChannelRole:delete
    expect(audits[5].operationId).toBe(audits[6].operationId);
    expect(audits[6].operationId).toBe(audits[7].operationId);
    const deleteGroup = audits.slice(5, 8);
    expect(
      deleteGroup.find((r: any) => r.resourceKind === 'navigationMenuItem'),
    ).toMatchObject({
      resourceKind: 'navigationMenuItem',
      resourceId: pinnedNavId,
      action: 'delete',
    });
    expect(
      deleteGroup.find((r: any) => r.resourceKind === 'agentChatChannel'),
    ).toMatchObject({
      resourceKind: 'agentChatChannel',
      resourceId: created.id,
      action: 'delete',
      redactedDiff: {
        changedFields: ['color', 'icon', 'isCustom', 'name', 'position'],
        values: {
          isCustom: { before: true, after: null },
        },
      },
    });
    expect(
      deleteGroup.find((r: any) => r.resourceKind === 'agentChatChannelRole'),
    ).toMatchObject({
      resourceKind: 'agentChatChannelRole',
      resourceId: replacementRoleLink.id,
      action: 'delete',
      redactedDiff: {
        changedFields: ['channelId', 'roleId'],
        values: {
          channelId: { before: created.id, after: null },
          roleId: { before: salesRoleId, after: null },
        },
      },
    });
  });

  it('audits agentChatChannelRole cascade deletion during RoleService.deleteRole and AiAgentRoleService.deleteAgentOnlyRoleIfUnused', async () => {
    const {
      cacheService,
      workspaceCacheService,
      applicationServiceMock,
      validateBuildAndRunMock,
      channelMetadataService,
    } = buildHarness();

    const createdChannel = await channelMetadataService.createChannel({
      workspaceId,
      name: 'Support Triage',
      icon: 'IconLifebuoy',
      color: 'orange',
      roleIds: [supportRoleId],
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const [supportChannelRole] = await ownerDataSource.query(
      `SELECT id FROM core."agentChatChannelRole" WHERE "channelId"=$1 AND "roleId"=$2`,
      [createdChannel.id, supportRoleId],
    );
    expect(supportChannelRole).toBeDefined();

    // Assign memberUserWorkspaceId to supportRoleId so RoleService.deleteRole also rebinds roleTarget
    const memberRoleTargetId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."roleTarget" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "roleId", "userWorkspaceId"
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        memberRoleTargetId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        supportRoleId,
        memberUserWorkspaceId,
      ],
    );

    const roleService = new RoleService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: workspaceId, defaultRoleId }),
      } as never,
      applicationServiceMock as never,
      {
        getApiKeysAssignedToRole: jest.fn().mockResolvedValue([]),
      } as never,
    );

    await roleService.deleteRole({
      roleId: supportRoleId,
      workspaceId,
      actingUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });

    const remainingChannelRoles = await ownerDataSource.query(
      `SELECT id FROM core."agentChatChannelRole" WHERE "roleId"=$1`,
      [supportRoleId],
    );
    expect(remainingChannelRoles).toHaveLength(0);

    // Unused agent-only role with a residual agentChatChannelRole row is cleaned up and audited
    const agentOnlyRoleId = randomUUID().toLowerCase();
    const agentOnlyRoleUniversalId = randomUUID().toLowerCase();
    const agentRoleTargetId = randomUUID().toLowerCase();
    const residualChannelRoleId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core.role (
         id, "workspaceId", "applicationId", "universalIdentifier",
         label, "isEditable", "canBeAssignedToUsers", "canBeAssignedToAgents", "canBeAssignedToApiKeys"
       ) VALUES ($1, $2, $3, $4, 'Agent Only Role', true, false, true, false)`,
      [
        agentOnlyRoleId,
        workspaceId,
        customApplicationId,
        agentOnlyRoleUniversalId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."roleTarget" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "roleId", "agentId"
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        agentRoleTargetId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        agentOnlyRoleId,
        agentId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core."agentChatChannelRole" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "channelId", "roleId"
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        residualChannelRoleId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        createdChannel.id,
        agentOnlyRoleId,
      ],
    );

    const aiAgentRoleService = new AiAgentRoleService(
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: agentOnlyRoleId,
          universalIdentifier: agentOnlyRoleUniversalId,
          isEditable: true,
          canBeAssignedToAgents: true,
          canBeAssignedToUsers: false,
          canBeAssignedToApiKeys: false,
        }),
      } as never,
      {
        count: jest.fn().mockResolvedValue(0),
      } as never,
      {} as never,
      workspaceCacheService as never,
      runtimeDataSource,
    );

    await aiAgentRoleService.deleteAgentOnlyRoleIfUnused({
      roleId: agentOnlyRoleId,
      roleTargetId: agentRoleTargetId,
      workspaceId,
      auditIdentity: {
        auth: {
          workspace: { id: workspaceId },
          type: 'user',
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });

    const audits = await ownerDataSource.query(
      `SELECT "operationId","resourceKind","resourceId",action,"redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    const supportChannelRoleDelete = audits.find(
      (r: any) =>
        r.resourceKind === 'agentChatChannelRole' &&
        r.resourceId === supportChannelRole.id &&
        r.action === 'delete',
    );
    const supportRoleDelete = audits.find(
      (r: any) =>
        r.resourceKind === 'role' &&
        r.resourceId === supportRoleId &&
        r.action === 'delete',
    );
    expect(supportChannelRoleDelete).toBeDefined();
    expect(supportRoleDelete).toBeDefined();
    expect(supportChannelRoleDelete.operationId).toBe(
      supportRoleDelete.operationId,
    );

    const residualChannelRoleDelete = audits.find(
      (r: any) =>
        r.resourceKind === 'agentChatChannelRole' &&
        r.resourceId === residualChannelRoleId &&
        r.action === 'delete',
    );
    const agentRoleDelete = audits.find(
      (r: any) =>
        r.resourceKind === 'role' &&
        r.resourceId === agentOnlyRoleId &&
        r.action === 'delete',
    );
    expect(residualChannelRoleDelete).toBeDefined();
    expect(agentRoleDelete).toBeDefined();
    expect(residualChannelRoleDelete.operationId).toBe(
      agentRoleDelete.operationId,
    );
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining([
        'flatRoleMaps',
        'flatAgentChatChannelRoleMaps',
        'flatAgentChatChannelMaps',
      ]),
    );
  });

  it('audits application manifest sync, system build fallback, and assertNoRemainingApplicationRoleOrPermissionMetadata for channels and channel roles', async () => {
    const { runnerService, flatApplicationMaps } = buildHarness();

    const appChannelId = randomUUID().toLowerCase();
    const appChannelUniversalId = randomUUID().toLowerCase();
    const appRoleId = randomUUID().toLowerCase();
    const appRoleUniversalId = randomUUID().toLowerCase();
    const appChannelRoleId = randomUUID().toLowerCase();
    const appChannelRoleUniversalId = randomUUID().toLowerCase();

    // 1. Create role, channel, and channelRole via withApplicationMetadataAudit
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
                metadataName: 'role',
                id: appRoleId,
                flatEntity: {
                  id: appRoleId,
                  universalIdentifier: appRoleUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  label: 'App Channel Role',
                  description: null,
                  icon: 'IconKey',
                  isEditable: true,
                  canUpdateAllSettings: false,
                  canAccessAllTools: true,
                  canAccessAllAgentChatChannels: false,
                  canReadAllObjectRecords: true,
                  canUpdateAllObjectRecords: true,
                  canSoftDeleteAllObjectRecords: true,
                  canDestroyAllObjectRecords: true,
                  canBeAssignedToUsers: true,
                  canBeAssignedToAgents: true,
                  canBeAssignedToApiKeys: true,
                },
              },
              {
                type: 'create',
                metadataName: 'agentChatChannel',
                id: appChannelId,
                flatEntity: {
                  id: appChannelId,
                  universalIdentifier: appChannelUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'App Shipped Channel',
                  icon: 'IconRobot',
                  color: 'purple',
                  position: 1,
                  isCustom: true,
                },
              },
              {
                type: 'create',
                metadataName: 'agentChatChannelRole',
                id: appChannelRoleId,
                flatEntity: {
                  id: appChannelRoleId,
                  universalIdentifier: appChannelRoleUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  channelUniversalIdentifier: appChannelUniversalId,
                  roleUniversalIdentifier: appRoleUniversalId,
                },
              },
            ],
          } as never,
        }),
    );

    // 2. assertNoRemainingApplicationRoleOrPermissionMetadata blocks deletion while channel/channelRole remain
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

    // 3. Reconcile and delete channel + role (which cascades agentChatChannelRole)
    const existingMaps = await buildMapsFromDb();
    const record: Record<string, any> = {
      role: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [appRoleUniversalId]:
            existingMaps.flatRoleMaps.byUniversalIdentifier[appRoleUniversalId],
        },
      },
      agentChatChannel: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [appChannelUniversalId]:
            existingMaps.flatAgentChatChannelMaps.byUniversalIdentifier[
              appChannelUniversalId
            ],
        },
      },
    };
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName: record,
      existingAllFlatEntityMaps: existingMaps,
    });
    expect(
      Object.keys(record.agentChatChannelRole?.flatEntityToDelete ?? {}),
    ).toEqual([appChannelRoleUniversalId]);

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
                metadataName: 'agentChatChannelRole',
                universalIdentifier: appChannelRoleUniversalId,
              },
              {
                type: 'delete',
                metadataName: 'agentChatChannel',
                universalIdentifier: appChannelUniversalId,
              },
              {
                type: 'delete',
                metadataName: 'role',
                universalIdentifier: appRoleUniversalId,
              },
            ],
          } as never,
        }),
    );

    const runnerAfter = runtimeDataSource.createQueryRunner();
    await runnerAfter.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          runnerAfter,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await runnerAfter.release();
    }

    // 4. Legacy system build (AddAgentChatChannelsCommand pattern) auto-wraps in system application metadata audit
    const standardChannelId = randomUUID().toLowerCase();
    const standardChannelUniversalId = randomUUID().toLowerCase();
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
                  metadataName: 'agentChatChannel',
                  id: standardChannelId,
                  flatEntity: {
                    id: standardChannelId,
                    universalIdentifier: standardChannelUniversalId,
                    applicationUniversalIdentifier:
                      STANDARD_APPLICATION_UNIVERSAL_ID,
                    name: 'General',
                    icon: null,
                    color: null,
                    position: 0,
                    isCustom: false,
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

    const legacyResult =
      await validateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
        {
          workspaceId,
          isSystemBuild: true,
          applicationUniversalIdentifier: STANDARD_APPLICATION_UNIVERSAL_ID,
          allFlatEntityOperationByMetadataName: {
            agentChatChannel: {
              flatEntityToCreate: [
                {
                  id: standardChannelId,
                  universalIdentifier: standardChannelUniversalId,
                  applicationUniversalIdentifier:
                    STANDARD_APPLICATION_UNIVERSAL_ID,
                  name: 'General',
                  icon: null,
                  color: null,
                  position: 0,
                  isCustom: false,
                } as never,
              ],
              flatEntityToUpdate: [],
              flatEntityToDelete: [],
            },
          },
        },
      );
    expect(legacyResult.status).toBe('success');

    // 5. Updating a standard channel (owned by twenty-standard) and updating roleIds when scalar fields are unchanged both succeed and audit
    const { channelMetadataService } = buildHarness();
    const renamedStandard = await channelMetadataService.updateChannel({
      workspaceId,
      channelId: standardChannelId,
      changes: {
        name: 'General Renamed',
        icon: 'IconHash',
      },
      roleIds: [supportRoleId],
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    expect(renamedStandard.name).toBe('General Renamed');
    expect(renamedStandard.roleIds).toEqual([supportRoleId]);

    // Passing unchanged scalar fields alongside a changed roleIds list updates only agentChatChannelRole without throwing
    const roleChangedOnly = await channelMetadataService.updateChannel({
      workspaceId,
      channelId: standardChannelId,
      changes: {
        name: 'General Renamed',
        icon: 'IconHash',
      },
      roleIds: [salesRoleId],
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });
    expect(roleChangedOnly.roleIds).toEqual([salesRoleId]);

    const audits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action,actor,"redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(
      audits.find(
        (r: any) =>
          r.resourceKind === 'agentChatChannel' &&
          r.resourceId === standardChannelId &&
          r.action === 'create',
      ),
    ).toMatchObject({
      actor: { kind: 'system', id: 'workspace-migration:system-build' },
      redactedDiff: {
        values: {
          isCustom: { before: null, after: false },
        },
      },
    });
  });

  it('enforces fail-closed invariants, rolls back on audit failure, and enqueues grant rewrites on NativeTransactionOutcomeUnknownError', async () => {
    const {
      runnerService,
      channelMetadataService,
      channelService,
      enqueueChannelGrantsRewriteMock,
      invalidateCacheMock,
    } = buildHarness();

    // 1. Unaudited runner execution touching agentChatChannel or agentChatChannelRole is rejected
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'agentChatChannel',
              id: randomUUID().toLowerCase(),
              flatEntity: {
                universalIdentifier: randomUUID().toLowerCase(),
                applicationUniversalIdentifier: customApplicationUniversalId,
                name: 'Unaudited Channel',
                icon: null,
                color: null,
                position: 0,
                isCustom: true,
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
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'agentChatChannelRole',
              universalIdentifier: randomUUID().toLowerCase(),
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. agentChatChannelRole update is rejected fail-closed in CrmAuditTransactionContext and migration runner
    await expect(
      withNavigationMenuItemAudit(
        captureNavigationMenuItemAudit({
          workspaceId,
          mode: 'channel',
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
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
                  metadataName: 'agentChatChannelRole',
                  universalIdentifier: randomUUID().toLowerCase(),
                  update: {},
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow('Agent chat channel role update is unsupported');

    // 3. Audit INSERT failure rolls back channel and channelRole creation atomically
    const flushSpy = jest
      .spyOn(CrmAuditTransactionContext.prototype, 'flush')
      .mockRejectedValueOnce(new Error('Simulated audit storage failure'));

    await expect(
      channelMetadataService.createChannel({
        workspaceId,
        name: 'Rolled Back Channel',
        icon: null,
        color: null,
        roleIds: [supportRoleId],
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      }),
    ).rejects.toThrow('Simulated audit storage failure');
    flushSpy.mockRestore();

    const rolledBackChannels = await ownerDataSource.query(
      `SELECT id FROM core."agentChatChannel" WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(rolledBackChannels).toHaveLength(0);

    // 4. NativeTransactionOutcomeUnknownError / CoreAuditPostCommitError during updateChannel with roleIds enqueues grant rewrite
    const liveChannel = await channelMetadataService.createChannel({
      workspaceId,
      name: 'Resilient Channel',
      icon: null,
      color: null,
      roleIds: [supportRoleId],
      authUserWorkspaceId: ownerUserWorkspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
    });

    const postCommitSpy = jest
      .spyOn(channelMetadataService, 'updateChannel')
      .mockRejectedValueOnce(
        new NativeTransactionOutcomeUnknownError(
          'commit',
          new Error('Lost ACK'),
        ),
      );

    await expect(
      channelService.updateChannel({
        workspaceId,
        channelId: liveChannel.id,
        changes: {
          name: 'Updated After Lost Commit',
          roleIds: [salesRoleId],
        },
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      }),
    ).rejects.toThrow(NativeTransactionOutcomeUnknownError);
    postCommitSpy.mockRestore();

    expect(enqueueChannelGrantsRewriteMock).toHaveBeenCalledWith({
      workspaceId,
      channelId: liveChannel.id,
    });

    const coreAuditPostCommitSpy = jest
      .spyOn(channelMetadataService, 'updateChannel')
      .mockRejectedValueOnce(
        new CoreAuditPostCommitError('Post-commit failure'),
      );

    await expect(
      channelService.updateChannel({
        workspaceId,
        channelId: liveChannel.id,
        changes: {
          roleIds: [salesRoleId],
        },
        authUserWorkspaceId: ownerUserWorkspaceId,
        auditIdentity: {
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      }),
    ).rejects.toThrow(CoreAuditPostCommitError);
    coreAuditPostCommitSpy.mockRestore();

    expect(invalidateCacheMock).toHaveBeenCalled();

    // 5. Concurrent agentChatChannelRole inserted before deleteChannel lock is rejected fail-closed
    const concurrentRoleLinkId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."agentChatChannelRole" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         "channelId", "roleId"
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        concurrentRoleLinkId,
        workspaceId,
        customApplicationId,
        randomUUID().toLowerCase(),
        liveChannel.id,
        salesRoleId,
      ],
    );

    await expect(
      withNavigationMenuItemAudit(
        captureNavigationMenuItemAudit({
          workspaceId,
          mode: 'channel',
          expectedParentChannelDeleteIds: [liveChannel.id],
          expectedChannelRoleDeleteIds: [],
          expectedDeletedIds: [],
          auditIdentity: {
            user: { id: ownerUserId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        })(),
        () =>
          runnerService.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: customApplicationUniversalId,
              actions: [
                {
                  type: 'delete',
                  metadataName: 'agentChatChannel',
                  universalIdentifier: liveChannel.universalIdentifier,
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toThrow(
      'Agent chat channel delete audit persisted agentChatChannelRole set changed',
    );
  });
});
