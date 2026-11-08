import crypto, { randomUUID } from 'node:crypto';
import { type Request } from 'express';
import { decode, sign, verify, type SignOptions } from 'jsonwebtoken';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  AppTokenEntity,
  AppTokenType,
} from 'src/engine/core-modules/app-token/app-token.entity';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { compareHash } from 'src/engine/core-modules/auth/auth.util';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { clearPendingPasswordResetTokenValidation } from 'src/engine/core-modules/crm-audit/password-update-audit';
import { type UserSessionCookieService } from 'src/engine/core-modules/user-session/services/user-session-cookie.service';
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';
import { UserSessionEntity } from 'src/engine/core-modules/user-session/user-session.entity';
import { hashUserSessionToken } from 'src/engine/core-modules/user-session/utils/hash-user-session-token.util';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('src/engine/core-modules/user/user.entity', () => {
  const { Entity, PrimaryColumn, Column } = require('typeorm');
  class UserEntity {}
  Entity({ schema: 'core', name: 'user' })(UserEntity);
  PrimaryColumn({ type: 'uuid' })(UserEntity.prototype, 'id');
  Column({ type: 'text', default: 'user@example.test' })(
    UserEntity.prototype,
    'email',
  );
  Column({ type: 'text', default: 'First' })(UserEntity.prototype, 'firstName');
  Column({ type: 'text', default: 'Last' })(UserEntity.prototype, 'lastName');
  Column({ type: 'text', nullable: true })(
    UserEntity.prototype,
    'passwordHash',
  );
  Column({ type: 'timestamptz', nullable: true })(
    UserEntity.prototype,
    'deletedAt',
  );
  Column({ type: 'timestamptz', default: () => 'now()' })(
    UserEntity.prototype,
    'updatedAt',
  );
  return { UserEntity };
});

jest.mock('src/engine/core-modules/workspace/workspace.entity', () => {
  const { Entity, PrimaryColumn, Column, OneToMany } = require('typeorm');
  const {
    UserWorkspaceEntity: UW,
  } = require('src/engine/core-modules/user-workspace/user-workspace.entity');
  class WorkspaceEntity {}
  Entity({ schema: 'core', name: 'workspace' })(WorkspaceEntity);
  PrimaryColumn({ type: 'uuid' })(WorkspaceEntity.prototype, 'id');
  Column({ type: 'boolean', default: true })(
    WorkspaceEntity.prototype,
    'isPasswordAuthEnabled',
  );
  Column({ type: 'timestamptz', nullable: true })(
    WorkspaceEntity.prototype,
    'deletedAt',
  );
  Column({ type: 'timestamptz', default: () => 'now()' })(
    WorkspaceEntity.prototype,
    'createdAt',
  );
  OneToMany(
    () => UW,
    (uw: { workspace: unknown }) => uw.workspace,
  )(WorkspaceEntity.prototype, 'workspaceUsers');
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
      UserEntity: U,
    } = require('src/engine/core-modules/user/user.entity');
    class UserWorkspaceEntity {}
    Entity({ schema: 'core', name: 'userWorkspace' })(UserWorkspaceEntity);
    PrimaryColumn({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'id');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'userId');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'workspaceId');
    ManyToOne(() => U)(UserWorkspaceEntity.prototype, 'user');
    JoinColumn({ name: 'userId' })(UserWorkspaceEntity.prototype, 'user');
    ManyToOne(
      () =>
        require('src/engine/core-modules/workspace/workspace.entity')
          .WorkspaceEntity,
    )(UserWorkspaceEntity.prototype, 'workspace');
    JoinColumn({ name: 'workspaceId' })(
      UserWorkspaceEntity.prototype,
      'workspace',
    );
    Column({ type: 'text', default: 'en' })(
      UserWorkspaceEntity.prototype,
      'locale',
    );
    Column({ type: 'timestamptz', nullable: true })(
      UserWorkspaceEntity.prototype,
      'deletedAt',
    );
    Column({ type: 'timestamptz', default: () => 'now()' })(
      UserWorkspaceEntity.prototype,
      'createdAt',
    );
    return { UserWorkspaceEntity };
  },
);

jest.mock('twenty-emails', () => ({
  PasswordUpdateNotifyEmail: jest.fn(() => 'password-update-email'),
  PasswordResetLinkEmail: jest.fn(() => 'password-reset-email'),
  renderEmail: jest.fn(async () => 'rendered-email'),
}));

for (const [modPath, names] of [
  [
    'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
    ['MetadataResolver'],
  ],
  [
    'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars',
    ['UUIDScalarType'],
  ],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(
      names.map((n) => [
        n,
        function DecoratorAdapter() {
          return function NoopDecorator() {};
        },
      ]),
    ),
  );
}

for (const [modPath, names] of [
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  [
    'src/engine/core-modules/event-logs/emit/event-log-emitter.service',
    ['EventLogEmitterService'],
  ],
  [
    'src/engine/core-modules/jwt/services/jwt-wrapper.service',
    ['JwtWrapperService'],
  ],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/core-modules/cache-storage/services/cache-storage.service',
    ['CacheStorageService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/access-token.service',
    ['AccessTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/workspace-agnostic-token.service',
    ['WorkspaceAgnosticTokenService'],
  ],
  [
    'src/engine/core-modules/application/application-registration/application-registration.service',
    ['ApplicationRegistrationService'],
  ],
  [
    'src/engine/core-modules/auth/services/auth-sso.service',
    ['AuthSsoService'],
  ],
  [
    'src/engine/core-modules/auth/services/create-sso-connected-account.service',
    ['CreateSsoConnectedAccountService'],
  ],
  [
    'src/engine/core-modules/auth/services/sign-in-up.service',
    ['SignInUpService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/login-token.service',
    ['LoginTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/sso-exchange-token.service',
    ['SsoExchangeTokenService'],
  ],
  [
    'src/engine/core-modules/domain/domain-server-config/services/domain-server-config.service',
    ['DomainServerConfigService'],
  ],
  [
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  ['src/engine/core-modules/email/email.service', ['EmailService']],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  [
    'src/engine/core-modules/guard-redirect/services/guard-redirect.service',
    ['GuardRedirectService'],
  ],
  ['src/engine/core-modules/i18n/i18n.service', ['I18nService']],
  [
    'src/engine/core-modules/user-workspace/user-workspace.service',
    ['UserWorkspaceService'],
  ],
  ['src/engine/core-modules/user/services/user.service', ['UserService']],
  [
    'src/engine/core-modules/workspace-invitation/services/workspace-invitation.service',
    ['WorkspaceInvitationService'],
  ],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/core-entity-cache/services/core-entity-cache.service',
    ['CoreEntityCacheService'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}

const { RefreshTokenService } =
  require('src/engine/core-modules/auth/token/services/refresh-token.service') as typeof import('src/engine/core-modules/auth/token/services/refresh-token.service');
const { RenewTokenService } =
  require('src/engine/core-modules/auth/token/services/renew-token.service') as typeof import('src/engine/core-modules/auth/token/services/renew-token.service');
const { UserSessionService } =
  require('src/engine/core-modules/user-session/services/user-session.service') as typeof import('src/engine/core-modules/user-session/services/user-session.service');
const { AuthService } =
  require('src/engine/core-modules/auth/services/auth.service') as typeof import('src/engine/core-modules/auth/services/auth.service');
const { ResetPasswordService } =
  require('src/engine/core-modules/auth/services/reset-password.service') as typeof import('src/engine/core-modules/auth/services/reset-password.service');
const { UserSessionResolver } =
  require('src/engine/core-modules/user-session/user-session.resolver') as typeof import('src/engine/core-modules/user-session/user-session.resolver');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated twenty_rob764_test_<16 hex> database required');
}

const role = `password_audit_${randomUUID().replaceAll('-', '')}`;
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
  extra: { max: 5, statement_timeout: 12000 },
});

const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = 'isolated-password-audit-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities,
  synchronize: false,
  extra: { max: 5, statement_timeout: 12000 },
});

const userId = randomUUID();
const otherUserId = randomUUID();
const workspaceId = randomUUID();
const secondWorkspaceId = randomUUID();
const userWorkspaceId = randomUUID();
const secondUserWorkspaceId = randomUUID();
const initiatorUserWorkspaceId = randomUUID();

const jwtSecret = 'isolated-password-audit-jwt-secret-not-production';
const jwt = {
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

const config = {
  get: (key: string) => {
    if (key === 'REFRESH_TOKEN_REUSE_GRACE_PERIOD') return '1m';
    if (key === 'REFRESH_TOKEN_EXPIRES_IN') return '1h';
    if (key === 'PASSWORD_RESET_TOKEN_EXPIRES_IN') return '15m';
    if (key === 'EMAIL_FROM_NAME') return 'Twenty';
    if (key === 'EMAIL_FROM_ADDRESS') return 'noreply@example.test';
    return '7d';
  },
};

const makeHarness = () => {
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const emailSend = jest.fn().mockResolvedValue(undefined);
  const sessionCache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    mdel: jest.fn(),
  };
  const cookieClear = jest.fn();
  const cookieService = {
    extractSessionTokenFromRequest: jest.fn(
      (req: Request) =>
        (req as Request & { sessionToken?: string }).sessionToken,
    ),
    attachSessionTokenToResponse: jest.fn(),
    clearSessionCookie: cookieClear,
    hasSessionCookie: jest.fn(() => true),
  } as unknown as UserSessionCookieService;

  const refreshTokenService = new RefreshTokenService(
    jwt as never,
    config as never,
    runtime.getRepository(AppTokenEntity),
    runtime.getRepository(UserEntity),
  );
  const userSessionService = new UserSessionService(
    runtime.getRepository(UserSessionEntity),
    runtime.getRepository(AppTokenEntity),
    sessionCache as never,
    config as never,
    jwt as never,
    {
      createContext: jest.fn().mockReturnValue({
        insertWorkspaceEvent: jest.fn(),
      }),
    } as never,
    cookieService as never,
  );
  const accessTokenService = {
    generateAccessToken: jest.fn(async () => ({
      token: 'synthetic-access-token',
      expiresAt: new Date(Date.now() + 3600000),
    })),
  };
  const renewTokenService = new RenewTokenService(
    accessTokenService as never,
    {} as never,
    refreshTokenService,
  );

  const userService = {
    findUserByEmail: async (email: string) =>
      runtime.getRepository(UserEntity).findOneBy({ email }),
    findUserByIdOrThrow: async (id: string, err?: Error) => {
      const row = await runtime.getRepository(UserEntity).findOneBy({ id });
      if (!row) {
        throw (
          err ??
          new AuthException('User not found', AuthExceptionCode.USER_NOT_FOUND)
        );
      }
      return row;
    },
    coreEntityCacheService: { invalidate: cacheInvalidate },
  };

  const resetPasswordService = new ResetPasswordService(
    config as never,
    {
      buildWorkspaceURL: () => new URL('https://workspace.example.test/reset'),
    } as never,
    runtime.getRepository(WorkspaceEntity),
    runtime.getRepository(AppTokenEntity),
    { send: emailSend } as never,
    { getI18nInstance: () => ({ _: () => 'Reset Subject' }) } as never,
    userService as never,
  );

  const authService = new AuthService(
    accessTokenService as never,
    {} as never,
    {} as never,
    {
      getBaseUrl: () => new URL('https://app.example.test'),
    } as never,
    refreshTokenService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    userService as never,
    {} as never,
    {} as never,
    runtime.getRepository(WorkspaceEntity),
    runtime.getRepository(UserEntity),
    config as never,
    { send: emailSend } as never,
    runtime.getRepository(AppTokenEntity),
    { getI18nInstance: () => ({ _: () => 'Password Changed' }) } as never,
    {
      createContext: jest.fn().mockReturnValue({
        insertWorkspaceEvent: jest.fn(),
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    userSessionService,
    { invalidate: cacheInvalidate } as never,
    runtime,
  );

  const userSessionResolver = new UserSessionResolver(
    userSessionService,
    cookieService,
  );

  const updatePasswordViaResetToken = async (
    passwordResetToken: string,
    newPassword: string,
  ) => {
    const { id } =
      await resetPasswordService.validatePasswordResetToken(passwordResetToken);
    await authService.updatePassword(id, newPassword);
    return await resetPasswordService.invalidatePasswordResetToken(id);
  };

  return {
    authService,
    resetPasswordService,
    refreshTokenService,
    renewTokenService,
    userSessionService,
    userSessionResolver,
    cacheInvalidate,
    emailSend,
    sessionCache,
    cookieClear,
    updatePasswordViaResetToken,
  };
};

const createRefreshToken = async (
  overrides: Partial<AppTokenEntity> = {},
  claims: Record<string, unknown> = {},
) => {
  const row = await owner.getRepository(AppTokenEntity).save({
    userId,
    workspaceId,
    type: AppTokenType.RefreshToken,
    value: 'secret-refresh-token-value',
    expiresAt: new Date(Date.now() + 3600000),
    context: { email: 'private@example.test' },
    ...overrides,
  });
  return {
    row,
    token: sign(
      {
        sub: row.userId ?? userId,
        userId: row.userId ?? userId,
        workspaceId: row.workspaceId ?? undefined,
        type: JwtTokenTypeEnum.REFRESH,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
        ...claims,
      },
      jwtSecret,
      { jwtid: row.id, expiresIn: '1h' },
    ),
  };
};

const audits = () =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, id ASC',
  );
const appTokens = () =>
  owner.getRepository(AppTokenEntity).find({ order: { id: 'ASC' } });
const sessions = () =>
  owner.getRepository(UserSessionEntity).find({ order: { id: 'ASC' } });
const userRow = async (id = userId) =>
  (await owner.query('SELECT * FROM core."user" WHERE id = $1', [id]))[0];

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
    CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-password-audit-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core, crm_audit TO "${role}";
    GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}";
    GRANT INSERT, UPDATE ON core."appToken", core."userSession", core."user", core."userWorkspace" TO "${role}";
    GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}";
  `);
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  jwt.verifyJwtToken.mockClear();
  clearPendingPasswordResetTokenValidation();
  await owner.query(`
    DROP TRIGGER IF EXISTS fail_password_audit ON crm_audit."crmAuditEntry";
    DROP FUNCTION IF EXISTS crm_audit.fail_password_audit();
    DROP TRIGGER IF EXISTS corrupt_password_user ON core."user";
    DROP FUNCTION IF EXISTS core.corrupt_password_user();
    DROP TRIGGER IF EXISTS corrupt_password_token ON core."appToken";
    DROP FUNCTION IF EXISTS core.corrupt_password_token();
    TRUNCATE core."appToken", core."userSession", core."userWorkspace", core."user", core.workspace, crm_audit."crmAuditEntry" CASCADE;
  `);
  await owner.query(
    `INSERT INTO core.workspace (id, "isPasswordAuthEnabled", "deletedAt")
     VALUES ($1, true, NULL), ($2, true, NULL)`,
    [workspaceId, secondWorkspaceId],
  );
  await owner.query(
    `INSERT INTO core."user" (id, email, "firstName", "lastName", "passwordHash", "deletedAt")
     VALUES ($1, 'private@example.test', 'Alice', 'Admin', 'initial-password-hash', NULL),
            ($2, 'initiator@example.test', 'Bob', 'Support', 'other-password-hash', NULL)`,
    [userId, otherUserId],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId", locale, "deletedAt")
     VALUES ($1, $2, $3, 'en', NULL),
            ($4, $2, $5, 'fr-FR', NULL),
            ($6, $7, $3, 'en', NULL)`,
    [
      userWorkspaceId,
      userId,
      workspaceId,
      secondUserWorkspaceId,
      secondWorkspaceId,
      initiatorUserWorkspaceId,
      otherUserId,
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

describe('LOG171 password update and refresh token security revocation audit', () => {
  it('atomically updates passwordHash, revokes active and grace-rotated refresh tokens across workspaces with PASSWORD_CHANGED audit, preserves prior security revocations, and revokes sessions', async () => {
    const harness = makeHarness();
    const activeTokenWs1 = await createRefreshToken({ workspaceId });
    const graceRotatedAt = new Date(Date.now() - 5000);
    const graceTokenWs2 = await createRefreshToken({
      workspaceId: secondWorkspaceId,
      revokedAt: graceRotatedAt,
      deletedAt: new Date(Date.now() - 10000),
      context: { email: 'private@example.test' },
    });
    const priorSecurityAt = new Date(Date.now() - 20000);
    const alreadyRevokedToken = await createRefreshToken({
      workspaceId,
      revokedAt: priorSecurityAt,
      context: {
        email: 'private@example.test',
        revokedReason: UserSessionRevokedReason.UserSignOut,
      },
    });
    const agnosticToken = await createRefreshToken({ workspaceId: null });
    const otherUserToken = await createRefreshToken({
      userId: otherUserId,
      workspaceId,
    });

    const createdSession = await harness.userSessionService.createSession({
      userId,
      workspaceId,
      userWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
      userAgent: 'test-agent',
      ipAddress: '192.0.2.10',
    });
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    const result = await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: userId },
        impersonationContext: {
          impersonatorUserWorkspaceId: initiatorUserWorkspaceId,
        },
      }),
      () =>
        harness.authService.updatePassword(userId, 'StrongPass!2026', {
          auditIdentity: {
            actor: { kind: 'coreUser', id: userId },
            impersonatorUserWorkspaceId: initiatorUserWorkspaceId,
            correlationId: 'corr-password-update-171',
          },
        }),
    );

    expect(result).toEqual({ success: true });

    const updatedUser = await userRow();
    expect(updatedUser.passwordHash).not.toBe('initial-password-hash');
    expect(await compareHash('StrongPass!2026', updatedUser.passwordHash)).toBe(
      true,
    );
    expect(harness.cacheInvalidate).toHaveBeenCalledWith('user', userId);
    expect(harness.emailSend).toHaveBeenCalledTimes(1);

    const tokenRows = await appTokens();
    const byId = new Map(tokenRows.map((row) => [row.id, row]));

    expect(byId.get(activeTokenWs1.row.id)?.revokedAt).not.toBeNull();
    expect(byId.get(activeTokenWs1.row.id)?.context).toEqual({
      email: 'private@example.test',
      revokedReason: UserSessionRevokedReason.PasswordChanged,
    });

    expect(byId.get(graceTokenWs2.row.id)?.revokedAt?.toISOString()).toBe(
      graceRotatedAt.toISOString(),
    );
    expect(byId.get(graceTokenWs2.row.id)?.context).toEqual({
      email: 'private@example.test',
      revokedReason: UserSessionRevokedReason.PasswordChanged,
    });

    expect(byId.get(alreadyRevokedToken.row.id)?.revokedAt?.toISOString()).toBe(
      priorSecurityAt.toISOString(),
    );
    expect(byId.get(alreadyRevokedToken.row.id)?.context).toEqual({
      email: 'private@example.test',
      revokedReason: UserSessionRevokedReason.UserSignOut,
    });

    expect(byId.get(agnosticToken.row.id)?.revokedAt).not.toBeNull();
    expect(byId.get(agnosticToken.row.id)?.context).toEqual({
      email: 'private@example.test',
      revokedReason: UserSessionRevokedReason.PasswordChanged,
    });

    expect(byId.get(otherUserToken.row.id)?.revokedAt).toBeNull();
    expect(
      byId.get(otherUserToken.row.id)?.context?.revokedReason,
    ).toBeUndefined();

    const sessionRows = await sessions();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].id).toBe(createdSession.session.id);
    expect(sessionRows[0].revokedAt).not.toBeNull();
    expect(sessionRows[0].revokedReason).toBe(
      UserSessionRevokedReason.PasswordChanged,
    );

    const entries = await audits();
    const refreshEntries = entries.filter(
      (entry: { resourceKind: string }) =>
        entry.resourceKind === 'refreshToken',
    );
    const sessionEntries = entries.filter(
      (entry: { resourceKind: string }) => entry.resourceKind === 'userSession',
    );
    expect(refreshEntries).toHaveLength(2);
    expect(sessionEntries).toHaveLength(1);

    const ws1Entry = refreshEntries.find(
      (entry: { resourceId: string }) =>
        entry.resourceId === activeTokenWs1.row.id,
    );
    const ws2Entry = refreshEntries.find(
      (entry: { resourceId: string }) =>
        entry.resourceId === graceTokenWs2.row.id,
    );

    expect(ws1Entry).toMatchObject({
      workspaceId,
      resourceKind: 'refreshToken',
      resourceId: activeTokenWs1.row.id,
      action: 'update',
      outcome: 'success',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: otherUserId },
      correlationId: 'corr-password-update-171',
      securityDescriptor: {
        resourceKind: 'refreshToken',
        resourceId: activeTokenWs1.row.id,
        tokenOwner: {
          userId,
          access: 'currentWorkspaceAdministration',
        },
      },
      redactedDiff: {
        changedFields: ['revokedAt', 'revokedReason'],
        values: {
          revokedReason: {
            before: null,
            after: UserSessionRevokedReason.PasswordChanged,
          },
        },
      },
    });

    expect(ws2Entry).toMatchObject({
      workspaceId: secondWorkspaceId,
      resourceKind: 'refreshToken',
      resourceId: graceTokenWs2.row.id,
      action: 'update',
      outcome: 'success',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: otherUserId },
      correlationId: 'corr-password-update-171',
      securityDescriptor: {
        resourceKind: 'refreshToken',
        resourceId: graceTokenWs2.row.id,
        tokenOwner: {
          userId,
          access: 'currentWorkspaceAdministration',
        },
      },
      redactedDiff: {
        changedFields: ['revokedReason'],
        values: {
          revokedReason: {
            before: null,
            after: UserSessionRevokedReason.PasswordChanged,
          },
        },
      },
    });
    expect(sessionEntries[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userSession',
      resourceId: createdSession.session.id,
      action: 'update',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: otherUserId },
    });

    const serializedEntries = JSON.stringify(entries);
    for (const secret of [
      'StrongPass!2026',
      updatedUser.passwordHash,
      'initial-password-hash',
      'secret-refresh-token-value',
      'private@example.test',
      activeTokenWs1.token,
      graceTokenWs2.token,
    ]) {
      expect(serializedEntries).not.toContain(secret);
    }
  });

  it('immediately blocks renewing both rotated grace tokens and newly issued tokens after updatePassword', async () => {
    const harness = makeHarness();
    const { token: initialToken } = await createRefreshToken();
    const rotated =
      await harness.renewTokenService.generateTokensFromRefreshToken(
        initialToken,
      );

    await harness.authService.updatePassword(userId, 'NewValidPass!99');

    await expect(
      harness.refreshTokenService.verifyRefreshToken(initialToken),
    ).rejects.toThrow('This refresh token has been revoked.');
    await expect(
      harness.refreshTokenService.verifyRefreshToken(
        rotated.refreshToken.token,
      ),
    ).rejects.toThrow('This refresh token has been revoked.');
    await expect(
      harness.renewTokenService.generateTokensFromRefreshToken(initialToken),
    ).rejects.toThrow('This refresh token has been revoked.');
    await expect(
      harness.renewTokenService.generateTokensFromRefreshToken(
        rotated.refreshToken.token,
      ),
    ).rejects.toThrow('This refresh token has been revoked.');
  });

  it('atomically consumes the password reset token inside the password-update transaction and prevents concurrent or repeated reuse', async () => {
    const harness = makeHarness();
    const { token: activeRefresh } = await createRefreshToken();
    const generated =
      await harness.resetPasswordService.generatePasswordResetToken(
        'private@example.test',
        workspaceId,
      );
    expect(generated.status).toBe('TOKEN_GENERATED');
    if (generated.status !== 'TOKEN_GENERATED') {
      throw new Error('Expected TOKEN_GENERATED');
    }

    await harness.resetPasswordService.rotatePasswordResetToken({
      userId,
      resetToken: generated.resetToken,
    });

    const plainResetToken = generated.resetToken.passwordResetToken;
    const validated =
      await harness.resetPasswordService.validatePasswordResetToken(
        plainResetToken,
      );
    expect(validated).toEqual({
      id: userId,
      email: 'private@example.test',
      hasPassword: true,
    });

    const outcomes = await Promise.allSettled([
      harness.updatePasswordViaResetToken(plainResetToken, 'ResetWinner!123'),
      harness.updatePasswordViaResetToken(plainResetToken, 'ResetLoser!456'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    await expect(
      harness.resetPasswordService.validatePasswordResetToken(plainResetToken),
    ).rejects.toThrow('Token is invalid');
    await expect(
      harness.authService.updatePassword(userId, 'AnotherPass!789', {
        passwordResetToken: plainResetToken,
      }),
    ).rejects.toThrow('Token is invalid');

    await expect(
      harness.refreshTokenService.verifyRefreshToken(activeRefresh),
    ).rejects.toThrow('This refresh token has been revoked.');

    const resetRows = (await appTokens()).filter(
      (row) => row.type === AppTokenType.PasswordResetToken,
    );
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0].revokedAt).not.toBeNull();
  });

  it('serializes concurrent rotateRefreshToken and generateRefreshToken with updatePassword under acquireUserAuthenticationLock', async () => {
    const harness = makeHarness();
    const { token: initialToken } = await createRefreshToken();

    const outcomes = await Promise.allSettled([
      harness.renewTokenService.generateTokensFromRefreshToken(initialToken),
      harness.authService.updatePassword(userId, 'ConcurrentPass!2026'),
      harness.refreshTokenService.generateRefreshToken({
        userId,
        workspaceId,
        targetedTokenType: JwtTokenTypeEnum.ACCESS,
      }),
    ]);

    expect(outcomes[1]).toEqual({
      status: 'fulfilled',
      value: { success: true },
    });

    if (outcomes[0].status === 'fulfilled') {
      const rotatedAfterOrBefore = outcomes[0].value.refreshToken.token;
      const decodedRotated = decode(rotatedAfterOrBefore) as { jti: string };
      const dbRow = (await appTokens()).find(
        (row) => row.id === decodedRotated.jti,
      );
      expect(dbRow).toBeDefined();
    }

    await expect(
      harness.refreshTokenService.verifyRefreshToken(initialToken),
    ).rejects.toThrow('This refresh token has been revoked.');
  });

  it('rolls back passwordHash, refresh tokens, and reset tokens on audit failure, trigger corruption, weak password, or deactivated user', async () => {
    const harness = makeHarness();
    const { row: refreshRow } = await createRefreshToken();
    const plainReset = crypto.randomBytes(32).toString('hex');
    const hashedReset = crypto
      .createHash('sha256')
      .update(plainReset)
      .digest('hex');
    await owner.getRepository(AppTokenEntity).save({
      userId,
      workspaceId,
      type: AppTokenType.PasswordResetToken,
      value: hashedReset,
      expiresAt: new Date(Date.now() + 600000),
    });

    await expect(
      harness.authService.updatePassword(userId, 'weak'),
    ).rejects.toThrow('Password is too weak');
    expect((await userRow()).passwordHash).toBe('initial-password-hash');

    await expect(
      harness.authService.updatePassword(randomUUID(), 'weak'),
    ).rejects.toThrow('User not found');

    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${role}"`,
    );
    try {
      await expect(
        harness.authService.updatePassword(userId, 'ValidAuditFail!123', {
          passwordResetToken: plainReset,
        }),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
      );
    }

    expect((await userRow()).passwordHash).toBe('initial-password-hash');
    expect(
      (await appTokens()).find((row) => row.id === refreshRow.id)?.revokedAt,
    ).toBeNull();
    expect(
      (await appTokens()).find(
        (row) => row.type === AppTokenType.PasswordResetToken,
      )?.revokedAt,
    ).toBeNull();
    expect(await audits()).toHaveLength(0);
    expect(harness.emailSend).not.toHaveBeenCalled();

    await owner.query(`
      CREATE FUNCTION core.corrupt_password_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.email = 'tampered@example.test';
        RETURN NEW;
      END $$;
      CREATE TRIGGER corrupt_password_user BEFORE UPDATE ON core."user"
        FOR EACH ROW EXECUTE FUNCTION core.corrupt_password_user();
    `);
    await expect(
      harness.authService.updatePassword(userId, 'ValidTriggerFail!123'),
    ).rejects.toThrow('Password update user effects mismatch');
    await owner.query(
      'DROP TRIGGER corrupt_password_user ON core."user"; DROP FUNCTION core.corrupt_password_user();',
    );
    expect((await userRow()).passwordHash).toBe('initial-password-hash');
    expect((await userRow()).email).toBe('private@example.test');
    expect(await audits()).toHaveLength(0);

    await owner.query(
      'UPDATE core."user" SET "deletedAt" = now() WHERE id = $1',
      [userId],
    );
    await expect(
      harness.authService.updatePassword(userId, 'ValidDeletedUser!123'),
    ).rejects.toThrow('User not found');
    await expect(
      harness.resetPasswordService.validatePasswordResetToken(plainReset),
    ).rejects.toThrow('User not found');
  });

  it('classifies lost COMMIT ACK as NativeTransactionOutcomeUnknownError with cache eviction and best-effort session revocation, and propagates impersonation initiator through UserSessionResolver', async () => {
    const harness = makeHarness();
    await createRefreshToken();
    const session1 = await harness.userSessionService.createSession({
      userId,
      workspaceId,
      userWorkspaceId,
      authProvider: AuthProviderEnum.Impersonation,
      isImpersonating: true,
      impersonatorUserWorkspaceId: initiatorUserWorkspaceId,
      impersonatedUserWorkspaceId: userWorkspaceId,
      origin: 'sign_in',
      userAgent: 'impersonated-agent-1',
      ipAddress: '192.0.2.21',
    });
    const session2 = await harness.userSessionService.createSession({
      userId,
      workspaceId,
      userWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
      userAgent: 'regular-agent-2',
      ipAddress: '192.0.2.22',
    });
    const session3 = await harness.userSessionService.createSession({
      userId,
      workspaceId,
      userWorkspaceId,
      authProvider: AuthProviderEnum.Password,
      origin: 'sign_in',
      userAgent: 'regular-agent-3',
      ipAddress: '192.0.2.23',
    });
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    const reqWithImpersonation = {
      sessionToken: session1.sessionToken,
      impersonationContext: {
        impersonatorUserWorkspaceId: initiatorUserWorkspaceId,
      },
      res: {},
    } as unknown as Request;

    const singleRevoked = await harness.userSessionResolver.revokeUserSession(
      { id: userId } as never,
      { id: workspaceId } as never,
      session2.session.id,
      { req: reqWithImpersonation },
    );
    expect(singleRevoked).toBe(true);

    const otherRevokedCount =
      await harness.userSessionResolver.revokeAllOtherUserSessions(
        { id: userId } as never,
        { id: workspaceId } as never,
        { req: reqWithImpersonation },
      );
    expect(otherRevokedCount).toBe(1);

    const resolverAuditRows = await audits();
    expect(resolverAuditRows).toHaveLength(2);
    for (const row of resolverAuditRows) {
      expect(row).toMatchObject({
        workspaceId,
        resourceKind: 'userSession',
        action: 'update',
        actor: { kind: 'coreUser', id: userId },
        initiator: { kind: 'coreUser', id: otherUserId },
      });
    }
    expect(
      resolverAuditRows
        .map((row: { resourceId: string }) => row.resourceId)
        .sort(),
    ).toEqual([session2.session.id, session3.session.id].sort());

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    harness.cacheInvalidate.mockClear();
    harness.emailSend.mockClear();

    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    let lostAckInjected = false;
    jest
      .spyOn(runtime, 'createQueryRunner')
      .mockImplementation((mode?: 'master' | 'slave') => {
        const runner = originalCreateQueryRunner(mode);
        const originalConnect = runner.connect.bind(runner);
        let wrapped = false;
        jest.spyOn(runner, 'connect').mockImplementation(async () => {
          const client = await originalConnect();
          if (!wrapped && !lostAckInjected) {
            wrapped = true;
            lostAckInjected = true;
            const originalQuery = client.query.bind(client);
            client.query = async (sql: string, ...args: unknown[]) => {
              const res = await originalQuery(sql, ...args);
              if (sql === 'COMMIT') {
                throw new Error('simulated lost COMMIT acknowledgement');
              }
              return res;
            };
          }
          return client;
        });
        return runner;
      });

    await expect(
      harness.authService.updatePassword(userId, 'LostAckPassword!2026'),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    jest.restoreAllMocks();

    expect(harness.cacheInvalidate).toHaveBeenCalledWith('user', userId);
    expect(harness.emailSend).not.toHaveBeenCalled();
    expect(
      await compareHash('LostAckPassword!2026', (await userRow()).passwordHash),
    ).toBe(true);
    const remainingSession1 = (await sessions()).find(
      (s) => s.id === session1.session.id,
    );
    expect(remainingSession1?.revokedAt).not.toBeNull();
    expect(remainingSession1?.revokedReason).toBe(
      UserSessionRevokedReason.PasswordChanged,
    );
    expect(hashUserSessionToken(session1.sessionToken)).toBe(
      remainingSession1?.tokenHash,
    );
  });
});
