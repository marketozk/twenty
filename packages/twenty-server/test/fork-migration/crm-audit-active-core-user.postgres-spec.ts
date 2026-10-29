import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
const adapters: [string, string[]][] = [
  [
    'src/engine/core-modules/twenty-config/interfaces/support.interface',
    ['SupportDriver'],
  ],
  [
    'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
    ['MetadataResolver'],
  ],
  ['src/engine/core-modules/api-key/api-key.entity', ['ApiKeyEntity']],
  [
    'src/engine/core-modules/auth/dto/available-workspaces.dto',
    ['AvailableWorkspaces'],
  ],
  [
    'src/engine/core-modules/onboarding/enums/onboarding-status.enum',
    ['OnboardingStatus'],
  ],
  [
    'src/engine/core-modules/onboarding/onboarding.service',
    ['OnboardingService', 'OnboardingStepKeys'],
  ],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  [
    'src/engine/core-modules/two-factor-authentication/utils/two-factor-authentication-method.presenter',
    ['buildTwoFactorAuthenticationMethodSummary'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.service',
    ['UserWorkspaceService'],
  ],
  [
    'src/engine/core-modules/user/dtos/deleted-workspace-member.dto',
    ['DeletedWorkspaceMemberDTO'],
  ],
  [
    'src/engine/core-modules/user/dtos/update-user-email.input',
    ['UpdateUserEmailInput'],
  ],
  [
    'src/engine/core-modules/user/dtos/update-workspace-member-settings.input',
    ['UpdateWorkspaceMemberSettingsInput'],
  ],
  [
    'src/engine/core-modules/user/dtos/workspace-member.dto',
    ['WorkspaceMemberDTO'],
  ],
  [
    'src/engine/core-modules/user/services/workspace-member-transpiler.service',
    ['WorkspaceMemberTranspiler'],
  ],
  [
    'src/engine/core-modules/user/user-vars/services/user-vars.service',
    ['UserVarsService'],
  ],
  ['src/engine/core-modules/user/user.entity', ['UserEntity']],
  [
    'src/engine/core-modules/user/utils/assert-workspace-member-update-non-custom-fields.util',
    ['assertWorkspaceMemberUpdateUsesNonCustomFieldsOnly'],
  ],
  [
    'src/engine/core-modules/user/utils/assert-workspace-member-update-values-are-valid.util',
    ['assertWorkspaceMemberUpdateValuesAreValid'],
  ],
  [
    'src/engine/core-modules/workspace/types/workspace.type',
    ['AuthProviderEnum'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  [
    'src/engine/decorators/auth/auth-authenticated-at.decorator',
    ['AuthAuthenticatedAt'],
  ],
  ['src/engine/decorators/auth/auth-provider.decorator', ['AuthProvider']],
  [
    'src/engine/decorators/auth/auth-impersonation-context.decorator',
    ['AuthImpersonationContext'],
  ],
  [
    'src/engine/core-modules/auth/utils/can-credential-auto-login-into-workspaces.util',
    ['canCredentialAutoLoginIntoWorkspaces'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  [
    'src/engine/decorators/auth/auth-is-user-session.decorator',
    ['AuthIsUserSession'],
  ],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  [
    'src/engine/decorators/auth/auth-workspace-member-id.decorator',
    ['AuthWorkspaceMemberId'],
  ],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/allow-suspended-workspace.decorator',
    ['AllowSuspendedWorkspace'],
  ],
  ['src/engine/guards/custom-permission.guard', ['CustomPermissionGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/role/utils/fromUserWorkspacePermissionsToUserWorkspacePermissionsDto',
    ['fromUserWorkspacePermissionsToUserWorkspacePermissionsDto'],
  ],
  [
    'src/engine/metadata-modules/user-role/user-role.service',
    ['UserRoleService'],
  ],
  ['src/engine/twenty-orm/workspace-orm.manager', ['WorkspaceOrmManager']],
  [
    'src/engine/twenty-orm/utils/build-system-auth-context.util',
    ['buildSystemAuthContext'],
  ],
  [
    'src/modules/connected-account/types/accounts-to-reconnect-key-value.type',
    ['AccountsToReconnectKeys'],
  ],
  [
    'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
    ['WorkspaceMemberWorkspaceEntity'],
  ],
  [
    'src/engine/core-entity-cache/services/core-entity-cache.service',
    ['CoreEntityCacheService'],
  ],
  [
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  [
    'src/engine/core-modules/email-verification/email-verification.constants',
    ['EmailVerificationTrigger'],
  ],
  [
    'src/engine/core-modules/email-verification/services/email-verification.service',
    ['EmailVerificationService'],
  ],
  [
    'src/engine/core-modules/graphql/utils/graphql-errors.util',
    ['UserInputError'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/message-queue.decorator',
    ['InjectMessageQueue'],
  ],
  [
    'src/engine/core-modules/message-queue/message-queue.constants',
    ['MessageQueue'],
  ],
  [
    'src/engine/core-modules/message-queue/services/message-queue.service',
    ['MessageQueueService'],
  ],
  [
    'src/engine/core-modules/user/jobs/update-workspace-member-email.job',
    ['UpdateWorkspaceMemberEmailJob', 'UpdateWorkspaceMemberEmailJobData'],
  ],
  [
    'src/engine/core-modules/workspace/services/workspace.service',
    ['WorkspaceService'],
  ],
  [
    'src/engine/core-modules/record-share/services/record-share-ownership-transfer.service',
    ['RecordShareOwnershipTransferService'],
  ],
  [
    'src/engine/metadata-modules/connected-account/services/connected-account-ownership-transfer.service',
    ['ConnectedAccountOwnershipTransferService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/utils/detach-agent-chat-channel-threads-from-workspace-member.util',
    ['detachAgentChatChannelThreadsFromWorkspaceMember'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity',
    ['AgentChatThreadWorkspaceEntity'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository',
    ['AgentHistoryRepository'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-history/repositories/inject-agent-history-repository.decorator',
    ['InjectAgentHistoryRepository'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars',
    ['UUIDScalarType'],
  ],
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  [
    'src/engine/core-modules/application/dtos/application.dto',
    ['ApplicationDTO'],
  ],
  [
    'src/engine/core-modules/application/utils/from-flat-application-to-application-dto.util',
    ['fromFlatApplicationToApplicationDto'],
  ],
  [
    'src/engine/core-modules/application/utils/get-scoped-calling-application.util',
    ['getScopedCallingApplication'],
  ],
  [
    'src/engine/core-modules/billing/dtos/billing-entitlement.dto',
    ['BillingEntitlementDTO'],
  ],
  [
    'src/engine/core-modules/billing/entities/billing-customer.entity',
    ['BillingCustomerEntity'],
  ],
  [
    'src/engine/core-modules/billing/entities/billing-subscription.entity',
    ['BillingSubscriptionEntity'],
  ],
  [
    'src/engine/core-modules/billing/services/billing-subscription.service',
    ['BillingSubscriptionService'],
  ],
  [
    'src/engine/core-modules/dns-manager/dtos/domain-valid-records',
    ['DomainValidRecords'],
  ],
  [
    'src/engine/core-modules/dns-manager/services/dns-manager.service',
    ['DnsManagerService'],
  ],
  [
    'src/engine/core-modules/domain/custom-domain-manager/services/custom-domain-manager.service',
    ['CustomDomainManagerService'],
  ],
  [
    'src/engine/core-modules/enterprise/services/enterprise-plan.service',
    ['EnterprisePlanService'],
  ],
  [
    'src/engine/core-modules/feature-flag/dtos/feature-flag.dto',
    ['FeatureFlagDTO'],
  ],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  [
    'src/engine/core-modules/file/file-url/file-url.service',
    ['FileUrlService'],
  ],
  [
    'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
    ['PreventNestToAutoLogGraphqlErrorsFilter'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  [
    'src/engine/core-modules/workspace/dtos/activate-workspace-input',
    ['ActivateWorkspaceInput'],
  ],
  [
    'src/engine/core-modules/workspace/dtos/public-workspace-data.dto',
    ['PublicWorkspaceDataDTO', 'PublicWorkspaceDataSummaryDTO'],
  ],
  [
    'src/engine/core-modules/workspace/dtos/update-workspace-allowed-iframe-origins.input',
    ['UpdateWorkspaceAllowedIframeOriginsInput'],
  ],
  [
    'src/engine/core-modules/workspace/dtos/update-workspace-input',
    ['UpdateWorkspaceInput'],
  ],
  [
    'src/engine/core-modules/workspace/dtos/workspace-urls.dto',
    ['WorkspaceUrlsDTO'],
  ],
  [
    'src/engine/core-modules/workspace/utils/get-auth-bypass-providers-by-workspace.util',
    ['getAuthBypassProvidersByWorkspace'],
  ],
  [
    'src/engine/core-modules/workspace/utils/get-auth-providers-by-workspace.util',
    ['getAuthProvidersByWorkspace'],
  ],
  [
    'src/engine/core-modules/workspace/utils/workspace-graphql-api-exception-handler.util',
    ['workspaceGraphqlApiExceptionHandler'],
  ],
  [
    'src/engine/core-modules/workspace/workspace.exception',
    [
      'WorkspaceException',
      'WorkspaceExceptionCode',
      'WorkspaceNotFoundDefaultError',
    ],
  ],
  ['src/engine/guards/public-endpoint.guard', ['PublicEndpointGuard']],
  ['src/engine/metadata-modules/role/dtos/role.dto', ['RoleDTO']],
  ['src/engine/metadata-modules/role/role.service', ['RoleService']],
  ['src/engine/metadata-modules/view/dtos/view.dto', ['ViewDTO']],
  ['src/engine/metadata-modules/view/services/view.service', ['ViewService']],
  ['src/utils/extract-request', ['getRequest']],
];
for (const [path, names] of adapters.filter(
  ([path]) => !path.endsWith('graphql-errors.util'),
))
  jest.doMock(path, () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        function Adapter() {
          return function Decorator() {};
        },
      ]),
    ),
  );

for (const [path, name] of [
  ['email/email.service', 'EmailService'],
  ['i18n/i18n.service', 'I18nService'],
  ['event-logs/emit/event-log-emitter.service', 'EventLogEmitterService'],
  [
    'two-factor-authentication/two-factor-authentication.service',
    'TwoFactorAuthenticationService',
  ],
])
  jest.doMock('src/engine/core-modules/' + path, () => ({ [name]: class {} }));
jest.doMock('src/engine/core-modules/user/user.entity', () => ({
  UserEntity: class {},
}));
jest.mock('twenty-emails', () => ({
  ServerAdminAccessChangedEmail: jest.fn(),
  renderEmail: jest.fn(),
}));
const { UserEntity } = require('src/engine/core-modules/user/user.entity');
const { UserService } =
  require('src/engine/core-modules/user/services/user.service') as typeof import('src/engine/core-modules/user/services/user.service');
const { AdminPanelServerAdminService } =
  require('src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service') as typeof import('src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service');
const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const userId = randomUUID(),
  otherUserId = randomUUID(),
  workspaceId = randomUUID();
const role = 'active_user_' + randomUUID().replaceAll('-', '');
const userSchema = new EntitySchema({
  name: 'ActiveUserFixture',
  target: UserEntity,
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text', unique: true },
    firstName: { type: 'text', default: 'Before' },
    lastName: { type: 'text', default: '' },
    isEmailVerified: { type: 'boolean', default: false },
    canAccessFullAdminPanel: { type: 'boolean', default: true },
    canImpersonate: { type: 'boolean', default: false },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [userSchema],
  extra: { max: 7, statement_timeout: 12000 },
});
const restricted = new URL(url);
restricted.username = role;
restricted.password = 'isolated-active-user';
const runtime = new DataSource({
  type: 'postgres',
  url: restricted.toString(),
  entities: [userSchema],
  extra: { max: 7, statement_timeout: 12000 },
});
const invalidate = jest.fn<Promise<unknown>, unknown[]>(),
  queue = jest.fn<Promise<unknown>, unknown[]>(),
  stepUp = jest.fn<Promise<void>, unknown[]>();
const notify = jest.fn<Promise<void>, unknown[]>(),
  emit = jest.fn<void, unknown[]>();
const service = Object.create(UserService.prototype) as InstanceType<
  typeof UserService
>;
Object.assign(service, {
  userRepository: runtime.getRepository(UserEntity),
  coreEntityCacheService: { invalidate },
  workspaceQueueService: { add: queue },
  logger: new Logger('UserService'),
});
const admin = Object.create(
  AdminPanelServerAdminService.prototype,
) as InstanceType<typeof AdminPanelServerAdminService>;
Object.assign(admin, {
  userRepository: runtime.getRepository(UserEntity),
  coreEntityCacheService: { invalidate },
  twoFactorAuthenticationService: {
    assertFreshStepUpAuthenticationOrThrow: stepUp,
  },
  twentyConfigService: { get: () => 'production' },
  notifyAdministrators: notify,
  emitServerAdminAccessChangedEvent: emit,
  logger: new Logger('AdminPanelServerAdminService'),
});
const actor = {
  id: otherUserId,
  firstName: 'Actor',
  lastName: 'Test',
} as Parameters<typeof admin.updateServerAdminAccess>[0]['actor'];
const changeAdmin = (
  changes: Partial<Parameters<typeof admin.updateServerAdminAccess>[0]> = {},
) =>
  admin.updateServerAdminAccess({
    actor,
    actorWorkspaceId: workspaceId,
    targetUserId: userId,
    canImpersonate: true,
    ...changes,
  });
const change = (kind: string) =>
  kind === 'verification'
    ? service.markEmailAsVerified(userId)
    : kind === 'email'
      ? service.updateEmailFromVerificationToken(userId, 'NEW@EXAMPLE.TEST')
      : changeAdmin();
const user = async (id = userId) =>
  (await owner.query('SELECT * FROM core."user" WHERE id=$1', [id]))[0];
const deactivate = () =>
  deactivateCoreUserWithAudit({
    dataSource: runtime,
    userEntity: UserEntity,
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
  throw new Error('Expected SQL lock wait');
};
const pauseNextCommit = () => {
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const create = runtime.createQueryRunner.bind(runtime);
  let paused = false;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      commit = runner.commitTransaction.bind(runner);
    jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
      if (!paused) {
        paused = true;
        reached();
        await barrier;
      }
      return commit();
    });
    return runner;
  });
  return { release, held };
};
beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query('CREATE TABLE core.workspace(id uuid PRIMARY KEY)');
  await owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid REFERENCES core."user"(id),"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    'CREATE ROLE "' +
      role +
      '" LOGIN PASSWORD \'isolated-active-user\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "' +
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
  invalidate.mockReset().mockResolvedValue(undefined);
  queue.mockReset().mockResolvedValue(undefined);
  stepUp.mockReset().mockResolvedValue(undefined);
  notify.mockReset().mockResolvedValue(undefined);
  emit.mockReset();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_user ON core."user"; DROP FUNCTION IF EXISTS core.corrupt_user(); TRUNCATE core."user",core."userWorkspace",crm_audit."crmAuditEntry" CASCADE',
  );
  await owner.query(
    "INSERT INTO core.\"user\"(id,email) VALUES($1,'before@example.test'),($2,'other@example.test')",
    [userId, otherUserId],
  );
});
afterAll(async () => {
  jest.restoreAllMocks();
  await runtime.destroy();
  await owner.query('DROP OWNED BY "' + role + '"; DROP ROLE "' + role + '"');
  await owner.destroy();
});
it('verification returns the updated entity without overwriting unrelated values', async () => {
  const result = await service.markEmailAsVerified(userId);
  expect(result).toBeInstanceOf(UserEntity);
  expect(result).toMatchObject({
    id: userId,
    isEmailVerified: true,
    email: 'before@example.test',
    deletedAt: null,
    firstName: 'Before',
  });
  expect(invalidate).toHaveBeenCalledWith('user', userId);
  expect(queue).not.toHaveBeenCalled();
});
it('email preserves lowercase normalization and queues the actual committed address', async () => {
  const result = await service.updateEmailFromVerificationToken(
    userId,
    ' NEW@EXAMPLE.TEST ',
  );
  expect(result).toBeInstanceOf(UserEntity);
  expect(result.email).toBe(' new@example.test ');
  expect(queue).toHaveBeenCalledWith(
    expect.anything(),
    { userId, email: ' new@example.test ' },
    { retryLimit: 2 },
  );
});
it('caller verification sees an uncommitted user and neither commits nor invalidates cache', async () => {
  const runner = runtime.createQueryRunner();
  await runner.startTransaction();
  const id = randomUUID();
  try {
    await runner.query(
      'INSERT INTO core."user"(id,email) VALUES($1,\'new@example.test\')',
      [id],
    );
    const commit = jest.spyOn(runner, 'commitTransaction');
    expect(await service.markEmailAsVerified(id, runner)).toMatchObject({
      id,
      isEmailVerified: true,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(await user(id)).toBeUndefined();
    await runner.rollbackTransaction();
    expect(await user(id)).toBeUndefined();
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
  }
});
it.each(['inactive', 'released', 'foreign'])(
  'verification refuses a %s supplied runner',
  async (kind) => {
    const runner = (kind === 'foreign' ? owner : runtime).createQueryRunner();
    if (kind === 'foreign') await runner.startTransaction();
    if (kind === 'released') await runner.release();
    try {
      await expect(service.markEmailAsVerified(userId, runner)).rejects.toThrow(
        'active transaction',
      );
      expect((await user()).isEmailVerified).toBe(false);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (!runner.isReleased) await runner.release();
    }
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s cannot change a missing or deactivated user',
  async (kind) => {
    await owner.query('UPDATE core."user" SET "deletedAt"=now() WHERE id=$1', [
      userId,
    ]);
    await expect(change(kind)).rejects.toThrow();
    expect((await user()).deletedAt).toBeTruthy();
    await owner.query('DELETE FROM core."user" WHERE id=$1', [userId]);
    await expect(change(kind)).rejects.toThrow();
    expect(await user()).toBeUndefined();
    expect(queue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s sees unrelated changes committed while waiting and does not overwrite them',
  async (kind) => {
    const runner = owner.createQueryRunner();
    await runner.startTransaction();
    await runner.query(
      'UPDATE core."user" SET "firstName"=\'Concurrent\' WHERE id=$1',
      [userId],
    );
    const pending = settle(change(kind));
    try {
      await waitForLock();
      await runner.commitTransaction();
      expect(await pending).toMatchObject({
        value: expect.objectContaining({ firstName: 'Concurrent' }),
      });
      expect((await user()).firstName).toBe('Concurrent');
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await pending;
    }
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s cannot reinsert after hard deletion committed during its wait',
  async (kind) => {
    const runner = owner.createQueryRunner();
    await runner.startTransaction();
    await runner.query('DELETE FROM core."user" WHERE id=$1', [userId]);
    const pending = settle(change(kind));
    try {
      await waitForLock();
      await runner.commitTransaction();
      expect(await pending).toHaveProperty('error');
      expect(await user()).toBeUndefined();
      expect(queue).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await pending;
    }
  },
);
it.each(['verification', 'email', 'admin'])(
  'deactivation first prevents waiting %s from restoring the account',
  async (kind) => {
    const barrier = pauseNextCommit(),
      removing = settle(deactivate());
    await barrier.held;
    const updating = settle(change(kind));
    try {
      await waitForLock();
      barrier.release();
      expect(await removing).toEqual({ value: 'deleted' });
      expect(await updating).toHaveProperty('error');
      expect((await user()).deletedAt).toBeTruthy();
      expect(queue).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await removing;
      await updating;
    }
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s first holds the account until commit then deactivation succeeds',
  async (kind) => {
    const barrier = pauseNextCommit(),
      updating = settle(change(kind));
    await barrier.held;
    const removing = settle(deactivate());
    try {
      await waitForLock();
      barrier.release();
      expect(await updating).toHaveProperty('value');
      expect(await removing).toEqual({ value: 'deleted' });
      expect((await user()).deletedAt).toBeTruthy();
    } finally {
      barrier.release();
      await updating;
      await removing;
    }
  },
);
it('admin retains a fresh target after OTP and preserves omitted flags', async () => {
  stepUp.mockImplementationOnce(async () => {
    await owner.query(
      'UPDATE core."user" SET "firstName"=\'After OTP\',"canAccessFullAdminPanel"=false WHERE id=$1',
      [userId],
    );
  });
  expect(await changeAdmin()).toMatchObject({
    firstName: 'After OTP',
    canImpersonate: true,
    canAccessFullAdminPanel: false,
  });
  expect(stepUp).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
});
it('deletion during OTP is rejected instead of saving the pre-OTP entity', async () => {
  stepUp.mockImplementationOnce(async () => {
    await owner.query('DELETE FROM core."user" WHERE id=$1', [userId]);
  });
  await expect(changeAdmin()).rejects.toThrow('User not found');
  expect(await user()).toBeUndefined();
  expect(emit).not.toHaveBeenCalled();
});
it('a stale apparent no-op is recomputed after OTP', async () => {
  stepUp.mockImplementationOnce(async () => {
    await owner.query(
      'UPDATE core."user" SET "canImpersonate"=true WHERE id=$1',
      [userId],
    );
  });
  expect(await changeAdmin({ canImpersonate: false })).toMatchObject({
    canImpersonate: false,
  });
  expect(emit).toHaveBeenCalledTimes(1);
});
it('a newly promoted last admin cannot be demoted using its pre-OTP flags', async () => {
  await owner.query('UPDATE core."user" SET "canAccessFullAdminPanel"=false');
  stepUp.mockImplementationOnce(async () => {
    await owner.query(
      'UPDATE core."user" SET "canAccessFullAdminPanel"=true WHERE id=$1',
      [userId],
    );
  });
  await expect(
    changeAdmin({ canAccessFullAdminPanel: false, canImpersonate: undefined }),
  ).rejects.toThrow('last server administrator');
  expect((await user()).canAccessFullAdminPanel).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});
it('concurrent full-admin demotions leave one active administrator', async () => {
  const results = await Promise.allSettled([
    changeAdmin({ canAccessFullAdminPanel: false }),
    changeAdmin({ targetUserId: otherUserId, canAccessFullAdminPanel: false }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: expect.objectContaining({
      message: expect.stringContaining('last server administrator'),
    }),
  });
  expect(
    await owner.query(
      'SELECT id FROM core."user" WHERE "deletedAt" IS NULL AND "canAccessFullAdminPanel"=true',
    ),
  ).toHaveLength(1);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
});
it('an actual no-op does not emit notifications', async () => {
  expect(await changeAdmin({ canImpersonate: false })).toMatchObject({
    canImpersonate: false,
  });
  expect(emit).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});
it('OTP failure performs no update', async () => {
  stepUp.mockRejectedValueOnce(new Error('OTP required'));
  await expect(changeAdmin()).rejects.toThrow('OTP required');
  expect((await user()).canImpersonate).toBe(false);
  expect(emit).not.toHaveBeenCalled();
});
it.each(['verification', 'email', 'admin'])(
  '%s detects trigger-suppressed writes and does not publish effects',
  async (kind) => {
    await owner.query(
      'CREATE FUNCTION core.corrupt_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER corrupt_user BEFORE UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION core.corrupt_user()',
    );
    await expect(change(kind)).rejects.toThrow();
    expect((await user()).email).toBe('before@example.test');
    expect((await user()).isEmailVerified).toBe(false);
    expect((await user()).canImpersonate).toBe(false);
    expect(queue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s reports unknown COMMIT without retry or postcommit notifications',
  async (kind) => {
    const create = runtime.createQueryRunner.bind(runtime);
    let commits = 0;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = create(mode),
        connect = runner.connect.bind(runner);
      if (mode !== 'master') return runner;
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
    await expect(change(kind)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(commits).toBe(1);
    expect(invalidate).toHaveBeenCalledWith('user', userId);
    expect(queue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const persisted = await user();
    expect(
      kind === 'verification'
        ? persisted.isEmailVerified
        : kind === 'email'
          ? persisted.email === 'new@example.test'
          : persisted.canImpersonate,
    ).toBe(true);
  },
);
it.each(['verification', 'email', 'admin'])(
  '%s logs failed invalidation without masking a committed result',
  async (kind) => {
    invalidate.mockRejectedValueOnce(new Error('cache down'));
    await expect(change(kind)).resolves.toBeDefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('cache invalidation failed'),
    );
  },
);
