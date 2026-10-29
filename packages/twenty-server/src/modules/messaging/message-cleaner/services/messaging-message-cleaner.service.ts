import { Injectable } from '@nestjs/common';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { cleanOrphanNativeMessagesAndThreadsWithAudit } from 'src/engine/core-modules/crm-audit/clean-orphan-native-messages-and-threads-with-audit';
import { deleteNativeMessageChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-message-channel-associations-with-audit';
import { deleteOrdinarySyncMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-sync-message-associations-with-audit';
import {
  deleteSentDraftMessageWithAudit,
  type SentDraftCleanupTarget,
} from 'src/engine/core-modules/crm-audit/delete-sent-draft-message-with-audit';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';

@Injectable()
export class MessagingMessageCleanerService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async deleteMessagesChannelMessageAssociationsAndRelatedOrphans({
    workspaceId,
    messageExternalIds,
    messageChannelId,
    expectedRun,
    auditOperation,
  }: {
    workspaceId: string;
    messageExternalIds: string[];
    messageChannelId: string;
    expectedRun: OrdinaryMetadataSyncRun;
    auditOperation: CrmAuditOperation;
  }): Promise<
    Awaited<ReturnType<typeof deleteOrdinarySyncMessageAssociationsWithAudit>>
  > {
    if (
      !expectedRun ||
      expectedRun.workspaceId !== workspaceId ||
      expectedRun.channelId !== messageChannelId ||
      expectedRun.kind !== 'message'
    )
      throw new Error('ORDINARY_SYNC_CLEANUP_INVALID_SCOPE');
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error(
        'Native targeted cleanup requires scoped audit operation',
      );
    const run = { ...expectedRun };
    const externalIds = [...messageExternalIds];
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            this.assertWorkspaceScope(workspaceId, scope);
            return deleteOrdinarySyncMessageAssociationsWithAudit({
              scope,
              operation,
              expectedRun: run,
              messageExternalIds: externalIds,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  async deleteSentDraft({
    workspaceId,
    connectedAccountId,
    draftMessageId,
    caller,
    auditOperation,
    target,
  }: {
    workspaceId: string;
    connectedAccountId: string;
    draftMessageId: string;
    caller: { userWorkspaceId: string; userId: string };
    auditOperation: CrmAuditOperation;
    target: SentDraftCleanupTarget;
  }): Promise<Awaited<ReturnType<typeof deleteSentDraftMessageWithAudit>>> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error('Native draft cleanup requires scoped audit operation');
    const capturedCaller = {
      userWorkspaceId: caller.userWorkspaceId,
      userId: caller.userId,
    };
    const capturedTarget = {
      associationId: target.associationId,
      messageChannelId: target.messageChannelId,
      messageExternalId: target.messageExternalId,
    };
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            this.assertWorkspaceScope(workspaceId, scope);
            return deleteSentDraftMessageWithAudit({
              scope,
              operation,
              caller: capturedCaller,
              connectedAccountId,
              draftMessageId,
              target: capturedTarget,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  async deleteMessageChannelMessageAssociationsByChannelId({
    workspaceId,
    messageChannelId,
    auditOperation,
  }: {
    workspaceId: string;
    messageChannelId: string;
    auditOperation: CrmAuditOperation;
  }) {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error('Native channel cleanup requires scoped audit operation');
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        return this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            this.assertWorkspaceScope(workspaceId, transactionScope);
            return deleteNativeMessageChannelAssociationsWithAudit({
              scope: transactionScope,
              messageChannelId,
              operation,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        );
      },
      authContext,
      { lite: true },
    );
  }

  public async cleanOrphanMessagesAndThreads(
    workspaceId: string,
    auditOperation: CrmAuditOperation,
  ): Promise<void> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error('Native orphan cleanup requires scoped audit operation');
    const operation = {
      ...auditOperation,
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    const authContext = buildSystemAuthContext(workspaceId);
    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            this.assertWorkspaceScope(workspaceId, transactionScope);
            return cleanOrphanNativeMessagesAndThreadsWithAudit({
              scope: transactionScope,
              operation,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
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
}
