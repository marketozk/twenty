import { randomUUID } from 'node:crypto';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { addCustomCrmMetadata } from 'test/fork-migration/custom-crm-metadata.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity', 'customCase'],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  configureMetadata: (maps) => {
    addCustomCrmMetadata(maps);
    const custom = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((value) => value?.nameSingular === 'customCase')!;
    const source = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (value) =>
        value?.objectMetadataId === custom.id && value.name === 'company',
    )!;
    const field = {
      ...source,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      name: 'backupCompany',
      label: 'Backup company',
      settings: {
        ...source.settings,
        relationType: 'MANY_TO_ONE',
        joinColumnName: 'backupCompanyId',
      },
    } as typeof source;
    maps.flatFieldMetadataMaps.byUniversalIdentifier[
      field.universalIdentifier
    ] = field;
    maps.flatFieldMetadataMaps.universalIdentifierById[field.id] =
      field.universalIdentifier;
  },
});
const parentId = randomUUID(),
  otherParentId = randomUUID(),
  personId = randomUUID(),
  secondPersonId = randomUUID(),
  opportunityId = randomUUID(),
  customId = randomUUID();
const read = (name: string): Promise<Record<string, unknown>[]> => f.read(name);
const audits = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );
const run = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'set-null-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name = 'company') =>
  scope.getRepository(name, { shouldBypassPermissionChecks: true });
const snapshot = async () => ({
  company: await read('company'),
  person: await read('person'),
  opportunity: await read('opportunity'),
  custom: await read('_customCase'),
});
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TABLE IF EXISTS "${f.schemaName}".unsupported_child`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS "${f.schemaName}".grandchild`);
  await f.owner.query(
    `ALTER TABLE "${f.schemaName}".person DROP CONSTRAINT IF EXISTS test_action`,
  );
  for (const table of ['company', 'person']) {
    await f.owner.query(
      `DROP TRIGGER IF EXISTS test_effect ON "${f.schemaName}".${table}`,
    );
    await f.owner.query(
      `DROP FUNCTION IF EXISTS "${f.schemaName}".test_effect_${table}()`,
    );
  }
  await f.reset();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name) VALUES($1,'private parent'),($2,'other')`,
    [parentId, otherParentId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName","companyId","deletedAt") VALUES($1,'private child',$3,NULL),($2,'archived child',$3,'2026-01-01')`,
    [personId, secondPersonId, parentId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".opportunity(id,name,"companyId") VALUES($1,'private deal',$2)`,
    [opportunityId, parentId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"."_customCase"(id,name,"companyId","backupCompanyId") VALUES($1,'private custom',$2,$2)`,
    [customId, parentId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('audits actual standard SET NULL effects without extra timestamps or child events', async () => {
  const before = await snapshot();
  expect((await run((scope) => repo(scope).delete(parentId))).affected).toBe(1);
  const after = await snapshot();
  expect(after.person).toEqual(
    before.person.map((row) => ({ ...row, companyId: null })),
  );
  expect(after.opportunity).toEqual(
    before.opportunity.map((row) => ({ ...row, companyId: null })),
  );
  expect(after.custom).toEqual(
    before.custom.map((row) => ({
      ...row,
      companyId: null,
      backupCompanyId: null,
    })),
  );
  const entries = await audits();
  expect(entries).toHaveLength(5);
  expect(entries.filter((row) => row.action === 'delete')).toHaveLength(1);
  expect(new Set(entries.map((row) => row.operationId)).size).toBe(1);
  expect(JSON.stringify(entries)).not.toContain('private');
  expect(
    f.eventEmitter.mock.calls.flatMap(([batch]) =>
      batch.events.map((event: { recordId: string }) => event.recordId),
    ),
  ).toEqual([parentId]);
});

it('aggregates two FK effects on the same child across deleted parents', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}"."_customCase" SET "backupCompanyId"=$1 WHERE id=$2`,
    [otherParentId, customId],
  );
  await run((scope) => repo(scope).delete([parentId, otherParentId]));
  const entries = await audits();
  expect(entries).toHaveLength(6);
  expect(entries.filter((row) => row.resourceId === customId)).toHaveLength(1);
  expect((await read('_customCase'))[0]).toMatchObject({
    companyId: null,
    backupCompanyId: null,
  });
});

it('preserves the other parent FK and audits only the actual nulling fields', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}"."_customCase" SET "backupCompanyId"=$1 WHERE id=$2`,
    [otherParentId, customId],
  );
  await run((scope) => repo(scope).delete(parentId));
  const entry = (await audits()).find((row) => row.resourceId === customId)!;
  expect(entry.redactedDiff.changedFields).toHaveLength(1);
  expect((await read('_customCase'))[0]).toMatchObject({
    companyId: null,
    backupCompanyId: otherParentId,
  });
});

it('rolls back the complete cascade graph when audit insertion fails', async () => {
  const before = await snapshot();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(
      run((scope) => repo(scope).delete(parentId)),
    ).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
});

it.each(['CASCADE', 'SET DEFAULT', 'RESTRICT'])(
  'rejects uncovered %s action without partially nulling other records',
  async (action) => {
    await f.owner.query(
      `ALTER TABLE "${f.schemaName}".person ADD CONSTRAINT test_action FOREIGN KEY ("companyId") REFERENCES "${f.schemaName}".company(id) ON DELETE ${action}`,
    );
    const before = await snapshot();
    await expect(run((scope) => repo(scope).delete(parentId))).rejects.toThrow(
      'outside SET NULL coverage',
    );
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('rejects an unregistered child table even with SET NULL', async () => {
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".unsupported_child(id uuid PRIMARY KEY,parent_id uuid REFERENCES "${f.schemaName}".company(id) ON DELETE SET NULL)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".unsupported_child TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".unsupported_child VALUES($1,$2)`,
    [randomUUID(), parentId],
  );
  const before = await snapshot();
  await expect(run((scope) => repo(scope).delete(parentId))).rejects.toThrow(
    'outside SET NULL coverage',
  );
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it.each(['nameFirstName', 'updatedAt'])(
  'rejects a child trigger changing unrelated %s',
  async (column) => {
    const value =
      column === 'updatedAt' ? "'2030-01-01'" : "'changed by trigger'";
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".test_effect_person() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."${column}"=${value}; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER test_effect BEFORE UPDATE ON "${f.schemaName}".person FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".test_effect_person()`,
    );
    const before = await snapshot();
    await expect(run((scope) => repo(scope).delete(parentId))).rejects.toThrow(
      'SET NULL postcondition',
    );
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('refuses transitive ON UPDATE CASCADE effects beyond the audited child', async () => {
  await f.owner.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS person_company_pair ON "${f.schemaName}".person(id,"companyId")`,
  );
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".grandchild(id uuid PRIMARY KEY,"personId" uuid,"companyId" uuid,FOREIGN KEY ("personId","companyId") REFERENCES "${f.schemaName}".person(id,"companyId") ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".grandchild TO "${f.roleName}"`,
  );
  const grandchildId = randomUUID();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".grandchild VALUES($1,$2,$3)`,
    [grandchildId, personId, parentId],
  );
  const probe = f.owner.createQueryRunner();
  await probe.connect();
  await probe.startTransaction();
  try {
    await probe.query(`DELETE FROM "${f.schemaName}".company WHERE id=$1`, [
      parentId,
    ]);
    expect(
      (
        await probe.query(
          `SELECT "companyId" FROM "${f.schemaName}".grandchild WHERE id=$1`,
          [grandchildId],
        )
      )[0].companyId,
    ).toBeNull();
  } finally {
    await probe.rollbackTransaction();
    await probe.release();
  }
  const before = await snapshot(),
    grandchildren = await read('grandchild');
  await expect(run((scope) => repo(scope).delete(parentId))).rejects.toThrow(
    'transitive',
  );
  expect(await snapshot()).toEqual(before);
  expect(await read('grandchild')).toEqual(grandchildren);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('allows grandchild references to unchanged child columns', async () => {
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".grandchild(id uuid PRIMARY KEY,"personId" uuid REFERENCES "${f.schemaName}".person(id) ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".grandchild TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".grandchild VALUES($1,$2)`,
    [randomUUID(), personId],
  );
  const before = await read('grandchild');
  await run((scope) => repo(scope).delete(parentId));
  expect(await read('grandchild')).toEqual(before);
  expect(await audits()).toHaveLength(5);
});

it('allows empty transitive foreign-key tables', async () => {
  await f.owner.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS person_company_pair ON "${f.schemaName}".person(id,"companyId")`,
  );
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".grandchild(id uuid PRIMARY KEY,"personId" uuid,"companyId" uuid,FOREIGN KEY ("personId","companyId") REFERENCES "${f.schemaName}".person(id,"companyId") ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}".grandchild TO "${f.roleName}"`,
  );
  await run((scope) => repo(scope).delete(parentId));
  expect(await read('grandchild')).toEqual([]);
  expect(await audits()).toHaveLength(5);
});

it('poisons caught SET NULL postcondition failures', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".test_effect_person() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."nameFirstName"='unexpected'; RETURN NEW; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER test_effect BEFORE UPDATE ON "${f.schemaName}".person FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".test_effect_person()`,
  );
  const before = await snapshot();
  await expect(
    run(async (scope) => {
      await repo(scope).update(otherParentId, { name: 'changed' });
      try {
        await repo(scope).delete(parentId);
      } catch {}
    }),
  ).rejects.toThrow('SET NULL postcondition');
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('keeps children unchanged when the parent delete is skipped', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".test_effect_company() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER test_effect BEFORE DELETE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".test_effect_company()`,
  );
  const before = await snapshot();
  expect((await run((scope) => repo(scope).delete(parentId))).affected).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('aggregates explicit child update and later cascade using first-before and final-after', async () => {
  await run(async (scope) => {
    await repo(scope, 'person').update(personId, {
      name: { firstName: 'changed' },
    });
    await repo(scope).delete(parentId);
  });
  const entries = await audits();
  expect(entries).toHaveLength(5);
  expect(entries.filter((row) => row.resourceId === personId)).toHaveLength(1);
  expect(
    (await read('person')).find((row) => row.id === personId),
  ).toMatchObject({ companyId: null, nameFirstName: 'changed' });
});

it('does not null a child reparented before its lock is acquired', async () => {
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  await writer.query(
    `UPDATE "${f.schemaName}".person SET "companyId"=$1 WHERE id=$2`,
    [otherParentId, personId],
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
  const deletion = run((scope) => repo(scope).delete(parentId));
  try {
    await locking;
    await writer.commitTransaction();
    await deletion;
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
  }
  expect(
    (await read('person')).find((row) => row.id === personId)?.companyId,
  ).toBe(otherParentId);
  const entries = await audits();
  expect(entries).toHaveLength(4);
  expect(entries.some((row) => row.resourceId === personId)).toBe(false);
});

it('serializes reparenting after a committed SET NULL without recording the later change', async () => {
  let changed!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (changed = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const deletion = run(async (scope) => {
    await repo(scope).delete(parentId);
    changed();
    await gate;
  });
  await ready;
  const reparent = f.owner.query(
    `/* set-null-reparent */ UPDATE "${f.schemaName}".person SET "companyId"=$1 WHERE id=$2`,
    [otherParentId, personId],
  );
  let blocked = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waits = await f.owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '/* set-null-reparent */%'`,
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
    await deletion;
  }
  await reparent;
  expect(
    (await read('person')).find((row) => row.id === personId)?.companyId,
  ).toBe(otherParentId);
  const entries = await audits();
  expect(entries).toHaveLength(5);
  expect(entries.filter((row) => row.resourceId === personId)).toHaveLength(1);
});

it('reports actual lost COMMIT acknowledgement for the whole graph without replay', async () => {
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
  await expect(
    run((scope) => repo(scope).delete(parentId)),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  expect(await audits()).toHaveLength(5);
  expect((await read('person')).every((row) => row.companyId === null)).toBe(
    true,
  );
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
});
