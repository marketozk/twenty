import { randomUUID } from 'node:crypto';
import { MUTATION_MAX_MERGE_RECORDS } from 'twenty-shared/constants';
import {
  FieldMetadataType,
  RowLevelPermissionPredicateOperand,
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonMergeManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-merge-many-query-runner.service';
import {
  CommonQueryRunnerException,
  CommonQueryRunnerExceptionCode,
} from 'src/engine/api/common/common-query-runners/errors/common-query-runner.exception';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { runInStandaloneShareWithScope } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
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
jest.mock(
  'src/engine/core-modules/metrics/metrics.service',
  () => ({ MetricsService: class {} }),
);
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

const FIXTURE_ACTIVE_OBJECTS = new Set([
  'company',
  'person',
  'opportunity',
  'customCase',
  'task',
  'taskTarget',
  'recordShare',
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
]);

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

    // Keep only fixture-provisioned objects active so relation traversal skips uncreated tables (also tests m1).
    for (const object of Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (!object) continue;
      if (!FIXTURE_ACTIVE_OBJECTS.has(object.nameSingular)) {
        object.isActive = false;
      }
      if (
        ['company', 'person', 'customCase', 'task'].includes(
          object.nameSingular,
        )
      ) {
        object.duplicateCriteria = [['name']];
      }
    }

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
        settings: { maxNumberOfValues: 5 },
        isUnique: false,
      };
      maps.flatFieldMetadataMaps.byUniversalIdentifier[
        field.universalIdentifier
      ] = field;
      maps.flatFieldMetadataMaps.universalIdentifierById[field.id] =
        field.universalIdentifier;
      targetObject.fieldIds = [...targetObject.fieldIds, field.id];
      targetObject.fieldUniversalIdentifiers = [
        ...targetObject.fieldUniversalIdentifiers,
        field.universalIdentifier,
      ];
    }

    // Add a unique index on customCase(companyId, name) to exercise duplicate child soft-delete + migration.
    const customFields = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter((field) => field?.objectMetadataId === customCase.id);
    const customCompanyField = customFields.find(
      (field) => field?.name === 'company',
    )!;
    const customNameField = customFields.find(
      (field) => field?.name === 'name',
    )!;
    const indexId = randomUUID();
    const indexUniversalId = randomUUID();
    const customUniqueIndex = {
      id: indexId,
      universalIdentifier: indexUniversalId,
      name: 'IDX_CUSTOM_CASE_COMPANY_NAME_UNIQUE',
      objectMetadataId: customCase.id,
      objectMetadataUniversalIdentifier: customCase.universalIdentifier,
      workspaceId: customCase.workspaceId,
      applicationId: customCase.applicationId,
      applicationUniversalIdentifier: customCase.applicationUniversalIdentifier,
      isCustom: true,
      isUnique: true,
      indexType: 'BTREE',
      indexWhereClause: '"deletedAt" IS NULL',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      flatIndexFieldMetadatas: [
        {
          id: randomUUID(),
          indexMetadataId: indexId,
          fieldMetadataId: customCompanyField.id,
          fieldMetadataUniversalIdentifier:
            customCompanyField.universalIdentifier,
          order: 0,
          subFieldName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          indexMetadataId: indexId,
          fieldMetadataId: customNameField.id,
          fieldMetadataUniversalIdentifier: customNameField.universalIdentifier,
          order: 1,
          subFieldName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    maps.flatIndexMaps.byUniversalIdentifier[indexUniversalId] =
      customUniqueIndex as never;
    maps.flatIndexMaps.universalIdentifierById[indexId] = indexUniversalId;
    customCase.indexMetadataIds = [...customCase.indexMetadataIds, indexId];
    customCase.indexMetadataUniversalIdentifiers = [
      ...customCase.indexMetadataUniversalIdentifiers,
      indexUniversalId,
    ];
  },
});

const id1 = randomUUID();
const id2 = randomUUID();
const id3 = randomUUID();
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
  for (const constraint of constraints) {
    await f.owner.query(
      `ALTER TABLE "${f.schemaName}"."${table}" DROP CONSTRAINT "${constraint.conname.replaceAll('"', '""')}"`,
    );
  }
  await f.owner.query(
    `ALTER TABLE "${f.schemaName}"."${table}" ADD CONSTRAINT "direct_${column}" FOREIGN KEY ("${column}") REFERENCES "${f.schemaName}".company(id) ON DELETE ${action}`,
  );
};

type HarnessPermissionsOptions = {
  canRead?: boolean;
  canUpdate?: boolean;
  canSoftDelete?: boolean;
  canDestroy?: boolean;
  rlsPredicatesByObjectName?: Record<
    string,
    ObjectsPermissionsByRoleId[string][string]['rowLevelPermissionPredicates']
  >;
};

const harness = (
  kind: 'system' | 'user' | 'apiKey' | 'application' | 'agent' = 'system',
  options: HarnessPermissionsOptions = {},
  workspaceId = f.workspaceId,
) => {
  const {
    canRead = true,
    canUpdate = true,
    canSoftDelete = true,
    canDestroy = true,
    rlsPredicatesByObjectName = {},
  } = options;

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
          canReadObjectRecords: canRead,
          canUpdateObjectRecords: canUpdate,
          canSoftDeleteObjectRecords: canSoftDelete,
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
  const mergeMany = new CommonMergeManyQueryRunnerService();

  Object.assign(mergeMany, {
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
    mergeMany,
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
    `CREATE TABLE IF NOT EXISTS core.file(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,path varchar NOT NULL,size bigint NOT NULL,settings jsonb,status text NOT NULL DEFAULT 'UPLOADED',"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),"deletedAt" timestamptz,"applicationId" uuid,"applicationRegistrationId" uuid,"isStaticAsset" boolean DEFAULT false,"mimeType" varchar DEFAULT 'application/pdf',"contentSha256" varchar)`,
  );
  await f.owner.query(
    `GRANT USAGE ON SCHEMA core TO "${f.roleName}"; GRANT SELECT, UPDATE ON core.file TO "${f.roleName}"`,
  );
  base = await f.withContext(async () => getWorkspaceContext());
});

beforeEach(async () => {
  await f.owner.query('TRUNCATE core.file');
  await setDeleteAction('person', 'companyId', 'SET NULL');
  await setDeleteAction('_customCase', 'companyId', 'CASCADE');
  await f.owner.query(`DROP TABLE IF EXISTS "${f.schemaName}".delete_child`);
  await f.owner.query(
    `DROP TRIGGER IF EXISTS fail_public_merge_audit ON crm_audit."crmAuditEntry"`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS crm_audit.fail_public_merge_audit()`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS skip_merge_delete ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".skip_merge_delete()`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS skip_merge_child_update ON "${f.schemaName}".person`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".skip_merge_child_update()`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS skip_merge_child_soft_delete ON "${f.schemaName}"."_customCase"`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".skip_merge_child_soft_delete()`,
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
  for (const table of ['company', '_customCase']) {
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."${table}" (id, name) VALUES ($1, 'private first'), ($2, 'private second'), ($3, 'private third')`,
      [id1, id2, id3],
    );
  }
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person (id, "nameFirstName", "companyId") VALUES ($1, 'private p1', NULL), ($2, 'private p2', NULL), ($3, 'private p3', NULL)`,
    [id1, id2, id3],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 't1'), ($2, 't2')`,
    [id1, id2],
  );
  f.recordStock.releaseRecordStock.mockClear();
  f.eventEmitter.mockClear();
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

describe('Public CRM record merge audit (LOG-203)', () => {
  it('audits mergeMany across standard/custom objects, 3-record merges, uppercase UUIDs, empty mergedData, selectedFields without id, all 5 actor types, dryRun + getter dryRun guard, and validate()', async () => {
    // 1. 3-record merge on company with conflictPriorityIndex = 1, uppercase UUIDs, selectedFields without id, and user actor
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "addressAddressCity" = NULL WHERE id = $1`,
      [id2],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "addressAddressCity" = 'private city' WHERE id = $1`,
      [id3],
    );
    const hUser = harness('user');
    const { results: mergedCompany } = await hUser.mergeMany.execute(
      {
        ids: [id1.toUpperCase(), id2.toUpperCase(), id3.toUpperCase()],
        conflictPriorityIndex: 1,
        selectedFields: { name: true, address: { addressCity: true } },
      },
      hUser.queryContext('company'),
    );
    expect(mergedCompany.name).toBe('private second');
    expect((mergedCompany.address as { addressCity: string }).addressCity).toBe(
      'private city',
    );
    const remainingCompanies = (await f.read('company')) as Array<{
      id: string;
      addressAddressCity: string | null;
    }>;
    expect(remainingCompanies.map((row) => row.id)).toEqual([id2]);
    expect(remainingCompanies[0].addressAddressCity).toBe('private city');
    expect(f.recordStock.releaseRecordStock).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2 }),
    );
    const entries = await audit();
    // 2 deleted companies + 1 updated priority company = 3 under ONE operationId
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
    const deletedEntries = entries.filter((entry) => entry.action === 'delete');
    expect(deletedEntries.map((entry) => entry.resourceId).sort()).toEqual(
      [id1, id3].sort(),
    );
    for (const delEntry of deletedEntries) {
      expect(delEntry).toMatchObject({
        action: 'delete',
        resourceKind: 'crmRecord',
        actor: { kind: 'workspaceMember', id: actorId },
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: delEntry.resourceId,
          objectMetadataId: base.objectIdByNameSingular.company,
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        },
      });
    }
    const updatedEntry = entries.find((entry) => entry.action === 'update');
    expect(updatedEntry).toMatchObject({
      action: 'update',
      resourceKind: 'crmRecord',
      resourceId: id2,
      actor: { kind: 'workspaceMember', id: actorId },
    });
    expect(JSON.stringify(entries)).not.toContain('private');
    expect(hUser.managerPort.getRepository).not.toHaveBeenCalled();
    expect(hUser.hooks.executePostQueryHooks).toHaveBeenCalledTimes(1);

    // 2. Remaining 4 actor kinds (apiKey, application, agent, system -> crm-api-merge) + customCase + empty mergedData
    const actorCases: Array<{
      kind: 'apiKey' | 'application' | 'agent' | 'system';
      object: 'person' | 'customCase';
      expectedActor: { kind: string; id: string };
      clearFields: boolean;
    }> = [
      {
        kind: 'apiKey',
        object: 'person',
        expectedActor: { kind: 'apiKey', id: actorId },
        clearFields: false,
      },
      {
        kind: 'application',
        object: 'customCase',
        expectedActor: { kind: 'application', id: actorId },
        clearFields: true,
      },
      {
        kind: 'agent',
        object: 'person',
        expectedActor: { kind: 'agent', id: agentId },
        clearFields: false,
      },
      {
        kind: 'system',
        object: 'customCase',
        expectedActor: { kind: 'system', id: 'crm-api-merge' },
        clearFields: false,
      },
    ];

    for (const item of actorCases) {
      const a = randomUUID();
      const b = randomUUID();
      if (item.object === 'customCase') {
        await f.owner.query(
          `INSERT INTO "${f.schemaName}"."_customCase" (id, name) VALUES ($1, $3), ($2, $4)`,
          [
            a,
            b,
            item.clearFields ? null : 'private a',
            item.clearFields ? null : 'private b',
          ],
        );
      } else {
        await f.owner.query(
          `INSERT INTO "${f.schemaName}".person (id, "nameFirstName") VALUES ($1, 'private pa'), ($2, 'private pb')`,
          [a, b],
        );
      }
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      const h = harness(item.kind);
      const { results } = await h.mergeMany.execute(
        {
          ids: [a, b],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        h.queryContext(item.object),
      );
      expect(results.id).toBe(a);
      const actorEntries = await audit();
      expect(
        actorEntries.find(
          (entry) =>
            entry.action === 'delete' &&
            entry.resourceId === b &&
            entry.securityDescriptor.objectMetadataId ===
              base.objectIdByNameSingular[item.object],
        )?.actor,
      ).toEqual(item.expectedActor);
      expect(JSON.stringify(actorEntries)).not.toContain('private');
      expect(h.managerPort.getRepository).not.toHaveBeenCalled();
    }

    // 3. dryRun: true (with nested relations) leaves DB untouched and writes 0 audit rows; getter dryRun cannot bypass audit (B1)
    const d1: string = randomUUID();
    const d2: string = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'dry first'), ($2, 'dry second')`,
      [d1, d2],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hDry = harness('user');
    const { results: dryRes } = await hDry.mergeMany.execute(
      {
        ids: [d1, d2],
        conflictPriorityIndex: 0,
        dryRun: true,
        selectedFields: { id: true, name: true, people: { id: true } },
      },
      hDry.queryContext('company'),
    );
    expect(dryRes.name).toBe('dry first');
    expect(dryRes.id).not.toBe(d1);
    expect(await audit()).toHaveLength(0);
    // Root dryRun opens only the root repository once; nested relations reuse context.repository.
    expect(hDry.managerPort.getRepository).toHaveBeenCalledTimes(1);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).filter((row) =>
        [d1, d2].includes(row.id),
      ),
    ).toHaveLength(2);

    // B1: getter dryRun returned by preQueryHooks flipping true -> false between executeQueryAndEnrichResults and run() stays dryRun: true
    let hookDryReads = 0;
    const hTricky = harness('user');
    hTricky.hooks.executePreQueryHooks.mockImplementationOnce(
      async (_auth, _name, _op, rawArgs) => {
        const hooked = { ...(rawArgs as Record<string, unknown>) };
        Object.defineProperty(hooked, 'dryRun', {
          enumerable: true,
          get() {
            hookDryReads += 1;
            return hookDryReads <= 1;
          },
        });
        return hooked;
      },
    );
    await hTricky.mergeMany.execute(
      {
        ids: [d1, d2],
        conflictPriorityIndex: 0,
        selectedFields: { id: true, name: true },
      },
      hTricky.queryContext('company'),
    );
    expect(await audit()).toHaveLength(0);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).filter((row) =>
        [d1, d2].includes(row.id),
      ),
    ).toHaveLength(2);

    // B1 defense-in-depth (Major 4): direct run() without transactionScope or with unproven plainScope fails closed on covered object
    const hDirect = harness('user');
    await hDirect.run(async () => {
      const baseCtx = hDirect.queryContext('company');
      const directArgs = {
        ids: [d1, d2],
        conflictPriorityIndex: 0,
        selectedFieldsResult: { select: { id: true }, relations: {}, aggregate: {} },
      };
      await expect(
        hDirect.mergeMany.run(directArgs as never, {
          ...baseCtx,
          rolePermissionConfig: { intersectionOf: { userWorkspaceRoleId: roleId } },
          repository: hDirect.dataSource.getRepository('company', bypass),
          featureFlagsMap: base.featureFlagsMap,
          commonQueryParser: {} as never,
        }),
      ).rejects.toThrow('Public CRM merge requires a proven native audit scope');
      await expect(
        hDirect.dataSource.transaction(
          (plainScope) =>
            hDirect.mergeMany.run(directArgs as never, {
              ...baseCtx,
              transactionScope: plainScope,
              rolePermissionConfig: { intersectionOf: { userWorkspaceRoleId: roleId } },
              repository: plainScope.getRepository('company', bypass),
              featureFlagsMap: base.featureFlagsMap,
              commonQueryParser: {} as never,
            }),
          { commitOutcome: 'strict' },
        ),
      ).rejects.toThrow('Public CRM merge requires a proven native audit scope');
    });

    // 4. validate() rejections (remote, no duplicateCriteria, non-array/non-string/invalid/duplicate/too-many ids, non-integer/negative/string/out-of-range priority, non-boolean dryRun) + missing/soft-deleted RECORD_NOT_FOUND
    const hVal = harness('user');
    await expect(
      hVal.mergeMany.execute(
        { ids: [d1, d2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hVal.queryContext('company', undefined, { isRemote: true }),
      ),
    ).rejects.toThrow('Remote objects are read-only');
    await expect(
      hVal.mergeMany.execute(
        { ids: [d1, d2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hVal.queryContext('company', undefined, { duplicateCriteria: null }),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
    });
    const tooManyIds = Array.from(
      { length: MUTATION_MAX_MERGE_RECORDS + 1 },
      () => randomUUID(),
    );
    for (const badArgs of [
      { ids: 'abcdef' as never, conflictPriorityIndex: 0 },
      { ids: [null, 123] as never, conflictPriorityIndex: 0 },
      { ids: [d1], conflictPriorityIndex: 0 },
      { ids: tooManyIds, conflictPriorityIndex: 0 },
      { ids: [d1, 'not-a-uuid'], conflictPriorityIndex: 0 },
      { ids: [d1, d1.toUpperCase()], conflictPriorityIndex: 0 },
      { ids: [d1, d2], conflictPriorityIndex: -1 },
      { ids: [d1, d2], conflictPriorityIndex: '0' as never },
      { ids: [d1, d2], conflictPriorityIndex: 0.5 },
      { ids: [d1, d2], conflictPriorityIndex: 2 },
      { ids: [d1, d2], conflictPriorityIndex: 0, dryRun: 'false' as never },
    ]) {
      await expect(
        hVal.mergeMany.execute(
          { ...badArgs, selectedFields: { id: true } },
          hVal.queryContext('company'),
        ),
      ).rejects.toMatchObject({
        code: CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
      });
    }
    await expect(
      hVal.mergeMany.execute(
        {
          ids: [d1, randomUUID()],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        hVal.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "deletedAt" = now() WHERE id = $1`,
      [d2],
    );
    await expect(
      hVal.mergeMany.execute(
        { ids: [d1, d2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hVal.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
  });

  it('audits child migration, unique-index child soft-delete, soft-deleted FK SET NULL, and transactional nested reads under one operationId; enforces select-RLS hidden child refusal, uncovered/FILES/omni fail-closed, and trigger skips', async () => {
    await setDeleteAction('person', 'companyId', 'SET NULL');
    await setDeleteAction('_customCase', 'companyId', 'CASCADE');

    // Setup children for company merge: id1 (priority), id2 (duplicate)
    // - live person id2 pointing to id2 -> migrated to id1
    // - soft-deleted person softPersonId pointing to id2 -> SET NULL via prepareNativeCrmDeleteEffects
    // - customCase: priority has 'shared-code', duplicate has 'shared-code' (soft_delete) + 'unique-code' (migrate)
    const softPersonId = randomUUID();
    const dupCaseId = randomUUID();
    const migrateCaseId = randomUUID();
    await f.owner.query(
      `UPDATE "${f.schemaName}".person SET "companyId" = $1 WHERE id = $2`,
      [id2, id2],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "nameFirstName", "companyId", "deletedAt") VALUES ($1, 'private soft', $2, now())`,
      [softPersonId, id2],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET "companyId" = $1, name = 'shared-code' WHERE id = $1`,
      [id1],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, "companyId", name) VALUES ($1, $2, 'shared-code'), ($3, $2, 'unique-code')`,
      [dupCaseId, id2, migrateCaseId],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "addressAddressCity" = 'private merged city' WHERE id = $1`,
      [id2],
    );

    const h = harness('user');
    const { results: merged } = await h.mergeMany.execute(
      {
        ids: [id1, id2],
        conflictPriorityIndex: 0,
        selectedFields: {
          id: true,
          name: true,
          address: { addressCity: true },
          people: { id: true },
        },
      },
      h.queryContext('company'),
    );
    expect(merged.id).toBe(id1);
    expect((merged.address as { addressCity: string }).addressCity).toBe(
      'private merged city',
    );
    expect((merged.people as Array<{ id: string }>).map((p) => p.id)).toEqual([
      id2,
    ]);
    expect(h.managerPort.getRepository).not.toHaveBeenCalled();

    // Verify DB state
    const peopleAfter = (await f.read('person')) as Array<{
      id: string;
      companyId: string | null;
    }>;
    expect(peopleAfter.find((p) => p.id === id2)?.companyId).toBe(id1);
    expect(peopleAfter.find((p) => p.id === softPersonId)?.companyId).toBeNull();
    const casesAfter = (await f.read('_customCase')) as Array<{
      id: string;
      companyId: string | null;
      deletedAt: string | null;
    }>;
    // dupCaseId was soft-deleted during deduplication and then physically CASCADE-deleted when company(id2) was deleted.
    expect(casesAfter.some((c) => c.id === dupCaseId)).toBe(false);
    expect(casesAfter.find((c) => c.id === migrateCaseId)?.companyId).toBe(id1);

    // Verify all 7 audit entries share ONE operationId with exact objectMetadataId + action matching
    const entries = await audit();
    expect(entries).toHaveLength(7);
    expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === id2 &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.person,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === softPersonId &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.person,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === dupCaseId &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.customCase,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === dupCaseId &&
          entry.action === 'delete' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.customCase,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === migrateCaseId &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.customCase,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === id2 &&
          entry.action === 'delete' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.company,
      ),
    ).toBeDefined();
    expect(
      entries.find(
        (entry) =>
          entry.resourceId === id1 &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.company,
      ),
    ).toBeDefined();

    // 2. B2: select-RLS hiding a live child (customCase with ON DELETE CASCADE) must fail closed and preserve parent + hidden child
    const cA = randomUUID();
    const cB = randomUUID();
    const hiddenCaseId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'cA'), ($2, 'cB')`,
      [cA, cB],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, "companyId", name) VALUES ($1, $2, 'hidden-secret-case')`,
      [hiddenCaseId, cB],
    );
    const customNameField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === base.objectIdByNameSingular.customCase &&
        field.name === 'name',
    )!;
    const predId = randomUUID();
    const hSelectRls = harness('user', {
      rlsPredicatesByObjectName: {
        customCase: [
          {
            id: predId,
            universalIdentifier: predId,
            fieldMetadataId: customNameField.id,
            operand: RowLevelPermissionPredicateOperand.CONTAINS,
            value: 'visible-only',
            subFieldName: null,
            workspaceMemberFieldMetadataId: null,
            workspaceMemberSubFieldName: null,
            workspaceId: f.workspaceId,
            roleId,
            objectMetadataId: base.objectIdByNameSingular.customCase,
            rowLevelPermissionPredicateGroupId: null,
            positionInRowLevelPermissionPredicateGroup: null,
            deletedAt: null,
            applicationId: randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as never,
        ],
      },
    });
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await expect(
      hSelectRls.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hSelectRls.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
      message: 'Cannot merge records with inaccessible related records',
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    expect(
      ((await f.read('_customCase')) as Array<{ id: string }>).some(
        (row) => row.id === hiddenCaseId,
      ),
    ).toBe(true);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === cB,
      ),
    ).toBe(true);
    await f.owner.query(
      `DELETE FROM "${f.schemaName}"."_customCase" WHERE id = $1`,
      [hiddenCaseId],
    );

    // 2b. B2 priority branch: select-RLS hiding a live child of priorityRecord (with unique index) also fails closed
    const hiddenPriorityCaseId = randomUUID();
    const visibleDupCaseId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, "companyId", name) VALUES ($1, $2, 'hidden-prio'), ($3, $4, 'visible-only-dup')`,
      [hiddenPriorityCaseId, cA, visibleDupCaseId, cB],
    );
    await expect(
      hSelectRls.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hSelectRls.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
      message: 'Cannot merge records with inaccessible related records',
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    await f.owner.query(
      `DELETE FROM "${f.schemaName}"."_customCase" WHERE id IN ($1, $2)`,
      [hiddenPriorityCaseId, visibleDupCaseId],
    );

    // 3. Uncovered live child (taskTarget) fails closed and rolls back everything
    const hFail = harness('user');
    const ttId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [ttId, id1, cB],
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.audit_coverage_rejected' },
    ]);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === cB,
      ),
    ).toBe(true);
    await f.owner.query(
      `DELETE FROM "${f.schemaName}"."taskTarget" WHERE id = $1`,
      [ttId],
    );

    // 4. Uncovered soft-deleted FK child table refuses before DELETE
    await f.owner.query(
      `CREATE TABLE "${f.schemaName}".delete_child (
         id uuid PRIMARY KEY,
         parent_id uuid REFERENCES "${f.schemaName}".company(id) ON DELETE CASCADE,
         "deletedAt" timestamptz
       )`,
    );
    await f.owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "${f.schemaName}".delete_child TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".delete_child (id, parent_id, "deletedAt") VALUES ($1, $2, now())`,
      [randomUUID(), cB],
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toThrow('excludes referenced');
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.audit_coverage_rejected' },
    ]);
    await f.owner.query(`DROP TABLE "${f.schemaName}".delete_child`);

    // 5. Non-empty FILES on duplicate when priority has no FILES refuses deterministically before DELETE; non-empty FILES on priorityRecord alone succeeds
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [cB, JSON.stringify([{ fileId: randomUUID(), label: 'dup.pdf' }])],
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Merging files from duplicate records onto a priority record without files is not supported',
    );
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.audit_coverage_rejected' },
    ]);
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = NULL WHERE id = $1`,
      [cB],
    );

    const fPrio = randomUUID();
    const fDup = randomUUID();
    const fileId = randomUUID();
    const docsField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === base.objectIdByNameSingular.company &&
        field.name === 'documents',
    )!;
    await f.owner.query(
      'INSERT INTO core.file (id, "workspaceId", path, size, settings) VALUES ($1, $2, $3, 12, $4)',
      [
        fileId,
        f.workspaceId,
        `secret/${docsField.universalIdentifier}/${fileId}.pdf`,
        JSON.stringify({ isTemporaryFile: false, toDelete: false }),
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents) VALUES ($1, 'file-prio', $3::jsonb), ($2, 'file-dup', NULL)`,
      [fPrio, fDup, JSON.stringify([{ fileId, label: 'prio.pdf' }])],
    );
    const { results: fileMerged } = await hFail.mergeMany.execute(
      {
        ids: [fPrio, fDup],
        conflictPriorityIndex: 0,
        selectedFields: { id: true, documents: true },
      },
      hFail.queryContext('company'),
    );
    expect(fileMerged.id).toBe(fPrio);
    expect(fileMerged.documents).toEqual([{ fileId, label: 'prio.pdf' }]);
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    // 6. Omni-protected duplicate person refuses before DELETE
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
       VALUES ($1, $2, 'telegram', 'inst-m', 'acc-m', $3, $4, '1', '{}'::jsonb)`,
      [bindingId, f.workspaceId, connectedAccountId, messageChannelId],
    );
    await f.owner.query(
      `INSERT INTO core."omniExternalIdentity" (id, "workspaceId", "bindingId", "providerPeerId", "personId", "verificationSource")
       VALUES ($1, $2, $3, 'peer-m', $4, 'provider')`,
      [randomUUID(), f.workspaceId, bindingId, id3],
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [id1, id3], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('person'),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    await expectPostRollbackAttempts([
      {
        outcome: 'denied',
        reasonCode: 'crm.mutation.domain_command_required',
      },
    ]);
    await f.owner.query(
      'DELETE FROM core."omniExternalIdentity" WHERE "workspaceId" = $1',
      [f.workspaceId],
    );
    await f.owner.query(
      'DELETE FROM core."omniAccountBinding" WHERE "workspaceId" = $1',
      [f.workspaceId],
    );

    // 7. Trigger skips: BEFORE DELETE on duplicate company, BEFORE UPDATE on migrating person, BEFORE UPDATE on soft-deleting customCase
    const migPersonId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "nameFirstName", "companyId") VALUES ($1, 'mig', $2)`,
      [migPersonId, cB],
    );
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".skip_merge_delete() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF OLD.id = '${cB}' THEN RETURN NULL; END IF; RETURN OLD; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER skip_merge_delete BEFORE DELETE ON "${f.schemaName}".company
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".skip_merge_delete()`,
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    // Child migration must have been rolled back!
    expect(
      (
        (await f.read('person')) as Array<{ id: string; companyId: string | null }>
      ).find((p) => p.id === migPersonId)?.companyId,
    ).toBe(cB);
    await f.owner.query(
      `DROP TRIGGER skip_merge_delete ON "${f.schemaName}".company`,
    );

    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".skip_merge_child_update() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF OLD.id = '${migPersonId}' THEN RETURN NULL; END IF; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER skip_merge_child_update BEFORE UPDATE ON "${f.schemaName}".person
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".skip_merge_child_update()`,
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === cB,
      ),
    ).toBe(true);
    await f.owner.query(
      `DROP TRIGGER skip_merge_child_update ON "${f.schemaName}".person`,
    );

    // BEFORE UPDATE trigger skip on soft-deleting colliding customCase
    const prioCaseId = randomUUID();
    const skipCaseId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, "companyId", name) VALUES ($1, $2, 'collide'), ($3, $4, 'collide')`,
      [prioCaseId, cA, skipCaseId, cB],
    );
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".skip_merge_child_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF OLD.id = '${skipCaseId}' THEN RETURN NULL; END IF; RETURN NEW; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER skip_merge_child_soft_delete BEFORE UPDATE ON "${f.schemaName}"."_customCase"
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".skip_merge_child_soft_delete()`,
    );
    await expect(
      hFail.mergeMany.execute(
        { ids: [cA, cB], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hFail.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === cB,
      ),
    ).toBe(true);
  });

  it('enforces permissions, outer transaction aggregation + real CommonRecordVisibilityService masking, and inherited scope poisoning', async () => {
    // 1. Permission denials: canRead: false, canDestroy: false, and canUpdate: false all fail BEFORE acquiring FOR UPDATE or committing child migrations
    await f.owner.query(
      `UPDATE "${f.schemaName}".person SET "companyId" = $1 WHERE id = $2`,
      [id2, id2],
    );
    const companiesBefore = await f.read('company');

    const hNoRead = harness('apiKey', { canRead: false });
    await expect(
      hNoRead.mergeMany.execute(
        { ids: [id1, id2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hNoRead.queryContext('company'),
      ),
    ).rejects.toBeInstanceOf(PermissionsException);
    await expectPostRollbackAttempts([
      { outcome: 'denied', reasonCode: 'crm.mutation.permission_denied' },
    ]);

    const hNoDestroy = harness('apiKey', { canDestroy: false, canUpdate: true });
    await expect(
      hNoDestroy.mergeMany.execute(
        { ids: [id1, id2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hNoDestroy.queryContext('company'),
      ),
    ).rejects.toBeInstanceOf(PermissionsException);
    await expectPostRollbackAttempts([
      { outcome: 'denied', reasonCode: 'crm.mutation.permission_denied' },
    ]);
    expect(await f.read('company')).toEqual(companiesBefore);
    expect(
      (
        (await f.read('person')) as Array<{ id: string; companyId: string | null }>
      ).find((p) => p.id === id2)?.companyId,
    ).toBe(id2);

    const hNoUpdate = harness('apiKey', { canDestroy: true, canUpdate: false });
    await expect(
      hNoUpdate.mergeMany.execute(
        { ids: [id1, id2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hNoUpdate.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.PERMISSION_DENIED,
    });
    await expectPostRollbackAttempts([
      { outcome: 'denied', reasonCode: 'crm.mutation.permission_denied' },
    ]);
    expect(await f.read('company')).toEqual(companiesBefore);

    // Parent select-RLS hiding one of the merged companies fails with RECORD_NOT_FOUND before FOR UPDATE
    const companyNameField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === base.objectIdByNameSingular.company &&
        field.name === 'name',
    )!;
    const parentPredId = randomUUID();
    const hParentRls = harness('user', {
      rlsPredicatesByObjectName: {
        company: [
          {
            id: parentPredId,
            universalIdentifier: parentPredId,
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
          } as never,
        ],
      },
    });
    await expect(
      hParentRls.mergeMany.execute(
        { ids: [id1, id2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        hParentRls.queryContext('company'),
      ),
    ).rejects.toMatchObject({
      code: CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
    });
    await expectPostRollbackAttempts([
      { outcome: 'failed', reasonCode: 'crm.mutation.record_not_found' },
    ]);

    // 2. Outer proven withNativeCrmAuditTransaction: sees uncommitted outer update, aggregates priorityCompany updates into 1 entry, runs real visibility handler on nested people, defers post-query hooks
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "addressAddressCity" = 'private outer city' WHERE id = $1`,
      [id2],
    );
    const hOuter = harness('user');
    const observedNames: unknown[] = [];
    hOuter.visibility.registerHandler({
      objectNameSingular: 'person',
      handler: {
        applyVisibilityRestrictions: async ({ records }) => {
          for (const record of records) {
            const nameField = record.name as
              | { firstName?: string | null }
              | undefined;
            observedNames.push(nameField?.firstName);
            record.name = { ...nameField, firstName: '[masked-person]' };
          }
        },
      },
    });
    await hOuter.run(() =>
      hOuter.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', bypass)
            .update(id1, { name: 'uncommitted outer' });
          const res = await hOuter.mergeMany.execute(
            {
              ids: [id1, id2],
              conflictPriorityIndex: 0,
              selectedFields: {
                id: true,
                name: true,
                address: { addressCity: true },
                people: { id: true, name: { firstName: true } },
              },
            },
            hOuter.queryContext('company', scope),
          );
          expect(res.results.name).toBe('uncommitted outer');
          expect(
            (res.results.address as { addressCity: string }).addressCity,
          ).toBe('private outer city');
          expect(observedNames).toEqual(['private p2']);
          expect(res.results.people).toEqual([
            expect.objectContaining({
              id: id2,
              name: expect.objectContaining({ firstName: '[masked-person]' }),
            }),
          ]);
          expect(hOuter.hooks.executePostQueryHooks).not.toHaveBeenCalled();
          expect(await audit()).toHaveLength(0);
        },
        { nativeAudit: { operationId: randomUUID() } },
      ),
    );
    expect(hOuter.hooks.executePostQueryHooks).toHaveBeenCalledTimes(1);
    expect(hOuter.managerPort.getRepository).not.toHaveBeenCalled();
    const outerEntries = await audit();
    // Aggregated: 1 company(id1):update (combining outer name + merge address) + 1 company(id2):delete + 1 person(id2):update = 3 under ONE operationId
    expect(outerEntries).toHaveLength(3);
    expect(new Set(outerEntries.map((entry) => entry.operationId)).size).toBe(
      1,
    );
    const companyAddressField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === base.objectIdByNameSingular.company &&
        field.name === 'address',
    )!;
    const aggregatedUpdate = outerEntries.find(
      (entry) =>
        entry.resourceId === id1 &&
        entry.action === 'update' &&
        entry.securityDescriptor.objectMetadataId ===
          base.objectIdByNameSingular.company,
    );
    expect(aggregatedUpdate).toBeDefined();
    expect(aggregatedUpdate?.redactedDiff.changedFields).toEqual(
      expect.arrayContaining([companyNameField.id, companyAddressField.id]),
    );
    expect(
      outerEntries.find(
        (entry) =>
          entry.resourceId === id2 &&
          entry.action === 'delete' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.company,
      ),
    ).toBeDefined();
    expect(
      outerEntries.find(
        (entry) =>
          entry.resourceId === id2 &&
          entry.action === 'update' &&
          entry.securityDescriptor.objectMetadataId ===
            base.objectIdByNameSingular.person,
      ),
    ).toBeDefined();

    // 3. Inherited scope fail-closed & poisoning + uncovered task (with duplicateCriteria) + dryRun inside outer scope
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hScope = harness('user');
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          (scope) =>
            hScope.mergeMany.execute(
              {
                ids: [id1, id3],
                conflictPriorityIndex: 0,
                selectedFields: { id: true },
              },
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
              hScope.mergeMany.execute(
                {
                  ids: [id1, id3],
                  conflictPriorityIndex: 0,
                  selectedFields: { id: true },
                },
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
            await hScope.mergeMany.execute(
              {
                ids: [id1, id3],
                conflictPriorityIndex: 0,
                selectedFields: { id: true },
              },
              hScope.queryContext('company', { ...scope }),
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    await expect(
      hScope.mergeMany.execute(
        {
          ids: [id1, id3],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        hScope.queryContext('company', capturedScope),
      ),
    ).rejects.toThrow('Public CRM mutation requires a proven native audit scope');

    const snapshotBeforePoison = await f.read('company');
    const hOtherActor = harness('apiKey');
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(id1, { name: 'must rollback actor' });
            try {
              await hOtherActor.mergeMany.execute(
                {
                  ids: [id1, id3],
                  conflictPriorityIndex: 0,
                  selectedFields: { id: true },
                },
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
    expect(await f.read('company')).toEqual(snapshotBeforePoison);
    expect(await audit()).toHaveLength(0);

    const hOtherWorkspace = harness('user', {}, randomUUID());
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(id1, { name: 'must rollback ws' });
            try {
              await hOtherWorkspace.mergeMany.execute(
                {
                  ids: [id1, id3],
                  conflictPriorityIndex: 0,
                  selectedFields: { id: true },
                },
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
    expect(await f.read('company')).toEqual(snapshotBeforePoison);
    expect(await audit()).toHaveLength(0);

    // RECORD_NOT_FOUND inside proven outer scope caught by caller still poisons and rolls back
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(id1, { name: 'must rollback missing' });
            try {
              await hScope.mergeMany.execute(
                {
                  ids: [id1, randomUUID()],
                  conflictPriorityIndex: 0,
                  selectedFields: { id: true },
                },
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
    expect(await f.read('company')).toEqual(snapshotBeforePoison);
    expect(await audit()).toHaveLength(0);

    // dryRun: true inside proven outer scope reads truly uncommitted outer changes and remains read-only
    await expect(
      hScope.run(() =>
        hScope.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(id1, { name: 'truly uncommitted dryRun' });
            const dryInner = await hScope.mergeMany.execute(
              {
                ids: [id1, id3],
                conflictPriorityIndex: 0,
                dryRun: true,
                selectedFields: { id: true, name: true },
              },
              hScope.queryContext('company', scope),
            );
            expect(dryInner.results.name).toBe('truly uncommitted dryRun');
            throw new Error('rollback outer dryRun tx');
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('rollback outer dryRun tx');
    expect(await audit()).toHaveLength(0);

    // Uncovered object (task with duplicateCriteria): works outside scope with 0 audit, fails closed + poisons inside outer proven scope
    const hTask = harness('user');
    const tExtra = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 't3')`,
      [tExtra],
    );
    await hTask.mergeMany.execute(
      { ids: [id1, id2], conflictPriorityIndex: 0, selectedFields: { id: true } },
      hTask.queryContext('task'),
    );
    expect(await audit()).toHaveLength(0);
    await expect(
      hTask.run(() =>
        hTask.dataSource.transaction(
          async (scope) => {
            try {
              await hTask.mergeMany.execute(
                {
                  ids: [id1, tExtra],
                  conflictPriorityIndex: 0,
                  selectedFields: { id: true },
                },
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
    expect(await audit()).toHaveLength(0);
  });

  it('rolls back full merge on real audit INSERT failure and propagates NativeTransactionOutcomeUnknownError without retry on lost COMMIT ACK', async () => {
    await f.owner.query(
      `UPDATE "${f.schemaName}".person SET "companyId" = $1 WHERE id = $2`,
      [id2, id2],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET "addressAddressCity" = 'private rollback city' WHERE id = $1`,
      [id2],
    );
    const companiesBefore = await f.read('company');

    // 1. Real audit INSERT trigger failure rolls back child migration, duplicate delete, priority update, events, stock release, and hooks
    const hFail = harness('user');
    await f.owner.query(
      `CREATE FUNCTION crm_audit.fail_public_merge_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'MERGE_AUDIT_FAILURE'; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER fail_public_merge_audit BEFORE INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_public_merge_audit()`,
    );
    f.recordStock.releaseRecordStock.mockClear();
    f.eventEmitter.mockClear();
    let cause: unknown = await hFail.mergeMany
      .execute(
        {
          ids: [id1, id2],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
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
    expect(messages).toContain('MERGE_AUDIT_FAILURE');
    await f.owner.query(
      `DROP TRIGGER IF EXISTS fail_public_merge_audit ON crm_audit."crmAuditEntry"`,
    );
    await f.owner.query(
      `DROP FUNCTION IF EXISTS crm_audit.fail_public_merge_audit()`,
    );
    expect(await f.read('company')).toEqual(companiesBefore);
    expect(
      (
        (await f.read('person')) as Array<{ id: string; companyId: string | null }>
      ).find((p) => p.id === id2)?.companyId,
    ).toBe(id2);
    expect(await audit()).toHaveLength(0);
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(f.recordStock.releaseRecordStock).not.toHaveBeenCalled();
    expect(hFail.hooks.executePostQueryHooks).not.toHaveBeenCalled();

    // 2. Lost COMMIT ACK throws NativeTransactionOutcomeUnknownError without ROLLBACK/retry, keeps committed merge + audit intact, skips events/hooks
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
      if (text === 'COMMIT') throw new Error('lost merge commit ack');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));

    await expect(
      hLost.mergeMany.execute(
        {
          ids: [id1, id2],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        hLost.queryContext('company'),
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
    expect(statements).not.toContain('ROLLBACK');
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === id2,
      ),
    ).toBe(false);
    expect(
      (
        (await f.read('person')) as Array<{ id: string; companyId: string | null }>
      ).find((p) => p.id === id2)?.companyId,
    ).toBe(id1);
    const lostEntries = await audit();
    expect(lostEntries).toHaveLength(3);
    expect(new Set(lostEntries.map((entry) => entry.operationId)).size).toBe(1);
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(hLost.hooks.executePostQueryHooks).not.toHaveBeenCalled();
  });
});
