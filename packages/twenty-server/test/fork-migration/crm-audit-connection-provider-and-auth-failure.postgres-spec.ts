import { randomUUID } from 'node:crypto';
import { ConnectedAccountProvider } from 'twenty-shared/types';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { ConnectionProviderExceptionCode } from 'src/engine/core-modules/application/connection-provider/connection-provider-exception-code.enum';
import { ConnectionProviderException } from 'src/engine/core-modules/application/connection-provider/connection-provider.exception';
import {
  captureOptionalApplicationDeleteAudit,
  runAuditedApplicationDelete,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';
import {
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/connection-provider/interceptors/connection-provider-graphql-api-exception.interceptor',
    ['ConnectionProviderGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/core-modules/application/connection-provider/connections/dtos/app-connection.object',
    ['AppConnectionObjectDto'],
  ],
  [
    'src/engine/core-modules/application/connection-provider/connections/dtos/list-app-connections.input',
    ['ListAppConnectionsInput'],
  ],
  [
    'src/engine/core-modules/application/connection-provider/connections/dtos/report-app-connection-auth-failure.input',
    ['ReportAppConnectionAuthFailureInput'],
  ],
  [
    'src/engine/core-modules/application/connection-provider/connections/services/application-connections-list.service',
    ['ApplicationConnectionsListService'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
    ['ConnectedAccountEntity'],
  ],
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
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
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
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { ApplicationConnectionAuthFailureService } =
  require('src/engine/core-modules/application/connection-provider/connections/services/application-connection-auth-failure.service') as typeof import('src/engine/core-modules/application/connection-provider/connections/services/application-connection-auth-failure.service');
const { ApplicationConnectionsResolver } =
  require('src/engine/core-modules/application/connection-provider/connections/application-connections.resolver') as typeof import('src/engine/core-modules/application/connection-provider/connections/application-connections.resolver');
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

const runtimeRole = `twenty_cp_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
const secondUserId = randomUUID().toLowerCase();
const secondUserWorkspaceId = randomUUID().toLowerCase();

const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();

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

describe('CRM audit connectionProvider lifecycle and app connection auth failure (LOG177)', () => {
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

      CREATE TABLE core."connectionProvider" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        "displayName" text NOT NULL,
        logo text,
        type text NOT NULL,
        scope text NOT NULL DEFAULT 'USER',
        "oauthConfig" jsonb,
        "identifyAccountLogicFunctionUniversalIdentifier" uuid,
        "onConnectLogicFunctionUniversalIdentifier" uuid,
        "onDisconnectLogicFunctionUniversalIdentifier" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE core."connectedAccount" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "userWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
        "applicationId" uuid REFERENCES core.application(id) ON DELETE CASCADE,
        "connectionProviderId" uuid REFERENCES core."connectionProvider"(id),
        handle text NOT NULL,
        provider text NOT NULL,
        scope text NOT NULL DEFAULT 'USER',
        "accessToken" text,
        "refreshToken" text,
        "connectionParameters" jsonb,
        "lastCredentialsRefreshedAt" timestamptz,
        "authFailedAt" timestamptz,
        "authFailedReason" text,
        "archivedAt" timestamptz,
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
        core."connectedAccount",
        core."connectionProvider",
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
         ($2, 'impersonator@example.com'),
         ($3, 'second@example.com')`,
      [ownerUserId, impersonatorUserId, secondUserId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId") VALUES
         ($1, $2, $3),
         ($4, $5, $3),
         ($6, $7, $3)`,
      [
        ownerUserWorkspaceId,
        ownerUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
        secondUserWorkspaceId,
        secondUserId,
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
  });

  const audits = async () =>
    ownerDataSource.query(
      'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, id ASC',
    );

  const buildHarness = () => {
    const appUniversalById: Record<string, string> = {
      [standardApplicationId]: STANDARD_APPLICATION_UNIVERSAL_ID,
      [customApplicationId]: customApplicationUniversalId,
      [thirdPartyApplicationId]: thirdPartyApplicationUniversalId,
    };

    const buildMapsFromDb = async () => {
      const cpRows = await ownerDataSource.query(
        `SELECT * FROM core."connectionProvider" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const flatConnectionProviderMaps = {
        byUniversalIdentifier: Object.fromEntries(
          cpRows.map((row: Record<string, unknown>) => [
            String(row.universalIdentifier).toLowerCase(),
            {
              id: String(row.id).toLowerCase(),
              workspaceId: String(row.workspaceId).toLowerCase(),
              applicationId: String(row.applicationId).toLowerCase(),
              universalIdentifier: String(
                row.universalIdentifier,
              ).toLowerCase(),
              applicationUniversalIdentifier:
                appUniversalById[String(row.applicationId).toLowerCase()] ??
                thirdPartyApplicationUniversalId,
              name: row.name,
              displayName: row.displayName,
              logo: row.logo ?? null,
              type: row.type,
              scope: row.scope,
              oauthConfig: row.oauthConfig ?? null,
              identifyAccountLogicFunctionUniversalIdentifier:
                row.identifyAccountLogicFunctionUniversalIdentifier ?? null,
              onConnectLogicFunctionUniversalIdentifier:
                row.onConnectLogicFunctionUniversalIdentifier ?? null,
              onDisconnectLogicFunctionUniversalIdentifier:
                row.onDisconnectLogicFunctionUniversalIdentifier ?? null,
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
          cpRows.map((row: Record<string, unknown>) => [
            String(row.universalIdentifier).toLowerCase(),
            String(row.id).toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          cpRows.map((row: Record<string, unknown>) => [
            String(row.id).toLowerCase(),
            String(row.universalIdentifier).toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      return {
        flatConnectionProviderMaps,
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
          action: {
            type: string;
            metadataName: string;
            id?: string;
            universalIdentifier?: string;
            flatEntity?: Record<string, unknown>;
            update?: Record<string, unknown>;
          };
          context: {
            queryRunner: QueryRunner;
            allFlatEntityMaps: {
              flatConnectionProviderMaps: {
                byUniversalIdentifier: Record<string, Record<string, unknown>>;
              };
            };
            flatApplication: { id: string; universalIdentifier: string };
          };
        }) => {
          const { queryRunner, allFlatEntityMaps, flatApplication } = context;
          if (action.metadataName === 'connectionProvider') {
            if (action.type === 'create') {
              const fe = action.flatEntity!;
              const id = String(
                action.id ?? fe.id ?? randomUUID(),
              ).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core."connectionProvider" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, "displayName", logo, type, scope, "oauthConfig",
                   "identifyAccountLogicFunctionUniversalIdentifier",
                   "onConnectLogicFunctionUniversalIdentifier",
                   "onDisconnectLogicFunctionUniversalIdentifier"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.displayName,
                  fe.logo ?? null,
                  fe.type ?? 'oauth',
                  fe.scope ?? 'USER',
                  fe.oauthConfig ? JSON.stringify(fe.oauthConfig) : null,
                  fe.identifyAccountLogicFunctionUniversalIdentifier ?? null,
                  fe.onConnectLogicFunctionUniversalIdentifier ?? null,
                  fe.onDisconnectLogicFunctionUniversalIdentifier ?? null,
                ],
              );
              allFlatEntityMaps.flatConnectionProviderMaps.byUniversalIdentifier[
                String(fe.universalIdentifier).toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatConnectionProviderMaps
                  ?.byUniversalIdentifier[
                  String(action.universalIdentifier).toLowerCase()
                ];
              const upd = action.update ?? {};
              const nextOauthConfig =
                'oauthConfig' in upd ? upd.oauthConfig : existing.oauthConfig;
              await queryRunner.query(
                `UPDATE core."connectionProvider"
                 SET name=$1, "displayName"=$2, logo=$3, type=$4, scope=$5, "oauthConfig"=$6,
                     "identifyAccountLogicFunctionUniversalIdentifier"=$7,
                     "onConnectLogicFunctionUniversalIdentifier"=$8,
                     "onDisconnectLogicFunctionUniversalIdentifier"=$9,
                     "updatedAt"=now()
                 WHERE id=$10 AND "workspaceId"=$11`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'displayName' in upd ? upd.displayName : existing.displayName,
                  'logo' in upd ? upd.logo : existing.logo,
                  'type' in upd ? upd.type : existing.type,
                  'scope' in upd ? upd.scope : existing.scope,
                  nextOauthConfig ? JSON.stringify(nextOauthConfig) : null,
                  'identifyAccountLogicFunctionUniversalIdentifier' in upd
                    ? upd.identifyAccountLogicFunctionUniversalIdentifier
                    : existing.identifyAccountLogicFunctionUniversalIdentifier,
                  'onConnectLogicFunctionUniversalIdentifier' in upd
                    ? upd.onConnectLogicFunctionUniversalIdentifier
                    : existing.onConnectLogicFunctionUniversalIdentifier,
                  'onDisconnectLogicFunctionUniversalIdentifier' in upd
                    ? upd.onDisconnectLogicFunctionUniversalIdentifier
                    : existing.onDisconnectLogicFunctionUniversalIdentifier,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatConnectionProviderMaps
                  ?.byUniversalIdentifier[
                  String(action.universalIdentifier).toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."connectionProvider" WHERE id=$1 AND "workspaceId"=$2`,
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
        throwIfSchemaAffectingActionsAreInProgress: jest
          .fn()
          .mockResolvedValue(undefined),
      } as never,
    );

    const connectedAccountRepositoryMock = {
      manager: { connection: runtimeDataSource },
      findOne: jest
        .fn()
        .mockImplementation(
          async ({ where }: { where: Record<string, unknown> }) => {
            const [row] = await runtimeDataSource.query(
              `SELECT * FROM core."connectedAccount"
               WHERE id=$1 AND "applicationId"=$2 AND "workspaceId"=$3 AND LOWER(provider)=LOWER($4) AND "archivedAt" IS NULL`,
              [
                where.id,
                where.applicationId,
                where.workspaceId,
                where.provider ?? 'app',
              ],
            );
            return row ?? null;
          },
        ),
    };

    const authFailureService = new ApplicationConnectionAuthFailureService(
      connectedAccountRepositoryMock as never,
      runtimeDataSource,
    );
    const applicationConnectionsResolver = new ApplicationConnectionsResolver(
      {} as never,
      authFailureService,
    );

    return {
      runnerService,
      authFailureService,
      applicationConnectionsResolver,
      connectedAccountRepositoryMock,
    };
  };

  it('audits connectionProvider create, idempotent no-op, update, connectedAccount deletion guard, applicationDelete barrier, and delete', async () => {
    const { runnerService } = buildHarness();
    const providerId = randomUUID().toLowerCase();
    const providerUniversalId = randomUUID().toLowerCase();
    const onConnectHookUniversalId = randomUUID().toLowerCase();

    const oauthConfigV1 = {
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      revokeEndpoint: null,
      scopes: ['chat:write'],
      clientIdVariable: 'SLACK_CLIENT_ID',
      clientSecretVariable: 'SLACK_CLIENT_SECRET',
      authorizationParams: null,
      tokenRequestContentType: 'json',
      usePkce: true,
    };

    // 1. Fail-closed barrier rejects unaudited connectionProvider migration
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'connectionProvider',
              id: providerId,
              flatEntity: {
                universalIdentifier: providerUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'slack',
                displayName: 'Slack OAuth',
                logo: null,
                type: 'oauth',
                scope: 'USER',
                oauthConfig: oauthConfigV1,
                identifyAccountLogicFunctionUniversalIdentifier: null,
                onConnectLogicFunctionUniversalIdentifier: null,
                onDisconnectLogicFunctionUniversalIdentifier: null,
              },
            } as never,
          ],
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );
    expect(await audits()).toHaveLength(0);

    const runWithAudit = <TResult>(work: () => Promise<TResult>) => {
      const captured = captureApplicationMetadataAuditOperation({
        workspaceId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: workspaceId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
          impersonatorUserWorkspaceId,
        },
      });
      return withApplicationMetadataAudit(
        bindApplicationMetadataAuditOperation(captured, {
          applicationId: thirdPartyApplicationId,
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
        }),
        work,
      );
    };

    // 2. Create connectionProvider -> connectionProvider:create with redacted oauthConfig/name/displayName
    await runWithAudit(() =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'connectionProvider',
              id: providerId,
              flatEntity: {
                universalIdentifier: providerUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'slack',
                displayName: 'Slack OAuth',
                logo: 'https://slack.com/logo.svg',
                type: 'oauth',
                scope: 'USER',
                oauthConfig: oauthConfigV1,
                identifyAccountLogicFunctionUniversalIdentifier: null,
                onConnectLogicFunctionUniversalIdentifier: null,
                onDisconnectLogicFunctionUniversalIdentifier: null,
              },
            } as never,
          ],
        },
      }),
    );

    // 3. No-op update produces 0 new audit entries
    await runWithAudit(() =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'update',
              metadataName: 'connectionProvider',
              universalIdentifier: providerUniversalId,
              update: {
                displayName: 'Slack OAuth',
                scope: 'USER',
              },
            } as never,
          ],
        },
      }),
    );
    expect(await audits()).toHaveLength(1);

    // 4. Update scope (USER -> WORKSPACE), displayName, oauthConfig, and onConnect hook
    const oauthConfigV2 = {
      ...oauthConfigV1,
      scopes: ['chat:write', 'channels:read'],
    };
    await runWithAudit(() =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'update',
              metadataName: 'connectionProvider',
              universalIdentifier: providerUniversalId,
              update: {
                displayName: 'Slack Workspace OAuth',
                scope: 'WORKSPACE',
                oauthConfig: oauthConfigV2,
                onConnectLogicFunctionUniversalIdentifier:
                  onConnectHookUniversalId,
              },
            } as never,
          ],
        },
      }),
    );

    // 5. Application delete barrier blocks silent ON DELETE CASCADE while connectionProvider exists
    const deleteAudit = captureOptionalApplicationDeleteAudit({
      workspaceId,
      auditIdentity: {
        auth: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
      },
    });
    await expect(
      runAuditedApplicationDelete(runtimeDataSource, deleteAudit, {
        applicationId: thirdPartyApplicationId,
        work: async () => undefined,
      }),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // 6. Deleting connectionProvider while connectedAccount still references it is rejected
    const linkedAccountId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."connectedAccount" (
         id, "workspaceId", "userWorkspaceId", "applicationId", "connectionProviderId",
         handle, provider, scope
       ) VALUES ($1,$2,$3,$4,$5,'slack-bot','APP','WORKSPACE')`,
      [
        linkedAccountId,
        workspaceId,
        ownerUserWorkspaceId,
        thirdPartyApplicationId,
        providerId,
      ],
    );
    await expect(
      runWithAudit(() =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName: 'connectionProvider',
                universalIdentifier: providerUniversalId,
              } as never,
            ],
          },
        }),
      ),
    ).rejects.toThrow(
      'Connection provider still has connected accounts; audited cleanup must run first',
    );
    await ownerDataSource.query(
      `DELETE FROM core."connectedAccount" WHERE id=$1`,
      [linkedAccountId],
    );

    // 7. Audited deletion of connectionProvider succeeds after connectedAccount cleanup
    await runWithAudit(() =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'connectionProvider',
              universalIdentifier: providerUniversalId,
            } as never,
          ],
        },
      }),
    );

    const entries = await audits();
    expect(entries).toHaveLength(3);

    expect(entries[0]).toMatchObject({
      workspaceId,
      resourceKind: 'connectionProvider',
      resourceId: providerId,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'displayName',
          'identifyAccountLogicFunctionUniversalIdentifier',
          'logo',
          'name',
          'oauthConfig',
          'onConnectLogicFunctionUniversalIdentifier',
          'onDisconnectLogicFunctionUniversalIdentifier',
          'scope',
          'type',
        ],
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          type: { before: null, after: 'oauth' },
          scope: { before: null, after: 'USER' },
        },
      },
    });
    expect(entries[0].redactedDiff.values.oauthConfig).toBeUndefined();
    expect(entries[0].redactedDiff.values.name).toBeUndefined();

    expect(entries[1]).toMatchObject({
      workspaceId,
      resourceKind: 'connectionProvider',
      resourceId: providerId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: [
          'displayName',
          'oauthConfig',
          'onConnectLogicFunctionUniversalIdentifier',
          'scope',
        ],
        values: {
          scope: { before: 'USER', after: 'WORKSPACE' },
        },
      },
    });

    expect(entries[2]).toMatchObject({
      workspaceId,
      resourceKind: 'connectionProvider',
      resourceId: providerId,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'displayName',
          'identifyAccountLogicFunctionUniversalIdentifier',
          'logo',
          'name',
          'oauthConfig',
          'onConnectLogicFunctionUniversalIdentifier',
          'onDisconnectLogicFunctionUniversalIdentifier',
          'scope',
          'type',
        ],
        values: {
          applicationId: { before: thirdPartyApplicationId, after: null },
          type: { before: 'oauth', after: null },
          scope: { before: 'WORKSPACE', after: null },
        },
      },
    });
  });

  it('audits reportAppConnectionAuthFailure on WORKSPACE and USER connections, drops superseded reports, and enforces access boundaries', async () => {
    const {
      authFailureService,
      applicationConnectionsResolver,
      connectedAccountRepositoryMock,
    } = buildHarness();

    const providerId = randomUUID().toLowerCase();
    const workspaceConnId = randomUUID().toLowerCase();
    const userConnId = randomUUID().toLowerCase();
    const foreignUserConnId = randomUUID().toLowerCase();
    const foreignAppConnId = randomUUID().toLowerCase();
    const initialRefreshedAt = new Date('2026-11-09T05:00:00.000Z');

    await ownerDataSource.query(
      `INSERT INTO core."connectionProvider" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         name, "displayName", type, scope
       ) VALUES ($1,$2,$3,$4,'slack','Slack','oauth','WORKSPACE')`,
      [
        providerId,
        workspaceId,
        thirdPartyApplicationId,
        randomUUID().toLowerCase(),
      ],
    );

    await ownerDataSource.query(
      `INSERT INTO core."connectedAccount" (
         id, "workspaceId", "userWorkspaceId", "applicationId", "connectionProviderId",
         handle, provider, scope, "accessToken", "refreshToken", "lastCredentialsRefreshedAt"
       ) VALUES
         ($1,$2,$3,$4,$5,'ws-bot','APP','WORKSPACE','enc-access','enc-refresh',$6),
         ($7,$2,$3,$4,$5,'owner-bot','APP','USER','enc-access',NULL,$6),
         ($8,$2,$9,$4,$5,'second-bot','APP','USER','enc-access',NULL,$6),
         ($10,$2,$3,$11,$5,'other-app-bot','APP','WORKSPACE','enc-access',NULL,$6)`,
      [
        workspaceConnId,
        workspaceId,
        ownerUserWorkspaceId,
        thirdPartyApplicationId,
        providerId,
        initialRefreshedAt,
        userConnId,
        foreignUserConnId,
        secondUserWorkspaceId,
        foreignAppConnId,
        customApplicationId,
      ],
    );

    // 1. Report auth failure with reason via ApplicationConnectionsResolver on WORKSPACE connection
    const ok =
      await applicationConnectionsResolver.reportAppConnectionAuthFailure(
        { id: thirdPartyApplicationId } as never,
        { id: workspaceId } as never,
        ownerUserWorkspaceId,
        {
          id: workspaceConnId,
          reason: 'Slack rejected the stored token (invalid_auth)',
        } as never,
      );
    expect(ok).toBe(true);

    // 2. Report auth failure without reason on own USER-scoped connection
    await applicationConnectionsResolver.reportAppConnectionAuthFailure(
      { id: thirdPartyApplicationId } as never,
      { id: workspaceId } as never,
      ownerUserWorkspaceId,
      {
        id: userConnId,
      } as never,
    );

    // 3. Refuses another user's USER-scoped connection, another app's connection, and unknown connection
    await expect(
      applicationConnectionsResolver.reportAppConnectionAuthFailure(
        { id: thirdPartyApplicationId } as never,
        { id: workspaceId } as never,
        ownerUserWorkspaceId,
        {
          id: foreignUserConnId,
          reason: 'Should fail',
        } as never,
      ),
    ).rejects.toMatchObject({
      code: ConnectionProviderExceptionCode.CONNECTION_NOT_FOUND,
    });

    await expect(
      applicationConnectionsResolver.reportAppConnectionAuthFailure(
        { id: thirdPartyApplicationId } as never,
        { id: workspaceId } as never,
        ownerUserWorkspaceId,
        {
          id: foreignAppConnId,
          reason: 'Should fail',
        } as never,
      ),
    ).rejects.toBeInstanceOf(ConnectionProviderException);

    await expect(
      applicationConnectionsResolver.reportAppConnectionAuthFailure(
        { id: thirdPartyApplicationId } as never,
        { id: workspaceId } as never,
        ownerUserWorkspaceId,
        {
          id: randomUUID().toLowerCase(),
          reason: 'Should fail',
        } as never,
      ),
    ).rejects.toBeInstanceOf(ConnectionProviderException);

    // 4. Superseded report when a concurrent reconnect updated lastCredentialsRefreshedAt after pre-read
    connectedAccountRepositoryMock.findOne.mockImplementationOnce(async () => ({
      id: workspaceConnId,
      workspaceId,
      applicationId: thirdPartyApplicationId,
      provider: ConnectedAccountProvider.APP,
      scope: 'WORKSPACE',
      userWorkspaceId: ownerUserWorkspaceId,
      archivedAt: null,
      lastCredentialsRefreshedAt: new Date('2026-11-09T04:00:00.000Z'),
    }));
    await authFailureService.reportAuthFailureOrThrow({
      applicationId: thirdPartyApplicationId,
      workspaceId,
      requestUserWorkspaceId: ownerUserWorkspaceId,
      id: workspaceConnId,
      reason: 'Stale report from old credential',
    });

    const [wsConnAfter] = await ownerDataSource.query(
      `SELECT "authFailedReason" FROM core."connectedAccount" WHERE id=$1`,
      [workspaceConnId],
    );
    expect(wsConnAfter.authFailedReason).toBe(
      'Slack rejected the stored token (invalid_auth)',
    );

    const entries = await audits();
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({
      workspaceId,
      resourceKind: 'connectedAccount',
      resourceId: workspaceConnId,
      action: 'update',
      actor: { kind: 'application', id: thirdPartyApplicationId },
      redactedDiff: {
        changedFields: ['authFailedAt', 'authFailedReason'],
        values: {},
      },
    });
    expect(entries[0].redactedDiff.values.authFailedReason).toBeUndefined();

    expect(entries[1]).toMatchObject({
      workspaceId,
      resourceKind: 'connectedAccount',
      resourceId: userConnId,
      action: 'update',
      actor: { kind: 'application', id: thirdPartyApplicationId },
      redactedDiff: {
        changedFields: ['authFailedAt'],
        values: {},
      },
    });
  });

  it('rolls back on post-flush trigger corruption and propagates NativeTransactionOutcomeUnknownError without ROLLBACK when COMMIT acknowledgement is lost', async () => {
    const { runnerService, authFailureService } = buildHarness();
    const providerId = randomUUID().toLowerCase();
    const providerUniversalId = randomUUID().toLowerCase();
    const connId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."connectedAccount" (
         id, "workspaceId", "userWorkspaceId", "applicationId",
         handle, provider, scope
       ) VALUES ($1,$2,$3,$4,'bot','APP','WORKSPACE')`,
      [connId, workspaceId, ownerUserWorkspaceId, thirdPartyApplicationId],
    );

    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_cp_on_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'connectionProvider' THEN
          UPDATE core."connectionProvider" SET scope = 'WORKSPACE' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_cp_on_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_cp_on_audit_insert();
    `);

    try {
      const captured = captureApplicationMetadataAuditOperation({
        workspaceId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: workspaceId },
            workspaceMemberId: ownerWorkspaceMemberId,
          },
        },
      });
      await expect(
        withApplicationMetadataAudit(
          bindApplicationMetadataAuditOperation(captured, {
            applicationId: thirdPartyApplicationId,
            applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          }),
          () =>
            runnerService.run({
              workspaceId,
              workspaceMigration: {
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                actions: [
                  {
                    type: 'create',
                    metadataName: 'connectionProvider',
                    id: providerId,
                    flatEntity: {
                      universalIdentifier: providerUniversalId,
                      applicationUniversalIdentifier:
                        thirdPartyApplicationUniversalId,
                      name: 'slack',
                      displayName: 'Slack',
                      type: 'oauth',
                      scope: 'USER',
                      oauthConfig: null,
                    },
                  } as never,
                ],
              },
            }),
        ),
      ).rejects.toThrow(
        'Application metadata state changed during audit flush',
      );

      expect(
        await ownerDataSource.query(
          'SELECT id FROM core."connectionProvider" WHERE "workspaceId"=$1',
          [workspaceId],
        ),
      ).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    } finally {
      await ownerDataSource.query(
        'DROP TRIGGER IF EXISTS trg_corrupt_cp_on_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS core.corrupt_cp_on_audit_insert();',
      );
    }

    // Simulate COMMIT acknowledgement loss on reportAuthFailureOrThrow
    const statements: string[] = [];
    const origCreateQueryRunner =
      runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementationOnce((mode?: 'master' | 'slave') => {
        const runner = origCreateQueryRunner(mode);
        const origConnect = runner.connect.bind(runner);
        jest.spyOn(runner, 'connect').mockImplementationOnce(async () => {
          const client = await origConnect();
          const origClientQuery = client.query.bind(client);
          const querySpy = jest
            .spyOn(client, 'query')
            .mockImplementation((...args: unknown[]) => {
              if (typeof args[0] === 'string') {
                statements.push(args[0]);
              }
              if (args[0] === 'COMMIT') {
                querySpy.mockRestore();
                return Promise.reject(
                  new Error('simulated socket hang up after COMMIT'),
                );
              }
              return (origClientQuery as (...a: unknown[]) => unknown)(...args);
            });
          return client;
        });
        return runner;
      });

    await expect(
      authFailureService.reportAuthFailureOrThrow({
        applicationId: thirdPartyApplicationId,
        workspaceId,
        requestUserWorkspaceId: ownerUserWorkspaceId,
        id: connId,
        reason: 'token_revoked',
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements.some((sql) => /^ROLLBACK\b/i.test(sql.trim()))).toBe(
      false,
    );
  });
});
