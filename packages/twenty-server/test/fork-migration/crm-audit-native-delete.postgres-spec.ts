import { randomUUID } from 'node:crypto';
import { FieldMetadataType } from 'twenty-shared/types';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
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
  configureMetadata: (maps) => {
    addCustomCrmMetadata(maps);
    const source = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find((field) => field?.name === 'name')!;
    const company = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'company')!;
    const field = {
      ...source,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      objectMetadataId: company.id,
      name: 'documents',
      label: 'Documents',
      type: FieldMetadataType.FILES,
      defaultValue: null,
      settings: null,
      isUnique: false,
    };
    maps.flatFieldMetadataMaps.byUniversalIdentifier[
      field.universalIdentifier
    ] = field;
    maps.flatFieldMetadataMaps.universalIdentifierById[field.id] =
      field.universalIdentifier;
  },
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
        systemActorId: 'native-delete-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name = 'company') =>
  scope.getRepository(name, { shouldBypassPermissionChecks: true });
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(`DROP TABLE IF EXISTS "${f.schemaName}".delete_child`);
  await f.owner.query(
    `DROP TRIGGER IF EXISTS keep_deleted ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".keep_deleted()`,
  );
  await f.reset();
  for (const table of ['company', '_customCase', 'opportunity'])
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."${table}"(id,name) VALUES ($1,'private first'),($2,'private second')`,
      [id, secondId],
    );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id) VALUES ($1),($2)`,
    [id, secondId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it.each(['company', 'person', 'opportunity', 'customCase'])(
  'audits actual physical deletion of %s with administrative descriptor',
  async (name) => {
    const result = await run((scope) =>
      repo(scope, name).delete([id, secondId, randomUUID()]),
    );
    expect(result.affected).toBe(2);
    expect(await f.read(name === 'customCase' ? '_customCase' : name)).toEqual(
      [],
    );
    const entries = await audit();
    expect(entries).toHaveLength(2);
    const objectMetadataId = await f.withContext(
      async () => getWorkspaceContext().objectIdByNameSingular[name],
    );
    for (const entry of entries) {
      expect(entry.action).toBe('delete');
      expect(entry.securityDescriptor).toEqual({
        resourceKind: 'crmRecord',
        resourceId: entry.resourceId,
        objectMetadataId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      });
    }
    expect(JSON.stringify(entries)).not.toContain('private');
    expect(f.recordStock.releaseRecordStock).toHaveBeenCalledTimes(1);
  },
);

it.each([[[]], [['name']]])(
  'preserves caller RETURNING selection %j',
  async (columnsToReturn) => {
    const rows = await run((scope) => {
      const repository = repo(scope);
      return repository.runMutation({
        selectQueryBuilder: repository.createQueryBuilder().where({ id }),
        rowLevelPermissionsApplied: false,
        kind: 'delete',
        columnsToReturn,
      });
    });
    expect(rows).toEqual(
      columnsToReturn.length ? [{ name: 'private first' }] : [{}],
    );
    expect((await audit())[0].resourceId).toBe(id);
  },
);

it('does not audit an unmatched delete', async () => {
  expect(
    (await run((scope) => repo(scope).delete(randomUUID()))).affected,
  ).toBe(0);
  expect(await audit()).toEqual([]);
});

it('rolls back deletion, audit, events and stock release when audit fails', async () => {
  const before = await f.read('company');
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(run((scope) => repo(scope).delete(id))).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
});

const childTable = async (action: string, composite = false) => {
  if (composite)
    await f.owner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS delete_parent_key ON "${f.schemaName}".company(id,name)`,
    );
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}".delete_child (id uuid PRIMARY KEY, parent_id uuid, parent_name text, "deletedAt" timestamptz, FOREIGN KEY (${composite ? 'parent_id,parent_name' : 'parent_id'}) REFERENCES "${f.schemaName}".company(${composite ? 'id,name' : 'id'}) ON DELETE ${action})`,
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON "${f.schemaName}".delete_child TO "${f.roleName}"`,
  );
};
it.each(['CASCADE', 'SET NULL', 'RESTRICT'])(
  'refuses %s references including soft-deleted children before mutation',
  async (action) => {
    await childTable(action);
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".delete_child(id,parent_id,"deletedAt") VALUES ($1,$2,now())`,
      [randomUUID(), id],
    );
    const before = await f.read('company'),
      children = await f.read('delete_child');
    await expect(run((scope) => repo(scope).delete(id))).rejects.toThrow(
      'excludes referenced',
    );
    expect(await f.read('company')).toEqual(before);
    expect(await f.read('delete_child')).toEqual(children);
    expect(await audit()).toEqual([]);
  },
);
it('checks every column of composite references', async () => {
  await childTable('CASCADE', true);
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".delete_child(id,parent_id,parent_name) VALUES ($1,$2,'private first')`,
    [randomUUID(), id],
  );
  await expect(run((scope) => repo(scope).delete(id))).rejects.toThrow(
    'excludes referenced',
  );
  expect(await audit()).toEqual([]);
});
it('poisons a caller-caught delete failure and rolls back previous writes', async () => {
  await childTable('CASCADE');
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".delete_child(id,parent_id) VALUES ($1,$2)`,
    [randomUUID(), id],
  );
  const before = await f.read('company');
  await expect(
    run(async (scope) => {
      await repo(scope).update(secondId, { name: 'changed' });
      try {
        await repo(scope).delete(id);
      } catch {}
    }),
  ).rejects.toThrow('excludes referenced');
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});
it.each([[null], [[]]])('permits empty FILES %j', async (files) => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".company SET documents=$1::jsonb WHERE id=$2`,
    [JSON.stringify(files), id],
  );
  await run((scope) => repo(scope).delete(id));
  expect(await audit()).toHaveLength(1);
});
it('refuses nonempty FILES before deletion', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".company SET documents=$1::jsonb WHERE id=$2`,
    [JSON.stringify([{ fileId: randomUUID(), label: 'private file' }]), id],
  );
  const before = await f.read('company');
  await expect(run((scope) => repo(scope).delete(id))).rejects.toThrow(
    'excludes linked files',
  );
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toEqual([]);
});
it('keeps separate create and delete events for a transient row in one operation', async () => {
  const createdId = randomUUID();
  await run(async (scope) => {
    await repo(scope).insert({ id: createdId, name: 'transient' });
    await repo(scope).delete(createdId);
  });
  const entries = await audit();
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((entry) => entry.action))).toEqual(
    new Set(['create', 'delete']),
  );
  expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
  expect(
    (await f.read('company')).some(
      (row: { id: string }) => row.id === createdId,
    ),
  ).toBe(false);
});
it('uses actual DELETE RETURNING when a trigger skips a row', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".keep_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${id}' THEN RETURN NULL; END IF; RETURN OLD; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER keep_deleted BEFORE DELETE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".keep_deleted()`,
  );
  expect(
    (await run((scope) => repo(scope).delete([id, secondId]))).affected,
  ).toBe(1);
  expect((await audit()).map((entry) => entry.resourceId)).toEqual([secondId]);
  expect(
    f.eventEmitter.mock.calls.flatMap(([batch]) =>
      batch.events.map((event: { recordId: string }) => event.recordId),
    ),
  ).toEqual([secondId]);
  expect(f.recordStock.releaseRecordStock).toHaveBeenCalledWith({
    workspaceId: f.workspaceId,
    quantity: 1,
  });
  expect(
    (await f.read('company')).map((row: { id: string }) => row.id),
  ).toEqual([id]);
});
it('rejects resurrection by a DELETE trigger and rolls back', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".keep_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${f.schemaName}".company(id,name) VALUES(OLD.id,OLD.name); RETURN OLD; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER keep_deleted AFTER DELETE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".keep_deleted()`,
  );
  const before = await f.read('company');
  await expect(run((scope) => repo(scope).delete(id))).rejects.toThrow(
    'remains after delete',
  );
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('emits no destroy events when every DELETE row is skipped', async () => {
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".keep_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER keep_deleted BEFORE DELETE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".keep_deleted()`,
  );
  expect(
    (await run((scope) => repo(scope).delete([id, secondId]))).affected,
  ).toBe(0);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(f.recordStock.releaseRecordStock).toHaveBeenCalledWith({
    workspaceId: f.workspaceId,
    quantity: 0,
  });
});

it('refuses delete after a concurrent FK insert commits first', async () => {
  await childTable('CASCADE');
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  await writer.query(
    `INSERT INTO "${f.schemaName}".delete_child(id,parent_id) VALUES ($1,$2)`,
    [randomUUID(), id],
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
    if (text.includes('FOR UPDATE') && text.includes('company'))
      lockRequested();
    return query(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const pending = run((scope) => repo(scope).delete(id));
  const refusal = expect(pending).rejects.toThrow('excludes referenced');
  try {
    await locking;
    await writer.commitTransaction();
    await refusal;
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
  }
  expect(
    (await f.read('company')).some((row: { id: string }) => row.id === id),
  ).toBe(true);
  expect(await f.read('delete_child')).toHaveLength(1);
  expect(await audit()).toEqual([]);
});

it('blocks a concurrent FK insert until deletion commits and rejects its stale reference', async () => {
  await childTable('CASCADE');
  let deleted!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (deleted = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const deletion = run(async (scope) => {
    await repo(scope).delete(id);
    deleted();
    await gate;
  });
  await ready;
  const insertion = f.owner
    .query(
      `/* native-delete-child */ INSERT INTO "${f.schemaName}".delete_child(id,parent_id) VALUES ($1,$2)`,
      [randomUUID(), id],
    )
    .then(
      () => ({ code: 'unexpected-success' }),
      (error: { code: string }) => error,
    );
  let blocked = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waits = await f.owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '/* native-delete-child */%'`,
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
  expect((await insertion).code).toBe('23503');
  expect(await f.read('delete_child')).toEqual([]);
  expect(await audit()).toHaveLength(1);
});

it('preserves retained omni identity protection without granting a domain capability', async () => {
  const accountId = randomUUID(),
    channelId = randomUUID(),
    bindingId = randomUUID(),
    identityId = randomUUID();
  await f.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    f.workspaceId,
  ]);
  await f.owner.query('INSERT INTO core."connectedAccount"(id) VALUES ($1)', [
    accountId,
  ]);
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type) VALUES ($1,$2,\'APP\')',
    [channelId, f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAccountBinding"(id,"workspaceId",platform,"connectorInstanceId","accountId","connectedAccountId","messageChannelId","capabilitiesVersion",capabilities) VALUES ($1,$2,'telegram','delete-test','synthetic',$3,$4,'v1','{}')`,
    [bindingId, f.workspaceId, accountId, channelId],
  );
  await f.owner.query(
    `INSERT INTO core."omniExternalIdentity"(id,"workspaceId","bindingId","providerPeerId","personId","verificationSource") VALUES ($1,$2,$3,'synthetic',$4,'test')`,
    [identityId, f.workspaceId, bindingId, id],
  );
  const before = await f.read('person');
  try {
    await expect(
      run((scope) => repo(scope, 'person').delete(id)),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    expect(await f.read('person')).toEqual(before);
    expect(await audit()).toEqual([]);
  } finally {
    await f.owner.query('DELETE FROM core."omniExternalIdentity" WHERE id=$1', [
      identityId,
    ]);
    await f.owner.query('DELETE FROM core."omniAccountBinding" WHERE id=$1', [
      bindingId,
    ]);
    await f.owner.query('DELETE FROM core."messageChannel" WHERE id=$1', [
      channelId,
    ]);
    await f.owner.query('DELETE FROM core."connectedAccount" WHERE id=$1', [
      accountId,
    ]);
    await f.owner.query('DELETE FROM core.workspace WHERE id=$1', [
      f.workspaceId,
    ]);
  }
});

it('preserves object-level destroy permission refusal', async () => {
  const before = await f.read('company');
  await expect(
    run((scope) =>
      scope
        .getRepository('company', {
          intersectionOf: { userWorkspaceRoleId: null },
        })
        .delete(id),
    ),
  ).rejects.toThrow();
  expect(await f.read('company')).toEqual(before);
  expect(await audit()).toEqual([]);
});
it('reports actual lost COMMIT acknowledgement without retry or rollback', async () => {
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
  await expect(run((scope) => repo(scope).delete(id))).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await audit()).toHaveLength(1);
  expect(
    (await f.read('company')).some((row: { id: string }) => row.id === id),
  ).toBe(false);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
});

it.each([
  'missing',
  'wrong access',
  'extra key',
  'wrong action',
  'wrong resource',
])('rejects %s deleted-record descriptors', (kind) => {
  const descriptor: Record<string, unknown> = {
    resourceKind: 'crmRecord',
    resourceId: id,
    objectMetadataId: randomUUID(),
    deletedRecord: { access: 'currentWorkspaceAdministration' },
  };
  if (kind === 'missing') delete descriptor.deletedRecord;
  if (kind === 'wrong access')
    descriptor.deletedRecord = { access: 'historical' };
  if (kind === 'extra key')
    descriptor.deletedRecord = {
      access: 'currentWorkspaceAdministration',
      grant: true,
    };
  if (kind === 'wrong resource') descriptor.resourceKind = 'crmFile';
  const context = new CrmAuditTransactionContext(
    { query: jest.fn(), isTransactionActive: true, isReleased: false },
    {
      workspaceId: f.workspaceId,
      operationId: randomUUID(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  expect(() =>
    context.record({
      resourceKind: descriptor.resourceKind,
      resourceId: id,
      action: kind === 'wrong action' ? 'update' : 'delete',
      before: {},
      after: null,
      securityDescriptor: descriptor,
    } as Parameters<typeof context.record>[0]),
  ).toThrow();
});
