import { deleteOrdinarySyncCalendarAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-sync-calendar-associations-with-audit';
import { cleanWorkspaceNativeCalendarEventsWithAudit } from 'src/engine/core-modules/crm-audit/clean-workspace-native-calendar-events-with-audit';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteNativeCalendarChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { Injectable } from '@nestjs/common';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';

@Injectable()
export class CalendarEventCleanerService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async deleteCalendarChannelEventAssociationsByChannelId({
    workspaceId,
    calendarChannelId,
    auditOperation,
  }: {
    workspaceId: string;
    calendarChannelId: string;
    auditOperation: CrmAuditOperation;
  }): Promise<number> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error(
        'Native calendar cleanup requires scoped audit operation',
      );
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        return this.workspaceOrmManager.runInWorkspaceTransaction(
          (scope) => {
            if (scope.workspaceId !== workspaceId)
              throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
            return deleteNativeCalendarChannelAssociationsWithAudit({
              scope,
              operation,
              calendarChannelId,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        );
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  async deleteCalendarChannelEventAssociationsAndRelatedOrphans({
    workspaceId,
    calendarChannelId,
    eventExternalIds,
    expectedRun,
    auditOperation,
  }: {
    workspaceId: string;
    calendarChannelId: string;
    eventExternalIds: string[];
    expectedRun: OrdinaryMetadataSyncRun;
    auditOperation: CrmAuditOperation;
  }): Promise<boolean> {
    const run = { ...expectedRun };
    const externalIds = [...eventExternalIds];
    if (
      run.workspaceId !== workspaceId ||
      run.channelId !== calendarChannelId ||
      run.kind !== 'calendar'
    )
      throw new Error('ORDINARY_SYNC_CLEANUP_INVALID_SCOPE');
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error(
        'Native calendar cleanup requires scoped audit operation',
      );
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        return this.workspaceOrmManager.runInWorkspaceTransaction(
          (scope) => {
            if (scope.workspaceId !== workspaceId)
              throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
            return deleteOrdinarySyncCalendarAssociationsWithAudit({
              scope,
              operation,
              expectedRun: run,
              eventExternalIds: externalIds,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        );
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  public async cleanWorkspaceCalendarEvents(
    workspaceId: string,
    auditOperation: CrmAuditOperation,
  ): Promise<void> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error(
        'Native calendar cleanup requires scoped audit operation',
      );
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            if (scope.workspaceId !== workspaceId)
              throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
            await cleanWorkspaceNativeCalendarEventsWithAudit({
              scope,
              operation,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        );
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
