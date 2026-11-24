import { randomUUID } from 'node:crypto';
import {
  FeatureFlagKey,
  FileFolder,
  PageLayoutType,
  RecordShareAccessLevel,
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataSource } from 'typeorm';

import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonCreateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service';
import { CommonCreateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-one-query-runner.service';
import { CommonDeleteManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-delete-many-query-runner.service';
import { CommonDeleteOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-delete-one-query-runner.service';
import { CommonDestroyManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service';
import { CommonDestroyOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service';
import { CommonMergeManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-merge-many-query-runner.service';
import { CommonRestoreManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-restore-many-query-runner.service';
import { CommonRestoreOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-restore-one-query-runner.service';
import { CommonUpdateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-many-query-runner.service';
import { CommonUpdateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-one-query-runner.service';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  registerCrmAuditAlertSink,
  resetCrmAuditHealthStateForTesting,
} from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { FILES_FIELD_HARD_DELETE_INTENT_NAME } from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { isNativeCrmAuditMetadata } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { captureNativeCrmAuditBindingFromNavigationIdentity } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { RecordShareStorageService } from 'src/engine/core-modules/record-share/services/record-share-storage.service';
import { ShareWithService } from 'src/engine/core-modules/record-share/services/share-with.service';
import { PageLayoutService } from 'src/engine/metadata-modules/page-layout/services/page-layout.service';
import { PermissionsException } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { TrashCleanupService } from 'src/engine/trash-cleanup/services/trash-cleanup.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type NativeCrmAuditBinding } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { DashboardSyncService } from 'src/modules/dashboard-sync/services/dashboard-sync.service';
import {
  DashboardException,
  DashboardExceptionCode,
} from 'src/modules/dashboard/exceptions/dashboard.exception';
import { DashboardDuplicationService } from 'src/modules/dashboard/services/dashboard-duplication.service';
import { createCreateCompleteDashboardTool } from 'src/modules/dashboard/tools/create-complete-dashboard.tool';
import { type DashboardToolDependencies } from 'src/modules/dashboard/tools/types/dashboard-tool-dependencies.type';
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
  'src/engine/core-modules/file/files-field/services/files-field.service',
  () => ({ FilesFieldService: class {} }),
);
jest.mock(
  'src/engine/core-modules/actor/services/actor-from-auth-context.service',
  () => ({ ActorFromAuthContextService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/page-layout/services/page-layout-duplication.service',
  () => ({ PageLayoutDuplicationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application.service',
  () => ({ ApplicationService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);

const FIXTURE_ACTIVE_OBJECTS = new Set([
  'company',
  'person',
  'opportunity',
  'note',
  'noteTarget',
  'task',
  'taskTarget',
  'attachment',
  'timelineActivity',
  'recordShare',
  'workspaceMember',
  'agentChatThread',
  'calendarEvent',
  'workflow',
  'workflowVersion',
  'workflowRun',
  'dashboard',
  'messageCampaign',
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
    'note',
    'noteTarget',
    'task',
    'taskTarget',
    'attachment',
    'timelineActivity',
    'recordShare',
    'workspaceMember',
    'agentChatThread',
    'calendarEvent',
    'workflow',
    'workflowVersion',
    'workflowRun',
    'dashboard',
    'messageCampaign',
  ],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  configureMetadata: (maps) => {
    for (const object of Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (!object) continue;
      if (!FIXTURE_ACTIVE_OBJECTS.has(object.nameSingular)) {
        object.isActive = false;
      }
      if (object.nameSingular === 'dashboard') {
        object.duplicateCriteria = [['title']];
      }
    }
  },
});

const roleId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const userWorkspaceId = randomUUID();
const workspaceMemberId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const apiKeyId = randomUUID();
const appId = randomUUID();
const appUniversalId = randomUUID();
const agentId = randomUUID();

let attachmentFileFieldUniversalId = '';
let base: ReturnType<typeof getWorkspaceContext>;
let runtimeDataSource: DataSource;

const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt", id',
  );

const readIntents = () =>
  f.owner.query<Array<{ id: string; name: string; status: string }>>(
    `SELECT id, name, status FROM core."deferredWorkspaceMigrationAction"
     WHERE "workspaceId" = $1 AND name = $2 ORDER BY id`,
    [f.workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME],
  );

const seedFile = async () => {
  const fileId = randomUUID();
  const path = `${FileFolder.FilesField}/${attachmentFileFieldUniversalId}/${fileId}.pdf`;
  await f.owner.query(
    `INSERT INTO core.file (id, "workspaceId", "applicationId", path, size, settings, status, "deletedAt")
     VALUES ($1, $2, $3, $4, 256, $5::jsonb, 'UPLOADED', NULL)`,
    [
      fileId,
      f.workspaceId,
      appId,
      path,
      JSON.stringify({ isTemporaryFile: false, toDelete: false }),
    ],
  );
  return fileId;
};

const makeHarness = ({
  authOverride,
  permissionOverrides = {},
  recordLevelSharingEnabled = false,
  omitRoleMapping = false,
}: {
  authOverride?: WorkspaceAuthContext;
  permissionOverrides?: Record<
    string,
    Partial<{
      canReadObjectRecords: boolean;
      canUpdateObjectRecords: boolean;
      canSoftDeleteObjectRecords: boolean;
      canDestroyObjectRecords: boolean;
    }>
  >;
  recordLevelSharingEnabled?: boolean;
  omitRoleMapping?: boolean;
} = {}) => {
  const auth: WorkspaceAuthContext =
    authOverride ??
    ({
      type: 'user',
      workspace: { id: f.workspaceId } as never,
      userWorkspaceId,
      user: { id: userId } as never,
      workspaceMemberId,
      workspaceMember: { id: workspaceMemberId } as never,
    } as WorkspaceAuthContext);

  const permissions: ObjectsPermissionsByRoleId = {
    [roleId]: Object.fromEntries(
      Object.entries(base.objectIdByNameSingular).map(
        ([nameSingular, objectId]) => [
          objectId,
          {
            canReadObjectRecords: true,
            canUpdateObjectRecords: true,
            canSoftDeleteObjectRecords: true,
            canDestroyObjectRecords: true,
            ...permissionOverrides[nameSingular],
            restrictedFields: {},
            rowLevelPermissionPredicates: [],
            rowLevelPermissionPredicateGroups: [],
          },
        ],
      ),
    ),
  };

  const context = {
    ...base,
    featureFlagsMap: {
      ...base.featureFlagsMap,
      ...(recordLevelSharingEnabled
        ? { [FeatureFlagKey.IS_RECORD_LEVEL_SHARING_ENABLED]: true }
        : {}),
    },
    authContext: auth,
    permissionsPerRoleId: permissions,
    userWorkspaceRoleMap: omitRoleMapping ? {} : { [userWorkspaceId]: roleId },
    apiKeyRoleMap: omitRoleMapping ? {} : { [apiKeyId]: roleId },
  };

  const makeDataSource = (activeAuth: WorkspaceAuthContext) =>
    new WorkspaceDataSource({
      pool: f.pool,
      internalContext: {
        ...context,
        workspaceId: f.workspaceId,
        eventEmitterService: { emitDatabaseBatchEvent: f.eventEmitter },
        recordStock: f.recordStock,
        coreDataSource: f.owner,
      },
      authContext: activeAuth,
      objectPermissionsByRoleId: permissions,
    });

  const dataSource = makeDataSource(auth);

  const manager = {
    executeInWorkspaceContext: <T>(
      fn: () => Promise<T>,
      ctxAuth?: WorkspaceAuthContext,
    ) => withWorkspaceContext({ ...context, authContext: ctxAuth ?? auth }, fn),
    getGlobalWorkspaceDataSource: async () =>
      makeDataSource(getWorkspaceContext().authContext),
    runInWorkspaceTransaction: <T>(
      work: Parameters<WorkspaceDataSource['transaction']>[0],
      options?: Parameters<WorkspaceDataSource['transaction']>[1],
    ) =>
      makeDataSource(getWorkspaceContext().authContext).transaction<T>(
        work as never,
        options,
      ),
    getRepository: jest.fn(
      (
        objectName: string,
        roleConfig?: Parameters<WorkspaceDataSource['getRepository']>[1],
      ) =>
        makeDataSource(getWorkspaceContext().authContext).getRepository(
          objectName,
          roleConfig,
        ),
    ),
    getObjectMetadataId: (nameSingular: string) => {
      const map = getWorkspaceContext().objectIdByNameSingular;
      return Object.hasOwn(map, nameSingular) ? map[nameSingular] : undefined;
    },
  } as unknown as WorkspaceOrmManager;

  const hooks = {
    executePreQueryHooks: jest.fn(async (_a, _n, _o, args) => args),
    executePostQueryHooks: jest.fn(async () => undefined),
  };

  const storageService = new RecordShareStorageService(manager as never);
  const principalService = {
    assertPrincipalsReachRecordsOrThrow: jest.fn().mockResolvedValue(undefined),
  };
  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatObjectMetadataMaps: base.flatObjectMetadataMaps,
      flatFieldMetadataMaps: base.flatFieldMetadataMaps,
      flatWorkspaceMemberMaps: {
        byId: { [workspaceMemberId]: { id: workspaceMemberId } },
      },
      flatRoleMaps: {
        byId: { [roleId]: { id: roleId } },
      },
      flatAgentMaps: { byId: {} },
    })),
  };
  const shareWithService = new ShareWithService(
    storageService,
    principalService as never,
    workspaceCacheService as never,
  );

  const visibility = new CommonRecordVisibilityService();
  const recordPositionService = new RecordPositionService(manager);
  const createMany = new CommonCreateManyQueryRunnerService(
    recordPositionService,
    shareWithService,
  );
  const createOne = new CommonCreateOneQueryRunnerService(createMany);
  const updateMany = new CommonUpdateManyQueryRunnerService();
  const updateOne = new CommonUpdateOneQueryRunnerService(updateMany);
  const deleteMany = new CommonDeleteManyQueryRunnerService();
  const deleteOne = new CommonDeleteOneQueryRunnerService(deleteMany);
  const restoreMany = new CommonRestoreManyQueryRunnerService();
  const restoreOne = new CommonRestoreOneQueryRunnerService(restoreMany);
  const destroyMany = new CommonDestroyManyQueryRunnerService();
  const destroyOne = new CommonDestroyOneQueryRunnerService(destroyMany);
  const mergeMany = new CommonMergeManyQueryRunnerService();

  for (const runner of [
    createMany,
    createOne,
    updateMany,
    updateOne,
    deleteMany,
    deleteOne,
    restoreMany,
    restoreOne,
    destroyMany,
    destroyOne,
    mergeMany,
  ]) {
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
      twentyConfigService: { get: () => 10_000 },
      metricsService: { incrementCounterBy: jest.fn() },
      shareWithService,
      commonCreateManyQueryRunnerService: createMany,
    });
  }

  const queryContext = (
    name: string,
    transactionScope?: CommonBaseQueryRunnerContext['transactionScope'],
  ): CommonBaseQueryRunnerContext => {
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
      transactionScope,
    };
  };

  const makeTrashService = () => {
    const systemAuth: WorkspaceAuthContext = {
      type: 'system',
      workspace: { id: f.workspaceId } as never,
    };
    const systemContext = { ...base, authContext: systemAuth };
    const systemDataSource = new WorkspaceDataSource({
      pool: f.pool,
      internalContext: {
        ...systemContext,
        workspaceId: f.workspaceId,
        eventEmitterService: { emitDatabaseBatchEvent: f.eventEmitter },
        recordStock: f.recordStock,
        coreDataSource: f.owner,
      },
      authContext: systemAuth,
      objectPermissionsByRoleId: permissions,
    });
    const systemManager = {
      executeInWorkspaceContext: <T>(fn: () => Promise<T>) =>
        withWorkspaceContext(systemContext, fn),
      runInWorkspaceTransaction: systemDataSource.transaction.bind(
        systemDataSource,
      ),
      getRepository: systemDataSource.getRepository.bind(systemDataSource),
    } as unknown as WorkspaceOrmManager;
    const dashboardObject = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'dashboard')!;
    return new TrashCleanupService(
      {
        getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
          flatObjectMetadataMaps: {
            byUniversalIdentifier: {
              [dashboardObject.universalIdentifier]: dashboardObject,
            },
            universalIdentifierById: {
              [dashboardObject.id]: dashboardObject.universalIdentifier,
            },
          },
        }),
      } as never,
      systemManager,
    );
  };

  return {
    auth,
    dataSource,
    manager,
    recordPositionService,
    queryContext,
    createOne,
    createMany,
    updateOne,
    deleteOne,
    restoreOne,
    destroyOne,
    mergeMany,
    makeTrashService,
    run: <T>(fn: () => Promise<T>) => withWorkspaceContext(context, fn),
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    `ALTER TABLE core.workspace ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."user" (
       id uuid PRIMARY KEY,
       "deletedAt" timestamptz
     )`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."userWorkspace" (
       id uuid PRIMARY KEY,
       "userId" uuid NOT NULL,
       "workspaceId" uuid NOT NULL,
       "deletedAt" timestamptz
     )`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core.application (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       "universalIdentifier" uuid NOT NULL
     )`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core.file (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       "applicationId" uuid,
       path text NOT NULL,
       size bigint NOT NULL DEFAULT 0,
       settings jsonb NOT NULL DEFAULT '{}'::jsonb,
       status text NOT NULL DEFAULT 'UPLOADED',
       "deletedAt" timestamptz,
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."deferredWorkspaceMigrationAction" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       name text NOT NULL,
       status text NOT NULL,
       payload jsonb NOT NULL DEFAULT '{}'::jsonb,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "executedAt" timestamptz,
       "lastError" text
     )`,
  );
  await f.owner.query(
    `GRANT USAGE ON SCHEMA core TO "${f.roleName}";
     GRANT SELECT ON core."user" TO "${f.roleName}";
     GRANT SELECT ON core."userWorkspace" TO "${f.roleName}";
     GRANT SELECT ON core.application TO "${f.roleName}";
     GRANT SELECT, UPDATE, DELETE ON core.file TO "${f.roleName}";
     GRANT SELECT, UPDATE ON core.workspace TO "${f.roleName}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON core."deferredWorkspaceMigrationAction" TO "${f.roleName}";`,
  );
  await f.withContext(async () => {
    base = getWorkspaceContext();
    const attachmentObject = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'attachment')!;
    const fileField = Object.values(
      base.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === attachmentObject.id &&
        field?.name === 'file',
    )!;
    attachmentFileFieldUniversalId = fileField.universalIdentifier;
  });

  runtimeDataSource = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 3, statement_timeout: 10_000 },
  });
  await runtimeDataSource.initialize();
});

beforeEach(async () => {
  await f.reset();
  resetCrmAuditHealthStateForTesting();
  await f.owner.query('DELETE FROM core.file');
  await f.owner.query('DELETE FROM core.application');
  await f.owner.query('DELETE FROM core."userWorkspace"');
  await f.owner.query('DELETE FROM core."user"');
  await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
  await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

  await f.owner.query(
    'INSERT INTO core.workspace (id, "deletedAt") VALUES ($1, NULL) ON CONFLICT (id) DO UPDATE SET "deletedAt" = NULL',
    [f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO core."user" (id, "deletedAt") VALUES ($1, NULL), ($2, NULL), ($3, NULL) ON CONFLICT (id) DO NOTHING`,
    [userId, otherUserId, impersonatorUserId],
  );
  await f.owner.query(
    `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId", "deletedAt")
     VALUES ($1, $2, $3, NULL), ($4, $5, $3, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [
      userWorkspaceId,
      userId,
      f.workspaceId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await f.owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier")
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [appId, f.workspaceId, appUniversalId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"."workspaceMember" (id, "userId", "userEmail", "nameFirstName", "nameLastName")
     VALUES ($1, $2, 'member@example.com', 'Ada', 'Lovelace')
     ON CONFLICT (id) DO NOTHING`,
    [workspaceMemberId, userId],
  );
  f.eventEmitter.mockClear();
  f.recordStock.releaseRecordStock.mockClear();
});

afterAll(async () => {
  if (runtimeDataSource?.isInitialized) {
    await runtimeDataSource.destroy();
  }
  await f.dispose();
});

describe('LOG-211: dashboard native CRM audit and direct writers', () => {
  it('enables dashboard metadata coverage and fails closed on forged or mismatched nativeAuditBinding', async () => {
    const dashboardMeta = Object.values(
      base.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'dashboard')!;
    expect(isNativeCrmAuditMetadata(dashboardMeta, f.workspaceId)).toBe(true);

    const h = makeHarness();
    const forgedBinding: NativeCrmAuditBinding = Object.freeze({
      operation: Object.freeze({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        actor: Object.freeze({ kind: 'system' as const, id: 'forged' }),
      }),
    });

    const systemAuth: WorkspaceAuthContext = {
      type: 'system',
      workspace: { id: f.workspaceId } as never,
    };
    const hSys = makeHarness({ authOverride: systemAuth });
    await hSys.run(async () => {
      await expect(
        hSys.manager.runInWorkspaceTransaction(
          async () => undefined,
          { nativeAuditBinding: forgedBinding },
        ),
      ).rejects.toThrow('Untrusted native audit binding');

      const trustedBinding =
        captureNativeCrmAuditBindingFromNavigationIdentity({
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          defaultSystemActorId: 'test:bridge',
        });
      await expect(
        hSys.manager.runInWorkspaceTransaction(async () => undefined, {
          nativeAudit: { operationId: randomUUID(), systemActorId: 'test:a' },
          nativeAuditBinding: trustedBinding,
        }),
      ).rejects.toThrow('Native audit options and binding cannot be combined');
    });

    await h.run(async () => {
      const trustedBinding =
        captureNativeCrmAuditBindingFromNavigationIdentity({
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          defaultSystemActorId: 'test:bridge',
        });
      await expect(
        h.manager.runInWorkspaceTransaction(async () => undefined, {
          nativeAuditBinding: trustedBinding,
        }),
      ).rejects.toThrow('Trusted native audit binding requires system context');
    });
  });

  it('audits dashboard CRUD, Branch A shareWith, FK attachment CASCADE + FILES, timelineActivity SET NULL, MERGE_MANY, TrashCleanupService, and post-rollback attempts', async () => {
    const h = makeHarness({ recordLevelSharingEnabled: true });
    const dashboardId = randomUUID();
    const layoutId = randomUUID();

    await h.run(async () => {
      await h.createOne.execute(
        {
          data: { id: dashboardId, title: 'Q4 Revenue', pageLayoutId: layoutId },
          selectedFields: { id: true, title: true },
          shareWith: [
            {
              workspaceMemberId,
              accessLevel: RecordShareAccessLevel.READ,
            },
          ],
        },
        h.queryContext('dashboard'),
      );
    });

    const createEntries = await audit();
    expect(createEntries.map((e) => `${e.resourceKind}:${e.action}`)).toEqual(
      expect.arrayContaining(['crmRecord:create', 'recordShare:create']),
    );
    expect(new Set(createEntries.map((e) => e.operationId)).size).toBe(1);
    const dashboardCreate = createEntries.find(
      (e) => e.resourceKind === 'crmRecord' && e.resourceId === dashboardId,
    )!;
    expect(dashboardCreate.actor).toEqual({
      kind: 'workspaceMember',
      id: workspaceMemberId,
    });

    await h.run(async () => {
      await h.updateOne.execute(
        {
          id: dashboardId,
          data: { title: 'Q4 Revenue Updated' },
          selectedFields: { id: true, title: true },
        },
        h.queryContext('dashboard'),
      );
      await h.deleteOne.execute(
        {
          id: dashboardId,
          selectedFields: { id: true },
        },
        h.queryContext('dashboard'),
      );
      await h.restoreOne.execute(
        {
          id: dashboardId,
          selectedFields: { id: true },
        },
        h.queryContext('dashboard'),
      );
    });

    const lifecycleActions = (await audit())
      .filter((e) => e.resourceId === dashboardId)
      .map((e) => e.action);
    expect(lifecycleActions).toEqual(['create', 'update', 'update', 'update']);

    // Seed attachment (CASCADE + FILES) and timelineActivity (SET NULL), then DESTROY
    const fileId = await seedFile();
    const attachmentId = randomUUID();
    const timelineId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."attachment" (id, name, "targetDashboardId", file)
       VALUES ($1, 'report.pdf', $2, $3::jsonb)`,
      [
        attachmentId,
        dashboardId,
        JSON.stringify([{ fileId, label: 'report.pdf' }]),
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetDashboardId")
       VALUES ($1, 'dashboard.viewed', $2)`,
      [timelineId, dashboardId],
    );

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    await h.run(async () => {
      await h.destroyOne.execute(
        { id: dashboardId, selectedFields: { id: true } },
        h.queryContext('dashboard'),
      );
    });

    const destroyEntries = await audit();
    expect(new Set(destroyEntries.map((e) => e.operationId)).size).toBe(1);
    expect(
      destroyEntries.map(
        (e) => `${e.resourceKind}:${e.action}:${e.resourceId}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        `crmRecord:delete:${dashboardId}`,
        `crmRecord:delete:${attachmentId}`,
        `crmRecord:update:${timelineId}`,
        `crmFile:update:${fileId}`,
      ]),
    );
    expect(await readIntents()).toHaveLength(1);
    expect(await f.read('attachment')).toHaveLength(0);
    const remainingTimeline = await f.read('timelineActivity');
    expect(remainingTimeline[0].targetDashboardId).toBeNull();

    // MERGE_MANY between two dashboards re-parents attachment and timelineActivity
    const d1 = randomUUID();
    const d2 = randomUUID();
    const mergeAttId = randomUUID();
    const mergeTlId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId")
       VALUES ($1, 'Primary', $3), ($2, 'Duplicate', $4)`,
      [d1, d2, randomUUID(), randomUUID()],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."attachment" (id, name, "targetDashboardId") VALUES ($1, 'a.txt', $2)`,
      [mergeAttId, d2],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetDashboardId") VALUES ($1, 'ev', $2)`,
      [mergeTlId, d2],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    await h.run(async () => {
      await h.mergeMany.execute(
        {
          ids: [d1, d2],
          conflictPriorityIndex: 0,
          dryRun: false,
          selectedFields: { id: true },
        },
        h.queryContext('dashboard'),
      );
    });
    const mergeEntries = await audit();
    expect(new Set(mergeEntries.map((e) => e.operationId)).size).toBe(1);
    expect(
      mergeEntries.map((e) => `${e.resourceKind}:${e.action}:${e.resourceId}`),
    ).toEqual(
      expect.arrayContaining([
        `crmRecord:update:${mergeAttId}`,
        `crmRecord:update:${mergeTlId}`,
        `crmRecord:delete:${d2}`,
      ]),
    );

    // TrashCleanupService hard-deletes expired soft-deleted dashboard with attachment + FILES + timelineActivity
    const trashDashboardId = randomUUID();
    const trashFileId = await seedFile();
    const trashAttId = randomUUID();
    const trashTlId = randomUUID();
    const expiredDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId", "deletedAt")
       VALUES ($1, 'Expired', $2, $3)`,
      [trashDashboardId, randomUUID(), expiredDate],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."attachment" (id, name, "targetDashboardId", file)
       VALUES ($1, 'old.pdf', $2, $3::jsonb)`,
      [
        trashAttId,
        trashDashboardId,
        JSON.stringify([{ fileId: trashFileId, label: 'old.pdf' }]),
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetDashboardId")
       VALUES ($1, 'old.ev', $2)`,
      [trashTlId, trashDashboardId],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    const deletedCount = await h.makeTrashService().cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    expect(deletedCount).toBe(1);
    const trashEntries = await audit();
    expect(
      trashEntries.every(
        (e) => e.actor.kind === 'system' && e.actor.id === 'trash_cleanup',
      ),
    ).toBe(true);
    expect(
      trashEntries.map((e) => `${e.resourceKind}:${e.action}:${e.resourceId}`),
    ).toEqual(
      expect.arrayContaining([
        `crmRecord:delete:${trashDashboardId}`,
        `crmRecord:delete:${trashAttId}`,
        `crmRecord:update:${trashTlId}`,
        `crmFile:update:${trashFileId}`,
      ]),
    );

    // Post-rollback denied attempt on CRUD
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hDenied = makeHarness({
      permissionOverrides: { dashboard: { canUpdateObjectRecords: false } },
    });
    await hDenied.run(async () => {
      await expect(
        hDenied.createOne.execute(
          {
            data: { id: randomUUID(), title: 'NoPerm', pageLayoutId: randomUUID() },
            selectedFields: { id: true },
          },
          hDenied.queryContext('dashboard'),
        ),
      ).rejects.toThrow(PermissionsException);
    });
    const deniedEntries = await audit();
    expect(deniedEntries).toHaveLength(1);
    expect(deniedEntries[0].outcome).toBe('denied');
    expect(deniedEntries[0].action).toBe('create');
  });

  it('audits DashboardDuplicationService: user + impersonation, system auth, denied, not-found, rollback, and unknown outcome', async () => {
    const h = makeHarness();
    const sourceDashboardId = randomUUID();
    const sourceLayoutId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId", position)
       VALUES ($1, 'Sales', $2, 1)`,
      [sourceDashboardId, sourceLayoutId],
    );

    const newLayoutId = randomUUID();
    const pageLayoutDuplicationService = {
      duplicate: jest.fn().mockResolvedValue({ id: newLayoutId }),
    };
    const pageLayoutService = {
      destroy: jest.fn().mockResolvedValue(true),
    };
    const actorFromAuthContextService = {
      injectActorFieldsOnCreate: jest.fn(async ({ records }) => records),
    };

    const duplicationService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      h.manager,
      actorFromAuthContextService as never,
    );

    // 1. User + impersonation inside withCrmAuditRequest
    const reqSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });
    const duplicated = await withCrmAuditRequest(reqSnap, () =>
      duplicationService.duplicateDashboard(sourceDashboardId, h.auth),
    );
    expect(duplicated.title).toBe('Sales (Copy)');
    expect(duplicated.pageLayoutId).toBe(newLayoutId);

    const userEntries = await audit();
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].action).toBe('create');
    expect(userEntries[0].resourceId).toBe(duplicated.id);
    expect(userEntries[0].actor).toEqual({
      kind: 'workspaceMember',
      id: workspaceMemberId,
    });
    expect(userEntries[0].initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });
    expect(userEntries[0].correlationId).toBe(reqSnap.correlationId);
    expect(pageLayoutDuplicationService.duplicate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auditIdentity: expect.objectContaining({
          impersonatorUserWorkspaceId,
          correlationId: reqSnap.correlationId,
        }),
      }),
    );

    // 2. System authContext uses consistent systemActorId
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const sysAuth: WorkspaceAuthContext = {
      type: 'system',
      workspace: { id: f.workspaceId } as never,
    };
    const hSys = makeHarness({ authOverride: sysAuth });
    const sysDupService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      hSys.manager,
      actorFromAuthContextService as never,
    );
    const sysDuplicated = await sysDupService.duplicateDashboard(
      sourceDashboardId,
      sysAuth,
    );
    const sysEntries = await audit();
    expect(sysEntries).toHaveLength(1);
    expect(sysEntries[0].resourceId).toBe(sysDuplicated.id);
    expect(sysEntries[0].actor).toEqual({
      kind: 'system',
      id: 'dashboard-duplication:duplicate',
    });
    expect(pageLayoutDuplicationService.duplicate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auditIdentity: expect.objectContaining({
          systemActorId: 'dashboard-duplication:duplicate',
        }),
      }),
    );

    // 3. DASHBOARD_NOT_FOUND does not record a bogus create attempt
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await expect(
      duplicationService.duplicateDashboard(randomUUID(), h.auth),
    ).rejects.toMatchObject({
      code: DashboardExceptionCode.DASHBOARD_NOT_FOUND,
    });
    expect(await audit()).toHaveLength(0);

    // 4. PermissionsException (no insert permission) records denied and does NOT duplicate layout
    pageLayoutDuplicationService.duplicate.mockClear();
    const hNoInsert = makeHarness({
      permissionOverrides: { dashboard: { canUpdateObjectRecords: false } },
    });
    const deniedDupService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      hNoInsert.manager,
      actorFromAuthContextService as never,
    );
    await expect(
      deniedDupService.duplicateDashboard(sourceDashboardId, hNoInsert.auth),
    ).rejects.toThrow(PermissionsException);
    expect(pageLayoutDuplicationService.duplicate).not.toHaveBeenCalled();
    const dupDeniedEntries = await audit();
    expect(dupDeniedEntries).toHaveLength(1);
    expect(dupDeniedEntries[0].outcome).toBe('denied');
    expect(dupDeniedEntries[0].action).toBe('create');

    // 5. Missing rolePermissionConfig also records denied
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hNoRole = makeHarness({ omitRoleMapping: true });
    const noRoleDupService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      hNoRole.manager,
      actorFromAuthContextService as never,
    );
    await expect(
      noRoleDupService.duplicateDashboard(sourceDashboardId, hNoRole.auth),
    ).rejects.toThrow(PermissionsException);
    expect((await audit())[0].outcome).toBe('denied');

    // 6. Insert failure records single failed attempt and destroys duplicated layout with isLinkedDashboardAlreadyDestroyed: true
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    pageLayoutService.destroy.mockClear();
    const failingActorService = {
      injectActorFieldsOnCreate: jest.fn(async ({ records }) =>
        records.map((r: ObjectRecord) => ({ ...r, pageLayoutId: 'not-a-uuid' })),
      ),
    };
    const failingDupService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      h.manager,
      failingActorService as never,
    );
    await expect(
      failingDupService.duplicateDashboard(sourceDashboardId, h.auth),
    ).rejects.toThrow();
    const failedEntries = await audit();
    expect(failedEntries).toHaveLength(1);
    expect(failedEntries[0].outcome).toBe('failed');
    expect(failedEntries[0].action).toBe('create');
    expect(pageLayoutService.destroy).toHaveBeenCalledTimes(1);
    expect(pageLayoutService.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: newLayoutId,
        workspaceId: f.workspaceId,
        isLinkedDashboardAlreadyDestroyed: true,
      }),
    );

    // 7. NativeTransactionOutcomeUnknownError skips post-rollback DB attempt and skips layout destruction
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    pageLayoutService.destroy.mockClear();
    const alerts: Array<{ code: string }> = [];
    registerCrmAuditAlertSink((alert) => {
      alerts.push(alert);
    });
    const unknownTxManager = {
      ...h.manager,
      runInWorkspaceTransaction: jest
        .fn()
        .mockRejectedValue(
          new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('commit lost'),
          ),
        ),
    } as unknown as WorkspaceOrmManager;
    const unknownDupService = new DashboardDuplicationService(
      pageLayoutDuplicationService as never,
      pageLayoutService as never,
      unknownTxManager,
      actorFromAuthContextService as never,
    );
    await expect(
      unknownDupService.duplicateDashboard(sourceDashboardId, h.auth),
    ).rejects.toThrow(NativeTransactionOutcomeUnknownError);
    expect(await audit()).toHaveLength(0);
    expect(pageLayoutService.destroy).not.toHaveBeenCalled();
    expect(
      alerts.some((a) => a.code === 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED'),
    ).toBe(true);
  });

  it('audits createCreateCompleteDashboardTool across user+agent, coreUser, authUserWorkspaceId, system, impersonation/conflict rejection, rollback, and unknown outcome', async () => {
    const h = makeHarness();
    const buildToolDeps = (
      layoutId: string,
      managerOverride?: WorkspaceOrmManager,
    ) => {
      const createLayout = jest.fn().mockResolvedValue({ id: layoutId });
      const destroyLayout = jest.fn().mockResolvedValue(true);
      const deps = {
        pageLayoutService: { create: createLayout, destroy: destroyLayout },
        pageLayoutTabService: {
          create: jest.fn().mockResolvedValue({ id: randomUUID() }),
        },
        recordPositionService: h.recordPositionService,
        workspaceOrmManager: managerOverride ?? h.manager,
      } as unknown as DashboardToolDependencies;
      return { deps, createLayout, destroyLayout };
    };

    // 1. User + agentId (no application) inside withCrmAuditRequest
    const layout1 = randomUUID();
    const t1 = buildToolDeps(layout1);
    const reqSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
    });
    const tool1 = createCreateCompleteDashboardTool(t1.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
      auditIdentity: { auth: h.auth, agentId },
      authUserWorkspaceId: userWorkspaceId,
    });
    const res1 = await withCrmAuditRequest(reqSnap, () =>
      tool1.execute({ title: 'AI Sales' }),
    );
    expect(res1.success).toBe(true);
    const entries1 = await audit();
    expect(entries1).toHaveLength(1);
    expect(entries1[0].action).toBe('create');
    expect(entries1[0].actor).toEqual({ kind: 'agent', id: agentId });
    expect(entries1[0].initiator).toEqual({
      kind: 'workspaceMember',
      id: workspaceMemberId,
    });
    expect(entries1[0].correlationId).toBe(reqSnap.correlationId);

    // 2. Impersonated request + agentId fails closed BEFORE pageLayoutService.create
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const tImp = buildToolDeps(randomUUID());
    const impSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });
    const toolImp = createCreateCompleteDashboardTool(tImp.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
      auditIdentity: { auth: h.auth, agentId },
    });
    const resImp = await withCrmAuditRequest(impSnap, () =>
      toolImp.execute({ title: 'Blocked' }),
    );
    expect(resImp.success).toBe(false);
    expect(tImp.createLayout).not.toHaveBeenCalled();

    // 3. Cross-user request + userAuth fails closed BEFORE pageLayoutService.create
    const tCross = buildToolDeps(randomUUID());
    const otherSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: otherUserId },
    });
    const toolCross = createCreateCompleteDashboardTool(tCross.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
      auditIdentity: { auth: h.auth, agentId },
    });
    const resCross = await withCrmAuditRequest(otherSnap, () =>
      toolCross.execute({ title: 'CrossUser' }),
    );
    expect(resCross.success).toBe(false);
    expect(tCross.createLayout).not.toHaveBeenCalled();

    // 4. authUserWorkspaceId-only resolves coreUser from core."userWorkspace"
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const tUw = buildToolDeps(randomUUID());
    const toolUw = createCreateCompleteDashboardTool(tUw.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
      authUserWorkspaceId: userWorkspaceId,
    });
    const resUw = await toolUw.execute({ title: 'UW Dash' });
    expect(resUw.success).toBe(true);
    const uwEntries = await audit();
    expect(uwEntries).toHaveLength(1);
    expect(uwEntries[0].actor).toEqual({ kind: 'coreUser', id: userId });

    // 5. undefined auditIdentity outside ALS uses default systemActorId
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const tSys = buildToolDeps(randomUUID());
    const toolSys = createCreateCompleteDashboardTool(tSys.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
    });
    const resSys = await toolSys.execute({ title: 'Sys Dash' });
    expect(resSys.success).toBe(true);
    expect((await audit())[0].actor).toEqual({
      kind: 'system',
      id: 'dashboard-tool:create-complete-dashboard',
    });

    // 6. DB failure on insert records failed attempt and destroys layout
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const badLayout = 'not-a-uuid';
    const tFail = buildToolDeps(badLayout);
    const toolFail = createCreateCompleteDashboardTool(tFail.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
      auditIdentity: { user: { id: userId } },
    });
    const resFail = await toolFail.execute({ title: 'Bad Layout' });
    expect(resFail.success).toBe(false);
    expect(tFail.destroyLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        id: badLayout,
        isLinkedDashboardAlreadyDestroyed: true,
      }),
    );
    const failEntries = await audit();
    expect(failEntries).toHaveLength(1);
    expect(failEntries[0].outcome).toBe('failed');
    expect(failEntries[0].actor).toEqual({ kind: 'coreUser', id: userId });

    // 7. NativeTransactionOutcomeUnknownError skips layout destroy and skips DB attempt
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const unknownMgr = {
      ...h.manager,
      runInWorkspaceTransaction: jest
        .fn()
        .mockRejectedValue(
          new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('timeout'),
          ),
        ),
    } as unknown as WorkspaceOrmManager;
    const tUnk = buildToolDeps(randomUUID(), unknownMgr);
    const toolUnk = createCreateCompleteDashboardTool(tUnk.deps, {
      workspaceId: f.workspaceId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
    });
    const resUnk = await toolUnk.execute({ title: 'Unknown' });
    expect(resUnk.success).toBe(false);
    expect(tUnk.destroyLayout).not.toHaveBeenCalled();
    expect(await audit()).toHaveLength(0);
  });

  it('audits DashboardSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId including correlation inheritance, zero-row no-op, and best-effort post-rollback failure', async () => {
    const h = makeHarness();
    const layoutId = randomUUID();
    const dashboardId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId")
       VALUES ($1, 'Synced', $2)`,
      [dashboardId, layoutId],
    );

    const flatCache = {
      getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => ({
        flatPageLayoutMaps: {
          byUniversalIdentifier: {
            [layoutId]: { id: layoutId, type: PageLayoutType.DASHBOARD },
          },
          universalIdentifierById: { [layoutId]: layoutId },
        },
      })),
    };
    const syncService = new DashboardSyncService(h.manager, flatCache as never);

    // 1. Updates updatedAt inside audited system transaction, inheriting correlationId
    const reqSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
    });
    const nextUpdatedAt = new Date(Date.now() + 60_000);
    await withCrmAuditRequest(reqSnap, () =>
      syncService.updateLinkedDashboardsUpdatedAtByPageLayoutId({
        pageLayoutId: layoutId,
        workspaceId: f.workspaceId,
        updatedAt: nextUpdatedAt,
      }),
    );

    const syncEntries = await audit();
    expect(syncEntries).toHaveLength(1);
    expect(syncEntries[0].action).toBe('update');
    expect(syncEntries[0].resourceId).toBe(dashboardId);
    expect(syncEntries[0].actor).toEqual({
      kind: 'system',
      id: 'dashboard-sync:update-linked-dashboards',
    });
    expect(syncEntries[0].correlationId).toBe(reqSnap.correlationId);

    // 2. Zero matching dashboards -> zero audit entries
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const emptyLayoutId = randomUUID();
    flatCache.getOrRecomputeManyOrAllFlatEntityMaps.mockResolvedValueOnce({
      flatPageLayoutMaps: {
        byUniversalIdentifier: {
          [emptyLayoutId]: {
            id: emptyLayoutId,
            type: PageLayoutType.DASHBOARD,
          },
        },
        universalIdentifierById: { [emptyLayoutId]: emptyLayoutId },
      },
    });
    await syncService.updateLinkedDashboardsUpdatedAtByPageLayoutId({
      pageLayoutId: emptyLayoutId,
      workspaceId: f.workspaceId,
      updatedAt: new Date(),
    });
    expect(await audit()).toHaveLength(0);

    // 3. Transaction error does not throw but records post-rollback failed attempt inside workspace context
    const realRunInTx = h.manager.runInWorkspaceTransaction.bind(h.manager);
    let callCount = 0;
    const failOnceManager = {
      ...h.manager,
      runInWorkspaceTransaction: jest.fn(async (work, options) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('sync db error');
        }
        return realRunInTx(work, options);
      }),
    } as unknown as WorkspaceOrmManager;
    const failingSyncService = new DashboardSyncService(
      failOnceManager,
      flatCache as never,
    );
    await expect(
      failingSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId({
        pageLayoutId: layoutId,
        workspaceId: f.workspaceId,
        updatedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    const failSyncEntries = await audit();
    expect(failSyncEntries).toHaveLength(1);
    expect(failSyncEntries[0].outcome).toBe('failed');
    expect(failSyncEntries[0].action).toBe('update');
    expect(failSyncEntries[0].actor).toEqual({
      kind: 'system',
      id: 'dashboard-sync:update-linked-dashboards',
    });
  });

  it('audits PageLayoutService.destroy -> destroyAssociatedDashboards across HTTP RequestLike, OAuth, impersonation, authUserWorkspaceId, pre-migration fail-closed, post-rollback, and skip flag', async () => {
    const h = makeHarness();
    const buildPageLayoutService = (
      layoutId: string,
      managerOverride?: WorkspaceOrmManager,
    ) => {
      const validateBuildAndRun = jest
        .fn()
        .mockResolvedValue({ status: 'ok' });
      const flatLayout = {
        id: layoutId,
        universalIdentifier: layoutId,
        workspaceId: f.workspaceId,
        type: PageLayoutType.DASHBOARD,
        name: 'Layout',
        deletedAt: null,
      };
      const service = new PageLayoutService(
        managerOverride ?? h.manager,
        { validateBuildAndRunWorkspaceMigration: validateBuildAndRun } as never,
        {
          getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => ({
            flatPageLayoutMaps: {
              byUniversalIdentifier: { [layoutId]: flatLayout },
              universalIdentifierById: { [layoutId]: layoutId },
            },
          })),
        } as never,
        {
          findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
            async () => ({
              workspaceCustomFlatApplication: {
                universalIdentifier: appUniversalId,
              },
            }),
          ),
        } as never,
        {
          updateLinkedDashboardsUpdatedAtByPageLayoutId: jest.fn(),
        } as never,
      );
      return { service, validateBuildAndRun };
    };

    // 1. Real HTTP Express RequestLikeAuditIdentity inside withCrmAuditRequest (user + impersonation) + FK attachment CASCADE + FILES + timelineActivity SET NULL
    const layout1 = randomUUID();
    const dash1 = randomUUID();
    const file1 = await seedFile();
    const att1 = randomUUID();
    const tl1 = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId") VALUES ($1, 'L1', $2)`,
      [dash1, layout1],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."attachment" (id, name, "targetDashboardId", file)
       VALUES ($1, 'l1.pdf', $2, $3::jsonb)`,
      [att1, dash1, JSON.stringify([{ fileId: file1, label: 'l1.pdf' }])],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetDashboardId")
       VALUES ($1, 'l1.ev', $2)`,
      [tl1, dash1],
    );

    const { service: svc1 } = buildPageLayoutService(layout1);
    const httpReq = {
      workspace: { id: f.workspaceId },
      user: { id: userId },
      workspaceMemberId,
      impersonationContext: { impersonatorUserWorkspaceId },
    };
    const httpSnap = captureCrmAuditRequest(httpReq);
    await withCrmAuditRequest(httpSnap, () =>
      svc1.destroy({
        id: layout1,
        workspaceId: f.workspaceId,
        auditIdentity: httpReq,
      }),
    );

    const destroyEntries = await audit();
    expect(new Set(destroyEntries.map((e) => e.operationId)).size).toBe(1);
    expect(
      destroyEntries.map(
        (e) => `${e.resourceKind}:${e.action}:${e.resourceId}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        `crmRecord:delete:${dash1}`,
        `crmRecord:delete:${att1}`,
        `crmRecord:update:${tl1}`,
        `crmFile:update:${file1}`,
      ]),
    );
    expect(destroyEntries[0].actor).toEqual({
      kind: 'workspaceMember',
      id: workspaceMemberId,
    });
    expect(destroyEntries[0].initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });
    expect(destroyEntries[0].correlationId).toBe(httpSnap.correlationId);
    expect(await readIntents()).toHaveLength(1);

    // 2. OAuth client RequestLikeAuditIdentity (user + application) inside withCrmAuditRequest
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const layout2 = randomUUID();
    const dash2 = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId") VALUES ($1, 'L2', $2)`,
      [dash2, layout2],
    );
    const { service: svc2 } = buildPageLayoutService(layout2);
    const oauthReq = {
      workspace: { id: f.workspaceId },
      user: { id: userId },
      workspaceMemberId,
      application: { id: appId },
    };
    const oauthSnap = captureCrmAuditRequest(oauthReq);
    await withCrmAuditRequest(oauthSnap, () =>
      svc2.destroy({
        id: layout2,
        workspaceId: f.workspaceId,
        auditIdentity: oauthReq,
      }),
    );
    const oauthEntries = await audit();
    expect(oauthEntries).toHaveLength(1);
    expect(oauthEntries[0].actor).toEqual({ kind: 'application', id: appId });
    expect(oauthEntries[0].initiator).toEqual({
      kind: 'workspaceMember',
      id: workspaceMemberId,
    });

    // 3. authUserWorkspaceId-only resolves coreUser
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const layout3 = randomUUID();
    const dash3 = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId") VALUES ($1, 'L3', $2)`,
      [dash3, layout3],
    );
    const { service: svc3 } = buildPageLayoutService(layout3);
    await svc3.destroy({
      id: layout3,
      workspaceId: f.workspaceId,
      authUserWorkspaceId: userWorkspaceId,
    });
    const uwEntries = await audit();
    expect(uwEntries).toHaveLength(1);
    expect(uwEntries[0].actor).toEqual({ kind: 'coreUser', id: userId });

    // 4. Conflicting auditIdentity fails closed BEFORE validateBuildAndRunWorkspaceMigration
    const layout4 = randomUUID();
    const { service: svc4, validateBuildAndRun: run4 } =
      buildPageLayoutService(layout4);
    const wrongUserSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: otherUserId },
    });
    await expect(
      withCrmAuditRequest(wrongUserSnap, () =>
        svc4.destroy({
          id: layout4,
          workspaceId: f.workspaceId,
          auditIdentity: { user: { id: userId }, workspaceMemberId },
        }),
      ),
    ).rejects.toThrow('Native audit ambient user conflict');
    expect(run4).not.toHaveBeenCalled();

    // 5. Transaction failure in destroyAssociatedDashboards records failed attempt and rethrows
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const layout5 = randomUUID();
    const realRunInTx = h.manager.runInWorkspaceTransaction.bind(h.manager);
    let txCalls = 0;
    const failFirstManager = {
      ...h.manager,
      runInWorkspaceTransaction: jest.fn(async (work, options) => {
        txCalls += 1;
        if (txCalls === 1) {
          throw new Error('destroy db error');
        }
        return realRunInTx(work, options);
      }),
    } as unknown as WorkspaceOrmManager;
    const { service: svc5 } = buildPageLayoutService(layout5, failFirstManager);
    await expect(
      svc5.destroy({
        id: layout5,
        workspaceId: f.workspaceId,
      }),
    ).rejects.toThrow('destroy db error');
    const failEntries = await audit();
    expect(failEntries).toHaveLength(1);
    expect(failEntries[0].outcome).toBe('failed');
    expect(failEntries[0].action).toBe('delete');
    expect(failEntries[0].actor).toEqual({
      kind: 'system',
      id: 'page-layout:destroy-associated-dashboards',
    });

    // 6. isLinkedDashboardAlreadyDestroyed: true skips destroyAssociatedDashboards
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const layout6 = randomUUID();
    const dash6 = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."dashboard" (id, title, "pageLayoutId") VALUES ($1, 'Keep', $2)`,
      [dash6, layout6],
    );
    const { service: svc6 } = buildPageLayoutService(layout6);
    await svc6.destroy({
      id: layout6,
      workspaceId: f.workspaceId,
      isLinkedDashboardAlreadyDestroyed: true,
    });
    expect(await f.read('dashboard')).toHaveLength(1);
    expect(await audit()).toHaveLength(0);
  });

  it('enforces navigation audit edge invariants: null request fields, system actor under impersonation/unauthenticated request, workspaceMember-to-userWorkspace verification, MembershipCleanupIdentity initiator, cross-workspace, single-use binding, and sibling ambiguity', async () => {
    const systemAuth: WorkspaceAuthContext = {
      type: 'system',
      workspace: { id: f.workspaceId } as never,
    };
    const hSys = makeHarness({ authOverride: systemAuth });

    // 1. Null request fields & empty impersonationContext fall back cleanly to authUserWorkspaceId / defaultSystemActorId
    const nullFallback = captureNativeCrmAuditBindingFromNavigationIdentity({
      workspaceId: f.workspaceId,
      operationId: randomUUID(),
      auditIdentity: {
        user: null,
        apiKey: null,
        application: null,
        impersonationContext: {},
      },
      defaultSystemActorId: 'test:null-fallback',
    });
    expect(nullFallback.operation.actor).toEqual({
      kind: 'system',
      id: 'test:null-fallback',
    });

    // 2. Single-use binding cannot be consumed across two transactions
    await hSys.run(async () => {
      await hSys.manager.runInWorkspaceTransaction(async () => undefined, {
        nativeAuditBinding: nullFallback,
      });
      await expect(
        hSys.manager.runInWorkspaceTransaction(async () => undefined, {
          nativeAuditBinding: nullFallback,
        }),
      ).rejects.toThrow('Native audit binding was already consumed');
    });

    // 3. System MembershipCleanupIdentity works inside impersonated HTTP request, and unauthenticated HTTP request falls back to defaultSystemActorId
    const impSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });
    const sysInImp = withCrmAuditRequest(impSnap, () =>
      captureNativeCrmAuditBindingFromNavigationIdentity({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        auditIdentity: {
          workspaceId: f.workspaceId,
          actor: { kind: 'system', id: 'cleanup:sys' },
          correlationId: impSnap.correlationId,
        },
      }),
    );
    expect(sysInImp.operation.actor).toEqual({
      kind: 'system',
      id: 'cleanup:sys',
    });
    expect(sysInImp.operation.correlationId).toBe(impSnap.correlationId);

    const unauthSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: null,
      apiKey: null,
      application: null,
    });
    const sysInUnauth = withCrmAuditRequest(unauthSnap, () =>
      captureNativeCrmAuditBindingFromNavigationIdentity({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        auditIdentity: { user: null, apiKey: null, application: null },
        defaultSystemActorId: 'test:unauth-fallback',
      }),
    );
    expect(sysInUnauth.operation.actor).toEqual({
      kind: 'system',
      id: 'test:unauth-fallback',
    });
    expect(sysInUnauth.operation.correlationId).toBe(unauthSnap.correlationId);

    // 4. Cross-workspace reqLike.workspace.id fails closed even when no principal fields are set
    expect(() =>
      captureNativeCrmAuditBindingFromNavigationIdentity({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        auditIdentity: { workspace: { id: randomUUID() } },
        defaultSystemActorId: 'test:never',
      }),
    ).toThrow('Native audit workspace mismatch');

    // 5. Mismatched workspaceMemberId vs authUserWorkspaceId fails closed inside withNativeCrmAuditTransaction
    const otherMemberId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."workspaceMember" (id, "userId", "userEmail", "nameFirstName", "nameLastName")
       VALUES ($1, $2, 'other@example.com', 'Other', 'Member')`,
      [otherMemberId, otherUserId],
    );
    const mismatchedMemberBinding =
      captureNativeCrmAuditBindingFromNavigationIdentity({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        auditIdentity: { workspaceMemberId: otherMemberId },
        authUserWorkspaceId: userWorkspaceId,
      });
    await hSys.run(async () => {
      await expect(
        hSys.manager.runInWorkspaceTransaction(async () => undefined, {
          nativeAuditBinding: mismatchedMemberBinding,
        }),
      ).rejects.toThrow('Native audit userWorkspace mismatch');
    });

    // 6. MembershipCleanupIdentity preserves ambient initiator and rejects forged initiator
    const impCorrelationId = randomUUID();
    const preservedInitiator = withCrmAuditIdentity(
      f.workspaceId,
      {
        workspaceId: f.workspaceId,
        actor: { kind: 'coreUser', id: userId },
        initiator: { kind: 'coreUser', id: impersonatorUserId },
        correlationId: impCorrelationId,
      },
      () =>
        captureNativeCrmAuditBindingFromNavigationIdentity({
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          auditIdentity: {
            workspaceId: f.workspaceId,
            actor: { kind: 'coreUser', id: userId },
            correlationId: impCorrelationId,
          },
        }),
    );
    expect(preservedInitiator.operation.initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });

    const appOnlySnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      application: { id: appId },
    });
    expect(() =>
      withCrmAuditRequest(appOnlySnap, () =>
        captureNativeCrmAuditBindingFromNavigationIdentity({
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          auditIdentity: {
            workspaceId: f.workspaceId,
            actor: { kind: 'application', id: appId },
            initiator: { kind: 'coreUser', id: userId },
            correlationId: appOnlySnap.correlationId,
          },
        }),
      ),
    ).toThrow('Native audit ambient initiator conflict');

    // 7. Explicit impersonator inside non-impersonated ambient request & sibling fields on auth fail closed
    const nonImpSnap = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
    });
    expect(() =>
      withCrmAuditRequest(nonImpSnap, () =>
        captureNativeCrmAuditBindingFromNavigationIdentity({
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          auditIdentity: {
            user: { id: userId },
            workspaceMemberId,
            impersonatorUserWorkspaceId,
          },
        }),
      ),
    ).toThrow('Native audit impersonation context conflict');

    expect(() =>
      captureNativeCrmAuditBindingFromNavigationIdentity({
        workspaceId: f.workspaceId,
        operationId: randomUUID(),
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: f.workspaceId },
            workspaceMemberId,
          },
          apiKey: { id: apiKeyId },
        },
      }),
    ).toThrow('Ambiguous navigation audit authentication');
  });
});
