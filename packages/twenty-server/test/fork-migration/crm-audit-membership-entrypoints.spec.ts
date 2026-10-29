import { randomUUID } from 'node:crypto';
import { deleteNativeWorkspaceMemberWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-workspace-member-with-audit';
jest.mock(
  'src/engine/core-modules/crm-audit/delete-native-workspace-member-with-audit',
  () => ({ deleteNativeWorkspaceMemberWithAudit: jest.fn() }),
);
const deleteNativeMember = jest.mocked(deleteNativeWorkspaceMemberWithAudit);
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
jest.mock(
  'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit',
  () => ({
    deactivateCoreUserWithAudit: jest.fn().mockResolvedValue('deleted'),
  }),
);
const deactivateUser = jest.mocked(deactivateCoreUserWithAudit);
import {
  captureMembershipCleanupIdentity,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

// Real entrypoint and orchestration methods; unrelated DI and decorators are adapters.
const adapters: [string, string[]][] = [
  [
    'src/engine/core-modules/application/application-exception-filter',
    ['ApplicationExceptionFilter'],
  ],
  [
    'src/engine/decorators/auth/application-target-arg.decorator',
    ['ApplicationTargetArg'],
  ],
  ['src/engine/guards/application-target.guard', ['ApplicationTargetGuard']],
  [
    'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
    ['ConnectedAccountMetadataService'],
  ],
  [
    'src/engine/metadata-modules/connected-account/dtos/connected-account.dto',
    ['ConnectedAccountDTO'],
  ],
  [
    'src/engine/metadata-modules/connected-account/dtos/connected-account-public.dto',
    ['ConnectedAccountPublicDTO'],
  ],
  [
    'src/engine/metadata-modules/connected-account/dtos/application-connected-account.dto',
    ['ApplicationConnectedAccountDTO'],
  ],
  [
    'src/engine/metadata-modules/connected-account/interceptors/connected-account-graphql-api-exception.interceptor',
    ['ConnectedAccountGraphqlApiExceptionInterceptor'],
  ],
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
  [
    'src/engine/api/graphql/workspace-query-runner/workspace-query-hook/decorators/workspace-query-hook.decorator',
    ['WorkspaceQueryHook'],
  ],
];
for (const [path, names] of adapters)
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
const { UserResolver } =
  require('src/engine/core-modules/user/user.resolver') as typeof import('src/engine/core-modules/user/user.resolver');
const { UserService } =
  require('src/engine/core-modules/user/services/user.service') as typeof import('src/engine/core-modules/user/services/user.service');
const { WorkspaceResolver } =
  require('src/engine/core-modules/workspace/workspace.resolver') as typeof import('src/engine/core-modules/workspace/workspace.resolver');
const { WorkspaceMemberDeleteOnePostQueryHook } =
  require('src/modules/workspace-member/query-hooks/workspace-member-delete-one.post-query.hook') as typeof import('src/modules/workspace-member/query-hooks/workspace-member-delete-one.post-query.hook');
const { ConnectedAccountResolver } =
  require('src/engine/metadata-modules/connected-account/resolvers/connected-account.resolver') as typeof import('src/engine/metadata-modules/connected-account/resolvers/connected-account.resolver');

it('account disconnect resolver captures server identity and caller before the first await', async () => {
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    memberId = randomUUID(),
    applicationId = randomUUID(),
    id = randomUUID();
  const workspace = { id: workspaceId },
    application = { id: applicationId },
    request = {
      user: { id: userId },
      application: { id: applicationId },
      body: { actor: { kind: 'system', id: 'spoof' } },
    };
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = {
    workspaceId,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    actor: { kind: 'application', id: applicationId },
    initiator: { kind: 'coreUser', id: userId },
  };
  const capture = jest.fn(async (authentication) => {
    const identity = await captureMembershipCleanupIdentity(
      authentication,
      async () => undefined,
    );
    await pause;
    expect(identity.actor).toEqual(operation.actor);
    expect(identity.initiator).toEqual(operation.initiator);
    return operation;
  });
  const verify = jest.fn().mockResolvedValue(undefined),
    disconnect = jest
      .fn()
      .mockResolvedValue({ id, scope: 'USER', connectionParameters: null });
  const resolver = new ConnectedAccountResolver({
    captureDisconnectionAuditOperation: capture,
    verifyAdministrableByCaller: verify,
    disconnect,
  } as never);
  const result = resolver.disconnectConnectedAccount(
    id,
    workspace as never,
    memberId,
    { req: request } as never,
    application as never,
  );
  workspace.id = randomUUID();
  application.id = randomUUID();
  request.user.id = randomUUID();
  request.application.id = randomUUID();
  release();
  expect(await result).toMatchObject({ id });
  expect(disconnect).toHaveBeenCalledWith({
    id,
    workspaceId,
    caller: { userWorkspaceId: memberId, applicationId },
    auditOperation: operation,
  });
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
    disconnect.mock.invocationCallOrder[0],
  );
});

const fixture = () => {
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    actorId = randomUUID(),
    membershipId = randomUUID(),
    nativeId = randomUUID();
  const membership = { id: membershipId, workspaceId, userId };
  const target = { id: nativeId, userId };
  let nativeDeleted = false;
  const nativeRepository = {
    findOne: jest.fn().mockResolvedValue(target),
    find: jest
      .fn()
      .mockResolvedValue([target, { id: randomUUID(), userId: actorId }]),
    delete: jest.fn(async () => {
      nativeDeleted = true;
    }),
  };
  const orm = {
    executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    runInWorkspaceTransaction: jest.fn(
      async (work: (scope: never) => Promise<unknown>, options: unknown) => {
        expect(options).toEqual({
          commitOutcome: 'strict',
          nativeOwnershipLock: 'exclusive',
        });
        return work({} as never);
      },
    ),
    getRepository: () => nativeRepository,
  };
  deleteNativeMember.mockImplementation(async () => {
    nativeDeleted = true;
    return true;
  });
  const capture = jest.fn(
    (input: Parameters<typeof captureMembershipCleanupIdentity>[0]) =>
      captureMembershipCleanupIdentity(input, async () => actorId),
  );
  const cleanup = jest.fn(async (_input: unknown) => {
    expect(nativeDeleted).toBe(true);
  });
  const coreUserRepository = {
    manager: { connection: {} },
    findOne: jest
      .fn()
      .mockResolvedValue({ id: userId, userWorkspaces: [membership] }),
    softDelete: jest.fn().mockResolvedValue(undefined),
  };
  const workspaceService = {
    suspendWorkspace: jest.fn().mockResolvedValue(undefined),
    deleteWorkspace: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(UserService.prototype) as InstanceType<
    typeof UserService
  >;
  Object.assign(service, {
    userRepository: coreUserRepository,
    workspaceOrmManager: orm,
    userRoleService: {
      validateUserWorkspaceIsNotUniqueAdminOrThrow: jest
        .fn()
        .mockResolvedValue(undefined),
    },
    connectedAccountOwnershipTransferService: {
      transferConnectedAccountsOwnershipToCustodian: jest
        .fn()
        .mockResolvedValue(undefined),
    },
    recordShareOwnershipTransferService: {
      transferRecordSharesToCustodian: jest.fn().mockResolvedValue(undefined),
    },
    workspaceCacheService: {
      getOrRecompute: async () => ({ flatFieldMetadataMaps: {} }),
      invalidateAndRecompute: jest.fn().mockResolvedValue(undefined),
    },
    agentChatThreadRepository: {
      delete: jest.fn().mockResolvedValue(undefined),
    },
    userWorkspaceService: { deleteUserWorkspace: cleanup },
    coreEntityCacheService: {
      invalidate: jest.fn().mockResolvedValue(undefined),
    },
    workspaceService,
  });
  const resolver = Object.create(UserResolver.prototype) as InstanceType<
    typeof UserResolver
  >;
  Object.assign(resolver, {
    userService: service,
    userWorkspaceService: { captureCleanupAuditIdentity: capture },
    workspaceOrmManager: orm,
    permissionsService: { userHasWorkspaceSettingPermission: async () => true },
  });
  const postHook = Object.create(
    WorkspaceMemberDeleteOnePostQueryHook.prototype,
  ) as InstanceType<typeof WorkspaceMemberDeleteOnePostQueryHook>;
  Object.assign(postHook, service, {
    userWorkspaceRepository: { findOne: async () => membership },
  });
  return {
    postHook,
    resolver,
    service,
    transfer:
      service['connectedAccountOwnershipTransferService']
        .transferConnectedAccountsOwnershipToCustodian,
    capture,
    cleanup,
    nativeRepository,
    coreUserRepository,
    workspaceService,
    workspaceId,
    userId,
    actorId,
    membershipId,
    nativeId,
  };
};
beforeEach(() => {
  jest.clearAllMocks();
  deactivateUser.mockResolvedValue('deleted');
});

it.each([false, true])(
  'actual member removal retains actor after native deletion (application=%s)',
  async (viaApplication) => {
    const f = fixture(),
      applicationId = randomUUID();
    await f.resolver.deleteUserFromWorkspace(
      f.nativeId,
      { id: f.actorId } as never,
      randomUUID(),
      { id: f.workspaceId } as never,
      undefined,
      !viaApplication,
      viaApplication ? ({ id: applicationId } as never) : undefined,
      undefined,
    );
    expect(deleteNativeMember).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: f.userId,
        workspaceMemberId: f.nativeId,
      }),
    );
    const coreOperation = deactivateUser.mock.calls[0][0].auditOperations[0]!;
    expect(f.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        auditOperation: expect.objectContaining({
          actor: coreOperation.actor,
          correlationId: coreOperation.correlationId,
        }),
      }),
    );
    expect(coreOperation).toMatchObject({
      workspaceId: f.workspaceId,
      actor: {
        kind: viaApplication ? 'application' : 'coreUser',
        id: viaApplication ? applicationId : f.actorId,
      },
    });
    expect(deactivateUser.mock.calls[0][0].userId).toBe(f.userId);
    expect(f.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkspaceId: f.membershipId,
        expectedUserId: f.userId,
        auditOperation: expect.objectContaining({
          workspaceId: f.workspaceId,
          actor: {
            kind: viaApplication ? 'application' : 'coreUser',
            id: viaApplication ? applicationId : f.actorId,
          },
          ...(viaApplication
            ? { initiator: { kind: 'coreUser', id: f.actorId } }
            : {}),
        }),
      }),
    );
  },
);
it('actual self-account deletion captures impersonator before service reads memberships', async () => {
  const f = fixture();
  await f.resolver.deleteUser({ id: f.userId } as never, {
    impersonatorUserWorkspaceId: randomUUID(),
  });
  expect(f.cleanup).toHaveBeenCalledWith(
    expect.objectContaining({
      auditOperation: expect.objectContaining({
        actor: { kind: 'coreUser', id: f.userId },
        initiator: { kind: 'coreUser', id: f.actorId },
      }),
    }),
  );
  expect(f.capture.mock.invocationCallOrder[0]).toBeLessThan(
    f.coreUserRepository.findOne.mock.invocationCallOrder[0],
  );
});
it('actual post-query hook forwards the same trusted actor to transfer and core cleanup', async () => {
  const f = fixture();
  await f.nativeRepository.delete();
  await f.postHook.execute(
    {
      type: 'user',
      workspace: { id: f.workspaceId },
      user: { id: f.actorId },
      userWorkspaceId: randomUUID(),
    } as never,
    'workspaceMember',
    [{ id: f.nativeId, userId: f.userId }] as never,
  );
  const transfer = jest.mocked(f.transfer).mock.calls[0][0];
  expect(transfer.auditOperation).toMatchObject({
    workspaceId: f.workspaceId,
    actor: { kind: 'coreUser', id: f.actorId },
  });
  expect(f.cleanup).toHaveBeenCalledWith(
    expect.objectContaining({ auditOperation: transfer.auditOperation }),
  );
});
it('self-account caller reports active-membership refusal rather than successful deletion', async () => {
  const f = fixture();
  deactivateUser.mockResolvedValue('active-memberships');
  await expect(
    f.resolver.deleteUser({ id: f.userId } as never, undefined),
  ).rejects.toThrow('active workspace memberships remain');
});
it('workspace-less self-account caller supplies no invented audit scope', async () => {
  const f = fixture();
  f.coreUserRepository.findOne.mockResolvedValue({
    id: f.userId,
    userWorkspaces: [],
  });
  await f.resolver.deleteUser({ id: f.userId } as never, undefined);
  expect(deactivateUser).toHaveBeenCalledWith(
    expect.objectContaining({ userId: f.userId, auditOperations: [] }),
  );
});
it('last-member path carries caller attribution into workspace teardown', async () => {
  const f = fixture();
  f.nativeRepository.find.mockResolvedValue([
    { id: f.nativeId, userId: f.userId },
  ]);
  const identity = systemMembershipCleanupIdentity(f.workspaceId, 'test-root');
  await f.service.removeUserFromWorkspaceAndPotentiallyDeleteWorkspace(
    {
      id: f.membershipId,
      workspaceId: f.workspaceId,
      userId: f.userId,
    } as never,
    identity,
  );
  expect(f.workspaceService.deleteWorkspace).toHaveBeenCalledWith(
    f.workspaceId,
    true,
    identity,
  );
  expect(f.cleanup).not.toHaveBeenCalled();
});
it('capture failure stops public removal before target reads or side effects', async () => {
  const f = fixture();
  f.capture.mockRejectedValueOnce(new Error('initiator unavailable'));
  await expect(
    f.resolver.deleteUserFromWorkspace(
      f.nativeId,
      { id: f.actorId } as never,
      randomUUID(),
      { id: f.workspaceId } as never,
      undefined,
      true,
      undefined,
      { impersonatorUserWorkspaceId: randomUUID() },
    ),
  ).rejects.toThrow('initiator unavailable');
  expect(f.nativeRepository.findOne).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
});
it.each(['user', 'application', 'apiKey'] as const)(
  'workspace resolver preserves trusted %s actor before suspend',
  async (kind) => {
    const workspaceId = randomUUID(),
      id = randomUUID();
    const capture = jest.fn(
      (input: Parameters<typeof captureMembershipCleanupIdentity>[0]) =>
        captureMembershipCleanupIdentity(input, async () => undefined),
    );
    const suspendWorkspace = jest.fn().mockResolvedValue(undefined),
      deleteWorkspace = jest.fn().mockResolvedValue(undefined);
    const resolver = Object.create(WorkspaceResolver.prototype) as InstanceType<
      typeof WorkspaceResolver
    >;
    Object.assign(resolver, {
      userWorkspaceService: { captureCleanupAuditIdentity: capture },
      workspaceService: { suspendWorkspace, deleteWorkspace },
    });
    await resolver.deleteCurrentWorkspace(
      { id: workspaceId } as never,
      kind === 'user' ? ({ id } as never) : undefined,
      kind === 'apiKey' ? ({ id } as never) : undefined,
      kind === 'application' ? ({ id } as never) : undefined,
      undefined,
    );
    expect(deleteWorkspace).toHaveBeenCalledWith(
      workspaceId,
      true,
      expect.objectContaining({
        actor: { kind: kind === 'user' ? 'coreUser' : kind, id },
      }),
    );
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
      suspendWorkspace.mock.invocationCallOrder[0],
    );
  },
);
