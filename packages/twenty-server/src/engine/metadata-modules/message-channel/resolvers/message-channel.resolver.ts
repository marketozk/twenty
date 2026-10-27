import { UseGuards, UseInterceptors, UseFilters } from '@nestjs/common';
import {
  Args,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
} from '@nestjs/graphql';

import { PermissionFlagType } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';

import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import { UUIDScalarType } from 'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars';
import { buildPublicConnectedAccount } from 'src/engine/metadata-modules/connected-account/utils/build-public-connected-account.util';
import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthApplication } from 'src/engine/decorators/auth/auth-application.decorator';
import { AuthUserWorkspaceId } from 'src/engine/decorators/auth/auth-user-workspace-id.decorator';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { AllowSuspendedWorkspace } from 'src/engine/decorators/auth/allow-suspended-workspace.decorator';
import { CustomPermissionGuard } from 'src/engine/guards/custom-permission.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { ConnectedAccountPublicDTO } from 'src/engine/metadata-modules/connected-account/dtos/connected-account-public.dto';
import { CreateEmailGroupChannelInput } from 'src/engine/metadata-modules/message-channel/dtos/create-email-group-channel.input';
import { UpdateEmailGroupChannelInput } from 'src/engine/metadata-modules/message-channel/dtos/update-email-group-channel.input';
import { CreateEmailGroupChannelOutput } from 'src/engine/metadata-modules/message-channel/dtos/create-email-group-channel.output';
import { MessageChannelDTO } from 'src/engine/metadata-modules/message-channel/dtos/message-channel.dto';
import { UpdateMessageChannelInput } from 'src/engine/metadata-modules/message-channel/dtos/update-message-channel.input';
import { MessageChannelGraphqlApiExceptionInterceptor } from 'src/engine/metadata-modules/message-channel/interceptors/message-channel-graphql-api-exception.interceptor';
import { MessageChannelMetadataService } from 'src/engine/metadata-modules/message-channel/message-channel-metadata.service';
import { ApplicationMessageChannelsService } from 'src/engine/metadata-modules/message-channel/services/application-message-channels.service';
import {
  MessageChannelException,
  MessageChannelExceptionCode,
} from 'src/engine/metadata-modules/message-channel/message-channel.exception';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { MessageChannelType } from 'twenty-shared/types';

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
@UseInterceptors(MessageChannelGraphqlApiExceptionInterceptor)
@MetadataResolver(() => MessageChannelDTO)
@UseFilters(AuthGraphqlApiExceptionFilter)
export class MessageChannelResolver {
  constructor(
    private readonly messageChannelMetadataService: MessageChannelMetadataService,
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
    private readonly applicationMessageChannelsService: ApplicationMessageChannelsService,
  ) {}

  @ResolveField('importProgress', () => Int, { nullable: true })
  async importProgress(
    @Parent() messageChannel: MessageChannelDTO,
    @AuthWorkspace() workspace: WorkspaceEntity,
  ): Promise<number | null> {
    return this.messageChannelMetadataService.getImportProgress({
      messageChannelId: messageChannel.id,
      workspaceId: workspace.id,
    });
  }

  @ResolveField('connectedAccount', () => ConnectedAccountPublicDTO, {
    nullable: true,
  })
  async connectedAccount(
    @Parent() messageChannel: MessageChannelDTO,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId({ allowUndefined: true }) userWorkspaceId?: string,
    @AuthApplication({ allowUndefined: true }) application?: FlatApplication,
  ): Promise<ConnectedAccountPublicDTO | null> {
    if (messageChannel.type === MessageChannelType.EMAIL_GROUP) {
      const account = await this.connectedAccountMetadataService.findById({
        id: messageChannel.connectedAccountId,
        workspaceId: workspace.id,
      });

      return buildPublicConnectedAccount(account);
    }

    // app connections have no member owner, so reachability is delegated to the app-facing predicate, which also
    // stops one member reaching another's private connection through the app
    if (
      isDefined(application) &&
      messageChannel.type === MessageChannelType.APP
    ) {
      const account =
        await this.applicationMessageChannelsService.findReachableConnectedAccount(
          {
            applicationId: application.id,
            workspaceId: workspace.id,
            requestUserWorkspaceId: userWorkspaceId ?? null,
            connectedAccountId: messageChannel.connectedAccountId,
          },
        );

      return isDefined(account) ? buildPublicConnectedAccount(account) : null;
    }

    if (!isDefined(userWorkspaceId)) {
      return null;
    }

    const account =
      await this.connectedAccountMetadataService.findByIdAndUserWorkspaceId({
        id: messageChannel.connectedAccountId,
        userWorkspaceId,
        workspaceId: workspace.id,
      });

    return buildPublicConnectedAccount(account);
  }

  @Query(() => [MessageChannelDTO])
  @UseGuards(NoPermissionGuard)
  @AllowSuspendedWorkspace()
  async myMessageChannels(
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
    @Args('connectedAccountId', {
      type: () => UUIDScalarType,
      nullable: true,
    })
    connectedAccountId?: string,
  ): Promise<MessageChannelDTO[]> {
    if (connectedAccountId) {
      return this.messageChannelMetadataService.findByConnectedAccountIdForUser(
        {
          connectedAccountId,
          userWorkspaceId,
          workspaceId: workspace.id,
        },
      );
    }

    return this.messageChannelMetadataService.findByUserWorkspaceId({
      userWorkspaceId,
      workspaceId: workspace.id,
    });
  }

  @Mutation(() => MessageChannelDTO)
  @UseGuards(CustomPermissionGuard)
  async updateMessageChannel(
    @Args('input') input: UpdateMessageChannelInput,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
    @AuthApplication({ allowUndefined: true }) application?: FlatApplication,
  ): Promise<MessageChannelDTO> {
    const messageChannel =
      await this.messageChannelMetadataService.verifyAdministrableByCaller({
        id: input.id,
        userWorkspaceId,
        workspaceId: workspace.id,
        applicationId: application?.id,
        agentId: undefined,
      });

    // app channel settings belong to the creating app and go through updateAppMessageChannel
    if (messageChannel.type === MessageChannelType.APP) {
      throw new MessageChannelException(
        `Message channel ${input.id} is owned by an application and cannot be updated through this endpoint`,
        MessageChannelExceptionCode.MESSAGE_CHANNEL_OWNERSHIP_VIOLATION,
      );
    }

    return this.messageChannelMetadataService.update({
      id: input.id,
      workspaceId: workspace.id,
      data: input.update,
      settingsCaller: {
        connectedAccountId: messageChannel.connectedAccountId,
        userWorkspaceId,
        applicationId: application?.id,
      },
    });
  }

  @Mutation(() => CreateEmailGroupChannelOutput)
  @UseGuards(SettingsPermissionGuard(PermissionFlagType.WORKSPACE))
  async createEmailGroupChannel(
    @Args('input') input: CreateEmailGroupChannelInput,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
  ): Promise<CreateEmailGroupChannelOutput> {
    return this.messageChannelMetadataService.createEmailGroupChannel({
      handle: input.handle,
      displayName: input.displayName,
      userWorkspaceId,
      workspaceId: workspace.id,
    });
  }

  @Mutation(() => MessageChannelDTO)
  @UseGuards(SettingsPermissionGuard(PermissionFlagType.WORKSPACE))
  async updateEmailGroupChannel(
    @Args('input') input: UpdateEmailGroupChannelInput,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
  ): Promise<MessageChannelDTO> {
    return this.messageChannelMetadataService.updateEmailGroupChannel({
      id: input.id,
      displayName: input.displayName,
      userWorkspaceId,
      workspaceId: workspace.id,
    });
  }

  @Mutation(() => MessageChannelDTO)
  @UseGuards(SettingsPermissionGuard(PermissionFlagType.WORKSPACE))
  async deleteEmailGroupChannel(
    @Args('id', { type: () => UUIDScalarType }) id: string,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
  ): Promise<MessageChannelDTO> {
    return this.messageChannelMetadataService.deleteEmailGroupChannel({
      id,
      userWorkspaceId,
      workspaceId: workspace.id,
    });
  }
}
