import { UseGuards, UseInterceptors, UseFilters } from '@nestjs/common';
import { Args, Mutation, Query } from '@nestjs/graphql';

import { UUIDScalarType } from 'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars';
import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthUserWorkspaceId } from 'src/engine/decorators/auth/auth-user-workspace-id.decorator';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { AllowSuspendedWorkspace } from 'src/engine/decorators/auth/allow-suspended-workspace.decorator';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { CalendarChannelMetadataService } from 'src/engine/metadata-modules/calendar-channel/calendar-channel-metadata.service';
import { CalendarChannelDTO } from 'src/engine/metadata-modules/calendar-channel/dtos/calendar-channel.dto';
import { UpdateCalendarChannelInput } from 'src/engine/metadata-modules/calendar-channel/dtos/update-calendar-channel.input';
import { CalendarChannelGraphqlApiExceptionInterceptor } from 'src/engine/metadata-modules/calendar-channel/interceptors/calendar-channel-graphql-api-exception.interceptor';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { AuthUser } from 'src/engine/decorators/auth/auth-user.decorator';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';

@UseGuards(
  AuthPrincipalGuard({
    userSession: {
      standard: true,
      impersonated: true,
      playground: true,
      workspaceAgnostic: false,
    },
    apiKey: true,
    oauthClient: true,
    application: true,
  }),
)
@UseInterceptors(CalendarChannelGraphqlApiExceptionInterceptor)
@MetadataResolver(() => CalendarChannelDTO)
@UseFilters(AuthGraphqlApiExceptionFilter)
export class CalendarChannelResolver {
  constructor(
    private readonly calendarChannelMetadataService: CalendarChannelMetadataService,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
  ) {}

  @Query(() => [CalendarChannelDTO])
  @UseGuards(NoPermissionGuard)
  @AllowSuspendedWorkspace()
  async myCalendarChannels(
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
    @Args('connectedAccountId', {
      type: () => UUIDScalarType,
      nullable: true,
    })
    connectedAccountId?: string,
  ): Promise<CalendarChannelDTO[]> {
    if (connectedAccountId) {
      return this.calendarChannelMetadataService.findByConnectedAccountIdForUser(
        {
          connectedAccountId,
          userWorkspaceId,
          workspaceId: workspace.id,
        },
      );
    }

    return this.calendarChannelMetadataService.findByUserWorkspaceId({
      userWorkspaceId,
      workspaceId: workspace.id,
    });
  }

  @Mutation(() => CalendarChannelDTO)
  @UseGuards(NoPermissionGuard)
  async updateCalendarChannel(
    @Args('input') input: UpdateCalendarChannelInput,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
    @AuthUser() user: { id: string },
  ): Promise<CalendarChannelDTO> {
    const id = input.id;
    const workspaceId = workspace.id;
    const data = { ...input.update };
    const caller = { userWorkspaceId, userId: user.id };
    const result = await this.calendarChannelMetadataService.update({
      id,
      workspaceId,
      data,
      caller,
    });
    // Reset is already committed. Only invalidate its pinned current cache key.
    if (result.resetChannel) {
      try {
        await this.calendarChannelSyncStatusService.flushImportCache(
          [result.resetChannel],
          workspaceId,
        );
      } catch (error) {
        throw new CoreAuditPostCommitError(error);
      }
    }
    return result.calendarChannel as unknown as CalendarChannelDTO;
  }
}
