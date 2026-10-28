import { randomUUID } from 'node:crypto';
import { FieldMetadataType } from 'twenty-shared/types';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity'],
  coreSchema: 'audit',
});
const id = randomUUID();
const companyTwo = randomUUID();
const permissions = { shouldBypassPermissionChecks: true as const };
const objectIds: Record<string, string> = {};
const run = async <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'native-records-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name: string) =>
  scope.getRepository(name, permissions, { shouldSkipEventEmission: true });
const read = async (
  name: 'person' | 'company' | 'opportunity',
): Promise<Record<string, unknown>[]> => f.read(name);
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const fieldId = (object: string, name: string) =>
  Object.values(f.flatFieldMetadataMaps.byUniversalIdentifier).find(
    (field) =>
      field?.objectMetadataId === objectIds[object] && field.name === name,
  )!.id;
beforeAll(async () => {
  await f.withContext(async () => {
    const context = getWorkspaceContext();
    for (const name of ['company', 'person', 'opportunity'])
      objectIds[name] = context.objectIdByNameSingular[name];
    const company = Object.values(
      context.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.id === objectIds.company)!;
    const position = Object.values(
      f.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === objectIds.company &&
        field.name === 'position',
    )!;
    for (const [name, type] of [
      ['privatePayload', FieldMetadataType.RAW_JSON],
      ['tags', FieldMetadataType.ARRAY],
      ['privateFiles', FieldMetadataType.FILES],
    ] as const) {
      const field = {
        ...position,
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
beforeEach(async () => {
  await f.reset();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name,"domainNamePrimaryLinkUrl","domainNamePrimaryLinkLabel") VALUES ($1,'company-secret','https://private.invalid','old label'),($2,'second-secret',NULL,NULL)`,
    [id, companyTwo],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName","nameLastName","companyId") VALUES ($1,'first-secret','last-secret',$2)`,
    [id, id],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".opportunity(id,name,"amountAmountMicros","amountCurrencyCode") VALUES ($1,'deal-secret',100,'USD')`,
    [id],
  );
});
afterAll(() => f.dispose());

it('preserves untouched composite properties and groups their changes under one field ID', async () => {
  await run((scope) =>
    repo(scope, 'company').update(id, {
      domainName: { primaryLinkLabel: 'new-private-label' },
    }),
  );
  expect((await read('company')).find((row) => row.id === id)).toMatchObject({
    domainNamePrimaryLinkUrl: 'https://private.invalid',
    domainNamePrimaryLinkLabel: 'new-private-label',
  });
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0].redactedDiff.changedFields).toEqual([
    fieldId('company', 'domainName'),
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private.invalid|new-private-label/);
});

it('preserves undefined and changes only explicitly null or provided person name properties', async () => {
  await run((scope) =>
    repo(scope, 'person').update(id, {
      name: { firstName: undefined, lastName: null },
    }),
  );
  expect((await read('person'))[0]).toMatchObject({
    nameFirstName: 'first-secret',
    nameLastName: null,
  });
  expect((await audit())[0].redactedDiff.changedFields).toEqual([
    fieldId('person', 'name'),
  ]);
});

it('keeps the existing null-composite no-change behavior', async () => {
  await run((scope) =>
    repo(scope, 'person').update(id, { name: null, jobTitle: 'new-title' }),
  );
  expect((await read('person'))[0]).toMatchObject({
    nameFirstName: 'first-secret',
    nameLastName: 'last-secret',
    jobTitle: 'new-title',
  });
  expect((await audit())[0].redactedDiff.changedFields).toEqual([
    fieldId('person', 'jobTitle'),
  ]);
});

it('captures nested names before awaiting SQL', async () => {
  await run(async (scope) => {
    const data = { name: { firstName: 'captured-private' } };
    const pending = repo(scope, 'person').update(id, data);
    data.name.firstName = 'mutated';
    await pending;
  });
  expect((await read('person'))[0].nameFirstName).toBe('captured-private');
  expect(JSON.stringify(await audit())).not.toContain('captured-private');
});

it('captures JSON and arrays in each batch input without retaining values in audit', async () => {
  await run(async (scope) => {
    const data = {
      privatePayload: { nested: { secret: 'captured' } },
      tags: ['captured-tag'],
    };
    const pending = repo(scope, 'company').updateMany([
      { criteria: id, partialEntity: data },
    ]);
    data.privatePayload.nested.secret = 'mutated';
    data.tags[0] = 'mutated';
    await pending;
  });
  expect((await read('company')).find((row) => row.id === id)).toMatchObject({
    privatePayload: { nested: { secret: 'captured' } },
    tags: ['captured-tag'],
  });
  const rows = await audit();
  expect(rows[0].redactedDiff.changedFields).toEqual(
    [fieldId('company', 'privatePayload'), fieldId('company', 'tags')].sort(),
  );
  expect(rows[0].redactedDiff.values).toEqual({});
  expect(JSON.stringify(rows)).not.toContain('captured');
});

it('captures Date instances and currency values without converting exact numeric strings', async () => {
  const date = new Date('2026-11-15T12:30:00.000Z');
  await run(async (scope) => {
    const data = {
      closeDate: date,
      amount: { amountMicros: '9007199254740993', currencyCode: 'EUR' },
    };
    const pending = repo(scope, 'opportunity').update(id, data);
    date.setUTCFullYear(2030);
    data.amount.currencyCode = 'USD';
    await pending;
  });
  const rows = await read('opportunity');
  expect(rows[0]).toMatchObject({
    amountAmountMicros: '9007199254740993',
    amountCurrencyCode: 'EUR',
    closeDate: new Date('2026-11-15T12:30:00.000Z'),
  });
  expect((await audit())[0].redactedDiff.changedFields).toEqual(
    [
      fieldId('opportunity', 'amount'),
      fieldId('opportunity', 'closeDate'),
    ].sort(),
  );
});

it('keeps same record UUID in three objects as three separate audit resources', async () => {
  await run(async (scope) => {
    await repo(scope, 'company').update(id, { name: 'company-new' });
    await repo(scope, 'person').update(id, {
      name: { firstName: 'person-new' },
    });
    await repo(scope, 'opportunity').update(id, { name: 'opportunity-new' });
  });
  const rows = await audit();
  expect(rows).toHaveLength(3);
  expect(
    new Set(rows.map((row) => row.securityDescriptor.objectMetadataId)),
  ).toEqual(new Set(Object.values(objectIds)));
  expect(new Set(rows.map((row) => row.eventKey)).size).toBe(3);
  expect(rows.every((row) => row.resourceId === id)).toBe(true);
});

it('supports resolved native FK changes using the relation field metadata ID', async () => {
  await run((scope) =>
    repo(scope, 'person').update(id, { companyId: companyTwo }),
  );
  expect((await read('person'))[0].companyId).toBe(companyTwo);
  expect((await audit())[0].redactedDiff.changedFields).toEqual([
    fieldId('person', 'company'),
  ]);
});

it('rolls earlier writes and audit back on an invalid FK in the same owner', async () => {
  await expect(
    run(async (scope) => {
      await repo(scope, 'company').update(id, { name: 'must-rollback' });
      await repo(scope, 'person').update(id, { companyId: randomUUID() });
    }),
  ).rejects.toThrow();
  expect((await read('company')).find((row) => row.id === id)?.name).toBe(
    'company-secret',
  );
  expect((await read('person'))[0].companyId).toBe(id);
  expect(await audit()).toEqual([]);
});

it('preserves native permission denial and rolls the shared owner back', async () => {
  await expect(
    run(async (scope) => {
      await repo(scope, 'company').update(id, { name: 'must-rollback' });
      await scope
        .getRepository('person', { intersectionOf: { apiKeyRoleId: null } })
        .update(id, { name: { firstName: 'denied' } });
    }),
  ).rejects.toThrow();
  expect((await read('company')).find((row) => row.id === id)?.name).toBe(
    'company-secret',
  );
  expect(await audit()).toEqual([]);
});

it('ignores undefined fields exactly as the existing formatter does', async () => {
  await run((scope) =>
    repo(scope, 'company').update(id, {
      name: 'updated',
      unknownField: undefined,
      attachments: undefined,
    }),
  );
  expect((await audit())[0].redactedDiff.changedFields).toEqual([
    fieldId('company', 'name'),
  ]);
});

it.each([
  { domainName: { unexpected: 'value' } },
  { privatePayload: new Map([['key', 'value']]) },
  { privatePayload: new Set(['value']) },
  { privatePayload: { bad: () => 'raw SQL' } },
  { privatePayload: { number: Infinity } },
  { privatePayload: new Date('invalid') },
  { attachments: [] },
  { privateFiles: null },
])(
  'refuses unsupported values and file writes %# before persistence',
  async (data) => {
    await expect(
      run((scope) => repo(scope, 'company').update(id, data)),
    ).rejects.toThrow('coverage');
    expect(await audit()).toEqual([]);
  },
);

it('refuses circular input without an unbounded snapshot traversal', async () => {
  const data: Record<string, unknown> = {};
  data.self = data;
  await expect(
    run((scope) => repo(scope, 'company').update(id, { privatePayload: data })),
  ).rejects.toThrow('coverage');
  expect(await audit()).toEqual([]);
});

it('never derives the audit actor from mutable record actor fields', async () => {
  await run((scope) =>
    repo(scope, 'company').update(id, {
      updatedBy: { name: 'spoofed', source: 'MANUAL' },
      name: 'new',
    }),
  );
  expect((await audit())[0].actor).toEqual({
    kind: 'system',
    id: 'native-records-test',
  });
  expect(JSON.stringify(await audit())).not.toContain('spoofed');
});

it.each([
  ['single', 'deletedAt'],
  ['batch', 'deletedAt'],
  ['single', 'privateFiles'],
  ['batch', 'privateFiles'],
])(
  'refuses a %s accessor attempting to inject %s before any getter runs',
  async (mode, injected) => {
    let reads = 0;
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, 'name', {
      enumerable: true,
      get: () => {
        reads++;
        data[injected] = injected === 'privateFiles' ? [] : '2026-11-01';
        return 'injected';
      },
    });
    await expect(
      run((scope) =>
        mode === 'single'
          ? repo(scope, 'company').update(id, data)
          : repo(scope, 'company').updateMany([
              { criteria: id, partialEntity: data },
            ]),
      ),
    ).rejects.toThrow('coverage');
    expect(reads).toBe(0);
    expect((await read('company')).find((row) => row.id === id)).toMatchObject({
      name: 'company-secret',
      deletedAt: null,
      privateFiles: null,
    });
    expect(await audit()).toEqual([]);
  },
);

it.each(['single', 'batch'])(
  'refuses nested accessors in a %s input snapshot',
  async (mode) => {
    let reads = 0;
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, 'secret', {
      enumerable: true,
      get: () => {
        reads++;
        return 'must-not-read';
      },
    });
    const data = { privatePayload: nested };
    await expect(
      run((scope) =>
        mode === 'single'
          ? repo(scope, 'company').update(id, data)
          : repo(scope, 'company').updateMany([
              { criteria: id, partialEntity: data },
            ]),
      ),
    ).rejects.toThrow('coverage');
    expect(reads).toBe(0);
    expect(await audit()).toEqual([]);
  },
);
