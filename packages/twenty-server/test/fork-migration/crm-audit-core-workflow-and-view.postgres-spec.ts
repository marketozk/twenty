import { randomUUID } from 'node:crypto';
import {
  ViewOpenRecordIn,
  ViewType,
  ViewVisibility,
} from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';

const WorkflowVisibility = {
  WORKSPACE: 'WORKSPACE' as never,
  UNLISTED: 'UNLISTED' as never,
} as const;
import {
  captureApplicationMetadataAudit,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { WorkflowQueryValidationExceptionCode } from 'src/modules/workflow/common/exceptions/workflow-query-validation.exception';

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
    'src/engine/core-modules/workflow/entities/workflow.entity',
    ['WorkflowEntity'],
  ],
  [
    'src/engine/core-modules/workflow/entities/workflow-version.entity',
    ['WorkflowVersionEntity', 'WorkflowVersionStatus'],
  ],
  [
    'src/engine/core-modules/workflow/services/core-workflow-list.service',
    ['CoreWorkflowListService'],
  ],
  [
    'src/engine/core-modules/workflow/services/core-workflow-version-list.service',
    ['CoreWorkflowVersionListService'],
  ],
  [
    'src/engine/core-modules/workflow/services/core-workflow-version-write.service',
    ['CoreWorkflowVersionWriteService'],
  ],
  [
    'src/engine/core-modules/workflow/services/core-workflow-access.service',
    ['CoreWorkflowAccessService'],
  ],
  [
    'src/engine/core-modules/workflow/services/workflow-run-record-share.service',
    ['WorkflowRunRecordShareService'],
  ],
  [
    'src/engine/core-modules/workflow/services/workflow-core-sync.service',
    ['WorkflowCoreSyncService'],
  ],
  [
    'src/engine/core-modules/workflow/services/workflow-version-core-sync.service',
    ['WorkflowVersionCoreSyncService'],
  ],
  [
    'src/engine/core-modules/workflow/filters/workflow-query-validation-graphql-api-exception.filter',
    ['WorkflowQueryValidationGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
    ['PreventNestToAutoLogGraphqlErrorsFilter'],
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
    'src/engine/core-modules/auth/filters/auth-rest-api-exception.filter',
    ['AuthRestApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/command-menu-item/command-menu-item.service',
    ['CommandMenuItemService'],
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
    'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
    ['ApplicationTranslationCatalogService'],
  ],
  ['src/engine/metadata-modules/view/entities/view.entity', ['ViewEntity']],
  [
    'src/engine/metadata-modules/view/services/view-widget-upsert.service',
    ['ViewWidgetUpsertService'],
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
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-rest-api-exception.filter',
    ['PermissionsRestApiExceptionFilter'],
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
    'src/engine/workspace-manager/workspace-migration/filters/workspace-migration-runner-rest-api-exception.filter',
    ['WorkspaceMigrationRunnerRestApiExceptionFilter'],
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
    'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
    ['WorkspaceScopedRepository'],
  ],
  [
    'src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service',
    ['WorkflowVersionStepOperationsWorkspaceService'],
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
    'src/engine/decorators/auth/auth-workspace-member.decorator',
    ['AuthWorkspaceMember'],
  ],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  ['src/engine/decorators/locale/request-locale.decorator', ['RequestLocale']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { CoreWorkflowMutationWorkspaceService } =
  require('src/engine/core-modules/workflow/services/core-workflow-mutation.workspace-service') as typeof import('src/engine/core-modules/workflow/services/core-workflow-mutation.workspace-service');
const { CoreWorkflowResolver } =
  require('src/engine/core-modules/workflow/resolvers/core-workflow.resolver') as typeof import('src/engine/core-modules/workflow/resolvers/core-workflow.resolver');
const { ViewService } =
  require('src/engine/metadata-modules/view/services/view.service') as typeof import('src/engine/metadata-modules/view/services/view.service');
const { ViewResolver } =
  require('src/engine/metadata-modules/view/resolvers/view.resolver') as typeof import('src/engine/metadata-modules/view/resolvers/view.resolver');
const { ViewController } =
  require('src/engine/metadata-modules/view/controllers/view.controller') as typeof import('src/engine/metadata-modules/view/controllers/view.controller');
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

const databaseRole = `wf_view_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorMemberId = randomUUID();
const secondUserId = randomUUID();
const secondUserWorkspaceId = randomUUID();
const secondMemberId = randomUUID();
const customApplicationId = randomUUID();
const customApplicationUniversalIdentifier = randomUUID();
const objectMetadataId = randomUUID();
const objectMetadataUniversalIdentifier = randomUUID();
const workflowId = randomUUID();
const workflowUniversalIdentifier = randomUUID();
const viewId = randomUUID();
const viewUniversalIdentifier = randomUUID();

const workspaceSchema = `workspace_${workspaceId.replaceAll('-', '')}`;

const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-wf-view-fixture';

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

const identity = (
  _userId = actorUserId,
  _userWorkspaceId = actorUserWorkspaceId,
  memberId = actorMemberId,
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: memberId,
  },
});

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, "resourceKind" ASC, "resourceId" ASC`,
  );

const readDeferredIntents = () =>
  ownerDataSource.query(
    `SELECT id, "workspaceId", "applicationUniversalIdentifier", name, payload, status, attempts
       FROM core."deferredWorkspaceMigrationAction"
      ORDER BY id ASC`,
  );

const createHarness = () => {
  const invalidateFlatEntityMaps = jest.fn().mockResolvedValue(undefined);
  const invalidateAndRecompute = jest.fn().mockResolvedValue(undefined);
  const syncRunsOfCoreWorkflows = jest.fn().mockResolvedValue(undefined);
  const replaceSharesSpy = jest.fn().mockResolvedValue(undefined);

  const buildScopedWorkflowRepository = (runner?: QueryRunner) => ({
    manager: { connection: runtimeDataSource },
    withManager: (manager: { queryRunner?: QueryRunner }) =>
      buildScopedWorkflowRepository(manager?.queryRunner),
    update: async (
      wsId: string,
      _criteria: unknown,
      partial: { visibility: string; createdByUserWorkspaceId: string },
    ) => {
      const executor = runner ?? runtimeDataSource;
      const rows = await executor.query(
        `UPDATE core.workflow
            SET visibility = $1,
                "createdByUserWorkspaceId" = $2,
                "updatedAt" = now()
          WHERE "workspaceId" = $3
            AND id = $4
            AND ("createdByUserWorkspaceId" IS NULL OR "createdByUserWorkspaceId" = $2)
          RETURNING id`,
        [
          partial.visibility,
          partial.createdByUserWorkspaceId,
          wsId,
          workflowId,
        ],
      );
      return { affected: rows.length, raw: rows, generatedMaps: [] };
    },
  });

  const coreWorkflowAccessService = {
    assertCoreWorkflowsAreEditableOrThrow: jest
      .fn()
      .mockResolvedValue(undefined),
  };

  const workflowRunRecordShareService = {
    updateAccessThenSyncRuns: jest.fn(
      async ({
        updateAccess,
      }: {
        workspaceId: string;
        coreWorkflowId: string;
        updateAccess: () => Promise<unknown>;
      }) => {
        const result = await updateAccess();
        await replaceSharesSpy();
        return result;
      },
    ),
    syncRunsOfCoreWorkflows,
  };

  const coreWorkflowListService = {
    findOneById: jest.fn(
      async ({ coreWorkflowId }: { coreWorkflowId: string }) => {
        const [row] = await ownerDataSource.query(
          `SELECT id, visibility, "createdByUserWorkspaceId" FROM core.workflow WHERE id = $1`,
          [coreWorkflowId],
        );
        return row ?? null;
      },
    ),
  };

  const readFlatMaps = async () => {
    const wfRows = await ownerDataSource.query(
      `SELECT id, "universalIdentifier", "workspaceId", "applicationId", name, visibility, "createdByUserWorkspaceId", "isSystem"
         FROM core.workflow
        WHERE "workspaceId" = $1 AND "deletedAt" IS NULL`,
      [workspaceId],
    );
    const flatWorkflowByUid: Record<string, Record<string, unknown>> = {};
    const flatWorkflowIdByUid: Record<string, string> = {};
    for (const r of wfRows) {
      flatWorkflowByUid[r.universalIdentifier] = {
        ...r,
        applicationUniversalIdentifier: customApplicationUniversalIdentifier,
      };
      flatWorkflowIdByUid[r.universalIdentifier] = r.id;
    }

    const viewRows = await ownerDataSource.query(
      `SELECT id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId", name, icon, type, visibility, "createdByUserWorkspaceId", "isCustom", "isActive", "isSystemSideEffect", "isCompact", "shouldHideEmptyGroups", "groupLoadLimit", "openRecordIn", position, overrides
         FROM core.view
        WHERE "workspaceId" = $1 AND "deletedAt" IS NULL`,
      [workspaceId],
    );
    const flatViewByUid: Record<string, Record<string, unknown>> = {};
    const flatViewIdByUid: Record<string, string> = {};
    for (const v of viewRows) {
      flatViewByUid[v.universalIdentifier] = {
        ...v,
        applicationUniversalIdentifier: customApplicationUniversalIdentifier,
        objectMetadataUniversalIdentifier,
        calendarFieldMetadataId: null,
        calendarFieldMetadataUniversalIdentifier: null,
        calendarEndFieldMetadataId: null,
        calendarEndFieldMetadataUniversalIdentifier: null,
        kanbanAggregateOperation: null,
        kanbanAggregateOperationFieldMetadataId: null,
        kanbanAggregateOperationFieldMetadataUniversalIdentifier: null,
        mainGroupByFieldMetadataId: null,
        mainGroupByFieldMetadataUniversalIdentifier: null,
        kanbanColumnWidth: null,
        calendarLayout: null,
        anyFieldFilterValue: null,
        key: null,
        universalOverrides: null,
        viewFieldIds: [],
        viewFieldUniversalIdentifiers: [],
        viewFilterIds: [],
        viewFilterUniversalIdentifiers: [],
        viewGroupIds: [],
        viewGroupUniversalIdentifiers: [],
        viewFieldGroupIds: [],
        viewFieldGroupUniversalIdentifiers: [],
        viewFilterGroupIds: [],
        viewFilterGroupUniversalIdentifiers: [],
        navigationMenuItemIds: [],
        navigationMenuItemUniversalIdentifiers: [],
        viewSortIds: [],
        viewSortUniversalIdentifiers: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      flatViewIdByUid[v.universalIdentifier] = v.id;
    }

    return {
      flatWorkflowMaps: {
        byUniversalIdentifier: flatWorkflowByUid,
        universalIdentifierById: Object.fromEntries(
          Object.entries(flatWorkflowIdByUid).map(([uid, id]) => [id, uid]),
        ),
        universalIdentifiersByApplicationId: {},
      },
      flatViewMaps: {
        byUniversalIdentifier: flatViewByUid,
        universalIdentifierById: Object.fromEntries(
          Object.entries(flatViewIdByUid).map(([uid, id]) => [id, uid]),
        ),
        universalIdentifiersByApplicationId: {},
      },
      flatFieldMetadataMaps: {
        byUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      flatViewGroupMaps: {
        byUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [objectMetadataUniversalIdentifier]: {
            id: objectMetadataId,
            universalIdentifier: objectMetadataUniversalIdentifier,
            workspaceId,
            applicationId: customApplicationId,
            applicationUniversalIdentifier:
              customApplicationUniversalIdentifier,
          },
        },
        universalIdentifierById: {
          [objectMetadataId]: objectMetadataUniversalIdentifier,
        },
        universalIdentifiersByApplicationId: {},
      },
    };
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(() => readFlatMaps()),
    invalidateFlatEntityMaps,
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatApplicationMaps: {
        idByUniversalIdentifier: {
          [customApplicationUniversalIdentifier]: customApplicationId,
        },
        byId: {
          [customApplicationId]: {
            id: customApplicationId,
            universalIdentifier: customApplicationUniversalIdentifier,
            workspaceId,
          },
        },
      },
    })),
    invalidateAndRecompute,
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
          universalIdentifier: string;
          update?: Record<string, unknown>;
        };
        context: { queryRunner: QueryRunner };
      }) => {
        if (action.metadataName === 'view' && action.type === 'update') {
          const update = action.update ?? {};
          const setClauses: string[] = ['"updatedAt" = now()'];
          const params: unknown[] = [viewId, workspaceId];
          if ('name' in update && update.name !== undefined) {
            params.push(update.name);
            setClauses.push(`name = $${params.length}`);
          }
          if ('icon' in update && update.icon !== undefined) {
            params.push(update.icon);
            setClauses.push(`icon = $${params.length}`);
          }
          if ('visibility' in update && update.visibility !== undefined) {
            params.push(update.visibility);
            setClauses.push(`visibility = $${params.length}`);
          }
          if (
            'createdByUserWorkspaceId' in update &&
            update.createdByUserWorkspaceId !== undefined
          ) {
            params.push(update.createdByUserWorkspaceId);
            setClauses.push(`"createdByUserWorkspaceId" = $${params.length}`);
          }
          await context.queryRunner.query(
            `UPDATE core.view SET ${setClauses.join(', ')} WHERE id = $1 AND "workspaceId" = $2`,
            params,
          );
        } else if (
          action.metadataName === 'workflow' &&
          action.type === 'update'
        ) {
          const update = action.update ?? {};
          const setClauses: string[] = ['"updatedAt" = now()'];
          const params: unknown[] = [workflowId, workspaceId];
          if ('visibility' in update && update.visibility !== undefined) {
            params.push(update.visibility);
            setClauses.push(`visibility = $${params.length}`);
          }
          if (
            'createdByUserWorkspaceId' in update &&
            update.createdByUserWorkspaceId !== undefined
          ) {
            params.push(update.createdByUserWorkspaceId);
            setClauses.push(`"createdByUserWorkspaceId" = $${params.length}`);
          }
          await context.queryRunner.query(
            `UPDATE core.workflow SET ${setClauses.join(', ')} WHERE id = $1 AND "workspaceId" = $2`,
            params,
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

  const enqueueDeferred = jest.fn().mockResolvedValue(undefined);
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
      enqueue: enqueueDeferred,
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
            flatEntityToUpdate: Array<Record<string, unknown>>;
          };
        };
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const flatMaps = await readFlatMaps();
        const existingView =
          flatMaps.flatViewMaps.byUniversalIdentifier[viewUniversalIdentifier];
        const nextView =
          allFlatEntityOperationByMetadataName.view?.flatEntityToUpdate[0];
        const update: Record<string, unknown> = {};
        if (nextView && existingView) {
          for (const key of [
            'name',
            'icon',
            'visibility',
            'createdByUserWorkspaceId',
          ]) {
            if (nextView[key] !== existingView[key]) {
              update[key] = nextView[key];
            }
          }
        }
        const actions =
          Object.keys(update).length > 0
            ? [
                {
                  type: 'update',
                  metadataName: 'view',
                  universalIdentifier: viewUniversalIdentifier,
                  update,
                },
              ]
            : [];
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

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async () => ({
        workspaceCustomFlatApplication: {
          id: customApplicationId,
          universalIdentifier: customApplicationUniversalIdentifier,
          workspaceId,
        },
        twentyStandardFlatApplication: {
          id: randomUUID(),
          universalIdentifier: randomUUID(),
          workspaceId,
        },
      }),
    ),
  };

  const workflowMutationService = new CoreWorkflowMutationWorkspaceService(
    buildScopedWorkflowRepository() as never,
    {} as never,
    {} as never,
    coreWorkflowAccessService as never,
    {} as never,
    coreWorkflowListService as never,
    {} as never,
    {} as never,
    {} as never,
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
    workflowRunRecordShareService as never,
  );

  const workflowResolver = new CoreWorkflowResolver(
    coreWorkflowListService as never,
    workflowMutationService,
    {} as never,
  );

  const viewService = new ViewService(
    {} as never,
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
  );

  const viewResolver = new ViewResolver(
    viewService,
    flatEntityMapsCacheService as never,
    {} as never,
  );

  const viewController = new ViewController(
    viewService,
    flatEntityMapsCacheService as never,
    {
      getI18nContextByApplicationId: jest.fn(async () => () => ({})),
    } as never,
  );

  return {
    workflowMutationService,
    workflowResolver,
    viewService,
    viewResolver,
    viewController,
    migrationRunner,
    actionHandlerRegistry,
    invalidateFlatEntityMaps,
    invalidateAndRecompute,
    syncRunsOfCoreWorkflows,
    replaceSharesSpy,
    enqueueDeferred,
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
     CREATE TABLE core.workflow (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       name text NULL,
       visibility varchar NOT NULL DEFAULT 'WORKSPACE',
       "isSystem" boolean NOT NULL DEFAULT false,
       "createdByUserWorkspaceId" uuid NULL REFERENCES core."userWorkspace"(id) ON DELETE SET NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core.view (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "objectMetadataId" uuid NOT NULL,
       name text NOT NULL DEFAULT 'All records',
       icon text NOT NULL DEFAULT 'IconList',
       type text NOT NULL DEFAULT 'TABLE',
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
       overrides jsonb NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."deferredWorkspaceMigrationAction" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       "workspaceId" uuid NOT NULL,
       "applicationUniversalIdentifier" uuid NOT NULL,
       name text NOT NULL,
       payload jsonb NOT NULL,
       position integer NOT NULL DEFAULT 0,
       "runByVersion" text NULL,
       status text NOT NULL DEFAULT 'PENDING',
       attempts integer NOT NULL DEFAULT 0
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
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-wf-view-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await ownerDataSource.query(
    `DROP TRIGGER IF EXISTS corrupt_wf_view_audit ON crm_audit."crmAuditEntry";
     DROP FUNCTION IF EXISTS crm_audit.corrupt_wf_view_audit();
     TRUNCATE core.workspace, core."user", core."deferredWorkspaceMigrationAction", crm_audit."crmAuditEntry", "${workspaceSchema}"."workspaceMember" CASCADE;`,
  );
  await ownerDataSource.query(
    `INSERT INTO core.workspace (id, "activationStatus") VALUES ($1, $2)`,
    [workspaceId, WorkspaceActivationStatus.ACTIVE],
  );
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email) VALUES ($1, 'owner@example.com'), ($2, 'second@example.com')`,
    [actorUserId, secondUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId")
     VALUES ($1, $2, $3), ($4, $2, $5)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      secondUserWorkspaceId,
      secondUserId,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId")
     VALUES ($1, $2), ($3, $4)`,
    [actorMemberId, actorUserId, secondMemberId, secondUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier")
     VALUES ($1, $2, $3)`,
    [customApplicationId, workspaceId, customApplicationUniversalIdentifier],
  );
  await ownerDataSource.query(
    `INSERT INTO core.workflow (id, "universalIdentifier", "workspaceId", "applicationId", name, visibility, "createdByUserWorkspaceId")
     VALUES ($1, $2, $3, $4, 'Lead routing', 'WORKSPACE', NULL)`,
    [workflowId, workflowUniversalIdentifier, workspaceId, customApplicationId],
  );
  await ownerDataSource.query(
    `INSERT INTO core.view (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId", name, icon, type, visibility, "createdByUserWorkspaceId", "openRecordIn")
     VALUES ($1, $2, $3, $4, $5, 'All Opportunities', 'IconList', $6, 'WORKSPACE', NULL, $7)`,
    [
      viewId,
      viewUniversalIdentifier,
      workspaceId,
      customApplicationId,
      objectMetadataId,
      ViewType.TABLE,
      ViewOpenRecordIn.SIDE_PANEL,
    ],
  );
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (runtimeDataSource.isInitialized) {
    await runtimeDataSource.destroy();
  }
  if (ownerDataSource.isInitialized) {
    await ownerDataSource.query(
      `DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
       DROP OWNED BY "${databaseRole}";
       DROP ROLE "${databaseRole}";`,
    );
    await ownerDataSource.destroy();
  }
});

describe('coreWorkflow and coreView ownership and visibility CRM audit', () => {
  it('audits claiming an ownerless coreWorkflow and changing visibility to UNLISTED with durable sync_workflowRunShares intent', async () => {
    const { workflowResolver, invalidateFlatEntityMaps, replaceSharesSpy } =
      createHarness();
    let intentsDuringShareSync: Array<Record<string, unknown>> = [];
    replaceSharesSpy.mockImplementationOnce(async () => {
      intentsDuringShareSync = await readDeferredIntents();
    });

    const updated = await workflowResolver.updateCoreWorkflowVisibility(
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      {
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
      },
      { req: identity() },
    );

    expect(updated).toEqual({
      id: workflowId,
      visibility: WorkflowVisibility.UNLISTED,
      createdByUserWorkspaceId: actorUserWorkspaceId,
    });
    expect(replaceSharesSpy).toHaveBeenCalledTimes(1);
    expect(invalidateFlatEntityMaps).toHaveBeenCalledWith({
      workspaceId,
      flatMapsKeys: ['flatWorkflowMaps'],
    });

    expect(intentsDuringShareSync).toHaveLength(1);
    expect(intentsDuringShareSync[0]).toMatchObject({
      workspaceId,
      applicationUniversalIdentifier: customApplicationUniversalIdentifier,
      name: 'sync_workflowRunShares',
      payload: { version: 1, coreWorkflowId: workflowId },
      status: 'PENDING',
      attempts: 0,
    });
    expect(await readDeferredIntents()).toEqual([]);

    const audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: {
        kind: 'workspaceMember',
        id: actorMemberId,
      },
      action: 'update',
      resourceKind: 'coreWorkflow',
      resourceId: workflowId,
      outcome: 'success',
      redactedDiff: {
        changedFields: ['createdByUserWorkspaceId', 'visibility'],
        values: {
          createdByUserWorkspaceId: {
            before: null,
            after: actorUserWorkspaceId,
          },
          visibility: {
            before: WorkflowVisibility.WORKSPACE,
            after: WorkflowVisibility.UNLISTED,
          },
        },
      },
      securityDescriptor: {
        resourceKind: 'coreWorkflow',
        resourceId: workflowId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
  });

  it('audits visibility-only transition by the existing owner and suppresses no-op repeat audit and duplicate intents', async () => {
    const { workflowMutationService, replaceSharesSpy } = createHarness();
    await ownerDataSource.query(
      `UPDATE core.workflow SET visibility = 'UNLISTED', "createdByUserWorkspaceId" = $1 WHERE id = $2`,
      [actorUserWorkspaceId, workflowId],
    );

    await workflowMutationService.updateWorkflowVisibility({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      coreWorkflowId: workflowId,
      visibility: WorkflowVisibility.WORKSPACE,
      auditIdentity: identity(),
    });

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].redactedDiff).toEqual({
      changedFields: ['visibility'],
      values: {
        visibility: {
          before: WorkflowVisibility.UNLISTED,
          after: WorkflowVisibility.WORKSPACE,
        },
      },
    });
    expect(replaceSharesSpy).toHaveBeenCalledTimes(1);
    expect(await readDeferredIntents()).toEqual([]);

    await workflowMutationService.updateWorkflowVisibility({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      coreWorkflowId: workflowId,
      visibility: WorkflowVisibility.WORKSPACE,
      auditIdentity: identity(),
    });

    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(replaceSharesSpy).toHaveBeenCalledTimes(1);
    expect(await readDeferredIntents()).toEqual([]);
  });

  it('rejects non-creator visibility changes with FORBIDDEN, actor/membership spoofing, and returns null for missing workflow without audit or share sync side effects', async () => {
    const { workflowMutationService, replaceSharesSpy } = createHarness();
    await ownerDataSource.query(
      `UPDATE core.workflow SET visibility = 'WORKSPACE', "createdByUserWorkspaceId" = $1 WHERE id = $2`,
      [actorUserWorkspaceId, workflowId],
    );

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(
          secondUserId,
          secondUserWorkspaceId,
          secondMemberId,
        ),
      }),
    ).rejects.toThrow(
      'Core workflow/view audit workspaceMember actor does not match caller userWorkspace',
    );

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: {
          workspaceId,
          actor: { kind: 'coreUser', id: secondUserId },
          correlationId: randomUUID(),
        },
      }),
    ).rejects.toThrow(
      'Core workflow/view audit caller membership user mismatch',
    );

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: secondUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(
          secondUserId,
          secondUserWorkspaceId,
          secondMemberId,
        ),
      }),
    ).rejects.toMatchObject({
      code: WorkflowQueryValidationExceptionCode.FORBIDDEN,
    });

    expect(replaceSharesSpy).not.toHaveBeenCalled();
    expect(await readAuditRows()).toEqual([]);
    expect(await readDeferredIntents()).toEqual([]);

    const missingResult =
      await workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: randomUUID(),
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(),
      });
    expect(missingResult).toBeNull();
    expect(replaceSharesSpy).not.toHaveBeenCalled();
    expect(await readAuditRows()).toEqual([]);
    expect(await readDeferredIntents()).toEqual([]);
  });

  it('runs best-effort share sync and cache invalidation on CoreAuditPostCommitError and NativeTransactionOutcomeUnknownError', async () => {
    const {
      workflowMutationService,
      syncRunsOfCoreWorkflows,
      invalidateFlatEntityMaps,
    } = createHarness();

    await ownerDataSource.query(
      `CREATE OR REPLACE FUNCTION crm_audit.corrupt_wf_view_audit()
       RETURNS trigger AS $$
       BEGIN
         UPDATE core.workflow SET visibility = 'WORKSPACE' WHERE id = TG_ARGV[0]::uuid;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER corrupt_wf_view_audit
       AFTER INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_wf_view_audit('${workflowId}');`,
    );

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Core workflow visibility state changed during audit flush',
    );

    await ownerDataSource.query(
      `DROP TRIGGER IF EXISTS corrupt_wf_view_audit ON crm_audit."crmAuditEntry";
       DROP FUNCTION IF EXISTS crm_audit.corrupt_wf_view_audit();`,
    );

    const origCreateQueryRunner =
      runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementationOnce((mode) => {
        const qr = origCreateQueryRunner(mode);
        const origConnect = qr.connect.bind(qr);
        jest.spyOn(qr, 'connect').mockImplementationOnce(async () => {
          const client = await origConnect();
          const origClientQuery = client.query.bind(client);
          const querySpy = jest
            .spyOn(client, 'query')
            .mockImplementation((...args: unknown[]) => {
              if (args[0] === 'COMMIT') {
                querySpy.mockRestore();
                return Promise.reject(
                  new Error(
                    'Simulated lost COMMIT ACK during workflow visibility update',
                  ),
                );
              }
              return (origClientQuery as (...a: unknown[]) => unknown)(...args);
            });
          return client;
        });
        return qr;
      });

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(syncRunsOfCoreWorkflows).toHaveBeenCalledWith({
      workspaceId,
      coreWorkflowIds: [workflowId],
    });
    expect(invalidateFlatEntityMaps).toHaveBeenCalledWith({
      workspaceId,
      flatMapsKeys: ['flatWorkflowMaps'],
    });

    jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementationOnce((mode) => {
        const qr = origCreateQueryRunner(mode);
        const origCommit = qr.commitTransaction.bind(qr);
        jest.spyOn(qr, 'commitTransaction').mockImplementationOnce(async () => {
          await origCommit();
          throw new Error(
            'Simulated post-commit failure after workflow visibility update',
          );
        });
        return qr;
      });

    await expect(
      workflowMutationService.updateWorkflowVisibility({
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        coreWorkflowId: workflowId,
        visibility: WorkflowVisibility.UNLISTED,
        auditIdentity: identity(),
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(syncRunsOfCoreWorkflows).toHaveBeenCalledTimes(2);
    expect(await readAuditRows()).toHaveLength(1);
    expect(await readDeferredIntents()).toHaveLength(1);
  });

  it('audits coreView visibility and ownership transitions across ViewResolver and ViewController while skipping non-security UI updates', async () => {
    const { viewResolver, viewController } = createHarness();

    await viewResolver.updateView(
      viewId,
      {
        id: viewId,
        visibility: ViewVisibility.UNLISTED,
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      { req: identity() },
    );

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: {
        kind: 'workspaceMember',
        id: actorMemberId,
      },
      action: 'update',
      resourceKind: 'coreView',
      resourceId: viewId,
      outcome: 'success',
      redactedDiff: {
        changedFields: ['createdByUserWorkspaceId', 'visibility'],
        values: {
          createdByUserWorkspaceId: {
            before: null,
            after: actorUserWorkspaceId,
          },
          visibility: {
            before: ViewVisibility.WORKSPACE,
            after: ViewVisibility.UNLISTED,
          },
        },
      },
      securityDescriptor: {
        resourceKind: 'coreView',
        resourceId: viewId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });

    await viewController.update(
      viewId,
      {
        id: viewId,
        visibility: ViewVisibility.WORKSPACE,
      },
      undefined,
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      identity() as never,
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1].redactedDiff).toEqual({
      changedFields: ['visibility'],
      values: {
        visibility: {
          before: ViewVisibility.UNLISTED,
          after: ViewVisibility.WORKSPACE,
        },
      },
    });

    await viewResolver.updateView(
      viewId,
      {
        id: viewId,
        name: 'Renamed Opportunities View',
        icon: 'IconTarget',
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    const [persistedView] = await ownerDataSource.query(
      `SELECT name, icon, visibility, "createdByUserWorkspaceId" FROM core.view WHERE id = $1`,
      [viewId],
    );
    expect(persistedView).toEqual({
      name: 'Renamed Opportunities View',
      icon: 'IconTarget',
      visibility: ViewVisibility.WORKSPACE,
      createdByUserWorkspaceId: actorUserWorkspaceId,
    });

    await expect(
      viewResolver.updateView(
        viewId,
        {
          id: viewId,
          visibility: ViewVisibility.UNLISTED,
        },
        { id: workspaceId } as never,
        secondUserWorkspaceId,
        { req: identity(secondUserId, secondUserWorkspaceId, secondMemberId) },
      ),
    ).rejects.toThrow(
      'Core view visibility or creator can only be changed by its creator',
    );

    await expect(
      viewResolver.updateView(
        viewId,
        {
          id: viewId,
          visibility: ViewVisibility.UNLISTED,
        },
        { id: workspaceId } as never,
        actorUserWorkspaceId,
        { req: identity(secondUserId, secondUserWorkspaceId, secondMemberId) },
      ),
    ).rejects.toThrow(
      'Core workflow/view audit workspaceMember actor does not match caller userWorkspace',
    );
  });

  it('audits workflow/view visibility updates inside application metadata migrations and blocks unaudited runner updates fail-closed', async () => {
    const { migrationRunner, actionHandlerRegistry, enqueueDeferred } =
      createHarness();
    await ownerDataSource.query(
      `UPDATE core.workflow SET visibility = 'UNLISTED', "createdByUserWorkspaceId" = $1 WHERE id = $2`,
      [actorUserWorkspaceId, workflowId],
    );
    await ownerDataSource.query(
      `UPDATE core.view SET visibility = 'UNLISTED', "createdByUserWorkspaceId" = $1 WHERE id = $2`,
      [actorUserWorkspaceId, viewId],
    );

    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'workflow',
              universalIdentifier: workflowUniversalIdentifier,
              update: { visibility: WorkflowVisibility.WORKSPACE },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'view',
              universalIdentifier: viewUniversalIdentifier,
              update: { visibility: ViewVisibility.WORKSPACE },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    actionHandlerRegistry.executeActionHandler.mockImplementationOnce(
      async ({ context }: { context: { queryRunner: QueryRunner } }) => {
        await context.queryRunner.query(
          `UPDATE core.workflow SET visibility = 'WORKSPACE', "createdByUserWorkspaceId" = NULL WHERE id = $1`,
          [workflowId],
        );
        return {
          partialOptimisticCache: {},
          metadataEvents: [],
          deferredActions: [],
        };
      },
    );

    const getUnplannedAudit = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: customApplicationId,
      applicationUniversalIdentifier: customApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });
    await expect(
      withApplicationMetadataAudit(getUnplannedAudit(), () =>
        migrationRunner.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier:
              customApplicationUniversalIdentifier,
            actions: [
              {
                type: 'update',
                metadataName: 'workflow',
                universalIdentifier: workflowUniversalIdentifier,
                update: { name: 'Renamed' },
              },
            ] as never,
          },
        }),
      ),
    ).rejects.toThrow(
      'Application metadata audit detected unplanned workflow visibility or creator mutation',
    );

    expect(await readAuditRows()).toEqual([]);

    const getAppAudit = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: customApplicationId,
      applicationUniversalIdentifier: customApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });

    await withApplicationMetadataAudit(getAppAudit(), () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'workflow',
              universalIdentifier: workflowUniversalIdentifier,
              update: {
                visibility: WorkflowVisibility.WORKSPACE,
                createdByUserWorkspaceId: null,
              },
            },
            {
              type: 'update',
              metadataName: 'view',
              universalIdentifier: viewUniversalIdentifier,
              update: {
                visibility: ViewVisibility.WORKSPACE,
                createdByUserWorkspaceId: null,
              },
            },
          ] as never,
        },
      }),
    );

    const audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits.map((a: { resourceKind: string }) => a.resourceKind)).toEqual(
      ['coreView', 'coreWorkflow'],
    );
    expect(audits[0].redactedDiff).toEqual({
      changedFields: ['createdByUserWorkspaceId', 'visibility'],
      values: {
        createdByUserWorkspaceId: {
          before: actorUserWorkspaceId,
          after: null,
        },
        visibility: {
          before: ViewVisibility.UNLISTED,
          after: ViewVisibility.WORKSPACE,
        },
      },
    });
    expect(audits[1].redactedDiff).toEqual({
      changedFields: ['createdByUserWorkspaceId', 'visibility'],
      values: {
        createdByUserWorkspaceId: {
          before: actorUserWorkspaceId,
          after: null,
        },
        visibility: {
          before: WorkflowVisibility.UNLISTED,
          after: WorkflowVisibility.WORKSPACE,
        },
      },
    });
    expect(await readDeferredIntents()).toHaveLength(1);
    expect(enqueueDeferred).toHaveBeenCalledWith(workspaceId);
  });
});
