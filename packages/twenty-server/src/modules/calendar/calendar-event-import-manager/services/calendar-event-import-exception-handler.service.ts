import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { Injectable, Logger } from '@nestjs/common';

import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountRefreshAccessTokenExceptionCode } from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import { TwentyOrmExceptionCode } from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { CALENDAR_THROTTLE_MAX_ATTEMPTS } from 'src/modules/calendar/calendar-event-import-manager/constants/calendar-throttle-max-attempts';
import { CalendarEventImportDriverExceptionCode } from 'src/modules/calendar/calendar-event-import-manager/drivers/exceptions/calendar-event-import-driver.exception';
import {
  CalendarEventImportException,
  CalendarEventImportExceptionCode,
} from 'src/modules/calendar/calendar-event-import-manager/exceptions/calendar-event-import.exception';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';
export enum CalendarEventImportSyncStep {
  CALENDAR_EVENT_LIST_FETCH = 'CALENDAR_EVENT_LIST_FETCH',
  CALENDAR_EVENTS_IMPORT = 'CALENDAR_EVENTS_IMPORT',
}

@Injectable()
export class CalendarEventImportErrorHandlerService {
  private readonly logger = new Logger(
    CalendarEventImportErrorHandlerService.name,
  );
  constructor(
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
  ) {}

  public async handleDriverException(
    exception: unknown,
    syncStep: CalendarEventImportSyncStep,
    calendarChannel: Pick<
      CalendarChannelEntity,
      'id' | 'throttleFailureCount' | 'connectedAccountId'
    >,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    expectedRun = expectedRun && { ...expectedRun };
    if (isTransactionUnsafeToRetry(exception)) throw exception;
    const error =
      exception instanceof Error ? exception : new Error(String(exception));

    switch ('code' in error ? error.code : undefined) {
      case CalendarEventImportDriverExceptionCode.NOT_FOUND:
        await this.handleNotFoundException(
          syncStep,
          calendarChannel,
          workspaceId,
          expectedRun,
        );
        break;
      case TwentyOrmExceptionCode.QUERY_READ_TIMEOUT:
      case TwentyOrmExceptionCode.TRANSIENT_DATABASE_ERROR:
      case CalendarEventImportDriverExceptionCode.TEMPORARY_ERROR:
      case ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR:
        await this.handleTemporaryException(
          syncStep,
          calendarChannel,
          workspaceId,
          expectedRun,
        );
        break;
      case CalendarEventImportDriverExceptionCode.INSUFFICIENT_PERMISSIONS:
      case ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND:
      case ConnectedAccountRefreshAccessTokenExceptionCode.INVALID_REFRESH_TOKEN:
        await this.handleInsufficientPermissionsException(
          calendarChannel,
          workspaceId,
          expectedRun,
        );
        break;
      case CalendarEventImportDriverExceptionCode.SYNC_CURSOR_ERROR:
        await this.handleSyncCursorErrorException(
          calendarChannel,
          workspaceId,
          expectedRun,
        );
        break;
      case CalendarEventImportDriverExceptionCode.CHANNEL_MISCONFIGURED:
      case CalendarEventImportDriverExceptionCode.UNKNOWN:
      case CalendarEventImportDriverExceptionCode.UNKNOWN_NETWORK_ERROR:
      case ConnectedAccountRefreshAccessTokenExceptionCode.ACCESS_TOKEN_NOT_FOUND:
      case ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED:
      default:
        await this.handleUnknownException(
          error,
          calendarChannel,
          workspaceId,
          expectedRun,
        );
        break;
    }
  }

  private async handleSyncCursorErrorException(
    calendarChannel: Pick<CalendarChannelEntity, 'id' | 'connectedAccountId'>,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    this.logger.debug(
      `CalendarChannelId: ${calendarChannel.id} - Sync cursor error, resetting and rescheduling`,
    );

    await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
      [calendarChannel.id],
      workspaceId,
      calendarChannel.connectedAccountId,
      undefined,
      expectedRun,
    );
  }

  private async handleTemporaryException(
    syncStep: CalendarEventImportSyncStep,
    calendarChannel: Pick<
      CalendarChannelEntity,
      'id' | 'throttleFailureCount' | 'connectedAccountId'
    >,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    const result =
      await this.calendarChannelSyncStatusService.recordTemporaryFailure(
        calendarChannel.id,
        calendarChannel.connectedAccountId,
        workspaceId,
        syncStep === CalendarEventImportSyncStep.CALENDAR_EVENT_LIST_FETCH,
        CALENDAR_THROTTLE_MAX_ATTEMPTS,
        expectedRun,
      );
    if (!result) return;
    if (result.exhausted) {
      const calendarEventImportException = new CalendarEventImportException(
        `Temporary error occurred ${CALENDAR_THROTTLE_MAX_ATTEMPTS} times while importing calendar events for calendar channel ${calendarChannel.id} in workspace ${workspaceId} with throttleFailureCount ${result.failureCount}`,
        CalendarEventImportExceptionCode.UNKNOWN,
      );

      this.exceptionHandlerService.captureExceptions(
        [calendarEventImportException],
        {
          additionalData: {
            calendarChannelId: calendarChannel.id,
            syncStep,
            throttleFailureCount: result.failureCount,
          },
          workspace: {
            id: workspaceId,
          },
        },
      );

      throw calendarEventImportException;
    }
  }

  private async handleInsufficientPermissionsException(
    calendarChannel: Pick<CalendarChannelEntity, 'id' | 'connectedAccountId'>,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    await this.calendarChannelSyncStatusService.markAsFailedInsufficientPermissionsAndFlushCalendarEventsToImport(
      [calendarChannel.id],
      workspaceId,
      calendarChannel.connectedAccountId,
      expectedRun,
    );
  }

  private async handleUnknownException(
    exception: { message: string },
    calendarChannel: Pick<CalendarChannelEntity, 'id' | 'connectedAccountId'>,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    await this.calendarChannelSyncStatusService.markAsFailedUnknownAndFlushCalendarEventsToImport(
      [calendarChannel.id],
      workspaceId,
      calendarChannel.connectedAccountId,
      expectedRun,
    );

    const calendarEventImportException = new CalendarEventImportException(
      `Unknown error importing calendar events for calendar channel ${calendarChannel.id} in workspace ${workspaceId}: ${exception.message}`,
      CalendarEventImportExceptionCode.UNKNOWN,
    );

    this.logger.error(exception);
    this.exceptionHandlerService.captureExceptions(
      [calendarEventImportException],
      {
        additionalData: {
          calendarChannelId: calendarChannel.id,
          exceptionMessage: exception.message,
        },
        workspace: {
          id: workspaceId,
        },
      },
    );

    throw calendarEventImportException;
  }

  private async handleNotFoundException(
    syncStep: CalendarEventImportSyncStep,
    calendarChannel: Pick<CalendarChannelEntity, 'id' | 'connectedAccountId'>,
    workspaceId: string,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<void> {
    if (syncStep === CalendarEventImportSyncStep.CALENDAR_EVENT_LIST_FETCH) {
      return;
    }

    await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
      [calendarChannel.id],
      workspaceId,
      calendarChannel.connectedAccountId,
      undefined,
      expectedRun,
    );
  }
}
