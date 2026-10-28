import { calendarImportCacheKey } from 'src/modules/calendar/common/utils/calendar-import-cache-key';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { CalendarEventCleanerService } from 'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service';
import {
  CalendarEventImportErrorHandlerService,
  CalendarEventImportSyncStep,
} from 'src/modules/calendar/calendar-event-import-manager/services/calendar-event-import-exception-handler.service';
import { CalendarGetCalendarEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-get-events.service';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';

@Injectable()
export class CalendarFetchEventsService {
  private readonly logger = new Logger(CalendarFetchEventsService.name);
  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleCalendar)
    private readonly cacheStorage: CacheStorageService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
    private readonly getCalendarEventsService: CalendarGetCalendarEventsService,
    private readonly calendarEventImportErrorHandlerService: CalendarEventImportErrorHandlerService,
    private readonly calendarEventCleanerService: CalendarEventCleanerService,
  ) {}

  public async fetchCalendarEvents(
    calendarChannel: CalendarChannelEntity,
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
  ): Promise<boolean> {
    calendarChannel = { ...calendarChannel };
    connectedAccount = { ...connectedAccount };
    if (calendarChannel.connectedAccountId !== connectedAccount.id)
      throw new Error('CALENDAR_IMPORT_ACCOUNT_MISMATCH');
    const admitted =
      await this.calendarChannelSyncStatusService.beginCalendarListFetch(
        calendarChannel.id,
        workspaceId,
        connectedAccount.id,
      );
    if (!admitted) return false;
    calendarChannel = admitted.channel;
    connectedAccount = admitted.channel.connectedAccount;
    const expectedRun = admitted.run;
    const importKey = calendarImportCacheKey({
      workspaceId,
      calendarChannelId: calendarChannel.id,
      connectedAccountId: connectedAccount.id,
    });
    if (
      await this.calendarChannelSyncStatusService.recoverLegacyCalendarImport(
        calendarChannel.id,
        workspaceId,
        connectedAccount.id,
        expectedRun,
      )
    )
      return false;

    this.logger.log(
      `WorkspaceId: ${workspaceId}, CalendarChannelId: ${calendarChannel.id} - Fetching calendar events`,
    );

    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        try {
          const { calendarEventIds, calendarEventIdsToDelete, nextSyncCursor } =
            await this.getCalendarEventsService.getCalendarEvents(
              connectedAccount,
              calendarChannel.syncCursor || undefined,
            );

          if (calendarEventIdsToDelete.length > 0) {
            const cleaned =
              await this.calendarEventCleanerService.deleteCalendarChannelEventAssociationsAndRelatedOrphans(
                {
                  workspaceId,
                  calendarChannelId: calendarChannel.id,
                  eventExternalIds: calendarEventIdsToDelete,
                  expectedRun,
                },
              );
            if (!cleaned) return false;
          }

          if (calendarEventIds.length > 0)
            await this.cacheStorage.setAdd(importKey, calendarEventIds);
          return await this.calendarChannelSyncStatusService.finishCalendarListFetch(
            expectedRun,
            nextSyncCursor,
            calendarEventIds.length > 0,
          );
        } catch (error) {
          this.logger.error(
            `WorkspaceId: ${workspaceId}, CalendarChannelId: ${calendarChannel.id} - Calendar event fetch error: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.calendarEventImportErrorHandlerService.handleDriverException(
            error,
            CalendarEventImportSyncStep.CALENDAR_EVENT_LIST_FETCH,
            calendarChannel,
            workspaceId,
            expectedRun,
          );
          return false;
        }
      },
      authContext,
      { lite: true },
    );
  }
}
