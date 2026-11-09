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
import { SkillExceptionCode } from 'src/engine/metadata-modules/skill/skill.exception';
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
    'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
    ['ApplicationTranslationCatalogService'],
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
    'src/engine/metadata-modules/skill/interceptors/skill-graphql-api-exception.interceptor',
    ['SkillGraphqlApiExceptionInterceptor'],
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
    'src/engine/decorators/auth/application-target-arg.decorator',
    ['ApplicationTargetArg'],
  ],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
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

const { SkillService } =
  require('src/engine/metadata-modules/skill/skill.service') as typeof import('src/engine/metadata-modules/skill/skill.service');
const { SkillResolver } =
  require('src/engine/metadata-modules/skill/skill.resolver') as typeof import('src/engine/metadata-modules/skill/skill.resolver');
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

const runtimeRole = `twenty_sk_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

describe('CRM audit skill lifecycle and application cascade', () => {
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

      CREATE TABLE core.skill (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        label text NOT NULL,
        icon text,
        description text,
        content text NOT NULL,
        "isCustom" boolean NOT NULL DEFAULT false,
        "isSystem" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
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
        core.skill,
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

    const buildMapsFromDb = async () => {
      const skillRows = await ownerDataSource.query(
        `SELECT * FROM core.skill WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const flatSkillMaps = {
        byUniversalIdentifier: Object.fromEntries(
          skillRows.map((row: Record<string, any>) => [
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
              label: row.label,
              icon: row.icon ?? null,
              description: row.description ?? null,
              content: row.content,
              isCustom: Boolean(row.isCustom),
              isSystem: Boolean(row.isSystem),
              isActive: Boolean(row.isActive),
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
          skillRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          skillRows.map((row: Record<string, any>) => [
            row.id.toLowerCase(),
            row.universalIdentifier.toLowerCase(),
          ]),
        ),
        universalIdentifiersByApplicationId: {},
      };

      return {
        flatSkillMaps,
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
          if (action.metadataName === 'skill') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core.skill (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, label, icon, description, content,
                   "isCustom", "isSystem", "isActive"
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.label,
                  fe.icon ?? null,
                  fe.description ?? null,
                  fe.content,
                  Boolean(fe.isCustom),
                  Boolean(fe.isSystem),
                  fe.isActive !== undefined ? Boolean(fe.isActive) : true,
                ],
              );
              allFlatEntityMaps.flatSkillMaps.byUniversalIdentifier[
                fe.universalIdentifier
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatSkillMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              const upd = action.update ?? {};
              await queryRunner.query(
                `UPDATE core.skill
                 SET name=$1, label=$2, icon=$3, description=$4, content=$5,
                     "isCustom"=$6, "isSystem"=$7, "isActive"=$8, "updatedAt"=now()
                 WHERE id=$9 AND "workspaceId"=$10`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'label' in upd ? upd.label : existing.label,
                  'icon' in upd ? upd.icon : existing.icon,
                  'description' in upd ? upd.description : existing.description,
                  'content' in upd ? upd.content : existing.content,
                  'isCustom' in upd ? upd.isCustom : existing.isCustom,
                  'isSystem' in upd ? upd.isSystem : existing.isSystem,
                  'isActive' in upd ? upd.isActive : existing.isActive,
                  existing.id,
                  workspaceId,
                ],
              );
            } else if (action.type === 'delete') {
              const existing =
                allFlatEntityMaps.flatSkillMaps?.byUniversalIdentifier[
                  action.universalIdentifier
                ];
              await queryRunner.query(
                `DELETE FROM core.skill WHERE id=$1 AND "workspaceId"=$2`,
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
            currentMaps.flatSkillMaps?.byUniversalIdentifier[
              fe.universalIdentifier
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'name',
            'label',
            'icon',
            'description',
            'content',
            'isActive',
            'isSystem',
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

    const skillService = new SkillService(
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      cacheService as never,
      applicationServiceMock as never,
    );
    const skillResolver = new SkillResolver(skillService, {} as never);

    return {
      runnerService,
      cacheService,
      workspaceCacheService,
      invalidateCacheMock,
      flatApplicationMaps,
      applicationServiceMock,
      validateBuildAndRunMock,
      skillService,
      skillResolver,
    };
  };

  it('audits skill create, update, no-op update, activate/deactivate (custom and standard), and delete via SkillResolver and SkillService with prompt redaction', async () => {
    const { skillResolver } = buildHarness();

    const standardSkillId = randomUUID().toLowerCase();
    const standardSkillUniversalId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core.skill (
         id, "workspaceId", "applicationId", "universalIdentifier",
         name, label, icon, description, content,
         "isCustom", "isSystem", "isActive"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,true)`,
      [
        standardSkillId,
        workspaceId,
        standardApplicationId,
        standardSkillUniversalId,
        'workflow-building',
        'Workflow Building',
        'IconSettingsAutomation',
        'Standard workflow skill',
        'Use standard workflow instructions',
      ],
    );

    // 1. Create custom skill via GraphQL resolver under impersonation
    const created = await skillResolver.createSkill(
      {
        name: '  triage-inbound-leads  ',
        label: '  Triage Inbound Leads  ',
        icon: 'IconRobot',
        description: 'Classify and route leads',
        content: '  Always check CRM token sk_live_secret_prompt_token_999  ',
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

    expect(created.name).toBe('triage-inbound-leads');
    expect(created.label).toBe('Triage Inbound Leads');
    expect(created.content).toBe(
      'Always check CRM token sk_live_secret_prompt_token_999',
    );
    expect(created.isCustom).toBe(true);
    expect(created.isSystem).toBe(false);
    expect(created.isActive).toBe(true);

    // 2. Update custom skill via GraphQL resolver authenticated by apiKey
    const updated = await skillResolver.updateSkill(
      {
        id: created.id,
        name: 'triage-enterprise-leads',
        label: 'Triage Enterprise Leads',
        icon: 'IconSparkles',
        description: 'Updated lead routing instructions',
        content: 'Updated prompt content sk_live_rotated_token_888',
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
    expect(updated.name).toBe('triage-enterprise-leads');
    expect(updated.content).toBe(
      'Updated prompt content sk_live_rotated_token_888',
    );

    // 3. No-op update produces 0 additional audit entries
    const countBeforeNoOp = (
      await ownerDataSource.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1`,
        [workspaceId],
      )
    ).length;
    await skillResolver.updateSkill(
      {
        id: created.id,
        name: 'triage-enterprise-leads',
        content: 'Updated prompt content sk_live_rotated_token_888',
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

    // 4. Deactivate and re-activate standard skill under application principal
    const deactivatedStandard = await skillResolver.deactivateSkill(
      standardSkillId,
      { id: workspaceId } as never,
      undefined,
      undefined,
      {
        req: {
          application: { id: thirdPartyApplicationId },
        },
      },
    );
    expect(deactivatedStandard.isActive).toBe(false);

    const reactivatedStandard = await skillResolver.activateSkill(
      standardSkillId,
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
    expect(reactivatedStandard.isActive).toBe(true);

    // Re-activating an already active skill is a no-op (0 additional audit entries)
    await skillResolver.activateSkill(
      standardSkillId,
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

    // Standard skill rejects updateSkill and deleteSkill with SKILL_IS_STANDARD
    await expect(
      skillResolver.updateSkill(
        {
          id: standardSkillId,
          content: 'Attempted overwrite of standard skill',
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
    ).rejects.toMatchObject({
      code: SkillExceptionCode.SKILL_IS_STANDARD,
    });
    await expect(
      skillResolver.deleteSkill(
        standardSkillId,
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
      code: SkillExceptionCode.SKILL_IS_STANDARD,
    });

    // 5. Delete custom skill via GraphQL resolver
    const deleted = await skillResolver.deleteSkill(
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

    const audits = await ownerDataSource.query(
      `SELECT "resourceKind","resourceId",action,actor,initiator,"redactedDiff","securityDescriptor"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );
    expect(audits).toHaveLength(5);

    expect(audits[0]).toMatchObject({
      resourceKind: 'skill',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'skill',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'content',
          'description',
          'icon',
          'isActive',
          'isCustom',
          'isSystem',
          'label',
          'name',
        ],
        values: {
          applicationId: { before: null, after: customApplicationId },
          isCustom: { before: null, after: true },
          isSystem: { before: null, after: false },
          isActive: { before: null, after: true },
        },
      },
    });
    expect(audits[0].redactedDiff.values.content).toBeUndefined();
    expect(audits[0].redactedDiff.values.name).toBeUndefined();
    expect(audits[0].redactedDiff.values.label).toBeUndefined();
    expect(audits[0].redactedDiff.values.description).toBeUndefined();
    expect(JSON.stringify(audits[0])).not.toContain(
      'sk_live_secret_prompt_token_999',
    );

    expect(audits[1]).toMatchObject({
      resourceKind: 'skill',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['content', 'description', 'icon', 'label', 'name'],
        values: {},
      },
    });
    expect(JSON.stringify(audits[1])).not.toContain(
      'sk_live_rotated_token_888',
    );

    expect(audits[2]).toMatchObject({
      resourceKind: 'skill',
      resourceId: standardSkillId,
      action: 'update',
      actor: { kind: 'application', id: thirdPartyApplicationId },
      redactedDiff: {
        changedFields: ['isActive'],
        values: {
          isActive: { before: true, after: false },
        },
      },
    });

    expect(audits[3]).toMatchObject({
      resourceKind: 'skill',
      resourceId: standardSkillId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['isActive'],
        values: {
          isActive: { before: false, after: true },
        },
      },
    });

    expect(audits[4]).toMatchObject({
      resourceKind: 'skill',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: [
          'applicationId',
          'content',
          'description',
          'icon',
          'isActive',
          'isCustom',
          'isSystem',
          'label',
          'name',
        ],
        values: {
          applicationId: { before: customApplicationId, after: null },
          isCustom: { before: true, after: null },
          isSystem: { before: false, after: null },
          isActive: { before: true, after: null },
        },
      },
    });
  });

  it('audits application metadata migrations, system builds, and blocks application deletion until skill rows are removed', async () => {
    const { runnerService, flatApplicationMaps } = buildHarness();

    const appSkillId = randomUUID().toLowerCase();
    const appSkillUniversalId = randomUUID().toLowerCase();

    // 1. Create skill in thirdPartyApplication via withApplicationMetadataAudit
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
                metadataName: 'skill',
                id: appSkillId,
                flatEntity: {
                  id: appSkillId,
                  universalIdentifier: appSkillUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'manifest-skill',
                  label: 'Manifest Skill',
                  icon: 'IconBolt',
                  description: 'Installed app skill',
                  content: 'Follow manifest skill instructions',
                  isCustom: false,
                  isSystem: false,
                  isActive: true,
                },
              },
            ],
          } as never,
        }),
    );

    // 2. Update skill via withApplicationMetadataAudit
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
                metadataName: 'skill',
                universalIdentifier: appSkillUniversalId,
                update: {
                  label: 'Manifest Skill v2',
                  content: 'Follow updated manifest instructions',
                  isActive: false,
                },
              },
            ],
          } as never,
        }),
    );

    // 3. assertNoRemainingApplicationRoleOrPermissionMetadata and runAuditedApplicationDelete block while skill remains
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

    // 4. Delete skill via withApplicationMetadataAudit, then delete application
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
                metadataName: 'skill',
                universalIdentifier: appSkillUniversalId,
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

    // 5. System build auto-wraps skill migration in system application metadata audit
    const sysSkillId = randomUUID().toLowerCase();
    const sysSkillUniversalId = randomUUID().toLowerCase();
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
                  metadataName: 'skill',
                  id: sysSkillId,
                  flatEntity: {
                    id: sysSkillId,
                    universalIdentifier: sysSkillUniversalId,
                    applicationUniversalIdentifier:
                      STANDARD_APPLICATION_UNIVERSAL_ID,
                    name: 'standard-data-manipulation',
                    label: 'Data Manipulation',
                    icon: 'IconDatabase',
                    description: 'Standard data skill',
                    content: 'Standard data manipulation prompt',
                    isCustom: false,
                    isSystem: true,
                    isActive: true,
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
            skill: {
              flatEntityToCreate: [
                {
                  id: sysSkillId,
                  universalIdentifier: sysSkillUniversalId,
                  applicationUniversalIdentifier:
                    STANDARD_APPLICATION_UNIVERSAL_ID,
                  name: 'standard-data-manipulation',
                  label: 'Data Manipulation',
                  icon: 'IconDatabase',
                  description: 'Standard data skill',
                  content: 'Standard data manipulation prompt',
                  isCustom: false,
                  isSystem: true,
                  isActive: true,
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
      resourceKind: 'skill',
      resourceId: appSkillId,
      action: 'create',
      redactedDiff: {
        values: {
          applicationId: { before: null, after: thirdPartyApplicationId },
          isCustom: { before: null, after: false },
          isSystem: { before: null, after: false },
          isActive: { before: null, after: true },
        },
      },
    });
    expect(audits[1]).toMatchObject({
      resourceKind: 'skill',
      resourceId: appSkillId,
      action: 'update',
      redactedDiff: {
        changedFields: ['content', 'isActive', 'label'],
        values: {
          isActive: { before: true, after: false },
        },
      },
    });
    expect(audits[2]).toMatchObject({
      resourceKind: 'skill',
      resourceId: appSkillId,
      action: 'delete',
      redactedDiff: {
        values: {
          applicationId: { before: thirdPartyApplicationId, after: null },
          isCustom: { before: false, after: null },
          isSystem: { before: false, after: null },
          isActive: { before: false, after: null },
        },
      },
    });
    expect(audits[3]).toMatchObject({
      resourceKind: 'skill',
      resourceId: sysSkillId,
      action: 'create',
      actor: { kind: 'system', id: 'workspace-migration:system-build' },
      redactedDiff: {
        values: {
          applicationId: { before: null, after: standardApplicationId },
          isCustom: { before: null, after: false },
          isSystem: { before: null, after: true },
          isActive: { before: null, after: true },
        },
      },
    });
  });

  it('enforces fail-closed barriers, rolls back on post-flush trigger corruption, and invalidates cache on NativeTransactionOutcomeUnknownError', async () => {
    const { runnerService, skillService, skillResolver, invalidateCacheMock } =
      buildHarness();

    // 1. Unaudited runner execution touching skill is rejected fail-closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'skill',
              id: randomUUID().toLowerCase(),
              flatEntity: {
                universalIdentifier: randomUUID().toLowerCase(),
                applicationUniversalIdentifier: customApplicationUniversalId,
                name: 'unaudited-skill',
                label: 'Unaudited Skill',
                icon: null,
                description: null,
                content: 'Unaudited instructions',
                isCustom: true,
                isSystem: false,
                isActive: true,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Unauthenticated SkillService.create is rejected before any DB write
    await expect(
      skillService.create(
        {
          name: 'unauth-skill',
          label: 'Unauth Skill',
          content: 'Unauth content',
        },
        workspaceId,
      ),
    ).rejects.toThrow(
      'Navigation menu item mutation requires authenticated audit identity',
    );

    // 3. Reusing a one-shot NavigationMenuItemAuditRequest is rejected
    const getAudit = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'skill',
      expectedSkillCreateIds: [randomUUID().toLowerCase()],
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

    // 4. Post-flush trigger corruption rolls back both core.skill and crm_audit."crmAuditEntry"
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_skill_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'skill' THEN
          UPDATE core.skill
          SET content = 'Tampered prompt instructions'
          WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_skill_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_skill_after_audit();
    `);
    try {
      await expect(
        skillResolver.createSkill(
          {
            name: 'legit-skill',
            label: 'Legit Skill',
            content: 'Legit instructions',
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
      ).rejects.toThrow('Skill state changed during audit flush');
    } finally {
      await ownerDataSource.query(`
        DROP TRIGGER IF EXISTS trg_corrupt_skill_after_audit ON crm_audit."crmAuditEntry";
        DROP FUNCTION IF EXISTS core.corrupt_skill_after_audit();
      `);
    }

    const skillsAfterRollback = await ownerDataSource.query(
      `SELECT id FROM core.skill WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(skillsAfterRollback).toHaveLength(0);

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
        skillResolver.createSkill(
          {
            name: 'commit-ack-lost-skill',
            label: 'Commit Ack Lost Skill',
            content: 'Prompt content survived commit ack loss',
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

    const committedSkills = await ownerDataSource.query(
      `SELECT id FROM core.skill WHERE "workspaceId"=$1`,
      [workspaceId],
    );
    expect(committedSkills).toHaveLength(1);
  });
});
