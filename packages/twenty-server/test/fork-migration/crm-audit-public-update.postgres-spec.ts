import { randomUUID } from 'node:crypto';
import {
  type ObjectsPermissionsByRoleId,
  type ObjectRecord,
} from 'twenty-shared/types';
import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { CommonUpdateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-many-query-runner.service';
import { CommonUpdateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-one-query-runner.service';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { addCustomCrmMetadata } from 'test/fork-migration/custom-crm-metadata.fixture';
import { CommonCreateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-one-query-runner.service';
import { CommonCreateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service';
import { CommonDeleteOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-delete-one-query-runner.service';
import { CommonDeleteManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-delete-many-query-runner.service';
import { CommonRestoreOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-restore-one-query-runner.service';
import { CommonRestoreManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-restore-many-query-runner.service';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
// Nest injection tokens are replaced; the fixture supplies real ORM and processors below.
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/api/graphql/workspace-query-runner/workspace-query-hook/workspace-query-hook.service',
  () => ({ WorkspaceQueryHookService: class {} }),
);
jest.mock(
  'src/engine/workspace-cache/services/workspace-cache.service',
  () => ({ WorkspaceCacheService: class {} }),
);
jest.mock(
  'src/engine/core-modules/usage-limit/services/usage-limit-speed.service',
  () => ({ UsageLimitSpeedService: class {} }),
);
jest.mock(
  'src/engine/core-modules/usage/services/usage-recorder.service',
  () => ({ UsageRecorderService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/engine/core-modules/event-logs/emit/application-repeated-event-recorder.service',
  () => ({ ApplicationRepeatedEventRecorderService: class {} }),
);
jest.mock('src/engine/core-modules/file/file-url/file-url.service', () => ({
  FileUrlService: class {},
}));
jest.mock(
  'src/engine/core-modules/record-share/services/share-with.service',
  () => ({ ShareWithService: class {} }),
);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity', 'customCase'],
  configureMetadata: addCustomCrmMetadata,
  coreSchema: 'audit',
});
const id = randomUUID();
const secondId = randomUUID();
const actorId = randomUUID();
const roleId = randomUUID();
const bypass = { shouldBypassPermissionChecks: true as const };
let base: ReturnType<typeof getWorkspaceContext>;
const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const harness = (
  kind: 'system' | 'user' | 'apiKey' | 'application' = 'system',
  canUpdate = true,
  workspaceId = f.workspaceId,
) => {
  const auth = (
    kind === 'system'
      ? base.authContext
      : {
          workspace: { ...base.authContext.workspace, id: workspaceId },
          type: kind,
          ...(kind === 'user'
            ? {
                workspaceMemberId: actorId,
                userWorkspaceId: actorId,
                user: { id: actorId },
              }
            : {}),
          ...(kind === 'apiKey' ? { apiKey: { id: actorId } } : {}),
          ...(kind === 'application'
            ? { application: { id: actorId, defaultRoleId: roleId } }
            : {}),
        }
  ) as WorkspaceAuthContext;
  const permissions: ObjectsPermissionsByRoleId = {
    [roleId]: Object.fromEntries(
      Object.values(base.objectIdByNameSingular).map((objectId) => [
        objectId,
        {
          canReadObjectRecords: true,
          canUpdateObjectRecords: canUpdate,
          canSoftDeleteObjectRecords: canUpdate,
          canDestroyObjectRecords: false,
          restrictedFields: {},
          rowLevelPermissionPredicates: [],
          rowLevelPermissionPredicateGroups: [],
        },
      ]),
    ),
  };
  const context = {
    ...base,
    authContext: auth,
    permissionsPerRoleId: permissions,
    userWorkspaceRoleMap: { [actorId]: roleId },
    apiKeyRoleMap: { [actorId]: roleId },
  };
  const dataSource = new WorkspaceDataSource({
    pool: f.pool,
    internalContext: {
      ...context,
      workspaceId: f.workspaceId,
      eventEmitterService: { emitDatabaseBatchEvent: f.eventEmitter },
      recordStock: f.recordStock,
      coreDataSource: f.owner,
    },
    authContext: auth,
    objectPermissionsByRoleId: permissions,
  });
  const managerPort = {
    executeInWorkspaceContext: <TData>(work: () => Promise<TData>) =>
      withWorkspaceContext(context, work),
    runInWorkspaceTransaction: dataSource.transaction.bind(dataSource),
    getRepository: jest.fn(dataSource.getRepository.bind(dataSource)),
  };
  const manager = managerPort as unknown as WorkspaceOrmManager;
  const hooks = {
    executePreQueryHooks: jest.fn(
      async (
        _auth: unknown,
        _name: unknown,
        _operation: unknown,
        args: unknown,
      ) => args,
    ),
    executePostQueryHooks: jest.fn(async (..._args: unknown[]) => {}),
  };
  const visibility = new CommonRecordVisibilityService();
  const many = new CommonUpdateManyQueryRunnerService();
  const one = new CommonUpdateOneQueryRunnerService(many);
  const shares = {
    validateShareWithOrThrow: jest.fn(),
    insertRecordSharesForCreatedRecords: jest.fn(),
  };
  const createMany = new CommonCreateManyQueryRunnerService(
    new RecordPositionService(manager),
    shares as unknown as ConstructorParameters<
      typeof CommonCreateManyQueryRunnerService
    >[1],
  );
  const createOne = new CommonCreateOneQueryRunnerService(createMany);
  const deleteMany = new CommonDeleteManyQueryRunnerService(),
    deleteOne = new CommonDeleteOneQueryRunnerService(deleteMany);
  const restoreMany = new CommonRestoreManyQueryRunnerService(),
    restoreOne = new CommonRestoreOneQueryRunnerService(restoreMany);
  for (const runner of [
    one,
    many,
    createOne,
    createMany,
    deleteOne,
    deleteMany,
    restoreOne,
    restoreMany,
  ])
    Object.assign(runner, {
      workspaceOrmManager: manager,
      workspaceQueryHookService: hooks,
      dataArgProcessor: new DataArgProcessorService(
        new RecordPositionService(manager),
      ),
      filterArgProcessor: new FilterArgProcessorService(),
      processNestedRelationsHelper: new ProcessNestedRelationsHelper(manager),
      commonRecordVisibilityService: visibility,
      commonResultGettersService: new CommonResultGettersService(
        {} as FileUrlService,
      ),
      usageLimitSpeedService: { consumeOrThrow: jest.fn(async () => {}) },
      usageRecorderService: { isEnabled: () => false },
      twentyConfigService: { get: () => 10000 },
      metricsService: { incrementCounterBy: jest.fn() },
    });
  const queryContext = (
    name: string,
    transactionScope?: WorkspaceTransactionScope,
  ): CommonBaseQueryRunnerContext => ({
    authContext: auth,
    flatObjectMetadata: Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.id === base.objectIdByNameSingular[name])!,
    flatObjectMetadataMaps: base.flatObjectMetadataMaps,
    flatFieldMetadataMaps: base.flatFieldMetadataMaps,
    flatIndexMaps: base.flatIndexMaps,
    objectIdByNameSingular: base.objectIdByNameSingular,
    transactionScope,
  });
  return {
    permissions,
    one,
    many,
    createOne,
    createMany,
    deleteOne,
    deleteMany,
    restoreOne,
    restoreMany,
    shares,
    queryContext,
    hooks,
    visibility,
    managerPort,
    dataSource,
    run: <TData>(work: () => Promise<TData>) =>
      withWorkspaceContext(context, work),
  };
};

beforeAll(async () => {
  base = await f.withContext(async () => getWorkspaceContext());
  await f.initialize();
});
beforeEach(async () => {
  await f.reset();
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company(id,name) VALUES ($1,'original'),($2,'second')`,
    [id, secondId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person(id,"nameFirstName","companyId") VALUES ($1,'original',$1)`,
    [id],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".opportunity(id,name) VALUES ($1,'original')`,
    [id],
  );
});
afterEach(async () => {
  jest.restoreAllMocks();
  await f.owner.query(
    'DROP TRIGGER IF EXISTS fail_public_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query('DROP FUNCTION IF EXISTS crm_audit.fail_public_audit()');
});
afterAll(() => f.dispose());

it.each([false, true])(
  'creates standard-custom-standard nested records inside an explicit audited scope; rollback=%s',
  async (rollback) => {
    const h = harness(),
      parentId = randomUUID(),
      caseId = randomUUID(),
      nestedId = randomUUID();
    const operation = h.run(() =>
      h.dataSource.transaction(
        async (scope) => {
          const result = await h.createOne.execute(
            {
              data: {
                id: parentId,
                name: 'parent',
                case: {
                  create: {
                    id: caseId,
                    name: 'case',
                    company: {
                      create: { id: nestedId, name: 'nested company' },
                    },
                  },
                },
              },
              selectedFields: { id: true, caseId: true },
            },
            h.queryContext('company', scope),
          );
          expect(result.results).toMatchObject({ id: parentId, caseId });
          expect(await audit()).toHaveLength(0);
          if (rollback) throw new Error('NESTED_CUSTOM_ROLLBACK');
        },
        {
          nativeAudit: {
            operationId: randomUUID(),
            systemActorId: 'nested-custom-test',
          },
        },
      ),
    );
    if (rollback)
      await expect(operation).rejects.toThrow('NESTED_CUSTOM_ROLLBACK');
    else await operation;
    expect(
      (await f.read('_customCase')).map((row: ObjectRecord) => row.id),
    ).toEqual(rollback ? [] : [caseId]);
    expect(
      (await f.read('company')).filter(
        (row: ObjectRecord) => row.id === parentId || row.id === nestedId,
      ),
    ).toHaveLength(rollback ? 0 : 2);
    const entries = await audit();
    expect(entries).toHaveLength(rollback ? 0 : 3);
    if (!rollback)
      expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
    expect(h.shares.insertRecordSharesForCreatedRecords).not.toHaveBeenCalled();
  },
);

it.each(['system', 'user', 'apiKey', 'application'] as const)(
  'automatically audits the authenticated %s public update once',
  async (kind) => {
    const h = harness(kind);
    const result = await h.one.execute(
      {
        id,
        data: { name: 'private new' },
        selectedFields: { id: true, name: true },
      },
      h.queryContext('company'),
    );
    expect(result.results).toEqual({
      id,
      name: 'private new',
      updatedAt: expect.any(Date),
    });
    expect(await audit()).toHaveLength(1);
    expect((await audit())[0]).toMatchObject({
      resourceKind: 'crmRecord',
      resourceId: id,
      actor: {
        kind: kind === 'user' ? 'workspaceMember' : kind,
        id: kind === 'system' ? 'crm-api-update' : actorId,
      },
    });
    expect(JSON.stringify(await audit())).not.toContain('private new');
    expect(h.hooks.executePostQueryHooks).toHaveBeenCalledTimes(1);
    expect(h.managerPort.getRepository).not.toHaveBeenCalled();
  },
);

it.each(['person', 'opportunity'])(
  'uses the actual public transformer and writer for %s',
  async (name) => {
    const h = harness();
    const data =
      name === 'person' ? { name: { firstName: 'new' } } : { name: 'new' };
    await h.one.execute(
      { id, data, selectedFields: { id: true, name: true } },
      h.queryContext(name),
    );
    expect((await audit())[0]).toMatchObject({
      resourceId: id,
      securityDescriptor: {
        objectMetadataId: base.objectIdByNameSingular[name],
      },
    });
  },
);

it('updates a filtered batch with one audit operation and actual affected IDs', async () => {
  const h = harness();
  const result = await h.many.execute(
    {
      filter: { id: { in: [id, secondId, randomUUID()] } },
      data: { name: 'batch' },
      selectedFields: { id: true },
    },
    h.queryContext('company'),
  );
  expect(new Set(result.results.map((row) => row.id))).toEqual(
    new Set([id, secondId]),
  );
  const rows = await audit();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.operationId)).size).toBe(1);
});

it('denies an actor lacking update permission without changing data or success audit', async () => {
  const h = harness('apiKey', false);
  await expect(
    h.one.execute(
      { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toThrow();
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('original');
  expect(await audit()).toHaveLength(0);
});

it('rolls the public mutation back if the append-only audit writer fails', async () => {
  const h = harness();
  await f.owner.query(
    `CREATE FUNCTION crm_audit.fail_public_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`,
  );
  await f.owner.query(
    'CREATE TRIGGER fail_public_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_public_audit()',
  );
  await expect(
    h.one.execute(
      { id, data: { name: 'rollback' }, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toThrow('Data validation error.');
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('original');
  expect(await audit()).toHaveLength(0);
  expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
});

it('preserves awaited postcommit hook errors after the database and audit are committed', async () => {
  const h = harness();
  h.hooks.executePostQueryHooks.mockImplementation(async () => {
    expect(
      (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
    ).toBe('committed');
    expect(await audit()).toHaveLength(1);
    throw new Error('postcommit hook failed');
  });
  await expect(
    h.one.execute(
      { id, data: { name: 'committed' }, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toThrow('postcommit hook failed');
  expect(await audit()).toHaveLength(1);
});

it('reads nested relations on the inherited transaction and rolls all writes back with its owner', async () => {
  const h = harness();
  await expect(
    h.run(() =>
      h.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', bypass)
            .update(id, { name: 'uncommitted' });
          const result = await h.one.execute(
            {
              id,
              data: { jobTitle: 'changed' },
              selectedFields: { id: true, company: { id: true, name: true } },
            },
            h.queryContext('person', scope),
          );
          expect(result.results.company).toEqual({ id, name: 'uncommitted' });
          expect(
            (await f.read('company')).find((row: ObjectRecord) => row.id === id)
              .name,
          ).toBe('original');
          expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
          expect(h.managerPort.getRepository).not.toHaveBeenCalled();
          throw new Error('owner abort');
        },
        {
          nativeAudit: {
            operationId: randomUUID(),
            systemActorId: 'owner-test',
          },
        },
      ),
    ),
  ).rejects.toThrow('owner abort');
  expect(await audit()).toHaveLength(0);
  expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
});

it('rejects an unproven legacy scope instead of silently writing without audit', async () => {
  const h = harness();
  await expect(
    h.run(() =>
      h.dataSource.transaction((scope) =>
        h.one.execute(
          { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
          h.queryContext('company', scope),
        ),
      ),
    ),
  ).rejects.toThrow('proven native audit scope');
  expect(await audit()).toHaveLength(0);
});

it('commits one operation for inherited updates and runs hooks only after commit', async () => {
  const h = harness('user');
  const operationId = randomUUID();
  h.hooks.executePostQueryHooks.mockImplementation(async () => {
    expect(await audit()).toHaveLength(1);
  });
  await h.run(() =>
    h.dataSource.transaction(
      async (scope) => {
        for (const name of ['middle', 'final'])
          await h.one.execute(
            { id, data: { name }, selectedFields: { id: true } },
            h.queryContext('company', scope),
          );
        expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
      },
      { nativeAudit: { operationId } },
    ),
  );
  expect(await audit()).toHaveLength(1);
  expect((await audit())[0]).toMatchObject({
    operationId,
    actor: { kind: 'workspaceMember', id: actorId },
  });
  expect(h.hooks.executePostQueryHooks).toHaveBeenCalledTimes(2);
});

it('poisons a proven owner on mismatched actor even if the caller catches the error', async () => {
  const owner = harness('user');
  const other = harness('apiKey');
  await expect(
    owner.run(() =>
      owner.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', bypass)
            .update(id, { name: 'rollback' });
          await expect(
            other.one.execute(
              { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
              other.queryContext('company', scope),
            ),
          ).rejects.toThrow('different workspace or actor');
        },
        { nativeAudit: { operationId: randomUUID() } },
      ),
    ),
  ).rejects.toThrow('different workspace or actor');
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('original');
  expect(await audit()).toHaveLength(0);
});

it('rejects a foreign workspace against an otherwise matching actor and poisons the owner', async () => {
  const owner = harness('user');
  const other = harness('user', true, randomUUID());
  await expect(
    owner.run(() =>
      owner.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', bypass)
            .update(id, { name: 'rollback' });
          await expect(
            other.one.execute(
              { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
              other.queryContext('company', scope),
            ),
          ).rejects.toThrow('workspace mismatch');
        },
        { nativeAudit: { operationId: randomUUID() } },
      ),
    ),
  ).rejects.toThrow('workspace mismatch');
  expect(await audit()).toHaveLength(0);
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('original');
});

it.each(['expired', 'copied'] as const)(
  'refuses a %s audit scope with no unscoped fallback',
  async (mode) => {
    const h = harness();
    let retained!: WorkspaceTransactionScope;
    await h.run(() =>
      h.dataSource.transaction(
        async (scope) => {
          retained = scope;
          if (mode === 'copied')
            await expect(
              h.one.execute(
                {
                  id,
                  data: { name: 'forbidden' },
                  selectedFields: { id: true },
                },
                h.queryContext('company', { ...scope }),
              ),
            ).rejects.toThrow('proven native audit scope');
        },
        {
          nativeAudit: {
            operationId: randomUUID(),
            systemActorId: 'owner-test',
          },
        },
      ),
    );
    if (mode === 'expired')
      await expect(
        h.one.execute(
          { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
          h.queryContext('company', retained),
        ),
      ).rejects.toThrow('proven native audit scope');
    expect(h.managerPort.getRepository).not.toHaveBeenCalled();
    expect(await audit()).toHaveLength(0);
  },
);

it('keeps unknown commit outcome without rollback, retry, or public postcommit hook', async () => {
  const h = harness();
  const client = await f.pool.connect();
  const query = client.query.bind(client);
  const statements: string[] = [];
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
    h.one.execute(
      { id, data: { name: 'committed' }, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
  expect(statements).not.toContain('ROLLBACK');
  expect(await audit()).toHaveLength(1);
  expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
});

it('applies existing visibility restrictions to nested results before returning them or running hooks', async () => {
  const h = harness();
  h.visibility.registerHandler({
    objectNameSingular: 'company',
    handler: {
      applyVisibilityRestrictions: async ({ records }) => {
        for (const record of records) delete record.name;
      },
    },
  });
  const result = await h.one.execute(
    {
      id,
      data: { jobTitle: 'new' },
      selectedFields: { id: true, company: { id: true, name: true } },
    },
    h.queryContext('person'),
  );
  expect(result.results.company).toEqual({ id });
  expect(h.hooks.executePostQueryHooks.mock.calls[0][3]).toMatchObject({
    company: { id },
  });
  expect(
    JSON.stringify(h.hooks.executePostQueryHooks.mock.calls),
  ).not.toContain('original');
});

it.each(['createdAt', 'updatedAt', 'deletedAt'])(
  'preserves the public OPEN %s timestamp contract',
  async (field) => {
    const h = harness();
    await h.one.execute(
      {
        id,
        data: { [field]: '2020-02-03T04:05:06.123456Z' },
        selectedFields: { id: true },
      },
      h.queryContext('company'),
    );
    const rows = await f.owner.query(
      `SELECT "${field}"::text AS value FROM "${f.schemaName}".company WHERE id=$1`,
      [id],
    );
    expect(rows[0].value).toBe('2020-02-03 04:05:06.123456+00');
    const metadata = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (item) =>
        item?.objectMetadataId === base.objectIdByNameSingular.company &&
        item.name === field,
    )!;
    expect((await audit())[0].redactedDiff.changedFields).toEqual([
      metadata.id,
    ]);
  },
);

it('keeps missing single records and empty batches free of success audit', async () => {
  const h = harness();
  const missingId = randomUUID();
  await expect(
    h.one.execute(
      {
        id: missingId,
        data: { name: 'missing' },
        selectedFields: { id: true },
      },
      h.queryContext('company'),
    ),
  ).rejects.toThrow('Record not found');
  expect(
    (
      await h.many.execute(
        {
          filter: { id: { eq: missingId } },
          data: { name: 'missing' },
          selectedFields: { id: true },
        },
        h.queryContext('company'),
      )
    ).results,
  ).toEqual([]);
  expect(await audit()).toHaveLength(0);
});

it('enforces existing field update restrictions inside the automatic owner', async () => {
  const h = harness('apiKey');
  const objectId = base.objectIdByNameSingular.company;
  const field = Object.values(
    base.flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(
    (item) => item?.objectMetadataId === objectId && item.name === 'name',
  )!;
  h.permissions[roleId][objectId].restrictedFields[field.id] = {
    canRead: true,
    canUpdate: false,
  };
  await expect(
    h.one.execute(
      { id, data: { name: 'forbidden' }, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toThrow();
  expect(
    (await f.read('company')).find((row: ObjectRecord) => row.id === id).name,
  ).toBe('original');
  expect(await audit()).toHaveLength(0);
});

it('resolves public connect and disconnect with the scoped nested relation writer', async () => {
  const h = harness('user');
  const connected = await h.one.execute(
    {
      id,
      data: { company: { connect: { where: { id: secondId } } } },
      selectedFields: { id: true, company: { id: true, name: true } },
    },
    h.queryContext('person'),
  );
  expect(connected.results.company).toEqual({ id: secondId, name: 'second' });
  const disconnected = await h.one.execute(
    {
      id,
      data: { company: { disconnect: true } },
      selectedFields: { id: true, company: { id: true } },
    },
    h.queryContext('person'),
  );
  expect(disconnected.results.company).toBeNull();
  expect(await audit()).toHaveLength(2);
  expect(h.managerPort.getRepository).not.toHaveBeenCalled();
});

it.each(
  ['company', 'person', 'opportunity'].flatMap((object) =>
    [false, true].map((batch) => ({ object, batch })),
  ),
)(
  'audits public soft-delete and restore for $object; batch=$batch',
  async ({ object, batch }) => {
    const h = harness('user');
    const ids = object === 'company' && batch ? [id, secondId] : [id];
    if (batch)
      await h.deleteMany.execute(
        {
          filter: { id: { in: ids } },
          selectedFields: { id: true, deletedAt: true },
        },
        h.queryContext(object),
      );
    else
      await h.deleteOne.execute(
        { id, selectedFields: { id: true, deletedAt: true } },
        h.queryContext(object),
      );
    const deleted = (await f.read(object)) as ObjectRecord[];
    expect(
      deleted
        .filter((row) => ids.some((value) => value === row.id))
        .every((row) => row.deletedAt instanceof Date),
    ).toBe(true);
    if (batch)
      await h.restoreMany.execute(
        {
          filter: { id: { in: ids } },
          selectedFields: { id: true, deletedAt: true },
        },
        h.queryContext(object),
      );
    else
      await h.restoreOne.execute(
        { id, selectedFields: { id: true, deletedAt: true } },
        h.queryContext(object),
      );
    expect(
      ((await f.read(object)) as ObjectRecord[]).every(
        (row) => row.deletedAt === null,
      ),
    ).toBe(true);
    const entries = await audit();
    expect(entries).toHaveLength(ids.length * 2);
    expect(
      entries.every(
        (entry) => entry.action === 'update' && entry.actor.id === actorId,
      ),
    ).toBe(true);
    expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(2);
    expect(h.managerPort.getRepository).not.toHaveBeenCalled();
  },
);

it.each(['deleteOne', 'restoreOne'] as const)(
  'preserves public permission denial for %s',
  async (method) => {
    if (method === 'restoreOne')
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [id],
      );
    const before = await f.read('company'),
      h = harness('apiKey', false);
    await expect(
      h[method].execute(
        { id, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow();
    expect(await f.read('company')).toEqual(before);
    expect(await audit()).toHaveLength(0);
  },
);

it.each(['deleteOne', 'restoreOne'] as const)(
  'rolls %s back on a real audit INSERT failure',
  async (method) => {
    if (method === 'restoreOne')
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [id],
      );
    const before = await f.read('company'),
      h = harness();
    await f.owner.query(
      `CREATE FUNCTION crm_audit.fail_public_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LIFECYCLE_AUDIT_FAILURE'; END $$`,
    );
    await f.owner.query(
      'CREATE TRIGGER fail_public_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_public_audit()',
    );
    let cause: unknown = await h[method]
      .execute({ id, selectedFields: { id: true } }, h.queryContext('company'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(cause).toBeInstanceOf(Error);
    const messages: string[] = [],
      seen = new Set<Error>();
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause);
      messages.push(cause.message);
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    expect(messages).toContain('LIFECYCLE_AUDIT_FAILURE');
    expect(await f.read('company')).toEqual(before);
    expect(await audit()).toHaveLength(0);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('loads lifecycle nested relations through the current transaction repository', async () => {
  const h = harness('user');
  await h.run(() =>
    h.dataSource.transaction(
      async (scope) => {
        await scope
          .getRepository('company', bypass)
          .update(id, { name: 'uncommitted parent' });
        for (const method of ['deleteOne', 'restoreOne'] as const) {
          const result = await h[method].execute(
            {
              id,
              selectedFields: { id: true, company: { id: true, name: true } },
            },
            h.queryContext('person', scope),
          );
          expect(result.results.company).toEqual({
            id,
            name: 'uncommitted parent',
          });
        }
        expect(await audit()).toHaveLength(0);
      },
      { nativeAudit: { operationId: randomUUID() } },
    ),
  );
  expect(h.managerPort.getRepository).not.toHaveBeenCalled();
  const entries = await audit();
  expect(entries).toHaveLength(2);
  expect(
    entries.find(
      (entry) =>
        entry.securityDescriptor.objectMetadataId ===
        base.objectIdByNameSingular.person,
    )?.redactedDiff.changedFields,
  ).toEqual([]);
});

it('does not retry lifecycle writes after a lost real COMMIT acknowledgement', async () => {
  const h = harness(),
    client = await f.pool.connect(),
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
    h.deleteOne.execute(
      { id, selectedFields: { id: true } },
      h.queryContext('company'),
    ),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
  expect(statements).not.toContain('ROLLBACK');
  expect(
    ((await f.read('company')) as ObjectRecord[]).find((row) => row.id === id)
      ?.deletedAt,
  ).toBeInstanceOf(Date);
  expect(await audit()).toHaveLength(1);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});
