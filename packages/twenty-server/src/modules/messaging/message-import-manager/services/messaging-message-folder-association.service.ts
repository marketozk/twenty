import { Injectable } from '@nestjs/common';

import { In } from 'typeorm';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type MessageChannelMessageAssociationMessageFolderWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association-message-folder.workspace-entity';
import { type MessageChannelMessageAssociationFolderAssociation } from 'src/modules/messaging/message-import-manager/types/message-channel-message-association-folder-association.type';
import {
  buildMessageFolderAssociationsToInsert,
  type MessageFolderAssociationRecord,
} from 'src/modules/messaging/message-import-manager/utils/build-message-folder-associations-to-insert.util';

export type MessageFolderAssociationSavePlan = Readonly<{
  recordsToInsert: readonly MessageFolderAssociationRecord[];
  existingRecords: readonly MessageChannelMessageAssociationMessageFolderWorkspaceEntity[];
}>;

@Injectable()
export class MessagingMessageFolderAssociationService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async prepareMessageFolderAssociationsWithinTransaction(
    associations: MessageChannelMessageAssociationFolderAssociation[],
    workspaceId: string,
    transactionScope: WorkspaceTransactionScope,
  ): Promise<MessageFolderAssociationSavePlan> {
    const associationIds = [
      ...new Set(
        associations
          .filter((association) => association.messageFolderIds.length > 0)
          .map((association) => association.messageChannelMessageAssociationId),
      ),
    ];

    if (associationIds.length === 0) {
      return Object.freeze({
        recordsToInsert: Object.freeze([]),
        existingRecords: Object.freeze([]),
      });
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const repository =
          transactionScope.getRepository<MessageChannelMessageAssociationMessageFolderWorkspaceEntity>(
            'messageChannelMessageAssociationMessageFolder',
            { shouldBypassPermissionChecks: true },
          );

        const existingRecords = await repository.find({
          where: {
            messageChannelMessageAssociationId: In(associationIds),
          },
        });

        const recordsToInsert = buildMessageFolderAssociationsToInsert({
          associations,
          existingRecords,
        });

        return Object.freeze({
          recordsToInsert: Object.freeze(
            recordsToInsert.map((record) => Object.freeze({ ...record })),
          ),
          existingRecords: Object.freeze(
            existingRecords.map((record) => Object.freeze({ ...record })),
          ),
        });
      },
      authContext,
      { lite: true },
    );
  }

  async saveMessageFolderAssociations(
    associations: MessageChannelMessageAssociationFolderAssociation[],
    workspaceId: string,
    transactionScope: WorkspaceTransactionScope,
  ): Promise<void> {
    const plan = await this.prepareMessageFolderAssociationsWithinTransaction(
      associations,
      workspaceId,
      transactionScope,
    );

    if (plan.recordsToInsert.length === 0) {
      return;
    }

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const repository =
          transactionScope.getRepository<MessageChannelMessageAssociationMessageFolderWorkspaceEntity>(
            'messageChannelMessageAssociationMessageFolder',
            { shouldBypassPermissionChecks: true },
          );

        await repository.insert(
          plan.recordsToInsert.map((record) => ({ ...record })),
        );
      },
      authContext,
      { lite: true },
    );
  }
}
