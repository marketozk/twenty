import { randomUUID } from 'node:crypto';
import { type ObjectRecord } from 'twenty-shared/types';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { addCustomCrmMetadata } from 'test/fork-migration/custom-crm-metadata.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'customCase'],
  coreSchema: 'audit',
  configureMetadata: addCustomCrmMetadata,
});
const id = randomUUID(),
  secondId = randomUUID();
const run = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'native-lifecycle-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name = 'company') =>
  scope.getRepository(
    name,
    { shouldBypassPermissionChecks: true },
    { shouldSkipEventEmission: true },
  );
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS change_lifecycle ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".change_lifecycle()`,
  );
  await f.reset();
  for (const table of ['company', '_customCase'])
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."${table}"(id,name) VALUES ($1,'private first'),($2,'private second')`,
      [id, secondId],
    );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"companyId") VALUES ($1,$1)`,
    [id],
  );
});
afterAll(() => f.dispose());

it.each(['company', 'customCase'])(
  'soft-deletes and restores %s while preserving physical rows and related data',
  async (object) => {
    const table = object === 'company' ? 'company' : '_customCase',
      related = await f.read('person');
    const deleted = await run((scope) => repo(scope, object).softDelete(id));
    expect(deleted.affected).toBe(1);
    await run(async (scope) => {
      expect(await repo(scope, object).find({ where: { id } })).toEqual([]);
    });
    expect(
      ((await f.read(table)) as ObjectRecord[]).find((row) => row.id === id)
        ?.deletedAt,
    ).toBeInstanceOf(Date);
    const restored = await run((scope) => repo(scope, object).restore(id));
    expect(restored.affected).toBe(1);
    expect(
      ((await f.read(table)) as ObjectRecord[]).find((row) => row.id === id)
        ?.deletedAt,
    ).toBeNull();
    expect(await f.read('person')).toEqual(related);
    expect(await audit()).toHaveLength(2);
    expect(JSON.stringify(await audit())).not.toContain('private');
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it.each(['soft-delete', 'restore'] as const)(
  'keeps internal RETURNING id out of caller selection for %s',
  async (kind) => {
    if (kind === 'restore')
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [id],
      );
    const result = await run((scope) => {
      const repository = repo(scope);
      return repository.runMutation({
        selectQueryBuilder: repository.createQueryBuilder().where({ id }),
        rowLevelPermissionsApplied: false,
        kind,
        columnsToReturn: ['name'],
      });
    });
    expect(result).toEqual([{ name: 'private first' }]);
    expect((await audit())[0].resourceId).toBe(id);
  },
);

it('audits actual affected IDs in mixed lifecycle batches', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
    [secondId],
  );
  const deleted = await run((scope) =>
    repo(scope).softDelete([id, secondId, randomUUID()]),
  );
  expect(deleted.affected).toBe(1);
  expect((await audit()).map((entry) => entry.resourceId)).toEqual([id]);
  const restored = await run((scope) =>
    repo(scope).restore([id, secondId, randomUUID()]),
  );
  expect(restored.affected).toBe(2);
  expect(await audit()).toHaveLength(3);
});

it('captures lifecycle selection before the caller can mutate it', async () => {
  const result = await run(async (scope) => {
    const repository = repo(scope),
      columnsToReturn = ['name'];
    const pending = repository.runMutation({
      selectQueryBuilder: repository.createQueryBuilder().where({ id }),
      rowLevelPermissionsApplied: false,
      kind: 'soft-delete',
      columnsToReturn,
    });
    columnsToReturn.push('id');
    return pending;
  });
  expect(result).toEqual([{ name: 'private first' }]);
  expect((await audit())[0].resourceId).toBe(id);
});

it('preserves empty caller selection while auditing the actual lifecycle row', async () => {
  const result = await run((scope) => {
    const repository = repo(scope);
    return repository.runMutation({
      selectQueryBuilder: repository.createQueryBuilder().where({ id }),
      rowLevelPermissionsApplied: false,
      kind: 'soft-delete',
      columnsToReturn: [],
    });
  });
  expect(result).toEqual([{}]);
  expect((await audit())[0].resourceId).toBe(id);
});

it('distinguishes a live restore with an empty diff from unmatched lifecycle requests', async () => {
  await run((scope) => repo(scope).restore(id));
  expect(await audit()).toHaveLength(1);
  expect((await audit())[0].redactedDiff.changedFields).toEqual([]);
  await run((scope) => repo(scope).softDelete(id));
  expect((await run((scope) => repo(scope).softDelete(id))).affected).toBe(0);
  expect(
    (await run((scope) => repo(scope).restore(randomUUID()))).affected,
  ).toBe(0);
  expect(await audit()).toHaveLength(2);
});

it('aggregates soft-delete and restore to the actual final state in one operation', async () => {
  await run(async (scope) => {
    await repo(scope).softDelete(id);
    await repo(scope).restore(id);
  });
  expect(await audit()).toHaveLength(1);
  expect((await audit())[0].redactedDiff.changedFields).toEqual([]);
  expect(
    ((await f.read('company')) as ObjectRecord[]).find((row) => row.id === id)
      ?.deletedAt,
  ).toBeNull();
});

it('poisons a lifecycle owner when a later unsupported write is caught', async () => {
  const before = await f.read('company');
  await expect(
    run(async (scope) => {
      await repo(scope).softDelete(id);
      try {
        await repo(scope).delete(secondId);
      } catch {}
    }),
  ).rejects.toThrow('Native audit coverage excludes');
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toHaveLength(0);
});

it.each(['softDelete', 'restore'] as const)(
  'rejects a trigger that suppresses the required %s state',
  async (method) => {
    if (method === 'restore')
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [id],
      );
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".change_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."deletedAt"=OLD."deletedAt"; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER change_lifecycle BEFORE UPDATE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".change_lifecycle()`,
    );
    const before = await f.read('company');
    await expect(run((scope) => repo(scope)[method](id))).rejects.toThrow(
      'lifecycle postcondition',
    );
    expect(await f.read('company')).toEqual(before);
    expect(await audit()).toHaveLength(0);
  },
);

it.each(['softDelete', 'restore'] as const)(
  'serializes concurrent %s and identifies the actual state change',
  async (method) => {
    if (method === 'restore')
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [id],
      );
    await Promise.all([
      run((scope) => repo(scope)[method](id)),
      run((scope) => repo(scope)[method](id)),
    ]);
    const entries = await audit();
    expect(entries).toHaveLength(method === 'restore' ? 2 : 1);
    expect(
      entries.filter((entry) => entry.redactedDiff.changedFields.length),
    ).toHaveLength(1);
  },
);
