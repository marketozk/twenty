import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceTransactionOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import {
  acceptOmniIncomingEvent,
  type OmniIncomingPrincipal,
} from 'src/modules/omnichannel/services/accept-omni-incoming-event';
import { type OmniHistoryApplyAuthorizer } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { claimOmniIncomingReceipts } from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

export const createOmniHistoryApplyFixture = (
  options: {
    includeTargets?: boolean;
    includeFolderAssociations?: boolean;
    includeWorkspaceMember?: boolean;
    useStandardForeignKeyActions?: boolean;
  } = {},
) => {
  const native = createOmniNativeMessageFixture({
    coreSchema: 'fork',
    useStandardForeignKeyActions: options.useStandardForeignKeyActions,
    additionalTables: [
      ...(options.includeTargets ? ['messageThreadTarget' as const] : []),
      ...(options.includeFolderAssociations
        ? ['messageChannelMessageAssociationMessageFolder' as const]
        : []),
      ...(options.includeWorkspaceMember ? ['workspaceMember' as const] : []),
    ],
  });
  const runtime = new DataSource({
    type: 'postgres',
    url: native.runtimeDatabaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 3, statement_timeout: 10000 },
  });
  const manager = {
    getWorkspaceId: () => getWorkspaceContext().authContext.workspace.id,
    executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
      native.withContext(work),
    runInWorkspaceTransaction: async <T>(
      work: (scope: WorkspaceTransactionScope) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> => native.dataSource.transaction(work, options),
  } as unknown as WorkspaceOrmManager;
  const messages = new MessagingMessageService(manager);
  const forbidden = () => {
    throw new Error('Unrelated matching/contact/queue path must not run');
  };
  const participants = new MessagingMessageParticipantService(manager, {
    matchParticipants: forbidden,
  } as unknown as ConstructorParameters<
    typeof MessagingMessageParticipantService
  >[1]);
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    { add: forbidden } as unknown as ConstructorParameters<
      typeof MessagingSaveMessagesAndEnqueueContactCreationService
    >[0],
    messages,
    participants,
    {
      saveMessageFolderAssociations: forbidden,
    } as unknown as ConstructorParameters<
      typeof MessagingSaveMessagesAndEnqueueContactCreationService
    >[3],
    manager,
    runtime,
  );
  const coreInsert = async (
    table: string,
    fields: Record<string, unknown>,
  ): Promise<string> => {
    const row = { id: randomUUID(), ...fields };
    const keys = Object.keys(row);
    const result: { id: string }[] = await native.owner.query(
      `INSERT INTO core."${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
      Object.values(row),
    );
    return result[0].id;
  };
  const initialize = async () => {
    await native.initialize();
    await native.owner.query(
      'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD "archivedAt" timestamptz, ADD "applicationId" uuid, ADD "connectionProviderId" uuid',
    );
    await native.owner.query(
      'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid',
    );
    await native.owner.query(
      `GRANT INSERT, UPDATE ON core."omniIncomingReceipt" TO "${native.roleName}"`,
    );
    await native.owner.query(
      `GRANT INSERT ON core."omniMessageLink", core."omniMessageRevision", core."omniDomainEvent", core."omniRootExecution", core."omniEventDispatchPlan", core."omniReplyBudget" TO "${native.roleName}"`,
    );
    await native.owner.query(
      `GRANT INSERT, UPDATE ON core."omniConversation" TO "${native.roleName}"`,
    );
    await native.owner.query(
      `GRANT UPDATE ("currentRevisionId") ON core."omniMessageLink" TO "${native.roleName}"`,
    );
    for (const table of [
      'omniWorkspacePolicyState',
      'omniAccountBinding',
      'omniAutomationPolicy',
      'omniExternalIdentity',
      'omniQueue',
      'connectedAccount',
      'messageChannel',
      'omniRootExecution',
      'omniEventDispatchPlan',
    ]) {
      await native.owner.query(
        `GRANT UPDATE (id) ON core."${table}" TO "${native.roleName}"`,
      );
    }
    await runtime.initialize();
  };
  const reset = async (options: { withoutConversation?: boolean } = {}) => {
    await native.reset();
    await native.owner.query(
      'TRUNCATE core.workspace, core."connectedAccount", core."messageChannel" CASCADE',
    );
    await native.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      native.workspaceId,
    ]);
    await coreInsert('omniWorkspacePolicyState', {
      workspaceId: native.workspaceId,
    });
    const connectedAccountId = await coreInsert('connectedAccount', {
      workspaceId: native.workspaceId,
      applicationId: null,
      connectionProviderId: null,
    });
    const channelId = await coreInsert('messageChannel', {
      workspaceId: native.workspaceId,
      type: 'APP',
      connectedAccountId,
    });
    const bindingId = await coreInsert('omniAccountBinding', {
      workspaceId: native.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'history-fixture',
      accountId: randomUUID(),
      connectedAccountId,
      messageChannelId: channelId,
      capabilitiesVersion: 'fixture-v1',
      capabilities: '{}',
    });
    const queueId = await coreInsert('omniQueue', {
      workspaceId: native.workspaceId,
      bindingId,
      name: 'Explicit fixture queue grant',
      active: true,
    });
    await native.owner.query(
      `UPDATE core."omniAccountBinding" SET status='active',"defaultQueueId"=$1 WHERE id=$2`,
      [queueId, bindingId],
    );
    const policyId = await coreInsert('omniAutomationPolicy', {
      workspaceId: native.workspaceId,
      bindingId,
    });
    const settings = {
      enabled: false,
      maxReplies: 0,
      maxCrmEffects: 0,
      maxHops: 0,
    };
    await coreInsert('omniAutomationPolicyVersion', {
      workspaceId: native.workspaceId,
      policyId,
      version: '0',
      settings: JSON.stringify(settings),
      settingsHash: auditPayloadHash(settings),
      publishedBy: '{"kind":"system","id":"fixture"}',
      publishedAt: new Date(),
    });
    await native.owner.query(
      'UPDATE core."omniAutomationPolicy" SET "currentVersion"=0 WHERE id=$1',
      [policyId],
    );
    const personId = randomUUID();
    const threadId = randomUUID();
    await native.dataSource.transaction(
      async (scope) => {
        await scope
          .getRepository('person', { shouldBypassPermissionChecks: true })
          .insert({
            id: personId,
            name: { firstName: 'Bound', lastName: 'Person' },
          });
        if (!options.withoutConversation)
          await scope
            .getRepository('messageThread', {
              shouldBypassPermissionChecks: true,
            })
            .insert({ id: threadId, subject: 'Existing conversation title' });
      },
      { commitOutcome: 'strict' },
    );
    const conversationId = options.withoutConversation
      ? randomUUID()
      : await coreInsert('omniConversation', {
          workspaceId: native.workspaceId,
          bindingId,
          providerChatId: 'history-chat',
          messageThreadId: threadId,
          queueId,
          policyId,
          policyVersion: '0',
          mode: 'human',
        });
    const externalIdentityId = await coreInsert('omniExternalIdentity', {
      workspaceId: native.workspaceId,
      bindingId,
      providerPeerId: 'history-author',
      personId,
      verificationSource: 'fixture-confirmed',
    });
    const principal: OmniIncomingPrincipal = {
      workspaceId: native.workspaceId,
      bindingId,
      actor: { kind: 'system', id: 'fixture-history-worker' },
    };
    native.eventEmitter.mockClear();
    return {
      connectedAccountId,
      channelId,
      bindingId,
      queueId,
      policyId,
      personId,
      threadId,
      conversationId,
      externalIdentityId,
      principal,
    };
  };
  const capture = async (
    context: Awaited<ReturnType<typeof reset>>,
    changes: Record<string, unknown> = {},
    origin: 'history_import' | 'live' | null = 'history_import',
    deliveries = 1,
  ) => {
    const envelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      accountBindingId: context.bindingId,
      routeGeneration: '1',
      kind: 'message.received',
      providerChatId: 'history-chat',
      providerMessageId: 'history-message',
      direction: 'incoming',
      sourceVariant: 'complete',
      nativeMessageKeyVersion: 1,
      occurredAt: '2026-10-26T12:00:00.000Z',
      sourcePosition: { type: 'journal', value: '12' },
      payload: {
        text: 'Private imported body',
        sourceAuthorId: 'history-author',
        sourceDisplayName: 'Captured author',
      },
      ...changes,
    };
    const captureContext = {
      schemaVersion: 1,
      envelopeHash: auditPayloadHash(envelope),
      origin,
      qualification: { adapterId: 'fixture-history', adapterVersion: '1' },
      nativeMessageKeyVersion: 1,
      nativeMessageKey: `history:v1:${envelope.providerMessageId}`,
      sourceVariant: envelope.sourceVariant,
      sourcePosition: envelope.sourcePosition,
    };
    const deliveryResults = await Promise.all(
      Array.from({ length: deliveries }, () =>
        acceptOmniIncomingEvent(
          runtime,
          context.principal,
          envelope,
          async () => undefined,
          origin === null
            ? undefined
            : { context: captureContext, authorize: async () => undefined },
        ),
      ),
    );
    const accepted = deliveryResults[0];
    const claims = await claimOmniIncomingReceipts(
      runtime,
      context.principal,
      { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
      async () => undefined,
    );
    if (claims.length !== 1 || claims[0].receiptId !== accepted.receiptId)
      throw new Error('Fixture did not claim accepted receipt');
    const { receiptId, leaseOwner, leaseToken, routeGeneration } = claims[0];
    return {
      envelope,
      captureContext,
      accepted,
      deliveryResults,
      proof: {
        receiptId,
        leaseOwner,
        leaseToken,
        routeGeneration,
        externalIdentityId: context.externalIdentityId,
      },
    };
  };
  const authorizeFor =
    (
      context: Awaited<ReturnType<typeof reset>>,
      options: { allowNewConversation?: boolean } = {},
    ): OmniHistoryApplyAuthorizer =>
    async (_scope, request) => {
      // Synthetic explicit grant/qualification only; this does not implement ROB-766 policy.
      if (
        request.workspaceId !== native.workspaceId ||
        request.bindingId !== context.bindingId ||
        (!options.allowNewConversation &&
          request.conversationId !== context.conversationId) ||
        request.envelope.providerChatId !== 'history-chat' ||
        request.queueId !== context.queueId ||
        request.externalIdentityId !== context.externalIdentityId ||
        request.personId !== context.personId ||
        request.verificationSource !== 'fixture-confirmed' ||
        request.providerPeerId !== request.envelope.payload.sourceAuthorId ||
        request.captureContext.origin !== 'history_import' ||
        request.captureContext.qualification.adapterId !== 'fixture-history' ||
        request.captureContext.qualification.adapterVersion !== '1'
      )
        throw new Error('FIXTURE_HISTORY_AUTHORIZATION_DENIED');
    };
  const dispose = async () => {
    if (runtime.isInitialized) await runtime.destroy();
    await native.dispose();
  };
  return {
    ...native,
    runtime,
    manager,
    messages,
    participants,
    service,
    coreInsert,
    initialize,
    reset,
    capture,
    authorizeFor,
    dispose,
  };
};
