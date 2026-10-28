import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import {
  getRoleUpdateAudit,
  roleAuditIdentityFromRequest,
  runAuditedRoleUpdate,
  withRoleUpdateAudit,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditMutation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { compareTwoFlatEntity } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/utils/compare-two-universal-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));

// Keep transport, cache and unrelated metadata registries outside this PG fixture.
for (const [path, name] of [
  ['core-modules/api-key/services/api-key-role.service', 'ApiKeyRoleService'],
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
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({ WorkspaceMigrationRunnerActionHandler: () => class {} }),
);
jest.mock('src/engine/metadata-modules/role/role.entity', () => ({
  RoleEntity: class RoleEntity {},
}));
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock('src/engine/metadata-modules/role/dtos/role.dto', () => ({
  RoleDTO: class {},
}));

const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { UpdateRoleActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/update-role-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role/services/update-role-action-handler.service');
const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const { RoleService } =
  require('src/engine/metadata-modules/role/role.service') as typeof import('src/engine/metadata-modules/role/role.service');
const { UpdateRoleTool } =
  require('src/engine/metadata-modules/role/tools/update-role.tool') as typeof import('src/engine/metadata-modules/role/tools/update-role.tool');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');
const databaseRole = `role_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(),
  roleId = randomUUID(),
  universalIdentifier = randomUUID(),
  applicationId = randomUUID(),
  applicationUniversalIdentifier = randomUUID(),
  actorId = randomUUID();
const booleans = [
  'canUpdateAllSettings',
  'canAccessAllTools',
  'canAccessAllAgentChatChannels',
  'canReadAllObjectRecords',
  'canUpdateAllObjectRecords',
  'canSoftDeleteAllObjectRecords',
  'canDestroyAllObjectRecords',
  'canBeAssignedToUsers',
  'canBeAssignedToAgents',
  'canBeAssignedToApiKeys',
];
const roleSchema = new EntitySchema({
  name: 'RoleEntity',
  target: RoleEntity,
  tableName: 'role',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    label: { type: 'text' },
    description: { type: 'text', nullable: true },
    icon: { type: 'text', nullable: true },
    isEditable: { type: Boolean, default: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    ...Object.fromEntries(
      booleans.map((name) => [name, { type: Boolean, default: false }]),
    ),
  },
});
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [roleSchema],
  extra: { max: 4, statement_timeout: 10000 },
});
const url = new URL(databaseUrl);
url.username = databaseRole;
url.password = 'isolated-role-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: url.toString(),
  entities: [roleSchema],
  extra: { max: 4, statement_timeout: 10000 },
});
const identity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorId,
  },
});
const action = (
  update: Record<string, unknown> = {
    label: 'new private role label',
    canReadAllObjectRecords: true,
  },
) => ({
  type: 'update' as const,
  metadataName: 'role' as const,
  universalIdentifier,
  update,
});
const rows = () => owner.query('SELECT * FROM core.role ORDER BY id');
const audits = () =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );
const services = (
  options: {
    staleLabel?: string;
    mappedId?: string;
    deferred?: boolean;
    fail?: boolean;
  } = {},
) => {
  const flatRole = {
    id: options.mappedId ?? roleId,
    workspaceId,
    universalIdentifier,
    label: options.staleLabel ?? 'cached role',
  };
  const maps = {
    flatRoleMaps: {
      byUniversalIdentifier: { [universalIdentifier]: flatRole },
      universalIdentifierById: { [flatRole.id]: universalIdentifier },
    },
  };
  const handler = new UpdateRoleActionHandlerService();
  const registry = {
    executeActionHandler: jest.fn(async ({ context }) => {
      const flatAction =
        await handler.transpileUniversalActionToFlatAction(context);
      await handler.executeForMetadata({ ...context, flatAction });
      if (options.fail) throw new Error('handler failure');
      return {
        partialOptimisticCache: {},
        metadataEvents: [{ marker: 'synthetic metadata event' }],
        deferredActions: options.deferred ? [{}] : [],
      };
    }),
    executeActionRollbackHandler: jest.fn(),
  };
  const cache = {
    getOrRecompute: async () => ({
      flatApplicationMaps: {
        idByUniversalIdentifier: {
          [applicationUniversalIdentifier]: applicationId,
        },
        byId: {
          [applicationId]: {
            id: applicationId,
            universalIdentifier: applicationUniversalIdentifier,
          },
        },
      },
    }),
    invalidateAndRecompute: jest.fn(async () => {}),
  };
  const deferred = { persist: jest.fn(), dispatchAfterCommit: jest.fn() };
  const logger = {
    perf: jest.fn(),
    perfTime: jest.fn(),
    perfTimeEnd: jest.fn(),
    error: jest.fn(),
  };
  const service = new WorkspaceMigrationRunnerService(
    { getOrRecomputeManyOrAllFlatEntityMaps: async () => maps } as never,
    runtime,
    registry as never,
    {} as never,
    cache as never,
    { recordHistogram: jest.fn() } as never,
    logger as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    deferred as never,
    {} as never,
  );
  return { service, registry, cache, deferred, logger };
};
const run = (s = services(), change = action(), who = identity()) =>
  withRoleUpdateAudit(workspaceId, roleId, who, () =>
    s.service.run({
      workspaceId,
      workspaceMigration: {
        applicationUniversalIdentifier,
        actions: [change],
      } as never,
    }),
  );

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await owner.query(
    'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY,"userId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(`CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-role-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
    GRANT UPDATE ON core.role TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`);
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.corrupt_audit(); TRUNCATE core.role,core."userWorkspace",crm_audit."crmAuditEntry"',
  );
  await owner.getRepository(RoleEntity).insert({
    id: roleId,
    workspaceId,
    universalIdentifier,
    applicationId,
    label: 'actual private role label',
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

it('runs the real migration owner and update handler with actual row snapshots, actor and redaction', async () => {
  const s = services({ staleLabel: 'new private role label' });
  const result = await run(s);
  expect(result.metadataEvents).toHaveLength(1);
  expect(s.cache.invalidateAndRecompute).toHaveBeenCalledTimes(1);
  expect(s.registry.executeActionRollbackHandler).not.toHaveBeenCalled();
  expect(s.deferred.dispatchAfterCommit).not.toHaveBeenCalled();
  const [entry] = await audits();
  expect(entry.resourceKind).toBe('role');
  expect(entry.resourceId).toBe(roleId);
  expect(entry.actor).toEqual({ kind: 'workspaceMember', id: actorId });
  expect(entry.securityDescriptor).toEqual({
    resourceKind: 'role',
    resourceId: roleId,
    metadataAccess: 'currentWorkspaceAdministration',
  });
  expect(JSON.stringify(entry)).not.toContain('private role label');
  expect(JSON.stringify(entry.redactedDiff)).toContain('label');
  expect((await rows())[0].canReadAllObjectRecords).toBe(true);
});

it.each(['audit', 'handler', 'sql', 'deferred'])(
  'rolls back role update on %s failure',
  async (failure) => {
    const before = await rows(),
      s = services({
        fail: failure === 'handler',
        deferred: failure === 'deferred',
      });
    if (failure === 'audit')
      await owner.query(
        `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
      );
    if (failure === 'sql')
      await owner.query(`REVOKE UPDATE ON core.role FROM "${databaseRole}"`);
    try {
      await expect(run(s)).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"; GRANT UPDATE ON core.role TO "${databaseRole}"`,
      );
    }
    expect(await rows()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(s.registry.executeActionRollbackHandler).not.toHaveBeenCalled();
    expect(s.cache.invalidateAndRecompute).toHaveBeenCalledTimes(1);
  },
);

it('rejects a cached mapping that redirects the action to another role', async () => {
  await expect(run(services({ mappedId: randomUUID() }))).rejects.toThrow(
    'different record',
  );
  expect(await audits()).toEqual([]);
});
it.each(['isEditable', 'universalIdentifier', 'workspaceId'])(
  'rejects changed persisted %s before the handler',
  async (field) => {
    await owner.query(`UPDATE core.role SET "${field}"=$1`, [
      field === 'isEditable' ? false : randomUUID(),
    ]);
    const s = services();
    await expect(run(s)).rejects.toThrow();
    expect(s.registry.executeActionHandler).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  },
);

it('rolls back a role corrupted by an audit trigger after flush', async () => {
  const before = await rows();
  await owner.query(
    'CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core.role SET "isEditable"=false; RETURN NEW; END $$; CREATE TRIGGER corrupt_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()',
  );
  await expect(run()).rejects.toThrow('snapshot changed');
  expect(await rows()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('audits two serialized updates from fresh persisted state', async () => {
  await Promise.all([
    run(services(), action({ label: 'one' })),
    run(services(), action({ label: 'two' })),
  ]);
  expect(await audits()).toHaveLength(2);
  expect(
    new Set((await audits()).map((e: { operationId: string }) => e.operationId))
      .size,
  ).toBe(2);
});

it('preserves an agent actor and the calling user as initiator', async () => {
  const agentId = randomUUID();
  await run(services(), action(), { ...identity(), agentId });
  const [entry] = await audits();
  expect(entry.actor).toEqual({ kind: 'agent', id: agentId });
  expect(entry.initiator).toEqual({ kind: 'workspaceMember', id: actorId });
});
it('resolves a verified impersonation membership into the initiating core user', async () => {
  const membershipId = randomUUID(),
    userId = randomUUID();
  await owner.query('INSERT INTO core."userWorkspace" VALUES($1,$2,NULL)', [
    membershipId,
    userId,
  ]);
  await run(services(), action(), {
    ...identity(),
    impersonatorUserWorkspaceId: membershipId,
  });
  expect((await audits())[0].initiator).toEqual({
    kind: 'coreUser',
    id: userId,
  });
});
it('refuses unknown impersonation membership before mutation', async () => {
  const before = await rows();
  await expect(
    run(services(), action(), {
      ...identity(),
      impersonatorUserWorkspaceId: randomUUID(),
    }),
  ).rejects.toThrow('initiator unavailable');
  expect(await rows()).toEqual(before);
});

it('does not compensate or return metadata events after actual lost COMMIT acknowledgement', async () => {
  const create = runtime.createQueryRunner.bind(runtime),
    statements: string[] = [],
    clients = new WeakSet<object>();
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!clients.has(client)) {
        clients.add(client);
        const query = client.query.bind(client);
        client.query = async (sql: string, ...args: unknown[]) => {
          statements.push(sql);
          const result = await query(sql, ...args);
          if (sql === 'COMMIT') throw new Error('lost role ACK');
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  const s = services();
  await expect(run(s)).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(s.registry.executeActionRollbackHandler).not.toHaveBeenCalled();
  expect(s.cache.invalidateAndRecompute).toHaveBeenCalledTimes(1);
  expect(await audits()).toHaveLength(1);
  expect((await rows())[0].label).toBe('new private role label');
});

it.each(['create', 'foreign-object', 'multiple', 'bad-field'])(
  'rejects unsupported final action %s',
  async (kind) => {
    const actions =
      kind === 'multiple'
        ? [action(), action()]
        : [
            {
              ...action(),
              ...(kind === 'create' ? { type: 'create' } : {}),
              ...(kind === 'foreign-object'
                ? { metadataName: 'objectMetadata' }
                : {}),
              ...(kind === 'bad-field'
                ? { update: { isEditable: false } }
                : {}),
            },
          ];
    const work = jest.fn(async () => {});
    await expect(
      withRoleUpdateAudit(workspaceId, roleId, identity(), () =>
        runAuditedRoleUpdate(
          runtime,
          getRoleUpdateAudit(workspaceId)!,
          actions,
          work,
        ),
      ),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  },
);

it('rejects operation reuse and a detached inactive async scope', async () => {
  let detached: (() => Promise<void>) | undefined;
  await withRoleUpdateAudit(workspaceId, roleId, identity(), async () => {
    const request = getRoleUpdateAudit(workspaceId)!;
    const work = async (runner: QueryRunner) => {
      await runner.query('UPDATE core.role SET label=$1 WHERE id=$2', [
        'first',
        roleId,
      ]);
    };
    await runAuditedRoleUpdate(
      runtime,
      request,
      [action({ label: 'first' })],
      work,
    );
    await expect(
      runAuditedRoleUpdate(runtime, request, [action()], work),
    ).rejects.toThrow('consumed');
    detached = () => runAuditedRoleUpdate(runtime, request, [action()], work);
  });
  await expect(detached!()).rejects.toThrow('not active');
});

it.each(['missing', 'extra', 'wrong-kind', 'wrong-action'])(
  'rejects invalid role descriptor %s',
  (kind) => {
    const audit = new CrmAuditTransactionContext(
      { isTransactionActive: true, query: jest.fn() } as never,
      {
        workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'workspaceMember', id: actorId },
      },
    );
    expect(() =>
      audit.record({
        resourceKind: 'role',
        resourceId: roleId,
        action: kind === 'wrong-action' ? 'delete' : 'update',
        before: { label: 'a' },
        after: { label: 'b' },
        securityDescriptor: {
          resourceKind: kind === 'wrong-kind' ? 'crmRecord' : 'role',
          resourceId: roleId,
          ...(kind === 'missing'
            ? {}
            : { metadataAccess: 'currentWorkspaceAdministration' }),
          ...(kind === 'extra' ? { bindingId: randomUUID() } : {}),
        },
      } as CrmAuditMutation),
    ).toThrow();
  },
);

it('projects authenticated request fields without accepting body-selected identity', async () => {
  const who = roleAuditIdentityFromRequest({
    workspace: { id: workspaceId },
    apiKey: { id: actorId },
  });
  await run(services(), action(), who);
  expect((await audits())[0].actor).toEqual({ kind: 'apiKey', id: actorId });
  await expect(
    run(
      services(),
      action(),
      roleAuditIdentityFromRequest({ workspace: { id: workspaceId } }),
    ),
  ).rejects.toThrow('cannot perform');
});

const roleServiceFixture = (waitForOwner = async () => {}) => {
  const migration = services();
  const builder = {
    validateBuildAndRunWorkspaceMigration: jest.fn(async (args) => {
      const changed =
        args.allFlatEntityOperationByMetadataName.role.flatEntityToUpdate[0];
      const [before] = await rows();
      const update = compareTwoFlatEntity({
        fromUniversalFlatEntity: before,
        toUniversalFlatEntity: changed,
        metadataName: 'role',
      });
      if (!update) return { status: 'success' };
      await migration.service.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier,
          actions: [action(update)],
        } as never,
      });
      return { status: 'success' };
    }),
  };
  const service = new RoleService(
    builder as never,
    {
      getOrRecomputeManyOrAllFlatEntityMaps: async () => {
        const [row] = await rows();
        return {
          flatRoleMaps: {
            byUniversalIdentifier: {
              [universalIdentifier]: { ...row, rolePermissionFlagIds: [] },
            },
            universalIdentifierById: { [roleId]: universalIdentifier },
          },
          flatRolePermissionFlagMaps: {
            byUniversalIdentifier: {},
            universalIdentifierById: {},
          },
        };
      },
    } as never,
    {} as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => {
        await waitForOwner();
        return {
          workspaceCustomFlatApplication: {
            id: applicationId,
            universalIdentifier: applicationUniversalIdentifier,
          },
        };
      },
    } as never,
    {} as never,
  );
  return { service, builder, migration };
};

it('captures service input before awaiting owner/cache work', async () => {
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { service } = roleServiceFixture(() => barrier);
  const input = { id: roleId, update: { label: 'captured' } },
    auditIdentity = identity();
  const result = service.updateRole({ workspaceId, input, auditIdentity });
  input.id = randomUUID();
  input.update.label = 'mutated';
  auditIdentity.auth.workspace.id = randomUUID();
  unblock();
  await result;
  expect((await rows())[0].label).toBe('captured');
  expect((await audits())[0].workspaceId).toBe(workspaceId);
});

it('keeps the real service self-lockout check before the migration', async () => {
  await owner.query('UPDATE core.role SET "canUpdateAllSettings"=true');
  const { service, builder } = roleServiceFixture();
  await expect(
    service.updateRole({
      workspaceId,
      input: { id: roleId, update: { canUpdateAllSettings: false } },
      actingRoleIds: [roleId],
      auditIdentity: identity(),
    }),
  ).rejects.toThrow('Cannot revoke settings access');
  expect(builder.validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  expect(await audits()).toEqual([]);
});

it('runs the real AI update tool through the service and migration owner', async () => {
  const { service } = roleServiceFixture(),
    tool = new UpdateRoleTool(service),
    agentId = randomUUID();
  const result = await tool.execute({
    input: { roleId, update: { label: 'tool role' } },
    context: {
      workspaceId,
      authContext: identity().auth,
      agentId,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
    },
  } as never);
  expect(result.success).toBe(true);
  expect((await rows())[0].label).toBe('tool role');
  expect((await audits())[0].actor).toEqual({ kind: 'agent', id: agentId });
});

it('refuses the tool without resolved authentication instead of silently using a legacy writer', async () => {
  const { service, builder } = roleServiceFixture(),
    tool = new UpdateRoleTool(service);
  await expect(
    tool.execute({
      input: { roleId, update: { label: 'unauthenticated' } },
      context: {
        workspaceId,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    } as never),
  ).rejects.toThrow('authenticated audit identity');
  expect(builder.validateBuildAndRunWorkspaceMigration).not.toHaveBeenCalled();
  expect(await audits()).toEqual([]);
});

it('records an executed update with an empty diff when values were already current', async () => {
  await run(services(), action({ label: 'actual private role label' }));
  expect((await audits())[0].redactedDiff).toEqual({
    changedFields: [],
    values: {},
  });
});

it('keeps a builder no-op without mutation or success audit', async () => {
  const { service, migration } = roleServiceFixture();
  await service.updateRole({
    workspaceId,
    input: { id: roleId, update: { label: 'actual private role label' } },
    auditIdentity: identity(),
  });
  expect(migration.registry.executeActionHandler).not.toHaveBeenCalled();
  expect(await audits()).toEqual([]);
});

it('does not mask commit outcome when cache invalidation itself fails', async () => {
  const s = services();
  s.cache.invalidateAndRecompute.mockRejectedValueOnce(
    new Error('cache unavailable'),
  );
  await run(s);
  expect(await audits()).toHaveLength(1);
  expect(s.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('cache unavailable'),
    'Runner',
  );
});
