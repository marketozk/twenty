import { EmailOperation } from 'twenty-shared/types';
import { membershipCleanupIdentityFromWorkspaceAuth } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { captureCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type PersistedSentMessage } from 'src/modules/messaging/message-outbound-manager/types/persisted-sent-message.type';
import { Injectable, Logger } from '@nestjs/common';

import { SOURCE_LOCALE } from 'twenty-shared/translations';

import { I18nService } from 'src/engine/core-modules/i18n/i18n.service';
import { EmailComposerService } from 'src/engine/core-modules/tool/tools/email-tool/email-composer.service';
import { EmailToolInputZodSchema } from 'src/engine/core-modules/tool/tools/email-tool/email-tool.schema';
import { EmailToolException } from 'src/engine/core-modules/tool/tools/email-tool/exceptions/email-tool.exception';
import { isInsufficientPermissionsError } from 'src/engine/core-modules/tool/tools/email-tool/utils/is-insufficient-permissions-error.util';
import { type EmailToolInput } from 'src/engine/core-modules/tool/tools/email-tool/types/email-tool-input.type';
import { type ToolOutput } from 'src/engine/core-modules/tool/types/tool-output.type';
import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';
import { type Tool } from 'src/engine/core-modules/tool/types/tool.type';
import { SendEmailService } from 'src/modules/messaging/message-outbound-manager/services/send-email.service';

@Injectable()
export class SendEmailTool implements Tool {
  private readonly logger = new Logger(SendEmailTool.name);

  description =
    'Send an email using a connected account. Requires SEND_EMAIL_TOOL permission.';
  inputSchema = EmailToolInputZodSchema;

  constructor(
    private readonly emailComposerService: EmailComposerService,
    private readonly sendEmailService: SendEmailService,
    private readonly i18nService: I18nService,
  ) {}

  async execute(
    parameters: EmailToolInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutput> {
    const workspaceId = context.workspaceId;
    const userWorkspaceId = context.userWorkspaceId ?? null;
    const auth = context.authContext;
    const effectiveUserId =
      auth?.type === 'user' ? auth.user.id : context.userId;
    const authApplicationId =
      auth?.type === 'application'
        ? auth.application.id
        : auth?.type === 'user'
          ? (auth.viaApplication ?? auth.application)?.id
          : undefined;
    context = { ...context };
    parameters = { ...parameters };
    try {
      if (
        auth &&
        (auth.workspace.id !== workspaceId ||
          auth.type === 'system' ||
          auth.type === 'pendingActivationUser')
      )
        throw new Error('Email tool requires authenticated audit identity');
      const trustedIdentity = auth
        ? membershipCleanupIdentityFromWorkspaceAuth(auth)
        : undefined;
      const operation = captureCrmAuditOperation(
        await this.sendEmailService.captureRequestAuditOperation(
          workspaceId,
          trustedIdentity,
        ),
      );
      const applicationId =
        authApplicationId ??
        (operation.actor.kind === 'application'
          ? operation.actor.id
          : operation.initiator?.kind === 'application'
            ? operation.initiator.id
            : undefined);
      if (operation.actor.kind === 'agent' && !applicationId)
        throw new Error(
          'Email tool agent requires its authenticated application',
        );
      const result = await this.emailComposerService.composeEmail({
        parameters,
        context,
        operation: EmailOperation.SEND,
      });

      if (!result.success) {
        const errorMessage = this.i18nService
          .getI18nInstance(SOURCE_LOCALE)
          ._(result.error);

        return { success: false, message: errorMessage, error: errorMessage };
      }

      const data = {
        ...result.data,
        connectedAccount: { ...result.data.connectedAccount },
      };
      const matchingContext = Object.freeze({
        kind: 'sent-tool' as const,
        operation,
        userWorkspaceId,
        effectiveUserId,
        applicationId,
        connectedAccountId: data.connectedAccount.id,
        messageChannelId: data.messageChannelId,
      });

      const sendResult = await this.sendEmailService.sendComposedEmail(data);

      let persistedMessage: PersistedSentMessage | undefined;
      try {
        persistedMessage = data.shouldPersistMessage
          ? await this.sendEmailService.persistSentMessage(
              sendResult,
              data,
              workspaceId,
              matchingContext,
            )
          : undefined;

        this.logger.log(
          `Email sent successfully to ${data.toRecipientsDisplay}${data.attachments.length > 0 ? ` with ${data.attachments.length} attachments` : ''}`,
        );
      } catch {
        // The provider result remains successful after persistence or logging failure.
      }

      return {
        success: true,
        message: `Email sent successfully to ${data.toRecipientsDisplay}`,
        result: {
          recipients: data.recipients.to,
          ccRecipients: data.recipients.cc,
          bccRecipients: data.recipients.bcc,
          subject: data.sanitizedSubject,
          sanitizedHtmlBody: data.sanitizedHtmlBody,
          plainTextBody: data.plainTextBody,
          connectedAccountId: data.connectedAccount.id,
          attachmentCount: data.attachments.length,
          headerMessageId: sendResult.headerMessageId,
          threadExternalId: sendResult.threadExternalId,
          messageId: persistedMessage?.messageId,
          messageThreadId: persistedMessage?.messageThreadId,
        },
      };
    } catch (error) {
      if (error instanceof EmailToolException) {
        return {
          success: false,
          message: 'Failed to send email',
          error: error.message,
        };
      }

      this.logger.error(`Failed to send email: ${error}`);

      if (isInsufficientPermissionsError(error)) {
        return {
          success: false,
          message: 'Failed to send email due to insufficient permissions',
          error:
            'The connected email account does not have permission to send emails.',
        };
      }

      return {
        success: false,
        message: 'Failed to send email',
        error: error instanceof Error ? error.message : 'Failed to send email',
      };
    }
  }
}
