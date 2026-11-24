import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';

import {
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { DataSource, EntitySchema } from 'typeorm';

import { DataArgProcessorService } from 'src/engine/api/common/common-args-processors/data-arg-processor/data-arg-processor.service';
import { FilterArgProcessorService } from 'src/engine/api/common/common-args-processors/filter-arg-processor/filter-arg-processor.service';
import { ProcessNestedRelationsHelper } from 'src/engine/api/common/common-nested-relations-processor/process-nested-relations.helper';
import { CommonCreateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service';
import { CommonCreateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-create-one-query-runner.service';
import { CommonDestroyManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service';
import { CommonDestroyOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service';
import { CommonUpdateManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-many-query-runner.service';
import { CommonUpdateOneQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-update-one-query-runner.service';
import { CommonQueryRunnerException } from 'src/engine/api/common/common-query-runners/errors/common-query-runner.exception';
import { CommonRecordVisibilityService } from 'src/engine/api/common/common-record-visibility/common-record-visibility.service';
import { CommonResultGettersService } from 'src/engine/api/common/common-result-getters/common-result-getters.service';
import { type CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  checkCrmAuditDatabaseHealth,
  CrmAuditHealthService,
  type CrmAuditUnavailableRecord,
  getCrmAuditHealthSnapshot,
  registerCrmAuditAlertSink,
  reportCrmAuditUnavailable,
  resetCrmAuditHealthStateForTesting,
} from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
import { captureNativeCrmAuditBinding } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import {
  classifyCrmAuditAttemptOutcome,
  recordPostRollbackCoreAuditAttempt,
  recordPostRollbackNativeCrmAuditAttempt,
} from 'src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { RecordPositionService } from 'src/engine/core-modules/record-position/services/record-position.service';
import { type ShareWithService } from 'src/engine/core-modules/record-share/services/share-with.service';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  TwentyOrmException,
  TwentyOrmExceptionCode,
} from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import {
  getWorkspaceContext,
  withWorkspaceContext,
} from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
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
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageThreadTarget',
]);

const f = createOmniNativeMessageFixture({
  additionalTables: ['company', 'opportunity'],
  coreSchema: 'fork',
  useStandardForeignKeyActions: true,
  configureMetadata: (maps) => {
    for (const object of Object.values(
      maps.flatObjectMetadataMaps.byUniversalIdentifier,
    )) {
      if (object && !FIXTURE_ACTIVE_OBJECTS.has(object.nameSingular)) {
        object.isActive = false;
      }
    }
  },
});

const roleId = randomUUID();
const userId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const userWorkspaceId = randomUUID();
const workspaceMemberId = randomUUID();
const companyId = randomUUID();
const personId = randomUUID();

let base: ReturnType<typeof getWorkspaceContext>;
let runtimeDataSource: DataSource;

const CoreUserTestEntity = new EntitySchema<{
  id: string;
  deletedAt: Date | null;
  updatedAt: Date;
}>({
  name: 'CoreUserTest208',
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const audit = () =>
  f.owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt", id',
  );

const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;

const harness = (options?: {
  kind?: 'user' | 'apiKey' | 'system';
  canUpdate?: boolean;
  canDestroy?: boolean;
}) => {
  const kind = options?.kind ?? 'user';
  const canUpdate = options?.canUpdate ?? true;
  const canDestroy = options?.canDestroy ?? true;

  const auth: WorkspaceAuthContext =
    kind === 'system'
      ? {
          type: 'system',
          workspace: { id: f.workspaceId } as never,
        }
      : kind === 'apiKey'
        ? {
            type: 'apiKey',
            workspace: { id: f.workspaceId } as never,
            apiKey: { id: randomUUID() } as never,
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
      Object.values(base.objectIdByNameSingular).map((objectId) => [
        objectId,
        {
          canReadObjectRecords: true,
          canUpdateObjectRecords: canUpdate,
          canSoftDeleteObjectRecords: canUpdate,
          canDestroyObjectRecords: canDestroy,
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
    apiKeyRoleMap:
      auth.type === 'apiKey' ? { [auth.apiKey.id]: roleId } : {},
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
  const shareWithService = {
    insertRecordSharesForCreatedRecords: jest.fn(async () => undefined),
  } as unknown as ShareWithService;

  const createMany = new CommonCreateManyQueryRunnerService(
    recordPositionService,
    shareWithService,
  );
  const createOne = new CommonCreateOneQueryRunnerService(createMany);
  const updateMany = new CommonUpdateManyQueryRunnerService();
  const updateOne = new CommonUpdateOneQueryRunnerService(updateMany);
  const destroyMany = new CommonDestroyManyQueryRunnerService();
  const destroyOne = new CommonDestroyOneQueryRunnerService(destroyMany);

  for (const runner of [
    createMany,
    createOne,
    updateMany,
    updateOne,
    destroyMany,
    destroyOne,
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
    });
  }

  const queryContext = (
    name: 'company' | 'person',
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
    };
  };

  return {
    auth,
    dataSource,
    hooks,
    queryContext,
    run: <T>(fn: () => Promise<T>) => withWorkspaceContext(context, fn),
    updateOne,
    updateMany,
    destroyOne,
    createOne,
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."user" (
       id uuid PRIMARY KEY,
       "deletedAt" timestamptz,
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await f.owner.query(
    `ALTER TABLE core."user"
     ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now()`,
  );
  await f.owner.query(
    `CREATE TABLE IF NOT EXISTS core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL,
       "userId" uuid NOT NULL,
       "deletedAt" timestamptz
     )`,
  );
  await f.owner.query(
    `GRANT USAGE ON SCHEMA core TO ${quoteIdent(f.roleName)};
     GRANT SELECT, UPDATE ON core."user" TO ${quoteIdent(f.roleName)};
     GRANT SELECT ON core."userWorkspace" TO ${quoteIdent(f.roleName)};
     GRANT SELECT, UPDATE ON core.workspace TO ${quoteIdent(f.roleName)};`,
  );
  base = await f.withContext(async () => getWorkspaceContext());
  runtimeDataSource = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
    entities: [CoreUserTestEntity],
    synchronize: false,
    migrationsRun: false,
    extra: { max: 4, statement_timeout: 10000 },
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
  resetCrmAuditHealthStateForTesting();
  await f.owner.query(
    `DROP TRIGGER IF EXISTS fail_audit_208 ON crm_audit."crmAuditEntry";
     DROP FUNCTION IF EXISTS crm_audit.fail_audit_208();
     DROP TRIGGER IF EXISTS fail_company_create_208 ON "${f.schemaName}".company;
     DROP FUNCTION IF EXISTS "${f.schemaName}".fail_company_create_208();`,
  );
  await f.owner.query(
    `GRANT INSERT ON crm_audit."crmAuditEntry" TO ${quoteIdent(f.roleName)}`,
  );
  await f.reset();
  await f.owner.query(
    `INSERT INTO core.workspace (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [f.workspaceId],
  );
  await f.owner.query('DELETE FROM core."userWorkspace"');
  await f.owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt")
     VALUES ($1, $2, $3, NULL),
            ($4, $2, $5, NULL)`,
    [
      userWorkspaceId,
      f.workspaceId,
      userId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await f.owner.query(
    'DELETE FROM core."omniExternalIdentity" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    'DELETE FROM core."omniAccountBinding" WHERE "workspaceId" = $1',
    [f.workspaceId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".company (id, name) VALUES ($1, 'original-company')`,
    [companyId],
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}".person (id, "nameFirstName") VALUES ($1, 'protected-person')`,
    [personId],
  );
});

describe('LOG-208 General post-rollback denied/failed audit and audit health/alerting', () => {
  it('records post-rollback denied audit for permission denial with impersonation, correlationId and causationId', async () => {
    const h = harness({ kind: 'user', canUpdate: false });
    const req = captureCrmAuditRequest({
      workspace: { id: f.workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId },
    });

    await expect(
      withCrmAuditRequest(req, () =>
        h.updateOne.execute(
          {
            id: companyId,
            data: { name: 'SECRET_SHOULD_NOT_APPEAR_IN_AUDIT' },
            selectedFields: { id: true },
          },
          h.queryContext('company'),
        ),
      ),
    ).rejects.toBeInstanceOf(PermissionsException);

    const companyRows = (await f.read('company')) as ObjectRecord[];
    expect(companyRows.find((row) => row.id === companyId)?.name).toBe(
      'original-company',
    );

    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      workspaceId: f.workspaceId,
      resourceKind: 'crmRecord',
      resourceId: companyId,
      action: 'update',
      outcome: 'denied',
      reasonCode: 'crm.mutation.permission_denied',
      actor: { kind: 'workspaceMember', id: workspaceMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: req.correlationId,
      redactedDiff: { changedFields: [], values: {} },
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: companyId,
        objectMetadataId: base.objectIdByNameSingular.company,
      },
    });
    expect(entries[0].attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(entries)).not.toContain(
      'SECRET_SHOULD_NOT_APPEAR_IN_AUDIT',
    );

    const explicitCorrId = randomUUID();
    const explicitCauseId = `cause:${randomUUID()}`;
    await expect(
      withCrmAuditIdentity(
        f.workspaceId,
        {
          workspaceId: f.workspaceId,
          actor: { kind: 'coreUser', id: userId },
          initiator: { kind: 'coreUser', id: impersonatorUserId },
          correlationId: explicitCorrId,
          causationId: explicitCauseId,
        },
        () =>
          h.updateOne.execute(
            {
              id: companyId,
              data: { name: 'SECRET_2' },
              selectedFields: { id: true },
            },
            h.queryContext('company'),
          ),
      ),
    ).rejects.toBeInstanceOf(PermissionsException);

    const allEntries = await audit();
    expect(allEntries).toHaveLength(2);
    expect(allEntries[1]).toMatchObject({
      outcome: 'denied',
      reasonCode: 'crm.mutation.permission_denied',
      correlationId: explicitCorrId,
      causationId: explicitCauseId,
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
    expect(getCrmAuditHealthSnapshot().status).toBe('ok');
  });

  it('records post-rollback denied delete attempt with fail-closed deletedRecord descriptor for omni-protected parent', async () => {
    const bindingId = randomUUID();
    const connectedAccountId = randomUUID();
    const messageChannelId = randomUUID();
    await f.owner.query(
      'INSERT INTO core."connectedAccount" (id) VALUES ($1)',
      [connectedAccountId],
    );
    await f.owner.query(
      `INSERT INTO core."messageChannel" (id, "workspaceId", type) VALUES ($1, $2, 'email')`,
      [messageChannelId, f.workspaceId],
    );
    await f.owner.query(
      `INSERT INTO core."omniAccountBinding" (id, "workspaceId", platform, "connectorInstanceId", "accountId", "connectedAccountId", "messageChannelId", "capabilitiesVersion", capabilities)
       VALUES ($1, $2, 'telegram', 'inst-208', 'acc-208', $3, $4, '1', '{}'::jsonb)`,
      [bindingId, f.workspaceId, connectedAccountId, messageChannelId],
    );
    await f.owner.query(
      `INSERT INTO core."omniExternalIdentity" (id, "workspaceId", "bindingId", "providerPeerId", "personId", "verificationSource")
       VALUES ($1, $2, $3, 'peer-208', $4, 'provider')`,
      [randomUUID(), f.workspaceId, bindingId, personId],
    );

    const h = harness({ kind: 'user' });
    await expect(
      h.destroyOne.execute(
        { id: personId, selectedFields: { id: true } },
        h.queryContext('person'),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');

    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'crmRecord',
      resourceId: personId,
      action: 'delete',
      outcome: 'denied',
      reasonCode: 'crm.mutation.domain_command_required',
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: personId,
        objectMetadataId: base.objectIdByNameSingular.person,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  });

  it('records failed attempts with allowlisted reasonCode without leaking raw DB error messages and classifies RLS denials', async () => {
    expect(
      classifyCrmAuditAttemptOutcome(
        new TwentyOrmException(
          'RLS secret detail',
          TwentyOrmExceptionCode.RLS_VALIDATION_FAILED,
        ),
      ),
    ).toEqual({
      outcome: 'denied',
      reasonCode: 'crm.mutation.rls_denied',
    });

    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".fail_company_create_208() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'PRIVATE_CUSTOMER_PII_TOKEN_999'; END $$`,
    );
    await f.owner.query(
      `CREATE TRIGGER fail_company_create_208 BEFORE INSERT ON "${f.schemaName}".company
       FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".fail_company_create_208()`,
    );

    const h = harness({ kind: 'user' });
    await expect(
      h.createOne.execute(
        {
          data: { name: 'PRIVATE_NAME_888' },
          selectedFields: { id: true },
        },
        h.queryContext('company'),
      ),
    ).rejects.toThrow();

    await expect(
      h.updateMany.execute(
        {
          filter: {},
          data: { name: 'nope' },
          selectedFields: { id: true },
        },
        h.queryContext('company'),
      ),
    ).rejects.toBeInstanceOf(CommonQueryRunnerException);

    const entries = await audit();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'create',
      outcome: 'failed',
      reasonCode: 'crm.mutation.database_error',
      resourceId: base.objectIdByNameSingular.company,
      redactedDiff: { changedFields: [], values: {} },
    });
    expect(entries[1]).toMatchObject({
      action: 'update',
      outcome: 'failed',
      reasonCode: 'crm.mutation.invalid_input',
      resourceId: base.objectIdByNameSingular.company,
    });
    expect(JSON.stringify(entries)).not.toContain(
      'PRIVATE_CUSTOMER_PII_TOKEN_999',
    );
    expect(JSON.stringify(entries)).not.toContain('PRIVATE_NAME_888');
  });

  it('writes post-rollback attempt with nativeOwnershipLock=none without blocking on an exclusive ownership lock and blocks repository misuse', async () => {
    const h = harness({ kind: 'user' });
    const operationId = randomUUID();
    const binding = captureNativeCrmAuditBinding(f.workspaceId, h.auth, {
      operationId,
    });

    await expect(
      h.dataSource.transaction(async () => undefined, {
        nativeAudit: { operationId: randomUUID() },
        nativeOwnershipLock: 'none',
      }),
    ).rejects.toThrow('Native audit requires a workspace ownership lock');

    await expect(
      h.dataSource.transaction(
        async (scope) => {
          scope.getRepository('company');
        },
        { commitOutcome: 'strict', nativeOwnershipLock: 'none' },
      ),
    ).rejects.toThrow(
      'Workspace repositories are disabled without an ownership lock',
    );

    await expect(
      h.dataSource.transaction(async () => undefined, {
        nativeOwnershipLock: 'none',
      }),
    ).rejects.toThrow(
      'Audit-only transaction requires strict transaction ownership',
    );

    await expect(
      h.dataSource.transaction(
        async (scope) => {
          scope.afterCommit(() => undefined);
        },
        { commitOutcome: 'strict', nativeOwnershipLock: 'none' },
      ),
    ).rejects.toThrow(
      'After-commit callbacks are disabled without an ownership lock',
    );

    const blocker = await f.pool.connect();
    try {
      await blocker.query('BEGIN');
      await lockOmniNativeOwnership(
        {
          executeRawQuery: (sql, params = []) =>
            blocker.query(sql, params).then((res) => res.rows),
        },
        f.workspaceId,
        'exclusive',
      );

      const startedAt = Date.now();
      const result = await recordPostRollbackNativeCrmAuditAttempt({
        runInAuditTransaction: (work, opts) =>
          h.dataSource.transaction(work, opts),
        binding,
        action: 'update',
        resourceId: companyId,
        objectMetadataId: base.objectIdByNameSingular.company,
        error: new PermissionsException(
          'denied',
          PermissionsExceptionCode.PERMISSION_DENIED,
        ),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result).toMatchObject({
        recorded: true,
        outcome: 'denied',
        reasonCode: 'crm.mutation.permission_denied',
      });
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0].operationId).toBe(operationId);
  });

  it('skips negative audit on NativeTransactionOutcomeUnknownError and reports explicit health alert without adding a false failed entry', async () => {
    const alerts: CrmAuditUnavailableRecord[] = [];
    const unsubscribe = registerCrmAuditAlertSink((record) => {
      alerts.push(record);
    });

    const h = harness({ kind: 'user' });
    const client = await f.pool.connect();
    let handedOff = false;
    const originalQuery = client.query.bind(client);

    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      const res = await originalQuery(statement as string, values);
      if (text === 'COMMIT') {
        throw new Error('simulated lost commit ack');
      }
      return res;
    }) as never);
    jest.spyOn(f.pool, 'connect').mockImplementationOnce(async () => {
      handedOff = true;
      return client as never;
    });

    try {
      await expect(
        h.updateOne.execute(
          {
            id: companyId,
            data: { name: 'committed-despite-lost-ack' },
            selectedFields: { id: true },
          },
          h.queryContext('company'),
        ),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    } finally {
      unsubscribe();
      jest.restoreAllMocks();
      if (!handedOff) {
        client.release();
      }
    }

    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('success');
    await new Promise((resolve) => setImmediate(resolve));
    expect(alerts).toEqual([
      expect.objectContaining({
        code: 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED',
        workspaceId: f.workspaceId,
      }),
    ]);
    expect(getCrmAuditHealthSnapshot()).toMatchObject({
      status: 'degraded',
      lastFailureCode: 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED',
      hasRecentAuditLoss: true,
    });
  });

  it('preserves original error when post-rollback audit channel is unavailable, isolates async sink failures, recovers after window, and probes DB health with caching', async () => {
    const received: CrmAuditUnavailableRecord[] = [];
    const unsubBad = registerCrmAuditAlertSink(async () => {
      throw new Error('sink crash must never propagate');
    });
    const unsubGood = registerCrmAuditAlertSink((record) => {
      received.push(record);
    });
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    try {
      const hImp = harness({ kind: 'user' });
      const badReq = captureCrmAuditRequest({
        workspace: { id: f.workspaceId },
        user: { id: userId },
        impersonationContext: { impersonatorUserWorkspaceId: randomUUID() },
      });
      await expect(
        withCrmAuditRequest(badReq, () =>
          hImp.updateOne.execute(
            {
              id: companyId,
              data: { name: 'bad-impersonator' },
              selectedFields: { id: true },
            },
            hImp.queryContext('company'),
          ),
        ),
      ).rejects.toThrow('Native audit impersonation initiator unavailable');
      expect(await audit()).toHaveLength(0);
      expect(getCrmAuditHealthSnapshot().totalUnavailableCount).toBe(0);

      await f.owner.query(
        `CREATE FUNCTION crm_audit.fail_audit_208() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'AUDIT_CHANNEL_DOWN'; END $$`,
      );
      await f.owner.query(
        `CREATE TRIGGER fail_audit_208 BEFORE INSERT ON crm_audit."crmAuditEntry"
         FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_audit_208()`,
      );

      const hDenied = harness({ kind: 'user', canUpdate: false });
      await expect(
        hDenied.updateOne.execute(
          {
            id: companyId,
            data: { name: 'forbidden' },
            selectedFields: { id: true },
          },
          hDenied.queryContext('company'),
        ),
      ).rejects.toBeInstanceOf(PermissionsException);

      expect(await audit()).toHaveLength(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(received).toEqual([
        expect.objectContaining({
          code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
          workspaceId: f.workspaceId,
          resourceKind: 'crmRecord',
          action: 'update',
        }),
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('POST_ROLLBACK_AUDIT_UNAVAILABLE operationId='),
      );

      const failureMs = received[0].occurredAtMs;
      expect(
        getCrmAuditHealthSnapshot({
          recentWindowMs: 60_000,
          nowMs: failureMs + 1000,
        }),
      ).toMatchObject({
        status: 'degraded',
        hasRecentAuditLoss: true,
        recentUnavailableCount: 1,
        totalUnavailableCount: 1,
      });
      expect(
        getCrmAuditHealthSnapshot({
          recentWindowMs: 60_000,
          nowMs: failureMs + 60_001,
        }),
      ).toMatchObject({
        status: 'ok',
        hasRecentAuditLoss: false,
        recentUnavailableCount: 0,
        totalUnavailableCount: 1,
      });

      const healthService = new CrmAuditHealthService(runtimeDataSource);
      await f.owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM ${quoteIdent(f.roleName)}`,
      );
      const revokedHealth = await healthService.checkHealth({
        bypassCache: true,
      });
      expect(revokedHealth).toMatchObject({
        status: 'unavailable',
        databaseReachable: true,
        appendOnlyPrivilegesVerified: false,
        fromCache: false,
      });

      await f.owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO ${quoteIdent(f.roleName)}`,
      );
      const freshHealth = await healthService.checkHealth({
        bypassCache: true,
        recentWindowMs: 60_000,
        nowMs: failureMs + 60_001,
      });
      expect(freshHealth).toMatchObject({
        status: 'ok',
        databaseReachable: true,
        appendOnlyPrivilegesVerified: true,
        fromCache: false,
      });

      const cachedHealth = await healthService.checkHealth({
        recentWindowMs: 60_000,
        nowMs: failureMs + 60_002,
      });
      expect(cachedHealth).toMatchObject({
        status: 'ok',
        fromCache: true,
      });

      expect(await checkCrmAuditDatabaseHealth(undefined)).toMatchObject({
        status: 'unavailable',
        databaseReachable: false,
        appendOnlyPrivilegesVerified: false,
      });
    } finally {
      unsubBad();
      unsubGood();
      errorSpy.mockRestore();
    }
  });

  it('records core post-rollback attempts, skips CoreAuditPostCommitError, and preserves exact-match health alert codes', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const alerts: CrmAuditUnavailableRecord[] = [];
    const unsub = registerCrmAuditAlertSink((record) => {
      alerts.push(record);
    });

    try {
      const roleTargetId = randomUUID();
      const opId = randomUUID();
      const coreResult = await recordPostRollbackCoreAuditAttempt({
        dataSource: runtimeDataSource,
        operation: {
          workspaceId: f.workspaceId,
          operationId: opId,
          actor: { kind: 'coreUser', id: userId },
        },
        attempt: {
          resourceKind: 'role',
          resourceId: roleTargetId,
          action: 'update',
          outcome: 'denied',
          reasonCode: 'role.update.permission_denied',
          securityDescriptor: {
            resourceKind: 'role',
            resourceId: roleTargetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        },
        error: new PermissionsException(
          'denied',
          PermissionsExceptionCode.PERMISSION_DENIED,
        ),
      });

      expect(coreResult).toMatchObject({
        recorded: true,
        outcome: 'denied',
        reasonCode: 'role.update.permission_denied',
      });
      const entries = await audit();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        operationId: opId,
        resourceKind: 'role',
        resourceId: roleTargetId,
        outcome: 'denied',
        reasonCode: 'role.update.permission_denied',
      });

      const skipped = await recordPostRollbackCoreAuditAttempt({
        dataSource: runtimeDataSource,
        operation: {
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          actor: { kind: 'coreUser', id: userId },
        },
        attempt: {
          resourceKind: 'role',
          resourceId: roleTargetId,
          action: 'update',
          outcome: 'failed',
          reasonCode: 'role.update.failed',
          securityDescriptor: {
            resourceKind: 'role',
            resourceId: roleTargetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        },
        error: new CoreAuditPostCommitError(new Error('post-commit')),
      });
      expect(skipped).toEqual({ recorded: false, skippedUnknownOutcome: true });
      expect(await audit()).toHaveLength(1);

      await f.owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM ${quoteIdent(f.roleName)}`,
      );
      const unavailableResult = await recordPostRollbackCoreAuditAttempt({
        dataSource: runtimeDataSource,
        operation: {
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          actor: { kind: 'coreUser', id: userId },
        },
        attempt: {
          resourceKind: 'role',
          resourceId: roleTargetId,
          action: 'delete',
          outcome: 'failed',
          reasonCode: 'role.delete.failed',
          securityDescriptor: {
            resourceKind: 'role',
            resourceId: roleTargetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        },
        error: new Error('core mutation failed'),
      });
      expect(unavailableResult).toEqual({
        recorded: false,
        alertReported: true,
      });

      reportCrmAuditUnavailable({
        code: 'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(alerts.map((item) => item.code)).toEqual([
        'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED',
        'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
      ]);
    } finally {
      unsub();
      errorSpy.mockRestore();
    }
  });

  it('enforces single-flight deduplication, stale-probe cache fencing, concurrent loss visibility, direct-input validation, and real deactivateCoreUserWithAudit wiring', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const alerts: CrmAuditUnavailableRecord[] = [];
    const unsub = registerCrmAuditAlertSink((record) => {
      alerts.push(record);
    });

    try {
      // 1. Uninitialized DataSource returns unavailable safely.
      const uninitializedDs = new DataSource({
        type: 'postgres',
        url: f.runtimeDatabaseUrl,
      });
      expect(
        await checkCrmAuditDatabaseHealth(uninitializedDs),
      ).toMatchObject({
        status: 'unavailable',
        databaseReachable: false,
        appendOnlyPrivilegesVerified: false,
      });

      // 2. Single-flight deduplication + visibility of concurrent loss reported mid-probe (M1 + M2).
      const origCreateQueryRunner =
        runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
      let releaseFirstProbe!: () => void;
      const firstProbeEntered = new Promise<void>((resolve) => {
        jest
          .spyOn(runtimeDataSource, 'createQueryRunner')
          .mockImplementationOnce((mode) => {
            const runner = origCreateQueryRunner(mode);
            const origQuery = runner.query.bind(runner);
            runner.query = (async (sql: string, params?: unknown[]) => {
              if (sql === 'SELECT 1') {
                resolve();
                await new Promise<void>((done) => {
                  releaseFirstProbe = done;
                });
              }
              return origQuery(sql, params);
            }) as typeof runner.query;
            return runner;
          });
      });

      const p1 = checkCrmAuditDatabaseHealth(runtimeDataSource, {
        cacheTtlMs: 10_000,
      });
      const p2 = checkCrmAuditDatabaseHealth(runtimeDataSource, {
        cacheTtlMs: 0,
      });
      await firstProbeEntered;

      // Concurrent audit loss while probe is in-flight must surface as degraded after await.
      reportCrmAuditUnavailable({
        code: 'SESSION_REVOCATION_AUDIT_UNAVAILABLE',
        operationId: randomUUID(),
      });

      // Concurrent bypassCache probe finishes before slow p1; p1 must NOT overwrite newer cache entry.
      const bypassResult = await checkCrmAuditDatabaseHealth(
        runtimeDataSource,
        { bypassCache: true, cacheTtlMs: 10_000 },
      );
      expect(bypassResult).toMatchObject({
        status: 'degraded',
        databaseReachable: true,
        appendOnlyPrivilegesVerified: true,
        hasRecentAuditLoss: true,
        fromCache: false,
      });

      releaseFirstProbe();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toMatchObject({
        status: 'degraded',
        hasRecentAuditLoss: true,
        recentUnavailableCount: 1,
      });
      expect(r2).toMatchObject({
        status: 'degraded',
        hasRecentAuditLoss: true,
      });
      expect(runtimeDataSource.createQueryRunner).toHaveBeenCalledTimes(2);

      // Cached read after bypassCache + p1 uses bypassResult's valid cache (not invalidated by p2's cacheTtlMs=0).
      const afterCache = await checkCrmAuditDatabaseHealth(runtimeDataSource);
      expect(afterCache.fromCache).toBe(true);
      expect(afterCache.checkedAt).toBe(bypassResult.checkedAt);
      jest.restoreAllMocks();

      // 3. Direct-caller validation (m1) and refined classification (m2).
      expect(
        classifyCrmAuditAttemptOutcome(
          new TwentyOrmException(
            'bad uuid',
            TwentyOrmExceptionCode.INVALID_INPUT,
          ),
        ),
      ).toEqual({ outcome: 'failed', reasonCode: 'crm.mutation.invalid_input' });
      expect(
        classifyCrmAuditAttemptOutcome(
          new PermissionsException(
            'missing metadata',
            PermissionsExceptionCode.OBJECT_METADATA_NOT_FOUND,
          ),
        ),
      ).toEqual({
        outcome: 'failed',
        reasonCode: 'crm.mutation.execution_failed',
      });
      expect(
        classifyCrmAuditAttemptOutcome(
          new AuthException('bad input', AuthExceptionCode.INVALID_INPUT),
        ),
      ).toEqual({ outcome: 'failed', reasonCode: 'crm.mutation.invalid_input' });

      const h = harness({ kind: 'user' });
      const validBinding = captureNativeCrmAuditBinding(f.workspaceId, h.auth, {
        operationId: randomUUID(),
      });
      const beforeAlertCount =
        getCrmAuditHealthSnapshot().totalUnavailableCount;
      expect(
        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, opts) =>
            h.dataSource.transaction(work, opts),
          binding: validBinding,
          action: 'update',
          resourceId: 'not-a-uuid',
          objectMetadataId: base.objectIdByNameSingular.company,
          error: new Error('fail'),
        }),
      ).toEqual({ recorded: false, skippedInvalidAttribution: true });
      expect(
        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, opts) =>
            h.dataSource.transaction(work, opts),
          binding: {
            ...validBinding,
            impersonatorUserWorkspaceId: 'not-a-uuid',
          },
          action: 'update',
          resourceId: companyId,
          objectMetadataId: base.objectIdByNameSingular.company,
          error: new Error('fail'),
        }),
      ).toEqual({ recorded: false, skippedInvalidAttribution: true });
      expect(
        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, opts) =>
            h.dataSource.transaction(work, opts),
          binding: validBinding,
          action: 'update',
          resourceId: companyId,
          objectMetadataId: base.objectIdByNameSingular.company,
          error: new Error('Native audit operation was already committed'),
        }),
      ).toEqual({ recorded: false, skippedInvalidAttribution: true });
      expect(getCrmAuditHealthSnapshot().totalUnavailableCount).toBe(
        beforeAlertCount,
      );

      // NativeTransactionOutcomeUnknownError in recordPostRollbackCoreAuditAttempt skips attempt.
      expect(
        await recordPostRollbackCoreAuditAttempt({
          dataSource: runtimeDataSource,
          operation: {
            workspaceId: f.workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'coreUser', id: userId },
          },
          attempt: {
            resourceKind: 'role',
            resourceId: randomUUID(),
            action: 'update',
            outcome: 'failed',
            reasonCode: 'role.update.failed',
            securityDescriptor: {
              resourceKind: 'role',
              resourceId: randomUUID(),
              metadataAccess: 'currentWorkspaceAdministration',
            },
          },
          error: new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('unknown'),
          ),
        }),
      ).toEqual({ recorded: false, skippedUnknownOutcome: true });

      // 4. Real wiring of deactivateCoreUserWithAudit -> reportCrmAuditUnavailable on commit only (M3 + M4).
      resetCrmAuditHealthStateForTesting();
      const wiredAlerts: CrmAuditUnavailableRecord[] = [];
      const unsubWired = registerCrmAuditAlertSink((record) => {
        wiredAlerts.push(record);
      });
      const realErrorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();

      try {
        // Rolled-back deactivation must NOT report CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE (M3).
        const rolledBackUserId = randomUUID();
        await f.owner.query(
          'INSERT INTO core."user" (id, "deletedAt") VALUES ($1, NULL)',
          [rolledBackUserId],
        );
        await f.owner.query(
          `CREATE FUNCTION core.fail_user_update_208() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'USER_UPDATE_ROLLBACK_208'; END $$;
           CREATE TRIGGER fail_user_update_208 BEFORE UPDATE ON core."user"
           FOR EACH ROW EXECUTE FUNCTION core.fail_user_update_208();`,
        );
        try {
          await expect(
            deactivateCoreUserWithAudit({
              dataSource: runtimeDataSource,
              userEntity: CoreUserTestEntity as never,
              userId: rolledBackUserId,
              auditOperations: [],
              invalidate: async () => undefined,
            }),
          ).rejects.toThrow('USER_UPDATE_ROLLBACK_208');
          expect(getCrmAuditHealthSnapshot().totalUnavailableCount).toBe(0);
          expect(wiredAlerts).toHaveLength(0);
        } finally {
          await f.owner.query(
            `DROP TRIGGER IF EXISTS fail_user_update_208 ON core."user";
             DROP FUNCTION IF EXISTS core.fail_user_update_208();`,
          );
        }

        const orphanUserId = randomUUID();
        await f.owner.query(
          'INSERT INTO core."user" (id, "deletedAt") VALUES ($1, NULL)',
          [orphanUserId],
        );

        const res = await deactivateCoreUserWithAudit({
          dataSource: runtimeDataSource,
          userEntity: CoreUserTestEntity as never,
          userId: orphanUserId,
          auditOperations: [],
          invalidate: async () => undefined,
        });
        expect(res).toBe('deleted');
        await new Promise((resolve) => setImmediate(resolve));
        expect(getCrmAuditHealthSnapshot()).toMatchObject({
          status: 'degraded',
          lastFailureCode: 'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
          countsByCode: { CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE: 1 },
        });
        expect(wiredAlerts).toEqual([
          expect.objectContaining({
            code: 'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
          }),
        ]);
        expect(realErrorSpy).toHaveBeenCalledWith(
          'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
        );
      } finally {
        unsubWired();
        realErrorSpy.mockRestore();
      }
    } finally {
      unsub();
      errorSpy.mockRestore();
    }
  });
});
