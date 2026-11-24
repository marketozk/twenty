import { randomUUID } from 'node:crypto';
import {
  FieldMetadataType,
  RowLevelPermissionPredicateOperand,
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { CommonDestroyManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service';
import { CommonDestroyOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service';
import {
  CommonQueryRunnerException,
  CommonQueryRunnerExceptionCode,
} from 'src/engine/api/common/common-query-runners/errors/common-query-runner.exception';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { runInStandaloneShareWithScope } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { DeleteRecordService } from 'src/engine/core-modules/record-crud/services/delete-record.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { addCustomCrmMetadata } from 'test/fork-migration/custom-crm-metadata.fixture';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
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
jest.mock(
  'src/engine/core-modules/record-crud/services/common-api-context-builder.service',
  () => ({ CommonApiContextBuilderService: class {} }),
);

const f = createOmniNativeMessageFixture({
  additionalTables: [
    'company',
    'opportunity',
    'customCase',
    'task',
    'taskTarget',
    'recordShare',
  ],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  configureMetadata: (maps) => {
    addCustomCrmMetadata(maps);
    const source = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find((field) => field?.name === 'name')!;
    const company = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'company')!;
    const customCase = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'customCase')!;
    for (const targetObject of [company, customCase]) {
      const field = {
        ...source,
        id: randomUUID(),
        universalIdentifier: randomUUID(),
        objectMetadataId: targetObject.id,
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
    }
  },
});

const id = randomUUID();
const secondId = randomUUID();
const actorId = randomUUID();
const agentId = randomUUID();
const roleId = randomUUID();
const bypass = { shouldBypassPermissionChecks: true as const };
let base: ReturnType<typeof getWorkspaceContext>;

const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const expectPostRollbackAttempts = async (
  expected: Array<{ outcome: 'denied' | 'failed'; reasonCode?: string }>,
) => {
  const rows = await audit();
  expect(rows.filter((entry) => entry.outcome === 'success')).toHaveLength(0);
  expect(rows.filter((entry) => entry.outcome !== 'success')).toEqual(
    expected.map((item) => expect.objectContaining(item)),
  );
  await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
};

const setDeleteAction = async (
  table: string,
  column: string,
  action: 'CASCADE' | 'SET NULL',
) => {
  const constraints = await f.owner.query<{ conname: string }[]>(
    `SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND confrelid=$2::regclass AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$3)]::smallint[]`,
    [`"${f.schemaName}"."${table}"`, `"${f.schemaName}".company`, column],
  );
  for (const constraint of constraints)
    await f.owner.query(
      `ALTER TABLE "${f.schemaName}"."${table}" DROP CONSTRAINT "${constraint.conname.replaceAll('"', '""')}"`,
    );
  await f.owner.query(
    `ALTER TABLE "${f.schemaName}"."${table}" ADD CONSTRAINT "direct_${column}" FOREIGN KEY ("${column}") REFERENCES "${f.schemaName}".company(id) ON DELETE ${action}`,
  );
};

const harness = (
  kind: 'system' | 'user' | 'apiKey' | 'application' | 'agent' = 'system',
  canDestroy = true,
  workspaceId = f.workspaceId,
  rlsPredicatesByObjectName: Record<
    string,
    ObjectsPermissionsByRoleId[string][string]['rowLevelPermissionPredicates']
  > = {},
) => {
  const auth = (
    kind === 'system'
      ? base.authContext
      : {
          workspace: { ...base.authContext.workspace, id: workspaceId },
          type: kind === 'agent' ? 'application' : kind,
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
          ...(kind === 'agent'
            ? {
                application: { id: actorId, defaultRoleId: roleId },
                actingAgent: { id: agentId },
              }
            : {}),
        }
  ) as WorkspaceAuthContext;

  const permissions: ObjectsPermissionsByRoleId = {
    [roleId]: Object.fromEntries(
      Object.entries(base.objectIdByNameSingular).map(([name, objectId]) => [
        objectId,
        {
          canReadObjectRecords: true,
          canUpdateObjectRecords: canDestroy,
          canSoftDeleteObjectRecords: canDestroy,
          canDestroyObjectRecords: canDestroy,
          restrictedFields: {},
          rowLevelPermissionPredicates: rlsPredicatesByObjectName[name] ?? [],
          rowLevelPermissionPredicateGroups: [],
        },
      ]),
    ),
  };

  const allRlsPredicates = Object.values(rlsPredicatesByObjectName).flat();
  const flatRowLevelPermissionPredicateMaps = {
    byUniversalIdentifier: Object.fromEntries(
      allRlsPredicates.map((predicate) => [
        (predicate as { universalIdentifier?: string; id: string })
          .universalIdentifier ?? predicate.id,
        predicate,
      ]),
    ),
    universalIdentifierById: Object.fromEntries(
      allRlsPredicates.map((predicate) => [
        predicate.id,
        (predicate as { universalIdentifier?: string; id: string })
          .universalIdentifier ?? predicate.id,
      ]),
    ),
    universalIdentifiersByApplicationId: {},
  };

  const context = {
    ...base,
    authContext: auth,
    permissionsPerRoleId: permissions,
    flatRowLevelPermissionPredicateMaps:
      allRlsPredicates.length > 0
        ? (flatRowLevelPermissionPredicateMaps as typeof base.flatRowLevelPermissionPredicateMaps)
        : base.flatRowLevelPermissionPredicateMaps,
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
  const destroyMany = new CommonDestroyManyQueryRunnerService();
  const destroyOne = new CommonDestroyOneQueryRunnerService(destroyMany);

  for (const runner of [destroyOne, destroyMany]) {
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
  }

  const queryContext = (
    name: string,
    transactionScope?: WorkspaceTransactionScope,
    overrides?: Partial<CommonBaseQueryRunnerContext['flatObjectMetadata']>,
  ): CommonBaseQueryRunnerContext => {
    const flatObjectMetadata = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.id === base.objectIdByNameSingular[name])!;

    return {
      authContext: auth,
      flatObjectMetadata: overrides
        ? { ...flatObjectMetadata, ...overrides }
        : flatObjectMetadata,
      flatObjectMetadataMaps: base.flatObjectMetadataMaps,
      flatFieldMetadataMaps: base.flatFieldMetadataMaps,
      flatIndexMaps: base.flatIndexMaps,
      objectIdByNameSingular: base.objectIdByNameSingular,
      transactionScope,
    };
  };

  return {
    auth,
    permissions,
    destroyOne,
    destroyMany,
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
  await f.initialize();
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core.file (
       id uuid PRIMARY KEY,
       "workspaceId" uuid,
       "applicationId" uuid,
       path text NOT NULL,
       size bigint NOT NULL DEFAULT 0,
       settings jsonb,
       status text NOT NULL DEFAULT 'UPLOADED',
       "deletedAt" timestamptz,
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await f.owner.query(
    `GRANT USAGE ON SCHEMA core TO "${f.roleName}";
     GRANT SELECT, UPDATE ON core.file TO "${f.roleName}";`,
  );
  base = await f.withContext(async () => getWorkspaceContext());
});

beforeEach(async () => {
  await f.owner.query(`DROP TABLE IF EXISTS "${f.schemaName}".delete_child`);
  await f.owner.query(
    `DROP TRIGGER IF EXISTS fail_public_destroy_audit ON crm_audit."crmAuditEntry"`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS crm_audit.fail_public_destroy_audit()`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS keep_destroyed ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".keep_destroyed()`,
  );
  await f.owner.query(
    'DELETE FROM core."omniExternalIdentity" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniAccountBinding" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.reset();
  for (const table of ['company', 'opportunity', '_customCase']) {
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."${table}" (id, name) VALUES ($1, 'private first'), ($2, 'private second')`,
      [id, secondId],
    );
  }
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person (id, "companyId") VALUES ($1, $1), ($2, $2)`,
    [id, secondId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".task (id) VALUES ($1), ($2)`,
    [id, secondId],
  );
  f.recordStock.releaseRecordStock.mockClear();
  f.eventEmitter.mockClear();
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

describe('Public physical deletion CRM audit (LOG-202)', () => {
  it('audits public destroyOne and destroyMany across standard/custom objects, soft-deleted rows, all actor types, selectedFields without id, unmatched deletes, and validate()', async () => {
    // 1. Live and soft-deleted destroyOne on company, person, opportunity, customCase with different actors
    const cases: Array<{
      object: 'company' | 'person' | 'opportunity' | 'customCase';
      actorKind: 'user' | 'apiKey' | 'application' | 'agent' | 'system';
      expectedActor: { kind: string; id: string };
      softDeleteFirst: boolean;
      selectedFields: Record<string, boolean>;
    }> = [
      {
        object: 'person',
        actorKind: 'user',
        expectedActor: { kind: 'workspaceMember', id: actorId },
        softDeleteFirst: false,
        selectedFields: { id: true },
      },
      {
        object: 'opportunity',
        actorKind: 'apiKey',
        expectedActor: { kind: 'apiKey', id: actorId },
        softDeleteFirst: true,
        selectedFields: { name: true },
      },
      {
        object: 'customCase',
        actorKind: 'application',
        expectedActor: { kind: 'application', id: actorId },
        softDeleteFirst: true,
        selectedFields: { id: true, name: true },
      },
      {
        object: 'company',
        actorKind: 'agent',
        expectedActor: { kind: 'agent', id: agentId },
        softDeleteFirst: false,
        selectedFields: { name: true },
      },
    ];

    for (const item of cases) {
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      const table = item.object === 'customCase' ? '_customCase' : item.object;
      if (item.softDeleteFirst) {
        await f.owner.query(
          `UPDATE "${f.schemaName}"."${table}" SET "deletedAt" = now() WHERE id = $1`,
          [id],
        );
      }
      f.recordStock.releaseRecordStock.mockClear();
      const h = harness(item.actorKind);
      const { results } = await h.destroyOne.execute(
        { id, selectedFields: item.selectedFields },
        h.queryContext(item.object),
      );
      expect(results).toBeDefined();
      if (item.selectedFields.name) {
        expect(results.name).toBe('private first');
      }
      expect(f.recordStock.releaseRecordStock).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 1 }),
      );
      const remaining = (await f.read(table)) as Array<{ id: string }>;
      expect(remaining.some((row) => row.id === id)).toBe(false);
      const entries = await audit();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'delete',
        resourceKind: 'crmRecord',
        resourceId: id,
        actor: item.expectedActor,
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: id,
          objectMetadataId: base.objectIdByNameSingular[item.object],
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        },
      });
      expect(JSON.stringify(entries)).not.toContain('private');
      expect(h.managerPort.getRepository).not.toHaveBeenCalled();
      expect(h.hooks.executePostQueryHooks).toHaveBeenCalledTimes(1);
    }

    // 2. Multi-row destroyMany (>= 2 rows) with system actor uses systemActorId: 'crm-api-destroy' under one operationId
    const extraOppId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".opportunity (id, name) VALUES ($1, 'private batch')`,
      [extraOppId],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    f.recordStock.releaseRecordStock.mockClear();
    const sysH = harness('system');
    const { results: destroyedMany } = await sysH.destroyMany.execute(
      {
        filter: { id: { in: [secondId, extraOppId, randomUUID()] } },
        selectedFields: { id: true, name: true },
      },
      sysH.queryContext('opportunity'),
    );
    expect(destroyedMany.map((row) => row.id).sort()).toEqual(
      [secondId, extraOppId].sort(),
    );
    expect(f.recordStock.releaseRecordStock).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2 }),
    );
    const sysEntries = await audit();
    expect(sysEntries).toHaveLength(2);
    expect(new Set(sysEntries.map((entry) => entry.operationId)).size).toBe(1);
    expect(sysEntries.map((entry) => entry.resourceId).sort()).toEqual(
      [secondId, extraOppId].sort(),
    );
    for (const entry of sysEntries) {
      expect(entry.actor).toEqual({
        kind: 'system',
        id: 'crm-api-destroy',
      });
    }

    // 3. Unmatched destroyOne -> RECORD_NOT_FOUND (0 audit, 0 hooks, no stock release > 0); unmatched destroyMany -> [] (0 audit)
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    f.recordStock.releaseRecordStock.mockClear();
    const hUnmatched = harness('user');
    await expect(
      hUnmatched.destroyOne.execute(
        { id: randomUUID(), selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    expect(hUnmatched.hooks.executePostQueryHooks).not.toHaveBeenCalled();
    expect(
      f.recordStock.releaseRecordStock.mock.calls.filter(
        ([call]: [{ quantity: number }]) => call.quantity > 0,
      ),
    ).toHaveLength(0);

    const { results: emptyMany } = await hUnmatched.destroyMany.execute(
      {
        filter: { id: { eq: randomUUID() } },
        selectedFields: { id: true },
      },
      hUnmatched.queryContext('company'),
    );
    expect(emptyMany).toEqual([]);
    expect(await audit()).toHaveLength(0);
    expect(
      f.recordStock.releaseRecordStock.mock.calls.filter(
        ([call]: [{ quantity: number }]) => call.quantity > 0,
      ),
    ).toHaveLength(0);

    // 4. CommonDestroyOneQueryRunnerService and CommonDestroyManyQueryRunnerService validate() rejections
    await expect(
      hUnmatched.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hUnmatched.queryContext('company', undefined, { isRemote: true }),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
      message: 'Remote objects are read-only',
    });
    await expect(
      hUnmatched.destroyOne.execute(
        { id: undefined as unknown as string, selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
      message: 'Missing id',
    });
    await expect(
      hUnmatched.destroyOne.execute(
        { id: 'not-a-uuid', selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
      message: 'Value "not-a-uuid" is not a valid UUID',
    });
    await expect(
      hUnmatched.destroyMany.execute(
        { filter: { id: { eq: secondId } }, selectedFields: { id: true } },
        hUnmatched.queryContext('company', undefined, { isRemote: true }),
      ),
    ).rejects.toThrow('Remote objects are read-only');
    await expect(
      hUnmatched.destroyMany.execute(
        { filter: undefined as never, selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
      message: 'Filter is required',
    });
    await expect(
      hUnmatched.destroyMany.execute(
        { filter: { id: { in: ['not-a-uuid'] } }, selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toThrow('is not a valid UUID');
    await expect(
      hUnmatched.destroyMany.execute(
        { filter: {}, selectedFields: { id: true } },
        hUnmatched.queryContext('company'),
      ),
    ).rejects.toThrow();
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.invalid_input' },
    ]);
  });

  it('audits direct FK SET NULL and CASCADE effects under one operationId, enforces fail-closed FILES/uncovered FK/omni-protected parent, and respects BEFORE DELETE trigger skips', async () => {
    await setDeleteAction('_customCase', 'companyId', 'CASCADE');
    await setDeleteAction('person', 'companyId', 'SET NULL');
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET "companyId" = $1 WHERE id = $1`,
      [id],
    );

    // 1. Direct SET NULL (person) + CASCADE (customCase) + ONE_TO_MANY nested relation read on same tx repository
    const h = harness('user');
    await h.destroyOne.execute(
      {
        id,
        selectedFields: {
          id: true,
          people: { id: true },
        },
      },
      h.queryContext('company'),
    );
    const entries = await audit();
    // 1 company delete + 1 person SET NULL update + 1 customCase CASCADE delete = 3 under ONE operationId
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
    expect(
      entries.find(
        (entry) =>
          entry.securityDescriptor.objectMetadataId ===
          base.objectIdByNameSingular.person,
      )?.action,
    ).toBe('update');
    expect(
      entries.find(
        (entry) =>
          entry.securityDescriptor.objectMetadataId ===
          base.objectIdByNameSingular.customCase,
      )?.action,
    ).toBe('delete');
    expect(h.managerPort.getRepository).not.toHaveBeenCalled();
    // Verify actual DB state after SET NULL + CASCADE
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === id,
      ),
    ).toBe(false);
    expect(
      ((await f.read('_customCase')) as Array<{ id: string }>).some(
        (row) => row.id === id,
      ),
    ).toBe(false);
    expect(
      (
        (await f.read('person')) as Array<{
          id: string;
          companyId: string | null;
        }>
      ).find((row) => row.id === id)?.companyId,
    ).toBeNull();

    // 2. Non-empty FILES on parent AND on CASCADE child both refuse before mutation and keep DB intact
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hFail = harness('user');
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [secondId, JSON.stringify([{ fileId: randomUUID(), label: 'parent.pdf' }])],
    );
    await expect(
      hFail.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Native file is missing, deleted or outside this workspace',
    );
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.audit_coverage_rejected' },
    ]);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === secondId,
      ),
    ).toBe(true);
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = NULL WHERE id = $1`,
      [secondId],
    );

    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET "companyId" = $1, documents = $2::jsonb WHERE id = $1`,
      [secondId, JSON.stringify([{ fileId: randomUUID(), label: 'secret.pdf' }])],
    );
    await expect(
      hFail.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Native file is missing, deleted or outside this workspace',
    );
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.audit_coverage_rejected' },
    ]);
    expect(hFail.hooks.executePostQueryHooks).not.toHaveBeenCalled();
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === secondId,
      ),
    ).toBe(true);
    expect(
      ((await f.read('_customCase')) as Array<{ id: string }>).some(
        (row) => row.id === secondId,
      ),
    ).toBe(true);
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET documents = NULL WHERE id = $1`,
      [secondId],
    );

    // 2b. Omni-protected parent refuses before mutation (OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND)
    const bindingId = randomUUID();
    const connectedAccountId = randomUUID();
    const messageChannelId = randomUUID();
    await f.owner.query(
      `INSERT INTO core.workspace (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [f.workspaceId],
    );
    await f.owner.query('INSERT INTO core."connectedAccount" (id) VALUES ($1)', [
      connectedAccountId,
    ]);
    await f.owner.query(
      `INSERT INTO core."messageChannel" (id, "workspaceId", type) VALUES ($1, $2, 'email')`,
      [messageChannelId, f.workspaceId],
    );
    await f.owner.query(
      `INSERT INTO core."omniAccountBinding" (id, "workspaceId", platform, "connectorInstanceId", "accountId", "connectedAccountId", "messageChannelId", "capabilitiesVersion", capabilities)
       VALUES ($1, $2, 'telegram', 'inst-1', 'acc-1', $3, $4, '1', '{}'::jsonb)`,
      [bindingId, f.workspaceId, connectedAccountId, messageChannelId],
    );
    await f.owner.query(
      `INSERT INTO core."omniExternalIdentity" (id, "workspaceId", "bindingId", "providerPeerId", "personId", "verificationSource")
       VALUES ($1, $2, $3, 'peer-1', $4, 'provider')`,
      [randomUUID(), f.workspaceId, bindingId, secondId],
    );
    hFail.hooks.executePostQueryHooks.mockClear();
    await expect(
      hFail.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hFail.queryContext('person'),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    await expectPostRollbackAttempts([
      {
        outcome: 'denied',
        reasonCode: 'crm.mutation.domain_command_required',
      },
    ]);
    expect(hFail.hooks.executePostQueryHooks).not.toHaveBeenCalled();
    expect(
      ((await f.read('person')) as Array<{ id: string }>).some(
        (row) => row.id === secondId,
      ),
    ).toBe(true);
    await f.owner.query(
      'DELETE FROM core."omniExternalIdentity" WHERE "workspaceId" = $1',
      [f.workspaceId],
    );
    await f.owner.query(
      'DELETE FROM core."omniAccountBinding" WHERE "workspaceId" = $1',
      [f.workspaceId],
    );

    // 3. Uncovered FK child table (CASCADE, SET NULL, RESTRICT including soft-deleted child) refuses before mutation and keeps parent intact
    for (const deleteAction of ['CASCADE', 'SET NULL', 'RESTRICT'] as const) {
      await f.owner.query(
        `CREATE TABLE "${f.schemaName}".delete_child (
           id uuid PRIMARY KEY,
           parent_id uuid REFERENCES "${f.schemaName}".company(id) ON DELETE ${deleteAction},
           "deletedAt" timestamptz
         )`,
      );
      await f.owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${f.schemaName}".delete_child TO "${f.roleName}"`,
      );
      await f.owner.query(
        `INSERT INTO "${f.schemaName}".delete_child (id, parent_id, "deletedAt") VALUES ($1, $2, now())`,
        [randomUUID(), secondId],
      );
      await expect(
        hFail.destroyOne.execute(
          { id: secondId, selectedFields: { id: true } },
          hFail.queryContext('company'),
        ),
      ).rejects.toThrow('excludes referenced');
      await expectPostRollbackAttempts([
        {
          outcome: 'failed',
          reasonCode: 'crm.mutation.audit_coverage_rejected',
        },
      ]);
      expect(
        ((await f.read('company')) as Array<{ id: string }>).some(
          (row) => row.id === secondId,
        ),
      ).toBe(true);
      await f.owner.query(`DROP TABLE "${f.schemaName}".delete_child`);
    }

    // 4. BEFORE DELETE trigger skip: destroyOne -> RECORD_NOT_FOUND (0 audit); destroyMany on 2 rows with 1 skipped -> audits only 1
    const thirdId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'private third')`,
      [thirdId],
    );
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".keep_destroyed() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.id = '${secondId}' THEN RETURN NULL; END IF;
         RETURN OLD;
       END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER keep_destroyed BEFORE DELETE ON "${f.schemaName}".company
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".keep_destroyed()`,
    );
    f.recordStock.releaseRecordStock.mockClear();
    f.eventEmitter.mockClear();
    await expect(
      hFail.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    expect(f.eventEmitter).not.toHaveBeenCalled();

    const { results: partialDestroyed } = await hFail.destroyMany.execute(
      {
        filter: { id: { in: [secondId, thirdId] } },
        selectedFields: { id: true },
      },
      hFail.queryContext('company'),
    );
    expect(partialDestroyed.map((row) => row.id)).toEqual([thirdId]);
    expect((await audit()).map((entry) => entry.resourceId)).toEqual([thirdId]);
  });

  it('enforces RLS predicates, relation-traversal filters, nested relation tx reads + visibility restrictions, and inherited native audit scope poisoning', async () => {
    const companyNameField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === base.objectIdByNameSingular.company &&
        field.name === 'name',
    )!;

    // 1. Relation-traversal filter (hasRelationTraversal === true) on person by company.name
    const hRel = harness('user');
    const { results: relDestroyed } = await hRel.destroyMany.execute(
      {
        filter: { company: { name: { eq: 'private first' } } },
        selectedFields: { id: true },
      },
      hRel.queryContext('person'),
    );
    expect(relDestroyed.map((row) => row.id)).toEqual([id]);
    expect((await audit()).map((entry) => entry.resourceId)).toEqual([id]);

    // 2. RLS predicates: destroyOne on hidden row -> RECORD_NOT_FOUND (0 audit); destroyMany on 2 rows -> deletes only allowed 1
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const rlsPredicateId = randomUUID();
    const rlsPredicate = {
      id: rlsPredicateId,
      universalIdentifier: rlsPredicateId,
      fieldMetadataId: companyNameField.id,
      operand: RowLevelPermissionPredicateOperand.CONTAINS,
      value: 'private first',
      subFieldName: null,
      workspaceMemberFieldMetadataId: null,
      workspaceMemberSubFieldName: null,
      workspaceId: f.workspaceId,
      roleId,
      objectMetadataId: base.objectIdByNameSingular.company,
      rowLevelPermissionPredicateGroupId: null,
      positionInRowLevelPermissionPredicateGroup: null,
      deletedAt: null,
      applicationId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const hRls = harness('user', true, f.workspaceId, {
      company: [rlsPredicate as never],
    });
    await expect(
      hRls.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hRls.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);

    const { results: rlsDestroyed } = await hRls.destroyMany.execute(
      {
        filter: { id: { in: [id, secondId] } },
        selectedFields: { id: true },
      },
      hRls.queryContext('company'),
    );
    expect(rlsDestroyed.map((row) => row.id)).toEqual([id]);
    expect((await audit()).map((entry) => entry.resourceId)).toEqual([id]);

    // 3. Nested relation read inside outer withNativeCrmAuditTransaction + real CommonRecordVisibilityService masking + deferred hooks
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hNested = harness('user');
    const observedBeforeMask: unknown[] = [];
    hNested.visibility.registerHandler({
      objectNameSingular: 'company',
      handler: {
        applyVisibilityRestrictions: async ({ records }) => {
          for (const record of records) {
            observedBeforeMask.push(record.name);
            record.name = '[masked]';
          }
        },
      },
    });
    await hNested.run(() =>
      hNested.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', bypass)
            .update(secondId, { name: 'uncommitted parent' });
          const res = await hNested.destroyOne.execute(
            {
              id: secondId,
              selectedFields: { id: true, company: { id: true, name: true } },
            },
            hNested.queryContext('person', scope),
          );
          expect(observedBeforeMask).toEqual(['uncommitted parent']);
          expect(res.results.company).toEqual({
            id: secondId,
            name: '[masked]',
          });
          // Hooks deferred until outer commit; audit not yet flushed
          expect(hNested.hooks.executePostQueryHooks).not.toHaveBeenCalled();
          expect(await audit()).toHaveLength(0);
        },
        { nativeAudit: { operationId: randomUUID() } },
      ),
    );
    expect(hNested.hooks.executePostQueryHooks).toHaveBeenCalledTimes(1);
    expect(hNested.managerPort.getRepository).not.toHaveBeenCalled();
    const nestedEntries = await audit();
    expect(nestedEntries).toHaveLength(2);
    expect(new Set(nestedEntries.map((entry) => entry.operationId)).size).toBe(
      1,
    );

    // 4. Inherited scope fail-closed: plain external scope, standaloneShareWithScope, shallow copy, expired scope, wrong actor/workspaceId + RECORD_NOT_FOUND poisoning, uncovered object task
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hScope = harness('user');
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          (scope) =>
            hScope.destroyOne.execute(
              { id: secondId, selectedFields: { id: true } },
              hScope.queryContext('company', scope),
            ),
          { commitOutcome: 'strict' },
        ),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          (scope) =>
            runInStandaloneShareWithScope(scope, () =>
              hScope.destroyOne.execute(
                { id: secondId, selectedFields: { id: true } },
                hScope.queryContext('company', scope),
              ),
            ),
          { commitOutcome: 'strict' },
        ),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    let capturedScope: WorkspaceTransactionScope | undefined;
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            capturedScope = scope;
            await hScope.destroyOne.execute(
              { id: secondId, selectedFields: { id: true } },
              hScope.queryContext('company', { ...scope }),
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    await expect(
      hScope.destroyOne.execute(
        { id: secondId, selectedFields: { id: true } },
        hScope.queryContext('company', capturedScope),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    // Wrong actor caught by caller still poisons outer transaction
    const hOtherActor = harness('apiKey');
    const companyBefore = await f.read('company');
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(secondId, { name: 'must rollback' });
            try {
              await hOtherActor.destroyOne.execute(
                { id: secondId, selectedFields: { id: true } },
                hOtherActor.queryContext('company', scope),
              );
            } catch {
              // Caller tries to swallow actor mismatch
            }
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('different workspace or actor');
    expect(await f.read('company')).toEqual(companyBefore);
    expect(await audit()).toHaveLength(0);

    // Wrong workspaceId caught by caller still poisons outer transaction
    const hOtherWorkspace = harness('user', true, randomUUID());
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(secondId, { name: 'must rollback ws' });
            try {
              await hOtherWorkspace.destroyOne.execute(
                { id: secondId, selectedFields: { id: true } },
                hOtherWorkspace.queryContext('company', scope),
              );
            } catch {
              // Caller tries to swallow workspace mismatch
            }
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit workspace mismatch');
    expect(await f.read('company')).toEqual(companyBefore);
    expect(await audit()).toHaveLength(0);

    // RECORD_NOT_FOUND inside proven outer scope caught by caller still poisons and rolls back outer transaction
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(secondId, { name: 'must rollback missing' });
            try {
              await hScope.destroyOne.execute(
                { id: randomUUID(), selectedFields: { id: true } },
                hScope.queryContext('company', scope),
              );
            } catch (error) {
              expect(error).toBeInstanceOf(CommonQueryRunnerException);
              expect((error as CommonQueryRunnerException).code).toBe(
                CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
              );
            }
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toBeInstanceOf(CommonQueryRunnerException);
    expect(await f.read('company')).toEqual(companyBefore);
    expect(await audit()).toHaveLength(0);

    // Uncovered object (task): works outside native scope with 0 audit, fails closed and poisons inside proven outer scope
    const hTask = harness('user');
    await hTask.destroyOne.execute(
      { id, selectedFields: { id: true } },
      hTask.queryContext('task'),
    );
    expect(await audit()).toHaveLength(0);
    await expect(
      hTask.run(() =>
        hTask.dataSource.transaction(
          async (scope) => {
            try {
              await hTask.destroyOne.execute(
                { id: secondId, selectedFields: { id: true } },
                hTask.queryContext('task', scope),
              );
            } catch {
              // Poison must still fail transaction
            }
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');
  });

  it('preserves permission denial, rolls back on real audit INSERT failure, and propagates NativeTransactionOutcomeUnknownError without retry (including through DeleteRecordService)', async () => {
    // 1. Permission denial (canDestroyObjectRecords: false)
    const before = await f.read('company');
    const hDenied = harness('apiKey', false);
    await expect(
      hDenied.destroyOne.execute(
        { id, selectedFields: { id: true } },
        hDenied.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.PERMISSION_DENIED,
    });
    await expect(
      hDenied.destroyOne.execute(
        { id, selectedFields: { id: true } },
        hDenied.queryContext('company'),
      ),
    ).rejects.toBeInstanceOf(PermissionsException);
    expect(await f.read('company')).toEqual(before);
    await expectPostRollbackAttempts([
      { outcome: 'denied', reasonCode: 'crm.mutation.permission_denied' },
      { outcome: 'denied', reasonCode: 'crm.mutation.permission_denied' },
    ]);
    expect(hDenied.hooks.executePostQueryHooks).not.toHaveBeenCalled();

    // 2. Real audit INSERT failure rolls back physical deletion, events, stock release, and post-query hooks
    const hFail = harness('user');
    await f.owner.query(
      `CREATE FUNCTION crm_audit.fail_public_destroy_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'DESTROY_AUDIT_FAILURE'; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER fail_public_destroy_audit BEFORE INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_public_destroy_audit()`,
    );
    f.recordStock.releaseRecordStock.mockClear();
    f.eventEmitter.mockClear();
    let cause: unknown = await hFail.destroyOne
      .execute(
        { id, selectedFields: { id: true } },
        hFail.queryContext('company'),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(cause).toBeInstanceOf(Error);
    const messages: string[] = [];
    const seen = new Set<Error>();
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause);
      messages.push(cause.message);
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    expect(messages).toContain('DESTROY_AUDIT_FAILURE');
    await f.owner.query(
      `DROP TRIGGER IF EXISTS fail_public_destroy_audit ON crm_audit."crmAuditEntry";
       DROP FUNCTION IF EXISTS crm_audit.fail_public_destroy_audit();`,
    );
    expect(await f.read('company')).toEqual(before);
    expect(await audit()).toHaveLength(0);
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
    expect(hFail.hooks.executePostQueryHooks).not.toHaveBeenCalled();

    // 3. DeleteRecordService(soft: false) happy path + lost COMMIT ACK throws NativeTransactionOutcomeUnknownError without retry
    const hHappy = harness('user');
    const happyDeleteRecordService = new DeleteRecordService(
      {} as never,
      hHappy.destroyOne,
      {
        build: jest.fn(async () => ({
          queryRunnerContext: hHappy.queryContext('opportunity'),
          selectedFields: { id: true, name: true },
          flatObjectMetadata:
            hHappy.queryContext('opportunity').flatObjectMetadata,
        })),
      } as never,
    );
    const happyOutput = await happyDeleteRecordService.execute({
      objectName: 'opportunity',
      objectRecordId: secondId,
      authContext: hHappy.auth,
      soft: false,
    });
    expect(happyOutput).toMatchObject({
      success: true,
      result: { id: secondId, name: 'private second' },
    });
    expect(await audit()).toEqual([
      expect.objectContaining({
        action: 'delete',
        resourceId: secondId,
      }),
    ]);

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    f.eventEmitter.mockClear();
    const hLost = harness('user');
    const client = await f.pool.connect();
    const rawQuery = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      statements.push(text);
      const result = await rawQuery(statement as string, values);
      if (text === 'COMMIT') throw new Error('lost destroy commit ack');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));

    const deleteRecordService = new DeleteRecordService(
      {} as never,
      hLost.destroyOne,
      {
        build: jest.fn(async () => ({
          queryRunnerContext: hLost.queryContext('opportunity'),
          selectedFields: { id: true },
          flatObjectMetadata:
            hLost.queryContext('opportunity').flatObjectMetadata,
        })),
      } as never,
    );

    await expect(
      deleteRecordService.execute({
        objectName: 'opportunity',
        objectRecordId: id,
        authContext: hLost.auth,
        soft: false,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
    expect(statements).not.toContain('ROLLBACK');
    const remainingOpps = (await f.read('opportunity')) as ObjectRecord[];
    expect(remainingOpps.some((row) => row.id === id)).toBe(false);
    expect(await audit()).toEqual([
      expect.objectContaining({
        action: 'delete',
        resourceId: id,
      }),
    ]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(hLost.hooks.executePostQueryHooks).not.toHaveBeenCalled();
  });
});
