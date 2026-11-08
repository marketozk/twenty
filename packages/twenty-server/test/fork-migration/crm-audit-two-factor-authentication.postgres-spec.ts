import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { TwoFactorAuthenticationStrategy } from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { OTPStatus } from 'src/engine/core-modules/two-factor-authentication/strategies/otp/otp.constants';
import { TwoFactorAuthenticationExceptionCode } from 'src/engine/core-modules/two-factor-authentication/two-factor-authentication.exception';
import { hashTwoFactorAuthenticationRecoveryCode } from 'src/engine/core-modules/two-factor-authentication/utils/hash-two-factor-authentication-recovery-code.util';
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
jest.mock('twenty-emails', () => ({
  TwoFactorAuthenticationRecoveryCodeIssuedEmail: jest.fn(() => 'issued-email'),
  TwoFactorAuthenticationResetEmail: jest.fn(() => 'reset-email'),
  renderEmail: jest.fn(async () => 'rendered-email'),
}));
for (const [modPath, names] of [
  [
    'src/engine/core-modules/app-token/app-token.entity',
    ['AppTokenEntity', 'AppTokenType'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/entities/two-factor-authentication-method.entity',
    ['TwoFactorAuthenticationMethodEntity'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.service',
    ['UserWorkspaceService'],
  ],
  ['src/engine/core-modules/user/user.entity', ['UserEntity']],
  ['src/engine/core-modules/user/services/user.service', ['UserService']],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/core-modules/secret-encryption/secret-encryption.service',
    ['SecretEncryptionService'],
  ],
  ['src/engine/core-modules/throttler/throttler.service', ['ThrottlerService']],
  [
    'src/engine/core-modules/throttler/filters/throttler-graphql-api-exception.filter',
    ['ThrottlerGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/auth/token/services/login-token.service',
    ['LoginTokenService'],
  ],
  [
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  [
    'src/engine/core-modules/user-session/services/user-session.service',
    ['UserSessionService'],
  ],
  ['src/engine/core-modules/email/email.service', ['EmailService']],
  ['src/engine/core-modules/i18n/i18n.service', ['I18nService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/two-factor-authentication-exception.filter',
    ['TwoFactorAuthenticationExceptionFilter'],
  ],
  ['src/engine/guards/custom-permission.guard', ['CustomPermissionGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  ['src/engine/guards/public-endpoint.guard', ['PublicEndpointGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { TwoFactorAuthenticationService } =
  require('src/engine/core-modules/two-factor-authentication/two-factor-authentication.service') as typeof import('src/engine/core-modules/two-factor-authentication/two-factor-authentication.service');
const { TwoFactorAuthenticationResolver } =
  require('src/engine/core-modules/two-factor-authentication/two-factor-authentication.resolver') as typeof import('src/engine/core-modules/two-factor-authentication/two-factor-authentication.resolver');
const { TwoFactorAuthenticationRecoveryService } =
  require('src/engine/core-modules/two-factor-authentication/services/two-factor-authentication-recovery.service') as typeof import('src/engine/core-modules/two-factor-authentication/services/two-factor-authentication-recovery.service');

jest.setTimeout(120000);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated fork test database required');
}

const databaseRole = `two_factor_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorMemberId = randomUUID();
const secondUserId = randomUUID();
const secondUserWorkspaceId = randomUUID();
const secondMemberId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-two-factor-audit-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const extractTotpSecretFromUri = (uri: string): string => {
  const parsed = new URL(uri);
  const secret = parsed.searchParams.get('secret');
  if (!secret) {
    throw new Error(`Missing secret in URI: ${uri}`);
  }
  return secret;
};

const buildHarness = () => {
  const secretEncryptionService = {
    encryptVersioned: jest.fn(
      (val: PlaintextString) =>
        `enc:v2:${Buffer.from(String(val)).toString('base64')}` as EncryptedString,
    ),
    decryptVersionedOrThrow: jest.fn(
      (val: EncryptedString) =>
        Buffer.from(String(val).replace(/^enc:v2:/, ''), 'base64').toString(
          'utf8',
        ) as PlaintextString,
    ),
  };

  const throttlerService = {
    tokenBucketThrottleOrThrow: jest.fn(async () => {}),
  };

  const twoFactorAuthenticationMethodRepository = {
    findOne: jest.fn(
      async (
        wsId: string,
        opts: {
          where: {
            id?: string;
            strategy?: string;
            userWorkspace?: {
              id?: string;
              userId?: string;
              workspaceId?: string;
            };
          };
        },
      ) => {
        if (opts.where.id) {
          const rows = await owner.query(
            'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE id = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
            [opts.where.id, wsId],
          );
          if (!rows[0]) return null;
          const uwRows = await owner.query(
            'SELECT * FROM core."userWorkspace" WHERE id = $1',
            [rows[0].userWorkspaceId],
          );
          return { ...rows[0], userWorkspace: uwRows[0] ?? null };
        }
        if (opts.where.userWorkspace?.id) {
          const rows = await owner.query(
            'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "workspaceId" = $1 AND "userWorkspaceId" = $2 AND strategy = $3 AND "deletedAt" IS NULL',
            [wsId, opts.where.userWorkspace.id, opts.where.strategy],
          );
          return rows[0] ?? null;
        }
        const uwRows = await owner.query(
          'SELECT * FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
          [opts.where.userWorkspace?.userId, wsId],
        );
        if (!uwRows[0]) return null;
        const rows = await owner.query(
          'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "workspaceId" = $1 AND "userWorkspaceId" = $2 AND strategy = $3 AND "deletedAt" IS NULL',
          [wsId, uwRows[0].id, opts.where.strategy],
        );
        return rows[0] ? { ...rows[0], userWorkspace: uwRows[0] } : null;
      },
    ),
    exists: jest.fn(
      async (
        wsId: string,
        opts: {
          where: {
            userWorkspaceId?: string;
            userWorkspace?: { userId?: string };
            status?: string;
          };
        },
      ) => {
        let uwId = opts.where.userWorkspaceId;
        if (!uwId && opts.where.userWorkspace?.userId) {
          const uwRows = await owner.query(
            'SELECT id FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
            [opts.where.userWorkspace.userId, wsId],
          );
          uwId = uwRows[0]?.id;
        }
        if (!uwId) return false;
        const rows = await owner.query(
          'SELECT 1 FROM core."twoFactorAuthenticationMethod" WHERE "workspaceId" = $1 AND "userWorkspaceId" = $2 AND status = $3 AND "deletedAt" IS NULL LIMIT 1',
          [wsId, uwId, opts.where.status ?? OTPStatus.VERIFIED],
        );
        return rows.length > 0;
      },
    ),
  };

  const appTokenRepository = {
    manager: { connection: runtime },
    exists: jest.fn(
      async (opts: { where: { userId: string; workspaceId: string } }) => {
        const rows = await owner.query(
          `SELECT 1 FROM core."appToken"
            WHERE "userId" = $1
              AND "workspaceId" = $2
              AND type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE'
              AND "deletedAt" IS NOT NULL
              AND "revokedAt" IS NULL
            LIMIT 1`,
          [opts.where.userId, opts.where.workspaceId],
        );
        return rows.length > 0;
      },
    ),
  };

  const userWorkspaceService = {
    getUserWorkspaceForUserOrThrow: jest.fn(
      async ({
        userId,
        workspaceId: wsId,
      }: {
        userId: string;
        workspaceId: string;
      }) => {
        const rows = await owner.query(
          'SELECT * FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
          [userId, wsId],
        );
        if (!rows[0]) {
          throw new Error('UserWorkspace not found');
        }
        return rows[0];
      },
    ),
    getUserWorkspaceForUser: jest.fn(
      async ({
        userId,
        workspaceId: wsId,
      }: {
        userId: string;
        workspaceId: string;
      }) => {
        const rows = await owner.query(
          'SELECT * FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
          [userId, wsId],
        );
        if (!rows[0]) return null;
        return {
          ...rows[0],
          locale: 'en',
          user: {
            id: userId,
            email:
              userId === actorUserId
                ? 'actor@example.com'
                : 'second@example.com',
            canImpersonate: false,
            canAccessFullAdminPanel: false,
          },
          workspace: {
            id: wsId,
            displayName: 'Test Workspace',
          },
        };
      },
    ),
  };

  const twoFactorAuthenticationService = new TwoFactorAuthenticationService(
    twoFactorAuthenticationMethodRepository as never,
    appTokenRepository as never,
    userWorkspaceService as never,
    secretEncryptionService as never,
    throttlerService as never,
    runtime,
  );

  const userSessionService = {
    revokeAllSessionsForUser: jest.fn(async () => 1),
  };
  const emailService = {
    send: jest.fn(async () => {}),
  };
  const i18nService = {
    getI18nInstance: jest.fn(() => ({
      _: (msgDesc: { message?: string }) => msgDesc?.message ?? 'subject',
    })),
  };
  const twentyConfigService = {
    get: jest.fn((key: string) =>
      key === 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE_EXPIRES_IN'
        ? '1h'
        : 'noreply@example.com',
    ),
  };

  const twoFactorAuthenticationRecoveryService =
    new TwoFactorAuthenticationRecoveryService(
      twoFactorAuthenticationMethodRepository as never,
      appTokenRepository as never,
      twoFactorAuthenticationService,
      userWorkspaceService as never,
      userSessionService as never,
      throttlerService as never,
      emailService as never,
      i18nService as never,
      twentyConfigService as never,
      runtime,
    );

  const loginTokenService = {
    verifyLoginToken: jest.fn(async () => ({
      sub: 'actor@example.com',
      workspaceId,
    })),
  };
  const userService = {
    findUserByEmailOrThrow: jest.fn(async () => ({
      id: actorUserId,
      email: 'actor@example.com',
    })),
  };
  const workspaceDomainsService = {
    getWorkspaceByOriginOrDefaultWorkspace: jest.fn(async () => ({
      id: workspaceId,
      displayName: 'Test Workspace',
    })),
  };

  const twoFactorAuthenticationResolver = new TwoFactorAuthenticationResolver(
    twoFactorAuthenticationService,
    twoFactorAuthenticationRecoveryService,
    loginTokenService as never,
    userService as never,
    workspaceDomainsService as never,
    twoFactorAuthenticationMethodRepository as never,
  );

  return {
    twoFactorAuthenticationService,
    twoFactorAuthenticationRecoveryService,
    twoFactorAuthenticationResolver,
    userSessionService,
    emailService,
    secretEncryptionService,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    `DROP SCHEMA IF EXISTS core CASCADE;
     DROP SCHEMA IF EXISTS crm_audit CASCADE;
     DROP SCHEMA IF EXISTS "workspace_${workspaceId}" CASCADE;
     CREATE SCHEMA core;
     CREATE SCHEMA "workspace_${workspaceId}";`,
  );
  await owner.query(
    `CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "activationStatus" text NOT NULL,
      "defaultRoleId" uuid NULL,
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "userId" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."twoFactorAuthenticationMethod" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "userWorkspaceId" uuid NOT NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
      secret text NOT NULL CHECK (secret LIKE 'enc:v2:%'),
      status text NOT NULL,
      strategy text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL,
      UNIQUE ("userWorkspaceId", strategy)
    );
    CREATE TABLE core."appToken" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" uuid NOT NULL,
      "workspaceId" uuid NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      type text NOT NULL,
      value text NULL,
      "expiresAt" timestamptz NOT NULL,
      "deletedAt" timestamptz NULL,
      "revokedAt" timestamptz NULL,
      context jsonb NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "workspace_${workspaceId}"."workspaceMember" (
      id uuid PRIMARY KEY,
      "userId" uuid NOT NULL,
      "deletedAt" timestamptz NULL
    );`,
  );

  const runner = owner.createQueryRunner();
  await runner.connect();
  try {
    await new OmniAuditBootstrapFastInstanceCommand().up(runner as QueryRunner);
  } finally {
    await runner.release();
  }

  await owner.query(
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${databaseRole}') THEN
        CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-two-factor-audit-fixture';
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA core, crm_audit, "workspace_${workspaceId}" TO "${databaseRole}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
    GRANT SELECT ON ALL TABLES IN SCHEMA "workspace_${workspaceId}" TO "${databaseRole}";
    GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );

  await runtime.initialize();
});

beforeEach(async () => {
  await owner.query(
    `TRUNCATE TABLE
      crm_audit."crmAuditEntry",
      core."twoFactorAuthenticationMethod",
      core."appToken",
      core."userWorkspace",
      core.workspace,
      "workspace_${workspaceId}"."workspaceMember"
      RESTART IDENTITY CASCADE`,
  );
  await owner.query(
    `INSERT INTO core.workspace (id, "activationStatus")
     VALUES ($1, $2), ($3, $2)`,
    [workspaceId, WorkspaceActivationStatus.ACTIVE, foreignWorkspaceId],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "createdAt")
     VALUES
      ($1, $2, $3, '2026-01-01T00:00:00.000Z'),
      ($4, $2, $5, '2026-01-01T00:00:00.000Z'),
      ($6, $2, $7, '2026-01-01T00:00:00.000Z')`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      secondUserWorkspaceId,
      secondUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await owner.query(
    `INSERT INTO "workspace_${workspaceId}"."workspaceMember" (id, "userId")
     VALUES ($1, $2), ($3, $4)`,
    [actorMemberId, actorUserId, secondMemberId, secondUserId],
  );
});

afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      `DROP SCHEMA IF EXISTS core CASCADE;
       DROP SCHEMA IF EXISTS crm_audit CASCADE;
       DROP SCHEMA IF EXISTS "workspace_${workspaceId}" CASCADE;`,
    );
    await owner.destroy();
  }
});

describe('TwoFactorAuthenticationMethod lifecycle & recovery-code CRM audit (LOG168)', () => {
  it('audits twoFactorAuthenticationMethod create, 1-hour window reuse without audit noise, expired PENDING secret rotation update, and already-provisioned rejection', async () => {
    const { twoFactorAuthenticationResolver, twoFactorAuthenticationService } =
      buildHarness();

    const firstProvision =
      await twoFactorAuthenticationResolver.initiateOTPProvisioning(
        { loginToken: 'login-token-1' },
        'https://app.twenty.com',
      );
    const firstSecret = extractTotpSecretFromUri(firstProvision.uri);

    const methodsAfterCreate: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );
    expect(methodsAfterCreate).toHaveLength(1);
    expect(methodsAfterCreate[0]).toMatchObject({
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      status: OTPStatus.PENDING,
      strategy: TwoFactorAuthenticationStrategy.TOTP,
    });

    const entriesAfterCreate = await audits();
    expect(entriesAfterCreate).toHaveLength(1);
    expect(entriesAfterCreate[0]).toMatchObject({
      workspaceId,
      resourceKind: 'twoFactorAuthenticationMethod',
      resourceId: methodsAfterCreate[0].id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      outcome: 'success',
    });
    const createDiff = entriesAfterCreate[0].redactedDiff as {
      changedFields: string[];
      values: Record<string, unknown>;
    };
    expect(createDiff.changedFields).toEqual(
      expect.arrayContaining([
        'userWorkspaceId',
        'strategy',
        'status',
        'secret',
      ]),
    );
    expect(createDiff.values).toEqual({
      userWorkspaceId: { before: null, after: actorUserWorkspaceId },
      strategy: { before: null, after: TwoFactorAuthenticationStrategy.TOTP },
      status: { before: null, after: OTPStatus.PENDING },
    });
    expect(JSON.stringify(entriesAfterCreate[0])).not.toContain(firstSecret);
    expect(JSON.stringify(entriesAfterCreate[0])).not.toContain('enc:v2:');

    const secondProvision =
      await twoFactorAuthenticationResolver.initiateOTPProvisioningForAuthenticatedUser(
        { id: actorUserId, email: 'actor@example.com' } as never,
        { id: workspaceId, displayName: 'Test Workspace' } as never,
      );
    expect(extractTotpSecretFromUri(secondProvision.uri)).toBe(firstSecret);
    expect(await audits()).toHaveLength(1);

    await owner.query(
      `UPDATE core."twoFactorAuthenticationMethod"
          SET "createdAt" = now() - interval '2 hours'
        WHERE id = $1`,
      [methodsAfterCreate[0].id],
    );

    const rotatedUri =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const rotatedSecret = extractTotpSecretFromUri(rotatedUri);
    expect(rotatedSecret).not.toBe(firstSecret);

    const entriesAfterRotate = await audits();
    expect(entriesAfterRotate).toHaveLength(2);
    expect(entriesAfterRotate[1]).toMatchObject({
      workspaceId,
      resourceKind: 'twoFactorAuthenticationMethod',
      resourceId: methodsAfterCreate[0].id,
      action: 'update',
      actor: { kind: 'coreUser', id: actorUserId },
    });
    const rotateDiff = entriesAfterRotate[1].redactedDiff as {
      changedFields: string[];
      values: Record<string, unknown>;
    };
    expect(rotateDiff.changedFields).toEqual(['secret']);
    expect(JSON.stringify(entriesAfterRotate[1])).not.toContain(rotatedSecret);
    expect(JSON.stringify(entriesAfterRotate[1])).not.toContain('enc:v2:');

    const validOtp = authenticator.generate(rotatedSecret);
    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      validOtp,
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      ),
    ).rejects.toMatchObject({
      code: TwoFactorAuthenticationExceptionCode.TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED,
    });
  });

  it('audits PENDING -> VERIFIED transition on validateStrategy, revokes recovery codes, and suppresses audit noise on subsequent VERIFIED OTP checks (T1)', async () => {
    const { twoFactorAuthenticationResolver, twoFactorAuthenticationService } =
      buildHarness();

    const uri =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const secret = extractTotpSecretFromUri(uri);

    const recoveryTokenId = randomUUID();
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', 'hashed-code', now() + interval '1 hour')`,
      [recoveryTokenId, actorUserId, workspaceId],
    );

    await expect(
      twoFactorAuthenticationResolver.verifyTwoFactorAuthenticationMethodForAuthenticatedUser(
        { otp: '000000' },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
      ),
    ).rejects.toMatchObject({
      code: TwoFactorAuthenticationExceptionCode.INVALID_OTP,
    });
    expect(await audits()).toHaveLength(1);

    const validOtp = authenticator.generate(secret);
    await expect(
      twoFactorAuthenticationResolver.verifyTwoFactorAuthenticationMethodForAuthenticatedUser(
        { otp: validOtp },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
      ),
    ).resolves.toEqual({ success: true });

    const entriesAfterVerify = await audits();
    expect(entriesAfterVerify).toHaveLength(2);
    expect(entriesAfterVerify[1]).toMatchObject({
      workspaceId,
      resourceKind: 'twoFactorAuthenticationMethod',
      action: 'update',
      actor: { kind: 'coreUser', id: actorUserId },
    });
    const verifyDiff = entriesAfterVerify[1].redactedDiff as {
      changedFields: string[];
      values: Record<string, unknown>;
    };
    expect(verifyDiff.changedFields).toEqual(['status']);
    expect(verifyDiff.values).toEqual({
      status: { before: OTPStatus.PENDING, after: OTPStatus.VERIFIED },
    });

    const [revokedRecoveryCode]: Row[] = await owner.query(
      'SELECT * FROM core."appToken" WHERE id = $1',
      [recoveryTokenId],
    );
    expect(revokedRecoveryCode.revokedAt).not.toBeNull();

    const secondRecoveryTokenId = randomUUID();
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', 'hashed-code-2', now() + interval '1 hour')`,
      [secondRecoveryTokenId, actorUserId, workspaceId],
    );

    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(secret),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );

    expect(await audits()).toHaveLength(2);
    const [secondRevokedRecoveryCode]: Row[] = await owner.query(
      'SELECT * FROM core."appToken" WHERE id = $1',
      [secondRecoveryTokenId],
    );
    expect(secondRevokedRecoveryCode.revokedAt).not.toBeNull();
  });

  it('audits twoFactorAuthenticationMethod deletion by owner and rejects missing or foreign-owned methods', async () => {
    const { twoFactorAuthenticationResolver, twoFactorAuthenticationService } =
      buildHarness();

    const uri =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const secret = extractTotpSecretFromUri(uri);
    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(secret),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );

    const [methodRow]: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );

    await expect(
      twoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod(
        { twoFactorAuthenticationMethodId: randomUUID() },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
      ),
    ).rejects.toThrow('Two-factor authentication method not found');

    await expect(
      twoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod(
        { twoFactorAuthenticationMethodId: methodRow.id },
        { id: workspaceId } as never,
        { id: secondUserId } as never,
      ),
    ).rejects.toThrow(
      'You can only delete your own two-factor authentication methods',
    );
    expect(await audits()).toHaveLength(2);

    const deleteRes =
      await twoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod(
        { twoFactorAuthenticationMethodId: methodRow.id },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
      );
    expect(deleteRes).toEqual({ success: true });

    const remainingRows: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE id = $1',
      [methodRow.id],
    );
    expect(remainingRows).toHaveLength(0);

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      workspaceId,
      resourceKind: 'twoFactorAuthenticationMethod',
      resourceId: methodRow.id,
      action: 'delete',
      actor: { kind: 'coreUser', id: actorUserId },
    });
    const deleteDiff = entries[2].redactedDiff as {
      changedFields: string[];
      values: Record<string, unknown>;
    };
    expect(deleteDiff.values).toEqual({
      userWorkspaceId: { before: actorUserWorkspaceId, after: null },
      strategy: { before: TwoFactorAuthenticationStrategy.TOTP, after: null },
      status: { before: OTPStatus.VERIFIED, after: null },
    });
    expect(JSON.stringify(entries[2])).not.toContain(secret);
    expect(JSON.stringify(entries[2])).not.toContain('enc:v2:');
  });

  it('audits recovery-code redemption across optional and enforced 2FA modes, revoking refresh tokens and blocking public re-enrollment while reserved (M2, M3, M4)', async () => {
    const {
      twoFactorAuthenticationService,
      twoFactorAuthenticationRecoveryService,
      userSessionService,
    } = buildHarness();

    const uri1 =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const secret1 = extractTotpSecretFromUri(uri1);
    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(secret1),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );
    const [method1]: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );

    const rawCode1 = 'ABCDE-FGHJK-MNPQR-STVWX';
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', $4, now() + interval '1 hour', '2026-06-01T00:00:00.000Z')`,
      [
        randomUUID(),
        actorUserId,
        workspaceId,
        hashTwoFactorAuthenticationRecoveryCode(rawCode1),
      ],
    );

    const refreshToken1Id = randomUUID();
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'REFRESH_TOKEN', now() + interval '1 day', now())`,
      [refreshToken1Id, actorUserId, workspaceId],
    );

    await expect(
      twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: false,
        },
        recoveryCode: 'WRONG-CODE1-WRONG-CODE2',
      }),
    ).rejects.toMatchObject({
      code: TwoFactorAuthenticationExceptionCode.INVALID_RECOVERY_CODE,
    });
    expect(userSessionService.revokeAllSessionsForUser).not.toHaveBeenCalled();

    const redeemOptional =
      await twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: false,
        },
        recoveryCode: rawCode1,
      });
    expect(redeemOptional).toEqual({ provisioningUri: null });
    expect(userSessionService.revokeAllSessionsForUser).toHaveBeenCalledWith({
      userId: actorUserId,
      workspaceId,
      reason: UserSessionRevokedReason.TwoFactorAuthenticationReset,
    });

    const entriesAfterOptional = await audits();
    expect(entriesAfterOptional).toHaveLength(4);
    const optionalBatch = entriesAfterOptional.slice(2);
    const optionalDeleteEntry = optionalBatch.find(
      (entry) => entry.resourceKind === 'twoFactorAuthenticationMethod',
    )!;
    const optionalRefreshEntry = optionalBatch.find(
      (entry) => entry.resourceKind === 'refreshToken',
    )!;
    expect(optionalDeleteEntry).toMatchObject({
      workspaceId,
      resourceKind: 'twoFactorAuthenticationMethod',
      resourceId: method1.id,
      action: 'delete',
      actor: { kind: 'coreUser', id: actorUserId },
    });
    expect(optionalRefreshEntry).toMatchObject({
      workspaceId,
      resourceKind: 'refreshToken',
      resourceId: refreshToken1Id,
      action: 'update',
      operationId: optionalDeleteEntry.operationId,
      actor: { kind: 'coreUser', id: actorUserId },
    });
    expect(
      (optionalRefreshEntry.redactedDiff as { values: Record<string, unknown> })
        .values,
    ).toEqual({
      revokedReason: {
        before: null,
        after: UserSessionRevokedReason.TwoFactorAuthenticationReset,
      },
    });

    const uri2 =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const secret2 = extractTotpSecretFromUri(uri2);
    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(secret2),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );
    const [method2]: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );

    const rawCode2 = '12345-67890-ABCDE-FGHIJ';
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', $4, now() + interval '1 hour', '2026-06-01T00:00:00.000Z')`,
      [
        randomUUID(),
        actorUserId,
        workspaceId,
        hashTwoFactorAuthenticationRecoveryCode(rawCode2),
      ],
    );
    const refreshToken2Id = randomUUID();
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'REFRESH_TOKEN', now() + interval '1 day', now())`,
      [refreshToken2Id, actorUserId, workspaceId],
    );

    const redeemEnforced =
      await twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: true,
        },
        recoveryCode: rawCode2,
      });
    expect(redeemEnforced.provisioningUri).toEqual(
      expect.stringContaining('otpauth://totp/'),
    );
    const replacementSecret = extractTotpSecretFromUri(
      redeemEnforced.provisioningUri!,
    );

    const [replacementMethod]: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );
    expect(replacementMethod.id).not.toBe(method2.id);
    expect(replacementMethod.status).toBe(OTPStatus.PENDING);

    const entriesAfterEnforced = await audits();
    expect(entriesAfterEnforced).toHaveLength(9);
    const enforcedEntries = entriesAfterEnforced.slice(6);
    expect(
      new Set(enforcedEntries.map((entry) => entry.operationId)).size,
    ).toBe(1);
    expect(
      enforcedEntries
        .map(
          (entry) =>
            `${entry.resourceKind}:${entry.action}:${entry.resourceId}`,
        )
        .sort(),
    ).toEqual(
      [
        `twoFactorAuthenticationMethod:delete:${method2.id}`,
        `refreshToken:update:${refreshToken2Id}`,
        `twoFactorAuthenticationMethod:create:${replacementMethod.id}`,
      ].sort(),
    );

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      ),
    ).rejects.toMatchObject({
      code: TwoFactorAuthenticationExceptionCode.RECOVERY_ENROLLMENT_RESTRICTED,
    });
    expect(await audits()).toHaveLength(9);

    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(replacementSecret),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );
    expect(await audits()).toHaveLength(10);
  });

  it('enforces fail-closed invariants on unauthenticated callers, actor/userWorkspace mismatch, and cross-workspace FK rows', async () => {
    const {
      twoFactorAuthenticationService,
      twoFactorAuthenticationRecoveryService,
    } = buildHarness();

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
        { auditIdentity: undefined },
      ),
    ).rejects.toThrow(
      'Two-factor authentication mutation requires authenticated audit identity',
    );

    await expect(
      twoFactorAuthenticationService.validateStrategy(
        actorUserId,
        '123456',
        workspaceId,
        TwoFactorAuthenticationStrategy.TOTP,
        { auditIdentity: undefined },
      ),
    ).rejects.toThrow(
      'Two-factor authentication mutation requires authenticated audit identity',
    );

    await expect(
      twoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod({
        twoFactorAuthenticationMethodId: randomUUID(),
        workspaceId,
        userId: actorUserId,
        auditIdentity: undefined,
      }),
    ).rejects.toThrow(
      'Two-factor authentication mutation requires authenticated audit identity',
    );

    await expect(
      twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: false,
        },
        recoveryCode: 'ABCDE-FGHJK-MNPQR-STVWX',
        auditIdentity: undefined,
      }),
    ).rejects.toThrow(
      'Two-factor authentication mutation requires authenticated audit identity',
    );

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
        {
          auditIdentity: {
            workspaceId,
            actor: { kind: 'coreUser', id: secondUserId },
          },
        },
      ),
    ).rejects.toThrow(
      'Two-factor authentication actor does not match target userWorkspace',
    );

    const mismatchedMemberIdentity: RoleUpdateAuditIdentity = {
      auth: {
        type: 'user',
        user: { id: secondUserId },
        workspace: { id: workspaceId },
        userWorkspaceId: secondUserWorkspaceId,
        workspaceMemberId: secondMemberId,
      } as RoleUpdateAuditIdentity['auth'],
    };

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
        { auditIdentity: mismatchedMemberIdentity },
      ),
    ).rejects.toThrow(
      'Two-factor authentication workspaceMember actor does not match target userWorkspace',
    );

    const foreignMethodId = randomUUID();
    await owner.query(
      `INSERT INTO core."twoFactorAuthenticationMethod"
        (id, "workspaceId", "userWorkspaceId", secret, status, strategy)
       VALUES ($1, $2, $3, 'enc:v2:Zm9yZWlnbi1zZWNyZXQ=', 'VERIFIED', 'TOTP')`,
      [foreignMethodId, foreignWorkspaceId, actorUserWorkspaceId],
    );

    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      ),
    ).rejects.toThrow('Two-factor authentication method workspace mismatch');

    await expect(
      twoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod({
        twoFactorAuthenticationMethodId: foreignMethodId,
        workspaceId,
        userId: actorUserId,
      }),
    ).rejects.toThrow('Two-factor authentication method workspace mismatch');

    expect(await audits()).toHaveLength(0);
  });

  it('propagates NativeTransactionOutcomeUnknownError and CoreAuditPostCommitError across TwoFactorAuthenticationService and TwoFactorAuthenticationRecoveryService while revoking sessions on uncertain recovery commit (M5)', async () => {
    const {
      twoFactorAuthenticationService,
      twoFactorAuthenticationRecoveryService,
      userSessionService,
      emailService,
    } = buildHarness();

    const origCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const injectCommitFailure = () => {
      jest
        .spyOn(runtime, 'createQueryRunner')
        .mockImplementationOnce((mode) => {
          const qr = origCreateQueryRunner(mode);
          const origConnect = qr.connect.bind(qr);
          jest.spyOn(qr, 'connect').mockImplementationOnce(async () => {
            const client = await origConnect();
            const origClientQuery = client.query.bind(client);
            const querySpy = jest
              .spyOn(client, 'query')
              .mockImplementation((...args: unknown[]) => {
                if (args[0] === 'COMMIT') {
                  querySpy.mockRestore();
                  return Promise.reject(
                    new Error('connection terminated during COMMIT'),
                  );
                }
                return (origClientQuery as (...a: unknown[]) => unknown)(
                  ...args,
                );
              });
            return client;
          });
          return qr;
        });
    };

    const injectPostCommitFailure = () => {
      jest
        .spyOn(runtime, 'createQueryRunner')
        .mockImplementationOnce((mode) => {
          const qr = origCreateQueryRunner(mode);
          const origCommit = qr.commitTransaction.bind(qr);
          jest
            .spyOn(qr, 'commitTransaction')
            .mockImplementationOnce(async () => {
              await origCommit();
              throw new Error('post-commit failure');
            });
          return qr;
        });
    };

    const uri =
      await twoFactorAuthenticationService.initiateStrategyConfiguration(
        actorUserId,
        'actor@example.com',
        workspaceId,
        'Test Workspace',
      );
    const secret = extractTotpSecretFromUri(uri);
    await twoFactorAuthenticationService.validateStrategy(
      actorUserId,
      authenticator.generate(secret),
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
    );
    const [methodRow]: Row[] = await owner.query(
      'SELECT * FROM core."twoFactorAuthenticationMethod" WHERE "userWorkspaceId" = $1',
      [actorUserWorkspaceId],
    );

    injectCommitFailure();
    await expect(
      twoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod({
        twoFactorAuthenticationMethodId: methodRow.id,
        workspaceId,
        userId: actorUserId,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    injectPostCommitFailure();
    await expect(
      twoFactorAuthenticationService.initiateStrategyConfiguration(
        secondUserId,
        'second@example.com',
        workspaceId,
        'Test Workspace',
      ),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    const rawCode1 = 'ABCDE-FGHJK-MNPQR-STVWX';
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', $4, now() + interval '1 hour', '2026-06-01T00:00:00.000Z')`,
      [
        randomUUID(),
        actorUserId,
        workspaceId,
        hashTwoFactorAuthenticationRecoveryCode(rawCode1),
      ],
    );

    userSessionService.revokeAllSessionsForUser.mockClear();
    emailService.send.mockClear();
    injectCommitFailure();
    await expect(
      twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: true,
        },
        recoveryCode: rawCode1,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(userSessionService.revokeAllSessionsForUser).toHaveBeenCalledWith({
      userId: actorUserId,
      workspaceId,
      reason: UserSessionRevokedReason.TwoFactorAuthenticationReset,
    });
    expect(emailService.send).not.toHaveBeenCalled();

    const rawCode2 = '12345-67890-ABCDE-FGHIJ';
    await owner.query(
      `INSERT INTO core."appToken" (id, "userId", "workspaceId", type, value, "expiresAt", "createdAt")
       VALUES ($1, $2, $3, 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE', $4, now() + interval '1 hour', '2026-06-01T00:00:00.000Z')`,
      [
        randomUUID(),
        actorUserId,
        workspaceId,
        hashTwoFactorAuthenticationRecoveryCode(rawCode2),
      ],
    );

    userSessionService.revokeAllSessionsForUser.mockClear();
    emailService.send.mockClear();
    injectPostCommitFailure();
    await expect(
      twoFactorAuthenticationRecoveryService.redeemRecoveryCode({
        userId: actorUserId,
        userEmail: 'actor@example.com',
        workspace: {
          id: workspaceId,
          displayName: 'Test Workspace',
          isTwoFactorAuthenticationEnforced: true,
        },
        recoveryCode: rawCode2,
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);
    expect(userSessionService.revokeAllSessionsForUser).toHaveBeenCalledWith({
      userId: actorUserId,
      workspaceId,
      reason: UserSessionRevokedReason.TwoFactorAuthenticationReset,
    });
    expect(emailService.send).not.toHaveBeenCalled();
  });
});
