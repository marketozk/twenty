import { randomUUID } from 'node:crypto';

import { BlocklistScope, MessageParticipantRole } from 'twenty-shared/types';
import { DataSource, EntitySchema } from 'typeorm';

import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceTransactionOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { BlocklistItemDeleteMessagesJob } from 'src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-item-delete-messages.job';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';
import { MessagingDeleteFolderMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-delete-folder-messages.service';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';

type CleanupAccount = { id: string; handleAliases: string[] };
type CleanupChannel = {
  id: string;
  workspaceId: string;
  type: string;
  handle: string;
  connectedAccountId: string | null;
  connectedAccount: CleanupAccount | null;
};

const accountSchema = new EntitySchema<CleanupAccount>({
  name: 'CleanupAccount',
  tableName: 'connectedAccount',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    handleAliases: { type: 'text', array: true },
  },
});
const channelSchema = new EntitySchema<CleanupChannel>({
  name: 'CleanupChannel',
  tableName: 'messageChannel',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    type: { type: 'text' },
    handle: { type: 'text' },
    connectedAccountId: { type: 'uuid' },
  },
  relations: {
    connectedAccount: {
      type: 'many-to-one',
      target: 'CleanupAccount',
      joinColumn: { name: 'connectedAccountId' },
    },
  },
});
const permissions = { shouldBypassPermissionChecks: true } as const;
export type CleanupMarker = 'binding' | 'link' | 'conversation';

export const createOmniNativeCleanupFixture = () => {
  const native = createOmniNativeMessageFixture({
    coreSchema: 'fork',
    useStandardForeignKeyActions: true,
    additionalTables: [
      'workspaceMember',
      'company',
      'opportunity',
      'messageThreadTarget',
      'messageCampaign',
      'blocklist',
      'messageChannelMessageAssociationMessageFolder',
    ],
  });
  const coreReader = new DataSource({
    type: 'postgres',
    url: native.runtimeDatabaseUrl,
    entities: [accountSchema, channelSchema],
    synchronize: false,
    migrationsRun: false,
    extra: { max: 2, statement_timeout: 10000 },
  });
  // Only DI/context loading is substituted; all cleanup algorithms and SQL repositories are real.
  const manager = {
    getWorkspaceId: () => getWorkspaceContext().authContext.workspace.id,
    executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
      native.withContext(work),
    runInWorkspaceTransaction: async <T>(
      work: (scope: WorkspaceTransactionScope) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> => native.dataSource.transaction(work, options),
    getRepository: (name: string, options?: RolePermissionConfig) =>
      native.dataSource.getRepository(name, options),
  } as unknown as WorkspaceOrmManager;
  const targets = new ParticipantTargetReconciliationService(
    manager,
    coreReader,
  );
  const cleaner = new MessagingMessageCleanerService(manager, targets);
  const folders = new MessagingDeleteFolderMessagesService(
    cleaner,
    manager,
    coreReader,
  );
  const blocklist = new BlocklistItemDeleteMessagesJob(
    cleaner,
    manager,
    coreReader.getRepository(channelSchema) as unknown as ConstructorParameters<
      typeof BlocklistItemDeleteMessagesJob
    >[2],
    coreReader.getRepository(accountSchema) as unknown as ConstructorParameters<
      typeof BlocklistItemDeleteMessagesJob
    >[3],
    {
      findOne: () => {
        throw new Error('Unused member-scoped fixture dependency');
      },
    } as unknown as ConstructorParameters<
      typeof BlocklistItemDeleteMessagesJob
    >[4],
    coreReader,
  );
  const run = <T>(work: (scope: WorkspaceTransactionScope) => Promise<T>) =>
    native.withContext(() =>
      native.dataSource.transaction(work, { commitOutcome: 'strict' }),
    );
  // Fixture construction only. Cleanup algorithms still use the unprivileged
  // manager/run above, so these tests exercise their filtering and the ORM guard.
  const seedNative = <T>(
    work: (scope: WorkspaceTransactionScope) => Promise<T>,
  ) =>
    native.withContext(() =>
      native.dataSource.transaction(
        (scope) => work(withOmniRepositoryOptions(scope)),
        { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
      ),
    );
  const coreInsert = async (
    table: string,
    fields: Record<string, unknown>,
  ): Promise<string> => {
    const row = { id: randomUUID(), ...fields };
    const keys = Object.keys(row);
    const result = await native.owner.query(
      `INSERT INTO core."${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
      Object.values(row),
    );
    return result[0].id;
  };
  const initialize = async () => {
    await native.initialize();
    await native.owner.query(
      `GRANT SELECT, UPDATE ("deletedAt") ON core.workspace TO "${native.roleName}"`,
    );
    await native.owner.query(
      `ALTER TABLE core."connectedAccount" ADD "handleAliases" text[] NOT NULL DEFAULT '{}'`,
    );
    await native.owner.query(
      `ALTER TABLE core."messageChannel" ADD handle text NOT NULL DEFAULT 'manager@example.test', ADD "connectedAccountId" uuid`,
    );
    await coreReader.initialize();
  };
  const reset = async () => {
    await native.reset();
    await native.owner.query(
      'TRUNCATE core.workspace, core."connectedAccount", core."messageChannel" CASCADE',
    );
    await native.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      native.workspaceId,
    ]);
  };
  const seed = async (marker: CleanupMarker = 'binding') => {
    const accountId = await coreInsert('connectedAccount', {});
    const channelId = await coreInsert('messageChannel', {
      workspaceId: native.workspaceId,
      type: 'EMAIL',
      connectedAccountId: accountId,
    });
    const protectedChannelId = await coreInsert('messageChannel', {
      workspaceId: native.workspaceId,
      type: 'APP',
      connectedAccountId: accountId,
    });
    const bindingId = await coreInsert('omniAccountBinding', {
      workspaceId: native.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'cleanup-fixture',
      accountId: randomUUID(),
      connectedAccountId: accountId,
      messageChannelId: protectedChannelId,
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
    const folderId = randomUUID();
    const result = await seedNative(async (scope) => {
      const insert = async (name: string, fields: Record<string, unknown>) => {
        const id = randomUUID();
        await scope.getRepository(name, permissions).insert({ id, ...fields });
        return id;
      };
      const personId = await insert('person', {
        name: { firstName: 'Cleanup', lastName: 'Person' },
      });
      const blocklistId = await insert('blocklist', {
        handle: 'client@example.test',
        scope: BlocklistScope.WORKSPACE,
      });
      const createMessage = async (prefix: string) => {
        const threadId = await insert('messageThread', {
          subject: `${prefix} thread`,
        });
        const messageId = await insert('message', {
          messageThreadId: threadId,
          headerMessageId: randomUUID(),
          subject: `${prefix} subject`,
          text: `${prefix} body`,
          receivedAt: new Date('2026-10-27T00:00:00Z'),
          isDraft: false,
        });
        const participantId = await insert('messageParticipant', {
          messageId,
          personId,
          role: MessageParticipantRole.FROM,
          handle: 'client@example.test',
          displayName: 'Client',
        });
        const targetId = await insert('messageThreadTarget', {
          messageThreadId: threadId,
          targetPersonId: personId,
          isAutomaticallyAssigned: true,
          isManuallyAssigned: false,
        });
        const associationId = await insert('messageChannelMessageAssociation', {
          messageId,
          messageChannelId: channelId,
          messageExternalId: prefix,
          messageThreadExternalId: `${prefix}-thread`,
          direction: 'INCOMING',
        });
        const junctionId = await insert(
          'messageChannelMessageAssociationMessageFolder',
          {
            messageChannelMessageAssociationId: associationId,
            messageFolderId: folderId,
          },
        );
        return {
          threadId,
          messageId,
          participantId,
          targetId,
          associationId,
          junctionId,
          externalId: prefix,
        };
      };
      const omni = await createMessage('omni');
      const email = await createMessage('email');
      if (marker === 'binding')
        await insert('messageChannelMessageAssociation', {
          messageId: omni.messageId,
          messageChannelId: protectedChannelId,
          messageExternalId: 'protected',
          messageThreadExternalId: 'protected-thread',
          direction: 'INCOMING',
          deletedAt: new Date(),
        });
      const markerThreadId =
        marker === 'link'
          ? await insert('messageThread', {
              subject: 'Independent link parent',
            })
          : omni.threadId;
      return { omni, email, personId, blocklistId, markerThreadId };
    });
    if (marker !== 'binding') {
      const conversationId = await coreInsert('omniConversation', {
        workspaceId: native.workspaceId,
        bindingId,
        providerChatId: randomUUID(),
        messageThreadId: result.markerThreadId,
        policyId,
        policyVersion: '0',
      });
      if (marker === 'link')
        await coreInsert('omniMessageLink', {
          workspaceId: native.workspaceId,
          bindingId,
          conversationId,
          messageId: result.omni.messageId,
          rawNativeMessageId: randomUUID(),
          nativeMessageKey: randomUUID(),
          nativeMessageKeyVersion: 1,
          displayOccurredAt: new Date(),
          displayTimeSource: 'source',
          immutableAuthorSnapshot: '{}',
          senderProvenance: 'fixture',
          correlationState: 'unresolved',
        });
    }
    native.eventEmitter.mockClear();
    return {
      ...result,
      channelId,
      protectedChannelId,
      bindingId,
      policyId,
      folderId,
    };
  };
  const dispose = async () => {
    if (coreReader.isInitialized) await coreReader.destroy();
    await native.dispose();
  };
  return {
    ...native,
    coreReader,
    manager,
    cleaner,
    folders,
    blocklist,
    run,
    seedNative,
    coreInsert,
    seed,
    initialize,
    reset,
    dispose,
  };
};
