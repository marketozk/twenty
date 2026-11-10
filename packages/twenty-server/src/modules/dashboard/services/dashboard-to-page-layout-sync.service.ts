import { Injectable } from '@nestjs/common';

import { msg } from '@lingui/core/macro';
import { isDefined } from 'twenty-shared/utils';
import { In } from 'typeorm';

import { type NavigationMenuItemAuditIdentity } from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { PageLayoutTabService } from 'src/engine/metadata-modules/page-layout-tab/services/page-layout-tab.service';
import { PageLayoutType } from 'twenty-shared/types';
import { PageLayoutService } from 'src/engine/metadata-modules/page-layout/services/page-layout.service';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { i18nLabel } from 'src/engine/workspace-manager/twenty-standard-application/utils/i18n-label.util';
import type { DashboardWorkspaceEntity } from 'src/modules/dashboard/standard-objects/dashboard.workspace-entity';

@Injectable()
export class DashboardToPageLayoutSyncService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly pageLayoutService: PageLayoutService,
    private readonly pageLayoutTabService: PageLayoutTabService,
  ) {}

  public async createPageLayoutForDashboard({
    workspaceId,
    auditIdentity,
  }: {
    workspaceId: string;
    auditIdentity?: NavigationMenuItemAuditIdentity;
  }): Promise<string> {
    const pageLayout = await this.pageLayoutService.create({
      createPageLayoutInput: {
        type: PageLayoutType.DASHBOARD,
        objectMetadataId: null,
        name: 'Dashboard Layout',
      },
      workspaceId,
      auditIdentity,
      defaultSystemActorId: 'dashboard-to-page-layout-sync:create',
    });

    await this.pageLayoutTabService.create({
      createPageLayoutTabInput: {
        title: i18nLabel(
          msg({ message: `Tab 1`, context: 'pageLayoutTab.title' }),
        ),
        pageLayoutId: pageLayout.id,
      },
      workspaceId,
      auditIdentity,
      defaultSystemActorId: 'dashboard-to-page-layout-sync:create',
    });

    return pageLayout.id;
  }

  public async destroyPageLayoutsForDashboards({
    dashboardIds,
    workspaceId,
    auditIdentity,
  }: {
    dashboardIds: string[];
    workspaceId: string;
    auditIdentity?: NavigationMenuItemAuditIdentity;
  }): Promise<void> {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const dashboardRepository =
        this.workspaceOrmManager.getRepository<DashboardWorkspaceEntity>(
          'dashboard',
          { shouldBypassPermissionChecks: true },
        );

      const dashboards = await dashboardRepository.find({
        where: {
          id: In(dashboardIds),
        },
        withDeleted: true,
      });

      const pageLayoutIds = dashboards
        .map((dashboard) => dashboard.pageLayoutId)
        .filter(isDefined);

      await this.pageLayoutService.destroyMany({
        ids: pageLayoutIds,
        workspaceId,
        auditIdentity,
      });
    }, authContext);
  }
}
