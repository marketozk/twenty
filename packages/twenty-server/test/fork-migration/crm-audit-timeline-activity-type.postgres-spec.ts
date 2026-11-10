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
import { TimelineActivityTypeExceptionCode } from 'src/engine/metadata-modules/timeline-activity-type/enums/timeline-activity-type-exception-code.enum';
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
    'src/engine/metadata-modules/timeline-activity-type/interceptors/timeline-activity-type-graphql-api-exception.interceptor',
    ['TimelineActivityTypeGraphqlApiExceptionInterceptor'],
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
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { TimelineActivityTypeService } =
  require('src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.service') as typeof import('src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.service');
const { TimelineActivityTypeResolver } =
  require('src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.resolver') as typeof import('src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.resolver');
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

const runtimeRole = `twenty_tat_audit_rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

describe('CRM audit timelineActivityType lifecycle and application cascade', () => {
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

      CREATE TABLE core."timelineActivityType" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        label text NOT NULL,
        action text,
        icon text,
        "frontComponentUniversalIdentifier" uuid,
        "objectUniversalIdentifier" uuid,
        "targetRelationFieldUniversalIdentifier" uuid,
        "triggerFieldUniversalIdentifiers" uuid[],
        "happensAtFieldUniversalIdentifier" uuid,
        "replacesTimelineActivityTypeUniversalIdentifier" uuid,
        "isActive" boolean NOT NULL DEFAULT true,
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
        core."timelineActivityType",
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
      const tatRows = await ownerDataSource.query(
        `SELECT * FROM core."timelineActivityType" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );
      const objRows = await ownerDataSource.query(
        `SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id`,
        [workspaceId],
      );

      const flatTimelineActivityTypeMaps = {
        byUniversalIdentifier: Object.fromEntries(
          tatRows.map((row: Record<string, any>) => [
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
              action: row.action ?? null,
              icon: row.icon ?? null,
              frontComponentUniversalIdentifier:
                row.frontComponentUniversalIdentifier
                  ? row.frontComponentUniversalIdentifier.toLowerCase()
                  : null,
              objectUniversalIdentifier: row.objectUniversalIdentifier
                ? row.objectUniversalIdentifier.toLowerCase()
                : null,
              targetRelationFieldUniversalIdentifier:
                row.targetRelationFieldUniversalIdentifier
                  ? row.targetRelationFieldUniversalIdentifier.toLowerCase()
                  : null,
              triggerFieldUniversalIdentifiers: Array.isArray(
                row.triggerFieldUniversalIdentifiers,
              )
                ? row.triggerFieldUniversalIdentifiers.map((uid: string) =>
                    uid.toLowerCase(),
                  )
                : null,
              happensAtFieldUniversalIdentifier:
                row.happensAtFieldUniversalIdentifier
                  ? row.happensAtFieldUniversalIdentifier.toLowerCase()
                  : null,
              replacesTimelineActivityTypeUniversalIdentifier:
                row.replacesTimelineActivityTypeUniversalIdentifier
                  ? row.replacesTimelineActivityTypeUniversalIdentifier.toLowerCase()
                  : null,
              isActive: Boolean(row.isActive),
              overrides: row.overrides ?? null,
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
          tatRows.map((row: Record<string, any>) => [
            row.universalIdentifier.toLowerCase(),
            row.id.toLowerCase(),
          ]),
        ),
        universalIdentifierById: Object.fromEntries(
          tatRows.map((row: Record<string, any>) => [
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
        flatTimelineActivityTypeMaps,
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
          if (action.metadataName === 'timelineActivityType') {
            if (action.type === 'create') {
              const fe = action.flatEntity;
              const id = (action.id ?? fe.id ?? randomUUID()).toLowerCase();
              await queryRunner.query(
                `INSERT INTO core."timelineActivityType" (
                   id, "workspaceId", "applicationId", "universalIdentifier",
                   name, label, action, icon,
                   "frontComponentUniversalIdentifier", "objectUniversalIdentifier",
                   "targetRelationFieldUniversalIdentifier", "triggerFieldUniversalIdentifiers",
                   "happensAtFieldUniversalIdentifier", "replacesTimelineActivityTypeUniversalIdentifier",
                   "isActive", overrides
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid[],$13,$14,$15,$16::jsonb)`,
                [
                  id,
                  workspaceId,
                  flatApplication.id,
                  fe.universalIdentifier,
                  fe.name,
                  fe.label,
                  fe.action ?? null,
                  fe.icon ?? null,
                  fe.frontComponentUniversalIdentifier ?? null,
                  fe.objectUniversalIdentifier ?? null,
                  fe.targetRelationFieldUniversalIdentifier ?? null,
                  fe.triggerFieldUniversalIdentifiers ?? null,
                  fe.happensAtFieldUniversalIdentifier ?? null,
                  fe.replacesTimelineActivityTypeUniversalIdentifier ?? null,
                  fe.isActive ?? true,
                  fe.overrides !== undefined && fe.overrides !== null
                    ? JSON.stringify(fe.overrides)
                    : null,
                ],
              );
              allFlatEntityMaps.flatTimelineActivityTypeMaps.byUniversalIdentifier[
                fe.universalIdentifier.toLowerCase()
              ] = {
                ...fe,
                id,
                applicationId: flatApplication.id,
              };
            } else if (action.type === 'update') {
              const existing =
                allFlatEntityMaps.flatTimelineActivityTypeMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              const upd = action.update ?? {};
              const nextOverrides =
                'overrides' in upd ? upd.overrides : existing.overrides;
              await queryRunner.query(
                `UPDATE core."timelineActivityType"
                 SET name=$1, label=$2, action=$3, icon=$4,
                     "frontComponentUniversalIdentifier"=$5, "objectUniversalIdentifier"=$6,
                     "targetRelationFieldUniversalIdentifier"=$7, "triggerFieldUniversalIdentifiers"=$8::uuid[],
                     "happensAtFieldUniversalIdentifier"=$9, "replacesTimelineActivityTypeUniversalIdentifier"=$10,
                     "isActive"=$11, overrides=$12::jsonb, "updatedAt"=now()
                 WHERE id=$13 AND "workspaceId"=$14`,
                [
                  'name' in upd ? upd.name : existing.name,
                  'label' in upd ? upd.label : existing.label,
                  'action' in upd ? upd.action : existing.action,
                  'icon' in upd ? upd.icon : existing.icon,
                  'frontComponentUniversalIdentifier' in upd
                    ? upd.frontComponentUniversalIdentifier
                    : existing.frontComponentUniversalIdentifier,
                  'objectUniversalIdentifier' in upd
                    ? upd.objectUniversalIdentifier
                    : existing.objectUniversalIdentifier,
                  'targetRelationFieldUniversalIdentifier' in upd
                    ? upd.targetRelationFieldUniversalIdentifier
                    : existing.targetRelationFieldUniversalIdentifier,
                  'triggerFieldUniversalIdentifiers' in upd
                    ? upd.triggerFieldUniversalIdentifiers
                    : existing.triggerFieldUniversalIdentifiers,
                  'happensAtFieldUniversalIdentifier' in upd
                    ? upd.happensAtFieldUniversalIdentifier
                    : existing.happensAtFieldUniversalIdentifier,
                  'replacesTimelineActivityTypeUniversalIdentifier' in upd
                    ? upd.replacesTimelineActivityTypeUniversalIdentifier
                    : existing.replacesTimelineActivityTypeUniversalIdentifier,
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
                allFlatEntityMaps.flatTimelineActivityTypeMaps
                  ?.byUniversalIdentifier[
                  action.universalIdentifier.toLowerCase()
                ];
              await queryRunner.query(
                `DELETE FROM core."timelineActivityType" WHERE id=$1 AND "workspaceId"=$2`,
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
            currentMaps.flatTimelineActivityTypeMaps?.byUniversalIdentifier[
              fe.universalIdentifier.toLowerCase()
            ] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'name',
            'label',
            'action',
            'icon',
            'frontComponentUniversalIdentifier',
            'objectUniversalIdentifier',
            'targetRelationFieldUniversalIdentifier',
            'triggerFieldUniversalIdentifiers',
            'happensAtFieldUniversalIdentifier',
            'replacesTimelineActivityTypeUniversalIdentifier',
            'isActive',
            'overrides',
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

    const timelineActivityTypeService = new TimelineActivityTypeService(
      cacheService as never,
      {
        validateBuildAndRunWorkspaceMigration: validateBuildAndRunMock,
      } as never,
      applicationServiceMock as never,
    );

    const timelineActivityTypeResolver = new TimelineActivityTypeResolver(
      timelineActivityTypeService,
      { buildEffectiveEntityI18nContext: jest.fn() } as never,
    );

    return {
      runnerService,
      timelineActivityTypeService,
      timelineActivityTypeResolver,
    };
  };

  it('audits standard and custom timelineActivityType update and reset through TimelineActivityTypeResolver and TimelineActivityTypeService', async () => {
    const { timelineActivityTypeResolver } = buildHarness();

    const standardTatId = randomUUID().toLowerCase();
    const standardTatUniversalId = randomUUID().toLowerCase();
    const customTatId = randomUUID().toLowerCase();
    const customTatUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."timelineActivityType" (
         id, "workspaceId", "applicationId", "universalIdentifier",
         name, label, action, icon, "isActive"
       ) VALUES
         ($1, $2, $3, $4, 'recordCreated', 'was created by', 'created', 'IconCirclePlus', true),
         ($5, $2, $6, $7, 'customCallLogged', 'logged a call', null, 'IconPhone', true)`,
      [
        standardTatId,
        workspaceId,
        standardApplicationId,
        standardTatUniversalId,
        customTatId,
        customApplicationId,
        customTatUniversalId,
      ],
    );

    // 1. Override standard timelineActivityType under impersonation
    const overriddenStandard =
      await timelineActivityTypeResolver.updateTimelineActivityType(
        {
          id: standardTatId,
          label: 'was created in CRM by',
          icon: 'IconPlus',
          isActive: false,
          translations: [
            {
              locale: 'fr-FR' as never,
              property: 'label',
              value: 'a ete cree par',
            },
          ],
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
    expect(overriddenStandard.id).toBe(standardTatId);
    expect(overriddenStandard.isActive).toBe(false);

    // 2. Idempotent update on standard timelineActivityType produces 0 new audit entries
    await timelineActivityTypeResolver.updateTimelineActivityType(
      {
        id: standardTatId,
        label: 'was created in CRM by',
        icon: 'IconPlus',
        isActive: false,
        translations: [
          {
            locale: 'fr-FR' as never,
            property: 'label',
            value: 'a ete cree par',
          },
        ],
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

    // 3. Reset standard timelineActivityType overrides under apiKey
    const resetStandard =
      await timelineActivityTypeResolver.resetTimelineActivityType(
        standardTatId,
        { id: workspaceId } as never,
        {
          req: {
            workspace: { id: workspaceId },
            apiKey: { id: apiKeyId },
          },
        },
      );
    expect(resetStandard.id).toBe(standardTatId);
    expect(resetStandard.isActive).toBe(true);
    expect(resetStandard.overrides).toBeNull();

    // 4. Update custom timelineActivityType directly mutates columns
    const updatedCustom =
      await timelineActivityTypeResolver.updateTimelineActivityType(
        {
          id: customTatId,
          label: 'completed an outbound call',
          icon: 'IconPhoneCall',
          isActive: false,
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
    expect(updatedCustom.label).toBe('completed an outbound call');
    expect(updatedCustom.icon).toBe('IconPhoneCall');
    expect(updatedCustom.isActive).toBe(false);

    // 5. Reject resetTimelineActivityType on custom timelineActivityType
    await expect(
      timelineActivityTypeResolver.resetTimelineActivityType(
        customTatId,
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
      code: TimelineActivityTypeExceptionCode.TIMELINE_ACTIVITY_TYPE_CANNOT_BE_RESET,
    });

    const entries = await ownerDataSource.query(
      `SELECT "operationId", "resourceKind", "resourceId", action,
              actor, initiator, "securityDescriptor", "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: standardTatId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'timelineActivityType',
        resourceId: standardTatId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: ['overrides'],
        values: {},
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: standardTatId,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      initiator: null,
      redactedDiff: {
        changedFields: ['overrides'],
        values: {},
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: customTatId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: ownerWorkspaceMemberId },
      redactedDiff: {
        changedFields: ['icon', 'isActive', 'label'],
        values: {
          isActive: {
            before: true,
            after: false,
          },
        },
      },
    });
  });

  it('audits application manifest timelineActivityType create/update/delete, blocks application delete until removed, and rejects unaudited runner mutations', async () => {
    const { runnerService } = buildHarness();

    const tatId = randomUUID().toLowerCase();
    const tatUniversalId = randomUUID().toLowerCase();
    const frontComponentUniversalId = randomUUID().toLowerCase();
    const targetRelationFieldUniversalId = randomUUID().toLowerCase();
    const triggerFieldUniversalId1 = randomUUID().toLowerCase();
    const triggerFieldUniversalId2 = randomUUID().toLowerCase();
    const happensAtFieldUniversalId = randomUUID().toLowerCase();
    const replacesTatUniversalId = randomUUID().toLowerCase();

    // 1. Fail-closed without audit context
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: thirdPartyApplicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'timelineActivityType',
              id: tatId,
              flatEntity: {
                id: tatId,
                universalIdentifier: tatUniversalId,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalId,
                name: 'externalCallSynced',
                label: 'synced external call',
                action: 'updated',
                icon: 'IconPhone',
                frontComponentUniversalIdentifier: frontComponentUniversalId,
                objectUniversalIdentifier: companyObjectUniversalId,
                targetRelationFieldUniversalIdentifier:
                  targetRelationFieldUniversalId,
                triggerFieldUniversalIdentifiers: [triggerFieldUniversalId1],
                happensAtFieldUniversalIdentifier: null,
                replacesTimelineActivityTypeUniversalIdentifier:
                  replacesTatUniversalId,
                isActive: true,
                overrides: null,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // 2. Create timelineActivityType via application metadata audit
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
                metadataName: 'timelineActivityType',
                id: tatId,
                flatEntity: {
                  id: tatId,
                  universalIdentifier: tatUniversalId,
                  applicationUniversalIdentifier:
                    thirdPartyApplicationUniversalId,
                  name: 'externalCallSynced',
                  label: 'synced external call',
                  action: 'updated',
                  icon: 'IconPhone',
                  frontComponentUniversalIdentifier: frontComponentUniversalId,
                  objectUniversalIdentifier: companyObjectUniversalId,
                  targetRelationFieldUniversalIdentifier:
                    targetRelationFieldUniversalId,
                  triggerFieldUniversalIdentifiers: [triggerFieldUniversalId1],
                  happensAtFieldUniversalIdentifier: null,
                  replacesTimelineActivityTypeUniversalIdentifier:
                    replacesTatUniversalId,
                  isActive: true,
                  overrides: null,
                },
              },
            ],
          } as never,
        }),
    );

    // 3. Update timelineActivityType via application metadata audit
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
                metadataName: 'timelineActivityType',
                universalIdentifier: tatUniversalId,
                update: {
                  label: 'synced call from provider',
                  triggerFieldUniversalIdentifiers: [
                    triggerFieldUniversalId1,
                    triggerFieldUniversalId2,
                  ],
                  happensAtFieldUniversalIdentifier: happensAtFieldUniversalId,
                  isActive: false,
                },
              },
            ],
          } as never,
        }),
    );

    // 4. Application delete barrier rejects while timelineActivityType row still exists
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

    // 5. Delete timelineActivityType via application metadata audit, then delete application
    const deleteTatOp = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: {
        user: { id: ownerUserId },
        workspaceMemberId: ownerWorkspaceMemberId,
      },
      isSystemBuild: true,
    });
    await withApplicationMetadataAudit(
      bindApplicationMetadataAuditOperation(deleteTatOp, {
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
                metadataName: 'timelineActivityType',
                universalIdentifier: tatUniversalId,
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
      `SELECT "operationId", "resourceKind", "resourceId", action, actor, "redactedDiff"
       FROM crm_audit."crmAuditEntry"
       WHERE "workspaceId"=$1
       ORDER BY "createdAt" ASC, id ASC`,
      [workspaceId],
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: tatId,
      action: 'create',
      redactedDiff: {
        changedFields: [
          'action',
          'applicationId',
          'frontComponentUniversalIdentifier',
          'happensAtFieldUniversalIdentifier',
          'icon',
          'isActive',
          'label',
          'name',
          'objectUniversalIdentifier',
          'overrides',
          'replacesTimelineActivityTypeUniversalIdentifier',
          'targetRelationFieldUniversalIdentifier',
          'triggerFieldUniversalIdentifiers',
        ],
        values: {
          applicationId: {
            before: null,
            after: thirdPartyApplicationId,
          },
          action: {
            before: null,
            after: 'updated',
          },
          frontComponentUniversalIdentifier: {
            before: null,
            after: frontComponentUniversalId,
          },
          objectUniversalIdentifier: {
            before: null,
            after: companyObjectUniversalId,
          },
          targetRelationFieldUniversalIdentifier: {
            before: null,
            after: targetRelationFieldUniversalId,
          },
          happensAtFieldUniversalIdentifier: {
            before: null,
            after: null,
          },
          replacesTimelineActivityTypeUniversalIdentifier: {
            before: null,
            after: replacesTatUniversalId,
          },
          isActive: {
            before: null,
            after: true,
          },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: tatId,
      action: 'update',
      redactedDiff: {
        changedFields: [
          'happensAtFieldUniversalIdentifier',
          'isActive',
          'label',
          'triggerFieldUniversalIdentifiers',
        ],
        values: {
          happensAtFieldUniversalIdentifier: {
            before: null,
            after: happensAtFieldUniversalId,
          },
          isActive: {
            before: true,
            after: false,
          },
        },
      },
    });
    expect(entries[2]).toMatchObject({
      resourceKind: 'timelineActivityType',
      resourceId: tatId,
      action: 'delete',
    });
  });

  it('rolls back on post-flush timelineActivityType mutation and propagates NativeTransactionOutcomeUnknownError on lost COMMIT ack', async () => {
    const { runnerService } = buildHarness();

    const tatId = randomUUID().toLowerCase();
    const tatUniversalId = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `CREATE OR REPLACE FUNCTION crm_audit.tamper_tat_after_audit()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
       BEGIN
         IF NEW."resourceKind" = 'timelineActivityType' THEN
           UPDATE core."timelineActivityType" SET "isActive" = false WHERE id = NEW."resourceId"::uuid;
         END IF;
         RETURN NEW;
       END;
       $$;
       DROP TRIGGER IF EXISTS trg_tamper_tat_after_audit ON crm_audit."crmAuditEntry";
       CREATE TRIGGER trg_tamper_tat_after_audit
       AFTER INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_tat_after_audit();`,
    );

    try {
      const capturedTamper = captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'timelineActivityType',
        auditIdentity: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedTimelineActivityTypeCreateIds: [tatId],
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
                  metadataName: 'timelineActivityType',
                  id: tatId,
                  flatEntity: {
                    id: tatId,
                    universalIdentifier: tatUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'tamperedType',
                    label: 'Tampered Type',
                    action: null,
                    icon: 'IconAlertCircle',
                    isActive: true,
                  },
                },
              ],
            } as never,
          }),
        ),
      ).rejects.toThrow(
        'Timeline activity type state changed during audit flush',
      );
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_tamper_tat_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.tamper_tat_after_audit();`,
      );
    }

    const rowsAfterRollback = await ownerDataSource.query(
      `SELECT id FROM core."timelineActivityType" WHERE id=$1`,
      [tatId],
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
        mode: 'timelineActivityType',
        auditIdentity: {
          workspace: { id: workspaceId },
          user: { id: ownerUserId },
          workspaceMemberId: ownerWorkspaceMemberId,
        },
        expectedTimelineActivityTypeCreateIds: [tatId],
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
                  metadataName: 'timelineActivityType',
                  id: tatId,
                  flatEntity: {
                    id: tatId,
                    universalIdentifier: tatUniversalId,
                    applicationUniversalIdentifier:
                      customApplicationUniversalId,
                    name: 'commitLossType',
                    label: 'Commit Loss Type',
                    action: null,
                    icon: 'IconCheck',
                    isActive: true,
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
