import { randomUUID } from 'node:crypto';
import {
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonCreateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service';
import { CommonCreateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-one-query-runner.service';
import { CommonDeleteManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-delete-many-query-runner.service';
import { CommonDestroyManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service';
import { CommonDestroyOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service';
import { CommonMergeManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-merge-many-query-runner.service';
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
import { copyMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  captureNativeCrmAuditBinding,
  captureNativeCrmAuditOperation,
  withNativeCrmAuditTransaction,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { runAuditedShareWithInsert } from 'src/engine/core-modules/crm-audit/record-share-audit';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { CreateManyRecordsService } from 'src/engine/core-modules/record-crud/services/create-many-records.service';
import { CreateRecordService } from 'src/engine/core-modules/record-crud/services/create-record.service';
import { DeleteManyRecordsService } from 'src/engine/core-modules/record-crud/services/delete-many-records.service';
import { UpdateManyRecordsService } from 'src/engine/core-modules/record-crud/services/update-many-records.service';
import { UpdateRecordService } from 'src/engine/core-modules/record-crud/services/update-record.service';
import { UpsertManyRecordsService } from 'src/engine/core-modules/record-crud/services/upsert-many-records.service';
import { UpsertRecordService } from 'src/engine/core-modules/record-crud/services/upsert-record.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { type ShareWithService } from 'src/engine/core-modules/record-share/services/share-with.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
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
jest.mock(
  'src/engine/core-modules/record-crud/services/common-api-context-builder.service',
  () => ({ CommonApiContextBuilderService: class {} }),
);

const FIXTURE_ACTIVE_OBJECTS = new Set([
  'company',
  'person',
  'opportunity',
  'recordShare',
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
]);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity', 'recordShare'],
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
      if (object.nameSingular === 'company') {
        object.duplicateCriteria = [['name']];
      }
    }
  },
});

const companyId1 = randomUUID();
const companyId2 = randomUUID();
const memberId = randomUUID();
const userId = randomUUID();
const userWorkspaceId = randomUUID();
const sameWsImpersonatorUwId = randomUUID();
const sameWsImpersonatorUserId = randomUUID();
const crossWsImpersonatorUwId = randomUUID();
const crossWsImpersonatorUserId = randomUUID();
const deletedImpersonatorUwId = randomUUID();
const apiKeyId = randomUUID();
const appId = randomUUID();
const agentId = randomUUID();
const roleId = randomUUID();
const bypass = { shouldBypassPermissionChecks: true as const };
let base: ReturnType<typeof getWorkspaceContext>;

const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

type AuthSpec =
  | {
      kind: 'user';
      userId?: string;
      memberId?: string;
      viaApplicationId?: string;
      applicationId?: string;
      agentId?: string;
    }
  | { kind: 'apiKey'; id?: string }
  | {
      kind: 'application';
      id?: string;
      actingAgentId?: string;
      agentId?: string;
    }
  | { kind: 'system' };

const harness = (spec: AuthSpec, workspaceId = f.workspaceId) => {
  const auth = (
    spec.kind === 'system'
      ? { ...base.authContext, workspace: { ...base.authContext.workspace, id: workspaceId } }
      : spec.kind === 'user'
        ? {
            type: 'user',
            workspace: { ...base.authContext.workspace, id: workspaceId },
            workspaceMemberId: spec.memberId ?? memberId,
            userWorkspaceId,
            ...(spec.userId !== undefined
              ? { user: { id: spec.userId } }
              : { user: { id: userId } }),
            ...(spec.applicationId !== undefined
              ? { application: { id: spec.applicationId } }
              : {}),
            ...(spec.viaApplicationId !== undefined
              ? { viaApplication: { id: spec.viaApplicationId } }
              : {}),
            ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
          }
        : spec.kind === 'apiKey'
          ? {
              type: 'apiKey',
              workspace: { ...base.authContext.workspace, id: workspaceId },
              apiKey: { id: spec.id ?? apiKeyId },
            }
          : {
              type: 'application',
              workspace: { ...base.authContext.workspace, id: workspaceId },
              application: { id: spec.id ?? appId, defaultRoleId: roleId },
              ...(spec.actingAgentId !== undefined
                ? { actingAgent: { id: spec.actingAgentId } }
                : {}),
              ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
            }
  ) as WorkspaceAuthContext;

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
    apiKeyRoleMap: { [spec.kind === 'apiKey' ? (spec.id ?? apiKeyId) : apiKeyId]: roleId },
    flatRoleTargetByAgentIdMaps: {
      ...base.flatRoleTargetByAgentIdMaps,
      [agentId]: { roleId },
    } as typeof base.flatRoleTargetByAgentIdMaps,
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
  const recordPositionService = new RecordPositionService(manager);
  const shareWithService = {
    insertRecordSharesForCreatedRecords: jest.fn(async () => {}),
  } as unknown as ShareWithService;

  const createMany = new CommonCreateManyQueryRunnerService(
    recordPositionService,
    shareWithService,
  );
  const createOne = new CommonCreateOneQueryRunnerService(createMany);
  const updateMany = new CommonUpdateManyQueryRunnerService();
  const updateOne = new CommonUpdateOneQueryRunnerService(updateMany);
  const deleteMany = new CommonDeleteManyQueryRunnerService();
  const destroyMany = new CommonDestroyManyQueryRunnerService();
  const destroyOne = new CommonDestroyOneQueryRunnerService(destroyMany);
  const mergeMany = new CommonMergeManyQueryRunnerService();

  for (const runner of [
    createMany,
    createOne,
    updateMany,
    updateOne,
    deleteMany,
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
      twentyConfigService: { get: () => 10000 },
      metricsService: { incrementCounterBy: jest.fn() },
    });
  }

  const queryContext = (
    name: string,
    transactionScope?: WorkspaceTransactionScope,
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

  return {
    auth,
    dataSource,
    hooks,
    managerPort,
    createOne,
    createMany,
    updateOne,
    updateMany,
    deleteMany,
    destroyOne,
    mergeMany,
    queryContext,
    run: <TData>(work: () => Promise<TData>) =>
      withWorkspaceContext(context, work),
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       "userId" uuid NOT NULL,
       "deletedAt" timestamptz
     )`,
  );
  await f.owner.query(
    `GRANT USAGE ON SCHEMA core TO "${f.roleName}";
     GRANT SELECT ON core."userWorkspace" TO "${f.roleName}";
     GRANT SELECT, UPDATE ON core.workspace TO "${f.roleName}";`,
  );
  base = await f.withContext(async () => getWorkspaceContext());
});

beforeEach(async () => {
  await f.reset();
  await f.owner.query(
    `INSERT INTO core.workspace (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [f.workspaceId],
  );
  await f.owner.query('DELETE FROM core."userWorkspace"');
  await f.owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt")
     VALUES ($1, $2, $3, NULL),
            ($4, $5, $6, NULL),
            ($7, $2, $8, now())`,
    [
      sameWsImpersonatorUwId,
      f.workspaceId,
      sameWsImpersonatorUserId,
      crossWsImpersonatorUwId,
      randomUUID(),
      crossWsImpersonatorUserId,
      deletedImpersonatorUwId,
      randomUUID(),
    ],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'private first'), ($2, 'private second')`,
    [companyId1, companyId2],
  );
  f.recordStock.releaseRecordStock.mockClear();
  f.eventEmitter.mockClear();
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

describe('LOG-204 ALS attribution propagation and record-crud NativeTransactionOutcomeUnknownError propagation', () => {
  it('propagates correlationId, causationId, same/cross-workspace impersonation, viaApplication, actingAgent, application+agentId, apiKey, system trace, and Branch A ShareWithService attribution', async () => {
    // 1. Regular user request inside withCrmAuditRequest across UPDATE_ONE and DESTROY_ONE
    const userReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
    });
    const hUser = harness({ kind: 'user' });
    await withCrmAuditRequest(userReq, () =>
      hUser.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'updated private' },
          selectedFields: { id: true },
        },
        hUser.queryContext('company'),
      ),
    );
    let entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'update',
      resourceId: companyId1,
      actor: { kind: 'workspaceMember', id: memberId },
      initiator: null,
      correlationId: userReq.correlationId,
    });

    const destroyTargetId = randomUUID();
    await f.owner.query(
      `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'destroy target')`,
      [destroyTargetId],
    );
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await withCrmAuditRequest(userReq, () =>
      hUser.destroyOne.execute(
        { id: destroyTargetId, selectedFields: { id: true } },
        hUser.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'delete',
      resourceId: destroyTargetId,
      actor: { kind: 'workspaceMember', id: memberId },
      initiator: null,
      correlationId: userReq.correlationId,
    });

    // 2. Same-workspace impersonation on UPDATE_ONE and cross-workspace server-level impersonation on MERGE_MANY
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const sameWsImpReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: {
        impersonatorUserWorkspaceId: sameWsImpersonatorUwId,
      },
    });
    await withCrmAuditRequest(sameWsImpReq, () =>
      hUser.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'imp updated' },
          selectedFields: { id: true },
        },
        hUser.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: memberId },
      initiator: { kind: 'coreUser', id: sameWsImpersonatorUserId },
      correlationId: sameWsImpReq.correlationId,
    });

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const crossWsImpReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: {
        impersonatorUserWorkspaceId: crossWsImpersonatorUwId.toUpperCase(),
      },
    });
    await withCrmAuditRequest(crossWsImpReq, () =>
      hUser.mergeMany.execute(
        {
          ids: [companyId1, companyId2],
          conflictPriorityIndex: 0,
          selectedFields: { id: true },
        },
        hUser.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actor: { kind: 'workspaceMember', id: memberId },
        initiator: { kind: 'coreUser', id: crossWsImpersonatorUserId },
        correlationId: crossWsImpReq.correlationId,
      });
    }

    // 3. Missing or soft-deleted impersonator userWorkspace fails closed and rolls back
    const beforeBadImpCompanies = await f.read('company');
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    for (const badImpId of [randomUUID(), deletedImpersonatorUwId]) {
      const badReq = captureCrmAuditRequest({
        workspace: { id: f.workspaceId },
        user: { id: userId },
        impersonationContext: { impersonatorUserWorkspaceId: badImpId },
      });
      await expect(
        withCrmAuditRequest(badReq, () =>
          hUser.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'must rollback' },
              selectedFields: { id: true },
            },
            hUser.queryContext('company'),
          ),
        ),
      ).rejects.toThrow('Native audit impersonation initiator unavailable');
    }
    expect(await f.read('company')).toEqual(beforeBadImpCompanies);
    expect(await audit()).toHaveLength(0);

    // 3b. User inside withCrmAuditIdentity with resolved coreUser initiator and causationId
    const resolvedInitiatorId = randomUUID();
    const resolvedCorrId = randomUUID();
    const resolvedCauseId = `cause:${randomUUID()}`;
    await withCrmAuditIdentity(
      f.workspaceId,
      {
        workspaceId: f.workspaceId,
        actor: { kind: 'coreUser', id: userId },
        initiator: { kind: 'coreUser', id: resolvedInitiatorId },
        correlationId: resolvedCorrId,
        causationId: resolvedCauseId,
      },
      () =>
        hUser.updateOne.execute(
          {
            id: companyId1,
            data: { name: 'resolved identity update' },
            selectedFields: { id: true },
          },
          hUser.queryContext('company'),
        ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: memberId },
      initiator: { kind: 'coreUser', id: resolvedInitiatorId },
      correlationId: resolvedCorrId,
      causationId: resolvedCauseId,
    });

    // 4. user with viaApplication -> actor: application, initiator: workspaceMember; user with application+agentId -> actor: agent, initiator: workspaceMember
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const viaAppReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      application: { id: appId },
    });
    const hViaApp = harness({ kind: 'user', viaApplicationId: appId });
    await withCrmAuditRequest(viaAppReq, () =>
      hViaApp.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'via app update' },
          selectedFields: { id: true },
        },
        hViaApp.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'application', id: appId },
      initiator: { kind: 'workspaceMember', id: memberId },
      correlationId: viaAppReq.correlationId,
    });

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const userAppAgentReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      application: { id: appId },
      agentId,
    });
    const hUserAppAgent = harness({
      kind: 'user',
      applicationId: appId,
      agentId,
    });
    await withCrmAuditRequest(userAppAgentReq, () =>
      hUserAppAgent.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'user app agent update' },
          selectedFields: { id: true },
        },
        hUserAppAgent.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'workspaceMember', id: memberId },
      correlationId: userAppAgentReq.correlationId,
    });

    // 5. application with actingAgent -> actor: agent, initiator: application; application with req.agentId (no actingAgent) -> actor: application, initiator: null
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const actingAgentReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      application: { id: appId },
      agentId,
    });
    const hActingAgent = harness({
      kind: 'application',
      id: appId,
      actingAgentId: agentId,
    });
    await withCrmAuditRequest(actingAgentReq, () =>
      hActingAgent.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'acting agent update' },
          selectedFields: { id: true },
        },
        hActingAgent.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'application', id: appId },
      correlationId: actingAgentReq.correlationId,
    });

    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const narrowedApp = harness({ kind: 'application', id: appId, agentId });
    await withCrmAuditRequest(actingAgentReq, () =>
      narrowedApp.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'narrowed app update' },
          selectedFields: { id: true },
        },
        narrowedApp.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'application', id: appId },
      initiator: null,
      correlationId: actingAgentReq.correlationId,
    });

    // 6. apiKey inside withCrmAuditRequest
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const apiKeyReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      apiKey: { id: apiKeyId },
    });
    const hApiKey = harness({ kind: 'apiKey' });
    await withCrmAuditRequest(apiKeyReq, () =>
      hApiKey.updateOne.execute(
        {
          id: companyId1,
          data: { name: 'apiKey update' },
          selectedFields: { id: true },
        },
        hApiKey.queryContext('company'),
      ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'apiKey', id: apiKeyId },
      initiator: null,
      correlationId: apiKeyReq.correlationId,
    });

    // 7. system auth inside withCrmAuditIdentity (correlationId + causationId), unauthenticated request, and workspace-less request (B3)
    const hSys = harness({ kind: 'system' });
    const traceCorrelationId = randomUUID();
    const traceCausationId = `cause:${randomUUID()}`;
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await withCrmAuditIdentity(
      f.workspaceId,
      {
        workspaceId: f.workspaceId,
        actor: { kind: 'system', id: 'upstream-job' },
        correlationId: traceCorrelationId,
        causationId: traceCausationId,
      },
      () =>
        hSys.updateOne.execute(
          {
            id: companyId1,
            data: { name: 'sys traced' },
            selectedFields: { id: true },
          },
          hSys.queryContext('company'),
        ),
    );
    entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'system', id: 'crm-api-update' },
      initiator: null,
      correlationId: traceCorrelationId,
      causationId: traceCausationId,
    });

    for (const reqFields of [{ workspace: { id: f.workspaceId } }, {}]) {
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      const unauthReq = captureCrmAuditRequest(reqFields);
      await withCrmAuditRequest(unauthReq, () =>
        hSys.updateOne.execute(
          {
            id: companyId1,
            data: { name: `sys unauth ${unauthReq.correlationId}` },
            selectedFields: { id: true },
          },
          hSys.queryContext('company'),
        ),
      );
      entries = await audit();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: { kind: 'system', id: 'crm-api-update' },
        initiator: null,
        correlationId: unauthReq.correlationId,
      });
    }

    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({ workspace: { id: randomUUID() } }),
        () =>
          hSys.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'wrong ws' },
              selectedFields: { id: true },
            },
            hSys.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('CRM audit context workspace mismatch');

    // 8. Branch A ShareWithService (runAuditedShareWithInsert) inside withNativeCrmAuditTransaction under impersonation, viaApplication, and application + req.agentId (B2)
    for (const branchCase of [
      {
        label: 'impersonation',
        h: hUser,
        req: sameWsImpReq,
        expectedActor: { kind: 'workspaceMember', id: memberId },
        expectedInitiator: { kind: 'coreUser', id: sameWsImpersonatorUserId },
      },
      {
        label: 'viaApplication',
        h: hViaApp,
        req: viaAppReq,
        expectedActor: { kind: 'application', id: appId },
        expectedInitiator: { kind: 'workspaceMember', id: memberId },
      },
      {
        label: 'application+agentId',
        h: narrowedApp,
        req: actingAgentReq,
        expectedActor: { kind: 'application', id: appId },
        expectedInitiator: null,
      },
    ]) {
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      const shareRecordId = randomUUID();
      const shareId = randomUUID();
      const shareSourceId = randomUUID();
      await withCrmAuditRequest(branchCase.req, () =>
        branchCase.h.run(() =>
          branchCase.h.dataSource.transaction(
            async (scope) => {
              await scope
                .getRepository('company', bypass)
                .insert({ id: shareRecordId, name: `branchA ${branchCase.label}` });
              await runAuditedShareWithInsert({
                scope,
                workspaceId: f.workspaceId,
                objectMetadataId: base.objectIdByNameSingular.company,
                recordIds: [shareRecordId],
                authContext: branchCase.h.auth as never,
                desiredShares: [
                  {
                    recordId: shareRecordId,
                    objectMetadataId: base.objectIdByNameSingular.company,
                    principalId: memberId,
                    principalType: 'WORKSPACE_MEMBER',
                    accessLevel: 'READ_WRITE',
                    rowCause: 'OWNER',
                    sourceId: shareSourceId,
                  },
                ],
                execute: async () => {
                  await scope.executeRawQuery(
                    `INSERT INTO "${f.schemaName}"."recordShare" (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
                     VALUES ($1, $2, $3, $4, 'WORKSPACE_MEMBER', 'READ_WRITE', 'OWNER', $5)`,
                    [
                      shareId,
                      shareRecordId,
                      base.objectIdByNameSingular.company,
                      memberId,
                      shareSourceId,
                    ],
                  );
                },
              });
            },
            { nativeAudit: { operationId: randomUUID() } },
          ),
        ),
      );
      entries = await audit();
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          actor: branchCase.expectedActor,
          initiator: branchCase.expectedInitiator,
          correlationId: branchCase.req.correlationId,
        });
      }
    }

    // 9. Pure captureNativeCrmAuditOperation does NOT read ALS (B1: preserves role-update-audit stripped user auth)
    const pureResult = withCrmAuditRequest(sameWsImpReq, () =>
      captureNativeCrmAuditOperation(
        f.workspaceId,
        { type: 'user', workspace: { id: f.workspaceId }, workspaceMemberId: memberId },
        { operationId: randomUUID() },
      ),
    );
    expect(pureResult.actor).toEqual({ kind: 'workspaceMember', id: memberId });
    expect(pureResult.initiator).toBeUndefined();
    expect(pureResult.correlationId).toBeUndefined();
  });

  it('fails closed on ALS conflicts (M2) and poisons nested scopes on initiator/impersonation/correlationId/causationId drift (M3)', async () => {
    const hUser = harness({ kind: 'user' });
    const hApiKey = harness({ kind: 'apiKey' });
    const hApp = harness({ kind: 'application', id: appId });

    // 1. App-only ALS + plain user auth must fail (M2 - cannot fabricate initiator: workspaceMember)
    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          application: { id: appId },
        }),
        () =>
          hUser.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'blocked' },
              selectedFields: { id: true },
            },
            hUser.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('Native audit ambient initiator conflict');

    // 2. App+agent-only ALS + plain user auth must fail (M2)
    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          application: { id: appId },
          agentId,
        }),
        () =>
          hUser.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'blocked' },
              selectedFields: { id: true },
            },
            hUser.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('Native audit ambient initiator conflict');

    // 3. Ambient user mismatch, apiKey mismatch, application mismatch, principal mismatch
    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          user: { id: randomUUID() },
        }),
        () =>
          hUser.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'blocked' },
              selectedFields: { id: true },
            },
            hUser.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('Native audit ambient user conflict');

    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          apiKey: { id: randomUUID() },
        }),
        () =>
          hApiKey.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'blocked' },
              selectedFields: { id: true },
            },
            hApiKey.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('Native audit ambient apiKey conflict');

    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          application: { id: randomUUID() },
        }),
        () =>
          hApp.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'blocked' },
              selectedFields: { id: true },
            },
            hApp.queryContext('company'),
          ),
      ),
    ).rejects.toThrow('Native audit ambient application conflict');

    // 4. Direct binding validation: empty user.id, conflicting application vs viaApplication, agentId without application, impersonation + viaApplication
    expect(() =>
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          user: { id: userId },
        }),
        () =>
          captureNativeCrmAuditBinding(
            f.workspaceId,
            {
              type: 'user',
              workspace: { id: f.workspaceId },
              workspaceMemberId: memberId,
              user: { id: '' },
            },
            { operationId: randomUUID() },
          ),
      ),
    ).toThrow('Native audit UUID is invalid');

    expect(() =>
      captureNativeCrmAuditOperation(
        f.workspaceId,
        {
          type: 'user',
          workspace: { id: f.workspaceId },
          workspaceMemberId: memberId,
          application: { id: appId },
          viaApplication: { id: randomUUID() },
        },
        { operationId: randomUUID() },
      ),
    ).toThrow('Native audit application context conflict');

    expect(() =>
      captureNativeCrmAuditOperation(
        f.workspaceId,
        {
          type: 'user',
          workspace: { id: f.workspaceId },
          workspaceMemberId: memberId,
          agentId,
        },
        { operationId: randomUUID() },
      ),
    ).toThrow('Native audit agent requires an authenticated application');

    expect(() =>
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          user: { id: userId },
          impersonationContext: {
            impersonatorUserWorkspaceId: sameWsImpersonatorUwId,
          },
        }),
        () =>
          captureNativeCrmAuditBinding(
            f.workspaceId,
            {
              type: 'user',
              workspace: { id: f.workspaceId },
              workspaceMemberId: memberId,
              user: { id: userId },
              viaApplication: { id: appId },
            },
            { operationId: randomUUID() },
          ),
      ),
    ).toThrow(
      'Native audit impersonation cannot combine with agent or application',
    );

    // 5. Nested scope poisoning on impersonator switch, correlationId drift, new ALS over uncorrelated scope, and masked ALS inside ALS scope (M3)
    const beforeCompanies = await f.read('company');
    const outerImpReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: {
        impersonatorUserWorkspaceId: sameWsImpersonatorUwId,
      },
    });
    const innerOtherImpReq = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: {
        impersonatorUserWorkspaceId: crossWsImpersonatorUwId,
      },
    });
    await expect(
      withCrmAuditRequest(outerImpReq, () =>
        hUser.run(() =>
          hUser.dataSource.transaction(
            async (scope) => {
              await scope
                .getRepository('company', bypass)
                .update(companyId1, { name: 'must rollback imp' });
              try {
                await withCrmAuditRequest(innerOtherImpReq, () =>
                  hUser.updateOne.execute(
                    {
                      id: companyId2,
                      data: { name: 'nested imp' },
                      selectedFields: { id: true },
                    },
                    hUser.queryContext('company', scope),
                  ),
                );
              } catch {
                // Caller tries to swallow impersonation drift
              }
            },
            { nativeAudit: { operationId: randomUUID() } },
          ),
        ),
      ),
    ).rejects.toThrow('different initiator or impersonation context');
    expect(await f.read('company')).toEqual(beforeCompanies);
    expect(await audit()).toHaveLength(0);

    // Masked ALS inside ALS-correlated outer scope poisons and rolls back
    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          user: { id: userId },
        }),
        () =>
          hUser.run(() =>
            hUser.dataSource.transaction(
              async (scope) => {
                await scope
                  .getRepository('company', bypass)
                  .update(companyId1, { name: 'must rollback masked' });
                try {
                  await withCrmAuditIdentity(f.workspaceId, undefined, () =>
                    hUser.updateOne.execute(
                      {
                        id: companyId2,
                        data: { name: 'nested masked' },
                        selectedFields: { id: true },
                      },
                      hUser.queryContext('company', scope),
                    ),
                  );
                } catch {
                  // Caller tries to swallow lost correlation
                }
              },
              { nativeAudit: { operationId: randomUUID() } },
            ),
          ),
      ),
    ).rejects.toThrow('conflicting correlation or causation context');
    expect(await f.read('company')).toEqual(beforeCompanies);
    expect(await audit()).toHaveLength(0);

    // New ALS introduced over uncorrelated outer scope poisons and rolls back
    await expect(
      hUser.run(() =>
        hUser.dataSource.transaction(
          async (scope) => {
            await scope
              .getRepository('company', bypass)
              .update(companyId1, { name: 'must rollback new als' });
            try {
              await withCrmAuditRequest(
                captureCrmAuditRequest({
                  workspace: { id: f.workspaceId },
                  user: { id: userId },
                }),
                () =>
                  hUser.updateOne.execute(
                    {
                      id: companyId2,
                      data: { name: 'nested new als' },
                      selectedFields: { id: true },
                    },
                    hUser.queryContext('company', scope),
                  ),
              );
            } catch {
              // Caller tries to swallow new correlation
            }
          },
          { nativeAudit: { operationId: randomUUID() } },
        ),
      ),
    ).rejects.toThrow('conflicting correlation or causation context');
    expect(await f.read('company')).toEqual(beforeCompanies);
    expect(await audit()).toHaveLength(0);

    // Explicit options.correlationId outside ALS still allows nested calls without ALS (M3)
    const explicitCorr = randomUUID();
    await hUser.run(() =>
      hUser.dataSource.transaction(
        async (scope) => {
          await hUser.updateOne.execute(
            {
              id: companyId1,
              data: { name: 'explicit corr ok' },
              selectedFields: { id: true },
            },
            hUser.queryContext('company', scope),
          );
        },
        { nativeAudit: { operationId: randomUUID(), correlationId: explicitCorr } },
      ),
    );
    const explicitEntries = await audit();
    expect(explicitEntries).toHaveLength(1);
    expect(explicitEntries[0].correlationId).toBe(explicitCorr);

    // Explicit options.correlationId and causationId inside active ALS still allow nested calls in the same ALS, while ambient drift still poisons
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const ambientCorr = randomUUID();
    const ambientCause = `cause:${randomUUID()}`;
    const overrideCorr = randomUUID();
    const overrideCause = `override:${randomUUID()}`;
    await withCrmAuditIdentity(
      f.workspaceId,
      {
        workspaceId: f.workspaceId,
        actor: { kind: 'coreUser', id: userId },
        correlationId: ambientCorr,
        causationId: ambientCause,
      },
      () =>
        hUser.run(() =>
          hUser.dataSource.transaction(
            async (scope) => {
              await hUser.updateOne.execute(
                {
                  id: companyId1,
                  data: { name: 'explicit override inside als' },
                  selectedFields: { id: true },
                },
                hUser.queryContext('company', scope),
              );
            },
            {
              nativeAudit: {
                operationId: randomUUID(),
                correlationId: overrideCorr,
                causationId: overrideCause,
              },
            },
          ),
        ),
    );
    const overrideEntries = await audit();
    expect(overrideEntries).toHaveLength(1);
    expect(overrideEntries[0]).toMatchObject({
      correlationId: overrideCorr,
      causationId: overrideCause,
    });

    // Nested causationId drift inside active ALS poisons and rolls back
    await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const beforeCauseDrift = await f.read('company');
    await expect(
      withCrmAuditIdentity(
        f.workspaceId,
        {
          workspaceId: f.workspaceId,
          actor: { kind: 'coreUser', id: userId },
          correlationId: ambientCorr,
          causationId: ambientCause,
        },
        () =>
          hUser.run(() =>
            hUser.dataSource.transaction(
              async (scope) => {
                await scope
                  .getRepository('company', bypass)
                  .update(companyId1, { name: 'must rollback cause drift' });
                try {
                  await withCrmAuditIdentity(
                    f.workspaceId,
                    {
                      workspaceId: f.workspaceId,
                      actor: { kind: 'coreUser', id: userId },
                      correlationId: ambientCorr,
                      causationId: `other:${randomUUID()}`,
                    },
                    () =>
                      hUser.updateOne.execute(
                        {
                          id: companyId2,
                          data: { name: 'nested cause drift' },
                          selectedFields: { id: true },
                        },
                        hUser.queryContext('company', scope),
                      ),
                  );
                } catch {
                  // Caller tries to swallow causationId drift
                }
              },
              { nativeAudit: { operationId: randomUUID() } },
            ),
          ),
      ),
    ).rejects.toThrow('conflicting correlation or causation context');
    expect(await f.read('company')).toEqual(beforeCauseDrift);
    expect(await audit()).toHaveLength(0);

    // Application without actingAgent rejects conflicting auth.agentId vs ambient agent actor (m1)
    expect(() =>
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: f.workspaceId },
          application: { id: appId },
          agentId,
        }),
        () =>
          captureNativeCrmAuditBinding(
            f.workspaceId,
            {
              type: 'application',
              workspace: { id: f.workspaceId },
              application: { id: appId },
              agentId: randomUUID(),
            },
            { operationId: randomUUID() },
          ),
      ),
    ).toThrow('Native audit ambient application conflict');

    // membershipCleanupIdentity rejects empty or oversized causationId (M1)
    for (const badCause of ['', 'c'.repeat(257)]) {
      expect(() =>
        copyMembershipCleanupIdentity(
          {
            workspaceId: f.workspaceId,
            actor: { kind: 'system', id: 'cleanup' },
            correlationId: randomUUID(),
            causationId: badCause,
          },
          f.workspaceId,
        ),
      ).toThrow('Membership audit causationId is invalid');
    }

    // Direct withNativeCrmAuditTransaction validates impersonatorUserWorkspaceId and actor kind before touching DB / advisory lock (M4)
    const rawQuerySpy = jest.fn();
    const fakeScope = { workspaceId: f.workspaceId, executeRawQuery: rawQuerySpy };
    await expect(
      withNativeCrmAuditTransaction(
        {},
        fakeScope,
        {
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          actor: { kind: 'workspaceMember', id: memberId },
        },
        async () => {},
        { impersonatorUserWorkspaceId: 'not-a-uuid' },
      ),
    ).rejects.toThrow('Native audit UUID is invalid');
    await expect(
      withNativeCrmAuditTransaction(
        {},
        fakeScope,
        {
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          actor: { kind: 'system', id: 'batch' },
        },
        async () => {},
        { impersonatorUserWorkspaceId: sameWsImpersonatorUwId },
      ),
    ).rejects.toThrow('Native audit impersonation requires a user actor');
    expect(rawQuerySpy).not.toHaveBeenCalled();
  });

  it('rethrows NativeTransactionOutcomeUnknownError without masking across all 7 remaining mutating record-crud services', async () => {
    const withLostCommitAck = async (
      work: () => Promise<unknown>,
    ): Promise<{ statements: string[]; error: unknown }> => {
      const statements: string[] = [];
      let fired = false;
      const rawConnect = f.pool.connect.bind(f.pool);
      const connectSpy = jest
        .spyOn(f.pool, 'connect')
        .mockImplementation(((...args: unknown[]) => {
          if (typeof args[0] === 'function') {
            return (rawConnect as (...a: unknown[]) => unknown)(...args);
          }

          return (async () => {
            const client = await rawConnect();
            const rawQuery = client.query.bind(client);
            const querySpy = jest
              .spyOn(client, 'query')
              .mockImplementation((async (
                statement: string | { text: string },
                values?: unknown[],
              ) => {
                const text =
                  typeof statement === 'string' ? statement : statement.text;
                statements.push(text);
                const result = await rawQuery(statement as string, values);
                if (!fired && text === 'COMMIT') {
                  fired = true;
                  querySpy.mockRestore();
                  throw new Error('lost record-crud commit ack');
                }
                return result;
              }) as typeof client.query);
            const rawRelease = client.release.bind(client);
            const releaseSpy = jest
              .spyOn(client, 'release')
              .mockImplementation((err?: Error | boolean) => {
                querySpy.mockRestore();
                releaseSpy.mockRestore();
                return rawRelease(err);
              });
            return client;
          })();
        }) as typeof f.pool.connect);

      try {
        await work();
        return { statements, error: undefined };
      } catch (error) {
        return { statements, error };
      } finally {
        connectSpy.mockRestore();
      }
    };

    const makeContextBuilder = (
      h: ReturnType<typeof harness>,
      objectName: string,
    ) => ({
      build: jest.fn(async () => ({
        queryRunnerContext: h.queryContext(objectName),
        selectedFields: { id: true, name: true },
        flatObjectMetadata: h.queryContext(objectName).flatObjectMetadata,
        flatObjectMetadataMaps: base.flatObjectMetadataMaps,
        flatFieldMetadataMaps: base.flatFieldMetadataMaps,
        objectIdByNameSingular: base.objectIdByNameSingular,
      })),
    });

    const cases: Array<{
      label: string;
      run: (h: ReturnType<typeof harness>) => Promise<unknown>;
    }> = [
      {
        label: 'CreateRecordService',
        run: (h) =>
          new CreateRecordService(
            h.createOne,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            objectRecord: { id: randomUUID(), name: 'lost-create-one' },
            authContext: h.auth,
          }),
      },
      {
        label: 'CreateManyRecordsService',
        run: (h) =>
          new CreateManyRecordsService(
            h.createMany,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            objectRecords: [{ id: randomUUID(), name: 'lost-create-many' }],
            authContext: h.auth,
          }),
      },
      {
        label: 'UpdateRecordService',
        run: (h) =>
          new UpdateRecordService(
            h.updateOne,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            objectRecordId: companyId1,
            objectRecord: { name: 'lost-update-one' },
            authContext: h.auth,
          }),
      },
      {
        label: 'UpdateManyRecordsService',
        run: (h) =>
          new UpdateManyRecordsService(
            h.updateMany,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            filter: { id: { eq: companyId1 } },
            data: { name: 'lost-update-many' },
            authContext: h.auth,
          }),
      },
      {
        label: 'DeleteManyRecordsService',
        run: (h) =>
          new DeleteManyRecordsService(
            h.deleteMany,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            filter: { id: { eq: companyId2 } },
            authContext: h.auth,
          }),
      },
      {
        label: 'UpsertRecordService',
        run: (h) =>
          new UpsertRecordService(
            h.createOne,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            objectRecord: { id: randomUUID(), name: 'lost-upsert-one' },
            authContext: h.auth,
          }),
      },
      {
        label: 'UpsertManyRecordsService',
        run: (h) =>
          new UpsertManyRecordsService(
            h.createMany,
            makeContextBuilder(h, 'company') as never,
          ).execute({
            objectName: 'company',
            objectRecords: [{ id: randomUUID(), name: 'lost-upsert-many' }],
            authContext: h.auth,
          }),
      },
    ];

    for (const item of cases) {
      await f.owner.query('DELETE FROM crm_audit."crmAuditEntry"');
      f.eventEmitter.mockClear();
      const h = harness({ kind: 'user' });
      const { statements, error } = await withLostCommitAck(() => item.run(h));
      expect(error).toBeInstanceOf(NativeTransactionOutcomeUnknownError);
      expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);
      expect(statements).not.toContain('ROLLBACK');
      expect((await audit()).length).toBeGreaterThanOrEqual(1);
      expect(f.eventEmitter).not.toHaveBeenCalled();
      expect(h.hooks.executePostQueryHooks).not.toHaveBeenCalled();
    }
  });
});
