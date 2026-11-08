import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureCoreUserAndWorkspaceAudit,
  recordAuditedCoreUserUpdate,
  withCoreUserAndWorkspaceAudit,
} from 'src/engine/core-modules/crm-audit/core-user-and-workspace-audit';
import { runAuditedPasswordUpdate } from 'src/engine/core-modules/crm-audit/password-update-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

const decoratorAdapters: [string, string[]][] = [
  [
    'src/engine/core-modules/twenty-config/interfaces/support.interface',
    ['SupportDriver'],
  ],
  [
    'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
    ['MetadataResolver'],
  ],
  [
    'src/engine/api/graphql/graphql-config/decorators/admin-resolver.decorator',
    ['AdminResolver'],
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
    'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator',
    ['OnDatabaseBatchEvent'],
  ],
];

for (const [modPath, names] of decoratorAdapters) {
  jest.doMock(modPath, () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        function Adapter() {
          return function Decorator() {};
        },
      ]),
    ),
  );
}

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
    'core-modules/approved-access-domain/services/approved-access-domain.service',
    'ApprovedAccessDomainService',
  ],
  ['core-modules/auth/token/services/login-token.service', 'LoginTokenService'],
  [
    'core-modules/file/file-core-picture/services/file-core-picture.service',
    'FileCorePictureService',
  ],
  ['core-modules/file/file-url/file-url.service', 'FileUrlService'],
  [
    'core-modules/workspace-invitation/services/workspace-invitation.service',
    'WorkspaceInvitationService',
  ],
  [
    'metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    'RoleAssignmentValidationService',
  ],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  [
    'metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity',
    'DeferredWorkspaceMigrationActionEntity',
  ],
  [
    'core-modules/workflow/services/workflow-run-record-share.service',
    'WorkflowRunRecordShareService',
  ],
  ['core-modules/metrics/metrics.service', 'MetricsService'],
  [
    'metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    'WorkspaceManyOrAllFlatEntityMapsCacheService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service',
    'DeferredWorkspaceMigrationActionHandlerRegistryService',
  ],
  ['core-modules/email/email.service', 'EmailService'],
  ['core-modules/i18n/i18n.service', 'I18nService'],
  [
    'core-modules/event-logs/emit/event-log-emitter.service',
    'EventLogEmitterService',
  ],
  [
    'core-modules/two-factor-authentication/two-factor-authentication.service',
    'TwoFactorAuthenticationService',
  ],
]) {
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
}

jest.doMock('src/engine/core-modules/user/user.entity', () => ({
  UserEntity: class {},
}));
jest.doMock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({
    UserWorkspaceEntity: class {},
  }),
);
jest.mock('twenty-emails', () => ({
  ServerAdminAccessChangedEmail: jest.fn(),
  renderEmail: jest.fn(),
}));

const { UserEntity } = require('src/engine/core-modules/user/user.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { UserWorkspaceService } =
  require('src/engine/core-modules/user-workspace/user-workspace.service') as typeof import('src/engine/core-modules/user-workspace/user-workspace.service');
const { UserService } =
  require('src/engine/core-modules/user/services/user.service') as typeof import('src/engine/core-modules/user/services/user.service');
const { UserResolver } =
  require('src/engine/core-modules/user/user.resolver') as typeof import('src/engine/core-modules/user/user.resolver');
const { GlobalWorkspaceMemberListener } =
  require('src/engine/core-modules/user/services/global-workspace-member.listener') as typeof import('src/engine/core-modules/user/services/global-workspace-member.listener');
const { AdminPanelServerAdminService } =
  require('src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service') as typeof import('src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (
  !url ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname)
) {
  throw new Error('Dedicated test database required');
}

const role = 'core_user_ws_audit_' + randomUUID().replaceAll('-', '');

const userSchema = new EntitySchema({
  name: 'CoreUserAuditFixture',
  target: UserEntity,
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text', unique: true },
    firstName: { type: 'text', default: 'First' },
    lastName: { type: 'text', default: 'Last' },
    isEmailVerified: { type: 'boolean', default: false },
    canAccessFullAdminPanel: { type: 'boolean', default: true },
    canImpersonate: { type: 'boolean', default: false },
    passwordHash: { type: 'text', nullable: true },
    locale: { type: 'text', default: 'en' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const membershipSchema = new EntitySchema({
  name: 'UserWorkspaceAuditFixture',
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

const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [userSchema, membershipSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-core-user-ws-audit';

const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [userSchema, membershipSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const userId = randomUUID();
const otherUserId = randomUUID();
const impersonatorUserId = randomUUID();
const workspaceId = randomUUID();
const secondWorkspaceId = randomUUID();
const deletedWorkspaceId = randomUUID();
const impersonatorMembershipId = randomUUID();
const workspaceMemberId = randomUUID();
const roleId = randomUUID();
const apiKeyId = randomUUID();
const applicationId = randomUUID();

const invalidate = jest.fn<Promise<unknown>, unknown[]>();
const avatar = jest.fn<Promise<string>, unknown[]>();
const queueAdd = jest.fn<Promise<unknown>, unknown[]>();
const stepUp = jest.fn<Promise<void>, unknown[]>();
const notifyAdmins = jest.fn<Promise<void>, unknown[]>();
const emitAdminEvent = jest.fn<void, unknown[]>();
const assignRoleMock = jest.fn<Promise<void>, unknown[]>();

const userWorkspaceService = Object.create(
  UserWorkspaceService.prototype,
) as InstanceType<typeof UserWorkspaceService>;
Object.assign(userWorkspaceService, {
  userWorkspaceRepository: runtime.getRepository(UserWorkspaceEntity),
  userRepository: runtime.getRepository(UserEntity),
  coreEntityCacheService: { invalidate },
  computeDefaultAvatarUrl: avatar,
  checkUserWorkspaceExists: async (uId: string, wId: string) =>
    runtime.getRepository(UserWorkspaceEntity).findOneBy({
      userId: uId,
      workspaceId: wId,
    }),
  resolveRoleIdForNewMember: async () => roleId,
  createWorkspaceMember: async () => {},
  workspaceCacheService: { invalidateAndRecompute: async () => {} },
  userRoleService: { assignRoleToManyUserWorkspace: assignRoleMock },
  workspaceInvitationService: { invalidateWorkspaceInvitation: async () => {} },
  onboardingService: { setOnboardingCreateProfilePending: async () => {} },
  getUserWorkspaceForUserOrThrow: async ({
    userId: uId,
    workspaceId: wId,
  }: {
    userId: string;
    workspaceId: string;
  }) => {
    const row = await runtime.getRepository(UserWorkspaceEntity).findOneBy({
      userId: uId,
      workspaceId: wId,
    });
    if (!row) throw new Error('UserWorkspace not found');
    return row;
  },
  getUserWorkspaceForUser: async ({
    userId: uId,
    workspaceId: wId,
  }: {
    userId: string;
    workspaceId: string;
  }) =>
    runtime.getRepository(UserWorkspaceEntity).findOneBy({
      userId: uId,
      workspaceId: wId,
    }),
  countUserWorkspaces: async (uId: string) =>
    runtime
      .getRepository(UserWorkspaceEntity)
      .count({ where: { userId: uId } }),
  logger: new Logger('UserWorkspaceService'),
});

const userService = Object.create(UserService.prototype) as InstanceType<
  typeof UserService
>;
Object.assign(userService, {
  userRepository: runtime.getRepository(UserEntity),
  userWorkspaceService,
  coreEntityCacheService: { invalidate },
  workspaceQueueService: { add: queueAdd },
  twentyConfigService: {
    get: (key: string) =>
      key === 'IS_EMAIL_VERIFICATION_REQUIRED' ? false : 'production',
  },
  logger: new Logger('UserService'),
});

const adminService = Object.create(
  AdminPanelServerAdminService.prototype,
) as InstanceType<typeof AdminPanelServerAdminService>;
Object.assign(adminService, {
  userRepository: runtime.getRepository(UserEntity),
  coreEntityCacheService: { invalidate },
  twoFactorAuthenticationService: {
    assertFreshStepUpAuthenticationOrThrow: stepUp,
  },
  twentyConfigService: { get: () => 'production' },
  notifyAdministrators: notifyAdmins,
  emitServerAdminAccessChangedEvent: emitAdminEvent,
  logger: new Logger('AdminPanelServerAdminService'),
});

const hasSettingPermission = jest.fn<Promise<boolean>, unknown[]>();
const userResolver = Object.create(UserResolver.prototype) as InstanceType<
  typeof UserResolver
>;
Object.assign(userResolver, {
  userRepository: runtime.getRepository(UserEntity),
  userWorkspaceRepository: runtime.getRepository(UserWorkspaceEntity),
  userService,
  userWorkspaceService,
  permissionsService: {
    userHasWorkspaceSettingPermission: hasSettingPermission,
  },
  onboardingService: {
    completeOnboardingProfileStepIfNameProvided: async () => {},
  },
  workspaceOrmManager: {
    executeInWorkspaceContext: async <T>(fn: () => Promise<T> | T) => fn(),
    getRepository: () => ({
      findOne: async () => ({
        id: workspaceMemberId,
        userId,
      }),
      save: async (payload: unknown) => payload,
    }),
  },
});

const globalWorkspaceMemberListener = new GlobalWorkspaceMemberListener(
  { invalidateAndRecompute: async () => {} } as never,
  userWorkspaceService,
);

const audits = () =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, id ASC',
  );

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(`
    CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "deletedAt" timestamptz
    );
    CREATE TABLE core."appToken" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" uuid REFERENCES core."user"(id) ON DELETE CASCADE,
      "workspaceId" uuid,
      type text NOT NULL,
      value text,
      "expiresAt" timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
      "deletedAt" timestamptz,
      "revokedAt" timestamptz,
      context jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE core."userWorkspace"
      ADD FOREIGN KEY ("userId") REFERENCES core."user"(id) ON DELETE CASCADE,
      ADD FOREIGN KEY ("workspaceId") REFERENCES core.workspace(id);
    CREATE UNIQUE INDEX active_membership_idx
      ON core."userWorkspace"("userId", "workspaceId")
      WHERE "deletedAt" IS NULL;
  `);
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-core-user-ws-audit' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit TO "${role}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${role}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  invalidate.mockReset().mockResolvedValue(undefined);
  avatar
    .mockReset()
    .mockResolvedValue('https://cdn.example.test/secret-avatar.png');
  queueAdd.mockReset().mockResolvedValue(undefined);
  stepUp.mockReset().mockResolvedValue(undefined);
  notifyAdmins.mockReset().mockResolvedValue(undefined);
  emitAdminEvent.mockReset();
  assignRoleMock.mockReset().mockResolvedValue(undefined);
  hasSettingPermission.mockReset().mockResolvedValue(true);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

  await owner.query(`
    DROP TRIGGER IF EXISTS corrupt_audit_after ON crm_audit."crmAuditEntry";
    DROP FUNCTION IF EXISTS crm_audit.corrupt_audit_after();
    TRUNCATE core."appToken", core."userWorkspace", core."user", core.workspace, crm_audit."crmAuditEntry" CASCADE;
  `);

  await owner.query(
    `INSERT INTO core.workspace (id, "deletedAt") VALUES
      ($1, NULL),
      ($2, NULL),
      ($3, now())`,
    [workspaceId, secondWorkspaceId, deletedWorkspaceId],
  );
  await owner.query(
    `INSERT INTO core."user" (id, email, "isEmailVerified", "canAccessFullAdminPanel", "canImpersonate", "passwordHash", locale)
     VALUES
      ($1, 'before@example.test', false, true, false, 'initial-hash-secret', 'en'),
      ($2, 'admin@example.test', true, true, true, 'admin-hash-secret', 'en'),
      ($3, 'impersonator@example.test', true, true, true, 'imp-hash-secret', 'en')`,
    [userId, otherUserId, impersonatorUserId],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId", locale, "defaultAvatarUrl")
     VALUES ($1, $2, $3, 'en', NULL)`,
    [impersonatorMembershipId, impersonatorUserId, workspaceId],
  );
});

afterAll(async () => {
  jest.restoreAllMocks();
  await runtime.destroy();
  await owner.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
  await owner.destroy();
});

describe('LOG-173 coreUser and userWorkspace transactional audit', () => {
  it('audits userWorkspace create and locale update across direct, addUserToWorkspace, external runner, UserResolver (impersonation/apiKey/application), and GlobalWorkspaceMemberListener with synchronous pre-await capture', async () => {
    const mutableIdentity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: otherUserId },
      impersonatorUserWorkspaceId: impersonatorMembershipId,
      correlationId: 'corr-create-173',
    };
    avatar.mockImplementationOnce(async () => {
      mutableIdentity.actor.id = randomUUID();
      return 'https://cdn.example.test/secret-avatar-url.png';
    });

    const created = await userWorkspaceService.create({
      userId,
      workspaceId,
      isExistingUser: true,
      locale: 'en',
      auditIdentity: mutableIdentity,
    });

    let rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userWorkspace',
      resourceId: created.id,
      action: 'create',
      outcome: 'success',
      actor: { kind: 'coreUser', id: otherUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: 'corr-create-173',
      securityDescriptor: {
        resourceKind: 'userWorkspace',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
      redactedDiff: {
        changedFields: ['defaultAvatarUrl', 'deletedAt', 'locale', 'userId'],
        values: {
          userId: { before: null, after: userId },
          locale: { before: null, after: 'en' },
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain('secret-avatar-url.png');

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    const userRow = (await runtime
      .getRepository(UserEntity)
      .findOneByOrFail({ id: userId })) as InstanceType<typeof UserEntity>;
    await userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace(
      userRow,
      { id: secondWorkspaceId, defaultRoleId: roleId } as never,
      roleId,
    );
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: secondWorkspaceId,
      resourceKind: 'userWorkspace',
      action: 'create',
    });
    expect(assignRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: secondWorkspaceId,
        roleId,
        auditIdentity: expect.objectContaining({
          correlationId: rows[0].correlationId,
        }),
      }),
    );

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    const runner = runtime.createQueryRunner();
    await runner.startTransaction();
    try {
      const thirdUserId = randomUUID();
      await runner.query(
        `INSERT INTO core."user" (id, email) VALUES ($1, 'runner@example.test')`,
        [thirdUserId],
      );
      const inTxMembership = await userWorkspaceService.create(
        {
          userId: thirdUserId,
          workspaceId,
          isExistingUser: false,
          locale: 'fr-FR' as never,
        },
        runner,
      );
      expect(await audits()).toHaveLength(0);
      await runner.commitTransaction();
      rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId,
        resourceKind: 'userWorkspace',
        resourceId: inTxMembership.id,
        action: 'create',
        actor: { kind: 'coreUser', id: thirdUserId },
        redactedDiff: {
          values: {
            userId: { before: null, after: thirdUserId },
            locale: { before: null, after: 'fr-FR' },
          },
        },
      });
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await userResolver.updateWorkspaceMemberSettings(
      {
        workspaceMemberId,
        update: { locale: 'ru-RU' },
      } as never,
      { id: workspaceId } as never,
      created.id,
      undefined,
      workspaceMemberId,
      { id: userId } as never,
      undefined,
      { impersonatorUserWorkspaceId: impersonatorMembershipId },
    );

    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userWorkspace',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['locale'],
        values: {
          locale: { before: 'en', after: 'ru-RU' },
        },
      },
    });
    expect(invalidate).toHaveBeenCalledWith('userWorkspaceEntity', created.id);

    invalidate.mockClear();
    await userResolver.updateWorkspaceMemberSettings(
      {
        workspaceMemberId,
        update: { locale: 'ru-RU' },
      } as never,
      { id: workspaceId } as never,
      created.id,
      undefined,
      workspaceMemberId,
      { id: userId } as never,
      undefined,
    );
    expect(await audits()).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await userResolver.updateWorkspaceMemberSettings(
      {
        workspaceMemberId,
        update: { locale: 'de-DE' },
      } as never,
      { id: workspaceId } as never,
      undefined,
      { id: apiKeyId } as never,
      undefined,
      null,
      undefined,
    );
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userWorkspace',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['locale'],
        values: {
          locale: { before: 'ru-RU', after: 'de-DE' },
        },
      },
    });

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await userResolver.updateWorkspaceMemberSettings(
      {
        workspaceMemberId,
        update: { locale: 'es-ES' },
      } as never,
      { id: workspaceId } as never,
      created.id,
      undefined,
      workspaceMemberId,
      { id: otherUserId } as never,
      { id: applicationId } as never,
    );
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userWorkspace',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'application', id: applicationId },
      initiator: { kind: 'coreUser', id: otherUserId },
      redactedDiff: {
        changedFields: ['locale'],
        values: {
          locale: { before: 'de-DE', after: 'es-ES' },
        },
      },
    });

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await globalWorkspaceMemberListener.syncUserWorkspaceLocale({
      name: 'workspaceMember.updated',
      workspaceId,
      objectMetadata: {} as never,
      events: [
        {
          recordId: workspaceMemberId,
          userId: otherUserId,
          properties: {
            diff: { locale: { before: 'es-ES', after: 'it-IT' } },
            after: { userId, locale: 'it-IT' },
          },
        } as never,
      ],
    });
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'userWorkspace',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'coreUser', id: otherUserId },
      redactedDiff: {
        changedFields: ['locale'],
        values: {
          locale: { before: 'es-ES', after: 'it-IT' },
        },
      },
    });
  });

  it('audits coreUser updates for server-admin flags, email verification, email change, and password change across all active workspaces while redacting email and passwordHash', async () => {
    await userWorkspaceService.create({
      userId,
      workspaceId,
      isExistingUser: true,
      locale: 'en',
    });
    await userWorkspaceService.create({
      userId,
      workspaceId: secondWorkspaceId,
      isExistingUser: true,
      locale: 'en',
    });
    await owner.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId", locale)
       VALUES ($1, $2, $3, 'en')`,
      [randomUUID(), userId, deletedWorkspaceId],
    );
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    await adminService.updateServerAdminAccess({
      actor: {
        id: otherUserId,
        firstName: 'Admin',
        lastName: 'Actor',
      } as never,
      actorWorkspaceId: workspaceId,
      targetUserId: userId,
      canImpersonate: true,
      canAccessFullAdminPanel: false,
    });

    let rows = await audits();
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r: { workspaceId: string }) => r.workspaceId).sort(),
    ).toEqual([workspaceId, secondWorkspaceId].sort());
    expect(rows[0].correlationId).toBe(rows[1].correlationId);
    expect(rows[0].operationId).not.toBe(rows[1].operationId);
    for (const row of rows) {
      expect(row).toMatchObject({
        resourceKind: 'coreUser',
        resourceId: userId,
        action: 'update',
        actor: { kind: 'coreUser', id: otherUserId },
        securityDescriptor: {
          resourceKind: 'coreUser',
          resourceId: userId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
        redactedDiff: {
          changedFields: ['canAccessFullAdminPanel', 'canImpersonate'],
          values: {
            canAccessFullAdminPanel: { before: true, after: false },
            canImpersonate: { before: false, after: true },
          },
        },
      });
    }

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await withCoreUserAndWorkspaceAudit(
      {
        workspaceId,
        actor: { kind: 'coreUser', id: userId },
        correlationId: 'corr-verify-and-email-173',
      },
      async () => {
        await userService.markEmailAsVerified(userId);
        await userService.markEmailAsVerified(userId);
        await userService.updateEmailFromVerificationToken(
          userId,
          'UPDATED-SECRET@EXAMPLE.TEST',
        );
      },
    );

    rows = await audits();
    expect(rows).toHaveLength(4);
    const verifyRows = rows.filter(
      (r: { redactedDiff: { changedFields: string[] } }) =>
        r.redactedDiff.changedFields.includes('isEmailVerified'),
    );
    const emailRows = rows.filter(
      (r: { redactedDiff: { changedFields: string[] } }) =>
        r.redactedDiff.changedFields.includes('email'),
    );
    expect(verifyRows).toHaveLength(2);
    expect(emailRows).toHaveLength(2);
    for (const row of verifyRows) {
      expect(row).toMatchObject({
        resourceKind: 'coreUser',
        resourceId: userId,
        action: 'update',
        actor: { kind: 'coreUser', id: userId },
        correlationId: 'corr-verify-and-email-173',
        redactedDiff: {
          changedFields: ['isEmailVerified'],
          values: {
            isEmailVerified: { before: false, after: true },
          },
        },
      });
    }
    for (const row of emailRows) {
      expect(row).toMatchObject({
        resourceKind: 'coreUser',
        resourceId: userId,
        action: 'update',
        actor: { kind: 'coreUser', id: userId },
        correlationId: 'corr-verify-and-email-173',
        redactedDiff: {
          changedFields: ['email'],
          values: {},
        },
      });
    }
    expect(JSON.stringify(rows)).not.toMatch(
      /before@example\.test|updated-secret@example\.test|UPDATED-SECRET/i,
    );

    await owner.query(
      `DELETE FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2`,
      [userId, secondWorkspaceId],
    );
    await owner.query(
      `DELETE FROM core."userWorkspace" WHERE "userId" = $1 AND "workspaceId" = $2`,
      [userId, deletedWorkspaceId],
    );
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    await userResolver.updateUserEmail(
      { newEmail: 'impersonated-new@example.test' } as never,
      {
        id: userId,
        email: 'updated-secret@example.test',
        locale: 'en',
      } as never,
      {
        id: workspaceId,
        editableProfileFields: ['email'],
      } as never,
      { impersonatorUserWorkspaceId: impersonatorMembershipId },
    );
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'coreUser',
      resourceId: userId,
      action: 'update',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['email'],
        values: {},
      },
    });
    expect(JSON.stringify(rows)).not.toContain('impersonated-new@example.test');

    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    await runAuditedPasswordUpdate({
      dataSource: runtime,
      request: {
        expectedUserId: userId,
        actor: { kind: 'coreUser', id: userId },
        impersonatorUserWorkspaceId: impersonatorMembershipId,
        correlationId: 'corr-password-only-173',
      },
      userId,
      newPasswordHash: 'new-super-secret-password-hash',
      onInvalidResetToken: () => {
        throw new Error('invalid reset token');
      },
      onUserNotFound: () => {
        throw new Error('user not found');
      },
      onUserWorkspaceNotFound: () => {
        throw new Error('user workspace not found');
      },
    });
    rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'coreUser',
      resourceId: userId,
      action: 'update',
      actor: { kind: 'coreUser', id: userId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: 'corr-password-only-173',
      redactedDiff: {
        changedFields: ['passwordHash'],
        values: {},
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /initial-hash-secret|new-super-secret-password-hash/,
    );
  });

  it('rolls back userWorkspace and coreUser mutations on audit INSERT failure or post-flush trigger corruption, rejects request reuse, and classifies lost COMMIT ACK', async () => {
    const reusable = captureCoreUserAndWorkspaceAudit({
      fallbackUserId: userId,
      fallbackWorkspaceId: workspaceId,
    });
    const runner = runtime.createQueryRunner();
    await runner.startTransaction();
    try {
      await recordAuditedCoreUserUpdate({
        runner,
        request: reusable,
        userId,
        beforeSnapshot: { isEmailVerified: false },
        afterSnapshot: { isEmailVerified: false },
      });
      await expect(
        recordAuditedCoreUserUpdate({
          runner,
          request: reusable,
          userId,
          beforeSnapshot: { isEmailVerified: false },
          afterSnapshot: { isEmailVerified: true },
        }),
      ).rejects.toThrow('invalid or already consumed');
      await expect(
        userService.markEmailAsVerified(userId, runner, reusable),
      ).rejects.toThrow('invalid or already consumed');
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }

    const membership = await userWorkspaceService.create({
      userId,
      workspaceId,
      isExistingUser: true,
      locale: 'en',
    });
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${role}"`,
    );
    try {
      await expect(
        userWorkspaceService.create({
          userId,
          workspaceId: secondWorkspaceId,
          isExistingUser: true,
          locale: 'en',
        }),
      ).rejects.toThrow();
      await expect(
        userWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace({
          userWorkspaceId: membership.id,
          locale: 'ru-RU',
        }),
      ).rejects.toThrow();
      await expect(userService.markEmailAsVerified(userId)).rejects.toThrow();
      await expect(
        userService.updateEmailFromVerificationToken(
          userId,
          'blocked@example.test',
        ),
      ).rejects.toThrow();
      await expect(
        adminService.updateServerAdminAccess({
          actor: { id: otherUserId, firstName: 'A', lastName: 'B' } as never,
          actorWorkspaceId: workspaceId,
          targetUserId: userId,
          canImpersonate: true,
        }),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
      );
    }

    const persistedMemberships = await owner.query(
      'SELECT * FROM core."userWorkspace" WHERE "userId" = $1',
      [userId],
    );
    expect(persistedMemberships).toHaveLength(1);
    expect(persistedMemberships[0].locale).toBe('en');
    const persistedUser = (
      await owner.query('SELECT * FROM core."user" WHERE id = $1', [userId])
    )[0];
    expect(persistedUser).toMatchObject({
      email: 'before@example.test',
      isEmailVerified: false,
      canImpersonate: false,
    });
    expect(queueAdd).not.toHaveBeenCalled();
    expect(emitAdminEvent).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
    expect(await audits()).toHaveLength(0);

    await owner.query(`
      CREATE FUNCTION crm_audit.corrupt_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'userWorkspace' THEN
          UPDATE core."userWorkspace" SET locale = 'corrupted' WHERE id = NEW."resourceId"::uuid;
        ELSE
          UPDATE core."user" SET "canImpersonate" = false WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER corrupt_audit_after AFTER INSERT ON crm_audit."crmAuditEntry"
        FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit_after();
    `);

    await expect(
      userWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace({
        userWorkspaceId: membership.id,
        locale: 'de-DE',
      }),
    ).rejects.toThrow('Membership locale update effects mismatch');
    await expect(
      adminService.updateServerAdminAccess({
        actor: { id: otherUserId, firstName: 'A', lastName: 'B' } as never,
        actorWorkspaceId: workspaceId,
        targetUserId: userId,
        canImpersonate: true,
      }),
    ).rejects.toThrow('Server admin update changed before commit');

    await owner.query(`
      DROP TRIGGER corrupt_audit_after ON crm_audit."crmAuditEntry";
      DROP FUNCTION crm_audit.corrupt_audit_after();
    `);
    expect(
      (
        await owner.query(
          'SELECT locale FROM core."userWorkspace" WHERE id = $1',
          [membership.id],
        )
      )[0].locale,
    ).toBe('en');
    expect(
      (
        await owner.query(
          'SELECT "canImpersonate" FROM core."user" WHERE id = $1',
          [userId],
        )
      )[0].canImpersonate,
    ).toBe(false);
    expect(await audits()).toHaveLength(0);

    invalidate.mockClear();
    const createRunner = runtime.createQueryRunner.bind(runtime);
    let lostAckInjected = false;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const r = createRunner(mode);
      const connect = r.connect.bind(r);
      let wrapped = false;
      jest.spyOn(r, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!wrapped && !lostAckInjected) {
          wrapped = true;
          lostAckInjected = true;
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            const res = await query(sql, ...args);
            if (sql === 'COMMIT') {
              throw new Error('lost commit ack');
            }
            return res;
          };
        }
        return client;
      });
      return r;
    });

    await expect(
      userWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace({
        userWorkspaceId: membership.id,
        locale: 'ja-JP' as never,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(invalidate).toHaveBeenCalledWith(
      'userWorkspaceEntity',
      membership.id,
    );
    expect(
      (
        await owner.query(
          'SELECT locale FROM core."userWorkspace" WHERE id = $1',
          [membership.id],
        )
      )[0].locale,
    ).toBe('ja-JP');
    expect(await audits()).toHaveLength(1);
  });
});
