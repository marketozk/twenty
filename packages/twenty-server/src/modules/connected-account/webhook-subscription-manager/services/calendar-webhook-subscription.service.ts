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
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
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
export class CalendarWebhookSubscriptionService {
  constructor(
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly workspaceActivationService: WorkspaceActivationService,
    private readonly webhookSubscriptionDriverFactory: WebhookSubscriptionDriverFactory,
    private readonly metricsService: MetricsService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    private readonly webhookSubscriptionExceptionHandlerService: WebhookSubscriptionExceptionHandlerService,
  ) {}

  async createSubscription(
    calendarChannelId: string,
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

    const calendarChannel = await this.calendarChannelRepository.findOne({
      where: { id: calendarChannelId, workspaceId },
      relations: ['connectedAccount'],
    });

    if (!isDefined(calendarChannel?.connectedAccount)) {
      return;
    }

    if (
      expectedSubscription &&
      !matchesWebhookSubscription(calendarChannel, expectedSubscription)
    )
      return;
    const snapshot = webhookSubscriptionSnapshot(calendarChannel);

    const { connectedAccount } = calendarChannel;

    if (
      !this.webhookSubscriptionDriverFactory.isProviderSupported(
        connectedAccount.provider,
      )
    ) {
      return;
    }

    if (
      calendarChannel.webhookSubscriptionStatus ===
      WebhookSubscriptionStatus.ACTIVE
    ) {
      return;
    }

    const driver = this.webhookSubscriptionDriverFactory.getDriver(
      connectedAccount.provider,
    );

    // Keep any existing watch live until the replacement is created, then stop it.
    const previousSubscription = isDefined(
      calendarChannel.webhookSubscriptionExternalId,
    )
      ? this.toContext(calendarChannel)
      : null;

    const clientState =
      await this.webhookSubscriptionStatusService.claimSubscriptionCreation(
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannel.id,
        workspaceId,
        calendarChannel.connectedAccountId,
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
        calendarChannel.connectedAccountId,
        WebhookSubscriptionChannelType.CALENDAR,
        clientState,
      );
    } catch (error) {
      if (error instanceof OmniCoreTransactionOutcomeUnknownError) throw error;
      const reset =
        await this.webhookSubscriptionStatusService.resetPendingSubscription(
          WebhookSubscriptionChannelType.CALENDAR,
          calendarChannel.id,
          workspaceId,
          calendarChannel.connectedAccountId,
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
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannel,
        workspaceId,
        reset
          ? { ...claimedSnapshot, webhookSubscriptionExpiresAt: null }
          : claimedSnapshot,
      );

      return;
    }

    const hasSettledClaim =
      await this.webhookSubscriptionStatusService.settleClaimedSubscription(
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannel.id,
        workspaceId,
        clientState,
        result,
        calendarChannel.connectedAccountId,
      );

    if (!hasSettledClaim) {
      await driver
        .deleteSubscription({
          connectedAccountId: calendarChannel.connectedAccountId,
          channelType: WebhookSubscriptionChannelType.CALENDAR,
          externalSubscriptionId: result.externalSubscriptionId,
          externalResourceId: result.externalResourceId,
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
    calendarChannelId,
    workspaceId,
    removedSubscriptionId,
    expectedSubscription,
  }: {
    calendarChannelId: string;
    workspaceId: string;
    removedSubscriptionId: string | null;
    expectedSubscription?: WebhookSubscriptionSnapshot;
  }): Promise<void> {
    const channel = expectedSubscription
      ? webhookSubscriptionSnapshot(expectedSubscription)
      : await this.calendarChannelRepository.findOneBy({
          id: calendarChannelId,
          workspaceId,
        });
    if (!channel) return;
    const snapshot = webhookSubscriptionSnapshot(channel);
    const cleared =
      await this.webhookSubscriptionStatusService.clearRemovedSubscription(
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannelId,
        workspaceId,
        removedSubscriptionId,
        snapshot.connectedAccountId,
        snapshot,
      );
    if (!cleared) return;
    await this.createSubscription(calendarChannelId, workspaceId, {
      ...snapshot,
      webhookSubscriptionExpiresAt: null,
      webhookSubscriptionExternalId: null,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
    });
  }

  async renewSubscription({
    calendarChannelId,
    workspaceId,
    expectedSubscription,
  }: {
    calendarChannelId: string;
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

    const calendarChannel = await this.calendarChannelRepository.findOne({
      where: { id: calendarChannelId, workspaceId },
      relations: ['connectedAccount'],
    });

    if (!isDefined(calendarChannel)) {
      return;
    }

    if (
      expectedSubscription &&
      !matchesWebhookSubscription(calendarChannel, expectedSubscription)
    )
      return;
    const snapshot = webhookSubscriptionSnapshot(calendarChannel);

    if (
      calendarChannel.webhookSubscriptionStatus !==
      WebhookSubscriptionStatus.ACTIVE
    ) {
      await this.createSubscription(calendarChannelId, workspaceId, snapshot);

      return;
    }

    const { connectedAccount } = calendarChannel;

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
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannelId,
        workspaceId,
        snapshot,
      ))
    )
      return;

    let result: WebhookSubscriptionResult;

    try {
      result = await driver.renewSubscription(this.toContext(calendarChannel));
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
          WebhookSubscriptionChannelType.CALENDAR,
          calendarChannel,
          calendarChannel.workspaceId,
          snapshot,
        );

      if (recoveryAction === 'RECREATE') {
        await this.createSubscription(calendarChannelId, workspaceId, {
          ...snapshot,
          webhookSubscriptionExpiresAt: null,
          webhookSubscriptionExternalId: null,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
        });
      }
      return;
    }

    const applied = await this.webhookSubscriptionStatusService.markAsActive(
      WebhookSubscriptionChannelType.CALENDAR,
      calendarChannel.id,
      workspaceId,
      result,
      calendarChannel.connectedAccountId,
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
    calendarChannelId: string,
    workspaceId: string,
  ): Promise<void> {
    const calendarChannel = await this.calendarChannelRepository.findOne({
      where: { id: calendarChannelId, workspaceId },
    });

    if (!isDefined(calendarChannel)) {
      return;
    }

    if (
      calendarChannel.webhookSubscriptionStatus !==
      WebhookSubscriptionStatus.ACTIVE
    ) {
      return;
    }

    const connectedAccount = await this.connectedAccountRepository.findOne({
      where: {
        id: calendarChannel.connectedAccountId,
        workspaceId: calendarChannel.workspaceId,
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

    const snapshot = webhookSubscriptionSnapshot(calendarChannel);
    try {
      await driver.deleteSubscription(this.toContext(calendarChannel));
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
      WebhookSubscriptionChannelType.CALENDAR,
      calendarChannelId,
      workspaceId,
      calendarChannel.connectedAccountId,
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
    calendarChannelId,
    workspaceId,
  }: {
    calendarChannelId: string;
    workspaceId: string;
  }): Promise<void> {
    const isWorkspaceServiceable =
      await this.workspaceActivationService.isWorkspaceServiceable(workspaceId);

    if (isWorkspaceServiceable) {
      return;
    }

    await this.deleteSubscription(calendarChannelId, workspaceId);
  }

  private buildMetricAttributes(provider: string) {
    return {
      channel_type: WebhookSubscriptionChannelType.CALENDAR,
      provider,
    };
  }

  private toContext(
    calendarChannel: CalendarChannelEntity,
  ): WebhookSubscriptionContext {
    return {
      connectedAccountId: calendarChannel.connectedAccountId,
      channelType: WebhookSubscriptionChannelType.CALENDAR,
      externalSubscriptionId: calendarChannel.webhookSubscriptionExternalId,
      externalResourceId: calendarChannel.webhookSubscriptionExternalResourceId,
      clientState: calendarChannel.webhookSubscriptionClientState ?? '',
    };
  }
}
