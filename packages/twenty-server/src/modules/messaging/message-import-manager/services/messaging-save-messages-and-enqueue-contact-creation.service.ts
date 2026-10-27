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
import { appendOmniBindingConfigWakeupFailure } from 'src/modules/omnichannel/services/append-omni-binding-config-wakeup-failure';
import { appendOmniHumanTextCommandFailure } from 'src/modules/omnichannel/services/append-omni-human-text-command-failure';
import { appendOmniHumanCommandLeaseFailure } from 'src/modules/omnichannel/services/append-omni-human-command-lease-failure';
import { appendOmniConnectorAcceptanceFailure } from 'src/modules/omnichannel/services/append-omni-connector-acceptance-failure';
import { appendOmniSentReceiptFailure } from 'src/modules/omnichannel/services/append-omni-sent-receipt-failure';
import { appendOmniSentApplyFailure } from 'src/modules/omnichannel/services/append-omni-sent-apply-failure';
import { appendOmniHumanCommandRecoveryFailure } from 'src/modules/omnichannel/services/append-omni-human-command-recovery-failure';
import {
  deferOmniHumanCommandReconciliation,
  discoverOmniHumanCommandRecovery,
  snapshotOmniHumanCommandDeferRequest,
  snapshotOmniHumanCommandDiscoveryRequest,
  type OmniHumanCommandDeferCallbacks,
  type OmniHumanCommandDiscoveryCallbacks,
} from 'src/modules/omnichannel/services/recover-omni-human-command';
import {
  type OmniHumanCommandRecoveryPrincipal,
  type OmniHumanCommandDeferInput,
  type OmniHumanCommandDeferResult,
  type OmniHumanCommandDiscoveryInput,
  type OmniHumanCommandDiscoveryResult,
} from 'src/modules/omnichannel/contracts/omni-human-command-recovery';
import {
  applyOmniSentReceipt,
  snapshotOmniSentApplyRequest,
  type OmniSentApplyPrincipal,
  type OmniSentApplyProof,
  type OmniSentApplyCallbacks,
  type OmniSentApplyResult,
} from 'src/modules/omnichannel/services/apply-omni-sent-receipt';
import {
  acceptOmniSentReceipt,
  claimOmniSentReceipt,
  snapshotOmniSentReceiptRequest,
  snapshotOmniSentReceiptClaimRequest,
  type OmniSentReceiptCallbacks,
} from 'src/modules/omnichannel/services/omni-sent-receipt';
import {
  type OmniSentReceiptPrincipal,
  type OmniSentReceiptInput,
  type OmniSentReceiptClaimInput,
  type OmniSentReceiptAcceptance,
  type OmniSentReceiptClaimResult,
} from 'src/modules/omnichannel/contracts/omni-sent-receipt';
import {
  applyOmniConnectorAcceptance,
  snapshotOmniConnectorAcceptanceRequest,
  type OmniConnectorAcceptanceCallbacks,
} from 'src/modules/omnichannel/services/apply-omni-connector-acceptance';
import {
  type OmniConnectorAcceptanceInput,
  type OmniConnectorAcceptancePrincipal,
  type OmniConnectorAcceptanceResult,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import {
  claimOmniHumanCommandLease,
  isOmniHumanCommandLeaseAuthorizationError,
  snapshotOmniHumanCommandLeaseRequest,
  type OmniHumanCommandLeaseCallbacks,
} from 'src/modules/omnichannel/services/claim-omni-human-command';
import {
  type OmniHumanCommandLeaseInput,
  type OmniHumanCommandLeasePrincipal,
  type OmniHumanCommandLeaseResult,
} from 'src/modules/omnichannel/contracts/omni-human-command-lease';
import {
  admitOmniHumanTextCommand,
  isOmniHumanTextCommandAuthorizationError,
  snapshotOmniHumanTextCommandRequest,
  type OmniHumanTextCommandAuthorizer,
} from 'src/modules/omnichannel/services/admit-omni-human-text-command';
import {
  type OmniHumanTextCommandInput,
  type OmniHumanTextCommandPrincipal,
  type OmniHumanTextCommandResult,
} from 'src/modules/omnichannel/contracts/omni-human-text-command';
import {
  claimOmniBindingConfigWakeups,
  housekeepOmniBindingConfigWakeups,
  processOmniBindingConfigWakeupPage,
  rearmOmniBindingConfigWakeup,
  reconcileOmniBindingConfigWakeups,
  snapshotOmniBindingConfigRecoveryRequest,
  type OmniBindingConfigRecoveryCommand,
  type OmniBindingConfigRecoveryResult,
  type OmniBindingConfigWakeupAuthorizer,
  type OmniBindingConfigWakeupPrincipal,
} from 'src/modules/omnichannel/services/omni-binding-config-wakeup';
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

  async deferOmniHumanCommandReconciliation(
    principal: OmniHumanCommandRecoveryPrincipal,
    input: OmniHumanCommandDeferInput,
    callbacks: OmniHumanCommandDeferCallbacks,
  ): Promise<OmniHumanCommandDeferResult> {
    const request = snapshotOmniHumanCommandDeferRequest(
      principal,
      input,
      callbacks,
    );
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return deferOmniHumanCommandReconciliation(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
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
                  appendOmniHumanCommandRecoveryFailure(
                    scope,
                    request.principal,
                    request.input,
                    attemptOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_HUMAN_COMMAND_RECOVERY_FAILURE_AUDIT_UNCONFIRMED',
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

  async discoverOmniHumanCommandRecovery(
    principal: OmniHumanCommandRecoveryPrincipal,
    input: OmniHumanCommandDiscoveryInput,
    callbacks: OmniHumanCommandDiscoveryCallbacks,
  ): Promise<OmniHumanCommandDiscoveryResult> {
    const request = snapshotOmniHumanCommandDiscoveryRequest(
      principal,
      input,
      callbacks,
    );
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          (scope) =>
            discoverOmniHumanCommandRecovery(
              scope,
              request.principal,
              request.input,
              request.callbacks,
            ),
          { commitOutcome: 'strict' },
        ),
      buildSystemAuthContext(request.principal.workspaceId),
      { lite: true },
    );
  }

  async applyOmniSentReceipt(
    principal: OmniSentApplyPrincipal,
    proof: OmniSentApplyProof,
    callbacks: OmniSentApplyCallbacks,
  ): Promise<OmniSentApplyResult> {
    const request = snapshotOmniSentApplyRequest(principal, proof, callbacks);
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              const nativeScope = withOmniRepositoryOptions(scope);
              return applyOmniSentReceipt(
                nativeScope,
                request.principal,
                request.proof,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
                  },
                },
                {
                  createInitialMessage: async (input) => {
                    if (input.workspaceId !== nativeScope.workspaceId)
                      throw new Error(
                        'OMNI_SENT_APPLY_NATIVE_WORKSPACE_MISMATCH',
                      );
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
                            direction: MessageDirection.OUTGOING,
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
                    )
                      throw new Error('OMNI_SENT_APPLY_NATIVE_MAPPING_MISSING');
                    if (
                      !result.createdMessages.some(
                        (message) => message.id === messageId,
                      )
                    )
                      throw new Error(
                        'OMNI_SENT_APPLY_NATIVE_MESSAGE_CREATION_POSTCONDITION',
                      );
                    if (result.createdMessageThreadIds.length !== 0)
                      throw new Error(
                        'OMNI_SENT_APPLY_NATIVE_THREAD_CREATION_POSTCONDITION',
                      );
                    const saved =
                      await this.messageParticipantService.saveMessageParticipants(
                        [
                          {
                            messageId,
                            personId: null,
                            workspaceMemberId: input.workspaceMemberId,
                            handle: null,
                            displayName: null,
                            role: MessageParticipantRole.FROM,
                          },
                        ],
                        input.workspaceId,
                        nativeScope,
                      );
                    if (saved.length !== 1 || saved[0].messageId !== messageId)
                      throw new Error(
                        'OMNI_SENT_APPLY_NATIVE_PARTICIPANT_MISSING',
                      );
                    return {
                      messageId,
                      associationId,
                      participantId: saved[0].id,
                      createdThread: false,
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
                  appendOmniSentApplyFailure(
                    scope,
                    request.principal,
                    request.proof,
                    attemptOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_SENT_APPLY_FAILURE_AUDIT_UNCONFIRMED',
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

  async acceptOmniSentReceipt(
    principal: OmniSentReceiptPrincipal,
    input: OmniSentReceiptInput,
    callbacks: OmniSentReceiptCallbacks,
  ): Promise<OmniSentReceiptAcceptance> {
    const request = snapshotOmniSentReceiptRequest(principal, input, callbacks);
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return acceptOmniSentReceipt(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
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
                  appendOmniSentReceiptFailure(
                    scope,
                    request.principal,
                    {
                      operation: 'accept',
                      resourceId: request.input.envelope.commandId,
                    },
                    attemptOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_SENT_RECEIPT_FAILURE_AUDIT_UNCONFIRMED',
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

  async claimOmniSentReceipt(
    principal: OmniSentReceiptPrincipal,
    input: OmniSentReceiptClaimInput,
    callbacks: OmniSentReceiptCallbacks,
  ): Promise<OmniSentReceiptClaimResult> {
    const request = snapshotOmniSentReceiptClaimRequest(
      principal,
      input,
      callbacks,
    );
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return claimOmniSentReceipt(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
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
                  appendOmniSentReceiptFailure(
                    scope,
                    request.principal,
                    { operation: 'claim', resourceId: request.input.receiptId },
                    attemptOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_SENT_RECEIPT_FAILURE_AUDIT_UNCONFIRMED',
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

  async applyOmniConnectorAcceptance(
    principal: OmniConnectorAcceptancePrincipal,
    input: OmniConnectorAcceptanceInput,
    callbacks: OmniConnectorAcceptanceCallbacks,
  ): Promise<OmniConnectorAcceptanceResult> {
    const request = snapshotOmniConnectorAcceptanceRequest(
      principal,
      input,
      callbacks,
    );
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return applyOmniConnectorAcceptance(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
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
                  appendOmniConnectorAcceptanceFailure(
                    scope,
                    request.principal,
                    request.input,
                    attemptOperationId,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_CONNECTOR_ACCEPTANCE_FAILURE_AUDIT_UNCONFIRMED',
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

  async claimOmniHumanCommandLease(
    principal: OmniHumanCommandLeasePrincipal,
    input: OmniHumanCommandLeaseInput,
    callbacks: OmniHumanCommandLeaseCallbacks,
  ): Promise<OmniHumanCommandLeaseResult> {
    const request = snapshotOmniHumanCommandLeaseRequest(
      principal,
      input,
      callbacks,
    );
    const attemptOperationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return claimOmniHumanCommandLease(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorize: async (...args) => {
                    try {
                      return await request.callbacks.authorize(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
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
                  appendOmniHumanCommandLeaseFailure(
                    scope,
                    request.principal,
                    request.input,
                    attemptOperationId,
                    authorizationDenied ||
                      isOmniHumanCommandLeaseAuthorizationError(error),
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_HUMAN_COMMAND_LEASE_FAILURE_AUDIT_UNCONFIRMED',
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

  async admitOmniHumanTextCommand(
    principal: OmniHumanTextCommandPrincipal,
    input: OmniHumanTextCommandInput,
    authorize: OmniHumanTextCommandAuthorizer,
  ): Promise<OmniHumanTextCommandResult> {
    const request = snapshotOmniHumanTextCommandRequest(
      principal,
      input,
      authorize,
    );
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              callbackEntered = true;
              return admitOmniHumanTextCommand(
                scope,
                request.principal,
                request.input,
                async (authorizationScope, descriptor) => {
                  try {
                    await request.authorize(authorizationScope, descriptor);
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
                  appendOmniHumanTextCommandFailure(
                    scope,
                    request.principal,
                    request.input,
                    authorizationDenied ||
                      isOmniHumanTextCommandAuthorizationError(error),
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_HUMAN_COMMAND_FAILURE_AUDIT_UNCONFIRMED',
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

  async executeOmniBindingConfigRecovery(
    principal: OmniBindingConfigWakeupPrincipal,
    command: OmniBindingConfigRecoveryCommand,
    authorize: OmniBindingConfigWakeupAuthorizer,
    authorizeResume?: OmniBlockedHistoryResumeAuthorizer,
  ): Promise<OmniBindingConfigRecoveryResult> {
    const request = snapshotOmniBindingConfigRecoveryRequest(
      principal,
      command,
      authorize,
      authorizeResume,
    );
    const failureOperationId = randomUUID();

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        const currentAuthorize: OmniBindingConfigWakeupAuthorizer = async (
          scope,
          descriptor,
        ) => {
          try {
            await request.authorize(scope, descriptor);
          } catch (error) {
            authorizationDenied = true;
            throw error;
          }
        };
        const resumeAuthorize = request.authorizeResume;
        const currentResumeAuthorize: OmniBlockedHistoryResumeAuthorizer =
          async (scope, descriptor) => {
            if (!resumeAuthorize)
              throw new Error('OMNI_CONFIG_WAKEUP_RESUME_AUTHORIZER_REQUIRED');
            try {
              await resumeAuthorize(scope, descriptor);
            } catch (error) {
              authorizationDenied = true;
              throw error;
            }
          };

        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction<OmniBindingConfigRecoveryResult>(
            async (scope) => {
              callbackEntered = true;
              const operation = request.command;
              switch (operation.operation) {
                case 'claim':
                  return {
                    operation: 'claim',
                    result: await claimOmniBindingConfigWakeups(
                      scope,
                      request.principal,
                      operation.input,
                      currentAuthorize,
                    ),
                  };
                case 'process':
                  return {
                    operation: 'process',
                    result: await processOmniBindingConfigWakeupPage(
                      scope,
                      request.principal,
                      operation.proof,
                      operation.input,
                      currentAuthorize,
                      currentResumeAuthorize,
                    ),
                  };
                case 'reconcile':
                  return {
                    operation: 'reconcile',
                    result: await reconcileOmniBindingConfigWakeups(
                      scope,
                      request.principal,
                      operation.input,
                      currentAuthorize,
                    ),
                  };
                case 'rearm':
                  return {
                    operation: 'rearm',
                    result: await rearmOmniBindingConfigWakeup(
                      scope,
                      request.principal,
                      operation.wakeupId,
                      currentAuthorize,
                    ),
                  };
                case 'housekeeping':
                  return {
                    operation: 'housekeeping',
                    result: await housekeepOmniBindingConfigWakeups(
                      scope,
                      request.principal,
                      currentAuthorize,
                    ),
                  };
              }
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
                  appendOmniBindingConfigWakeupFailure(
                    scope,
                    request.principal,
                    failureOperationId,
                    request.command.operation,
                    authorizationDenied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_CONFIG_WAKEUP_FAILURE_AUDIT_UNCONFIRMED',
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
