import { calendarImportCacheKey } from 'src/modules/calendar/common/utils/calendar-import-cache-key';
import { scheduleOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/schedule-ordinary-metadata-channels';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CalendarChannelSyncStage } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarEventsImportService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service';
import { CalendarFetchEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service';
import { CALENDAR_EVENT_WEBHOOK_SYNC_INLINE_IMPORT_MAX_EVENTS } from 'src/modules/connected-account-sync-webhooks/calendar-event-webhook-sync/constants/calendar-event-webhook-sync-inline-import-max-events.constant';

@Injectable()
export class CalendarEventWebhookSyncService {
  private readonly logger = new Logger(CalendarEventWebhookSyncService.name);

  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleCalendar)
    private readonly cacheStorage: CacheStorageService,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly calendarFetchEventsService: CalendarFetchEventsService,
    private readonly calendarEventsImportService: CalendarEventsImportService,
  ) {}

  async processCalendarEventWebhookSync({
    calendarChannelId,
    workspaceId,
    expectedConnectedAccountId,
  }: {
    calendarChannelId: string;
    workspaceId: string;
    expectedConnectedAccountId?: string;
  }): Promise<void> {
    const [scheduledChannel] = await scheduleOrdinaryMetadataChannels(
      this.calendarChannelRepository.manager,
      workspaceId,
      [calendarChannelId],
      'calendar',
      {
        pending: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
        scheduled: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
      },
      expectedConnectedAccountId,
    );

    if (!scheduledChannel) {
      this.logger.log(
        `Skipping webhook sync for calendar channel ${calendarChannelId}, a sync is already in progress`,
      );

      return;
    }

    const calendarChannel = await this.findSyncEnabledCalendarChannel({
      calendarChannelId,
      workspaceId,
      expectedConnectedAccountId: scheduledChannel.connectedAccountId,
      stage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
    });

    if (!isDefined(calendarChannel)) {
      return;
    }

    await this.calendarFetchEventsService.fetchCalendarEvents(
      calendarChannel,
      calendarChannel.connectedAccount,
      workspaceId,
    );

    await this.importFetchedCalendarEvents({
      calendarChannelId,
      workspaceId,
      expectedConnectedAccountId: scheduledChannel.connectedAccountId,
    });
  }

  private async findSyncEnabledCalendarChannel({
    calendarChannelId,
    workspaceId,
    expectedConnectedAccountId,
    stage,
  }: {
    calendarChannelId: string;
    workspaceId: string;
    expectedConnectedAccountId: string;
    stage: CalendarChannelSyncStage;
  }): Promise<CalendarChannelEntity | null> {
    return withOrdinaryMetadataChannels(
      this.calendarChannelRepository.manager,
      workspaceId,
      [calendarChannelId],
      'calendar',
      async (manager, channels) =>
        channels.length
          ? manager.getRepository(CalendarChannelEntity).findOne({
              where: {
                id: calendarChannelId,
                workspaceId,
                isSyncEnabled: true,
                syncStage: stage,
              },
              relations: ['connectedAccount'],
            })
          : null,
      'read',
      expectedConnectedAccountId,
    );
  }

  private async importFetchedCalendarEvents({
    calendarChannelId,
    workspaceId,
    expectedConnectedAccountId,
  }: {
    calendarChannelId: string;
    workspaceId: string;
    expectedConnectedAccountId: string;
  }): Promise<void> {
    const calendarEventsToImportCount = await this.cacheStorage.getSetLength(
      calendarImportCacheKey({
        workspaceId,
        calendarChannelId,
        connectedAccountId: expectedConnectedAccountId,
      }),
    );

    if (calendarEventsToImportCount === 0) {
      return;
    }

    if (this.shouldDeferImportToCron(calendarEventsToImportCount)) {
      this.logger.log(
        `Deferring ${calendarEventsToImportCount} calendar events to the import cron for calendar channel ${calendarChannelId}`,
      );

      return;
    }

    const [scheduledChannel] = await scheduleOrdinaryMetadataChannels(
      this.calendarChannelRepository.manager,
      workspaceId,
      [calendarChannelId],
      'calendar',
      {
        pending: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
        scheduled: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
      },
      expectedConnectedAccountId,
    );
    if (!scheduledChannel) return;

    const calendarChannel = await this.findSyncEnabledCalendarChannel({
      calendarChannelId,
      workspaceId,
      expectedConnectedAccountId,
      stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
    });

    if (!isDefined(calendarChannel)) {
      return;
    }

    await this.calendarEventsImportService.processCalendarEventsImport(
      calendarChannel,
      calendarChannel.connectedAccount,
      workspaceId,
    );
  }

  private shouldDeferImportToCron(
    calendarEventsToImportCount: number,
  ): boolean {
    return (
      calendarEventsToImportCount >
      CALENDAR_EVENT_WEBHOOK_SYNC_INLINE_IMPORT_MAX_EVENTS
    );
  }
}
