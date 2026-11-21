import { randomUUID } from 'node:crypto';
import { ViewType, ViewVisibility } from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAudit,
  captureApplicationMetadataAuditOperation,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureCoreViewCreateAudit,
  withCoreViewAudit,
} from 'src/engine/core-modules/crm-audit/core-workflow-and-view-audit';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';

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
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  ['src/engine/core-modules/logger/logger.service', ['LoggerService']],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
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
    'src/engine/metadata-modules/flat-entity/filters/flat-entity-maps-rest-api-exception.filter',
    ['FlatEntityMapsRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-rest-api-exception.filter',
    ['PermissionsRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
    ['ApplicationTranslationCatalogService'],
  ],
  [
    'src/engine/metadata-modules/view/services/view-widget-upsert.service',
    ['ViewWidgetUpsertService'],
  ],
  [
    'src/engine/metadata-modules/view/entities/view.entity',
    ['ViewEntity'],
  ],
  [
    'src/engine/metadata-modules/view/utils/view-graphql-api-exception.filter',
    ['ViewGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/view/filters/view-rest-api-exception.filter',
    ['ViewRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/view-permissions/guards/view-permission.guard',
    ['ViewPermissionGuard'],
  ],
  [
    'src/engine/metadata-modules/view-permissions/guards/create-view-permission.guard',
    ['CreateViewPermissionGuard'],
  ],
  ['src/engine/guards/custom-permission.guard', ['CustomPermissionGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  [
    'src/engine/guards/settings-permission.guard',
    ['SettingsPermissionGuard'],
  ],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
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
    'src/engine/workspace-manager/workspace-migration/filters/workspace-migration-runner-rest-api-exception.filter',
    ['WorkspaceMigrationRunnerRestApiExceptionFilter'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    ['WorkspaceMigrationRunnerActionHandlerRegistryService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    ['DeferredWorkspaceMigrationActionRunnerService'],
  ],
] as const) {
  jest.mock(modPath, () => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      out[name] =
        name === 'SettingsPermissionGuard' || name === 'AuthPrincipalGuard'
          ? () => class {}
          : class {};
    }
    return out;
  });
}

jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({
    InjectWorkspaceScopedRepository: () => () => {},
  }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({
    WorkspaceScopedRepository: class {},
  }),
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ViewService } =
  require('src/engine/metadata-modules/view/services/view.service') as typeof import('src/engine/metadata-modules/view/services/view.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ViewResolver } =
  require('src/engine/metadata-modules/view/resolvers/view.resolver') as typeof import('src/engine/metadata-modules/view/resolvers/view.resolver');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ViewController } =
  require('src/engine/metadata-modules/view/controllers/view.controller') as typeof import('src/engine/metadata-modules/view/controllers/view.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CompleteViewUpsertService } =
  require('src/engine/metadata-modules/view/tools/services/complete-view-upsert.service') as typeof import('src/engine/metadata-modules/view/tools/services/complete-view-upsert.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

const ownerUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !ownerUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(ownerUrl).pathname)
) {
  throw new Error(
    'FORK_MIGRATION_TEST_URL must target an isolated temporary test database',
  );
}
const databaseRole = `core_view_audit_rt_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const runtimeUrl = (() => {
  const parsed = new URL(ownerUrl);
  parsed.username = databaseRole;
  parsed.password = 'isolated-core-view-fixture';
  return parsed.toString();
})();

const workspaceId = randomUUID().toLowerCase();
const workspaceSchema = `workspace_${workspaceId.replaceAll('-', '')}`;
const actorUserId = randomUUID().toLowerCase();
const actorUserWorkspaceId = randomUUID().toLowerCase();
const actorMemberId = randomUUID().toLowerCase();
const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();
const impersonatorMemberId = randomUUID().toLowerCase();

const customApplicationId = randomUUID().toLowerCase();
const customApplicationUniversalIdentifier = randomUUID().toLowerCase();
const standardApplicationId = randomUUID().toLowerCase();
const standardApplicationUniversalIdentifier = randomUUID().toLowerCase();
const thirdPartyApplicationId = randomUUID().toLowerCase();
const thirdPartyApplicationUniversalIdentifier = randomUUID().toLowerCase();

const objectMetadataId = randomUUID().toLowerCase();
const objectMetadataUniversalIdentifier = randomUUID().toLowerCase();
const fieldMetadataId = randomUUID().toLowerCase();
const fieldMetadataUniversalIdentifier = randomUUID().toLowerCase();

const ownerDataSource = new DataSource({ type: 'postgres', url: ownerUrl });
const runtimeDataSource = new DataSource({ type: 'postgres', url: runtimeUrl });

const identity = (impersonated = false): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    user: { id: actorUserId },
    userWorkspaceId: actorUserWorkspaceId,
    workspaceMemberId: actorMemberId,
  } as never,
  ...(impersonated
    ? {
        impersonatorUserWorkspaceId,
      }
    : {}),
});

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT id, "operationId", actor, initiator, action, "resourceKind", "resourceId",
            outcome, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
      ORDER BY "createdAt" ASC, id ASC`,
    [workspaceId],
  );

const createHarness = () => {
  const readFlatMaps = async () => {
    const appRows = await ownerDataSource.query(
      `SELECT id, "universalIdentifier" FROM core.application WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const appUidById = new Map<string, string>(
      appRows.map((row: { id: string; universalIdentifier: string }) => [
        row.id,
        row.universalIdentifier,
      ]),
    );
    const objectRows = await ownerDataSource.query(
      `SELECT * FROM core."objectMetadata" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const fieldRows = await ownerDataSource.query(
      `SELECT * FROM core."fieldMetadata" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const viewRows = await ownerDataSource.query(
      `SELECT * FROM core.view WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const navRows = await ownerDataSource.query(
      `SELECT * FROM core."navigationMenuItem" WHERE "workspaceId" = $1`,
      [workspaceId],
    );

    const buildMap = <TRow extends { id: string; universalIdentifier: string }>(
      rows: TRow[],
      enrich?: (row: TRow) => Record<string, unknown>,
    ) => {
      const byUniversalIdentifier: Record<string, Record<string, unknown>> = {};
      const universalIdentifierById: Record<string, string> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      for (const row of rows) {
        const enriched = enrich ? enrich(row) : row;
        byUniversalIdentifier[row.universalIdentifier] = enriched;
        universalIdentifierById[row.id] = row.universalIdentifier;
        idByUniversalIdentifier[row.universalIdentifier] = row.id;
      }
      return {
        byUniversalIdentifier,
        universalIdentifierById,
        idByUniversalIdentifier,
      };
    };

    const objUidById = new Map<string, string>(
      objectRows.map((row: { id: string; universalIdentifier: string }) => [
        row.id,
        row.universalIdentifier,
      ]),
    );

    const flatViewMaps = buildMap(viewRows, (row: Record<string, unknown>) => ({
      ...row,
      applicationUniversalIdentifier:
        appUidById.get(String(row.applicationId)) ??
        customApplicationUniversalIdentifier,
      objectMetadataUniversalIdentifier:
        objUidById.get(String(row.objectMetadataId)) ??
        objectMetadataUniversalIdentifier,
      calendarFieldMetadataUniversalIdentifier: null,
      calendarEndFieldMetadataUniversalIdentifier: null,
      kanbanAggregateOperationFieldMetadataUniversalIdentifier: null,
      mainGroupByFieldMetadataUniversalIdentifier: null,
      universalOverrides: row.overrides ?? null,
      viewFieldIds: [],
      viewFieldGroupIds: [],
      viewFilterIds: [],
      viewFilterGroupIds: [],
      viewGroupIds: [],
      viewSortIds: [],
      viewFieldUniversalIdentifiers: [],
      viewFilterUniversalIdentifiers: [],
      viewGroupUniversalIdentifiers: [],
      viewFieldGroupUniversalIdentifiers: [],
      viewFilterGroupUniversalIdentifiers: [],
      navigationMenuItemUniversalIdentifiers: [],
      viewSortUniversalIdentifiers: [],
    }));

    const flatObjectMetadataMaps = buildMap(
      objectRows,
      (row: Record<string, unknown>) => ({
        ...row,
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
        fieldUniversalIdentifiers: [],
        indexMetadataUniversalIdentifiers: [],
        viewUniversalIdentifiers: [],
      }),
    );

    const flatFieldMetadataMaps = buildMap(
      fieldRows,
      (row: Record<string, unknown>) => ({
        ...row,
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
        objectMetadataUniversalIdentifier:
          objUidById.get(String(row.objectMetadataId)) ??
          objectMetadataUniversalIdentifier,
      }),
    );

    const flatNavigationMenuItemMaps = buildMap(
      navRows,
      (row: Record<string, unknown>) => ({
        ...row,
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
      }),
    );

    const emptyMap = {
      byUniversalIdentifier: {},
      universalIdentifierById: {},
      idByUniversalIdentifier: {},
    };

    return {
      flatViewMaps,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatNavigationMenuItemMaps,
      flatViewGroupMaps: emptyMap,
      flatViewFieldMaps: emptyMap,
      flatViewFilterMaps: emptyMap,
      flatViewSortMaps: emptyMap,
      flatViewFieldGroupMaps: emptyMap,
      flatViewFilterGroupMaps: emptyMap,
      flatRoleMaps: emptyMap,
      flatRoleTargetMaps: emptyMap,
      flatAgentMaps: emptyMap,
      flatPermissionFlagMaps: emptyMap,
      flatRolePermissionFlagMaps: emptyMap,
      flatObjectPermissionMaps: emptyMap,
      flatFieldPermissionMaps: emptyMap,
      flatRowLevelPermissionPredicateMaps: emptyMap,
      flatRowLevelPermissionPredicateGroupMaps: emptyMap,
      flatWorkflowMaps: emptyMap,
      flatIndexMaps: emptyMap,
      flatPageLayoutMaps: emptyMap,
      flatPageLayoutTabMaps: emptyMap,
      flatPageLayoutWidgetMaps: emptyMap,
      flatAgentChatChannelMaps: emptyMap,
      flatAgentChatChannelRoleMaps: emptyMap,
      flatWebhookMaps: emptyMap,
      flatConnectionProviderMaps: emptyMap,
      flatSkillMaps: emptyMap,
      flatFrontComponentMaps: emptyMap,
      flatSettingsMenuItemMaps: emptyMap,
      flatLogicFunctionMaps: emptyMap,
      flatWorkflowVersionMaps: emptyMap,
      flatTimelineActivityTypeMaps: emptyMap,
      flatCommandMenuItemMaps: emptyMap,
      flatSearchFieldMetadataMaps: emptyMap,
    };
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => readFlatMaps()),
    invalidateFlatEntityMaps: jest.fn().mockResolvedValue(undefined),
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => {
      const appRows = await ownerDataSource.query(
        `SELECT id, "universalIdentifier" FROM core.application WHERE "workspaceId" = $1`,
        [workspaceId],
      );
      const byId: Record<string, unknown> = {};
      const byUniversalIdentifier: Record<string, unknown> = {};
      const universalIdentifierById: Record<string, string> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      for (const row of appRows) {
        const flatApp = {
          id: row.id,
          workspaceId,
          universalIdentifier: row.universalIdentifier,
        };
        byId[row.id] = flatApp;
        byUniversalIdentifier[row.universalIdentifier] = flatApp;
        universalIdentifierById[row.id] = row.universalIdentifier;
        idByUniversalIdentifier[row.universalIdentifier] = row.id;
      }
      return {
        flatApplicationMaps: {
          byId,
          byUniversalIdentifier,
          universalIdentifierById,
          idByUniversalIdentifier,
        },
        flatWorkspace: {
          id: workspaceId,
          activationStatus: WorkspaceActivationStatus.ACTIVE,
        },
      };
    }),
    invalidateAndRecompute: jest.fn().mockResolvedValue(undefined),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async () => ({
        workspaceCustomFlatApplication: {
          id: customApplicationId,
          workspaceId,
          universalIdentifier: customApplicationUniversalIdentifier,
        },
        twentyStandardFlatApplication: {
          id: standardApplicationId,
          workspaceId,
          universalIdentifier: standardApplicationUniversalIdentifier,
        },
      }),
    ),
  };

  const actionHandlerRegistry = {
    executeActionHandler: jest.fn(
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
          flatApplication: { id: string };
          allFlatEntityMaps: Awaited<ReturnType<typeof readFlatMaps>>;
          queryRunner: QueryRunner;
          workspaceId: string;
        };
      }) => {
        if (action.metadataName === 'view') {
          if (action.type === 'create' && action.flatEntity) {
            const flat = action.flatEntity;
            const id = String(action.id ?? flat.id ?? randomUUID());
            const objUid = String(
              flat.objectMetadataUniversalIdentifier ??
                objectMetadataUniversalIdentifier,
            );
            const [objRow] = await context.queryRunner.query(
              `SELECT id FROM core."objectMetadata" WHERE "workspaceId" = $1 AND "universalIdentifier" = $2 LIMIT 1`,
              [context.workspaceId, objUid],
            );
            const objId =
              objRow?.id ??
              context.allFlatEntityMaps.flatObjectMetadataMaps
                .idByUniversalIdentifier[objUid] ??
              String(flat.objectMetadataId ?? objectMetadataId);
            await context.queryRunner.query(
              `INSERT INTO core.view
                (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
                 name, icon, type, key, visibility, "createdByUserWorkspaceId",
                 "isCustom", "isActive", "isSystemSideEffect", position, "anyFieldFilterValue", overrides)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
              [
                id,
                String(flat.universalIdentifier),
                context.workspaceId,
                context.flatApplication.id,
                objId,
                String(flat.name ?? 'View'),
                String(flat.icon ?? 'IconList'),
                String(flat.type ?? ViewType.TABLE),
                flat.key ?? null,
                String(flat.visibility ?? ViewVisibility.WORKSPACE),
                flat.createdByUserWorkspaceId ?? null,
                flat.isCustom ?? true,
                flat.isActive ?? true,
                flat.isSystemSideEffect ?? false,
                Number(flat.position ?? 0),
                flat.anyFieldFilterValue ?? null,
                flat.overrides !== undefined && flat.overrides !== null
                  ? JSON.stringify(flat.overrides)
                  : null,
              ],
            );
          } else if (action.type === 'update' && action.update) {
            const existing =
              context.allFlatEntityMaps.flatViewMaps.byUniversalIdentifier[
                action.universalIdentifier!
              ];
            const id = String(existing?.id);
            const setClauses: string[] = ['"updatedAt" = now()'];
            const params: unknown[] = [id, context.workspaceId];
            const update = action.update;
            for (const [key, col] of [
              ['name', 'name'],
              ['icon', 'icon'],
              ['visibility', 'visibility'],
              ['createdByUserWorkspaceId', '"createdByUserWorkspaceId"'],
              ['isActive', '"isActive"'],
              ['position', 'position'],
              ['anyFieldFilterValue', '"anyFieldFilterValue"'],
            ] as const) {
              if (key in update && update[key] !== undefined) {
                params.push(update[key]);
                setClauses.push(`${col} = $${params.length}`);
              }
            }
            if ('universalOverrides' in update || 'overrides' in update) {
              const rawOverrides =
                'universalOverrides' in update
                  ? update.universalOverrides
                  : update.overrides;
              params.push(
                rawOverrides === null || rawOverrides === undefined
                  ? null
                  : JSON.stringify(rawOverrides),
              );
              setClauses.push(`overrides = $${params.length}::jsonb`);
            }
            await context.queryRunner.query(
              `UPDATE core.view SET ${setClauses.join(', ')} WHERE id = $1 AND "workspaceId" = $2`,
              params,
            );
          } else if (action.type === 'delete') {
            const existing =
              context.allFlatEntityMaps.flatViewMaps.byUniversalIdentifier[
                action.universalIdentifier!
              ];
            const id = String(existing?.id);
            await context.queryRunner.query(
              `DELETE FROM core.view WHERE id = $1 AND "workspaceId" = $2`,
              [id, context.workspaceId],
            );
          }
        } else if (
          action.metadataName === 'objectMetadata' &&
          action.type === 'create' &&
          action.flatEntity
        ) {
          const flat = action.flatEntity;
          await context.queryRunner.query(
            `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier")
             VALUES ($1, $2, $3, $4)`,
            [
              String(action.id ?? flat.id),
              context.workspaceId,
              context.flatApplication.id,
              String(flat.universalIdentifier),
            ],
          );
        } else if (
          action.metadataName === 'objectMetadata' &&
          action.type === 'delete'
        ) {
          const existing =
            context.allFlatEntityMaps.flatObjectMetadataMaps
              .byUniversalIdentifier[action.universalIdentifier!];
          await context.queryRunner.query(
            `DELETE FROM core."objectMetadata" WHERE id = $1 AND "workspaceId" = $2`,
            [String(existing?.id), context.workspaceId],
          );
        } else if (
          action.metadataName === 'fieldMetadata' &&
          action.type === 'delete'
        ) {
          const existing =
            context.allFlatEntityMaps.flatFieldMetadataMaps
              .byUniversalIdentifier[action.universalIdentifier!];
          await context.queryRunner.query(
            `DELETE FROM core."fieldMetadata" WHERE id = $1 AND "workspaceId" = $2`,
            [String(existing?.id), context.workspaceId],
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

  const migrationRunner = new WorkspaceMigrationRunnerService(
    flatEntityMapsCacheService as never,
    runtimeDataSource,
    actionHandlerRegistry as never,
    {
      incrementMetadataVersion: jest.fn().mockResolvedValue(undefined),
    } as never,
    workspaceCacheService as never,
    { recordHistogram: jest.fn() } as never,
    {
      perfTime: jest.fn(),
      perfTimeEnd: jest.fn(),
      perf: jest.fn(),
      error: jest.fn(),
    } as never,
    { get: jest.fn(() => false) } as never,
    { getWorkspaceFeatureFlagsMap: jest.fn(async () => ({})) } as never,
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

  const validateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: wsId,
        applicationUniversalIdentifier: appUid,
      }: {
        allFlatEntityOperationByMetadataName: {
          view?: {
            flatEntityToCreate?: Array<Record<string, unknown>>;
            flatEntityToUpdate?: Array<Record<string, unknown>>;
            flatEntityToDelete?: Array<Record<string, unknown>>;
          };
        };
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const flatMaps = await readFlatMaps();
        const actions: Array<Record<string, unknown>> = [];
        for (const toCreate of allFlatEntityOperationByMetadataName.view
          ?.flatEntityToCreate ?? []) {
          actions.push({
            type: 'create',
            metadataName: 'view',
            id: toCreate.id,
            flatEntity: toCreate,
          });
        }
        for (const toUpdate of allFlatEntityOperationByMetadataName.view
          ?.flatEntityToUpdate ?? []) {
          const uid = String(toUpdate.universalIdentifier);
          const existing =
            flatMaps.flatViewMaps.byUniversalIdentifier[uid] ?? {};
          const update: Record<string, unknown> = {};
          for (const key of [
            'name',
            'icon',
            'visibility',
            'createdByUserWorkspaceId',
            'isActive',
          ]) {
            if (toUpdate[key] !== existing[key]) {
              update[key] = toUpdate[key];
            }
          }
          if (
            JSON.stringify(toUpdate.universalOverrides ?? null) !==
            JSON.stringify(existing.universalOverrides ?? null)
          ) {
            update.universalOverrides = toUpdate.universalOverrides ?? null;
          }
          if (Object.keys(update).length > 0) {
            actions.push({
              type: 'update',
              metadataName: 'view',
              universalIdentifier: uid,
              update,
            });
          }
        }
        for (const toDelete of allFlatEntityOperationByMetadataName.view
          ?.flatEntityToDelete ?? []) {
          actions.push({
            type: 'delete',
            metadataName: 'view',
            universalIdentifier: String(toDelete.universalIdentifier),
          });
        }

        await migrationRunner.run({
          workspaceId: wsId,
          workspaceMigration: {
            applicationUniversalIdentifier: appUid,
            actions: actions as never,
          },
        });
        return { status: 'success' as const };
      },
    ),
  };

  const viewService = new ViewService(
    {} as never,
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
  );

  const viewResolver = new ViewResolver(
    viewService,
    {} as never,
    {} as never,
  );

  const viewController = new ViewController(
    viewService,
    flatEntityMapsCacheService as never,
    {
      getI18nContextByApplicationId: jest.fn(async () => () => ({})),
    } as never,
  );

  const completeViewUpsertService = new CompleteViewUpsertService(
    viewService,
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
  );

  return {
    viewService,
    viewResolver,
    viewController,
    completeViewUpsertService,
    migrationRunner,
    readFlatMaps,
  };
};

beforeAll(async () => {
  await ownerDataSource.initialize();
  await ownerDataSource.query(
    `DROP SCHEMA IF EXISTS core CASCADE;
     DROP SCHEMA IF EXISTS crm_audit CASCADE;
     DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
     CREATE SCHEMA core;
     CREATE SCHEMA "${workspaceSchema}";`,
  );
  await ownerDataSource.query(
    `CREATE TABLE core.workspace (
       id uuid PRIMARY KEY,
       "activationStatus" text NOT NULL DEFAULT 'ACTIVE',
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."user" (
       id uuid PRIMARY KEY,
       email text NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core.application (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."objectMetadata" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "nameSingular" text NOT NULL DEFAULT 'opportunity',
       "namePlural" text NOT NULL DEFAULT 'opportunities',
       "labelSingular" text NOT NULL DEFAULT 'Opportunity',
       "labelPlural" text NOT NULL DEFAULT 'Opportunities',
       "isSystem" boolean NOT NULL DEFAULT false,
       "isActive" boolean NOT NULL DEFAULT true,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."fieldMetadata" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
       type text NOT NULL DEFAULT 'TEXT',
       name text NOT NULL DEFAULT 'amount',
       label text NOT NULL DEFAULT 'Amount',
       "isSystem" boolean NOT NULL DEFAULT false,
       "isSystemSideEffect" boolean NOT NULL DEFAULT false,
       "isActive" boolean NOT NULL DEFAULT true,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core.view (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
       "calendarFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
       "mainGroupByFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
       "kanbanAggregateOperationFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
       name text NOT NULL DEFAULT 'All records',
       icon text NOT NULL DEFAULT 'IconList',
       type text NOT NULL DEFAULT 'TABLE',
       key text NULL,
       visibility text NOT NULL DEFAULT 'WORKSPACE',
       "createdByUserWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE SET NULL,
       "isCustom" boolean NOT NULL DEFAULT true,
       "isActive" boolean NOT NULL DEFAULT true,
       "isSystemSideEffect" boolean NOT NULL DEFAULT false,
       "isCompact" boolean NOT NULL DEFAULT false,
       "shouldHideEmptyGroups" boolean NOT NULL DEFAULT false,
       "groupLoadLimit" integer NOT NULL DEFAULT 10,
       "openRecordIn" text NOT NULL DEFAULT 'SIDE_PANEL',
       position double precision NOT NULL DEFAULT 0,
       "anyFieldFilterValue" text NULL,
       overrides jsonb NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."navigationMenuItem" (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "userWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
       type text NOT NULL DEFAULT 'VIEW',
       "viewId" uuid NULL REFERENCES core.view(id) ON DELETE CASCADE,
       "targetObjectMetadataId" uuid NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
       "folderId" uuid NULL REFERENCES core."navigationMenuItem"(id) ON DELETE CASCADE,
       name text NULL,
       link text NULL,
       icon text NULL,
       color text NULL,
       position double precision NOT NULL DEFAULT 0,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     );
     CREATE TABLE "${workspaceSchema}"."workspaceMember" (
       id uuid PRIMARY KEY,
       "userId" uuid NOT NULL,
       "deletedAt" timestamptz NULL
     );`,
  );

  await ownerDataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await ownerDataSource.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-core-view-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();

  await ownerDataSource.query(
    `INSERT INTO core.workspace (id, "activationStatus") VALUES ($1, 'ACTIVE')`,
    [workspaceId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email) VALUES ($1, 'actor@example.com'), ($2, 'admin@example.com')`,
    [actorUserId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId") VALUES ($1, $2, $3), ($4, $2, $5)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId") VALUES ($1, $2), ($3, $4)`,
    [actorMemberId, actorUserId, impersonatorMemberId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier") VALUES ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
    [
      customApplicationId,
      workspaceId,
      customApplicationUniversalIdentifier,
      standardApplicationId,
      standardApplicationUniversalIdentifier,
      thirdPartyApplicationId,
      thirdPartyApplicationUniversalIdentifier,
    ],
  );
});

afterAll(async () => {
  if (runtimeDataSource.isInitialized) {
    await runtimeDataSource.destroy();
  }
  if (ownerDataSource.isInitialized) {
    await ownerDataSource.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       REVOKE ALL PRIVILEGES ON SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       DROP ROLE IF EXISTS "${databaseRole}";`,
    );
    await ownerDataSource.destroy();
  }
});

beforeEach(async () => {
  await ownerDataSource.query(
    `DELETE FROM crm_audit."crmAuditEntry";
     DELETE FROM core."navigationMenuItem";
     DELETE FROM core.view;
     DELETE FROM core."fieldMetadata";
     DELETE FROM core."objectMetadata";`,
  );
  await ownerDataSource.query(
    `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier")
     VALUES ($1, $2, $3, $4)`,
    [
      objectMetadataId,
      workspaceId,
      customApplicationId,
      objectMetadataUniversalIdentifier,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      fieldMetadataId,
      workspaceId,
      customApplicationId,
      fieldMetadataUniversalIdentifier,
      objectMetadataId,
    ],
  );
});

describe('coreView lifecycle CRM audit (LOG-197)', () => {
  it('audits create, hard delete with navigation cascade, and overridden deactivation across ViewResolver, ViewController, and CompleteViewUpsertService', async () => {
    const {
      viewResolver,
      viewController,
      completeViewUpsertService,
    } = createHarness();

    // 1. ViewResolver.createView (UNLISTED with impersonation + redaction of sensitive display fields)
    const createdUnlisted = await viewResolver.createView(
      {
        name: 'Secret Pipeline View',
        objectMetadataId,
        icon: 'IconLock',
        type: ViewType.TABLE,
        visibility: ViewVisibility.UNLISTED,
        position: 3,
        anyFieldFilterValue: 'confidential-filter',
      } as never,
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      { req: identity(true) },
    );

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      action: 'create',
      resourceKind: 'coreView',
      resourceId: createdUnlisted.id,
      outcome: 'success',
      securityDescriptor: {
        resourceKind: 'coreView',
        resourceId: createdUnlisted.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values).toMatchObject({
      applicationId: { before: null, after: customApplicationId },
      objectMetadataId: { before: null, after: objectMetadataId },
      type: { before: null, after: ViewType.TABLE },
      isCustom: { before: null, after: true },
      isActive: { before: null, after: true },
      isSystemSideEffect: { before: null, after: false },
      createdByUserWorkspaceId: { before: null, after: actorUserWorkspaceId },
      visibility: { before: null, after: ViewVisibility.UNLISTED },
    });
    expect(audits[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining(['name', 'icon', 'position', 'anyFieldFilterValue']),
    );
    expect(audits[0].redactedDiff.values.name).toBeUndefined();
    expect(audits[0].redactedDiff.values.icon).toBeUndefined();
    expect(audits[0].redactedDiff.values.position).toBeUndefined();
    expect(audits[0].redactedDiff.values.anyFieldFilterValue).toBeUndefined();
    expect(JSON.stringify(audits[0].redactedDiff)).not.toContain(
      'Secret Pipeline View',
    );
    expect(JSON.stringify(audits[0].redactedDiff)).not.toContain(
      'confidential-filter',
    );

    // 2. ViewController.create (REST with userWorkspaceId + auditIdentity)
    const restCreated = await viewController.create(
      {
        name: 'REST Deals View',
        objectMetadataId,
        icon: 'IconTable',
        type: ViewType.TABLE,
        visibility: ViewVisibility.UNLISTED,
      } as never,
      { id: workspaceId } as never,
      undefined,
      identity() as never,
      actorUserWorkspaceId,
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'create',
      resourceKind: 'coreView',
      resourceId: restCreated.id,
    });
    expect(audits[1].redactedDiff.values.createdByUserWorkspaceId).toEqual({
      before: null,
      after: actorUserWorkspaceId,
    });

    // 3. CompleteViewUpsertService.upsertCompleteView (create + non-security update)
    const upsertedView = await completeViewUpsertService.upsertCompleteView({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      objectMetadataId,
      name: 'AI Created View',
      icon: 'IconSparkles',
      type: ViewType.TABLE,
      visibility: ViewVisibility.WORKSPACE,
      auditIdentity: identity(),
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      action: 'create',
      resourceKind: 'coreView',
      resourceId: upsertedView.id,
    });

    // Non-security update via upsertCompleteView (only name) must not emit noisy audit
    await completeViewUpsertService.upsertCompleteView({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      existingViewId: upsertedView.id,
      objectMetadataId,
      name: 'AI Renamed View',
      auditIdentity: identity(),
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(3);

    // 4. Hard delete custom view with pinned navigationMenuItem -> both audited under ONE operationId
    const navId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."navigationMenuItem"
        (id, "universalIdentifier", "workspaceId", "applicationId", type, "viewId", name)
       VALUES ($1,$2,$3,$4,'VIEW',$5,'Pinned View')`,
      [navId, randomUUID(), workspaceId, customApplicationId, createdUnlisted.id],
    );

    await viewResolver.deleteView(
      createdUnlisted.id,
      { id: workspaceId } as never,
      { req: identity() },
      actorUserWorkspaceId,
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    const deleteAudits = audits.slice(3);
    expect(deleteAudits[0].operationId).toBe(deleteAudits[1].operationId);
    const viewDeleteAudit = deleteAudits.find(
      (row: { resourceKind: string }) => row.resourceKind === 'coreView',
    );
    const navDeleteAudit = deleteAudits.find(
      (row: { resourceKind: string }) =>
        row.resourceKind === 'navigationMenuItem',
    );
    expect(viewDeleteAudit).toMatchObject({
      action: 'delete',
      resourceKind: 'coreView',
      resourceId: createdUnlisted.id,
      actor: { kind: 'workspaceMember', id: actorMemberId },
    });
    expect(navDeleteAudit).toMatchObject({
      action: 'delete',
      resourceKind: 'navigationMenuItem',
      resourceId: navId,
    });

    // 5. Overridden standard view deactivation (shouldDeactivate === true) -> coreView:update with isActive true -> false
    const standardViewId = randomUUID().toLowerCase();
    const standardViewUid = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core.view
        (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
         name, icon, type, visibility, "isCustom", "isActive", "isSystemSideEffect")
       VALUES ($1,$2,$3,$4,$5,'All Opportunities','IconList','TABLE','WORKSPACE',false,true,false)`,
      [
        standardViewId,
        standardViewUid,
        workspaceId,
        standardApplicationId,
        objectMetadataId,
      ],
    );

    await viewController.delete(
      standardViewId,
      { id: workspaceId } as never,
      identity() as never,
      actorUserWorkspaceId,
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(6);
    expect(audits[5]).toMatchObject({
      action: 'update',
      resourceKind: 'coreView',
      resourceId: standardViewId,
      actor: { kind: 'workspaceMember', id: actorMemberId },
    });
    expect(audits[5].redactedDiff.values).toEqual({
      isActive: { before: true, after: false },
    });
    expect(audits[5].redactedDiff.changedFields).toEqual(
      expect.arrayContaining(['isActive', 'overrides']),
    );
    expect(audits[5].redactedDiff.values.overrides).toBeUndefined();
  });

  it('enforces stateful fail-closed barrier for view create, delete, and override reset while allowing non-security UI updates', async () => {
    const { migrationRunner, viewService } = createHarness();

    // Unaudited view:create is blocked
    const unauditedViewId = randomUUID().toLowerCase();
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'create',
              metadataName: 'view',
              id: unauditedViewId,
              flatEntity: {
                id: unauditedViewId,
                universalIdentifier: randomUUID().toLowerCase(),
                objectMetadataUniversalIdentifier,
                applicationUniversalIdentifier:
                  customApplicationUniversalIdentifier,
                name: 'Rogue View',
              },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Seed an overridden deactivated view
    const viewId = randomUUID().toLowerCase();
    const viewUid = randomUUID().toLowerCase();
    const initialOverrides = {
      [customApplicationUniversalIdentifier]: { isActive: false },
    };
    await ownerDataSource.query(
      `INSERT INTO core.view
        (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
         name, icon, type, visibility, "isCustom", "isActive", overrides)
       VALUES ($1,$2,$3,$4,$5,'Standard View','IconList','TABLE','WORKSPACE',false,true,$6::jsonb)`,
      [
        viewId,
        viewUid,
        workspaceId,
        standardApplicationId,
        objectMetadataId,
        JSON.stringify(initialOverrides),
      ],
    );

    // Unaudited universalOverrides: null (reactivating deactivated view!) MUST be blocked
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'view',
              universalIdentifier: viewUid,
              update: {
                universalOverrides: null,
              },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Unaudited legacy-shaped universalOverrides with *UniversalIdentifier key activating view MUST be blocked
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'view',
              universalIdentifier: viewUid,
              update: {
                universalOverrides: {
                  isActive: true,
                  calendarFieldMetadataUniversalIdentifier:
                    fieldMetadataUniversalIdentifier,
                },
              },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Unaudited view:delete MUST be blocked
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'view',
              universalIdentifier: viewUid,
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Non-security UI override update (changing name while preserving isActive: false) is ALLOWED without audit scope
    await migrationRunner.run({
      workspaceId,
      workspaceMigration: {
        applicationUniversalIdentifier: customApplicationUniversalIdentifier,
        actions: [
          {
            type: 'update',
            metadataName: 'view',
            universalIdentifier: viewUid,
            update: {
              universalOverrides: {
                [customApplicationUniversalIdentifier]: {
                  isActive: false,
                  name: 'Renamed Standard View',
                },
              },
            },
          },
        ] as never,
      },
    });
    expect(await readAuditRows()).toHaveLength(0);

    // Creating an UNLISTED view without userWorkspaceId is rejected
    await expect(
      viewService.createOne({
        createViewInput: {
          name: 'Orphan Unlisted',
          objectMetadataId,
          icon: 'IconLock',
          type: ViewType.TABLE,
          visibility: ViewVisibility.UNLISTED,
        } as never,
        workspaceId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Unlisted view create requires an authenticated creator userWorkspaceId',
    );

    // Spoofing createdByUserWorkspaceId during coreViewCreate is rejected
    const spoofedViewId = randomUUID().toLowerCase();
    const getCreateAudit = captureCoreViewCreateAudit({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      auditIdentity: identity(),
    });
    await expect(
      withCoreViewAudit(getCreateAudit(spoofedViewId), () =>
        migrationRunner.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier:
              customApplicationUniversalIdentifier,
            actions: [
              {
                type: 'create',
                metadataName: 'view',
                id: spoofedViewId,
                flatEntity: {
                  id: spoofedViewId,
                  universalIdentifier: randomUUID().toLowerCase(),
                  objectMetadataUniversalIdentifier,
                  applicationUniversalIdentifier:
                    customApplicationUniversalIdentifier,
                  name: 'Spoofed Creator',
                  visibility: ViewVisibility.WORKSPACE,
                  createdByUserWorkspaceId: impersonatorUserWorkspaceId,
                },
              },
            ] as never,
          },
        }),
      ),
    ).rejects.toThrow(
      'Core view create persisted unexpected createdByUserWorkspaceId',
    );
  });

  it('audits coreView create/update/delete in application metadata and cascade migrations and blocks leftover rows on application delete', async () => {
    const { migrationRunner } = createHarness();

    // 1. Application metadata manifest create / update (isActive) / delete
    const appViewId = randomUUID().toLowerCase();
    const appViewUid = randomUUID().toLowerCase();

    const getAppCreate = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: thirdPartyApplicationId,
      applicationUniversalIdentifier: thirdPartyApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });
    await withApplicationMetadataAudit(getAppCreate(), () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'create',
              metadataName: 'view',
              id: appViewId,
              flatEntity: {
                id: appViewId,
                universalIdentifier: appViewUid,
                objectMetadataUniversalIdentifier,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalIdentifier,
                name: 'App Manifest View',
                icon: 'IconApps',
                type: ViewType.TABLE,
                visibility: ViewVisibility.WORKSPACE,
              },
            },
          ] as never,
        },
      }),
    );

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'create',
      resourceKind: 'coreView',
      resourceId: appViewId,
    });

    // Leftover own core.view blocks application delete
    const checkRunner = ownerDataSource.createQueryRunner();
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

    // Manifest update changing isActive -> false
    const getAppUpdate = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: thirdPartyApplicationId,
      applicationUniversalIdentifier: thirdPartyApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });
    await withApplicationMetadataAudit(getAppUpdate(), () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'view',
              universalIdentifier: appViewUid,
              update: { isActive: false },
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'update',
      resourceKind: 'coreView',
      resourceId: appViewId,
    });
    expect(audits[1].redactedDiff.values).toEqual({
      isActive: { before: true, after: false },
    });

    // Manifest delete
    const getAppDelete = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: thirdPartyApplicationId,
      applicationUniversalIdentifier: thirdPartyApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });
    await withApplicationMetadataAudit(getAppDelete(), () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'view',
              universalIdentifier: appViewUid,
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      action: 'delete',
      resourceKind: 'coreView',
      resourceId: appViewId,
    });

    // 2. Cascade delete of customApplication view via thirdParty field kanbanAggregateOperationFieldMetadataId
    const tpFieldId = randomUUID().toLowerCase();
    const tpFieldUid = randomUUID().toLowerCase();
    const kanbanViewId = randomUUID().toLowerCase();
    const kanbanViewUid = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO core."fieldMetadata"
        (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", type, name, label)
       VALUES ($1,$2,$3,$4,$5,'NUMBER','score','Score')`,
      [
        tpFieldId,
        workspaceId,
        thirdPartyApplicationId,
        tpFieldUid,
        objectMetadataId,
      ],
    );
    await ownerDataSource.query(
      `INSERT INTO core.view
        (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
         "kanbanAggregateOperationFieldMetadataId", name, type)
       VALUES ($1,$2,$3,$4,$5,$6,'Kanban By Score','KANBAN')`,
      [
        kanbanViewId,
        kanbanViewUid,
        workspaceId,
        customApplicationId,
        objectMetadataId,
        tpFieldId,
      ],
    );

    // Leftover dependent core.view via kanbanAggregateOperationFieldMetadataId blocks thirdParty app delete
    const checkRunner2 = ownerDataSource.createQueryRunner();
    await checkRunner2.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner2,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await checkRunner2.release();
    }

    // Deleting tpField under fieldDelete audits cascaded deletion of foreign customApplication view
    const fieldDeleteOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        mode: 'fieldDelete',
        expectedDeletedFieldId: tpFieldId,
        auditIdentity: identity(),
      }),
      {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier:
          thirdPartyApplicationUniversalIdentifier,
      },
    );
    await withApplicationMetadataAudit(fieldDeleteOp, () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'fieldMetadata',
              universalIdentifier: tpFieldUid,
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(4);
    expect(audits[3]).toMatchObject({
      action: 'delete',
      resourceKind: 'coreView',
      resourceId: kanbanViewId,
    });

    // After removal, assertNoRemainingApplicationRoleOrPermissionMetadata passes
    const checkRunner3 = ownerDataSource.createQueryRunner();
    await checkRunner3.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner3,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await checkRunner3.release();
    }

    // 3. Navigation cascade with expectedCreatedObjectId audits initial view creation
    const newObjectId = randomUUID().toLowerCase();
    const newObjectUid = randomUUID().toLowerCase();
    const initialViewId = randomUUID().toLowerCase();
    const initialViewUid = randomUUID().toLowerCase();
    const getCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: identity(),
    });
    await withNavigationMenuItemAudit(
      getCascade({ expectedCreatedObjectId: newObjectId }),
      () =>
        migrationRunner.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier:
              customApplicationUniversalIdentifier,
            actions: [
              {
                type: 'create',
                metadataName: 'objectMetadata',
                id: newObjectId,
                flatEntity: {
                  id: newObjectId,
                  universalIdentifier: newObjectUid,
                  applicationUniversalIdentifier:
                    customApplicationUniversalIdentifier,
                },
                universalFlatFieldMetadatas: [],
              },
              {
                type: 'create',
                metadataName: 'view',
                id: initialViewId,
                flatEntity: {
                  id: initialViewId,
                  universalIdentifier: initialViewUid,
                  objectMetadataUniversalIdentifier: newObjectUid,
                  applicationUniversalIdentifier:
                    customApplicationUniversalIdentifier,
                  name: 'All New Objects',
                  icon: 'IconList',
                  type: ViewType.TABLE,
                  visibility: ViewVisibility.WORKSPACE,
                },
              },
            ] as never,
          },
        }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    expect(audits[4]).toMatchObject({
      action: 'create',
      resourceKind: 'coreView',
      resourceId: initialViewId,
    });
  });

  it('rolls back coreView create and deactivation on audit flush failure and on post-flush row drift', async () => {
    const { viewService } = createHarness();

    // 1. Audit flush failure rolls back coreView:create
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_view_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'coreView' THEN
          RAISE EXCEPTION 'simulated view audit flush failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_on_view_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_on_view_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_view_audit();
    `);

    try {
      await expect(
        viewService.createOne({
          createViewInput: {
            name: 'Rolled Back View',
            objectMetadataId,
            icon: 'IconTable',
            type: ViewType.TABLE,
            visibility: ViewVisibility.WORKSPACE,
          } as never,
          workspaceId,
          createdByUserWorkspaceId: actorUserWorkspaceId,
          auditIdentity: identity(),
        }),
      ).rejects.toThrow('simulated view audit flush failure');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_on_view_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_on_view_audit();`,
      );
    }

    expect(
      await ownerDataSource.query(
        `SELECT id FROM core.view WHERE "workspaceId" = $1`,
        [workspaceId],
      ),
    ).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);

    // 2. Post-flush row drift rolls back coreView:create transaction
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.drift_view_after_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'coreView' AND NEW.action = 'create' THEN
          UPDATE core.view SET name = 'Drifted Name' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_drift_view_after_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_drift_view_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.drift_view_after_audit();
    `);

    try {
      await expect(
        viewService.createOne({
          createViewInput: {
            name: 'Drift Victim View',
            objectMetadataId,
            icon: 'IconTable',
            type: ViewType.TABLE,
            visibility: ViewVisibility.WORKSPACE,
          } as never,
          workspaceId,
          createdByUserWorkspaceId: actorUserWorkspaceId,
          auditIdentity: identity(),
        }),
      ).rejects.toThrow('Core view state changed during audit flush');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_drift_view_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.drift_view_after_audit();`,
      );
    }

    expect(
      await ownerDataSource.query(
        `SELECT id FROM core.view WHERE "workspaceId" = $1`,
        [workspaceId],
      ),
    ).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
  });
});
