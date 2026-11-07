import { Injectable } from '@nestjs/common';

import { type Manifest } from 'twenty-shared/application';
import { ALL_METADATA_NAME } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ComputeApplicationManifestAllUniversalFlatEntityMapsService } from 'src/engine/core-modules/application/application-manifest/services/compute-application-manifest-all-universal-flat-entity-maps.service';
import { buildApplicationWorkflowCronTriggerCacheEntries } from 'src/engine/core-modules/application/application-manifest/utils/build-application-workflow-cron-trigger-cache-entries.util';
import { addWorkflowManifestsToFlatEntityMapsOrThrow } from 'src/engine/core-modules/application/application-manifest/utils/add-workflow-manifests-to-flat-entity-maps-or-throw.util';
import { preallocateWorkflowReferenceIds } from 'src/engine/core-modules/application/application-manifest/utils/preallocate-workflow-reference-ids.util';
import { buildAllFlatEntityOperationRecordByMetadataNameFromFromTo } from 'src/engine/core-modules/application/application-manifest/utils/build-all-flat-entity-operation-record-by-metadata-name-from-from-to.util';
import { buildFromToAllUniversalFlatEntityMaps } from 'src/engine/core-modules/application/application-manifest/utils/build-from-to-all-universal-flat-entity-maps.util';
import { getApplicationSubAllFlatEntityMaps } from 'src/engine/core-modules/application/application-manifest/utils/get-application-sub-all-flat-entity-maps.util';
import { assertConnectionProviderLogicFunctionsAreOwn } from 'src/engine/core-modules/application/application-manifest/utils/assert-connection-provider-logic-functions-are-own.util';
import { resolveApplicationReferenceIdOrThrow } from 'src/engine/core-modules/application/application-manifest/utils/resolve-application-reference-id-or-throw.util';
import {
  ApplicationException,
  ApplicationExceptionCode,
} from 'src/engine/core-modules/application/application.exception';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { type ApplicationDefaultRoleAuditIdentity } from 'src/engine/core-modules/crm-audit/application-default-role-audit';
import {
  captureApplicationMetadataAudit,
  reconcileApplicationRoleAndPermissionOperations,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import { LoggerService } from 'src/engine/core-modules/logger/logger.service';
import { WorkflowVersionCoreSyncService } from 'src/engine/core-modules/workflow/services/workflow-version-core-sync.service';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { findFlatEntityByUniversalIdentifierOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-universal-identifier-or-throw.util';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { WorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration.type';

@Injectable()
export class ApplicationManifestMigrationService {
  constructor(
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly applicationService: ApplicationService,
    private readonly computeManifestFlatEntityMapsService: ComputeApplicationManifestAllUniversalFlatEntityMapsService,
    private readonly logger: LoggerService,
    private readonly workflowVersionCoreSyncService: WorkflowVersionCoreSyncService,
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
  ) {}

  async syncPreInstallLogicFunctionFromManifest({
    manifest,
    workspaceId,
    ownerFlatApplication,
  }: {
    manifest: Manifest;
    workspaceId: string;
    ownerFlatApplication: FlatApplication;
  }): Promise<void> {
    const preInstallLogicFunction =
      manifest.application.preInstallLogicFunction;

    if (!isDefined(preInstallLogicFunction)) {
      return;
    }

    const preInstallLogicFunctionManifest = manifest.logicFunctions.find(
      (logicFunction) =>
        logicFunction.universalIdentifier ===
        preInstallLogicFunction.universalIdentifier,
    );

    if (!isDefined(preInstallLogicFunctionManifest)) {
      throw new ApplicationException(
        `Pre-install logic function "${preInstallLogicFunction.universalIdentifier}" is declared on the application manifest but not present in manifest.logicFunctions`,
        ApplicationExceptionCode.ENTITY_NOT_FOUND,
      );
    }

    const preInstallOnlyManifest: Manifest = {
      application: manifest.application,
      objects: [],
      fields: [],
      logicFunctions: [preInstallLogicFunctionManifest],
      frontComponents: [],
      permissionFlags: [],
      roles: [],
      skills: [],
      agents: [],
      publicAssets: [],
      views: [],
      viewFields: [],
      navigationMenuItems: [],
      pageLayouts: [],
      pageLayoutTabs: [],
      pageLayoutWidgets: [],
      commandMenuItems: [],
      timelineActivityTypes: [],
      settingsMenuItems: [],
    };

    const now = new Date().toISOString();

    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const cacheResult = await this.workspaceCacheService.getOrRecompute(
      workspaceId,
      [
        ...Object.values(ALL_METADATA_NAME).map(getMetadataFlatEntityMapsKey),
        'featureFlagsMap',
        'billingEntitlements',
      ],
    );

    const {
      featureFlagsMap,
      billingEntitlements,
      ...existingAllFlatEntityMaps
    } = cacheResult;

    const fromAllFlatEntityMaps = getApplicationSubAllFlatEntityMaps({
      applicationIds: [ownerFlatApplication.id],
      fromAllFlatEntityMaps: existingAllFlatEntityMaps,
    });

    const toAllUniversalFlatEntityMaps =
      this.computeManifestFlatEntityMapsService.compute({
        manifest: preInstallOnlyManifest,
        ownerFlatApplication,
        fromAllFlatEntityMaps,
        now,
      });

    const dependencyAllFlatEntityMaps = getApplicationSubAllFlatEntityMaps({
      applicationIds:
        ownerFlatApplication.universalIdentifier ===
        TWENTY_STANDARD_APPLICATION.universalIdentifier
          ? [twentyStandardFlatApplication.id]
          : [ownerFlatApplication.id, twentyStandardFlatApplication.id],
      fromAllFlatEntityMaps: existingAllFlatEntityMaps,
    });

    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigrationFromTo(
        {
          // inferDeletionFromMissingEntities omitted so this pre-install sync is purely additive
          buildOptions: {
            isSystemBuild: false,
            applicationUniversalIdentifier:
              ownerFlatApplication.universalIdentifier,
          },
          fromToAllFlatEntityMaps: buildFromToAllUniversalFlatEntityMaps({
            fromAllFlatEntityMaps,
            toAllUniversalFlatEntityMaps,
          }),
          workspaceId,
          dependencyAllFlatEntityMaps,
          additionalCacheDataMaps: { featureFlagsMap, billingEntitlements },
        },
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Validation errors occurred while syncing pre-install logic function',
      );
    }

    this.logger.log(
      `Pre-install logic function synced for application ${ownerFlatApplication.universalIdentifier}`,
      ApplicationManifestMigrationService.name,
    );
  }

  async syncMetadataFromManifest({
    manifest,
    workspaceId,
    ownerFlatApplication,
    dryRun = false,
    inferDeletionFromMissingEntities = true,
    auditIdentity,
  }: {
    manifest: Manifest;
    workspaceId: string;
    ownerFlatApplication: FlatApplication;
    dryRun?: boolean;
    inferDeletionFromMissingEntities?: boolean;
    auditIdentity?: ApplicationDefaultRoleAuditIdentity;
  }): Promise<{
    workspaceMigration: WorkspaceMigration;
    hasSchemaMetadataChanged: boolean;
  }> {
    const ownerApplicationId = ownerFlatApplication.id;
    const capturedOwnerFlatApplication: FlatApplication = {
      ...ownerFlatApplication,
      id: ownerApplicationId,
    };
    const capturedMetadataAudit = !dryRun
      ? captureApplicationMetadataAudit({
          workspaceId,
          applicationId: ownerApplicationId,
          applicationUniversalIdentifier:
            capturedOwnerFlatApplication.universalIdentifier,
          auditIdentity,
        })
      : undefined;
    const now = new Date().toISOString();

    const recomputeStart = performance.now();
    const existingAllFlatEntityMaps =
      await this.workspaceCacheService.getOrRecompute(
        workspaceId,
        Object.values(ALL_METADATA_NAME).map(getMetadataFlatEntityMapsKey),
      );
    const recomputeMs = performance.now() - recomputeStart;

    this.logger.perf(
      `[install-perf] syncMetadataFromManifest ALL_METADATA_NAME getOrRecompute flat-maps took ${recomputeMs.toFixed(1)}ms (logicFunctions=${manifest.logicFunctions.length})`,
      ApplicationManifestMigrationService.name,
    );

    const fromAllFlatEntityMaps = getApplicationSubAllFlatEntityMaps({
      applicationIds: [ownerFlatApplication.id],
      fromAllFlatEntityMaps: existingAllFlatEntityMaps,
    });

    const toAllUniversalFlatEntityMaps =
      this.computeManifestFlatEntityMapsService.compute({
        manifest,
        ownerFlatApplication,
        fromAllFlatEntityMaps,
        now,
      });

    assertConnectionProviderLogicFunctionsAreOwn({
      manifest,
      fromFlatLogicFunctionMaps: fromAllFlatEntityMaps.flatLogicFunctionMaps,
      toFlatLogicFunctionMaps:
        toAllUniversalFlatEntityMaps.flatLogicFunctionMaps,
      inferDeletionFromMissingEntities,
    });

    const idByUniversalIdentifierByMetadataName =
      (manifest.workflows ?? []).length > 0
        ? preallocateWorkflowReferenceIds({
            fromAllFlatEntityMaps,
            toAllUniversalFlatEntityMaps,
          })
        : {};

    const applicationWorkflows = addWorkflowManifestsToFlatEntityMapsOrThrow({
      workflows: manifest.workflows ?? [],
      ownerFlatApplication,
      fromAllFlatEntityMaps,
      toAllUniversalFlatEntityMaps,
      existingAllFlatEntityMaps,
      idByUniversalIdentifierByMetadataName,
      now,
    });

    const allFlatEntityOperationRecordByMetadataName =
      buildAllFlatEntityOperationRecordByMetadataNameFromFromTo({
        fromAllFlatEntityMaps,
        toAllUniversalFlatEntityMaps,
        buildOptions: {
          isSystemBuild: false,
          inferDeletionFromMissingEntities: inferDeletionFromMissingEntities
            ? true
            : undefined,
          applicationUniversalIdentifier:
            capturedOwnerFlatApplication.universalIdentifier,
        },
      });

    const ownedAgentUniversalIdentifiers = [
      ...new Set([
        ...Object.keys(
          fromAllFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier ?? {},
        ),
        ...Object.keys(
          toAllUniversalFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier ??
            {},
        ),
      ]),
    ];
    const toRoleTargetByAgentUniversalIdentifier = Object.fromEntries(
      Object.values(
        toAllUniversalFlatEntityMaps.flatRoleTargetMaps
          ?.byUniversalIdentifier ?? {},
      )
        .filter(isDefined)
        .filter((target) => isDefined(target.agentUniversalIdentifier))
        .map((target) => [target.agentUniversalIdentifier!, target]),
    );
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName,
      existingAllFlatEntityMaps,
      ownedAgentUniversalIdentifiers,
      toRoleTargetByAgentUniversalIdentifier,
      inferDeletionFromMissingEntities,
    });

    const connectionProviderIdsToDelete = Object.values(
      allFlatEntityOperationRecordByMetadataName.connectionProvider
        ?.flatEntityToDelete ?? {},
    )
      .filter(isDefined)
      .map(
        ({ universalIdentifier }) =>
          findFlatEntityByUniversalIdentifierOrThrow({
            flatEntityMaps: fromAllFlatEntityMaps.flatConnectionProviderMaps,
            universalIdentifier,
          }).id,
      );

    const shouldDeleteConnectedAccounts =
      !dryRun && connectionProviderIdsToDelete.length > 0;

    const validateBuildAndRunMigration = (isDryRun: boolean) => {
      const execute = () =>
        this.validateBuildAndRunOrThrow({
          allFlatEntityOperationRecordByMetadataName,
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier:
            capturedOwnerFlatApplication.universalIdentifier,
          idByUniversalIdentifierByMetadataName,
          dryRun: isDryRun,
        });

      return isDryRun
        ? execute()
        : withApplicationMetadataAudit(capturedMetadataAudit!(), execute);
    };

    const validateBuildRunStart = performance.now();
    let validateAndBuildResult = await validateBuildAndRunMigration(
      dryRun || shouldDeleteConnectedAccounts,
    );

    // Deleting runs disconnect hooks and revokes tokens, so the plan is validated before anything is released
    if (shouldDeleteConnectedAccounts) {
      await this.connectedAccountMetadataService.deleteManyByConnectionProviderIds(
        {
          connectionProviderIds: connectionProviderIdsToDelete,
          workspaceId,
          applicationId: ownerApplicationId,
        },
      );

      validateAndBuildResult = await validateBuildAndRunMigration(false);
    }
    const validateBuildRunMs = performance.now() - validateBuildRunStart;

    this.logger.perf(
      `[install-perf] syncMetadataFromManifest validateBuildAndRunWorkspaceMigrationFromTo took ${validateBuildRunMs.toFixed(1)}ms (dryRun=${dryRun}, actions=${validateAndBuildResult.workspaceMigration.actions.length})`,
      ApplicationManifestMigrationService.name,
    );

    this.logger.log(
      `Metadata migration ${dryRun ? 'plan computed (dry run)' : 'completed'} for application ${ownerFlatApplication.universalIdentifier}`,
      ApplicationManifestMigrationService.name,
    );

    if (!dryRun) {
      await this.syncApplicationReferencesFromManifest({
        manifest,
        workspaceId,
        ownerFlatApplication: capturedOwnerFlatApplication,
        inferDeletionFromMissingEntities,
        auditIdentity,
      });

      await this.workflowVersionCoreSyncService.publishCronTriggerCacheEntries(
        buildApplicationWorkflowCronTriggerCacheEntries({
          workspaceId,
          workflows: applicationWorkflows,
        }),
      );
    }

    return {
      workspaceMigration: validateAndBuildResult.workspaceMigration,
      hasSchemaMetadataChanged: validateAndBuildResult.hasSchemaMetadataChanged,
    };
  }

  private async validateBuildAndRunOrThrow(
    args: Parameters<
      WorkspaceMigrationValidateBuildAndRunService['validateBuildAndRunWorkspaceMigrationFromRecord']
    >[0],
  ) {
    const validateAndBuildResult =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigrationFromRecord(
        args,
      );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Validation errors occurred while syncing application manifest metadata',
      );
    }

    return validateAndBuildResult;
  }

  private async syncApplicationReferencesFromManifest({
    manifest,
    workspaceId,
    ownerFlatApplication,
    inferDeletionFromMissingEntities,
    auditIdentity,
  }: {
    manifest: Manifest;
    workspaceId: string;
    ownerFlatApplication: FlatApplication;
    inferDeletionFromMissingEntities: boolean;
    auditIdentity?: ApplicationDefaultRoleAuditIdentity;
  }) {
    const ownerApplicationId = ownerFlatApplication.id;
    const {
      flatRoleMaps: refreshedFlatRoleMaps,
      flatFrontComponentMaps: refreshedFlatFrontComponentMaps,
      flatLogicFunctionMaps: refreshedFlatLogicFunctionMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatRoleMaps',
      'flatFrontComponentMaps',
      'flatLogicFunctionMaps',
    ]);

    let defaultRoleId: string | null = null;

    for (const role of manifest.roles) {
      const flatRoleId = resolveApplicationReferenceIdOrThrow({
        flatEntityMaps: refreshedFlatRoleMaps,
        universalIdentifier: role.universalIdentifier,
        referenceLabel: 'role',
        exceptionCode: ApplicationExceptionCode.ENTITY_NOT_FOUND,
        ownerApplicationId,
      });

      if (
        role.universalIdentifier ===
        manifest.application.defaultRoleUniversalIdentifier
      ) {
        defaultRoleId = flatRoleId;
      }
    }

    if (
      isDefined(manifest.application.defaultRoleUniversalIdentifier) &&
      !isDefined(defaultRoleId)
    ) {
      defaultRoleId = resolveApplicationReferenceIdOrThrow({
        flatEntityMaps: refreshedFlatRoleMaps,
        universalIdentifier:
          manifest.application.defaultRoleUniversalIdentifier,
        referenceLabel: 'role',
        exceptionCode: ApplicationExceptionCode.ENTITY_NOT_FOUND,
        ownerApplicationId,
      });
    }

    const settingsFrontComponentUniversalIdentifier =
      manifest.application.settingsFrontComponent?.universalIdentifier;

    const settingsCustomTabFrontComponentId = isDefined(
      settingsFrontComponentUniversalIdentifier,
    )
      ? resolveApplicationReferenceIdOrThrow({
          flatEntityMaps: refreshedFlatFrontComponentMaps,
          universalIdentifier: settingsFrontComponentUniversalIdentifier,
          referenceLabel: 'settings front component',
          exceptionCode: ApplicationExceptionCode.ENTITY_NOT_FOUND,
        })
      : null;

    const healthCheckLogicFunctionUniversalIdentifier =
      manifest.application.healthCheckLogicFunction?.universalIdentifier;

    const healthCheckLogicFunctionId = isDefined(
      healthCheckLogicFunctionUniversalIdentifier,
    )
      ? resolveApplicationReferenceIdOrThrow({
          flatEntityMaps: refreshedFlatLogicFunctionMaps,
          universalIdentifier: healthCheckLogicFunctionUniversalIdentifier,
          referenceLabel: 'health check logic function',
          exceptionCode: ApplicationExceptionCode.LOGIC_FUNCTION_NOT_FOUND,
          ownerApplicationId,
        })
      : null;

    const uninstallLogicFunctionUniversalIdentifier =
      manifest.application.uninstallLogicFunction?.universalIdentifier;

    const uninstallLogicFunctionId = isDefined(
      uninstallLogicFunctionUniversalIdentifier,
    )
      ? resolveApplicationReferenceIdOrThrow({
          flatEntityMaps: refreshedFlatLogicFunctionMaps,
          universalIdentifier: uninstallLogicFunctionUniversalIdentifier,
          referenceLabel: 'uninstall logic function',
          exceptionCode: ApplicationExceptionCode.LOGIC_FUNCTION_NOT_FOUND,
          ownerApplicationId,
        })
      : null;

    await this.applicationService.update(
      ownerApplicationId,
      {
        workspaceId,
        ...(isDefined(settingsCustomTabFrontComponentId) ||
        inferDeletionFromMissingEntities
          ? { settingsCustomTabFrontComponentId }
          : {}),
        ...(isDefined(uninstallLogicFunctionId) ||
        inferDeletionFromMissingEntities
          ? { uninstallLogicFunctionId }
          : {}),
        ...(isDefined(healthCheckLogicFunctionId) ||
        inferDeletionFromMissingEntities
          ? { healthCheckLogicFunctionId }
          : {}),
        ...(isDefined(defaultRoleId) || inferDeletionFromMissingEntities
          ? { defaultRoleId }
          : {}),
      },
      auditIdentity !== undefined ? { auditIdentity } : undefined,
    );
  }
}
