import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { UsageLimitExceptionCode } from 'src/engine/core-modules/usage-limit/exceptions/usage-limit.exception';
import { UsageOperationType } from 'src/engine/core-modules/usage/enums/usage-operation-type.enum';
import { UsageResourceType } from 'src/engine/core-modules/usage/enums/usage-resource-type.enum';
import { UsageUnit } from 'src/engine/core-modules/usage/enums/usage-unit.enum';

for (const [modPath, names] of [
  ['src/engine/core-modules/api-key/api-key.entity', ['ApiKeyEntity']],
  [
    'src/engine/core-modules/application/application.entity',
    ['ApplicationEntity'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-agent/entities/agent.entity',
    ['AgentEntity'],
  ],
  [
    'src/engine/metadata-modules/logic-function/logic-function.entity',
    ['LogicFunctionEntity'],
  ],
  [
    'src/engine/core-modules/usage-limit/usage-limit.entity',
    ['UsageLimitEntity'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-limit-entitlement.service',
    ['UsageLimitEntitlementService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-limit-quota.service',
    ['UsageLimitQuotaService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-limit-stock.service',
    ['UsageLimitStockService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-period.service',
    ['UsagePeriodService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-quota-consumption.service',
    ['UsageQuotaConsumptionService'],
  ],
  [
    'src/engine/core-modules/usage-limit/services/usage-quota-definition.service',
    ['UsageQuotaDefinitionService'],
  ],
  [
    'src/engine/core-modules/usage-limit/filters/usage-limit-graphql-api-exception.filter',
    ['UsageLimitGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/create-usage-limit.input',
    ['CreateUsageLimitInput'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/update-usage-limit.input',
    ['UpdateUsageLimitInput'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/usage-limit.dto',
    ['UsageLimitDTO'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/usage-quota-definitions.dto',
    ['UsageQuotaDefinitionsDTO'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/usage-quota-with-consumption.dto',
    ['UsageQuotaWithConsumptionDTO'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/usage-quota-scope-consumption.dto',
    ['UsageQuotaScopeConsumptionDTO'],
  ],
  [
    'src/engine/core-modules/usage-limit/dtos/usage-quota-scope.input',
    ['UsageQuotaScopeInput'],
  ],
  [
    'src/engine/core-modules/admin-panel/dtos/admin-panel-usage-limit.input',
    [
      'AdminPanelCreateUsageLimitInput',
      'AdminPanelDeleteUsageLimitInput',
      'AdminPanelUpdateUsageLimitInput',
      'AdminPanelWorkspaceUsageLimitsInput',
    ],
  ],
  [
    'src/engine/core-modules/admin-panel/dtos/admin-panel-workspace-usage-limits.dto',
    ['AdminPanelUsageLimitDTO', 'AdminPanelWorkspaceUsageLimitsDTO'],
  ],
  [
    'src/engine/core-modules/admin-panel/services/admin-panel-usage-limit.service',
    ['AdminPanelUsageLimitService'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
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
    'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars',
    ['UUIDScalarType'],
  ],
  ['src/engine/guards/admin-panel-guard', ['AdminPanelGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

jest.doMock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => undefined,
  }),
);
jest.doMock(
  'src/engine/api/graphql/graphql-config/decorators/admin-resolver.decorator',
  () => ({
    AdminResolver: () => () => undefined,
  }),
);
jest.doMock('src/engine/decorators/auth/auth-workspace.decorator', () => ({
  AuthWorkspace: () => () => undefined,
}));
jest.doMock('src/engine/decorators/auth/auth-user.decorator', () => ({
  AuthUser: () => () => undefined,
}));
jest.doMock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.doMock('src/engine/guards/settings-permission.guard', () => ({
  SettingsPermissionGuard: () => class {},
}));
jest.doMock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({
    InjectWorkspaceScopedRepository: () => () => undefined,
  }),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UsageLimitEntity } =
  require('src/engine/core-modules/usage-limit/usage-limit.entity') as {
    UsageLimitEntity: new () => Record<string, unknown>;
  };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UsageLimitService } =
  require('src/engine/core-modules/usage-limit/services/usage-limit.service') as typeof import('src/engine/core-modules/usage-limit/services/usage-limit.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UsageLimitResolver } =
  require('src/engine/core-modules/usage-limit/usage-limit.resolver') as typeof import('src/engine/core-modules/usage-limit/usage-limit.resolver');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AdminPanelUsageLimitResolver } =
  require('src/engine/core-modules/admin-panel/admin-panel-usage-limit.resolver') as typeof import('src/engine/core-modules/admin-panel/admin-panel-usage-limit.resolver');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url) throw new Error('FORK_MIGRATION_TEST_URL is required');

const role = `usage_limit_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const usageLimitSchema = new EntitySchema<Record<string, unknown>>({
  name: 'UsageLimitAuditFixture',
  target: UsageLimitEntity,
  schema: 'core',
  tableName: 'usageLimit',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    resourceType: { type: 'varchar' },
    operationType: { type: 'varchar' },
    spenderType: { type: 'varchar' },
    spenderId: { type: 'varchar', default: '' },
    limitKind: { type: 'varchar' },
    periodCount: { type: 'int' },
    periodUnit: { type: 'varchar' },
    unit: { type: 'varchar' },
    limitValue: {
      type: 'bigint',
      transformer: {
        to: (value: number | null) => value,
        from: (value: string | null) => (value === null ? null : Number(value)),
      },
    },
    burstValue: {
      type: 'bigint',
      nullable: true,
      transformer: {
        to: (value: number | null) => value,
        from: (value: string | null) => (value === null ? null : Number(value)),
      },
    },
    isInstanceOverride: { type: 'boolean', default: false },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [usageLimitSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-usage-limit-audit';

const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [usageLimitSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const adminUserId = randomUUID();
const adminUserWorkspaceId = randomUUID();
const appSpenderId = randomUUID();

const invalidateCacheMock = jest.fn(async () => {});
const dropQuotaCounterMock = jest.fn(async () => {});
const dropStockCounterMock = jest.fn(async () => {});

const createService = () =>
  new UsageLimitService(
    { find: jest.fn(async () => []) } as never,
    { existsBy: jest.fn(async () => true) } as never,
    { existsBy: jest.fn(async () => true) } as never,
    { existsBy: jest.fn(async () => true) } as never,
    { existsBy: jest.fn(async () => true) } as never,
    { existsBy: jest.fn(async () => true) } as never,
    { invalidateAndRecompute: invalidateCacheMock } as never,
    { dropLimitCounter: dropQuotaCounterMock } as never,
    { dropLimitCounter: dropStockCounterMock } as never,
    { isIntraWorkspaceLimitEntitled: jest.fn(async () => true) } as never,
    { hasAllowancePeriod: jest.fn(async () => true) } as never,
    runtime,
  );

const readUsageLimitAudits = async (wsId = workspaceId) =>
  owner.query(
    `SELECT id, "operationId", "correlationId", "resourceKind", "resourceId", action,
            actor, initiator, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
        AND "resourceKind" = 'usageLimit'
      ORDER BY "createdAt" ASC, id ASC`,
    [wsId],
  );

const quotaInput = (overrides: Record<string, unknown> = {}) =>
  ({
    resourceType: UsageResourceType.ALL,
    operationType: UsageOperationType.ALL,
    spenderType: 'application',
    spenderId: appSpenderId,
    limitKind: 'quota',
    periodCount: 1,
    periodUnit: 'month',
    unit: UsageUnit.CREDIT,
    limitValue: 1000,
    burstValue: null,
    ...overrides,
  }) as never;

describe('LOG194 transactional usageLimit audit (PostgreSQL)', () => {
  beforeAll(async () => {
    await owner.initialize();

    await owner.query(`DROP SCHEMA IF EXISTS crm_audit CASCADE`);
    await owner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
    await owner.query(`CREATE SCHEMA core`);

    await owner.query(`
      CREATE TABLE core.workspace (
        id uuid PRIMARY KEY,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."user" (
        id uuid PRIMARY KEY,
        email text UNIQUE NOT NULL,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."userWorkspace" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."usageLimit" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "resourceType" varchar NOT NULL,
        "operationType" varchar NOT NULL,
        "spenderType" varchar NOT NULL,
        "spenderId" varchar NOT NULL DEFAULT '',
        "limitKind" varchar NOT NULL,
        "periodCount" int NOT NULL,
        "periodUnit" varchar NOT NULL,
        unit varchar NOT NULL,
        "limitValue" bigint NOT NULL,
        "burstValue" bigint NULL,
        "isInstanceOverride" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_USAGE_LIMIT_SCOPE" UNIQUE (
          "workspaceId",
          "resourceType",
          "operationType",
          "spenderType",
          "spenderId",
          "limitKind",
          "periodCount",
          "periodUnit",
          unit
        )
      )
    `);

    const bootstrapRunner = owner.createQueryRunner();
    try {
      await new OmniAuditBootstrapFastInstanceCommand().up(bootstrapRunner);
    } finally {
      await bootstrapRunner.release();
    }

    await owner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-usage-limit-audit';
        END IF;
      END
      $$;
    `);
    await owner.query(`GRANT USAGE ON SCHEMA core, crm_audit TO "${role}"`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${role}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
    );
    await owner.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON crm_audit."crmAuditEntry" FROM "${role}"`,
    );

    await owner.query(`INSERT INTO core.workspace (id) VALUES ($1), ($2)`, [
      workspaceId,
      otherWorkspaceId,
    ]);
    await owner.query(
      `INSERT INTO core."user" (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [
        actorUserId,
        'owner@acme.test',
        impersonatorUserId,
        'impersonator@acme.test',
        adminUserId,
        'server-admin@acme.test',
      ],
    );
    await owner.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId")
       VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
      [
        actorUserWorkspaceId,
        actorUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
        workspaceId,
        adminUserWorkspaceId,
        adminUserId,
        workspaceId,
      ],
    );

    await runtime.initialize();
  });

  beforeEach(async () => {
    invalidateCacheMock.mockClear();
    dropQuotaCounterMock.mockClear();
    dropStockCounterMock.mockClear();
    await owner.query(`DELETE FROM core."usageLimit"`);
    await owner.query(`DELETE FROM crm_audit."crmAuditEntry"`);
  });

  afterAll(async () => {
    if (runtime.isInitialized) await runtime.destroy();
    if (owner.isInitialized) {
      await owner.query(`DROP SCHEMA IF EXISTS crm_audit CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.destroy();
    }
  });

  it('audits createUsageLimit, updateUsageLimit, and deleteUsageLimit via UsageLimitResolver with impersonation', async () => {
    const service = createService();
    const resolver = new UsageLimitResolver(service, {} as never, {} as never);

    const requestContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        impersonationContext: {
          impersonatorUserWorkspaceId,
        },
      },
    };

    const created = await resolver.createUsageLimit(
      { id: workspaceId } as never,
      quotaInput({ limitValue: 1500 }),
      requestContext,
    );

    expect(created.limitValue).toBe(1500);
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
    expect(dropQuotaCounterMock).toHaveBeenCalledTimes(1);

    const updated = await resolver.updateUsageLimit(
      { id: workspaceId } as never,
      {
        id: created.id,
        payload: quotaInput({ limitValue: 2500 }),
      } as never,
      requestContext,
    );
    expect(updated.limitValue).toBe(2500);

    const deleted = await resolver.deleteUsageLimit(
      { id: workspaceId } as never,
      created.id,
      requestContext,
    );
    expect(deleted).toBe(true);

    const deletedAgain = await resolver.deleteUsageLimit(
      { id: workspaceId } as never,
      created.id,
      requestContext,
    );
    expect(deletedAgain).toBe(false);

    const audits = await readUsageLimitAudits();
    expect(audits).toHaveLength(3);
    expect(audits.map((row: { action: string }) => row.action)).toEqual([
      'create',
      'update',
      'delete',
    ]);

    expect(audits[0]).toMatchObject({
      resourceKind: 'usageLimit',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'usageLimit',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values.limitValue).toEqual({
      before: null,
      after: '1500',
    });
    expect(audits[0].redactedDiff.values.isInstanceOverride).toEqual({
      before: null,
      after: false,
    });

    expect(audits[1].redactedDiff.values).toEqual({
      limitValue: { before: '1500', after: '2500' },
    });

    expect(audits[2].redactedDiff.values.limitValue).toEqual({
      before: '2500',
      after: null,
    });
  });

  it('audits cross-workspace operator create/update/delete via AdminPanelUsageLimitResolver with burstValue', async () => {
    const service = createService();
    const adminResolver = new AdminPanelUsageLimitResolver(
      {} as never,
      service,
    );

    const adminContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: adminUserId },
        userWorkspaceId: adminUserWorkspaceId,
        impersonationContext: {
          impersonatorUserWorkspaceId,
        },
      },
    };

    const speedPayload = (limitValue: number, burstValue: number) =>
      ({
        resourceType: UsageResourceType.API,
        operationType: UsageOperationType.API_REQUEST,
        spenderType: 'apiKey',
        spenderId: '',
        limitKind: 'speed',
        periodCount: 60,
        periodUnit: 'second',
        unit: UsageUnit.REQUEST,
        limitValue,
        burstValue,
      }) as never;

    const created = await adminResolver.createWorkspaceUsageLimit(
      {
        workspaceId: otherWorkspaceId,
        payload: speedPayload(500, 100),
      } as never,
      { id: adminUserId } as never,
      adminContext,
    );
    expect(created.limitValue).toBe(500);
    expect(created.burstValue).toBe(100);
    const [createdDbRow] = await owner.query(
      `SELECT "isInstanceOverride" FROM core."usageLimit" WHERE id = $1`,
      [created.id],
    );
    expect(createdDbRow.isInstanceOverride).toBe(true);

    const updated = await adminResolver.updateWorkspaceUsageLimit(
      {
        workspaceId: otherWorkspaceId,
        payload: {
          id: created.id,
          payload: speedPayload(900, 150),
        },
      } as never,
      { id: adminUserId } as never,
      adminContext,
    );
    expect(updated.limitValue).toBe(900);
    expect(updated.burstValue).toBe(150);

    const deleted = await adminResolver.deleteWorkspaceUsageLimit(
      {
        workspaceId: otherWorkspaceId,
        usageLimitId: created.id,
      } as never,
      { id: adminUserId } as never,
      adminContext,
    );
    expect(deleted).toBe(true);

    const audits = await readUsageLimitAudits(otherWorkspaceId);
    expect(audits).toHaveLength(3);
    expect(audits[0].actor).toEqual({ kind: 'coreUser', id: adminUserId });
    expect(audits[0].initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });
    expect(audits[0].redactedDiff.values.isInstanceOverride).toEqual({
      before: null,
      after: true,
    });
    expect(audits[0].redactedDiff.values.burstValue).toEqual({
      before: null,
      after: '100',
    });
    expect(audits[1].redactedDiff.values).toEqual({
      limitValue: { before: '500', after: '900' },
      burstValue: { before: '100', after: '150' },
    });
    expect(audits[2].action).toBe('delete');
  });

  it('rejects non-operator edits of operator overrides and duplicate scopes without writing audit', async () => {
    const service = createService();
    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const operatorLimit = await service.create({
      workspaceId,
      input: quotaInput({ limitValue: 3000 }),
      isOperator: true,
      auditIdentity: identity,
    });

    await expect(
      service.update({
        workspaceId,
        input: {
          id: operatorLimit.id,
          payload: quotaInput({ limitValue: 4000 }),
        } as never,
        isOperator: false,
        auditIdentity: identity,
      }),
    ).rejects.toMatchObject({
      code: UsageLimitExceptionCode.LIMIT_FORBIDDEN,
    });

    await expect(
      service.delete({
        workspaceId,
        usageLimitId: operatorLimit.id,
        isOperator: false,
        auditIdentity: identity,
      }),
    ).rejects.toMatchObject({
      code: UsageLimitExceptionCode.LIMIT_FORBIDDEN,
    });

    await expect(
      service.create({
        workspaceId,
        input: quotaInput({ limitValue: 5000 }),
        isOperator: true,
        auditIdentity: identity,
      }),
    ).rejects.toMatchObject({
      code: UsageLimitExceptionCode.LIMIT_INVALID,
    });

    const audits = await readUsageLimitAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('create');
  });

  it('fails closed without audit identity and enforces workspace isolation', async () => {
    const service = createService();
    const otherIdentity = {
      workspaceId: otherWorkspaceId,
      actor: { kind: 'coreUser' as const, id: adminUserId },
    };
    const wsIdentity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const otherLimit = await service.create({
      workspaceId: otherWorkspaceId,
      input: quotaInput({ limitValue: 777 }),
      isOperator: true,
      auditIdentity: otherIdentity,
    });

    invalidateCacheMock.mockClear();
    dropQuotaCounterMock.mockClear();

    await expect(
      service.create({
        workspaceId,
        input: quotaInput({ limitValue: 888 }),
        isOperator: false,
      }),
    ).rejects.toThrow();

    await expect(
      service.update({
        workspaceId,
        input: {
          id: otherLimit.id,
          payload: quotaInput({ limitValue: 999 }),
        } as never,
        isOperator: false,
      }),
    ).rejects.toThrow();

    await expect(
      service.delete({
        workspaceId,
        usageLimitId: otherLimit.id,
        isOperator: false,
      }),
    ).rejects.toThrow();

    expect(invalidateCacheMock).not.toHaveBeenCalled();
    expect(dropQuotaCounterMock).not.toHaveBeenCalled();

    const crossDelete = await service.delete({
      workspaceId,
      usageLimitId: otherLimit.id,
      isOperator: true,
      auditIdentity: wsIdentity,
    });
    expect(crossDelete).toBe(false);

    await expect(
      service.update({
        workspaceId,
        input: {
          id: otherLimit.id,
          payload: quotaInput({ limitValue: 999 }),
        } as never,
        isOperator: true,
        auditIdentity: wsIdentity,
      }),
    ).rejects.toMatchObject({
      code: UsageLimitExceptionCode.LIMIT_INVALID,
    });

    const stillExists = await owner.query(
      `SELECT id, "limitValue" FROM core."usageLimit" WHERE id = $1`,
      [otherLimit.id],
    );
    expect(stillExists).toHaveLength(1);
    expect(String(stillExists[0].limitValue)).toBe('777');
    expect(await readUsageLimitAudits(workspaceId)).toHaveLength(0);
  });

  it('rolls back create/update/delete on audit flush failure or post-flush row drift without firing post-commit effects', async () => {
    const service = createService();
    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const existing = await service.create({
      workspaceId,
      input: quotaInput({ limitValue: 1200 }),
      isOperator: false,
      auditIdentity: identity,
    });

    invalidateCacheMock.mockClear();
    dropQuotaCounterMock.mockClear();

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_usage_limit_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'usageLimit' THEN
          RAISE EXCEPTION 'simulated usageLimit audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_fail_usage_limit_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_usage_limit_audit();
    `);

    try {
      await expect(
        service.update({
          workspaceId,
          input: {
            id: existing.id,
            payload: quotaInput({ limitValue: 9999 }),
          } as never,
          isOperator: false,
          auditIdentity: identity,
        }),
      ).rejects.toThrow('simulated usageLimit audit failure');

      await expect(
        service.delete({
          workspaceId,
          usageLimitId: existing.id,
          isOperator: false,
          auditIdentity: identity,
        }),
      ).rejects.toThrow('simulated usageLimit audit failure');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_fail_usage_limit_audit ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.fail_on_usage_limit_audit()`,
      );
    }

    expect(invalidateCacheMock).not.toHaveBeenCalled();
    expect(dropQuotaCounterMock).not.toHaveBeenCalled();
    const [rowAfterFail] = await owner.query(
      `SELECT "limitValue" FROM core."usageLimit" WHERE id = $1`,
      [existing.id],
    );
    expect(String(rowAfterFail.limitValue)).toBe('1200');

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.tamper_usage_limit_after_flush()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'usageLimit' AND NEW.action = 'update' THEN
          UPDATE core."usageLimit"
             SET "limitValue" = 424242
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_tamper_usage_limit_after_flush
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_usage_limit_after_flush();
    `);

    try {
      await expect(
        service.update({
          workspaceId,
          input: {
            id: existing.id,
            payload: quotaInput({ limitValue: 2222 }),
          } as never,
          isOperator: false,
          auditIdentity: identity,
        }),
      ).rejects.toThrow('Usage limit state changed during audit flush');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_tamper_usage_limit_after_flush ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.tamper_usage_limit_after_flush()`,
      );
    }

    expect(invalidateCacheMock).not.toHaveBeenCalled();
    const [rowAfterDrift] = await owner.query(
      `SELECT "limitValue" FROM core."usageLimit" WHERE id = $1`,
      [existing.id],
    );
    expect(String(rowAfterDrift.limitValue)).toBe('1200');
  });
});
