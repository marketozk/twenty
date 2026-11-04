import { withOmniDetachedParentDelete } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import {
  buildMessageImportMatchingPages,
  captureMessageImportMatchingContext,
  captureMessageImportMatchingManifest,
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
  type MessageImportMatchingContext,
  type MessageImportMatchingIntentPayload,
  type MessageImportMatchingManifest,
} from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { captureMessageImportAuthorityProof } from 'src/engine/core-modules/crm-audit/message-import-authority-proof';
import {
  MESSAGE_SAVE_TABLES,
  MESSAGE_SAVE_WRITE_TABLES,
  messageSaveActualIds,
  messageSaveColumns,
  messageSaveTableSql,
  quoteMessageSaveIdentifier,
  type MessageSaveSnapshot,
  type MessageSaveTable,
  type MessageSaveWriteTable,
} from 'src/engine/core-modules/crm-audit/message-save-proof';
import { castCalendarProofImage } from 'src/engine/core-modules/crm-audit/calendar-target-proof';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  assertNativeCrmDeleteFilesEmpty,
  captureNativeCrmAuditSnapshot,
  captureNativeCrmAuditWriteData,
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { isUUID } from 'class-validator';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  destroyOmniCrmParent,
  snapshotOmniParentDestroyRequest,
  appendOmniParentDestroyFailure,
  type OmniParentDestroyPrincipal,
  type OmniParentDestroyCommand,
  type OmniParentDestroyAuthorizer,
} from 'src/modules/omnichannel/services/destroy-omni-crm-parent';
import {
  setOmniConversationTarget,
  snapshotOmniConversationTargetRequest,
  appendOmniConversationTargetFailure,
  type OmniConversationTargetPrincipal,
  type OmniConversationTargetCommand,
  type OmniConversationTargetAuthorizer,
} from 'src/modules/omnichannel/services/set-omni-conversation-target';
import {
  type OmniIncomingRevisionAdapter,
  snapshotOmniIncomingRevisionAdapter,
} from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
import { isOmniIncomingRevisionConflict } from 'src/modules/omnichannel/services/omni-incoming-revision-conflict.error';
import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import {
  type OmniLocalCommandCancellationPrincipal,
  type OmniLocalCommandCancellationInput,
  type OmniLocalCommandCancellationResult,
} from 'src/modules/omnichannel/contracts/omni-local-command-cancellation';
import {
  cancelOmniLocalHumanCommand,
  snapshotOmniLocalCommandCancellationRequest,
  isOmniLocalCommandCancellationAuthorizationError,
  type OmniLocalCommandCancellationCallbacks,
} from 'src/modules/omnichannel/services/cancel-omni-local-human-command';
import { appendOmniLocalCommandCancellationFailure } from 'src/modules/omnichannel/services/append-omni-local-command-cancellation-failure';
import { randomUUID } from 'node:crypto';
import {
  setOmniIdentityPerson,
  snapshotOmniIdentityCreatePersonRequest,
  type OmniIdentityCreatePersonCommand,
  type OmniIdentityCreatePersonAuthorizer,
  type OmniIdentityPersonRequest,
  snapshotOmniIdentityPersonRequest,
  appendOmniIdentityPersonFailure,
  type OmniIdentityPersonPrincipal,
  type OmniIdentityPersonCommand,
  type OmniIdentityPersonAuthorizer,
} from 'src/modules/omnichannel/services/set-omni-identity-person';

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
  applyOmniIncomingTextReceipt,
  type OmniIncomingTextApplyResult,
  type OmniIncomingAutoCreatePersonAuthorizer,
  OMNI_AUTO_PERSON_ACTOR_ID,
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

type MessageSaveScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];

type MessageSaveSourceTable = 'person' | 'workspaceMember';

type MessageSaveAuditState = {
  scope: MessageSaveScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<MessageSaveTable, NativeCrmAuditTableShape>;
  sourceShapes: Map<MessageSaveSourceTable, NativeCrmAuditTableShape>;
  before: Map<MessageSaveTable, MessageSaveSnapshot[]>;
  expected: Map<MessageSaveTable, MessageSaveSnapshot[]>;
  originalIds: Map<MessageSaveTable, string[]>;
  rootThreadIds: string[];
  headerMessageIds: string[];
  externalIds: string[];
  threadExternalIds: string[];
  channelId: string;
  validators: (() => Promise<void>)[];
};

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

  async destroyOmniCrmParent(
    principal: OmniParentDestroyPrincipal,
    command: OmniParentDestroyCommand,
    authorize: OmniParentDestroyAuthorizer,
  ) {
    const request = snapshotOmniParentDestroyRequest(
      principal,
      command,
      authorize,
    );
    const operationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const metadata =
          this.workspaceOrmManager.getOmniConversationTargetMetadata(
            request.command.objectMetadataId,
          );
        if (
          !metadata ||
          metadata.workspaceId !== request.principal.workspaceId ||
          !metadata.isActive ||
          metadata.isSystem ||
          !['targetPersonId', 'targetCompanyId'].includes(
            metadata.projectionField ?? '',
          )
        )
          throw new Error('OMNI_PARENT_DESTROY_METADATA_SCOPE');
        const name =
          metadata.projectionField === 'targetPersonId' ? 'person' : 'company';
        let entered = false,
          denied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              entered = true;
              const identity = this.identityPersonNativePort(scope);
              return destroyOmniCrmParent(
                scope,
                {
                  ...request,
                  authorize: async (...args) => {
                    try {
                      await request.authorize(...args);
                    } catch (error) {
                      denied = true;
                      throw error;
                    }
                  },
                },
                { ...metadata, isActive: true, isSystem: false },
                operationId,
                {
                  identity,
                  target: {
                    insertProjection: async () => {
                      throw new Error(
                        'OMNI_PARENT_DESTROY_CANNOT_INSERT_TARGET',
                      );
                    },
                    deleteProjection: identity.deleteProjection,
                  },
                  deleteParent: async (manifest) => {
                    const repository = scope.getRepository(
                      name,
                      { shouldBypassPermissionChecks: true },
                      { shouldSkipEventEmission: true },
                    );
                    await withOmniDetachedParentDelete(
                      scope,
                      repository,
                      manifest,
                      async () => {
                        const result = await repository.delete({
                          id: manifest.recordId,
                        });
                        if (result.affected !== 1)
                          throw new Error('OMNI_PARENT_DESTROY_NATIVE_DELETE');
                      },
                    );
                  },
                },
              );
            },
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
          );
        } catch (error) {
          if (
            entered &&
            !(error instanceof NativeTransactionOutcomeUnknownError)
          ) {
            try {
              await this.workspaceOrmManager.runInWorkspaceTransaction(
                (scope) =>
                  appendOmniParentDestroyFailure(
                    scope,
                    request,
                    name,
                    operationId,
                    denied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_PARENT_DESTROY_FAILURE_AUDIT_UNCONFIRMED',
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

  async setOmniConversationTarget(
    principal: OmniConversationTargetPrincipal,
    command: OmniConversationTargetCommand,
    authorize: OmniConversationTargetAuthorizer,
  ) {
    const request = snapshotOmniConversationTargetRequest(
      principal,
      command,
      authorize,
    );
    const operationId = randomUUID(),
      candidateTargetId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const metadata =
          this.workspaceOrmManager.getOmniConversationTargetMetadata(
            request.command.objectMetadataId,
          );
        if (
          !metadata ||
          metadata.workspaceId !== request.principal.workspaceId ||
          !metadata.isActive ||
          metadata.isSystem
        )
          throw new Error('OMNI_CONVERSATION_TARGET_METADATA_SCOPE');
        let entered = false,
          denied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              entered = true;
              return setOmniConversationTarget(
                scope,
                {
                  ...request,
                  authorize: async (...args) => {
                    try {
                      await request.authorize(...args);
                    } catch (error) {
                      denied = true;
                      throw error;
                    }
                  },
                },
                { ...metadata, isActive: true, isSystem: false },
                operationId,
                candidateTargetId,
                {
                  insertProjection: async (projection) => {
                    await withOmniRepositoryOptions(scope)
                      .getRepository('messageThreadTarget', {
                        shouldBypassPermissionChecks: true,
                      })
                      .insert(projection);
                  },
                  deleteProjection: async (id) => {
                    const result = await withOmniRepositoryOptions(scope)
                      .getRepository('messageThreadTarget', {
                        shouldBypassPermissionChecks: true,
                      })
                      .delete({ id });
                    if (result.affected !== 1)
                      throw new Error(
                        'OMNI_CONVERSATION_TARGET_PROJECTION_DELETE',
                      );
                  },
                },
              );
            },
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
          );
        } catch (error) {
          if (
            entered &&
            !(error instanceof NativeTransactionOutcomeUnknownError)
          ) {
            try {
              await this.workspaceOrmManager.runInWorkspaceTransaction(
                (scope) =>
                  appendOmniConversationTargetFailure(
                    scope,
                    request,
                    operationId,
                    candidateTargetId,
                    denied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_CONVERSATION_TARGET_FAILURE_AUDIT_UNCONFIRMED',
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

  async setOmniIdentityPerson(
    principal: OmniIdentityPersonPrincipal,
    command: OmniIdentityPersonCommand,
    authorize: OmniIdentityPersonAuthorizer,
  ) {
    const request = snapshotOmniIdentityPersonRequest(
      principal,
      command,
      authorize,
    );
    return this.executeOmniIdentityPersonRequest(request);
  }

  async createPersonForOmniIdentity(
    principal: OmniIdentityPersonPrincipal,
    command: OmniIdentityCreatePersonCommand,
    authorize: OmniIdentityCreatePersonAuthorizer,
  ) {
    return this.executeOmniIdentityPersonRequest(
      snapshotOmniIdentityCreatePersonRequest(principal, command, authorize),
    );
  }

  private identityPersonNativePort(
    scope: Parameters<
      Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
    >[0],
  ): Parameters<typeof setOmniIdentityPerson>[4] {
    return {
      createPerson: async (id, fields) => {
        await scope
          .getRepository(
            'person',
            { shouldBypassPermissionChecks: true },
            { shouldSkipEventEmission: true },
          )
          .insert({ id, name: { ...fields.name } });
      },
      updateParticipantPerson: async (id, personId) => {
        const result = await withOmniRepositoryOptions(scope)
          .getRepository<{
            id: string;
            personId: string | null;
          }>('messageParticipant', {
            shouldBypassPermissionChecks: true,
          })
          .update({ id }, { personId });
        if (result.affected !== 1)
          throw new Error('OMNI_IDENTITY_PARTICIPANT_UPDATE');
      },
      deleteProjection: async (id) => {
        const result = await withOmniRepositoryOptions(scope)
          .getRepository<{
            id: string;
          }>('messageThreadTarget', {
            shouldBypassPermissionChecks: true,
          })
          .delete({ id });
        if (result.affected !== 1)
          throw new Error('OMNI_IDENTITY_PROJECTION_DELETE');
      },
    };
  }

  private async executeOmniIdentityPersonRequest(
    request: OmniIdentityPersonRequest,
  ) {
    const operationId = randomUUID();
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const person = this.workspaceOrmManager.getStandardPersonMetadata();
        if (
          !person ||
          person.workspaceId !== request.principal.workspaceId ||
          !person.isActive
        )
          throw new Error('OMNI_IDENTITY_PERSON_METADATA_SCOPE');
        const personObjectMetadataId = person.id;
        let entered = false;
        let denied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              entered = true;
              return setOmniIdentityPerson(
                scope,
                request.mode === 'create'
                  ? {
                      ...request,
                      authorize: async (
                        ...args: Parameters<OmniIdentityCreatePersonAuthorizer>
                      ) => {
                        try {
                          await request.authorize(...args);
                        } catch (error) {
                          denied = true;
                          throw error;
                        }
                      },
                    }
                  : {
                      ...request,
                      authorize: async (
                        ...args: Parameters<OmniIdentityPersonAuthorizer>
                      ) => {
                        try {
                          await request.authorize(...args);
                        } catch (error) {
                          denied = true;
                          throw error;
                        }
                      },
                    },
                personObjectMetadataId,
                operationId,
                this.identityPersonNativePort(scope),
              );
            },
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
          );
        } catch (error) {
          if (
            entered &&
            !(error instanceof NativeTransactionOutcomeUnknownError)
          ) {
            try {
              await this.workspaceOrmManager.runInWorkspaceTransaction(
                (scope) =>
                  appendOmniIdentityPersonFailure(
                    scope,
                    request,
                    operationId,
                    denied,
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_IDENTITY_PERSON_FAILURE_AUDIT_UNCONFIRMED',
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
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
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

  async cancelOmniLocalHumanCommand(
    principal: OmniLocalCommandCancellationPrincipal,
    input: OmniLocalCommandCancellationInput,
    callbacks: OmniLocalCommandCancellationCallbacks,
  ): Promise<OmniLocalCommandCancellationResult> {
    const request = snapshotOmniLocalCommandCancellationRequest(
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
              return cancelOmniLocalHumanCommand(
                scope,
                request.principal,
                request.input,
                {
                  ...request.callbacks,
                  authorizeRead: async (...args) => {
                    try {
                      return await request.callbacks.authorizeRead(...args);
                    } catch (error) {
                      authorizationDenied = true;
                      throw error;
                    }
                  },
                  authorizeDelegatedCancel: request.callbacks
                    .authorizeDelegatedCancel
                    ? async (...args) => {
                        try {
                          return await request.callbacks
                            .authorizeDelegatedCancel!(...args);
                        } catch (error) {
                          authorizationDenied = true;
                          throw error;
                        }
                      }
                    : undefined,
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
                  appendOmniLocalCommandCancellationFailure(
                    scope,
                    request.principal,
                    request.input,
                    attemptOperationId,
                    authorizationDenied ||
                      isOmniLocalCommandCancellationAuthorizationError(error),
                  ),
                { commitOutcome: 'strict' },
              );
            } catch (auditError) {
              throw new AggregateError(
                [error, auditError],
                'OMNI_LOCAL_COMMAND_CANCEL_FAILURE_AUDIT_UNCONFIRMED',
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
    return this.applyOmniIncomingReceiptWithinTransaction(
      principal,
      proof,
      authorize,
      null,
    );
  }

  async applyOmniIncomingTextReceipt(
    principal: OmniHistoryApplyPrincipal,
    proof: OmniHistoryApplyProof,
    authorize: OmniHistoryApplyAuthorizer,
    adapter: OmniIncomingRevisionAdapter,
    authorizeAutoCreatePerson?: OmniIncomingAutoCreatePersonAuthorizer,
  ): Promise<OmniIncomingTextApplyResult> {
    const result = await this.applyOmniIncomingReceiptWithinTransaction(
      principal,
      proof,
      authorize,
      snapshotOmniIncomingRevisionAdapter(adapter),
      authorizeAutoCreatePerson,
    );
    if (!('applicationResult' in result) || !('replayed' in result))
      throw new Error('OMNI_INCOMING_RESULT_POSTCONDITION');
    return result;
  }

  async processOmniIncomingTextReceipt(
    principal: OmniHistoryApplyPrincipal,
    proof: OmniHistoryApplyProof,
    authorize: OmniHistoryApplyAuthorizer,
    adapter: OmniIncomingRevisionAdapter,
    authorizeLease: OmniIncomingReceiptLeaseAuthorizer,
    authorizeAutoCreatePerson?: OmniIncomingAutoCreatePersonAuthorizer,
  ) {
    const request = snapshotOmniHistoryReceiptRequest(
      principal,
      proof,
      authorize,
    );
    const revisionAdapter = snapshotOmniIncomingRevisionAdapter(adapter);
    const leaseAuthorizer = authorizeLease;
    if (typeof leaseAuthorizer !== 'function')
      throw new Error('OMNI_INCOMING_LEASE_AUTHORIZER_REQUIRED');
    let authorizationDenied = false;
    try {
      return await this.applyOmniIncomingTextReceipt(
        request.principal,
        request.proof,
        async (scope, facts) => {
          try {
            await request.authorize(scope, facts);
          } catch (error) {
            authorizationDenied = true;
            throw error;
          }
        },
        revisionAdapter,
        authorizeAutoCreatePerson,
      );
    } catch (error) {
      if (
        authorizationDenied ||
        (!isOmniIncomingRevisionConflict(error) &&
          !isOmniHistoryMissingConfigurationError(error))
      )
        throw error;
      const leaseProof = {
        receiptId: request.proof.receiptId,
        leaseOwner: request.proof.leaseOwner,
        leaseToken: request.proof.leaseToken,
        routeGeneration: request.proof.routeGeneration,
      };
      return deferOmniIncomingReceipt(
        this.dataSource,
        request.principal,
        leaseProof,
        isOmniIncomingRevisionConflict(error)
          ? { state: 'quarantined', errorCode: 'inconsistent_source' }
          : { state: 'blocked_config', errorCode: 'configuration_missing' },
        leaseAuthorizer,
      );
    }
  }

  private async applyOmniIncomingReceiptWithinTransaction(
    principal: OmniHistoryApplyPrincipal,
    proof: OmniHistoryApplyProof,
    authorize: OmniHistoryApplyAuthorizer,
    adapter: OmniIncomingRevisionAdapter | null,
    authorizeAutoCreatePerson?: OmniIncomingAutoCreatePersonAuthorizer,
  ): Promise<OmniHistoryApplyResult | OmniIncomingTextApplyResult> {
    const request = snapshotOmniHistoryReceiptRequest(
      principal,
      proof,
      authorize,
    );

    if (
      authorizeAutoCreatePerson !== undefined &&
      typeof authorizeAutoCreatePerson !== 'function'
    )
      throw new Error('OMNI_HISTORY_AUTO_PERSON_AUTHORIZER_REQUIRED');
    const autoCreateAuthorizer = authorizeAutoCreatePerson;
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        let callbackEntered = false;
        let authorizationDenied = false;
        try {
          return await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (transactionScope) => {
              callbackEntered = true;
              const nativeScope = withOmniRepositoryOptions(transactionScope);

              const apply = adapter
                ? (
                    scope: Parameters<typeof applyOmniHistoryReceipt>[0],
                    principal: OmniHistoryApplyPrincipal,
                    proof: OmniHistoryApplyProof,
                    authorize: OmniHistoryApplyAuthorizer,
                    nativePort: Parameters<typeof applyOmniHistoryReceipt>[4],
                  ) =>
                    applyOmniIncomingTextReceipt(
                      scope,
                      principal,
                      proof,
                      authorize,
                      nativePort,
                      adapter,
                    )
                : applyOmniHistoryReceipt;
              return apply(
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
                  createPersonForIdentity: autoCreateAuthorizer
                    ? async (input) => {
                        const person =
                          this.workspaceOrmManager.getStandardPersonMetadata();
                        if (
                          !person ||
                          person.workspaceId !==
                            request.principal.workspaceId ||
                          !person.isActive
                        )
                          throw new Error(
                            'OMNI_IDENTITY_PERSON_METADATA_SCOPE',
                          );
                        return setOmniIdentityPerson(
                          transactionScope,
                          snapshotOmniIdentityCreatePersonRequest(
                            {
                              workspaceId: request.principal.workspaceId,
                              actor: {
                                kind: 'system',
                                id: OMNI_AUTO_PERSON_ACTOR_ID,
                              },
                            },
                            input.command,
                            async (scope, facts) => {
                              try {
                                await autoCreateAuthorizer(
                                  scope,
                                  Object.freeze({
                                    ...facts,
                                    incoming: input.incoming,
                                  }),
                                );
                              } catch (error) {
                                authorizationDenied = true;
                                throw error;
                              }
                            },
                          ),
                          person.id,
                          input.operationId,
                          this.identityPersonNativePort(transactionScope),
                        );
                      }
                    : undefined,
                  updateMessageText: async (messageId, text) => {
                    const repository = nativeScope.getRepository<{
                      id: string;
                      text: string | null;
                    }>('message', { shouldBypassPermissionChecks: true });
                    const updated = await repository.update(
                      { id: messageId },
                      { text },
                    );
                    if (updated.affected !== 1)
                      throw new Error(
                        'OMNI_INCOMING_NATIVE_UPDATE_POSTCONDITION',
                      );
                  },
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
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
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
                    adapter !== null,
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
    options: {
      context: MessageImportMatchingContext;
      expectedRun?: OrdinaryMetadataSyncRun;
    },
  ): Promise<
    | {
        messageExternalIdsAndIdsMap: Map<string, string>;
        messageExternalIdToMessageThreadIdMap: Map<string, string>;
      }
    | undefined
  > {
    const context = captureMessageImportMatchingContext(options.context);
    const expectedRun = options.expectedRun && { ...options.expectedRun };
    const authority = context.authority;
    if (
      !isUUID(workspaceId) ||
      !messageChannel ||
      typeof messageChannel.id !== 'string' ||
      !isUUID(messageChannel.id) ||
      typeof messageChannel.connectedAccountId !== 'string' ||
      !isUUID(messageChannel.connectedAccountId) ||
      !connectedAccount ||
      typeof connectedAccount.id !== 'string' ||
      !isUUID(connectedAccount.id) ||
      authority.workspaceId !== workspaceId.toLowerCase() ||
      authority.channelId !== messageChannel.id.toLowerCase() ||
      authority.connectedAccountId !== connectedAccount.id.toLowerCase() ||
      authority.channelType !== messageChannel.type ||
      messageChannel.connectedAccountId.toLowerCase() !==
        connectedAccount.id.toLowerCase() ||
      (authority.kind === 'provider'
        ? !expectedRun ||
          canonicalAuditJson(authority.run) !== canonicalAuditJson(expectedRun)
        : expectedRun !== undefined)
    )
      throw new Error('MESSAGE_IMPORT_MATCHING_SCOPE_MISMATCH');
    if (
      expectedRun &&
      (expectedRun.kind !== 'message' ||
        expectedRun.workspaceId !== workspaceId ||
        expectedRun.channelId !== messageChannel.id ||
        expectedRun.connectedAccountId !== connectedAccount.id ||
        messageChannel.connectedAccountId !== connectedAccount.id)
    )
      throw new Error('MESSAGE_NATIVE_SYNC_SCOPE_MISMATCH');
    if (!Array.isArray(messagesToSave))
      throw new Error('Message save requires an array of messages');
    messagesToSave = (
      captureNativeCrmAuditWriteData({
        messages: messagesToSave,
      }).messages as MessageWithParticipants[]
    ).map((message) => ({
      ...message,
      receivedAt: message.receivedAt ? new Date(message.receivedAt) : null,
      attachments: Array.isArray(message.attachments)
        ? [...message.attachments]
        : [],
      messageFolderIds:
        message.messageFolderIds === undefined
          ? undefined
          : message.messageFolderIds.map((folderId) => {
              if (typeof folderId !== 'string' || !isUUID(folderId))
                throw new Error('Message save invalid folder reference');
              return folderId.toLowerCase();
            }),
      participants: Array.isArray(message.participants)
        ? message.participants.map((participant) => {
            if (
              (participant.personId !== undefined &&
                participant.personId !== null &&
                (typeof participant.personId !== 'string' ||
                  !isUUID(participant.personId))) ||
              (participant.workspaceMemberId !== undefined &&
                participant.workspaceMemberId !== null &&
                (typeof participant.workspaceMemberId !== 'string' ||
                  !isUUID(participant.workspaceMemberId)))
            )
              throw new Error('Message save invalid participant identity');
            return {
              ...participant,
              ...(typeof participant.personId === 'string'
                ? { personId: participant.personId.toLowerCase() }
                : {}),
              ...(typeof participant.workspaceMemberId === 'string'
                ? {
                    workspaceMemberId:
                      participant.workspaceMemberId.toLowerCase(),
                  }
                : {}),
            };
          })
        : [],
    }));
    if (
      messagesToSave.some(
        (message) =>
          typeof message.externalId !== 'string' ||
          message.externalId.length === 0 ||
          typeof message.headerMessageId !== 'string' ||
          typeof message.messageThreadExternalId !== 'string',
      ) ||
      new Set(messagesToSave.map((message) => message.externalId)).size !==
        messagesToSave.length
    )
      throw new Error('Message save requires distinct valid messages');
    messageChannel = {
      ...messageChannel,
      id: messageChannel.id.toLowerCase(),
      connectedAccountId: messageChannel.connectedAccountId.toLowerCase(),
      isContactAutoCreationEnabled: Boolean(
        messageChannel.isContactAutoCreationEnabled,
      ),
      excludeNonProfessionalEmails: Boolean(
        messageChannel.excludeNonProfessionalEmails,
      ),
      excludeGroupEmails: Boolean(messageChannel.excludeGroupEmails),
    };
    connectedAccount = {
      ...connectedAccount,
      id: connectedAccount.id.toLowerCase(),
      handleAliases: Array.isArray(connectedAccount.handleAliases)
        ? [...connectedAccount.handleAliases]
        : [],
    };
    const savedMessagesResult = await this.saveOrdinaryMessageBatchWithAudit({
      messagesToSave,
      messageChannel,
      connectedAccount,
      workspaceId: workspaceId.toLowerCase(),
      context,
    });

    if (!isDefined(savedMessagesResult)) return undefined;

    if (messageChannel.isContactAutoCreationEnabled) {
      const contactsToCreate =
        savedMessagesResult.participantsWithMessageId.flatMap((participant) =>
          participant.shouldCreateContact && participant.handle
            ? [
                {
                  handle: participant.handle,
                  displayName: participant.displayName ?? '',
                },
              ]
            : [],
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

    const matchingOutcome =
      await this.messageParticipantService.matchMessageParticipants({
        manifest: savedMessagesResult.manifest,
        context,
        workspaceId,
        ...(savedMessagesResult.intentId
          ? { intentId: savedMessagesResult.intentId }
          : {}),
      });
    if (matchingOutcome === 'stale-run') return undefined;

    return {
      messageExternalIdsAndIdsMap:
        savedMessagesResult.messageExternalIdsAndIdsMap,
      messageExternalIdToMessageThreadIdMap:
        savedMessagesResult.messageExternalIdToMessageThreadIdMap,
    };
  }

  private async saveOrdinaryMessageBatchWithAudit({
    messagesToSave,
    messageChannel,
    connectedAccount,
    workspaceId,
    context,
  }: {
    messagesToSave: MessageWithParticipants[];
    messageChannel: MessageChannelEntity;
    connectedAccount: ConnectedAccountEntity;
    workspaceId: string;
    context: MessageImportMatchingContext;
  }): Promise<
    | {
        manifest: MessageImportMatchingManifest;
        intentId?: string;
        participantsWithMessageId: {
          messageId: string;
          handle: string | null;
          displayName: string | null;
          role: MessageParticipantRole;
          personId?: string | null;
          workspaceMemberId?: string | null;
          shouldCreateContact: boolean;
        }[];
        savedMessageParticipants: {
          id: string;
          messageId: string;
          handle: string | null;
          displayName: string | null;
          role: MessageParticipantRole;
          personId: string | null;
          workspaceMemberId: string | null;
        }[];
        messageExternalIdsAndIdsMap: Map<string, string>;
        messageExternalIdToMessageThreadIdMap: Map<string, string>;
      }
    | undefined
  > {
    const handleAliases = connectedAccount.handleAliases || [];
    const authContext = buildSystemAuthContext(workspaceId);
    const operation: CrmAuditOperation = {
      ...context.operation,
      operationId: randomUUID(),
      actor: { ...context.operation.actor },
      ...(context.operation.initiator
        ? { initiator: { ...context.operation.initiator } }
        : {}),
    };

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            const state = await this.prepareMessageSaveAudit(
              transactionScope,
              operation,
              messagesToSave,
              messageChannel.id,
            );
            const authorityProof = await captureMessageImportAuthorityProof({
              scope: transactionScope,
              operation,
              authority: context.authority,
            });
            if (!authorityProof.applied) return undefined;
            state.validators.push(authorityProof.verify);
            await this.lockMessageSaveFolders(
              state,
              messagesToSave,
              messageChannel.id,
            );

            const messagePlan =
              await this.messageService.prepareMessageSaveWithinTransaction(
                messagesToSave,
                messageChannel.id,
                transactionScope,
                workspaceId,
              );
            const extraThreads = await transactionScope.executeRawQuery(
              `SELECT DISTINCT "messageThreadId" FROM ${messageSaveTableSql(state.shapes.get('message')!)} WHERE "messageThreadId" IS NOT NULL AND ("headerMessageId"=ANY($1::text[]) OR id=ANY($2::uuid[]) OR id IN (SELECT "messageId" FROM ${messageSaveTableSql(state.shapes.get('messageChannelMessageAssociation')!)} WHERE "messageChannelId"=$3::uuid AND ("messageExternalId"=ANY($4::text[]) OR "messageThreadExternalId"=ANY($5::text[]))))`,
              [
                state.headerMessageIds,
                [...messagePlan.discoveredMessageIds],
                messageChannel.id,
                state.externalIds,
                state.threadExternalIds,
              ],
            );
            state.rootThreadIds = [
              ...new Set([
                ...messagePlan.discoveredThreadIds.map((id) =>
                  id.toLowerCase(),
                ),
                ...messagePlan.messageThreadsToCreate.map((thread) =>
                  thread.id.toLowerCase(),
                ),
                ...extraThreads.flatMap((row) =>
                  typeof row.messageThreadId === 'string' &&
                  isUUID(row.messageThreadId)
                    ? [row.messageThreadId.toLowerCase()]
                    : [],
                ),
              ]),
            ].sort();
            state.originalIds.set('messageThread', [...state.rootThreadIds]);
            state.originalIds.set(
              'message',
              [
                ...new Set([
                  ...messagePlan.discoveredMessageIds.map((id) =>
                    id.toLowerCase(),
                  ),
                  ...messagePlan.messagesToCreate.map((row) =>
                    row.id.toLowerCase(),
                  ),
                ]),
              ].sort(),
            );
            state.originalIds.set(
              'messageChannelMessageAssociation',
              [
                ...new Set([
                  ...messagePlan.discoveredAssociationIds.map((id) =>
                    id.toLowerCase(),
                  ),
                  ...messagePlan.messageChannelMessageAssociationsToCreate.map(
                    (row) => row.id.toLowerCase(),
                  ),
                ]),
              ].sort(),
            );

            for (const name of [
              'messageThread',
              'message',
              'messageThreadTarget',
              'messageParticipant',
              'messageChannelMessageAssociation',
              'messageChannelMessageAssociationMessageFolder',
            ] as const) {
              const rows = await this.readMessageSaveGraph(state, name, true);
              state.before.set(name, rows);
              state.expected.set(name, rows);
              state.originalIds.set(
                name,
                [
                  ...new Set([
                    ...(state.originalIds.get(name) ?? []),
                    ...rows.map((row) => row.id),
                  ]),
                ].sort(),
              );
            }

            await this.lockMessageSaveParticipantSources(state, messagesToSave);
            await this.verifyMessageSaveGraph(state);

            const insertedThreadIds = await this.insertMessageSaveRecords(
              state,
              'messageThread',
              messagePlan.messageThreadsToCreate.map((row) => ({
                ...row,
                id: row.id.toLowerCase(),
              })),
            );
            if (
              insertedThreadIds.length !==
              messagePlan.messageThreadsToCreate.length
            )
              throw new Error(
                'Message save skipped thread required by dependent plan',
              );
            if (messagePlan.threadSubjectUpdates.length > 0) {
              const updatedThreadIds = await this.updateMessageSaveRecords(
                state,
                'messageThread',
                messagePlan.threadSubjectUpdates.map(({ id, subject }) => ({
                  criteria: id.toLowerCase(),
                  partialEntity: { subject },
                })),
              );
              if (
                updatedThreadIds.length !==
                messagePlan.threadSubjectUpdates.length
              )
                throw new Error(
                  'Message save skipped thread subject update required by plan',
                );
            }

            const insertedMessageIds = await this.insertMessageSaveRecords(
              state,
              'message',
              messagePlan.messagesToCreate.map((row) => ({
                ...row,
                id: row.id.toLowerCase(),
                messageThreadId: row.messageThreadId
                  ? row.messageThreadId.toLowerCase()
                  : null,
              })),
            );
            if (
              insertedMessageIds.length !== messagePlan.messagesToCreate.length
            )
              throw new Error(
                'Message save skipped message required by dependent plan',
              );

            const insertedAssociationIds = await this.insertMessageSaveRecords(
              state,
              'messageChannelMessageAssociation',
              messagePlan.messageChannelMessageAssociationsToCreate.map(
                (row) => ({
                  ...row,
                  id: row.id.toLowerCase(),
                  messageChannelId: row.messageChannelId.toLowerCase(),
                  messageId: row.messageId.toLowerCase(),
                }),
              ),
            );
            if (
              insertedAssociationIds.length !==
              messagePlan.messageChannelMessageAssociationsToCreate.length
            )
              throw new Error(
                'Message save skipped association required by dependent plan',
              );

            const messageExternalIdsAndIdsMap = new Map<string, string>();
            const messageExternalIdToMessageChannelMessageAssociationIdMap =
              new Map<string, string>();
            const messageExternalIdToMessageThreadIdMap = new Map<
              string,
              string
            >();
            for (const message of messagesToSave) {
              const messageId = messagePlan.messageExternalIdsAndIdsMap
                .get(message.externalId)
                ?.toLowerCase();
              const threadId = messagePlan.messageExternalIdToMessageThreadIdMap
                .get(message.externalId)
                ?.toLowerCase();
              const associationId =
                messagePlan.messageExternalIdToMessageChannelMessageAssociationIdMap
                  .get(message.externalId)
                  ?.toLowerCase();
              const messageRow = state.expected
                .get('message')!
                .find((row) => row.id === messageId);
              const threadRow = state.expected
                .get('messageThread')!
                .find((row) => row.id === threadId);
              const associationRow = state.expected
                .get('messageChannelMessageAssociation')!
                .find((row) => row.id === associationId);
              if (
                !messageId ||
                !threadId ||
                !associationId ||
                !messageRow ||
                !threadRow ||
                !associationRow ||
                messageRow.deletedAt !== 'null' ||
                threadRow.deletedAt !== 'null' ||
                associationRow.deletedAt !== 'null' ||
                messageRow.messageThreadId !== JSON.stringify(threadId) ||
                associationRow.messageId !== JSON.stringify(messageId) ||
                associationRow.messageChannelId !==
                  JSON.stringify(messageChannel.id)
              )
                throw new Error('Message save resolved mapping mismatch');
              messageExternalIdsAndIdsMap.set(message.externalId, messageId);
              messageExternalIdToMessageThreadIdMap.set(
                message.externalId,
                threadId,
              );
              messageExternalIdToMessageChannelMessageAssociationIdMap.set(
                message.externalId,
                associationId,
              );
            }

            const participantsWithMessageId = messagesToSave.flatMap(
              (message) => {
                const messageId = messageExternalIdsAndIdsMap.get(
                  message.externalId,
                );
                return messageId
                  ? message.participants.map((participant) => {
                      const fromHandle =
                        message.participants.find(
                          (item) => item.role === MessageParticipantRole.FROM,
                        )?.handle || '';
                      const isMessageSentByConnectedAccount =
                        handleAliases.includes(fromHandle) ||
                        fromHandle === connectedAccount.handle;
                      const isParticipantConnectedAccount =
                        handleAliases.includes(participant.handle ?? '') ||
                        participant.handle === connectedAccount.handle;
                      const isExcludedByNonProfessionalEmails =
                        messageChannel.excludeNonProfessionalEmails &&
                        !isWorkEmail(participant.handle ?? '');
                      const isExcludedByGroupEmails =
                        messageChannel.excludeGroupEmails &&
                        isGroupEmail(participant.handle ?? '');
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
                        handle: participant.handle ?? null,
                        displayName: participant.displayName ?? null,
                        messageId,
                        shouldCreateContact,
                      };
                    })
                  : [];
              },
            );

            const participantPlan =
              await this.messageParticipantService.prepareMessageParticipantsWithinTransaction(
                participantsWithMessageId,
                workspaceId,
                transactionScope,
              );
            const expectedParticipantIds = new Set(
              state.expected
                .get('messageParticipant')!
                .filter((row) => row.deletedAt === 'null')
                .map((row) => row.id),
            );
            if (
              participantPlan.existingParticipants.some(
                (row) => !expectedParticipantIds.has(row.id.toLowerCase()),
              )
            )
              throw new Error(
                'Message save participant discovery changed before write',
              );

            const updatedParticipantIds = await this.updateMessageSaveRecords(
              state,
              'messageParticipant',
              participantPlan.identityUpdates.map((row) => ({
                criteria: row.criteria.toLowerCase(),
                partialEntity: { ...row.partialEntity },
              })),
            );
            const plannedParticipants =
              participantPlan.participantsToCreate.map((row) => ({
                ...row,
                id: randomUUID(),
                messageId: row.messageId.toLowerCase(),
                personId: row.personId ? row.personId.toLowerCase() : null,
                workspaceMemberId: row.workspaceMemberId
                  ? row.workspaceMemberId.toLowerCase()
                  : null,
              }));
            state.originalIds.set(
              'messageParticipant',
              [
                ...new Set([
                  ...(state.originalIds.get('messageParticipant') ?? []),
                  ...plannedParticipants.map((row) => row.id),
                ]),
              ].sort(),
            );
            const insertedParticipantIds = await this.insertMessageSaveRecords(
              state,
              'messageParticipant',
              plannedParticipants,
            );
            if (insertedParticipantIds.length !== plannedParticipants.length)
              throw new Error(
                'Message save skipped participant required by dependent plan',
              );

            const touchedParticipantSet = new Set([
              ...insertedParticipantIds,
              ...updatedParticipantIds,
            ]);
            const savedMessageParticipants = state.expected
              .get('messageParticipant')!
              .filter((row) => touchedParticipantSet.has(row.id))
              .map((row) => ({
                id: row.id,
                messageId: JSON.parse(String(row.messageId)) as string,
                handle: JSON.parse(String(row.handle)) as string | null,
                displayName: JSON.parse(String(row.displayName)) as
                  | string
                  | null,
                role: JSON.parse(String(row.role)) as MessageParticipantRole,
                personId: JSON.parse(String(row.personId)) as string | null,
                workspaceMemberId: JSON.parse(String(row.workspaceMemberId)) as
                  | string
                  | null,
              }));

            const folderAssociations: MessageChannelMessageAssociationFolderAssociation[] =
              messagesToSave.flatMap((message) => {
                const messageFolderIds = message.messageFolderIds ?? [];
                if (messageFolderIds.length === 0) return [];
                const associationId =
                  messageExternalIdToMessageChannelMessageAssociationIdMap.get(
                    message.externalId,
                  );
                if (!isDefined(associationId)) return [];
                return [
                  {
                    messageChannelMessageAssociationId: associationId,
                    messageFolderIds,
                  },
                ];
              });

            const folderPlan =
              await this.messageFolderAssociationService.prepareMessageFolderAssociationsWithinTransaction(
                folderAssociations,
                workspaceId,
                transactionScope,
              );
            const plannedJunctions = folderPlan.recordsToInsert.map((row) => ({
              id: randomUUID(),
              messageChannelMessageAssociationId:
                row.messageChannelMessageAssociationId.toLowerCase(),
              messageFolderId: row.messageFolderId.toLowerCase(),
            }));
            state.originalIds.set(
              'messageChannelMessageAssociationMessageFolder',
              [
                ...new Set([
                  ...(state.originalIds.get(
                    'messageChannelMessageAssociationMessageFolder',
                  ) ?? []),
                  ...plannedJunctions.map((row) => row.id),
                ]),
              ].sort(),
            );
            const insertedJunctionIds = await this.insertMessageSaveRecords(
              state,
              'messageChannelMessageAssociationMessageFolder',
              plannedJunctions,
            );
            if (insertedJunctionIds.length !== plannedJunctions.length)
              throw new Error(
                'Message save skipped folder junction required by dependent plan',
              );

            const participantMessageIds = [
              ...new Set(
                participantsWithMessageId.map(({ messageId }) => messageId),
              ),
            ];
            const messageReferences = [...messageExternalIdsAndIdsMap].flatMap(
              ([externalId, messageId]) => {
                if (!participantMessageIds.includes(messageId)) return [];
                const messageThreadId =
                  messageExternalIdToMessageThreadIdMap.get(externalId);
                if (!messageThreadId)
                  throw new Error('MESSAGE_IMPORT_MATCHING_THREAD_MISSING');
                return [{ messageId, messageThreadId }];
              },
            );
            const manifest = captureMessageImportMatchingManifest({
              messages: messageReferences,
              participants: savedMessageParticipants.map((participant) => ({
                id: participant.id,
                messageId: participant.messageId,
                handle: participant.handle ?? null,
                personId: participant.personId ?? null,
                workspaceMemberId: participant.workspaceMemberId ?? null,
              })),
              mode:
                messageChannel.type === MessageChannelType.APP
                  ? 'targetsOnly'
                  : 'both',
            });
            const pages = buildMessageImportMatchingPages(manifest);
            let intentId: string | undefined;
            if (pages.length > 0) {
              intentId = randomUUID();
              const intentPayload: MessageImportMatchingIntentPayload = {
                version: 1,
                context,
                pages,
                nextPageIndex: 0,
              };
              const insertedIntent = await transactionScope.executeRawQuery(
                `INSERT INTO core."deferredWorkspaceMigrationAction"(id,"workspaceId","applicationUniversalIdentifier",name,payload,position,"runByVersion",status,attempts) VALUES($1,$2,$3,$4,$5::jsonb,0,NULL,'PENDING',0) RETURNING id`,
                [
                  intentId,
                  workspaceId,
                  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
                  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
                  JSON.stringify(intentPayload),
                ],
              );
              if (
                insertedIntent.length !== 1 ||
                insertedIntent[0].id !== intentId
              )
                throw new Error(
                  'Message save matching intent was not persisted',
                );
              const persistedIntentId = intentId;
              state.validators.push(async () => {
                const intentRows = await transactionScope.executeRawQuery(
                  `SELECT id,"workspaceId","applicationUniversalIdentifier",name,payload,position,"runByVersion",status,attempts,"lastError","startedAt" FROM core."deferredWorkspaceMigrationAction" WHERE id=$1`,
                  [persistedIntentId],
                );
                if (
                  intentRows.length !== 1 ||
                  intentRows[0].id !== persistedIntentId ||
                  intentRows[0].workspaceId !== workspaceId ||
                  intentRows[0].applicationUniversalIdentifier !==
                    TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER ||
                  intentRows[0].name !== MESSAGE_IMPORT_MATCHING_INTENT_NAME ||
                  intentRows[0].position !== 0 ||
                  intentRows[0].runByVersion !== null ||
                  intentRows[0].status !== 'PENDING' ||
                  intentRows[0].attempts !== 0 ||
                  intentRows[0].lastError !== null ||
                  intentRows[0].startedAt !== null ||
                  canonicalAuditJson(intentRows[0].payload) !==
                    canonicalAuditJson(intentPayload)
                )
                  throw new Error(
                    'Message save matching intent changed before commit',
                  );
              });
            }

            await this.finishMessageSaveAudit(state);

            return {
              manifest,
              ...(intentId ? { intentId } : {}),
              participantsWithMessageId,
              savedMessageParticipants,
              messageExternalIdsAndIdsMap,
              messageExternalIdToMessageThreadIdMap,
            };
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      authContext,
      { lite: true },
    );
  }

  private async prepareMessageSaveAudit(
    scope: MessageSaveScope,
    operation: CrmAuditOperation,
    messagesToSave: readonly MessageWithParticipants[],
    channelId: string,
  ): Promise<MessageSaveAuditState> {
    const context = getIssuedNativeCleanupMetadata(scope);
    if (
      context.authType !== 'system' ||
      context.authWorkspaceId !== scope.workspaceId ||
      operation.workspaceId !== scope.workspaceId
    )
      throw new Error('Message save requires issued scoped system authority');
    const shapes = new Map<MessageSaveTable, NativeCrmAuditTableShape>();
    for (const name of MESSAGE_SAVE_TABLES) {
      const candidates = context.objects.filter(
        ({ metadata }) =>
          metadata.nameSingular === name &&
          metadata.universalIdentifier ===
            STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
          metadata.applicationUniversalIdentifier ===
            TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
          metadata.workspaceId === scope.workspaceId &&
          !metadata.isRemote,
      );
      if (candidates.length !== 1)
        throw new Error('Message save requires exact standard metadata');
      const { metadata, shape } = candidates[0];
      if (
        shape.objectMetadataId !== metadata.id ||
        shape.nameSingular !== name ||
        shape.tableName !== name
      )
        throw new Error('Message save table metadata mismatch');
      shapes.set(name, shape);
    }
    const sourceShapes = new Map<
      MessageSaveSourceTable,
      NativeCrmAuditTableShape
    >();
    for (const name of ['person', 'workspaceMember'] as const) {
      const candidates = context.objects.filter(
        ({ metadata }) =>
          metadata.nameSingular === name &&
          metadata.universalIdentifier ===
            STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
          metadata.applicationUniversalIdentifier ===
            TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
          metadata.workspaceId === scope.workspaceId &&
          !metadata.isRemote,
      );
      if (candidates.length === 1) {
        const { metadata, shape } = candidates[0];
        if (
          shape.objectMetadataId !== metadata.id ||
          shape.nameSingular !== name ||
          shape.tableName !== name
        )
          throw new Error('Message save source metadata mismatch');
        sourceShapes.set(name, shape);
      }
    }
    if (
      new Set(
        [...shapes.values(), ...sourceShapes.values()].map(
          (shape) => shape.schemaName,
        ),
      ).size !== 1
    )
      throw new Error('Message save schema mismatch');
    await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
    const [workspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Message save requires active workspace');
    await scope.executeRawQuery(
      'LOCK TABLE ' +
        MESSAGE_SAVE_WRITE_TABLES.map((name) =>
          messageSaveTableSql(shapes.get(name)!),
        )
          .sort()
          .join(',') +
        ' IN SHARE ROW EXCLUSIVE MODE',
    );
    await scope.executeRawQuery(
      `LOCK TABLE ${messageSaveTableSql(shapes.get('messageThreadTarget')!)} IN SHARE MODE`,
    );
    const schemaName = shapes.get('message')!.schemaName;
    for (const [parent, child, column] of [
      ['messageThread', 'message', 'messageThreadId'],
      ['messageThread', 'messageThreadTarget', 'messageThreadId'],
      ['message', 'messageParticipant', 'messageId'],
      ['message', 'messageChannelMessageAssociation', 'messageId'],
      [
        'messageChannelMessageAssociation',
        'messageChannelMessageAssociationMessageFolder',
        'messageChannelMessageAssociationId',
      ],
    ] as const) {
      const references = await getIncomingRecordForeignKeys(
        scope,
        schemaName,
        parent,
      );
      if (
        !references.some(
          (reference) =>
            reference.schemaName === schemaName &&
            reference.tableName === child &&
            canonicalAuditJson(reference.parentColumns) === '["id"]' &&
            canonicalAuditJson(reference.childColumns) ===
              canonicalAuditJson([column]),
        )
      )
        throw new Error('Message save requires expected foreign keys');
    }
    return {
      scope,
      shapes,
      sourceShapes,
      before: new Map(),
      expected: new Map(),
      originalIds: new Map(),
      rootThreadIds: [],
      headerMessageIds: [
        ...new Set(
          messagesToSave.flatMap((message) =>
            typeof message.headerMessageId === 'string'
              ? [message.headerMessageId]
              : [],
          ),
        ),
      ].sort(),
      externalIds: [
        ...new Set(messagesToSave.map((message) => message.externalId)),
      ].sort(),
      threadExternalIds: [
        ...new Set(
          messagesToSave.map((message) => message.messageThreadExternalId),
        ),
      ].sort(),
      channelId,
      validators: [
        async () => {
          const [currentWorkspace] = await scope.executeRawQuery(
            'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
            [scope.workspaceId],
          );
          if (
            currentWorkspace?.id !== workspace.id ||
            currentWorkspace.deletedAt !== null
          )
            throw new Error('Message save workspace changed before commit');
        },
      ],
      audit: new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation,
      ),
    };
  }

  private async lockMessageSaveFolders(
    state: MessageSaveAuditState,
    messagesToSave: readonly MessageWithParticipants[],
    channelId: string,
  ) {
    const folderIds = [
      ...new Set(
        messagesToSave.flatMap((message) => message.messageFolderIds ?? []),
      ),
    ].sort();
    if (folderIds.length === 0) return;
    const readFolders = (lock = false) =>
      state.scope.executeRawQuery(
        `SELECT id,"workspaceId","messageChannelId" FROM core."messageFolder" WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
        [folderIds],
      );
    const before = await readFolders(true);
    if (
      before.length !== folderIds.length ||
      before.some(
        (folder) =>
          folder.workspaceId !== state.scope.workspaceId ||
          folder.messageChannelId !== channelId,
      )
    )
      throw new Error('Message save folder authority mismatch');
    if (
      (
        await findOmniOwnedMessageFolderIds(
          state.scope,
          state.scope.workspaceId,
          folderIds,
        )
      ).size
    )
      throw new Error('Message save folder ownership mismatch');
    state.validators.push(async () => {
      const current = await readFolders();
      if (canonicalAuditJson(current) !== canonicalAuditJson(before))
        throw new Error('Message save folder authority changed before commit');
      if (
        (
          await findOmniOwnedMessageFolderIds(
            state.scope,
            state.scope.workspaceId,
            folderIds,
          )
        ).size
      )
        throw new Error('Message save folder ownership changed before commit');
    });
  }

  private async lockMessageSaveParticipantSources(
    state: MessageSaveAuditState,
    messagesToSave: readonly MessageWithParticipants[],
  ) {
    for (const sourceName of ['person', 'workspaceMember'] as const) {
      const column = sourceName === 'person' ? 'personId' : 'workspaceMemberId';
      const suppliedIds = [
        ...new Set(
          messagesToSave.flatMap((message) =>
            message.participants.flatMap((participant) =>
              typeof participant[column] === 'string'
                ? [participant[column].toLowerCase()]
                : [],
            ),
          ),
        ),
      ].sort();
      const existingIds = [
        ...new Set(
          state.before.get('messageParticipant')!.flatMap((row) => {
            const value = JSON.parse(String(row[column]));
            if (value === null) return [];
            if (typeof value !== 'string' || !isUUID(value))
              throw new Error('Message save invalid existing source reference');
            return [value.toLowerCase()];
          }),
        ),
      ].sort();
      const allIds = [...new Set([...suppliedIds, ...existingIds])].sort();
      if (allIds.length === 0) continue;
      const shape = state.sourceShapes.get(sourceName);
      if (!shape)
        throw new Error('Message save requires exact standard source metadata');
      const references = await getIncomingRecordForeignKeys(
        state.scope,
        shape.schemaName,
        sourceName,
      );
      if (
        !references.some(
          (reference) =>
            reference.schemaName === shape.schemaName &&
            reference.tableName === 'messageParticipant' &&
            canonicalAuditJson(reference.parentColumns) === '["id"]' &&
            canonicalAuditJson(reference.childColumns) ===
              canonicalAuditJson([column]),
        )
      )
        throw new Error('Message save requires participant source foreign key');
      await state.scope.executeRawQuery(
        `LOCK TABLE ${messageSaveTableSql(shape)} IN SHARE MODE`,
      );
      const locked = await state.scope.executeRawQuery(
        `SELECT id FROM ${messageSaveTableSql(shape)} WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [allIds],
      );
      const lockedIds = locked.map((row) => {
        if (typeof row.id !== 'string' || !isUUID(row.id))
          throw new Error('Message save invalid source identity');
        return row.id.toLowerCase();
      });
      const readSnapshots = async () => {
        const rows = await readNativeCrmAuditRows(
          {
            execute: ({ text, values }) =>
              state.scope.executeRawQuery(text, values),
          },
          shape,
          allIds,
        );
        return rows.sort((a, b) => a.id.localeCompare(b.id));
      };
      const before = await readSnapshots();
      if (
        lockedIds.length !== allIds.length ||
        before.length !== allIds.length ||
        suppliedIds.some((id) => {
          const row = before.find((item) => item.id === id);
          return !row || row.deletedAt !== 'null';
        })
      )
        throw new Error('Message save unresolved participant source reference');
      state.validators.push(async () => {
        if (
          canonicalAuditJson(await readSnapshots()) !==
          canonicalAuditJson(before)
        )
          throw new Error(
            'Message save participant source changed before commit',
          );
      });
    }
  }

  private async readMessageSaveGraph(
    state: MessageSaveAuditState,
    name: MessageSaveTable,
    lock = false,
  ): Promise<MessageSaveSnapshot[]> {
    const shape = state.shapes.get(name)!;
    const tableSql = messageSaveTableSql(shape);
    const originalIds = [
      ...new Set([
        ...(state.originalIds.get(name) ?? []),
        ...(state.before.get(name) ?? []).map((row) => row.id),
        ...(state.expected.get(name) ?? []).map((row) => row.id),
      ]),
    ].sort();
    const messageIds = [
      ...new Set([
        ...(state.originalIds.get('message') ?? []),
        ...(state.before.get('message') ?? []).map((row) => row.id),
        ...(state.expected.get('message') ?? []).map((row) => row.id),
      ]),
    ].sort();
    const associationIds = [
      ...new Set([
        ...(state.originalIds.get('messageChannelMessageAssociation') ?? []),
        ...(state.before.get('messageChannelMessageAssociation') ?? []).map(
          (row) => row.id,
        ),
        ...(state.expected.get('messageChannelMessageAssociation') ?? []).map(
          (row) => row.id,
        ),
      ]),
    ].sort();
    const lockClause = lock
      ? name === 'messageThreadTarget'
        ? ' FOR SHARE'
        : ' FOR UPDATE'
      : '';
    let sql: string;
    let params: unknown[];
    if (name === 'messageThread') {
      sql = `SELECT id FROM ${tableSql} WHERE id=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id${lockClause}`;
      params = [state.rootThreadIds, originalIds];
    } else if (name === 'message') {
      sql = `SELECT id FROM ${tableSql} WHERE "messageThreadId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) OR "headerMessageId"=ANY($3::text[]) ORDER BY id${lockClause}`;
      params = [state.rootThreadIds, originalIds, state.headerMessageIds];
    } else if (name === 'messageThreadTarget') {
      sql = `SELECT id FROM ${tableSql} WHERE "messageThreadId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id${lockClause}`;
      params = [state.rootThreadIds, originalIds];
    } else if (name === 'messageParticipant') {
      sql = `SELECT id FROM ${tableSql} WHERE "messageId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id${lockClause}`;
      params = [messageIds, originalIds];
    } else if (name === 'messageChannelMessageAssociation') {
      sql = `SELECT id FROM ${tableSql} WHERE "messageId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) OR ("messageChannelId"=$3::uuid AND ("messageExternalId"=ANY($4::text[]) OR "messageThreadExternalId"=ANY($5::text[]))) ORDER BY id${lockClause}`;
      params = [
        messageIds,
        originalIds,
        state.channelId,
        state.externalIds,
        state.threadExternalIds,
      ];
    } else {
      sql = `SELECT id FROM ${tableSql} WHERE "messageChannelMessageAssociationId"=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id${lockClause}`;
      params = [associationIds, originalIds];
    }
    const ids = (await state.scope.executeRawQuery(sql, params)).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Message save invalid graph identity');
      return row.id.toLowerCase();
    });
    const rows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      shape,
      ids,
    );
    if (rows.length !== ids.length)
      throw new Error('Message save graph changed');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async verifyMessageSaveGraph(state: MessageSaveAuditState) {
    for (const verify of state.validators) await verify();
    for (const name of MESSAGE_SAVE_TABLES) {
      const expected = [...(state.expected.get(name) ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      if (
        canonicalAuditJson(await this.readMessageSaveGraph(state, name)) !==
        canonicalAuditJson(expected)
      )
        throw new Error('Message save graph effects mismatch');
    }
    const threadIds = [
      ...new Set([
        ...state.rootThreadIds,
        ...(state.expected.get('messageThread') ?? []).map((row) => row.id),
      ]),
    ];
    const messageIds = [
      ...new Set((state.expected.get('message') ?? []).map((row) => row.id)),
    ];
    if (
      (
        await findOmniOwnedMessageThreadIds(
          state.scope,
          state.scope.workspaceId,
          threadIds,
        )
      ).size ||
      (
        await findOmniOwnedMessageIds(
          state.scope,
          state.scope.workspaceId,
          messageIds,
        )
      ).size
    )
      throw new Error('Message save ownership changed before commit');
  }

  private async insertMessageSaveRecords(
    state: MessageSaveAuditState,
    name: MessageSaveWriteTable,
    records: { id: string }[],
  ): Promise<string[]> {
    const shape = state.shapes.get(name)!;
    const actualIds: string[] = [];
    if (
      new Set(records.map((row) => row.id)).size !== records.length ||
      records.some((row) => !isUUID(row.id))
    )
      throw new Error('Message save invalid planned insert identity');
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100);
      await this.verifyMessageSaveGraph(state);
      const expected = state.expected.get(name)!;
      if (
        batch.some((row) => expected.some((existing) => existing.id === row.id))
      )
        throw new Error('Message save insert identity already exists');
      const declared = new Map<
        string,
        { columns: Record<string, unknown>; image: MessageSaveSnapshot }
      >();
      for (const row of batch) {
        const columns = messageSaveColumns(shape, row);
        declared.set(row.id, {
          columns,
          image: await castCalendarProofImage(state.scope, shape, columns),
        });
      }
      const result = await state.scope
        .getRepository(name, { shouldBypassPermissionChecks: true })
        .insert(batch);
      const ids = messageSaveActualIds(
        result,
        batch.map((row) => row.id),
      );
      const rows = await readNativeCrmAuditRows(
        {
          execute: ({ text, values }) =>
            state.scope.executeRawQuery(text, values),
        },
        shape,
        ids,
      );
      if (rows.length !== ids.length)
        throw new Error('Message save inserted row disappeared');
      for (const row of rows) {
        const planned = declared.get(row.id)!;
        if (
          row.deletedAt !== 'null' ||
          Object.keys(planned.image).some(
            (column) =>
              column !== 'createdAt' &&
              column !== 'updatedAt' &&
              row[column] !== planned.image[column],
          )
        )
          throw new Error('Message save inserted values mismatch');
      }
      assertNativeCrmDeleteFilesEmpty(shape, rows);
      state.expected.set(name, [...expected, ...rows]);
      actualIds.push(...ids);
      await this.verifyMessageSaveGraph(state);
    }
    return actualIds;
  }

  private async updateMessageSaveRecords(
    state: MessageSaveAuditState,
    name: MessageSaveWriteTable,
    records: { criteria: string; partialEntity: Record<string, unknown> }[],
  ): Promise<string[]> {
    const shape = state.shapes.get(name)!;
    const actualUpdatedIds: string[] = [];
    for (let offset = 0; offset < records.length; ) {
      const batch: typeof records = [];
      const ids = new Set<string>();
      while (
        offset < records.length &&
        batch.length < 100 &&
        !ids.has(records[offset].criteria)
      ) {
        const record = records[offset++];
        if (!isUUID(record.criteria))
          throw new Error('Message save invalid update identity');
        ids.add(record.criteria);
        batch.push(record);
      }
      await this.verifyMessageSaveGraph(state);
      const expected = state.expected.get(name)!;
      const after = new Map<string, MessageSaveSnapshot>();
      for (const record of batch) {
        const before = expected.find((row) => row.id === record.criteria);
        if (!before || before.deletedAt !== 'null')
          throw new Error('Message save requires live update parent');
        const columns = messageSaveColumns(shape, record.partialEntity);
        const image = await castCalendarProofImage(
          state.scope,
          shape,
          { ...columns, id: record.criteria },
          before,
        );
        after.set(record.criteria, image);
        const changedColumns = Object.keys(image).filter(
          (column) => column !== 'id' && image[column] !== before[column],
        );
        const patch =
          '{' +
          changedColumns
            .map(
              (column) => JSON.stringify(column) + ':' + String(image[column]),
            )
            .join(',') +
          '}';
        await assertNoReferentialUpdateEffects(
          {
            execute: ({ text, values }) =>
              state.scope.executeRawQuery(text, values),
          },
          {
            kind: 'update',
            alias: 'message_save_parent',
            tableShape: shape,
            setClauses: changedColumns.map((columnName) => ({
              columnName,
              valueExpression: `(jsonb_populate_record(NULL::${messageSaveTableSql(shape)},$2::jsonb)).${quoteMessageSaveIdentifier(columnName)}`,
            })),
          },
          {},
          '"message_save_parent".id=$1::uuid AND $2::jsonb IS NOT NULL',
          (text) => ({
            text,
            values: [record.criteria, patch],
          }),
        );
      }
      const result = await state.scope
        .getRepository(name, { shouldBypassPermissionChecks: true })
        .updateMany(batch);
      const actual = new Set(messageSaveActualIds(result, [...ids]));
      actualUpdatedIds.push(...actual);
      state.expected.set(
        name,
        expected.map((row) => (actual.has(row.id) ? after.get(row.id)! : row)),
      );
      await this.verifyMessageSaveGraph(state);
    }
    return [...new Set(actualUpdatedIds)];
  }

  private async finishMessageSaveAudit(state: MessageSaveAuditState) {
    await this.verifyMessageSaveGraph(state);
    for (const name of MESSAGE_SAVE_WRITE_TABLES) {
      const shape = state.shapes.get(name)!;
      const before = new Map(
        state.before.get(name)!.map((row) => [row.id, row]),
      );
      const after = new Map(
        state.expected.get(name)!.map((row) => [row.id, row]),
      );
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(id),
          current = after.get(id);
        if (
          canonicalAuditJson(previous ?? null) ===
          canonicalAuditJson(current ?? null)
        )
          continue;
        state.audit.record({
          resourceKind: 'crmRecord',
          resourceId: id,
          action: previous ? (current ? 'update' : 'delete') : 'create',
          before: previous
            ? captureNativeCrmAuditSnapshot(shape, previous)
            : null,
          after: current ? captureNativeCrmAuditSnapshot(shape, current) : null,
          implicitUpdatedAtFieldId:
            previous && current
              ? shape.columnShapeByColumnName.updatedAt?.fieldMetadataId
              : undefined,
          securityDescriptor: {
            resourceKind: 'crmRecord',
            resourceId: id,
            objectMetadataId: shape.objectMetadataId,
            ...(!current
              ? {
                  deletedRecord: {
                    access: 'currentWorkspaceAdministration' as const,
                  },
                }
              : {}),
          },
        });
      }
    }
    await state.audit.flush();
    await state.scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
    await this.verifyMessageSaveGraph(state);
  }
}
