import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-shared/application-runtime';
import { deleteNativeWorkspaceMemberWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-workspace-member-with-audit';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  additionalTables: Object.keys(STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS),
});
const id = randomUUID(),
  otherId = randomUUID(),
  userId = randomUUID();
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'coreUser', id: randomUUID() },
  correlationId: randomUUID(),
});
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const insert = async (name: string, values: Record<string, unknown> = {}) => {
  const recordId = randomUUID();
  const data = { id: recordId, ...values };
  await f.owner.query(
    'INSERT INTO ' +
      quote(f.schemaName) +
      '.' +
      quote(name) +
      '(' +
      Object.keys(data).map(quote).join(',') +
      ') VALUES(' +
      Object.keys(data)
        .map((_, i) => '$' + (i + 1))
        .join(',') +
      ')',
    Object.values(data),
  );
  return String(data.id);
};
const run = async (
  identity: CrmAuditOperation | undefined = operation(),
  target = id,
  targetUser = userId,
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteNativeWorkspaceMemberWithAudit({
          scope,
          workspaceMemberId: target,
          userId: targetUser,
          operation: identity,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const audits = () => f.owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
const nativeTable = (name: string) => quote(f.schemaName) + '.' + quote(name);
beforeAll(() => f.initialize(), 60000);
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await f.reset();
  await insert('workspaceMember', {
    id,
    userId,
    nameFirstName: 'Private manager',
  });
  await insert('workspaceMember', {
    id: otherId,
    userId: randomUUID(),
    nameFirstName: 'Other',
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await f.dispose();
});
it('audits private member deletion with trusted attribution and redacted values', async () => {
  const identity = operation();
  expect(await run(identity)).toBe(true);
  expect(
    (await f.read('workspaceMember')).map((r: { id: string }) => r.id),
  ).toEqual([otherId]);
  const rows = await audits();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: identity.actor,
    correlationId: identity.correlationId,
    resourceKind: 'crmRecord',
    resourceId: id,
    action: 'delete',
  });
  expect(rows[0].operationId).not.toBe(identity.operationId);
  expect(JSON.stringify(rows)).not.toContain('Private manager');
});
it('missing member is a no-op while a rebound target is refused', async () => {
  await expect(run(operation(), id, randomUUID())).rejects.toThrow(
    'changed user',
  );
  expect(await f.read('workspaceMember')).toHaveLength(2);
  expect(await run(operation(), randomUUID())).toBe(false);
  expect(await audits()).toEqual([]);
});
it('journal denial does not restore the deleted member', async () => {
  await f.owner.query(
    'REVOKE INSERT ON crm_audit."crmAuditEntry" FROM ' + quote(f.roleName),
  );
  try {
    expect(await run()).toBe(true);
    expect(await audits()).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'NATIVE_MEMBER_DELETION_AUDIT_UNAVAILABLE',
    );
  } finally {
    await f.owner.query(
      'GRANT INSERT ON crm_audit."crmAuditEntry" TO ' + quote(f.roleName),
    );
  }
  expect(await f.read('workspaceMember')).toHaveLength(1);
});
it('captures the complete standard CASCADE and SET NULL graph', async () => {
  const company = await insert('company', { accountOwnerId: id });
  const opportunity = await insert('opportunity', { ownerId: id });
  const task = await insert('task', { assigneeId: id });
  const thread = await insert('messageThread');
  const message = await insert('message', { messageThreadId: thread });
  const participant = await insert('messageParticipant', {
    messageId: message,
    workspaceMemberId: id,
  });
  const calendar = await insert('calendarEvent');
  const calendarParticipant = await insert('calendarEventParticipant', {
    calendarEventId: calendar,
    workspaceMemberId: id,
  });
  const ownedThread = await insert('agentChatThread', {
    workspaceMemberId: id,
  });
  const retainedThread = await insert('agentChatThread', {
    workspaceMemberId: otherId,
    assigneeId: id,
  });
  const turn = await insert('agentTurn', { threadId: ownedThread });
  const ownedMessage = await insert('agentMessage', {
    role: 'user',
    threadId: ownedThread,
    senderWorkspaceMemberId: id,
    turnId: turn,
  });
  const retainedMessage = await insert('agentMessage', {
    role: 'user',
    threadId: retainedThread,
    senderWorkspaceMemberId: id,
  });
  const part = await insert('agentMessagePart', {
    orderIndex: 0,
    type: 'text',
    messageId: ownedMessage,
  });
  const reaction = await insert('agentMessageReaction', {
    emoji: 'ok',
    messageId: ownedMessage,
    workspaceMemberId: id,
  });
  const threadParticipant = await insert('agentChatThreadParticipant', {
    threadId: ownedThread,
    workspaceMemberId: id,
  });
  const target = await insert('agentChatThreadTarget', {
    threadId: ownedThread,
  });
  const attachment = await insert('attachment', {
    targetAgentChatThreadId: ownedThread,
  });
  const blocklist = await insert('blocklist', { workspaceMemberId: id });
  const timeline = await insert('timelineActivity', { workspaceMemberId: id });
  const deleted = [
    id,
    ownedThread,
    turn,
    ownedMessage,
    part,
    reaction,
    threadParticipant,
    target,
    attachment,
    blocklist,
    timeline,
  ];
  const updated = [
    company,
    opportunity,
    task,
    participant,
    calendarParticipant,
    retainedThread,
    retainedMessage,
  ];
  await run();
  const rows = await audits();
  expect(
    rows
      .filter((r: { action: string }) => r.action === 'delete')
      .map((r: { resourceId: string }) => r.resourceId)
      .sort(),
  ).toEqual(deleted.sort());
  expect(
    rows
      .filter((r: { action: string }) => r.action === 'update')
      .map((r: { resourceId: string }) => r.resourceId)
      .sort(),
  ).toEqual(updated.sort());
  expect(
    new Set(rows.map((r: { operationId: string }) => r.operationId)).size,
  ).toBe(1);
  expect(
    (await f.read('agentMessage')).map((r: { id: string }) => r.id),
  ).toEqual([retainedMessage]);
});
it('rejects wrong standard member identity without widening ordinary native metadata', async () => {
  await f.withContext(async () => {
    const metadata =
      getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember
      ]!;
    const previous = metadata.isSystem;
    metadata.isSystem = false;
    try {
      await expect(run()).rejects.toThrow('exact standard metadata');
    } finally {
      metadata.isSystem = previous;
    }
  });
  expect(await f.read('workspaceMember')).toHaveLength(2);
});
it('refuses transitive UPDATE effects even when their parent will also be deleted', async () => {
  const threadId = await insert('agentChatThread', { workspaceMemberId: id });
  const messageId = await insert('agentMessage', {
    role: 'user',
    threadId,
    senderWorkspaceMemberId: id,
  });
  const parent = nativeTable('agentMessage'),
    child = nativeTable('mixedPath');
  await f.owner.query(
    'ALTER TABLE ' +
      parent +
      ' ADD CONSTRAINT mixed_path_unique UNIQUE(id,"senderWorkspaceMemberId")',
  );
  await f.owner.query(
    'CREATE TABLE ' +
      child +
      ' (id uuid PRIMARY KEY, "messageId" uuid, "memberId" uuid, FOREIGN KEY("messageId","memberId") REFERENCES ' +
      parent +
      '(id,"senderWorkspaceMemberId") ON UPDATE CASCADE ON DELETE NO ACTION)',
  );
  await f.owner.query('GRANT SELECT ON ' + child + ' TO ' + quote(f.roleName));
  try {
    await insert('mixedPath', { messageId, memberId: id });
    await expect(run()).rejects.toThrow('transitive update effects');
    expect(await f.read('workspaceMember')).toHaveLength(2);
    expect(await f.read('agentMessage')).toHaveLength(1);
    expect((await f.owner.query('SELECT * FROM ' + child))[0].memberId).toBe(
      id,
    );
    expect(await audits()).toEqual([]);
  } finally {
    await f.owner.query('DROP TABLE ' + child);
    await f.owner.query(
      'ALTER TABLE ' + parent + ' DROP CONSTRAINT mixed_path_unique',
    );
  }
});
it.each(['shared', 'copied', 'foreign-operation'] as const)(
  'refuses an invalid private transaction boundary: %s',
  async (kind) => {
    await expect(
      f.withContext(() =>
        f.dataSource.transaction(
          (scope) =>
            deleteNativeWorkspaceMemberWithAudit({
              scope: kind === 'copied' ? { ...scope } : scope,
              workspaceMemberId: id,
              userId,
              operation: {
                ...operation(),
                ...(kind === 'foreign-operation'
                  ? { workspaceId: randomUUID() }
                  : {}),
              },
            }),
          {
            commitOutcome: 'strict',
            nativeOwnershipLock: kind === 'shared' ? 'shared' : 'exclusive',
          },
        ),
      ),
    ).rejects.toThrow();
    expect(await f.read('workspaceMember')).toHaveLength(2);
    expect(await audits()).toEqual([]);
  },
);
it('an unavailable identity still removes access and reports unavailable audit', async () => {
  await f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteNativeWorkspaceMemberWithAudit({
          scope,
          workspaceMemberId: id,
          userId,
          operation: undefined,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  expect(await f.read('workspaceMember')).toHaveLength(1);
  expect(await audits()).toEqual([]);
  expect(Logger.prototype.error).toHaveBeenCalledWith(
    'NATIVE_MEMBER_DELETION_AUDIT_UNAVAILABLE',
  );
});
it.each(['deletion', 'journal'] as const)(
  'checks actual dependent rows after %s triggers',
  async (phase) => {
    const companyId = await insert('company', {
      accountOwnerId: id,
      name: 'Original',
    });
    const triggerTable =
      phase === 'journal'
        ? 'crm_audit."crmAuditEntry"'
        : nativeTable('workspaceMember');
    const fn = nativeTable('corrupt_child');
    await f.owner.query(
      'CREATE FUNCTION ' +
        fn +
        '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE ' +
        nativeTable('company') +
        " SET name='Corrupted' WHERE id='" +
        companyId +
        "'; RETURN NULL; END $$",
    );
    await f.owner.query(
      'CREATE TRIGGER corrupt_child AFTER ' +
        (phase === 'journal' ? 'INSERT' : 'DELETE') +
        ' ON ' +
        triggerTable +
        ' FOR EACH ROW EXECUTE FUNCTION ' +
        fn +
        '()',
    );
    try {
      if (phase === 'deletion')
        await expect(run()).rejects.toThrow('update effects mismatch');
      else expect(await run()).toBe(true);
      expect(await f.read('workspaceMember')).toHaveLength(
        phase === 'deletion' ? 2 : 1,
      );
      expect((await f.read('company'))[0]).toMatchObject({
        name: 'Original',
        accountOwnerId: phase === 'deletion' ? id : null,
      });
      expect(await audits()).toEqual([]);
    } finally {
      await f.owner.query('DROP TRIGGER corrupt_child ON ' + triggerTable);
      await f.owner.query('DROP FUNCTION ' + fn + '()');
    }
  },
);
const waitForLock = async (pid?: number) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const rows = await f.owner.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND " +
        (pid ? 'pid=$1' : 'usename=$1'),
      [pid ?? f.roleName],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected PostgreSQL lock wait');
};
it.each(['insert', 'reparent'] as const)(
  'captures child %s committed before the member lock',
  async (kind) => {
    const childId =
      kind === 'reparent'
        ? await insert('company', { accountOwnerId: otherId })
        : randomUUID();
    const writer = f.owner.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      if (kind === 'insert')
        await writer.query(
          'INSERT INTO ' +
            nativeTable('company') +
            '(id,"accountOwnerId") VALUES($1,$2)',
          [childId, id],
        );
      else
        await writer.query(
          'UPDATE ' +
            nativeTable('company') +
            ' SET "accountOwnerId"=$1 WHERE id=$2',
          [id, childId],
        );
      pending = run().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForLock();
      await writer.commitTransaction();
      expect(await pending).toEqual({ value: true });
      expect((await f.read('company'))[0].accountOwnerId).toBeNull();
      expect(
        (await audits())
          .map((row: { resourceId: string }) => row.resourceId)
          .sort(),
      ).toEqual([id, childId].sort());
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await pending;
      await writer.release();
    }
  },
);
it('rechecks a child moved away while cleanup waits for its row lock', async () => {
  const childId = await insert('company', { accountOwnerId: id });
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query(
      'UPDATE ' +
        nativeTable('company') +
        ' SET "accountOwnerId"=$1 WHERE id=$2',
      [otherId, childId],
    );
    pending = run().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForLock();
    await writer.commitTransaction();
    expect(await pending).toEqual({ value: true });
    expect((await f.read('company'))[0].accountOwnerId).toBe(otherId);
    expect(await audits()).toHaveLength(1);
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await pending;
    await writer.release();
  }
});
it.each(['insert', 'reparent'] as const)(
  'member deletion rejects a later child %s at its real FK fence',
  async (kind) => {
    const childId =
      kind === 'reparent'
        ? await insert('company', { accountOwnerId: otherId })
        : randomUUID();
    const writer = f.owner.createQueryRunner();
    await writer.connect();
    const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');
    let release!: () => void, locked!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const identity = operation(),
      originalActor = { ...identity.actor };
    const removal = Promise.resolve(
      f.withContext(() =>
        f.dataSource.transaction(
          async (scope) => {
            const query = scope.executeRawQuery.bind(scope);
            scope.executeRawQuery = async (text, values) => {
              const result = await query(text, values);
              if (
                text ===
                'SELECT id FROM ' +
                  nativeTable('workspaceMember') +
                  ' WHERE id=$1 FOR UPDATE'
              ) {
                locked();
                await resume;
              }
              return result;
            };
            return deleteNativeWorkspaceMemberWithAudit({
              scope,
              workspaceMemberId: id,
              userId,
              operation: identity,
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      ),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let pending: Promise<unknown> | undefined;
    try {
      await ready;
      identity.actor.id = randomUUID();
      pending = writer
        .query(
          kind === 'insert'
            ? 'INSERT INTO ' +
                nativeTable('company') +
                '(id,"accountOwnerId") VALUES($1,$2)'
            : 'UPDATE ' +
                nativeTable('company') +
                ' SET "accountOwnerId"=$2 WHERE id=$1',
          [childId, id],
        )
        .then(
          (value) => ({ value }),
          (error) => ({ code: error.code }),
        );
      await waitForLock(pid);
      release();
      expect(await removal).toEqual({ value: true });
      expect(await pending).toEqual({ code: '23503' });
      expect((await audits())[0].actor).toEqual(originalActor);
    } finally {
      release();
      await removal;
      await pending;
      await writer.release();
    }
  },
);
it('reports actual lost COMMIT acknowledgement without retry or false callbacks', async () => {
  const client = await f.pool.connect(),
    query = client.query.bind(client);
  let commits = 0;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const result = await query(statement as string, values);
    if (text === 'COMMIT') {
      commits++;
      throw new Error('lost ack');
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(run()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(commits).toBe(1);
  expect(await f.read('workspaceMember')).toHaveLength(1);
  expect(await audits()).toHaveLength(1);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});
