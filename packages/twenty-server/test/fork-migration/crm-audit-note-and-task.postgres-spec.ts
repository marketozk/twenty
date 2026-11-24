import { randomUUID } from 'node:crypto';
import {
  FeatureFlagKey,
  FileFolder,
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
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  registerCrmAuditAlertSink,
  resetCrmAuditHealthStateForTesting,
} from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { FILES_FIELD_HARD_DELETE_INTENT_NAME } from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import {
  runInNativeCrmMergeChildScope,
  runInNativeCrmTargetLifecycleScope,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { RecordShareStorageService } from 'src/engine/core-modules/record-share/services/record-share-storage.service';
import { ShareWithService } from 'src/engine/core-modules/record-share/services/share-with.service';
import { PermissionsExceptionMessage } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { TrashCleanupService } from 'src/engine/trash-cleanup/services/trash-cleanup.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { NotePostQueryHookService } from 'src/modules/note/query-hooks/note-post-query-hook.service';
import { TaskPostQueryHookService } from 'src/modules/task/query-hooks/task-post-query-hook.service';
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
      if (['note', 'task'].includes(object.nameSingular)) {
        object.duplicateCriteria = [['title']];
      }
      if (['company', 'person', 'opportunity'].includes(object.nameSingular)) {
        object.duplicateCriteria = [['name']];
      }
    }
  },
});

const roleId = randomUUID();
const userId = randomUUID();
const userWorkspaceId = randomUUID();
const workspaceMemberId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const apiKeyId = randomUUID();
const appId = randomUUID();
const appUniversalId = randomUUID();

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

const seedOmniConversationTarget = async (
  objectMetadataId: string,
  recordId: string,
) => {
  const connectedAccountId = randomUUID();
  const messageChannelId = randomUUID();
  const bindingId = randomUUID();
  const policyId = randomUUID();
  const threadId = randomUUID();
  const conversationId = randomUUID();

  await f.owner.query('INSERT INTO core."connectedAccount" (id) VALUES ($1)', [
    connectedAccountId,
  ]);
  await f.owner.query(
    `INSERT INTO core."messageChannel" (id, "workspaceId", type) VALUES ($1, $2, 'email')`,
    [messageChannelId, f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAccountBinding" (id, "workspaceId", platform, "connectorInstanceId", "accountId", "connectedAccountId", "messageChannelId", "capabilitiesVersion", capabilities)
     VALUES ($1, $2, 'telegram', 'inst-210', $3, $4, $5, '1', '{}'::jsonb)`,
    [bindingId, f.workspaceId, randomUUID(), connectedAccountId, messageChannelId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAutomationPolicy" (id, "workspaceId", "bindingId") VALUES ($1, $2, $3)`,
    [policyId, f.workspaceId, bindingId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAutomationPolicyVersion" (id, "workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
     VALUES ($1, $2, $3, '0', '{}'::jsonb, $4, '{"kind":"system","id":"fixture"}'::jsonb, now())`,
    [randomUUID(), f.workspaceId, policyId, 'b'.repeat(64)],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"."messageThread" (id) VALUES ($1)`,
    [threadId],
  );
  await f.owner.query(
    `INSERT INTO core."omniConversation" (id, "workspaceId", "bindingId", "providerChatId", "messageThreadId", "policyId", "policyVersion")
     VALUES ($1, $2, $3, $4, $5, $6, '0')`,
    [conversationId, f.workspaceId, bindingId, randomUUID(), threadId, policyId],
  );
  await f.owner.query(
    `INSERT INTO core."omniConversationTarget" (id, "workspaceId", "conversationId", "objectMetadataId", "recordId")
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), f.workspaceId, conversationId, objectMetadataId, recordId],
  );
};

const harness = ({
  authType = 'user',
  permissionOverrides = {},
  wireRealTargetHooks = false,
  recordLevelSharingEnabled = false,
}: {
  authType?: 'user' | 'apiKey' | 'system';
  permissionOverrides?: Record<
    string,
    Partial<{
      canReadObjectRecords: boolean;
      canUpdateObjectRecords: boolean;
      canSoftDeleteObjectRecords: boolean;
      canDestroyObjectRecords: boolean;
    }>
  >;
  wireRealTargetHooks?: boolean;
  recordLevelSharingEnabled?: boolean;
} = {}) => {
  const auth: WorkspaceAuthContext =
    authType === 'apiKey'
      ? {
          type: 'apiKey',
          workspace: { id: f.workspaceId } as never,
          apiKey: { id: apiKeyId } as never,
        }
      : authType === 'system'
        ? {
            type: 'system',
            workspace: { id: f.workspaceId } as never,
          }
        : {
            type: 'user',
            workspace: { id: f.workspaceId } as never,
            user: { id: userId } as never,
            userWorkspaceId,
            workspaceMemberId,
            workspaceMember: { id: workspaceMemberId } as never,
          };

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
    userWorkspaceRoleMap: { [userWorkspaceId]: roleId },
    apiKeyRoleMap: { [apiKeyId]: roleId },
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

  const notePostQueryHookService = new NotePostQueryHookService(manager);
  const taskPostQueryHookService = new TaskPostQueryHookService(manager);

  const hooks = {
    executePreQueryHooks: jest.fn(async (_a, _n, _o, args) => args),
    executePostQueryHooks: jest.fn(
      async (
        hookAuth: WorkspaceAuthContext,
        objectName: string,
        operationName: string,
        payload: unknown,
      ) => {
        if (!wireRealTargetHooks) return;
        const records = Array.isArray(payload) ? payload : [payload];
        if (objectName === 'note') {
          if (operationName === 'deleteOne' || operationName === 'deleteMany') {
            await notePostQueryHookService.handleNoteTargetsDelete(
              hookAuth,
              records as never,
            );
          } else if (
            operationName === 'restoreOne' ||
            operationName === 'restoreMany'
          ) {
            await notePostQueryHookService.handleNoteTargetsRestore(
              hookAuth,
              records as never,
            );
          }
        } else if (objectName === 'task') {
          if (operationName === 'deleteOne' || operationName === 'deleteMany') {
            await taskPostQueryHookService.handleTaskTargetsDelete(
              hookAuth,
              records as never,
            );
          } else if (
            operationName === 'restoreOne' ||
            operationName === 'restoreMany'
          ) {
            await taskPostQueryHookService.handleTaskTargetsRestore(
              hookAuth,
              records as never,
            );
          }
        }
      },
    ),
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

  const makeTrashService = (objectNames: string[]) => {
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
    const objects = objectNames.map((name) =>
      Object.values(base.flatObjectMetadataMaps.byUniversalIdentifier).find(
        (object) => object?.nameSingular === name,
      )!,
    );
    return new TrashCleanupService(
      {
        getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
          flatObjectMetadataMaps: {
            byUniversalIdentifier: Object.fromEntries(
              objects.map((object) => [object.universalIdentifier, object]),
            ),
            universalIdentifierById: Object.fromEntries(
              objects.map((object) => [object.id, object.universalIdentifier]),
            ),
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
    hooks,
    notePostQueryHookService,
    taskPostQueryHookService,
    queryContext,
    createOne,
    createMany,
    updateOne,
    deleteOne,
    deleteMany,
    restoreOne,
    restoreMany,
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
    `GRANT USAGE ON SCHEMA core TO "${f.roleName}";
     GRANT SELECT ON core."user" TO "${f.roleName}";
     GRANT SELECT ON core."userWorkspace" TO "${f.roleName}";
     GRANT SELECT ON core.application TO "${f.roleName}";
     GRANT SELECT, UPDATE, DELETE ON core.file TO "${f.roleName}";
     GRANT SELECT, UPDATE ON core.workspace TO "${f.roleName}";`,
  );

  base = await f.withContext(async () => getWorkspaceContext());
  const attachmentObjId = base.objectIdByNameSingular.attachment;
  attachmentFileFieldUniversalId = Object.values(
    base.flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(
    (field) =>
      field?.objectMetadataId === attachmentObjId && field.name === 'file',
  )!.universalIdentifier;

  runtimeDataSource = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 3, statement_timeout: 10_000 },
  });
  await runtimeDataSource.initialize();
});

afterAll(async () => {
  if (runtimeDataSource?.isInitialized) {
    await runtimeDataSource.destroy();
  }
  await f.dispose();
});

beforeEach(async () => {
  await f.reset();
  resetCrmAuditHealthStateForTesting();
  await f.owner.query('DELETE FROM core.file');
  await f.owner.query('DELETE FROM core.application');
  await f.owner.query('DELETE FROM core."userWorkspace"');
  await f.owner.query('DELETE FROM core."user"');
  await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
  await f.owner.query(
    'DELETE FROM core."omniConversationTarget" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniConversation" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniAutomationPolicyVersion" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniAutomationPolicy" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniAccountBinding" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."messageChannel" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query('DELETE FROM core."connectedAccount"');
  await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

  await f.owner.query(
    'INSERT INTO core.workspace (id, "deletedAt") VALUES ($1, NULL) ON CONFLICT (id) DO UPDATE SET "deletedAt" = NULL',
    [f.workspaceId],
  );
  await f.owner.query(
    'INSERT INTO core."user" (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING',
    [userId, impersonatorUserId],
  );
  await f.owner.query(
    'INSERT INTO core."userWorkspace" (id, "userId", "workspaceId") VALUES ($1, $2, $3), ($4, $5, $3) ON CONFLICT DO NOTHING',
    [
      userWorkspaceId,
      userId,
      f.workspaceId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await f.owner.query(
    'INSERT INTO core.application (id, "workspaceId", "universalIdentifier") VALUES ($1, $2, $3)',
    [appId, f.workspaceId, appUniversalId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"."workspaceMember" (id, "userId", "userEmail", "nameFirstName", "nameLastName")
     VALUES ($1, $2, 'member210@test.local', 'Member', 'One')`,
    [workspaceMemberId, userId],
  );
  f.eventEmitter.mockClear();
  f.recordStock.releaseRecordStock.mockClear();
});

describe('LOG-210 Native CRM audit for note and task plus audited target lifecycle hooks', () => {
  it('audits CREATE (with ShareWithService Branch A), UPDATE (RICH_TEXT privacy), apiKey/system actors, permission denial, and audit rollback on note and task', async () => {
    const hUser = harness({ authType: 'user' });
    const reqSnapshot = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });

    const noteId = randomUUID();
    const taskId = randomUUID();

    // 1. CREATE_ONE note & task under impersonated user with real ShareWithService Branch A.
    await withCrmAuditRequest(reqSnapshot, () =>
      hUser.run(async () => {
        await hUser.createOne.execute(
          {
            data: {
              id: noteId,
              title: 'SECRET_NOTE_TITLE_210',
              bodyV2: {
                markdown: 'SECRET_NOTE_MARKDOWN_210',
                blocknote: '[{"type":"paragraph","content":"SECRET_BLOCK_210"}]',
                tiptap:
                  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"SECRET_TIPTAP_210"}]}]}',
              },
              position: 1,
            },
            selectedFields: { id: true },
          },
          hUser.queryContext('note'),
        );

        await hUser.createOne.execute(
          {
            data: {
              id: taskId,
              title: 'SECRET_TASK_TITLE_210',
              bodyV2: { markdown: 'SECRET_TASK_BODY_210' },
              status: 'TODO',
              dueAt: '2026-12-01T10:00:00.000Z',
              assigneeId: workspaceMemberId,
              position: 1,
            },
            selectedFields: { id: true },
          },
          hUser.queryContext('task'),
        );
      }),
    );

    const createEntries = await audit();
    const noteCreate = createEntries.find(
      (e) => e.resourceKind === 'crmRecord' && e.resourceId === noteId,
    );
    const taskCreate = createEntries.find(
      (e) => e.resourceKind === 'crmRecord' && e.resourceId === taskId,
    );
    expect(noteCreate).toMatchObject({
      action: 'create',
      outcome: 'success',
      actor: { kind: 'workspaceMember', id: workspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: reqSnapshot.correlationId,
    });
    expect(taskCreate).toMatchObject({
      action: 'create',
      outcome: 'success',
      actor: { kind: 'workspaceMember', id: workspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: reqSnapshot.correlationId,
    });

    // Branch A wrote OWNER recordShare rows atomically under the same operationId!
    const shares = (await f.read('recordShare')) as Array<{
      id: string;
      recordId: string;
      rowCause: string;
    }>;
    expect(shares.map((s) => s.recordId).sort()).toEqual([noteId, taskId].sort());
    for (const [recordId, parentOpId] of [
      [noteId, noteCreate!.operationId],
      [taskId, taskCreate!.operationId],
    ]) {
      const shareRow = shares.find((s) => s.recordId === recordId)!;
      expect(
        createEntries.find(
          (e) => e.resourceKind === 'recordShare' && e.resourceId === shareRow.id,
        ),
      ).toMatchObject({
        operationId: parentOpId,
        action: 'create',
        outcome: 'success',
      });
    }

    // 2. UPDATE_ONE on note (bodyV2) under apiKey and on task (status/title) under system.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hApiKey = harness({ authType: 'apiKey' });
    await hApiKey.run(() =>
      hApiKey.updateOne.execute(
        {
          id: noteId,
          data: {
            bodyV2: { markdown: 'SECRET_NOTE_UPDATED_210' },
          },
          selectedFields: { id: true },
        },
        hApiKey.queryContext('note'),
      ),
    );
    const hSystem = harness({ authType: 'system' });
    await hSystem.run(() =>
      hSystem.updateOne.execute(
        {
          id: taskId,
          data: { title: 'SECRET_TASK_UPDATED_210', status: 'IN_PROGRESS' },
          selectedFields: { id: true },
        },
        hSystem.queryContext('task'),
      ),
    );

    const updateEntries = await audit();
    expect(updateEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: 'crmRecord',
          resourceId: noteId,
          action: 'update',
          outcome: 'success',
          actor: { kind: 'apiKey', id: apiKeyId },
        }),
        expect.objectContaining({
          resourceKind: 'crmRecord',
          resourceId: taskId,
          action: 'update',
          outcome: 'success',
          actor: { kind: 'system', id: 'crm-api-update' },
        }),
      ]),
    );

    // Privacy check: zero note/task title or bodyV2 text leaked into crmAuditEntry.
    const serialized = JSON.stringify([...createEntries, ...updateEntries]);
    for (const secret of [
      'SECRET_NOTE_TITLE_210',
      'SECRET_NOTE_MARKDOWN_210',
      'SECRET_BLOCK_210',
      'SECRET_TIPTAP_210',
      'SECRET_TASK_TITLE_210',
      'SECRET_TASK_BODY_210',
      'SECRET_NOTE_UPDATED_210',
      'SECRET_TASK_UPDATED_210',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // 3. Permission denial writes post-rollback denied entry.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hDenied = harness({
      authType: 'user',
      permissionOverrides: { task: { canUpdateObjectRecords: false } },
    });
    await expect(
      hDenied.run(() =>
        hDenied.updateOne.execute(
          { id: taskId, data: { title: 'blocked' }, selectedFields: { id: true } },
          hDenied.queryContext('task'),
        ),
      ),
    ).rejects.toThrow(PermissionsExceptionMessage.PERMISSION_DENIED);
    expect(await audit()).toEqual([
      expect.objectContaining({
        resourceKind: 'crmRecord',
        resourceId: taskId,
        action: 'update',
        outcome: 'denied',
      }),
    ]);

    // 4. Real audit INSERT failure rolls back note update cleanly.
    await f.owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
    );
    try {
      await expect(
        hApiKey.run(() =>
          hApiKey.updateOne.execute(
            {
              id: noteId,
              data: { title: 'must-rollback-title' },
              selectedFields: { id: true },
            },
            hApiKey.queryContext('note'),
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await f.owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
      );
    }
    const [noteRow] = (await f.owner.query(
      `SELECT title FROM "${f.schemaName}".note WHERE id = $1`,
      [noteId],
    )) as Array<{ title: string }>;
    expect(noteRow.title).toBe('SECRET_NOTE_TITLE_210');

    // 5. CREATE_ONE under apiKey (Branch A ROLE share) and under system (0 recordShare rows),
    // UPSERT (mixed update + insert with Branch A), and OPEN company with explicit shareWith.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const apiKeyNoteId = randomUUID();
    await hApiKey.run(() =>
      hApiKey.createOne.execute(
        {
          data: { id: apiKeyNoteId, title: 'api-key-note', position: 2 },
          selectedFields: { id: true },
        },
        hApiKey.queryContext('note'),
      ),
    );
    const apiKeyEntries = await audit();
    const apiKeyNoteEntry = apiKeyEntries.find(
      (e) => e.resourceKind === 'crmRecord' && e.resourceId === apiKeyNoteId,
    );
    expect(apiKeyNoteEntry).toMatchObject({
      action: 'create',
      outcome: 'success',
      actor: { kind: 'apiKey', id: apiKeyId },
    });
    const apiKeyShareRows = (
      (await f.read('recordShare')) as Array<{
        id: string;
        recordId: string;
        targetType: string;
      }>
    ).filter((s) => s.recordId === apiKeyNoteId);
    expect(apiKeyShareRows).toHaveLength(1);
    expect(
      apiKeyEntries.find(
        (e) =>
          e.resourceKind === 'recordShare' &&
          e.resourceId === apiKeyShareRows[0].id,
      ),
    ).toMatchObject({
      operationId: apiKeyNoteEntry!.operationId,
      action: 'create',
      outcome: 'success',
    });

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const sysTaskId = randomUUID();
    await hSystem.run(() =>
      hSystem.createOne.execute(
        {
          data: { id: sysTaskId, title: 'system-task', position: 2 },
          selectedFields: { id: true },
        },
        hSystem.queryContext('task'),
      ),
    );
    const sysEntries = await audit();
    expect(sysEntries).toEqual([
      expect.objectContaining({
        resourceKind: 'crmRecord',
        resourceId: sysTaskId,
        action: 'create',
        outcome: 'success',
        actor: { kind: 'system', id: 'crm-api-create' },
      }),
    ]);

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const upsertedNewNoteId = randomUUID();
    await hUser.run(() =>
      hUser.createMany.execute(
        {
          data: [
            { id: noteId, title: 'SECRET_UPSERT_UPDATE_210', position: 1 },
            {
              id: upsertedNewNoteId,
              title: 'SECRET_UPSERT_INSERT_210',
              position: 3,
            },
          ],
          upsert: true,
          selectedFields: { id: true },
        },
        hUser.queryContext('note'),
      ),
    );
    const upsertEntries = await audit();
    expect(new Set(upsertEntries.map((e) => e.operationId)).size).toBe(1);
    expect(upsertEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: 'crmRecord',
          resourceId: noteId,
          action: 'update',
          outcome: 'success',
        }),
        expect.objectContaining({
          resourceKind: 'crmRecord',
          resourceId: upsertedNewNoteId,
          action: 'create',
          outcome: 'success',
        }),
        expect.objectContaining({
          resourceKind: 'recordShare',
          action: 'create',
          outcome: 'success',
        }),
      ]),
    );

    // Real ShareWithService Branch A on OPEN company with explicit shareWith (B1 end-to-end).
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hSharing = harness({
      authType: 'user',
      recordLevelSharingEnabled: true,
    });
    const sharedCompanyId = randomUUID();
    await hSharing.run(() =>
      hSharing.createOne.execute(
        {
          data: { id: sharedCompanyId, name: 'open-shared-co', position: 1 },
          shareWith: [
            {
              workspaceMemberId,
              accessLevel: RecordShareAccessLevel.READ_WRITE,
            },
          ],
          selectedFields: { id: true },
        },
        hSharing.queryContext('company'),
      ),
    );
    const sharedCoEntries = await audit();
    expect(new Set(sharedCoEntries.map((e) => e.operationId)).size).toBe(1);
    expect(sharedCoEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: 'crmRecord',
          resourceId: sharedCompanyId,
          action: 'create',
          outcome: 'success',
        }),
        expect.objectContaining({
          resourceKind: 'recordShare',
          action: 'create',
          outcome: 'success',
        }),
      ]),
    );
  });

  it('audits DELETE and RESTORE of note/task and transitioning noteTarget/taskTarget via real post-query hooks while preserving database batch events and rolling back on audit failure', async () => {
    const h = harness({ authType: 'user', wireRealTargetHooks: true });
    const companyId = randomUUID();
    const company2Id = randomUUID();
    const company3Id = randomUUID();
    const noteId = randomUUID();
    const activeNoteTargetId = randomUUID();
    const alreadyDeletedNoteTargetId = randomUUID();
    const taskId = randomUUID();
    const activeTaskTargetId = randomUUID();
    const alreadyDeletedTaskTargetId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'co-210'), ($2, 'co-210-2'), ($3, 'co-210-3')`,
      [companyId, company2Id, company3Id],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'note-hook')`,
      [noteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetCompanyId", "deletedAt")
       VALUES ($1, $2, $3, NULL), ($4, $2, $5, '2026-01-01T00:00:00.000Z')`,
      [
        activeNoteTargetId,
        noteId,
        companyId,
        alreadyDeletedNoteTargetId,
        company2Id,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 'task-hook')`,
      [taskId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetCompanyId", "deletedAt")
       VALUES ($1, $2, $3, NULL), ($4, $2, $5, '2026-01-02T00:00:00.000Z')`,
      [
        activeTaskTargetId,
        taskId,
        companyId,
        alreadyDeletedTaskTargetId,
        company2Id,
      ],
    );

    const reqSnapshot = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });

    // 1. DELETE_ONE on note and task: parent + ONLY active target audited with same correlationId & batch events emitted!
    await withCrmAuditRequest(reqSnapshot, () =>
      h.run(async () => {
        await h.deleteOne.execute(
          { id: noteId, selectedFields: { id: true } },
          h.queryContext('note'),
        );
        await h.deleteOne.execute(
          { id: taskId, selectedFields: { id: true } },
          h.queryContext('task'),
        );
      }),
    );

    const deleteEntries = await audit();
    expect(deleteEntries.map((e) => e.resourceId).sort()).toEqual(
      [noteId, activeNoteTargetId, taskId, activeTaskTargetId].sort(),
    );
    for (const entry of deleteEntries) {
      expect(entry).toMatchObject({
        resourceKind: 'crmRecord',
        action: 'update',
        outcome: 'success',
        actor: { kind: 'workspaceMember', id: workspaceMemberId },
        initiator: { kind: 'coreUser', id: impersonatorUserId },
        correlationId: reqSnapshot.correlationId,
      });
    }
    // Already soft-deleted targets kept their original timestamp untouched.
    const [oldNt] = (await f.owner.query(
      `SELECT "deletedAt" FROM "${f.schemaName}"."noteTarget" WHERE id = $1`,
      [alreadyDeletedNoteTargetId],
    )) as Array<{ deletedAt: Date }>;
    expect(oldNt.deletedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    // Database batch events for noteTarget.deleted and taskTarget.deleted were emitted (B3)!
    const deletedEventTargets = f.eventEmitter.mock.calls
      .map((call) => call[0])
      .filter((batch) => batch?.action === DatabaseEventAction.DELETED)
      .map((batch) => batch.objectMetadata?.nameSingular);
    expect(deletedEventTargets).toEqual(
      expect.arrayContaining(['note', 'noteTarget', 'task', 'taskTarget']),
    );

    // 2. RESTORE_ONE on note and task: parent + deleted targets restored and audited, batch events emitted!
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    f.eventEmitter.mockClear();

    // Add a live noteTarget before restore to prove already-live targets produce no spurious audit entry.
    const alreadyLiveNoteTargetId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetCompanyId", "deletedAt")
       VALUES ($1, $2, $3, NULL)`,
      [alreadyLiveNoteTargetId, noteId, company3Id],
    );

    await withCrmAuditRequest(reqSnapshot, () =>
      h.run(async () => {
        await h.restoreOne.execute(
          { id: noteId, selectedFields: { id: true } },
          h.queryContext('note'),
        );
        await h.restoreOne.execute(
          { id: taskId, selectedFields: { id: true } },
          h.queryContext('task'),
        );
      }),
    );

    const restoreEntries = await audit();
    expect(restoreEntries.map((e) => e.resourceId).sort()).toEqual(
      [
        noteId,
        activeNoteTargetId,
        alreadyDeletedNoteTargetId,
        taskId,
        activeTaskTargetId,
        alreadyDeletedTaskTargetId,
      ].sort(),
    );
    expect(
      restoreEntries.some((e) => e.resourceId === alreadyLiveNoteTargetId),
    ).toBe(false);
    const restoredEventTargets = f.eventEmitter.mock.calls
      .map((call) => call[0])
      .filter((batch) => batch?.action === DatabaseEventAction.RESTORED)
      .map((batch) => batch.objectMetadata?.nameSingular);
    expect(restoredEventTargets).toEqual(
      expect.arrayContaining(['note', 'noteTarget', 'task', 'taskTarget']),
    );

    // 3. Audit INSERT failure inside NotePostQueryHookService rolls back noteTarget soft-delete and alerts health.
    const alerts: Array<{ code: string }> = [];
    const unsubscribe = registerCrmAuditAlertSink((event) => {
      alerts.push({ code: event.code });
    });
    await f.owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
    );
    try {
      await expect(
        h.notePostQueryHookService.handleNoteTargetsDelete(h.auth, [
          { id: noteId } as never,
        ]),
      ).rejects.toThrow();
    } finally {
      await f.owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
      );
      unsubscribe();
    }
    const [ntStillLive] = (await f.owner.query(
      `SELECT "deletedAt" FROM "${f.schemaName}"."noteTarget" WHERE id = $1`,
      [activeNoteTargetId],
    )) as Array<{ deletedAt: Date | null }>;
    expect(ntStillLive.deletedAt).toBeNull();
    expect(alerts.some((a) => a.code === 'POST_ROLLBACK_AUDIT_UNAVAILABLE')).toBe(
      true,
    );

    // 4. Malformed payload id fails closed instead of silently dropping records.
    await expect(
      h.notePostQueryHookService.handleNoteTargetsDelete(h.auth, [
        { id: 'not-a-uuid' } as never,
      ]),
    ).rejects.toThrow('Invalid note id in post-query hook payload');
    await expect(
      h.taskPostQueryHookService.handleTaskTargetsRestore(h.auth, [
        { id: '' } as never,
      ]),
    ).rejects.toThrow('Invalid task id in post-query hook payload');

    // 5. DELETE_MANY / RESTORE_MANY (including a targetless note -> 0 target audit rows) and system-actor hooks.
    const emptyNoteId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'no-targets-note')`,
      [emptyNoteId],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const hSysHooks = harness({ authType: 'system', wireRealTargetHooks: true });
    await hSysHooks.run(async () => {
      await hSysHooks.deleteMany.execute(
        {
          filter: { id: { in: [noteId, emptyNoteId] } },
          selectedFields: { id: true },
        },
        hSysHooks.queryContext('note'),
      );
      await hSysHooks.restoreMany.execute(
        {
          filter: { id: { in: [noteId, emptyNoteId] } },
          selectedFields: { id: true },
        },
        hSysHooks.queryContext('note'),
      );
    });
    const bulkEntries = await audit();
    expect(
      bulkEntries.filter(
        (e) =>
          e.resourceId === activeNoteTargetId &&
          e.actor.kind === 'system' &&
          e.actor.id === 'note-targets-post-query-hook',
      ),
    ).toHaveLength(2);
    expect(
      bulkEntries.filter((e) => e.resourceId === emptyNoteId),
    ).toHaveLength(2);

    // 6. Non-audit DB failure inside TaskPostQueryHookService rolls back taskTarget and writes post-rollback failed entry.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await f.owner.query(
      `CREATE OR REPLACE FUNCTION "${f.schemaName}".fail_task_target_update() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'forced_task_target_db_error'; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER trg_fail_task_target_update BEFORE UPDATE ON "${f.schemaName}"."taskTarget"
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".fail_task_target_update()`,
    );
    try {
      await expect(
        hSysHooks.taskPostQueryHookService.handleTaskTargetsDelete(
          hSysHooks.auth,
          [{ id: taskId } as never],
        ),
      ).rejects.toThrow('Data validation error.');
    } finally {
      await f.owner.query(
        `DROP TRIGGER IF EXISTS trg_fail_task_target_update ON "${f.schemaName}"."taskTarget"`,
      );
      await f.owner.query(
        `DROP FUNCTION IF EXISTS "${f.schemaName}".fail_task_target_update()`,
      );
    }
    const [ttStillLive] = (await f.owner.query(
      `SELECT "deletedAt" FROM "${f.schemaName}"."taskTarget" WHERE id = $1`,
      [activeTaskTargetId],
    )) as Array<{ deletedAt: Date | null }>;
    expect(ttStillLive.deletedAt).toBeNull();
    expect(await audit()).toEqual([
      expect.objectContaining({
        resourceKind: 'crmRecord',
        resourceId: base.objectIdByNameSingular.taskTarget,
        action: 'update',
        outcome: 'failed',
        actor: { kind: 'system', id: 'task-targets-post-query-hook' },
      }),
    ]);
  });

  it('audits DESTROY_ONE (with attachment FILES + listener wakeup), MERGE_MANY, TrashCleanupService, and omniConversationTarget protection on note and task', async () => {
    const h = harness({ authType: 'user' });
    const companyId = randomUUID();
    const noteId = randomUUID();
    const noteTargetId = randomUUID();
    const noteAttachmentId = randomUUID();
    const noteFileId = await seedFile();
    const noteTimelineId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'co-dest')`,
      [companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'note-destroy')`,
      [noteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [noteTargetId, noteId, companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetNoteId")
       VALUES ($1, 'note-att', $2::jsonb, $3)`,
      [
        noteAttachmentId,
        JSON.stringify([{ fileId: noteFileId, label: 'n.pdf' }]),
        noteId,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetNoteId")
       VALUES ($1, 'note-tl', $2)`,
      [noteTimelineId, noteId],
    );

    // 1. DESTROY_ONE note: noteTarget CASCADE (delete), attachment & timelineActivity SET NULL (update);
    // attachment's core.file stays intact (UPLOADED) since attachment.targetNote is ON DELETE SET NULL.
    f.eventEmitter.mockClear();
    await h.run(() =>
      h.destroyOne.execute(
        { id: noteId, selectedFields: { id: true } },
        h.queryContext('note'),
      ),
    );
    const destroyEntries = await audit();
    expect(new Set(destroyEntries.map((e) => e.operationId)).size).toBe(1);
    expect(destroyEntries.map((e) => e.resourceId).sort()).toEqual(
      [noteId, noteTargetId, noteAttachmentId, noteTimelineId].sort(),
    );
    expect(
      destroyEntries.find((e) => e.resourceId === noteTargetId)?.action,
    ).toBe('delete');
    expect(
      destroyEntries.find((e) => e.resourceId === noteAttachmentId)?.action,
    ).toBe('update');
    expect(
      destroyEntries.find((e) => e.resourceId === noteTimelineId)?.action,
    ).toBe('update');
    const [noteAttAfter] = (await f.owner.query(
      `SELECT "targetNoteId" FROM "${f.schemaName}".attachment WHERE id = $1`,
      [noteAttachmentId],
    )) as Array<{ targetNoteId: string | null }>;
    expect(noteAttAfter.targetNoteId).toBeNull();
    const [noteFileAfter] = (await f.owner.query(
      'SELECT status, "deletedAt" FROM core.file WHERE id = $1',
      [noteFileId],
    )) as Array<{ status: string; deletedAt: string | null }>;
    expect(noteFileAfter).toEqual({ status: 'UPLOADED', deletedAt: null });

    // 2. MERGE_MANY on task: migrates taskTarget, live attachment (file stays UPLOADED), timelineActivity,
    // and SET NULLs soft-deleted attachment (preserving its core.file since attachment.targetTask is SET NULL).
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const taskPrio = randomUUID();
    const taskDup = randomUUID();
    const taskTargetId = randomUUID();
    const liveAttId = randomUUID();
    const liveFileId = await seedFile();
    const softAttId = randomUUID();
    const softFileId = await seedFile();
    const taskTimelineId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 't-prio'), ($2, 't-dup')`,
      [taskPrio, taskDup],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [taskTargetId, taskDup, companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetTaskId")
       VALUES ($1, 'live-task-att', $2::jsonb, $3)`,
      [liveAttId, JSON.stringify([{ fileId: liveFileId, label: 'a.pdf' }]), taskDup],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetTaskId", "deletedAt")
       VALUES ($1, 'soft-task-att', $2::jsonb, $3, now())`,
      [softAttId, JSON.stringify([{ fileId: softFileId, label: 'b.pdf' }]), taskDup],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetTaskId")
       VALUES ($1, 'task-tl', $2)`,
      [taskTimelineId, taskDup],
    );

    await h.run(() =>
      h.mergeMany.execute(
        {
          ids: [taskPrio, taskDup],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        h.queryContext('task'),
      ),
    );

    const mergeEntries = await audit();
    expect(new Set(mergeEntries.map((e) => e.operationId)).size).toBe(1);
    expect(mergeEntries.every((e) => e.outcome === 'success')).toBe(true);
    for (const migratedId of [taskTargetId, liveAttId, taskTimelineId, softAttId]) {
      expect(mergeEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resourceId: migratedId, action: 'update' }),
        ]),
      );
    }
    const [liveFileRow] = (await f.owner.query(
      'SELECT status, "deletedAt", settings FROM core.file WHERE id = $1',
      [liveFileId],
    )) as Array<{
      status: string;
      deletedAt: string | null;
      settings: { toDelete?: boolean };
    }>;
    expect(liveFileRow).toMatchObject({
      status: 'UPLOADED',
      deletedAt: null,
      settings: expect.objectContaining({ toDelete: false }),
    });

    // 3. TrashCleanupService cleans soft-deleted note & task with targets (CASCADE) and attachment (SET NULL).
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
    const trashNoteId = randomUUID();
    const trashNoteTargetId = randomUUID();
    const trashTaskId = randomUUID();
    const trashTaskAttId = randomUUID();
    const trashTaskFileId = await seedFile();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title, "deletedAt")
       VALUES ($1, 'old-note', NOW() - INTERVAL '40 days')`,
      [trashNoteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [trashNoteTargetId, trashNoteId, companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title, "deletedAt")
       VALUES ($1, 'old-task', NOW() - INTERVAL '40 days')`,
      [trashTaskId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetTaskId")
       VALUES ($1, 'trash-task-att', $2::jsonb, $3)`,
      [
        trashTaskAttId,
        JSON.stringify([{ fileId: trashTaskFileId, label: 'tt.pdf' }]),
        trashTaskId,
      ],
    );

    const trashService = h.makeTrashService(['note', 'task']);
    const deletedCount = await trashService.cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    expect(deletedCount).toBe(2);
    const trashEntries = await audit();
    expect(trashEntries.every((e) => e.actor.id === 'trash_cleanup')).toBe(true);
    expect(trashEntries.map((e) => e.resourceId).sort()).toEqual(
      [
        trashNoteId,
        trashNoteTargetId,
        trashTaskId,
        trashTaskAttId,
      ].sort(),
    );
    expect(await readIntents()).toHaveLength(0);

    // 4. omniConversationTarget on task blocks DESTROY_ONE and records post-rollback denied entry.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const omniTaskId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 'omni-linked-task')`,
      [omniTaskId],
    );
    await seedOmniConversationTarget(base.objectIdByNameSingular.task, omniTaskId);

    await expect(
      h.run(() =>
        h.destroyOne.execute(
          { id: omniTaskId, selectedFields: { id: true } },
          h.queryContext('task'),
        ),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    expect(
      ((await f.read('task')) as Array<ObjectRecord>).some(
        (row) => row.id === omniTaskId,
      ),
    ).toBe(true);
    expect(await audit()).toEqual([
      expect.objectContaining({
        resourceId: omniTaskId,
        outcome: 'denied',
        reasonCode: 'crm.mutation.domain_command_required',
      }),
    ]);
  });

  it('keeps runInNativeCrmTargetLifecycleScope fail-closed for direct writes, non-target FK children, mismatched kinds, nesting, and unproven scopes', async () => {
    const h = harness({ authType: 'user' });
    const companyId = randomUUID();
    const noteId = randomUUID();
    const noteTargetId = randomUUID();
    const attachmentId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'co-guard')`,
      [companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'n-guard')`,
      [noteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [noteTargetId, noteId, companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, "targetCompanyId") VALUES ($1, 'att-guard', $2)`,
      [attachmentId, companyId],
    );

    // 1. Direct softDelete on noteTarget inside nativeAudit without grant fails closed.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('noteTarget', { shouldBypassPermissionChecks: true })
              .softDelete(noteTargetId);
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 2. Using runInNativeCrmTargetLifecycleScope for attachment (not noteTarget/taskTarget) fails closed.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmTargetLifecycleScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.attachment,
                kind: 'soft-delete',
              },
              async () => {
                await scope
                  .getRepository('attachment', {
                    shouldBypassPermissionChecks: true,
                  })
                  .softDelete(attachmentId);
              },
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 3. Mismatched kind (restore under soft-delete grant) and update under soft-delete grant fail closed.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmTargetLifecycleScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.noteTarget,
                kind: 'soft-delete',
              },
              async () => {
                await scope
                  .getRepository('noteTarget', {
                    shouldBypassPermissionChecks: true,
                  })
                  .restore(noteTargetId);
              },
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmTargetLifecycleScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.noteTarget,
                kind: 'soft-delete',
              },
              async () => {
                await scope
                  .getRepository('noteTarget', {
                    shouldBypassPermissionChecks: true,
                  })
                  .update(noteTargetId, { targetCompanyId: null });
              },
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 4. Overlap between mergeChildScope and targetLifecycleScope fails closed.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmMergeChildScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.noteTarget,
                kind: 'soft-delete',
              },
              () =>
                runInNativeCrmTargetLifecycleScope(
                  scope,
                  {
                    objectMetadataId: base.objectIdByNameSingular.noteTarget,
                    kind: 'soft-delete',
                  },
                  async () => undefined,
                ),
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow(
      'Nested native audit target lifecycle scope is unsupported',
    );

    // 5. Unproven plain transaction scope fails closed.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (plainScope) => {
            await runInNativeCrmTargetLifecycleScope(
              plainScope,
              {
                objectMetadataId: base.objectIdByNameSingular.noteTarget,
                kind: 'soft-delete',
              },
              async () => undefined,
            );
          },
          { commitOutcome: 'strict' },
        ),
      ),
    ).rejects.toThrow(
      'Native audit target lifecycle scope requires a proven native audit scope',
    );
  });
});
