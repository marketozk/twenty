import { randomUUID } from 'node:crypto';
import {
  FileFolder,
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataSource } from 'typeorm';

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
  FILES_FIELD_HARD_DELETE_INTENT_NAME,
  reconcileFilesFieldHardDeleteIntentsWithAudit,
} from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { runInNativeCrmMergeChildScope } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { FilesFieldDeletionListener } from 'src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { PermissionsExceptionMessage } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { TrashCleanupService } from 'src/engine/trash-cleanup/services/trash-cleanup.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/run-deferred-workspace-migration-actions-job-name.constant';
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
  'customCase',
  'note',
  'noteTarget',
  'task',
  'taskTarget',
  'attachment',
  'timelineActivity',
  'agentChatThread',
  'agentChatThreadTarget',
  'calendarEvent',
  'calendarEventTarget',
  'calendarEventParticipant',
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
  'messageList',
  'messageListMember',
  'recordShare',
  'workflow',
  'workflowVersion',
  'workflowRun',
  'dashboard',
  'messageCampaign',
]);

const f = createOmniNativeMessageFixture({
  additionalTables: [
    'company',
    'opportunity',
    'customCase',
    'note',
    'noteTarget',
    'task',
    'taskTarget',
    'attachment',
    'timelineActivity',
    'agentChatThread',
    'agentChatThreadTarget',
    'calendarEvent',
    'calendarEventTarget',
    'calendarEventParticipant',
    'messageList',
    'messageListMember',
    'recordShare',
    'workflow',
    'workflowVersion',
    'workflowRun',
    'dashboard',
    'messageCampaign',
  ],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  configureMetadata: (maps) => {
    addCustomCrmMetadata(maps);

    for (const object of Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (!object) continue;
      if (!FIXTURE_ACTIVE_OBJECTS.has(object.nameSingular)) {
        object.isActive = false;
      }
      if (
        ['company', 'person', 'opportunity', 'workflow'].includes(
          object.nameSingular,
        )
      ) {
        object.duplicateCriteria = [['name']];
      }
    }

    // Add a custom morph relation from messageThreadTarget -> customCase so we test
    // omni-owned messageThreadTarget protection on custom-object deletion too.
    const customCase = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'customCase')!;
    const mttObject = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'messageThreadTarget')!;
    const mttTargetCompany = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === mttObject.id &&
        field.name === 'targetCompany',
    )!;
    const mttCustomField = {
      ...mttTargetCompany,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      objectMetadataId: mttObject.id,
      name: 'targetCustomCase',
      label: 'Custom Case',
      relationTargetObjectMetadataId: customCase.id,
      relationTargetFieldMetadataId: null,
      settings: {
        ...(mttTargetCompany.settings as Record<string, unknown>),
        joinColumnName: 'targetCustomCaseId',
      } as typeof mttTargetCompany.settings,
    };
    maps.flatFieldMetadataMaps.byUniversalIdentifier[
      mttCustomField.universalIdentifier
    ] = mttCustomField;
    maps.flatFieldMetadataMaps.universalIdentifierById[mttCustomField.id] =
      mttCustomField.universalIdentifier;
    mttObject.fieldIds = [...mttObject.fieldIds, mttCustomField.id];
    mttObject.fieldUniversalIdentifiers = [
      ...mttObject.fieldUniversalIdentifiers,
      mttCustomField.universalIdentifier,
    ];

    // Add a SET NULL relation from messageParticipant -> customCase so we also
    // exercise setNullBefore omni protection without findOmniProtectedParentIds shortcut.
    const mpObject = Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    ).find((object) => object?.nameSingular === 'messageParticipant')!;
    const mpPersonField = Object.values(
      maps.flatFieldMetadataMaps.byUniversalIdentifier,
    ).find(
      (field) =>
        field?.objectMetadataId === mpObject.id && field.name === 'person',
    )!;
    const mpCustomField = {
      ...mpPersonField,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      objectMetadataId: mpObject.id,
      name: 'targetCustomCase',
      label: 'Custom Case',
      relationTargetObjectMetadataId: customCase.id,
      relationTargetFieldMetadataId: null,
      settings: {
        ...(mpPersonField.settings as Record<string, unknown>),
        joinColumnName: 'targetCustomCaseId',
      } as typeof mpPersonField.settings,
    };
    maps.flatFieldMetadataMaps.byUniversalIdentifier[
      mpCustomField.universalIdentifier
    ] = mpCustomField;
    maps.flatFieldMetadataMaps.universalIdentifierById[mpCustomField.id] =
      mpCustomField.universalIdentifier;
    mpObject.fieldIds = [...mpObject.fieldIds, mpCustomField.id];
    mpObject.fieldUniversalIdentifiers = [
      ...mpObject.fieldUniversalIdentifiers,
      mpCustomField.universalIdentifier,
    ];
  },
});

const roleId = randomUUID();
const userId = randomUUID();
const userWorkspaceId = randomUUID();
const workspaceMemberId = randomUUID();
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
  f.owner.query<Array<{ id: string; name: string; status: string; payload: unknown }>>(
    `SELECT id, name, status, payload FROM core."deferredWorkspaceMigrationAction"
     WHERE "workspaceId" = $1 AND name = $2 ORDER BY id`,
    [f.workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME],
  );

const seedOmniOwned = async () => {
  const connectedAccountId = randomUUID();
  const messageChannelId = randomUUID();
  const bindingId = randomUUID();
  const policyId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
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
     VALUES ($1, $2, 'telegram', 'inst-209', $3, $4, $5, '1', '{}'::jsonb)`,
    [bindingId, f.workspaceId, randomUUID(), connectedAccountId, messageChannelId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAutomationPolicy" (id, "workspaceId", "bindingId") VALUES ($1, $2, $3)`,
    [policyId, f.workspaceId, bindingId],
  );
  await f.owner.query(
    `INSERT INTO core."omniAutomationPolicyVersion" (id, "workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
     VALUES ($1, $2, $3, '0', '{}'::jsonb, $4, '{"kind":"system","id":"fixture"}'::jsonb, now())`,
    [randomUUID(), f.workspaceId, policyId, 'a'.repeat(64)],
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
    `INSERT INTO core."omniConversation" (id, "workspaceId", "bindingId", "providerChatId", "messageThreadId", "policyId", "policyVersion")
     VALUES ($1, $2, $3, $4, $5, $6, '0')`,
    [conversationId, f.workspaceId, bindingId, randomUUID(), threadId, policyId],
  );
  await f.owner.query(
    `INSERT INTO core."omniMessageLink" (id, "workspaceId", "bindingId", "conversationId", "messageId", "rawNativeMessageId", "nativeMessageKey", "nativeMessageKeyVersion", "displayOccurredAt", "displayTimeSource", "immutableAuthorSnapshot", "senderProvenance", "correlationState")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now(), 'source', '{}'::jsonb, 'fixture', 'unresolved')`,
    [
      randomUUID(),
      f.workspaceId,
      bindingId,
      conversationId,
      messageId,
      randomUUID(),
      randomUUID(),
    ],
  );

  return { threadId, messageId, bindingId, conversationId };
};

const seedFile = async () => {
  const fileId = randomUUID();
  const path = `${FileFolder.FilesField}/${attachmentFileFieldUniversalId}/${fileId}.pdf`;
  await f.owner.query(
    `INSERT INTO core.file (id, "workspaceId", "applicationId", path, size, settings, status, "deletedAt")
     VALUES ($1, $2, $3, $4, 512, $5::jsonb, 'UPLOADED', NULL)`,
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

const harness = (
  permissionOverrides: Record<
    string,
    Partial<{
      canReadObjectRecords: boolean;
      canUpdateObjectRecords: boolean;
      canSoftDeleteObjectRecords: boolean;
      canDestroyObjectRecords: boolean;
    }>
  > = {},
) => {
  const auth: WorkspaceAuthContext = {
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
      coreDataSource: f.owner,
    },
    authContext: auth,
    objectPermissionsByRoleId: permissions,
  });
  const manager = {
    executeInWorkspaceContext: <T>(fn: () => Promise<T>) =>
      withWorkspaceContext(context, fn),
    getGlobalWorkspaceDataSource: async () => dataSource,
    runInWorkspaceTransaction: dataSource.transaction.bind(dataSource),
    getRepository: jest.fn(dataSource.getRepository.bind(dataSource)),
  } as unknown as WorkspaceOrmManager;

  const hooks = {
    executePreQueryHooks: jest.fn(async (_a, _n, _o, args) => args),
    executePostQueryHooks: jest.fn(async () => undefined),
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
      twentyConfigService: { get: () => 10_000 },
      metricsService: { incrementCounterBy: jest.fn() },
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
    const systemOrm = {
      executeInWorkspaceContext: <T>(fn: () => Promise<T>) =>
        withWorkspaceContext(systemContext, fn),
      getGlobalWorkspaceDataSource: async () => systemDataSource,
      runInWorkspaceTransaction:
        systemDataSource.transaction.bind(systemDataSource),
    } as unknown as WorkspaceOrmManager;
    const byUid: Record<string, unknown> = {};
    for (const name of objectNames) {
      const obj = Object.values(
        base.flatObjectMetadataMaps.byUniversalIdentifier,
      ).find((item) => item?.nameSingular === name)!;
      byUid[obj.universalIdentifier] = obj;
    }
    return new TrashCleanupService(
      {
        getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
          flatObjectMetadataMaps: { byUniversalIdentifier: byUid },
        }),
      } as never,
      systemOrm,
    );
  };

  return {
    dataSource,
    queryContext,
    destroyOne,
    destroyMany,
    mergeMany,
    makeTrashService,
    run: <T>(fn: () => Promise<T>) => withWorkspaceContext(context, fn),
  };
};

beforeAll(async () => {
  await f.initialize();
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
  await f.owner.query(
    `DROP TABLE IF EXISTS "${f.schemaName}".transitive_attachment_child`,
  );
  await f.owner.query('DELETE FROM core.file');
  await f.owner.query('DELETE FROM core.application');
  await f.owner.query('DELETE FROM core."deferredWorkspaceMigrationAction"');
  await f.owner.query(
    'DELETE FROM core."omniMessageLink" WHERE "workspaceId" = $1',
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
    `INSERT INTO core.workspace (id, "deletedAt") VALUES ($1, NULL)
     ON CONFLICT (id) DO UPDATE SET "deletedAt" = NULL`,
    [f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier") VALUES ($1, $2, $3)`,
    [appId, f.workspaceId, appUniversalId],
  );
});

describe('LOG-209 Extended FK coverage for 10 standard system child tables in DESTROY, MERGE_MANY and TrashCleanupService', () => {
  it('audits CASCADE and SET NULL across all 10 standard child tables on DESTROY including attachment FILES hard-delete', async () => {
    const h = harness();
    const personId = randomUUID();
    const opportunityId = randomUUID();
    const noteId = randomUUID();
    const noteTargetId = randomUUID();
    const taskId = randomUUID();
    const taskTargetId = randomUUID();
    const attachmentId = randomUUID();
    const attachmentFileId = await seedFile();
    const timelineCascadeId = randomUUID();
    const timelineSetNullId = randomUUID();
    const agentThreadId = randomUUID();
    const agentThreadTargetId = randomUUID();
    const calEventId = randomUUID();
    const calEventTargetId = randomUUID();
    const calEventParticipantId = randomUUID();
    const msgThreadId = randomUUID();
    const msgId = randomUUID();
    const msgThreadTargetId = randomUUID();
    const msgParticipantId = randomUUID();
    const msgListId = randomUUID();
    const msgListMemberId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "nameFirstName") VALUES ($1, 'SECRET_PERSON_209')`,
      [personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".opportunity (id, name) VALUES ($1, 'SECRET_OPP_209')`,
      [opportunityId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'note-1')`,
      [noteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetPersonId") VALUES ($1, $2, $3)`,
      [noteTargetId, noteId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 'task-1')`,
      [taskId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetPersonId") VALUES ($1, $2, $3)`,
      [taskTargetId, taskId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetPersonId") VALUES ($1, 'SECRET_DOC_209', $2::jsonb, $3)`,
      [
        attachmentId,
        JSON.stringify([{ fileId: attachmentFileId, label: 'secret-att.pdf' }]),
        personId,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetPersonId") VALUES ($1, 'SECRET_EVENT_209', $2)`,
      [timelineCascadeId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetOpportunityId") VALUES ($1, 'OPP_EVENT_209', $2)`,
      [timelineSetNullId, opportunityId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."agentChatThread" (id, title) VALUES ($1, 'chat-1')`,
      [agentThreadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."agentChatThreadTarget" (id, "threadId", "targetPersonId") VALUES ($1, $2, $3)`,
      [agentThreadTargetId, agentThreadId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."calendarEvent" (id, title) VALUES ($1, 'cal-1')`,
      [calEventId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."calendarEventTarget" (id, "calendarEventId", "targetPersonId") VALUES ($1, $2, $3)`,
      [calEventTargetId, calEventId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."calendarEventParticipant" (id, "calendarEventId", "personId", handle) VALUES ($1, $2, $3, 'SECRET_HANDLE_209@test.local')`,
      [calEventParticipantId, calEventId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThread" (id) VALUES ($1)`,
      [msgThreadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".message (id, "messageThreadId") VALUES ($1, $2)`,
      [msgId, msgThreadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThreadTarget" (id, "messageThreadId", "targetPersonId") VALUES ($1, $2, $3)`,
      [msgThreadTargetId, msgThreadId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", "personId", role, handle) VALUES ($1, $2, $3, 'FROM', 'SECRET_MAIL_209@test.local')`,
      [msgParticipantId, msgId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageList" (id, name) VALUES ($1, 'list-1')`,
      [msgListId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageListMember" (id, "listId", "personId") VALUES ($1, $2, $3)`,
      [msgListMemberId, msgListId, personId],
    );

    // 1. Destroy person: triggers 8 CASCADE deletes + 2 SET NULL updates + attachment FILES retirement.
    await h.destroyOne.execute(
      { id: personId, selectedFields: { id: true } },
      h.queryContext('person'),
    );

    const personEntries = await audit();
    expect(new Set(personEntries.map((e) => e.operationId)).size).toBe(1);
    const byId = new Map(personEntries.map((e) => [e.resourceId, e]));
    for (const cascadedId of [
      personId,
      noteTargetId,
      taskTargetId,
      attachmentId,
      timelineCascadeId,
      agentThreadTargetId,
      calEventTargetId,
      msgThreadTargetId,
      msgListMemberId,
    ]) {
      expect(byId.get(cascadedId)).toMatchObject({
        resourceKind: 'crmRecord',
        action: 'delete',
        outcome: 'success',
        securityDescriptor: expect.objectContaining({
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        }),
      });
    }
    for (const setNullId of [calEventParticipantId, msgParticipantId]) {
      expect(byId.get(setNullId)).toMatchObject({
        resourceKind: 'crmRecord',
        action: 'update',
        outcome: 'success',
      });
    }
    expect(byId.get(attachmentFileId)).toMatchObject({
      resourceKind: 'crmFile',
      action: 'update',
      outcome: 'success',
      securityDescriptor: expect.objectContaining({
        fileParent: expect.objectContaining({
          objectMetadataId: base.objectIdByNameSingular.attachment,
          recordId: attachmentId,
        }),
      }),
    });

    // Privacy check: no private strings leaked into crmAuditEntry.
    const serialized = JSON.stringify(personEntries);
    expect(serialized).not.toContain('SECRET_PERSON_209');
    expect(serialized).not.toContain('SECRET_DOC_209');
    expect(serialized).not.toContain('SECRET_EVENT_209');
    expect(serialized).not.toContain('SECRET_HANDLE_209');
    expect(serialized).not.toContain('SECRET_MAIL_209');

    // Durable file hard-delete intent created and reconciled cleanly.
    expect(await readIntents()).toHaveLength(1);
    const reconciled = await reconcileFilesFieldHardDeleteIntentsWithAudit({
      coreDataSource: runtimeDataSource,
      workspaceId: f.workspaceId,
      deleteFileObject: async () => undefined,
      releaseStorageStock: async () => undefined,
    });
    expect(reconciled).toMatchObject({ deletedFiles: 1, completedIntents: 1 });
    expect(
      await f.owner.query('SELECT id FROM core.file WHERE id = $1', [
        attachmentFileId,
      ]),
    ).toHaveLength(0);

    // 2. Destroy opportunity: timelineActivity SET NULL audited under same operationId.
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await h.destroyOne.execute(
      { id: opportunityId, selectedFields: { id: true } },
      h.queryContext('opportunity'),
    );
    const oppEntries = await audit();
    expect(new Set(oppEntries.map((e) => e.operationId)).size).toBe(1);
    expect(oppEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: opportunityId,
          action: 'delete',
          outcome: 'success',
        }),
        expect.objectContaining({
          resourceId: timelineSetNullId,
          action: 'update',
          outcome: 'success',
        }),
      ]),
    );
    const remainingTimeline = (await f.read('timelineActivity')) as Array<{
      id: string;
      targetOpportunityId: string | null;
    }>;
    expect(remainingTimeline).toEqual([
      expect.objectContaining({
        id: timelineSetNullId,
        targetOpportunityId: null,
      }),
    ]);

    // 3. Company (no own FILES fields) destroyed with cascaded attachment.file:
    // FilesFieldDeletionListener.handleDestroyedEvent wakes workspaceQueue and skips legacy deleteCascadeQueue.
    const companyId = randomUUID();
    const companyAttachmentId = randomUUID();
    const companyAttachmentFileId = await seedFile();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'co-files-wake')`,
      [companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetCompanyId")
       VALUES ($1, 'co-att', $2::jsonb, $3)`,
      [
        companyAttachmentId,
        JSON.stringify([{ fileId: companyAttachmentFileId, label: 'co.pdf' }]),
        companyId,
      ],
    );
    f.eventEmitter.mockClear();
    await h.destroyOne.execute(
      { id: companyId, selectedFields: { id: true } },
      h.queryContext('company'),
    );
    const emittedCompanyDestroyed = f.eventEmitter.mock.calls
      .map((call) => call[0])
      .find(
        (batch) =>
          batch?.objectMetadata?.nameSingular === 'company' &&
          batch?.action === DatabaseEventAction.DESTROYED,
      );
    expect(emittedCompanyDestroyed).toBeDefined();

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
    await listener.handleDestroyedEvent({
      workspaceId: f.workspaceId,
      name: `company.${DatabaseEventAction.DESTROYED}`,
      objectMetadata: emittedCompanyDestroyed.objectMetadata,
      events: emittedCompanyDestroyed.events,
    });
    expect(workspaceQueueAdd).toHaveBeenCalledWith(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId: f.workspaceId },
      expect.any(Object),
    );
    expect(deleteCascadeAdd).not.toHaveBeenCalled();

    const reconciledCompany = await reconcileFilesFieldHardDeleteIntentsWithAudit({
      coreDataSource: runtimeDataSource,
      workspaceId: f.workspaceId,
      deleteFileObject: async () => undefined,
      releaseStorageStock: async () => undefined,
    });
    expect(reconciledCompany).toMatchObject({
      deletedFiles: 1,
      completedIntents: 1,
    });
  });

  it('blocks deletion when a standard or custom object references omni-owned messageThreadTarget or messageParticipant', async () => {
    const h = harness();
    const omni = await seedOmniOwned();
    const personId = randomUUID();
    const customCaseCascadeId = randomUUID();
    const customCaseSetNullId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "nameFirstName") VALUES ($1, 'omni-person')`,
      [personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", "personId", role, handle)
       VALUES ($1, $2, $3, 'FROM', 'omni@test.local')`,
      [randomUUID(), omni.messageId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."_customCase" (id, name) VALUES ($1, 'omni-case-cascade'), ($2, 'omni-case-setnull')`,
      [customCaseCascadeId, customCaseSetNullId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThreadTarget" (id, "messageThreadId", "targetCustomCaseId")
       VALUES ($1, $2, $3)`,
      [randomUUID(), omni.threadId, customCaseCascadeId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", "targetCustomCaseId", role, handle)
       VALUES ($1, $2, $3, 'TO', 'omni-setnull@test.local')`,
      [randomUUID(), omni.messageId, customCaseSetNullId],
    );

    // Person with omni-owned messageParticipant refuses via parent guard.
    await expect(
      h.destroyOne.execute(
        { id: personId, selectedFields: { id: true } },
        h.queryContext('person'),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    expect(
      ((await f.read('person')) as Array<{ id: string }>).some(
        (row) => row.id === personId,
      ),
    ).toBe(true);

    // Custom object with omni-owned messageThreadTarget refuses via prepareNativeCrmDeleteEffects cascade guard.
    await expect(
      h.destroyOne.execute(
        { id: customCaseCascadeId, selectedFields: { id: true } },
        h.queryContext('customCase'),
      ),
    ).rejects.toThrow('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
    expect(
      ((await f.read('_customCase')) as Array<{ id: string }>).some(
        (row) => row.id === customCaseCascadeId,
      ),
    ).toBe(true);

    // Custom object with omni-owned messageParticipant (SET NULL) refuses via setNullBefore guard.
    await expect(
      h.destroyOne.execute(
        { id: customCaseSetNullId, selectedFields: { id: true } },
        h.queryContext('customCase'),
      ),
    ).rejects.toThrow('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
    expect(
      ((await f.read('_customCase')) as Array<{ id: string }>).some(
        (row) => row.id === customCaseSetNullId,
      ),
    ).toBe(true);

    const entries = await audit();
    expect(entries.filter((e) => e.outcome === 'success')).toHaveLength(0);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.reasonCode)).toEqual([
      'crm.mutation.domain_command_required',
      'crm.mutation.domain_command_required',
      'crm.mutation.domain_command_required',
    ]);
  });

  it('audits MERGE_MANY migration, duplicate soft-delete + CASCADE, soft-deleted attachment FILES retirement, and blocks omni-owned child merge', async () => {
    const h = harness();
    const cPrio = randomUUID();
    const cDup = randomUUID();
    const sharedTaskId = randomUUID();
    const uniqueTaskId = randomUUID();
    const prioTaskTargetId = randomUUID();
    const dupSharedTaskTargetId = randomUUID();
    const dupUniqueTaskTargetId = randomUUID();
    const liveAttachmentId = randomUUID();
    const liveAttachmentFileId = await seedFile();
    const softDeletedAttachmentId = randomUUID();
    const softAttachmentFileId = await seedFile();
    const timelineId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'prio-co'), ($2, 'dup-co')`,
      [cPrio, cDup],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 'shared-task'), ($2, 'unique-task')`,
      [sharedTaskId, uniqueTaskId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetCompanyId")
       VALUES ($1, $2, $3), ($4, $2, $5), ($6, $7, $5)`,
      [
        prioTaskTargetId,
        sharedTaskId,
        cPrio,
        dupSharedTaskTargetId,
        cDup,
        dupUniqueTaskTargetId,
        uniqueTaskId,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetCompanyId")
       VALUES ($1, 'live-att', $2::jsonb, $3)`,
      [
        liveAttachmentId,
        JSON.stringify([{ fileId: liveAttachmentFileId, label: 'live.pdf' }]),
        cDup,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetCompanyId", "deletedAt")
       VALUES ($1, 'soft-att', $2::jsonb, $3, now())`,
      [
        softDeletedAttachmentId,
        JSON.stringify([{ fileId: softAttachmentFileId, label: 'old.pdf' }]),
        cDup,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetCompanyId")
       VALUES ($1, 'activity-1', $2)`,
      [timelineId, cDup],
    );

    await h.mergeMany.execute(
      { ids: [cPrio, cDup], conflictPriorityIndex: 0, selectedFields: { id: true } },
      h.queryContext('company'),
    );

    const entries = await audit();
    expect(new Set(entries.map((e) => e.operationId)).size).toBe(1);
    expect(entries.every((e) => e.outcome === 'success')).toBe(true);
    // Migrated unique taskTarget, live attachment, timelineActivity -> update
    for (const migratedId of [
      dupUniqueTaskTargetId,
      liveAttachmentId,
      timelineId,
    ]) {
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceId: migratedId,
            action: 'update',
          }),
        ]),
      );
    }
    // Live attachment's file stays intact (UPLOADED, not deleted, no crmFile audit, no intent).
    const [liveFileRow] = (await f.owner.query(
      'SELECT status, "deletedAt", settings FROM core.file WHERE id = $1',
      [liveAttachmentFileId],
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
    expect(
      entries.some((e) => e.resourceId === liveAttachmentFileId),
    ).toBe(false);

    // Colliding shared taskTarget -> soft-delete (update) + CASCADE (delete)
    expect(
      entries.filter((e) => e.resourceId === dupSharedTaskTargetId).map((e) => e.action).sort(),
    ).toEqual(['delete', 'update']);
    // Soft-deleted attachment -> CASCADE delete + crmFile:update + durable intent
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: softDeletedAttachmentId,
          action: 'delete',
        }),
        expect.objectContaining({
          resourceKind: 'crmFile',
          resourceId: softAttachmentFileId,
          action: 'update',
        }),
      ]),
    );
    expect(await readIntents()).toHaveLength(1);

    // MERGE_MANY with omni-owned messageThreadTarget on duplicate company must fail closed
    // and emit post-rollback denied audit entry.
    const cPrio2 = randomUUID();
    const cDup2 = randomUUID();
    const omni = await seedOmniOwned();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'p2'), ($2, 'd2')`,
      [cPrio2, cDup2],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThreadTarget" (id, "messageThreadId", "targetCompanyId")
       VALUES ($1, $2, $3)`,
      [randomUUID(), omni.threadId, cDup2],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    await expect(
      h.mergeMany.execute(
        { ids: [cPrio2, cDup2], conflictPriorityIndex: 0, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === cDup2,
      ),
    ).toBe(true);
    const mergeDeniedEntries = await audit();
    expect(
      mergeDeniedEntries.filter((e) => e.outcome === 'success'),
    ).toHaveLength(0);
    expect(mergeDeniedEntries).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        reasonCode: 'crm.mutation.domain_command_required',
      }),
    ]);
  });

  it('cleans soft-deleted person with noteTarget, attachment FILES, timelineActivity and non-omni messageParticipant through TrashCleanupService', async () => {
    const h = harness();
    const personId = randomUUID();
    const noteId = randomUUID();
    const noteTargetId = randomUUID();
    const attachmentId = randomUUID();
    const fileId = await seedFile();
    const timelineId = randomUUID();
    const msgThreadId = randomUUID();
    const msgId = randomUUID();
    const msgParticipantId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".person (id, "nameFirstName", "deletedAt")
       VALUES ($1, 'old-person', NOW() - INTERVAL '40 days')`,
      [personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".note (id, title) VALUES ($1, 'n1')`,
      [noteId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."noteTarget" (id, "noteId", "targetPersonId") VALUES ($1, $2, $3)`,
      [noteTargetId, noteId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, file, "targetPersonId")
       VALUES ($1, 'trash-att', $2::jsonb, $3)`,
      [
        attachmentId,
        JSON.stringify([{ fileId, label: 'trash-att.pdf' }]),
        personId,
      ],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetPersonId") VALUES ($1, 'tl1', $2)`,
      [timelineId, personId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageThread" (id) VALUES ($1)`,
      [msgThreadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".message (id, "messageThreadId") VALUES ($1, $2)`,
      [msgId, msgThreadId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."messageParticipant" (id, "messageId", "personId", role, handle)
       VALUES ($1, $2, $3, 'FROM', 'plain@test.local')`,
      [msgParticipantId, msgId, personId],
    );

    const trashService = h.makeTrashService(['person']);
    const deletedCount = await trashService.cleanupWorkspaceTrash({
      workspaceId: f.workspaceId,
      trashRetentionDays: 14,
    });
    expect(deletedCount).toBe(1);
    expect(await f.read('person')).toHaveLength(0);

    const entries = await audit();
    expect(entries.every((e) => e.actor.id === 'trash_cleanup')).toBe(true);
    expect(entries.map((e) => e.resourceId).sort()).toEqual(
      [
        personId,
        noteTargetId,
        attachmentId,
        fileId,
        timelineId,
        msgParticipantId,
      ].sort(),
    );
    expect(await readIntents()).toHaveLength(1);
  });

  it('keeps direct writes on FK child tables, non-FK merge child edits, and transitive child FKs fail-closed', async () => {
    const h = harness();
    const companyId = randomUUID();
    const attachmentId = randomUUID();
    const taskId = randomUUID();
    const taskTargetId = randomUUID();

    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'c-guard')`,
      [companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".attachment (id, name, "targetCompanyId") VALUES ($1, 'att-guard', $2)`,
      [attachmentId, companyId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".task (id, title) VALUES ($1, 't-guard')`,
      [taskId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."taskTarget" (id, "taskId", "targetCompanyId") VALUES ($1, $2, $3)`,
      [taskTargetId, taskId, companyId],
    );

    // 1. Direct update on attachment inside nativeAudit scope is still rejected.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('attachment', { shouldBypassPermissionChecks: true })
              .update(attachmentId, { name: 'forbidden' });
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 2. Modifying a non-FK column inside runInNativeCrmMergeChildScope is rejected.
    const otherCompanyId = randomUUID();
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmMergeChildScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.attachment,
                kind: 'update',
                allowedJoinColumnName: 'targetCompanyId',
                allowedTargetRecordId: otherCompanyId,
              },
              async () => {
                await scope
                  .getRepository('attachment', {
                    shouldBypassPermissionChecks: true,
                  })
                  .update(attachmentId, { name: 'forbidden-in-merge' });
              },
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 3. Narrow grant enforcement: wrong targetRecordId, null join value, and update under soft-delete grant are rejected.
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await runInNativeCrmMergeChildScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.taskTarget,
                kind: 'update',
                allowedJoinColumnName: 'targetCompanyId',
                allowedTargetRecordId: otherCompanyId,
              },
              async () => {
                await scope
                  .getRepository('taskTarget', {
                    shouldBypassPermissionChecks: true,
                  })
                  .update(taskTargetId, { targetCompanyId: null });
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
            await runInNativeCrmMergeChildScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.taskTarget,
                kind: 'update',
                allowedJoinColumnName: 'targetCompanyId',
                allowedTargetRecordId: otherCompanyId,
              },
              async () => {
                await scope
                  .getRepository('taskTarget', {
                    shouldBypassPermissionChecks: true,
                  })
                  .update(taskTargetId, { targetCompanyId: randomUUID() });
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
            await runInNativeCrmMergeChildScope(
              scope,
              {
                objectMetadataId: base.objectIdByNameSingular.taskTarget,
                kind: 'soft-delete',
              },
              async () => {
                await scope
                  .getRepository('taskTarget', {
                    shouldBypassPermissionChecks: true,
                  })
                  .update(taskTargetId, { targetCompanyId: otherCompanyId });
              },
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');

    // 4. Uncovered parent MERGE_MANY (workflow with live timelineActivity) inside proven outer nativeAudit scope fails closed
    // through both CommonBaseQueryRunnerService.execute and direct CommonMergeManyQueryRunnerService.run (isCoveredTargetObject === false).
    const workflowPrioId = randomUUID();
    const workflowDupId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".workflow (id, name) VALUES ($1, 'wf-prio'), ($2, 'wf-dup')`,
      [workflowPrioId, workflowDupId],
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}"."timelineActivity" (id, "linkedRecordCachedName", "targetWorkflowId") VALUES ($1, 'wf-tl', $2)`,
      [randomUUID(), workflowDupId],
    );
    await expect(
      h.run(() =>
        h.dataSource.transaction(
          async (scope) => {
            await h.mergeMany.execute(
              {
                ids: [workflowPrioId, workflowDupId],
                conflictPriorityIndex: 0,
                selectedFields: { id: true },
              },
              h.queryContext('workflow', scope),
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
            await h.mergeMany.run(
              {
                ids: [workflowPrioId, workflowDupId],
                conflictPriorityIndex: 0,
                selectedFieldsResult: {
                  select: { id: true },
                  relations: {},
                  aggregate: {},
                },
              } as never,
              {
                ...h.queryContext('workflow', scope),
                rolePermissionConfig: {
                  intersectionOf: { userWorkspaceRoleId: roleId },
                },
                repository: scope.getRepository('workflow', {
                  shouldBypassPermissionChecks: true,
                }),
                featureFlagsMap: base.featureFlagsMap,
                commonQueryParser: {} as never,
              } as never,
            );
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('Native audit coverage excludes this object or mutation');
    expect(
      ((await f.read('workflow')) as Array<{ id: string }>).some(
        (row) => row.id === workflowDupId,
      ),
    ).toBe(true);

    // 5. RBAC on child table is still enforced during MERGE_MANY when canUpdateObjectRecords is false.
    const restrictedHarness = harness({
      taskTarget: { canUpdateObjectRecords: false },
    });
    const rbacCompanyPrio = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'c-rbac-prio')`,
      [rbacCompanyPrio],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await expect(
      restrictedHarness.mergeMany.execute(
        {
          ids: [rbacCompanyPrio, companyId],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        restrictedHarness.queryContext('company'),
      ),
    ).rejects.toThrow(PermissionsExceptionMessage.PERMISSION_DENIED);
    expect(
      ((await f.read('company')) as Array<{ id: string }>).some(
        (row) => row.id === companyId,
      ),
    ).toBe(true);
    const rbacAuditEntries = await audit();
    expect(
      rbacAuditEntries.filter((e) => e.outcome === 'success'),
    ).toHaveLength(0);
    expect(rbacAuditEntries).toEqual([
      expect.objectContaining({
        outcome: 'denied',
      }),
    ]);

    // 6. Transitive FK referencing a covered child (attachment) still fails closed.
    await f.owner.query(
      `CREATE TABLE "${f.schemaName}".transitive_attachment_child (
         id uuid PRIMARY KEY,
         attachment_id uuid NOT NULL REFERENCES "${f.schemaName}".attachment(id) ON DELETE CASCADE
       );
       GRANT SELECT, INSERT, UPDATE, DELETE ON "${f.schemaName}".transitive_attachment_child TO "${f.roleName}";`,
    );
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".transitive_attachment_child (id, attachment_id) VALUES ($1, $2)`,
      [randomUUID(), attachmentId],
    );

    await expect(
      h.destroyOne.execute(
        { id: companyId, selectedFields: { id: true } },
        h.queryContext('company'),
      ),
    ).rejects.toThrow('Native delete excludes transitive foreign-key effects');
    expect(
      ((await f.read('company')) as Array<ObjectRecord>).some(
        (row) => row.id === companyId,
      ),
    ).toBe(true);
    expect((await audit()).filter((e) => e.outcome === 'success')).toHaveLength(
      0,
    );
  });
});
