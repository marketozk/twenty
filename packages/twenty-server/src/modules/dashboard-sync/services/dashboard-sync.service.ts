import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { captureNativeCrmAuditBinding } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { recordPostRollbackNativeCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { PageLayoutType } from 'twenty-shared/types';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';

const DASHBOARD_SYNC_SYSTEM_ACTOR_ID =
  'dashboard-sync:update-linked-dashboards';
const DASHBOARD_SYNC_UPDATE_CHUNK_SIZE = 200;

@Injectable()
export class DashboardSyncService {
  private readonly logger = new Logger(DashboardSyncService.name);

  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly workspaceManyOrAllFlatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
  ) {}

  private async isPageLayoutOfTypeDashboard({
    pageLayoutId,
    workspaceId,
  }: {
    pageLayoutId: string;
    workspaceId: string;
  }): Promise<boolean> {
    const { flatPageLayoutMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatPageLayoutMaps'],
        },
      );

    const pageLayout = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: pageLayoutId,
      flatEntityMaps: flatPageLayoutMaps,
    });

    return (
      isDefined(pageLayout) && pageLayout.type === PageLayoutType.DASHBOARD
    );
  }

  async updateLinkedDashboardsUpdatedAtByPageLayoutId({
    pageLayoutId,
    workspaceId,
    updatedAt,
  }: {
    pageLayoutId: string;
    workspaceId: string;
    updatedAt: Date;
  }): Promise<void> {
    const isDashboard = await this.isPageLayoutOfTypeDashboard({
      pageLayoutId,
      workspaceId,
    });

    if (!isDashboard) {
      return;
    }

    const authContext = buildSystemAuthContext(workspaceId);

    try {
      await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
        const nativeAudit = {
          operationId: randomUUID(),
          systemActorId: DASHBOARD_SYNC_SYSTEM_ACTOR_ID,
        };
        const auditBinding = captureNativeCrmAuditBinding(
          workspaceId,
          authContext,
          nativeAudit,
        );
        const dashboardObjectMetadataId =
          this.workspaceOrmManager.getObjectMetadataId('dashboard');

        try {
          await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (transactionScope) => {
              const dashboardRepository = transactionScope.getRepository(
                'dashboard',
                {
                  shouldBypassPermissionChecks: true,
                },
              );

              const dashboards = await dashboardRepository.find({
                where: { pageLayoutId },
                select: ['id'],
                order: { id: 'ASC' },
                withDeleted: true,
              });
              const dashboardIds = dashboards.map((dashboard) =>
                String(dashboard.id),
              );

              for (
                let index = 0;
                index < dashboardIds.length;
                index += DASHBOARD_SYNC_UPDATE_CHUNK_SIZE
              ) {
                const chunk = dashboardIds.slice(
                  index,
                  index + DASHBOARD_SYNC_UPDATE_CHUNK_SIZE,
                );

                await dashboardRepository.update(chunk, { updatedAt });
              }
            },
            { nativeAudit },
          );
        } catch (error) {
          if (isDefined(dashboardObjectMetadataId)) {
            await recordPostRollbackNativeCrmAuditAttempt({
              runInAuditTransaction: (work, options) =>
                this.workspaceOrmManager.runInWorkspaceTransaction(
                  work,
                  options,
                ),
              binding: auditBinding,
              action: 'update',
              resourceId: dashboardObjectMetadataId,
              objectMetadataId: dashboardObjectMetadataId,
              error,
            });
          }

          throw error;
        }
      }, authContext);
    } catch (error) {
      this.logger.error(
        `Failed to update dashboard updatedAt for page layout ${pageLayoutId}: ${error}`,
      );
    }
  }

  async updateLinkedDashboardsUpdatedAtByTabId({
    tabId,
    workspaceId,
    updatedAt,
  }: {
    tabId: string;
    workspaceId: string;
    updatedAt: Date;
  }): Promise<void> {
    const { flatPageLayoutTabMaps, flatPageLayoutMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatPageLayoutTabMaps', 'flatPageLayoutMaps'],
        },
      );

    const tab = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: tabId,
      flatEntityMaps: flatPageLayoutTabMaps,
    });

    if (!isDefined(tab)) {
      return;
    }

    const pageLayout = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: tab.pageLayoutId,
      flatEntityMaps: flatPageLayoutMaps,
    });

    if (
      !isDefined(pageLayout) ||
      pageLayout.type !== PageLayoutType.DASHBOARD
    ) {
      return;
    }

    await this.updateLinkedDashboardsUpdatedAtByPageLayoutId({
      pageLayoutId: tab.pageLayoutId,
      workspaceId,
      updatedAt,
    });
  }

  async updateLinkedDashboardsUpdatedAtByWidgetId({
    widgetId,
    workspaceId,
    updatedAt,
  }: {
    widgetId: string;
    workspaceId: string;
    updatedAt: Date;
  }): Promise<void> {
    const {
      flatPageLayoutWidgetMaps,
      flatPageLayoutTabMaps,
      flatPageLayoutMaps,
    } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: [
            'flatPageLayoutWidgetMaps',
            'flatPageLayoutTabMaps',
            'flatPageLayoutMaps',
          ],
        },
      );

    const widget = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: widgetId,
      flatEntityMaps: flatPageLayoutWidgetMaps,
    });

    if (!isDefined(widget)) {
      return;
    }

    const tab = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: widget.pageLayoutTabId,
      flatEntityMaps: flatPageLayoutTabMaps,
    });

    if (!isDefined(tab)) {
      return;
    }

    const pageLayout = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: tab.pageLayoutId,
      flatEntityMaps: flatPageLayoutMaps,
    });

    if (
      !isDefined(pageLayout) ||
      pageLayout.type !== PageLayoutType.DASHBOARD
    ) {
      return;
    }

    await this.updateLinkedDashboardsUpdatedAtByPageLayoutId({
      pageLayoutId: tab.pageLayoutId,
      workspaceId,
      updatedAt,
    });
  }
}
