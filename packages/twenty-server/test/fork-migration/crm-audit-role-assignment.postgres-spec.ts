import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { withRoleAssignmentAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { deleteUserWorkspaceTransaction } from 'src/engine/core-modules/user-workspace/delete-user-workspace-transaction';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));
for (const [path, name] of [
  ['core-modules/application/application.service', 'ApplicationService'],
  [
    'workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    'WorkspaceMigrationValidateBuildAndRunService',
  ],
  [
    'core-modules/feature-flag/services/feature-flag.service',
    'FeatureFlagService',
  ],
  ['core-modules/logger/logger.service', 'LoggerService'],
  ['core-modules/metrics/metrics.service', 'MetricsService'],
  ['core-modules/twenty-config/twenty-config.service', 'TwentyConfigService'],
  [
    'metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    'WorkspaceManyOrAllFlatEntityMapsCacheService',
  ],
  [
    'metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    'WorkspaceMetadataVersionService',
  ],
  ['workspace-cache/services/workspace-cache.service', 'WorkspaceCacheService'],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    'InFlightDeferredWorkspaceMigrationActionsService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    'DeferredWorkspaceMigrationActionRunnerService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    'WorkspaceMigrationRunnerActionHandlerRegistryService',
  ],
  ['twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    'RoleAssignmentValidationService',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
jest.mock('src/engine/twenty-orm/utils/build-system-auth-context.util', () => ({
  buildSystemAuthContext: (workspaceId: string) => ({
    workspace: { id: workspaceId },
    type: 'system',
  }),
}));
jest.mock(
  'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
  () => ({ WorkspaceMemberWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({
    WorkspaceMigrationRunnerActionHandler: () =>
      class {
        async insertFlatEntitiesInRepository({
          queryRunner,
          flatEntities,
        }: {
          queryRunner: QueryRunner;
          flatEntities: object[];
        }) {
          await queryRunner.manager.getRepository(RoleTargetEntity).insert(
            flatEntities.map((flatEntity) =>
              flatEntityToScalarFlatEntity({
                metadataName: 'roleTarget',
                flatEntity: flatEntity as never,
              }),
            ),
          );
        }
        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: { universalIdentifier: string };
          allFlatEntityMaps: {
            flatRoleTargetMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
          };
        }) {
          return {
            ...context.action,
            entityId:
              context.allFlatEntityMaps.flatRoleTargetMaps
                .byUniversalIdentifier[context.action.universalIdentifier].id,
          };
        }
      },
  }),
);
const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { UserRoleService } =
  require('src/engine/metadata-modules/user-role/user-role.service') as typeof import('src/engine/metadata-modules/user-role/user-role.service');
const { AssignRoleToWorkspaceMemberTool } =
  require('src/engine/metadata-modules/role/tools/assign-role-to-workspace-member.tool') as typeof import('src/engine/metadata-modules/role/tools/assign-role-to-workspace-member.tool');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');
const databaseRole = `assignment_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(),
  applicationId = randomUUID(),
  applicationUniversalIdentifier = randomUUID();
const memberId = randomUUID(),
  userId = randomUUID(),
  userWorkspaceId = randomUUID(),
  actorId = randomUUID();
const adminRoleId = randomUUID(),
  destinationId = randomUUID(),
  destinationUniversalIdentifier = randomUUID();
const application = {
  id: applicationId,
  universalIdentifier: applicationUniversalIdentifier,
};
const membershipSchema = new EntitySchema({
  name: 'UserWorkspaceEntity',
  target: UserWorkspaceEntity,
  tableName: 'userWorkspace',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});
const targetSchema = new EntitySchema({
  name: 'RoleTargetEntity',
  target: RoleTargetEntity,
  tableName: 'roleTarget',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    userWorkspaceId: { type: 'uuid', nullable: true },
    agentId: { type: 'uuid', nullable: true },
    apiKeyId: { type: 'uuid', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
  uniques: [
    { columns: ['workspaceId', 'userWorkspaceId'] },
    { columns: ['workspaceId', 'universalIdentifier'] },
  ],
});
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-assignment-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
type Row = Record<string, unknown> & {
  id: string;
  universalIdentifier: string;
};
const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY id');
const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY id');
const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const identity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
});
const assignment = () => ({
  workspaceId,
  workspaceMemberId: memberId,
  userId,
  userWorkspaceId,
  roleId: destinationId,
});
const entityMaps = (records: Row[]) => ({
  byUniversalIdentifier: Object.fromEntries(
    records.map((r) => [r.universalIdentifier, r]),
  ),
  universalIdentifierById: Object.fromEntries(
    records.map((r) => [r.id, r.universalIdentifier]),
  ),
});
const flatMaps = async () => ({
  flatRoleMaps: entityMaps(await roles()),
  flatRoleTargetMaps: entityMaps(await targets()),
  flatAgentMaps: entityMaps([]),
  flatApplicationMaps: { byId: { [applicationId]: application } },
});
type CreateAction = {
  type: 'create';
  metadataName: 'roleTarget';
  id: string;
  flatEntity: Record<string, unknown>;
};
type DeleteAction = {
  type: 'delete';
  metadataName: 'roleTarget';
  universalIdentifier: string;
};
type Action = CreateAction | DeleteAction;
const makeActions = async (membership = userWorkspaceId): Promise<Action[]> => {
  const old = (await targets()).find((r) => r.userWorkspaceId === membership),
    now = new Date().toISOString();
  return [
    ...(old
      ? [
          {
            type: 'delete' as const,
            metadataName: 'roleTarget' as const,
            universalIdentifier: old.universalIdentifier,
          },
        ]
      : []),
    {
      type: 'create',
      metadataName: 'roleTarget',
      id: randomUUID(),
      flatEntity: {
        universalIdentifier: randomUUID(),
        roleUniversalIdentifier: destinationUniversalIdentifier,
        userWorkspaceId: membership,
        agentUniversalIdentifier: null,
        apiKeyId: null,
        applicationUniversalIdentifier,
        createdAt: now,
        updatedAt: now,
      },
    },
  ];
};
const fixture = async (
  options: {
    fail?: boolean;
    deferred?: boolean;
    maps?: Awaited<ReturnType<typeof flatMaps>>;
  } = {},
) => {
  const maps = options.maps ?? (await flatMaps());
  const create = new CreateRoleTargetActionHandlerService(),
    remove = new DeleteRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      if (context.action.type === 'create') {
        const flatAction =
          await create.transpileUniversalActionToFlatAction(context);
        await create.executeForMetadata({ ...context, flatAction });
      } else {
        const flatAction =
          await remove.transpileUniversalActionToFlatAction(context);
        await remove.executeForMetadata({ ...context, flatAction });
      }
      if (options.fail) throw new Error('handler failure');
      return {
        partialOptimisticCache: {},
        metadataEvents: [{}],
        deferredActions: options.deferred ? [{}] : [],
      };
    }),
    executeActionRollbackHandler: jest.fn(),
  };
  const cache = {
    getOrRecompute: async () => ({
      flatApplicationMaps: {
        byId: { [applicationId]: application },
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
      },
    }),
    invalidateAndRecompute: jest.fn(async () => {}),
  };
  const logger = {
    perf: jest.fn(),
    perfTime: jest.fn(),
    perfTimeEnd: jest.fn(),
    error: jest.fn(),
  };
  const migration = new WorkspaceMigrationRunnerService(
    { getOrRecomputeManyOrAllFlatEntityMaps: async () => maps } as never,
    runtime,
    registry as never,
    {} as never,
    cache as never,
    { recordHistogram: jest.fn() } as never,
    logger as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    { persist: jest.fn(), dispatchAfterCommit: jest.fn() } as never,
    {} as never,
  );
  return { migration, registry, cache, maps };
};
const run = async (
  actions?: Action[],
  options: Parameters<typeof fixture>[0] = {},
  request = assignment(),
  who = identity(),
) => {
  const f = await fixture(options),
    plan = actions ?? (await makeActions(request.userWorkspaceId));
  const result = await withRoleAssignmentAudit(request, who, () =>
    f.migration.run({
      workspaceId,
      workspaceMigration: {
        applicationUniversalIdentifier,
        actions: plan,
      } as never,
    }),
  );
  return { ...f, result };
};
const addMember = async (
  id = memberId,
  membership = userWorkspaceId,
  user = userId,
  role = adminRoleId,
) => {
  await owner.query(
    'INSERT INTO core."userWorkspace" (id,"workspaceId","userId") VALUES($1,$2,$3)',
    [membership, workspaceId, user],
  );
  await owner.query(
    'INSERT INTO synthetic_members."workspaceMember" (id,"userId") VALUES($1,$2)',
    [id, user],
  );
  if (role)
    await owner.getRepository(RoleTargetEntity).insert({
      id: randomUUID(),
      workspaceId,
      applicationId,
      universalIdentifier: randomUUID(),
      roleId: role,
      userWorkspaceId: membership,
    });
};
beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE; CREATE SCHEMA core; CREATE SCHEMA synthetic_members',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"deletedAt" timestamptz); CREATE TABLE core.role(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"canBeAssignedToUsers" boolean); ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE; CREATE TABLE synthetic_members."workspaceMember"(id uuid PRIMARY KEY,"userId" uuid,"deletedAt" timestamptz); CREATE TABLE core.workflow(id uuid PRIMARY KEY,"workspaceId" uuid,"applicationId" uuid,"createdByUserWorkspaceId" uuid)',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"databaseSchema") VALUES($1,$2)',
    [workspaceId, 'synthetic_members'],
  );
  await owner.query(
    'CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-assignment-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit,synthetic_members TO "${databaseRole}"; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core,synthetic_members TO "${databaseRole}"; GRANT INSERT,DELETE ON core."roleTarget" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query('TRUNCATE core.application');
  await owner.query('INSERT INTO core.application VALUES($1,$2,$3,NULL)', [
    applicationId,
    workspaceId,
    applicationUniversalIdentifier,
  ]);
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.corrupt_audit(); TRUNCATE core."roleTarget",core.role,core."userWorkspace",synthetic_members."workspaceMember",crm_audit."crmAuditEntry"',
  );
  await owner.query(
    'INSERT INTO core.role VALUES($1,$2,$3,true),($4,$2,$5,true)',
    [
      adminRoleId,
      workspaceId,
      STANDARD_ROLE.admin.universalIdentifier,
      destinationId,
      destinationUniversalIdentifier,
    ],
  );
  await addMember();
  await addMember(randomUUID(), randomUUID(), randomUUID());
});
afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

it('replaces one roleTarget through the real runner and handlers with two atomic audit entries', async () => {
  const old = (await targets()).find(
    (r) => r.userWorkspaceId === userWorkspaceId,
  )!;
  await run();
  expect(
    (await targets()).find((r) => r.userWorkspaceId === userWorkspaceId)
      ?.roleId,
  ).toBe(destinationId);
  const entries = await audits();
  expect(entries).toHaveLength(2);
  expect(entries.map((e) => e.action).sort()).toEqual(['create', 'delete']);
  expect(new Set(entries.map((e) => e.operationId)).size).toBe(1);
  expect(entries.find((e) => e.action === 'delete')?.resourceId).toBe(old.id);
  expect(entries[0].actor).toEqual({ kind: 'workspaceMember', id: actorId });
});
const signal = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const observeWorkspaceFence = (
  source: DataSource,
  entered: ReturnType<typeof signal>,
) => {
  const create = source.createQueryRunner.bind(source);
  jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
    const queryRunner = create(mode),
      query = queryRunner.query.bind(queryRunner);
    queryRunner.query = (
      sql: string,
      parameters?: unknown[],
      structured?: true,
    ) => {
      if (sql.includes('FOR NO KEY UPDATE')) entered.release();
      return structured ? query(sql, parameters, true) : query(sql, parameters);
    };
    return queryRunner;
  });
};
const removeMembership = (persistReconciliation = async () => async () => {}) =>
  deleteUserWorkspaceTransaction({
    dataSource: owner,
    entities: { membership: UserWorkspaceEntity, roleTarget: RoleTargetEntity },
    workspaceId,
    userWorkspaceId,
    softDelete: false,
    persistReconciliation,
  });
it('assignment first: deletion waits for its commit, then removes the replacement target', async () => {
  const assigned = signal(),
    release = signal(),
    deleting = signal();
  const flush = CrmAuditTransactionContext.prototype.flush;
  jest
    .spyOn(CrmAuditTransactionContext.prototype, 'flush')
    .mockImplementation(async function (this: CrmAuditTransactionContext) {
      const result = await flush.call(this);
      assigned.release();
      await release.promise;
      return result;
    });
  const assigning = run();
  await assigned.promise;
  observeWorkspaceFence(owner, deleting);
  const removing = removeMembership();
  await deleting.promise;
  release.release();
  await assigning;
  await removing;
  expect(
    (await targets()).filter(
      (target) => target.userWorkspaceId === userWorkspaceId,
    ),
  ).toEqual([]);
  expect(
    await owner.query('SELECT id FROM core."userWorkspace" WHERE id=$1', [
      userWorkspaceId,
    ]),
  ).toEqual([]);
  expect(await audits()).toHaveLength(2);
});
it('deletion first: an already prepared assignment waits, then refuses the missing membership', async () => {
  const plan = await makeActions(),
    maps = await flatMaps();
  const deleting = signal(),
    release = signal(),
    assigning = signal();
  await owner.query('INSERT INTO core.workflow VALUES($1,$2,$3,$4)', [
    randomUUID(),
    workspaceId,
    applicationId,
    userWorkspaceId,
  ]);
  const removing = removeMembership(async () => {
    deleting.release();
    await release.promise;
    return async () => {};
  });
  await deleting.promise;
  observeWorkspaceFence(runtime, assigning);
  const assignmentResult = run(plan, { maps }).then(
    () => undefined,
    (error: Error) => error,
  );
  await assigning.promise;
  release.release();
  await removing;
  expect(await assignmentResult).toBeInstanceOf(Error);
  expect(
    (await targets()).filter(
      (target) => target.userWorkspaceId === userWorkspaceId,
    ),
  ).toEqual([]);
  expect(await audits()).toEqual([]);
  await owner.query('DELETE FROM core.workflow');
});
it('audits an initial assignment with no old target', async () => {
  await owner.query(
    'DELETE FROM core."roleTarget" WHERE "userWorkspaceId"=$1',
    [userWorkspaceId],
  );
  await run();
  expect(await audits()).toHaveLength(1);
});

it.each(['missing', 'foreign', 'deleted', 'universalIdentifier'])(
  'rejects stale application ownership on role assignment: %s',
  async (kind) => {
    if (kind === 'missing') await owner.query('DELETE FROM core.application');
    if (kind === 'foreign')
      await owner.query('UPDATE core.application SET "workspaceId"=$1', [
        randomUUID(),
      ]);
    if (kind === 'deleted')
      await owner.query('UPDATE core.application SET "deletedAt"=now()');
    if (kind === 'universalIdentifier')
      await owner.query(
        'UPDATE core.application SET "universalIdentifier"=$1',
        [randomUUID()],
      );
    const before = await targets();
    await expect(run()).rejects.toThrow('application ownership');
    expect(await targets()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('rechecks application ownership after assignment audit flush', async () => {
  await owner.query(
    'CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core.application SET "deletedAt"=now(); RETURN NEW; END $$; CREATE TRIGGER corrupt_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()',
  );
  const before = await targets();
  await expect(run()).rejects.toThrow('application ownership');
  expect(await targets()).toEqual(before);
  expect(await audits()).toEqual([]);
});
it.each(['audit', 'sql', 'handler', 'deferred'])(
  'rolls back assignment on %s failure',
  async (failure) => {
    const before = await targets();
    if (failure === 'audit')
      await owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
      );
    if (failure === 'sql')
      await owner.query(
        `REVOKE INSERT ON core."roleTarget" FROM "${databaseRole}"`,
      );
    try {
      await expect(
        run(undefined, {
          fail: failure === 'handler',
          deferred: failure === 'deferred',
        }),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON core."roleTarget",crm_audit."crmAuditEntry" TO "${databaseRole}"`,
      );
    }
    expect(await targets()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);
it.each([
  'foreign-membership',
  'missing-membership',
  'changed-user',
  'deleted-member',
  'nonassignable',
  'self',
])('refuses %s before handlers', async (kind) => {
  if (kind === 'foreign-membership')
    await owner.query(
      'UPDATE core."userWorkspace" SET "workspaceId"=$1 WHERE id=$2',
      [randomUUID(), userWorkspaceId],
    );
  if (kind === 'missing-membership')
    await owner.query('DELETE FROM core."userWorkspace" WHERE id=$1', [
      userWorkspaceId,
    ]);
  if (kind === 'changed-user')
    await owner.query(
      'UPDATE synthetic_members."workspaceMember" SET "userId"=$1 WHERE id=$2',
      [randomUUID(), memberId],
    );
  if (kind === 'deleted-member')
    await owner.query(
      'UPDATE synthetic_members."workspaceMember" SET "deletedAt"=now() WHERE id=$1',
      [memberId],
    );
  if (kind === 'nonassignable')
    await owner.query(
      'UPDATE core.role SET "canBeAssignedToUsers"=false WHERE id=$1',
      [destinationId],
    );
  const request = {
      ...assignment(),
      ...(kind === 'self' ? { actingUserWorkspaceId: userWorkspaceId } : {}),
    },
    before = await targets();
  await expect(run(undefined, {}, request)).rejects.toThrow();
  expect(await targets()).toEqual(before);
  expect(await audits()).toEqual([]);
});
it('rejects last administrator demotion from fresh database state', async () => {
  await owner.query(
    'DELETE FROM core."roleTarget" WHERE "userWorkspaceId"<>$1',
    [userWorkspaceId],
  );
  await expect(run()).rejects.toThrow('last administrator');
  expect(await audits()).toEqual([]);
});
it('serializes two concurrent demotions so one administrator remains', async () => {
  const [other] = await owner.query(
    'SELECT u.id AS membership,u."userId" AS user,m.id AS member FROM core."userWorkspace" u JOIN synthetic_members."workspaceMember" m ON m."userId"=u."userId" WHERE u.id<>$1',
    [userWorkspaceId],
  );
  const results = await Promise.allSettled([
    run(),
    run(
      undefined,
      {},
      {
        ...assignment(),
        userWorkspaceId: other.membership,
        userId: other.user,
        workspaceMemberId: other.member,
      },
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    (await targets()).filter((r) => r.roleId === adminRoleId),
  ).toHaveLength(1);
  expect(await audits()).toHaveLength(2);
});
it('refuses a stale deletion plan instead of replacing another current assignment', async () => {
  const actions = await makeActions(),
    maps = await flatMaps();
  await owner.query(
    'UPDATE core."roleTarget" SET "universalIdentifier"=$1 WHERE "userWorkspaceId"=$2',
    [randomUUID(), userWorkspaceId],
  );
  const before = await targets();
  await expect(run(actions, { maps })).rejects.toThrow('old target changed');
  expect(await targets()).toEqual(before);
});
it.each([
  'target',
  'application',
  'role',
  'extra',
  'missing-delete',
  'wrong-order',
])('rejects invalid final assignment plan %s', async (kind) => {
  const actions = await makeActions(),
    create = actions.at(-1)! as CreateAction;
  if (kind === 'target') create.flatEntity.userWorkspaceId = randomUUID();
  if (kind === 'application')
    create.flatEntity.applicationUniversalIdentifier = randomUUID();
  if (kind === 'role') create.flatEntity.roleUniversalIdentifier = randomUUID();
  if (kind === 'extra') actions.push({ ...create });
  if (kind === 'missing-delete') actions.shift();
  if (kind === 'wrong-order') actions.reverse();
  const before = await targets();
  await expect(run(actions)).rejects.toThrow();
  expect(await targets()).toEqual(before);
  expect(await audits()).toEqual([]);
});
it('rolls back audit-trigger corruption of the replacement', async () => {
  await owner.query(
    'CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."roleTarget" SET "createdAt"="createdAt" + interval \'1 microsecond\'; RETURN NEW; END $$; CREATE TRIGGER corrupt_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()',
  );
  const before = await targets();
  await expect(run()).rejects.toThrow('changed during audit flush');
  expect(await targets()).toEqual(before);
  expect(await audits()).toEqual([]);
});
it('preserves committed assignment and invalidates cache after actual lost COMMIT acknowledgement', async () => {
  const create = runtime.createQueryRunner.bind(runtime),
    statements: string[] = [],
    clients = new WeakSet<object>();
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!clients.has(client)) {
        clients.add(client);
        const query = client.query.bind(client);
        client.query = async (sql: string, ...args: unknown[]) => {
          statements.push(sql);
          const result = await query(sql, ...args);
          if (sql === 'COMMIT') throw new Error('lost assignment ACK');
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  const f = await fixture(),
    actions = await makeActions();
  await expect(
    withRoleAssignmentAudit(assignment(), identity(), () =>
      f.migration.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier,
          actions,
        } as never,
      }),
    ),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  expect(f.registry.executeActionRollbackHandler).not.toHaveBeenCalled();
  expect(f.cache.invalidateAndRecompute).toHaveBeenCalledTimes(1);
  expect(await audits()).toHaveLength(2);
  expect(
    (await targets()).find((r) => r.userWorkspaceId === userWorkspaceId)
      ?.roleId,
  ).toBe(destinationId);
});

const serviceFixture = (waitForMember = async () => {}) => {
  const builder = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async (args) => {
      const operations = args.allFlatEntityOperationByMetadataName.roleTarget;
      const actions = [
        ...operations.flatEntityToDelete.map((row: Row) => ({
          type: 'delete',
          metadataName: 'roleTarget',
          universalIdentifier: row.universalIdentifier,
        })),
        ...operations.flatEntityToCreate.map((row: Row) => ({
          type: 'create',
          metadataName: 'roleTarget',
          id: row.id,
          flatEntity: Object.fromEntries(
            Object.entries(row).filter(
              ([key]) =>
                ![
                  'id',
                  'workspaceId',
                  'applicationId',
                  'roleId',
                  'agentId',
                ].includes(key),
            ),
          ),
        })),
      ];
      const f = await fixture();
      await f.migration.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier,
          actions,
        } as never,
      });
      return { status: 'success' };
    }),
  };
  const targetService = new RoleTargetService(
    { getOrRecomputeManyOrAllFlatEntityMaps: flatMaps } as never,
    builder as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: application,
      }),
    } as never,
  );
  const assignmentValidation = {
    validateRoleAssignableToUsersOrThrow: jest.fn(async () => {}),
  };
  const roleTargetRepository = {
    findOne: async (
      _workspace: string,
      options: { where: { userWorkspaceId: string; roleId: string } },
    ) =>
      (await targets()).find(
        (r) =>
          r.userWorkspaceId === options.where.userWorkspaceId &&
          r.roleId === options.where.roleId,
      ),
    find: async (
      _workspace: string,
      options: { where: { userWorkspaceId: { value: string[] } } },
    ) => {
      const roleRows = await roles();
      return (await targets())
        .filter((r) =>
          options.where.userWorkspaceId.value.includes(
            String(r.userWorkspaceId),
          ),
        )
        .map((r) => ({
          ...r,
          role: roleRows.find((role) => role.id === r.roleId),
        }));
    },
  };
  const cache = {
    getOrRecompute: jest.fn(async (_workspace: string, keys: string[]) => {
      if (keys.includes('userWorkspaceRoleMap'))
        return {
          userWorkspaceRoleMap: Object.fromEntries(
            (await targets()).map((r) => [r.userWorkspaceId, r.roleId]),
          ),
        };
      const records = await owner.query(
        'SELECT m.id,u.id AS membership FROM synthetic_members."workspaceMember" m JOIN core."userWorkspace" u ON u."userId"=m."userId"',
      );
      return {
        flatWorkspaceMemberMaps: {
          byId: Object.fromEntries(
            records.map((r: { id: string }) => [r.id, r]),
          ),
          idByUserWorkspaceId: Object.fromEntries(
            records.map((r: { membership: string; id: string }) => [
              r.membership,
              r.id,
            ]),
          ),
        },
      };
    }),
  };
  const service = new UserRoleService(
    roleTargetRepository as never,
    owner.getRepository(UserWorkspaceEntity),
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
      getRepository: () => ({
        findOne: async (options: { where: { id: string } }) => {
          await waitForMember();
          const [row] = await owner.query(
            'SELECT * FROM synthetic_members."workspaceMember" WHERE id=$1 AND "deletedAt" IS NULL',
            [options.where.id],
          );
          return row
            ? {
                ...row,
                name: {
                  firstName: 'private member',
                  lastName: 'secret surname',
                },
              }
            : null;
        },
      }),
    } as never,
    targetService,
    cache as never,
    assignmentValidation as never,
  );
  return { service, builder, cache, assignmentValidation };
};

it.each(['missing', 'extra', 'update', 'foreign-kind'])(
  'rejects unsupported assignment audit descriptor %s',
  (kind) => {
    const audit = new CrmAuditTransactionContext(
      { isTransactionActive: true, query: jest.fn() } as never,
      {
        workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'workspaceMember', id: actorId },
      },
    );
    expect(() =>
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: memberId,
        action: kind === 'update' ? 'update' : 'create',
        before: null,
        after: { roleId: destinationId, userWorkspaceId },
        securityDescriptor: {
          resourceKind: kind === 'foreign-kind' ? 'role' : 'roleTarget',
          resourceId: memberId,
          ...(kind === 'missing'
            ? {}
            : { metadataAccess: 'currentWorkspaceAdministration' }),
          ...(kind === 'extra' ? { queueId: randomUUID() } : {}),
        },
      } as never),
    ).toThrow();
  },
);

it('runs the actual public service and roleTarget builder bridge without a cached no-op', async () => {
  const { service, cache, assignmentValidation } = serviceFixture();
  const original = cache.getOrRecompute.getMockImplementation()!;
  cache.getOrRecompute.mockImplementation(async (workspace, keys) =>
    keys.includes('userWorkspaceRoleMap')
      ? { userWorkspaceRoleMap: { [userWorkspaceId]: destinationId } }
      : original(workspace, keys),
  );
  const result = await service.assignRoleToWorkspaceMember({
    workspaceId,
    workspaceMemberId: memberId,
    roleId: destinationId,
    auditIdentity: identity(),
  });
  expect(result.userWorkspaceId).toBe(userWorkspaceId);
  expect(
    assignmentValidation.validateRoleAssignableToUsersOrThrow,
  ).toHaveBeenCalledTimes(1);
  expect(
    (await targets()).find((r) => r.userWorkspaceId === userWorkspaceId)
      ?.roleId,
  ).toBe(destinationId);
  expect(await audits()).toHaveLength(2);
  expect(JSON.stringify(await audits())).not.toContain('private member');
});

it('keeps a real persisted no-op without success mutation audit', async () => {
  await owner.query(
    'UPDATE core."roleTarget" SET "roleId"=$1 WHERE "userWorkspaceId"=$2',
    [destinationId, userWorkspaceId],
  );
  const { service, builder, assignmentValidation } = serviceFixture();
  assignmentValidation.validateRoleAssignableToUsersOrThrow.mockRejectedValue(
    new Error('must not validate an existing assignment'),
  );
  await service.assignRoleToWorkspaceMember({
    workspaceId,
    workspaceMemberId: memberId,
    roleId: destinationId,
    auditIdentity: identity(),
  });
  expect(builder.validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  expect(await audits()).toEqual([]);
});

it.each(['foreign', 'pending', 'missing'])(
  'rejects invalid %s identity even for an actual no-op',
  async (kind) => {
    await owner.query(
      'UPDATE core."roleTarget" SET "roleId"=$1 WHERE "userWorkspaceId"=$2',
      [destinationId, userWorkspaceId],
    );
    const { service, builder } = serviceFixture();
    const auditIdentity =
      kind === 'missing'
        ? undefined
        : kind === 'pending'
          ? {
              auth: {
                type: 'pendingActivationUser',
                workspace: { id: workspaceId },
              },
            }
          : {
              auth: {
                type: 'user',
                workspace: { id: randomUUID() },
                workspaceMemberId: actorId,
              },
            };
    await expect(
      service.assignRoleToWorkspaceMember({
        workspaceId,
        workspaceMemberId: memberId,
        roleId: destinationId,
        auditIdentity: auditIdentity as RoleUpdateAuditIdentity,
      }),
    ).rejects.toThrow();
    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  },
);

it('captures the actual AI tool identity and input before member lookup', async () => {
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { service } = serviceFixture(() => barrier),
    tool = new AssignRoleToWorkspaceMemberTool(service);
  const agentId = randomUUID(),
    input = { workspaceMemberId: memberId, roleId: destinationId },
    context = { workspaceId, authContext: identity().auth, agentId };
  const pending = tool.execute({ input, context } as never);
  input.roleId = adminRoleId;
  context.agentId = randomUUID();
  context.authContext.workspace.id = randomUUID();
  unblock();
  const result = await pending;
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({
    roleId: destinationId,
    workspaceMemberId: memberId,
  });
  expect((await audits())[0].actor).toEqual({ kind: 'agent', id: agentId });
  expect((await audits())[0].initiator).toEqual({
    kind: 'workspaceMember',
    id: actorId,
  });
});

it('keeps bulk bootstrap assignment on its explicit legacy path', async () => {
  const { service } = serviceFixture();
  await service.assignRoleToManyUserWorkspace({
    workspaceId,
    userWorkspaceIds: [userWorkspaceId],
    roleId: destinationId,
  });
  expect(
    (await targets()).find((r) => r.userWorkspaceId === userWorkspaceId)
      ?.roleId,
  ).toBe(destinationId);
  expect(await audits()).toEqual([]);
});
