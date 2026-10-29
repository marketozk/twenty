import { captureCurrentCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { membershipCleanupOperation } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  CalendarChannelSettingsError,
  type CalendarChannelSettingsUpdates,
  type CalendarChannelSettingsResult,
  updateCalendarChannelSettingsWithAudit,
} from 'src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import {
  CalendarChannelSyncStage,
  CalendarChannelVisibility,
} from 'twenty-shared/types';

import {
  CalendarChannelException,
  CalendarChannelExceptionCode,
} from 'src/engine/metadata-modules/calendar-channel/calendar-channel.exception';
import { CALENDAR_CHANNEL_DELETED_EVENT } from 'src/engine/metadata-modules/calendar-channel/constants/calendar-channel-deleted.constant';
import { CalendarChannelDTO } from 'src/engine/metadata-modules/calendar-channel/dtos/calendar-channel.dto';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type CalendarChannelDeletedEvent } from 'src/engine/metadata-modules/calendar-channel/types/calendar-channel-deleted.type';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';

@Injectable()
export class CalendarChannelMetadataService {
  constructor(
    @InjectRepository(CalendarChannelEntity)
    private readonly repository: Repository<CalendarChannelEntity>,
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
  ) {}

  async findAll(workspaceId: string): Promise<CalendarChannelDTO[]> {
    return this.repository.find({ where: { workspaceId } });
  }

  async findByUserWorkspaceId({
    userWorkspaceId,
    workspaceId,
  }: {
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<CalendarChannelDTO[]> {
    const userAccountIds =
      await this.connectedAccountMetadataService.getUserConnectedAccountIds({
        userWorkspaceId,
        workspaceId,
      });

    return this.findByConnectedAccountIds({
      connectedAccountIds: userAccountIds,
      workspaceId,
    });
  }

  async findByConnectedAccountIdForUser({
    connectedAccountId,
    userWorkspaceId,
    workspaceId,
  }: {
    connectedAccountId: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<CalendarChannelDTO[]> {
    await this.connectedAccountMetadataService.verifyUsableByCaller({
      id: connectedAccountId,
      userWorkspaceId,
      workspaceId,
    });

    return this.findByConnectedAccountId({ connectedAccountId, workspaceId });
  }

  async findByConnectedAccountId({
    connectedAccountId,
    workspaceId,
  }: {
    connectedAccountId: string;
    workspaceId: string;
  }): Promise<CalendarChannelDTO[]> {
    return this.repository.find({
      where: { connectedAccountId, workspaceId },
    });
  }

  async findByConnectedAccountIds({
    connectedAccountIds,
    workspaceId,
  }: {
    connectedAccountIds: string[];
    workspaceId: string;
  }): Promise<CalendarChannelDTO[]> {
    if (connectedAccountIds.length === 0) {
      return [];
    }

    return this.repository.find({
      where: { connectedAccountId: In(connectedAccountIds), workspaceId },
    });
  }

  async findById({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<CalendarChannelDTO | null> {
    return this.repository.findOne({ where: { id, workspaceId } });
  }

  async verifyOwnership({
    id,
    userWorkspaceId,
    workspaceId,
  }: {
    id: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<CalendarChannelEntity> {
    const calendarChannel = await this.repository.findOne({
      where: { id, workspaceId },
    });

    if (!calendarChannel) {
      throw new CalendarChannelException(
        `Calendar channel ${id} not found`,
        CalendarChannelExceptionCode.CALENDAR_CHANNEL_NOT_FOUND,
      );
    }

    const userAccountIds =
      await this.connectedAccountMetadataService.getUserConnectedAccountIds({
        userWorkspaceId,
        workspaceId,
      });

    if (!userAccountIds.includes(calendarChannel.connectedAccountId)) {
      throw new CalendarChannelException(
        `Calendar channel ${id} does not belong to user workspace ${userWorkspaceId}`,
        CalendarChannelExceptionCode.CALENDAR_CHANNEL_OWNERSHIP_VIOLATION,
      );
    }

    return calendarChannel;
  }

  async create(
    data: Partial<CalendarChannelEntity> & {
      workspaceId: string;
      handle: string;
      connectedAccountId: string;
      visibility: CalendarChannelVisibility;
      syncStage: CalendarChannelSyncStage;
    },
  ): Promise<CalendarChannelDTO> {
    const entity = this.repository.create(data);

    return this.repository.save(entity);
  }

  async update({
    id,
    workspaceId,
    data,
    caller,
  }: {
    id: string;
    workspaceId: string;
    data: CalendarChannelSettingsUpdates;
    caller: { userWorkspaceId: string; userId: string };
  }): Promise<CalendarChannelSettingsResult> {
    const updates = { ...data };
    const capturedCaller = {
      userWorkspaceId: caller.userWorkspaceId,
      userId: caller.userId,
    };
    if (this.repository.manager.queryRunner?.isTransactionActive)
      throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
    const identity = await captureCurrentCrmAuditIdentity(
      workspaceId,
      async (membershipId) => {
        const [member] = await this.repository.manager.query(
          'SELECT "userId" FROM core."userWorkspace" WHERE id=$1',
          [membershipId],
        );
        return member?.userId;
      },
    );
    const operation = membershipCleanupOperation(workspaceId, identity);
    if (!operation)
      throw new Error('Calendar channel settings require audit identity');
    try {
      return await updateCalendarChannelSettingsWithAudit({
        dataSource: this.repository.manager.connection,
        workspaceId,
        calendarChannelId: id,
        caller: capturedCaller,
        updates,
        operation,
      });
    } catch (error) {
      if (error instanceof CalendarChannelSettingsError)
        throw new CalendarChannelException(
          error.message,
          CalendarChannelExceptionCode[error.code],
        );
      throw error;
    }
  }

  async delete({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<CalendarChannelDTO> {
    const calendarChannel = await this.repository.findOneOrFail({
      where: { id, workspaceId },
    });

    await this.repository.delete({ id, workspaceId });

    this.workspaceEventEmitter.emitCustomBatchEvent<CalendarChannelDeletedEvent>(
      CALENDAR_CHANNEL_DELETED_EVENT,
      [{ calendarChannelId: id }],
      workspaceId,
    );

    return calendarChannel;
  }
}
