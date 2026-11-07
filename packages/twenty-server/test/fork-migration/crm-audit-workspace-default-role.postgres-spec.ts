import { randomUUID } from 'node:crypto';
import { type Request } from 'express';
import { MEMBER_ROLE_UNIVERSAL_IDENTIFIER } from 'twenty-shared/constants';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import {
  captureWorkspaceDefaultRoleAudit,
  runAuditedWorkspaceDefaultRoleUpdate,
} from 'src/engine/core-modules/crm-audit/workspace-default-role-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

jest.mock('twenty-shared/ai', () => ({
  ToolCategory: { ROLE: 'ROLE' },
  isAiModelTier: jest.fn(() => true),
}));
jest.mock('src/database/typeorm/postgres-advisory-lock.service', () => ({
  PostgresAdvisoryLockService: class {},
}));
jest.mock(
  'src/engine/core-entity-cache/services/core-entity-cache.service',
  () => ({ CoreEntityCacheService: class {} }),
);
jest.mock('src/engine/core-modules/api-key/api-key.entity', () => ({
  ApiKeyEntity: class {},
}));
jest.mock('src/engine/core-modules/application/application.service', () => ({
  ApplicationService: class {},
}));
jest.mock('src/engine/core-modules/application/dtos/application.dto', () => ({
  ApplicationDTO: class {},
}));
jest.mock(
  'src/engine/core-modules/application/application-manifest/services/application-uninstall.service',
  () => ({ ApplicationUninstallService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/pre-installed-apps/pre-installed-apps.service',
  () => ({ PreInstalledAppsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
  () => ({ AuthGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/billing/dtos/billing-entitlement.dto',
  () => ({
    BillingEntitlementDTO: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/billing/entities/billing-customer.entity',
  () => ({ BillingCustomerEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/billing/entities/billing-subscription.entity',
  () => ({ BillingSubscriptionEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/billing/services/billing-subscription.service',
  () => ({ BillingSubscriptionService: class {} }),
);
jest.mock('src/engine/core-modules/billing/services/billing.service', () => ({
  BillingService: class {},
}));
jest.mock(
  'src/engine/core-modules/dns-manager/dtos/domain-valid-records',
  () => ({ DomainValidRecords: class {} }),
);
jest.mock(
  'src/engine/core-modules/dns-manager/services/dns-manager.service',
  () => ({ DnsManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/custom-domain-manager/services/custom-domain-manager.service',
  () => ({ CustomDomainManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/ subdomain-manager/services/subdomain-manager.service'.replace(
    ' ',
    '',
  ),
  () => ({ SubdomainManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
  () => ({ WorkspaceDomainsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/emailing-domain/emailing-domain.entity',
  () => ({ EmailingDomainEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/emailing-domain/jobs/emailing-domain-workspace-cleanup.job',
  () => ({ EmailingDomainWorkspaceCleanupJob: class {} }),
);
jest.mock(
  'src/engine/core-modules/enterprise/services/enterprise-plan.service',
  () => ({ EnterprisePlanService: class {} }),
);
jest.mock(
  'src/engine/core-modules/event-logs/retention/services/event-log-retention.service',
  () => ({ EventLogRetentionService: class {} }),
);
jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);
jest.mock('src/engine/core-modules/feature-flag/dtos/feature-flag.dto', () => ({
  FeatureFlagDTO: class {},
}));
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock(
  'src/engine/core-modules/file/file-core-picture/services/file-core-picture.service',
  () => ({ FileCorePictureService: class {} }),
);
jest.mock('src/engine/core-modules/file/file-url/file-url.service', () => ({
  FileUrlService: class {},
}));
jest.mock(
  'src/engine/core-modules/file/jobs/file-workspace-folder-deletion.job',
  () => ({ FileWorkspaceFolderDeletionJob: class {} }),
);
jest.mock(
  'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
  () => ({ PreventNestToAutoLogGraphqlErrorsFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
  () => ({ ResolverValidationPipe: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/engine/core-modules/sdk-client/sdk-client-generation.service',
  () => ({
    SdkClientGenerationService: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-migration.service',
  () => ({ UpgradeMigrationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-sequence-reader.service',
  () => ({ UpgradeSequenceReaderService: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.service',
  () => ({ UserWorkspaceService: class {} }),
);
jest.mock('src/engine/core-modules/user/user.entity', () => ({
  UserEntity: class {},
}));
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/workspace/jobs/workspace-deletion-application-uninstall.job',
  () => ({ WorkspaceDeletionApplicationUninstallJob: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/ai/ai-models/services/ai-model-registry.service',
  () => ({ AiModelRegistryService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/field-metadata/field-metadata.entity',
  () => ({ FieldMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/constant/all-metadata-entity-by-metadata-name.constant',
  () => ({ ALL_METADATA_ENTITY_BY_METADATA_NAME: {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-metadata/object-metadata.entity',
  () => ({ ObjectMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-permission/field-permission/field-permission.service',
  () => ({ FieldPermissionService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-permission/object-permission.service',
  () => ({ ObjectPermissionService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/permissions/permissions.service',
  () => ({ PermissionsService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
  () => ({ PermissionsGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
  () => ({ RoleAssignmentValidationService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-permission-flag/role-permission-flag.service',
  () => ({ RolePermissionFlagService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-target/services/role-target.service',
  () => ({ RoleTargetService: class {} }),
);
jest.mock('src/engine/metadata-modules/role/dtos/role.dto', () => ({
  RoleDTO: class {},
}));
jest.mock('src/engine/metadata-modules/role/role.entity', () => ({
  RoleEntity: class {},
}));
jest.mock('src/engine/metadata-modules/role/role.service', () => ({
  RoleService: class {},
}));
jest.mock('src/engine/metadata-modules/user-role/user-role.service', () => ({
  UserRoleService: class {},
}));
jest.mock('src/engine/metadata-modules/view/dtos/view.dto', () => ({
  ViewDTO: class {},
}));
jest.mock('src/engine/metadata-modules/view/services/view.service', () => ({
  ViewService: class {},
}));
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/workspace-cache-storage/workspace-cache-storage.service',
  () => ({ WorkspaceCacheStorageService: class {} }),
);
jest.mock('src/engine/workspace-datasource/workspace-schema.service', () => ({
  WorkspaceSchemaService: class {},
}));
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/services/prefill-logic-function.service',
  () => ({ PrefillLogicFunctionService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-companies.util',
  () => ({ prefillCompanies: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-dashboards.util',
  () => ({ prefillDashboards: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-opportunities.util',
  () => ({ prefillOpportunities: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-people.util',
  () => ({ prefillPeople: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflow-code-step-logic-functions.util',
  () => ({
    getCreateCompanyWhenAddingNewPersonCodeStepLogicFunctionDefinitions: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflow-command-menu-items.util',
  () => ({ prefillWorkflowCommandMenuItems: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflows.util',
  () => ({ prefillWorkflows: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service',
  () => ({ TwentyStandardApplicationService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);

const {
  WorkspaceEntity,
} = require('src/engine/core-modules/workspace/workspace.entity');
const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { WorkspaceService } =
  require('src/engine/core-modules/workspace/services/workspace.service') as typeof import('src/engine/core-modules/workspace/services/workspace.service');
const { WorkspaceResolver } =
  require('src/engine/core-modules/workspace/workspace.resolver') as typeof import('src/engine/core-modules/workspace/workspace.resolver');
const { WorkspaceManagerService } =
  require('src/engine/workspace-manager/workspace-manager.service') as typeof import('src/engine/workspace-manager/workspace-manager.service');
const { DevSeederPermissionsService } =
  require('src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service') as typeof import('src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `ws_default_role_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorMemberId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const adminRoleId = randomUUID();
const memberRoleId = randomUUID();
const secondUserRoleId = randomUUID();
const agentOnlyRoleId = randomUUID();

const workspaceSchema = new EntitySchema({
  name: 'WorkspaceEntity',
  target: WorkspaceEntity,
  tableName: 'workspace',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    displayName: { type: 'text', nullable: true },
    subdomain: { type: 'text', nullable: true },
    customDomain: { type: 'text', nullable: true },
    isCustomDomainEnabled: { type: Boolean, default: false },
    logo: { type: 'text', nullable: true },
    logoFileId: { type: 'uuid', nullable: true },
    databaseSchema: { type: 'text', nullable: true },
    defaultRoleId: { type: 'uuid', nullable: true },
    activationStatus: { type: 'text', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});

const roleSchema = new EntitySchema({
  name: 'RoleEntity',
  target: RoleEntity,
  tableName: 'role',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    label: { type: 'text' },
    canBeAssignedToUsers: { type: Boolean, default: true },
    canBeAssignedToAgents: { type: Boolean, default: false },
    canBeAssignedToApiKeys: { type: Boolean, default: false },
  },
});

const membershipSchema = new EntitySchema({
  name: 'UserWorkspaceEntity',
  target: UserWorkspaceEntity,
  tableName: 'userWorkspace',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [workspaceSchema, roleSchema, membershipSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-ws-default-role-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [workspaceSchema, roleSchema, membershipSchema],
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const readWorkspace = async (): Promise<Row> => {
  const [row] = await owner.query('SELECT * FROM core.workspace WHERE id=$1', [
    workspaceId,
  ]);
  return row;
};
const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const userIdentity = (
  extra: Partial<RoleUpdateAuditIdentity> = {},
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorMemberId,
  },
  ...extra,
});

const buildHarness = () => {
  const permissionsService = {
    userHasWorkspaceSettingPermission: jest.fn(async () => true),
  };
  const roleAssignmentValidationService = {
    validateRoleAssignableToUsersOrThrow: jest.fn(async () => {}),
  };
  const dnsManagerService = {
    deleteHostnameSilently: jest.fn(async () => {}),
  };
  const customDomainManagerService = {
    setCustomDomain: jest.fn(async () => {}),
  };
  const coreEntityCacheService = {
    invalidate: jest.fn(async () => {}),
  };
  const fileCorePictureService = {
    deleteCorePicture: jest.fn(async () => {}),
  };
  const twentyConfigService = {
    get: jest.fn(() => true),
  };
  const exceptionHandlerService = {
    captureExceptions: jest.fn(),
  };

  const workspaceService = Object.assign(
    Object.create(WorkspaceService.prototype),
    {
      logger: { log: jest.fn(), error: jest.fn() },
      WORKSPACE_FIELD_PERMISSIONS: {
        displayName: 'WORKSPACE',
        customDomain: 'WORKSPACE',
        logo: 'WORKSPACE',
        defaultRoleId: 'ROLES',
      },
      workspaceRepository: runtime.getRepository(WorkspaceEntity),
      coreDataSource: runtime,
      permissionsService,
      roleAssignmentValidationService,
      dnsManagerService,
      customDomainManagerService,
      coreEntityCacheService,
      fileCorePictureService,
      twentyConfigService,
      exceptionHandlerService,
    },
  ) as InstanceType<typeof WorkspaceService>;

  const workspaceResolver = new WorkspaceResolver(
    workspaceService,
    {} as never,
    {} as never,
    twentyConfigService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dnsManagerService as never,
    customDomainManagerService as never,
    {} as never,
    {} as never,
  );

  return {
    workspaceService,
    workspaceResolver,
    permissionsService,
    roleAssignmentValidationService,
    dnsManagerService,
    customDomainManagerService,
    coreEntityCacheService,
    fileCorePictureService,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.getRepository(WorkspaceEntity).insert({
    id: workspaceId,
    displayName: 'Acme',
    subdomain: 'acme',
    databaseSchema: 'workspace_acme',
    defaultRoleId: memberRoleId,
    activationStatus: WorkspaceActivationStatus.ACTIVE,
  });
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-ws-default-role-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT,UPDATE ON core.workspace,core.role,core."userWorkspace" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    'TRUNCATE core.role,core."userWorkspace",crm_audit."crmAuditEntry"',
  );
  await owner.getRepository(RoleEntity).insert([
    {
      id: adminRoleId,
      workspaceId,
      universalIdentifier: STANDARD_ROLE.admin.universalIdentifier,
      label: 'Admin',
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
    {
      id: memberRoleId,
      workspaceId,
      universalIdentifier: MEMBER_ROLE_UNIVERSAL_IDENTIFIER,
      label: 'Member',
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
    {
      id: secondUserRoleId,
      workspaceId,
      universalIdentifier: randomUUID(),
      label: 'Sales Rep',
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
    {
      id: agentOnlyRoleId,
      workspaceId,
      universalIdentifier: randomUUID(),
      label: 'Agent Only',
      canBeAssignedToUsers: false,
      canBeAssignedToAgents: true,
      canBeAssignedToApiKeys: false,
    },
  ]);
  await owner.getRepository(UserWorkspaceEntity).insert([
    {
      id: actorUserWorkspaceId,
      workspaceId,
      userId: actorUserId,
      deletedAt: null,
    },
    {
      id: impersonatorUserWorkspaceId,
      workspaceId,
      userId: impersonatorUserId,
      deletedAt: null,
    },
  ]);
  await owner.getRepository(WorkspaceEntity).update(workspaceId, {
    displayName: 'Acme',
    subdomain: 'acme',
    customDomain: null,
    isCustomDomainEnabled: false,
    logo: null,
    logoFileId: null,
    databaseSchema: 'workspace_acme',
    defaultRoleId: memberRoleId,
    activationStatus: WorkspaceActivationStatus.ACTIVE,
    deletedAt: null,
  });
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

describe('Workspace defaultRoleId CRM audit (LOG163)', () => {
  it('audits defaultRoleId updates in WorkspaceService.updateWorkspaceById and WorkspaceResolver.updateWorkspace including impersonation initiator', async () => {
    const { workspaceService, workspaceResolver, coreEntityCacheService } =
      buildHarness();

    const updated = await workspaceService.updateWorkspaceById({
      payload: {
        id: workspaceId,
        displayName: 'Acme Corp',
        defaultRoleId: secondUserRoleId,
      },
      userWorkspaceId: actorUserWorkspaceId,
      apiKey: undefined,
      auditIdentity: userIdentity(),
    });
    expect(updated.defaultRoleId).toBe(secondUserRoleId);
    expect(updated.displayName).toBe('Acme Corp');
    expect(coreEntityCacheService.invalidate).toHaveBeenCalledWith(
      'workspaceEntity',
      workspaceId,
    );

    const req = {
      workspace: { id: workspaceId },
      userWorkspaceId: actorUserWorkspaceId,
      workspaceMemberId: actorMemberId,
      user: { id: actorUserId },
      impersonationContext: {
        impersonatorUserWorkspaceId,
      },
    } as unknown as Request;

    const updatedViaResolver = await workspaceResolver.updateWorkspace(
      { defaultRoleId: adminRoleId },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      undefined,
      undefined,
      { req },
    );
    expect(updatedViaResolver?.defaultRoleId).toBe(adminRoleId);

    const entries = await audits();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      outcome: 'success',
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: null,
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: memberRoleId, after: secondUserRoleId },
        },
      },
      securityDescriptor: {
        resourceKind: 'workspace',
        resourceId: workspaceId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(entries[1]).toMatchObject({
      workspaceId,
      action: 'update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      outcome: 'success',
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: secondUserRoleId, after: adminRoleId },
        },
      },
    });
  });

  it('skips writing an audit entry when defaultRoleId is unchanged (case-insensitive) while still persisting other workspace fields', async () => {
    const { workspaceService } = buildHarness();

    const updated = await workspaceService.updateWorkspaceById({
      payload: {
        id: workspaceId,
        displayName: 'Acme Same Role',
        defaultRoleId: memberRoleId.toUpperCase(),
      },
      userWorkspaceId: actorUserWorkspaceId,
      apiKey: undefined,
      auditIdentity: userIdentity(),
    });

    expect(updated.displayName).toBe('Acme Same Role');
    expect(updated.defaultRoleId).toBe(memberRoleId);
    expect(await audits()).toHaveLength(0);
  });

  it('rolls back under database lock when the target role is missing, belongs to another workspace, is not assignable to users, or is null', async () => {
    const { workspaceService } = buildHarness();
    const foreignRoleId = randomUUID();
    await owner.getRepository(RoleEntity).insert({
      id: foreignRoleId,
      workspaceId: randomUUID(),
      universalIdentifier: randomUUID(),
      label: 'Foreign Role',
      canBeAssignedToUsers: true,
    });

    for (const invalidRoleId of [
      randomUUID(),
      foreignRoleId,
      agentOnlyRoleId,
      null as unknown as string,
    ]) {
      await expect(
        workspaceService.updateWorkspaceById({
          payload: {
            id: workspaceId,
            displayName: 'Should Roll Back',
            defaultRoleId: invalidRoleId,
          },
          userWorkspaceId: actorUserWorkspaceId,
          apiKey: undefined,
          auditIdentity: userIdentity(),
        }),
      ).rejects.toThrow(
        'Workspace default role is unavailable or not assignable to users',
      );
    }

    const row = await readWorkspace();
    expect(row.defaultRoleId).toBe(memberRoleId);
    expect(row.displayName).toBe('Acme');
    expect(await audits()).toHaveLength(0);
  });

  it('rejects missing or non-auditable identity and conflicting metadata audit scopes before the first await while keeping non-defaultRoleId updates open', async () => {
    const { workspaceService, permissionsService, customDomainManagerService } =
      buildHarness();
    const pendingActivationIdentity = {
      auth: { type: 'pendingActivationUser', workspace: { id: workspaceId } },
    } as unknown as RoleUpdateAuditIdentity;

    await expect(
      workspaceService.updateWorkspaceById({
        payload: { id: workspaceId, defaultRoleId: secondUserRoleId },
        userWorkspaceId: actorUserWorkspaceId,
        apiKey: undefined,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      workspaceService.updateWorkspaceById({
        payload: {
          id: workspaceId,
          customDomain: 'acme.example.com',
          defaultRoleId: secondUserRoleId,
        },
        userWorkspaceId: actorUserWorkspaceId,
        apiKey: undefined,
        auditIdentity: pendingActivationIdentity,
      }),
    ).rejects.toThrow('Authentication cannot perform audited CRM writes');

    await expect(
      withRoleUpdateAudit(workspaceId, memberRoleId, userIdentity(), () =>
        workspaceService.updateWorkspaceById({
          payload: { id: workspaceId, defaultRoleId: secondUserRoleId },
          userWorkspaceId: actorUserWorkspaceId,
          apiKey: undefined,
          auditIdentity: userIdentity(),
        }),
      ),
    ).rejects.toThrow('Nested workspace default role audit is unsupported');

    const captured = captureWorkspaceDefaultRoleAudit(
      workspaceId,
      userIdentity(),
    )();
    await runAuditedWorkspaceDefaultRoleUpdate(
      runtime,
      captured,
      secondUserRoleId,
      async (runner) => {
        await runner.manager.update(WorkspaceEntity, workspaceId, {
          defaultRoleId: secondUserRoleId,
        });
      },
    );
    await expect(
      runAuditedWorkspaceDefaultRoleUpdate(
        runtime,
        captured,
        memberRoleId,
        async () => {},
      ),
    ).rejects.toThrow('Nested workspace default role audit is unsupported');

    expect(
      permissionsService.userHasWorkspaceSettingPermission,
    ).not.toHaveBeenCalled();
    expect(customDomainManagerService.setCustomDomain).not.toHaveBeenCalled();

    const mutablePayload: {
      id: string;
      displayName?: string;
      defaultRoleId?: string;
    } = {
      id: workspaceId,
      displayName: 'Renamed Only',
    };
    permissionsService.userHasWorkspaceSettingPermission.mockImplementationOnce(
      async () => {
        mutablePayload.defaultRoleId = adminRoleId;
        return true;
      },
    );
    const updatedWithoutRole = await workspaceService.updateWorkspaceById({
      payload: mutablePayload,
      userWorkspaceId: actorUserWorkspaceId,
      apiKey: undefined,
    });
    expect(updatedWithoutRole.displayName).toBe('Renamed Only');
    expect(updatedWithoutRole.defaultRoleId).toBe(secondUserRoleId);
    expect(await audits()).toHaveLength(1);
  });

  it('audits initial defaultRoleId assignment in WorkspaceManagerService.setupDefaultRoles and DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace', async () => {
    await owner.query(
      'UPDATE core.workspace SET "defaultRoleId"=NULL,"activationStatus"=$2 WHERE id=$1',
      [workspaceId, WorkspaceActivationStatus.ONGOING_CREATION],
    );

    const roleService = {
      createWorkspaceCustomApplicationRole: jest.fn(async () => {}),
      createMemberRole: jest.fn(async () => ({ id: memberRoleId })),
    };
    const userRoleService = {
      assignRoleToManyUserWorkspace: jest.fn(async () => {}),
    };

    const workspaceManager = new WorkspaceManagerService(
      {} as never,
      owner.getRepository(UserWorkspaceEntity),
      roleService as never,
      userRoleService as never,
      {} as never,
      runtime.getRepository(WorkspaceEntity),
      {
        findOne: jest.fn(async () => ({ id: memberRoleId })),
      } as never,
      {} as never,
    );

    await (
      workspaceManager as unknown as {
        setupDefaultRoles: (args: {
          workspaceId: string;
          userId: string;
          workspaceCustomFlatApplication: unknown;
        }) => Promise<void>;
      }
    ).setupDefaultRoles({
      workspaceId,
      userId: actorUserId,
      workspaceCustomFlatApplication: { id: randomUUID() },
    });

    expect((await readWorkspace()).defaultRoleId).toBe(memberRoleId);

    await owner.query(
      'UPDATE core.workspace SET "defaultRoleId"=NULL,"activationStatus"=$2 WHERE id=$1',
      [workspaceId, WorkspaceActivationStatus.PENDING_CREATION],
    );

    const seeder = new DevSeederPermissionsService(
      roleService as never,
      userRoleService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtime,
    );

    await seeder.initMinimalPermissionsAndActivateWorkspace({
      workspaceId,
      workspaceCustomFlatApplication: { id: randomUUID() } as never,
    });

    const afterSeederWorkspace = await readWorkspace();
    expect(afterSeederWorkspace.defaultRoleId).toBe(memberRoleId);
    expect(afterSeederWorkspace.activationStatus).toBe(
      WorkspaceActivationStatus.ACTIVE,
    );

    const entries = await audits();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      actor: {
        kind: 'system',
        id: 'workspace-manager:setup-default-roles',
      },
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: memberRoleId },
        },
      },
    });
    expect(entries[1]).toMatchObject({
      action: 'update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      actor: {
        kind: 'system',
        id: 'dev-seeder:init-minimal-permissions',
      },
      redactedDiff: {
        changedFields: ['defaultRoleId'],
        values: {
          defaultRoleId: { before: null, after: memberRoleId },
        },
      },
    });
  });

  it('suppresses ROLLBACK, invalidates workspaceEntity cache, and preserves registered customDomain when COMMIT acknowledgement is lost', async () => {
    const {
      workspaceService,
      coreEntityCacheService,
      dnsManagerService,
      customDomainManagerService,
    } = buildHarness();
    const statements: string[] = [];
    const clients = new WeakSet<object>();
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const connect = runner.connect.bind(runner);
      jest.spyOn(runner, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!clients.has(client)) {
          clients.add(client);
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            statements.push(sql);
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('commit ack lost');
            return result;
          };
        }
        return client;
      });
      return runner;
    });

    await expect(
      workspaceService.updateWorkspaceById({
        payload: {
          id: workspaceId,
          customDomain: 'crm.acme.example',
          defaultRoleId: secondUserRoleId,
        },
        userWorkspaceId: actorUserWorkspaceId,
        apiKey: undefined,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(customDomainManagerService.setCustomDomain).toHaveBeenCalledTimes(1);
    expect(dnsManagerService.deleteHostnameSilently).not.toHaveBeenCalled();
    expect(coreEntityCacheService.invalidate).toHaveBeenCalledWith(
      'workspaceEntity',
      workspaceId,
    );
    expect((await readWorkspace()).defaultRoleId).toBe(secondUserRoleId);
    expect(await audits()).toHaveLength(1);
  });

  it('wraps a failure after a confirmed COMMIT in CoreAuditPostCommitError without ROLLBACK or customDomain deletion', async () => {
    const { workspaceService, coreEntityCacheService, dnsManagerService } =
      buildHarness();
    const rollbacks: jest.SpyInstance[] = [];
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = originalCreateQueryRunner(mode);
      const commitTransaction = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commitTransaction();
        throw new Error('failure after confirmed commit');
      };
      rollbacks.push(jest.spyOn(runner, 'rollbackTransaction'));
      return runner;
    });

    await expect(
      workspaceService.updateWorkspaceById({
        payload: {
          id: workspaceId,
          customDomain: 'postcommit.acme.example',
          defaultRoleId: adminRoleId,
        },
        userWorkspaceId: actorUserWorkspaceId,
        apiKey: undefined,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    expect(rollbacks.length).toBeGreaterThan(0);
    for (const rollback of rollbacks) expect(rollback).not.toHaveBeenCalled();
    expect(dnsManagerService.deleteHostnameSilently).not.toHaveBeenCalled();
    expect(coreEntityCacheService.invalidate).toHaveBeenCalledWith(
      'workspaceEntity',
      workspaceId,
    );
    expect((await readWorkspace()).defaultRoleId).toBe(adminRoleId);
    expect(await audits()).toHaveLength(1);
  });

  it('compensates customDomain on pre-commit rollback, deletes core picture after commit, rejects unpersisted defaultRoleId, preserves PENDING_CREATION permission error, and freezes captured actor against post-start mutation', async () => {
    const {
      workspaceService,
      dnsManagerService,
      coreEntityCacheService,
      fileCorePictureService,
      permissionsService,
    } = buildHarness();

    await expect(
      workspaceService.updateWorkspaceById({
        payload: {
          id: workspaceId,
          customDomain: 'rollback.acme.example',
          defaultRoleId: agentOnlyRoleId,
        },
        userWorkspaceId: actorUserWorkspaceId,
        apiKey: undefined,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Workspace default role is unavailable or not assignable to users',
    );
    expect(dnsManagerService.deleteHostnameSilently).toHaveBeenCalledWith(
      'rollback.acme.example',
    );
    expect(coreEntityCacheService.invalidate).not.toHaveBeenCalled();

    const wrongPersistenceAudit = captureWorkspaceDefaultRoleAudit(
      workspaceId,
      userIdentity(),
    )();
    await expect(
      runAuditedWorkspaceDefaultRoleUpdate(
        runtime,
        wrongPersistenceAudit,
        secondUserRoleId,
        async () => {},
      ),
    ).rejects.toThrow(
      'Workspace default role update did not persist expected value',
    );
    expect((await readWorkspace()).defaultRoleId).toBe(memberRoleId);
    expect(await audits()).toHaveLength(0);

    const logoFileId = randomUUID();
    await owner.getRepository(WorkspaceEntity).update(workspaceId, {
      logo: 'https://acme.example/logo.png',
      logoFileId,
    });
    const mutableAuth = {
      type: 'user' as const,
      workspace: { id: workspaceId },
      workspaceMemberId: actorMemberId,
    };
    const mutableIdentity: RoleUpdateAuditIdentity = { auth: mutableAuth };
    permissionsService.userHasWorkspaceSettingPermission.mockImplementationOnce(
      async () => {
        mutableAuth.workspaceMemberId = randomUUID();
        return true;
      },
    );

    const updatedWithLogoClear = await workspaceService.updateWorkspaceById({
      payload: {
        id: workspaceId,
        logo: null as unknown as string,
        defaultRoleId: secondUserRoleId,
      },
      userWorkspaceId: actorUserWorkspaceId,
      apiKey: undefined,
      auditIdentity: mutableIdentity,
    });
    expect(updatedWithLogoClear.defaultRoleId).toBe(secondUserRoleId);
    expect(updatedWithLogoClear.logoFileId).toBeNull();
    expect(fileCorePictureService.deleteCorePicture).toHaveBeenCalledWith({
      fileId: logoFileId,
      workspaceId,
    });
    const entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toEqual({
      kind: 'workspaceMember',
      id: actorMemberId,
    });

    await owner.getRepository(WorkspaceEntity).update(workspaceId, {
      activationStatus: WorkspaceActivationStatus.PENDING_CREATION,
    });
    await expect(
      workspaceService.updateWorkspaceById({
        payload: { id: workspaceId, defaultRoleId: adminRoleId },
        userWorkspaceId: undefined,
        apiKey: undefined,
        auditIdentity: {
          auth: {
            type: 'pendingActivationUser',
            workspace: { id: workspaceId },
          },
        } as unknown as RoleUpdateAuditIdentity,
      }),
    ).rejects.toThrow('Entity performing the request does not have permission');
  });
});
