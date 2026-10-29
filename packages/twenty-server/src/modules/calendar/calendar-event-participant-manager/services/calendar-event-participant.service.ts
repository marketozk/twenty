import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

import chunk from 'lodash.chunk';
import { FieldActorSource } from 'twenty-shared/types';
import { Any, In } from 'typeorm';

import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { CALENDAR_EVENT_PARTICIPANT_CHUNK_SIZE } from 'src/modules/calendar/calendar-event-participant-manager/constants/calendar-event-participant-chunk-size';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { type FetchedCalendarEventParticipant } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import {
  CreateCompanyAndContactJob,
  type CreateCompanyAndContactJobData,
} from 'src/modules/contact-creation-manager/jobs/create-company-and-contact.job';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';

@Injectable()
export class CalendarEventParticipantService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly matchParticipantService: MatchParticipantService<CalendarEventParticipantWorkspaceEntity>,
    @InjectMessageQueue(MessageQueue.contactCreationQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  public async findCalendarEventParticipantsByCalendarEventIds({
    calendarEventIds,
    transactionScope,
  }: {
    calendarEventIds: string[];
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<CalendarEventParticipantWorkspaceEntity[]> {
    const calendarEventParticipantRepository = (
      transactionScope ?? this.workspaceOrmManager
    ).getRepository<CalendarEventParticipantWorkspaceEntity>(
      'calendarEventParticipant',
      { shouldBypassPermissionChecks: true },
    );

    return calendarEventParticipantRepository.find({
      where: { calendarEventId: Any([...new Set(calendarEventIds)]) },
    });
  }

  public async matchParticipantsAndEnqueueContactCreationJob({
    savedParticipantIds,
    participantsOfLinkedEvents,
    calendarChannel,
    connectedAccount,
    workspaceId,
    calendarEventIds,
    auditOperation,
  }: {
    savedParticipantIds: string[];
    participantsOfLinkedEvents: FetchedCalendarEventParticipant[];
    calendarChannel: CalendarChannelEntity;
    connectedAccount: ConnectedAccountEntity;
    workspaceId: string;
    calendarEventIds: string[];
    auditOperation: CrmAuditOperation;
  }): Promise<void> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error('Calendar matching requires scoped save audit operation');
    const operation: CrmAuditOperation = {
      ...auditOperation,
      operationId: randomUUID(),
      causationId: auditOperation.operationId,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    savedParticipantIds = [...savedParticipantIds];
    calendarEventIds = [...calendarEventIds];
    participantsOfLinkedEvents = participantsOfLinkedEvents.map((row) => ({
      ...row,
    }));
    calendarChannel = { ...calendarChannel };
    connectedAccount = {
      ...connectedAccount,
      handleAliases: connectedAccount.handleAliases && [
        ...connectedAccount.handleAliases,
      ],
    };
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const calendarEventParticipantRepository =
          this.workspaceOrmManager.getRepository<CalendarEventParticipantWorkspaceEntity>(
            'calendarEventParticipant',
            { shouldBypassPermissionChecks: true },
          );

        const savedParticipants: CalendarEventParticipantWorkspaceEntity[] = [];

        for (const savedParticipantIdsChunk of chunk(
          savedParticipantIds,
          CALENDAR_EVENT_PARTICIPANT_CHUNK_SIZE,
        )) {
          const participantsChunk =
            await calendarEventParticipantRepository.find({
              where: { id: In(savedParticipantIdsChunk) },
            });

          savedParticipants.push(...participantsChunk);
        }

        if (calendarChannel.isContactAutoCreationEnabled) {
          await this.messageQueueService.add<CreateCompanyAndContactJobData>(
            CreateCompanyAndContactJob.name,
            {
              workspaceId,
              connectedAccount,
              contactsToCreate: [
                ...savedParticipants,
                ...participantsOfLinkedEvents,
              ].map((participant) => ({
                handle: participant.handle ?? '',
                displayName:
                  participant.displayName ?? participant.handle ?? '',
              })),
              source: FieldActorSource.CALENDAR,
            },
          );
        }

        await this.matchParticipantService.matchCalendarImportParticipantsWithAudit(
          {
            workspaceId,
            participantIds: savedParticipantIds,
            eventIds: calendarEventIds,
            operation,
          },
        );
      },
      authContext,
      { lite: true },
    );
  }
}
