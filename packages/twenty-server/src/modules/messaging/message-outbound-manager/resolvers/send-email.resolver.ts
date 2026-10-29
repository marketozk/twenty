import { type SentDraftCleanupTarget } from 'src/engine/core-modules/crm-audit/delete-sent-draft-message-with-audit';
import { type SendMessageResult } from 'src/modules/messaging/message-outbound-manager/types/send-message-result.type';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { EmailOperation } from 'twenty-shared/types';
import {
  ForbiddenException,
  Logger,
  UseFilters,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Args, Context, Mutation } from '@nestjs/graphql';

import { PermissionFlagType } from 'twenty-shared/constants';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { FileEmailAttachmentService } from 'src/engine/core-modules/file/file-email-attachment/services/file-email-attachment.service';
import { ResolverValidationPipe } from 'src/engine/core-modules/graphql/pipes/resolver-validation.pipe';
import { I18nService } from 'src/engine/core-modules/i18n/i18n.service';
import { type I18nContext } from 'src/engine/core-modules/i18n/types/i18n-context.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { EmailComposerService } from 'src/engine/core-modules/tool/tools/email-tool/email-composer.service';
import { AuthUserWorkspaceId } from 'src/engine/decorators/auth/auth-user-workspace-id.decorator';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { SendEmailOutputDTO } from 'src/modules/messaging/message-outbound-manager/dtos/send-email-output.dto';
import { SendEmailInput } from 'src/modules/messaging/message-outbound-manager/dtos/send-email.input';
import { SendEmailService } from 'src/modules/messaging/message-outbound-manager/services/send-email.service';
import { SentMessageRecordLinkService } from 'src/modules/messaging/message-outbound-manager/services/sent-message-record-link.service';
import { CustomException } from 'src/utils/custom-exception';
import { isDefined } from 'twenty-shared/utils';
import { isNonEmptyString } from '@sniptt/guards';

@MetadataResolver()
@UsePipes(ResolverValidationPipe)
@UseFilters(AuthGraphqlApiExceptionFilter)
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
  SettingsPermissionGuard(PermissionFlagType.SEND_EMAIL_TOOL),
)
export class SendEmailResolver {
  private readonly logger = new Logger(SendEmailResolver.name);

  constructor(
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
    private readonly emailComposerService: EmailComposerService,
    private readonly fileEmailAttachmentService: FileEmailAttachmentService,
    private readonly sendEmailService: SendEmailService,
    private readonly sentMessageRecordLinkService: SentMessageRecordLinkService,
    private readonly i18nService: I18nService,
  ) {}

  @Mutation(() => SendEmailOutputDTO)
  async sendEmail(
    @Args('input') input: SendEmailInput,
    @AuthWorkspace() workspace: WorkspaceEntity,
    @AuthUserWorkspaceId() userWorkspaceId: string,
    @Context() context: I18nContext,
  ): Promise<SendEmailOutputDTO> {
    // Capture request values before composing or awaiting the external provider.
    input = { ...input };
    const workspaceId = workspace.id;
    const connectedAccountId = input.connectedAccountId;
    const draftMessageId = input.draftMessageId;
    let cleanupCaller: { userWorkspaceId: string; userId: string } | undefined;
    let cleanupOperation: CrmAuditOperation | undefined;
    try {
      if (isDefined(draftMessageId)) {
        const authentication = getWorkspaceAuthContext();
        if (
          authentication.type !== 'user' ||
          authentication.workspace.id !== workspaceId ||
          authentication.userWorkspaceId !== userWorkspaceId
        )
          throw new ForbiddenException(
            'Draft cleanup requires the authenticated workspace member.',
          );
        cleanupCaller = { userWorkspaceId, userId: authentication.user.id };
        cleanupOperation =
          await this.sendEmailService.captureDraftCleanupAuditOperation(
            workspaceId,
          );
      }
      await this.connectedAccountMetadataService.verifyUsableByCaller({
        id: connectedAccountId,
        userWorkspaceId,
        workspaceId,
      });

      const result = await this.emailComposerService.composeEmail({
        parameters: {
          recipients: {
            to: input.to,
            cc: input.cc ?? '',
            bcc: input.bcc ?? '',
          },
          subject: input.subject,
          body: input.body,
          connectedAccountId,
          fromHandle: input.fromHandle,
          files: input.files ?? [],
          inReplyTo: input.inReplyTo,
        },
        context: { workspaceId },
        operation: EmailOperation.SEND,
      });

      if (!result.success) {
        return {
          success: false,
          error: this.i18nService
            .getI18nInstance(context.req.locale)
            ._(result.error),
        };
      }

      const { data } = result;

      let sendResult: SendMessageResult;
      let cleanupTarget: SentDraftCleanupTarget | undefined;
      if (isDefined(draftMessageId)) {
        const sentDraft = await this.sendEmailService.sendComposedDraft(
          data,
          draftMessageId,
          workspaceId,
        );
        sendResult = sentDraft.sendResult;
        cleanupTarget = { ...sentDraft.cleanupTarget };
      } else {
        sendResult = await this.sendEmailService.sendComposedEmail(data);
      }

      let messageThreadId: string | undefined;

      try {
        const persistedSentMessage = data.shouldPersistMessage
          ? await this.sendEmailService.persistSentMessage(
              sendResult,
              data,
              workspaceId,
            )
          : undefined;

        if (isDefined(draftMessageId)) {
          await this.sendEmailService.deleteSentDraft(
            draftMessageId,
            connectedAccountId,
            workspaceId,
            cleanupCaller!,
            cleanupOperation!,
            cleanupTarget!,
          );
        }

        const sentMessageExternalId =
          sendResult.messageExternalId ?? sendResult.headerMessageId;

        messageThreadId =
          isDefined(draftMessageId) && isNonEmptyString(sentMessageExternalId)
            ? await this.sendEmailService.getSentMessageThreadId(
                sentMessageExternalId,
                workspaceId,
              )
            : undefined;

        const attachmentFileIds = (input.files ?? []).map((file) => file.id);

        if (attachmentFileIds.length > 0) {
          await this.fileEmailAttachmentService.deleteFiles({
            fileIds: attachmentFileIds,
            workspaceId,
          });
        }

        const sentMessageThreadId =
          persistedSentMessage?.messageThreadId ?? messageThreadId;

        if (isDefined(input.targetRecord) && isDefined(sentMessageThreadId)) {
          await this.sentMessageRecordLinkService.linkSentMessageThreadToRecord(
            {
              authContext: getWorkspaceAuthContext(),
              messageThreadId: sentMessageThreadId,
              objectNameSingular: input.targetRecord.objectNameSingular,
              recordId: input.targetRecord.recordId,
            },
          );
        }
      } catch {
        // Provider success is irreversible. Cleanup and logging failures must not invite another send.
        try {
          this.logger.warn('Email sent but post-send cleanup failed.');
        } catch {
          // Preserve the confirmed provider result even when logging is unavailable.
        }
      }

      return { success: true, messageThreadId };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error(`Failed to send email: ${error}`);

      if (error instanceof CustomException) {
        return {
          success: false,
          error: this.i18nService
            .getI18nInstance(context.req.locale)
            ._(error.userFriendlyMessage),
        };
      }

      return { success: false };
    }
  }
}
