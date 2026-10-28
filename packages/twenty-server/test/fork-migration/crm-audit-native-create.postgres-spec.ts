import { randomUUID } from 'node:crypto';
import { FieldMetadataType, type ObjectRecord } from 'twenty-shared/types';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity'],
  coreSchema: 'audit',
});
const bypass = { shouldBypassPermissionChecks: true as const };
const id = randomUUID();
const secondId = randomUUID();
const objectIds: Record<string, string> = {};
const fieldId = (name: string, field: string) =>
  Object.values(f.flatFieldMetadataMaps.byUniversalIdentifier).find(
    (item) => item?.objectMetadataId === objectIds[name] && item.name === field,
  )!.id;
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const operation = () => ({
  operationId: randomUUID(),
  systemActorId: 'native-create-test',
});
const run = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
  nativeAudit = operation(),
) => f.withContext(() => f.dataSource.transaction(work, { nativeAudit }));
const repo = (
  scope: WorkspaceTransactionScope,
  name = 'company',
  skip = true,
) => scope.getRepository(name, bypass, { shouldSkipEventEmission: skip });
beforeAll(async () => {
  await f.withContext(async () => {
    const context = getWorkspaceContext();
    for (const name of ['company', 'person', 'opportunity'])
      objectIds[name] = context.objectIdByNameSingular[name];
    const company = Object.values(
      context.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.id === objectIds.company)!;
    const template = Object.values(
      f.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === objectIds.company &&
        field.name === 'position',
    )!;
    for (const [name, type] of [
      ['documents', FieldMetadataType.FILES],
      ['exactNumber', FieldMetadataType.NUMERIC],
      ['payload', FieldMetadataType.RAW_JSON],
    ] as const) {
      const field = {
        ...template,
        id: randomUUID(),
        universalIdentifier: randomUUID(),
        name,
        label: name,
        type,
        isNullable: true,
        isCustom: true,
        defaultValue: null,
      };
      f.flatFieldMetadataMaps.byUniversalIdentifier[field.universalIdentifier] =
        field;
      f.flatFieldMetadataMaps.universalIdentifierById[field.id] =
        field.universalIdentifier;
      company.fieldIds.push(field.id);
      company.fieldUniversalIdentifiers.push(field.universalIdentifier);
    }
  });
  await f.initialize();
});
beforeEach(() => f.reset());
afterEach(async () => {
  jest.restoreAllMocks();
  await f.owner.query(
    'DROP TRIGGER IF EXISTS fail_create_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query('DROP FUNCTION IF EXISTS crm_audit.fail_create_audit()');
  await f.owner.query(
    `DROP TRIGGER IF EXISTS change_created_row ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".change_created_row()`,
  );
});
afterAll(() => f.dispose());

it.each(['company', 'person', 'opportunity'])(
  'audits actual %s insert defaults with generated identity and no event dependency',
  async (name) => {
    const data =
      name === 'person'
        ? { name: { firstName: 'private' } }
        : { name: 'private' };
    const result = await run((scope) => repo(scope, name).insert(data));
    expect(result.identifiers).toHaveLength(1);
    const createdId = result.identifiers[0].id;
    expect(
      (await f.read(name as 'company')).find(
        (row: ObjectRecord) => row.id === createdId,
      ),
    ).toBeDefined();
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      resourceId: createdId,
      resourceKind: 'crmRecord',
      outcome: 'success',
      actor: { kind: 'system', id: 'native-create-test' },
      securityDescriptor: { objectMetadataId: objectIds[name] },
    });
    expect(rows[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining([
        fieldId(name, 'name'),
        fieldId(name, 'createdAt'),
        fieldId(name, 'updatedAt'),
      ]),
    );
    expect(rows[0].redactedDiff.values).toEqual({});
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('audits batch explicit IDs including identical IDs belonging to different objects', async () => {
  await run(async (scope) => {
    await repo(scope).insert([
      { id, name: 'one' },
      { id: secondId, name: 'two' },
    ]);
    await repo(scope, 'person').insert({ id, name: { firstName: 'person' } });
  });
  expect(await audit()).toHaveLength(3);
  expect(new Set((await audit()).map((row) => row.operationId)).size).toBe(1);
  expect(
    new Set(
      (await audit())
        .filter((row) => row.resourceId === id)
        .map((row) => row.securityDescriptor.objectMetadataId),
    ).size,
  ).toBe(2);
});

it.each([{ columnsToReturn: ['name'] }, { columnsToReturn: [] }])(
  'captures IDs internally for caller selection %j',
  async ({ columnsToReturn }) => {
    const result = await run((scope) =>
      repo(scope).runInsert({
        records: [{ name: 'projected' }],
        columnsToReturn,
      }),
    );
    expect(result.identifiers).toHaveLength(1);
    expect(result.raw).toHaveLength(1);
    expect(result.raw[0]).not.toHaveProperty('id');
    expect(Object.keys(result.raw[0])).toEqual(columnsToReturn);
    expect((await audit())[0].resourceId).toBe(result.identifiers[0].id);
  },
);

it('ignores conflicting rows without creating success audit or altering existing records', async () => {
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name) VALUES ($1,'existing')`,
    [id],
  );
  const result = await run((scope) =>
    repo(scope).insert(
      [
        { id, name: 'skip' },
        { id: secondId, name: 'insert' },
      ],
      { onConflictDoNothing: true },
    ),
  );
  expect(result.identifiers).toEqual([{ id: secondId }]);
  expect((await audit()).map((row) => row.resourceId)).toEqual([secondId]);
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('existing');
});

it('does not audit an empty or completely skipped insert', async () => {
  await f.owner.query(`INSERT INTO "${f.schemaName}".company(id) VALUES ($1)`, [
    id,
  ]);
  await run(async (scope) => {
    expect((await repo(scope).insert([])).identifiers).toEqual([]);
    expect(
      (await repo(scope).insert({ id }, { onConflictDoNothing: true }))
        .identifiers,
    ).toEqual([]);
  });
  expect(await audit()).toHaveLength(0);
});

it('keeps exact numeric, nested JSON and explicit timestamp values out of audit payload', async () => {
  await run((scope) =>
    repo(scope).insert({
      id,
      name: 'private',
      exactNumber: '9007199254740993.125',
      payload: { secret: ['private'] },
      createdAt: '2000-01-01T00:00:00.123456Z',
    }),
  );
  const rows = await f.owner.query(
    `SELECT "exactNumber"::text n, "createdAt"::text t, payload FROM "${f.schemaName}".company WHERE id=$1`,
    [id],
  );
  expect(rows[0]).toEqual({
    n: '9007199254740993.125',
    t: '2000-01-01 00:00:00.123456+00',
    payload: { secret: ['private'] },
  });
  expect(JSON.stringify(await audit())).not.toMatch(/private|9007199254740993/);
});

it.each(['save', 'upsert'] as const)(
  'audits mixed %s by actual create/update action in one operation',
  async (method) => {
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company(id,name) VALUES ($1,'existing')`,
      [id],
    );
    await run(async (scope) => {
      const repository = repo(scope);
      const data = [
        { id, name: 'updated' },
        { id: secondId, name: 'created' },
      ];
      if (method === 'save') await repository.save(data);
      else await repository.upsert(data, ['id']);
    });
    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.resourceId === id)?.action).toBe('update');
    expect(rows.find((row) => row.resourceId === secondId)?.action).toBe(
      'create',
    );
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(1);
  },
);

it('keeps create and later update as distinct action events', async () => {
  await run(async (scope) => {
    await repo(scope).insert({ id, name: 'initial' });
    await repo(scope).update(id, { name: 'final' });
  });
  expect((await audit()).map((row) => row.action).sort()).toEqual([
    'create',
    'update',
  ]);
});

it.each(['insert', 'save', 'upsert'] as const)(
  'rolls all native writes back on %s failure even if caught',
  async (method) => {
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company(id,name) VALUES ($1,'existing')`,
      [id],
    );
    await expect(
      run(async (scope) => {
        const repository = repo(scope);
        await repository.update(id, { name: 'rollback' });
        const input = [
          { id, name: 'duplicate' },
          { id: secondId, companyId: randomUUID() },
        ];
        try {
          if (method === 'insert') await repository.insert(input);
          else if (method === 'save') await repository.save(input);
          else await repository.upsert(input, ['id']);
        } catch {}
      }),
    ).rejects.toThrow();
    expect(
      (await f.read('company')).map((row: ObjectRecord) => row.name),
    ).toEqual(['existing']);
    expect(await audit()).toHaveLength(0);
  },
);

it('rolls back inserted records and deferred events when audit persistence fails', async () => {
  await f.owner.query(
    `CREATE FUNCTION crm_audit.fail_create_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_create_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_create_audit()',
  );
  await expect(
    run((scope) =>
      repo(scope, 'company', false).insert({ id, name: 'rollback' }),
    ),
  ).rejects.toThrow();
  expect(await f.read('company')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('preserves create events and stock acquisition until confirmed COMMIT', async () => {
  await run(async (scope) => {
    await repo(scope, 'company', false).insert({ id, name: 'created' });
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(f.recordStock.acquireRecordStock).not.toHaveBeenCalled();
  });
  expect(f.eventEmitter).toHaveBeenCalled();
  expect(f.recordStock.acquireRecordStock).toHaveBeenCalled();
  expect(await audit()).toHaveLength(1);
});

it('preserves unknown real COMMIT outcome without retry or failed audit', async () => {
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
    run((scope) => repo(scope).insert({ id, name: 'created' })),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
  expect(await f.read('company')).toHaveLength(1);
  expect(await audit()).toHaveLength(1);
});

it('denies native insert permission without creating records or audit', async () => {
  await expect(
    run((scope) =>
      scope
        .getRepository('company', { intersectionOf: { apiKeyRoleId: null } })
        .insert({ id, name: 'forbidden' }),
    ),
  ).rejects.toThrow();
  expect(await f.read('company')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it('keeps record stock denial before INSERT', async () => {
  f.recordStock.assertRecordStockAvailable.mockRejectedValueOnce(
    new Error('stock denied'),
  );
  await expect(
    run((scope) => repo(scope).insert({ id, name: 'forbidden' })),
  ).rejects.toThrow('stock denied');
  expect(await f.read('company')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it.each([
  { documents: 'invalid' },
  { documents: [{ fileId: 'invalid', label: 'private' }] },
])(
  'refuses invalid create FILES payload before core writes: %j',
  async ({ documents }) => {
    await expect(
      run((scope) => repo(scope).insert({ id, documents })),
    ).rejects.toThrow();
    expect(await f.read('company')).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);

it('allows nullable FILES without introducing a core attachment', async () => {
  await run((scope) =>
    repo(scope).insert({ id, name: 'empty', documents: null }),
  );
  expect((await f.read('company'))[0].documents).toBeNull();
  expect(await audit()).toHaveLength(1);
});

it('refuses a trigger-injected File attachment and rolls the row back', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".change_created_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.documents='[{"fileId":"${randomUUID()}","label":"private"}]'::jsonb; RETURN NEW; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER change_created_row BEFORE INSERT ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".change_created_row()`,
  );
  await expect(
    run((scope) => repo(scope).insert({ id, name: 'blocked' })),
  ).rejects.toThrow('Native created file links do not match the captured plan');
  expect(await f.read('company')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it('fails atomically when an inserted row disappears before audit readback', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".change_created_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "${f.schemaName}".company WHERE id=NEW.id; RETURN NEW; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER change_created_row AFTER INSERT ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".change_created_row()`,
  );
  await expect(
    run((scope) => repo(scope).insert({ id, name: 'gone' })),
  ).rejects.toThrow('vanished after insert');
  expect(await audit()).toHaveLength(0);
});

it('captures nested input before awaiting quota checks', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.recordStock.assertRecordStockAvailable.mockImplementationOnce(async () => {
    entered();
    await wait;
  });
  const data = { id, name: 'captured', payload: { nested: 'captured' } };
  const pending = run((scope) => repo(scope).insert(data));
  await ready;
  data.name = 'changed';
  data.payload.nested = 'changed';
  release();
  await pending;
  expect((await f.read('company'))[0]).toMatchObject({
    name: 'captured',
    payload: { nested: 'captured' },
  });
});

it('rejects input accessors without executing them', async () => {
  const getter = jest.fn(() => 'malicious');
  const data = { id };
  Object.defineProperty(data, 'name', { enumerable: true, get: getter });
  await expect(run((scope) => repo(scope).insert(data))).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(await audit()).toHaveLength(0);
});

it.each(['save', 'upsert'] as const)(
  'captures the complete %s request before its existence lookup',
  async (method) => {
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company(id,name) VALUES ($1,'existing')`,
      [id],
    );
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const client = await f.pool.connect(),
      query = client.query.bind(client);
    let paused = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      const result = await query(statement as string, values);
      if (!paused && text.includes('SELECT') && text.includes('company')) {
        paused = true;
        entered();
        await wait;
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const data = [
      { id, name: 'captured', payload: { nested: 'captured' } },
      { id: secondId, name: 'new', payload: { nested: 'new' } },
    ];
    const conflictPaths = ['id'];
    const pending = run<unknown>((scope) =>
      method === 'save'
        ? repo(scope).save(data)
        : repo(scope).upsert(data, conflictPaths),
    );
    await ready;
    data[0].name = 'mutated';
    data[0].payload.nested = 'mutated';
    data.push({
      id: randomUUID(),
      name: 'unexpected',
      payload: { nested: 'unexpected' },
    });
    conflictPaths[0] = 'name';
    release();
    await pending;
    expect(await f.read('company')).toHaveLength(2);
    expect(
      (await f.read('company')).find((row: ObjectRecord) => row.id === id),
    ).toMatchObject({ name: 'captured', payload: { nested: 'captured' } });
    expect(await audit()).toHaveLength(2);
  },
);

it('poisons the owner when a caught save validation error occurs before the insert kernel', async () => {
  await expect(
    run(async (scope) => {
      await repo(scope).insert({ id, name: 'rollback' });
      await expect(
        repo(scope, 'person').save({
          id: secondId,
          company: { connect: { where: { id } } },
        }),
      ).rejects.toThrow('nested relation');
    }),
  ).rejects.toThrow('nested relation');
  expect(await f.read('company')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it('rolls a mixed save back on a real foreign key violation in its new record', async () => {
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName") VALUES ($1,'existing')`,
    [id],
  );
  await expect(
    run((scope) =>
      repo(scope, 'person').save([
        { id, name: { firstName: 'rollback' } },
        { id: secondId, companyId: randomUUID() },
      ]),
    ),
  ).rejects.toThrow();
  const rows = await f.read('person');
  expect(rows).toHaveLength(1);
  expect(rows[0].nameFirstName).toBe('existing');
  expect(await audit()).toHaveLength(0);
});
