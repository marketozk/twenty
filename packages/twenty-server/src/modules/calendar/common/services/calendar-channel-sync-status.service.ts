import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import {
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
} from 'twenty-shared/types';
import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { AccountsToReconnectService } from 'src/modules/connected-account/services/accounts-to-reconnect.service';
import { AccountsToReconnectKeys } from 'src/modules/connected-account/types/accounts-to-reconnect-key-value.type';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  withOrdinaryMetadataChannels,
  type OrdinaryMetadataChannel,
} from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

@Injectable()
export class CalendarChannelSyncStatusService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectCacheStorage(CacheStorageNamespace.ModuleCalendar)
    private readonly cacheStorage: CacheStorageService,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly accountsToReconnectService: AccountsToReconnectService,
    private readonly metricsService: MetricsService,
  ) {}

  public async recordTemporaryFailure(
    channelId: string,
    expectedConnectedAccountId: string,
    workspaceId: string,
    isListFetch: boolean,
    maximumAttempts: number,
  ): Promise<{ exhausted: boolean; failureCount: number } | null> {
    const retryStage = isListFetch
      ? CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING
      : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING;
    const result = await withOrdinaryMetadataChannels(
      this.calendarChannelRepository.manager,
      workspaceId,
      [channelId],
      'calendar',
      async (manager, channels) => {
        if (!channels.length) return null;
        const repository = manager.getRepository(CalendarChannelEntity);
        const current = await repository.findOneByOrFail({
          id: channelId,
          workspaceId,
        });
        const exhausted = current.throttleFailureCount >= maximumAttempts;
        await repository.update(
          { id: channelId, workspaceId },
          exhausted
            ? {
                syncStatus: CalendarChannelSyncStatus.FAILED_UNKNOWN,
                syncStage: CalendarChannelSyncStage.FAILED,
              }
            : {
                throttleFailureCount: current.throttleFailureCount + 1,
                syncStage: retryStage,
              },
        );
        return {
          exhausted,
          failureCount: exhausted
            ? current.throttleFailureCount
            : current.throttleFailureCount + 1,
          channels,
        };
      },
      'read',
      expectedConnectedAccountId,
    );
    if (!result) return null;
    if (result.exhausted) {
      await this.flushImportCache(result.channels, workspaceId);
      await this.metricsService.incrementCounterForEvents({
        key: MetricsKeys.CalendarEventSyncJobFailedUnknown,
        eventIds: [channelId],
      });
    }
    return { exhausted: result.exhausted, failureCount: result.failureCount };
  }

  public async markAsCalendarEventListFetchPending(
    calendarChannelIds: string[],
    workspaceId: string,
    preserveSyncStageStartedAt: boolean = false,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(calendarChannelIds, workspaceId, {
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      ...(!preserveSyncStageStartedAt ? { syncStageStartedAt: null } : {}),
    });
  }

  public async markAsCalendarEventListFetchOngoing(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(calendarChannelIds, workspaceId, {
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_ONGOING,
      syncStatus: CalendarChannelSyncStatus.ONGOING,
      syncStageStartedAt: new Date().toISOString(),
    });
  }

  public async resetAndMarkAsCalendarEventListFetchPending(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    const updated = await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncCursor: '',
        syncStageStartedAt: null,
        throttleFailureCount: 0,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      },
    );
    await this.flushImportCache(updated, workspaceId);
  }

  public async resetSyncStageStartedAt(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(calendarChannelIds, workspaceId, {
      syncStageStartedAt: null,
    });
  }

  public async markAsCalendarEventsImportPending(
    calendarChannelIds: string[],
    workspaceId: string,
    preserveSyncStageStartedAt: boolean = false,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(calendarChannelIds, workspaceId, {
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
      ...(!preserveSyncStageStartedAt ? { syncStageStartedAt: null } : {}),
    });
  }

  public async markAsCalendarEventsImportOngoing(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(calendarChannelIds, workspaceId, {
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      syncStatus: CalendarChannelSyncStatus.ONGOING,
      syncStageStartedAt: new Date().toISOString(),
    });
  }

  public async markAsCalendarEventSyncCompleted(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    const updated = await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
        syncStatus: CalendarChannelSyncStatus.ACTIVE,
        throttleFailureCount: 0,
        syncStageStartedAt: null,
        syncedAt: new Date().toISOString(),
      },
    );
    if (updated.length)
      await this.metricsService.incrementCounterForEvents({
        key: MetricsKeys.CalendarEventSyncJobActive,
        eventIds: updated.map(({ id }) => id),
      });
  }

  public async markAsFailedUnknownAndFlushCalendarEventsToImport(
    calendarChannelIds: string[],
    workspaceId: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    const updated = await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncStatus: CalendarChannelSyncStatus.FAILED_UNKNOWN,
        syncStage: CalendarChannelSyncStage.FAILED,
      },
    );
    await this.flushImportCache(updated, workspaceId);
    if (updated.length)
      await this.metricsService.incrementCounterForEvents({
        key: MetricsKeys.CalendarEventSyncJobFailedUnknown,
        eventIds: updated.map(({ id }) => id),
      });
  }

  public async markAsFailedInsufficientPermissionsAndFlushCalendarEventsToImport(
    calendarChannelIds: string[],
    workspaceId: string,
    expectedConnectedAccountId?: string,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    const updated = await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncStatus: CalendarChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
        syncStage: CalendarChannelSyncStage.FAILED,
      },
      true,
      expectedConnectedAccountId,
    );
    await this.flushImportCache(updated, workspaceId);
    if (!updated.length) return;
    await this.addToAccountsToReconnect(updated, workspaceId);
    await this.metricsService.incrementCounterForEvents({
      key: MetricsKeys.CalendarEventSyncJobFailedInsufficientPermissions,
      eventIds: updated.map(({ id }) => id),
    });
  }

  private async mutateCalendarChannels(
    ids: string[],
    workspaceId: string,
    values: QueryDeepPartialEntity<CalendarChannelEntity>,
    authFailed = false,
    expectedConnectedAccountId?: string,
  ): Promise<OrdinaryMetadataChannel[]> {
    const requestedIds = [...ids];
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        withOrdinaryMetadataChannels(
          this.calendarChannelRepository.manager,
          workspaceId,
          requestedIds,
          'calendar',
          async (manager, channels) => {
            if (!channels.length) return [];
            const result = await manager
              .getRepository(CalendarChannelEntity)
              .createQueryBuilder()
              .update()
              .set(values)
              .where({ id: In(channels.map(({ id }) => id)), workspaceId })
              .returning('id')
              .execute();
            const updated = (result.raw as { id: string }[]).map(({ id }) => {
              const channel = channels.find((channel) => channel.id === id);
              if (!channel)
                throw new Error('OMNI_UNEXPECTED_CHANNEL_UPDATE_RESULT');
              return channel;
            });
            if (authFailed && updated.length)
              await manager
                .getRepository(this.connectedAccountRepository.target)
                .update(
                  {
                    id: In([
                      ...new Set(
                        updated.map(
                          ({ connectedAccountId }) => connectedAccountId,
                        ),
                      ),
                    ]),
                    workspaceId,
                  },
                  { authFailedAt: new Date() },
                );
            return updated;
          },
          authFailed ? 'write' : 'read',
          expectedConnectedAccountId,
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  private async flushImportCache(
    channels: OrdinaryMetadataChannel[],
    workspaceId: string,
  ) {
    for (const { id } of channels)
      await this.cacheStorage.del(
        `calendar-events-to-import:${workspaceId}:${id}`,
      );
  }

  private async addToAccountsToReconnect(
    channels: OrdinaryMetadataChannel[],
    workspaceId: string,
  ) {
    const accounts = new Map(
      channels.map((channel) => [
        channel.connectedAccountId,
        channel.userWorkspaceId,
      ]),
    );
    for (const [connectedAccountId, userWorkspaceId] of accounts) {
      const userWorkspace = await this.userWorkspaceRepository.findOne({
        where: { id: userWorkspaceId, workspaceId },
        select: ['userId'],
      });
      if (!userWorkspace) continue;
      await this.accountsToReconnectService.addAccountToReconnectByKey(
        AccountsToReconnectKeys.ACCOUNTS_TO_RECONNECT_INSUFFICIENT_PERMISSIONS,
        userWorkspace.userId,
        workspaceId,
        connectedAccountId,
      );
    }
  }
}
