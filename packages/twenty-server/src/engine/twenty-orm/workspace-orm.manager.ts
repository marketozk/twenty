import { computeTableName } from 'src/engine/utils/compute-table-name.util';
import { TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER } from 'twenty-shared/application/constants/TwentyStandardApplicationUniversalIdentifier';
import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-shared/metadata/constants/standard-object-universal-identifiers.constant';
import {
  PermissionsException,
  PermissionsExceptionCode,
  PermissionsExceptionMessage,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';
import { isValidationRuleEnforcementEnabled } from 'src/engine/twenty-orm/utils/is-validation-rule-enforcement-enabled.util';
import { Injectable, type Type } from '@nestjs/common';

import { type ObjectLiteral } from 'typeorm';

import { type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { EnterprisePlanService } from 'src/engine/core-modules/enterprise/services/enterprise-plan.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildObjectIdByNameMaps } from 'src/engine/metadata-modules/flat-object-metadata/utils/build-object-id-by-name-maps.util';
import { ExecuteInWorkspaceContextOptions } from 'src/engine/twenty-orm/types/execute-in-workspace-context-options.type';
import { type WorkspaceTransactionOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import {
  type ORMWorkspaceContext,
  withWorkspaceContext,
  getWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import type { RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { WorkspaceDataSourceService } from 'src/engine/twenty-orm/datasource/workspace-data-source.service';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { convertClassNameToObjectMetadataName } from 'src/engine/workspace-manager/utils/convert-class-to-object-metadata-name.util';

@Injectable()
export class WorkspaceOrmManager {
  constructor(
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
    private readonly enterprisePlanService: EnterprisePlanService,
    private readonly twentyConfigService: TwentyConfigService,
  ) {}

  getOmniConversationTargetMetadata(objectMetadataId: string) {
    const maps = getWorkspaceContext().flatObjectMetadataMaps;
    const key = maps.universalIdentifierById[objectMetadataId];
    const object = key ? maps.byUniversalIdentifier[key] : undefined;
    if (!object) return undefined;
    const projectionField:
      | 'targetPersonId'
      | 'targetCompanyId'
      | 'targetOpportunityId'
      | null =
      object.universalIdentifier ===
      STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person
        ? 'targetPersonId'
        : object.universalIdentifier ===
            STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company
          ? 'targetCompanyId'
          : object.universalIdentifier ===
              STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity
            ? 'targetOpportunityId'
            : null;
    return Object.freeze({
      id: object.id,
      workspaceId: object.workspaceId,
      isActive: object.isActive,
      isSystem: object.isSystem,
      tableName: computeTableName(
        object.nameSingular,
        object.applicationUniversalIdentifier !==
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
      ),
      projectionField,
    });
  }

  getStandardPersonMetadata() {
    const object =
      getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person
      ];
    return (
      object &&
      Object.freeze({
        id: object.id,
        workspaceId: object.workspaceId,
        isActive: object.isActive,
      })
    );
  }

  getWorkspaceId(): string {
    return getWorkspaceContext().authContext.workspace.id;
  }

  getRepository<T extends ObjectLiteral = ObjectRecord>(
    workspaceEntity: Type<T>,
    permissionOptions?: RolePermissionConfig,
    repositoryOptions?: {
      useReplica?: boolean;
      shouldSkipEventEmission?: boolean;
    },
  ): WorkspaceRepository<T>;

  getRepository<T extends ObjectLiteral = ObjectRecord>(
    objectMetadataName: string,
    permissionOptions?: RolePermissionConfig,
    repositoryOptions?: {
      useReplica?: boolean;
      shouldSkipEventEmission?: boolean;
    },
  ): WorkspaceRepository<T>;

  getRepository<T extends ObjectLiteral = ObjectRecord>(
    workspaceEntityOrObjectMetadataName: Type<T> | string,
    permissionOptions?: RolePermissionConfig,
    repositoryOptions?: {
      useReplica?: boolean;
      shouldSkipEventEmission?: boolean;
    },
  ): WorkspaceRepository<T> {
    const objectMetadataName = this.resolveObjectMetadataName(
      workspaceEntityOrObjectMetadataName,
    );

    return this.workspaceDataSourceService
      .getDataSource({ useReplica: repositoryOptions?.useReplica ?? false })
      .getRepository<T>(objectMetadataName, permissionOptions, {
        shouldSkipEventEmission:
          repositoryOptions?.shouldSkipEventEmission ?? false,
      });
  }

  // Domain APIs must evaluate the same role intersection as ordinary record APIs.
  getRepositoryWithContextPermissions<
    TData extends ObjectLiteral = ObjectRecord,
  >(
    objectMetadataName: string,
    transactionScope?: WorkspaceTransactionScope,
  ): WorkspaceRepository<TData> {
    const context = getWorkspaceContext();
    const permissionConfig = resolveRolePermissionConfig(context);
    if (!isDefined(permissionConfig)) {
      throw new PermissionsException(
        PermissionsExceptionMessage.PERMISSION_DENIED,
        PermissionsExceptionCode.PERMISSION_DENIED,
      );
    }
    return isDefined(transactionScope)
      ? transactionScope.getRepository<TData>(
          objectMetadataName,
          permissionConfig,
        )
      : this.getRepository<TData>(objectMetadataName, permissionConfig);
  }

  private resolveObjectMetadataName<T extends ObjectLiteral>(
    workspaceEntityOrObjectMetadataName: Type<T> | string,
  ): string {
    if (typeof workspaceEntityOrObjectMetadataName === 'string') {
      return workspaceEntityOrObjectMetadataName;
    }

    return convertClassNameToObjectMetadataName(
      workspaceEntityOrObjectMetadataName.name,
    );
  }

  async runInWorkspaceTransaction<T>(
    work: (transactionScope: WorkspaceTransactionScope) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ): Promise<T> {
    return this.workspaceDataSourceService
      .getDataSource({ useReplica: false })
      .transaction(work, options);
  }

  async executeInWorkspaceContext<T>(
    fn: () => T | Promise<T>,
    authContext?: WorkspaceAuthContext,
    options?: ExecuteInWorkspaceContextOptions,
  ): Promise<T> {
    const resolvedAuthContext = authContext ?? getWorkspaceAuthContext();
    const context = options?.lite
      ? await this.loadLiteWorkspaceContext(resolvedAuthContext)
      : await this.loadWorkspaceContext(resolvedAuthContext);

    return withWorkspaceContext(context, fn);
  }

  private async loadWorkspaceContext(
    authContext: WorkspaceAuthContext,
  ): Promise<ORMWorkspaceContext> {
    const workspaceId = authContext.workspace.id;

    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMapsOrm,
      flatIndexMaps,
      featureFlagsMap,
      billingEntitlements,
      rolesPermissions: permissionsPerRoleId,
      roleIdsWithAllRecordsAccess,
      userWorkspaceRoleMap,
      apiKeyRoleMap,
      flatRoleTargetByAgentIdMaps,
      flatRowLevelPermissionPredicateMaps,
      flatRowLevelPermissionPredicateGroupMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMapsOrm',
      'flatIndexMaps',
      'featureFlagsMap',
      'billingEntitlements',
      'rolesPermissions',
      'roleIdsWithAllRecordsAccess',
      'userWorkspaceRoleMap',
      'apiKeyRoleMap',
      'flatRoleTargetByAgentIdMaps',
      'flatRowLevelPermissionPredicateMaps',
      'flatRowLevelPermissionPredicateGroupMaps',
    ]);

    const { idByNameSingular: objectIdByNameSingular } =
      buildObjectIdByNameMaps(flatObjectMetadataMaps);

    const flatValidationRuleMaps = isValidationRuleEnforcementEnabled({
      featureFlagsMap,
      billingEntitlements,
      hasValidEnterprisePlan: this.enterprisePlanService.isValid(),
      isBillingEnabled: this.twentyConfigService.get('IS_BILLING_ENABLED'),
    })
      ? (
          await this.workspaceCacheService.getOrRecompute(workspaceId, [
            'flatValidationRuleMaps',
          ])
        ).flatValidationRuleMaps
      : undefined;

    return {
      authContext,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps: flatFieldMetadataMapsOrm,
      flatIndexMaps,
      flatRowLevelPermissionPredicateMaps,
      flatRowLevelPermissionPredicateGroupMaps,
      flatValidationRuleMaps,
      objectIdByNameSingular,
      featureFlagsMap,
      billingEntitlements,
      permissionsPerRoleId,
      roleIdsWithAllRecordsAccess,
      userWorkspaceRoleMap,
      apiKeyRoleMap,
      flatRoleTargetByAgentIdMaps,
    };
  }

  private async loadLiteWorkspaceContext(
    authContext: WorkspaceAuthContext,
  ): Promise<ORMWorkspaceContext> {
    const workspaceId = authContext.workspace.id;

    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMapsOrm,
      billingEntitlements,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMapsOrm',
      'billingEntitlements',
    ]);

    const { idByNameSingular: objectIdByNameSingular } =
      buildObjectIdByNameMaps(flatObjectMetadataMaps);

    return {
      authContext,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps: flatFieldMetadataMapsOrm,
      flatIndexMaps: {
        byUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      flatRowLevelPermissionPredicateMaps: {
        byUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      flatRowLevelPermissionPredicateGroupMaps: {
        byUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
      objectIdByNameSingular,
      featureFlagsMap: {} as ORMWorkspaceContext['featureFlagsMap'],
      billingEntitlements,
      permissionsPerRoleId: {},
      roleIdsWithAllRecordsAccess: [],
      userWorkspaceRoleMap: {},
      apiKeyRoleMap: {},
      flatRoleTargetByAgentIdMaps: {},
    };
  }
}
