import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  WebhookSubscriptionChannelType,
  WebhookSubscriptionStatus,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import {
  WebhookSubscriptionDriverException,
  WebhookSubscriptionDriverExceptionCode,
} from 'src/modules/connected-account/webhook-subscription-manager/drivers/exceptions/webhook-subscription-driver.exception';
import { WebhookSubscriptionDriverFactory } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-driver-factory.service';
import { WebhookSubscriptionExceptionHandlerService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-exception-handler.service';
import { WebhookSubscriptionStatusService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-status.service';
import { WorkspaceActivationService } from 'src/modules/connected-account/webhook-subscription-manager/services/workspace-activation.service';
import {
  type WebhookSubscriptionContext,
  type WebhookSubscriptionResult,
  type WebhookSubscriptionSnapshot,
} from 'src/modules/connected-account/webhook-subscription-manager/types/webhook-subscription-driver.type';

import {
  matchesWebhookSubscription,
  webhookSubscriptionSnapshot,
} from 'src/modules/connected-account/webhook-subscription-manager/utils/webhook-subscription-snapshot';

@Injectable()
export class MessagingWebhookSubscriptionService {
  constructor(
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly workspaceActivationService: WorkspaceActivationService,
    private readonly webhookSubscriptionDriverFactory: WebhookSubscriptionDriverFactory,
    private readonly metricsService: MetricsService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    private readonly webhookSubscriptionExceptionHandlerService: WebhookSubscriptionExceptionHandlerService,
  ) {}

  async createSubscription(
    messageChannelId: string,
    workspaceId: string,
    expectedSubscription?: WebhookSubscriptionSnapshot,
  ): Promise<void> {
    expectedSubscription =
      expectedSubscription && webhookSubscriptionSnapshot(expectedSubscription);
    const isWorkspaceServiceable =
      await this.workspaceActivationService.isWorkspaceServiceable(workspaceId);

    if (!isWorkspaceServiceable) {
      return;
    }

    const messageChannel = await this.messageChannelRepository.findOne({
      where: { id: messageChannelId, workspaceId },
      relations: ['connectedAccount'],
    });

    if (!isDefined(messageChannel?.connectedAccount)) {
      return;
    }

    if (
      expectedSubscription &&
      !matchesWebhookSubscription(messageChannel, expectedSubscription)
    )
      return;
    const snapshot = webhookSubscriptionSnapshot(messageChannel);

    const { connectedAccount } = messageChannel;

    if (
      !this.webhookSubscriptionDriverFactory.isProviderSupported(
        connectedAccount.provider,
      )
    ) {
      return;
    }

    if (
      messageChannel.webhookSubscriptionStatus ===
      WebhookSubscriptionStatus.ACTIVE
    ) {
      return;
    }

    const driver = this.webhookSubscriptionDriverFactory.getDriver(
      connectedAccount.provider,
    );

    // Keep any existing watch live until the replacement is created, then stop it.
    const previousSubscription = isDefined(
      messageChannel.webhookSubscriptionExternalId,
    )
      ? this.toContext(messageChannel)
      : null;

    const clientState =
      await this.webhookSubscriptionStatusService.claimSubscriptionCreation(
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannel.id,
        workspaceId,
        messageChannel.connectedAccountId,
        snapshot,
      );

    if (!isDefined(clientState)) {
      return;
    }

    const claimedSnapshot = {
      ...snapshot,
      webhookSubscriptionClientState: clientState,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
    };
    let result: WebhookSubscriptionResult;

    try {
      result = await driver.createSubscription(
        messageChannel.connectedAccountId,
        WebhookSubscriptionChannelType.MESSAGING,
        clientState,
      );
    } catch (error) {
      if (error instanceof OmniCoreTransactionOutcomeUnknownError) throw error;
      const reset =
        await this.webhookSubscriptionStatusService.resetPendingSubscription(
          WebhookSubscriptionChannelType.MESSAGING,
          messageChannel.id,
          workspaceId,
          messageChannel.connectedAccountId,
          claimedSnapshot,
        );

      this.metricsService.incrementCounterBy({
        key: MetricsKeys.ConnectedAccountWebhookSubscriptionCreationFailed,
        amount: 1,
        attributes: this.buildMetricAttributes(connectedAccount.provider),
      });

      await this.webhookSubscriptionExceptionHandlerService.handleDriverException(
        error,
        'CREATE',
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannel,
        workspaceId,
        reset
          ? { ...claimedSnapshot, webhookSubscriptionExpiresAt: null }
          : claimedSnapshot,
      );

      return;
    }

    const hasSettledClaim =
      await this.webhookSubscriptionStatusService.settleClaimedSubscription(
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannel.id,
        workspaceId,
        clientState,
        result,
        messageChannel.connectedAccountId,
      );

    if (!hasSettledClaim) {
      await driver
        .deleteSubscription({
          connectedAccountId: messageChannel.connectedAccountId,
          channelType: WebhookSubscriptionChannelType.MESSAGING,
          externalSubscriptionId: result.externalSubscriptionId,
          externalResourceId: null,
          clientState,
        })
        .catch(() => undefined);

      return;
    }

    this.metricsService.incrementCounterBy({
      key: MetricsKeys.ConnectedAccountWebhookSubscriptionCreated,
      amount: 1,
      attributes: this.buildMetricAttributes(connectedAccount.provider),
    });

    if (isDefined(previousSubscription)) {
      await driver
        .deleteSubscription(previousSubscription)
        .catch(() => undefined);
    }
  }

  async recreateSubscription({
    messageChannelId,
    workspaceId,
    removedSubscriptionId,
    expectedSubscription,
  }: {
    messageChannelId: string;
    workspaceId: string;
    removedSubscriptionId: string | null;
    expectedSubscription?: WebhookSubscriptionSnapshot;
  }): Promise<void> {
    const channel = expectedSubscription
      ? webhookSubscriptionSnapshot(expectedSubscription)
      : await this.messageChannelRepository.findOneBy({
          id: messageChannelId,
          workspaceId,
        });
    if (!channel) return;
    const snapshot = webhookSubscriptionSnapshot(channel);
    const cleared =
      await this.webhookSubscriptionStatusService.clearRemovedSubscription(
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannelId,
        workspaceId,
        removedSubscriptionId,
        snapshot.connectedAccountId,
        snapshot,
      );
    if (!cleared) return;
    await this.createSubscription(messageChannelId, workspaceId, {
      ...snapshot,
      webhookSubscriptionExpiresAt: null,
      webhookSubscriptionExternalId: null,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
    });
  }

  async renewSubscription({
    messageChannelId,
    workspaceId,
    expectedSubscription,
  }: {
    messageChannelId: string;
    workspaceId: string;
    expectedSubscription?: WebhookSubscriptionSnapshot;
  }): Promise<void> {
    expectedSubscription =
      expectedSubscription && webhookSubscriptionSnapshot(expectedSubscription);
    const isWorkspaceServiceable =
      await this.workspaceActivationService.isWorkspaceServiceable(workspaceId);

    if (!isWorkspaceServiceable) {
      return;
    }

    const messageChannel = await this.messageChannelRepository.findOne({
      where: { id: messageChannelId, workspaceId },
      relations: ['connectedAccount'],
    });

    if (!isDefined(messageChannel)) {
      return;
    }

    if (
      expectedSubscription &&
      !matchesWebhookSubscription(messageChannel, expectedSubscription)
    )
      return;
    const snapshot = webhookSubscriptionSnapshot(messageChannel);

    if (
      messageChannel.webhookSubscriptionStatus !==
      WebhookSubscriptionStatus.ACTIVE
    ) {
      await this.createSubscription(messageChannelId, workspaceId, snapshot);

      return;
    }

    const { connectedAccount } = messageChannel;

    if (!isDefined(connectedAccount)) {
      return;
    }

    if (
      !this.webhookSubscriptionDriverFactory.isProviderSupported(
        connectedAccount.provider,
      )
    ) {
      return;
    }

    const driver = this.webhookSubscriptionDriverFactory.getDriver(
      connectedAccount.provider,
    );

    if (
      !(await this.webhookSubscriptionStatusService.isCurrentSubscription(
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannelId,
        workspaceId,
        snapshot,
      ))
    )
      return;

    let result: WebhookSubscriptionResult;

    try {
      result = await driver.renewSubscription(this.toContext(messageChannel));
    } catch (error) {
      if (error instanceof OmniCoreTransactionOutcomeUnknownError) throw error;
      this.metricsService.incrementCounterBy({
        key: MetricsKeys.ConnectedAccountWebhookSubscriptionRenewalFailed,
        amount: 1,
        attributes: this.buildMetricAttributes(connectedAccount.provider),
      });

      const recoveryAction =
        await this.webhookSubscriptionExceptionHandlerService.handleDriverException(
          error,
          'RENEW',
          WebhookSubscriptionChannelType.MESSAGING,
          messageChannel,
          messageChannel.workspaceId,
          snapshot,
        );

      if (recoveryAction === 'RECREATE') {
        await this.createSubscription(messageChannelId, workspaceId, {
          ...snapshot,
          webhookSubscriptionExpiresAt: null,
          webhookSubscriptionExternalId: null,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
        });
      }
      return;
    }

    const applied = await this.webhookSubscriptionStatusService.markAsActive(
      WebhookSubscriptionChannelType.MESSAGING,
      messageChannel.id,
      workspaceId,
      result,
      messageChannel.connectedAccountId,
      snapshot,
    );
    if (!applied) return;

    this.metricsService.incrementCounterBy({
      key: MetricsKeys.ConnectedAccountWebhookSubscriptionRenewed,
      amount: 1,
      attributes: this.buildMetricAttributes(connectedAccount.provider),
    });
  }

  async deleteSubscription(
    messageChannelId: string,
    workspaceId: string,
  ): Promise<void> {
    const messageChannel = await this.messageChannelRepository.findOne({
      where: { id: messageChannelId, workspaceId },
    });

    if (!isDefined(messageChannel)) {
      return;
    }

    if (
      messageChannel.webhookSubscriptionStatus !==
      WebhookSubscriptionStatus.ACTIVE
    ) {
      return;
    }

    const connectedAccount = await this.connectedAccountRepository.findOne({
      where: {
        id: messageChannel.connectedAccountId,
        workspaceId: messageChannel.workspaceId,
      },
    });

    if (!isDefined(connectedAccount)) {
      return;
    }

    if (
      !this.webhookSubscriptionDriverFactory.isProviderSupported(
        connectedAccount.provider,
      )
    ) {
      return;
    }

    const driver = this.webhookSubscriptionDriverFactory.getDriver(
      connectedAccount.provider,
    );

    const snapshot = webhookSubscriptionSnapshot(messageChannel);
    try {
      await driver.deleteSubscription(this.toContext(messageChannel));
    } catch (error) {
      if (error instanceof OmniCoreTransactionOutcomeUnknownError) throw error;
      if (
        error instanceof WebhookSubscriptionDriverException &&
        error.code === WebhookSubscriptionDriverExceptionCode.NOT_FOUND
      ) {
        return;
      }

      this.metricsService.incrementCounterBy({
        key: MetricsKeys.ConnectedAccountWebhookSubscriptionDeletionFailed,
        amount: 1,
        attributes: this.buildMetricAttributes(connectedAccount.provider),
      });

      throw error;
    }

    const applied = await this.webhookSubscriptionStatusService.markAsExpired(
      WebhookSubscriptionChannelType.MESSAGING,
      messageChannelId,
      workspaceId,
      messageChannel.connectedAccountId,
      snapshot,
    );
    if (!applied) return;

    this.metricsService.incrementCounterBy({
      key: MetricsKeys.ConnectedAccountWebhookSubscriptionDeleted,
      amount: 1,
      attributes: this.buildMetricAttributes(connectedAccount.provider),
    });
  }

  async revokeSubscription({
    messageChannelId,
    workspaceId,
  }: {
    messageChannelId: string;
    workspaceId: string;
  }): Promise<void> {
    const isWorkspaceServiceable =
      await this.workspaceActivationService.isWorkspaceServiceable(workspaceId);

    if (isWorkspaceServiceable) {
      return;
    }

    await this.deleteSubscription(messageChannelId, workspaceId);
  }

  private buildMetricAttributes(provider: string) {
    return {
      channel_type: WebhookSubscriptionChannelType.MESSAGING,
      provider,
    };
  }

  private toContext(
    messageChannel: MessageChannelEntity,
  ): WebhookSubscriptionContext {
    return {
      connectedAccountId: messageChannel.connectedAccountId,
      channelType: WebhookSubscriptionChannelType.MESSAGING,
      externalSubscriptionId: messageChannel.webhookSubscriptionExternalId,
      externalResourceId: null,
      clientState: messageChannel.webhookSubscriptionClientState ?? '',
    };
  }
}
