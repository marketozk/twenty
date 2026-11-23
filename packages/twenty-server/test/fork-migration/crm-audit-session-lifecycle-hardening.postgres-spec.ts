import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Request } from 'express';
import { sign, verify, decode, type SignOptions } from 'jsonwebtoken';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  AppTokenEntity,
  AppTokenType,
} from 'src/engine/core-modules/app-token/app-token.entity';
import { RefreshTokenService } from 'src/engine/core-modules/auth/token/services/refresh-token.service';
import { RenewTokenService } from 'src/engine/core-modules/auth/token/services/renew-token.service';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import { acquireUserAuthenticationLock } from 'src/engine/core-modules/auth/utils/acquire-user-authentication-lock.util';
import { type CrmAuditEntryPayload } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { ImpersonationService } from 'src/engine/core-modules/impersonation/services/impersonation.service';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';
import { UserSessionEntity } from 'src/engine/core-modules/user-session/user-session.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

jest.mock('src/engine/core-modules/user/user.entity', () => {
  const { Entity, PrimaryColumn, Column } = require('typeorm');
  class UserEntity {}
  Entity({ schema: 'core', name: 'user' })(UserEntity);
  PrimaryColumn({ type: 'uuid' })(UserEntity.prototype, 'id');
  Column({ type: 'boolean', default: false })(UserEntity.prototype, 'disabled');
  Column({ type: 'timestamptz', nullable: true })(
    UserEntity.prototype,
    'deletedAt',
  );
  return { UserEntity };
});
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => {
  const { Entity, PrimaryColumn, Column } = require('typeorm');
  class WorkspaceEntity {}
  Entity({ schema: 'core', name: 'workspace' })(WorkspaceEntity);
  PrimaryColumn({ type: 'uuid' })(WorkspaceEntity.prototype, 'id');
  Column({ type: 'timestamptz', nullable: true })(
    WorkspaceEntity.prototype,
    'deletedAt',
  );
  return { WorkspaceEntity };
});
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => {
    const {
      Entity,
      PrimaryColumn,
      Column,
      ManyToOne,
      JoinColumn,
    } = require('typeorm');
    const {
      UserEntity: MockUser,
    } = require('src/engine/core-modules/user/user.entity');
    const {
      WorkspaceEntity: MockWorkspace,
    } = require('src/engine/core-modules/workspace/workspace.entity');
    class UserWorkspaceEntity {}
    Entity({ schema: 'core', name: 'userWorkspace' })(UserWorkspaceEntity);
    PrimaryColumn({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'id');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'userId');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'workspaceId');
    Column({ type: 'timestamptz', nullable: true })(
      UserWorkspaceEntity.prototype,
      'deletedAt',
    );
    ManyToOne(() => MockUser)(UserWorkspaceEntity.prototype, 'user');
    JoinColumn({ name: 'userId' })(UserWorkspaceEntity.prototype, 'user');
    ManyToOne(() => MockWorkspace)(UserWorkspaceEntity.prototype, 'workspace');
    JoinColumn({ name: 'workspaceId' })(
      UserWorkspaceEntity.prototype,
      'workspace',
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
jest.mock(
  'src/engine/core-modules/auth/token/services/login-token.service',
  () => ({ LoginTokenService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
  () => ({ WorkspaceDomainsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/impersonation/services/impersonation-authorization.service',
  () => ({ ImpersonationAuthorizationService: class {} }),
);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated fork test database required');
}

const role = `session_harden_${randomUUID().replaceAll('-', '')}`;
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
  extra: { max: 5, statement_timeout: 10000 },
});
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = 'isolated-session-harden-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities,
  synchronize: false,
  extra: { max: 5, statement_timeout: 10000 },
});

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userAId = randomUUID();
const userBId = randomUUID();
const impersonatorUserId = randomUUID();
const userAWorkspaceId = randomUUID();
const userBWorkspaceId = randomUUID();
const impersonatorWorkspaceId = randomUUID();

const jwtSecret = 'isolated-log207-jwt-fixture-not-production';
const jwtWrapper = {
  verifyJwtToken: jest.fn(async (token: string) => verify(token, jwtSecret)),
  decode: (token: string) => decode(token),
  signAsyncOrThrow: async (
    payload: object,
    options: { jwtid: string; expiresIn?: SignOptions['expiresIn'] },
  ) =>
    sign(payload, jwtSecret, {
      jwtid: options.jwtid,
      expiresIn: options.expiresIn ?? '1h',
    }),
};
const configService = {
  get: (key: string) => {
    if (key === 'REFRESH_TOKEN_REUSE_GRACE_PERIOD') return '1m';
    if (key === 'SESSION_IDLE_TIMEOUT') return '7d';
    return '1h';
  },
};

const makeServices = () => {
  const cache = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    mdel: jest.fn().mockResolvedValue(undefined),
  };
  const cookieState = {
    presentedSessionToken: undefined as string | undefined,
    impersonatorSessionToken: undefined as string | undefined,
  };
  const cookieService = {
    extractSessionTokenFromRequest: jest.fn(
      () => cookieState.presentedSessionToken,
    ),
    extractImpersonatorSessionTokenFromRequest: jest.fn(
      () => cookieState.impersonatorSessionToken,
    ),
    attachSessionTokenToResponse: jest.fn(),
    attachImpersonatorSessionTokenToResponse: jest.fn(),
    clearSessionCookie: jest.fn(),
    clearImpersonatorSessionCookie: jest.fn(),
  };
  const eventLogEmitter = {
    createContext: jest.fn().mockReturnValue({
      insertWorkspaceEvent: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const refreshService = new RefreshTokenService(
    jwtWrapper as never,
    configService as never,
    runtime.getRepository(AppTokenEntity),
    runtime.getRepository(UserEntity),
  );
  const accessService = {
    generateAccessToken: jest.fn(async () => ({
      token: 'synthetic-access-jwt',
      expiresAt: new Date(Date.now() + 3600_000),
    })),
  };
  const renewService = new RenewTokenService(
    accessService as never,
    {} as never,
    refreshService,
  );
  const sessionService = new UserSessionService(
    runtime.getRepository(UserSessionEntity),
    runtime.getRepository(AppTokenEntity),
    cache as never,
    configService as never,
    jwtWrapper as never,
    eventLogEmitter as never,
    cookieService as never,
  );
  const impersonationService = new ImpersonationService(
    eventLogEmitter as never,
    {} as never,
    {} as never,
    runtime.getRepository(UserWorkspaceEntity),
    {} as never,
    configService as never,
    sessionService,
    cookieService as never,
  );
  return {
    refreshService,
    renewService,
    sessionService,
    impersonationService,
    cookieState,
    cookieService,
    cache,
  };
};

const readAudits = () =>
  owner.query<CrmAuditEntryPayload[]>(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
  );
const readTokens = () =>
  owner.getRepository(AppTokenEntity).find({ order: { createdAt: 'ASC' } });
const readSessions = () =>
  owner.getRepository(UserSessionEntity).find({ order: { createdAt: 'ASC' } });

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(`
    CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-session-harden-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core, crm_audit TO "${role}";
    GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}";
    GRANT UPDATE ON core."user", core.workspace, core."userWorkspace" TO "${role}";
    GRANT INSERT, UPDATE ON core."appToken", core."userSession" TO "${role}";
    GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}";
  `);
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  jwtWrapper.verifyJwtToken.mockClear();
  await owner.query(`
    DROP TRIGGER IF EXISTS fail_family_audit ON crm_audit."crmAuditEntry";
    DROP FUNCTION IF EXISTS crm_audit.fail_family_audit();
    DROP TRIGGER IF EXISTS corrupt_family_token ON core."appToken";
    DROP FUNCTION IF EXISTS core.corrupt_family_token();
    DROP TRIGGER IF EXISTS resurrect_family_token ON crm_audit."crmAuditEntry";
    DROP FUNCTION IF EXISTS crm_audit.resurrect_family_token();
    TRUNCATE core."appToken", core."userSession", core."userWorkspace", core."user", core.workspace, crm_audit."crmAuditEntry" CASCADE;
  `);
  await owner.query('INSERT INTO core.workspace (id) VALUES ($1), ($2)', [
    workspaceId,
    otherWorkspaceId,
  ]);
  await owner.query(
    'INSERT INTO core."user" (id, disabled) VALUES ($1, false), ($2, false), ($3, false)',
    [userAId, userBId, impersonatorUserId],
  );
  await owner.query(
    'INSERT INTO core."userWorkspace" (id, "userId", "workspaceId") VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
    [
      userAWorkspaceId,
      userAId,
      workspaceId,
      userBWorkspaceId,
      userBId,
      otherWorkspaceId,
      impersonatorWorkspaceId,
      impersonatorUserId,
      otherWorkspaceId,
    ],
  );
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

describe('LOG-207 Session lifecycle hardening', () => {
  it('revokes an entire refresh token family on post-grace replay, spares expired historical tokens and other families, and survives audit failure via SAVEPOINT', async () => {
    const { refreshService, renewService } = makeServices();

    // Issue family F (T1 -> T2 -> T3) and unrelated family F2 (U1).
    const t1 = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });
    const t2 = (await renewService.generateTokensFromRefreshToken(t1.token))
      .refreshToken;
    const t3 = (await renewService.generateTokensFromRefreshToken(t2.token))
      .refreshToken;
    const u1 = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });

    const t1Claims = decode(t1.token) as { jti: string };
    const t2Claims = decode(t2.token) as { jti: string };
    const t3Claims = decode(t3.token) as { jti: string };
    const u1Claims = decode(u1.token) as { jti: string };

    const allBefore = await readTokens();
    const t1Row = allBefore.find((row) => row.id === t1Claims.jti)!;
    const t2Row = allBefore.find((row) => row.id === t2Claims.jti)!;
    const t3Row = allBefore.find((row) => row.id === t3Claims.jti)!;
    const u1Row = allBefore.find((row) => row.id === u1Claims.jti)!;
    const familyF = t1Row.context!.familyId!;
    expect(t2Row.context?.familyId).toBe(familyF);
    expect(t3Row.context?.familyId).toBe(familyF);
    expect(u1Row.context?.familyId).not.toBe(familyF);

    // Seed an expired historical rotated token T0 in family F (must NOT be touched or audited).
    const t0Id = randomUUID();
    const t0RevokedAt = new Date(Date.now() - 48 * 3600_000);
    await owner.getRepository(AppTokenEntity).save({
      id: t0Id,
      userId: userAId,
      workspaceId,
      type: AppTokenType.RefreshToken,
      expiresAt: new Date(Date.now() - 24 * 3600_000),
      revokedAt: t0RevokedAt,
      context: { familyId: familyF, email: 'private-old@example.test' },
    });

    // Move T1's revokedAt past the 1m grace window.
    const t1PastGrace = new Date(Date.now() - 120_000);
    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [t1PastGrace, t1Row.id],
    );
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    // Replay T1 concurrently from two callers: no deadlock, exactly one family revoke audit batch.
    const replayResults = await Promise.allSettled([
      renewService.generateTokensFromRefreshToken(t1.token),
      renewService.generateTokensFromRefreshToken(t1.token),
    ]);
    expect(replayResults.every((r) => r.status === 'rejected')).toBe(true);

    const afterReplay = await readTokens();
    const afterById = new Map(afterReplay.map((row) => [row.id, row]));
    expect(afterById.get(t1Row.id)!.revokedAt!.getTime()).toBe(
      t1PastGrace.getTime(),
    );
    expect(afterById.get(t1Row.id)!.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
    expect(afterById.get(t2Row.id)!.revokedAt!.getTime()).toBe(
      t2Row.revokedAt!.getTime(),
    );
    expect(afterById.get(t2Row.id)!.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
    expect(afterById.get(t3Row.id)!.revokedAt).toBeInstanceOf(Date);
    expect(afterById.get(t3Row.id)!.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
    // Expired historical T0 and independent family U1 remain untouched.
    expect(afterById.get(t0Id)!.context?.revokedReason).toBeUndefined();
    expect(afterById.get(u1Row.id)!.revokedAt).toBeNull();

    const familyAudits = await readAudits();
    expect(familyAudits).toHaveLength(3);
    expect(new Set(familyAudits.map((entry) => entry.operationId)).size).toBe(
      1,
    );
    expect(familyAudits.map((entry) => entry.resourceId).sort()).toEqual(
      [t1Row.id, t2Row.id, t3Row.id].sort(),
    );
    for (const entry of familyAudits) {
      expect(entry.action).toBe('update');
      expect(entry.redactedDiff.values).toEqual({
        revokedReason: {
          before: null,
          after: UserSessionRevokedReason.RefreshTokenReuseDetected,
        },
      });
    }
    const serialized = JSON.stringify(familyAudits);
    expect(serialized).not.toContain(familyF);
    expect(serialized).not.toContain(t1.token);
    expect(serialized).not.toContain('private-old@example.test');

    // Subsequent replay of T1 or T3 is idempotent (no additional audit entries).
    await expect(
      renewService.generateTokensFromRefreshToken(t1.token),
    ).rejects.toThrow('revoked');
    await expect(
      renewService.generateTokensFromRefreshToken(t3.token),
    ).rejects.toThrow('revoked');
    expect(await readAudits()).toHaveLength(3);

    // Independent family U1 still rotates cleanly.
    const u2 = (await renewService.generateTokensFromRefreshToken(u1.token))
      .refreshToken;
    expect(u2.token).toBeDefined();

    // Direct rotateRefreshToken replay + deactivated user replay + SAVEPOINT survival on audit failure.
    const u1PastGrace = new Date(Date.now() - 120_000);
    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [u1PastGrace, u1Row.id],
    );
    await owner.query(
      'UPDATE core."user" SET "deletedAt" = NOW() WHERE id = $1',
      [userAId],
    );
    await owner.query(`
      CREATE FUNCTION crm_audit.fail_family_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'FAMILY_AUDIT_DOWN'; END $$;
      CREATE TRIGGER fail_family_audit BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_family_audit();
    `);
    const errorLogSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      renewService.generateTokensFromRefreshToken(u1.token),
    ).rejects.toThrow('revoked');

    const u2Claims = decode(u2.token) as { jti: string };
    const u2Row = (await readTokens()).find((row) => row.id === u2Claims.jti)!;
    expect(u2Row.revokedAt).toBeInstanceOf(Date);
    expect(u2Row.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
    expect(errorLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE'),
    );
  });

  it('assigns familyId to a legacy token on rotation and revokes its successor on post-grace replay', async () => {
    const { renewService, refreshService } = makeServices();
    const legacyRow = await owner.getRepository(AppTokenEntity).save({
      userId: userAId,
      workspaceId,
      type: AppTokenType.RefreshToken,
      expiresAt: new Date(Date.now() + 3600_000),
      context: { email: 'legacy@example.test' },
    });
    const legacyJwt = sign(
      {
        sub: userAId,
        userId: userAId,
        workspaceId,
        type: JwtTokenTypeEnum.REFRESH,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
      },
      jwtSecret,
      { jwtid: legacyRow.id, expiresIn: '1h' },
    );

    const successor = (
      await renewService.generateTokensFromRefreshToken(legacyJwt)
    ).refreshToken;
    const successorClaims = decode(successor.token) as { jti: string };

    const rowsAfterRotate = await readTokens();
    const updatedLegacy = rowsAfterRotate.find((r) => r.id === legacyRow.id)!;
    const successorRow = rowsAfterRotate.find(
      (r) => r.id === successorClaims.jti,
    )!;
    expect(updatedLegacy.context?.familyId).toBe(legacyRow.id.toLowerCase());
    expect(successorRow.context?.familyId).toBe(legacyRow.id.toLowerCase());

    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), legacyRow.id],
    );

    await expect(
      refreshService.rotateRefreshToken({
        tokenId: legacyRow.id,
        payload: {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        },
      }),
    ).rejects.toThrow('revoked');

    const finalSuccessor = (await readTokens()).find(
      (r) => r.id === successorClaims.jti,
    )!;
    expect(finalSuccessor.revokedAt).toBeInstanceOf(Date);
    expect(finalSuccessor.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
  });

  it('fences token issuance, rotation, and session creation against deactivated/disabled users, deleted workspaces, deleted memberships, and real row-level FOR UPDATE races', async () => {
    const { refreshService, sessionService } = makeServices();
    const activeToken = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });
    const activeTokenId = (decode(activeToken.token) as { jti: string }).jti;

    // 1. Disabled user cannot mint tokens or sessions.
    await owner.query('UPDATE core."user" SET disabled = true WHERE id = $1', [
      userAId,
    ]);
    await expect(
      refreshService.generateRefreshToken({
        userId: userAId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
      }),
    ).rejects.toThrow('User not found');
    await expect(
      refreshService.rotateRefreshToken({
        tokenId: activeTokenId,
        payload: {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        },
      }),
    ).rejects.toThrow('User not found');
    await expect(
      sessionService.createSession({
        userId: userAId,
        workspaceId,
        userWorkspaceId: userAWorkspaceId,
        authProvider: AuthProviderEnum.Password,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('User not found');
    await expect(
      sessionService.createSession({
        userId: userAId,
        authProvider: AuthProviderEnum.Password,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('User not found');

    await owner.query('UPDATE core."user" SET disabled = false WHERE id = $1', [
      userAId,
    ]);

    // 2. Deleted workspace blocks refresh issuance and workspace session creation.
    await owner.query(
      'UPDATE core.workspace SET "deletedAt" = NOW() WHERE id = $1',
      [workspaceId],
    );
    await expect(
      refreshService.generateRefreshToken({
        userId: userAId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
      }),
    ).rejects.toThrow('Workspace not found');
    await expect(
      sessionService.createSession({
        userId: userAId,
        workspaceId,
        userWorkspaceId: userAWorkspaceId,
        authProvider: AuthProviderEnum.Password,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('Workspace not found');

    await owner.query(
      'UPDATE core.workspace SET "deletedAt" = NULL WHERE id = $1',
      [workspaceId],
    );

    // 3. Real production deactivation race via row-level FOR UPDATE (NO acquireUserAuthenticationLock).
    const deactivateRunner = owner.createQueryRunner();
    await deactivateRunner.connect();
    await deactivateRunner.startTransaction();
    try {
      await deactivateRunner.query(
        'SELECT id FROM core."user" WHERE id = $1 FOR UPDATE',
        [userAId],
      );

      let refreshFinished = false;
      let sessionFinished = false;
      const racingRefresh = refreshService
        .generateRefreshToken({
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        })
        .finally(() => {
          refreshFinished = true;
        });
      const racingSession = sessionService
        .createSession({
          userId: userAId,
          workspaceId,
          userWorkspaceId: userAWorkspaceId,
          authProvider: AuthProviderEnum.Password,
          origin: 'sign_in',
        })
        .finally(() => {
          sessionFinished = true;
        });

      const settledRacing = Promise.allSettled([racingRefresh, racingSession]);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(refreshFinished).toBe(false);
      expect(sessionFinished).toBe(false);

      await deactivateRunner.query(
        'UPDATE core."user" SET "deletedAt" = NOW() WHERE id = $1',
        [userAId],
      );
      await deactivateRunner.commitTransaction();

      const [refreshOutcome, sessionOutcome] = await settledRacing;
      expect(refreshOutcome.status).toBe('rejected');
      expect(
        (refreshOutcome as PromiseRejectedResult).reason.message,
      ).toContain('User not found');
      expect(sessionOutcome.status).toBe('rejected');
      expect(
        (sessionOutcome as PromiseRejectedResult).reason.message,
      ).toContain('User not found');
      expect(await readSessions()).toHaveLength(0);
    } finally {
      if (deactivateRunner.isTransactionActive) {
        await deactivateRunner.rollbackTransaction();
      }
      await deactivateRunner.release();
    }
  });

  it('enforces canonical actor/initiator, target lockUserId, fail-closed stopImpersonation checks, and shared correlationId across Superseded and signOut', async () => {
    const {
      sessionService,
      impersonationService,
      refreshService,
      cookieState,
    } = makeServices();

    // 1. Create normal session for userA and impersonation session for userA (initiated by impersonator).
    const normalSession = await sessionService.createSession({
      userId: userAId,
      workspaceId,
      userWorkspaceId: userAWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
    });
    const impSession = await sessionService.createSession({
      userId: userAId,
      workspaceId,
      userWorkspaceId: userAWorkspaceId,
      authProvider: AuthProviderEnum.Impersonation,
      isImpersonating: true,
      impersonatorUserWorkspaceId: impersonatorWorkspaceId,
      impersonatedUserWorkspaceId: userAWorkspaceId,
      origin: 'sign_in',
    });

    // stopImpersonation presented with a NON-impersonation cookie must fail closed without revoking it.
    cookieState.presentedSessionToken = normalSession.sessionToken;
    await expect(
      impersonationService.stopImpersonation({
        impersonationContext: {
          impersonatorUserWorkspaceId: impersonatorWorkspaceId,
          impersonatedUserWorkspaceId: userAWorkspaceId,
        },
        workspaceId,
        request: { headers: {}, res: {} } as Request,
      }),
    ).rejects.toThrow('Session does not match active impersonation');
    expect(
      (await readSessions()).find((s) => s.id === normalSession.session.id)!
        .revokedAt,
    ).toBeNull();

    // stopImpersonation with mismatched impersonator must fail closed.
    cookieState.presentedSessionToken = impSession.sessionToken;
    await expect(
      impersonationService.stopImpersonation({
        impersonationContext: {
          impersonatorUserWorkspaceId: userBWorkspaceId,
          impersonatedUserWorkspaceId: userAWorkspaceId,
        },
        workspaceId,
        request: { headers: {}, res: {} } as Request,
      }),
    ).rejects.toThrow('Session does not match active impersonation');

    // Valid stopImpersonation must acquire user-authentication lock on TARGET userAId and record actor=userAId, initiator=impersonatorUserId.
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    const lockRunner = owner.createQueryRunner();
    await lockRunner.connect();
    await lockRunner.startTransaction();
    try {
      await acquireUserAuthenticationLock({
        entityManager: lockRunner.manager,
        userId: userAId,
        mode: 'exclusive',
      });
      let stopCompleted = false;
      const stopPromise = impersonationService
        .stopImpersonation({
          impersonationContext: {
            impersonatorUserWorkspaceId: impersonatorWorkspaceId,
            impersonatedUserWorkspaceId: userAWorkspaceId,
          },
          workspaceId,
          request: { headers: {}, res: {} } as Request,
        })
        .finally(() => {
          stopCompleted = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stopCompleted).toBe(false);
      await lockRunner.commitTransaction();
      await stopPromise;
    } finally {
      if (lockRunner.isTransactionActive) {
        await lockRunner.rollbackTransaction();
      }
      await lockRunner.release();
    }

    const stopAudits = await readAudits();
    expect(stopAudits).toHaveLength(1);
    expect(stopAudits[0]).toMatchObject({
      resourceKind: 'userSession',
      resourceId: impSession.session.id,
      action: 'update',
      actor: { kind: 'coreUser', id: userAId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
    expect(stopAudits[0].redactedDiff.values).toEqual({
      revokedReason: {
        before: null,
        after: UserSessionRevokedReason.ImpersonationEnded,
      },
    });

    // 2. issueSessionForTokenPair: userB signs in over userA's cookie -> Superseded locks userAId and shares correlationId with userB's create.
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    cookieState.presentedSessionToken = normalSession.sessionToken;
    const accessTokenForB = sign(
      {
        sub: userBId,
        userId: userBId,
        workspaceId: otherWorkspaceId,
        userWorkspaceId: userBWorkspaceId,
        authProvider: AuthProviderEnum.Password,
        type: JwtTokenTypeEnum.ACCESS,
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const supersedeLockRunner = owner.createQueryRunner();
    await supersedeLockRunner.connect();
    await supersedeLockRunner.startTransaction();
    try {
      await acquireUserAuthenticationLock({
        entityManager: supersedeLockRunner.manager,
        userId: userAId,
        mode: 'exclusive',
      });
      let issueDone = false;
      const issuePromise = sessionService
        .issueSessionForTokenPair({
          tokenPair: {
            accessOrWorkspaceAgnosticToken: {
              token: accessTokenForB,
              expiresAt: new Date(Date.now() + 3600_000),
            },
            refreshToken: {
              token: 'unused-refresh',
              expiresAt: new Date(Date.now() + 3600_000),
            },
          },
          request: { headers: {}, res: {}, ip: '192.0.2.10' } as Request,
          origin: 'sign_in',
        })
        .finally(() => {
          issueDone = true;
        });

      // createSession for userB completes, then revokeSessionByToken(Superseded) blocks on userAId lock.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(issueDone).toBe(false);
      await supersedeLockRunner.commitTransaction();
      await issuePromise;
    } finally {
      if (supersedeLockRunner.isTransactionActive) {
        await supersedeLockRunner.rollbackTransaction();
      }
      await supersedeLockRunner.release();
    }

    const handoffAudits = await readAudits();
    expect(handoffAudits).toHaveLength(2);
    const createAudit = handoffAudits.find((e) => e.action === 'create')!;
    const supersededAudit = handoffAudits.find((e) => e.action === 'update')!;
    expect(createAudit.correlationId).toBeDefined();
    expect(supersededAudit.correlationId).toBe(createAudit.correlationId);
    expect(supersededAudit.resourceId).toBe(normalSession.session.id);

    // 3. signOut({ sessionToken, refreshToken }) links both audits via one correlationId; invalid correlationId fails before SAVEPOINT.
    const signOutSession = await sessionService.createSession({
      userId: userAId,
      workspaceId,
      userWorkspaceId: userAWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
    });
    const signOutRefresh = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    await sessionService.signOut({
      sessionToken: signOutSession.sessionToken,
      refreshToken: signOutRefresh.token,
    });

    const signOutAudits = await readAudits();
    expect(signOutAudits).toHaveLength(2);
    const sessionOut = signOutAudits.find(
      (e) => e.resourceKind === 'userSession',
    )!;
    const refreshOut = signOutAudits.find(
      (e) => e.resourceKind === 'refreshToken',
    )!;
    expect(sessionOut.correlationId).toBeDefined();
    expect(refreshOut.correlationId).toBe(sessionOut.correlationId);

    // Invalid correlationId rejected before transaction / SAVEPOINT.
    await expect(
      sessionService.revokeSessionByToken(
        signOutSession.sessionToken,
        UserSessionRevokedReason.UserSignOut,
        undefined,
        { correlationId: '' },
      ),
    ).rejects.toThrow('correlationId is invalid');
  });

  it('blocks deleted memberships, deleted workspace on rotation, disabled impersonators, and validates malformed UUIDs fail-fast before transactions', async () => {
    const { refreshService, sessionService } = makeServices();
    const activeToken = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });
    const activeTokenId = (decode(activeToken.token) as { jti: string }).jti;

    // 1. Deleted membership blocks generateRefreshToken, rotateRefreshToken, and createSession.
    await owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt" = NOW() WHERE id = $1',
      [userAWorkspaceId],
    );
    await expect(
      refreshService.generateRefreshToken({
        userId: userAId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
      }),
    ).rejects.toThrow('User workspace not found');
    await expect(
      refreshService.rotateRefreshToken({
        tokenId: activeTokenId,
        payload: {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        },
      }),
    ).rejects.toThrow('User workspace not found');
    await expect(
      sessionService.createSession({
        userId: userAId,
        workspaceId,
        userWorkspaceId: userAWorkspaceId,
        authProvider: AuthProviderEnum.Password,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('Session membership does not match');

    await owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt" = NULL WHERE id = $1',
      [userAWorkspaceId],
    );

    // 2. Deleted workspace blocks rotateRefreshToken.
    await owner.query(
      'UPDATE core.workspace SET "deletedAt" = NOW() WHERE id = $1',
      [workspaceId],
    );
    await expect(
      refreshService.rotateRefreshToken({
        tokenId: activeTokenId,
        payload: {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        },
      }),
    ).rejects.toThrow('Workspace not found');
    await owner.query(
      'UPDATE core.workspace SET "deletedAt" = NULL WHERE id = $1',
      [workspaceId],
    );

    // 3. Disabled impersonator account cannot issue impersonation refresh tokens or sessions.
    await owner.query('UPDATE core."user" SET disabled = true WHERE id = $1', [
      impersonatorUserId,
    ]);
    await expect(
      refreshService.generateRefreshToken(
        {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
          isImpersonating: true,
          impersonatorUserWorkspaceId: impersonatorWorkspaceId,
          impersonatedUserWorkspaceId: userAWorkspaceId,
        },
        true,
      ),
    ).rejects.toThrow('Refresh issuance initiator unavailable');
    await expect(
      sessionService.createSession({
        userId: userAId,
        workspaceId,
        userWorkspaceId: userAWorkspaceId,
        authProvider: AuthProviderEnum.Impersonation,
        isImpersonating: true,
        impersonatorUserWorkspaceId: impersonatorWorkspaceId,
        impersonatedUserWorkspaceId: userAWorkspaceId,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('Session impersonation initiator is unavailable');
    await owner.query('UPDATE core."user" SET disabled = false WHERE id = $1', [
      impersonatorUserId,
    ]);

    // 4. Fail-fast UUID validation before transaction / SAVEPOINT.
    const liveSession = await sessionService.createSession({
      userId: userAId,
      workspaceId,
      userWorkspaceId: userAWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
    });
    await expect(
      sessionService.revokeSessionByToken(
        liveSession.sessionToken,
        UserSessionRevokedReason.Superseded,
        'not-a-uuid',
      ),
    ).rejects.toThrow('Session revocation actor is invalid');
    expect(
      (await readSessions()).find((s) => s.id === liveSession.session.id)!
        .revokedAt,
    ).toBeNull();

    await expect(
      refreshService.rotateRefreshToken({
        tokenId: 'not-a-uuid',
        payload: {
          userId: userAId,
          workspaceId,
          targetedTokenType: JwtTokenTypeEnum.ACCESS,
        },
      }),
    ).rejects.toThrow('malformed');

    await expect(
      sessionService.createSession({
        userId: 'not-a-uuid',
        workspaceId,
        userWorkspaceId: userAWorkspaceId,
        authProvider: AuthProviderEnum.Password,
        origin: 'sign_in',
      }),
    ).rejects.toThrow('Session scope identifiers are invalid');
  });

  it('audits impersonation refresh-family replay, survives deleted initiator via SAVEPOINT, and guards against corrupting DB triggers', async () => {
    const { refreshService, renewService } = makeServices();
    const imp1 = await refreshService.generateRefreshToken(
      {
        userId: userAId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
        isImpersonating: true,
        impersonatorUserWorkspaceId: impersonatorWorkspaceId,
        impersonatedUserWorkspaceId: userAWorkspaceId,
      },
      true,
    );
    const imp2 = (await renewService.generateTokensFromRefreshToken(imp1.token))
      .refreshToken;
    const imp1Id = (decode(imp1.token) as { jti: string }).jti;
    const imp2Id = (decode(imp2.token) as { jti: string }).jti;

    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), imp1Id],
    );
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');

    // Happy-path impersonation family replay records initiator.
    await expect(
      renewService.generateTokensFromRefreshToken(imp1.token),
    ).rejects.toThrow('revoked');

    const impAudits = await readAudits();
    expect(impAudits).toHaveLength(2);
    for (const entry of impAudits) {
      expect(entry.actor).toEqual({ kind: 'coreUser', id: userAId });
      expect(entry.initiator).toEqual({
        kind: 'coreUser',
        id: impersonatorUserId,
      });
    }
    expect(
      (await readTokens()).find((r) => r.id === imp2Id)!.context?.revokedReason,
    ).toBe(UserSessionRevokedReason.RefreshTokenReuseDetected);

    // Deleted impersonator membership during family replay: revocation still commits via SAVEPOINT.
    const imp3 = await refreshService.generateRefreshToken(
      {
        userId: userAId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
        isImpersonating: true,
        impersonatorUserWorkspaceId: impersonatorWorkspaceId,
        impersonatedUserWorkspaceId: userAWorkspaceId,
      },
      true,
    );
    const imp4 = (await renewService.generateTokensFromRefreshToken(imp3.token))
      .refreshToken;
    const imp3Id = (decode(imp3.token) as { jti: string }).jti;
    const imp4Id = (decode(imp4.token) as { jti: string }).jti;
    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), imp3Id],
    );
    await owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt" = NOW() WHERE id = $1',
      [impersonatorWorkspaceId],
    );
    const errorLogSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      renewService.generateTokensFromRefreshToken(imp3.token),
    ).rejects.toThrow('revoked');
    expect(
      (await readTokens()).find((r) => r.id === imp4Id)!.context?.revokedReason,
    ).toBe(UserSessionRevokedReason.RefreshTokenReuseDetected);
    expect(errorLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE'),
    );

    // Trigger corrupting core."appToken" on BEFORE UPDATE aborts family revocation transaction.
    const tA = await refreshService.generateRefreshToken({
      userId: userAId,
      workspaceId,
      targetedTokenType: JwtTokenTypeEnum.ACCESS,
    });
    const tB = (await renewService.generateTokensFromRefreshToken(tA.token))
      .refreshToken;
    const tAId = (decode(tA.token) as { jti: string }).jti;
    const tBId = (decode(tB.token) as { jti: string }).jti;
    await owner.query(
      'UPDATE core."appToken" SET "revokedAt" = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), tAId],
    );
    await owner.query(`
      CREATE FUNCTION core.corrupt_family_token() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW."userId" = '${userBId}'; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_family_token BEFORE UPDATE ON core."appToken"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_family_token();
    `);
    await expect(
      renewService.generateTokensFromRefreshToken(tA.token),
    ).rejects.toThrow('Refresh persisted credential changed');
    expect(
      (await readTokens()).find((r) => r.id === tBId)!.revokedAt,
    ).toBeNull();

    await owner.query(`
      DROP TRIGGER corrupt_family_token ON core."appToken";
      DROP FUNCTION core.corrupt_family_token();
    `);

    // AFTER INSERT audit trigger attempting to resurrect token rolls back SAVEPOINT and keeps family revoked.
    await owner.query(`
      CREATE FUNCTION crm_audit.resurrect_family_token() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE core."appToken" SET "revokedAt" = NULL WHERE id = NEW."resourceId"::uuid; RETURN NEW; END $$;
      CREATE TRIGGER resurrect_family_token AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.resurrect_family_token();
    `);
    await expect(
      renewService.generateTokensFromRefreshToken(tA.token),
    ).rejects.toThrow('revoked');
    const finalTB = (await readTokens()).find((r) => r.id === tBId)!;
    expect(finalTB.revokedAt).toBeInstanceOf(Date);
    expect(finalTB.context?.revokedReason).toBe(
      UserSessionRevokedReason.RefreshTokenReuseDetected,
    );
  });

  it('enforces stopImpersonation workspace/target checks, rejects empty strings, and is idempotent on already-revoked impersonation sessions', async () => {
    const { sessionService, impersonationService, cookieState } =
      makeServices();
    const impSession = await sessionService.createSession({
      userId: userAId,
      workspaceId,
      userWorkspaceId: userAWorkspaceId,
      authProvider: AuthProviderEnum.Impersonation,
      isImpersonating: true,
      impersonatorUserWorkspaceId: impersonatorWorkspaceId,
      impersonatedUserWorkspaceId: userAWorkspaceId,
      origin: 'sign_in',
    });
    cookieState.presentedSessionToken = impSession.sessionToken;

    // Mismatched expectedWorkspaceId fails closed.
    await expect(
      impersonationService.stopImpersonation({
        impersonationContext: {
          impersonatorUserWorkspaceId: impersonatorWorkspaceId,
          impersonatedUserWorkspaceId: userAWorkspaceId,
        },
        workspaceId: otherWorkspaceId,
        request: { headers: {}, res: {} } as Request,
      }),
    ).rejects.toThrow('Session does not match active impersonation');

    // Mismatched expectedImpersonatedUserWorkspaceId fails closed.
    await expect(
      impersonationService.stopImpersonation({
        impersonationContext: {
          impersonatorUserWorkspaceId: impersonatorWorkspaceId,
          impersonatedUserWorkspaceId: userBWorkspaceId,
        },
        workspaceId,
        request: { headers: {}, res: {} } as Request,
      }),
    ).rejects.toThrow('Session does not match active impersonation');

    // Empty expectedWorkspaceId string is rejected fail-closed (not silently skipped).
    await expect(
      sessionService.revokeSessionByToken(
        impSession.sessionToken,
        UserSessionRevokedReason.ImpersonationEnded,
        undefined,
        {
          initiatorMembershipId: impersonatorWorkspaceId,
          expectedWorkspaceId: '',
        },
      ),
    ).rejects.toThrow('Session does not match active impersonation');

    // First valid stopImpersonation revokes and writes 1 audit; second retry is idempotent with 0 extra audits.
    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await impersonationService.stopImpersonation({
      impersonationContext: {
        impersonatorUserWorkspaceId: impersonatorWorkspaceId,
        impersonatedUserWorkspaceId: userAWorkspaceId,
      },
      workspaceId,
      request: { headers: {}, res: {} } as Request,
    });
    expect(await readAudits()).toHaveLength(1);

    await impersonationService.stopImpersonation({
      impersonationContext: {
        impersonatorUserWorkspaceId: impersonatorWorkspaceId,
        impersonatedUserWorkspaceId: userAWorkspaceId,
      },
      workspaceId,
      request: { headers: {}, res: {} } as Request,
    });
    expect(await readAudits()).toHaveLength(1);
  });
});
