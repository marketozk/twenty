import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type AllMetadataName } from 'twenty-shared/metadata';
import { FeatureFlagKey, FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  getApiKeyCreateAudit,
  runAuditedApiKeyCreate,
} from 'src/engine/core-modules/crm-audit/api-key-audit';
import {
  AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES,
  AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES,
  getApplicationMetadataAudit,
  isAuditedWorkflowOrViewUpdateAction,
  runAuditedApplicationMetadataMigration,
  type ApplicationMetadataAuditMappings,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  getCoreViewUpdateAudit,
  runAuditedCoreViewUpdate,
} from 'src/engine/core-modules/crm-audit/core-workflow-and-view-audit';
import {
  getNavigationMenuItemAudit,
  runAuditedNavigationMenuItemMigration,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import {
  getRoleAssignmentAudit,
  runAuditedRoleAssignment,
} from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  getRolePermissionAudit,
  runAuditedRolePermissionUpsert,
} from 'src/engine/core-modules/crm-audit/role-permission-audit';
import {
  getRoleMutationAudit,
  runAuditedRoleMutation,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { LoggerService } from 'src/engine/core-modules/logger/logger.service';
import { WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES } from 'src/engine/core-modules/metrics/constants/workspace-migration-duration-ms-bucket-boundaries.constant';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { getFlatEntityMapsExceptionContext } from 'src/engine/metadata-modules/flat-entity/utils/get-flat-entity-maps-exception-context.util';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { withDerivedFieldMetadataMaps } from 'src/engine/metadata-modules/flat-entity/utils/with-derived-field-metadata-maps.util';
import { createSearchFieldMetadatasByTsVectorFieldIdAccessor } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/create-search-field-metadatas-by-ts-vector-field-id-accessor.util';
import { WorkspaceMetadataVersionService } from 'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkspaceCacheKeyName } from 'src/engine/workspace-cache/types/workspace-cache-key.type';
import { WorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration.type';
import {
  WorkspaceMigrationRunnerException,
  WorkspaceMigrationRunnerExceptionCode,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-runner.exception';
import { InFlightDeferredWorkspaceMigrationActionsService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service';
import { SCHEMA_AFFECTING_WORKSPACE_MIGRATION_METADATA_NAMES } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/schema-affecting-workspace-migration-metadata-names.constant';
import { isSchemaAffectingWorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/is-schema-affecting-workspace-migration.util';
import { WorkspaceMigrationRunnerActionHandlerRegistryService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service';
import { DeferredWorkspaceMigrationActionRunnerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service';
import { type DeferredWorkspaceMigrationAction } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action.type';
import { type MetadataEvent } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/metadata-event.type';
import { getMetadataNamesToLoadForWorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/get-metadata-names-to-load-for-workspace-migration.util';
import { buildPreallocatedIdByUniversalIdentifierFromActions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/build-preallocated-id-by-universal-identifier-from-actions.util';

@Injectable()
export class WorkspaceMigrationRunnerService {
  constructor(
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
    private readonly workspaceMigrationRunnerActionHandlerRegistry: WorkspaceMigrationRunnerActionHandlerRegistryService,
    private readonly workspaceMetadataVersionService: WorkspaceMetadataVersionService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly metricsService: MetricsService,
    private readonly logger: LoggerService,
    private readonly twentyConfigService: TwentyConfigService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly deferredWorkspaceMigrationActionRunnerService: DeferredWorkspaceMigrationActionRunnerService,
    private readonly inFlightDeferredWorkspaceMigrationActionsService: InFlightDeferredWorkspaceMigrationActionsService,
  ) {}

  async invalidateCache({
    allFlatEntityMapsKeys,
    workspaceId,
    hasSchemaMetadataChanged = SCHEMA_AFFECTING_WORKSPACE_MIGRATION_METADATA_NAMES.some(
      (metadataName) =>
        allFlatEntityMapsKeys.includes(
          getMetadataFlatEntityMapsKey(metadataName),
        ),
    ),
    hasMorphRelationFieldChanged = false,
  }: {
    allFlatEntityMapsKeys: (keyof AllFlatEntityMaps)[];
    workspaceId: string;
    hasSchemaMetadataChanged?: boolean;
    hasMorphRelationFieldChanged?: boolean;
  }): Promise<void> {
    this.logger.perfTime(
      'Runner',
      `Cache invalidation ${allFlatEntityMapsKeys.join()}`,
    );

    const hasRolesPermissionsChanged = allFlatEntityMapsKeys.some(
      (flatEntityMapsKey) =>
        flatEntityMapsKey === 'flatRoleMaps' ||
        flatEntityMapsKey === 'flatRoleTargetMaps' ||
        flatEntityMapsKey === 'flatObjectPermissionMaps' ||
        flatEntityMapsKey === 'flatFieldPermissionMaps' ||
        flatEntityMapsKey === 'flatRolePermissionFlagMaps' ||
        flatEntityMapsKey === 'flatRowLevelPermissionPredicateMaps' ||
        flatEntityMapsKey === 'flatRowLevelPermissionPredicateGroupMaps',
    );

    const hasWorkflowVersionsChanged = allFlatEntityMapsKeys.includes(
      'flatWorkflowVersionMaps',
    );

    const hasApplicationVariablesChanged = allFlatEntityMapsKeys.includes(
      'flatApplicationVariableMaps',
    );

    const cacheKeyNamesToInvalidate: WorkspaceCacheKeyName[] = [
      ...new Set([
        ...withDerivedFieldMetadataMaps(allFlatEntityMapsKeys),
        ...(hasRolesPermissionsChanged || hasMorphRelationFieldChanged
          ? ['rolesPermissions' as const]
          : []),
        ...(hasWorkflowVersionsChanged
          ? ['workflowAutomatedTriggerMaps' as const]
          : []),
        ...(hasApplicationVariablesChanged
          ? ['userApplicationVariableValueMaps' as const]
          : []),
      ]),
    ];

    await this.workspaceCacheService.invalidateAndRecompute(
      workspaceId,
      cacheKeyNamesToInvalidate,
    );

    if (hasSchemaMetadataChanged) {
      await this.workspaceMetadataVersionService.incrementMetadataVersion(
        workspaceId,
      );
    }

    this.logger.perfTimeEnd(
      'Runner',
      `Cache invalidation ${allFlatEntityMapsKeys.join()}`,
    );
  }

  private recordRunPhaseMetric({
    phase,
    status,
    value,
  }: {
    phase:
      | 'initial-cache-retrieval'
      | 'flat-maps-clone'
      | 'action-execution'
      | 'commit'
      | 'cache-invalidation';
    status: 'success' | 'fail';
    value: number;
  }): void {
    this.metricsService.recordHistogram({
      key: MetricsKeys.WorkspaceMigrationRunPhaseDurationMs,
      value,
      unit: 'ms',
      attributes: { phase, status },
      bucketBoundaries: WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES,
    });
  }

  private async logBlockingDbActivity(): Promise<void> {
    try {
      // Metadata only (no query text) to avoid logging literals from other sessions.
      const rows = await this.coreDataSource.query(
        `SELECT pid, state, wait_event_type, wait_event,
                now() - query_start AS running_for, pg_blocking_pids(pid) AS blocked_by
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND state <> 'idle'
           AND pid <> pg_backend_pid()
         ORDER BY query_start ASC`,
      );

      this.logger.error(
        `[install-perf] active DB sessions at failure: ${JSON.stringify(rows)}`,
        'Runner',
      );
    } catch (snapshotError) {
      this.logger.error(
        `[install-perf] could not snapshot pg_stat_activity: ${
          snapshotError instanceof Error
            ? snapshotError.message
            : String(snapshotError)
        }`,
        'Runner',
      );
    }
  }

  run = async (args: {
    workspaceMigration: WorkspaceMigration;
    workspaceId: string;
  }): Promise<{
    allFlatEntityMaps: AllFlatEntityMaps;
    metadataEvents: MetadataEvent[];
    hasSchemaMetadataChanged: boolean;
  }> => {
    const runStart = performance.now();

    await this.throwIfSchemaAffectingDeferredActionsAreInProgress(args);

    try {
      const result = await this.executeRun(args);

      this.metricsService.recordHistogram({
        key: MetricsKeys.WorkspaceMigrationRunDurationMs,
        value: performance.now() - runStart,
        unit: 'ms',
        attributes: { status: 'success' },
        bucketBoundaries: WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES,
      });

      return result;
    } catch (error) {
      this.metricsService.recordHistogram({
        key: MetricsKeys.WorkspaceMigrationRunDurationMs,
        value: performance.now() - runStart,
        unit: 'ms',
        attributes: { status: 'fail' },
        bucketBoundaries: WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES,
      });

      throw error;
    }
  };

  private throwIfSchemaAffectingDeferredActionsAreInProgress = async ({
    workspaceMigration: { actions },
    workspaceId,
  }: {
    workspaceMigration: WorkspaceMigration;
    workspaceId: string;
  }): Promise<void> => {
    const featureFlagsMap =
      await this.featureFlagService.getWorkspaceFeatureFlagsMap(workspaceId);

    if (
      !featureFlagsMap[
        FeatureFlagKey.IS_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_ENABLED
      ] ||
      !isSchemaAffectingWorkspaceMigration(actions)
    ) {
      return;
    }

    await this.inFlightDeferredWorkspaceMigrationActionsService.throwIfSchemaAffectingActionsAreInProgress(
      workspaceId,
    );
  };

  private executeRun = async ({
    workspaceMigration: { actions, applicationUniversalIdentifier },
    workspaceId,
  }: {
    workspaceMigration: WorkspaceMigration;
    workspaceId: string;
  }): Promise<{
    allFlatEntityMaps: AllFlatEntityMaps;
    metadataEvents: MetadataEvent[];
    hasSchemaMetadataChanged: boolean;
  }> => {
    if (this.twentyConfigService.get('WORKSPACE_SCHEMA_DDL_LOCKED')) {
      throw new WorkspaceMigrationRunnerException({
        message:
          'Workspace schema DDL changes are locked. This is typically set during hot upgrades.',
        code: WorkspaceMigrationRunnerExceptionCode.DDL_LOCKED,
      });
    }

    this.logger.perfTime('Runner', 'Total execution');
    this.logger.perfTime('Runner', 'Initial cache retrieval');

    const initialCacheRetrievalStart = performance.now();

    const actionMetadataNames = [
      ...new Set(actions.flatMap((action) => action.metadataName)),
    ];
    const hasSchemaMetadataChanged =
      isSchemaAffectingWorkspaceMigration(actions);

    const hasSearchVectorRebuildAction = actions.some(
      (action) =>
        action.metadataName === 'fieldMetadata' &&
        action.type === 'update' &&
        action.rebuildSearchVector === true,
    );

    const searchVectorRebuildMetadataNames: AllMetadataName[] =
      hasSearchVectorRebuildAction ? ['index'] : [];

    const hasObjectOrFieldDeleteAction = actions.some(
      (action) =>
        action.type === 'delete' &&
        (action.metadataName === 'objectMetadata' ||
          action.metadataName === 'fieldMetadata'),
    );
    const hasNavCascadeParentDeleteAction = actions.some(
      (action) =>
        action.type === 'delete' &&
        (action.metadataName === 'view' ||
          action.metadataName === 'pageLayout' ||
          action.metadataName === 'agentChatChannel'),
    );
    const hasChannelRoleCascadeParentDeleteAction = actions.some(
      (action) =>
        action.type === 'delete' &&
        (action.metadataName === 'role' ||
          action.metadataName === 'agentChatChannel'),
    );
    const permissionCascadeMetadataNames: AllMetadataName[] = [
      ...(hasObjectOrFieldDeleteAction
        ? ([
            'objectPermission',
            'fieldPermission',
            'rowLevelPermissionPredicateGroup',
            'rowLevelPermissionPredicate',
            'view',
            'pageLayout',
            'navigationMenuItem',
          ] as const)
        : hasNavCascadeParentDeleteAction
          ? (['navigationMenuItem'] as const)
          : []),
      ...(hasChannelRoleCascadeParentDeleteAction
        ? (['agentChatChannelRole'] as const)
        : []),
    ];

    const actionsMetadataAndRelatedMetadataNames: AllMetadataName[] = [
      ...new Set([
        ...getMetadataNamesToLoadForWorkspaceMigration(actionMetadataNames),
        ...searchVectorRebuildMetadataNames,
        ...permissionCascadeMetadataNames,
      ]),
    ];
    const allFlatEntityMapsKeys = actionsMetadataAndRelatedMetadataNames.map(
      getMetadataFlatEntityMapsKey,
    );

    const cachedAllFlatEntityMaps =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps<
        typeof allFlatEntityMapsKeys
      >({
        workspaceId,
        flatMapsKeys: allFlatEntityMapsKeys,
      });

    this.logger.perfTimeEnd('Runner', 'Initial cache retrieval');

    const hasMorphRelationFieldChanged = actions.some(
      (action) =>
        action.metadataName === 'fieldMetadata' &&
        (action.type === 'create'
          ? action.flatEntity
          : cachedAllFlatEntityMaps.flatFieldMetadataMaps
              ?.byUniversalIdentifier[action.universalIdentifier]
        )?.type === FieldMetadataType.MORPH_RELATION,
    );

    const initialCacheRetrievalMs =
      performance.now() - initialCacheRetrievalStart;

    this.recordRunPhaseMetric({
      phase: 'initial-cache-retrieval',
      status: 'success',
      value: initialCacheRetrievalMs,
    });

    this.logger.perf(
      `[install-perf] Runner initial cache retrieval (getOrRecomputeManyOrAllFlatEntityMaps) took ${initialCacheRetrievalMs.toFixed(1)}ms for ${allFlatEntityMapsKeys.length} flat-maps keys`,
      'Runner',
    );

    const cloneStart = performance.now();

    let allFlatEntityMaps = structuredClone(cachedAllFlatEntityMaps);

    const cloneMs = performance.now() - cloneStart;

    this.recordRunPhaseMetric({
      phase: 'flat-maps-clone',
      status: 'success',
      value: cloneMs,
    });

    this.logger.perf(
      `[install-perf] Runner flat-maps clone took ${cloneMs.toFixed(1)}ms for ${allFlatEntityMapsKeys.length} flat-maps keys`,
      'Runner',
    );

    const { flatApplicationMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatApplicationMaps',
      ]);

    const applicationId =
      flatApplicationMaps.idByUniversalIdentifier[
        applicationUniversalIdentifier
      ];
    const flatApplication = isDefined(applicationId)
      ? flatApplicationMaps.byId[applicationId]
      : undefined;

    if (!isDefined(applicationId) || !isDefined(flatApplication)) {
      throw new WorkspaceMigrationRunnerException({
        message: `Could not find application for application with universal identifier: ${applicationUniversalIdentifier}`,
        code: WorkspaceMigrationRunnerExceptionCode.APPLICATION_NOT_FOUND,
      });
    }

    const preallocatedIdByUniversalIdentifierByMetadataName =
      buildPreallocatedIdByUniversalIdentifierFromActions(actions);

    const featureFlagsMap =
      await this.featureFlagService.getWorkspaceFeatureFlagsMap(workspaceId);

    const shouldPersistDeferredActions =
      featureFlagsMap[
        FeatureFlagKey.IS_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_ENABLED
      ];

    this.logger.perfTime('Runner', 'Transaction execution');

    const roleAudit = getRoleMutationAudit(workspaceId);
    const assignmentAudit = getRoleAssignmentAudit(workspaceId);
    const permissionAudit = getRolePermissionAudit(workspaceId);
    const apiKeyCreateAudit = getApiKeyCreateAudit(workspaceId);
    const applicationMetadataAudit = getApplicationMetadataAudit(workspaceId);
    const coreViewUpdateAudit = getCoreViewUpdateAudit(workspaceId);
    const navigationMenuItemAudit = getNavigationMenuItemAudit(workspaceId);
    if (
      [
        roleAudit,
        assignmentAudit,
        permissionAudit,
        apiKeyCreateAudit,
        applicationMetadataAudit,
        coreViewUpdateAudit,
        navigationMenuItemAudit,
      ].filter(Boolean).length > 1
    )
      throw new Error('Conflicting metadata audit owners');
    if (
      roleAudit ||
      assignmentAudit ||
      permissionAudit ||
      apiKeyCreateAudit ||
      coreViewUpdateAudit ||
      navigationMenuItemAudit
    ) {
      const hasSchemaMetadataChangedForAudit =
        isSchemaAffectingWorkspaceMigration(actions);
      try {
        const mappings = {
          application: flatApplication,
          roles: allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier ?? {},
          targets:
            allFlatEntityMaps.flatRoleTargetMaps?.byUniversalIdentifier ?? {},
          agents: allFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier ?? {},
          permissionFlags:
            allFlatEntityMaps.flatPermissionFlagMaps?.byUniversalIdentifier ??
            {},
          rolePermissionFlags:
            allFlatEntityMaps.flatRolePermissionFlagMaps
              ?.byUniversalIdentifier ?? {},
          objectMetadatas:
            allFlatEntityMaps.flatObjectMetadataMaps?.byUniversalIdentifier ??
            {},
          fieldMetadatas:
            allFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier ??
            {},
          objectPermissions:
            allFlatEntityMaps.flatObjectPermissionMaps?.byUniversalIdentifier ??
            {},
          fieldPermissions:
            allFlatEntityMaps.flatFieldPermissionMaps?.byUniversalIdentifier ??
            {},
          rowLevelPermissionPredicates:
            allFlatEntityMaps.flatRowLevelPermissionPredicateMaps
              ?.byUniversalIdentifier ?? {},
          rowLevelPermissionPredicateGroups:
            allFlatEntityMaps.flatRowLevelPermissionPredicateGroupMaps
              ?.byUniversalIdentifier ?? {},
          views: allFlatEntityMaps.flatViewMaps?.byUniversalIdentifier ?? {},
          navigationMenuItems:
            allFlatEntityMaps.flatNavigationMenuItemMaps
              ?.byUniversalIdentifier ?? {},
          pageLayouts:
            allFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier ?? {},
          agentChatChannels:
            allFlatEntityMaps.flatAgentChatChannelMaps?.byUniversalIdentifier ??
            {},
          agentChatChannelRoles:
            allFlatEntityMaps.flatAgentChatChannelRoleMaps
              ?.byUniversalIdentifier ?? {},
          webhooks:
            allFlatEntityMaps.flatWebhookMaps?.byUniversalIdentifier ?? {},
          skills: allFlatEntityMaps.flatSkillMaps?.byUniversalIdentifier ?? {},
        };
        const searchFieldMetadatasByTsVectorFieldIdAccessor =
          createSearchFieldMetadatasByTsVectorFieldIdAccessor(
            () => allFlatEntityMaps.flatSearchFieldMetadataMaps,
          );
        const execute = async (queryRunner: QueryRunner) => {
          const metadataEvents: MetadataEvent[] = [];
          const allDeferredActions: DeferredWorkspaceMigrationAction[] = [];
          for (const action of actions) {
            if (
              roleAudit &&
              (roleAudit.action === 'delete'
                ? !(
                    (action.metadataName === 'role' &&
                      action.type === 'delete' &&
                      allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier[
                        action.universalIdentifier
                      ]?.id === roleAudit.roleId) ||
                    (action.metadataName === 'roleTarget' &&
                      (action.type === 'delete' || action.type === 'create')) ||
                    (action.metadataName === 'agentChatChannelRole' &&
                      action.type === 'delete')
                  )
                : action.metadataName !== 'role' ||
                  (action.type === 'update'
                    ? allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier[
                        action.universalIdentifier
                      ]?.id !== roleAudit.roleId
                    : action.type !== 'create' ||
                      action.id !== roleAudit.roleId ||
                      roleAudit.action !== 'create' ||
                      flatApplication.id !== roleAudit.expected.applicationId ||
                      flatApplication.universalIdentifier !==
                        roleAudit.expected.applicationUniversalIdentifier))
            )
              throw new Error(
                'Audited role mutation resolved a different record or application',
              );
            const executed =
              await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionHandler(
                {
                  action,
                  context: {
                    flatApplication,
                    action,
                    allFlatEntityMaps,
                    queryRunner,
                    workspaceId,
                    preallocatedIdByUniversalIdentifierByMetadataName,
                    getSearchFieldMetadatasByTsVectorFieldId:
                      navigationMenuItemAudit
                        ? searchFieldMetadatasByTsVectorFieldIdAccessor.get
                        : () => [],
                    featureFlagsMap,
                  },
                },
              );
            if (executed.deferredActions.length && !navigationMenuItemAudit)
              throw new Error(
                'Audited role mutation cannot dispatch deferred actions',
              );
            allFlatEntityMaps = {
              ...allFlatEntityMaps,
              ...executed.partialOptimisticCache,
            } as typeof allFlatEntityMaps;
            if (action.metadataName === 'searchFieldMetadata') {
              searchFieldMetadatasByTsVectorFieldIdAccessor.invalidate();
            }
            metadataEvents.push(...executed.metadataEvents);
            allDeferredActions.push(...executed.deferredActions);
          }
          if (navigationMenuItemAudit && shouldPersistDeferredActions) {
            await this.deferredWorkspaceMigrationActionRunnerService.persist({
              deferredActions: allDeferredActions,
              workspaceId,
              applicationUniversalIdentifier,
              queryRunner,
            });
          }
          return {
            allFlatEntityMaps,
            metadataEvents,
            hasSchemaMetadataChanged: navigationMenuItemAudit
              ? hasSchemaMetadataChangedForAudit
              : false,
            allDeferredActions,
          };
        };
        const outcome = roleAudit
          ? await runAuditedRoleMutation(
              this.coreDataSource,
              roleAudit,
              actions,
              execute,
              mappings,
            )
          : assignmentAudit
            ? await runAuditedRoleAssignment(
                this.coreDataSource,
                assignmentAudit,
                actions,
                mappings,
                execute,
              )
            : permissionAudit
              ? await runAuditedRolePermissionUpsert(
                  this.coreDataSource,
                  permissionAudit,
                  actions,
                  mappings,
                  execute,
                )
              : coreViewUpdateAudit
                ? await runAuditedCoreViewUpdate(
                    this.coreDataSource,
                    coreViewUpdateAudit,
                    actions as never,
                    mappings,
                    execute,
                  )
                : navigationMenuItemAudit
                  ? await runAuditedNavigationMenuItemMigration(
                      this.coreDataSource,
                      navigationMenuItemAudit,
                      actions as never,
                      mappings,
                      execute,
                    )
                  : await runAuditedApiKeyCreate(
                      this.coreDataSource,
                      apiKeyCreateAudit!,
                      actions,
                      mappings,
                      execute,
                    );
        if (navigationMenuItemAudit && outcome.allDeferredActions.length > 0) {
          await this.deferredWorkspaceMigrationActionRunnerService.dispatchAfterCommit(
            {
              deferredActions: outcome.allDeferredActions,
              hasPersistedDeferredActions: shouldPersistDeferredActions,
              workspaceId,
              applicationUniversalIdentifier,
              allFlatEntityMaps: outcome.allFlatEntityMaps,
            },
          );
        }
        return {
          allFlatEntityMaps: outcome.allFlatEntityMaps,
          metadataEvents: outcome.metadataEvents,
          hasSchemaMetadataChanged: outcome.hasSchemaMetadataChanged,
        };
      } catch (error) {
        if (!navigationMenuItemAudit) {
          throw error;
        }
        const mayHaveCommitted =
          error instanceof NativeTransactionOutcomeUnknownError ||
          error instanceof CoreAuditPostCommitError;
        if (
          !mayHaveCommitted &&
          typeof this.workspaceMigrationRunnerActionHandlerRegistry
            .executeActionRollbackHandler === 'function'
        ) {
          const invertedActions = [...actions].reverse();
          for (const invertedAction of invertedActions) {
            await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionRollbackHandler(
              {
                action: invertedAction,
                context: {
                  flatApplication,
                  action: invertedAction,
                  allFlatEntityMaps,
                  workspaceId,
                },
              },
            );
          }
        }
        const exceptionContext = getFlatEntityMapsExceptionContext(error);
        if (
          mayHaveCommitted ||
          error instanceof WorkspaceMigrationRunnerException ||
          !isDefined(exceptionContext)
        ) {
          throw error;
        }
        throw new WorkspaceMigrationRunnerException({
          message: error instanceof Error ? error.message : String(error),
          code: WorkspaceMigrationRunnerExceptionCode.INTERNAL_SERVER_ERROR,
          context: exceptionContext,
        });
      } finally {
        // A lost COMMIT acknowledgement can still have changed permissions.
        try {
          await this.invalidateCache({
            allFlatEntityMapsKeys,
            workspaceId,
            hasSchemaMetadataChanged: navigationMenuItemAudit
              ? hasSchemaMetadataChangedForAudit
              : false,
            hasMorphRelationFieldChanged: navigationMenuItemAudit
              ? hasMorphRelationFieldChanged
              : false,
          });
        } catch (cacheError) {
          this.logger.error(
            `Cache invalidation failed after audited role mutation: ${cacheError}`,
            'Runner',
          );
        }
      }
    }

    if (applicationMetadataAudit) {
      const mappings: ApplicationMetadataAuditMappings = {
        application: flatApplication,
        roles: allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier ?? {},
        targets:
          allFlatEntityMaps.flatRoleTargetMaps?.byUniversalIdentifier ?? {},
        agents: allFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier ?? {},
        permissionFlags:
          allFlatEntityMaps.flatPermissionFlagMaps?.byUniversalIdentifier ?? {},
        rolePermissionFlags:
          allFlatEntityMaps.flatRolePermissionFlagMaps?.byUniversalIdentifier ??
          {},
        objectMetadatas:
          allFlatEntityMaps.flatObjectMetadataMaps?.byUniversalIdentifier ?? {},
        fieldMetadatas:
          allFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier ?? {},
        objectPermissions:
          allFlatEntityMaps.flatObjectPermissionMaps?.byUniversalIdentifier ??
          {},
        fieldPermissions:
          allFlatEntityMaps.flatFieldPermissionMaps?.byUniversalIdentifier ??
          {},
        rowLevelPermissionPredicates:
          allFlatEntityMaps.flatRowLevelPermissionPredicateMaps
            ?.byUniversalIdentifier ?? {},
        rowLevelPermissionPredicateGroups:
          allFlatEntityMaps.flatRowLevelPermissionPredicateGroupMaps
            ?.byUniversalIdentifier ?? {},
        applicationVariables:
          allFlatEntityMaps.flatApplicationVariableMaps
            ?.byUniversalIdentifier ?? {},
        workflows:
          allFlatEntityMaps.flatWorkflowMaps?.byUniversalIdentifier ?? {},
        views: allFlatEntityMaps.flatViewMaps?.byUniversalIdentifier ?? {},
        navigationMenuItems:
          allFlatEntityMaps.flatNavigationMenuItemMaps?.byUniversalIdentifier ??
          {},
        pageLayouts:
          allFlatEntityMaps.flatPageLayoutMaps?.byUniversalIdentifier ?? {},
        agentChatChannels:
          allFlatEntityMaps.flatAgentChatChannelMaps?.byUniversalIdentifier ??
          {},
        agentChatChannelRoles:
          allFlatEntityMaps.flatAgentChatChannelRoleMaps
            ?.byUniversalIdentifier ?? {},
        webhooks:
          allFlatEntityMaps.flatWebhookMaps?.byUniversalIdentifier ?? {},
        connectionProviders:
          allFlatEntityMaps.flatConnectionProviderMaps?.byUniversalIdentifier ??
          {},
        skills: allFlatEntityMaps.flatSkillMaps?.byUniversalIdentifier ?? {},
      };
      const allMetadataEvents: MetadataEvent[] = [];
      const allDeferredActions: DeferredWorkspaceMigrationAction[] = [];
      const hasAuditedWorkflowVisibilityUpdate = actions.some(
        (action) =>
          action.metadataName === 'workflow' &&
          isAuditedWorkflowOrViewUpdateAction(action as never),
      );
      const searchFieldMetadatasByTsVectorFieldIdAccessor =
        createSearchFieldMetadatasByTsVectorFieldIdAccessor(
          () => allFlatEntityMaps.flatSearchFieldMetadataMaps,
        );
      try {
        await runAuditedApplicationMetadataMigration(
          this.coreDataSource,
          applicationMetadataAudit,
          actions as never,
          mappings,
          async (queryRunner: QueryRunner) => {
            for (const action of actions) {
              const {
                partialOptimisticCache,
                metadataEvents,
                deferredActions,
              } =
                await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionHandler(
                  {
                    action,
                    context: {
                      flatApplication,
                      action,
                      allFlatEntityMaps,
                      queryRunner,
                      workspaceId,
                      preallocatedIdByUniversalIdentifierByMetadataName,
                      getSearchFieldMetadatasByTsVectorFieldId:
                        searchFieldMetadatasByTsVectorFieldIdAccessor.get,
                      featureFlagsMap,
                    },
                  },
                );
              allFlatEntityMaps = {
                ...allFlatEntityMaps,
                ...partialOptimisticCache,
              } as typeof allFlatEntityMaps;
              if (action.metadataName === 'searchFieldMetadata') {
                searchFieldMetadatasByTsVectorFieldIdAccessor.invalidate();
              }
              allMetadataEvents.push(...metadataEvents);
              allDeferredActions.push(...deferredActions);
            }
            if (shouldPersistDeferredActions) {
              await this.deferredWorkspaceMigrationActionRunnerService.persist({
                deferredActions: allDeferredActions,
                workspaceId,
                applicationUniversalIdentifier,
                queryRunner,
              });
            }
          },
        );
      } catch (error) {
        const mayHaveCommitted =
          error instanceof NativeTransactionOutcomeUnknownError ||
          error instanceof CoreAuditPostCommitError;
        if (!mayHaveCommitted) {
          const invertedActions = [...actions].reverse();
          for (const invertedAction of invertedActions) {
            await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionRollbackHandler(
              {
                action: invertedAction,
                context: {
                  flatApplication,
                  action: invertedAction,
                  allFlatEntityMaps,
                  workspaceId,
                },
              },
            );
          }
        } else if (hasAuditedWorkflowVisibilityUpdate) {
          try {
            await this.deferredWorkspaceMigrationActionRunnerService.enqueue?.(
              workspaceId,
            );
          } catch (enqueueError) {
            this.logger.error(
              `Deferred action enqueue failed after application metadata migration error: ${enqueueError}`,
              'Runner',
            );
          }
        }
        try {
          await this.invalidateCache({
            allFlatEntityMapsKeys,
            workspaceId,
            hasSchemaMetadataChanged,
            hasMorphRelationFieldChanged,
          });
        } catch (cacheError) {
          this.logger.error(
            `Cache invalidation failed after application metadata migration error: ${cacheError}`,
            'Runner',
          );
        }
        const exceptionContext = getFlatEntityMapsExceptionContext(error);
        if (
          mayHaveCommitted ||
          error instanceof WorkspaceMigrationRunnerException ||
          !isDefined(exceptionContext)
        ) {
          throw error;
        }
        throw new WorkspaceMigrationRunnerException({
          message: error instanceof Error ? error.message : String(error),
          code: WorkspaceMigrationRunnerExceptionCode.INTERNAL_SERVER_ERROR,
          context: exceptionContext,
        });
      }

      try {
        await this.invalidateCache({
          allFlatEntityMapsKeys,
          workspaceId,
          hasSchemaMetadataChanged,
          hasMorphRelationFieldChanged,
        });
      } catch (cacheError) {
        this.logger.error(
          `Cache invalidation failed after committed transaction: ${cacheError}`,
          'Runner',
        );
      }

      if (hasAuditedWorkflowVisibilityUpdate) {
        await this.deferredWorkspaceMigrationActionRunnerService.enqueue?.(
          workspaceId,
        );
      }

      await this.deferredWorkspaceMigrationActionRunnerService.dispatchAfterCommit(
        {
          deferredActions: allDeferredActions,
          hasPersistedDeferredActions: shouldPersistDeferredActions,
          workspaceId,
          applicationUniversalIdentifier,
          allFlatEntityMaps,
        },
      );

      return {
        allFlatEntityMaps,
        metadataEvents: allMetadataEvents,
        hasSchemaMetadataChanged,
      };
    }

    if (
      actions.some(
        (action) =>
          AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES.has(action.metadataName) ||
          (action.type === 'delete' &&
            AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES.has(
              action.metadataName,
            )) ||
          isAuditedWorkflowOrViewUpdateAction(action as never),
      )
    ) {
      throw new Error(
        'Workspace migration touching role or permission metadata requires an active CRM audit scope',
      );
    }

    const queryRunner = this.coreDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const allMetadataEvents: MetadataEvent[] = [];
    const allDeferredActions: DeferredWorkspaceMigrationAction[] = [];

    const transactionStart = performance.now();
    let slowestActionMs = 0;
    let slowestActionLabel = 'n/a';
    let actionCount = 0;

    const searchFieldMetadatasByTsVectorFieldIdAccessor =
      createSearchFieldMetadatasByTsVectorFieldIdAccessor(
        () => allFlatEntityMaps.flatSearchFieldMetadataMaps,
      );

    try {
      await queryRunner.query(`SET LOCAL lock_timeout = '8s'`);

      for (const action of actions) {
        const actionStart = performance.now();
        const { partialOptimisticCache, metadataEvents, deferredActions } =
          await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionHandler(
            {
              action,
              context: {
                flatApplication,
                action,
                allFlatEntityMaps,
                queryRunner,
                workspaceId,
                preallocatedIdByUniversalIdentifierByMetadataName,
                getSearchFieldMetadatasByTsVectorFieldId:
                  searchFieldMetadatasByTsVectorFieldIdAccessor.get,
                featureFlagsMap,
              },
            },
          );

        const actionMs = performance.now() - actionStart;

        actionCount += 1;

        if (actionMs > slowestActionMs) {
          slowestActionMs = actionMs;
          slowestActionLabel = `${action.type}:${action.metadataName}`;
        }

        if (actionMs > 50) {
          this.logger.perf(
            `[install-perf] slow action ${action.type}:${action.metadataName} took ${actionMs.toFixed(1)}ms`,
            'Runner',
          );
        }

        allFlatEntityMaps = {
          ...allFlatEntityMaps,
          ...partialOptimisticCache,
        } as typeof allFlatEntityMaps;

        if (action.metadataName === 'searchFieldMetadata') {
          searchFieldMetadatasByTsVectorFieldIdAccessor.invalidate();
        }

        allMetadataEvents.push(...metadataEvents);
        allDeferredActions.push(...deferredActions);
      }

      if (shouldPersistDeferredActions) {
        await this.deferredWorkspaceMigrationActionRunnerService.persist({
          deferredActions: allDeferredActions,
          workspaceId,
          applicationUniversalIdentifier,
          queryRunner,
        });
      }

      const commitStart = performance.now();

      await queryRunner.commitTransaction();

      const commitMs = performance.now() - commitStart;
      const transactionMs = performance.now() - transactionStart;

      this.recordRunPhaseMetric({
        phase: 'action-execution',
        status: 'success',
        value: transactionMs - commitMs,
      });

      this.recordRunPhaseMetric({
        phase: 'commit',
        status: 'success',
        value: commitMs,
      });

      this.logger.perf(
        `[install-perf] Runner transaction summary: ${actionCount} actions, total transaction ${transactionMs.toFixed(1)}ms (commit ${commitMs.toFixed(1)}ms), slowest action ${slowestActionLabel} ${slowestActionMs.toFixed(1)}ms`,
        'Runner',
      );

      this.logger.perfTimeEnd('Runner', 'Transaction execution');
    } catch (error) {
      this.recordRunPhaseMetric({
        phase: 'action-execution',
        status: 'fail',
        value: performance.now() - transactionStart,
      });

      this.logger.error(
        `[install-perf] migration failed after ${actionCount} action(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
        'Runner',
      );

      if (queryRunner.isTransactionActive && !queryRunner.isReleased) {
        await queryRunner
          .rollbackTransaction()
          .catch((rollbackError) =>
            this.logger.error(
              `[install-perf] rollback failed: ${rollbackError.message}`,
              'Runner',
            ),
          );
      } else {
        this.logger.error(
          `[install-perf] skipping rollback (txnActive=${queryRunner.isTransactionActive} released=${queryRunner.isReleased})`,
          'Runner',
        );
      }

      await queryRunner.release();

      await this.logBlockingDbActivity();

      const invertedActions = [...actions].reverse();

      for (const invertedAction of invertedActions) {
        await this.workspaceMigrationRunnerActionHandlerRegistry.executeActionRollbackHandler(
          {
            action: invertedAction,
            context: {
              flatApplication,
              action: invertedAction,
              allFlatEntityMaps,
              workspaceId,
            },
          },
        );
      }

      try {
        await this.invalidateCache({
          allFlatEntityMapsKeys,
          workspaceId,
          hasSchemaMetadataChanged,
          hasMorphRelationFieldChanged,
        });
      } catch (cacheError) {
        this.logger.error(
          `Cache invalidation failed after rollback: ${cacheError}`,
          'Runner',
        );
      }

      if (error instanceof WorkspaceMigrationRunnerException) {
        throw error;
      }

      throw new WorkspaceMigrationRunnerException({
        message: error instanceof Error ? error.message : String(error),
        code: WorkspaceMigrationRunnerExceptionCode.INTERNAL_SERVER_ERROR,
        context: getFlatEntityMapsExceptionContext(error),
      });
    } finally {
      if (!queryRunner.isReleased) {
        await queryRunner.release();
      }
    }

    const postCommitInvalidateStart = performance.now();

    try {
      await this.invalidateCache({
        allFlatEntityMapsKeys,
        workspaceId,
        hasSchemaMetadataChanged,
        hasMorphRelationFieldChanged,
      });

      this.recordRunPhaseMetric({
        phase: 'cache-invalidation',
        status: 'success',
        value: performance.now() - postCommitInvalidateStart,
      });
    } catch (cacheError) {
      this.recordRunPhaseMetric({
        phase: 'cache-invalidation',
        status: 'fail',
        value: performance.now() - postCommitInvalidateStart,
      });

      this.logger.error(
        `Cache invalidation failed after committed transaction: ${cacheError}`,
        'Runner',
      );
    }

    const postCommitInvalidateMs =
      performance.now() - postCommitInvalidateStart;

    this.logger.perf(
      `[install-perf] Runner post-commit invalidateCache took ${postCommitInvalidateMs.toFixed(1)}ms for ${allFlatEntityMapsKeys.length} flat-maps keys`,
      'Runner',
    );

    await this.deferredWorkspaceMigrationActionRunnerService.dispatchAfterCommit(
      {
        deferredActions: allDeferredActions,
        hasPersistedDeferredActions: shouldPersistDeferredActions,
        workspaceId,
        applicationUniversalIdentifier,
        allFlatEntityMaps,
      },
    );

    this.logger.perfTimeEnd('Runner', 'Total execution');

    return {
      allFlatEntityMaps,
      metadataEvents: allMetadataEvents,
      hasSchemaMetadataChanged,
    };
  };
}
