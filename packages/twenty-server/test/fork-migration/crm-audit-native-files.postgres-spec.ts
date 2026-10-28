import { randomUUID } from 'node:crypto';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { type CrmAuditSecurityDescriptor } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { FieldMetadataType } from 'twenty-shared/types';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity'],
  coreSchema: 'audit',
});
const recordId = randomUUID(),
  secondId = randomUUID(),
  fileId = randomUUID(),
  foreignWorkspace = randomUUID();
const fields: Record<
  string,
  { id: string; universalIdentifier: string; objectMetadataId: string }
> = {};
const run = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'native-files-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name = 'company') =>
  scope.getRepository(
    name,
    { shouldBypassPermissionChecks: true },
    { shouldSkipEventEmission: true },
  );
const payload = (label = 'private-label', id = fileId) => [
  { fileId: id, label },
];
const audits = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceKind",id',
  );
const files = () => f.owner.query('SELECT * FROM core.file ORDER BY id');
const readCompanies = async (): Promise<
  { id: string; documents: ReturnType<typeof payload> | null }[]
> => f.read('company');
const record = async (id = recordId) =>
  (await readCompanies()).find((row) => row.id === id)!;
const seed = async (
  overrides: Record<string, unknown> = {},
  object = 'company',
) => {
  await f.owner.query(
    `INSERT INTO core.file(id,"workspaceId",path,size,settings,status) VALUES ($1,$2,$3,12,$4,$5)`,
    [
      fileId,
      overrides.workspaceId ?? f.workspaceId,
      overrides.path ??
        'secret/' + fields[object].universalIdentifier + '/private.pdf',
      overrides.settings ?? { isTemporaryFile: true, toDelete: true },
      overrides.status ?? 'UPLOADED',
    ],
  );
  if (overrides.deleted)
    await f.owner.query(
      'UPDATE core.file SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',
      [fileId],
    );
};
const attach = (object = 'company') =>
  run((scope) =>
    repo(scope, object).update(recordId, { documents: payload() }),
  );
beforeAll(async () => {
  await f.withContext(async () => {
    const context = getWorkspaceContext();
    for (const name of ['company', 'person', 'opportunity']) {
      const object = Object.values(
        context.flatObjectMetadataMaps.byUniversalIdentifier,
      ).find((item) => item?.nameSingular === name)!;
      const base = Object.values(
        f.flatFieldMetadataMaps.byUniversalIdentifier,
      ).find(
        (item) =>
          item?.objectMetadataId === object.id && item.name === 'position',
      )!;
      const field = {
        ...base,
        id: randomUUID(),
        universalIdentifier: randomUUID(),
        name: 'documents',
        label: 'documents',
        type: FieldMetadataType.FILES,
        isNullable: true,
        isCustom: true,
        defaultValue: null,
        settings: { maxNumberOfValues: 5 },
      };
      f.flatFieldMetadataMaps.byUniversalIdentifier[field.universalIdentifier] =
        field;
      f.flatFieldMetadataMaps.universalIdentifierById[field.id] =
        field.universalIdentifier;
      object.fieldIds.push(field.id);
      object.fieldUniversalIdentifiers.push(field.universalIdentifier);
      fields[name] = field;
    }
  });
  await f.initialize();
  await f.owner.query(`INSERT INTO core.workspace(id) VALUES ($1),($2)`, [
    f.workspaceId,
    foreignWorkspace,
  ]);
  await f.owner.query('CREATE TABLE core.application(id uuid PRIMARY KEY)');
  await f.owner.query(
    'CREATE TABLE core."applicationRegistration"(id uuid PRIMARY KEY)',
  );
  await f.owner.query(
    `CREATE TYPE core.file_status_enum AS ENUM ('PENDING','UPLOADED')`,
  );
  await f.owner.query(`CREATE TABLE core.file (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "workspaceId" uuid REFERENCES core.workspace(id) ON DELETE CASCADE,
  "applicationId" uuid REFERENCES core.application(id) ON DELETE RESTRICT,
  "applicationRegistrationId" uuid REFERENCES core."applicationRegistration"(id) ON DELETE CASCADE,
  path varchar NOT NULL, size bigint NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "deletedAt" timestamptz,
  "isStaticAsset" boolean NOT NULL DEFAULT false, settings jsonb,
  "mimeType" varchar NOT NULL DEFAULT 'application/octet-stream',
  status core.file_status_enum NOT NULL DEFAULT 'UPLOADED', "contentSha256" varchar,
  CHECK(status!='PENDING' OR "mimeType"='application/octet-stream'),
  CHECK("workspaceId" IS NOT NULL OR "applicationRegistrationId" IS NOT NULL),
  CHECK("workspaceId" IS NULL OR "applicationRegistrationId" IS NULL),
  UNIQUE("applicationId","workspaceId",path), UNIQUE("applicationRegistrationId",path))`);
  await f.owner.query(`GRANT USAGE ON SCHEMA core TO "${f.roleName}"`);
  await f.owner.query(`GRANT SELECT,UPDATE ON core.file TO "${f.roleName}"`);
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS fail_files_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query('DROP FUNCTION IF EXISTS crm_audit.fail_files_audit()');
  await f.owner.query('DROP TRIGGER IF EXISTS fail_file_update ON core.file');
  await f.owner.query('DROP FUNCTION IF EXISTS core.fail_file_update()');
  await f.owner.query(
    `DROP TRIGGER IF EXISTS skip_company_update ON "${f.schemaName}".company`,
  );
  await f.owner.query('DROP FUNCTION IF EXISTS core.skip_company_update()');
  await f.reset();
  await f.owner.query('TRUNCATE core.file');
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name) VALUES($1,'one'),($2,'two')`,
    [recordId, secondId],
  );
  await f.owner.query(`INSERT INTO "${f.schemaName}".person(id) VALUES($1)`, [
    recordId,
  ]);
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".opportunity(id) VALUES($1)`,
    [recordId],
  );
});
afterAll(() => f.dispose());

it.each(['company', 'person', 'opportunity'])(
  'attaches a File and audits its exact %s parent in one commit',
  async (object) => {
    await seed({}, object);
    await attach(object);
    expect((await files())[0].settings).toEqual({
      isTemporaryFile: false,
      toDelete: false,
    });
    const rows = await audits();
    expect(rows).toHaveLength(2);
    const fileAudit = rows.find((row) => row.resourceKind === 'crmFile')!;
    expect(fileAudit.securityDescriptor).toEqual({
      resourceKind: 'crmFile',
      resourceId: fileId,
      fileParent: {
        objectMetadataId: fields[object].objectMetadataId,
        recordId,
        fieldMetadataId: fields[object].id,
      },
    });
    expect(fileAudit.redactedDiff).toMatchObject({
      values: {},
      changedFields: ['settings'],
    });
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(f.eventEmitter).not.toHaveBeenCalled();
    const native = (
      (await f.read(object as 'company' | 'person' | 'opportunity')) as {
        id: string;
        documents: unknown;
      }[]
    ).find((row) => row.id === recordId)!;
    expect(native.documents).toEqual([
      { fileId, label: 'private-label', extension: '.pdf' },
    ]);
  },
);
it('renames only the native label without changing the core File or creating a file audit', async () => {
  await seed();
  await attach();
  const before = (await files())[0];
  await run((scope) =>
    repo(scope).update(recordId, { documents: payload('changed label') }),
  );
  expect((await files())[0]).toEqual(before);
  expect(
    (await audits()).filter((row) => row.resourceKind === 'crmFile'),
  ).toHaveLength(1);
  expect((await record()).documents![0].label).toBe('changed label');
});
it('removes a file with both native and core audit and preserves the parent descriptor', async () => {
  await seed();
  await attach();
  await run((scope) => repo(scope).update(recordId, { documents: [] }));
  expect((await files())[0].deletedAt).toBeInstanceOf(Date);
  expect((await record()).documents).toEqual([]);
  const rows = (await audits()).filter((row) => row.resourceKind === 'crmFile');
  expect(rows).toHaveLength(2);
  expect(
    rows.find((row) => row.redactedDiff.changedFields.includes('deletedAt'))!
      .securityDescriptor.fileParent!.recordId,
  ).toBe(recordId);
});
it.each([false, true])(
  'uses authoritative batch record IDs for retained/removed files; spoof=%s',
  async (spoof) => {
    await seed();
    await attach();
    await run((scope) =>
      repo(scope).updateMany([
        {
          criteria: recordId,
          partialEntity: {
            ...(spoof ? { id: secondId } : {}),
            documents: payload('batch label'),
          },
        },
      ]),
    );
    expect((await record()).documents![0].label).toBe('batch label');
    expect((await record(secondId)).documents).toBeNull();
    await run((scope) =>
      repo(scope).updateMany([
        {
          criteria: recordId,
          partialEntity: { ...(spoof ? { id: secondId } : {}), documents: [] },
        },
      ]),
    );
    expect((await files())[0].deletedAt).toBeInstanceOf(Date);
    expect((await record()).documents).toEqual([]);
  },
);
it.each([
  ['foreign workspace', { workspaceId: foreignWorkspace }],
  ['pending', { status: 'PENDING' }],
  ['permanent', { settings: { isTemporaryFile: false, toDelete: false } }],
  ['wrong field', { path: 'other/private.pdf' }],
  ['deleted', { deleted: true }],
])('refuses %s before native/core persistence', async (_name, options) => {
  await seed(options as Record<string, unknown>);
  const before = await files();
  await expect(attach()).rejects.toThrow();
  expect(await files()).toEqual(before);
  expect((await record()).documents).toBeNull();
  expect(await audits()).toEqual([]);
});
it('refuses a missing file', async () => {
  await expect(attach()).rejects.toThrow();
  expect(await audits()).toEqual([]);
});
it('serializes competing attachments of one temporary file', async () => {
  await seed();
  const result = await Promise.allSettled([
    attach(),
    run((scope) => repo(scope).update(secondId, { documents: payload() })),
  ]);
  expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(
    (await readCompanies()).filter((row) => row.documents?.length),
  ).toHaveLength(1);
  expect(await audits()).toHaveLength(2);
});
it('refuses a file shared between two parent records in the same batch', async () => {
  await seed();
  await expect(
    run((scope) =>
      repo(scope).updateMany([
        { criteria: recordId, partialEntity: { documents: payload() } },
        { criteria: secondId, partialEntity: { documents: payload() } },
      ]),
    ),
  ).rejects.toThrow('one unambiguous owner');
  expect((await files())[0].settings.isTemporaryFile).toBe(true);
  expect(await audits()).toEqual([]);
});
it('refuses duplicate parent IDs in a file batch', async () => {
  await seed();
  await expect(
    run((scope) =>
      repo(scope).updateMany([
        { criteria: recordId, partialEntity: { documents: payload() } },
        { criteria: recordId, partialEntity: { documents: [] } },
      ]),
    ),
  ).rejects.toThrow('repeat a record');
  expect(await audits()).toEqual([]);
});
it.each([
  null,
  [
    { fileId, label: 'x' },
    { fileId, label: 'y' },
  ],
  [{ fileId, label: 'x', unexpected: 'value' }],
])('rejects ambiguous file input %#', async (documents) => {
  await seed();
  await expect(
    run((scope) => repo(scope).update(recordId, { documents })),
  ).rejects.toThrow('coverage');
  expect(await audits()).toEqual([]);
});
it.each(['missing', 'deleted', 'foreign'])(
  'refuses removing an invalid %s attachment without touching foreign storage',
  async (kind) => {
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents=$1 WHERE id=$2`,
      [JSON.stringify(payload()), recordId],
    );
    if (kind !== 'missing')
      await seed(
        kind === 'foreign'
          ? {
              workspaceId: foreignWorkspace,
              settings: { isTemporaryFile: false, toDelete: false },
            }
          : {
              deleted: true,
              settings: { isTemporaryFile: false, toDelete: false },
            },
      );
    const before = await files();
    await expect(
      run((scope) => repo(scope).update(recordId, { documents: [] })),
    ).rejects.toThrow();
    expect(await files()).toEqual(before);
    expect((await record()).documents).toEqual(payload());
    expect(await audits()).toEqual([]);
  },
);
it('rolls back native and core mutations when the audit insert fails', async () => {
  await seed();
  const before = await files();
  await f.owner.query(
    `CREATE FUNCTION crm_audit.fail_files_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FILES_AUDIT_FAILURE'; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_files_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_files_audit()',
  );
  await expect(attach()).rejects.toThrow();
  expect(await files()).toEqual(before);
  expect((await record()).documents).toBeNull();
  expect(await audits()).toEqual([]);
});
it('rolls back the native update when core file persistence fails', async () => {
  await seed();
  const before = await files();
  await f.owner.query(
    `CREATE FUNCTION core.fail_file_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CORE_FILE_FAILURE'; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_file_update BEFORE UPDATE ON core.file FOR EACH ROW EXECUTE FUNCTION core.fail_file_update()',
  );
  await expect(attach()).rejects.toThrow();
  expect(await files()).toEqual(before);
  expect((await record()).documents).toBeNull();
  expect(await audits()).toEqual([]);
});
it('does not apply the file plan when the native update returns no written parent', async () => {
  await seed();
  await f.owner.query(
    `CREATE FUNCTION core.skip_company_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await f.owner.query(
    `CREATE TRIGGER skip_company_update BEFORE UPDATE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION core.skip_company_update()`,
  );
  await expect(attach()).rejects.toThrow('parent was not updated');
  expect((await files())[0].settings.isTemporaryFile).toBe(true);
  expect(await audits()).toEqual([]);
});
it('captures mutable file payload before awaiting SQL', async () => {
  await seed();
  await run(async (scope) => {
    const documents = payload();
    const pending = repo(scope).update(recordId, { documents });
    documents[0].fileId = randomUUID();
    documents[0].label = 'mutated';
    await pending;
  });
  expect((await record()).documents![0]).toMatchObject({
    fileId,
    label: 'private-label',
  });
});
it('retains one committed file/native audit pair on lost COMMIT acknowledgement without compensation', async () => {
  await seed();
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
  await expect(attach()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect((await files())[0].settings.isTemporaryFile).toBe(false);
  expect((await record()).documents).toHaveLength(1);
  expect(await audits()).toHaveLength(2);
});

it.each(['attach', 'remove'])(
  'rejects a trigger that changes the actual parent file list on %s',
  async (mode) => {
    await seed();
    if (mode === 'remove') await attach();
    const before = await files(),
      beforeRecord = await record(),
      beforeAudit = await audits();
    await f.owner.query(
      `CREATE FUNCTION core.skip_company_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.documents=OLD.documents; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER skip_company_update BEFORE UPDATE ON "${f.schemaName}".company FOR EACH ROW EXECUTE FUNCTION core.skip_company_update()`,
    );
    await expect(
      run((scope) =>
        repo(scope).update(recordId, {
          documents: mode === 'attach' ? payload() : [],
        }),
      ),
    ).rejects.toThrow('parent link');
    expect(await files()).toEqual(before);
    expect(await record()).toEqual(beforeRecord);
    expect(await audits()).toEqual(beforeAudit);
  },
);
it('rejects a core trigger that preserves temporary state after attach', async () => {
  await seed();
  const before = await files();
  await f.owner.query(
    `CREATE FUNCTION core.fail_file_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.settings=OLD.settings; RETURN NEW; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_file_update BEFORE UPDATE ON core.file FOR EACH ROW EXECUTE FUNCTION core.fail_file_update()',
  );
  await expect(attach()).rejects.toThrow('state does not match');
  expect(await files()).toEqual(before);
  expect((await record()).documents).toBeNull();
  expect(await audits()).toEqual([]);
});
it.each([
  'missing',
  'extra',
  'invalidId',
  'wrongKind',
  'binding',
  'rootObject',
])('rejects malformed file audit scope %s', async (kind) => {
  await run(async (scope) => {
    const audit = new CrmAuditTransactionContext(
      createCrmAuditWorkspaceExecutor(scope),
      {
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'system', id: 'scope-test' },
      },
    );
    const descriptor: Record<string, unknown> = {
      resourceKind: 'crmFile',
      resourceId: fileId,
      fileParent: {
        objectMetadataId: fields.company.objectMetadataId,
        recordId,
        fieldMetadataId: fields.company.id,
      },
    };
    if (kind === 'missing') delete descriptor.fileParent;
    if (kind === 'extra')
      descriptor.fileParent = {
        ...(descriptor.fileParent as object),
        unexpected: true,
      };
    if (kind === 'invalidId')
      descriptor.fileParent = {
        ...(descriptor.fileParent as object),
        recordId: 'not-uuid',
      };
    if (kind === 'wrongKind') descriptor.resourceKind = 'crmRecord';
    if (kind === 'binding') descriptor.bindingId = randomUUID();
    if (kind === 'rootObject')
      descriptor.objectMetadataId = fields.company.objectMetadataId;
    expect(() =>
      audit.record({
        resourceKind: 'crmFile',
        resourceId: fileId,
        action: 'update',
        before: { settings: 'old' },
        after: { settings: 'new' },
        securityDescriptor: descriptor as CrmAuditSecurityDescriptor,
      }),
    ).toThrow();
  });
  expect(await audits()).toEqual([]);
});
