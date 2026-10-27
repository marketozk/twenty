import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import {
  FieldActorSource,
  MessageChannelContactAutoCreationPolicy,
  MessageChannelType,
  MessageParticipantRole,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import {
  CreateCompanyAndContactJob,
  type CreateCompanyAndContactJobData,
} from 'src/modules/contact-creation-manager/jobs/create-company-and-contact.job';
import {
  type Participant,
  type ParticipantWithMessageId,
} from 'src/modules/messaging/message-import-manager/drivers/gmail/types/gmail-message.type';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { type MessageChannelMessageAssociationFolderAssociation } from 'src/modules/messaging/message-import-manager/types/message-channel-message-association-folder-association.type';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';
import { isGroupEmail } from 'src/modules/messaging/message-import-manager/utils/is-group-email';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { isWorkEmail } from 'src/utils/is-work-email';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import {
  applyOmniHistoryReceipt,
  snapshotOmniHistoryReceiptRequest,
  type OmniHistoryApplyAuthorizer,
  type OmniHistoryApplyPrincipal,
  type OmniHistoryApplyProof,
  type OmniHistoryApplyResult,
} from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { appendOmniHistoryApplyFailure } from 'src/modules/omnichannel/services/append-omni-history-apply-failure';
import { isOmniHistoryMissingConfigurationError } from 'src/modules/omnichannel/services/omni-history-missing-configuration.error';
import { appendOmniHistoryResumeFailure } from 'src/modules/omnichannel/services/append-omni-history-resume-failure';
import {
  resumeOmniBlockedHistoryReceipts,
  snapshotOmniBlockedHistoryResumeRequest,
  type OmniBlockedHistoryResumePrincipal,
  type OmniBlockedHistoryResumeInput,
  type OmniBlockedHistoryResumeAuthorizer,
  type OmniBlockedHistoryResumeResult,
} from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';
import {
  deferOmniIncomingReceipt,
  type OmniIncomingReceiptLeaseAuthorizer,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';

export type OmniHistoryProcessResult =
  | OmniHistoryApplyResult
  | Readonly<{
      receiptId: string;
      state: 'blocked_config';
      errorCode: 'configuration_missing';
      nextAttemptAt: string;
    }>;

@Injectable()
export class MessagingSaveMessagesAndEnqueueContactCreationService {
  constructor(
    @InjectMessageQueue(MessageQueue.contactCreationQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly messageService: MessagingMessageService,
    private readonly messageParticipantService: MessagingMessageParticipantService,
    private readonly messageFolderAssociationService: MessagingMessageFolderAssociationService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async resumeOmniBlockedHistoryReceipts(
    principal: OmniBlockedHistoryResumePrincipal,
    input: OmniBlockedHistoryResumeInput,
    authorize: OmniBlockedHistoryResumeAuthorizer,
  ): Promise<OmniBlockedHistoryResumeResult> {
    const request = snapshotOmniBlockedHistoryResumeRequest(
      principal,
      input,
      authorize,
    );
    const failureOperationId = randomUUID();

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;

        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;

              return resumeOmniBlockedHistoryReceipts(
                scope,
                request.principal,
                request.input,
                async (authorizationScope, authorization) => {
                  try {
                    await request.authorize(authorizationScope, authorization);
                  } catch (error) {
                    authorizationDenied = true;
                    throw error;
                  }
                },
              );
            },
            { commitOutcome: 'strict' },
          );
        } catch (error) {
          if (
            callbackEntered &&
            !(error instanceof NativeTransactionOutcomeUnknownError)
          ) {
            try {
              await this.workspaceOrmManager.runInWorkspaceTransaction(
                (scope) =>
                  appendOmniHistoryResumeFailure(
                    scope,
                    request.principal,
                    failureOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_HISTORY_RESUME_FAILURE_AUDIT_UNCONFIRMED',
              );
            }
          }
          throw error;
        }
      },
      buildSystemAuthContext(request.principal.workspaceId),
      { lite: true },
    );
  }

  async processOmniHistoryReceipt(
    principal: OmniHistoryApplyPrincipal,
    proof: OmniHistoryApplyProof,
    authorizeHistory: OmniHistoryApplyAuthorizer,
    authorizeLease: OmniIncomingReceiptLeaseAuthorizer,
  ): Promise<OmniHistoryProcessResult> {
    const request = snapshotOmniHistoryReceiptRequest(
      principal,
      proof,
      authorizeHistory,
    );
    const leaseAuthorizer = authorizeLease;

    if (typeof leaseAuthorizer !== 'function') {
      throw new Error('OMNI_HISTORY_LEASE_AUTHORIZER_REQUIRED');
    }

    const leaseProof = Object.freeze({
      receiptId: request.proof.receiptId,
      leaseOwner: request.proof.leaseOwner,
      leaseToken: request.proof.leaseToken,
      routeGeneration: request.proof.routeGeneration,
    });
    let historyAuthorizationDenied = false;

    try {
      return await this.applyOmniHistoryReceipt(
        request.principal,
        request.proof,
        async (scope, authorization) => {
          try {
            await request.authorize(scope, authorization);
          } catch (error) {
            historyAuthorizationDenied = true;
            throw error;
          }
        },
      );
    } catch (error) {
      // The strict apply boundary propagates this issued error only after confirmed
      // rollback. Unknown transaction outcomes and failed audit cleanup stay errors.
      if (
        historyAuthorizationDenied ||
        !isOmniHistoryMissingConfigurationError(error)
      ) {
        throw error;
      }

      const deferred = await deferOmniIncomingReceipt(
        this.dataSource,
        request.principal,
        leaseProof,
        { state: 'blocked_config', errorCode: 'configuration_missing' },
        leaseAuthorizer,
      );

      if (
        deferred.receiptId !== leaseProof.receiptId ||
        deferred.state !== 'blocked_config' ||
        deferred.errorCode !== 'configuration_missing'
      ) {
        throw new Error('OMNI_HISTORY_CONFIG_DEFER_POSTCONDITION');
      }

      return Object.freeze({
        receiptId: deferred.receiptId,
        state: 'blocked_config',
        errorCode: 'configuration_missing',
        nextAttemptAt: deferred.nextAttemptAt,
      });
    }
  }

  async applyOmniHistoryReceipt(
    principal: OmniHistoryApplyPrincipal,
    proof: OmniHistoryApplyProof,
    authorize: OmniHistoryApplyAuthorizer,
  ): Promise<OmniHistoryApplyResult> {
    const request = snapshotOmniHistoryReceiptRequest(
      principal,
      proof,
      authorize,
    );

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (transactionScope) => {
              callbackEntered = true;
              const nativeScope = withOmniRepositoryOptions(transactionScope);

              return applyOmniHistoryReceipt(
                nativeScope,
                request.principal,
                request.proof,
                async (scope, authorization) => {
                  try {
                    await request.authorize(scope, authorization);
                  } catch (error) {
                    authorizationDenied = true;
                    throw error;
                  }
                },
                {
                  createInitialMessage: async (input) => {
                    if (input.workspaceId !== nativeScope.workspaceId) {
                      throw new Error('OMNI_HISTORY_NATIVE_WORKSPACE_MISMATCH');
                    }
                    const result =
                      await this.messageService.saveMessagesWithinTransaction(
                        [
                          {
                            externalId: input.messageExternalId,
                            messageThreadExternalId:
                              input.messageThreadExternalId,
                            headerMessageId: input.headerMessageId,
                            subject: input.subject,
                            text: input.text,
                            receivedAt: new Date(input.receivedAt),
                            isDraft: false,
                            direction: MessageDirection.INCOMING,
                            attachments: [],
                            participants: [],
                          },
                        ],
                        input.messageChannelId,
                        nativeScope,
                        input.workspaceId,
                        {
                          canonicalThreadIdByThreadExternalId: new Map([
                            [
                              input.messageThreadExternalId,
                              input.messageThreadId,
                            ],
                          ]),
                        },
                      );
                    const messageId = result.messageExternalIdsAndIdsMap.get(
                      input.messageExternalId,
                    );
                    const associationId =
                      result.messageExternalIdToMessageChannelMessageAssociationIdMap.get(
                        input.messageExternalId,
                      );

                    if (
                      !messageId ||
                      !associationId ||
                      result.messageExternalIdToMessageThreadIdMap.get(
                        input.messageExternalId,
                      ) !== input.messageThreadId
                    ) {
                      throw new Error('OMNI_HISTORY_NATIVE_MAPPING_MISSING');
                    }
                    if (
                      !result.createdMessages.some(
                        (message) => message.id === messageId,
                      )
                    ) {
                      throw new Error(
                        'OMNI_HISTORY_NATIVE_MESSAGE_CREATION_POSTCONDITION',
                      );
                    }
                    const saved =
                      await this.messageParticipantService.saveMessageParticipants(
                        [
                          {
                            messageId,
                            personId: input.personId,
                            workspaceMemberId: null,
                            handle: input.participantHandle,
                            displayName: input.participantDisplayName,
                            role: MessageParticipantRole.FROM,
                          },
                        ],
                        input.workspaceId,
                        nativeScope,
                      );

                    if (
                      saved.length !== 1 ||
                      saved[0].messageId !== messageId
                    ) {
                      throw new Error(
                        'OMNI_HISTORY_NATIVE_PARTICIPANT_MISSING',
                      );
                    }

                    return {
                      messageId,
                      associationId,
                      participantId: saved[0].id,
                      createdThread: result.createdMessageThreadIds.includes(
                        input.messageThreadId,
                      ),
                    };
                  },
                },
              );
            },
            { commitOutcome: 'strict' },
          );
        } catch (error) {
          if (
            callbackEntered &&
            !(error instanceof NativeTransactionOutcomeUnknownError)
          ) {
            try {
              await this.workspaceOrmManager.runInWorkspaceTransaction(
                (scope) =>
                  appendOmniHistoryApplyFailure(
                    scope,
                    request.principal,
                    request.proof,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_HISTORY_FAILURE_AUDIT_UNCONFIRMED',
              );
            }
          }
          throw error;
        }
      },
      buildSystemAuthContext(request.principal.workspaceId),
      { lite: true },
    );
  }

  async saveMessagesAndEnqueueContactCreation(
    messagesToSave: MessageWithParticipants[],
    messageChannel: MessageChannelEntity,
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
  ): Promise<
    | {
        messageExternalIdsAndIdsMap: Map<string, string>;
        messageExternalIdToMessageThreadIdMap: Map<string, string>;
      }
    | undefined
  > {
    const handleAliases = connectedAccount.handleAliases || [];
    const authContext = buildSystemAuthContext(workspaceId);

    const savedMessagesResult =
      await this.workspaceOrmManager.executeInWorkspaceContext(
        async () => {
          return this.workspaceOrmManager.runInWorkspaceTransaction(
            async (transactionScope) => {
              const {
                messageExternalIdsAndIdsMap,
                messageExternalIdToMessageChannelMessageAssociationIdMap,
                messageExternalIdToMessageThreadIdMap,
              } = await this.messageService.saveMessagesWithinTransaction(
                messagesToSave,
                messageChannel.id,
                transactionScope,
                workspaceId,
              );

              const participantsWithMessageId: (ParticipantWithMessageId & {
                shouldCreateContact: boolean;
              })[] = messagesToSave.flatMap((message) => {
                const messageId = messageExternalIdsAndIdsMap.get(
                  message.externalId,
                );

                return messageId
                  ? message.participants.map((participant: Participant) => {
                      const fromHandle =
                        message.participants.find(
                          (p) => p.role === MessageParticipantRole.FROM,
                        )?.handle || '';

                      const isMessageSentByConnectedAccount =
                        handleAliases.includes(fromHandle) ||
                        fromHandle === connectedAccount.handle;

                      const isParticipantConnectedAccount =
                        handleAliases.includes(participant.handle) ||
                        participant.handle === connectedAccount.handle;

                      const isExcludedByNonProfessionalEmails =
                        messageChannel.excludeNonProfessionalEmails &&
                        !isWorkEmail(participant.handle);

                      const isExcludedByGroupEmails =
                        messageChannel.excludeGroupEmails &&
                        isGroupEmail(participant.handle);

                      // Drafts are outgoing, so recipients of an unsent email don't become contacts
                      const shouldCreateContact =
                        !message.isDraft &&
                        !!participant.handle &&
                        !isParticipantConnectedAccount &&
                        !isExcludedByNonProfessionalEmails &&
                        !isExcludedByGroupEmails &&
                        (messageChannel.contactAutoCreationPolicy ===
                          MessageChannelContactAutoCreationPolicy.SENT_AND_RECEIVED ||
                          (messageChannel.contactAutoCreationPolicy ===
                            MessageChannelContactAutoCreationPolicy.SENT &&
                            isMessageSentByConnectedAccount));

                      return {
                        ...participant,
                        messageId,
                        shouldCreateContact,
                      };
                    })
                  : [];
              });

              const savedMessageParticipants =
                await this.messageParticipantService.saveMessageParticipants(
                  participantsWithMessageId,
                  workspaceId,
                  transactionScope,
                );

              const folderAssociations: MessageChannelMessageAssociationFolderAssociation[] =
                messagesToSave.flatMap((message) => {
                  const messageFolderIds = message.messageFolderIds ?? [];

                  if (messageFolderIds.length === 0) {
                    return [];
                  }

                  const associationId =
                    messageExternalIdToMessageChannelMessageAssociationIdMap.get(
                      message.externalId,
                    );

                  if (!isDefined(associationId)) {
                    return [];
                  }

                  return [
                    {
                      messageChannelMessageAssociationId: associationId,
                      messageFolderIds,
                    },
                  ];
                });

              await this.messageFolderAssociationService.saveMessageFolderAssociations(
                folderAssociations,
                workspaceId,
                transactionScope,
              );

              return {
                participantsWithMessageId,
                savedMessageParticipants,
                messageExternalIdsAndIdsMap,
                messageExternalIdToMessageThreadIdMap,
              };
            },
          );
        },
        authContext,
        { lite: true },
      );

    if (messageChannel.isContactAutoCreationEnabled && savedMessagesResult) {
      const contactsToCreate =
        savedMessagesResult.participantsWithMessageId.filter(
          (participant) => participant.shouldCreateContact,
        );

      await this.messageQueueService.add<CreateCompanyAndContactJobData>(
        CreateCompanyAndContactJob.name,
        {
          workspaceId,
          connectedAccount,
          contactsToCreate,
          source: FieldActorSource.EMAIL,
        },
      );
    }

    if (!isDefined(savedMessagesResult)) {
      return undefined;
    }

    const messageIds = [
      ...new Set(
        savedMessagesResult.participantsWithMessageId.map(
          ({ messageId }) => messageId,
        ),
      ),
    ];

    // Matching non-email handles as emails would null out caller-supplied identities, so those channels only reconcile targets
    await this.messageParticipantService.matchMessageParticipants({
      participants: savedMessagesResult.savedMessageParticipants,
      messageIds,
      workspaceId,
      matchWith:
        messageChannel.type === MessageChannelType.APP
          ? 'targetsOnly'
          : 'workspaceMemberAndPerson',
    });

    return {
      messageExternalIdsAndIdsMap:
        savedMessagesResult.messageExternalIdsAndIdsMap,
      messageExternalIdToMessageThreadIdMap:
        savedMessagesResult.messageExternalIdToMessageThreadIdMap,
    };
  }
}
