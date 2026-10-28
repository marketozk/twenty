import { FieldMetadataType } from 'twenty-shared/types';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { randomUUID } from 'node:crypto';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { captureNativeCrmAuditOperation } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company'],
  coreSchema: 'audit',
});
const id = randomUUID();
const secondId = randomUUID();
const permissions = { shouldBypassPermissionChecks: true as const };
const opts = () => ({
  operationId: randomUUID(),
  systemActorId: 'native-company-test',
});
const run = async <T>(
  work: (scope: WorkspaceTransactionScope) => Promise<T>,
  nativeAudit = opts(),
) => f.withContext(() => f.dataSource.transaction(work, { nativeAudit }));
const repo = (scope: WorkspaceTransactionScope, skip = true) =>
  scope.getRepository('company', permissions, {
    shouldSkipEventEmission: skip,
  });
const readCompany = async (): Promise<
  { id: string; name: string; position: number }[]
> => f.read('company');
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const fieldId = (name: string) => {
  const field = Object.values(
    f.flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(
    (item) =>
      item?.name === name && item.objectMetadataId === companyMetadataId,
  );
  if (!field) throw new Error('Missing Company field');
  return field.id;
};
let companyMetadataId: string;
beforeAll(async () => {
  await f.withContext(async () => {
    const context = getWorkspaceContext();
    const objectId = context.objectIdByNameSingular.company;
    const object = Object.values(
      context.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((item) => item?.id === objectId)!;
    const position = Object.values(
      f.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (item) => item?.objectMetadataId === objectId && item.name === 'position',
    )!;
    const numericField = {
      ...position,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      name: 'exactNumber',
      isNullable: true,
      label: 'Exact number',
      type: FieldMetadataType.NUMERIC,
      isCustom: true,
      defaultValue: null,
    };
    f.flatFieldMetadataMaps.byUniversalIdentifier[
      numericField.universalIdentifier
    ] = numericField;
    f.flatFieldMetadataMaps.universalIdentifierById[numericField.id] =
      numericField.universalIdentifier;
    object.fieldIds.push(numericField.id);
    object.fieldUniversalIdentifiers.push(numericField.universalIdentifier);
  });
  await f.initialize();
  companyMetadataId = await f.withContext(
    async () => getWorkspaceContext().objectIdByNameSingular.company,
  );
});
beforeEach(async () => {
  await f.reset();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name,position) VALUES ($1,'original-private',1),($2,'second-private',2)`,
    [id, secondId],
  );
});
afterEach(async () => {
  jest.restoreAllMocks();
  await f.owner.query(
    'DROP TRIGGER IF EXISTS fail_native_company_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    'DROP FUNCTION IF EXISTS crm_audit.fail_native_company_audit()',
  );
});
afterAll(() => f.dispose());

it('writes one scoped redacted audit with the actual native update despite suppressed events', async () => {
  const operation = opts();
  await run(async (scope) => {
    expect(
      (await repo(scope).update(id, { name: 'secret-new', position: 8 }))
        .affected,
    ).toBe(1);
  }, operation);
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    workspaceId: f.workspaceId,
    operationId: operation.operationId,
    resourceKind: 'crmRecord',
    resourceId: id,
    action: 'update',
    outcome: 'success',
    actor: { kind: 'system', id: 'native-company-test' },
    securityDescriptor: {
      resourceKind: 'crmRecord',
      resourceId: id,
      objectMetadataId: companyMetadataId,
    },
  });
  expect(rows[0].redactedDiff.changedFields).toEqual(
    [fieldId('position'), fieldId('name')].sort(),
  );
  expect(rows[0].redactedDiff.values).toEqual({});
  expect(JSON.stringify(rows)).not.toMatch(/original-private|secret-new/);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect((await readCompany()).find((row) => row.id === id)).toMatchObject({
    name: 'secret-new',
    position: 8,
  });
});

it('audits real affected batch rows only, including repeated inputs as one aggregated event', async () => {
  await run((scope) =>
    repo(scope).updateMany([
      { criteria: id, partialEntity: { name: 'first' } },
      { criteria: secondId, partialEntity: { position: 4 } },
      { criteria: randomUUID(), partialEntity: { name: 'missing' } },
      { criteria: id, partialEntity: { name: 'last' } },
    ]),
  );
  const rows = await audit();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.resourceId))).toEqual(
    new Set([id, secondId]),
  );
  expect((await readCompany()).find((row) => row.id === id)?.name).toBe('last');
});

it('aggregates first-before and last-after across repositories in one owned transaction', async () => {
  await run(async (scope) => {
    await repo(scope).update(id, { name: 'temporary', position: 3 });
    await repo(scope).update(id, { name: 'original-private', position: 5 });
  });
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0].redactedDiff.changedFields).toEqual([fieldId('position')]);
});

it('keeps ordinary events without making them the audit source', async () => {
  await run((scope) => repo(scope, false).update(id, { position: 3 }));
  expect(await audit()).toHaveLength(1);
  expect(f.eventEmitter).toHaveBeenCalled();
});

it('does not audit a predicate that affects no rows', async () => {
  await run((scope) =>
    repo(scope).update({ id, name: 'not-current' }, { position: 3 }),
  );
  expect(await audit()).toEqual([]);
});

it('rolls native changes and events back when audit insert fails', async () => {
  await f.owner.query(
    `CREATE FUNCTION crm_audit.fail_native_company_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUDIT_FAILURE'; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_native_company_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_native_company_audit()',
  );
  const error: unknown = await run((scope) =>
    repo(scope, false).update(id, { position: 9 }),
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  let cause = error;
  for (
    let depth = 0;
    depth < 10 && cause instanceof Error && cause.cause;
    depth++
  )
    cause = cause.cause;
  expect(cause).toMatchObject({ message: 'AUDIT_FAILURE', code: 'P0001' });
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(1);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('poisons the transaction even if its caller catches an unsupported write', async () => {
  await expect(
    run(async (scope) => {
      await repo(scope).update(id, { position: 9 });
      try {
        await repo(scope).update(id, {
          domainName: { primaryLinkUrl: 'secret' },
        });
      } catch {
        /* caller cannot erase the failure */
      }
    }),
  ).rejects.toThrow('scalar coverage');
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(1);
  expect(await audit()).toEqual([]);
});

it.each([
  ['file', { attachments: [] }],
  ['raw function', { name: () => 'SQL' }],
  ['system timestamp', { deletedAt: '2026-10-28' }],
])('refuses unsupported %s writes before persistence', async (_label, data) => {
  await expect(run((scope) => repo(scope).update(id, data))).rejects.toThrow(
    'scalar coverage',
  );
  expect(await audit()).toEqual([]);
});

it('refuses unaudited create/delete and other-object writes inside the bounded owner', async () => {
  for (const work of [
    (scope: WorkspaceTransactionScope) => repo(scope).insert({ name: 'new' }),
    (scope: WorkspaceTransactionScope) => repo(scope).delete(id),
    (scope: WorkspaceTransactionScope) =>
      scope
        .getRepository('person', permissions)
        .update(randomUUID(), { name: 'x' }),
  ])
    await expect(run<unknown>(work)).rejects.toThrow('only standard Company');
  expect((await readCompany()).length).toBe(2);
  expect(await audit()).toEqual([]);
});

it('rejects a legacy audit owner before executing its callback', async () => {
  const work = jest.fn();
  await expect(
    f.dataSource.transaction(work, {
      nativeAudit: opts(),
      commitOutcome: 'legacy',
    }),
  ).rejects.toThrow('strict');
  expect(work).not.toHaveBeenCalled();
});

it('requires an explicit system actor, never record createdBy or a guessed ID', async () => {
  const work = jest.fn();
  await expect(
    f.dataSource.transaction(work, {
      nativeAudit: { operationId: randomUUID() },
    }),
  ).rejects.toThrow('identifier');
  expect(work).not.toHaveBeenCalled();
});

it('captures operation metadata before awaiting the connection and caller data before SQL', async () => {
  const operation = opts(),
    original = operation.operationId;
  await run(async (scope) => {
    operation.operationId = randomUUID();
    operation.systemActorId = 'mutated';
    const input = { name: 'captured' };
    const pending = repo(scope).update(id, input);
    input.name = 'mutated';
    await pending;
  }, operation);
  const rows = await audit();
  expect(rows[0].operationId).toBe(original);
  expect(rows[0].actor.id).toBe('native-company-test');
  expect((await readCompany()).find((row) => row.id === id)?.name).toBe(
    'captured',
  );
});

it('captures each batch input before the first await', async () => {
  await run(async (scope) => {
    const input = [{ criteria: id, partialEntity: { name: 'captured' } }];
    const pending = repo(scope).updateMany(input);
    input[0].partialEntity.name = 'mutated';
    input[0].criteria = secondId;
    await pending;
  });
  expect((await readCompany()).find((row) => row.id === id)?.name).toBe(
    'captured',
  );
  expect((await readCompany()).find((row) => row.id === secondId)?.name).toBe(
    'second-private',
  );
});

it('uses the committed concurrent before-image rather than the earlier unlocked candidate', async () => {
  let firstWritten!: () => void,
    releaseFirst!: () => void,
    secondLock!: () => void;
  const ready = new Promise<void>((resolve) => (firstWritten = resolve)),
    release = new Promise<void>((resolve) => (releaseFirst = resolve)),
    locking = new Promise<void>((resolve) => (secondLock = resolve));
  const first = run(async (scope) => {
    await repo(scope).update(id, { name: 'intermediate' });
    firstWritten();
    await release;
  });
  await ready;
  const client = await f.pool.connect(),
    query = client.query.bind(client);
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (text.includes('FOR UPDATE') && text.includes('company')) secondLock();
    return query(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const second = run((scope) =>
    repo(scope).update(id, { name: 'original-private' }),
  );
  await locking;
  releaseFirst();
  await Promise.all([first, second]);
  const rows = await audit();
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row.redactedDiff.changedFields).toContain(fieldId('name'));
});

it('reports lost real COMMIT acknowledgement as unknown with one success and no failed audit', async () => {
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
    run((scope) => repo(scope).update(id, { position: 9 })),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0].outcome).toBe('success');
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(9);
});

it('refuses retained repositories after the audit transaction ended', async () => {
  let retained!: WorkspaceRepository;
  await run(async (scope) => {
    retained = repo(scope);
    await retained.update(id, { position: 9 });
  });
  await expect(retained.update(id, { position: 10 })).rejects.toThrow();
  expect(await audit()).toHaveLength(1);
});

it('preserves the explicit rollout boundary for an ordinary uninstrumented repository', async () => {
  await f.withContext(() =>
    f.dataSource
      .getRepository('company', permissions, { shouldSkipEventEmission: true })
      .update(id, { position: 7 }),
  );
  expect(await audit()).toEqual([]);
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(7);
});

it.each(['user', 'apiKey', 'application', 'agent'] as const)(
  'derives %s principal only from server authentication',
  (kind) => {
    const actorId = randomUUID();
    const auth = {
      workspace: { id: f.workspaceId },
      ...(kind === 'user'
        ? { type: 'user', workspaceMemberId: actorId }
        : kind === 'apiKey'
          ? { type: 'apiKey', apiKey: { id: actorId } }
          : {
              type: 'application',
              application: { id: kind === 'agent' ? randomUUID() : actorId },
              ...(kind === 'agent'
                ? { actingAgent: { id: actorId, label: 'untrusted label' } }
                : {}),
            }),
    } as WorkspaceAuthContext;
    const result = captureNativeCrmAuditOperation(f.workspaceId, auth, {
      operationId: randomUUID(),
    });
    expect(result.actor).toEqual({
      kind: kind === 'user' ? 'workspaceMember' : kind,
      id: actorId,
    });
    expect(() =>
      captureNativeCrmAuditOperation(f.workspaceId, auth, { ...opts() }),
    ).toThrow('Only system');
    expect(() =>
      captureNativeCrmAuditOperation(randomUUID(), auth, {
        operationId: randomUUID(),
      }),
    ).toThrow('workspace mismatch');
  },
);

it('preserves NUMERIC precision when detecting native field changes', async () => {
  await f.owner.query(
    `UPDATE "${f.schemaName}".company SET "exactNumber"=$1 WHERE id=$2`,
    ['9007199254740992', id],
  );
  await run((scope) =>
    repo(scope).update(id, { exactNumber: '9007199254740993' }),
  );
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0].redactedDiff.changedFields).toEqual([fieldId('exactNumber')]);
  expect(JSON.stringify(rows)).not.toMatch(/900719925474099[23]/);
  const actual = await f.owner.query(
    `SELECT "exactNumber"::text AS value FROM "${f.schemaName}".company WHERE id=$1`,
    [id],
  );
  expect(actual[0].value).toBe('9007199254740993');
});

it('refuses reuse of an already committed operation before another mutation', async () => {
  const operation = opts();
  await run((scope) => repo(scope).update(id, { position: 8 }), operation);
  const work = jest.fn((scope: WorkspaceTransactionScope) =>
    repo(scope).update(id, { position: 9 }),
  );
  await expect(run(work, operation)).rejects.toThrow('already committed');
  expect(work).not.toHaveBeenCalled();
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(8);
  expect(await audit()).toHaveLength(1);
});

it('serializes concurrent reuse of one operation across different rows', async () => {
  const operation = opts();
  const results = await Promise.allSettled([
    run((scope) => repo(scope).update(id, { position: 8 }), operation),
    run((scope) => repo(scope).update(secondId, { position: 9 }), operation),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  expect(await audit()).toHaveLength(1);
  expect((await readCompany()).filter((row) => row.position > 2)).toHaveLength(
    1,
  );
});

it('allows retry after a confirmed rollback without a committed audit', async () => {
  const operation = opts();
  await expect(
    run(async (scope) => {
      await repo(scope).update(id, { position: 8 });
      throw new Error('abort');
    }, operation),
  ).rejects.toThrow('abort');
  await run((scope) => repo(scope).update(id, { position: 9 }), operation);
  expect(await audit()).toHaveLength(1);
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(9);
});

it('does not bypass native permissions when auditing an update', async () => {
  await expect(
    run((scope) =>
      scope
        .getRepository('company', { intersectionOf: { apiKeyRoleId: null } })
        .update(id, { position: 9 }),
    ),
  ).rejects.toThrow();
  expect((await readCompany()).find((row) => row.id === id)?.position).toBe(1);
  expect(await audit()).toHaveLength(0);
});
