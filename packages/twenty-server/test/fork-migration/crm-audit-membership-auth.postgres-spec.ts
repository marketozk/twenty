import { randomUUID } from 'node:crypto';
import { type Request } from 'express';
import { DataSource, EntitySchema } from 'typeorm';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import { type AccessTokenJwtPayload } from 'src/engine/core-modules/auth/types/access-token-jwt-payload.type';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';

for (const [path, name] of [
  [
    'core-entity-cache/services/core-entity-cache.service',
    'CoreEntityCacheService',
  ],
  ['workspace-cache/services/workspace-cache.service', 'WorkspaceCacheService'],
  [
    'core-modules/impersonation/services/impersonation-authorization.service',
    'ImpersonationAuthorizationService',
  ],
  ['core-modules/jwt/services/jwt-wrapper.service', 'JwtWrapperService'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
  ['core-modules/user/user.entity', 'UserEntity'],
  ['core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
  ['core-modules/twenty-config/twenty-config.service', 'TwentyConfigService'],
  [
    'core-modules/user-session/services/user-session.service',
    'UserSessionService',
  ],
  [
    'core-modules/user-session/services/user-session-cookie.service',
    'UserSessionCookieService',
  ],
  ['twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'modules/workspace-member/standard-objects/workspace-member.workspace-entity',
    'WorkspaceMemberWorkspaceEntity',
  ],
])
  jest.doMock(
    'src/' + (path.startsWith('modules/') ? '' : 'engine/') + path,
    () => ({ [name]: class {} }),
  );
jest.mock('src/engine/twenty-orm/utils/build-system-auth-context.util', () => ({
  buildSystemAuthContext: jest.fn(),
}));
const { JwtAuthStrategy } =
  require('src/engine/core-modules/auth/strategies/jwt.auth.strategy') as typeof import('src/engine/core-modules/auth/strategies/jwt.auth.strategy');
const { AccessTokenService } =
  require('src/engine/core-modules/auth/token/services/access-token.service') as typeof import('src/engine/core-modules/auth/token/services/access-token.service');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const workspaceId = randomUUID(),
  userId = randomUUID(),
  membershipId = randomUUID(),
  memberId = randomUUID();
const schema = new EntitySchema({
  name: 'MembershipAuthFixture',
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true },
    userId: { type: 'uuid' },
    workspaceId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});
const database = new DataSource({
  type: 'postgres',
  url,
  entities: [schema],
  extra: { max: 3, statement_timeout: 10000 },
});
const payload: AccessTokenJwtPayload = {
  type: JwtTokenTypeEnum.ACCESS,
  sub: userId,
  userId,
  authProvider: AuthProviderEnum.Password,
  userWorkspaceId: membershipId,
  workspaceId,
  workspaceMemberId: memberId,
};
const applicationId = randomUUID();
const fixture = () => {
  const user = { id: userId },
    membership = {
      id: membershipId,
      userId,
      workspaceId,
      deletedAt: null as string | null,
    };
  const workspace = {
    id: workspaceId,
    activationStatus: WorkspaceActivationStatus.ACTIVE,
  };
  const coreCache = {
    get: jest.fn(async (name: string) =>
      name === 'user'
        ? user
        : name === 'userWorkspaceEntity'
          ? membership
          : workspace,
    ),
    invalidate: jest.fn().mockRejectedValue(new Error('cache unavailable')),
  };
  const repository = database.getRepository(schema);
  const strategy = Object.create(JwtAuthStrategy.prototype) as InstanceType<
    typeof JwtAuthStrategy
  >;
  Object.assign(strategy, {
    coreEntityCacheService: coreCache,
    userWorkspaceRepository: repository,
    workspaceCacheService: {
      getOrRecompute: jest.fn().mockResolvedValue({
        flatApplicationMaps: {
          byId: { [applicationId]: { id: applicationId } },
        },
        flatWorkspaceMemberMaps: {
          idByUserId: { [userId]: memberId },
          byId: { [memberId]: { id: memberId, userId, deletedAt: null } },
        },
      }),
    },
  });
  // The cookie bridge is real; session resolution/signature verification are separate boundaries.
  const service = Object.create(AccessTokenService.prototype) as InstanceType<
    typeof AccessTokenService
  >;
  Object.assign(service, {
    jwtStrategy: strategy,
    jwtWrapperService: {
      extractJwtFromRequest: () => () => null,
      verifyJwtToken: jest.fn().mockResolvedValue(undefined),
      decode: () => payload,
    },
    userSessionService: {
      resolveSession: jest
        .fn()
        .mockResolvedValue({ payload, authenticatedAt: new Date() }),
    },
    userSessionCookieService: {
      extractSessionTokenFromRequest: () => 'test-cookie-token',
    },
  });
  return {
    strategy,
    service,
    user,
    membership,
    workspace,
    coreCache,
    repository,
  };
};
beforeAll(async () => {
  await database.initialize();
  await database.query(
    'DROP SCHEMA IF EXISTS core CASCADE; CREATE SCHEMA core',
  );
  await database.synchronize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  await database.query('TRUNCATE core."userWorkspace"');
  await database.query(
    'INSERT INTO core."userWorkspace" VALUES($1,$2,$3,NULL)',
    [membershipId, userId, workspaceId],
  );
});
afterAll(async () => {
  jest.restoreAllMocks();
  await database.destroy();
});

it('accepts an active matching membership using the existing real repository', async () => {
  const { strategy, repository } = fixture();
  const read = jest.spyOn(repository, 'findOne');
  const context = await strategy.validate(payload);
  expect(context.userWorkspaceId).toBe(membershipId);
  expect(context.workspaceMember?.id).toBe(memberId);
  expect(read).toHaveBeenCalledWith({
    select: { id: true },
    where: { id: membershipId, userId, workspaceId },
  });
});
it.each(['soft', 'hard'])(
  'refuses %s deleted membership despite populated user and member caches',
  async (kind) => {
    const { strategy, repository, coreCache } = fixture();
    await strategy.validate(payload);
    if (kind === 'soft') await repository.softDelete({ id: membershipId });
    else await repository.delete({ id: membershipId });
    await expect(coreCache.invalidate()).rejects.toThrow('cache unavailable');
    await expect(strategy.validate(payload)).rejects.toThrow(
      'User or user workspace not found',
    );
  },
);
it.each(['userId', 'workspaceId'])(
  'refuses a DB membership rebound to another %s while cache is stale',
  async (field) => {
    const { strategy } = fixture();
    await database.query(
      `UPDATE core."userWorkspace" SET "${field}"=$1 WHERE id=$2`,
      [randomUUID(), membershipId],
    );
    await expect(strategy.validate(payload)).rejects.toThrow(
      'User or user workspace not found',
    );
  },
);
it.each(['id', 'userId', 'workspaceId'])(
  'rejects mismatched cached membership %s',
  async (field) => {
    const { strategy, membership } = fixture();
    membership[field as 'id' | 'userId' | 'workspaceId'] = randomUUID();
    await expect(strategy.validate(payload)).rejects.toThrow(
      'User or user workspace not found',
    );
  },
);
it('rejects a cached tombstone even when DB was subsequently restored', async () => {
  const { strategy, membership } = fixture();
  membership.deletedAt = new Date().toISOString();
  await expect(strategy.validate(payload)).rejects.toThrow(
    'User or user workspace not found',
  );
});
it('rejects a cache entry belonging to a different core user', async () => {
  const { strategy, user } = fixture();
  user.id = randomUUID();
  await expect(strategy.validate(payload)).rejects.toThrow(
    'User or user workspace not found',
  );
});
it('does not fall back to cache when the authoritative DB read fails', async () => {
  const { strategy, repository } = fixture();
  jest
    .spyOn(repository, 'findOne')
    .mockRejectedValue(new Error('database unavailable'));
  await expect(strategy.validate(payload)).rejects.toThrow(
    'database unavailable',
  );
});
it('rechecks a removal committed during cache resolution', async () => {
  const { strategy, repository, coreCache } = fixture();
  const get = coreCache.get.getMockImplementation()!;
  coreCache.get.mockImplementation(async (name) => {
    if (name === 'userWorkspaceEntity')
      await repository.softDelete({ id: membershipId });
    return get(name);
  });
  await expect(strategy.validate(payload)).rejects.toThrow(
    'User or user workspace not found',
  );
});
it('also checks membership for pending workspace creation', async () => {
  const { strategy, repository, workspace } = fixture();
  workspace.activationStatus = WorkspaceActivationStatus.PENDING_CREATION;
  await repository.softDelete({ id: membershipId });
  await expect(strategy.validate(payload)).rejects.toThrow(
    'User or user workspace not found',
  );
});
it('preserves workspace-agnostic authentication without an active workspace membership', async () => {
  const { strategy, repository } = fixture();
  await repository.softDelete({ id: membershipId });
  const read = jest.spyOn(repository, 'findOne');
  const result = await strategy.validate({
    type: JwtTokenTypeEnum.WORKSPACE_AGNOSTIC,
    sub: userId,
  } as never);
  expect(result.user?.id).toBe(userId);
  expect(result.userWorkspace).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it.each(['cookie', 'bearer', 'playground'])(
  'checks the real %s validation path after soft removal',
  async (path) => {
    const { service, strategy, repository } = fixture();
    await repository.softDelete({ id: membershipId });
    const validate =
      path === 'cookie'
        ? service.validateTokenByRequest({} as Request)
        : path === 'bearer'
          ? service.validateToken('fixture-jwt')
          : strategy.validate({
              ...payload,
              type: JwtTokenTypeEnum.PLAYGROUND,
            } as never);
    await expect(validate).rejects.toThrow('User or user workspace not found');
  },
);
it('preserves the real cookie bridge for an active membership', async () => {
  const { service } = fixture();
  const result = await service.validateTokenByRequest({} as Request);
  expect(result.workspaceMemberId).toBe(memberId);
  expect(result.authenticatedAt).toBeInstanceOf(Date);
});
it.each([false, true])(
  'checks delegated application membership with deleted=%s',
  async (deleted) => {
    const { strategy, repository } = fixture();
    if (deleted) await repository.softDelete({ id: membershipId });
    const result = strategy.validate({
      type: JwtTokenTypeEnum.APPLICATION_ACCESS,
      sub: applicationId,
      workspaceId,
      userId,
      userWorkspaceId: membershipId,
    } as never);
    if (deleted)
      await expect(result).rejects.toThrow('User or user workspace not found');
    else expect((await result).userWorkspaceId).toBe(membershipId);
  },
);
it('does not require user membership for an application without a user', async () => {
  const { strategy, repository } = fixture();
  await repository.softDelete({ id: membershipId });
  const read = jest.spyOn(repository, 'findOne');
  const result = await strategy.validate({
    type: JwtTokenTypeEnum.APPLICATION_ACCESS,
    sub: applicationId,
    workspaceId,
  } as never);
  expect(result.application?.id).toBe(applicationId);
  expect(read).not.toHaveBeenCalled();
});
