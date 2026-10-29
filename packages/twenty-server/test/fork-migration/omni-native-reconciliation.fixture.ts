import { randomUUID } from 'node:crypto';

import { DataSource, EntitySchema, type Repository } from 'typeorm';

import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import {
  type WorkspaceTransactionScope,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

const channelSchema = new EntitySchema<{
  id: string;
  workspaceId: string;
  type: string;
}>({
  name: 'ReconciliationMessageChannel',
  tableName: 'messageChannel',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    type: { type: 'text' },
  },
});

export const createOmniNativeReconciliationFixture = () => {
  const native = createOmniNativeMessageFixture({
    coreSchema: 'fork',
    additionalTables: [
      'workspaceMember',
      'company',
      'opportunity',
      'messageThreadTarget',
      'calendarEvent',
      'calendarEventParticipant',
      'calendarEventTarget',
      'calendarChannelEventAssociation',
      'callRecording',
    ],
  });
  const coreReader = new DataSource({
    type: 'postgres',
    url: process.env.FORK_MIGRATION_TEST_URL,
    entities: [channelSchema],
    synchronize: false,
    migrationsRun: false,
    extra: { max: 2, statement_timeout: 10000 },
  });
  // Context loading is substituted; matching, reconciliation and every repository remain real.
  const manager = {
    getWorkspaceId: () => getWorkspaceContext().authContext.workspace.id,
    executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
      native.withContext(work),
    runInWorkspaceTransaction: async <T>(
      work: (scope: WorkspaceTransactionScope) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> =>
      native.dataSource.transaction(work, {
        commitOutcome: 'strict',
        ...options,
      }),
    getRepository: (name: string, permissions?: RolePermissionConfig) =>
      native.dataSource.getRepository(name, permissions),
  } as unknown as WorkspaceOrmManager;
  const targets = new ParticipantTargetReconciliationService(
    manager,
    native.owner,
  );
  const matcher =
    new MatchParticipantService<MessageParticipantWorkspaceEntity>(
      manager,
      targets,
      coreReader.getRepository(
        channelSchema,
      ) as unknown as Repository<MessageChannelEntity>,
      native.owner,
    );
  const calendarMatcher =
    new MatchParticipantService<CalendarEventParticipantWorkspaceEntity>(
      manager,
      targets,
      coreReader.getRepository(
        channelSchema,
      ) as unknown as Repository<MessageChannelEntity>,
      native.owner,
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
  const createBinding = async () => {
    const connectedAccountId = await coreInsert('connectedAccount', {});
    const channelId = await coreInsert('messageChannel', {
      workspaceId: native.workspaceId,
      type: 'APP',
    });
    const bindingId = await coreInsert('omniAccountBinding', {
      workspaceId: native.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'fixture',
      accountId: randomUUID(),
      connectedAccountId,
      messageChannelId: channelId,
      capabilitiesVersion: 'fixture-v1',
      capabilities: '{}',
      status: 'disabled',
    });
    const policyId = await coreInsert('omniAutomationPolicy', {
      workspaceId: native.workspaceId,
      bindingId,
    });
    await coreInsert('omniAutomationPolicyVersion', {
      workspaceId: native.workspaceId,
      policyId,
      version: '0',
      settings: '{}',
      settingsHash: 'a'.repeat(64),
      publishedBy: '{"kind":"system","id":"fixture"}',
      publishedAt: new Date(),
    });
    return { bindingId, channelId, policyId };
  };
  const markConversation = (
    binding: Awaited<ReturnType<typeof createBinding>>,
    threadId: string,
  ) =>
    coreInsert('omniConversation', {
      workspaceId: native.workspaceId,
      bindingId: binding.bindingId,
      providerChatId: randomUUID(),
      messageThreadId: threadId,
      policyId: binding.policyId,
      policyVersion: '0',
    });
  const markMessage = (
    binding: Awaited<ReturnType<typeof createBinding>>,
    conversationId: string,
    messageId: string,
  ) =>
    coreInsert('omniMessageLink', {
      workspaceId: native.workspaceId,
      bindingId: binding.bindingId,
      conversationId,
      messageId,
      rawNativeMessageId: randomUUID(),
      nativeMessageKey: randomUUID(),
      nativeMessageKeyVersion: 1,
      displayOccurredAt: new Date(),
      displayTimeSource: 'source',
      immutableAuthorSnapshot: '{}',
      senderProvenance: 'fixture',
      correlationState: 'unresolved',
    });
  const initialize = async () => {
    await native.initialize();
    await native.owner.query(
      `GRANT UPDATE ON core.workspace TO "${native.roleName}"`,
    );
    await coreReader.initialize();
  };
  const reset = async () => {
    await native.reset();
    await native.owner.query(
      'TRUNCATE core."omniAccountBinding", core."connectedAccount", core."messageChannel", core.workspace CASCADE',
    );
    await native.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      native.workspaceId,
    ]);
  };
  const dispose = async () => {
    if (coreReader.isInitialized) await coreReader.destroy();
    await native.dispose();
  };
  return {
    ...native,
    matcher,
    calendarMatcher,
    targets,
    coreInsert,
    createBinding,
    markConversation,
    markMessage,
    initialize,
    reset,
    dispose,
  };
};
