import { randomUUID } from 'node:crypto';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company'],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
});
const personId = randomUUID(),
  companyId = randomUUID(),
  otherCompanyId = randomUUID();
const run = <T>(work: (scope: WorkspaceTransactionScope) => Promise<T>) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'update-fk-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope) =>
  scope.getRepository('person', { shouldBypassPermissionChecks: true });
const audits = () => f.owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
const addReference = async (
  column = 'companyId',
  action = 'CASCADE',
  populated = true,
) => {
  await f.owner.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "person_${column}_pair" ON "${f.schemaName}".person(id,"${column}")`,
  );
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".update_child AS SELECT id, id AS "personId", "${column}" AS value FROM "${f.schemaName}".person WITH NO DATA`,
  );
  await f.owner.query(
    `ALTER TABLE "${f.schemaName}".update_child ADD FOREIGN KEY ("personId",value) REFERENCES "${f.schemaName}".person(id,"${column}") ON UPDATE ${action}`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".update_child TO "${f.roleName}"`,
  );
  if (populated)
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".update_child SELECT id,id,"${column}" FROM "${f.schemaName}".person`,
    );
};
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS rewrite_key ON "${f.schemaName}".person`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".rewrite_key()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS "${f.schemaName}".update_child`);
  await f.reset();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name) VALUES($1,'first'),($2,'second')`,
    [companyId, otherCompanyId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName","companyId","updatedAt") VALUES($1,'private',$2,'2020-01-01')`,
    [personId, companyId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it.each([true, false])(
  'handles a BEFORE trigger key rewrite with populated references=%s',
  async (populated) => {
    await addReference('companyId', 'CASCADE', populated);
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".rewrite_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."companyId"='${otherCompanyId}'; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER rewrite_key BEFORE UPDATE ON "${f.schemaName}".person FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".rewrite_key()`,
    );
    const before = await f.read('person'),
      children = await f.read('update_child');
    const mutation = run((scope) =>
      repo(scope).update(personId, { name: { firstName: 'changed' } }),
    );
    if (populated) {
      await expect(mutation).rejects.toThrow('referential UPDATE');
      expect(await f.read('person')).toEqual(before);
      expect(await audits()).toEqual([]);
    } else {
      await mutation;
      expect((await f.read('person'))[0].companyId).toBe(otherCompanyId);
      expect(await audits()).toHaveLength(1);
    }
    expect(await f.read('update_child')).toEqual(children);
  },
);

it('preserves the legacy non-audited update path', async () => {
  await addReference();
  await f.withContext(() =>
    f.dataSource.transaction((scope) =>
      repo(scope).update(personId, { companyId: otherCompanyId }),
    ),
  );
  expect((await f.read('update_child'))[0].value).toBe(otherCompanyId);
  expect(await audits()).toEqual([]);
});

it('does not confuse a reference to a different composite parent key', async () => {
  const otherPerson = randomUUID();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"companyId") VALUES($1,$2)`,
    [otherPerson, companyId],
  );
  await addReference();
  await f.owner.query(
    `DELETE FROM "${f.schemaName}".update_child WHERE "personId"=$1`,
    [personId],
  );
  const before = await f.read('update_child');
  await run((scope) =>
    repo(scope).update(personId, { companyId: otherCompanyId }),
  );
  expect(await f.read('update_child')).toEqual(before);
  expect(await audits()).toHaveLength(1);
});

it('observes a referencing insert committed before the parent FOR UPDATE lock', async () => {
  await addReference('companyId', 'CASCADE', false);
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  await writer.query(
    `INSERT INTO "${f.schemaName}".update_child SELECT id,id,"companyId" FROM "${f.schemaName}".person`,
  );
  let lockRequested!: () => void;
  const locking = new Promise<void>((resolve) => (lockRequested = resolve));
  const client = await f.pool.connect(),
    query = client.query.bind(client);
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (text.includes('FOR UPDATE') && text.includes('."person"'))
      lockRequested();
    return query(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const update = run((scope) =>
    repo(scope).update(personId, { companyId: otherCompanyId }),
  );
  const rejection = expect(update).rejects.toThrow('referential UPDATE');
  try {
    await locking;
    await writer.commitTransaction();
    await rejection;
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
  }
  expect((await f.read('person'))[0].companyId).toBe(companyId);
  expect((await f.read('update_child'))[0].value).toBe(companyId);
  expect(await audits()).toEqual([]);
});

it('holds the parent lock so a later referencing insert cannot slip past the guard', async () => {
  await addReference('companyId', 'CASCADE', false);
  let ready!: () => void, release!: () => void;
  const changed = new Promise<void>((resolve) => (ready = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const update = run(async (scope) => {
    await repo(scope).update(personId, { companyId: otherCompanyId });
    ready();
    await gate;
  });
  await changed;
  const insert = f.owner.query(
    `/* update-fk-late-insert */ INSERT INTO "${f.schemaName}".update_child VALUES($1,$1,$2)`,
    [personId, companyId],
  );
  const rejected = expect(insert).rejects.toThrow(/foreign key/i);
  let blocked = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waits = await f.owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '/* update-fk-late-insert */%'`,
      );
      if (waits.length) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
  } finally {
    release();
    await update;
  }
  await rejected;
  expect(await f.read('update_child')).toEqual([]);
  expect(await audits()).toHaveLength(1);
});

it('refuses an actual composite ON UPDATE CASCADE before an unaudited child change', async () => {
  await addReference();
  const before = await f.read('person'),
    childBefore = await f.read('update_child');
  await expect(
    run((scope) => repo(scope).update(personId, { companyId: otherCompanyId })),
  ).rejects.toThrow('referential UPDATE');
  expect(await f.read('person')).toEqual(before);
  expect(await f.read('update_child')).toEqual(childBefore);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['SET NULL', 'SET DEFAULT'])(
  'refuses actual ON UPDATE %s effects',
  async (action) => {
    await addReference('companyId', action);
    const before = await f.read('update_child');
    await expect(
      run((scope) =>
        repo(scope).update(personId, { companyId: otherCompanyId }),
      ),
    ).rejects.toThrow('referential UPDATE');
    expect(await f.read('update_child')).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('rolls back earlier batch items when a later item changes a referenced key', async () => {
  const secondId = randomUUID();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName","companyId") VALUES($1,'second',$2)`,
    [secondId, companyId],
  );
  await addReference();
  const before = await f.read('person');
  await expect(
    run((scope) =>
      repo(scope).runBatchUpdate({
        inputs: [
          { id: secondId, data: { name: { firstName: 'changed' } } },
          { id: personId, data: { companyId: otherCompanyId } },
        ],
        columnsToReturn: ['id'],
      }),
    ),
  ).rejects.toThrow('referential UPDATE');
  expect(await f.read('person')).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('poisons the owner even if the caller catches the guard error', async () => {
  await addReference();
  const before = await f.read('person');
  await expect(
    run(async (scope) => {
      await repo(scope).update(personId, { name: { firstName: 'earlier' } });
      try {
        await repo(scope).update(personId, { companyId: otherCompanyId });
      } catch {
        /* owner must remain failed */
      }
    }),
  ).rejects.toThrow();
  expect(await f.read('person')).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('allows a supplied but unchanged referenced value', async () => {
  await addReference();
  const before = await f.read('update_child');
  await run((scope) =>
    repo(scope).update(personId, { companyId, name: { firstName: 'changed' } }),
  );
  expect(await f.read('update_child')).toEqual(before);
  expect(await audits()).toHaveLength(1);
});

it('allows actual key changes when no referencing rows exist', async () => {
  await addReference('companyId', 'CASCADE', false);
  await run((scope) =>
    repo(scope).update(personId, { companyId: otherCompanyId }),
  );
  expect((await f.read('person'))[0].companyId).toBe(otherCompanyId);
  expect(await f.read('update_child')).toEqual([]);
  expect(await audits()).toHaveLength(1);
});

it('allows FK references to unchanged id', async () => {
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".update_child(id uuid PRIMARY KEY REFERENCES "${f.schemaName}".person(id) ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".update_child TO "${f.roleName}"`,
  );
  await f.owner.query(`INSERT INTO "${f.schemaName}".update_child VALUES($1)`, [
    personId,
  ]);
  await run((scope) =>
    repo(scope).update(personId, { companyId: otherCompanyId }),
  );
  expect(await f.read('update_child')).toEqual([{ id: personId }]);
  expect(await audits()).toHaveLength(1);
});

it('does not reject an unmatched update because another record has references', async () => {
  await addReference();
  expect(
    (
      await run((scope) =>
        repo(scope).update(randomUUID(), { companyId: otherCompanyId }),
      )
    ).affected,
  ).toBe(0);
  expect(await audits()).toEqual([]);
});

it.each(['update', 'batch', 'softDelete', 'restore'])(
  'checks implicit updatedAt changes for %s',
  async (operation) => {
    await addReference('updatedAt');
    const before = await f.read('person'),
      children = await f.read('update_child');
    await expect(
      run((scope) => {
        if (operation === 'batch')
          return repo(scope).runBatchUpdate({
            inputs: [
              { id: personId, data: { name: { firstName: 'changed' } } },
            ],
            columnsToReturn: ['id'],
          });
        if (operation === 'softDelete') return repo(scope).softDelete(personId);
        if (operation === 'restore') return repo(scope).restore(personId);
        return repo(scope).update(personId, { name: { firstName: 'changed' } });
      }),
    ).rejects.toThrow('referential UPDATE');
    expect(await f.read('person')).toEqual(before);
    expect(await f.read('update_child')).toEqual(children);
    expect(await audits()).toEqual([]);
  },
);

it('compares explicit updatedAt using database timestamp equality', async () => {
  await addReference('updatedAt');
  const before = await f.read('update_child');
  await run((scope) =>
    repo(scope).update(personId, {
      updatedAt: '2020-01-01T03:00:00+03:00',
      name: { firstName: 'changed' },
    }),
  );
  expect(await f.read('update_child')).toEqual(before);
  expect(await audits()).toHaveLength(1);
});

it('checks restore changes to a referenced deletedAt', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".person SET "deletedAt"='2020-01-01' WHERE id=$1`,
    [personId],
  );
  await addReference('deletedAt');
  const before = await f.read('person');
  await expect(run((scope) => repo(scope).restore(personId))).rejects.toThrow(
    'referential UPDATE',
  );
  expect(await f.read('person')).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('preserves the soft-delete live-row predicate for an already archived record', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".person SET "deletedAt"='2020-01-01' WHERE id=$1`,
    [personId],
  );
  await addReference('updatedAt');
  expect(
    (await run((scope) => repo(scope).softDelete(personId))).affected,
  ).toBe(0);
  expect(await audits()).toEqual([]);
});

it.each(['NO ACTION', 'RESTRICT'])(
  'preserves PostgreSQL rejection for %s',
  async (action) => {
    await addReference('companyId', action);
    await expect(
      run((scope) =>
        repo(scope).update(personId, { companyId: otherCompanyId }),
      ),
    ).rejects.toThrow(/foreign key/i);
    expect(await audits()).toEqual([]);
  },
);
