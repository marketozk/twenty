import {
  beginOrdinaryMetadataSyncRun,
  matchesOrdinaryMetadataSyncRun,
  type OrdinaryMetadataSyncRun,
} from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import {
  calendarImportCacheKey,
  legacyCalendarImportCacheKey,
} from 'src/modules/calendar/common/utils/calendar-import-cache-key';
import { isSyncStale } from 'src/modules/calendar/calendar-event-import-manager/utils/is-sync-stale.util';
import { toIsoStringOrNull } from 'src/utils/date/toIsoStringOrNull';
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

  public async requeueStaleChannels(
    ids: string[],
    workspaceId: string,
  ): Promise<string[]> {
    const updated = await withOrdinaryMetadataChannels(
      this.calendarChannelRepository.manager,
      workspaceId,
      ids,
      'calendar',
      async (manager, channels) => {
        const accepted = [];
        const repository = manager.getRepository(CalendarChannelEntity);
        for (const channel of channels) {
          const current = await repository.findOneByOrFail({
            id: channel.id,
            workspaceId,
          });
          if (!isSyncStale(toIsoStringOrNull(current.syncStageStartedAt)))
            continue;
          const pending =
            current.syncStage ===
              CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_ONGOING ||
            current.syncStage ===
              CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED
              ? CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING
              : current.syncStage ===
                    CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING ||
                  current.syncStage ===
                    CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED
                ? CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING
                : null;
          if (pending === null) continue;
          await repository.update(
            { id: channel.id, workspaceId },
            { syncStage: pending, syncStageStartedAt: null },
          );
          accepted.push({
            ...channel,
            syncStage: pending,
            syncStatus: current.syncStatus,
          });
        }
        return accepted;
      },
    );
    return updated.map(({ id }) => id);
  }

  public async recordTemporaryFailure(
    channelId: string,
    expectedConnectedAccountId: string,
    workspaceId: string,
    isListFetch: boolean,
    maximumAttempts: number,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<{ exhausted: boolean; failureCount: number } | null> {
    expectedRun = expectedRun && { ...expectedRun };
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
        if (
          expectedRun &&
          !(await matchesOrdinaryMetadataSyncRun(
            manager,
            workspaceId,
            channelId,
            'calendar',
            expectedRun,
          ))
        )
          return null;
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

  public async resetAndScheduleCalendarEventListFetch(
    calendarChannelIds: string[],
    workspaceId: string,
    expectedConnectedAccountId: string,
  ): Promise<string[]> {
    return this.resetCalendarChannels(
      calendarChannelIds,
      workspaceId,
      expectedConnectedAccountId,
      true,
    );
  }

  public async resetAndMarkAsCalendarEventListFetchPending(
    calendarChannelIds: string[],
    workspaceId: string,
    expectedConnectedAccountId?: string,
    expectedUserWorkspaceId?: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<string[]> {
    return this.resetCalendarChannels(
      calendarChannelIds,
      workspaceId,
      expectedConnectedAccountId,
      false,
      expectedUserWorkspaceId,
      false,
      expectedRun,
    );
  }

  private async resetCalendarChannels(
    calendarChannelIds: string[],
    workspaceId: string,
    expectedConnectedAccountId: string | undefined,
    schedule: boolean,
    expectedUserWorkspaceId?: string,
    recovery = false,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<string[]> {
    if (!calendarChannelIds.length) return [];

    const updated = await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncCursor: '',
        syncStageStartedAt: schedule ? new Date().toISOString() : null,
        throttleFailureCount: 0,
        syncStage: schedule
          ? CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED
          : CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
        ...(schedule ? { syncStatus: CalendarChannelSyncStatus.ONGOING } : {}),
      },
      false,
      expectedConnectedAccountId,
      schedule || recovery,
      expectedUserWorkspaceId,
      expectedRun,
    );
    await this.flushImportCache(updated, workspaceId);
    return updated.map(({ id }) => id);
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
    expectedRun?: OrdinaryMetadataSyncRun,
  ) {
    if (!calendarChannelIds.length) {
      return;
    }

    await this.mutateCalendarChannels(
      calendarChannelIds,
      workspaceId,
      {
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
        ...(!preserveSyncStageStartedAt ? { syncStageStartedAt: null } : {}),
      },
      false,
      expectedRun?.connectedAccountId,
      false,
      undefined,
      expectedRun,
    );
  }

  public async beginCalendarEventsImport(
    channelId: string,
    workspaceId: string,
    expectedConnectedAccountId: string,
  ) {
    return beginOrdinaryMetadataSyncRun(
      this.calendarChannelRepository.manager,
      workspaceId,
      channelId,
      expectedConnectedAccountId,
      'calendar',
      {
        scheduled: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
        ongoing: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
        syncStatus: CalendarChannelSyncStatus.ONGOING,
      },
      async (manager, run) => {
        const channel = await manager
          .getRepository(CalendarChannelEntity)
          .findOneOrFail({
            where: { id: channelId, workspaceId },
            relations: ['connectedAccount'],
          });
        return { channel, run };
      },
    );
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
    expectedRun?: OrdinaryMetadataSyncRun,
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
      false,
      expectedRun?.connectedAccountId,
      false,
      undefined,
      expectedRun,
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
    expectedConnectedAccountId?: string,
    expectedRun?: OrdinaryMetadataSyncRun,
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
      false,
      expectedConnectedAccountId,
      false,
      undefined,
      expectedRun,
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
    expectedRun?: OrdinaryMetadataSyncRun,
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
      false,
      undefined,
      expectedRun,
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
    reconnect = false,
    expectedUserWorkspaceId?: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<OrdinaryMetadataChannel[]> {
    expectedRun = expectedRun && { ...expectedRun };
    const requestedIds = [...ids];
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        withOrdinaryMetadataChannels(
          this.calendarChannelRepository.manager,
          workspaceId,
          requestedIds,
          'calendar',
          async (manager, admittedChannels) => {
            let channels = admittedChannels.filter(
              ({ userWorkspaceId }) =>
                expectedUserWorkspaceId === undefined ||
                userWorkspaceId === expectedUserWorkspaceId,
            );
            if (expectedRun) {
              const accepted = [];
              for (const channel of channels) {
                if (
                  await matchesOrdinaryMetadataSyncRun(
                    manager,
                    workspaceId,
                    channel.id,
                    'calendar',
                    expectedRun,
                  )
                )
                  accepted.push(channel);
              }
              channels = accepted;
            }
            if (!channels.length) return [];
            const result = await manager
              .getRepository(CalendarChannelEntity)
              .createQueryBuilder()
              .update()
              .set(values)
              .where({ id: In(channels.map(({ id }) => id)), workspaceId })
              .andWhere(
                reconnect
                  ? '"isSyncEnabled" = true AND "syncStage" IS DISTINCT FROM :pendingConfiguration'
                  : 'TRUE',
                {
                  pendingConfiguration:
                    CalendarChannelSyncStage.PENDING_CONFIGURATION,
                },
              )
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

  public async recoverLegacyCalendarImport(
    calendarChannelId: string,
    workspaceId: string,
    expectedConnectedAccountId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<boolean> {
    expectedRun = expectedRun && { ...expectedRun };
    const legacyKey = legacyCalendarImportCacheKey(
      workspaceId,
      calendarChannelId,
    );
    if (!(await this.cacheStorage.getSetLength(legacyKey))) return false;
    const accepted = await this.resetCalendarChannels(
      [calendarChannelId],
      workspaceId,
      expectedConnectedAccountId,
      false,
      undefined,
      true,
      expectedRun,
    );
    if (accepted.includes(calendarChannelId))
      await this.cacheStorage.del(legacyKey);
    return true;
  }

  private async flushImportCache(
    channels: OrdinaryMetadataChannel[],
    workspaceId: string,
  ) {
    for (const { id, connectedAccountId } of channels)
      await this.cacheStorage.del(
        calendarImportCacheKey({
          workspaceId,
          calendarChannelId: id,
          connectedAccountId,
        }),
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
