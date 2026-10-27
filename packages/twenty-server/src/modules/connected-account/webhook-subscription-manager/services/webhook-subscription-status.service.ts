import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  WebhookSubscriptionChannelType,
  WebhookSubscriptionStatus,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { v4 } from 'uuid';

import { withOrdinaryMetadataChannel } from 'src/modules/omnichannel/services/with-ordinary-metadata-channel';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { CLAIMABLE_WEBHOOK_SUBSCRIPTION_STATUSES } from 'src/modules/connected-account/webhook-subscription-manager/constants/claimable-webhook-subscription-statuses.constant';
import { WEBHOOK_SUBSCRIPTION_CLAIM_STALE_MS } from 'src/modules/connected-account/webhook-subscription-manager/constants/webhook-subscription-claim-stale-ms.constant';
import {
  type WebhookSubscribableChannel,
  type WebhookSubscriptionResult,
} from 'src/modules/connected-account/webhook-subscription-manager/types/webhook-subscription-driver.type';

@Injectable()
export class WebhookSubscriptionStatusService {
  constructor(
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
  ) {}

  public async claimSubscriptionCreation(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    expectedConnectedAccountId?: string,
  ): Promise<string | null> {
    return this.withOrdinaryChannel(
      channelType,
      channelId,
      workspaceId,
      async (repository) => {
        const clientState = v4();

        const updateResult = await repository
          .createQueryBuilder()
          .update()
          .set({
            webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
            webhookSubscriptionClientState: clientState,
          })
          .where('"id" = :channelId', { channelId })
          .andWhere('"workspaceId" = :workspaceId', { workspaceId })
          .andWhere(
            `("webhookSubscriptionStatus" IS NULL
          OR "webhookSubscriptionStatus" IN (:...claimableStatuses)
          OR ("webhookSubscriptionStatus" = :pendingStatus AND "updatedAt" <= :staleClaimBefore))`,
            {
              claimableStatuses: CLAIMABLE_WEBHOOK_SUBSCRIPTION_STATUSES,
              pendingStatus: WebhookSubscriptionStatus.PENDING,
              staleClaimBefore: new Date(
                Date.now() - WEBHOOK_SUBSCRIPTION_CLAIM_STALE_MS,
              ),
            },
          )
          .returning('id')
          .execute();

        return updateResult.raw.length > 0 ? clientState : null;
      },
      expectedConnectedAccountId,
    );
  }

  public async settleClaimedSubscription(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    clientState: string,
    result: WebhookSubscriptionResult,
    expectedConnectedAccountId?: string,
  ): Promise<boolean> {
    return (
      (await this.withOrdinaryChannel(
        channelType,
        channelId,
        workspaceId,
        async (repository) => {
          const { affected } = await repository.update(
            {
              id: channelId,
              workspaceId,
              webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
              webhookSubscriptionClientState: clientState,
            },
            {
              webhookSubscriptionExternalId: result.externalSubscriptionId,
              webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
              webhookSubscriptionExpiresAt: result.expiresAt,
              ...(channelType === WebhookSubscriptionChannelType.CALENDAR
                ? {
                    webhookSubscriptionExternalResourceId:
                      result.externalResourceId,
                  }
                : {}),
            },
          );

          return isDefined(affected) && affected > 0;
        },
        expectedConnectedAccountId,
      )) ?? false
    );
  }

  public async markAsActive(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    result: WebhookSubscriptionResult,
    expectedConnectedAccountId?: string,
  ) {
    return this.update(
      channelType,
      channelId,
      workspaceId,
      {
        webhookSubscriptionExternalId: result.externalSubscriptionId,
        webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
        webhookSubscriptionExpiresAt: result.expiresAt,
        ...(channelType === WebhookSubscriptionChannelType.CALENDAR
          ? { webhookSubscriptionExternalResourceId: result.externalResourceId }
          : {}),
      },
      expectedConnectedAccountId,
    );
  }

  public async markAsFailed(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    expectedConnectedAccountId?: string,
  ) {
    return this.update(
      channelType,
      channelId,
      workspaceId,
      {
        webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
      },
      expectedConnectedAccountId,
    );
  }

  public async markAsExpired(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    expectedConnectedAccountId?: string,
  ) {
    return this.update(
      channelType,
      channelId,
      workspaceId,
      {
        webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED,
      },
      expectedConnectedAccountId,
    );
  }

  public async resetPendingSubscription(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    expectedConnectedAccountId?: string,
  ) {
    return this.update(
      channelType,
      channelId,
      workspaceId,
      {
        webhookSubscriptionExpiresAt: null,
      },
      expectedConnectedAccountId,
    );
  }

  public async clearRemovedSubscription(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    removedSubscriptionId: string | null,
    expectedConnectedAccountId?: string,
  ): Promise<boolean> {
    return (
      (await this.withOrdinaryChannel(
        channelType,
        channelId,
        workspaceId,
        async (repository) => {
          const { affected } = await repository.update(
            {
              id: channelId,
              workspaceId,
              ...(isDefined(removedSubscriptionId)
                ? { webhookSubscriptionExternalId: removedSubscriptionId }
                : {}),
            },
            {
              webhookSubscriptionExternalId: null,
              webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
              webhookSubscriptionExpiresAt: null,
              ...(channelType === WebhookSubscriptionChannelType.CALENDAR
                ? { webhookSubscriptionExternalResourceId: null }
                : {}),
            },
          );

          return isDefined(affected) && affected > 0;
        },
        expectedConnectedAccountId,
      )) ?? false
    );
  }

  private async update(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    payload: QueryDeepPartialEntity<WebhookSubscribableChannel>,
    expectedConnectedAccountId?: string,
  ): Promise<boolean> {
    return (
      (await this.withOrdinaryChannel(
        channelType,
        channelId,
        workspaceId,
        async (repository) => {
          const { affected } = await repository.update(
            { id: channelId, workspaceId },
            payload,
          );
          return isDefined(affected) && affected > 0;
        },
        expectedConnectedAccountId,
      )) ?? false
    );
  }

  private withOrdinaryChannel<T>(
    channelType: WebhookSubscriptionChannelType,
    channelId: string,
    workspaceId: string,
    work: (repository: Repository<WebhookSubscribableChannel>) => Promise<T>,
    expectedConnectedAccountId?: string,
  ): Promise<T | null> {
    const repository = this.getRepository(channelType);
    return withOrdinaryMetadataChannel(
      repository.manager,
      workspaceId,
      channelId,
      channelType === WebhookSubscriptionChannelType.CALENDAR
        ? 'calendar'
        : 'message',
      (manager) => work(manager.getRepository(repository.target)),
      expectedConnectedAccountId,
    );
  }

  private getRepository(
    channelType: WebhookSubscriptionChannelType,
  ): Repository<WebhookSubscribableChannel> {
    return (
      channelType === WebhookSubscriptionChannelType.CALENDAR
        ? this.calendarChannelRepository
        : this.messageChannelRepository
    ) as Repository<WebhookSubscribableChannel>;
  }
}
