import { lockNativeCleanupCandidates } from 'src/modules/omnichannel/services/lock-native-cleanup-candidates';
import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import {
  lockCurrentGroupEmailAction,
  type OrdinaryGroupEmailAction,
} from 'src/modules/omnichannel/services/ordinary-group-email-action';
import { Injectable, Logger } from '@nestjs/common';

import chunk from 'lodash.chunk';
import { isDefined } from 'twenty-shared/utils';
import { In, MoreThan } from 'typeorm';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type MessageThreadWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-thread.workspace-entity';
import { type MessageWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message.workspace-entity';
import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';

type CleanupTransactionScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];

const ORPHAN_CLEANUP_PAGE_SIZE = 500;

@Injectable()
export class MessagingMessageCleanerService {
  private readonly logger = new Logger(MessagingMessageCleanerService.name);
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly participantTargetReconciliationService: ParticipantTargetReconciliationService,
  ) {}

  async deleteMessagesChannelMessageAssociationsAndRelatedOrphans({
    workspaceId,
    messageExternalIds,
    messageChannelId,
    groupEmailAction,
    expectedRun,
  }: {
    workspaceId: string;
    messageExternalIds: string[];
    messageChannelId: string;
    groupEmailAction?: OrdinaryGroupEmailAction;
    expectedRun?: OrdinaryMetadataSyncRun;
  }): Promise<boolean> {
    expectedRun = expectedRun ? { ...expectedRun } : undefined;
    const expected = groupEmailAction ? { ...groupEmailAction } : undefined;
    const externalIds = [...messageExternalIds];
    if (
      expected &&
      (expected.workspaceId !== workspaceId ||
        expected.messageChannelId !== messageChannelId ||
        expected.action !== 'GROUP_EMAILS_DELETION')
    )
      throw new Error('OMNI_INVALID_GROUP_ACTION_SCOPE');
    if (
      expectedRun &&
      (expectedRun.workspaceId !== workspaceId ||
        expectedRun.channelId !== messageChannelId ||
        expectedRun.kind !== 'message' ||
        (expected &&
          expected.connectedAccountId !== expectedRun.connectedAccountId))
    )
      throw new Error('ORDINARY_SYNC_CLEANUP_INVALID_SCOPE');
    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        return this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            this.assertWorkspaceScope(workspaceId, transactionScope);
            if (expected) {
              const lifecycle = transactionScope.transactionLifecycle;
              if (
                !lifecycle?.isTransactionActive ||
                lifecycle.isReleased ||
                lifecycle.commitOutcome !== 'strict'
              )
                throw new Error(
                  'OMNI_GROUP_ACTION_REQUIRES_STRICT_TRANSACTION',
                );
              if (
                !(await lockCurrentGroupEmailAction(transactionScope, expected))
              )
                return false;
            }
            if (
              expectedRun &&
              !(await lockOrdinaryNativeSyncRun(transactionScope, expectedRun))
            )
              return false;
            await this.cleanMessageAssociationsInScope(
              transactionScope,
              workspaceId,
              messageChannelId,
              externalIds,
            );
            return true;
          },
          expected || expectedRun ? { commitOutcome: 'strict' } : undefined,
        );
      },
      authContext,
      { lite: true },
    );
  }

  async deleteMessageAssociationsWithinTransaction(
    transactionScope: CleanupTransactionScope,
    args: {
      workspaceId: string;
      messageChannelId: string;
      messageExternalIds: string[];
    },
  ): Promise<void> {
    const lifecycle = transactionScope.transactionLifecycle;
    if (
      !lifecycle?.isTransactionActive ||
      lifecycle.isReleased ||
      lifecycle.commitOutcome !== 'strict'
    )
      throw new Error('OMNI_CLEANUP_REQUIRES_STRICT_TRANSACTION');
    this.assertWorkspaceScope(args.workspaceId, transactionScope);
    return this.cleanMessageAssociationsInScope(
      transactionScope,
      args.workspaceId,
      args.messageChannelId,
      [...args.messageExternalIds],
    );
  }

  private async cleanMessageAssociationsInScope(
    transactionScope: CleanupTransactionScope,
    workspaceId: string,
    messageChannelId: string,
    externalIds: string[],
  ): Promise<void> {
    const messageRepository =
      transactionScope.getRepository<MessageWorkspaceEntity>('message', {
        shouldBypassPermissionChecks: true,
      });
    const messageChannelMessageAssociationRepository =
      transactionScope.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
        'messageChannelMessageAssociation',
        { shouldBypassPermissionChecks: true },
      );
    const messageThreadRepository =
      transactionScope.getRepository<MessageThreadWorkspaceEntity>(
        'messageThread',
        { shouldBypassPermissionChecks: true },
      );

    for (const messageExternalIdsChunk of chunk(externalIds, 500)) {
      const associations =
        await messageChannelMessageAssociationRepository.find({
          where: {
            messageExternalId: In(messageExternalIdsChunk),
            messageChannelId,
          },
        });

      const ownedMessageIds = await findOmniOwnedMessageIds(
        transactionScope,
        workspaceId,
        associations.map(({ messageId }) => messageId),
      );
      let associationsToDelete = associations.filter(
        ({ messageId }) => !ownedMessageIds.has(messageId.toLowerCase()),
      );

      if (associationsToDelete.length <= 0) {
        continue;
      }

      const discoveredMessages = await messageRepository.find({
        where: {
          id: In(associationsToDelete.map(({ messageId }) => messageId)),
        },
      });
      const parents = new Map(
        discoveredMessages.map(({ id, messageThreadId }) => [
          id,
          messageThreadId,
        ]),
      );
      await lockNativeCleanupCandidates(
        transactionScope,
        'messageThread',
        discoveredMessages
          .map(({ messageThreadId }) => messageThreadId)
          .filter(isDefined),
      );
      await lockNativeCleanupCandidates(
        transactionScope,
        'message',
        discoveredMessages.map(({ id }) => id),
      );
      const currentMessages = await messageRepository.find({
        where: { id: In(discoveredMessages.map(({ id }) => id)) },
      });
      if (
        currentMessages.some(
          ({ id, messageThreadId }) => parents.get(id) !== messageThreadId,
        )
      )
        throw new Error('NATIVE_CLEANUP_REFERENCE_CHANGED');
      const expected = new Map(
        associationsToDelete.map(({ id, messageId }) => [id, messageId]),
      );
      await lockNativeCleanupCandidates(
        transactionScope,
        'messageChannelMessageAssociation',
        associationsToDelete.map(({ id }) => id),
      );
      associationsToDelete =
        await messageChannelMessageAssociationRepository.find({
          where: {
            id: In(associationsToDelete.map(({ id }) => id)),
            messageChannelId,
            messageExternalId: In(messageExternalIdsChunk),
          },
        });
      if (
        associationsToDelete.some(
          ({ id, messageId }) => expected.get(id) !== messageId,
        )
      )
        throw new Error('NATIVE_CLEANUP_REFERENCE_CHANGED');
      if (!associationsToDelete.length) continue;
      await messageChannelMessageAssociationRepository.delete(
        associationsToDelete.map(({ id }) => id),
      );

      this.logger.log(
        `WorkspaceId: ${workspaceId} Deleting ${associationsToDelete.length} message channel message associations`,
      );

      const candidateMessageIds = [
        ...new Set(associationsToDelete.map(({ messageId }) => messageId)),
      ];

      const orphanMessageIds = await this.filterOrphans(
        candidateMessageIds,
        async (messageIds) => [
          ...(await this.findReferencedMessageIds(
            messageChannelMessageAssociationRepository,
            messageIds,
          )),
          ...(await findOmniOwnedMessageIds(
            transactionScope,
            workspaceId,
            messageIds,
          )),
        ],
      );

      if (orphanMessageIds.length <= 0) {
        continue;
      }

      const orphanMessages = await messageRepository.find({
        where: { id: In(orphanMessageIds) },
      });

      await messageRepository.delete(orphanMessageIds);

      const candidateThreadIds = [
        ...new Set(
          orphanMessages
            .map(({ messageThreadId }) => messageThreadId)
            .filter(isDefined),
        ),
      ];

      const orphanThreadIds = await this.filterOrphans(
        candidateThreadIds,
        async (threadIds) => [
          ...(await this.findReferencedThreadIds(messageRepository, threadIds)),
          ...(await findOmniOwnedMessageThreadIds(
            transactionScope,
            workspaceId,
            threadIds,
          )),
        ],
      );

      if (orphanThreadIds.length > 0) {
        await messageThreadRepository.delete(orphanThreadIds);
      }

      await this.participantTargetReconciliationService.reconcileMessageThreadTargets(
        {
          messageThreadIds: candidateThreadIds.filter(
            (threadId) => !orphanThreadIds.includes(threadId),
          ),
          transactionScope,
        },
      );
    }
  }

  async deleteMessageChannelMessageAssociationsByChannelId({
    workspaceId,
    messageChannelId,
  }: {
    workspaceId: string;
    messageChannelId: string;
  }) {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            this.assertWorkspaceScope(workspaceId, transactionScope);
            const messageChannelMessageAssociationRepository =
              transactionScope.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
                'messageChannelMessageAssociation',
                { shouldBypassPermissionChecks: true },
              );

            let cursor: string | undefined;

            for (;;) {
              const associations =
                await messageChannelMessageAssociationRepository.find({
                  where: {
                    messageChannelId,
                    ...(isDefined(cursor) ? { id: MoreThan(cursor) } : {}),
                  },
                  order: { id: 'ASC' },
                  take: ORPHAN_CLEANUP_PAGE_SIZE,
                  select: { id: true, messageId: true },
                });

              if (associations.length === 0) {
                break;
              }

              // Protected rows remain, so progress must follow the full page.
              cursor = associations[associations.length - 1].id;
              const ownedMessageIds = await findOmniOwnedMessageIds(
                transactionScope,
                workspaceId,
                associations.map(({ messageId }) => messageId),
              );
              const ids = associations
                .filter(
                  ({ messageId }) =>
                    !ownedMessageIds.has(messageId.toLowerCase()),
                )
                .map(({ id }) => id);

              if (ids.length === 0) continue;

              this.logger.log(
                `WorkspaceId: ${workspaceId} Deleting ${ids.length} message channel message associations for channel ${messageChannelId}`,
              );

              await messageChannelMessageAssociationRepository.delete(ids);
            }
          },
        );
      },
      authContext,
      { lite: true },
    );
  }

  public async cleanOrphanMessagesAndThreads(workspaceId: string) {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            this.assertWorkspaceScope(workspaceId, transactionScope);
            const messageThreadRepository =
              transactionScope.getRepository<MessageThreadWorkspaceEntity>(
                'messageThread',
                { shouldBypassPermissionChecks: true },
              );
            const messageRepository =
              transactionScope.getRepository<MessageWorkspaceEntity>(
                'message',
                { shouldBypassPermissionChecks: true },
              );
            const messageChannelMessageAssociationRepository =
              transactionScope.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
                'messageChannelMessageAssociation',
                { shouldBypassPermissionChecks: true },
              );

            await this.deleteOrphansByKeyset(
              async (cursor) => {
                const page = await messageRepository.find({
                  where: isDefined(cursor) ? { id: MoreThan(cursor) } : {},
                  order: { id: 'ASC' },
                  take: ORPHAN_CLEANUP_PAGE_SIZE,
                  select: { id: true },
                });

                return page.map(({ id }) => id);
              },
              async (ids) => {
                const messagesToDelete = await messageRepository.find({
                  where: { id: In(ids) },
                  select: { messageThreadId: true },
                });
                const candidateThreadIds = [
                  ...new Set(
                    messagesToDelete
                      .map(({ messageThreadId }) => messageThreadId)
                      .filter(isDefined),
                  ),
                ];

                await messageRepository.delete(ids);

                const survivingThreadIds = await this.findReferencedThreadIds(
                  messageRepository,
                  candidateThreadIds,
                );

                await this.participantTargetReconciliationService.reconcileMessageThreadTargets(
                  {
                    messageThreadIds: survivingThreadIds,
                    transactionScope,
                  },
                );
              },
              (pageIds) =>
                this.filterOrphans(pageIds, async (ids) => [
                  ...(await this.findReferencedMessageIds(
                    messageChannelMessageAssociationRepository,
                    ids,
                  )),
                  ...(await findOmniOwnedMessageIds(
                    transactionScope,
                    workspaceId,
                    ids,
                  )),
                ]),
            );

            await this.deleteOrphansByKeyset(
              async (cursor) => {
                const page = await messageThreadRepository.find({
                  where: isDefined(cursor) ? { id: MoreThan(cursor) } : {},
                  order: { id: 'ASC' },
                  take: ORPHAN_CLEANUP_PAGE_SIZE,
                  select: { id: true },
                });

                return page.map(({ id }) => id);
              },
              (ids) => messageThreadRepository.delete(ids),
              (pageIds) =>
                this.filterOrphans(pageIds, async (ids) => [
                  ...(await this.findReferencedThreadIds(
                    messageRepository,
                    ids,
                  )),
                  ...(await findOmniOwnedMessageThreadIds(
                    transactionScope,
                    workspaceId,
                    ids,
                  )),
                ]),
            );
          },
        );
      },
      authContext,
      { lite: true },
    );
  }

  private assertWorkspaceScope(
    workspaceId: string,
    transactionScope: { workspaceId: string },
  ): void {
    if (
      transactionScope.workspaceId !== workspaceId ||
      this.workspaceOrmManager.getWorkspaceId() !== workspaceId
    ) {
      throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
    }
  }

  private async findReferencedMessageIds(
    messageChannelMessageAssociationRepository: WorkspaceRepository<MessageChannelMessageAssociationWorkspaceEntity>,
    messageIds: string[],
  ): Promise<string[]> {
    const associations = await messageChannelMessageAssociationRepository.find({
      where: { messageId: In(messageIds) },
      select: { messageId: true },
    });

    return associations.map(({ messageId }) => messageId);
  }

  private async findReferencedThreadIds(
    messageRepository: WorkspaceRepository<MessageWorkspaceEntity>,
    threadIds: string[],
  ): Promise<string[]> {
    if (threadIds.length === 0) {
      return [];
    }

    const messages = await messageRepository.find({
      where: { messageThreadId: In(threadIds) },
      select: { messageThreadId: true },
    });

    return messages
      .map(({ messageThreadId }) => messageThreadId)
      .filter(isDefined);
  }

  private async filterOrphans(
    parentIds: string[],
    findReferencedParentIds: (parentIds: string[]) => Promise<string[]>,
  ): Promise<string[]> {
    if (parentIds.length === 0) {
      return [];
    }

    const referencedParentIds = new Set(
      await findReferencedParentIds(parentIds),
    );

    return parentIds.filter((parentId) => !referencedParentIds.has(parentId));
  }

  private async deleteOrphansByKeyset(
    fetchPageIds: (cursor: string | undefined) => Promise<string[]>,
    deleteByIds: (ids: string[]) => Promise<unknown>,
    findOrphanIds: (pageIds: string[]) => Promise<string[]>,
  ): Promise<void> {
    let cursor: string | undefined;

    for (;;) {
      const pageIds = await fetchPageIds(cursor);

      if (pageIds.length === 0) {
        break;
      }

      cursor = pageIds[pageIds.length - 1];

      const orphanIds = await findOrphanIds(pageIds);

      if (orphanIds.length > 0) {
        await deleteByIds(orphanIds);
      }
    }
  }
}
