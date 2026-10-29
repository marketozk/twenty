import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type MembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Injectable, Logger } from '@nestjs/common';

import { ConnectedAccountProvider } from 'twenty-shared/types';

import { CalDavCreateEventService } from 'src/modules/calendar/calendar-event-creation-manager/drivers/caldav/services/caldav-create-event.service';
import { GoogleCalendarCreateEventService } from 'src/modules/calendar/calendar-event-creation-manager/drivers/google-calendar/services/google-calendar-create-event.service';
import { MicrosoftCalendarCreateEventService } from 'src/modules/calendar/calendar-event-creation-manager/drivers/microsoft-calendar/services/microsoft-calendar-create-event.service';
import {
  CalendarEventCreationException,
  CalendarEventCreationExceptionCode,
} from 'src/modules/calendar/calendar-event-creation-manager/exceptions/calendar-event-creation.exception';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { type ComposedCalendarEvent } from 'src/modules/calendar/calendar-event-creation-manager/types/composed-calendar-event.type';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';

@Injectable()
export class CreateCalendarEventService {
  private readonly logger = new Logger(CreateCalendarEventService.name);

  constructor(
    private readonly googleCalendarCreateEventService: GoogleCalendarCreateEventService,
    private readonly microsoftCalendarCreateEventService: MicrosoftCalendarCreateEventService,
    private readonly calDavCreateEventService: CalDavCreateEventService,
    private readonly calendarSaveEventsService: CalendarSaveEventsService,
  ) {}

  captureCalendarSaveAuditOperation(
    workspaceId: string,
    trustedIdentity?: MembershipCleanupIdentity,
  ): Promise<CrmAuditOperation> {
    return this.calendarSaveEventsService.captureCalendarSaveAuditOperation(
      workspaceId,
      trustedIdentity,
    );
  }

  async createComposedCalendarEvent(
    data: ComposedCalendarEvent,
  ): Promise<FetchedCalendarEvent> {
    switch (data.connectedAccount.provider) {
      case ConnectedAccountProvider.GOOGLE:
        return this.googleCalendarCreateEventService.createCalendarEvent(
          data.input,
          data.connectedAccount,
        );
      case ConnectedAccountProvider.MICROSOFT:
        return this.microsoftCalendarCreateEventService.createCalendarEvent(
          data.input,
          data.connectedAccount,
        );
      case ConnectedAccountProvider.IMAP_SMTP_CALDAV:
        return this.calDavCreateEventService.createCalendarEvent(
          data.input,
          data.connectedAccount,
        );
      default:
        throw new CalendarEventCreationException(
          `Calendar event creation is not supported for provider ${data.connectedAccount.provider}`,
          CalendarEventCreationExceptionCode.PROVIDER_NOT_SUPPORTED,
        );
    }
  }

  // Non-fatal on failure: the next provider sync reconciles the event via its external id
  async persistCalendarEvent(
    createdEvent: FetchedCalendarEvent,
    data: ComposedCalendarEvent,
    workspaceId: string,
    auditOperation: CrmAuditOperation,
  ): Promise<string | null> {
    try {
      const { calendarEventIds } =
        await this.calendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob(
          [createdEvent],
          data.calendarChannel,
          data.connectedAccount,
          workspaceId,
          auditOperation,
        );

      return calendarEventIds[0] ?? null;
    } catch {
      // Provider creation already succeeded; diagnostics must not report it as failed.
      try {
        this.logger.warn(
          'Created calendar event could not be confirmed locally; provider sync will reconcile it.',
        );
      } catch {
        // Logging is best-effort after the external side effect.
      }
      return null;
    }
  }
}
