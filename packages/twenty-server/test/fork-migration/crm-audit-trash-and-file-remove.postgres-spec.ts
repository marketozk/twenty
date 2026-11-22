import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FieldMetadataType } from 'twenty-shared/types';
import {
  type ObjectRecordDestroyEvent,
  type ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { FILES_FIELD_HARD_DELETE_INTENT_NAME } from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { FilesFieldDeletionListener } from 'src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener';
import { FilesFieldService } from 'src/engine/core-modules/file/files-field/services/files-field.service';
import { TrashCleanupService } from 'src/engine/trash-cleanup/services/trash-cleanup.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type WorkspaceTransactionOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
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
  'src/engine/core-modules/file-storage/services/file-storage.service',
  () => ({ FileStorageService: class {} }),
);
jest.mock('src/engine/core-modules/application/application.entity', () => ({
  ApplicationEntity: class {},
}));
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
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
]);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity', 'customCase'],
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
      targetObject.fieldIds.push(field.id);
      targetObject.fieldUniversalIdentifiers.push(field.universalIdentifier);
    }
  },
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
});

const appId = randomUUID();
const appUniversalId = randomUUID();

let base: ReturnType<typeof getWorkspaceContext>;
let runtimeDataSource: DataSource;
let companyDocsFieldId = '';
let companyDocsFieldUniversalId = '';
let customCaseDocsFieldId = '';
let customCaseDocsFieldUniversalId = '';

const readAudits = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );

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
      payload: {
        version: number;
        nextFileIndex: number;
        sourceOperationId: string;
        correlationId?: string;
        files: Array<{
          fileId: string;
          objectMetadataId: string;
          recordId: string;
          fieldMetadataId: string;
        }>;
      };
    }>
  >('SELECT * FROM core."deferredWorkspaceMigrationAction" ORDER BY id');

const seedFile = async (
  overrides: Partial<{
    id: string;
    workspaceId: string;
    applicationId: string | null;
    path: string;
    size: number;
    settings: { isTemporaryFile: boolean; toDelete: boolean };
    status: string;
    deletedAt: Date | null;
    fieldUniversalId: string;
  }> = {},
) => {
  const id = overrides.id ?? randomUUID();
  const fieldUid = overrides.fieldUniversalId ?? companyDocsFieldUniversalId;
  await f.owner.query(
    `INSERT INTO core.file (id, "workspaceId", "applicationId", path, size, settings, status, "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      id,
      overrides.workspaceId ?? f.workspaceId,
      'applicationId' in overrides ? overrides.applicationId : appId,
      overrides.path ?? `files-field/${fieldUid}/private-${id}.pdf`,
      overrides.size ?? 2048,
      JSON.stringify(
        overrides.settings ?? { isTemporaryFile: false, toDelete: false },
      ),
      overrides.status ?? 'UPLOADED',
      overrides.deletedAt ?? null,
    ],
  );
  return id;
};

const makeTrashService = (objectNames: string[]) => {
  const manager = {
    getWorkspaceId: () => getWorkspaceContext().authContext.workspace.id,
    executeInWorkspaceContext: async <T>(work: () => Promise<T>): Promise<T> =>
      f.withContext(work),
    runInWorkspaceTransaction: async <T>(
      work: (scope: WorkspaceTransactionScope) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> => f.dataSource.transaction(work, options),
    getRepository: (name: string, options?: RolePermissionConfig) =>
      f.dataSource.getRepository(name, options),
  } as unknown as WorkspaceOrmManager;

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: Object.fromEntries(
          objectNames.map((name) => {
            const id = base.objectIdByNameSingular[name];
            const uid = base.flatObjectMetadataMaps.universalIdentifierById[id];
            return [
              name,
              uid
                ? base.flatObjectMetadataMaps.byUniversalIdentifier[uid]
                : undefined,
            ];
          }),
        ),
      },
    }),
  } as unknown as ConstructorParameters<typeof TrashCleanupService>[0];

  return new TrashCleanupService(flatEntityMapsCacheService, manager);
};

const makeListenerAndWorker = () => {
  const deleteCascadeQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const workspaceQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const releaseStorageStock = jest.fn().mockResolvedValue(undefined);
  const fileStorageService = {
    deleteFileObject: jest.fn().mockResolvedValue(undefined),
    releaseStorageStock,
  };
  const querySpy = jest.spyOn(runtimeDataSource, 'query');

  const cacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn().mockResolvedValue({
      flatObjectMetadataMaps: base.flatObjectMetadataMaps,
      flatFieldMetadataMaps: base.flatFieldMetadataMaps,
    }),
  };

  const listener = new FilesFieldDeletionListener(
    deleteCascadeQueue as never,
    cacheService as never,
    workspaceQueue as never,
    runtimeDataSource,
  );

  const filesFieldService = new FilesFieldService(
    fileStorageService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    runtimeDataSource,
  );

  const handler = new DeleteFilesFieldFilesDeferredActionHandlerService(
    filesFieldService,
  );

  const executeHandler = async (
    payload: unknown,
    actionId?: string,
  ): Promise<void> => {
    const queryRunner = runtimeDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await handler.execute({
        workspaceId: f.workspaceId,
        payload,
        queryRunner,
        actionId,
      });
    } finally {
      await queryRunner.release();
    }
  };

  return {
    deleteCascadeQueue,
    workspaceQueue,
    fileStorageService,
    releaseStorageStock,
    querySpy,
    cacheService,
    listener,
    handler,
    executeHandler,
  };
};

const runAudited = <TData>(
  work: (scope: WorkspaceTransactionScope) => Promise<TData>,
  options: { operationId?: string; correlationId?: string } = {},
) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      commitOutcome: 'strict',
      nativeAudit: {
        operationId: options.operationId ?? randomUUID(),
        systemActorId: 'log206-test',
        ...(options.correlationId
          ? { correlationId: options.correlationId }
          : {}),
      },
    }),
  );

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

  // Recreate _customCase.companyId as ON DELETE CASCADE to exercise parent+CASCADE FILES trash cleanup.
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
  const companyDocs = allFields.find(
    (field) =>
      field?.objectMetadataId === base.objectIdByNameSingular.company &&
      field.type === FieldMetadataType.FILES,
  )!;
  const customCaseDocs = allFields.find(
    (field) =>
      field?.objectMetadataId === base.objectIdByNameSingular.customCase &&
      field.type === FieldMetadataType.FILES,
  )!;
  companyDocsFieldId = companyDocs.id;
  companyDocsFieldUniversalId = companyDocs.universalIdentifier;
  customCaseDocsFieldId = customCaseDocs.id;
  customCaseDocsFieldUniversalId = customCaseDocs.universalIdentifier;
});

beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS fail_trash_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query('DROP FUNCTION IF EXISTS crm_audit.fail_trash_audit()');
  await f.reset();
  await f.owner.query('DELETE FROM core.file');
  await f.owner.query('DELETE FROM core.application');
  await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
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
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtimeDataSource?.isInitialized) {
    await runtimeDataSource.destroy();
  }
  await f.dispose();
});

describe('LOG-206 TrashCleanupService audit and UPDATE toRemove durable file hard-delete', () => {
  it('audits TrashCleanupService covered deletes with FK effects and FILES, then hard-deletes files via the durable owner', async () => {
    const companyId = randomUUID();
    const childId = randomUUID();
    const personId = randomUUID();
    const parentFileId = await seedFile({
      size: 4096,
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    const childFileId = await seedFile({
      size: 1024,
      fieldUniversalId: customCaseDocsFieldUniversalId,
    });

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents, "deletedAt")
       VALUES ($1, 'private co', $2::jsonb, NOW() - INTERVAL '40 days')`,
      [
        companyId,
        JSON.stringify([{ fileId: parentFileId, label: 'private-parent.pdf' }]),
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, name, "companyId", documents)
       VALUES ($1, 'private child', $2, $3::jsonb)`,
      [
        childId,
        companyId,
        JSON.stringify([{ fileId: childFileId, label: 'private-child.pdf' }]),
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "companyId")
       VALUES ($1, $2)`,
      [personId, companyId],
    );

    const trashService = makeTrashService(['company']);
    const deletedCount = await trashService.cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    expect(deletedCount).toBe(1);

    const auditsAfterTrash = await readAudits();
    const companyDelete = auditsAfterTrash.find(
      (entry) =>
        entry.resourceKind === 'crmRecord' &&
        entry.action === 'delete' &&
        entry.resourceId === companyId,
    )!;
    const childDelete = auditsAfterTrash.find(
      (entry) =>
        entry.resourceKind === 'crmRecord' &&
        entry.action === 'delete' &&
        entry.resourceId === childId,
    )!;
    const personSetNull = auditsAfterTrash.find(
      (entry) =>
        entry.resourceKind === 'crmRecord' &&
        entry.action === 'update' &&
        entry.resourceId === personId,
    )!;
    const fileUpdates = auditsAfterTrash.filter(
      (entry) => entry.resourceKind === 'crmFile' && entry.action === 'update',
    );

    expect(companyDelete).toBeDefined();
    expect(childDelete).toBeDefined();
    expect(personSetNull).toBeDefined();
    expect(fileUpdates).toHaveLength(2);
    expect(companyDelete.actor).toEqual({
      kind: 'system',
      id: 'trash_cleanup',
    });
    expect(companyDelete.correlationId).toBeDefined();
    for (const entry of [
      companyDelete,
      childDelete,
      personSetNull,
      ...fileUpdates,
    ]) {
      expect(entry.operationId).toBe(companyDelete.operationId);
      expect(entry.correlationId).toBe(companyDelete.correlationId);
    }

    const intents = await readIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      workspaceId: f.workspaceId,
      name: FILES_FIELD_HARD_DELETE_INTENT_NAME,
      status: 'PENDING',
      payload: {
        version: 1,
        nextFileIndex: 0,
        sourceOperationId: companyDelete.operationId,
        correlationId: companyDelete.correlationId,
      },
    });
    expect(intents[0].payload.files.map((item) => item.fileId).sort()).toEqual(
      [parentFileId, childFileId].sort(),
    );
    expect(JSON.stringify(intents)).not.toContain('private');

    const {
      deleteCascadeQueue,
      workspaceQueue,
      fileStorageService,
      releaseStorageStock,
      listener,
      executeHandler,
    } = makeListenerAndWorker();

    const emittedBatches = f.eventEmitter.mock.calls.map(
      (call) => call[0],
    ) as Array<{
      action: DatabaseEventAction;
      workspaceId: string;
      objectMetadata: { nameSingular: string };
      events: ObjectRecordDestroyEvent[];
    }>;
    const destroyedBatch = emittedBatches.find(
      (batch) => batch.action === DatabaseEventAction.DESTROYED,
    );
    expect(destroyedBatch).toBeDefined();

    await listener.handleDestroyedEvent(destroyedBatch as never);
    expect(workspaceQueue.add).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );
    expect(deleteCascadeQueue.add).not.toHaveBeenCalled();

    await executeHandler(intents[0].payload, intents[0].id);

    expect(fileStorageService.deleteFileObject).toHaveBeenCalledTimes(2);
    expect(releaseStorageStock).toHaveBeenCalledTimes(2);
    expect(await readFiles()).toHaveLength(0);
    expect(await readIntents()).toHaveLength(0);

    const allAudits = await readAudits();
    const fileDeletes = allAudits.filter(
      (entry) => entry.resourceKind === 'crmFile' && entry.action === 'delete',
    );
    expect(fileDeletes).toHaveLength(2);
    for (const fileDelete of fileDeletes) {
      expect(fileDelete.correlationId).toBe(companyDelete.correlationId);
      expect(fileDelete.causationId).toBe(companyDelete.operationId);
      expect(fileDelete.securityDescriptor.deletedRecord).toEqual({
        access: 'currentWorkspaceAdministration',
      });
    }
    expect(
      fileDeletes.find((entry) => entry.resourceId === parentFileId)!
        .securityDescriptor.fileParent,
    ).toEqual({
      objectMetadataId: base.objectIdByNameSingular.company,
      recordId: companyId,
      fieldMetadataId: companyDocsFieldId,
    });
    expect(
      fileDeletes.find((entry) => entry.resourceId === childFileId)!
        .securityDescriptor.fileParent,
    ).toEqual({
      objectMetadataId: base.objectIdByNameSingular.customCase,
      recordId: childId,
      fieldMetadataId: customCaseDocsFieldId,
    });
    expect(JSON.stringify(allAudits)).not.toContain('private');
  });

  it('isolates poison-pill records in TrashCleanupService, skips audit on uncovered objects, and propagates audit failures and unknown outcomes', async () => {
    const blockedPersonId = randomUUID();
    const cleanPerson1Id = randomUUID();
    const cleanPerson2Id = randomUUID();
    const blockedCompanyId = randomUUID();
    const cleanCompanyId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const participantRefId = randomUUID();
    const oldParticipantId = randomUUID();

    const invalidFileId = await seedFile({
      status: 'PENDING',
      fieldUniversalId: companyDocsFieldUniversalId,
    });

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "deletedAt")
       VALUES
         ($1, NOW() - INTERVAL '45 days'),
         ($2, NOW() - INTERVAL '44 days'),
         ($3, NOW() - INTERVAL '43 days')`,
      [blockedPersonId, cleanPerson1Id, cleanPerson2Id],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThread" (id) VALUES ($1)`,
      [threadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".message (id, "messageThreadId") VALUES ($1, $2)`,
      [messageId, threadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", "personId", role, handle)
       VALUES ($1, $2, $3, 'FROM', 'a@example.com')`,
      [participantRefId, messageId, blockedPersonId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", role, handle, "deletedAt")
       VALUES ($1, $2, 'TO', 'b@example.com', NOW() - INTERVAL '40 days')`,
      [oldParticipantId, messageId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents, "deletedAt")
       VALUES
         ($1, 'blocked co', $2::jsonb, NOW() - INTERVAL '45 days'),
         ($3, 'clean co', NULL, NOW() - INTERVAL '44 days')`,
      [
        blockedCompanyId,
        JSON.stringify([{ fileId: invalidFileId, label: 'pending.pdf' }]),
        cleanCompanyId,
      ],
    );

    const trashService = makeTrashService([
      'person',
      'company',
      'messageParticipant',
    ]);
    const deletedCount = await trashService.cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    // 2 clean persons + 1 clean company + 1 uncovered messageParticipant = 4.
    expect(deletedCount).toBe(4);

    const remainingPersons = (await f.read('person')) as Array<{ id: string }>;
    expect(remainingPersons.map((row) => row.id)).toEqual([blockedPersonId]);
    const remainingCompanies = (await f.read('company')) as Array<{
      id: string;
    }>;
    expect(remainingCompanies.map((row) => row.id)).toEqual([blockedCompanyId]);
    const remainingParticipants = (await f.read(
      'messageParticipant',
    )) as Array<{ id: string }>;
    expect(remainingParticipants.map((row) => row.id)).toEqual([
      participantRefId,
    ]);

    const audits = await readAudits();
    expect(audits.map((entry) => entry.resourceId).sort()).toEqual(
      [cleanPerson1Id, cleanPerson2Id, cleanCompanyId].sort(),
    );
    const correlationIds = new Set(audits.map((entry) => entry.correlationId));
    expect(correlationIds.size).toBe(1);
    expect(
      audits.every(
        (entry) =>
          entry.actor.kind === 'system' && entry.actor.id === 'trash_cleanup',
      ),
    ).toBe(true);

    // Non-coverage audit infrastructure failure must propagate and roll back.
    const auditFailCompanyId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, "deletedAt")
       VALUES ($1, 'infra fail co', NOW() - INTERVAL '40 days')`,
      [auditFailCompanyId],
    );
    await f.owner.query(
      `CREATE FUNCTION crm_audit.fail_trash_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TRASH_AUDIT_FAILURE'; END $$`,
    );
    await f.owner.query(
      'CREATE TRIGGER fail_trash_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_trash_audit()',
    );
    await expect(
      makeTrashService(['company']).cleanupWorkspaceTrash({
        workspaceId: f.workspaceId,
        trashRetentionDays: 14,
      }),
    ).rejects.toThrow();
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === auditFailCompanyId,
      ),
    ).toBe(true);

    await f.owner.query(
      'DROP TRIGGER IF EXISTS fail_trash_audit ON crm_audit."crmAuditEntry"',
    );
    await f.owner.query('DROP FUNCTION IF EXISTS crm_audit.fail_trash_audit()');

    // Lost COMMIT acknowledgement must throw NativeTransactionOutcomeUnknownError without ROLLBACK and leave durable intent recoverable.
    const unknownFileId = await seedFile({
      size: 512,
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $1::jsonb WHERE id = $2`,
      [
        JSON.stringify([{ fileId: unknownFileId, label: 'private-ack.pdf' }]),
        auditFailCompanyId,
      ],
    );
    await f.owner.query(`DELETE FROM "${f.schemaName}".company WHERE id = $1`, [
      blockedCompanyId,
    ]);

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
      if (text === 'COMMIT') throw new Error('lost commit ack');
      return result;
    }) as typeof client.query);

    const rawConnect = f.pool.connect.bind(f.pool);
    let intercepted = false;
    jest.spyOn(f.pool, 'connect').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        return rawConnect(...(args as Parameters<typeof rawConnect>));
      }
      if (!intercepted) {
        intercepted = true;
        return Promise.resolve(client);
      }
      return rawConnect();
    }) as typeof f.pool.connect);

    await expect(
      makeTrashService(['company']).cleanupWorkspaceTrash({
        workspaceId: f.workspaceId,
        trashRetentionDays: 14,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(statements).not.toContain('ROLLBACK');

    const pendingIntents = await readIntents();
    expect(pendingIntents).toHaveLength(1);
    expect(pendingIntents[0].payload.files.map((item) => item.fileId)).toEqual([
      unknownFileId,
    ]);

    const { fileStorageService, releaseStorageStock, executeHandler } =
      makeListenerAndWorker();
    await executeHandler(pendingIntents[0].payload, pendingIntents[0].id);
    expect(fileStorageService.deleteFileObject).toHaveBeenCalledTimes(1);
    expect(releaseStorageStock).toHaveBeenCalledTimes(1);
    expect(
      (await readFiles()).find((row) => row.id === unknownFileId),
    ).toBeUndefined();
    expect(await readIntents()).toHaveLength(0);
  });

  it('retires and durably hard-deletes FILES on UPDATE toRemove and file replacement (including mixed-case UUIDs) via FilesFieldDeletionListener', async () => {
    const companyId = randomUUID();
    const customCaseId = randomUUID();
    const fileA = await seedFile({
      size: 1000,
      settings: { isTemporaryFile: true, toDelete: true },
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    const fileB = await seedFile({
      size: 2000,
      settings: { isTemporaryFile: true, toDelete: true },
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    const fileC = await seedFile({
      size: 3000,
      settings: { isTemporaryFile: true, toDelete: true },
      fieldUniversalId: customCaseDocsFieldUniversalId,
    });

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'private co')`,
      [companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, name) VALUES ($1, 'private case')`,
      [customCaseId],
    );

    const {
      deleteCascadeQueue,
      workspaceQueue,
      fileStorageService,
      releaseStorageStock,
      querySpy,
      listener,
      executeHandler,
    } = makeListenerAndWorker();

    // 1. Attach fileA (toAdd only) using uppercase UUID.
    await runAudited((scope) =>
      scope
        .getRepository('company', { shouldBypassPermissionChecks: true })
        .update(companyId, {
          documents: [{ fileId: fileA.toUpperCase(), label: 'private-a' }],
        }),
    );
    const addBatch = (
      f.eventEmitter.mock.calls.map((call) => call[0]) as Array<{
        action: DatabaseEventAction;
        events: ObjectRecordUpdateEvent[];
      }>
    ).find((batch) => batch.action === DatabaseEventAction.UPDATED)!;
    querySpy.mockClear();
    await listener.handleUpdatedEvent(addBatch as never);
    expect(querySpy).not.toHaveBeenCalled();
    expect(workspaceQueue.add).not.toHaveBeenCalled();
    expect(await readIntents()).toHaveLength(0);

    // 2. Rename label with uppercase UUID (toUpdate only): must NOT classify as toRemove or touch DB.
    f.eventEmitter.mockClear();
    await runAudited((scope) =>
      scope
        .getRepository('company', { shouldBypassPermissionChecks: true })
        .update(companyId, {
          documents: [
            { fileId: fileA.toUpperCase(), label: 'private-a-renamed' },
          ],
        }),
    );
    const renameBatch = (
      f.eventEmitter.mock.calls.map((call) => call[0]) as Array<{
        action: DatabaseEventAction;
        events: ObjectRecordUpdateEvent[];
      }>
    ).find((batch) => batch.action === DatabaseEventAction.UPDATED)!;
    querySpy.mockClear();
    await listener.handleUpdatedEvent(renameBatch as never);
    expect(querySpy).not.toHaveBeenCalled();
    expect(workspaceQueue.add).not.toHaveBeenCalled();
    expect(await readIntents()).toHaveLength(0);

    // 3. Non-FILES field update and empty events batch: must NOT query DB.
    f.eventEmitter.mockClear();
    await runAudited((scope) =>
      scope
        .getRepository('company', { shouldBypassPermissionChecks: true })
        .update(companyId, { name: 'private co renamed' }),
    );
    const nameBatch = (
      f.eventEmitter.mock.calls.map((call) => call[0]) as Array<{
        action: DatabaseEventAction;
        events: ObjectRecordUpdateEvent[];
      }>
    ).find((batch) => batch.action === DatabaseEventAction.UPDATED)!;
    querySpy.mockClear();
    await listener.handleUpdatedEvent(nameBatch as never);
    await listener.handleUpdatedEvent({
      ...(nameBatch as object),
      events: [],
    } as never);
    expect(querySpy).not.toHaveBeenCalled();
    expect(workspaceQueue.add).not.toHaveBeenCalled();

    // 4. Replace fileA -> fileB (toRemove fileA + toAdd fileB in one UPDATE with uppercase UUID).
    f.eventEmitter.mockClear();
    const replaceOpId = randomUUID();
    const replaceCorrId = randomUUID();
    await runAudited(
      (scope) =>
        scope
          .getRepository('company', { shouldBypassPermissionChecks: true })
          .update(companyId, {
            documents: [{ fileId: fileB.toUpperCase(), label: 'private-b' }],
          }),
      { operationId: replaceOpId, correlationId: replaceCorrId },
    );

    const filesAfterReplace = await readFiles();
    const rowA = filesAfterReplace.find((row) => row.id === fileA)!;
    const rowB = filesAfterReplace.find((row) => row.id === fileB)!;
    expect(rowA.deletedAt).toBeInstanceOf(Date);
    expect(rowA.settings).toEqual({ isTemporaryFile: false, toDelete: true });
    expect(rowB.deletedAt).toBeNull();
    expect(rowB.settings).toEqual({ isTemporaryFile: false, toDelete: false });

    const intentsAfterReplace = await readIntents();
    expect(intentsAfterReplace).toHaveLength(1);
    expect(intentsAfterReplace[0]).toMatchObject({
      workspaceId: f.workspaceId,
      name: FILES_FIELD_HARD_DELETE_INTENT_NAME,
      status: 'PENDING',
      payload: {
        version: 1,
        nextFileIndex: 0,
        sourceOperationId: replaceOpId,
        correlationId: replaceCorrId,
        files: [
          {
            fileId: fileA,
            objectMetadataId: base.objectIdByNameSingular.company,
            recordId: companyId,
            fieldMetadataId: companyDocsFieldId,
          },
        ],
      },
    });

    const replaceBatch = (
      f.eventEmitter.mock.calls.map((call) => call[0]) as Array<{
        action: DatabaseEventAction;
        events: ObjectRecordUpdateEvent[];
      }>
    ).find((batch) => batch.action === DatabaseEventAction.UPDATED)!;
    querySpy.mockClear();
    await listener.handleUpdatedEvent(replaceBatch as never);
    expect(workspaceQueue.add).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );
    expect(deleteCascadeQueue.add).not.toHaveBeenCalled();

    // Execute durable worker for fileA: fileB must remain intact.
    await executeHandler(
      intentsAfterReplace[0].payload,
      intentsAfterReplace[0].id,
    );
    expect(fileStorageService.deleteFileObject).toHaveBeenCalledTimes(1);
    expect(releaseStorageStock).toHaveBeenCalledTimes(1);
    expect((await readFiles()).find((row) => row.id === fileA)).toBeUndefined();
    expect((await readFiles()).find((row) => row.id === fileB)).toBeDefined();
    expect(await readIntents()).toHaveLength(0);

    // 5. Custom object attach + toRemove (documents: []) -> durable hard-delete.
    await runAudited((scope) =>
      scope
        .getRepository('customCase', { shouldBypassPermissionChecks: true })
        .update(customCaseId, {
          documents: [{ fileId: fileC, label: 'private-c' }],
        }),
    );
    f.eventEmitter.mockClear();
    workspaceQueue.add.mockClear();
    const customRemoveOpId = randomUUID();
    await runAudited(
      (scope) =>
        scope
          .getRepository('customCase', { shouldBypassPermissionChecks: true })
          .update(customCaseId, { documents: [] }),
      { operationId: customRemoveOpId },
    );
    const customRemoveBatch = (
      f.eventEmitter.mock.calls.map((call) => call[0]) as Array<{
        action: DatabaseEventAction;
        events: ObjectRecordUpdateEvent[];
      }>
    ).find((batch) => batch.action === DatabaseEventAction.UPDATED)!;
    await listener.handleUpdatedEvent(customRemoveBatch as never);
    expect(workspaceQueue.add).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );

    const customIntents = await readIntents();
    expect(customIntents).toHaveLength(1);
    await executeHandler(customIntents[0].payload, customIntents[0].id);

    const allAudits = await readAudits();
    const deleteA = allAudits.find(
      (entry) =>
        entry.resourceKind === 'crmFile' &&
        entry.action === 'delete' &&
        entry.resourceId === fileA,
    )!;
    const deleteC = allAudits.find(
      (entry) =>
        entry.resourceKind === 'crmFile' &&
        entry.action === 'delete' &&
        entry.resourceId === fileC,
    )!;
    expect(deleteA.correlationId).toBe(replaceCorrId);
    expect(deleteA.causationId).toBe(replaceOpId);
    expect(deleteA.securityDescriptor.deletedRecord).toEqual({
      access: 'currentWorkspaceAdministration',
    });
    expect(deleteA.securityDescriptor.fileParent).toEqual({
      objectMetadataId: base.objectIdByNameSingular.company,
      recordId: companyId,
      fieldMetadataId: companyDocsFieldId,
    });
    expect(deleteC.causationId).toBe(customRemoveOpId);
    expect(deleteC.securityDescriptor.fileParent).toEqual({
      objectMetadataId: base.objectIdByNameSingular.customCase,
      recordId: customCaseId,
      fieldMetadataId: customCaseDocsFieldId,
    });
    expect(JSON.stringify(allAudits)).not.toContain('private');
  });

  it.each([
    ['pending status', { status: 'PENDING' }],
    ['non-files-field path', { path: 'other/invalid/private.pdf' }],
    ['missing applicationId', { applicationId: null }],
    [
      'already toDelete true',
      { settings: { isTemporaryFile: false, toDelete: true } },
    ],
  ])(
    'fails closed and rolls back UPDATE toRemove when core.file has %s',
    async (_label, overrides) => {
      const companyId = randomUUID();
      const badFileId = await seedFile({
        ...(overrides as Record<string, unknown>),
        path:
          (overrides as { path?: string }).path ??
          `files-field/${companyDocsFieldUniversalId}/private-bad.pdf`,
      });
      await f.owner.query(
        `INSERT INTO "${f.schemaName}".company (id, name, documents)
         VALUES ($1, 'co', $2::jsonb)`,
        [companyId, JSON.stringify([{ fileId: badFileId, label: 'bad.pdf' }])],
      );

      const filesBefore = await readFiles();
      await expect(
        runAudited((scope) =>
          scope
            .getRepository('company', { shouldBypassPermissionChecks: true })
            .update(companyId, { documents: [] }),
        ),
      ).rejects.toThrow();

      expect(await readFiles()).toEqual(filesBefore);
      expect(await readAudits()).toHaveLength(0);
      expect(await readIntents()).toHaveLength(0);
      const companyRow = (
        (await f.read('company')) as Array<{ id: string; documents: unknown }>
      ).find((row) => row.id === companyId)!;
      expect(companyRow.documents).toEqual([
        { fileId: badFileId, label: 'bad.pdf' },
      ]);
    },
  );

  it('advances pagination cursor past a single-record poison pill and refuses shared-file batches without 1-by-1 bypass', async () => {
    const blockedSingleId = randomUUID();
    const cleanNextPageId = randomUUID();
    const invalidFileId = await seedFile({
      status: 'PENDING',
      fieldUniversalId: companyDocsFieldUniversalId,
    });

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents, "deletedAt")
       VALUES
         ($1, 'single blocked', $2::jsonb, NOW() - INTERVAL '50 days'),
         ($3, 'clean page 2', NULL, NOW() - INTERVAL '40 days')`,
      [
        blockedSingleId,
        JSON.stringify([{ fileId: invalidFileId, label: 'pending.pdf' }]),
        cleanNextPageId,
      ],
    );

    // Force batchSize = 1 so page 1 has candidateIds.length === 1 (single poison pill) and page 2 has the clean record.
    const pagedTrash = makeTrashService(['company']);
    (pagedTrash as unknown as { batchSize: number }).batchSize = 1;
    const deletedPaged = await pagedTrash.cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    expect(deletedPaged).toBe(1);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([blockedSingleId]);

    // Shared fileId across two soft-deleted records must fail closed on the whole batch without 1-by-1 fallback destroying the file.
    await f.owner.query(`DELETE FROM "${f.schemaName}".company`);
    const sharedFileId = await seedFile({
      size: 512,
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    const sharedCo1 = randomUUID();
    const sharedCo2 = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents, "deletedAt")
       VALUES
         ($1, 'shared 1', $3::jsonb, NOW() - INTERVAL '45 days'),
         ($2, 'shared 2', $3::jsonb, NOW() - INTERVAL '44 days')`,
      [
        sharedCo1,
        sharedCo2,
        JSON.stringify([{ fileId: sharedFileId, label: 'shared.pdf' }]),
      ],
    );

    await expect(
      makeTrashService(['company']).cleanupWorkspaceTrash({
        workspaceId: f.workspaceId,
        trashRetentionDays: 14,
      }),
    ).rejects.toThrow('Native file must have one unambiguous owner');

    const remainingSharedCompanies = (
      (await f.read('company')) as Array<{ id: string }>
    )
      .map((row) => row.id)
      .sort();
    expect(remainingSharedCompanies).toEqual([sharedCo1, sharedCo2].sort());
    const sharedFileRow = (await readFiles()).find(
      (row) => row.id === sharedFileId,
    )!;
    expect(sharedFileRow.deletedAt).toBeNull();
    expect(sharedFileRow.settings).toEqual({
      isTemporaryFile: false,
      toDelete: false,
    });
    expect(await readIntents()).toHaveLength(0);
  });

  it('handles pre-existing uppercase fileId in DB across rename, add, and updateMany removal without mutating caller input, plus listener fallback branches', async () => {
    const companyId = randomUUID();
    const legacyFileId = await seedFile({
      size: 1200,
      settings: { isTemporaryFile: false, toDelete: false },
      fieldUniversalId: companyDocsFieldUniversalId,
    });
    const addedFileId = await seedFile({
      size: 800,
      settings: { isTemporaryFile: true, toDelete: true },
      fieldUniversalId: companyDocsFieldUniversalId,
    });

    // Seed pre-existing uppercase fileId directly in workspace JSONB (as from legacy/un-audited writes).
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name, documents)
       VALUES ($1, 'legacy co', $2::jsonb)`,
      [
        companyId,
        JSON.stringify([
          {
            fileId: legacyFileId.toUpperCase(),
            label: 'private-legacy.pdf',
            extension: '.pdf',
          },
        ]),
      ],
    );

    // 1. Rename label + attach second file while caller passes uppercase UUIDs; caller input must not be mutated.
    const callerInput = {
      documents: [
        { fileId: legacyFileId.toUpperCase(), label: 'private-renamed' },
        { fileId: addedFileId.toUpperCase(), label: 'private-added' },
      ],
    };
    await runAudited((scope) =>
      scope
        .getRepository('company', { shouldBypassPermissionChecks: true })
        .update(companyId, callerInput),
    );
    expect(callerInput.documents[0].fileId).toBe(legacyFileId.toUpperCase());
    expect(callerInput.documents[1].fileId).toBe(addedFileId.toUpperCase());
    expect(await readIntents()).toHaveLength(0);

    // 2. Remove both files via updateMany with a pre-existing uppercase fileId re-seeded in DB.
    await f.owner.query(
      `UPDATE "${f.schemaName}".company SET documents = $1::jsonb WHERE id = $2`,
      [
        JSON.stringify([
          {
            fileId: legacyFileId.toUpperCase(),
            label: 'private-legacy.pdf',
            extension: '.pdf',
          },
        ]),
        companyId,
      ],
    );
    await runAudited((scope) =>
      scope
        .getRepository('company', { shouldBypassPermissionChecks: true })
        .updateMany([
          { criteria: companyId, partialEntity: { documents: [] } },
        ]),
    );

    const intents = await readIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].payload.files.map((item) => item.fileId)).toEqual([
      legacyFileId,
    ]);
    expect(JSON.stringify(intents)).not.toContain('private');

    // 3. FilesFieldDeletionListener.handleUpdatedEvent fallback and uncovered-object branches.
    const { workspaceQueue, querySpy, listener, executeHandler } =
      makeListenerAndWorker();
    const companyMeta =
      base.flatObjectMetadataMaps.byUniversalIdentifier[
        base.flatObjectMetadataMaps.universalIdentifierById[
          base.objectIdByNameSingular.company
        ]!
      ]!;
    const participantMeta =
      base.flatObjectMetadataMaps.byUniversalIdentifier[
        base.flatObjectMetadataMaps.universalIdentifierById[
          base.objectIdByNameSingular.messageParticipant
        ]!
      ]!;

    // Uncovered object must not query coreDataSource.
    querySpy.mockClear();
    await listener.handleUpdatedEvent({
      workspaceId: f.workspaceId,
      objectMetadata: participantMeta,
      events: [
        {
          recordId: randomUUID(),
          properties: { updatedFields: ['handle'], before: {}, after: {} },
        },
      ],
    } as never);
    expect(querySpy).not.toHaveBeenCalled();
    expect(workspaceQueue.add).not.toHaveBeenCalled();

    // Conservative fallback when updatedFields is omitted and after is null (e.g. documents: null).
    await listener.handleUpdatedEvent({
      workspaceId: f.workspaceId,
      objectMetadata: companyMeta,
      events: [
        {
          recordId: companyId,
          properties: {
            before: { documents: [{ fileId: legacyFileId, label: 'x' }] },
            after: { documents: null },
          },
        },
      ],
    } as never);
    expect(workspaceQueue.add).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );

    // Conservative fallback when before is null.
    workspaceQueue.add.mockClear();
    await listener.handleUpdatedEvent({
      workspaceId: f.workspaceId,
      objectMetadata: companyMeta,
      events: [
        {
          recordId: companyId,
          properties: {
            updatedFields: ['documents'],
            before: null,
            after: { documents: [] },
          },
        },
      ],
    } as never);
    expect(workspaceQueue.add).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );

    await executeHandler(intents[0].payload, intents[0].id);
    expect(
      (await readFiles()).find((row) => row.id === legacyFileId),
    ).toBeUndefined();
    expect(await readIntents()).toHaveLength(0);
  });
});
