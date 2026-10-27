import { randomUUID } from 'node:crypto';

import { MessageParticipantRole } from 'twenty-shared/types';

import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
// Only the unused metadata-delete branch references this entity; DDL stays real.
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({
    IndexMetadataEntity: class {},
  }),
);

const fixture = createOmniNativeMessageFixture();
const channelId = randomUUID();
const bindingId = randomUUID();
const conversationId = randomUUID();
let personId: string;
let threadId: string;

// Only context loading is substituted; all native repositories and SQL are real.
const manager = {
  executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
    work(),
} as unknown as WorkspaceOrmManager;
const messages = new MessagingMessageService(manager);
const participants = new MessagingMessageParticipantService(manager, {
  matchParticipants: () => {
    throw new Error('Email matcher must not run in this fixture');
  },
} as unknown as MatchParticipantService<MessageParticipantWorkspaceEntity>);
const incoming = (
  externalId = 'incoming-1',
  chatId = 'chat-1',
): MessageWithParticipants => ({
  externalId,
  headerMessageId: `omni:v1:telegram:${bindingId}:${externalId}`,
  messageThreadExternalId: chatId,
  subject: 'private-subject-fixture',
  text: 'private-body-fixture',
  receivedAt: new Date('2026-10-27T00:00:00.000Z'),
  isDraft: false,
  direction: MessageDirection.INCOMING,
  attachments: [],
  participants: [
    {
      role: MessageParticipantRole.FROM,
      handle: 'telegram:fixture-client',
      displayName: 'Fixture client',
      personId,
    },
  ],
});
const save = async (
  scope: WorkspaceTransactionScope,
  batch = [incoming()],
  map = new Map([['chat-1', threadId]]),
) => {
  const result = await messages.saveMessagesWithinTransaction(
    batch,
    channelId,
    scope,
    fixture.workspaceId,
    { canonicalThreadIdByThreadExternalId: map },
  );
  const participantInputs = batch.flatMap((message) => {
    const messageId = result.messageExternalIdsAndIdsMap.get(
      message.externalId,
    );

    if (!messageId) throw new Error('Missing canonical message result');

    return message.participants.map((participant) => {
      if (
        typeof participant.handle !== 'string' ||
        typeof participant.displayName !== 'string'
      ) {
        throw new Error(
          'Native fixture participants require handle and display name',
        );
      }

      return {
        ...participant,
        handle: participant.handle,
        displayName: participant.displayName,
        messageId,
      };
    });
  });

  await participants.saveMessageParticipants(
    participantInputs,
    fixture.workspaceId,
    scope,
  );

  return result;
};
const writeAudit = async (
  scope: WorkspaceTransactionScope,
  messageId: string,
) => {
  const message = incoming();
  const audit = new CrmAuditTransactionContext(
    createCrmAuditWorkspaceExecutor(scope),
    {
      workspaceId: fixture.workspaceId,
      operationId: randomUUID(),
      actor: { kind: 'system', id: 'native-message-fixture' },
    },
  );

  audit.record({
    resourceKind: 'omniMessage',
    resourceId: messageId,
    action: 'create',
    before: null,
    after: {
      text: message.text,
      subject: message.subject,
      headerMessageId: message.headerMessageId,
      messageThreadId: threadId,
      isDraft: false,
    },
    securityDescriptor: {
      resourceKind: 'omniMessage',
      resourceId: messageId,
      bindingId,
      conversationId,
    },
  });
  await audit.flush();
};
const transaction = <T>(
  work: (scope: WorkspaceTransactionScope) => Promise<T>,
) =>
  fixture.dataSource.transaction(
    (scope) => work(withOmniRepositoryOptions(scope)),
    { commitOutcome: 'strict' },
  );
const auditRows = () =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry"');

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  await fixture.reset();
  personId = randomUUID();
  threadId = randomUUID();
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}".person (id,"nameFirstName","nameLastName") VALUES ($1,'Fixture','Client')`,
    [personId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('canonical native Message persistence on PostgreSQL', () => {
  it('commits native messages, participant Person links and audit on the same connection without raw events', async () => {
    let savedMessageId: string | undefined;

    await transaction(async (scope) => {
      const result = await save(scope);

      savedMessageId = result.messageExternalIdsAndIdsMap.get('incoming-1');
      if (!savedMessageId) throw new Error('Missing message');
      await writeAudit(scope, savedMessageId);
      expect(await fixture.read('message')).toEqual([]);
      expect(await fixture.read('messageParticipant')).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    const storedMessages = await fixture.read('message');
    const storedParticipants = await fixture.read('messageParticipant');
    const audits = await auditRows();

    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]).toMatchObject({
      id: savedMessageId,
      messageThreadId: threadId,
      text: 'private-body-fixture',
    });
    expect(storedParticipants).toHaveLength(1);
    expect(storedParticipants[0]).toMatchObject({
      messageId: savedMessageId,
      personId,
    });
    expect(await fixture.read('messageThread')).toHaveLength(1);
    expect(await fixture.read('messageChannelMessageAssociation')).toHaveLength(
      1,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      resourceKind: 'omniMessage',
      resourceId: savedMessageId,
      outcome: 'success',
    });
    expect(JSON.stringify(audits)).not.toContain('private-body-fixture');
    expect(JSON.stringify(audits)).not.toContain('private-subject-fixture');
    const nativeRead = await transaction((scope) =>
      scope
        .getRepository('messageParticipant', {
          shouldBypassPermissionChecks: true,
        })
        .find({ relations: { person: true, message: true } }),
    );

    expect(nativeRead).toHaveLength(1);
    expect(nativeRead[0]).toMatchObject({
      person: { id: personId },
      message: { id: savedMessageId, messageThreadId: threadId },
    });
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('rejects an unresolved Person link through the actual native foreign key and rolls back the message', async () => {
    const message = incoming();

    message.participants[0].personId = randomUUID();
    await expect(
      transaction((scope) => save(scope, [message])),
    ).rejects.toThrow();
    expect(await fixture.read('message')).toEqual([]);
    expect(await fixture.read('messageThread')).toEqual([]);
    expect(await fixture.read('messageParticipant')).toEqual([]);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('leaves ordinary native events enabled and defers them until COMMIT', async () => {
    await fixture.dataSource.transaction(
      async (scope) => {
        await messages.saveMessagesWithinTransaction(
          [incoming()],
          channelId,
          scope,
          fixture.workspaceId,
        );
        expect(fixture.eventEmitter).not.toHaveBeenCalled();
      },
      { commitOutcome: 'strict' },
    );

    expect(fixture.eventEmitter).toHaveBeenCalled();
    expect(
      fixture.eventEmitter.mock.calls.some(
        ([event]) =>
          event.objectMetadataNameSingular === 'message' &&
          event.action === 'created',
      ),
    ).toBe(true);
    expect(await fixture.read('message')).toHaveLength(1);
  });

  it('rolls back native rows and success audit together after a later failure', async () => {
    await expect(
      transaction(async (scope) => {
        const result = await save(scope);
        await writeAudit(
          scope,
          result.messageExternalIdsAndIdsMap.get('incoming-1')!,
        );
        throw new Error('fixture failure after audit');
      }),
    ).rejects.toThrow('fixture failure after audit');
    expect(await fixture.read('message')).toEqual([]);
    expect(await fixture.read('messageThread')).toEqual([]);
    expect(await fixture.read('messageParticipant')).toEqual([]);
    expect(await fixture.read('messageChannelMessageAssociation')).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('rolls back native rows when audit insert is refused', async () => {
    await fixture.owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT "reject_native_fixture" CHECK (false)',
    );
    try {
      await expect(
        transaction(async (scope) => {
          const result = await save(scope);
          await writeAudit(
            scope,
            result.messageExternalIdsAndIdsMap.get('incoming-1')!,
          );
        }),
      ).rejects.toThrow();
      expect(await fixture.read('message')).toEqual([]);
      expect(await fixture.read('messageThread')).toEqual([]);
      expect(await fixture.read('messageParticipant')).toEqual([]);
      expect(await auditRows()).toEqual([]);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    } finally {
      await fixture.owner.query(
        'ALTER TABLE crm_audit."crmAuditEntry" DROP CONSTRAINT "reject_native_fixture"',
      );
    }
  });

  it('reuses one canonical thread for two messages and does not duplicate a replay', async () => {
    const batch = [incoming('first'), incoming('second')];
    const first = await transaction((scope) => save(scope, batch));
    const second = await transaction((scope) => save(scope, batch));

    expect(second.messageExternalIdsAndIdsMap).toEqual(
      first.messageExternalIdsAndIdsMap,
    );
    expect(await fixture.read('messageThread')).toHaveLength(1);
    expect(await fixture.read('message')).toHaveLength(2);
    expect(await fixture.read('messageParticipant')).toHaveLength(2);
    expect(await fixture.read('messageChannelMessageAssociation')).toHaveLength(
      2,
    );
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('reuses a preallocated native thread with no previous channel associations', async () => {
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread" (id,subject) VALUES ($1,'Preallocated')`,
      [threadId],
    );
    await transaction((scope) => save(scope));
    const threads = await fixture.read('messageThread');

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: threadId,
      subject: incoming().subject,
    });
  });

  it('rejects a deleted preallocated thread instead of reviving it', async () => {
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread" (id,"deletedAt") VALUES ($1,now())`,
      [threadId],
    );
    await expect(transaction((scope) => save(scope))).rejects.toThrow();
    expect(await fixture.read('message')).toEqual([]);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it.each(['message', 'messageChannelMessageAssociation'] as const)(
    'keeps a deleted old %s while accepting a different new message in the same canonical thread',
    async (tableName) => {
      await transaction((scope) => save(scope, [incoming('old-message')]));
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."${tableName}" SET "deletedAt"=now()`,
      );
      await transaction((scope) => save(scope, [incoming('new-message')]));
      const stored = await fixture.read('message');

      expect(stored).toHaveLength(2);
      const historicalRows = await fixture.read(tableName);

      expect(
        historicalRows.filter(
          (row: { deletedAt: Date | null }) => row.deletedAt !== null,
        ),
      ).toHaveLength(1);
      expect(
        stored.every(
          (message: { messageThreadId: string }) =>
            message.messageThreadId === threadId,
        ),
      ).toBe(true);
      expect(await fixture.read('messageThread')).toHaveLength(1);
      expect(
        await fixture.read('messageChannelMessageAssociation'),
      ).toHaveLength(2);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  it.each(['message', 'messageChannelMessageAssociation'] as const)(
    'rejects replay of the current deleted %s without restoring its tombstone',
    async (tableName) => {
      await transaction((scope) => save(scope));
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."${tableName}" SET "deletedAt"=now()`,
      );
      const before = await fixture.read(tableName);

      await expect(transaction((scope) => save(scope))).rejects.toThrow();
      expect(await fixture.read(tableName)).toEqual(before);
      expect(await fixture.read('message')).toHaveLength(1);
      expect(await fixture.read('messageThread')).toHaveLength(1);
      expect(
        await fixture.read('messageChannelMessageAssociation'),
      ).toHaveLength(1);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'extra', 'duplicate-target'] as const)(
    'rejects %s canonical mapping before writes',
    async (kind) => {
      const batch =
        kind === 'duplicate-target'
          ? [incoming('first', 'chat-1'), incoming('second', 'chat-2')]
          : [incoming()];
      const map =
        kind === 'missing'
          ? new Map<string, string>()
          : new Map([
              ['chat-1', threadId],
              ['chat-2', threadId],
            ]);

      await expect(
        transaction((scope) => save(scope, batch, map)),
      ).rejects.toThrow();
      expect(await fixture.read('message')).toEqual([]);
      expect(await fixture.read('messageThread')).toEqual([]);
    },
  );

  it('rejects an existing header/association bound to another canonical thread', async () => {
    await transaction((scope) => save(scope));
    const previous = await fixture.read('message');
    threadId = randomUUID();
    await expect(transaction((scope) => save(scope))).rejects.toThrow();
    expect(await fixture.read('message')).toEqual(previous);
    expect(await fixture.read('messageThread')).toHaveLength(1);
  });

  it.each(['header', 'direction'] as const)(
    'rejects a conflicting %s for the same channel external message',
    async (kind) => {
      await transaction((scope) => save(scope));
      const message = incoming();

      if (kind === 'header') message.headerMessageId = 'different-header';
      else message.direction = MessageDirection.OUTGOING;
      await expect(
        transaction((scope) => save(scope, [message])),
      ).rejects.toThrow();
      expect(await fixture.read('message')).toHaveLength(1);
      expect(
        await fixture.read('messageChannelMessageAssociation'),
      ).toHaveLength(1);
    },
  );

  it('snapshots canonical IDs before the first asynchronous repository read', async () => {
    const expectedThreadId = threadId;
    const map = new Map([['chat-1', expectedThreadId]]);
    const batch = [incoming()];

    await transaction(async (scope) => {
      const pending = messages.saveMessagesWithinTransaction(
        batch,
        channelId,
        scope,
        fixture.workspaceId,
        { canonicalThreadIdByThreadExternalId: map },
      );

      map.set('chat-1', randomUUID());
      batch[0].text = 'mutated after invocation';
      await pending;
    });
    expect((await fixture.read('message'))[0]).toMatchObject({
      messageThreadId: expectedThreadId,
      text: 'private-body-fixture',
    });
  });
});
