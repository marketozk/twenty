import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { randomUUID, createHash } from 'node:crypto';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { Logger } from '@nestjs/common';
import {
  captureCrmAuditRequest,
  captureCurrentCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  captureMembershipCleanupIdentity,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { requireOAuthAuditIdentity } from 'src/engine/core-modules/crm-audit/oauth-audit-identity';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { ApplicationRegistrationSourceType } from 'src/engine/core-modules/application/application-registration/enums/application-registration-source-type.enum';

// Explicit adapters exclude unrelated DI, GraphQL decorators and entity loading.
// The eight production source methods and attribution/PKCE helpers stay real.
const adapters: [string, string[]][] = [
  [
    'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
    ['MetadataResolver'],
  ],
  [
    'src/engine/core-modules/api-key/services/api-key.service',
    ['ApiKeyService'],
  ],
  [
    'src/engine/core-modules/event-logs/emit/event-log-emitter.service',
    ['EventLogEmitterService'],
  ],
  [
    'src/engine/core-modules/auth/dto/api-key-token.input',
    ['ApiKeyTokenInput'],
  ],
  ['src/engine/core-modules/auth/dto/app-token.input', ['AppTokenInput']],
  ['src/engine/core-modules/auth/dto/authorize-app.dto', []],
  ['src/engine/core-modules/auth/dto/authorize-app.input', []],
  [
    'src/engine/core-modules/auth/dto/available-workspaces-and-access-tokens.dto',
    ['AvailableWorkspacesAndAccessTokensDTO'],
  ],
  [
    'src/engine/core-modules/auth/dto/email-password-reset-link.dto',
    ['EmailPasswordResetLinkDTO'],
  ],
  [
    'src/engine/core-modules/auth/dto/email-password-reset-link.input',
    ['EmailPasswordResetLinkInput'],
  ],
  [
    'src/engine/core-modules/auth/dto/get-auth-token-from-email-verification-token.input',
    ['GetAuthTokenFromEmailVerificationTokenInput'],
  ],
  [
    'src/engine/core-modules/auth/dto/get-authorization-url-for-sso.dto',
    ['GetAuthorizationUrlForSsoDTO'],
  ],
  [
    'src/engine/core-modules/auth/dto/get-authorization-url-for-sso.input',
    ['GetAuthorizationUrlForSsoInput'],
  ],
  [
    'src/engine/core-modules/auth/dto/invalidate-password.dto',
    ['InvalidatePasswordDTO'],
  ],
  ['src/engine/core-modules/auth/dto/sign-up.dto', ['SignUpDTO']],
  [
    'src/engine/core-modules/auth/dto/transient-token.dto',
    ['TransientTokenDTO'],
  ],
  [
    'src/engine/core-modules/auth/dto/update-password-via-reset-token.input',
    ['UpdatePasswordViaResetTokenInput'],
  ],
  [
    'src/engine/core-modules/auth/dto/validate-password-reset-token.dto',
    ['ValidatePasswordResetTokenDTO'],
  ],
  [
    'src/engine/core-modules/auth/dto/validate-password-reset-token.input',
    ['ValidatePasswordResetTokenInput'],
  ],
  [
    'src/engine/core-modules/auth/dto/verify-email-and-get-login-token.dto',
    ['VerifyEmailAndGetLoginTokenDTO'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/auth/services/reset-password.service',
    ['ResetPasswordService'],
  ],
  [
    'src/engine/core-modules/throttler/filters/throttler-graphql-api-exception.filter',
    ['ThrottlerGraphqlApiExceptionFilter'],
  ],
  ['src/engine/core-modules/throttler/throttler.service', ['ThrottlerService']],
  [
    'src/engine/core-modules/auth/services/sign-in-up.service',
    ['SignInUpService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/access-token.service',
    ['AccessTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/email-verification-token.service',
    ['EmailVerificationTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/login-token.service',
    ['LoginTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/refresh-token.service',
    ['RefreshTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/renew-token.service',
    ['RenewTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/sso-exchange-token.service',
    ['SsoExchangeTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/transient-token.service',
    ['TransientTokenService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/workspace-agnostic-token.service',
    ['WorkspaceAgnosticTokenService'],
  ],
  [
    'src/engine/core-modules/captcha/filters/captcha-graphql-api-exception.filter',
    ['CaptchaGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/domain/subdomain-manager/dtos/subdomain-availability.dto',
    ['SubdomainAvailabilityDTO'],
  ],
  [
    'src/engine/core-modules/domain/subdomain-manager/dtos/workspace-creation-defaults.dto',
    ['WorkspaceCreationDefaultsDTO'],
  ],
  [
    'src/engine/core-modules/domain/subdomain-manager/services/subdomain-manager.service',
    ['SubdomainManagerService'],
  ],
  [
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  [
    'src/engine/core-modules/email-verification/services/email-verification.service',
    ['EmailVerificationService'],
  ],
  [
    'src/engine/core-modules/file/dtos/file-with-sign-url.dto',
    ['FileWithSignedUrlDTO'],
  ],
  [
    'src/engine/core-modules/file/file-upload/dtos/file-upload-target.dto',
    ['FileUploadTargetDTO'],
  ],
  [
    'src/engine/core-modules/file/file-upload/filters/file-upload-graphql-api-exception.filter',
    ['FileUploadGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/file/file-core-picture/services/file-core-picture.service',
    ['FileCorePictureService'],
  ],
  [
    'src/engine/core-modules/file/file-upload/services/file-upload.service',
    ['FileUploadService'],
  ],
  [
    'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
    ['PreventNestToAutoLogGraphqlErrorsFilter'],
  ],
  [
    'src/engine/core-modules/impersonation/services/impersonation-authorization.service',
    ['ImpersonationAuthorizationService'],
  ],
  ['src/engine/core-modules/sso/services/sso.service', ['SsoService']],
  [
    'src/engine/core-modules/two-factor-authentication/dto/two-factor-authentication-recovery-code-redemption.dto',
    ['TwoFactorAuthenticationRecoveryCodeRedemptionDTO'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/dto/two-factor-authentication-recovery-code-verification.input',
    ['TwoFactorAuthenticationRecoveryCodeVerificationInput'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/dto/two-factor-authentication-verification.input',
    ['TwoFactorAuthenticationVerificationInput'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/services/two-factor-authentication-recovery.service',
    ['TwoFactorAuthenticationRecoveryService'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/two-factor-authentication.service',
    ['TwoFactorAuthenticationService'],
  ],
  [
    'src/engine/core-modules/user-session/services/user-session-cookie.service',
    ['UserSessionCookieService'],
  ],
  [
    'src/engine/core-modules/user-session/services/user-session.service',
    ['UserSessionService'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.service',
    ['UserWorkspaceService'],
  ],
  ['src/engine/core-modules/user/services/user.service', ['UserService']],
  ['src/engine/core-modules/user/user.entity', ['UserEntity']],
  [
    'src/engine/core-modules/workspace/filters/workspace-graphql-api-exception.filter',
    ['WorkspaceGraphqlApiExceptionFilter'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  ['src/engine/decorators/auth/auth-provider.decorator', ['AuthProvider']],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  ['src/engine/guards/public-endpoint.guard', ['PublicEndpointGuard']],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  [
    'src/engine/core-modules/application/application-registration/application-registration.service',
    ['ApplicationRegistrationService'],
  ],
  ['src/engine/core-modules/auth/dto/auth-tokens.dto', []],
  ['src/engine/core-modules/auth/dto/update-password.dto', []],
  ['src/engine/core-modules/auth/dto/user-credentials.input', []],
  ['src/engine/core-modules/auth/dto/user-exists.dto', []],
  ['src/engine/core-modules/auth/dto/workspace-invite-hash-valid.dto', []],
  [
    'src/engine/core-modules/auth/services/auth-sso.service',
    ['AuthSsoService'],
  ],
  [
    'src/engine/core-modules/auth/services/create-sso-connected-account.service',
    ['CreateSsoConnectedAccountService'],
  ],
  [
    'src/engine/core-modules/domain/domain-server-config/services/domain-server-config.service',
    ['DomainServerConfigService'],
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
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/core-modules/workspace-invitation/dtos/workspace-invitation.dto',
    [],
  ],
  [
    'src/engine/core-modules/workspace-invitation/services/workspace-invitation.service',
    ['WorkspaceInvitationService'],
  ],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/core-modules/application/application-authorization/services/application-authorization.service',
    ['ApplicationAuthorizationService'],
  ],
  [
    'src/engine/core-modules/application/application-registration/application-registration.entity',
    ['ApplicationRegistrationEntity'],
  ],
  [
    'src/engine/core-modules/application/application.entity',
    ['ApplicationEntity'],
  ],
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/application-token.service',
    ['ApplicationTokenService'],
  ],
  [
    'src/engine/core-modules/application/application-manifest/application-manifest-apply.service',
    ['ApplicationManifestApplyService'],
  ],
  [
    'src/engine/core-modules/application/application-manifest/application-sync.service',
    ['ApplicationSyncService'],
  ],
  [
    'src/engine/core-modules/application/application-package/application-package-fetcher.service',
    ['ApplicationPackageFetcherService'],
  ],
  [
    'src/engine/core-modules/application/application-package/application-version-validation.service',
    ['ApplicationVersionValidationService'],
  ],
  [
    'src/engine/core-modules/application/application-registration-version/application-registration-version.service',
    ['ApplicationRegistrationVersionService'],
  ],
  [
    'src/engine/core-modules/application/application-lookup/application-lookup.service',
    ['ApplicationLookupService'],
  ],
  [
    'src/engine/core-modules/cache-lock/cache-lock.service',
    ['CacheLockService'],
  ],
  [
    'src/engine/core-modules/file-storage/services/file-storage.service',
    ['FileStorageService'],
  ],
  [
    'src/engine/core-modules/logic-function/logic-function-executor/logic-function-executor.service',
    ['LogicFunctionExecutorService'],
  ],
  [
    'src/engine/core-modules/logic-function/logic-function-trigger/jobs/application-lifecycle-hook.job',
    ['ApplicationLifecycleHookJob'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/message-queue.decorator',
    ['InjectMessageQueue'],
  ],
  [
    'src/engine/core-modules/message-queue/services/message-queue.service',
    ['MessageQueueService'],
  ],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/workspace-manager/workspace-version/services/workspace-version.service',
    ['WorkspaceVersionService'],
  ],
  [
    'src/database/commands/command-runners/workspace-iterator.service',
    ['WorkspaceIteratorService'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/process.decorator',
    ['Process'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/processor.decorator',
    ['Processor'],
  ],
];
jest.doMock('graphql-upload/GraphQLUpload.mjs', () => ({ default: class {} }));
for (const [path, exports] of adapters) {
  jest.doMock(path, () =>
    Object.fromEntries(
      exports.map((name) => [
        name,
        function () {
          return () => {};
        },
      ]),
    ),
  );
}
const { AuthResolver } = require('src/engine/core-modules/auth/auth.resolver');
const {
  AuthService,
} = require('src/engine/core-modules/auth/services/auth.service');
const {
  OAuthService,
} = require('src/engine/core-modules/application/application-oauth/oauth.service');
const {
  ApplicationInstallService,
} = require('src/engine/core-modules/application/application-install/application-install.service');
const {
  ApplicationUpgradeService,
} = require('src/engine/core-modules/application/application-upgrade/application-upgrade.service');
const {
  PreInstalledAppsService,
} = require('src/engine/core-modules/application/pre-installed-apps/pre-installed-apps.service');
const {
  InstallApplicationCommand,
} = require('src/engine/core-modules/application/application-install/commands/install-application.command');
const {
  UpgradeWorkspaceApplicationJob,
} = require('src/engine/core-modules/application/jobs/upgrade-workspace-application.job');

const current = (workspaceId: string) =>
  captureCurrentCrmAuditIdentity(workspaceId, async () => undefined);
const instance = (
  Type: { prototype: object },
  fields: Record<string, unknown>,
) =>
  Object.assign(
    Object.create(Type.prototype),
    { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    fields,
  );
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
beforeEach(() => {
  jest.restoreAllMocks();
  for (const method of ['log', 'warn', 'error'] as const)
    jest.spyOn(Logger.prototype, method).mockImplementation(() => {});
});

const fixture = () => {
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    initiator = randomUUID(),
    verifier = 'test-pkce-verifier';
  const identity: MembershipCleanupIdentity = {
    workspaceId,
    actor: { kind: 'coreUser', id: userId },
    initiator: { kind: 'coreUser', id: initiator },
    correlationId: randomUUID(),
  };
  const registration = {
    id: randomUUID(),
    name: 'Fixture',
    universalIdentifier: randomUUID(),
    sourceType: ApplicationRegistrationSourceType.NPM,
    latestAvailableVersion: '1.0.0',
    oAuthClientId: randomUUID(),
    oAuthClientSecretHash: null,
    oAuthRedirectUris: ['http://localhost:4567/callback'],
    oAuthScopes: ['api'],
  };
  const application = { id: randomUUID() };
  const token = {
    id: randomUUID(),
    userId,
    workspaceId,
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60000),
    context: {
      auditIdentity: identity as MembershipCleanupIdentity | undefined,
      clientId: registration.oAuthClientId,
      redirectUri: registration.oAuthRedirectUris[0],
      scope: 'api',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    },
  };
  const sequence: string[] = [],
    captured: (MembershipCleanupIdentity | undefined)[] = [];
  const install = jest.fn(async () => {
    sequence.push('install');
    captured.push(await current(workspaceId));
    return true;
  });
  const create = jest.fn(async () => {
    sequence.push('bare');
    captured.push(await current(workspaceId));
    return application;
  });
  const repository = {
    findOne: jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(application),
  };
  const membership = jest.fn(async () => {
    sequence.push('membership');
    return { id: randomUUID() } as object | null;
  });
  const consume = jest.fn().mockResolvedValue({ affected: 1 });
  const grant = jest.fn().mockResolvedValue(undefined);
  const pair = jest.fn().mockResolvedValue({
    applicationAccessToken: { token: 'fixture-access' },
    applicationRefreshToken: { token: 'fixture-refresh' },
  });
  const service = instance(OAuthService, {
    appTokenRepository: {
      findOne: jest.fn().mockResolvedValue(token),
      update: consume,
    },
    applicationRepository: repository,
    userWorkspaceRepository: { findOne: membership },
    applicationRegistrationService: {
      findOneByClientId: jest.fn().mockResolvedValue(registration),
      verifyClientSecret: jest.fn().mockResolvedValue(true),
    },
    applicationInstallService: { installApplication: install },
    applicationService: { create },
    applicationAuthorizationService: { recordAuthorization: grant },
    applicationTokenService: { generateApplicationTokenPair: pair },
    twentyConfigService: { get: () => '1h' },
  });
  const params = {
    authorizationCode: 'fixture-code',
    clientId: registration.oAuthClientId,
    redirectUri: token.context.redirectUri,
    codeVerifier: verifier,
  };
  return {
    service,
    params,
    token,
    registration,
    identity,
    workspaceId,
    userId,
    initiator,
    install,
    create,
    repository,
    membership,
    consume,
    grant,
    pair,
    sequence,
    captured,
    application,
  };
};

it('binds and copies OAuth user/impersonator identity; rejects another actor or workspace', () => {
  const f = fixture();
  const captured = requireOAuthAuditIdentity(
    f.identity,
    f.workspaceId,
    f.userId,
  );
  expect(captured).toEqual(f.identity);
  expect(Object.isFrozen(captured.actor)).toBe(true);
  expect(() =>
    requireOAuthAuditIdentity(f.identity, randomUUID(), f.userId),
  ).toThrow();
  expect(() =>
    requireOAuthAuditIdentity(f.identity, f.workspaceId, randomUUID()),
  ).toThrow();
  expect(() =>
    requireOAuthAuditIdentity(undefined, f.workspaceId, f.userId),
  ).toThrow();
});

it('issues a persisted code with a copied identity before the first awaited lookup', async () => {
  const f = fixture(),
    ready = gate(),
    saved: any[] = [];
  const service = instance(AuthService, {
    applicationRegistrationService: {
      findOneByClientId: async () => {
        await ready.promise;
        return f.registration;
      },
    },
    appTokenRepository: {
      create: (data: unknown) => data,
      save: async (data: unknown) => saved.push(data),
    },
    twentyConfigService: { get: () => 'http://localhost:2020' },
  });
  const user = { id: f.userId },
    workspace = { id: f.workspaceId };
  const input = {
    clientId: f.params.clientId,
    redirectUrl: f.params.redirectUri,
    codeChallenge: f.token.context.codeChallenge,
  };
  const original = JSON.parse(JSON.stringify(f.identity));
  const run = service.generateAuthorizationCode({
    authorizeAppInput: input,
    user,
    workspace,
    requestBaseUrl: 'http://localhost:2020',
    auditIdentity: f.identity,
  });
  user.id = randomUUID();
  workspace.id = randomUUID();
  input.redirectUrl = 'https://foreign.invalid';
  (f.identity.actor as { id: string }).id = randomUUID();
  ready.release();
  expect((await run).redirectUrl).toContain(
    'http://localhost:4567/callback?code=',
  );
  expect(saved[0]).toMatchObject({
    userId: f.userId,
    workspaceId: f.workspaceId,
    context: { auditIdentity: original },
  });
  expect(saved[0].value).not.toContain('fixture-code');
});

it('resolver captures the verified impersonator before its lookup and ignores body actor', async () => {
  const f = fixture(),
    ready = gate(),
    args: any[] = [];
  const resolver = instance(AuthResolver, {
    userWorkspaceService: {
      captureCleanupAuditIdentity: (auth: any) =>
        captureMembershipCleanupIdentity(auth, async () => {
          await ready.promise;
          return f.initiator;
        }),
    },
    authService: {
      generateAuthorizationCode: async (data: unknown) => {
        args.push(data);
        return {};
      },
    },
  });
  const req = {
    protocol: 'http',
    get: () => 'localhost:2020',
    headers: { host: 'localhost:2020' },
    impersonationContext: { impersonatorUserWorkspaceId: randomUUID() },
  };
  const user = { id: f.userId },
    workspace = { id: f.workspaceId },
    input = {
      clientId: f.params.clientId,
      actor: { kind: 'system', id: 'spoof' },
    };
  const run = resolver.authorizeApp(input, user, workspace, { req });
  user.id = randomUUID();
  workspace.id = randomUUID();
  req.impersonationContext.impersonatorUserWorkspaceId = randomUUID();
  ready.release();
  await run;
  expect(args[0].auditIdentity).toMatchObject({
    workspaceId: f.workspaceId,
    actor: { kind: 'coreUser', id: f.userId },
    initiator: { kind: 'coreUser', id: f.initiator },
  });
  expect(args[0].user.id).toBe(f.userId);
  expect(args[0].workspace.id).toBe(f.workspaceId);
});

it('uses retained impersonator at exchange and checks membership before installing', async () => {
  const f = fixture();
  const foreign = {
    workspace: { id: randomUUID() },
    user: { id: randomUUID() },
  };
  const result = await withCrmAuditRequest(
    captureCrmAuditRequest(foreign),
    () => f.service.exchangeAuthorizationCode(f.params),
  );
  expect(result.access_token).toBe('fixture-access');
  expect(f.sequence).toEqual(['membership', 'install']);
  expect(f.captured).toEqual([f.identity]);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.consume).toHaveBeenCalledTimes(1);
});

it.each([
  'missing',
  'foreign-workspace',
  'foreign-user',
  'system',
  'malformed',
  'bad-initiator',
])('rejects %s persisted identity before effects', async (kind) => {
  const f = fixture();
  if (kind === 'missing') f.token.context.auditIdentity = undefined;
  else if (kind === 'foreign-workspace')
    f.token.context.auditIdentity = {
      ...f.identity,
      workspaceId: randomUUID(),
    };
  else if (kind === 'foreign-user')
    f.token.context.auditIdentity = {
      ...f.identity,
      actor: { kind: 'coreUser', id: randomUUID() },
    };
  else if (kind === 'system')
    f.token.context.auditIdentity = {
      ...f.identity,
      actor: { kind: 'system', id: 'PretendUser' },
    };
  else if (kind === 'bad-initiator')
    f.token.context.auditIdentity = {
      ...f.identity,
      initiator: { kind: 'system', id: 'PretendUser' },
    };
  else
    f.token.context.auditIdentity = { ...f.identity, correlationId: 'invalid' };
  expect((await f.service.exchangeAuthorizationCode(f.params)).error).toBe(
    'invalid_grant',
  );
  expect(f.install).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.grant).not.toHaveBeenCalled();
});

it.each(['client', 'redirect', 'pkce', 'expired', 'replayed', 'concurrent'])(
  'keeps %s code rejection before installation',
  async (kind) => {
    const f = fixture();
    if (kind === 'client') f.token.context.clientId = randomUUID();
    if (kind === 'redirect')
      f.params.redirectUri = 'http://localhost:8888/foreign';
    if (kind === 'pkce') f.params.codeVerifier = 'wrong';
    if (kind === 'expired') f.token.expiresAt = new Date(0);
    if (kind === 'replayed') f.token.revokedAt = new Date();
    if (kind === 'concurrent') f.consume.mockResolvedValue({ affected: 0 });
    expect((await f.service.exchangeAuthorizationCode(f.params)).error).toBe(
      'invalid_grant',
    );
    expect(f.install).not.toHaveBeenCalled();
    expect(f.membership).not.toHaveBeenCalled();
  },
);

it('refuses a removed membership before either installation or token grant', async () => {
  const f = fixture();
  f.membership.mockResolvedValue(null);
  expect((await f.service.exchangeAuthorizationCode(f.params)).error).toBe(
    'invalid_grant',
  );
  expect(f.install).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.pair).not.toHaveBeenCalled();
});

it.each([
  ApplicationRegistrationSourceType.OAUTH_ONLY,
  ApplicationRegistrationSourceType.LOCAL,
])(
  'creates a no-package %s installation under retained identity',
  async (sourceType) => {
    const f = fixture();
    f.registration.sourceType = sourceType;
    expect(
      (await f.service.exchangeAuthorizationCode(f.params)).access_token,
    ).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.captured).toEqual([f.identity]);
  },
);

it('uses an existing application without reinstalling', async () => {
  const f = fixture();
  f.repository.findOne.mockReset().mockResolvedValue(f.application);
  await f.service.exchangeAuthorizationCode(f.params);
  expect(f.install).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each(['ordinary', 'unknown', 'missing-result'])(
  'does not create a bare fallback or grant after %s packaged install failure',
  async (kind) => {
    const f = fixture();
    const error =
      kind === 'unknown'
        ? new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('lost ack'),
          )
        : new Error('install failed');
    if (kind === 'missing-result')
      f.repository.findOne.mockReset().mockResolvedValue(null);
    else f.install.mockRejectedValue(error);
    const run = f.service.exchangeAuthorizationCode(f.params);
    if (kind === 'missing-result')
      await expect(run).rejects.toThrow('did not create');
    else await expect(run).rejects.toBe(error);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.pair).not.toHaveBeenCalled();
  },
);

it('scopes each preinstalled policy action despite a foreign ambient request', async () => {
  const foreign = {
    workspace: { id: randomUUID() },
    user: { id: randomUUID() },
  };
  const targets = [randomUUID(), randomUUID()],
    seen: any[] = [];
  const service = instance(PreInstalledAppsService, {
    applicationRegistrationRepository: {
      find: async () => [{ id: randomUUID() }, { id: randomUUID() }],
    },
    applicationInstallService: {
      installApplication: async ({ workspaceId }: any) => {
        await Promise.resolve();
        seen.push(await current(workspaceId));
      },
    },
  });
  await withCrmAuditRequest(captureCrmAuditRequest(foreign), () =>
    Promise.all(targets.map((id) => service.installOnWorkspace(id))),
  );
  expect(seen).toHaveLength(4);
  for (const identity of seen) {
    expect(targets).toContain(identity.workspaceId);
    expect(identity.actor).toEqual({
      kind: 'system',
      id: 'PreInstalledAppsService.installOnWorkspace',
    });
    expect(identity.initiator).toBeUndefined();
  }
  expect(new Set(seen.map((x) => x.correlationId)).size).toBe(4);
});

it('backfill uses named identities for the actual iterator workspaces', async () => {
  const ids = [randomUUID(), randomUUID()],
    seen: any[] = [];
  const service = instance(PreInstalledAppsService, {
    applicationRegistrationRepository: {
      findOne: async () => ({ id: randomUUID() }),
    },
    workspaceIteratorService: {
      iterate: async ({ callback }: any) => {
        await Promise.all(ids.map((workspaceId) => callback({ workspaceId })));
        return { success: ids, fail: [] };
      },
    },
    applicationInstallService: {
      installApplication: async ({ workspaceId }: any) =>
        seen.push(await current(workspaceId)),
    },
  });
  await service.backfillApplicationOnAllWorkspaces(randomUUID());
  expect(seen.map((x) => x.workspaceId).sort()).toEqual(ids.sort());
  expect(
    seen.every((x) => x.actor.id === 'PreInstalledAppsService.backfill'),
  ).toBe(true);
});

it.each([true, false])(
  'CLI dryRun=%s retains its effect boundary and named source',
  async (dryRun) => {
    const f = fixture(),
      seen: any[] = [];
    const service = instance(InstallApplicationCommand, {
      applicationRegistrationRepository: {
        findOne: async () => f.registration,
      },
      applicationRepository: { exists: async () => false },
      workspaceIteratorService: {
        iterate: async ({ callback }: any) => {
          await callback({ workspaceId: f.workspaceId });
          return { success: [f.workspaceId], fail: [] };
        },
      },
      applicationInstallService: {
        installApplication: async () => seen.push(await current(f.workspaceId)),
      },
    });
    await service.run([], {
      applicationRegistrationUniversalIdentifier:
        f.registration.universalIdentifier,
      dryRun,
      yes: true,
    });
    expect(seen).toHaveLength(dryRun ? 0 : 1);
    if (!dryRun)
      expect(seen[0].actor).toEqual({
        kind: 'system',
        id: 'InstallApplicationCommand',
      });
  },
);

it('automatic upgrade uses the actual worker identity and restores the parent', async () => {
  const f = fixture(),
    seen: any[] = [];
  const job = instance(UpgradeWorkspaceApplicationJob, {
    applicationUpgradeService: {
      upgradeWorkspaceApplicationToLatestVersion: async () =>
        seen.push(await current(f.workspaceId)),
    },
  });
  const parent = {
    workspace: { id: randomUUID() },
    user: { id: randomUUID() },
  };
  await withCrmAuditRequest(captureCrmAuditRequest(parent), async () => {
    await job.handle({
      workspaceId: f.workspaceId,
      applicationRegistrationId: f.registration.id,
      onlyAutoUpgrade: false,
    });
    expect((await current(parent.workspace.id))?.actor.id).toBe(parent.user.id);
  });
  expect(seen[0].actor).toEqual({
    kind: 'system',
    id: 'UpgradeWorkspaceApplicationJob',
  });
});

const installFixture = (kind = 'native') => {
  const f = fixture(),
    error =
      kind === 'committed'
        ? new CoreAuditPostCommitError(new Error('fixture post-commit failure'))
        : kind === 'omni'
          ? new OmniCoreTransactionOutcomeUnknownError(new Error('lost ack'))
          : new NativeTransactionOutcomeUnknownError(
              'commit',
              new Error('lost ack'),
            );
  const compensation = jest.fn().mockResolvedValue(undefined);
  const service = instance(ApplicationInstallService, {
    ensureApplicationExists: async () => ({ id: randomUUID(), version: null }),
    writeFilesToStorage: jest.fn().mockRejectedValue(error),
    applicationSyncService: { uninstallApplication: compensation },
    metricsService: { incrementCounterBy: jest.fn() },
    eventLogEmitterService: {
      recordApplicationPlatformEvents: jest
        .fn()
        .mockRejectedValue(new Error('telemetry failed')),
    },
  });
  const input = {
    appRegistration: f.registration,
    params: {
      workspaceId: f.workspaceId,
      skipWorkspaceCompatibilityCheck: true,
    },
    resolvedPackage: {
      packageJson: { version: '1.0.0' },
      manifest: {
        application: { displayName: 'Fixture', requestedCapabilities: [] },
      },
    },
    existingApplication: null,
    progressReporter: { reportStepCompleted: async () => {} },
    isVersionUpgrade: false,
  };
  return { f, service, input, error, compensation };
};
it.each(['native', 'omni', 'committed'])(
  'real install catch does not compensate %s unknown outcome',
  async (kind) => {
    const f = installFixture(kind);
    await expect(f.service.runInstall(f.input)).rejects.toBe(f.error);
    expect(f.compensation).not.toHaveBeenCalled();
  },
);
it('ordinary install failures retain their original compensation behavior', async () => {
  const f = installFixture(),
    error = new Error('known failed');
  f.service.writeFilesToStorage.mockRejectedValue(error);
  await expect(f.service.runInstall(f.input)).rejects.toBe(error);
  expect(f.compensation).toHaveBeenCalledTimes(1);
});
it.each(['native', 'omni', 'committed'])(
  '%s unknown install outcome survives telemetry',
  async (kind) => {
    const f = installFixture(kind);
    await expect(f.service.runInstallWithMetrics(f.input)).rejects.toBe(
      f.error,
    );
    expect(
      f.service.eventLogEmitterService.recordApplicationPlatformEvents,
    ).not.toHaveBeenCalled();
    expect(f.service.metricsService.incrementCounterBy).not.toHaveBeenCalled();
  },
);
it.each([
  ['native', false],
  ['native', true],
  ['omni', false],
  ['omni', true],
  ['committed', false],
  ['committed', true],
] as const)(
  '%s outcome survives package cleanup failure=%s',
  async (kind, fails) => {
    const f = installFixture(kind),
      cleanup = jest.fn();
    if (fails) cleanup.mockRejectedValue(new Error('cleanup failed'));
    else cleanup.mockResolvedValue(undefined);
    Object.assign(f.service, {
      appRegistrationRepository: { findOne: async () => f.f.registration },
      applicationLookupService: { findByUniversalIdentifier: async () => null },
      resolvePackageOrRecordFailure: async () => ({
        ...f.input.resolvedPackage,
        cleanupDir: '/isolated/package',
      }),
      applicationPackageFetcherService: { cleanupExtractedDir: cleanup },
    });
    await expect(
      f.service.doInstallApplication(
        f.f.registration,
        f.input.params,
        f.input.progressReporter,
      ),
    ).rejects.toBe(f.error);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(f.compensation).not.toHaveBeenCalled();
  },
);
it.each(['native', 'omni', 'committed'])(
  'upgrade propagates the exact %s unknown outcome',
  async (kind) => {
    const f = fixture(),
      error =
        kind === 'committed'
          ? new CoreAuditPostCommitError(
              new Error('fixture post-commit failure'),
            )
          : kind === 'omni'
            ? new OmniCoreTransactionOutcomeUnknownError(new Error('lost'))
            : new NativeTransactionOutcomeUnknownError(
                'rollback',
                new Error('lost'),
              );
    const service = instance(ApplicationUpgradeService, {
      appRegistrationRepository: { findOneOrFail: async () => f.registration },
      applicationInstallService: {
        installApplication: async () => {
          throw error;
        },
      },
    });
    await expect(
      service.upgradeApplication({
        appRegistrationId: f.registration.id,
        targetVersion: '2.0.0',
        workspaceId: f.workspaceId,
      }),
    ).rejects.toBe(error);
  },
);
it('manifest account-delete COMMIT ACK loss crosses install without compensation or a second migration', async () => {
  const { DataSource } = require('typeorm');
  const {
    withOmniNativeOwnershipTransaction,
  } = require('src/modules/omnichannel/services/omni-core-transaction');
  const base = 'src/engine/core-modules/application/application-manifest/';
  for (const [path, name] of [
    [
      base +
        'services/compute-application-manifest-all-universal-flat-entity-maps.service',
      'ComputeApplicationManifestAllUniversalFlatEntityMapsService',
    ],
    ['src/engine/core-modules/logger/logger.service', 'LoggerService'],
    [
      'src/engine/core-modules/workflow/services/workflow-version-core-sync.service',
      'WorkflowVersionCoreSyncService',
    ],
    [
      'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
      'ConnectedAccountMetadataService',
    ],
    [
      'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
      'WorkspaceMigrationValidateBuildAndRunService',
    ],
  ])
    jest.doMock(path, () => ({ [name]: class {} }));
  jest.doMock(
    base + 'utils/get-application-sub-all-flat-entity-maps.util',
    () => ({ getApplicationSubAllFlatEntityMaps: () => ({}) }),
  );
  jest.doMock(
    base + 'utils/assert-connection-provider-logic-functions-are-own.util',
    () => ({ assertConnectionProviderLogicFunctionsAreOwn: () => {} }),
  );
  jest.doMock(
    base + 'utils/add-workflow-manifests-to-flat-entity-maps-or-throw.util',
    () => ({ addWorkflowManifestsToFlatEntityMapsOrThrow: () => [] }),
  );
  jest.doMock(
    base +
      'utils/build-all-flat-entity-operation-record-by-metadata-name-from-from-to.util',
    () => ({
      buildAllFlatEntityOperationRecordByMetadataNameFromFromTo: () => ({
        connectionProvider: {
          flatEntityToDelete: {
            fixture: { universalIdentifier: 'fixture-provider' },
          },
        },
      }),
    }),
  );
  const providerId = randomUUID();
  jest.doMock(
    'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-universal-identifier-or-throw.util',
    () => ({
      findFlatEntityByUniversalIdentifierOrThrow: () => ({ id: providerId }),
    }),
  );
  const {
    ApplicationManifestMigrationService,
  } = require('src/engine/core-modules/application/application-manifest/application-manifest-migration.service');
  const db = new DataSource({
    type: 'postgres',
    url: process.env.FORK_MIGRATION_TEST_URL,
  });
  await db.initialize();
  const table = 'log125_' + randomUUID().replaceAll('-', '');
  const f = installFixture('omni');
  let lost: Error | undefined;
  try {
    await db.query('CREATE TABLE public."' + table + '" (id int PRIMARY KEY)');
    await db.query('INSERT INTO public."' + table + '" VALUES(1)');
    const realCreate = db.createQueryRunner.bind(db);
    db.createQueryRunner = (mode: string) => {
      const runner = realCreate(mode);
      const commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('fixture COMMIT ACK lost');
      };
      return runner;
    };
    const validate = jest.fn().mockResolvedValue({
      workspaceMigration: { actions: [] },
      hasSchemaMetadataChanged: true,
    });
    const ownerApplicationId = randomUUID();
    const ownerFlatApplication = {
      id: ownerApplicationId,
      universalIdentifier: f.f.registration.universalIdentifier,
    };
    const deletion = jest.fn(async () => {
      try {
        await withOmniNativeOwnershipTransaction(
          db,
          f.f.workspaceId,
          'shared',
          async (runner: any) => {
            await runner.query(
              'DELETE FROM public."' + table + '" WHERE id=1 RETURNING id',
            );
          },
        );
      } catch (error) {
        lost = error as Error;
        throw error;
      }
    });
    const migration = instance(ApplicationManifestMigrationService, {
      logger: { perf: () => {}, log: () => {} },
      workspaceCacheService: {
        getOrRecompute: async () => {
          ownerFlatApplication.id = randomUUID();
          return {};
        },
      },
      computeManifestFlatEntityMapsService: { compute: () => ({}) },
      validateBuildAndRunOrThrow: validate,
      connectedAccountMetadataService: {
        deleteManyByConnectionProviderIds: deletion,
      },
    });
    const application = {
      id: randomUUID(),
      version: null,
      logo: null,
      logoFileId: null,
    };
    Object.assign(f.service, {
      ensureApplicationExists: async () => application,
      writeFilesToStorage: async () => {},
      importLogoFile: async () => null,
      runPreInstallHook: async () => {},
      applicationManifestApplyService: {
        applyManifestToWorkspace: () =>
          migration.syncMetadataFromManifest({
            manifest: {
              ...f.input.resolvedPackage.manifest,
              logicFunctions: [],
              workflows: [],
            },
            workspaceId: f.f.workspaceId,
            ownerFlatApplication,
          }),
      },
    });
    await expect(
      f.service.runInstallWithMetrics(f.input),
    ).rejects.toBeInstanceOf(OmniCoreTransactionOutcomeUnknownError);
    expect(lost).toBeInstanceOf(OmniCoreTransactionOutcomeUnknownError);
    expect(f.compensation).not.toHaveBeenCalled();
    expect(
      f.service.eventLogEmitterService.recordApplicationPlatformEvents,
    ).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0][0].dryRun).toBe(true);
    expect(deletion).toHaveBeenCalledWith({
      connectionProviderIds: [providerId],
      workspaceId: f.f.workspaceId,
      applicationId: ownerApplicationId,
    });
    db.createQueryRunner = realCreate;
    expect(await db.query('SELECT * FROM public."' + table + '"')).toEqual([]);
  } finally {
    await db.query('DROP TABLE IF EXISTS public."' + table + '"');
    await db.destroy();
  }
});
