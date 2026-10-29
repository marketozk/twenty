import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type QueryRunner } from 'typeorm';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteNativeMessageChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-message-channel-associations-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { findOmniNativeWriteOwnedRecords } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';
import {
  createOmniNativeCleanupFixture,
  type CleanupMarker,
} from 'test/fork-migration/omni-native-cleanup.fixture';

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
type Seed = Awaited<ReturnType<typeof f.seed>>;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageChannelDeletionCleanupJob' },
});
const remove = async (id: string, audit = operation()) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteNativeMessageChannelAssociationsWithAudit({
          scope,
          messageChannelId: id,
          operation: audit,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const seedDeletedChannel = async (marker: CleanupMarker = 'binding') => {
  const seed = await f.seed(marker);
  await f.owner.query('DELETE FROM core."messageChannel" WHERE id=$1', [
    seed.channelId,
  ]);
  return seed;
};
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const snapshots = async () => {
  const result: unknown[] = [];
  for (const name of [ROOT, CHILD, 'message', 'messageThread'])
    result.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS snapshot FROM ${table(name)} row ORDER BY id`,
      ),
    );
  return result;
};
const present = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const emittedIds = () =>
  f.eventEmitter.mock.calls.flatMap(([batch]) =>
    batch.events.map((event: { recordId: string }) => event.recordId),
  );
const assertProtected = async (seed: Seed) => {
  expect(await present(ROOT, seed.omni.associationId)).toBe(true);
  expect(await present(CHILD, seed.omni.junctionId)).toBe(true);
};
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS association_skip ON ${table(ROOT)}`,
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS association_corrupt ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".association_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('association_extra')}`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('journals only actual ordinary association and junction deletion with safe scoped identity', async () => {
  const seed = await seedDeletedChannel();
  expect(await remove(seed.channelId)).toBe(1);
  expect(await present(ROOT, seed.email.associationId)).toBe(false);
  expect(await present(CHILD, seed.email.junctionId)).toBe(false);
  await assertProtected(seed);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
  const rows = await audit();
  expect(rows).toHaveLength(2);
  expect(
    rows.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([seed.email.associationId, seed.email.junctionId].sort());
  for (const row of rows) {
    expect(row).toMatchObject({
      workspaceId: f.workspaceId,
      resourceKind: 'crmRecord',
      action: 'delete',
      actor: operation().actor,
    });
    expect(row.securityDescriptor).toMatchObject({
      resourceKind: 'crmRecord',
      resourceId: row.resourceId,
      deletedRecord: { access: 'currentWorkspaceAdministration' },
    });
    expect(row.securityDescriptor.objectMetadataId).toEqual(expect.any(String));
  }
  expect(JSON.stringify(rows)).not.toContain('email body');
  expect(JSON.stringify(rows)).not.toContain('client@example.test');
});

it.each(['binding', 'link', 'conversation'] as const)(
  'preserves independent %s ownership and folder junctions',
  async (marker) => {
    const seed = await seedDeletedChannel(marker);
    expect(await remove(seed.channelId)).toBe(1);
    await assertProtected(seed);
    expect(await audit()).toHaveLength(2);
  },
);

it('empty rerun creates no duplicate audit', async () => {
  const seed = await seedDeletedChannel();
  await remove(seed.channelId);
  const before = await audit();
  expect(await remove(seed.channelId)).toBe(0);
  expect(await audit()).toEqual(before);
});

it('dispatches the actual root event only after deletion and audit are externally committed', async () => {
  const seed = await seedDeletedChannel();
  const observations: { present: boolean; auditCount: number }[] = [];
  f.eventEmitter.mockImplementationOnce(async () => {
    observations.push({
      present: await present(ROOT, seed.email.associationId),
      auditCount: (await audit()).length,
    });
  });
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        expect(
          await deleteNativeMessageChannelAssociationsWithAudit({
            scope,
            messageChannelId: seed.channelId,
            operation: operation(),
          }),
        ).toBe(1);
        expect(f.eventEmitter).not.toHaveBeenCalled();
        // Independent owner connection cannot see uncommitted deletion or journal.
        expect(await present(ROOT, seed.email.associationId)).toBe(true);
        expect(await audit()).toEqual([]);
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  expect(observations).toEqual([{ present: false, auditCount: 2 }]);
  expect(emittedIds()).toEqual([seed.email.associationId]);
});

it('does not dispatch queued native events when the outer transaction rolls back', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  const failure = new Error('rollback after successful cleanup callback');
  await expect(
    f.withContext(() =>
      f.dataSource.transaction(
        async (scope) => {
          await deleteNativeMessageChannelAssociationsWithAudit({
            scope,
            messageChannelId: seed.channelId,
            operation: operation(),
          });
          expect(f.eventEmitter).not.toHaveBeenCalled();
          throw failure;
        },
        { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
      ),
    ),
  ).rejects.toThrow(failure.message);
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('preserves the existing successful cleanup contract and logs a postcommit emitter failure', async () => {
  const seed = await seedDeletedChannel();
  const failure = new Error('native event dispatch failed after commit');
  const logged = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  f.eventEmitter.mockImplementationOnce(() => {
    throw failure;
  });
  // Ordinary native callbacks remain best-effort; this is not durable delivery.
  expect(await remove(seed.channelId)).toBe(1);
  expect(logged).toHaveBeenCalledWith(
    `After-commit callback failed for workspace ${f.workspaceId}`,
    failure,
  );
  expect(await present(ROOT, seed.email.associationId)).toBe(false);
  expect(await present(CHILD, seed.email.junctionId)).toBe(false);
  expect(await audit()).toHaveLength(2);
  expect(emittedIds()).toEqual([seed.email.associationId]);
});

it.each([[[]], [['messageExternalId']]])(
  'keeps internal DELETE identity out of caller-selected columns %j',
  async (columnsToReturn) => {
    const seed = await seedDeletedChannel();
    const result = await f.withContext(() =>
      f.dataSource.transaction(
        (scope) =>
          scope
            .getRepository(ROOT, { shouldBypassPermissionChecks: true })
            .delete(seed.email.associationId, { columnsToReturn }),
        { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
      ),
    );
    expect(result.affected).toBe(1);
    expect(result.raw).toEqual(
      columnsToReturn.length ? [{ messageExternalId: 'email' }] : [{}],
    );
    expect(emittedIds()).toEqual([seed.email.associationId]);
    expect(await present(ROOT, seed.email.associationId)).toBe(false);
  },
);

it('preserves a soft-deleted ordinary association and its junction without events or audit', async () => {
  const seed = await seedDeletedChannel();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.email.associationId],
  );
  const before = await snapshots();
  expect(await remove(seed.channelId)).toBe(0);
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('audits recreated association and junction IDs in a fresh operation even when caller operation is reused', async () => {
  const seed = await seedDeletedChannel();
  const capturedRows: { name: string; snapshot: string }[] = [];
  for (const [name, id] of [
    [ROOT, seed.email.associationId],
    [CHILD, seed.email.junctionId],
  ]) {
    const [row] = await f.owner.query(
      `SELECT to_jsonb(row)::text AS snapshot FROM ${table(name)} row WHERE id=$1`,
      [id],
    );
    capturedRows.push({ name, snapshot: row.snapshot });
  }
  const callerOperation = operation();
  expect(await remove(seed.channelId, callerOperation)).toBe(1);
  const first = await audit();
  for (const row of capturedRows)
    await f.owner.query(
      `INSERT INTO ${table(row.name)} SELECT * FROM jsonb_populate_record(NULL::${table(row.name)}, $1::jsonb)`,
      [row.snapshot],
    );
  expect(await remove(seed.channelId, callerOperation)).toBe(1);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(2);
  expect(
    entries.filter(
      (row: { operationId: string }) =>
        row.operationId === first[0].operationId,
    ),
  ).toHaveLength(2);
  for (const id of [seed.email.associationId, seed.email.junctionId])
    expect(
      entries.filter((row: { resourceId: string }) => row.resourceId === id),
    ).toHaveLength(2);
  expect(emittedIds()).toEqual([
    seed.email.associationId,
    seed.email.associationId,
  ]);
});

it('journals and emits only actual deletion in a mixed trigger-skipped batch', async () => {
  const seed = await seedDeletedChannel();
  const messageId = randomUUID(),
    associationId = randomUUID(),
    junctionId = randomUUID();
  for (const [name, sourceId, changes] of [
    [
      'message',
      seed.email.messageId,
      { id: messageId, headerMessageId: randomUUID() },
    ],
    [
      ROOT,
      seed.email.associationId,
      { id: associationId, messageId, messageExternalId: 'second-ordinary' },
    ],
    [
      CHILD,
      seed.email.junctionId,
      { id: junctionId, messageChannelMessageAssociationId: associationId },
    ],
  ] as const)
    await f.owner.query(
      `INSERT INTO ${table(name)} SELECT (jsonb_populate_record(NULL::${table(name)}, to_jsonb(source)||$2::jsonb)).* FROM ${table(name)} source WHERE id=$1`,
      [sourceId, JSON.stringify(changes)],
    );
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".association_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.email.associationId}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$;
    CREATE TRIGGER association_skip BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".association_test()`);
  expect(await remove(seed.channelId)).toBe(1);
  expect(await present(ROOT, seed.email.associationId)).toBe(true);
  expect(await present(CHILD, seed.email.junctionId)).toBe(true);
  expect(await present(ROOT, associationId)).toBe(false);
  expect(await present(CHILD, junctionId)).toBe(false);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([associationId, junctionId].sort());
  expect(emittedIds()).toEqual([associationId]);
  await assertProtected(seed);
});

it('retains a null-message association through its Conversation thread and propagates that ownership to its junction', async () => {
  const seed = await seedDeletedChannel('conversation');
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "messageId"=NULL, "messageThreadId"=$1 WHERE id=$2`,
    [seed.omni.threadId, seed.email.associationId],
  );
  const before = await snapshots();
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        for (const [name, id] of [
          [ROOT, seed.email.associationId],
          [CHILD, seed.email.junctionId],
        ]) {
          const rows = await scope.executeRawQuery(
            `SELECT * FROM ${table(name)} WHERE id=$1`,
            [id],
          );
          expect(rows).toHaveLength(1);
          expect(
            await findOmniNativeWriteOwnedRecords(
              scope,
              f.workspaceId,
              name,
              rows,
            ),
          ).toEqual(rows);
        }
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  expect(await remove(seed.channelId)).toBe(0);
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('retains an ordinary association whose child references a folder on another bound channel', async () => {
  const seed = await seedDeletedChannel();
  const folderId = await f.coreInsert('messageFolder', {
    workspaceId: f.workspaceId,
    messageChannelId: seed.protectedChannelId,
  });
  await f.owner.query(
    `UPDATE ${table(CHILD)} SET "messageFolderId"=$1 WHERE id=$2`,
    [folderId, seed.email.junctionId],
  );
  const before = await snapshots();
  expect(await remove(seed.channelId)).toBe(0);
  expect(await snapshots()).toEqual(before);
  expect(await present(ROOT, seed.email.associationId)).toBe(true);
  expect(await present(CHILD, seed.email.junctionId)).toBe(true);
  await assertProtected(seed);
  expect(await audit()).toEqual([]);
});

it('refuses a recreated core channel before any cleanup', async () => {
  const seed = await seedDeletedChannel();
  await f.coreInsert('messageChannel', {
    id: seed.channelId,
    workspaceId: f.workspaceId,
    type: 'EMAIL',
  });
  const before = await snapshots();
  await expect(remove(seed.channelId)).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('refuses a missing workspace even for an empty channel cleanup', async () => {
  await f.owner.query('DELETE FROM core.workspace WHERE id=$1', [
    f.workspaceId,
  ]);
  await expect(remove(randomUUID())).rejects.toThrow(
    'Native channel cleanup requires active workspace',
  );
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('refuses a soft-deleted workspace without deleting native records', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  await f.owner.query(
    'UPDATE core.workspace SET "deletedAt"=clock_timestamp() WHERE id=$1',
    [f.workspaceId],
  );
  await expect(remove(seed.channelId)).rejects.toThrow(
    'Native channel cleanup requires active workspace',
  );
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back cleanup and audit-trigger workspace deactivation together', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".association_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    UPDATE core.workspace SET "deletedAt"=clock_timestamp() WHERE id='${f.workspaceId}'::uuid;
    RETURN NEW; END $$;
    CREATE TRIGGER association_corrupt AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".association_test()`);
  await expect(remove(seed.channelId)).rejects.toThrow(
    'Native channel cleanup workspace changed before commit',
  );
  expect(await snapshots()).toEqual(before);
  expect(
    await f.owner.query('SELECT "deletedAt" FROM core.workspace WHERE id=$1', [
      f.workspaceId,
    ]),
  ).toEqual([{ deletedAt: null }]);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['shared', 'foreign-workspace'] as const)(
  'refuses %s authority without effects',
  async (kind) => {
    const seed = await seedDeletedChannel(),
      before = await snapshots();
    const work =
      kind === 'shared'
        ? f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                deleteNativeMessageChannelAssociationsWithAudit({
                  scope,
                  messageChannelId: seed.channelId,
                  operation: operation(),
                }),
              { commitOutcome: 'strict' },
            ),
          )
        : remove(seed.channelId, { ...operation(), workspaceId: randomUUID() });
    await expect(work).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('skipped root DELETE retains its junction and records no false deletion', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".association_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER association_skip BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".association_test()`);
  expect(await remove(seed.channelId)).toBe(0);
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('audit insertion refusal rolls back both root and junction', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(remove(seed.channelId)).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('audit-trigger resurrection is detected and rolls back all effects', async () => {
  const seed = await seedDeletedChannel(),
    before = await snapshots();
  const [row] = await f.owner.query(
    `SELECT to_jsonb(row)::text AS snapshot FROM ${table(ROOT)} row WHERE id=$1`,
    [seed.email.associationId],
  );
  const literal = row.snapshot.replaceAll("'", "''");
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".association_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table(ROOT)} SELECT * FROM jsonb_populate_record(NULL::${table(ROOT)}, '${literal}'::jsonb) ON CONFLICT DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER association_corrupt BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".association_test()`);
  await expect(remove(seed.channelId)).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('rolls back deletion when an audit trigger adds retained Omni ownership to the deleted association message', async () => {
  const seed = await seedDeletedChannel('link'),
    before = await snapshots();
  const linkId = randomUUID();
  const [source] = await f.owner.query(
    'SELECT (to_jsonb(link)||$2::jsonb)::text AS snapshot FROM core."omniMessageLink" link WHERE "messageId"=$1',
    [
      seed.omni.messageId,
      JSON.stringify({
        id: linkId,
        messageId: seed.email.messageId,
        rawNativeMessageId: randomUUID(),
        nativeMessageKey: randomUUID(),
      }),
    ],
  );
  expect(source).toBeDefined();
  const literal = source.snapshot.replaceAll("'", "''");
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".association_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniMessageLink" SELECT * FROM jsonb_populate_record(NULL::core."omniMessageLink", '${literal}'::jsonb) ON CONFLICT DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER association_corrupt AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".association_test()`);
  await expect(remove(seed.channelId)).rejects.toThrow(
    'Native channel cleanup ownership changed before commit',
  );
  expect(await snapshots()).toEqual(before);
  expect(
    await f.owner.query('SELECT id FROM core."omniMessageLink" WHERE id=$1', [
      linkId,
    ]),
  ).toEqual([]);
  expect(
    await f.owner.query(
      'SELECT id FROM core."omniMessageLink" WHERE "messageId"=$1',
      [seed.omni.messageId],
    ),
  ).toHaveLength(1);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([false, true])(
  'refuses a missing association-to-junction FK even with no selected junction=%s',
  async (withoutChild) => {
    const seed = await seedDeletedChannel();
    if (withoutChild)
      await f.owner.query(`DELETE FROM ${table(CHILD)} WHERE id=$1`, [
        seed.email.junctionId,
      ]);
    const before = await snapshots();
    const constraints = await f.owner.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass`,
      [table(CHILD), table(ROOT)],
    );
    expect(constraints).toHaveLength(1);
    const constraint = constraints[0];
    const quotedName = '"' + constraint.name.replaceAll('"', '""') + '"';
    await f.owner.query(
      `ALTER TABLE ${table(CHILD)} DROP CONSTRAINT ${quotedName}`,
    );
    try {
      await expect(remove(seed.channelId)).rejects.toThrow();
      expect(await snapshots()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect(f.eventEmitter).not.toHaveBeenCalled();
    } finally {
      await f.owner.query(
        `ALTER TABLE ${table(CHILD)} ADD CONSTRAINT ${quotedName} ${constraint.definition}`,
      );
    }
  },
);

it.each(['CASCADE', 'SET NULL'] as const)(
  'refuses populated unsupported %s incoming FK',
  async (action) => {
    const seed = await seedDeletedChannel(),
      before = await snapshots();
    await f.owner
      .query(`CREATE TABLE ${table('association_extra')} (parent uuid REFERENCES ${table(ROOT)}(id) ON DELETE ${action});
    GRANT SELECT ON ${table('association_extra')} TO "${f.roleName}"`);
    await f.owner.query(
      `INSERT INTO ${table('association_extra')} VALUES($1)`,
      [seed.email.associationId],
    );
    await expect(remove(seed.channelId)).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('advances past a full protected first page and audits the ordinary later page', async () => {
  const seed = await seedDeletedChannel('conversation');
  await f.owner.query(
    `DELETE FROM ${table(ROOT)} WHERE "messageChannelId"=$1`,
    [seed.channelId],
  );
  await f.seedNative(async (scope) => {
    const permissions = { shouldBypassPermissionChecks: true } as const;
    const ids = Array.from({ length: 500 }, () => randomUUID());
    await scope.getRepository('message', permissions).insert(
      ids.map((id) => ({
        id,
        messageThreadId: seed.omni.threadId,
        headerMessageId: randomUUID(),
        subject: 'protected',
        text: 'private protected body',
        isDraft: false,
      })),
    );
    const associations = ids.map((messageId, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      messageId,
      messageChannelId: seed.channelId,
      messageExternalId: `protected-${index}`,
      messageThreadExternalId: 'protected',
      direction: 'INCOMING',
    }));
    associations.push({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      messageId: seed.email.messageId,
      messageChannelId: seed.channelId,
      messageExternalId: 'email',
      messageThreadExternalId: 'email',
      direction: 'INCOMING',
    });
    await scope.getRepository(ROOT, permissions).insert(associations);
    await scope.getRepository(CHILD, permissions).insert(
      associations.map((row) => ({
        id: row.id,
        messageChannelMessageAssociationId: row.id,
        messageFolderId: seed.folderId,
      })),
    );
  });
  expect(await remove(seed.channelId)).toBe(1);
  expect(await f.read(ROOT)).toHaveLength(500);
  expect(await f.read(CHILD)).toHaveLength(500);
  expect(await audit()).toHaveLength(2);
});

it('reports lost COMMIT acknowledgement while keeping the committed deletion and journal', async () => {
  const seed = await seedDeletedChannel();
  const client = await f.pool.connect(),
    query = client.query.bind(client),
    statements: string[] = [];
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    statements.push(text);
    const result = await query(statement as string, values);
    if (text === 'COMMIT') throw new Error('lost ack');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove(seed.channelId)).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await present(ROOT, seed.email.associationId)).toBe(false);
  expect(await audit()).toHaveLength(2);
});

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const capture = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const waitForBlocker = async (waiting: number, blocking: number) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const [row] = await f.owner.query(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiting, blocking],
    );
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected the exact cleanup/FK PostgreSQL lock wait');
};
const closeWriter = async (runner: QueryRunner) => {
  if (runner.isTransactionActive) await runner.rollbackTransaction();
  if (!runner.isReleased) await runner.release();
};
// Use an independent SQL writer deliberately: its real FK checks must serialize
// with the cleanup row locks even without the supported native ownership fence.
const prepareChildRace = async (seed: Seed, kind: 'insert' | 'reparent') => {
  const childId = randomUUID(),
    sourceId = randomUUID(),
    folderId = randomUUID();
  if (kind === 'reparent') {
    await f.owner.query(
      `INSERT INTO ${table(ROOT)}(id,"messageId","messageChannelId","messageExternalId","messageThreadExternalId",direction) VALUES($1,$2,$3,$4,$5,'INCOMING')`,
      [
        sourceId,
        seed.email.messageId,
        randomUUID(),
        'race-source',
        'race-source-thread',
      ],
    );
    await f.owner.query(
      `INSERT INTO ${table(CHILD)}(id,"messageChannelMessageAssociationId","messageFolderId") VALUES($1,$2,$3)`,
      [childId, sourceId, folderId],
    );
  }
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  const [backend] = await writer.query('SELECT pg_backend_pid() AS pid');
  const write = () =>
    kind === 'insert'
      ? writer.query(
          `INSERT INTO ${table(CHILD)}(id,"messageChannelMessageAssociationId","messageFolderId") VALUES($1,$2,$3)`,
          [childId, seed.email.associationId, folderId],
        )
      : writer.query(
          `UPDATE ${table(CHILD)} SET "messageChannelMessageAssociationId"=$1 WHERE id=$2`,
          [seed.email.associationId, childId],
        );
  return { writer, writerPid: backend.pid as number, childId, sourceId, write };
};

it.each(['insert', 'reparent'] as const)(
  'captures and audits a FK child %s committed before parent cleanup locks',
  async (kind) => {
    const seed = await seedDeletedChannel();
    const race = await prepareChildRace(seed, kind);
    const client = await f.pool.connect();
    const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid as number;
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await race.writer.startTransaction();
    await race.write();
    const deletion = capture(remove(seed.channelId));
    try {
      await waitForBlocker(nativePid, race.writerPid);
      await race.writer.commitTransaction();
      expect(await deletion).toEqual({ ok: true, value: 1 });
      expect(await present(ROOT, seed.email.associationId)).toBe(false);
      expect(await present(CHILD, race.childId)).toBe(false);
      const rows = await audit();
      expect(rows).toHaveLength(3);
      expect(
        rows.map((row: { resourceId: string }) => row.resourceId).sort(),
      ).toEqual(
        [seed.email.associationId, seed.email.junctionId, race.childId].sort(),
      );
      if (kind === 'reparent')
        expect(await present(ROOT, race.sourceId)).toBe(true);
      await assertProtected(seed);
    } finally {
      await closeWriter(race.writer);
      await deletion;
    }
  },
);

it.each(['insert', 'reparent'] as const)(
  'cleanup parent locks first, so later FK child %s fails after commit',
  async (kind) => {
    const seed = await seedDeletedChannel();
    const race = await prepareChildRace(seed, kind);
    const client = await f.pool.connect();
    const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid as number;
    const original = client.query.bind(client);
    const reached = barrier(),
      resume = barrier();
    let held = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      const result = await original(statement as string, values);
      if (
        !held &&
        text.startsWith('SELECT id FROM ' + table(ROOT)) &&
        text.includes('FOR UPDATE')
      ) {
        held = true;
        reached.release();
        await resume.promise;
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const deletion = capture(remove(seed.channelId));
    let mutation: ReturnType<typeof capture> | undefined;
    try {
      await Promise.race([
        reached.promise,
        deletion.then(() => {
          throw new Error('Cleanup settled before the parent lock barrier');
        }),
      ]);
      mutation = capture(race.write());
      await waitForBlocker(race.writerPid, nativePid);
      resume.release();
      expect(await deletion).toEqual({ ok: true, value: 1 });
      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          driverError: expect.objectContaining({ code: '23503' }),
        }),
      });
      expect(await audit()).toHaveLength(2);
      if (kind === 'insert')
        expect(await present(CHILD, race.childId)).toBe(false);
      else {
        expect(
          await f.owner.query(
            `SELECT "messageChannelMessageAssociationId" FROM ${table(CHILD)} WHERE id=$1`,
            [race.childId],
          ),
        ).toEqual([{ messageChannelMessageAssociationId: race.sourceId }]);
      }
      await assertProtected(seed);
    } finally {
      resume.release();
      await deletion;
      if (mutation) await mutation;
      await closeWriter(race.writer);
    }
  },
);
