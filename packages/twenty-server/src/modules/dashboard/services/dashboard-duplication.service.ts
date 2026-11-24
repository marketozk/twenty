import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { appendCopySuffix, isDefined } from 'twenty-shared/utils';

import { ActorFromAuthContextService } from 'src/engine/core-modules/actor/services/actor-from-auth-context.service';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  captureNativeCrmAuditBinding,
  type NativeCrmAuditBinding,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { recordPostRollbackNativeCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { PageLayoutDuplicationService } from 'src/engine/metadata-modules/page-layout/services/page-layout-duplication.service';
import { PageLayoutService } from 'src/engine/metadata-modules/page-layout/services/page-layout.service';
import {
  PermissionsException,
  PermissionsExceptionCode,
  PermissionsExceptionMessage,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  getWorkspaceContext,
  type ORMWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type NativeCrmAuditOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { isObjectOperationPermitted } from 'src/engine/twenty-orm/utils/is-object-operation-permitted.util';
import { resolveObjectRecordsPermissions } from 'src/engine/twenty-orm/utils/resolve-object-records-permissions.util';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';
import { DuplicatedDashboardDTO } from 'src/modules/dashboard/dtos/duplicated-dashboard.dto';
import {
  DashboardException,
  DashboardExceptionCode,
  DashboardExceptionMessageKey,
  generateDashboardExceptionMessage,
} from 'src/modules/dashboard/exceptions/dashboard.exception';
import { DashboardWorkspaceEntity } from 'src/modules/dashboard/standard-objects/dashboard.workspace-entity';

// A role-scoped read validates every selected column, so reading the whole row would refuse over fields never copied
const DUPLICATION_SOURCE_COLUMNS: (keyof DashboardWorkspaceEntity)[] = [
  'id',
  'title',
  'pageLayoutId',
  'position',
];

const DASHBOARD_DUPLICATION_SYSTEM_ACTOR_ID =
  'dashboard-duplication:duplicate';

const DUPLICATED_DASHBOARD_COLUMNS: (keyof DashboardWorkspaceEntity)[] = [
  ...DUPLICATION_SOURCE_COLUMNS,
  'createdAt',
  'updatedAt',
];

@Injectable()
export class DashboardDuplicationService {
  private readonly logger = new Logger(DashboardDuplicationService.name);

  constructor(
    private readonly pageLayoutDuplicationService: PageLayoutDuplicationService,
    private readonly pageLayoutService: PageLayoutService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly actorFromAuthContextService: ActorFromAuthContextService,
  ) {}

  async duplicateDashboard(
    dashboardId: string,
    authContext: WorkspaceAuthContext,
  ): Promise<DuplicatedDashboardDTO> {
    const workspace = authContext.workspace;
    const workspaceId = workspace.id;

    return this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const workspaceContext = getWorkspaceContext();
      const dashboardObjectMetadataId =
        this.workspaceOrmManager.getObjectMetadataId('dashboard');
      const rolePermissionConfig = resolveRolePermissionConfig({
        authContext: workspaceContext.authContext,
        userWorkspaceRoleMap: workspaceContext.userWorkspaceRoleMap,
        apiKeyRoleMap: workspaceContext.apiKeyRoleMap,
        flatRoleTargetByAgentIdMaps:
          workspaceContext.flatRoleTargetByAgentIdMaps,
      });

      const buildNativeAuditOptions = (): NativeCrmAuditOptions => ({
        operationId: randomUUID(),
        ...(authContext.type === 'system'
          ? { systemActorId: DASHBOARD_DUPLICATION_SYSTEM_ACTOR_ID }
          : {}),
      });

      const recordPermissionDeniedAttempt = async (error: unknown) => {
        if (!isDefined(dashboardObjectMetadataId)) {
          return;
        }
        let binding: NativeCrmAuditBinding | undefined;

        try {
          binding = captureNativeCrmAuditBinding(
            workspaceId,
            authContext,
            buildNativeAuditOptions(),
          );
        } catch {
          return;
        }

        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, options) =>
            this.workspaceOrmManager.runInWorkspaceTransaction(work, options),
          binding,
          action: 'create',
          resourceId: dashboardObjectMetadataId,
          objectMetadataId: dashboardObjectMetadataId,
          error,
        });
      };

      if (!isDefined(rolePermissionConfig)) {
        const permissionError = new PermissionsException(
          PermissionsExceptionMessage.PERMISSION_DENIED,
          PermissionsExceptionCode.PERMISSION_DENIED,
        );

        await recordPermissionDeniedAttempt(permissionError);
        throw permissionError;
      }

      const dashboardRepository =
        this.workspaceOrmManager.getRepository<DashboardWorkspaceEntity>(
          'dashboard',
          rolePermissionConfig,
        );

      const originalDashboard = await dashboardRepository.findOne({
        where: { id: dashboardId },
        select: DUPLICATION_SOURCE_COLUMNS,
      });

      if (!isDefined(originalDashboard)) {
        throw new DashboardException(
          generateDashboardExceptionMessage(
            DashboardExceptionMessageKey.DASHBOARD_NOT_FOUND,
            dashboardId,
          ),
          DashboardExceptionCode.DASHBOARD_NOT_FOUND,
        );
      }

      if (!isDefined(originalDashboard.pageLayoutId)) {
        throw new DashboardException(
          generateDashboardExceptionMessage(
            DashboardExceptionMessageKey.PAGE_LAYOUT_NOT_FOUND,
            dashboardId,
          ),
          DashboardExceptionCode.PAGE_LAYOUT_NOT_FOUND,
        );
      }

      // The layout copy lives outside the dashboard insert, so refuse before creating it
      try {
        this.assertCanCreateDashboardOrThrow({
          workspaceContext,
          rolePermissionConfig,
        });
      } catch (error) {
        await recordPermissionDeniedAttempt(error);
        throw error;
      }

      // Validate audit attribution before duplicating the page layout so invalid callers fail closed early
      const nativeAuditOptions = buildNativeAuditOptions();
      const auditBinding = captureNativeCrmAuditBinding(
        workspaceId,
        authContext,
        nativeAuditOptions,
      );
      const layoutAuditIdentity = {
        auth: authContext,
        ...(authContext.type === 'system'
          ? { systemActorId: DASHBOARD_DUPLICATION_SYSTEM_ACTOR_ID }
          : {}),
        ...(auditBinding.impersonatorUserWorkspaceId !== undefined
          ? {
              impersonatorUserWorkspaceId:
                auditBinding.impersonatorUserWorkspaceId,
            }
          : {}),
        ...(auditBinding.operation.correlationId !== undefined
          ? { correlationId: auditBinding.operation.correlationId }
          : {}),
        ...(auditBinding.operation.causationId !== undefined
          ? { causationId: auditBinding.operation.causationId }
          : {}),
      };

      try {
        const newPageLayout = await this.pageLayoutDuplicationService.duplicate(
          {
            pageLayoutId: originalDashboard.pageLayoutId,
            workspaceId,
            auditIdentity: layoutAuditIdentity,
          },
        );

        const newDashboard = await this.createDuplicatedDashboardOrRollback({
          originalDashboard,
          newPageLayoutId: newPageLayout.id,
          rolePermissionConfig,
          authContext,
          workspaceId,
          nativeAuditOptions,
          auditBinding,
          dashboardObjectMetadataId,
          layoutAuditIdentity,
        });

        return {
          id: newDashboard.id,
          title: newDashboard.title,
          pageLayoutId: newDashboard.pageLayoutId,
          position: newDashboard.position,
          createdAt: new Date(newDashboard.createdAt).toISOString(),
          updatedAt: new Date(newDashboard.updatedAt).toISOString(),
        };
      } catch (error) {
        this.logger.error(
          `Failed to duplicate dashboard ${dashboardId}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );

        throw error;
      }
    }, authContext);
  }

  private assertCanCreateDashboardOrThrow({
    workspaceContext,
    rolePermissionConfig,
  }: {
    workspaceContext: ORMWorkspaceContext;
    rolePermissionConfig: RolePermissionConfig;
  }): void {
    const { objectRecordsPermissions, shouldBypassPermissionChecks } =
      resolveObjectRecordsPermissions({
        rolePermissionConfig,
        objectPermissionsByRoleId: workspaceContext.permissionsPerRoleId,
      });

    if (shouldBypassPermissionChecks) {
      return;
    }

    const dashboardObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: workspaceContext.objectIdByNameSingular.dashboard,
      flatEntityMaps: workspaceContext.flatObjectMetadataMaps,
    });

    if (
      !isDefined(dashboardObjectMetadata) ||
      !isObjectOperationPermitted({
        objectMetadata: dashboardObjectMetadata,
        operationType: 'insert',
        objectsPermissions: objectRecordsPermissions,
      })
    ) {
      throw new PermissionsException(
        PermissionsExceptionMessage.PERMISSION_DENIED,
        PermissionsExceptionCode.PERMISSION_DENIED,
      );
    }
  }

  // The layout lives in the core schema, outside the insert, so a refused or failed insert must remove it
  private async createDuplicatedDashboardOrRollback({
    originalDashboard,
    newPageLayoutId,
    rolePermissionConfig,
    authContext,
    workspaceId,
    nativeAuditOptions,
    auditBinding,
    dashboardObjectMetadataId,
    layoutAuditIdentity,
  }: {
    originalDashboard: DashboardWorkspaceEntity;
    newPageLayoutId: string;
    rolePermissionConfig: RolePermissionConfig;
    authContext: WorkspaceAuthContext;
    workspaceId: string;
    nativeAuditOptions: NativeCrmAuditOptions;
    auditBinding: NativeCrmAuditBinding;
    dashboardObjectMetadataId: string | undefined;
    layoutAuditIdentity: {
      auth: WorkspaceAuthContext;
      systemActorId?: string;
      impersonatorUserWorkspaceId?: string;
      correlationId?: string;
      causationId?: string;
    };
  }): Promise<DashboardWorkspaceEntity> {
    const newDashboardId = randomUUID();

    try {
      return await this.createDuplicatedDashboard({
        newDashboardId,
        originalDashboard,
        newPageLayoutId,
        rolePermissionConfig,
        authContext,
        nativeAuditOptions,
      });
    } catch (error) {
      if (isDefined(dashboardObjectMetadataId)) {
        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, options) =>
            this.workspaceOrmManager.runInWorkspaceTransaction(work, options),
          binding: auditBinding,
          action: 'create',
          resourceId: newDashboardId,
          objectMetadataId: dashboardObjectMetadataId,
          error,
        });
      }

      if (!isTransactionUnsafeToRetry(error)) {
        try {
          await this.pageLayoutService.destroy({
            id: newPageLayoutId,
            workspaceId,
            isLinkedDashboardAlreadyDestroyed: true,
            auditIdentity: layoutAuditIdentity,
          });
        } catch (rollbackError) {
          this.logger.error(
            `Failed to destroy page layout ${newPageLayoutId} left by a failed dashboard duplication: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            rollbackError instanceof Error ? rollbackError.stack : undefined,
          );
        }
      }

      throw error;
    }
  }

  private async createDuplicatedDashboard({
    newDashboardId,
    originalDashboard,
    newPageLayoutId,
    rolePermissionConfig,
    authContext,
    nativeAuditOptions,
  }: {
    newDashboardId: string;
    originalDashboard: DashboardWorkspaceEntity;
    newPageLayoutId: string;
    rolePermissionConfig: RolePermissionConfig;
    authContext: WorkspaceAuthContext;
    nativeAuditOptions: NativeCrmAuditOptions;
  }): Promise<DashboardWorkspaceEntity> {
    const newTitle = appendCopySuffix(originalDashboard.title ?? '');

    const [recordWithActor] =
      await this.actorFromAuthContextService.injectActorFieldsOnCreate({
        records: [
          {
            id: newDashboardId,
            title: newTitle,
            pageLayoutId: newPageLayoutId,
            position: originalDashboard.position,
          },
        ],
        objectMetadataNameSingular: 'dashboard',
        authContext,
      });

    return this.workspaceOrmManager.runInWorkspaceTransaction(
      async (transactionScope) => {
        const txDashboardRepository =
          transactionScope.getRepository<DashboardWorkspaceEntity>(
            'dashboard',
            rolePermissionConfig,
          );

        await txDashboardRepository.insert(recordWithActor);

        const newDashboard = await txDashboardRepository.findOne({
          where: { id: newDashboardId },
          select: DUPLICATED_DASHBOARD_COLUMNS,
        });

        if (!isDefined(newDashboard)) {
          throw new DashboardException(
            generateDashboardExceptionMessage(
              DashboardExceptionMessageKey.DASHBOARD_DUPLICATION_FAILED,
              'Failed to retrieve created dashboard',
            ),
            DashboardExceptionCode.DASHBOARD_DUPLICATION_FAILED,
          );
        }

        return newDashboard;
      },
      { nativeAudit: nativeAuditOptions },
    );
  }
}
