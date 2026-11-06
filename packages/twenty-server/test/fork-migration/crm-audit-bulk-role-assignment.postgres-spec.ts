import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  withBulkUserRoleAssignmentAudit,
  withRoleAssignmentAudit,
} from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { PermissionsExceptionCode } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));
for (const [path, name] of [
  ['core-modules/application/application.service', 'ApplicationService'],
  [
    'workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    'WorkspaceMigrationValidateBuildAndRunService',
  ],
  [
    'core-modules/feature-flag/services/feature-flag.service',
    'FeatureFlagService',
  ],
  ['core-modules/logger/logger.service', 'LoggerService'],
  ['core-modules/metrics/metrics.service', 'MetricsService'],
  ['core-modules/twenty-config/twenty-config.service', 'TwentyConfigService'],
  [
    'metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    'WorkspaceManyOrAllFlatEntityMapsCacheService',
  ],
  [
    'metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    'WorkspaceMetadataVersionService',
  ],
  ['workspace-cache/services/workspace-cache.service', 'WorkspaceCacheService'],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    'InFlightDeferredWorkspaceMigrationActionsService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    'DeferredWorkspaceMigrationActionRunnerService',
  ],
  [
    'workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    'WorkspaceMigrationRunnerActionHandlerRegistryService',
  ],
  ['twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    'RoleAssignmentValidationService',
  ],
  ['metadata-modules/role/role.service', 'RoleService'],
  ['workspace-datasource/workspace-schema.service', 'WorkspaceSchemaService'],
  [
    'workspace-manager/twenty-standard-application/services/twenty-standard-application.service',
    'TwentyStandardApplicationService',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  ['core-modules/user-workspace/user-workspace.entity', 'UserWorkspaceEntity'],
  ['core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
jest.mock('src/engine/twenty-orm/utils/build-system-auth-context.util', () => ({
  buildSystemAuthContext: (workspaceId: string) => ({
    workspace: { id: workspaceId },
    type: 'system',
  }),
}));
jest.mock(
  'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
  () => ({ WorkspaceMemberWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({
    WorkspaceMigrationRunnerActionHandler: () =>
      class {
        async insertFlatEntitiesInRepository({
          queryRunner,
          flatEntities,
        }: {
          queryRunner: QueryRunner;
          flatEntities: object[];
        }) {
          await queryRunner.manager.getRepository(RoleTargetEntity).insert(
            flatEntities.map((flatEntity) =>
              flatEntityToScalarFlatEntity({
                metadataName: 'roleTarget',
                flatEntity: flatEntity as never,
              }),
            ),
          );
        }
        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: { universalIdentifier: string };
          allFlatEntityMaps: {
            flatRoleTargetMaps: {
              byUniversalIdentifier: Record<string, { id: string }>;
            };
          };
        }) {
          return {
            ...context.action,
            entityId:
              context.allFlatEntityMaps.flatRoleTargetMaps
                .byUniversalIdentifier[context.action.universalIdentifier].id,
          };
        }
      },
  }),
);

const {
  RoleTargetEntity,
} = require('src/engine/metadata-modules/role-target/role-target.entity');
const {
  UserWorkspaceEntity,
} = require('src/engine/core-modules/user-workspace/user-workspace.entity');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/create-role-target-action-handler.service');
const { DeleteRoleTargetActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-target/services/delete-role-target-action-handler.service');
const { RoleTargetService } =
  require('src/engine/metadata-modules/role-target/services/role-target.service') as typeof import('src/engine/metadata-modules/role-target/services/role-target.service');
const { UserRoleService } =
  require('src/engine/metadata-modules/user-role/user-role.service') as typeof import('src/engine/metadata-modules/user-role/user-role.service');
const { WorkspaceManagerService } =
  require('src/engine/workspace-manager/workspace-manager.service') as typeof import('src/engine/workspace-manager/workspace-manager.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `bulk_assign_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const member1Id = randomUUID();
const user1Id = randomUUID();
const userWorkspace1Id = randomUUID();
const member2Id = randomUUID();
const user2Id = randomUUID();
const userWorkspace2Id = randomUUID();
const member3Id = randomUUID();
const user3Id = randomUUID();
const userWorkspace3Id = randomUUID();
const actorId = randomUUID();
const adminRoleId = randomUUID();
const destinationId = randomUUID();
const destinationUniversalIdentifier = randomUUID();
const application = {
  id: applicationId,
  universalIdentifier: applicationUniversalIdentifier,
};

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

const targetSchema = new EntitySchema({
  name: 'RoleTargetEntity',
  target: RoleTargetEntity,
  tableName: 'roleTarget',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    userWorkspaceId: { type: 'uuid', nullable: true },
    agentId: { type: 'uuid', nullable: true },
    apiKeyId: { type: 'uuid', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
  uniques: [
    { columns: ['workspaceId', 'userWorkspaceId'] },
    { columns: ['workspaceId', 'universalIdentifier'] },
  ],
});

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-bulk-assignment-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [membershipSchema, targetSchema],
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & {
  id: string;
  universalIdentifier: string;
};

const targets = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core."roleTarget" ORDER BY id');
const roles = (): Promise<Row[]> =>
  owner.query('SELECT * FROM core.role ORDER BY id');
const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const userIdentity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
});

const systemIdentity = (
  systemActorId = 'user-workspace:add-user-to-workspace',
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'system',
    workspace: { id: workspaceId },
  },
  systemActorId,
});

const entityMaps = (records: Row[]) => ({
  byUniversalIdentifier: Object.fromEntries(
    records.map((r) => [r.universalIdentifier, r]),
  ),
  universalIdentifierById: Object.fromEntries(
    records.map((r) => [r.id, r.universalIdentifier]),
  ),
});

const flatMaps = async () => ({
  flatRoleMaps: entityMaps(await roles()),
  flatRoleTargetMaps: entityMaps(await targets()),
  flatAgentMaps: entityMaps([]),
  flatApplicationMaps: { byId: { [applicationId]: application } },
});

const fixture = async (
  options: {
    fail?: boolean;
    deferred?: boolean;
    maps?: Awaited<ReturnType<typeof flatMaps>>;
  } = {},
) => {
  const maps = options.maps ?? (await flatMaps());
  const create = new CreateRoleTargetActionHandlerService();
  const remove = new DeleteRoleTargetActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      if (context.action.type === 'create') {
        const flatAction =
          await create.transpileUniversalActionToFlatAction(context);
        await create.executeForMetadata({ ...context, flatAction });
      } else {
        const flatAction =
          await remove.transpileUniversalActionToFlatAction(context);
        await remove.executeForMetadata({ ...context, flatAction });
      }
      if (options.fail) throw new Error('handler failure');
      return {
        partialOptimisticCache: {},
        metadataEvents: [{}],
        deferredActions: options.deferred ? [{}] : [],
      };
    }),
    executeActionRollbackHandler: jest.fn(),
  };
  const cache = {
    getOrRecompute: async () => ({
      flatApplicationMaps: {
        byId: { [applicationId]: application },
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
      },
    }),
    invalidateAndRecompute: jest.fn(async () => {}),
  };
  const logger = {
    perf: jest.fn(),
    perfTime: jest.fn(),
    perfTimeEnd: jest.fn(),
    error: jest.fn(),
  };
  const migration = new WorkspaceMigrationRunnerService(
    { getOrRecomputeManyOrAllFlatEntityMaps: async () => maps } as never,
    runtime,
    registry as never,
    {} as never,
    cache as never,
    { recordHistogram: jest.fn() } as never,
    logger as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    { persist: jest.fn(), dispatchAfterCommit: jest.fn() } as never,
    {} as never,
  );
  return { migration, registry, cache, maps };
};

const addMember = async ({
  memberId,
  userWorkspaceId,
  userId,
  roleId,
  includeMemberRow = true,
}: {
  memberId: string;
  userWorkspaceId: string;
  userId: string;
  roleId?: string | null;
  includeMemberRow?: boolean;
}) => {
  await owner.query(
    'INSERT INTO core."userWorkspace" (id,"workspaceId","userId") VALUES($1,$2,$3)',
    [userWorkspaceId, workspaceId, userId],
  );
  if (includeMemberRow) {
    await owner.query(
      'INSERT INTO synthetic_members."workspaceMember" (id,"userId") VALUES($1,$2)',
      [memberId, userId],
    );
  }
  if (roleId) {
    await owner.getRepository(RoleTargetEntity).insert({
      id: randomUUID(),
      workspaceId,
      applicationId,
      universalIdentifier: randomUUID(),
      roleId,
      userWorkspaceId,
    });
  }
};

const serviceFixture = (
  options: {
    failMigration?: boolean;
    tamperOperations?: (operations: {
      flatEntityToCreate: Row[];
      flatEntityToDelete: Row[];
    }) => void;
    beforeMigrationRun?: () => Promise<void>;
  } = {},
) => {
  const builder = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async (args) => {
      if (options.beforeMigrationRun) {
        await options.beforeMigrationRun();
      }
      const operations = args.allFlatEntityOperationByMetadataName.roleTarget;
      options.tamperOperations?.(operations);
      const actions = [
        ...operations.flatEntityToDelete.map((row: Row) => ({
          type: 'delete',
          metadataName: 'roleTarget',
          universalIdentifier: row.universalIdentifier,
        })),
        ...operations.flatEntityToCreate.map((row: Row) => ({
          type: 'create',
          metadataName: 'roleTarget',
          id: row.id,
          flatEntity: Object.fromEntries(
            Object.entries(row).filter(
              ([key]) =>
                ![
                  'id',
                  'workspaceId',
                  'applicationId',
                  'roleId',
                  'agentId',
                ].includes(key),
            ),
          ),
        })),
      ];
      const f = await fixture({ fail: options.failMigration });
      await f.migration.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier,
          actions,
        } as never,
      });
      return { status: 'success' };
    }),
  };
  const targetService = new RoleTargetService(
    { getOrRecomputeManyOrAllFlatEntityMaps: flatMaps } as never,
    builder as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: application,
      }),
    } as never,
  );
  const assignmentValidation = {
    validateRoleAssignableToUsersOrThrow: jest.fn(async () => {}),
  };
  const roleTargetRepository = {
    findOne: async (
      _workspace: string,
      opts: { where: { userWorkspaceId: string; roleId: string } },
    ) =>
      (await targets()).find(
        (r) =>
          r.userWorkspaceId === opts.where.userWorkspaceId &&
          r.roleId === opts.where.roleId,
      ),
    find: async (
      _workspace: string,
      opts: { where: { userWorkspaceId: { value: string[] } } },
    ) => {
      const roleRows = await roles();
      return (await targets())
        .filter((r) =>
          opts.where.userWorkspaceId.value.includes(String(r.userWorkspaceId)),
        )
        .map((r) => ({
          ...r,
          role: roleRows.find((role) => role.id === r.roleId),
        }));
    },
  };
  const cache = {
    getOrRecompute: jest.fn(async (_workspace: string, keys: string[]) => {
      if (keys.includes('userWorkspaceRoleMap'))
        return {
          userWorkspaceRoleMap: Object.fromEntries(
            (await targets()).map((r) => [r.userWorkspaceId, r.roleId]),
          ),
        };
      const records = await owner.query(
        'SELECT m.id,u.id AS membership FROM synthetic_members."workspaceMember" m JOIN core."userWorkspace" u ON u."userId"=m."userId" WHERE m."deletedAt" IS NULL AND u."deletedAt" IS NULL',
      );
      return {
        flatWorkspaceMemberMaps: {
          byId: Object.fromEntries(
            records.map((r: { id: string }) => [r.id, r]),
          ),
          idByUserWorkspaceId: Object.fromEntries(
            records.map((r: { membership: string; id: string }) => [
              r.membership,
              r.id,
            ]),
          ),
        },
      };
    }),
  };
  const service = new UserRoleService(
    roleTargetRepository as never,
    owner.getRepository(UserWorkspaceEntity),
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
      getRepository: () => ({
        findOne: async (opts: { where: { id: string } }) => {
          const [row] = await owner.query(
            'SELECT * FROM synthetic_members."workspaceMember" WHERE id=$1 AND "deletedAt" IS NULL',
            [opts.where.id],
          );
          return row ?? null;
        },
      }),
    } as never,
    targetService,
    cache as never,
    assignmentValidation as never,
  );
  return { service, builder, cache, assignmentValidation };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE; CREATE SCHEMA core; CREATE SCHEMA synthetic_members',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"deletedAt" timestamptz); CREATE TABLE core.role(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"canBeAssignedToUsers" boolean); ALTER TABLE core."roleTarget" ADD FOREIGN KEY ("roleId") REFERENCES core.role(id) ON DELETE CASCADE; CREATE TABLE synthetic_members."workspaceMember"(id uuid PRIMARY KEY,"userId" uuid,"deletedAt" timestamptz); CREATE TABLE core.workflow(id uuid PRIMARY KEY,"workspaceId" uuid,"applicationId" uuid,"createdByUserWorkspaceId" uuid)',
  );
  await owner.query(
    'INSERT INTO core.workspace(id,"databaseSchema") VALUES($1,$2)',
    [workspaceId, 'synthetic_members'],
  );
  await owner.query(
    'CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid,"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-bulk-assignment-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit,synthetic_members TO "${databaseRole}"; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA core,synthetic_members TO "${databaseRole}"; GRANT INSERT,DELETE ON core."roleTarget" TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query('TRUNCATE core.application');
  await owner.query('INSERT INTO core.application VALUES($1,$2,$3,NULL)', [
    applicationId,
    workspaceId,
    applicationUniversalIdentifier,
  ]);
  await owner.query(
    'TRUNCATE core."roleTarget",core.role,core."userWorkspace",synthetic_members."workspaceMember",crm_audit."crmAuditEntry"',
  );
  await owner.query(
    'INSERT INTO core.role VALUES($1,$2,$3,true),($4,$2,$5,true)',
    [
      adminRoleId,
      workspaceId,
      STANDARD_ROLE.admin.universalIdentifier,
      destinationId,
      destinationUniversalIdentifier,
    ],
  );
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; DROP SCHEMA IF EXISTS synthetic_members CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
    await owner.destroy();
  }
});

describe('LOG159 audited bulk and initial member role assignments', () => {
  it('audits initial member role assignment with no existing roleTarget', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    const { service } = serviceFixture();

    await service.assignRoleToManyUserWorkspace({
      workspaceId,
      userWorkspaceIds: [userWorkspace1Id],
      roleId: destinationId,
      auditIdentity: systemIdentity('user-workspace:add-user-to-workspace'),
    });

    const targetRows = await targets();
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]).toMatchObject({
      workspaceId,
      roleId: destinationId,
      userWorkspaceId: userWorkspace1Id,
      agentId: null,
      apiKeyId: null,
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'roleTarget',
      resourceId: targetRows[0].id,
      action: 'create',
      redactedDiff: {
        changedFields: ['roleId', 'userWorkspaceId'],
        values: {
          roleId: { before: null, after: destinationId },
          userWorkspaceId: { before: null, after: userWorkspace1Id },
        },
      },
      actor: {
        kind: 'system',
        id: 'user-workspace:add-user-to-workspace',
      },
      securityDescriptor: {
        resourceKind: 'roleTarget',
        resourceId: targetRows[0].id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
  });

  it('audits bootstrap role assignment with requireWorkspaceMember: false before workspaceMember exists', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
      includeMemberRow: false,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: null,
      includeMemberRow: false,
    });
    const { service } = serviceFixture();

    await service.assignRoleToManyUserWorkspace({
      workspaceId,
      userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
      roleId: destinationId,
      requireWorkspaceMember: false,
      auditIdentity: systemIdentity('dev-seeder:init-permissions'),
    });

    const targetRows = await targets();
    expect(targetRows).toHaveLength(2);
    const auditRows = await audits();
    expect(auditRows).toHaveLength(2);
    expect(new Set(auditRows.map((row) => row.operationId)).size).toBe(1);
    expect(auditRows.map((row) => row.action)).toEqual(['create', 'create']);
    expect(auditRows[0].actor).toEqual({
      kind: 'system',
      id: 'dev-seeder:init-permissions',
    });

    const userWorkspace4Id = randomUUID();
    const user4Id = randomUUID();
    await addMember({
      memberId: randomUUID(),
      userWorkspaceId: userWorkspace4Id,
      userId: user4Id,
      roleId: null,
      includeMemberRow: false,
    });
    const workspaceManager = new WorkspaceManagerService(
      {} as never,
      owner.getRepository(UserWorkspaceEntity),
      { createMemberRole: async () => ({ id: destinationId }) } as never,
      service,
      {} as never,
      { update: jest.fn(async () => {}) } as never,
      {
        findOne: async (
          _wsId: string,
          opts: { where: { universalIdentifier: string } },
        ) =>
          opts.where.universalIdentifier ===
          STANDARD_ROLE.admin.universalIdentifier
            ? { id: adminRoleId }
            : { id: destinationId },
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
      userId: user4Id,
      workspaceCustomFlatApplication: application,
    });
    const afterSetupAudits = await audits();
    expect(afterSetupAudits).toHaveLength(3);
    expect(afterSetupAudits[2]).toMatchObject({
      action: 'create',
      resourceKind: 'roleTarget',
      actor: {
        kind: 'system',
        id: 'workspace-manager:setup-default-roles',
      },
      redactedDiff: {
        changedFields: ['roleId', 'userWorkspaceId'],
        values: {
          roleId: { before: null, after: adminRoleId },
          userWorkspaceId: { before: null, after: userWorkspace4Id },
        },
      },
    });
  });

  it('rejects requireWorkspaceMember: false for non-system actors', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    const { service, builder } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        requireWorkspaceMember: false,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Only system authentication can assign roles without workspaceMember verification',
    );
    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('audits mixed batch replacement + initial assignment + no-op deduplication with one operationId', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: adminRoleId,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: null,
    });
    await addMember({
      memberId: member3Id,
      userWorkspaceId: userWorkspace3Id,
      userId: user3Id,
      roleId: destinationId,
    });
    await addMember({
      memberId: randomUUID(),
      userWorkspaceId: randomUUID(),
      userId: randomUUID(),
      roleId: adminRoleId,
    });

    const oldTarget1 = (await targets()).find(
      (r) => r.userWorkspaceId === userWorkspace1Id,
    )!;
    const { service } = serviceFixture();

    await service.assignRoleToManyUserWorkspace({
      workspaceId,
      userWorkspaceIds: [
        userWorkspace1Id,
        userWorkspace2Id,
        userWorkspace3Id,
        userWorkspace1Id,
      ],
      roleId: destinationId,
      auditIdentity: userIdentity(),
    });

    const auditRows = await audits();
    expect(auditRows).toHaveLength(3);
    expect(new Set(auditRows.map((row) => row.operationId)).size).toBe(1);
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      'create',
      'create',
      'delete',
    ]);
    const deleteRow = auditRows.find((row) => row.action === 'delete')!;
    expect(deleteRow).toMatchObject({
      action: 'delete',
      resourceId: oldTarget1.id,
      redactedDiff: {
        changedFields: ['roleId', 'userWorkspaceId'],
        values: {
          roleId: { before: adminRoleId, after: null },
          userWorkspaceId: { before: userWorkspace1Id, after: null },
        },
      },
    });
    const createdUserWorkspaces = auditRows
      .filter((row) => row.action === 'create')
      .map(
        (row) =>
          (
            row.redactedDiff as {
              values: { userWorkspaceId: { after: string } };
            }
          ).values.userWorkspaceId.after,
      )
      .sort();
    expect(createdUserWorkspaces).toEqual(
      [userWorkspace1Id, userWorkspace2Id].sort(),
    );
  });

  it('rejects missing or invalid auditIdentity even when userWorkspaceIds is empty or all targets already have the role', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: destinationId,
    });
    const { service, builder } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [],
        roleId: destinationId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: randomUUID() },
            workspaceMemberId: actorId,
          },
        },
      }),
    ).rejects.toThrow();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        auditIdentity: {
          auth: {
            type: 'system',
            workspace: { id: workspaceId },
          },
        },
      }),
    ).rejects.toThrow('System role audit requires a valid systemActorId');

    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('prevents batch demotion of all administrators simultaneously', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: adminRoleId,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: adminRoleId,
    });
    const { service, builder } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.CANNOT_UNASSIGN_LAST_ADMIN,
    });
    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);

    const thirdAdminMemberId = randomUUID();
    const thirdAdminUserWorkspaceId = randomUUID();
    const thirdAdminUserId = randomUUID();
    await addMember({
      memberId: thirdAdminMemberId,
      userWorkspaceId: thirdAdminUserWorkspaceId,
      userId: thirdAdminUserId,
      roleId: adminRoleId,
    });

    const raceFixture = serviceFixture({
      beforeMigrationRun: async () => {
        await owner.query(
          'UPDATE synthetic_members."workspaceMember" SET "deletedAt"=now() WHERE id=$1',
          [thirdAdminMemberId],
        );
      },
    });

    await expect(
      raceFixture.service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow('Role assignment cannot remove the last administrator');
    expect(await audits()).toEqual([]);
  });

  it('rejects self-assignment via actingUserWorkspaceId or actor workspaceMemberId', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: null,
    });
    const { service, builder } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        actingUserWorkspaceId: userWorkspace2Id,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.CANNOT_UPDATE_SELF_ROLE,
    });

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: workspaceId },
            workspaceMemberId: member2Id,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.CANNOT_UPDATE_SELF_ROLE,
    });

    expect(
      builder.validateBuildAndRunWorkspaceMigration,
    ).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('rejects destination role that cannot be assigned to users', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    await owner.query(
      'UPDATE core.role SET "canBeAssignedToUsers"=false WHERE id=$1',
      [destinationId],
    );
    const { service } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Role assignment destination is unavailable or not assignable',
    );
    expect(await targets()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('rejects deleted or foreign userWorkspace and missing workspaceMember when requireWorkspaceMember is true', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
      includeMemberRow: false,
    });
    const { service } = serviceFixture();

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.WORKSPACE_MEMBER_NOT_FOUND,
    });

    await owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
      [userWorkspace1Id],
    );

    await expect(
      service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id],
        roleId: destinationId,
        requireWorkspaceMember: false,
        auditIdentity: systemIdentity(),
      }),
    ).rejects.toMatchObject({
      code: PermissionsExceptionCode.USER_WORKSPACE_NOT_FOUND,
    });

    expect(await audits()).toEqual([]);
  });

  it('rolls back both core.roleTarget and crm_audit.crmAuditEntry on handler failure or plan drift', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: adminRoleId,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: null,
    });
    await addMember({
      memberId: member3Id,
      userWorkspaceId: userWorkspace3Id,
      userId: user3Id,
      roleId: adminRoleId,
    });

    const failing = serviceFixture({ failMigration: true });
    await expect(
      failing.service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow('handler failure');
    expect(
      (await targets()).find((r) => r.userWorkspaceId === userWorkspace1Id)
        ?.roleId,
    ).toBe(adminRoleId);
    expect(
      (await targets()).find((r) => r.userWorkspaceId === userWorkspace2Id),
    ).toBeUndefined();
    expect(await audits()).toEqual([]);

    const tampered = serviceFixture({
      tamperOperations: (operations) => {
        operations.flatEntityToCreate[0].userWorkspaceId = randomUUID();
      },
    });
    await expect(
      tampered.service.assignRoleToManyUserWorkspace({
        workspaceId,
        userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
        roleId: destinationId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Bulk role assignment final plan points to a different target',
    );
    expect(await audits()).toEqual([]);
  });

  it('rejects nested or conflicting audit scopes and mismatched delegation inside withRoleAssignmentAudit', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    await addMember({
      memberId: member2Id,
      userWorkspaceId: userWorkspace2Id,
      userId: user2Id,
      roleId: null,
    });
    const { service } = serviceFixture();

    await expect(
      withRoleUpdateAudit(workspaceId, destinationId, userIdentity(), () =>
        service.assignRoleToManyUserWorkspace({
          workspaceId,
          userWorkspaceIds: [userWorkspace1Id],
          roleId: destinationId,
          auditIdentity: userIdentity(),
        }),
      ),
    ).rejects.toThrow('Nested role assignment audit unsupported');

    await expect(
      withBulkUserRoleAssignmentAudit(
        {
          workspaceId,
          roleId: destinationId,
          targets: [
            {
              userWorkspaceId: userWorkspace1Id,
              userId: user1Id,
              workspaceMemberId: member1Id,
            },
          ],
        },
        userIdentity(),
        () =>
          service.assignRoleToManyUserWorkspace({
            workspaceId,
            userWorkspaceIds: [userWorkspace1Id],
            roleId: destinationId,
            auditIdentity: userIdentity(),
          }),
      ),
    ).rejects.toThrow(
      'Bulk role assignment conflicts with active role assignment audit scope',
    );

    await expect(
      withRoleAssignmentAudit(
        {
          workspaceId,
          workspaceMemberId: member1Id,
          userId: user1Id,
          userWorkspaceId: userWorkspace1Id,
          roleId: destinationId,
        },
        userIdentity(),
        () =>
          service.assignRoleToManyUserWorkspace({
            workspaceId,
            userWorkspaceIds: [userWorkspace1Id, userWorkspace2Id],
            roleId: destinationId,
          }),
      ),
    ).rejects.toThrow(
      'Bulk role assignment conflicts with active role assignment audit scope',
    );

    expect(await audits()).toEqual([]);
  });

  it('captures userWorkspaceIds and auditIdentity before the first await', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    const { service } = serviceFixture();
    const mutableIds = [userWorkspace1Id];
    const mutableIdentity = userIdentity();

    const pending = service.assignRoleToManyUserWorkspace({
      workspaceId,
      userWorkspaceIds: mutableIds,
      roleId: destinationId,
      auditIdentity: mutableIdentity,
    });
    mutableIds.length = 0;
    mutableIds.push(randomUUID());
    (mutableIdentity.auth as { workspaceMemberId: string }).workspaceMemberId =
      randomUUID();
    await pending;

    const auditRows = await audits();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor).toEqual({
      kind: 'workspaceMember',
      id: actorId,
    });
    expect(
      (await targets()).find((r) => r.userWorkspaceId === userWorkspace1Id)
        ?.roleId,
    ).toBe(destinationId);
  });

  it('suppresses rollback and invalidates cache on NativeTransactionOutcomeUnknownError after commit', async () => {
    await addMember({
      memberId: member1Id,
      userWorkspaceId: userWorkspace1Id,
      userId: user1Id,
      roleId: null,
    });
    const f = await fixture();
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

    const now = new Date().toISOString();
    await expect(
      withBulkUserRoleAssignmentAudit(
        {
          workspaceId,
          roleId: destinationId,
          targets: [
            {
              userWorkspaceId: userWorkspace1Id,
              userId: user1Id,
              workspaceMemberId: member1Id,
            },
          ],
        },
        userIdentity(),
        () =>
          f.migration.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier,
              actions: [
                {
                  type: 'create',
                  metadataName: 'roleTarget',
                  id: randomUUID(),
                  flatEntity: {
                    universalIdentifier: randomUUID(),
                    roleUniversalIdentifier: destinationUniversalIdentifier,
                    userWorkspaceId: userWorkspace1Id,
                    agentUniversalIdentifier: null,
                    apiKeyId: null,
                    applicationUniversalIdentifier,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ],
            } as never,
          }),
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements).not.toContain('ROLLBACK');
    expect(f.registry.executeActionRollbackHandler).not.toHaveBeenCalled();
    expect(f.cache.invalidateAndRecompute).toHaveBeenCalledTimes(1);
    expect(await audits()).toHaveLength(1);
    expect(
      (await targets()).find((r) => r.userWorkspaceId === userWorkspace1Id)
        ?.roleId,
    ).toBe(destinationId);
  });
});
