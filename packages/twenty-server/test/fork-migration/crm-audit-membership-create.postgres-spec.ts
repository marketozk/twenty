import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
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
const { UserWorkspaceService } =
  require('src/engine/core-modules/user-workspace/user-workspace.service') as typeof import('src/engine/core-modules/user-workspace/user-workspace.service');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const userId = randomUUID(),
  otherUserId = randomUUID(),
  workspaceId = randomUUID(),
  otherWorkspaceId = randomUUID();
const role = 'membership_create_' + randomUUID().replaceAll('-', '');
const membershipSchema = new EntitySchema({
  name: 'MembershipCreateFixture',
  target: UserWorkspaceEntity,
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    userId: { type: 'uuid' },
    workspaceId: { type: 'uuid' },
    defaultAvatarUrl: { type: 'text', nullable: true },
    locale: { type: 'text', default: 'en' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const userSchema = new EntitySchema({
  name: 'MembershipUserFixture',
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [membershipSchema, userSchema],
  extra: { max: 6, statement_timeout: 12000 },
});
const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-membership-create';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [membershipSchema, userSchema],
  extra: { max: 6, statement_timeout: 12000 },
});
const invalidate = jest.fn<Promise<unknown>, unknown[]>();
const avatar = jest.fn<Promise<string>, unknown[]>();
const service = Object.create(UserWorkspaceService.prototype) as InstanceType<
  typeof UserWorkspaceService
>;
Object.assign(service, {
  userWorkspaceRepository: runtime.getRepository(UserWorkspaceEntity),
  coreEntityCacheService: { invalidate },
  computeDefaultAvatarUrl: avatar,
});
const input = () => ({
  userId,
  workspaceId,
  isExistingUser: true,
  locale: 'en' as const,
});
const memberships = () => owner.query('SELECT * FROM core."userWorkspace"');
const user = async () =>
  (await owner.query('SELECT * FROM core."user" WHERE id=$1', [userId]))[0];
const deactivate = () =>
  deactivateCoreUserWithAudit({
    dataSource: runtime,
    userEntity: userSchema,
    userId,
    auditOperations: [],
    invalidate: async () => {},
  });
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const waitForLock = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
          [role],
        )
      ).length
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected database lock wait');
};
beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY); ALTER TABLE core."userWorkspace" ADD FOREIGN KEY ("userId") REFERENCES core."user"(id) ON DELETE CASCADE, ADD FOREIGN KEY ("workspaceId") REFERENCES core.workspace(id); CREATE UNIQUE INDEX active_membership ON core."userWorkspace"("userId","workspaceId") WHERE "deletedAt" IS NULL',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    'CREATE ROLE "' +
      role +
      '" LOGIN PASSWORD \'isolated-membership-create\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "' +
      role +
      '"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "' +
      role +
      '"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "' +
      role +
      '"',
  );
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  avatar.mockReset().mockResolvedValue('avatar');
  invalidate.mockReset().mockResolvedValue(undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_membership ON core."userWorkspace"; DROP FUNCTION IF EXISTS core.corrupt_membership(); TRUNCATE core."user",core.workspace,core."userWorkspace",crm_audit."crmAuditEntry" CASCADE',
  );
  await owner.query('INSERT INTO core."user"(id) VALUES($1),($2)', [
    userId,
    otherUserId,
  ]);
  await owner.query('INSERT INTO core.workspace VALUES($1),($2)', [
    workspaceId,
    otherWorkspaceId,
  ]);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await runtime.destroy();
  await owner.query('DROP OWNED BY "' + role + '"; DROP ROLE "' + role + '"');
  await owner.destroy();
});

it('creates an active membership using the prepared avatar and default locale', async () => {
  const saved = await service.create({
    userId,
    workspaceId,
    isExistingUser: true,
  });
  expect(saved).toMatchObject({
    userId,
    workspaceId,
    locale: 'en',
    defaultAvatarUrl: 'avatar',
  });
  expect(await memberships()).toHaveLength(1);
  expect((await memberships())[0].id).toBe(saved.id);
});
it.each(['missing', 'deleted'])(
  'rejects a %s user before INSERT',
  async (state) => {
    await owner.query(
      state === 'missing'
        ? 'DELETE FROM core."user" WHERE id=$1'
        : 'UPDATE core."user" SET "deletedAt"=now() WHERE id=$1',
      [userId],
    );
    await expect(service.create(input())).rejects.toThrow(
      'Active user not found',
    );
    expect(await memberships()).toEqual([]);
  },
);
it('snapshots scalar input before avatar preparation awaits', async () => {
  const args = input();
  avatar.mockImplementationOnce(async () => {
    args.userId = otherUserId;
    args.workspaceId = otherWorkspaceId;
    return 'avatar';
  });
  expect(await service.create(args)).toMatchObject({ userId, workspaceId });
});
it('does not start a database transaction when avatar preparation fails', async () => {
  const create = jest.spyOn(runtime, 'createQueryRunner');
  avatar.mockRejectedValueOnce(new Error('avatar unavailable'));
  await expect(service.create(input())).rejects.toThrow('avatar unavailable');
  expect(create).not.toHaveBeenCalled();
});
it('uses the caller connection for an uncommitted user and leaves rollback to its caller', async () => {
  const runner = runtime.createQueryRunner();
  await runner.startTransaction();
  const newUserId = randomUUID();
  try {
    await runner.query('INSERT INTO core."user"(id) VALUES($1)', [newUserId]);
    const commit = jest.spyOn(runner, 'commitTransaction');
    const saved = await service.create(
      { ...input(), userId: newUserId },
      runner,
    );
    expect(saved.userId).toBe(newUserId);
    expect(commit).not.toHaveBeenCalled();
    expect(runner.isTransactionActive).toBe(true);
    expect(runner.isReleased).toBe(false);
    expect(await memberships()).toEqual([]);
    await runner.rollbackTransaction();
    expect(await memberships()).toEqual([]);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
  }
});
it.each(['inactive', 'released', 'foreign'])(
  'rejects a %s caller runner before avatar work',
  async (state) => {
    const runner = (state === 'foreign' ? owner : runtime).createQueryRunner();
    if (state === 'foreign') await runner.startTransaction();
    if (state === 'released') await runner.release();
    try {
      await expect(service.create(input(), runner)).rejects.toThrow(
        'active transaction on its data source',
      );
      expect(avatar).not.toHaveBeenCalled();
      expect(await memberships()).toEqual([]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (!runner.isReleased) await runner.release();
    }
  },
);
it('rechecks the caller transaction after avatar preparation', async () => {
  const runner = runtime.createQueryRunner();
  await runner.startTransaction();
  avatar.mockImplementationOnce(async () => {
    await runner.rollbackTransaction();
    return 'avatar';
  });
  try {
    await expect(service.create(input(), runner)).rejects.toThrow(
      'active transaction',
    );
    expect(await memberships()).toEqual([]);
  } finally {
    await runner.release();
  }
});
it.each([
  'RETURN NULL;',
  'NEW.id := gen_random_uuid(); RETURN NEW;',
  'NEW."userId" := \'' + otherUserId + "'; RETURN NEW;",
  'NEW."workspaceId" := \'' + otherWorkspaceId + "'; RETURN NEW;",
  'NEW."deletedAt" := now(); RETURN NEW;',
  'UPDATE core."user" SET "deletedAt"=now() WHERE id=NEW."userId"; RETURN NEW;',
])('rejects actual INSERT corruption and rolls it back: %s', async (body) => {
  await owner.query(
    'CREATE FUNCTION core.corrupt_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
      body +
      ' END $$; CREATE TRIGGER corrupt_membership BEFORE INSERT ON core."userWorkspace" FOR EACH ROW EXECUTE FUNCTION core.corrupt_membership()',
  );
  await expect(service.create(input())).rejects.toThrow();
  expect(await memberships()).toEqual([]);
  expect((await user()).deletedAt).toBeNull();
});
it('creator first holds its user lock until commit and deactivation sees its membership', async () => {
  const runner = runtime.createQueryRunner();
  await runner.startTransaction();
  await service.create(input(), runner);
  const pending = settle(deactivate());
  try {
    await waitForLock();
    await runner.commitTransaction();
    expect(await pending).toEqual({ value: 'active-memberships' });
    expect((await user()).deletedAt).toBeNull();
    expect(await memberships()).toHaveLength(1);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await pending;
  }
});
it('deactivator first makes a waiting creator reject the now deleted user', async () => {
  const create = runtime.createQueryRunner.bind(runtime);
  let unlock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce((mode) => {
    const runner = create(mode),
      commit = runner.commitTransaction.bind(runner);
    jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
      reached();
      await barrier;
      return commit();
    });
    return runner;
  });
  const removing = settle(deactivate());
  await held;
  const creating = settle(service.create(input()));
  try {
    await waitForLock();
    unlock();
    expect(await removing).toEqual({ value: 'deleted' });
    expect(await creating).toMatchObject({
      error: expect.objectContaining({ message: 'Active user not found' }),
    });
    expect(await memberships()).toEqual([]);
  } finally {
    unlock();
    await removing;
    await creating;
  }
});
it('lost standalone COMMIT acknowledgement is unknown with exactly one persisted membership', async () => {
  const create = runtime.createQueryRunner.bind(runtime);
  let commits = 0;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    let wrapped = false;
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!wrapped) {
        wrapped = true;
        const query = client.query.bind(client);
        client.query = async (sql: string, ...args: unknown[]) => {
          const result = await query(sql, ...args);
          if (sql === 'COMMIT') {
            commits++;
            throw new Error('lost acknowledgement');
          }
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  await expect(service.create(input())).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(commits).toBe(1);
  expect(await memberships()).toHaveLength(1);
});
it('updates only locale for an active membership and invalidates its cache', async () => {
  const saved = await service.create(input());
  await service.updateUserWorkspaceLocaleForUserWorkspace({
    userWorkspaceId: saved.id,
    locale: 'ru-RU',
  });
  expect((await memberships())[0]).toMatchObject({
    id: saved.id,
    userId,
    workspaceId,
    locale: 'ru-RU',
    deletedAt: null,
  });
  expect(invalidate).toHaveBeenCalledWith('userWorkspaceEntity', saved.id);
});
it.each(['hard', 'soft'])(
  'locale update cannot resurrect a concurrently %s removed membership',
  async (mode) => {
    const saved = await service.create(input()),
      runner = owner.createQueryRunner();
    await runner.startTransaction();
    await runner.query(
      mode === 'hard'
        ? 'DELETE FROM core."userWorkspace" WHERE id=$1'
        : 'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
      [saved.id],
    );
    const updating = settle(
      service.updateUserWorkspaceLocaleForUserWorkspace({
        userWorkspaceId: saved.id,
        locale: 'ru-RU',
      }),
    );
    try {
      await waitForLock();
      await runner.commitTransaction();
      expect(await updating).toEqual({ value: undefined });
      const rows = await memberships();
      if (mode === 'hard') expect(rows).toEqual([]);
      else {
        expect(rows[0].deletedAt).toBeTruthy();
        expect(rows[0].locale).toBe('en');
      }
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await updating;
    }
  },
);
it('missing locale target remains a no-op', async () => {
  await service.updateUserWorkspaceLocaleForUserWorkspace({
    userWorkspaceId: randomUUID(),
    locale: 'ru-RU',
  });
  expect(await memberships()).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled();
});
