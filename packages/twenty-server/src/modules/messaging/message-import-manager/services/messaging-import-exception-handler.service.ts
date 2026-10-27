import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { MAIL_SERVER_CERTIFICATE_INVALID_AUTH_FAILED_REASON } from 'twenty-shared/constants';
import { MessageChannelSyncStatus } from 'twenty-shared/types';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { ConnectedAccountRefreshAccessTokenExceptionCode } from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import { TwentyOrmExceptionCode } from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { MESSAGING_THROTTLE_MAX_ATTEMPTS } from 'src/modules/messaging/message-import-manager/constants/messaging-throttle-max-attempts';
import {
  MessageImportDriverException,
  MessageImportDriverExceptionCode,
} from 'src/modules/messaging/message-import-manager/drivers/exceptions/message-import-driver.exception';
import { MessageNetworkExceptionCode } from 'src/modules/messaging/message-import-manager/drivers/exceptions/message-network.exception';
import { MessagingMonitoringService } from 'src/modules/messaging/monitoring/services/messaging-monitoring.service';

export enum MessageImportSyncStep {
  MESSAGE_LIST_FETCH = 'MESSAGE_LIST_FETCH',
  MESSAGES_IMPORT_PENDING = 'MESSAGES_IMPORT_PENDING',
  MESSAGES_IMPORT_ONGOING = 'MESSAGES_IMPORT_ONGOING',
}

@Injectable()
export class MessageImportExceptionHandlerService {
  constructor(
    private readonly messageChannelSyncStatusService: MessageChannelSyncStatusService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
    private readonly messagingMonitoringService: MessagingMonitoringService,
  ) {}

  public async handleDriverException(
    exception: unknown,
    syncStep: MessageImportSyncStep,
    messageChannel: Pick<
      MessageChannelEntity,
      'id' | 'throttleFailureCount' | 'connectedAccountId'
    >,
    workspaceId: string,
  ): Promise<void> {
    if (
      exception instanceof OmniCoreTransactionOutcomeUnknownError ||
      exception instanceof NativeTransactionOutcomeUnknownError
    )
      throw exception;
    const error =
      exception instanceof Error ? exception : new Error(String(exception));

    if (error instanceof MessageImportDriverException) {
      error.context = {
        ...error.context,
        messageChannelId: messageChannel.id,
        workspaceId,
        syncStep,
      };
    }

    if ('code' in error) {
      switch (error.code) {
        case MessageImportDriverExceptionCode.NOT_FOUND:
          await this.handleNotFoundException(
            syncStep,
            messageChannel,
            workspaceId,
          );
          break;
        case TwentyOrmExceptionCode.QUERY_READ_TIMEOUT:
        case TwentyOrmExceptionCode.TRANSIENT_DATABASE_ERROR:
        case MessageImportDriverExceptionCode.TEMPORARY_ERROR:
        case ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR:
        case MessageNetworkExceptionCode.ECONNABORTED:
        case MessageNetworkExceptionCode.ENOTFOUND:
        case MessageNetworkExceptionCode.ECONNRESET:
        case MessageNetworkExceptionCode.ETIMEDOUT:
        case MessageNetworkExceptionCode.ERR_NETWORK:
          await this.handleTemporaryException(
            syncStep,
            messageChannel,
            workspaceId,
            error,
          );
          break;
        case ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND:
        case ConnectedAccountRefreshAccessTokenExceptionCode.INVALID_REFRESH_TOKEN:
          await this.messagingMonitoringService.track({
            eventName: `refresh_token.error.insufficient_permissions`,
            workspaceId,
            connectedAccountId: messageChannel.connectedAccountId,
            messageChannelId: messageChannel.id,
            message: `${error.code}: ${error.message ?? ''}`,
          });
          await this.handleInsufficientPermissionsException(
            messageChannel,
            workspaceId,
          );
          break;
        case MessageImportDriverExceptionCode.INSUFFICIENT_PERMISSIONS:
          await this.handleInsufficientPermissionsException(
            messageChannel,
            workspaceId,
          );
          break;
        case MessageImportDriverExceptionCode.SERVER_CERTIFICATE_INVALID:
          await this.messageChannelSyncStatusService.markAsFailed({
            messageChannelIds: [messageChannel.id],
            workspaceId,
            syncStatus:
              MessageChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
            expectedConnectedAccountId: messageChannel.connectedAccountId,
            authFailedReason:
              MAIL_SERVER_CERTIFICATE_INVALID_AUTH_FAILED_REASON,
          });
          break;
        case MessageImportDriverExceptionCode.SYNC_CURSOR_ERROR:
          await this.handleSyncCursorErrorException(
            messageChannel,
            workspaceId,
          );
          break;
        case ConnectedAccountRefreshAccessTokenExceptionCode.ACCESS_TOKEN_NOT_FOUND:
        case ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED:
        case MessageImportDriverExceptionCode.CHANNEL_MISCONFIGURED:
        case MessageImportDriverExceptionCode.ACCESS_TOKEN_MISSING:
        case MessageImportDriverExceptionCode.PROVIDER_NOT_SUPPORTED:
        case MessageImportDriverExceptionCode.UNKNOWN:
        case MessageImportDriverExceptionCode.UNKNOWN_NETWORK_ERROR:
        default:
          await this.handleUnknownException(
            error,
            messageChannel,
            workspaceId,
            syncStep,
          );
          break;
      }
    } else {
      await this.handleUnknownException(
        error,
        messageChannel,
        workspaceId,
        syncStep,
      );
    }
  }

  private async handleSyncCursorErrorException(
    messageChannel: Pick<MessageChannelEntity, 'id'>,
    workspaceId: string,
  ): Promise<void> {
    await this.messageChannelSyncStatusService.resetAndMarkAsMessagesListFetchPending(
      [messageChannel.id],
      workspaceId,
    );
  }

  private async handleTemporaryException(
    syncStep: MessageImportSyncStep,
    messageChannel: Pick<
      MessageChannelEntity,
      'id' | 'throttleFailureCount' | 'connectedAccountId'
    >,
    workspaceId: string,
    exception: { message: string },
  ): Promise<void> {
    const retryAfter =
      exception instanceof MessageImportDriverException
        ? exception.throttleRetryAfter
        : undefined;
    const result =
      await this.messageChannelSyncStatusService.recordTemporaryFailure(
        messageChannel.id,
        messageChannel.connectedAccountId,
        workspaceId,
        syncStep === MessageImportSyncStep.MESSAGE_LIST_FETCH,
        MESSAGING_THROTTLE_MAX_ATTEMPTS,
        isDefined(retryAfter) ? retryAfter.toISOString() : null,
      );
    if (!result) return;
    if (result.exhausted) {
      this.exceptionHandlerService.captureExceptions(
        [
          new Error(
            `Temporary error occurred ${MESSAGING_THROTTLE_MAX_ATTEMPTS} times while importing messages for message channel ${messageChannel.id} in workspace ${workspaceId}: ${exception?.message}`,
          ),
        ],
        {
          additionalData: {
            messageChannelId: messageChannel.id,
            syncStep,
            throttleFailureCount: result.failureCount,
          },
          workspace: { id: workspaceId },
        },
      );

      return;
    }
  }

  private async handleInsufficientPermissionsException(
    messageChannel: Pick<MessageChannelEntity, 'id' | 'connectedAccountId'>,
    workspaceId: string,
  ): Promise<void> {
    await this.messageChannelSyncStatusService.markAsFailed({
      messageChannelIds: [messageChannel.id],
      workspaceId,
      expectedConnectedAccountId: messageChannel.connectedAccountId,
      syncStatus: MessageChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
    });
  }

  private async handleUnknownException(
    exception: Error,
    messageChannel: Pick<MessageChannelEntity, 'id'>,
    workspaceId: string,
    syncStep: MessageImportSyncStep,
  ): Promise<void> {
    this.exceptionHandlerService.captureExceptions([exception], {
      additionalData: {
        messageChannelId: messageChannel.id,
        syncStep,
      },
      workspace: { id: workspaceId },
    });
    await this.messageChannelSyncStatusService.markAsFailed({
      messageChannelIds: [messageChannel.id],
      workspaceId,
      syncStatus: MessageChannelSyncStatus.FAILED_UNKNOWN,
    });
  }

  private async handleNotFoundException(
    syncStep: MessageImportSyncStep,
    messageChannel: Pick<MessageChannelEntity, 'id'>,
    workspaceId: string,
  ): Promise<void> {
    if (syncStep === MessageImportSyncStep.MESSAGE_LIST_FETCH) {
      await this.messageChannelSyncStatusService.markAsFailed({
        messageChannelIds: [messageChannel.id],
        workspaceId,
        syncStatus: MessageChannelSyncStatus.FAILED_UNKNOWN,
      });

      this.exceptionHandlerService.captureExceptions(
        [
          new Error(
            'Not Found exception occurred while fetching message list, which should never happen',
          ),
        ],
        {
          additionalData: {
            messageChannelId: messageChannel.id,
            syncStep,
          },
          workspace: { id: workspaceId },
        },
      );

      return;
    }

    await this.messageChannelSyncStatusService.resetAndMarkAsMessagesListFetchPending(
      [messageChannel.id],
      workspaceId,
    );
  }
}
