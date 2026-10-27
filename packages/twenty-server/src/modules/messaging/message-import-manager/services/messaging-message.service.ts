import { Injectable, Logger } from '@nestjs/common';

import { isUUID } from 'class-validator';
import { isDefined } from 'twenty-shared/utils';
import { In } from 'typeorm';
import { v4 } from 'uuid';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type MessageThreadWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-thread.workspace-entity';
import { type MessageWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message.workspace-entity';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';

type MessageAccumulator = {
  existingMessageInDB?: MessageWorkspaceEntity;
  existingThreadInDB?: Pick<MessageThreadWorkspaceEntity, 'id'>;
  existingMessageChannelMessageAssociationInDB?: MessageChannelMessageAssociationWorkspaceEntity;
  messageToCreate?: Pick<
    MessageWorkspaceEntity,
    | 'id'
    | 'headerMessageId'
    | 'subject'
    | 'receivedAt'
    | 'text'
    | 'messageThreadId'
    | 'isDraft'
  >;
  threadToCreate?: Pick<MessageThreadWorkspaceEntity, 'id' | 'subject'>;
  messageChannelMessageAssociationToCreate?: Pick<
    MessageChannelMessageAssociationWorkspaceEntity,
    | 'id'
    | 'messageChannelId'
    | 'messageId'
    | 'messageExternalId'
    | 'messageThreadExternalId'
    | 'direction'
  >;
};

export type CanonicalMessageThreadOptions = {
  canonicalThreadIdByThreadExternalId: ReadonlyMap<string, string>;
};

@Injectable()
export class MessagingMessageService {
  private readonly logger = new Logger(MessagingMessageService.name);

  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  public async saveMessagesWithinTransaction(
    messages: MessageWithParticipants[],
    messageChannelId: string,
    transactionScope: WorkspaceTransactionScope,
    workspaceId: string,
    options?: CanonicalMessageThreadOptions,
  ): Promise<{
    createdMessages: Partial<MessageWorkspaceEntity>[];
    createdMessageThreadIds: string[];
    messageExternalIdsAndIdsMap: Map<string, string>;
    messageExternalIdToMessageChannelMessageAssociationIdMap: Map<
      string,
      string
    >;
    messageExternalIdToMessageThreadIdMap: Map<string, string>;
  }> {
    const canonicalThreadIds = options
      ? this.captureCanonicalThreadIds(
          messages,
          transactionScope,
          workspaceId,
          options,
        )
      : undefined;

    if (canonicalThreadIds) {
      messages = messages.map((message) => ({
        ...message,
        receivedAt: message.receivedAt ? new Date(message.receivedAt) : null,
      }));
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageChannelMessageAssociationRepository =
          transactionScope.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
            'messageChannelMessageAssociation',
            { shouldBypassPermissionChecks: true },
          );

        const messageRepository =
          transactionScope.getRepository<MessageWorkspaceEntity>('message', {
            shouldBypassPermissionChecks: true,
          });

        const messageThreadRepository =
          transactionScope.getRepository<MessageThreadWorkspaceEntity>(
            'messageThread',
            { shouldBypassPermissionChecks: true },
          );

        const messageAccumulatorMap = new Map<string, MessageAccumulator>();

        const existingMessagesInDB = await messageRepository.find({
          where: {
            headerMessageId: In(
              messages.map((message) => message.headerMessageId),
            ),
          },
          ...(canonicalThreadIds ? { withDeleted: true } : {}),
        });

        const messageChannelMessageAssociationsReferencingMessageThread =
          await messageChannelMessageAssociationRepository.find({
            where: {
              messageThreadExternalId: In(
                messages.map((message) => message.messageThreadExternalId),
              ),
              messageChannelId,
            },
            relations: { message: true },
            ...(canonicalThreadIds ? { withDeleted: true } : {}),
          });

        const existingMessageChannelMessageAssociations =
          await messageChannelMessageAssociationRepository.find({
            where: {
              messageId: In(existingMessagesInDB.map((message) => message.id)),
              messageChannelId,
            },
            ...(canonicalThreadIds ? { withDeleted: true } : {}),
          });

        const canonicalThreads = canonicalThreadIds
          ? await messageThreadRepository.find({
              where: { id: In([...canonicalThreadIds.values()]) },
              withDeleted: true,
            })
          : [];

        if (canonicalThreadIds) {
          this.assertCanonicalThreadReferences(
            messages,
            canonicalThreadIds,
            canonicalThreads,
            existingMessagesInDB,
            messageChannelMessageAssociationsReferencingMessageThread,
            existingMessageChannelMessageAssociations,
          );
        }

        const inheritableThreadAssociations = canonicalThreadIds
          ? messageChannelMessageAssociationsReferencingMessageThread.filter(
              (association) =>
                !isDefined(association.deletedAt) &&
                isDefined(association.message) &&
                !isDefined(association.message.deletedAt),
            )
          : messageChannelMessageAssociationsReferencingMessageThread;

        await this.enrichMessageAccumulatorWithExistingMessages(
          messages,
          messageAccumulatorMap,
          existingMessagesInDB,
          inheritableThreadAssociations,
        );

        await this.enrichMessageAccumulatorWithExistingMessageThreadIds(
          messages,
          messageAccumulatorMap,
          inheritableThreadAssociations,
          workspaceId,
        );

        await this.enrichMessageAccumulatorWithExistingMessageChannelMessageAssociations(
          messages,
          messageAccumulatorMap,
          [
            ...existingMessageChannelMessageAssociations,
            ...inheritableThreadAssociations,
          ],
        );

        await this.enrichMessageAccumulatorWithMessageThreadToCreate(
          messages,
          messageAccumulatorMap,
          canonicalThreadIds,
          new Set(canonicalThreads.map((thread) => thread.id)),
        );

        const associationToCreateByMessageId = new Map<
          string,
          NonNullable<
            MessageAccumulator['messageChannelMessageAssociationToCreate']
          >
        >();

        for (const message of messages) {
          const messageAccumulator = messageAccumulatorMap.get(
            message.externalId,
          );

          if (!isDefined(messageAccumulator)) {
            throw new Error(
              `Message accumulator should reference the message, this should never happen`,
            );
          }

          const messageThreadId =
            messageAccumulator.threadToCreate?.id ??
            messageAccumulator.existingThreadInDB?.id;

          if (!isDefined(messageThreadId)) {
            throw new Error(
              `Message thread id should be defined, either in the threadToCreate or existingThreadInDB`,
            );
          }

          let newOrExistingMessageId: string;

          if (!isDefined(messageAccumulator.existingMessageInDB)) {
            newOrExistingMessageId = v4();

            const messageToCreate = {
              id: newOrExistingMessageId,
              headerMessageId: message.headerMessageId,
              subject: message.subject,
              receivedAt: message.receivedAt,
              text: message.text,
              messageThreadId,
              isDraft: message.isDraft,
            };

            messageAccumulator.messageToCreate = messageToCreate;
          } else {
            newOrExistingMessageId = messageAccumulator.existingMessageInDB.id;
          }

          if (
            !isDefined(
              messageAccumulator.existingMessageChannelMessageAssociationInDB,
            )
          ) {
            const associationToCreate = associationToCreateByMessageId.get(
              newOrExistingMessageId,
            ) ?? {
              id: v4(),
              messageChannelId,
              messageId: newOrExistingMessageId,
              messageExternalId: message.externalId,
              messageThreadExternalId: message.messageThreadExternalId,
              direction: message.direction,
            };

            associationToCreateByMessageId.set(
              newOrExistingMessageId,
              associationToCreate,
            );

            messageAccumulator.messageChannelMessageAssociationToCreate =
              associationToCreate;
          }

          messageAccumulatorMap.set(message.externalId, messageAccumulator);
        }

        const messageThreadsToCreate = Array.from(
          messageAccumulatorMap.values(),
        )
          .map((accumulator) => accumulator.threadToCreate)
          .filter(isDefined);

        const threadSubjectUpdates = new Map<
          string,
          { subject: string; receivedAt: number }
        >();

        for (const message of messages) {
          const messageAccumulator = messageAccumulatorMap.get(
            message.externalId,
          );

          if (!isDefined(messageAccumulator)) {
            continue;
          }

          if (
            isDefined(messageAccumulator.existingThreadInDB) &&
            isDefined(messageAccumulator.messageToCreate) &&
            isDefined(message.subject)
          ) {
            const threadId = messageAccumulator.existingThreadInDB.id;
            const existing = threadSubjectUpdates.get(threadId);
            const receivedAt = message.receivedAt?.getTime() ?? 0;

            if (!isDefined(existing) || receivedAt > existing.receivedAt) {
              threadSubjectUpdates.set(threadId, {
                subject: message.subject,
                receivedAt,
              });
            }
          }
        }

        if (messageThreadsToCreate.length > 0) {
          await messageThreadRepository.insert(messageThreadsToCreate);
        }

        if (threadSubjectUpdates.size > 0) {
          await messageThreadRepository.upsert(
            Array.from(threadSubjectUpdates.entries()).map(
              ([id, { subject }]) => ({ id, subject }),
            ),
            ['id'],
          );
        }

        const messagesToCreate = Array.from(messageAccumulatorMap.values())
          .map((accumulator) => accumulator.messageToCreate)
          .filter(isDefined);

        await messageRepository.insert(messagesToCreate);

        const messageChannelMessageAssociationsToCreate = Array.from(
          associationToCreateByMessageId.values(),
        );

        await messageChannelMessageAssociationRepository.insert(
          messageChannelMessageAssociationsToCreate,
        );

        const messageExternalIdsAndIdsMap = new Map<string, string>();
        const messageExternalIdToMessageChannelMessageAssociationIdMap =
          new Map<string, string>();
        const messageExternalIdToMessageThreadIdMap = new Map<string, string>();

        for (const [
          externalId,
          accumulator,
        ] of messageAccumulatorMap.entries()) {
          if (isDefined(accumulator.messageToCreate)) {
            messageExternalIdsAndIdsMap.set(
              externalId,
              accumulator.messageToCreate.id,
            );
          }

          if (isDefined(accumulator.existingMessageInDB)) {
            messageExternalIdsAndIdsMap.set(
              externalId,
              accumulator.existingMessageInDB.id,
            );
          }

          const messageThreadId =
            accumulator.messageToCreate?.messageThreadId ??
            accumulator.existingMessageInDB?.messageThreadId;

          if (isDefined(messageThreadId)) {
            messageExternalIdToMessageThreadIdMap.set(
              externalId,
              messageThreadId,
            );
          }

          const createdAssociationId =
            accumulator.messageChannelMessageAssociationToCreate?.id;
          const existingAssociationId =
            accumulator.existingMessageChannelMessageAssociationInDB?.id;
          const associationId = createdAssociationId ?? existingAssociationId;

          if (isDefined(associationId)) {
            messageExternalIdToMessageChannelMessageAssociationIdMap.set(
              externalId,
              associationId,
            );
          }
        }

        return {
          createdMessages: messagesToCreate,
          createdMessageThreadIds: messageThreadsToCreate.map(({ id }) => id),
          messageExternalIdsAndIdsMap,
          messageExternalIdToMessageChannelMessageAssociationIdMap,
          messageExternalIdToMessageThreadIdMap,
        };
      },
      authContext,
      { lite: true },
    );
  }

  private captureCanonicalThreadIds(
    messages: MessageWithParticipants[],
    transactionScope: WorkspaceTransactionScope,
    workspaceId: string,
    options: CanonicalMessageThreadOptions,
  ): ReadonlyMap<string, string> {
    const lifecycle = transactionScope.transactionLifecycle;

    if (
      transactionScope.workspaceId !== workspaceId ||
      lifecycle?.commitOutcome !== 'strict' ||
      !lifecycle.isTransactionActive ||
      lifecycle.isReleased
    ) {
      throw new Error(
        'Canonical message threads require an active strict workspace transaction',
      );
    }

    const canonicalThreadIds = new Map(
      options.canonicalThreadIdByThreadExternalId,
    );
    const threadExternalIds = new Set(
      messages.map((message) => message.messageThreadExternalId),
    );
    const messageExternalIds = new Set(
      messages.map((message) => message.externalId),
    );
    const headerMessageIds = new Set(
      messages.map((message) => message.headerMessageId),
    );

    if (
      canonicalThreadIds.size !== threadExternalIds.size ||
      messageExternalIds.size !== messages.length ||
      headerMessageIds.size !== messages.length
    ) {
      throw new Error(
        'Canonical message thread mapping does not match the batch',
      );
    }

    for (const [externalId, threadId] of canonicalThreadIds) {
      if (!threadExternalIds.has(externalId) || !isUUID(threadId)) {
        throw new Error('Canonical message thread mapping is invalid');
      }

      canonicalThreadIds.set(externalId, threadId.toLowerCase());
    }

    if (new Set(canonicalThreadIds.values()).size !== canonicalThreadIds.size) {
      throw new Error(
        'Canonical message thread mapping must not merge external threads',
      );
    }

    return canonicalThreadIds;
  }

  private assertCanonicalThreadReferences(
    messages: MessageWithParticipants[],
    canonicalThreadIds: ReadonlyMap<string, string>,
    canonicalThreads: MessageThreadWorkspaceEntity[],
    existingMessages: MessageWorkspaceEntity[],
    threadAssociations: MessageChannelMessageAssociationWorkspaceEntity[],
    existingAssociations: MessageChannelMessageAssociationWorkspaceEntity[],
  ): void {
    if (canonicalThreads.some((thread) => isDefined(thread.deletedAt))) {
      throw new Error('Canonical message thread is deleted');
    }

    for (const message of messages) {
      const expectedThreadId = canonicalThreadIds.get(
        message.messageThreadExternalId,
      );
      const headerMatches = existingMessages.filter(
        (existing) => existing.headerMessageId === message.headerMessageId,
      );
      const externalMatches = threadAssociations.filter(
        (association) => association.messageExternalId === message.externalId,
      );
      const relatedAssociations = threadAssociations.filter(
        (association) =>
          association.messageThreadExternalId ===
            message.messageThreadExternalId &&
          !isDefined(association.deletedAt) &&
          isDefined(association.message) &&
          !isDefined(association.message.deletedAt),
      );

      if (
        headerMatches.length > 1 ||
        externalMatches.length > 1 ||
        headerMatches.some(
          (existing) =>
            isDefined(existing.deletedAt) ||
            existing.messageThreadId !== expectedThreadId,
        ) ||
        externalMatches.some(
          (association) =>
            isDefined(association.deletedAt) ||
            !association.message ||
            isDefined(association.message.deletedAt) ||
            association.message.headerMessageId !== message.headerMessageId ||
            association.direction !== message.direction,
        ) ||
        relatedAssociations.some(
          (association) =>
            association.message?.messageThreadId !== expectedThreadId,
        ) ||
        ((headerMatches.length > 0 || relatedAssociations.length > 0) &&
          !canonicalThreads.some((thread) => thread.id === expectedThreadId)) ||
        (headerMatches[0] &&
          externalMatches[0] &&
          headerMatches[0].id !== externalMatches[0].messageId)
      ) {
        throw new Error(
          'Canonical message thread conflicts with existing messages',
        );
      }

      const matchedIds = new Set([
        ...headerMatches.map((existing) => existing.id),
        ...externalMatches.map((association) => association.messageId),
      ]);

      if (
        existingAssociations.some(
          (association) =>
            matchedIds.has(association.messageId) &&
            (isDefined(association.deletedAt) ||
              association.messageThreadExternalId !==
                message.messageThreadExternalId ||
              association.messageExternalId !== message.externalId ||
              association.direction !== message.direction),
        )
      ) {
        throw new Error(
          'Canonical message thread conflicts with existing channel associations',
        );
      }
    }
  }

  private async enrichMessageAccumulatorWithExistingMessages(
    messages: MessageWithParticipants[],
    messageAccumulatorMap: Map<string, MessageAccumulator>,
    existingMessagesInDB: MessageWorkspaceEntity[],
    messageChannelMessageAssociationsReferencingMessageThread: Pick<
      MessageChannelMessageAssociationWorkspaceEntity,
      'messageExternalId' | 'message'
    >[],
  ) {
    for (const message of messages) {
      const messageWithSameExternalIdInChannel =
        messageChannelMessageAssociationsReferencingMessageThread.find(
          (association) => association.messageExternalId === message.externalId,
        )?.message;

      const messageWithSameHeaderMessageId = existingMessagesInDB.find(
        (existingMessage) =>
          existingMessage.headerMessageId === message.headerMessageId,
      );

      const existingMessage =
        messageWithSameExternalIdInChannel ?? messageWithSameHeaderMessageId;

      if (!isDefined(existingMessage)) {
        messageAccumulatorMap.set(message.externalId, {});
        continue;
      }

      messageAccumulatorMap.set(message.externalId, {
        existingMessageInDB: existingMessage,
      });
    }
  }

  private async enrichMessageAccumulatorWithExistingMessageThreadIds(
    messages: MessageWithParticipants[],
    messageAccumulatorMap: Map<string, MessageAccumulator>,
    messageChannelMessageAssociationsReferencingMessageThread: Pick<
      MessageChannelMessageAssociationWorkspaceEntity,
      'messageThreadExternalId' | 'message'
    >[],
    workspaceId: string,
  ) {
    for (const message of messages) {
      const messageAccumulator = messageAccumulatorMap.get(message.externalId);

      if (!isDefined(messageAccumulator)) {
        throw new Error(
          `Message accumulator should reference the message, this should never happen`,
        );
      }

      const messageChannelMessageAssociationReferencingMessageThread =
        messageChannelMessageAssociationsReferencingMessageThread.find(
          (association) =>
            association.messageThreadExternalId ===
            message.messageThreadExternalId,
        );

      const existingThreadIdInDBIfMessageIsExistingInDB =
        messageAccumulator.existingMessageInDB?.messageThreadId;
      const existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation =
        messageChannelMessageAssociationReferencingMessageThread?.message
          ?.messageThreadId;

      if (isDefined(existingThreadIdInDBIfMessageIsExistingInDB)) {
        messageAccumulator.existingThreadInDB = {
          id: existingThreadIdInDBIfMessageIsExistingInDB,
        };
      }

      if (
        isDefined(
          existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation,
        )
      ) {
        messageAccumulator.existingThreadInDB = {
          id: existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation,
        };
      }

      if (
        isDefined(existingThreadIdInDBIfMessageIsExistingInDB) &&
        isDefined(
          existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation,
        ) &&
        existingThreadIdInDBIfMessageIsExistingInDB !==
          existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation
      ) {
        this.logger.warn(
          `
          WorkspaceId: ${workspaceId} /
          Message ExternalId: ${message.externalId} /
          Message HeaderId: ${message.headerMessageId} /
          Message Thread ExternalId: ${message.messageThreadExternalId} /
          Message Thread Id in DB: ${existingThreadIdInDBIfMessageIsExistingInDB} /
          Message Thread Id in Message Channel Message Association: ${existingThreadIdInDBIfMessageIsReferencedInMessageChannelMessageAssociation} /
          Message Subject: ${message.subject} /
          Message Received At: ${message.receivedAt} /
          Thread inter channel detected`,
        );
      }

      messageAccumulatorMap.set(message.externalId, messageAccumulator);
    }
  }

  private async enrichMessageAccumulatorWithExistingMessageChannelMessageAssociations(
    messages: MessageWithParticipants[],
    messageAccumulatorMap: Map<string, MessageAccumulator>,
    existingMessageChannelMessageAssociations: MessageChannelMessageAssociationWorkspaceEntity[],
  ) {
    for (const message of messages) {
      const messageAccumulator = messageAccumulatorMap.get(message.externalId);

      if (!isDefined(messageAccumulator)) {
        throw new Error(
          `Message accumulator should reference the message, this should never happen`,
        );
      }

      const existingMessage = messageAccumulator.existingMessageInDB;

      if (!isDefined(existingMessage)) {
        continue;
      }

      const existingMessageChannelMessageAssociation =
        existingMessageChannelMessageAssociations.find(
          (association) => association.messageId === existingMessage.id,
        );

      if (existingMessageChannelMessageAssociation) {
        messageAccumulator.existingMessageChannelMessageAssociationInDB =
          existingMessageChannelMessageAssociation;
      }
    }
  }

  private async enrichMessageAccumulatorWithMessageThreadToCreate(
    messages: MessageWithParticipants[],
    messageAccumulatorMap: Map<string, MessageAccumulator>,
    canonicalThreadIds?: ReadonlyMap<string, string>,
    existingCanonicalThreadIds = new Set<string>(),
  ) {
    for (const [index, message] of messages.entries()) {
      const messageAccumulator = messageAccumulatorMap.get(message.externalId);

      if (!isDefined(messageAccumulator)) {
        throw new Error(
          `Message accumulator should reference the message, this should never happen`,
        );
      }

      const previousMessageWithSameThreadExternalId = messages.find(
        (otherMessage, otherMessageIndex) =>
          otherMessage.messageThreadExternalId ===
            message.messageThreadExternalId && otherMessageIndex < index,
      );

      let newOrExistingMessageThreadId: string | undefined;

      const expectedThreadId = canonicalThreadIds?.get(
        message.messageThreadExternalId,
      );

      if (
        expectedThreadId &&
        existingCanonicalThreadIds.has(expectedThreadId)
      ) {
        messageAccumulator.existingThreadInDB = { id: expectedThreadId };
      }

      if (isDefined(messageAccumulator.existingThreadInDB)) {
        newOrExistingMessageThreadId = messageAccumulator.existingThreadInDB.id;
      }

      if (isDefined(previousMessageWithSameThreadExternalId)) {
        const previousMessageAccumulator = messageAccumulatorMap.get(
          previousMessageWithSameThreadExternalId.externalId,
        );

        const previousMessageThreadId =
          previousMessageAccumulator?.threadToCreate?.id ??
          previousMessageAccumulator?.existingThreadInDB?.id;

        if (!isDefined(previousMessageThreadId)) {
          throw new Error(
            `Previous message should have a thread id, either in the messageToCreate or existingMessageInDB`,
          );
        }

        newOrExistingMessageThreadId = previousMessageThreadId;
        messageAccumulator.existingThreadInDB = {
          id: previousMessageThreadId,
        };
      }

      if (!isDefined(newOrExistingMessageThreadId)) {
        newOrExistingMessageThreadId = expectedThreadId ?? v4();

        messageAccumulator.threadToCreate = {
          id: newOrExistingMessageThreadId,
          subject: message.subject,
        };
      }

      messageAccumulatorMap.set(message.externalId, messageAccumulator);
    }
  }
}
