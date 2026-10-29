import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteNativeMessageAssociationsAndRelatedOrphansWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-message-associations-and-related-orphans-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

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

const f = createOmniNativeCleanupFixture();
const ROOT = 'messageChannelMessageAssociation';
const CHILD = 'messageChannelMessageAssociationMessageFolder';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageCleanerService' },
});
// Terminal callback; public expectedRun/group/folder callers are not wired in LOG135.
const remove = async (
  messageChannelId: string,
  messageExternalIds: readonly string[],
  auditOperation = operation(),
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteNativeMessageAssociationsAndRelatedOrphansWithAudit({
          scope,
          operation: auditOperation,
          messageChannelId,
          messageExternalIds,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const present = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const snapshot = async () => {
  const all: unknown[] = [];
  for (const name of [
    ROOT,
    CHILD,
    'message',
    'messageParticipant',
    'messageThread',
    'messageThreadTarget',
    'person',
    'company',
    'opportunity',
  ])
    all.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
      ),
    );
  return all;
};
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .insert({ id, ...fields }),
  );
  f.eventEmitter.mockClear();
  return id;
};
const seedOrdinary = async () => {
  const seed = await f.seed('conversation');
  // The shared fixture's original account owns a disabled binding. Separate the
  // ordinary channel while retaining mixed protected/ordinary native messages.
  const accountId = await f.coreInsert('connectedAccount', {
    workspaceId: f.workspaceId,
    provider: 'google',
  });
  await f.owner.query(
    'UPDATE core."messageChannel" SET "connectedAccountId"=$1 WHERE id=$2',
    [accountId, seed.channelId],
  );
  return { ...seed, accountId };
};
type Seed = Awaited<ReturnType<typeof seedOrdinary>>;
const ordinaryIds = (seed: Seed) =>
  [
    seed.email.associationId,
    seed.email.junctionId,
    seed.email.messageId,
    seed.email.participantId,
    seed.email.threadId,
    seed.email.targetId,
  ].sort();
const assertOneOperation = (entries: { operationId: string }[]) =>
  expect(new Set(entries.map((row) => row.operationId)).size).toBe(1);

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD provider text, ADD "applicationId" uuid, ADD "connectionProviderId" uuid',
  );
  await f.owner.query(
    `GRANT SELECT,UPDATE ON core."connectedAccount",core."messageChannel" TO "${f.roleName}"`,
  );
});
beforeEach(async () => {
  for (const name of [ROOT, 'message', 'messageThread'])
    await f.owner.query(
      `DROP TRIGGER IF EXISTS targeted_test ON ${table(name)}`,
    );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS targeted_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".targeted_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('targeted_extra')}`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('audits the actual six-row graph in one operation and leaves mixed protected and unrelated orphan records untouched', async () => {
  const seed = await seedOrdinary();
  const unrelatedThreadId = await insert('messageThread', {
    subject: 'unrelated orphan',
  });
  const unrelatedMessageId = await insert('message', {
    messageThreadId: unrelatedThreadId,
    headerMessageId: randomUUID(),
    text: 'unrelated',
    receivedAt: new Date(),
    isDraft: false,
  });
  const result = await remove(seed.channelId, [
    seed.email.externalId,
    seed.omni.externalId,
  ]);
  expect(result.deletedAssociationIds).toEqual([seed.email.associationId]);
  expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(result.affectedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedTargetIds).toEqual([seed.email.targetId]);
  for (const [name, id] of [
    [ROOT, seed.email.associationId],
    [CHILD, seed.email.junctionId],
    ['message', seed.email.messageId],
    ['messageParticipant', seed.email.participantId],
    ['messageThread', seed.email.threadId],
    ['messageThreadTarget', seed.email.targetId],
  ])
    expect(await present(name, id)).toBe(false);
  for (const [name, id] of [
    [ROOT, seed.omni.associationId],
    [CHILD, seed.omni.junctionId],
    ['message', seed.omni.messageId],
    ['messageThread', seed.omni.threadId],
    ['message', unrelatedMessageId],
    ['messageThread', unrelatedThreadId],
  ])
    expect(await present(name, id)).toBe(true);
  const entries = await audit();
  expect(
    entries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual(ordinaryIds(seed));
  assertOneOperation(entries);
  for (const row of entries)
    expect(row).toMatchObject({
      workspaceId: f.workspaceId,
      actor: operation().actor,
      action: 'delete',
      resourceKind: 'crmRecord',
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.resourceId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  expect(JSON.stringify(entries)).not.toContain('email body');
  expect(JSON.stringify(entries)).not.toContain('client@example.test');
  f.eventEmitter.mockClear();
  expect(
    (await remove(seed.channelId, [seed.email.externalId]))
      .deletedAssociationIds,
  ).toEqual([]);
  expect(await audit()).toEqual(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('retains a Message still referenced by a soft-deleted association on another ordinary channel', async () => {
  const seed = await seedOrdinary();
  const otherChannelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    type: 'EMAIL',
    connectedAccountId: seed.accountId,
  });
  const otherAssociationId = await insert(ROOT, {
    messageId: seed.email.messageId,
    messageChannelId: otherChannelId,
    messageExternalId: seed.email.externalId,
    messageThreadExternalId: 'other',
    direction: 'INCOMING',
    deletedAt: new Date(),
  });
  const result = await remove(seed.channelId, [seed.email.externalId]);
  expect(result.deletedAssociationIds).toEqual([seed.email.associationId]);
  expect(result.deletedMessageIds).toEqual([]);
  expect(result.deletedThreadIds).toEqual([]);
  expect(await present(ROOT, otherAssociationId)).toBe(true);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
  const entries = await audit();
  expect(
    entries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([seed.email.associationId, seed.email.junctionId].sort());
  assertOneOperation(entries);
});

it('reconciles a surviving affected Thread from current sources and audits actual target create/delete with the Message graph', async () => {
  const seed = await seedOrdinary();
  const personId = await insert('person', {
    name: { firstName: 'Remaining', lastName: 'Source' },
  });
  const messageId = await insert('message', {
    messageThreadId: seed.email.threadId,
    headerMessageId: randomUUID(),
    text: 'remaining',
    receivedAt: new Date(),
    isDraft: false,
  });
  await insert('messageParticipant', {
    messageId,
    personId,
    role: 'FROM',
    handle: null,
    displayName: null,
  });
  await insert(ROOT, {
    messageId,
    messageChannelId: seed.channelId,
    messageExternalId: 'keep',
    messageThreadExternalId: 'keep',
    direction: 'INCOMING',
  });
  const result = await remove(seed.channelId, [seed.email.externalId]);
  expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(result.deletedThreadIds).toEqual([]);
  expect(result.createdTargetIds).toHaveLength(1);
  expect(result.deletedTargetIds).toEqual([seed.email.targetId]);
  expect(
    await f.owner.query(
      `SELECT id,"targetPersonId" FROM ${table('messageThreadTarget')} WHERE "messageThreadId"=$1`,
      [seed.email.threadId],
    ),
  ).toEqual([{ id: result.createdTargetIds[0], targetPersonId: personId }]);
  expect(await present('message', messageId)).toBe(true);
  const entries = await audit();
  expect(entries).toHaveLength(6);
  expect(
    entries.filter((row: { action: string }) => row.action === 'create'),
  ).toHaveLength(1);
  assertOneOperation(entries);
});

it('accepts a skipped association DELETE without claiming downstream orphan or audit effects', async () => {
  const seed = await seedOrdinary(),
    before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER targeted_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
  const result = await remove(seed.channelId, [seed.email.externalId]);
  expect(result.deletedAssociationIds).toEqual([]);
  expect(result.deletedMessageIds).toEqual([]);
  expect(result.affectedThreadIds).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['association', 'junction', 'unchanged'] as const)(
  'validates a skipped selected association before later Thread cascade: %s',
  async (mutation) => {
    const seed = await seedOrdinary();
    const skippedId = await insert(ROOT, {
      messageId: null,
      messageThreadId: seed.email.threadId,
      messageChannelId: seed.channelId,
      messageExternalId: 'skip-until-thread-cascade',
      messageThreadExternalId: 'direct-thread',
      direction: 'INCOMING',
    });
    const skippedJunctionId = await insert(CHILD, {
      messageChannelMessageAssociationId: skippedId,
      messageFolderId: seed.folderId,
    });
    const alternateFolderId = await f.coreInsert('messageFolder', {
      workspaceId: f.workspaceId,
      messageChannelId: seed.channelId,
    });
    const before = await snapshot();
    const change =
      mutation === 'association'
        ? `UPDATE ${table(ROOT)} SET "messageExternalId"='changed-before-cascade' WHERE id='${skippedId}';`
        : mutation === 'junction'
          ? `UPDATE ${table(CHILD)} SET "messageFolderId"='${alternateFolderId}' WHERE id='${skippedJunctionId}';`
          : '';
    await f.owner
      .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    IF TG_TABLE_NAME='${ROOT}' THEN
      IF OLD.id='${skippedId}'::uuid AND pg_trigger_depth()=1 THEN RETURN NULL; END IF;
      RETURN OLD;
    END IF;
    ${change}
    RETURN OLD; END $$;
    CREATE TRIGGER targeted_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test();
    CREATE TRIGGER targeted_test BEFORE DELETE ON ${table('message')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
    // The skip applies only to the initial explicit association DELETE. The
    // actual FK cascade later runs at greater trigger depth and removes A.
    if (mutation !== 'unchanged') {
      await expect(
        remove(seed.channelId, [
          seed.email.externalId,
          'skip-until-thread-cascade',
        ]),
      ).rejects.toThrow('Native targeted cleanup effects mismatch');
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect(f.eventEmitter).not.toHaveBeenCalled();
      return;
    }
    const result = await remove(seed.channelId, [
      seed.email.externalId,
      'skip-until-thread-cascade',
    ]);
    expect(result.deletedAssociationIds).toEqual(
      [seed.email.associationId, skippedId].sort(),
    );
    expect(result.deletedJunctionIds).toEqual(
      [seed.email.junctionId, skippedJunctionId].sort(),
    );
    expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
    expect(result.deletedThreadIds).toEqual([seed.email.threadId]);
    for (const [name, id] of [
      [ROOT, skippedId],
      [CHILD, skippedJunctionId],
      ['messageThread', seed.email.threadId],
    ])
      expect(await present(name, id)).toBe(false);
    const entries = await audit();
    expect(entries).toHaveLength(8);
    expect(
      entries.map((row: { resourceId: string }) => row.resourceId).sort(),
    ).toEqual([...ordinaryIds(seed), skippedId, skippedJunctionId].sort());
    expect(
      entries.every((row: { action: string }) => row.action === 'delete'),
    ).toBe(true);
    assertOneOperation(entries);
  },
);

it('deletes an ordinary null-Message association and junction without inventing an affected Message or Thread', async () => {
  const seed = await seedOrdinary();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "messageId"=NULL WHERE id=$1`,
    [seed.email.associationId],
  );
  const result = await remove(seed.channelId, [seed.email.externalId]);
  expect(result.deletedAssociationIds).toEqual([seed.email.associationId]);
  expect(result.deletedMessageIds).toEqual([]);
  expect(result.affectedThreadIds).toEqual([]);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([seed.email.associationId, seed.email.junctionId].sort());
});

it.each(['direct-thread', 'folder-child'] as const)(
  'retains the selected association graph protected only by %s ownership',
  async (kind) => {
    const seed = await seedOrdinary();
    if (kind === 'direct-thread') {
      await f.owner.query(
        `UPDATE ${table(ROOT)} SET "messageId"=NULL,"messageThreadId"=$1 WHERE id=$2`,
        [seed.omni.threadId, seed.email.associationId],
      );
    } else {
      const folderId = await f.coreInsert('messageFolder', {
        workspaceId: f.workspaceId,
        messageChannelId: seed.protectedChannelId,
      });
      await f.owner.query(
        `UPDATE ${table(CHILD)} SET "messageFolderId"=$1 WHERE id=$2`,
        [folderId, seed.email.junctionId],
      );
    }
    const before = await snapshot();
    expect(
      (await remove(seed.channelId, [seed.email.externalId]))
        .deletedAssociationIds,
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('keeps selected soft-deleted associations and their related live native graph', async () => {
  const seed = await seedOrdinary();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.email.associationId],
  );
  const before = await snapshot();
  expect(
    (await remove(seed.channelId, [seed.email.externalId]))
      .deletedAssociationIds,
  ).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('deduplicates requested external IDs and captures the caller array and actor before the first await', async () => {
  const seed = await seedOrdinary(),
    ids = [seed.email.externalId, seed.email.externalId],
    supplied = operation();
  const capturedActor = { ...supplied.actor };
  const result = await f.withContext(() =>
    f.dataSource.transaction(
      (scope) => {
        const pending =
          deleteNativeMessageAssociationsAndRelatedOrphansWithAudit({
            scope,
            operation: supplied,
            messageChannelId: seed.channelId,
            messageExternalIds: ids,
          });
        ids.splice(0, ids.length, seed.omni.externalId);
        supplied.actor = { kind: 'system', id: 'mutated-caller' };
        return pending;
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  expect(result.deletedAssociationIds).toEqual([seed.email.associationId]);
  const entries = await audit();
  expect(entries).toHaveLength(6);
  for (const row of entries) expect(row.actor).toEqual(capturedActor);
  assertOneOperation(entries);
});

it('rolls back every native stage when the final audit INSERT is refused', async () => {
  const seed = await seedOrdinary(),
    before = await snapshot();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(
      remove(seed.channelId, [seed.email.externalId]),
    ).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([true, false])(
  'requires the actual association-to-junction CASCADE even when hasChild=%s',
  async (hasChild) => {
    const seed = await seedOrdinary();
    if (!hasChild)
      await f.owner.query(
        `DELETE FROM ${table(CHILD)} WHERE "messageChannelMessageAssociationId"=$1`,
        [seed.email.associationId],
      );
    const constraints = await f.owner.query(
      `SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass`,
      [table(CHILD), table(ROOT)],
    );
    expect(constraints).toHaveLength(1);
    const constraint = constraints[0];
    const quotedName = '"' + constraint.name.replaceAll('"', '""') + '"';
    const before = await snapshot();
    await f.owner.query(
      `ALTER TABLE ${table(CHILD)} DROP CONSTRAINT ${quotedName}`,
    );
    try {
      await expect(
        remove(seed.channelId, [seed.email.externalId]),
      ).rejects.toThrow(
        'Native targeted cleanup requires the folder junction cascade',
      );
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect(f.eventEmitter).not.toHaveBeenCalled();
    } finally {
      await f.owner.query(
        `ALTER TABLE ${table(CHILD)} ADD CONSTRAINT ${quotedName} ${constraint.definition}`,
      );
    }
  },
);

it('refuses a populated unknown incoming SET NULL foreign key before deleting the selected graph', async () => {
  const seed = await seedOrdinary();
  await f.owner
    .query(`CREATE TABLE ${table('targeted_extra')} (parent uuid REFERENCES ${table(ROOT)}(id) ON DELETE SET NULL);
    GRANT SELECT ON ${table('targeted_extra')} TO "${f.roleName}"`);
  await f.owner.query(`INSERT INTO ${table('targeted_extra')} VALUES($1)`, [
    seed.email.associationId,
  ]);
  const before = await snapshot();
  await expect(remove(seed.channelId, [seed.email.externalId])).rejects.toThrow(
    'Native targeted cleanup excludes unsupported cascade effects',
  );
  expect(await snapshot()).toEqual(before);
  expect(
    await f.owner.query(`SELECT parent FROM ${table('targeted_extra')}`),
  ).toEqual([{ parent: seed.email.associationId }]);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('advances over a full first page of protected matching associations to delete an ordinary later match', async () => {
  const seed = await seedOrdinary();
  const associationIds: string[] = Array.from(
    { length: 500 },
    (_, index) =>
      `00000000-0000-4000-b000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  const messageIds: string[] = Array.from({ length: 500 }, () => randomUUID());
  const externalIds = associationIds.map((id) => 'protected-page-' + id);
  await f.seedNative(async (scope) => {
    const options = { shouldBypassPermissionChecks: true } as const;
    await scope.getRepository('message', options).insert(
      messageIds.map((id) => ({
        id,
        messageThreadId: seed.omni.threadId,
        headerMessageId: randomUUID(),
        text: 'retained protected page',
        receivedAt: new Date(),
        isDraft: false,
      })),
    );
    await scope.getRepository(ROOT, options).insert(
      associationIds.map((id, index) => ({
        id,
        messageId: messageIds[index],
        messageChannelId: seed.channelId,
        messageExternalId: externalIds[index],
        messageThreadExternalId: 'protected-page',
        direction: 'INCOMING',
      })),
    );
    await scope.getRepository(CHILD, options).insert(
      associationIds.map((id) => ({
        id,
        messageChannelMessageAssociationId: id,
        messageFolderId: seed.folderId,
      })),
    );
  });
  const requested = [...externalIds, seed.email.externalId];
  expect(
    (
      await f.owner.query(
        `SELECT id FROM ${table(ROOT)} WHERE "messageChannelId"=$1 AND "messageExternalId"=ANY($2::text[]) ORDER BY id LIMIT 500`,
        [seed.channelId, requested],
      )
    ).map((row: { id: string }) => row.id),
  ).toEqual(associationIds);
  f.eventEmitter.mockClear();
  const result = await remove(seed.channelId, requested);
  expect(result.deletedAssociationIds).toEqual([seed.email.associationId]);
  expect(result.deletedJunctionIds).toEqual([seed.email.junctionId]);
  expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(result.deletedThreadIds).toEqual([seed.email.threadId]);
  for (const name of [ROOT, CHILD])
    expect(
      await f.owner.query(
        `SELECT count(*)::int AS count FROM ${table(name)} WHERE id=ANY($1::uuid[])`,
        [associationIds],
      ),
    ).toEqual([{ count: 500 }]);
  expect(
    await f.owner.query(
      `SELECT count(*)::int AS count FROM ${table('message')} WHERE id=ANY($1::uuid[])`,
      [messageIds],
    ),
  ).toEqual([{ count: 500 }]);
  const entries = await audit();
  expect(
    entries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual(ordinaryIds(seed));
  assertOneOperation(entries);
}, 20000);

it('rolls back a real first association page DELETE when a later selected page fails', async () => {
  const seed = await seedOrdinary();
  const associationIds: string[] = Array.from(
    { length: 501 },
    (_, index) =>
      `00000000-0000-4000-a000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  const messageIds: string[] = Array.from({ length: 501 }, () => randomUUID());
  const externalIds = associationIds.map((id) => 'page-' + id);
  await f.seedNative(async (scope) => {
    const options = { shouldBypassPermissionChecks: true } as const;
    // Preserve the actual unique live channel/message index: one Message per association.
    await scope.getRepository('message', options).insert(
      messageIds.map((id) => ({
        id,
        messageThreadId: seed.email.threadId,
        headerMessageId: randomUUID(),
        text: 'paged source',
        receivedAt: new Date(),
        isDraft: false,
      })),
    );
    await scope.getRepository(ROOT, options).insert(
      associationIds.map((id, index) => ({
        id,
        messageId: messageIds[index],
        messageChannelId: seed.channelId,
        messageExternalId: externalIds[index],
        messageThreadExternalId: 'paged',
        direction: 'INCOMING',
      })),
    );
  });
  const before = await snapshot();
  f.eventEmitter.mockClear();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${associationIds[500]}'::uuid THEN RAISE EXCEPTION 'second targeted association page failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER targeted_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let firstPageRemainder: number | undefined;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      firstPageRemainder === undefined &&
      text.includes('DELETE FROM ' + table(ROOT))
    ) {
      firstPageRemainder = (
        await original(
          `SELECT count(*)::int AS count FROM ${table(ROOT)} WHERE id=ANY($1::uuid[])`,
          [associationIds.slice(0, 500)],
        )
      ).rows[0].count;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const failure: unknown = await remove(
    seed.channelId,
    [...externalIds].reverse(),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const messages: string[] = [];
  let cause: unknown = failure;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    messages.push(cause.message);
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  expect(messages.join('\n')).toContain(
    'second targeted association page failure',
  );
  expect(firstPageRemainder).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 20000);

it.each([
  'missing-channel',
  'missing-account',
  'foreign-channel',
  'foreign-account',
  'bound-channel',
  'bound-account',
  'reserved-provider',
] as const)(
  'rejects %s authority before touching native records',
  async (kind) => {
    const seed = await seedOrdinary();
    if (kind === 'missing-channel')
      await f.owner.query('DELETE FROM core."messageChannel" WHERE id=$1', [
        seed.channelId,
      ]);
    else if (kind === 'missing-account')
      await f.owner.query('DELETE FROM core."connectedAccount" WHERE id=$1', [
        seed.accountId,
      ]);
    else if (kind === 'foreign-channel')
      await f.owner.query(
        'UPDATE core."messageChannel" SET "workspaceId"=$2 WHERE id=$1',
        [seed.channelId, randomUUID()],
      );
    else if (kind === 'foreign-account')
      await f.owner.query(
        'UPDATE core."connectedAccount" SET "workspaceId"=$2 WHERE id=$1',
        [seed.accountId, randomUUID()],
      );
    else if (kind === 'bound-channel')
      await f.owner.query(
        'UPDATE core."omniAccountBinding" SET "messageChannelId"=$2 WHERE id=$1',
        [seed.bindingId, seed.channelId],
      );
    else if (kind === 'bound-account')
      await f.owner.query(
        'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$2 WHERE id=$1',
        [seed.bindingId, seed.accountId],
      );
    else
      await f.owner.query(
        'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
        [seed.accountId, 'app'],
      );
    const before = await snapshot();
    await expect(
      remove(seed.channelId, [seed.email.externalId]),
    ).rejects.toThrow(/requires live ordinary channel authority/);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('allows a registered application account without an EMAIL-only provider whitelist', async () => {
  const seed = await seedOrdinary();
  await f.owner.query(
    'UPDATE core."connectedAccount" SET provider=$2,"applicationId"=$3,"connectionProviderId"=$4 WHERE id=$1',
    [seed.accountId, 'app', randomUUID(), randomUUID()],
  );
  await f.owner.query('UPDATE core."messageChannel" SET type=$2 WHERE id=$1', [
    seed.channelId,
    'APP',
  ]);
  expect(
    (await remove(seed.channelId, [seed.email.externalId]))
      .deletedAssociationIds,
  ).toEqual([seed.email.associationId]);
  expect(await audit()).toHaveLength(6);
});

it.each(['provider', 'direct-binding', 'parent'] as const)(
  'rejects late %s authority changes during audit flush and rolls back every native effect',
  async (kind) => {
    const seed = await seedOrdinary(),
      before = await snapshot();
    const accountBefore = await f.owner.query(
      'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row WHERE id=$1',
      [seed.accountId],
    );
    const channelBefore = await f.owner.query(
      'SELECT to_jsonb(row)::text AS row FROM core."messageChannel" row WHERE id=$1',
      [seed.channelId],
    );
    const bindingBefore = await f.owner.query(
      'SELECT to_jsonb(row)::text AS row FROM core."omniAccountBinding" row WHERE id=$1',
      [seed.bindingId],
    );
    const mutation =
      kind === 'provider'
        ? `UPDATE core."connectedAccount" SET provider='app',"applicationId"=NULL,"connectionProviderId"=NULL WHERE id='${seed.accountId}';`
        : kind === 'direct-binding'
          ? `UPDATE core."omniAccountBinding" SET "connectedAccountId"='${seed.accountId}' WHERE id='${seed.bindingId}';`
          : `UPDATE core."messageChannel" SET "connectedAccountId"=(SELECT "connectedAccountId" FROM core."messageChannel" WHERE id='${seed.protectedChannelId}') WHERE id='${seed.channelId}';`;
    await f.owner
      .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    ${mutation} RETURN NEW; END $$;
    CREATE TRIGGER targeted_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
    await expect(
      remove(seed.channelId, [seed.email.externalId]),
    ).rejects.toThrow(/channel authority changed/);
    expect(await snapshot()).toEqual(before);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row WHERE id=$1',
        [seed.accountId],
      ),
    ).toEqual(accountBefore);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."messageChannel" row WHERE id=$1',
        [seed.channelId],
      ),
    ).toEqual(channelBefore);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."omniAccountBinding" row WHERE id=$1',
        [seed.bindingId],
      ),
    ).toEqual(bindingBefore);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it.each(['account', 'channel'] as const)(
  'holds the actual %s prerequisite lock until native cleanup commits',
  async (kind) => {
    const seed = await seedOrdinary();
    const writer = f.owner.createQueryRunner();
    await writer.connect();
    const [writerBackend] = await writer.query(
      'SELECT pg_backend_pid() AS pid',
    );
    const client = await f.pool.connect(),
      original = client.query.bind(client);
    const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid as number;
    let release!: () => void,
      reached!: () => void,
      held = false;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      const result = await original(statement as string, values);
      if (
        !held &&
        text.includes('core."messageChannel"') &&
        text.includes('FOR UPDATE')
      ) {
        held = true;
        reached();
        await resume;
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const work = remove(seed.channelId, [seed.email.externalId]).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let mutation:
      | Promise<{ ok: true } | { ok: false; error: unknown }>
      | undefined;
    try {
      await Promise.race([
        locked,
        work.then(() => {
          throw new Error(
            'Targeted owner settled before channel prerequisite lock',
          );
        }),
      ]);
      mutation = (
        kind === 'account'
          ? writer.query(
              'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
              [seed.accountId, 'app'],
            )
          : writer.query(
              'UPDATE core."messageChannel" SET "connectedAccountId"=(SELECT "connectedAccountId" FROM core."messageChannel" WHERE id=$2) WHERE id=$1',
              [seed.channelId, seed.protectedChannelId],
            )
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const [row] = await f.owner.query(
          'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
          [writerBackend.pid, nativePid],
        );
        if (row.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(await present(ROOT, seed.email.associationId)).toBe(true);
      expect(await audit()).toEqual([]);
      release();
      const result = await work;
      if (!result.ok) throw result.error;
      expect(result.value.deletedAssociationIds).toEqual([
        seed.email.associationId,
      ]);
      const changed = await mutation;
      if (!changed.ok) throw changed.error;
      expect(await audit()).toHaveLength(6);
      expect(await present('message', seed.email.messageId)).toBe(false);
    } finally {
      release();
      await work;
      if (mutation) await mutation;
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      if (!writer.isReleased) await writer.release();
    }
  },
  20000,
);

it('rejects deferred association resurrection before commit and restores the complete graph', async () => {
  const seed = await seedOrdinary();
  // Keep the Message live in another ordinary association so resurrection can
  // satisfy its FK and must be detected by the graph proof rather than FK failure.
  const otherChannelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    type: 'EMAIL',
    connectedAccountId: seed.accountId,
  });
  await insert(ROOT, {
    messageId: seed.email.messageId,
    messageChannelId: otherChannelId,
    messageExternalId: 'retained',
    messageThreadExternalId: 'retained',
    direction: 'INCOMING',
  });
  const before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table(ROOT)} SELECT OLD.*; RETURN OLD; END $$;
    CREATE CONSTRAINT TRIGGER targeted_test AFTER DELETE ON ${table(ROOT)} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
  await expect(remove(seed.channelId, [seed.email.externalId])).rejects.toThrow(
    'Native targeted cleanup effects mismatch',
  );
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rejects late retained Conversation ownership created during audit flush and rolls back all native effects', async () => {
  const seed = await seedOrdinary(),
    before = await snapshot(),
    conversationId = randomUUID();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".targeted_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniConversation" (id,"workspaceId","bindingId","providerChatId","messageThreadId","policyId","policyVersion")
      VALUES('${conversationId}','${f.workspaceId}','${seed.bindingId}','${conversationId}','${seed.email.threadId}','${seed.policyId}','0') ON CONFLICT(id) DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER targeted_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".targeted_test()`);
  await expect(remove(seed.channelId, [seed.email.externalId])).rejects.toThrow(
    /ownership changed before commit/,
  );
  expect(await snapshot()).toEqual(before);
  expect(
    await f.owner.query('SELECT id FROM core."omniConversation" WHERE id=$1', [
      conversationId,
    ]),
  ).toEqual([]);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('preserves committed graph and audits after actual lost COMMIT ACK without publishing false success events', async () => {
  const seed = await seedOrdinary();
  const client = await f.pool.connect(),
    original = client.query.bind(client),
    statements: string[] = [];
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    statements.push(text);
    const result = await original(statement as string, values);
    if (text === 'COMMIT')
      throw new Error('lost targeted cleanup COMMIT acknowledgement');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(
    remove(seed.channelId, [seed.email.externalId]),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  expect(await present(ROOT, seed.email.associationId)).toBe(false);
  expect(await present('message', seed.email.messageId)).toBe(false);
  expect(await present('messageThread', seed.email.threadId)).toBe(false);
  const entries = await audit();
  expect(entries).toHaveLength(6);
  assertOneOperation(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['foreign-operation', 'shared-scope'] as const)(
  'refuses %s authority before native writes',
  async (kind) => {
    const seed = await seedOrdinary(),
      before = await snapshot();
    const work =
      kind === 'foreign-operation'
        ? remove(seed.channelId, [seed.email.externalId], {
            ...operation(),
            workspaceId: randomUUID(),
          })
        : f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                deleteNativeMessageAssociationsAndRelatedOrphansWithAudit({
                  scope,
                  operation: operation(),
                  messageChannelId: seed.channelId,
                  messageExternalIds: [seed.email.externalId],
                }),
              { commitOutcome: 'strict' },
            ),
          );
    await expect(work).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);
