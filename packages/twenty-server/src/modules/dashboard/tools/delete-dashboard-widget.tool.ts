import { z } from 'zod';

import {
  type DashboardToolContext,
  type DashboardToolDependencies,
} from 'src/modules/dashboard/tools/types/dashboard-tool-dependencies.type';

const deleteDashboardWidgetSchema = z.object({
  widgetId: z.string().uuid().describe('The UUID of the widget to delete'),
});

export const createDeleteDashboardWidgetTool = (
  deps: Pick<DashboardToolDependencies, 'pageLayoutWidgetService'>,
  context: DashboardToolContext,
) => ({
  name: 'delete_dashboard_widget' as const,
  description: `Delete a widget from a dashboard. Use get_dashboard first to find the widgetId.`,
  inputSchema: deleteDashboardWidgetSchema,
  execute: async (parameters: { widgetId: string }) => {
    try {
      const widget = await deps.pageLayoutWidgetService.findByIdOrThrow({
        id: parameters.widgetId,
        workspaceId: context.workspaceId,
      });

      await deps.pageLayoutWidgetService.destroy({
        id: parameters.widgetId,
        workspaceId: context.workspaceId,
        auditIdentity: context.auditIdentity,
        authUserWorkspaceId: context.authUserWorkspaceId,
        defaultSystemActorId: 'dashboard-tool:delete-dashboard-widget',
      });

      return {
        success: true,
        message: `Widget "${widget.title}" deleted`,
        result: {
          deletedWidgetId: parameters.widgetId,
          deletedWidgetTitle: widget.title,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        success: false,
        message: `Failed to delete widget: ${errorMessage}`,
        error: errorMessage,
      };
    }
  },
});
