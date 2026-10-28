import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { sign, verify, decode, type SignOptions } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import {
  AppTokenEntity,
  AppTokenType,
} from 'src/engine/core-modules/app-token/app-token.entity';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { UserSessionEntity } from 'src/engine/core-modules/user-session/user-session.entity';
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';
import { RefreshTokenService } from 'src/engine/core-modules/auth/token/services/refresh-token.service';
import { RenewTokenService } from 'src/engine/core-modules/auth/token/services/renew-token.service';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditMutation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

jest.mock('src/engine/core-modules/user/user.entity', () => {
  const { Entity, PrimaryColumn } = require('typeorm');
  class UserEntity {}
  Entity({ schema: 'core', name: 'user' })(UserEntity);
  PrimaryColumn({ type: 'uuid' })(UserEntity.prototype, 'id');
  return { UserEntity };
});
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => {
  const { Entity, PrimaryColumn } = require('typeorm');
  class WorkspaceEntity {}
  Entity({ schema: 'core', name: 'workspace' })(WorkspaceEntity);
  PrimaryColumn({ type: 'uuid' })(WorkspaceEntity.prototype, 'id');
  return { WorkspaceEntity };
});
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => {
    const { Entity, PrimaryColumn, Column } = require('typeorm');
    class UserWorkspaceEntity {}
    Entity({ schema: 'core', name: 'userWorkspace' })(UserWorkspaceEntity);
    PrimaryColumn({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'id');
    for (const column of ['userId', 'workspaceId'])
      Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, column);
    Column({ type: 'timestamptz', nullable: true })(
      UserWorkspaceEntity.prototype,
      'deletedAt',
    );
    return { UserWorkspaceEntity };
  },
);
jest.mock(
  'src/engine/core-modules/event-logs/emit/event-log-emitter.service',
  () => ({ EventLogEmitterService: class {} }),
);
jest.mock('src/engine/core-modules/jwt/services/jwt-wrapper.service', () => ({
  JwtWrapperService: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({ CacheStorageService: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-session/services/user-session-cookie.service',
  () => ({ UserSessionCookieService: class {} }),
);
jest.mock(
  'src/engine/core-modules/auth/token/services/access-token.service',
  () => ({ AccessTokenService: class {} }),
);
jest.mock(
  'src/engine/core-modules/auth/token/services/workspace-agnostic-token.service',
  () => ({ WorkspaceAgnosticTokenService: class {} }),
);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');
const role = `refresh_audit_${randomUUID().replaceAll('-', '')}`;
const entities = [
  AppTokenEntity,
  UserSessionEntity,
  UserEntity,
  WorkspaceEntity,
  UserWorkspaceEntity,
];
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  synchronize: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = 'isolated-refresh-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities,
  synchronize: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const userId = randomUUID(),
  otherUserId = randomUUID(),
  workspaceId = randomUUID();
const secret = 'isolated-refresh-jwt-fixture-not-production';
const jwt = {
  verifyJwtToken: jest.fn(async (token: string) => verify(token, secret)),
  decode: (token: string) => decode(token),
  signAsyncOrThrow: async (
    payload: object,
    options: { jwtid: string; expiresIn?: SignOptions['expiresIn'] },
  ) =>
    sign(payload, secret, {
      jwtid: options.jwtid,
      expiresIn: options.expiresIn ?? '1h',
    }),
};
const config = {
  get: (key: string) =>
    key === 'REFRESH_TOKEN_REUSE_GRACE_PERIOD' ? '1m' : '1h',
};
const services = () => {
  const refresh = new RefreshTokenService(
    jwt as never,
    config as never,
    runtime.getRepository(AppTokenEntity),
    runtime.getRepository(UserEntity),
  );
  const service = new UserSessionService(
    runtime.getRepository(UserSessionEntity),
    runtime.getRepository(AppTokenEntity),
    {} as never,
    config as never,
    jwt as never,
    {} as never,
    {} as never,
  );
  const access = {
    generateAccessToken: jest.fn(async () => ({
      token: 'synthetic-access',
      expiresAt: new Date(),
    })),
  };
  const renew = new RenewTokenService(access as never, {} as never, refresh);
  return { service, refresh, renew, access };
};
const createToken = async (
  overrides: Partial<AppTokenEntity> = {},
  claims: Record<string, unknown> = {},
) => {
  const row = await owner.getRepository(AppTokenEntity).save({
    userId,
    workspaceId,
    type: AppTokenType.RefreshToken,
    value: 'private-token-value',
    expiresAt: new Date(Date.now() + 3600000),
    context: { email: 'private@example.test' },
    ...overrides,
  });
  return {
    row,
    token: sign(
      {
        sub: userId,
        userId,
        workspaceId,
        type: JwtTokenTypeEnum.REFRESH,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
        ...claims,
      },
      secret,
      { jwtid: row.id, expiresIn: '1h' },
    ),
  };
};
const audits = () => owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
const tokens = () =>
  owner.getRepository(AppTokenEntity).find({ order: { id: 'ASC' } });
beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-refresh-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core,crm_audit TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}";
    GRANT INSERT,UPDATE ON core."appToken",core."userSession" TO "${role}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${role}"`);
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  jwt.verifyJwtToken.mockClear();
  await owner.query(`DROP TRIGGER IF EXISTS fail_refresh_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.fail_refresh_audit();
    DROP TRIGGER IF EXISTS rewrite_refresh ON core."appToken"; DROP FUNCTION IF EXISTS core.rewrite_refresh();
    TRUNCATE core."appToken",core."userSession",core."userWorkspace",core."user",core.workspace,crm_audit."crmAuditEntry" CASCADE`);
  await owner.query('INSERT INTO core."user" VALUES($1),($2)', [
    userId,
    otherUserId,
  ]);
  await owner.query('INSERT INTO core.workspace VALUES($1)', [workspaceId]);
});
afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.destroy();
  }
});

it('logout immediately prevents renewing the presented token inside the rotation grace period', async () => {
  const { token } = await createToken(),
    { service, refresh } = services();
  await service.signOut({ refreshToken: token });
  await expect(refresh.verifyRefreshToken(token)).rejects.toThrow('revoked');
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
});

const issuancePayload = () => ({
  userId,
  workspaceId,
  targetedTokenType: JwtTokenTypeEnum.ACCESS,
});

it('issues a workspace refresh token with persisted scope and redacted create audit', async () => {
  const issued =
    await services().refresh.generateRefreshToken(issuancePayload());
  const claims = verify(issued.token, secret) as {
    jti: string;
    sub: string;
    workspaceId: string;
    exp: number;
    iat: number;
  };
  const rows = await tokens(),
    entries = await audits();
  expect(rows).toHaveLength(1);
  expect(entries).toHaveLength(1);
  expect(claims).toMatchObject({ jti: rows[0].id, sub: userId, workspaceId });
  expect(claims.exp - claims.iat).toBe(3600);
  expect(rows[0].expiresAt.getTime()).toBe(issued.expiresAt.getTime());
  expect(entries[0]).toMatchObject({
    resourceKind: 'refreshToken',
    resourceId: rows[0].id,
    action: 'create',
    actor: { kind: 'coreUser', id: userId },
  });
  expect(JSON.stringify(entries)).not.toContain(issued.token);
});

it('rotates old and new credentials in one audited operation', async () => {
  const { row, token } = await createToken(),
    { renew, access } = services();
  const result = await renew.generateTokensFromRefreshToken(token);
  const rows = await tokens(),
    entries = await audits();
  expect(rows).toHaveLength(2);
  expect(entries).toHaveLength(2);
  expect(
    entries.find(
      (entry: { resourceId: string }) => entry.resourceId === row.id,
    ),
  ).toMatchObject({ action: 'update' });
  expect(
    entries.find(
      (entry: { resourceId: string }) => entry.resourceId !== row.id,
    ),
  ).toMatchObject({ action: 'create' });
  expect(
    new Set(entries.map((entry: { operationId: string }) => entry.operationId))
      .size,
  ).toBe(1);
  expect(verify(result.refreshToken.token, secret)).toMatchObject({
    sub: userId,
    workspaceId,
  });
  expect(access.generateAccessToken).toHaveBeenCalledTimes(1);
});

it('allows concurrent grace renewal with one old-token update and two audited successors', async () => {
  const { row, token } = await createToken(),
    { renew } = services();
  const results = await Promise.all([
    renew.generateTokensFromRefreshToken(token),
    renew.generateTokensFromRefreshToken(token),
  ]);
  expect(new Set(results.map((result) => result.refreshToken.token)).size).toBe(
    2,
  );
  const rows = await tokens(),
    entries = await audits();
  expect(rows).toHaveLength(3);
  expect(entries).toHaveLength(3);
  expect(
    entries.filter(
      (entry: { resourceId: string }) => entry.resourceId === row.id,
    ),
  ).toHaveLength(1);
  expect(
    entries.filter((entry: { action: string }) => entry.action === 'create'),
  ).toHaveLength(2);
});

it('does not extend or re-audit the old timestamp on a permitted grace repeat', async () => {
  const revokedAt = new Date(Date.now() - 1000);
  const { row, token } = await createToken({ revokedAt });
  await services().renew.generateTokensFromRefreshToken(token);
  expect(
    (await tokens()).find((item) => item.id === row.id)?.revokedAt?.getTime(),
  ).toBe(revokedAt.getTime());
  expect(await audits()).toEqual([
    expect.objectContaining({ action: 'create' }),
  ]);
});

it.each(['sign', 'audit', 'sql'])(
  'rolls back standalone issuance on %s failure',
  async (failure) => {
    if (failure === 'sign')
      jest
        .spyOn(jwt, 'signAsyncOrThrow')
        .mockRejectedValue(new Error('sign failed'));
    if (failure === 'audit')
      await owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${role}"`,
      );
    if (failure === 'sql')
      await owner.query(`REVOKE INSERT ON core."appToken" FROM "${role}"`);
    try {
      await expect(
        services().refresh.generateRefreshToken(issuancePayload()),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry",core."appToken" TO "${role}"`,
      );
    }
    expect(await tokens()).toEqual([]);
    expect(await audits()).toEqual([]);
  },
);

it.each(['sign', 'audit', 'sql'])(
  'rolls back both sides of rotation on %s failure',
  async (failure) => {
    const { token } = await createToken(),
      before = await tokens(),
      { renew, access } = services();
    if (failure === 'sign')
      jest
        .spyOn(jwt, 'signAsyncOrThrow')
        .mockRejectedValue(new Error('sign failed'));
    if (failure === 'audit')
      await owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${role}"`,
      );
    if (failure === 'sql')
      await owner.query(`REVOKE INSERT ON core."appToken" FROM "${role}"`);
    try {
      await expect(
        renew.generateTokensFromRefreshToken(token),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry",core."appToken" TO "${role}"`,
      );
    }
    expect(await tokens()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(access.generateAccessToken).not.toHaveBeenCalled();
  },
);

it('rejects a newly inserted credential changed by a database trigger', async () => {
  await owner.query(`CREATE FUNCTION core.rewrite_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."userId"='${otherUserId}'; RETURN NEW; END $$;
    CREATE TRIGGER rewrite_refresh BEFORE INSERT ON core."appToken" FOR EACH ROW EXECUTE FUNCTION core.rewrite_refresh()`);
  await expect(
    services().refresh.generateRefreshToken(issuancePayload()),
  ).rejects.toThrow('persisted credential');
  expect(await tokens()).toEqual([]);
  expect(await audits()).toEqual([]);
});

it('rolls back issuance if an audit trigger changes the persisted credential', async () => {
  await owner.query(`CREATE FUNCTION crm_audit.fail_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."appToken" SET "userId"='${otherUserId}' WHERE id=NEW."resourceId"::uuid; RETURN NEW; END $$;
    CREATE TRIGGER fail_refresh_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_refresh_audit()`);
  await expect(
    services().refresh.generateRefreshToken(issuancePayload()),
  ).rejects.toThrow('persisted credential changed');
  expect(await tokens()).toEqual([]);
  expect(await audits()).toEqual([]);
});

it('preserves impersonation lifetime and records its resolved initiator', async () => {
  const membership = randomUUID();
  await owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [membership, otherUserId, workspaceId],
  );
  const result = await services().refresh.generateRefreshToken(
    {
      ...issuancePayload(),
      isImpersonating: true,
      impersonatorUserWorkspaceId: membership,
    },
    true,
  );
  const claims = verify(result.token, secret) as { exp: number; iat: number };
  expect(claims.exp - claims.iat).toBe(86400);
  expect((await audits())[0]).toMatchObject({
    actor: { kind: 'coreUser', id: userId },
    initiator: { kind: 'coreUser', id: otherUserId },
  });
});

it('refuses issuance when an impersonation initiator cannot be resolved', async () => {
  await expect(
    services().refresh.generateRefreshToken(
      {
        ...issuancePayload(),
        isImpersonating: true,
        impersonatorUserWorkspaceId: randomUUID(),
      },
      true,
    ),
  ).rejects.toThrow('initiator unavailable');
  expect(await tokens()).toEqual([]);
  expect(await audits()).toEqual([]);
});

it('keeps workspace-agnostic issuance without inventing a tenant audit', async () => {
  const result = await services().refresh.generateRefreshToken({
    userId,
    targetedTokenType: JwtTokenTypeEnum.WORKSPACE_AGNOSTIC,
  });
  expect(verify(result.token, secret)).toMatchObject({
    sub: userId,
    type: JwtTokenTypeEnum.REFRESH,
  });
  expect((await tokens())[0].workspaceId).toBeNull();
  expect(await audits()).toEqual([]);
});

it('refuses use of an inherited unowned issuance transaction', async () => {
  await runtime.transaction(async (manager) => {
    const refresh = new RefreshTokenService(
      jwt as never,
      config as never,
      manager.getRepository(AppTokenEntity),
      manager.getRepository(UserEntity),
    );
    await expect(
      refresh.generateRefreshToken(issuancePayload()),
    ).rejects.toThrow('ownership');
  });
  expect(await tokens()).toEqual([]);
  expect(await audits()).toEqual([]);
});

it.each(['user', 'workspace', 'type', 'security-reason', 'expired-grace'])(
  'checks fresh rotation %s under the owner',
  async (variant) => {
    const { row } = await createToken(
      variant === 'type'
        ? { type: AppTokenType.CodeChallenge }
        : variant === 'security-reason'
          ? {
              revokedAt: new Date(),
              context: { revokedReason: UserSessionRevokedReason.UserSignOut },
            }
          : variant === 'expired-grace'
            ? { revokedAt: new Date(Date.now() - 120000) }
            : {},
    );
    const payload = issuancePayload();
    if (variant === 'user') payload.userId = otherUserId;
    if (variant === 'workspace') payload.workspaceId = randomUUID();
    const before = await tokens();
    await expect(
      services().refresh.rotateRefreshToken({ tokenId: row.id, payload }),
    ).rejects.toThrow('revoked');
    expect(await tokens()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('audits the saved credential owner without copying token, email or full context', async () => {
  const { row, token } = await createToken(),
    { service } = services();
  await service.signOut({ refreshToken: token });
  const entries = await audits();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    resourceKind: 'refreshToken',
    resourceId: row.id,
    workspaceId,
    actor: { kind: 'coreUser', id: userId },
    action: 'update',
    outcome: 'success',
    securityDescriptor: {
      tokenOwner: { userId, access: 'currentWorkspaceAdministration' },
    },
  });
  for (const value of [token, 'private-token-value', 'private@example.test'])
    expect(JSON.stringify(entries)).not.toContain(value);
  expect((await tokens())[0].context).toEqual({
    email: 'private@example.test',
    revokedReason: UserSessionRevokedReason.UserSignOut,
  });
});

it('upgrades a rotated token to security revoke without extending its grace timestamp', async () => {
  const revokedAt = new Date(Date.now() - 1000);
  const { token } = await createToken({ revokedAt }),
    { service, refresh } = services();
  await expect(refresh.verifyRefreshToken(token)).resolves.toBeDefined();
  await service.signOut({ refreshToken: token });
  expect((await tokens())[0].revokedAt?.getTime()).toBe(revokedAt.getTime());
  await expect(refresh.verifyRefreshToken(token)).rejects.toThrow('revoked');
  expect(await audits()).toHaveLength(1);
});

it('does not replace an existing security reason or repeat its success audit', async () => {
  const { token } = await createToken({
      revokedAt: new Date(),
      context: { revokedReason: UserSessionRevokedReason.PasswordChanged },
    }),
    { service } = services();
  const before = await tokens();
  await service.signOut({ refreshToken: token });
  expect(await tokens()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('serializes duplicate logout into one mutation and one audit', async () => {
  const { token } = await createToken(),
    { service } = services();
  await Promise.all([
    service.signOut({ refreshToken: token }),
    service.signOut({ refreshToken: token }),
  ]);
  const before = await tokens();
  await service.signOut({ refreshToken: token });
  expect(await tokens()).toEqual(before);
  expect(await audits()).toHaveLength(1);
});

it.each([
  'wrong-type',
  'wrong-user',
  'mismatched-user-claim',
  'malformed-user-claim',
  'missing-row',
  'invalid-signature',
])('does not revoke an unproven credential: %s', async (variant) => {
  const { row, token } = await createToken(
    variant === 'wrong-type' ? { type: AppTokenType.CodeChallenge } : {},
  );
  let presented = token;
  if (variant === 'wrong-user')
    presented = sign(
      { sub: otherUserId, userId: otherUserId, type: JwtTokenTypeEnum.REFRESH },
      secret,
      { jwtid: row.id },
    );
  if (variant === 'mismatched-user-claim')
    presented = sign(
      { sub: userId, userId: otherUserId, type: JwtTokenTypeEnum.REFRESH },
      secret,
      { jwtid: row.id },
    );
  if (variant === 'malformed-user-claim')
    presented = sign(
      { sub: userId, userId: 42, type: JwtTokenTypeEnum.REFRESH },
      secret,
      { jwtid: row.id },
    );
  if (variant === 'missing-row')
    presented = sign(
      { sub: userId, userId, type: JwtTokenTypeEnum.REFRESH },
      secret,
      { jwtid: randomUUID() },
    );
  if (variant === 'invalid-signature')
    presented = sign(
      { sub: userId, userId, type: JwtTokenTypeEnum.REFRESH },
      'different-isolated-key',
      { jwtid: row.id },
    );
  const before = await tokens();
  await services().service.signOut({ refreshToken: presented });
  expect(await tokens()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('supports a legacy verified subject without the redundant userId claim', async () => {
  const { row } = await createToken();
  const token = sign({ sub: userId, type: JwtTokenTypeEnum.REFRESH }, secret, {
    jwtid: row.id,
  });
  await services().service.signOut({ refreshToken: token });
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  expect(await audits()).toHaveLength(1);
});

it('revokes a deletedAt-marked credential because native renewal still accepts it', async () => {
  const deletedAt = new Date(Date.now() - 1000);
  const { token } = await createToken({ deletedAt }),
    { service, refresh } = services();
  await expect(refresh.verifyRefreshToken(token)).resolves.toBeDefined();
  await service.signOut({ refreshToken: token });
  await expect(refresh.verifyRefreshToken(token)).rejects.toThrow('revoked');
  expect((await tokens())[0].deletedAt?.getTime()).toBe(deletedAt.getTime());
  expect(await audits()).toHaveLength(1);
});

it('revokes a workspace-agnostic token without inventing a tenant for audit', async () => {
  const { token } = await createToken(
    { workspaceId: null },
    { workspaceId: null },
  );
  await services().service.signOut({ refreshToken: token });
  expect((await tokens())[0].revokedAt).not.toBeNull();
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  expect(await audits()).toEqual([]);
});

it('records the verified impersonation initiator from the current membership', async () => {
  const membership = randomUUID();
  await owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [membership, otherUserId, workspaceId],
  );
  const { token } = await createToken(
    {},
    { isImpersonating: true, impersonatorUserWorkspaceId: membership },
  );
  await services().service.signOut({ refreshToken: token });
  expect((await audits())[0]).toMatchObject({
    actor: { kind: 'coreUser', id: userId },
    initiator: { kind: 'coreUser', id: otherUserId },
  });
});

it('keeps security revoke when audit insert fails and emits an explicit alert', async () => {
  const { token } = await createToken();
  await owner.query(`CREATE FUNCTION crm_audit.fail_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER fail_refresh_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_refresh_audit()`);
  const log = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => {});
  const { service, refresh } = services();
  await service.signOut({ refreshToken: token });
  await expect(refresh.verifyRefreshToken(token)).rejects.toThrow('revoked');
  expect(await audits()).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('REFRESH_REVOCATION_AUDIT_UNAVAILABLE'),
  );
});

it('rolls back audit-trigger credential resurrection while retaining the original revoke', async () => {
  const { token } = await createToken();
  await owner.query(`CREATE FUNCTION crm_audit.fail_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."appToken" SET "revokedAt"=NULL,context=NULL WHERE id=NEW."resourceId"::uuid; RETURN NEW; END $$;
    CREATE TRIGGER fail_refresh_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_refresh_audit()`);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await services().service.signOut({ refreshToken: token });
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  expect((await tokens())[0].revokedAt).not.toBeNull();
  expect(await audits()).toEqual([]);
});

it('refuses a trigger that changes the persisted credential identity during revoke', async () => {
  const { token } = await createToken(),
    before = await tokens();
  await owner.query(`CREATE FUNCTION core.rewrite_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."userId"='${otherUserId}'; RETURN NEW; END $$;
    CREATE TRIGGER rewrite_refresh BEFORE UPDATE ON core."appToken" FOR EACH ROW EXECUTE FUNCTION core.rewrite_refresh()`);
  await expect(
    services().service.signOut({ refreshToken: token }),
  ).rejects.toThrow('persisted state');
  expect(await tokens()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('still revokes refresh when the session logout path fails', async () => {
  const { token } = await createToken(),
    { service } = services();
  jest
    .spyOn(service, 'revokeSessionByToken')
    .mockRejectedValue(new Error('session storage unavailable'));
  await expect(
    service.signOut({ sessionToken: 'synthetic-session', refreshToken: token }),
  ).rejects.toThrow('session storage unavailable');
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  expect(await audits()).toHaveLength(1);
});

it('surfaces storage failure rather than pretending logout succeeded', async () => {
  const { token } = await createToken(),
    before = await tokens();
  await owner.query(`REVOKE UPDATE ON core."appToken" FROM "${role}"`);
  try {
    await expect(
      services().service.signOut({ refreshToken: token }),
    ).rejects.toThrow();
  } finally {
    await owner.query(`GRANT UPDATE ON core."appToken" TO "${role}"`);
  }
  expect(await tokens()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('reports lost actual COMMIT acknowledgement without replaying revoke', async () => {
  const { token } = await createToken(),
    create = runtime.createQueryRunner.bind(runtime),
    statements: string[] = [];
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    let patched = false;
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!patched) {
        patched = true;
        const query = client.query.bind(client);
        client.query = async (sql: string, ...args: unknown[]) => {
          statements.push(sql);
          const result = await query(sql, ...args);
          if (sql === 'COMMIT') throw new Error('lost refresh COMMIT ACK');
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  await expect(
    services().service.signOut({ refreshToken: token }),
  ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
  expect(statements).not.toContain('ROLLBACK');
  expect((await tokens())[0].context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  expect(await audits()).toHaveLength(1);
});

const waitForAuthenticationLock = async (prefix: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waits = await owner.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1`,
      [prefix + '%'],
    );
    if (waits.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected authentication lock wait not observed');
};

it.each(['issue', 'rotate'])(
  'does not return credentials after lost actual %s COMMIT acknowledgement',
  async (operation) => {
    const existing = operation === 'rotate' ? await createToken() : undefined;
    const create = runtime.createQueryRunner.bind(runtime),
      statements: string[] = [],
      patchedClients = new WeakSet<object>();
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = create(mode),
        connect = runner.connect.bind(runner);
      jest.spyOn(runner, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!patchedClients.has(client)) {
          patchedClients.add(client);
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            statements.push(sql);
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('lost issuance COMMIT ACK');
            return result;
          };
        }
        return client;
      });
      return runner;
    });
    const { refresh, renew, access } = services();
    await expect(
      existing
        ? renew.generateTokensFromRefreshToken(existing.token)
        : refresh.generateRefreshToken(issuancePayload()),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(statements).not.toContain('ROLLBACK');
    expect(
      statements.filter((sql) =>
        sql.startsWith('INSERT INTO "core"."appToken"'),
      ),
    ).toHaveLength(1);
    expect(await tokens()).toHaveLength(existing ? 2 : 1);
    expect(await audits()).toHaveLength(existing ? 2 : 1);
    expect(access.generateAccessToken).not.toHaveBeenCalled();
  },
);

it.each(['old', 'new'])(
  'rolls back rotation when audit corrupts the %s credential',
  async (target) => {
    const { token } = await createToken(),
      before = await tokens();
    const action = target === 'old' ? 'update' : 'create';
    await owner.query(`CREATE FUNCTION crm_audit.fail_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN UPDATE core."appToken" SET "expiresAt"=now()+interval '100 years' WHERE id=NEW."resourceId"::uuid; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_refresh_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_refresh_audit()`);
    await expect(
      services().renew.generateTokensFromRefreshToken(token),
    ).rejects.toThrow('persisted credential changed');
    expect(await tokens()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('checks grace again after waiting for the token row lock', async () => {
  const { row, token } = await createToken(),
    writer = owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  await writer.query('SELECT id FROM core."appToken" WHERE id=$1 FOR UPDATE', [
    row.id,
  ]);
  const renewing = services().renew.generateTokensFromRefreshToken(token);
  const rejected = expect(renewing).rejects.toThrow('revoked');
  try {
    await waitForAuthenticationLock('SELECT "AppTokenEntity"');
    await writer.query(
      'UPDATE core."appToken" SET "revokedAt"=$1 WHERE id=$2',
      [new Date(Date.now() - 120000), row.id],
    );
    await writer.commitTransaction();
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
  }
  await rejected;
  expect(await tokens()).toHaveLength(1);
  expect(await audits()).toEqual([]);
});

it('blocks a renewal that read the token before logout acquired the authentication fence', async () => {
  const { token } = await createToken(),
    { service, renew } = services();
  let ready!: () => void,
    release!: () => void,
    paused = false;
  const changed = new Promise<void>((resolve) => (ready = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const create = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      query = runner.query.bind(runner);
    runner.query = async (
      sql: string,
      params?: unknown[],
      structured?: true,
    ) => {
      const result = structured
        ? await query(sql, params, true)
        : await query(sql, params);
      if (sql === 'SAVEPOINT refresh_revocation_audit' && !paused) {
        paused = true;
        ready();
        await gate;
      }
      return result;
    };
    return runner;
  });
  const logout = service.signOut({ refreshToken: token });
  await changed;
  const renewing = renew.generateTokensFromRefreshToken(token);
  const rejected = expect(renewing).rejects.toThrow('revoked');
  try {
    await waitForAuthenticationLock('SELECT pg_advisory_xact_lock_shared');
  } finally {
    release();
    await logout;
  }
  await rejected;
  expect(await tokens()).toHaveLength(1);
  expect(await audits()).toHaveLength(1);
});

it('serializes logout after an earlier renewal without claiming to revoke successor tokens', async () => {
  const { row, token } = await createToken(),
    { service, refresh, renew } = services();
  let ready!: () => void, release!: () => void;
  const created = new Promise<void>((resolve) => (ready = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const generate = jwt.signAsyncOrThrow.bind(jwt);
  jest.spyOn(jwt, 'signAsyncOrThrow').mockImplementation(async (...args) => {
    const result = await generate(...args);
    ready();
    await gate;
    return result;
  });
  const renewing = renew.generateTokensFromRefreshToken(token);
  await created;
  const logout = service.signOut({ refreshToken: token });
  try {
    await waitForAuthenticationLock('SELECT pg_advisory_xact_lock(');
  } finally {
    release();
  }
  const successor = await renewing;
  await logout;
  const rows = await tokens();
  expect(rows).toHaveLength(2);
  expect(rows.find((item) => item.id === row.id)?.context?.revokedReason).toBe(
    UserSessionRevokedReason.UserSignOut,
  );
  await expect(refresh.verifyRefreshToken(token)).rejects.toThrow('revoked');
  await expect(
    refresh.verifyRefreshToken(successor.refreshToken.token),
  ).resolves.toBeDefined();
  expect(await audits()).toHaveLength(3);
});

it('does not report success if audit savepoint recovery fails', async () => {
  const { token } = await createToken(),
    before = await tokens();
  await owner.query(`CREATE FUNCTION crm_audit.fail_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER fail_refresh_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_refresh_audit()`);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const create = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      query = runner.query.bind(runner);
    runner.query = async (
      sql: string,
      params?: unknown[],
      structured?: true,
    ) => {
      if (sql === 'ROLLBACK TO SAVEPOINT refresh_revocation_audit')
        throw new Error('savepoint recovery failed');
      return structured ? query(sql, params, true) : query(sql, params);
    };
    return runner;
  });
  await expect(
    services().service.signOut({ refreshToken: token }),
  ).rejects.toThrow('savepoint recovery failed');
  expect(await tokens()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it.each([
  'missing-owner',
  'wrong-owner-shape',
  'wrong-access',
  'mixed-scope',
  'wrong-action',
  'wrong-resource',
])('rejects an invalid refresh audit descriptor: %s', (variant) => {
  const resourceId = randomUUID();
  const mutation: CrmAuditMutation = {
    resourceKind: 'refreshToken',
    resourceId,
    action: 'update',
    before: { revokedAt: null },
    after: { revokedAt: '2026-01-01' },
    securityDescriptor: {
      resourceKind: 'refreshToken',
      resourceId,
      tokenOwner: { userId, access: 'currentWorkspaceAdministration' },
    },
  };
  if (variant === 'missing-owner')
    delete mutation.securityDescriptor.tokenOwner;
  if (variant === 'wrong-owner-shape')
    Object.assign(mutation.securityDescriptor.tokenOwner!, {
      userWorkspaceId: randomUUID(),
    });
  if (variant === 'wrong-access')
    Object.assign(mutation.securityDescriptor.tokenOwner!, {
      access: 'historical-owner',
    });
  if (variant === 'mixed-scope')
    mutation.securityDescriptor.bindingId = randomUUID();
  if (variant === 'wrong-action') mutation.action = 'delete';
  if (variant === 'wrong-resource') {
    mutation.resourceKind = 'crmRecord';
    mutation.securityDescriptor.resourceKind = 'crmRecord';
    mutation.securityDescriptor.objectMetadataId = randomUUID();
  }
  const context = new CrmAuditTransactionContext(
    { isTransactionActive: true, isReleased: false, query: jest.fn() } as never,
    {
      workspaceId,
      operationId: randomUUID(),
      actor: { kind: 'coreUser', id: userId },
    },
  );
  expect(() => context.record(mutation)).toThrow(/scope/);
});
