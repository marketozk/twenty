import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { WorkspaceInvitationExceptionCode } from 'src/engine/core-modules/workspace-invitation/workspace-invitation.exception';

const AppTokenType = {
  RefreshToken: 'REFRESH_TOKEN',
  InvitationToken: 'INVITATION_TOKEN',
  OnboardingInvitationToken: 'ONBOARDING_INVITATION_TOKEN',
} as const;

jest.mock('twenty-emails', () => ({
  SendInviteLinkEmail: jest.fn(() => ({})),
  renderEmail: jest.fn(async (_tpl: unknown, opts?: { plainText?: boolean }) =>
    opts?.plainText ? 'Plain Text Email' : '<html>Email</html>',
  ),
}));

for (const [modPath, names] of [
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  ['src/engine/core-modules/email/email.service', ['EmailService']],
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
  ['src/engine/core-modules/i18n/i18n.service', ['I18nService']],
  [
    'src/engine/core-modules/onboarding/onboarding.service',
    ['OnboardingService'],
  ],
  ['src/engine/core-modules/throttler/throttler.service', ['ThrottlerService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/core-modules/workspace-invitation/dtos/send-invitations.dto',
    ['SendInvitationsDTO'],
  ],
  [
    'src/engine/core-modules/workspace-invitation/dtos/send-invitations.input',
    ['SendInvitationsInput'],
  ],
  [
    'src/engine/core-modules/workspace-invitation/dtos/workspace-invitation.dto',
    ['WorkspaceInvitation'],
  ],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
    ['RoleAssignmentValidationService'],
  ],
  ['src/engine/twenty-orm/workspace-orm.manager', ['WorkspaceOrmManager']],
  [
    'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
    ['WorkspaceMemberWorkspaceEntity'],
  ],
  [
    'src/engine/core-modules/application/application-oauth/oauth.service',
    ['OAuthService'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  ['src/engine/core-modules/user/user.entity', ['UserEntity']],
  ['src/engine/core-modules/app-token/app-token.entity', ['AppTokenEntity']],
] as const) {
  if (modPath === 'src/engine/core-modules/app-token/app-token.entity') {
    jest.doMock(modPath, () => {
      class AppTokenEntity {}

      return { AppTokenEntity, AppTokenType };
    });
    continue;
  }
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
  'src/engine/decorators/auth/allow-suspended-workspace.decorator',
  () => ({
    AllowSuspendedWorkspace: () => () => undefined,
  }),
);
jest.doMock('src/engine/decorators/auth/auth-application.decorator', () => ({
  AuthApplication: () => () => undefined,
}));
jest.doMock('src/engine/decorators/auth/auth-user.decorator', () => ({
  AuthUser: () => () => undefined,
}));
jest.doMock(
  'src/engine/decorators/auth/auth-user-workspace-id.decorator',
  () => ({
    AuthUserWorkspaceId: () => () => undefined,
  }),
);
jest.doMock('src/engine/decorators/auth/auth-workspace.decorator', () => ({
  AuthWorkspace: () => () => undefined,
}));
jest.doMock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.doMock('src/engine/guards/settings-permission.guard', () => ({
  SettingsPermissionGuard: () => class {},
}));
jest.doMock(
  'src/engine/twenty-orm/utils/build-system-auth-context.util',
  () => ({
    buildSystemAuthContext: (workspaceId: string) => ({ workspaceId }),
  }),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppTokenEntity } =
  require('src/engine/core-modules/app-token/app-token.entity') as {
    AppTokenEntity: new () => Record<string, unknown>;
  };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UserEntity } = require('src/engine/core-modules/user/user.entity') as {
  UserEntity: new () => Record<string, unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UserWorkspaceEntity } =
  require('src/engine/core-modules/user-workspace/user-workspace.entity') as {
    UserWorkspaceEntity: new () => Record<string, unknown>;
  };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkspaceInvitationService } =
  require('src/engine/core-modules/workspace-invitation/services/workspace-invitation.service') as typeof import('src/engine/core-modules/workspace-invitation/services/workspace-invitation.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkspaceInvitationResolver } =
  require('src/engine/core-modules/workspace-invitation/workspace-invitation.resolver') as typeof import('src/engine/core-modules/workspace-invitation/workspace-invitation.resolver');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url) throw new Error('FORK_MIGRATION_TEST_URL is required');

const role = `workspace_invitation_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const userSchema = new EntitySchema({
  name: 'WorkspaceInvitationUserFixture',
  target: UserEntity,
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text', unique: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const userWorkspaceSchema = new EntitySchema<Record<string, unknown>>({
  name: 'WorkspaceInvitationUserWorkspaceFixture',
  target: UserWorkspaceEntity,
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    userId: { type: 'uuid' },
    workspaceId: { type: 'uuid' },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
  relations: {
    user: {
      type: 'many-to-one',
      target: () => UserEntity,
      joinColumn: { name: 'userId' },
    },
  },
});

const appTokenSchema = new EntitySchema({
  name: 'WorkspaceInvitationAppTokenFixture',
  target: AppTokenEntity,
  schema: 'core',
  tableName: 'appToken',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    userId: { type: 'uuid', nullable: true },
    workspaceId: { type: 'uuid', nullable: true },
    type: { type: 'text' },
    value: { type: 'text', nullable: true },
    expiresAt: { type: 'timestamptz' },
    deletedAt: { type: 'timestamptz', nullable: true },
    revokedAt: { type: 'timestamptz', nullable: true },
    context: { type: 'jsonb', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [userSchema, userWorkspaceSchema, appTokenSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-workspace-invitation-audit';

const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [userSchema, userWorkspaceSchema, appTokenSchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const existingMemberUserId = randomUUID();
const existingMemberUserWorkspaceId = randomUUID();
const invitedRoleId = randomUUID();

const sendEmailMock = jest.fn(async () => {});
const completeOnboardingMock = jest.fn(async () => {});

const buildWorkspace = (id: string) =>
  ({
    id,
    displayName: 'Acme Corp',
    inviteHash: 'acme-invite-hash',
    logoFileId: null,
  }) as never;

const buildSender = () =>
  ({
    userId: actorUserId,
    userEmail: 'owner@acme.test',
    name: { firstName: 'Alice', lastName: 'Owner' },
    locale: 'en',
  }) as never;

const createService = () =>
  new WorkspaceInvitationService(
    runtime.getRepository(AppTokenEntity) as never,
    runtime.getRepository(UserWorkspaceEntity) as never,
    {
      validateRoleAssignableToUsersOrThrow: jest.fn(async () => {}),
    } as never,
    {
      get: (key: string) => {
        if (key === 'INVITATION_TOKEN_EXPIRES_IN') return '7d';
        if (key === 'IS_BILLING_ENABLED') return false;
        if (key === 'SERVER_URL') return 'https://crm.acme.test';
        if (key === 'EMAIL_FROM_ADDRESS') return 'noreply@acme.test';
        if (key === 'INVITATION_SENDING_BY_EMAIL_THROTTLE_LIMIT') return 100;
        if (key === 'INVITATION_SENDING_BY_EMAIL_THROTTLE_TTL_IN_MS')
          return 60000;
        if (key === 'INVITATION_SENDING_BY_WORKSPACE_THROTTLE_LIMIT')
          return 100;
        if (key === 'INVITATION_SENDING_BY_WORKSPACE_THROTTLE_TTL_IN_MS')
          return 60000;

        return undefined;
      },
    } as never,
    { send: sendEmailMock } as never,
    {
      isOnboardingInviteTeamPending: jest.fn(async () => false),
      completeOnboardingInviteTeamStep: completeOnboardingMock,
    } as never,
    {
      buildWorkspaceURL: () => new URL('https://crm.acme.test/invite/token'),
    } as never,
    {
      getI18nInstance: () => ({
        _: (m: unknown) => (typeof m === 'string' ? m : 'Join your team'),
      }),
    } as never,
    {
      tokenBucketThrottleOrThrow: jest.fn(async () => {}),
    } as never,
    {
      signFileByIdUrl: jest.fn(async () => 'https://cdn.acme.test/logo.png'),
    } as never,
    runtime,
  );

const createResolver = (
  service: InstanceType<typeof WorkspaceInvitationService>,
) =>
  new WorkspaceInvitationResolver(
    {
      executeInWorkspaceContext: async (fn: () => Promise<unknown>) => fn(),
      getRepository: () => ({
        findOneOrFail: async () => buildSender(),
      }),
    } as never,
    service,
    {
      userHasWorkspaceSettingPermission: jest.fn(async () => true),
    } as never,
  );

const readInvitationAudits = async (wsId = workspaceId) =>
  owner.query(
    `SELECT id, "operationId", "correlationId", "resourceKind", "resourceId", action,
            actor, initiator, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
        AND "resourceKind" = 'workspaceInvitation'
      ORDER BY "createdAt" ASC, id ASC`,
    [wsId],
  );

describe('LOG193 transactional workspaceInvitation audit (PostgreSQL)', () => {
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
      CREATE TABLE core."appToken" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        "workspaceId" uuid NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        type text NOT NULL DEFAULT 'REFRESH_TOKEN',
        value text NULL,
        "expiresAt" timestamptz NOT NULL,
        "deletedAt" timestamptz NULL,
        "revokedAt" timestamptz NULL,
        context jsonb NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
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
          CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-workspace-invitation-audit';
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
        'admin@acme.test',
        existingMemberUserId,
        'existing@acme.test',
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
        existingMemberUserWorkspaceId,
        existingMemberUserId,
        workspaceId,
      ],
    );

    await runtime.initialize();
  });

  beforeEach(async () => {
    sendEmailMock.mockClear();
    completeOnboardingMock.mockClear();
    await owner.query(`DELETE FROM core."appToken"`);
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

  it('audits sendInvitations, resendWorkspaceInvitation, and deleteWorkspaceInvitation via resolver with redaction and impersonation', async () => {
    const service = createService();
    const resolver = createResolver(service);

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

    const sendRes = await resolver.sendInvitations(
      {
        emails: ['NewHire@Acme.Test'],
        roleId: invitedRoleId,
      },
      { id: actorUserId } as never,
      buildWorkspace(workspaceId),
      actorUserWorkspaceId,
      undefined,
      requestContext,
    );

    expect(sendRes.success).toBe(true);
    expect(sendRes.result).toHaveLength(1);
    const firstInvitationId = sendRes.result[0].id;
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const [firstTokenRow] = await owner.query(
      `SELECT id, type, value, context FROM core."appToken" WHERE id = $1`,
      [firstInvitationId],
    );
    expect(firstTokenRow.type).toBe(AppTokenType.InvitationToken);
    expect(firstTokenRow.context.roleId).toBe(invitedRoleId);

    const auditsAfterSend = await readInvitationAudits();
    expect(auditsAfterSend).toHaveLength(1);
    const createAudit = auditsAfterSend[0];
    expect(createAudit.action).toBe('create');
    expect(createAudit.resourceId).toBe(firstInvitationId);
    expect(createAudit.actor).toEqual({ kind: 'coreUser', id: actorUserId });
    expect(createAudit.initiator).toEqual({
      kind: 'coreUser',
      id: impersonatorUserId,
    });
    expect(createAudit.securityDescriptor).toEqual({
      resourceKind: 'workspaceInvitation',
      resourceId: firstInvitationId,
      metadataAccess: 'currentWorkspaceAdministration',
    });
    expect(createAudit.redactedDiff.values).toEqual({
      type: { before: null, after: AppTokenType.InvitationToken },
      roleId: { before: null, after: invitedRoleId },
    });
    expect(createAudit.redactedDiff.changedFields).toEqual(
      expect.arrayContaining(['email', 'value', 'expiresAt', 'type', 'roleId']),
    );
    expect(createAudit.redactedDiff.values).not.toHaveProperty('email');
    expect(createAudit.redactedDiff.values).not.toHaveProperty('value');
    const serializedAudit = JSON.stringify(createAudit);
    expect(serializedAudit).not.toContain('newhire@acme.test');
    expect(serializedAudit).not.toContain('NewHire@Acme.Test');
    expect(serializedAudit).not.toContain(firstTokenRow.value);

    const resendRes = await resolver.resendWorkspaceInvitation(
      firstInvitationId,
      buildWorkspace(workspaceId),
      { id: actorUserId } as never,
      requestContext,
    );
    expect(resendRes.success).toBe(true);
    expect(resendRes.result).toHaveLength(1);
    const secondInvitationId = resendRes.result[0].id;
    expect(secondInvitationId).not.toBe(firstInvitationId);

    const auditsAfterResend = await readInvitationAudits();
    expect(auditsAfterResend).toHaveLength(3);
    const resendDelete = auditsAfterResend[1];
    const resendCreate = auditsAfterResend[2];
    expect(resendDelete.action).toBe('delete');
    expect(resendDelete.resourceId).toBe(firstInvitationId);
    expect(resendCreate.action).toBe('create');
    expect(resendCreate.resourceId).toBe(secondInvitationId);
    expect(resendDelete.correlationId).toBe(resendCreate.correlationId);
    expect(resendCreate.redactedDiff.values.roleId).toEqual({
      before: null,
      after: invitedRoleId,
    });

    const delSuccess = await resolver.deleteWorkspaceInvitation(
      secondInvitationId,
      buildWorkspace(workspaceId),
      requestContext,
    );
    expect(delSuccess).toBe('success');

    const delMissing = await resolver.deleteWorkspaceInvitation(
      secondInvitationId,
      buildWorkspace(workspaceId),
      requestContext,
    );
    expect(delMissing).toBe('error');

    const auditsAfterDelete = await readInvitationAudits();
    expect(auditsAfterDelete).toHaveLength(4);
    expect(auditsAfterDelete[3].action).toBe('delete');
    expect(auditsAfterDelete[3].resourceId).toBe(secondInvitationId);
    expect(auditsAfterDelete[3].redactedDiff.values).toEqual({
      type: { before: AppTokenType.InvitationToken, after: null },
      roleId: { before: invitedRoleId, after: null },
    });
  });

  it('atomically replaces expired invitations with one operationId and audits direct generateInvitationToken', async () => {
    const service = createService();
    const expiredId = randomUUID();

    await owner.query(
      `INSERT INTO core."appToken" (id, "workspaceId", type, value, "expiresAt", context)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 day', $5::jsonb)`,
      [
        expiredId,
        workspaceId,
        AppTokenType.InvitationToken,
        'expired-secret-token-value',
        JSON.stringify({ email: 'stale@acme.test', roleId: invitedRoleId }),
      ],
    );

    const directIdentity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const created = await service.createWorkspaceInvitation(
      'STALE@acme.test',
      buildWorkspace(workspaceId),
      undefined,
      true,
      directIdentity,
    );

    expect(created.type).toBe(AppTokenType.OnboardingInvitationToken);

    const audits = await readInvitationAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0].operationId).toBe(audits[1].operationId);
    expect(audits.map((row: { action: string }) => row.action).sort()).toEqual([
      'create',
      'delete',
    ]);
    const deleteRow = audits.find(
      (row: { action: string }) => row.action === 'delete',
    );
    const createRow = audits.find(
      (row: { action: string }) => row.action === 'create',
    );
    expect(deleteRow.resourceId).toBe(expiredId);
    expect(createRow.resourceId).toBe(created.id);
    expect(createRow.redactedDiff.values).toEqual({
      type: { before: null, after: AppTokenType.OnboardingInvitationToken },
      roleId: { before: null, after: null },
    });

    await expect(
      service.createWorkspaceInvitation(
        'stale@acme.test',
        buildWorkspace(workspaceId),
        undefined,
        false,
        directIdentity,
      ),
    ).rejects.toMatchObject({
      code: WorkspaceInvitationExceptionCode.INVITATION_ALREADY_EXIST,
    });

    await expect(
      service.createWorkspaceInvitation(
        'existing@acme.test',
        buildWorkspace(workspaceId),
        undefined,
        false,
        directIdentity,
      ),
    ).rejects.toMatchObject({
      code: WorkspaceInvitationExceptionCode.USER_ALREADY_EXIST,
    });

    const directGenerated = await service.generateInvitationToken(
      workspaceId,
      'direct@acme.test',
      invitedRoleId,
      false,
      undefined,
      directIdentity,
    );
    const auditsAfterDirect = await readInvitationAudits();
    expect(auditsAfterDirect).toHaveLength(3);
    expect(auditsAfterDirect[2].resourceId).toBe(directGenerated.id);
    expect(auditsAfterDirect[2].action).toBe('create');
  });

  it('audits invalidateWorkspaceInvitation with case-insensitive matching and no-op when absent', async () => {
    const service = createService();
    const sharedCorrelationId = randomUUID();
    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
      correlationId: sharedCorrelationId,
    };

    const created = await service.createWorkspaceInvitation(
      'Joiner@Acme.Test',
      buildWorkspace(workspaceId),
      invitedRoleId,
      false,
      identity,
    );

    await service.invalidateWorkspaceInvitation(
      workspaceId,
      'joiner@acme.test',
      identity,
    );

    await service.invalidateWorkspaceInvitation(
      workspaceId,
      'joiner@acme.test',
      identity,
    );

    const remaining = await owner.query(
      `SELECT id FROM core."appToken" WHERE id = $1`,
      [created.id],
    );
    expect(remaining).toHaveLength(0);

    const audits = await readInvitationAudits();
    expect(audits).toHaveLength(2);
    expect(audits[1].action).toBe('delete');
    expect(audits[1].resourceId).toBe(created.id);
    expect(audits[1].correlationId).toBe(sharedCorrelationId);
  });

  it('fails closed without audit identity and blocks cross-workspace deletion', async () => {
    const service = createService();
    const otherTokenId = randomUUID();

    await owner.query(
      `INSERT INTO core."appToken" (id, "workspaceId", type, value, "expiresAt", context)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '2 days', $5::jsonb)`,
      [
        otherTokenId,
        otherWorkspaceId,
        AppTokenType.InvitationToken,
        'other-workspace-secret',
        JSON.stringify({ email: 'other@other.test' }),
      ],
    );

    await expect(
      service.createWorkspaceInvitation(
        'noauth@acme.test',
        buildWorkspace(workspaceId),
      ),
    ).rejects.toThrow();

    await expect(
      service.generateInvitationToken(workspaceId, 'noauth@acme.test'),
    ).rejects.toThrow();

    await expect(
      service.deleteWorkspaceInvitation(otherTokenId, workspaceId),
    ).rejects.toThrow();

    await expect(
      service.invalidateWorkspaceInvitation(workspaceId, 'other@other.test'),
    ).rejects.toThrow();

    const validIdentity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const crossDel = await service.deleteWorkspaceInvitation(
      otherTokenId,
      workspaceId,
      validIdentity,
    );
    expect(crossDel).toBe('error');

    await service.sendInvitations({
      emails: ['inside@acme.test'],
      workspace: buildWorkspace(workspaceId),
      sender: buildSender(),
      appTokenIdToInvalidate: otherTokenId,
      auditIdentity: validIdentity,
    });

    const otherStillExists = await owner.query(
      `SELECT id FROM core."appToken" WHERE id = $1`,
      [otherTokenId],
    );
    expect(otherStillExists).toHaveLength(1);
    expect(await readInvitationAudits(otherWorkspaceId)).toHaveLength(0);
  });

  it('rolls back invitation create and delete if audit flush fails or row drifts after flush', async () => {
    const service = createService();
    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    const existing = await service.createWorkspaceInvitation(
      'rollback@acme.test',
      buildWorkspace(workspaceId),
      invitedRoleId,
      false,
      identity,
    );

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_invitation_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'workspaceInvitation' THEN
          RAISE EXCEPTION 'simulated audit flush failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_fail_invitation_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_invitation_audit();
    `);

    try {
      await expect(
        service.createWorkspaceInvitation(
          'blocked@acme.test',
          buildWorkspace(workspaceId),
          undefined,
          false,
          identity,
        ),
      ).rejects.toThrow('simulated audit flush failure');

      await expect(
        service.deleteWorkspaceInvitation(existing.id, workspaceId, identity),
      ).rejects.toThrow('simulated audit flush failure');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_fail_invitation_audit ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.fail_on_invitation_audit()`,
      );
    }

    const blockedRows = await owner.query(
      `SELECT id FROM core."appToken" WHERE lower(context->>'email') = 'blocked@acme.test'`,
    );
    expect(blockedRows).toHaveLength(0);
    const existingRows = await owner.query(
      `SELECT id FROM core."appToken" WHERE id = $1`,
      [existing.id],
    );
    expect(existingRows).toHaveLength(1);

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.tamper_invitation_after_flush()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'workspaceInvitation' AND NEW.action = 'create' THEN
          UPDATE core."appToken"
             SET value = 'tampered-after-flush'
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_tamper_invitation_after_flush
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_invitation_after_flush();
    `);

    try {
      await expect(
        service.createWorkspaceInvitation(
          'tampered@acme.test',
          buildWorkspace(workspaceId),
          undefined,
          false,
          identity,
        ),
      ).rejects.toThrow(
        'Workspace invitation state changed during audit flush',
      );
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_tamper_invitation_after_flush ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.tamper_invitation_after_flush()`,
      );
    }

    const tamperedRows = await owner.query(
      `SELECT id FROM core."appToken" WHERE lower(context->>'email') = 'tampered@acme.test'`,
    );
    expect(tamperedRows).toHaveLength(0);
  });
});
