import { Injectable } from '@nestjs/common';
import { MoreThan } from 'typeorm';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { deleteOrdinaryGroupEmailMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-group-email-message-associations-with-audit';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type OrdinaryGroupEmailAction } from 'src/modules/omnichannel/services/ordinary-group-email-action';

const PAGE_SIZE = 200;

@Injectable()
export class MessagingDeleteGroupEmailMessagesService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async deleteGroupEmailMessages(
    workspaceId: string,
    messageChannelId: string,
    action: OrdinaryGroupEmailAction,
  ): Promise<number | null> {
    if (
      !action ||
      action.workspaceId !== workspaceId ||
      action.messageChannelId !== messageChannelId ||
      action.action !== 'GROUP_EMAILS_DELETION'
    )
      throw new Error('OMNI_INVALID_GROUP_ACTION_SCOPE');
    const expected = { ...action };
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      MessagingDeleteGroupEmailMessagesService.name,
    );
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        const repository =
          this.workspaceOrmManager.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
            'messageChannelMessageAssociation',
            { shouldBypassPermissionChecks: true },
          );
        let cursor: string | undefined;
        let deleted = 0;
        for (;;) {
          // Candidate discovery conveys no authority; sender classification and action validation happen inside the owner.
          const rows = await repository.find({
            where: {
              messageChannelId,
              ...(cursor ? { id: MoreThan(cursor) } : {}),
            },
            select: { id: true },
            order: { id: 'ASC' },
            take: PAGE_SIZE,
          });
          const candidateAssociationIds = rows.map((row) => row.id);
          const operation = membershipCleanupOperation(workspaceId, identity)!;
          const result =
            await this.workspaceOrmManager.runInWorkspaceTransaction(
              async (scope) => {
                if (scope.workspaceId !== workspaceId)
                  throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
                return deleteOrdinaryGroupEmailMessageAssociationsWithAudit({
                  scope,
                  operation,
                  action: expected,
                  candidateAssociationIds,
                });
              },
              { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
            );
          if (result === null) return null;
          deleted += result.primaryDeletedAssociationIds.length;
          if (rows.length < PAGE_SIZE) return deleted;
          cursor = rows[rows.length - 1].id;
        }
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
