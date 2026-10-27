import { randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';
import {
  captureOrdinaryGroupEmailAction,
  finishOrdinaryGroupEmailAction,
  type OrdinaryGroupEmailAction,
} from 'src/modules/omnichannel/services/ordinary-group-email-action';
import { MessagingProcessGroupEmailActionsService } from 'src/modules/messaging/message-import-manager/services/messaging-process-group-email-actions.service';
import { MessagingDeleteGroupEmailMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-delete-group-email-messages.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeCleanupFixture();
let accountId: string, channelId: string, folderId: string;
let seed: Awaited<ReturnType<typeof fixture.seed>>;
let worker: MessagingProcessGroupEmailActionsService;
let deletion: MessagingDeleteGroupEmailMessagesService;
const channel = async () =>
  (
    await fixture.coreReader.query(
      'SELECT * FROM core."messageChannel" WHERE id=$1',
      [channelId],
    )
  )[0];
const capture = async () => {
  const result = await captureOrdinaryGroupEmailAction(
    fixture.coreReader.manager,
    fixture.workspaceId,
    channelId,
    accountId,
    (await channel()).pendingGroupEmailsAction,
  );
  expect(result).not.toBeNull();
  return result!;
};
const clean = (
  expected: OrdinaryGroupEmailAction,
  ids = [seed.email.externalId],
) =>
  fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans({
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    messageExternalIds: ids,
    groupEmailAction: expected,
  });
const exists = async () =>
  (await fixture.read('message')).some(
    (row: Record<string, string>) => row.id === seed.email.messageId,
  );
const cursor = async () =>
  (
    await fixture.coreReader.query(
      'SELECT "syncCursor" FROM core."messageFolder" WHERE id=$1',
      [folderId],
    )
  )[0].syncCursor;
const change = async (field: string, value: unknown) => {
  if (
    ![
      'connectedAccountId',
      'pendingGroupEmailsAction',
      'excludeGroupEmails',
      'updatedAt',
    ].includes(field)
  )
    throw Error('invalid fixture column');
  await fixture.owner.query(
    `UPDATE core."messageChannel" SET "${field}"=$2 WHERE id=$1`,
    [channelId, value],
  );
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "pendingGroupEmailsAction" text,ADD "excludeGroupEmails" boolean,ADD "syncCursor" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ADD "syncCursor" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON core."connectedAccount",core."messageChannel",core."messageFolder" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  await fixture.reset();
  seed = await fixture.seed('binding');
  accountId = await fixture.coreInsert('connectedAccount', {
    workspaceId: fixture.workspaceId,
    provider: 'google',
    userWorkspaceId: randomUUID(),
  });
  channelId = await fixture.coreInsert('messageChannel', {
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    type: 'EMAIL',
    pendingGroupEmailsAction: 'GROUP_EMAILS_DELETION',
    excludeGroupEmails: true,
    syncCursor: 'channel-before',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
  folderId = await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    syncCursor: 'folder-before',
  });
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$2 WHERE id=$1`,
    [seed.email.associationId, channelId],
  );
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
    [seed.email.junctionId, folderId],
  );
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageParticipant" SET handle='support@example.test' WHERE id=$1`,
    [seed.email.participantId],
  );
  deletion = new MessagingDeleteGroupEmailMessagesService(
    fixture.manager,
    fixture.cleaner,
  );
  worker = new MessagingProcessGroupEmailActionsService(
    { manager: fixture.coreReader.manager } as never,
    deletion,
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());
it('actual worker deletes ordinary group email and atomically finishes its action', async () => {
  expect(
    await worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).toBe(true);
  expect(await exists()).toBe(false);
  expect(await cursor()).toBe('');
  expect(await channel()).toMatchObject({
    syncCursor: '',
    pendingGroupEmailsAction: 'NONE',
  });
  expect(
    (await fixture.read('message')).some(
      (row: Record<string, string>) => row.id === seed.omni.messageId,
    ),
  ).toBe(true);
});
it('IMPORT resets cursors without deleting messages', async () => {
  await change('pendingGroupEmailsAction', 'GROUP_EMAILS_IMPORT');
  await change('excludeGroupEmails', false);
  expect(
    await worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).toBe(true);
  expect(await exists()).toBe(true);
  expect(await cursor()).toBe('');
  expect((await channel()).pendingGroupEmailsAction).toBe('NONE');
});
it.each([
  'connectedAccountId',
  'pendingGroupEmailsAction',
  'excludeGroupEmails',
  'updatedAt',
])('stale %s cancels destructive batch and finalization', async (field) => {
  const expected = await capture();
  await change(
    field,
    field === 'connectedAccountId'
      ? randomUUID()
      : field === 'pendingGroupEmailsAction'
        ? 'GROUP_EMAILS_IMPORT'
        : field === 'excludeGroupEmails'
          ? false
          : '2026-10-28T00:00:00.123457Z',
  );
  expect(await clean(expected)).toBe(false);
  expect(
    await finishOrdinaryGroupEmailAction(fixture.coreReader.manager, expected),
  ).toBe(false);
  expect(await exists()).toBe(true);
  expect(await cursor()).toBe('folder-before');
});
it('stale parent before capture aborts the actual worker', async () => {
  const before = await channel();
  await change('connectedAccountId', randomUUID());
  expect(
    await worker.processGroupEmailActions(before, fixture.workspaceId),
  ).toBe(false);
  expect(await exists()).toBe(true);
  expect(await cursor()).toBe('folder-before');
});
it('action ABA with one microsecond difference never accepts old work', async () => {
  const expected = await capture();
  expect(expected.updatedAt).toBe('2026-10-28T00:00:00.123456Z');
  await change('pendingGroupEmailsAction', 'GROUP_EMAILS_IMPORT');
  await change('pendingGroupEmailsAction', 'GROUP_EMAILS_DELETION');
  await change('updatedAt', '2026-10-28T00:00:00.123457Z');
  expect(await clean(expected)).toBe(false);
  expect(await exists()).toBe(true);
});
it('ordinary settings mismatch cancels capture', async () => {
  await change('excludeGroupEmails', false);
  expect(
    await worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).toBe(false);
  expect(await exists()).toBe(true);
});
it.each(['native', 'retained'])(
  'new %s ownership rejects captured work',
  async (kind) => {
    const expected = await capture();
    if (kind === 'native')
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
        [accountId, 'app'],
      );
    else
      await fixture.owner.query(
        'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$1 WHERE id=$2',
        [accountId, seed.bindingId],
      );
    expect(await clean(expected)).toBe(false);
    expect(
      await finishOrdinaryGroupEmailAction(
        fixture.coreReader.manager,
        expected,
      ),
    ).toBe(false);
    expect(await exists()).toBe(true);
  },
);
it('owned folder junction prevents its cursor reset but ordinary sibling resets', async () => {
  const protectedFolder = await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    syncCursor: 'protected',
  });
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
    [seed.omni.junctionId, protectedFolder],
  );
  const expected = await capture();
  expect(
    await finishOrdinaryGroupEmailAction(fixture.coreReader.manager, expected),
  ).toBe(true);
  expect(await cursor()).toBe('');
  expect(
    (
      await fixture.owner.query(
        'SELECT "syncCursor" FROM core."messageFolder" WHERE id=$1',
        [protectedFolder],
      )
    )[0].syncCursor,
  ).toBe('protected');
});
it('ownership read failure leaves native graph and pending action unchanged', async () => {
  const expected = await capture();
  await fixture.owner.query(
    `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
  );
  try {
    await expect(clean(expected)).rejects.toThrow();
    expect(await exists()).toBe(true);
    expect(await cursor()).toBe('folder-before');
  } finally {
    await fixture.owner.query(
      `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
    );
  }
});
it('final channel SQL failure rolls back earlier folder reset', async () => {
  const expected = await capture(),
    original = fixture.coreReader.createQueryRunner.bind(fixture.coreReader);
  jest.spyOn(fixture.coreReader, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner);
    runner.query = async (...args: Parameters<typeof runner.query>) => {
      if (args[0].startsWith('UPDATE core."messageChannel"'))
        await query('SELECT 1/0');
      return query(...args);
    };
    return runner;
  });
  await expect(
    finishOrdinaryGroupEmailAction(fixture.coreReader.manager, expected),
  ).rejects.toThrow();
  expect(await cursor()).toBe('folder-before');
  expect((await channel()).pendingGroupEmailsAction).toBe(
    'GROUP_EMAILS_DELETION',
  );
});
it('actual worker does not finalize after a lost native COMMIT acknowledgement', async () => {
  const original =
    fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans.bind(
      fixture.cleaner,
    );
  jest
    .spyOn(
      fixture.cleaner,
      'deleteMessagesChannelMessageAssociationsAndRelatedOrphans',
    )
    .mockImplementationOnce(async (args) => {
      const client = await fixture.pool.connect(),
        query = client.query.bind(client);
      jest.spyOn(client, 'query').mockImplementation((async (
        text: string,
        values?: unknown[],
      ) => {
        const result = await query(text, values);
        if (text === 'COMMIT') throw new Error('group cleanup ACK lost');
        return result;
      }) as PoolClient['query']);
      jest
        .spyOn(fixture.pool, 'connect')
        .mockImplementationOnce(async () => client);
      return original(args);
    });
  await expect(
    worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(await exists()).toBe(false);
  expect(await cursor()).toBe('folder-before');
  expect((await channel()).pendingGroupEmailsAction).toBe(
    'GROUP_EMAILS_DELETION',
  );
});
it('new action between destructive batch and finalizer is not erased', async () => {
  const original = deletion.deleteGroupEmailMessages.bind(deletion);
  jest
    .spyOn(deletion, 'deleteGroupEmailMessages')
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      await change('pendingGroupEmailsAction', 'GROUP_EMAILS_IMPORT');
      await change('excludeGroupEmails', false);
      return result;
    });
  expect(
    await worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).toBe(false);
  expect(await exists()).toBe(false);
  expect(await cursor()).toBe('folder-before');
  expect((await channel()).pendingGroupEmailsAction).toBe(
    'GROUP_EMAILS_IMPORT',
  );
});
it('rejects mismatched snapshot scope before native cleanup', async () => {
  const expected = await capture();
  await expect(
    clean({ ...expected, messageChannelId: randomUUID() }),
  ).rejects.toThrow('OMNI_INVALID_GROUP_ACTION_SCOPE');
  expect(await exists()).toBe(true);
});

it('stops later destructive chunks when settings change after the first commit', async () => {
  const inserted: { id: string }[] = await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."message"(id,"messageThreadId") SELECT gen_random_uuid(),$1 FROM generate_series(1,200) RETURNING id`,
    [seed.email.threadId],
  );
  const addedIds = inserted.map((row: Record<string, string>) => row.id);
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId","messageExternalId") SELECT gen_random_uuid(),id,$2,'batch-'||id FROM unnest($1::uuid[]) row(id)`,
    [addedIds, channelId],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageParticipant"(id,"messageId",role,handle) SELECT gen_random_uuid(),id,'FROM','support@example.test' FROM unnest($1::uuid[]) row(id)`,
    [addedIds],
  );
  const original =
    fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans.bind(
      fixture.cleaner,
    );
  let batches = 0;
  jest
    .spyOn(
      fixture.cleaner,
      'deleteMessagesChannelMessageAssociationsAndRelatedOrphans',
    )
    .mockImplementation(async (args) => {
      const result = await original(args);
      if (++batches === 1) {
        await change('pendingGroupEmailsAction', 'GROUP_EMAILS_IMPORT');
        await change('excludeGroupEmails', false);
      }
      return result;
    });
  expect(
    await worker.processGroupEmailActions(await channel(), fixture.workspaceId),
  ).toBe(false);
  expect(batches).toBe(2);
  expect(
    (await fixture.read('messageChannelMessageAssociation')).filter(
      (row: Record<string, string>) => row.messageChannelId === channelId,
    ),
  ).toHaveLength(1);
  expect(
    (await fixture.read('message')).filter(
      (row: Record<string, string>) =>
        row.messageThreadId === seed.email.threadId,
    ),
  ).toHaveLength(1);
  expect(await cursor()).toBe('folder-before');
  expect((await channel()).pendingGroupEmailsAction).toBe(
    'GROUP_EMAILS_IMPORT',
  );
});
it('shared cleaner waits for exclusive ownership enrollment and rechecks after it', async () => {
  const expected = await capture(),
    runner = fixture.owner.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  let pending: Promise<boolean> | undefined;
  try {
    await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'twenty:omni-native:' + fixture.workspaceId,
    ]);
    pending = clean(expected);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const rows = await fixture.owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
        [fixture.roleName],
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await runner.query(
      'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
      [accountId, 'app'],
    );
    await runner.commitTransaction();
    expect(await pending).toBe(false);
    expect(await exists()).toBe(true);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    if (pending) await pending.catch(() => undefined);
  }
});
it('native deletion failure rolls back its batch and leaves the finalizer untouched', async () => {
  await fixture.owner.query(
    `CREATE FUNCTION core.log060_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture group delete failure'; END $$`,
  );
  await fixture.owner.query(
    `CREATE TRIGGER log060_fail_delete BEFORE DELETE ON "${fixture.schemaName}"."message" FOR EACH ROW EXECUTE FUNCTION core.log060_fail_delete()`,
  );
  try {
    await expect(
      worker.processGroupEmailActions(await channel(), fixture.workspaceId),
    ).rejects.toThrow();
    expect(await exists()).toBe(true);
    expect(
      (await fixture.read('messageChannelMessageAssociation')).some(
        (row: Record<string, string>) => row.id === seed.email.associationId,
      ),
    ).toBe(true);
    expect(await cursor()).toBe('folder-before');
    expect((await channel()).pendingGroupEmailsAction).toBe(
      'GROUP_EMAILS_DELETION',
    );
  } finally {
    await fixture.owner.query(
      `DROP TRIGGER log060_fail_delete ON "${fixture.schemaName}"."message"`,
    );
    await fixture.owner.query('DROP FUNCTION core.log060_fail_delete()');
  }
});
