import { randomUUID } from 'node:crypto';
import { FeatureFlagKey } from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  ApplicationVariableEntityException,
  ApplicationVariableEntityExceptionCode,
} from 'src/engine/core-modules/application/application-variable/application-variable.exception';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { UserInputError } from 'src/engine/core-modules/graphql/utils/graphql-errors.util';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/admin-resolver.decorator',
  () => ({
    AdminResolver: () => () => {},
  }),
);
jest.mock(
  'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars',
  () => ({
    UUIDScalarType: class {},
  }),
);

for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/application-variable/application-variable.entity',
    ['ApplicationVariableEntity'],
  ],
  [
    'src/engine/core-modules/application/application-variable/dtos/application-variable.dto',
    ['ApplicationVariableEntityDTO'],
  ],
  [
    'src/engine/core-modules/application/application-variable/dtos/update-application-variable.input',
    ['UpdateApplicationVariableEntityInput'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable-exception-filter',
    ['ApplicationVariableEntityExceptionFilter'],
  ],
  [
    'src/engine/core-modules/application/application-exception-filter',
    ['ApplicationExceptionFilter'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/feature-flag/feature-flag.entity',
    ['FeatureFlagEntity'],
  ],
  [
    'src/engine/core-modules/feature-flag/dtos/feature-flag.dto',
    ['FeatureFlagDTO'],
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
    'src/engine/core-modules/lab/dtos/update-lab-public-feature-flag.input',
    ['UpdateLabPublicFeatureFlagInput'],
  ],
  [
    'src/engine/core-modules/secret-encryption/secret-encryption.service',
    ['SecretEncryptionService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

for (const [modPath, names] of [
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
    ['WorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        function MockDecorator() {
          return () => {};
        },
      ]),
    ),
  );
}

const { ApplicationVariableEntityService } =
  require('src/engine/core-modules/application/application-variable/application-variable.service') as typeof import('src/engine/core-modules/application/application-variable/application-variable.service');
const { ApplicationVariableEntityResolver } =
  require('src/engine/core-modules/application/application-variable/application-variable.resolver') as typeof import('src/engine/core-modules/application/application-variable/application-variable.resolver');
const { FeatureFlagService } =
  require('src/engine/core-modules/feature-flag/services/feature-flag.service') as typeof import('src/engine/core-modules/feature-flag/services/feature-flag.service');
const { LabResolver } =
  require('src/engine/core-modules/lab/lab.resolver') as typeof import('src/engine/core-modules/lab/lab.resolver');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated fork test database required');
}

const databaseRole = `app_var_ff_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const actorMemberId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const apiKeyId = randomUUID();
const oauthAppId = randomUUID();
const oauthAppUniversalId = randomUUID();
const secondAppId = randomUUID();
const secondAppUniversalId = randomUUID();
const workspaceVarId = randomUUID();
const workspaceVarUniversalId = randomUUID();
const nonSecretVarId = randomUUID();
const nonSecretVarUniversalId = randomUUID();
const userVarId = randomUUID();
const userVarUniversalId = randomUUID();

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 5, statement_timeout: 15000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-app-var-ff-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 5, statement_timeout: 15000 },
});

type Row = Record<string, unknown> & { id: string };

const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt", id',
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
  const workspaceCacheService = {
    invalidateAndRecompute: jest.fn(async () => {}),
    getOrRecompute: jest.fn(async () => ({
      featureFlagsMap: {},
      flatApplicationVariableMaps: {
        byId: {},
        byUniversalIdentifier: {},
        idByUniversalIdentifier: {},
        universalIdentifierById: {},
        universalIdentifiersByApplicationId: {},
      },
    })),
  };

  const secretEncryptionService = {
    encryptVersioned: jest.fn(
      (val: PlaintextString) =>
        `enc:v2:deadbeef:${Buffer.from(String(val)).toString('base64')}` as EncryptedString,
    ),
    decryptVersionedOrThrow: jest.fn(
      (val: EncryptedString) =>
        Buffer.from(
          String(val).replace(/^enc:v2:[0-9a-f]{8}:/, ''),
          'base64',
        ).toString('utf8') as PlaintextString,
    ),
    maskDecryptedValue: jest.fn((val: string) => `${val.slice(0, 2)}***`),
  };

  const applicationVariableService = new ApplicationVariableEntityService(
    { manager: { connection: runtime } } as never,
    workspaceCacheService as never,
    secretEncryptionService as never,
    runtime,
  );
  const applicationVariableResolver = new ApplicationVariableEntityResolver(
    applicationVariableService,
  );

  const featureFlagService = new FeatureFlagService(
    { manager: { connection: runtime } } as never,
    workspaceCacheService as never,
    runtime,
  );
  const labResolver = new LabResolver(featureFlagService);

  return {
    applicationVariableService,
    applicationVariableResolver,
    featureFlagService,
    labResolver,
    workspaceCacheService,
    secretEncryptionService,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core;',
  );
  await owner.query(
    `CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "activationStatus" text NOT NULL,
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.application (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL DEFAULT 'App',
      "deletedAt" timestamptz NULL,
      UNIQUE ("workspaceId", "universalIdentifier")
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "userId" uuid NOT NULL,
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."applicationVariable" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      key text NOT NULL,
      value text NULL,
      description text NOT NULL DEFAULT '',
      label text NOT NULL DEFAULT '',
      "isSecret" boolean NOT NULL DEFAULT true,
      "isDeprecated" boolean NOT NULL DEFAULT false,
      "isRequired" boolean NOT NULL DEFAULT false,
      type text NOT NULL DEFAULT 'TEXT',
      options jsonb NULL,
      scope text NOT NULL DEFAULT 'WORKSPACE',
      "defaultValue" text NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, scope),
      UNIQUE ("workspaceId", "universalIdentifier")
    );
    CREATE TABLE core."featureFlag" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      key text NOT NULL,
      value boolean NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE (key, "workspaceId")
    );`,
  );
  await owner.query(
    'INSERT INTO core.workspace (id, "activationStatus") VALUES ($1, $2), ($3, $2)',
    [workspaceId, WorkspaceActivationStatus.ACTIVE, foreignWorkspaceId],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-app-var-ff-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}";
     GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    `TRUNCATE
      core."featureFlag",
      core."applicationVariable",
      core.application,
      core."userWorkspace",
      crm_audit."crmAuditEntry"`,
  );
  await owner.query(
    'UPDATE core.workspace SET "deletedAt"=NULL WHERE id IN ($1, $2)',
    [workspaceId, foreignWorkspaceId],
  );
  await owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name) VALUES
      ($1, $2, $3, 'OAuth Integration App'),
      ($4, $2, $5, 'Second App')`,
    [
      oauthAppId,
      workspaceId,
      oauthAppUniversalId,
      secondAppId,
      secondAppUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt") VALUES
      ($1, $2, $3, NULL),
      ($4, $2, $5, NULL)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  const initialEmptyEnc = `enc:v2:deadbeef:${Buffer.from('').toString('base64')}`;
  await owner.query(
    `INSERT INTO core."applicationVariable" (id, "workspaceId", "applicationId", "universalIdentifier", key, value, scope, "isSecret") VALUES
      ($1, $2, $3, $4, 'WORKSPACE_API_SECRET', $5, 'WORKSPACE', true),
      ($6, $2, $3, $7, 'PUBLIC_WEBHOOK_BASE_URL', $5, 'WORKSPACE', false),
      ($8, $2, $3, $9, 'USER_PERSONAL_TOKEN', NULL, 'USER', true)`,
    [
      workspaceVarId,
      workspaceId,
      oauthAppId,
      workspaceVarUniversalId,
      initialEmptyEnc,
      nonSecretVarId,
      nonSecretVarUniversalId,
      userVarId,
      userVarUniversalId,
    ],
  );
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

describe('ApplicationVariable and FeatureFlag CRM audit (LOG176)', () => {
  it('audits workspace applicationVariable updates across user (impersonated), apiKey, and application principals with redacted key/value and enforces canonical exceptions', async () => {
    const {
      applicationVariableResolver,
      applicationVariableService,
      workspaceCacheService,
    } = buildHarness();

    const userReqContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    };

    // 1. Update secret workspace variable via resolver under impersonation
    const updated =
      await applicationVariableResolver.updateOneApplicationVariable(
        {
          key: 'WORKSPACE_API_SECRET',
          value: 'top-secret-workspace-key-v1' as PlaintextString,
          applicationId: oauthAppId,
        },
        { id: workspaceId } as never,
        undefined,
        userReqContext,
      );
    expect(updated).toBe(true);

    // 2. Idempotent repeat with identical encrypted value writes 0 new audit entries
    await applicationVariableResolver.updateOneApplicationVariable(
      {
        key: 'WORKSPACE_API_SECRET',
        value: 'top-secret-workspace-key-v1' as PlaintextString,
        applicationId: oauthAppId,
      },
      { id: workspaceId } as never,
      undefined,
      userReqContext,
    );

    // 3. Update via own application token without explicit applicationId arg
    await applicationVariableResolver.updateOneApplicationVariable(
      {
        key: 'PUBLIC_WEBHOOK_BASE_URL',
        value: 'https://hooks.acme.example.com' as PlaintextString,
      },
      { id: workspaceId } as never,
      { id: oauthAppId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          application: { id: oauthAppId },
        },
      },
    );

    // 4. Update via API key
    await applicationVariableResolver.updateOneApplicationVariable(
      {
        key: 'WORKSPACE_API_SECRET',
        value: 'top-secret-workspace-key-v2' as PlaintextString,
        applicationId: oauthAppId,
      },
      { id: workspaceId } as never,
      undefined,
      {
        req: {
          workspace: { id: workspaceId },
          apiKey: { id: apiKeyId },
        },
      },
    );

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      workspaceId,
      resourceKind: 'applicationVariable',
      resourceId: workspaceVarId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['value'],
        values: {},
      },
      securityDescriptor: {
        resourceKind: 'applicationVariable',
        resourceId: workspaceVarId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(entries[1]).toMatchObject({
      workspaceId,
      resourceKind: 'applicationVariable',
      resourceId: nonSecretVarId,
      action: 'update',
      actor: { kind: 'application', id: oauthAppId },
      initiator: null,
      redactedDiff: {
        changedFields: ['value'],
        values: {},
      },
    });
    expect(entries[2]).toMatchObject({
      workspaceId,
      resourceKind: 'applicationVariable',
      resourceId: workspaceVarId,
      action: 'update',
      actor: { kind: 'apiKey', id: apiKeyId },
      initiator: null,
      redactedDiff: {
        changedFields: ['value'],
        values: {},
      },
    });

    for (const entry of entries) {
      const serialized = JSON.stringify(entry.redactedDiff);
      expect(serialized).not.toContain('top-secret-workspace-key');
      expect(serialized).not.toContain('hooks.acme.example.com');
      expect(serialized).not.toContain('enc:v2:');
      expect(serialized).not.toContain('WORKSPACE_API_SECRET');
    }

    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationVariableMaps'],
    );

    // 5. Canonical exceptions for missing variable, foreign workspace application, and USER-scoped variable
    const foreignAppId = randomUUID();
    await owner.query(
      `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name)
       VALUES ($1, $2, $3, 'Foreign App')`,
      [foreignAppId, foreignWorkspaceId, randomUUID()],
    );

    await expect(
      applicationVariableService.update({
        key: 'NON_EXISTENT_KEY',
        plainTextValue: 'val' as PlaintextString,
        applicationId: oauthAppId,
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toMatchObject({
      code: ApplicationVariableEntityExceptionCode.APPLICATION_VARIABLE_NOT_FOUND,
    });

    await expect(
      applicationVariableService.update({
        key: 'WORKSPACE_API_SECRET',
        plainTextValue: 'val' as PlaintextString,
        applicationId: foreignAppId,
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toMatchObject({
      code: ApplicationVariableEntityExceptionCode.APPLICATION_VARIABLE_NOT_FOUND,
    });

    await expect(
      applicationVariableService.update({
        key: 'USER_PERSONAL_TOKEN',
        plainTextValue: 'val' as PlaintextString,
        applicationId: oauthAppId,
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(ApplicationVariableEntityException);

    // 6. Fail-closed on unauthenticated caller and cross-application targeting
    await expect(
      applicationVariableService.update({
        key: 'WORKSPACE_API_SECRET',
        plainTextValue: 'val' as PlaintextString,
        applicationId: oauthAppId,
        workspaceId,
      }),
    ).rejects.toThrow(
      'Application variable mutation requires authenticated audit identity',
    );

    await expect(
      applicationVariableService.update({
        key: 'WORKSPACE_API_SECRET',
        plainTextValue: 'val' as PlaintextString,
        applicationId: oauthAppId,
        callingApplicationId: secondAppId,
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Application variable audit cannot target another application',
    );

    expect(await audits()).toHaveLength(3);
  });

  it('audits featureFlag create, idempotent no-op, update, cross-workspace admin toggle, and batch enableFeatureFlags', async () => {
    const { featureFlagService, labResolver, workspaceCacheService } =
      buildHarness();

    const labReqContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    };

    // 1. Rejects non-public or invalid feature flag in LabResolver before opening DB transaction
    await expect(
      labResolver.updateLabPublicFeatureFlag(
        {
          publicFeatureFlag:
            FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
          value: true,
        },
        { id: workspaceId } as never,
        labReqContext,
      ),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(await audits()).toHaveLength(0);

    // 2. Create public feature flag via LabResolver
    const createdFlag = (await labResolver.updateLabPublicFeatureFlag(
      {
        publicFeatureFlag:
          FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
        value: true,
      },
      { id: workspaceId } as never,
      labReqContext,
    )) as { id: string; key: FeatureFlagKey; value: boolean };
    expect(createdFlag.key).toBe(
      FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
    );
    expect(createdFlag.value).toBe(true);

    // 3. Repeat with identical value (true) is a no-op under DB lock
    workspaceCacheService.invalidateAndRecompute.mockClear();
    const repeatedFlag = (await labResolver.updateLabPublicFeatureFlag(
      {
        publicFeatureFlag:
          FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
        value: true,
      },
      { id: workspaceId } as never,
      labReqContext,
    )) as { id: string; key: FeatureFlagKey; value: boolean };
    expect(repeatedFlag.id).toBe(createdFlag.id);
    expect(workspaceCacheService.invalidateAndRecompute).not.toHaveBeenCalled();

    // 4. Toggle public feature flag to false -> featureFlag:update
    const disabledFlag = (await labResolver.updateLabPublicFeatureFlag(
      {
        publicFeatureFlag:
          FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
        value: false,
      },
      { id: workspaceId } as never,
      labReqContext,
    )) as { id: string; key: FeatureFlagKey; value: boolean };
    expect(disabledFlag.id).toBe(createdFlag.id);
    expect(disabledFlag.value).toBe(false);

    // 5. Cross-workspace server admin toggle on foreignWorkspaceId with impersonation initiator
    const foreignFlag = await featureFlagService.upsertWorkspaceFeatureFlag({
      workspaceId: foreignWorkspaceId,
      featureFlag: FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
      value: true,
      auditIdentity: {
        workspaceId: foreignWorkspaceId,
        actor: { kind: 'coreUser', id: actorUserId },
        impersonatorUserWorkspaceId,
      },
    });
    expect(foreignFlag.workspaceId).toBe(foreignWorkspaceId);
    expect(foreignFlag.value).toBe(true);

    // 6. Batch enableFeatureFlags: flips IS_REST_METADATA_API_NEW_FORMAT_DIRECT (false -> true), creates IS_AI_ENABLED (true), and skips on repeat
    await featureFlagService.enableFeatureFlags(
      [
        FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
        FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
      ],
      workspaceId,
      {
        auditIdentity: {
          workspaceId,
          actor: {
            kind: 'system',
            id: 'workspace-service:activate-workspace',
          },
        },
      },
    );
    await featureFlagService.enableFeatureFlags(
      [
        FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
        FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
      ],
      workspaceId,
      {
        auditIdentity: {
          workspaceId,
          actor: {
            kind: 'system',
            id: 'workspace-service:activate-workspace',
          },
        },
      },
    );

    const entries = await audits();
    expect(entries).toHaveLength(5);

    expect(entries[0]).toMatchObject({
      workspaceId,
      resourceKind: 'featureFlag',
      resourceId: createdFlag.id,
      action: 'create',
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['key', 'value'],
        values: {
          key: {
            before: null,
            after: FeatureFlagKey.IS_REST_METADATA_API_NEW_FORMAT_DIRECT,
          },
          value: { before: null, after: true },
        },
      },
    });

    expect(entries[1]).toMatchObject({
      workspaceId,
      resourceKind: 'featureFlag',
      resourceId: createdFlag.id,
      action: 'update',
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['value'],
        values: {
          value: { before: true, after: false },
        },
      },
    });

    expect(entries[2]).toMatchObject({
      workspaceId: foreignWorkspaceId,
      resourceKind: 'featureFlag',
      resourceId: foreignFlag.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['key', 'value'],
        values: {
          key: {
            before: null,
            after: FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
          },
          value: { before: null, after: true },
        },
      },
    });

    // Batch enableFeatureFlags processed in single transaction with shared operationId
    expect(entries[3].operationId).toBe(entries[4].operationId);
    const batchEntries = entries.slice(3, 5);
    const batchCreated = batchEntries.find(
      (entry) => entry.action === 'create',
    );
    const batchUpdated = batchEntries.find(
      (entry) => entry.action === 'update',
    );
    expect(batchCreated).toMatchObject({
      workspaceId,
      resourceKind: 'featureFlag',
      action: 'create',
      actor: {
        kind: 'system',
        id: 'workspace-service:activate-workspace',
      },
      redactedDiff: {
        changedFields: ['key', 'value'],
        values: {
          key: {
            before: null,
            after: FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
          },
          value: { before: null, after: true },
        },
      },
    });
    expect(batchUpdated).toMatchObject({
      workspaceId,
      resourceKind: 'featureFlag',
      resourceId: createdFlag.id,
      action: 'update',
      actor: {
        kind: 'system',
        id: 'workspace-service:activate-workspace',
      },
      redactedDiff: {
        changedFields: ['value'],
        values: {
          value: { before: false, after: true },
        },
      },
    });
  });

  it('rolls back on post-flush trigger corruption and invalidates caches without ROLLBACK when COMMIT acknowledgement is lost', async () => {
    const {
      applicationVariableService,
      featureFlagService,
      workspaceCacheService,
    } = buildHarness();

    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_flag_on_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'featureFlag' THEN
          UPDATE core."featureFlag" SET value = NOT value WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_corrupt_flag_on_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_flag_on_audit_insert();
    `);

    try {
      await expect(
        featureFlagService.upsertWorkspaceFeatureFlag({
          workspaceId,
          featureFlag: FeatureFlagKey.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED,
          value: true,
          auditIdentity: userIdentity(),
        }),
      ).rejects.toThrow('Feature flag state changed during audit flush');

      expect(
        await owner.query(
          'SELECT id FROM core."featureFlag" WHERE "workspaceId"=$1',
          [workspaceId],
        ),
      ).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS trg_corrupt_flag_on_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS core.corrupt_flag_on_audit_insert();',
      );
    }

    // Simulate COMMIT acknowledgement loss on applicationVariable update
    const statements: string[] = [];
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest
      .spyOn(runtime, 'createQueryRunner')
      .mockImplementationOnce((mode?: 'master' | 'slave') => {
        const runner = originalCreateQueryRunner(mode);
        const origConnect = runner.connect.bind(runner);
        jest.spyOn(runner, 'connect').mockImplementationOnce(async () => {
          const client = await origConnect();
          const origClientQuery = client.query.bind(client);
          const querySpy = jest
            .spyOn(client, 'query')
            .mockImplementation((...args: unknown[]) => {
              if (typeof args[0] === 'string') {
                statements.push(args[0]);
              }
              if (args[0] === 'COMMIT') {
                querySpy.mockRestore();
                return Promise.reject(
                  new Error('simulated socket hang up after COMMIT'),
                );
              }
              return (origClientQuery as (...a: unknown[]) => unknown)(...args);
            });
          return client;
        });
        return runner;
      });

    workspaceCacheService.invalidateAndRecompute.mockClear();

    await expect(
      applicationVariableService.update({
        key: 'WORKSPACE_API_SECRET',
        plainTextValue: 'committed-secret-after-ack-loss' as PlaintextString,
        applicationId: oauthAppId,
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    expect(statements.some((sql) => /^ROLLBACK\b/i.test(sql.trim()))).toBe(
      false,
    );
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['flatApplicationVariableMaps'],
    );
    expect(await audits()).toHaveLength(0);
  });
});
