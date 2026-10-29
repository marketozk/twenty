import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, NestFactory } from '@nestjs/core';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

for (const [path, name] of [
  ['core-modules/cache-lock/cache-lock.module', 'CacheLockModule'],
  [
    'core-modules/record-share/record-share-storage.module',
    'RecordShareStorageModule',
  ],
  ['workspace-cache/workspace-cache.module', 'WorkspaceCacheModule'],
  ['core-modules/workflow/entities/workflow.entity', 'WorkflowEntity'],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/workspace-schema-migration-runner-action-handlers.module',
    'WorkspaceSchemaMigrationRunnerActionHandlersModule',
  ],
  [
    'core-entity-cache/services/core-entity-cache.service',
    'CoreEntityCacheService',
  ],
  [
    'core-modules/approved-access-domain/services/approved-access-domain.service',
    'ApprovedAccessDomainService',
  ],
  ['core-modules/auth/token/services/login-token.service', 'LoginTokenService'],
  [
    'core-modules/domain/workspace-domains/services/workspace-domains.service',
    'WorkspaceDomainsService',
  ],
  [
    'core-modules/file/file-core-picture/services/file-core-picture.service',
    'FileCorePictureService',
  ],
  ['core-modules/file/file-url/file-url.service', 'FileUrlService'],
  ['core-modules/onboarding/onboarding.service', 'OnboardingService'],
  ['core-modules/user/user.entity', 'UserEntity'],
  [
    'core-modules/workspace-invitation/services/workspace-invitation.service',
    'WorkspaceInvitationService',
  ],
  [
    'metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    'RoleAssignmentValidationService',
  ],
  ['metadata-modules/user-role/user-role.service', 'UserRoleService'],
  ['twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  ['workspace-cache/services/workspace-cache.service', 'WorkspaceCacheService'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  [
    'metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity',
    'DeferredWorkspaceMigrationActionEntity',
  ],
  [
    'core-modules/workflow/services/workflow-run-record-share.service',
    'WorkflowRunRecordShareService',
  ],
  [
    'core-modules/message-queue/services/message-queue.service',
    'MessageQueueService',
  ],
  ['core-modules/metrics/metrics.service', 'MetricsService'],
  ['core-modules/twenty-config/twenty-config.service', 'TwentyConfigService'],
  [
    'metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    'WorkspaceManyOrAllFlatEntityMapsCacheService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service',
    'DeferredWorkspaceMigrationActionHandlerRegistryService',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/provide-workspace-scoped-repository',
  () => ({
    provideWorkspaceScopedRepository: () => ({
      provide: 'test-workflow-repository',
      useValue: {},
    }),
  }),
);
jest.mock('src/engine/twenty-orm/utils/build-system-auth-context.util', () => ({
  buildSystemAuthContext: jest.fn(),
}));
jest.mock(
  'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
  () => ({ WorkspaceMemberWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);

const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const {
  DeferredWorkspaceMigrationActionEntity,
} = require('src/engine/metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity');
const { deleteUserWorkspaceTransaction } =
  require('src/engine/core-modules/user-workspace/delete-user-workspace-transaction') as typeof import('src/engine/core-modules/user-workspace/delete-user-workspace-transaction');
const { UserWorkspaceService } =
  require('src/engine/core-modules/user-workspace/user-workspace.service') as typeof import('src/engine/core-modules/user-workspace/user-workspace.service');
const { DeferredWorkspaceMigrationActionRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service');
const { DeferredWorkspaceMigrationActionRecoveryService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-recovery.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-recovery.service');
const { SyncWorkflowRunSharesDeferredActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/sync-workflow-run-shares-deferred-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/sync-workflow-run-shares-deferred-action-handler.service');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID(),
  membershipId = randomUUID(),
  workflowId = randomUUID(),
  applicationId = randomUUID(),
  applicationUid = randomUUID();
const membershipSchema = new EntitySchema({
  name: 'UserWorkspaceEntity',
  target: UserWorkspaceEntity,
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});
const targetSchema = new EntitySchema({
  name: 'RoleTargetEntity',
  target: RoleTargetEntity,
  schema: 'core',
  tableName: 'roleTarget',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userWorkspaceId: { type: 'uuid' },
  },
});
const deferredSchema = new EntitySchema({
  name: 'DeferredWorkspaceMigrationActionEntity',
  target: DeferredWorkspaceMigrationActionEntity,
  schema: 'core',
  tableName: 'deferredWorkspaceMigrationAction',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    applicationUniversalIdentifier: { type: 'varchar' },
    name: { type: 'varchar' },
    payload: { type: 'jsonb' },
    position: { type: 'integer' },
    runByVersion: { type: 'varchar', nullable: true },
    status: { type: 'varchar', default: 'PENDING' },
    attempts: { type: 'integer', default: 0 },
    lastError: { type: 'text', nullable: true },
    startedAt: { type: 'timestamptz', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const database = new DataSource({
  type: 'postgres',
  url,
  entities: [membershipSchema, targetSchema, deferredSchema],
  extra: { max: 6, statement_timeout: 12000 },
});
const deferredRows = () =>
  database.getRepository(DeferredWorkspaceMigrationActionEntity).find();
const membershipRows = () =>
  database.query('SELECT * FROM core."userWorkspace"');
const targetRows = () => database.query('SELECT * FROM core."roleTarget"');
const scopedDeferredRepository = {
  find: (scope: string, options: object) =>
    database.getRepository(DeferredWorkspaceMigrationActionEntity).find({
      ...options,
      where: { workspaceId: scope, ...(options as { where?: object }).where },
    }),
  update: (scope: string, criteria: object, changes: object) =>
    database
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .update({ ...criteria, workspaceId: scope }, changes),
  delete: (scope: string, criteria: object) =>
    database
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .delete({ ...criteria, workspaceId: scope }),
  createQueryBuilder: () =>
    database
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .createQueryBuilder('deferredWorkspaceMigrationAction'),
};
const queue = { add: jest.fn().mockResolvedValue(undefined) };
const sync = jest.fn().mockResolvedValue(undefined);
const handler = new SyncWorkflowRunSharesDeferredActionHandlerService({
  syncRunsOfCoreWorkflows: sync,
} as never);
const runner = new DeferredWorkspaceMigrationActionRunnerService(
  scopedDeferredRepository as never,
  database,
  queue as never,
  { getOrRecomputeManyOrAllFlatEntityMaps: async () => ({}) } as never,
  { getHandler: () => handler } as never,
  { get: () => 'test-version' } as never,
  { recordHistogram: jest.fn() } as never,
);
const recovery = new DeferredWorkspaceMigrationActionRecoveryService(
  scopedDeferredRepository as never,
  runner,
);
const serviceFixture = () => {
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const invalidateAndRecompute = jest.fn().mockResolvedValue(undefined);
  const logger = { error: jest.fn() };
  const service = Object.assign(Object.create(UserWorkspaceService.prototype), {
    userWorkspaceRepository: database.getRepository(UserWorkspaceEntity),
    workspaceQueue: queue,
    twentyConfigService: { get: () => 'test-version' },
    workflowRunRecordShareService: { syncRunsOfCoreWorkflows: sync },
    coreEntityCacheService: { invalidate },
    workspaceCacheService: { invalidateAndRecompute },
    logger,
  }) as InstanceType<typeof UserWorkspaceService>;
  return { service, invalidate, invalidateAndRecompute, logger };
};
const persist = async ({
  queryRunner,
  coreWorkflowId,
  applicationUniversalIdentifier,
}: {
  queryRunner: QueryRunner;
  coreWorkflowId: string;
  applicationUniversalIdentifier: string;
}) => {
  await runner.persist({
    queryRunner,
    workspaceId,
    applicationUniversalIdentifier,
    deferredActions: [
      {
        name: 'sync_workflowRunShares',
        payload: { version: 1, coreWorkflowId },
      },
    ],
  });
  return async () => {};
};
const remove = (
  overrides: Partial<Parameters<typeof deleteUserWorkspaceTransaction>[0]> = {},
) =>
  deleteUserWorkspaceTransaction({
    dataSource: database,
    entities: { membership: UserWorkspaceEntity, roleTarget: RoleTargetEntity },
    workspaceId,
    userWorkspaceId: membershipId,
    softDelete: false,
    persistReconciliation: persist,
    ...overrides,
  });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

beforeAll(async () => {
  await database.initialize();
  await database.query(
    'DROP SCHEMA IF EXISTS core CASCADE; CREATE SCHEMA core',
  );
  await database.synchronize();
  await database.query(`CREATE TABLE core.workspace(id uuid PRIMARY KEY,"deletedAt" timestamptz);
    CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid);
    CREATE TABLE core.workflow(id uuid PRIMARY KEY,"workspaceId" uuid,"applicationId" uuid,"visibility" text DEFAULT 'PRIVATE',"createdByUserWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE SET NULL);
    ALTER TABLE core."deferredWorkspaceMigrationAction" ADD CONSTRAINT test_workspace_fk FOREIGN KEY("workspaceId") REFERENCES core.workspace(id) ON DELETE CASCADE;`);
});
beforeEach(async () => {
  jest.restoreAllMocks();
  queue.add.mockReset().mockResolvedValue(undefined);
  sync.mockReset().mockResolvedValue(undefined);
  await database.query(
    'TRUNCATE core.workflow,core.application,core.workspace,core."userWorkspace",core."roleTarget",core."deferredWorkspaceMigrationAction" CASCADE',
  );
  await database.query('INSERT INTO core.workspace(id) VALUES($1),($2)', [
    workspaceId,
    foreignWorkspaceId,
  ]);
  await database.query('INSERT INTO core.application VALUES($1,$2,$3)', [
    applicationId,
    workspaceId,
    applicationUid,
  ]);
  await database.query(
    'INSERT INTO core."userWorkspace"(id,"workspaceId") VALUES($1,$2)',
    [membershipId, workspaceId],
  );
  await database.query('INSERT INTO core."roleTarget" VALUES($1,$2,$3)', [
    randomUUID(),
    workspaceId,
    membershipId,
  ]);
  await database.query(
    'INSERT INTO core.workflow(id,"workspaceId","applicationId","createdByUserWorkspaceId") VALUES($1,$2,$3,$4)',
    [workflowId, workspaceId, applicationId, membershipId],
  );
});
afterAll(async () => {
  await database.query('DROP SCHEMA IF EXISTS core CASCADE');
  await database.destroy();
});

it('deletes targets and membership and persists original workflow identity in one commit', async () => {
  expect(await remove()).toEqual([workflowId]);
  expect(await membershipRows()).toEqual([]);
  expect(await targetRows()).toEqual([]);
  expect(
    await database.query(
      'SELECT "createdByUserWorkspaceId" FROM core.workflow',
    ),
  ).toEqual([{ createdByUserWorkspaceId: null }]);
  expect(await deferredRows()).toEqual([
    expect.objectContaining({
      workspaceId,
      applicationUniversalIdentifier: applicationUid,
      name: 'sync_workflowRunShares',
      payload: { version: 1, coreWorkflowId: workflowId },
      status: 'PENDING',
      runByVersion: 'test-version',
    }),
  ]);
});
it('retains targets and creator on soft-delete without scheduling reconciliation', async () => {
  expect(await remove({ softDelete: true })).toEqual([]);
  expect((await membershipRows())[0].deletedAt).toBeInstanceOf(Date);
  expect(await targetRows()).toHaveLength(1);
  expect(await deferredRows()).toEqual([]);
});
it.each([false, true])(
  'rejects foreign workspace on hard/soft deletion (%s)',
  async (softDelete) => {
    await expect(
      remove({ workspaceId: foreignWorkspaceId, softDelete }),
    ).rejects.toThrow('workspace mismatch');
    expect(await membershipRows()).toHaveLength(1);
    expect(await targetRows()).toHaveLength(1);
    expect(await deferredRows()).toEqual([]);
  },
);
it('handles an already removed membership without duplicate intents', async () => {
  await remove();
  expect(await remove()).toEqual([]);
  expect(await deferredRows()).toHaveLength(1);
});
it('rolls back deletion if intent persistence fails', async () => {
  await expect(
    remove({
      persistReconciliation: async (args) => {
        await persist(args);
        throw new Error('intent fault');
      },
    }),
  ).rejects.toThrow('intent fault');
  expect(await membershipRows()).toHaveLength(1);
  expect(await targetRows()).toHaveLength(1);
  expect(await deferredRows()).toEqual([]);
});
it('rolls back deleted targets and intent when membership DELETE fails', async () => {
  await database.query(
    'CREATE TABLE core.restrict_delete(id uuid REFERENCES core."userWorkspace"(id))',
  );
  await database.query('INSERT INTO core.restrict_delete VALUES($1)', [
    membershipId,
  ]);
  try {
    await expect(remove()).rejects.toThrow();
    expect(await targetRows()).toHaveLength(1);
    expect(await membershipRows()).toHaveLength(1);
    expect(await deferredRows()).toEqual([]);
  } finally {
    await database.query('DROP TABLE core.restrict_delete');
  }
});
it.each(['roleTarget', 'userWorkspace'])(
  'rolls back when a trigger silently skips %s deletion',
  async (table) => {
    await database.query(`CREATE FUNCTION core.skip_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER skip_delete BEFORE DELETE ON core."${table}" FOR EACH ROW EXECUTE FUNCTION core.skip_delete()`);
    try {
      await expect(remove()).rejects.toThrow('was not applied');
      expect(await membershipRows()).toHaveLength(1);
      expect(await targetRows()).toHaveLength(1);
      expect(await deferredRows()).toEqual([]);
    } finally {
      await database.query(
        `DROP TRIGGER skip_delete ON core."${table}"; DROP FUNCTION core.skip_delete()`,
      );
    }
  },
);
it('refuses silently skipped soft deletion', async () => {
  await database.query(`CREATE FUNCTION core.skip_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER skip_update BEFORE UPDATE ON core."userWorkspace" FOR EACH ROW EXECUTE FUNCTION core.skip_update()`);
  try {
    await expect(remove({ softDelete: true })).rejects.toThrow(
      'was not applied',
    );
    expect((await membershipRows())[0].deletedAt).toBeNull();
  } finally {
    await database.query(
      'DROP TRIGGER skip_update ON core."userWorkspace"; DROP FUNCTION core.skip_update()',
    );
  }
});
it.each(['workflow', 'target'])(
  'refuses cross-workspace %s dependencies',
  async (kind) => {
    await database.query(
      kind === 'workflow'
        ? 'UPDATE core.workflow SET "workspaceId"=$1'
        : 'UPDATE core."roleTarget" SET "workspaceId"=$1',
      [foreignWorkspaceId],
    );
    await expect(remove()).rejects.toThrow('foreign dependencies');
    expect(await deferredRows()).toEqual([]);
    expect(await membershipRows()).toHaveLength(1);
  },
);
it('refuses an application from another workspace', async () => {
  await database.query('UPDATE core.application SET "workspaceId"=$1', [
    foreignWorkspaceId,
  ]);
  await expect(remove()).rejects.toThrow('application unavailable');
  expect(await deferredRows()).toEqual([]);
});
it('teardown deletes membership without scheduling native reconciliation', async () => {
  await database.query(
    'UPDATE core.workspace SET "deletedAt"=now() WHERE id=$1',
    [workspaceId],
  );
  expect(await remove()).toEqual([]);
  expect(await membershipRows()).toEqual([]);
  expect(await deferredRows()).toEqual([]);
});
it('new workflow FK references cannot enter after membership locking', async () => {
  const entered = gate(),
    release = gate();
  const deleting = remove({
    persistReconciliation: async (args) => {
      const verify = await persist(args);
      entered.release();
      await release.promise;
      return verify;
    },
  });
  await entered.promise;
  let inserted = false;
  const inserting = database
    .query(
      'INSERT INTO core.workflow(id,"workspaceId","applicationId","createdByUserWorkspaceId") VALUES($1,$2,$3,$4)',
      [randomUUID(), workspaceId, applicationId, membershipId],
    )
    .then(
      () => {
        inserted = true;
      },
      (error) => error,
    );
  release.release();
  await deleting;
  expect(await inserting).toBeInstanceOf(Error);
  expect(inserted).toBe(false);
});
it('serializes two deletions without duplicate intents', async () => {
  const results = await Promise.all([remove(), remove()]);
  expect(results.flat()).toEqual([workflowId]);
  expect(await deferredRows()).toHaveLength(1);
});
it('lost COMMIT acknowledgement retains committed intent for recovery', async () => {
  const original = database.createQueryRunner.bind(database);
  const sql: string[] = [];
  jest.spyOn(database, 'createQueryRunner').mockImplementation((mode) => {
    const queryRunner = original(mode);
    const connect = queryRunner.connect.bind(queryRunner);
    let wrapped = false;
    queryRunner.connect = async () => {
      const client = await connect();
      if (!wrapped) {
        wrapped = true;
        const query = client.query.bind(client);
        client.query = async (statement: string, ...args: unknown[]) => {
          sql.push(statement);
          const result = await query(statement, ...args);
          if (statement === 'COMMIT') throw new Error('lost ACK');
          return result;
        };
      }
      return client;
    };
    return queryRunner;
  });
  const { service, invalidate } = serviceFixture();
  await expect(
    service.deleteUserWorkspace({
      auditOperation: undefined,
      expectedUserId: undefined,
      workspaceId,
      userWorkspaceId: membershipId,
    }),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  jest.restoreAllMocks();
  expect(sql.filter((s) => s === 'COMMIT')).toHaveLength(1);
  expect(sql).not.toContain('ROLLBACK');
  expect(invalidate).toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(queue.add).not.toHaveBeenCalled();
  expect(await membershipRows()).toEqual([]);
  expect(await deferredRows()).toHaveLength(1);
  expect(await recovery.enqueueWorkspacesWithPendingActions()).toBe(1);
  expect(queue.add).toHaveBeenCalled();
});
it('Redis failure does not discard durable pending intent; recovery enqueues it', async () => {
  await remove();
  queue.add.mockRejectedValueOnce(new Error('redis unavailable'));
  await expect(runner.enqueue(workspaceId)).resolves.toBeUndefined();
  expect(await deferredRows()).toHaveLength(1);
  expect(await recovery.enqueueWorkspacesWithPendingActions()).toBe(1);
  expect(queue.add).toHaveBeenCalledTimes(2);
});
it('actual service persists before queue and immediate share reconciliation, invalidating membership caches', async () => {
  const { service, invalidate, invalidateAndRecompute } = serviceFixture();
  sync.mockImplementationOnce(async () => {
    expect(await membershipRows()).toEqual([]);
    expect(await deferredRows()).toHaveLength(1);
  });
  await service.deleteUserWorkspace({
    auditOperation: undefined,
    expectedUserId: undefined,
    workspaceId,
    userWorkspaceId: membershipId,
  });
  expect(queue.add).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith({
    workspaceId,
    coreWorkflowIds: [workflowId],
  });
  expect(invalidate).toHaveBeenCalledWith('userWorkspaceEntity', membershipId);
  expect(invalidateAndRecompute).toHaveBeenCalledWith(workspaceId, [
    'flatRoleTargetMaps',
    'userApplicationVariableValueMaps',
  ]);
});
it('actual service reports share failure with deletion committed and recovery intent retained', async () => {
  const { service, invalidate } = serviceFixture();
  sync.mockRejectedValueOnce(new Error('immediate share failure'));
  await expect(
    service.deleteUserWorkspace({
      auditOperation: undefined,
      expectedUserId: undefined,
      workspaceId,
      userWorkspaceId: membershipId,
    }),
  ).rejects.toThrow('immediate share failure');
  expect(await membershipRows()).toEqual([]);
  expect(await deferredRows()).toHaveLength(1);
  expect(invalidate).toHaveBeenCalled();
  await runner.runPendingActions(workspaceId);
  expect(await deferredRows()).toEqual([]);
});
it('actual service refuses an intent INSERT silently skipped by a trigger', async () => {
  await database.query(`CREATE FUNCTION core.skip_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER skip_intent BEFORE INSERT ON core."deferredWorkspaceMigrationAction" FOR EACH ROW EXECUTE FUNCTION core.skip_intent()`);
  try {
    await expect(
      serviceFixture().service.deleteUserWorkspace({
        auditOperation: undefined,
        expectedUserId: undefined,
        workspaceId,
        userWorkspaceId: membershipId,
      }),
    ).rejects.toThrow('not persisted');
    expect(await membershipRows()).toHaveLength(1);
    expect(await targetRows()).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
  } finally {
    await database.query(
      'DROP TRIGGER skip_intent ON core."deferredWorkspaceMigrationAction"; DROP FUNCTION core.skip_intent()',
    );
  }
});
it.each([
  "NEW.status := 'FAILED'",
  "NEW.payload := '{}'::jsonb",
  "NEW.name := 'delete_workflowRuns'",
  'NEW.attempts := 3',
])(
  'actual service rejects a rewritten recovery intent: %s',
  async (rewrite) => {
    await database.query(`CREATE FUNCTION core.rewrite_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${rewrite}; RETURN NEW; END $$;
    CREATE TRIGGER rewrite_intent BEFORE INSERT ON core."deferredWorkspaceMigrationAction" FOR EACH ROW EXECUTE FUNCTION core.rewrite_intent()`);
    try {
      await expect(
        serviceFixture().service.deleteUserWorkspace({
          auditOperation: undefined,
          expectedUserId: undefined,
          workspaceId,
          userWorkspaceId: membershipId,
        }),
      ).rejects.toThrow('intent changed');
      expect(await membershipRows()).toHaveLength(1);
      expect(await targetRows()).toHaveLength(1);
      expect(await deferredRows()).toEqual([]);
    } finally {
      await database.query(
        'DROP TRIGGER rewrite_intent ON core."deferredWorkspaceMigrationAction"; DROP FUNCTION core.rewrite_intent()',
      );
    }
  },
);
it('actual service rechecks durable intent after membership DELETE triggers', async () => {
  await database.query(`CREATE FUNCTION core.erase_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM core."deferredWorkspaceMigrationAction"; RETURN OLD; END $$;
    CREATE TRIGGER erase_intent AFTER DELETE ON core."userWorkspace" FOR EACH ROW EXECUTE FUNCTION core.erase_intent()`);
  try {
    await expect(
      serviceFixture().service.deleteUserWorkspace({
        auditOperation: undefined,
        expectedUserId: undefined,
        workspaceId,
        userWorkspaceId: membershipId,
      }),
    ).rejects.toThrow('intent changed');
    expect(await membershipRows()).toHaveLength(1);
    expect(await targetRows()).toHaveLength(1);
  } finally {
    await database.query(
      'DROP TRIGGER erase_intent ON core."userWorkspace"; DROP FUNCTION core.erase_intent()',
    );
  }
});
it('actual module providers inject the existing share service and the registry discovers the handler', async () => {
  const {
    WorkflowRunRecordShareModule,
  } = require('src/engine/core-modules/workflow/workflow-run-record-share.module');
  const {
    WorkflowRunRecordShareService,
  } = require('src/engine/core-modules/workflow/services/workflow-run-record-share.service');
  const {
    DeferredWorkspaceMigrationActionHandlerRegistryService: ActualRegistry,
  } = jest.requireActual(
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service',
  );
  const originalProviders = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    WorkflowRunRecordShareModule,
  );
  class FixtureModule {}
  Module({
    imports: [DiscoveryModule],
    providers: [
      ...originalProviders.filter(
        (provider: unknown) => provider !== WorkflowRunRecordShareService,
      ),
      {
        provide: WorkflowRunRecordShareService,
        useValue: { syncRunsOfCoreWorkflows: sync },
      },
      ActualRegistry,
    ],
  })(FixtureModule);
  const app = await NestFactory.createApplicationContext(FixtureModule, {
    logger: false,
  });
  const queryRunner = database.createQueryRunner();
  try {
    const registered = app
      .get(ActualRegistry)
      .getHandler('sync_workflowRunShares');
    expect(registered).toBe(
      app.get(SyncWorkflowRunSharesDeferredActionHandlerService),
    );
    await registered.execute({
      workspaceId,
      queryRunner,
      payload: { version: 1, coreWorkflowId: workflowId },
    });
    expect(sync).toHaveBeenCalledWith({
      workspaceId,
      coreWorkflowIds: [workflowId],
    });
  } finally {
    await queryRunner.release();
    await app.close();
  }
});
it('actual service soft-delete neither dispatches nor reconciles and preserves role targets', async () => {
  const { service, invalidate } = serviceFixture();
  await service.deleteUserWorkspace({
    auditOperation: undefined,
    expectedUserId: undefined,
    workspaceId,
    userWorkspaceId: membershipId,
    softDelete: true,
  });
  expect(queue.add).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(await targetRows()).toHaveLength(1);
  expect(invalidate).toHaveBeenCalled();
});
it('cache failure is reported without masking the original transaction failure', async () => {
  const { service, invalidate, logger } = serviceFixture();
  invalidate.mockRejectedValueOnce(new Error('cache offline'));
  await expect(
    service.deleteUserWorkspace({
      auditOperation: undefined,
      expectedUserId: undefined,
      workspaceId: foreignWorkspaceId,
      userWorkspaceId: membershipId,
    }),
  ).rejects.toThrow('workspace mismatch');
  expect(logger.error).toHaveBeenCalled();
  expect(await membershipRows()).toHaveLength(1);
});
it('a worker interrupted after applying shares replays the durable intent', async () => {
  await remove();
  const originalDelete = scopedDeferredRepository.delete;
  jest
    .spyOn(scopedDeferredRepository, 'delete')
    .mockRejectedValueOnce(new Error('completion write lost'));
  await expect(runner.runPendingActions(workspaceId)).rejects.toThrow('failed');
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await deferredRows()).toHaveLength(1);
  scopedDeferredRepository.delete = originalDelete;
  await runner.runPendingActions(workspaceId);
  expect(sync).toHaveBeenCalledTimes(2);
  expect(await deferredRows()).toEqual([]);
});
it('worker failure keeps intent pending and a replay calls current-state share service', async () => {
  await remove();
  sync.mockRejectedValueOnce(new Error('share fault'));
  await expect(runner.runPendingActions(workspaceId)).rejects.toThrow('failed');
  expect(await deferredRows()).toEqual([
    expect.objectContaining({ status: 'PENDING', attempts: 1 }),
  ]);
  await database.query('UPDATE core.workflow SET visibility=$1', ['WORKSPACE']);
  await runner.runPendingActions(workspaceId);
  expect(sync).toHaveBeenLastCalledWith({
    workspaceId,
    coreWorkflowIds: [workflowId],
  });
  expect(await deferredRows()).toEqual([]);
});
it('exhausted retries remain FAILED and the existing manual retry recovers them', async () => {
  await remove();
  sync.mockRejectedValue(new Error('shares unavailable'));
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(runner.runPendingActions(workspaceId)).rejects.toThrow(
      'failed',
    );
  expect(await deferredRows()).toEqual([
    expect.objectContaining({ status: 'FAILED', attempts: 3 }),
  ]);
  expect(await recovery.retryFailedActions(workspaceId)).toBe(1);
  sync.mockResolvedValue(undefined);
  await runner.runPendingActions(workspaceId);
  expect(await deferredRows()).toEqual([]);
});
it.each(['workspace', 'workflow'])(
  'recovery skips a removed %s',
  async (kind) => {
    await remove();
    if (kind === 'workspace')
      await database.query(
        'UPDATE core.workspace SET "deletedAt"=now() WHERE id=$1',
        [workspaceId],
      );
    else await database.query('DELETE FROM core.workflow');
    await runner.runPendingActions(workspaceId);
    expect(sync).not.toHaveBeenCalled();
    expect(await deferredRows()).toEqual([]);
  },
);
it.each([
  { version: 2, coreWorkflowId: workflowId },
  { version: 1, coreWorkflowId: 'bad' },
  { version: 1, coreWorkflowId: workflowId, access: 'WORKSPACE' },
])(
  'rejects malformed or snapshot-bearing deferred payload %j',
  async (payload) => {
    const queryRunner = database.createQueryRunner();
    try {
      await expect(
        handler.execute({ workspaceId, payload, queryRunner } as never),
      ).rejects.toThrow('payload invalid');
    } finally {
      await queryRunner.release();
    }
  },
);
