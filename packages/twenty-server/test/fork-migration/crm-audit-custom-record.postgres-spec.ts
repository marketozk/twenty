import { randomUUID } from 'node:crypto';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { isNativeCrmAuditMetadata } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
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
const id = randomUUID();
const run = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      nativeAudit: {
        operationId: randomUUID(),
        systemActorId: 'custom-crm-test',
      },
    }),
  );
const repo = (scope: WorkspaceTransactionScope, name = 'customCase') =>
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
beforeEach(() => f.reset());
afterAll(() => f.dispose());

it('keeps identical standard/custom record IDs in separate audit scopes', async () => {
  await run(async (scope) => {
    await repo(scope, 'company').insert({ id, name: 'private company' });
    await repo(scope).insert({ id, name: 'private case', companyId: id });
    await repo(scope).update(id, { name: 'private changed' });
    await repo(scope).updateMany([
      { criteria: id, partialEntity: { name: 'private final' } },
    ]);
  });
  expect((await f.read('_customCase'))[0]).toMatchObject({
    id,
    name: 'private final',
    companyId: id,
  });
  const entries = await audit();
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
  expect(
    new Set(entries.map((entry) => JSON.stringify(entry.securityDescriptor)))
      .size,
  ).toBe(2);
  expect(entries.filter((entry) => entry.action === 'update')).toHaveLength(1);
  expect(JSON.stringify(entries)).not.toContain('private');
});

it('rolls custom and standard writes back on an actual foreign key failure', async () => {
  await expect(
    run(async (scope) => {
      await repo(scope, 'company').insert({ id, name: 'rollback' });
      await repo(scope).insert({ id, companyId: randomUUID() });
    }),
  ).rejects.toThrow();
  expect(await f.read('company')).toHaveLength(0);
  expect(await f.read('_customCase')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it('keeps native permission checks for custom creation', async () => {
  await expect(
    run((scope) =>
      scope
        .getRepository('customCase', { intersectionOf: { apiKeyRoleId: null } })
        .insert({ id, name: 'forbidden' }),
    ),
  ).rejects.toThrow();
  expect(await f.read('_customCase')).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it.each(['delete', 'restore'] as const)(
  'keeps custom %s outside create/update coverage and poisons caught failures',
  async (method) => {
    await expect(
      run(async (scope) => {
        await repo(scope).insert({ id, name: 'rollback' });
        try {
          await repo(scope)[method](id);
        } catch {}
      }),
    ).rejects.toThrow();
    expect(await f.read('_customCase')).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);

it.each([
  'message',
  'messageThread',
  'task',
  'workflow',
  'dashboard',
  'recordShare',
  'calendarEvent',
])(
  'does not grant generic audit coverage to standard %s metadata',
  async (name) => {
    await f.withContext(async () => {
      const metadata = Object.values(
        getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier,
      ).find((object) => object?.nameSingular === name)!;
      expect(metadata).toBeDefined();
      expect(isNativeCrmAuditMetadata(metadata, f.workspaceId)).toBe(false);
      expect(
        isNativeCrmAuditMetadata(
          { ...metadata, isSystem: false },
          f.workspaceId,
        ),
      ).toBe(false);
    });
    await expect(
      run(async (scope) => {
        await repo(scope).insert({ id, name: 'rollback' });
        try {
          await repo(scope, name).insert({ id });
        } catch {}
      }),
    ).rejects.toThrow(
      'Native audit supports only covered local CRM creates and updates',
    );
    expect(await f.read('_customCase')).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);

it.each([
  'foreign-workspace',
  'remote',
  'system',
  'standard-identity',
  'standard-name',
  'missing-application',
])('refuses invalid custom metadata: %s', async (mode) => {
  await f.withContext(async () => {
    const objects = Object.values(
      getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier,
    );
    const custom = objects.find(
      (object) => object?.nameSingular === 'customCase',
    )!;
    const standard = objects.find(
      (object) => object?.nameSingular === 'workflow',
    )!;
    const changes =
      mode === 'foreign-workspace'
        ? { workspaceId: randomUUID() }
        : mode === 'remote'
          ? { isRemote: true }
          : mode === 'system'
            ? { isSystem: true }
            : mode === 'standard-identity'
              ? { universalIdentifier: standard.universalIdentifier }
              : mode === 'standard-name'
                ? { nameSingular: 'workflow' }
                : { applicationUniversalIdentifier: '' };
    expect(isNativeCrmAuditMetadata(custom, f.workspaceId)).toBe(true);
    expect(
      isNativeCrmAuditMetadata({ ...custom, ...changes }, f.workspaceId),
    ).toBe(false);
  });
});
