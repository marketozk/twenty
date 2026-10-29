import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteNativeCalendarChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit';
import { lockNativeCleanupCandidates } from 'src/modules/omnichannel/services/lock-native-cleanup-candidates';
import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import { In, MoreThan } from 'typeorm';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type CalendarChannelEventAssociationWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-channel-event-association.workspace-entity';
import { type CalendarEventWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event.workspace-entity';

type CleanupTransactionScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];

const CALENDAR_CLEANUP_PAGE_SIZE = 500;

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

  public async deleteOrphanedCalendarEvents({
    calendarEventIds,
    workspaceId,
  }: {
    calendarEventIds: string[];
    workspaceId: string;
  }) {
    if (calendarEventIds.length === 0) {
      return;
    }

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            await this.deleteOrphansInScope(transactionScope, calendarEventIds);
          },
        );
      },
      authContext,
      { lite: true },
    );
  }

  private async deleteOrphansInScope(
    transactionScope: CleanupTransactionScope,
    calendarEventIds: string[],
  ): Promise<void> {
    const calendarEventRepository =
      transactionScope.getRepository<CalendarEventWorkspaceEntity>(
        'calendarEvent',
        { shouldBypassPermissionChecks: true },
      );
    const calendarChannelEventAssociationRepository =
      transactionScope.getRepository<CalendarChannelEventAssociationWorkspaceEntity>(
        'calendarChannelEventAssociation',
        { shouldBypassPermissionChecks: true },
      );

    for (
      let index = 0;
      index < calendarEventIds.length;
      index += CALENDAR_CLEANUP_PAGE_SIZE
    ) {
      const pageIds = calendarEventIds.slice(
        index,
        index + CALENDAR_CLEANUP_PAGE_SIZE,
      );

      await lockNativeCleanupCandidates(
        transactionScope,
        'calendarEvent',
        pageIds,
      );

      const associations = await calendarChannelEventAssociationRepository.find(
        {
          where: { calendarEventId: In(pageIds) },
          select: { calendarEventId: true },
        },
      );

      const referencedEventIds = new Set(
        associations.map(({ calendarEventId }) => calendarEventId),
      );

      const orphanEventIds = pageIds.filter(
        (eventId) => !referencedEventIds.has(eventId),
      );

      if (orphanEventIds.length > 0) {
        await calendarEventRepository.delete(orphanEventIds);
      }
    }
  }

  async deleteCalendarChannelEventAssociationsAndRelatedOrphans({
    workspaceId,
    calendarChannelId,
    eventExternalIds,
    expectedRun,
  }: {
    workspaceId: string;
    calendarChannelId: string;
    eventExternalIds: string[];
    expectedRun: OrdinaryMetadataSyncRun;
  }): Promise<boolean> {
    const run = { ...expectedRun };
    const externalIds = [...eventExternalIds];
    if (
      run.workspaceId !== workspaceId ||
      run.channelId !== calendarChannelId ||
      run.kind !== 'calendar'
    )
      throw new Error('ORDINARY_SYNC_CLEANUP_INVALID_SCOPE');
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            if (!(await lockOrdinaryNativeSyncRun(scope, run))) return false;
            const repository =
              scope.getRepository<CalendarChannelEventAssociationWorkspaceEntity>(
                'calendarChannelEventAssociation',
                { shouldBypassPermissionChecks: true },
              );
            for (
              let index = 0;
              index < externalIds.length;
              index += CALENDAR_CLEANUP_PAGE_SIZE
            ) {
              const associations = await repository.find({
                where: {
                  calendarChannelId,
                  eventExternalId: In(
                    externalIds.slice(
                      index,
                      index + CALENDAR_CLEANUP_PAGE_SIZE,
                    ),
                  ),
                },
                select: { id: true, calendarEventId: true },
              });
              if (!associations.length) continue;
              await lockNativeCleanupCandidates(
                scope,
                'calendarEvent',
                associations.map(({ calendarEventId }) => calendarEventId),
              );
              await lockNativeCleanupCandidates(
                scope,
                'calendarChannelEventAssociation',
                associations.map(({ id }) => id),
              );
              const current = await repository.find({
                where: {
                  id: In(associations.map(({ id }) => id)),
                  calendarChannelId,
                  eventExternalId: In(
                    externalIds.slice(
                      index,
                      index + CALENDAR_CLEANUP_PAGE_SIZE,
                    ),
                  ),
                },
                select: { id: true, calendarEventId: true },
              });
              const expected = new Map(
                associations.map(({ id, calendarEventId }) => [
                  id,
                  calendarEventId,
                ]),
              );
              if (
                current.some(
                  ({ id, calendarEventId }) =>
                    expected.get(id) !== calendarEventId,
                )
              )
                throw new Error('NATIVE_CLEANUP_REFERENCE_CHANGED');
              if (!current.length) continue;
              await repository.delete(current.map(({ id }) => id));
              await this.deleteOrphansInScope(scope, [
                ...new Set(
                  current.map(({ calendarEventId }) => calendarEventId),
                ),
              ]);
            }
            return true;
          },
          { commitOutcome: 'strict' },
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  public async cleanWorkspaceCalendarEvents(workspaceId: string) {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            const calendarEventRepository =
              transactionScope.getRepository<CalendarEventWorkspaceEntity>(
                'calendarEvent',
                { shouldBypassPermissionChecks: true },
              );
            const calendarChannelEventAssociationRepository =
              transactionScope.getRepository<CalendarChannelEventAssociationWorkspaceEntity>(
                'calendarChannelEventAssociation',
                { shouldBypassPermissionChecks: true },
              );

            let cursor: string | undefined;

            for (;;) {
              const page = await calendarEventRepository.find({
                where: isDefined(cursor) ? { id: MoreThan(cursor) } : {},
                order: { id: 'ASC' },
                take: CALENDAR_CLEANUP_PAGE_SIZE,
                select: { id: true },
              });

              if (page.length === 0) {
                break;
              }

              cursor = page[page.length - 1].id;

              const pageIds = page.map(({ id }) => id);

              const associations =
                await calendarChannelEventAssociationRepository.find({
                  where: { calendarEventId: In(pageIds) },
                  select: { calendarEventId: true },
                });

              const referencedEventIds = new Set(
                associations.map(({ calendarEventId }) => calendarEventId),
              );

              const orphanEventIds = pageIds.filter(
                (eventId) => !referencedEventIds.has(eventId),
              );

              if (orphanEventIds.length > 0) {
                await calendarEventRepository.delete(orphanEventIds);
              }
            }
          },
        );
      },
      authContext,
      { lite: true },
    );
  }
}
