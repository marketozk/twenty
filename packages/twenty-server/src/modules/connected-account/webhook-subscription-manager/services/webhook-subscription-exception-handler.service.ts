import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { Injectable } from '@nestjs/common';

import { type WebhookSubscriptionChannelType } from 'twenty-shared/types';

import {
  ConnectedAccountRefreshAccessTokenException,
  ConnectedAccountRefreshAccessTokenExceptionCode,
} from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import {
  WebhookSubscriptionDriverException,
  WebhookSubscriptionDriverExceptionCode,
} from 'src/modules/connected-account/webhook-subscription-manager/drivers/exceptions/webhook-subscription-driver.exception';
import { WebhookSubscriptionStatusService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-status.service';
import {
  type WebhookSubscribableChannel,
  type WebhookSubscriptionOperation,
  type WebhookSubscriptionRecoveryAction,
  type WebhookSubscriptionSnapshot,
} from 'src/modules/connected-account/webhook-subscription-manager/types/webhook-subscription-driver.type';

type WebhookSubscribableChannelReference = Pick<
  WebhookSubscribableChannel,
  'id' | 'webhookSubscriptionExternalId' | 'connectedAccountId'
>;

@Injectable()
export class WebhookSubscriptionExceptionHandlerService {
  constructor(
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
  ) {}

  public async handleDriverException(
    exception: unknown,
    operation: WebhookSubscriptionOperation,
    channelType: WebhookSubscriptionChannelType,
    channel: WebhookSubscribableChannelReference,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<WebhookSubscriptionRecoveryAction> {
    if (exception instanceof OmniCoreTransactionOutcomeUnknownError)
      throw exception;
    if (exception instanceof WebhookSubscriptionDriverException) {
      switch (exception.code) {
        case WebhookSubscriptionDriverExceptionCode.NOT_FOUND:
          return await this.handleNotFoundException(
            exception,
            operation,
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
        case WebhookSubscriptionDriverExceptionCode.INSUFFICIENT_PERMISSIONS:
          return await this.handleInsufficientPermissionsException(
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
        case WebhookSubscriptionDriverExceptionCode.TEMPORARY_ERROR:
          return await this.handleTemporaryException(
            exception,
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
        case WebhookSubscriptionDriverExceptionCode.PROVIDER_NOT_CONFIGURED:
        case WebhookSubscriptionDriverExceptionCode.PROVIDER_RESPONSE_INVALID:
        case WebhookSubscriptionDriverExceptionCode.UNSUPPORTED_PROVIDER:
        case WebhookSubscriptionDriverExceptionCode.UNKNOWN:
        default:
          return await this.handleUnknownException(
            exception,
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
      }
    }

    if (exception instanceof ConnectedAccountRefreshAccessTokenException) {
      switch (exception.code) {
        case ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND:
        case ConnectedAccountRefreshAccessTokenExceptionCode.INVALID_REFRESH_TOKEN:
          return await this.handleInsufficientPermissionsException(
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
        case ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR:
          return await this.handleTemporaryException(
            exception,
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
        case ConnectedAccountRefreshAccessTokenExceptionCode.ACCESS_TOKEN_NOT_FOUND:
        case ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED:
        default:
          return await this.handleUnknownException(
            exception,
            channelType,
            channel,
            workspaceId,
            expectedSubscription,
          );
      }
    }

    return await this.handleUnknownException(
      exception,
      channelType,
      channel,
      workspaceId,
      expectedSubscription,
    );
  }

  private async handleNotFoundException(
    exception: unknown,
    operation: WebhookSubscriptionOperation,
    channelType: WebhookSubscriptionChannelType,
    channel: WebhookSubscribableChannelReference,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<WebhookSubscriptionRecoveryAction> {
    if (operation === 'CREATE') {
      return await this.handleInsufficientPermissionsException(
        channelType,
        channel,
        workspaceId,
        expectedSubscription,
      );
    }

    const cleared =
      await this.webhookSubscriptionStatusService.clearRemovedSubscription(
        channelType,
        channel.id,
        workspaceId,
        channel.webhookSubscriptionExternalId,
        channel.connectedAccountId,
        expectedSubscription,
      );

    return cleared ? 'RECREATE' : 'NONE';
  }

  private async handleInsufficientPermissionsException(
    channelType: WebhookSubscriptionChannelType,
    channel: WebhookSubscribableChannelReference,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<WebhookSubscriptionRecoveryAction> {
    await this.webhookSubscriptionStatusService.markAsExpired(
      channelType,
      channel.id,
      workspaceId,
      channel.connectedAccountId,
      expectedSubscription,
    );

    return 'NONE';
  }

  private async handleTemporaryException(
    exception:
      | WebhookSubscriptionDriverException
      | ConnectedAccountRefreshAccessTokenException,
    channelType: WebhookSubscriptionChannelType,
    channel: WebhookSubscribableChannelReference,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<WebhookSubscriptionRecoveryAction> {
    await this.webhookSubscriptionStatusService.markAsFailed(
      channelType,
      channel.id,
      workspaceId,
      channel.connectedAccountId,
      expectedSubscription,
    );

    throw exception;
  }

  private async handleUnknownException(
    exception: unknown,
    channelType: WebhookSubscriptionChannelType,
    channel: WebhookSubscribableChannelReference,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<WebhookSubscriptionRecoveryAction> {
    await this.webhookSubscriptionStatusService.markAsFailed(
      channelType,
      channel.id,
      workspaceId,
      channel.connectedAccountId,
      expectedSubscription,
    );

    throw exception;
  }
}
