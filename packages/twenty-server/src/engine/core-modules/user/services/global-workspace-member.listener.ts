import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import {
  ObjectRecordCreateEvent,
  ObjectRecordRestoreEvent,
  ObjectRecordUpdateEvent,
  ObjectRecordUpsertEvent,
  type ObjectRecordDeleteEvent,
  type ObjectRecordDestroyEvent,
} from 'twenty-shared/database-events';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { UserWorkspaceService } from 'src/engine/core-modules/user-workspace/user-workspace.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

@Injectable()
export class GlobalWorkspaceMemberListener {
  constructor(
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly userWorkspaceService: UserWorkspaceService,
  ) {}

  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.CREATED)
  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.UPDATED)
  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.DELETED)
  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.DESTROYED)
  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.RESTORED)
  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.UPSERTED)
  async handleWorkspaceMemberEvent(
    payload: WorkspaceEventBatch<
      | ObjectRecordCreateEvent<WorkspaceMemberWorkspaceEntity>
      | ObjectRecordUpdateEvent<WorkspaceMemberWorkspaceEntity>
      | ObjectRecordDeleteEvent<WorkspaceMemberWorkspaceEntity>
      | ObjectRecordDestroyEvent<WorkspaceMemberWorkspaceEntity>
      | ObjectRecordRestoreEvent<WorkspaceMemberWorkspaceEntity>
      | ObjectRecordUpsertEvent<WorkspaceMemberWorkspaceEntity>
    >,
  ) {
    await this.workspaceCacheService.invalidateAndRecompute(
      payload.workspaceId,
      ['flatWorkspaceMemberMaps'],
    );
  }

  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.UPDATED)
  async syncUserWorkspaceLocale(
    payload: WorkspaceEventBatch<
      ObjectRecordUpdateEvent<WorkspaceMemberWorkspaceEntity>
    >,
  ) {
    const capturedWorkspaceId = payload.workspaceId;
    const capturedEvents = payload.events
      .filter(
        (event) =>
          isDefined(event.properties.diff?.locale) &&
          isDefined(event.properties.after),
      )
      .map((event) => ({
        userId: event.properties.after.userId,
        locale: event.properties.after.locale,
        actingUserId: event.userId,
      }));

    for (const item of capturedEvents) {
      const userWorkspace =
        await this.userWorkspaceService.getUserWorkspaceForUser({
          userId: item.userId,
          workspaceId: capturedWorkspaceId,
          relations: [],
        });

      if (!isDefined(userWorkspace) || userWorkspace.locale === item.locale) {
        continue;
      }

      await this.userWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace(
        {
          locale: item.locale,
          userWorkspaceId: userWorkspace.id,
          auditIdentity: {
            workspaceId: capturedWorkspaceId,
            actor: isDefined(item.actingUserId)
              ? { kind: 'coreUser', id: item.actingUserId }
              : {
                  kind: 'system',
                  id: 'workspace-member:sync-user-workspace-locale',
                },
          },
        },
      );
    }
  }
}
