import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  FieldMetadataType,
  FileFolder,
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonDestroyManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service';
import { CommonDestroyOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service';
import { CommonMergeManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-merge-many-query-runner.service';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditSecurityDescriptor } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  FILES_FIELD_HARD_DELETE_INTENT_NAME,
  reconcileFilesFieldHardDeleteIntentsWithAudit,
} from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { FilesFieldDeletionJob } from 'src/engine/core-modules/file/files-field/jobs/files-field-deletion.job';
import { FilesFieldDeletionListener } from 'src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener';
import { FilesFieldService } from 'src/engine/core-modules/file/files-field/services/files-field.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-max-attempts.constant';
import { RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/run-deferred-workspace-migration-actions-job-name.constant';
import { DeleteFilesFieldFilesDeferredActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/delete-files-field-files-deferred-action-handler.service';
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
  'src/engine/core-modules/file-storage/services/file-storage.service',
  () => ({ FileStorageService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application.entity',
  () => ({ ApplicationEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/field-metadata/field-metadata.entity',
  () => ({ FieldMetadataEntity: class {} }),
);
jest.mock('src/engine/core-modules/file/entities/file.entity', () => ({
  FileEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/file/utils/extract-file-info-or-throw.utils',
  () => ({ extractFileInfoOrThrow: jest.fn() }),
);

const FIXTURE_ACTIVE_OBJECTS = new Set([
  'company',
  'person',
  'opportunity',
  'customCase',
  'recordShare',
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
]);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity', 'customCase', 'recordShare'],
  configureMetadata: (maps) => {
    addCustomCrmMetadata(maps);
    for (const object of Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (!object) continue;
      if (!FIXTURE_ACTIVE_OBJECTS.has(object.nameSingular)) {
        object.isActive = false;
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
        settings: { maxNumberOfValues: 5 } as never,
        isUnique: false,
      };
      maps.flatFieldMetadataMaps.byUniversalIdentifier[
        field.universalIdentifier
      ] = field;
      maps.flatFieldMetadataMaps.universalIdentifierById[field.id] =
        field.universalIdentifier;
    }
  },
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
});

const roleId = randomUUID();
const userId = randomUUID();
const memberId = randomUUID();
const userWorkspaceId = randomUUID();
const appId = randomUUID();
const appUniversalId = randomUUID();
const companyId1 = randomUUID();
const companyId2 = randomUUID();
const childId1 = randomUUID();

let base: ReturnType<typeof getWorkspaceContext>;
let runtimeDataSource: DataSource;
let companyDocsFieldId = '';
let companyDocsFieldUniversalId = '';
let customCaseDocsFieldId = '';

const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );
const successAudit = async () =>
  (await audit()).filter((entry) => entry.outcome === 'success');
const failedAudit = async () =>
  (await audit()).filter((entry) => entry.outcome !== 'success');

const readFiles = () =>
  f.owner.query<
    Array<{
      id: string;
      workspaceId: string;
      applicationId: string | null;
      path: string;
      size: string;
      settings: { isTemporaryFile?: boolean; toDelete?: boolean } | null;
      status: string;
      deletedAt: Date | null;
    }>
  >('SELECT * FROM core.file ORDER BY id');

const readIntents = () =>
  f.owner.query<
    Array<{
      id: string;
      workspaceId: string;
      name: string;
      status: string;
      attempts: number;
      lastError: string | null;
      payload: Record<string, unknown>;
    }>
  >(
    `SELECT id, "workspaceId", name, status, attempts, "lastError", payload
     FROM core."deferredWorkspaceMigrationAction"
     ORDER BY "createdAt", id`,
  );

const seedFile = async (overrides: {
  id?: string;
  workspaceId?: string;
  applicationId?: string | null;
  path?: string;
  size?: number;
  settings?: Record<string, unknown> | null;
  status?: string;
  deletedAt?: string | null;
} = {}) => {
  const fileId = overrides.id ?? randomUUID();
  await f.owner.query(
    `INSERT INTO core.file (id, "workspaceId", "applicationId", path, size, settings, status, "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      fileId,
      overrides.workspaceId ?? f.workspaceId,
      'applicationId' in overrides ? overrides.applicationId : appId,
      overrides.path ?? `files-field/${randomUUID()}/${fileId}.pdf`,
      overrides.size ?? 2048,
      JSON.stringify(
        'settings' in overrides
          ? overrides.settings
          : { isTemporaryFile: false, toDelete: false },
      ),
      overrides.status ?? 'UPLOADED',
      overrides.deletedAt ?? null,
    ],
  );
  return fileId;
};

const makeHarness = () => {
  const auth = {
    type: 'user',
    workspace: { ...base.authContext.workspace, id: f.workspaceId },
    workspaceMemberId: memberId,
    userWorkspaceId,
    user: { id: userId },
  } as WorkspaceAuthContext;

  const permissions: ObjectsPermissionsByRoleId = {
    [roleId]: Object.fromEntries(
      Object.entries(base.objectIdByNameSingular).map(([, objectId]) => [
        objectId,
        {
          canReadObjectRecords: true,
          canUpdateObjectRecords: true,
          canSoftDeleteObjectRecords: true,
          canDestroyObjectRecords: true,
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
    userWorkspaceRoleMap: { [userWorkspaceId]: roleId },
  };
  const dataSource = new WorkspaceDataSource({
    pool: f.pool,
    internalContext: {
      ...context,
      workspaceId: f.workspaceId,
      eventEmitterService: { emitDatabaseBatchEvent: f.eventEmitter },
      recordStock: f.recordStock,
      coreDataSource: runtimeDataSource,
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
  const recordPositionService = new RecordPositionService(manager);

  const destroyMany = new CommonDestroyManyQueryRunnerService();
  const destroyOne = new CommonDestroyOneQueryRunnerService(destroyMany);
  const mergeMany = new CommonMergeManyQueryRunnerService();

  for (const runner of [destroyMany, destroyOne, mergeMany]) {
    Object.assign(runner, {
      workspaceOrmManager: manager,
      workspaceQueryHookService: hooks,
      dataArgProcessor: new DataArgProcessorService(recordPositionService),
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

  const queryContext = (name: string): CommonBaseQueryRunnerContext => {
    const flatObjectMetadata = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.id === base.objectIdByNameSingular[name])!;

    return {
      authContext: auth,
      flatObjectMetadata,
      flatObjectMetadataMaps: base.flatObjectMetadataMaps,
      flatFieldMetadataMaps: base.flatFieldMetadataMaps,
      flatIndexMaps: base.flatIndexMaps,
      objectIdByNameSingular: base.objectIdByNameSingular,
    };
  };

  return {
    dataSource,
    destroyOne,
    destroyMany,
    mergeMany,
    queryContext,
    run: <TData>(work: () => Promise<TData>) =>
      withWorkspaceContext(context, work),
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core.application (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       "universalIdentifier" varchar NOT NULL
     )`,
  );
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
    `GRANT SELECT ON core.application TO "${f.roleName}";
     GRANT SELECT, UPDATE, DELETE ON core.file TO "${f.roleName}";`,
  );
  runtimeDataSource = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 3, statement_timeout: 10000 },
  });
  await runtimeDataSource.initialize();
  // Make _customCase.companyId ON DELETE CASCADE so parent DESTROY cascades into child with FILES.
  const constraints = (await f.owner.query(
    `SELECT c.conname
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f'
       AND c.conrelid = $1::regclass
       AND c.confrelid = $2::regclass
       AND a.attname = 'companyId'`,
    [`"${f.schemaName}"."_customCase"`, `"${f.schemaName}".company`],
  )) as Array<{ conname: string }>;
  for (const constraint of constraints) {
    await f.owner.query(
      `ALTER TABLE "${f.schemaName}"."_customCase" DROP CONSTRAINT "${constraint.conname.replaceAll('"', '""')}"`,
    );
  }
  await f.owner.query(
    `ALTER TABLE "${f.schemaName}"."_customCase"
     ADD CONSTRAINT "cascade_custom_case_company"
     FOREIGN KEY ("companyId") REFERENCES "${f.schemaName}".company(id) ON DELETE CASCADE`,
  );

  base = await f.withContext(async () => getWorkspaceContext());
  const allFields = Object.values(
    base.flatFieldMetadataMaps.byUniversalIdentifier,
  );
  const companyDocsField = allFields.find(
    (field) =>
      field?.objectMetadataId === base.objectIdByNameSingular.company &&
      field.type === FieldMetadataType.FILES,
  )!;
  companyDocsFieldId = companyDocsField.id;
  companyDocsFieldUniversalId = companyDocsField.universalIdentifier;
  customCaseDocsFieldId = allFields.find(
    (field) =>
      field?.objectMetadataId === base.objectIdByNameSingular.customCase &&
      field.type === FieldMetadataType.FILES,
  )!.id;
});

beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS keep_deleted_company ON "${f.schemaName}".company`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".keep_deleted_company()`,
  );
  await f.reset();
  await f.owner.query('DELETE FROM core.file');
  await f.owner.query('DELETE FROM core.application');
  await f.owner.query(
    `INSERT INTO core.workspace (id, "deletedAt") VALUES ($1, NULL)
     ON CONFLICT (id) DO UPDATE SET "deletedAt" = NULL`,
    [f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier")
     VALUES ($1, $2, $3)`,
    [appId, f.workspaceId, appUniversalId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company (id, name)
     VALUES ($1, 'private co 1'), ($2, 'private co 2')`,
    [companyId1, companyId2],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"."_customCase" (id, name, "companyId")
     VALUES ($1, 'private case 1', $2)`,
    [childId1, companyId1],
  );
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtimeDataSource?.isInitialized) {
    await runtimeDataSource.destroy();
  }
  await f.dispose();
});

describe('LOG-205 File hard-delete transactional audit and durable cleanup owner', () => {
  it('audits parent and CASCADE child FILES retirement on DESTROY and MERGE, then hard-deletes with crmFile:delete through the durable owner', async () => {
    const h = makeHarness();
    const parentFileId = await seedFile({ size: 4096 });
    const childFileId = await seedFile({ size: 1024 });

    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [
        companyId1,
        JSON.stringify([{ fileId: parentFileId, label: 'secret-parent.pdf' }]),
      ],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET documents = $2::jsonb WHERE id = $1`,
      [
        childId1,
        JSON.stringify([{ fileId: childFileId, label: 'secret-child.pdf' }]),
      ],
    );

    const req = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
    });
    await withCrmAuditRequest(req, () =>
      h.destroyOne.execute(
        { id: companyId1, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    );

    // 1. Parent + CASCADE child deleted; both core.file rows soft-retired with toDelete: true; single durable intent created.
    const entriesAfterDestroy = await audit();
    expect(entriesAfterDestroy).toHaveLength(4);
    expect(
      new Set(entriesAfterDestroy.map((entry) => entry.operationId)).size,
    ).toBe(1);
    const sourceOperationId = entriesAfterDestroy[0].operationId;
    expect(JSON.stringify(entriesAfterDestroy)).not.toContain('secret-');

    const updateFileAudits = entriesAfterDestroy.filter(
      (entry) => entry.resourceKind === 'crmFile' && entry.action === 'update',
    );
    expect(updateFileAudits).toHaveLength(2);
    expect(updateFileAudits.find((e) => e.resourceId === parentFileId)).toMatchObject({
      correlationId: req.correlationId,
      securityDescriptor: {
        resourceKind: 'crmFile',
        resourceId: parentFileId,
        fileParent: {
          objectMetadataId: base.objectIdByNameSingular.company,
          recordId: companyId1,
          fieldMetadataId: companyDocsFieldId,
        },
      },
    });
    expect(updateFileAudits.find((e) => e.resourceId === childFileId)).toMatchObject({
      correlationId: req.correlationId,
      securityDescriptor: {
        resourceKind: 'crmFile',
        resourceId: childFileId,
        fileParent: {
          objectMetadataId: base.objectIdByNameSingular.customCase,
          recordId: childId1,
          fieldMetadataId: customCaseDocsFieldId,
        },
      },
    });

    const retiredFiles = await readFiles();
    expect(retiredFiles).toHaveLength(2);
    for (const file of retiredFiles) {
      expect(file.deletedAt).toBeInstanceOf(Date);
      expect(file.settings).toEqual({ isTemporaryFile: false, toDelete: true });
    }

    const intents = await readIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      workspaceId: f.workspaceId,
      name: FILES_FIELD_HARD_DELETE_INTENT_NAME,
      status: 'PENDING',
      attempts: 0,
    });
    expect(JSON.stringify(intents[0].payload)).not.toContain('secret-');

    // 2. Execute through DeleteFilesFieldFilesDeferredActionHandlerService -> storage delete, core.file DELETE, crmFile:delete, stock release.
    const deleteFileObject = jest.fn(async () => {});
    const releaseStorageStock = jest.fn(async () => {});
    const handler = new DeleteFilesFieldFilesDeferredActionHandlerService({
      reconcileFilesFieldHardDeleteIntentsWithAudit: (args) =>
        reconcileFilesFieldHardDeleteIntentsWithAudit({
          coreDataSource: runtimeDataSource,
          ...args,
          deleteFileObject,
          releaseStorageStock,
        }),
    });

    const runner = f.owner.createQueryRunner();
    await runner.connect();
    try {
      await handler.execute({
        workspaceId: f.workspaceId,
        payload: intents[0].payload,
        queryRunner: runner,
        actionId: intents[0].id,
      });
    } finally {
      await runner.release();
    }

    expect(deleteFileObject).toHaveBeenCalledTimes(2);
    expect(deleteFileObject).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: f.workspaceId,
        applicationUniversalIdentifier: appUniversalId,
        fileFolder: 'files-field',
      }),
    );
    expect(releaseStorageStock).toHaveBeenCalledTimes(2);
    expect(releaseStorageStock).toHaveBeenCalledWith({
      workspaceId: f.workspaceId,
      applicationId: appId,
      bytes: 4096,
      quantity: 1,
    });
    expect(releaseStorageStock).toHaveBeenCalledWith({
      workspaceId: f.workspaceId,
      applicationId: appId,
      bytes: 1024,
      quantity: 1,
    });
    expect(await readFiles()).toHaveLength(0);
    expect(await readIntents()).toHaveLength(0);

    const allAudits = await audit();
    const deleteFileAudits = allAudits.filter(
      (entry) => entry.resourceKind === 'crmFile' && entry.action === 'delete',
    );
    expect(deleteFileAudits).toHaveLength(2);
    for (const fileAudit of deleteFileAudits) {
      expect(fileAudit).toMatchObject({
        actor: { kind: 'system', id: 'files_field_hard_delete' },
        correlationId: req.correlationId,
        causationId: sourceOperationId,
        securityDescriptor: {
          resourceKind: 'crmFile',
          resourceId: fileAudit.resourceId,
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        },
      });
      const correspondingUpdate = updateFileAudits.find(
        (u) => u.resourceId === fileAudit.resourceId,
      )!;
      expect(fileAudit.securityDescriptor.fileParent).toEqual(
        correspondingUpdate.securityDescriptor.fileParent,
      );
      expect(fileAudit.redactedDiff).toEqual({
        changedFields: ['deletedAt', 'settings'],
        values: {},
      });
    }

    // 3. MERGE_MANY: priority WITHOUT files + duplicate WITH files fails deterministically (B3);
    //    priority WITH files + duplicate WITH files keeps priority file and durably hard-deletes duplicate file.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const cPrio = randomUUID();
    const cDup = randomUUID();
    const prioFileId = await seedFile({
      size: 512,
      path: `files-field/${companyDocsFieldUniversalId}/${randomUUID()}.pdf`,
    });
    const dupFileId = await seedFile({
      size: 768,
      path: `files-field/${companyDocsFieldUniversalId}/${randomUUID()}.pdf`,
    });
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents)
       VALUES ($1, 'prio co', NULL), ($2, 'dup co', $3::jsonb)`,
      [cPrio, cDup, JSON.stringify([{ fileId: dupFileId, label: 'dup.pdf' }])],
    );

    await expect(
      h.mergeMany.execute(
        { ids: [cPrio, cDup], conflictPriorityIndex: 0, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Merging files from duplicate records onto a priority record without files is not supported',
    );
    await expect(
      h.mergeMany.execute(
        {
          ids: [cPrio, cDup],
          conflictPriorityIndex: 0,
          dryRun: true,
          selectedFields: { id: true },
        },
        h.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Merging files from duplicate records onto a priority record without files is not supported',
    );
    // Shared fileId across priority and duplicate refuses deterministically (Major #3).
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [cPrio, JSON.stringify([{ fileId: dupFileId, label: 'shared.pdf' }])],
    );
    await expect(
      h.mergeMany.execute(
        { ids: [cPrio, cDup], conflictPriorityIndex: 0, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow(
      'Merging records that share the same file is not supported',
    );
    expect(await successAudit()).toHaveLength(0);
    expect(await failedAudit()).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        reasonCode: 'crm.mutation.audit_coverage_rejected',
      }),
      expect.objectContaining({
        outcome: 'failed',
        reasonCode: 'crm.mutation.audit_coverage_rejected',
      }),
    ]);
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    expect(await readIntents()).toHaveLength(0);

    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [cPrio, JSON.stringify([{ fileId: prioFileId, label: 'prio.pdf' }])],
    );
    await withCrmAuditRequest(req, () =>
      h.mergeMany.execute(
        { ids: [cPrio, cDup], conflictPriorityIndex: 0, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    );

    const mergeIntents = await readIntents();
    expect(mergeIntents).toHaveLength(1);
    const mergeReconcile = await reconcileFilesFieldHardDeleteIntentsWithAudit({
      coreDataSource: runtimeDataSource,
      workspaceId: f.workspaceId,
      deleteFileObject: async () => {},
      releaseStorageStock: async () => {},
    });
    expect(mergeReconcile).toEqual({
      processedIntents: 1,
      completedIntents: 1,
      deletedFiles: 1,
    });
    // Priority file survived intact; duplicate file hard-deleted and audited.
    const remainingFiles = await readFiles();
    expect(remainingFiles).toHaveLength(1);
    expect(remainingFiles[0].id).toBe(prioFileId);
    expect(remainingFiles[0].deletedAt).toBeNull();
    const mergeDeleteFileAudits = (await audit()).filter(
      (entry) => entry.resourceKind === 'crmFile' && entry.action === 'delete',
    );
    expect(mergeDeleteFileAudits).toHaveLength(1);
    expect(mergeDeleteFileAudits[0].resourceId).toBe(dupFileId);
  });

  it('fails closed on ineligible/missing core.file rows, respects BEFORE DELETE trigger skips, and enforces crmFile:delete descriptor and reconciler invariants', async () => {
    const h = makeHarness();

    // 1. Ineligible core.file rows fail closed before DELETE (M5).
    const invalidCases: Array<{
      label: string;
      seed: () => Promise<string>;
      expectedError: string;
    }> = [
      {
        label: 'missing',
        seed: async () => randomUUID(),
        expectedError: 'Native file is missing, deleted or outside this workspace',
      },
      {
        label: 'soft-deleted',
        seed: () => seedFile({ deletedAt: new Date().toISOString() }),
        expectedError: 'Native file is missing, deleted or outside this workspace',
      },
      {
        label: 'foreign workspace',
        seed: () => seedFile({ workspaceId: randomUUID() }),
        expectedError: 'Native file is missing, deleted or outside this workspace',
      },
      {
        label: 'PENDING status',
        seed: () => seedFile({ status: 'PENDING' }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
      {
        label: 'non-files-field folder',
        seed: () => seedFile({ path: `workspace-logo/${randomUUID()}.png` }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
      {
        label: 'temporary file',
        seed: () => seedFile({ settings: { isTemporaryFile: true, toDelete: false } }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
      {
        label: 'already toDelete',
        seed: () => seedFile({ settings: { isTemporaryFile: false, toDelete: true } }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
      {
        label: 'null settings',
        seed: () => seedFile({ settings: null }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
      {
        label: 'null applicationId',
        seed: () => seedFile({ applicationId: null }),
        expectedError: 'Native file is not eligible for audited deletion',
      },
    ];

    for (const invalidCase of invalidCases) {
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
      const badFileId = await invalidCase.seed();
      await f.owner.query(
        `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
        [companyId2, JSON.stringify([{ fileId: badFileId, label: invalidCase.label }])],
      );
      const companiesBefore = await f.read('company');
      await expect(
        h.destroyOne.execute(
          { id: companyId2, selectedFields: { id: true } },
          h.queryContext('company'),
        ),
      ).rejects.toThrow(invalidCase.expectedError);
      expect(await f.read('company')).toEqual(companiesBefore);
      expect(await successAudit()).toHaveLength(0);
      expect(await failedAudit()).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'crm.mutation.audit_coverage_rejected',
        }),
      ]);
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      expect(await readIntents()).toHaveLength(0);
    }

    // Duplicate fileId shared between parent and CASCADE child fails closed.
    const dupSharedFileId = await seedFile();
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $2::jsonb WHERE id = $1`,
      [companyId1, JSON.stringify([{ fileId: dupSharedFileId, label: 'a.pdf' }])],
    );
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET documents = $2::jsonb WHERE id = $1`,
      [childId1, JSON.stringify([{ fileId: dupSharedFileId, label: 'b.pdf' }])],
    );
    await expect(
      h.destroyOne.execute(
        { id: companyId1, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow('Native file must have one unambiguous owner');
    expect(await successAudit()).toHaveLength(0);
    expect(await failedAudit()).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        reasonCode: 'crm.mutation.audit_coverage_rejected',
      }),
    ]);
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    expect(await readIntents()).toHaveLength(0);

    // 2. BEFORE DELETE trigger skipping parent leaves its core.file untouched and creates no intent.
    await f.owner.query(
      `UPDATE "${f.schemaName}"."_customCase" SET documents = NULL WHERE id = $1`,
      [childId1],
    );
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".keep_deleted_company() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.id = '${companyId1}' THEN RETURN NULL; END IF;
         RETURN OLD;
       END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER keep_deleted_company BEFORE DELETE ON "${f.schemaName}".company
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".keep_deleted_company()`,
    );
    await h.run(() =>
      h.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('company', { shouldBypassPermissionChecks: true })
            .delete(companyId1);
        },
        { nativeAudit: { operationId: randomUUID() } },
      ),
    );
    const untouchedFile = (await readFiles()).find(
      (file) => file.id === dupSharedFileId,
    )!;
    expect(untouchedFile.deletedAt).toBeNull();
    expect(untouchedFile.settings).toEqual({
      isTemporaryFile: false,
      toDelete: false,
    });
    expect(await audit()).toHaveLength(0);
    expect(await readIntents()).toHaveLength(0);

    // 3. crmFile:delete descriptor validation (m2).
    await h.run(() =>
      h.dataSource.transaction(
        async (scope) => {
          const ctx = new CrmAuditTransactionContext(
            createCrmAuditWorkspaceExecutor(scope),
            {
              workspaceId: f.workspaceId,
              operationId: randomUUID(),
              actor: { kind: 'system', id: 'descriptor-check' },
            },
          );
          const validParent = {
            objectMetadataId: base.objectIdByNameSingular.company,
            recordId: companyId1,
            fieldMetadataId: companyDocsFieldId,
          };
          // crmFile:delete without deletedRecord rejected
          expect(() =>
            ctx.record({
              resourceKind: 'crmFile',
              resourceId: dupSharedFileId,
              action: 'delete',
              before: { settings: 'x', deletedAt: 'y' },
              after: null,
              securityDescriptor: {
                resourceKind: 'crmFile',
                resourceId: dupSharedFileId,
                fileParent: validParent,
              },
            }),
          ).toThrow();
          // crmFile:delete with non-null after rejected
          expect(() =>
            ctx.record({
              resourceKind: 'crmFile',
              resourceId: dupSharedFileId,
              action: 'delete',
              before: { settings: 'x', deletedAt: 'y' },
              after: { settings: 'x', deletedAt: 'y' },
              securityDescriptor: {
                resourceKind: 'crmFile',
                resourceId: dupSharedFileId,
                fileParent: validParent,
                deletedRecord: { access: 'currentWorkspaceAdministration' },
              },
            }),
          ).toThrow();
          // crmFile:update with deletedRecord rejected
          expect(() =>
            ctx.record({
              resourceKind: 'crmFile',
              resourceId: dupSharedFileId,
              action: 'update',
              before: { settings: 'a' },
              after: { settings: 'b' },
              securityDescriptor: {
                resourceKind: 'crmFile',
                resourceId: dupSharedFileId,
                fileParent: validParent,
                deletedRecord: { access: 'currentWorkspaceAdministration' },
              } as CrmAuditSecurityDescriptor,
            }),
          ).toThrow();
        },
        { commitOutcome: 'strict' },
      ),
    );

    // 4. Reconciler refuses live core.file (deletedAt IS NULL) and marks malformed payload FAILED immediately (B1).
    const malformedIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        malformedIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({ version: 999, files: [] }),
      ],
    );
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId: malformedIntentId,
        deleteFileObject: async () => {},
        releaseStorageStock: async () => {},
      }),
    ).rejects.toThrow('version is unsupported');
    expect((await readIntents()).find((i) => i.id === malformedIntentId)?.status).toBe(
      'FAILED',
    );

    const liveFileIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', $6)`,
      [
        liveFileIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [
            {
              fileId: dupSharedFileId,
              objectMetadataId: base.objectIdByNameSingular.company,
              recordId: companyId1,
              fieldMetadataId: companyDocsFieldId,
            },
          ],
        }),
        DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS - 1,
      ],
    );
    const deleteStorageSpy = jest.fn(async () => {});
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId: liveFileIntentId,
        deleteFileObject: deleteStorageSpy,
        releaseStorageStock: async () => {},
      }),
    ).rejects.toThrow('refuses active or non-retirable file row');
    expect(deleteStorageSpy).not.toHaveBeenCalled();
    const failedLiveIntent = (await readIntents()).find(
      (i) => i.id === liveFileIntentId,
    )!;
    expect(failedLiveIntent.status).toBe('FAILED');
    expect(failedLiveIntent.attempts).toBe(
      DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS,
    );
  });

  it('handles transient storage errors, FILE_NOT_FOUND idempotency, absent-row replay, concurrent worker claim, lost COMMIT ACK unsafeOutcome fencing, inactive workspace, and listener/job behavior', async () => {
    const file1 = await seedFile({
      size: 100,
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const file2 = await seedFile({
      size: 200,
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const sortedTwo = [file1, file2].sort();
    const intentId = randomUUID();
    const sourceOpId = randomUUID();
    const corrId = randomUUID();

    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        intentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: sourceOpId,
          correlationId: corrId,
          files: sortedTwo.map((fileId) => ({
            fileId,
            objectMetadataId: base.objectIdByNameSingular.company,
            recordId: companyId1,
            fieldMetadataId: companyDocsFieldId,
          })),
        }),
      ],
    );

    // 1. Storage failure on file #2 commits file #1 (nextFileIndex = 1) and releases intent back to PENDING.
    let callCount = 0;
    const stockSpy = jest.fn(async () => {});
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId,
        deleteFileObject: async () => {
          callCount += 1;
          if (callCount === 2) throw new Error('transient S3 503');
        },
        releaseStorageStock: stockSpy,
      }),
    ).rejects.toThrow('transient S3 503');

    expect(stockSpy).toHaveBeenCalledTimes(1);
    const midIntent = (await readIntents())[0];
    expect(midIntent.status).toBe('PENDING');
    expect(midIntent.attempts).toBe(1);
    expect(midIntent.payload.nextFileIndex).toBe(1);
    expect((await audit()).filter((e) => e.action === 'delete')).toHaveLength(1);

    // 2. Concurrent claim + FILE_NOT_FOUND idempotency: only one worker claims and completes file #2 with zero duplicate audit.
    const [r1, r2] = await Promise.all([
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId,
        deleteFileObject: async () => {
          const notFound = new Error('not found') as Error & { code?: string };
          notFound.code = 'FILE_NOT_FOUND';
          throw notFound;
        },
        releaseStorageStock: stockSpy,
      }),
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId,
        deleteFileObject: async () => {},
        releaseStorageStock: stockSpy,
      }),
    ]);
    expect(r1.processedIntents + r2.processedIntents).toBe(1);
    expect(r1.deletedFiles + r2.deletedFiles).toBe(1);
    expect(await readIntents()).toHaveLength(0);
    expect(await readFiles()).toHaveLength(0);
    expect((await audit()).filter((e) => e.action === 'delete')).toHaveLength(2);

    // 3. Absent core.file row replay removes intent without false crmFile:delete.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const absentIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        absentIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [
            {
              fileId: randomUUID(),
              objectMetadataId: base.objectIdByNameSingular.company,
              recordId: companyId1,
              fieldMetadataId: companyDocsFieldId,
            },
          ],
        }),
      ],
    );
    const absentRes = await reconcileFilesFieldHardDeleteIntentsWithAudit({
      coreDataSource: runtimeDataSource,
      workspaceId: f.workspaceId,
      intentId: absentIntentId,
      deleteFileObject: async () => {},
      releaseStorageStock: async () => {},
    });
    expect(absentRes).toEqual({
      processedIntents: 1,
      completedIntents: 1,
      deletedFiles: 0,
    });
    expect(await readIntents()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);

    // 4. Lost COMMIT ACK on 1st of 2 files throws NativeTransactionOutcomeUnknownError, skips releaseStorageStock, fences intent with unsafeOutcome.
    const lostFile1 = await seedFile({
      size: 300,
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const lostFile2 = await seedFile({
      size: 400,
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const lostIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        lostIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [lostFile1, lostFile2].sort().map((fileId) => ({
            fileId,
            objectMetadataId: base.objectIdByNameSingular.company,
            recordId: companyId1,
            fieldMetadataId: companyDocsFieldId,
          })),
        }),
      ],
    );

    const lostStockSpy = jest.fn(async () => {});
    const originalCreateRunner = runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
    let firedLostAck = false;
    const createRunnerSpy = jest
      .spyOn(runtimeDataSource, 'createQueryRunner')
      .mockImplementation((mode) => {
        const qr = originalCreateRunner(mode);
        const origConnect = qr.connect.bind(qr);
        qr.connect = async () => {
          const client = await origConnect();
          if (!firedLostAck && client && typeof client.query === 'function') {
            const rawQuery = client.query.bind(client);
            client.query = (async (
              statement: string | { text: string },
              values?: unknown[],
            ) => {
              const text =
                typeof statement === 'string' ? statement : statement.text;
              const result = await rawQuery(statement as string, values);
              if (!firedLostAck && text === 'COMMIT') {
                firedLostAck = true;
                throw new Error('lost hard-delete commit ack');
              }
              return result;
            }) as typeof client.query;
          }
          return client;
        };
        return qr;
      });

    try {
      await expect(
        reconcileFilesFieldHardDeleteIntentsWithAudit({
          coreDataSource: runtimeDataSource,
          workspaceId: f.workspaceId,
          intentId: lostIntentId,
          deleteFileObject: async () => {},
          releaseStorageStock: lostStockSpy,
        }),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    } finally {
      createRunnerSpy.mockRestore();
    }

    expect(lostStockSpy).not.toHaveBeenCalled();
    const fencedIntent = (await readIntents()).find((i) => i.id === lostIntentId)!;
    expect(fencedIntent.status).toBe('FAILED');
    expect(fencedIntent.payload.unsafeOutcome).toBeDefined();
    // Fenced intent cannot be retried even if manually flipped back to PENDING.
    await f.owner.query(
      `UPDATE core."deferredWorkspaceMigrationAction" SET status = 'PENDING' WHERE id = $1`,
      [lostIntentId],
    );
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId: lostIntentId,
        deleteFileObject: async () => {},
        releaseStorageStock: lostStockSpy,
      }),
    ).rejects.toThrow('Files field hard-delete intent fenced by unsafe outcome');
    expect(
      (await readIntents()).find((i) => i.id === lostIntentId)?.status,
    ).toBe('FAILED');

    // 5. Inactive workspace cleans non-fenced PENDING intent.
    await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
    const inactiveIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        inactiveIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [
            {
              fileId: lostFile2,
              objectMetadataId: base.objectIdByNameSingular.company,
              recordId: companyId1,
              fieldMetadataId: companyDocsFieldId,
            },
          ],
        }),
      ],
    );
    await f.owner.query(
      'UPDATE core.workspace SET "deletedAt" = now() WHERE id = $1',
      [f.workspaceId],
    );
    const inactiveRes = await reconcileFilesFieldHardDeleteIntentsWithAudit({
      coreDataSource: runtimeDataSource,
      workspaceId: f.workspaceId,
      intentId: inactiveIntentId,
      deleteFileObject: async () => {},
      releaseStorageStock: async () => {},
    });
    expect(inactiveRes).toEqual({
      processedIntents: 0,
      completedIntents: 0,
      deletedFiles: 0,
    });
    expect(await readIntents()).toHaveLength(0);

    // 6. FilesFieldDeletionListener routing (M1 + M3) and FilesFieldDeletionJob retry idempotency (M2).
    await f.owner.query(
      'UPDATE core.workspace SET "deletedAt" = NULL WHERE id = $1',
      [f.workspaceId],
    );
    const retiredFile = await seedFile({
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const liveUnauditedFile = await seedFile({
      deletedAt: null,
      settings: { isTemporaryFile: false, toDelete: false },
    });

    const deleteCascadeAdd = jest.fn(async () => {});
    const workspaceQueueAdd = jest.fn(async () => {});
    const listener = new FilesFieldDeletionListener(
      { add: deleteCascadeAdd } as never,
      {
        getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
          flatObjectMetadataMaps: base.flatObjectMetadataMaps,
          flatFieldMetadataMaps: base.flatFieldMetadataMaps,
        }),
      } as never,
      { add: workspaceQueueAdd } as never,
      f.owner,
    );
    const companyMeta = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((obj) => obj?.nameSingular === 'company')!;

    await listener.handleDestroyedEvent({
      workspaceId: f.workspaceId,
      name: `company.${DatabaseEventAction.DESTROYED}`,
      objectMetadata: companyMeta as never,
      events: [
        {
          recordId: companyId1,
          properties: {
            before: {
              documents: [
                { fileId: retiredFile, label: 'retired.pdf' },
                { fileId: liveUnauditedFile, label: 'trash-cleanup.pdf' },
              ],
            },
          },
        } as never,
      ],
    });

    expect(workspaceQueueAdd).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );
    expect(deleteCascadeAdd).toHaveBeenCalledWith(FilesFieldDeletionJob.name, {
      workspaceId: f.workspaceId,
      fileIds: [liveUnauditedFile],
    });

    // CASCADE-only FILES (parent has empty documents, pending intent exists) still enqueues workspaceQueue (M3).
    deleteCascadeAdd.mockClear();
    workspaceQueueAdd.mockClear();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        randomUUID(),
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [
            {
              fileId: retiredFile,
              objectMetadataId: base.objectIdByNameSingular.customCase,
              recordId: childId1,
              fieldMetadataId: customCaseDocsFieldId,
            },
          ],
        }),
      ],
    );
    await listener.handleDestroyedEvent({
      workspaceId: f.workspaceId,
      name: `company.${DatabaseEventAction.DESTROYED}`,
      objectMetadata: companyMeta as never,
      events: [
        {
          recordId: companyId2,
          properties: { before: { documents: null } },
        } as never,
      ],
    });
    expect(workspaceQueueAdd).toHaveBeenCalledTimes(1);
    expect(deleteCascadeAdd).not.toHaveBeenCalled();

    // Mixed batch with invalid/non-UUID/non-array FILES values must not break valid file routing (Major #2).
    deleteCascadeAdd.mockClear();
    workspaceQueueAdd.mockClear();
    await listener.handleDestroyedEvent({
      workspaceId: f.workspaceId,
      name: `company.${DatabaseEventAction.DESTROYED}`,
      objectMetadata: companyMeta as never,
      events: [
        {
          recordId: companyId1,
          properties: {
            before: {
              documents: 'not-an-array',
            },
          },
        } as never,
        {
          recordId: companyId2,
          properties: {
            before: {
              documents: [
                null,
                { fileId: 'not-a-uuid', label: 'bad.pdf' },
                { fileId: liveUnauditedFile.toUpperCase(), label: 'valid.pdf' },
              ],
            },
          },
        } as never,
      ],
    });
    expect(deleteCascadeAdd).toHaveBeenCalledWith(FilesFieldDeletionJob.name, {
      workspaceId: f.workspaceId,
      fileIds: [liveUnauditedFile],
    });

    // Stale-recovery fencing by attempts (Major #1): Worker A (attempts=1) cannot commit or release Worker B's claim (attempts=2).
    await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
    const raceFileId = await seedFile({
      size: 256,
      deletedAt: new Date().toISOString(),
      settings: { isTemporaryFile: false, toDelete: true },
    });
    const raceIntentId = randomUUID();
    await f.owner.query(
      `INSERT INTO core."deferredWorkspaceMigrationAction"
       (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'PENDING', 0)`,
      [
        raceIntentId,
        f.workspaceId,
        appUniversalId,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        JSON.stringify({
          version: 1,
          nextFileIndex: 0,
          sourceOperationId: randomUUID(),
          files: [
            {
              fileId: raceFileId,
              objectMetadataId: base.objectIdByNameSingular.company,
              recordId: companyId1,
              fieldMetadataId: companyDocsFieldId,
            },
          ],
        }),
      ],
    );
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId: raceIntentId,
        deleteFileObject: async () => {
          // Simulate stale recovery + Worker B reclaiming with attempts = 2 while Worker A is in storage delete.
          await f.owner.query(
            `UPDATE core."deferredWorkspaceMigrationAction" SET attempts = 2, status = 'IN_PROGRESS' WHERE id = $1`,
            [raceIntentId],
          );
        },
        releaseStorageStock: async () => {},
      }),
    ).rejects.toThrow('Files field hard-delete intent lock lost');
    const stillClaimedByWorkerB = (await readIntents()).find(
      (i) => i.id === raceIntentId,
    )!;
    expect(stillClaimedByWorkerB.status).toBe('IN_PROGRESS');
    expect(stillClaimedByWorkerB.attempts).toBe(2);
    expect((await readFiles()).some((r) => r.id === raceFileId)).toBe(true);

    // UnsafeOutcome added concurrently inside transaction marks FAILED (never reopens to PENDING) (Major #1).
    await f.owner.query(
      `UPDATE core."deferredWorkspaceMigrationAction" SET status = 'PENDING', attempts = 0 WHERE id = $1`,
      [raceIntentId],
    );
    await expect(
      reconcileFilesFieldHardDeleteIntentsWithAudit({
        coreDataSource: runtimeDataSource,
        workspaceId: f.workspaceId,
        intentId: raceIntentId,
        deleteFileObject: async () => {
          await f.owner.query(
            `UPDATE core."deferredWorkspaceMigrationAction"
             SET payload = jsonb_set(payload, '{unsafeOutcome}', '{"reason":"concurrent","at":"2026-11-22T00:00:00.000Z"}'::jsonb, true)
             WHERE id = $1`,
            [raceIntentId],
          );
        },
        releaseStorageStock: async () => {},
      }),
    ).rejects.toThrow('Files field hard-delete intent fenced by unsafe outcome');
    expect(
      (await readIntents()).find((i) => i.id === raceIntentId)?.status,
    ).toBe('FAILED');

    // FilesFieldDeletionJob rethrows failures and retries idempotently via FilesFieldService.deleteFilesFieldFile (M2).
    const activeFiles = new Set([file1, file2]);
    let failOnce = true;
    const filesFieldService = new FilesFieldService(
      {
        deleteByFileId: jest.fn(async ({ fileId }: { fileId: string }) => {
          if (fileId === file2 && failOnce) {
            failOnce = false;
            throw new Error('temporary storage glitch');
          }
          activeFiles.delete(fileId);
        }),
      } as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn(
          async (_ws: string, { where }: { where: { id: string } }) =>
            activeFiles.has(where.id) ? { id: where.id } : null,
        ),
      } as never,
      {} as never,
    );
    const job = new FilesFieldDeletionJob(filesFieldService);
    await expect(
      job.handle({ workspaceId: f.workspaceId, fileIds: [file1, file2] }),
    ).rejects.toThrow('temporary storage glitch');
    // Retry with same batch succeeds because file1 is already absent (M2).
    await expect(
      job.handle({ workspaceId: f.workspaceId, fileIds: [file1, file2] }),
    ).resolves.toBeUndefined();
    expect(activeFiles.size).toBe(0);
    expect(FileFolder.FilesField).toBe('files-field');
  });
});
