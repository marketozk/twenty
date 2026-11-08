import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  ApprovedAccessDomainException,
  ApprovedAccessDomainExceptionCode,
} from 'src/engine/core-modules/approved-access-domain/approved-access-domain.exception';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import {
  captureWorkspaceDomainAudit,
  withWorkspaceDomainAudit,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import {
  PublicDomainException,
  PublicDomainExceptionCode,
} from 'src/engine/core-modules/public-domain/public-domain.exception';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('twenty-emails', () => ({
  SendApprovedAccessDomainValidation: jest.fn(() => ({})),
  renderEmail: jest.fn(async (_tpl: unknown, opts?: { plainText?: boolean }) =>
    opts?.plainText ? 'Plain Text Email' : '<html>Email</html>',
  ),
}));

jest.mock(
  'src/engine/core-modules/application/utils/serialize-application-for-broadcast.util',
  () => ({
    serializeApplicationForBroadcast: jest.fn((app: unknown) => app),
  }),
);

for (const [modPath, names] of [
  ['src/engine/core-modules/api-key/api-key.entity', ['ApiKeyEntity']],
  [
    'src/engine/core-modules/application/application-registration/application-registration.entity',
    ['ApplicationRegistrationEntity'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable.entity',
    ['ApplicationVariableEntity'],
  ],
  [
    'src/engine/core-modules/application/application-lookup/application-lookup.service',
    ['ApplicationLookupService'],
  ],
  [
    'src/engine/core-modules/application/application-exception-filter',
    ['ApplicationExceptionFilter'],
  ],
  [
    'src/engine/core-modules/approved-access-domain/approved-access-domain-exception-filter',
    ['ApprovedAccessDomainExceptionFilter'],
  ],
  [
    'src/engine/core-modules/approved-access-domain/dtos/approved-access-domain.dto',
    ['ApprovedAccessDomainDTO'],
  ],
  [
    'src/engine/core-modules/approved-access-domain/dtos/create-approved-access.domain.input',
    ['CreateApprovedAccessDomainInput'],
  ],
  [
    'src/engine/core-modules/approved-access-domain/dtos/delete-approved-access-domain.input',
    ['DeleteApprovedAccessDomainInput'],
  ],
  [
    'src/engine/core-modules/approved-access-domain/dtos/validate-approved-access-domain.input',
    ['ValidateApprovedAccessDomainInput'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
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
    'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service',
    ['WorkspaceDomainsService'],
  ],
  ['src/engine/core-modules/email/email.service', ['EmailService']],
  [
    'src/engine/core-modules/file/file-url/file-url.service',
    ['FileUrlService'],
  ],
  [
    'src/engine/core-modules/file-storage/services/file-storage.service',
    ['FileStorageService'],
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
    'src/engine/core-modules/jwt/services/jwt-wrapper.service',
    ['JwtWrapperService'],
  ],
  [
    'src/engine/core-modules/public-domain/dtos/create-public-domain.input',
    ['CreatePublicDomainInput'],
  ],
  [
    'src/engine/core-modules/public-domain/dtos/public-domain.dto',
    ['PublicDomainDTO'],
  ],
  [
    'src/engine/core-modules/public-domain/dtos/public-domain.input',
    ['PublicDomainInput'],
  ],
  [
    'src/engine/core-modules/public-domain/public-domain-exception-filter',
    ['PublicDomainExceptionFilter'],
  ],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/metadata-modules/ai/ai-agent/entities/agent.entity',
    ['AgentEntity'],
  ],
  [
    'src/engine/metadata-modules/command-menu-item/entities/command-menu-item.entity',
    ['CommandMenuItemEntity'],
  ],
  [
    'src/engine/metadata-modules/front-component/entities/front-component.entity',
    ['FrontComponentEntity'],
  ],
  [
    'src/engine/metadata-modules/logic-function/logic-function.entity',
    ['LogicFunctionEntity'],
  ],
  [
    'src/engine/metadata-modules/object-metadata/object-metadata.entity',
    ['ObjectMetadataEntity'],
  ],
  [
    'src/engine/metadata-modules/settings-menu-item/entities/settings-menu-item.entity',
    ['SettingsMenuItemEntity'],
  ],
  [
    'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service',
    ['WorkspaceEventBroadcaster'],
  ],
  ['src/engine/twenty-orm/workspace-orm.manager', ['WorkspaceOrmManager']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
    ['WorkspaceScopedRepository'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity',
    ['WorkspaceMemberWorkspaceEntity'],
  ],
  ['src/engine/guards/application-target.guard', ['ApplicationTargetGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

for (const [modPath, names] of [
  [
    'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
    ['MetadataResolver'],
  ],
  [
    'src/engine/core-modules/cron/sentry-cron-monitor.decorator',
    ['SentryCronMonitor'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/process.decorator',
    ['Process'],
  ],
  [
    'src/engine/core-modules/message-queue/decorators/processor.decorator',
    ['Processor'],
  ],
  [
    'src/engine/decorators/auth/application-target-args.decorator',
    ['ApplicationTargetArgs'],
  ],
  ['src/engine/decorators/auth/auth-api-key.decorator', ['AuthApiKey']],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  [
    'src/engine/decorators/auth/auth-impersonation-context.decorator',
    ['AuthImpersonationContext'],
  ],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, () => () => {}])),
  );
}

const ApplicationEntity = class ApplicationEntity {};
jest.doMock('src/engine/core-modules/application/application.entity', () => ({
  ApplicationEntity,
}));

const ApprovedAccessDomainEntity = class ApprovedAccessDomainEntity {};
jest.doMock(
  'src/engine/core-modules/approved-access-domain/approved-access-domain.entity',
  () => ({
    ApprovedAccessDomainEntity,
  }),
);

const PublicDomainEntity = class PublicDomainEntity {};
jest.doMock(
  'src/engine/core-modules/public-domain/public-domain.entity',
  () => ({
    PublicDomainEntity,
  }),
);

const { ApprovedAccessDomainResolver } =
  require('src/engine/core-modules/approved-access-domain/approved-access-domain.resolver') as typeof import('src/engine/core-modules/approved-access-domain/approved-access-domain.resolver');
const { ApprovedAccessDomainService } =
  require('src/engine/core-modules/approved-access-domain/services/approved-access-domain.service') as typeof import('src/engine/core-modules/approved-access-domain/services/approved-access-domain.service');
const { PublicDomainResolver } =
  require('src/engine/core-modules/public-domain/public-domain.resolver') as typeof import('src/engine/core-modules/public-domain/public-domain.resolver');
const { PublicDomainService } =
  require('src/engine/core-modules/public-domain/public-domain.service') as typeof import('src/engine/core-modules/public-domain/public-domain.service');
const { CheckPublicDomainsValidRecordsCronJob } =
  require('src/engine/core-modules/public-domain/crons/jobs/check-public-domains-valid-records.cron.job') as typeof import('src/engine/core-modules/public-domain/crons/jobs/check-public-domains-valid-records.cron.job');
const { DnsCloudflareService } =
  require('src/engine/core-modules/cloudflare/services/dns-cloudflare.service') as typeof import('src/engine/core-modules/cloudflare/services/dns-cloudflare.service');
const { ApplicationService } =
  require('src/engine/core-modules/application/application.service') as typeof import('src/engine/core-modules/application/application.service');

jest.setTimeout(120000);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error('Dedicated fork test database required');
}

const databaseRole = `ws_domain_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorMemberId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const apiKeyId = randomUUID();
const oauthAppId = randomUUID();
const oauthAppUniversalId = randomUUID();
const targetAppId = randomUUID();
const targetAppUniversalId = randomUUID();
const cascadeAppId = randomUUID();
const cascadeAppUniversalId = randomUUID();

const entities = [
  new EntitySchema({
    name: 'ApplicationEntity',
    target: ApplicationEntity,
    schema: 'core',
    tableName: 'application',
    columns: {
      id: { type: 'uuid', primary: true },
      workspaceId: { type: 'uuid' },
      universalIdentifier: { type: 'uuid' },
      name: { type: 'text' },
      packageJsonFileId: { type: 'uuid', nullable: true },
      yarnLockFileId: { type: 'uuid', nullable: true },
      primaryPublicDomainId: { type: 'uuid', nullable: true },
      deletedAt: { type: 'timestamptz', nullable: true },
    },
  }),
  new EntitySchema({
    name: 'ApprovedAccessDomainEntity',
    target: ApprovedAccessDomainEntity,
    schema: 'core',
    tableName: 'approvedAccessDomain',
    columns: {
      id: { type: 'uuid', primary: true },
      workspaceId: { type: 'uuid' },
      domain: { type: 'varchar' },
      isValidated: { type: 'boolean', default: false },
      createdAt: { type: 'timestamptz' },
      updatedAt: { type: 'timestamptz' },
    },
  }),
  new EntitySchema({
    name: 'PublicDomainEntity',
    target: PublicDomainEntity,
    schema: 'core',
    tableName: 'publicDomain',
    columns: {
      id: { type: 'uuid', primary: true },
      workspaceId: { type: 'uuid' },
      applicationId: { type: 'uuid' },
      domain: { type: 'varchar' },
      isValidated: { type: 'boolean', default: false },
      createdAt: { type: 'timestamptz' },
      updatedAt: { type: 'timestamptz' },
    },
  }),
];

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-workspace-domain-audit-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities,
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, id ASC',
  );

const encodeSegment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const buildAsymmetricToken = (payload: object) =>
  `${encodeSegment({ alg: 'ES256', kid: 'domain-test-kid' })}.${encodeSegment(payload)}.sig`;

describe('Workspace domain (approvedAccessDomain & publicDomain) transactional CRM audit (PostgreSQL)', () => {
  const emailSend = jest.fn(async () => undefined);
  const registerHostname = jest.fn(async () => ({ id: 'cf-host-1' }));
  const deleteHostnameSilently = jest.fn(async () => undefined);
  const refreshHostname = jest.fn(async (domain: string) => ({
    id: `cf-${domain}`,
    domain,
    records: [],
  }));
  const getHostnameWithRecords = jest.fn(async (domain: string) => ({
    id: `cf-${domain}`,
    domain,
    records: [],
  }));
  const isHostnameWorking = jest.fn(async () => true);

  let verifyJwtTokenImpl: (token: string) => Promise<unknown>;
  let approvedAccessDomainService: InstanceType<
    typeof ApprovedAccessDomainService
  >;
  let approvedAccessDomainResolver: InstanceType<
    typeof ApprovedAccessDomainResolver
  >;
  let publicDomainService: InstanceType<typeof PublicDomainService>;
  let publicDomainResolver: InstanceType<typeof PublicDomainResolver>;
  let checkPublicDomainsCronJob: InstanceType<
    typeof CheckPublicDomainsValidRecordsCronJob
  >;
  let dnsCloudflareService: InstanceType<typeof DnsCloudflareService>;
  let applicationService: InstanceType<typeof ApplicationService>;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await owner.initialize();
    const runner = owner.createQueryRunner();
    try {
      await runner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await runner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
      await runner.query('DROP SCHEMA IF EXISTS core CASCADE');
      await runner.query('CREATE SCHEMA core');
      await runner.query(`
        CREATE TABLE core.workspace (
          id uuid PRIMARY KEY,
          "displayName" text,
          "customDomain" varchar NULL,
          "isCustomDomainEnabled" boolean NOT NULL DEFAULT false,
          "logoFileId" uuid NULL,
          "deletedAt" timestamptz NULL
        );
        CREATE TABLE core."user" (
          id uuid PRIMARY KEY,
          email text NOT NULL,
          "deletedAt" timestamptz NULL
        );
        CREATE TABLE core."userWorkspace" (
          id uuid PRIMARY KEY,
          "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          locale varchar NOT NULL DEFAULT 'en',
          "deletedAt" timestamptz NULL
        );
        CREATE TABLE core."apiKey" (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "revokedAt" timestamptz NULL
        );
        CREATE TABLE core.application (
          id uuid PRIMARY KEY,
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "universalIdentifier" uuid NOT NULL,
          name text NOT NULL DEFAULT 'App',
          "packageJsonFileId" uuid NULL,
          "yarnLockFileId" uuid NULL,
          "primaryPublicDomainId" uuid NULL,
          "deletedAt" timestamptz NULL
        );
        CREATE TABLE core."approvedAccessDomain" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          domain varchar NOT NULL,
          "isValidated" boolean NOT NULL DEFAULT false,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "IDX_APPROVED_ACCESS_DOMAIN_DOMAIN_WORKSPACE_ID_UNIQUE" UNIQUE (domain, "workspaceId")
        );
        CREATE TABLE core."publicDomain" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          domain varchar NOT NULL UNIQUE,
          "isValidated" boolean NOT NULL DEFAULT false,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE core.application
          ADD CONSTRAINT "FK_application_primaryPublicDomain"
          FOREIGN KEY ("primaryPublicDomainId") REFERENCES core."publicDomain"(id)
          ON DELETE SET NULL ON UPDATE NO ACTION;
        CREATE TABLE core."applicationAuthorization" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
          "userWorkspaceId" uuid NOT NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
          "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
          scopes text[] NOT NULL DEFAULT '{}'::text[],
          "revokedAt" timestamptz NULL,
          "lastAuthorizedAt" timestamptz NOT NULL DEFAULT now(),
          "lastUsedAt" timestamptz NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );
      `);
      await new OmniAuditBootstrapFastInstanceCommand().up(runner);
      await runner.query(
        `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-workspace-domain-audit-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await runner.query(
        `GRANT USAGE ON SCHEMA core, crm_audit TO "${databaseRole}"`,
      );
      await runner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}"`,
      );
      await runner.query(
        `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
      );
      await runner.query(
        `REVOKE UPDATE, DELETE, TRUNCATE ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
      );
    } finally {
      await runner.release();
    }
    await runtime.initialize();

    const makeScopedRepo = <TEntity extends Record<string, unknown>>(
      entityTarget: unknown,
    ) => {
      const repo = runtime.getRepository(entityTarget as never);

      return {
        find: (wsId: string, opts?: Record<string, unknown>) =>
          repo.find({
            ...(opts ?? {}),
            where: {
              ...((opts?.where as Record<string, unknown>) ?? {}),
              workspaceId: wsId,
            },
          } as never),
        findOne: (wsId: string, opts?: Record<string, unknown>) =>
          repo.findOne({
            ...(opts ?? {}),
            where: {
              ...((opts?.where as Record<string, unknown>) ?? {}),
              workspaceId: wsId,
            },
          } as never),
        findOneBy: (wsId: string, where: Record<string, unknown>) =>
          repo.findOneBy({ ...where, workspaceId: wsId } as never),
        insert: (wsId: string, data: TEntity) =>
          repo.insert({ ...data, workspaceId: wsId } as never),
        insertAndReturnOne: async (wsId: string, data: TEntity) => {
          const res = await repo.insert({
            ...data,
            workspaceId: wsId,
          } as never);

          return {
            ...data,
            workspaceId: wsId,
            id: res.identifiers[0]?.id,
          };
        },
        update: (
          wsId: string,
          criteria: Record<string, unknown>,
          partial: Record<string, unknown>,
        ) => repo.update({ ...criteria, workspaceId: wsId } as never, partial),
        delete: (wsId: string, criteria: Record<string, unknown>) =>
          repo.delete({ ...criteria, workspaceId: wsId } as never),
      };
    };

    const workspaceUnscopedRepo = {
      manager: runtime.manager,
      findOneBy: async ({ customDomain }: { customDomain?: string }) => {
        if (!customDomain) return null;
        const [row] = await runtime.query(
          `SELECT * FROM core.workspace WHERE "customDomain"=$1 AND "deletedAt" IS NULL LIMIT 1`,
          [customDomain],
        );

        return row ?? null;
      },
      findOne: async ({
        where,
      }: {
        where?: { id?: string; customDomain?: string };
      }) => {
        if (where?.customDomain) {
          const [row] = await runtime.query(
            `SELECT * FROM core.workspace WHERE "customDomain"=$1 AND "deletedAt" IS NULL LIMIT 1`,
            [where.customDomain],
          );

          return row ?? null;
        }
        if (where?.id) {
          const [row] = await runtime.query(
            `SELECT * FROM core.workspace WHERE id=$1 LIMIT 1`,
            [where.id],
          );

          return row ?? null;
        }

        return null;
      },
    };

    approvedAccessDomainService = new ApprovedAccessDomainService(
      makeScopedRepo(ApprovedAccessDomainEntity) as never,
      runtime.getRepository(ApprovedAccessDomainEntity) as never,
      { send: emailSend } as never,
      {
        get: (key: string) =>
          key === 'EMAIL_FROM_ADDRESS'
            ? 'noreply@twenty.local'
            : 'https://crm.twenty.local',
      } as never,
      {
        signFileByIdUrl: jest.fn(async () => 'https://crm.twenty.local/logo'),
      } as never,
      {
        buildWorkspaceURL: jest.fn(
          () => new URL('https://crm.twenty.local/settings/members'),
        ),
      } as never,
      {
        signAsyncOrThrow: jest.fn(async (payload: object) =>
          buildAsymmetricToken(payload),
        ),
        verifyJwtToken: jest.fn((token: string) => verifyJwtTokenImpl(token)),
      } as never,
      {
        getI18nInstance: () => ({
          _: (d: { message?: string; id?: string }) =>
            d?.message ?? d?.id ?? 'Approve your access domain',
        }),
      } as never,
      runtime,
    );

    approvedAccessDomainResolver = new ApprovedAccessDomainResolver(
      {
        executeInWorkspaceContext: async <TResult>(
          fn: () => Promise<TResult>,
        ) => fn(),
        getRepository: () => ({
          findOneOrFail: async ({ where }: { where: { userId: string } }) => ({
            id: actorMemberId,
            userId: where.userId,
            userEmail: 'admin@acme-corp.io',
            name: { firstName: 'Ada', lastName: 'Admin' },
            locale: 'en',
          }),
        }),
      } as never,
      approvedAccessDomainService,
    );

    const dnsManagerMock = {
      registerHostname,
      deleteHostnameSilently,
      refreshHostname,
      getHostnameWithRecords,
      isHostnameWorking,
    };

    publicDomainService = new PublicDomainService(
      dnsManagerMock as never,
      makeScopedRepo(PublicDomainEntity) as never,
      runtime.getRepository(PublicDomainEntity) as never,
      workspaceUnscopedRepo as never,
      makeScopedRepo(ApplicationEntity) as never,
      runtime,
    );

    publicDomainResolver = new PublicDomainResolver(
      makeScopedRepo(PublicDomainEntity) as never,
      publicDomainService,
      dnsManagerMock as never,
    );

    checkPublicDomainsCronJob = new CheckPublicDomainsValidRecordsCronJob(
      runtime.getRepository(PublicDomainEntity) as never,
      publicDomainService,
    );

    dnsCloudflareService = new DnsCloudflareService(
      publicDomainService,
      { checkCustomDomainValidRecords: jest.fn() } as never,
      { findByCustomDomain: jest.fn(async () => null) } as never,
    );

    applicationService = new ApplicationService(
      runtime,
      makeScopedRepo(ApplicationEntity) as never,
      {} as never,
      {
        invalidateAndRecompute: jest.fn(async () => undefined),
        getOrRecompute: jest.fn(async () => ({})),
      } as never,
      {
        deleteApplicationFileRows: jest.fn(async () => undefined),
        deleteApplicationFilesFromStorage: jest.fn(async () => undefined),
        invalidateStorageStock: jest.fn(async () => undefined),
      } as never,
      workspaceUnscopedRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { broadcast: jest.fn(async () => undefined) } as never,
      {
        findByUniversalIdentifier: async ({
          universalIdentifier,
          workspaceId: wsId,
        }: {
          universalIdentifier: string;
          workspaceId: string;
        }) => {
          const [row] = await runtime.query(
            `SELECT * FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL`,
            [universalIdentifier, wsId],
          );

          return row ?? null;
        },
      } as never,
    );
  });

  beforeEach(async () => {
    emailSend.mockClear();
    registerHostname.mockClear();
    deleteHostnameSilently.mockClear();
    refreshHostname.mockClear();
    getHostnameWithRecords.mockClear();
    isHostnameWorking.mockClear();
    verifyJwtTokenImpl = async (token: string) => {
      const [, payloadSeg] = token.split('.');

      return JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
    };

    await owner.query(
      'TRUNCATE TABLE crm_audit."crmAuditEntry", core."applicationAuthorization", core."publicDomain", core."approvedAccessDomain", core.application, core."apiKey", core."userWorkspace", core."user", core.workspace CASCADE',
    );
    await owner.query(
      `INSERT INTO core.workspace (id, "displayName", "customDomain") VALUES ($1, 'Primary WS', 'taken-custom.twenty.io'), ($2, 'Foreign WS', NULL)`,
      [workspaceId, foreignWorkspaceId],
    );
    await owner.query(
      `INSERT INTO core."user" (id, email) VALUES ($1, 'admin@acme-corp.io'), ($2, 'support@twenty.io')`,
      [actorUserId, impersonatorUserId],
    );
    await owner.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId", locale) VALUES ($1, $2, $3, 'en'), ($4, $5, $3, 'en')`,
      [
        actorUserWorkspaceId,
        actorUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
      ],
    );
    await owner.query(
      `INSERT INTO core."apiKey" (id, "workspaceId") VALUES ($1, $2)`,
      [apiKeyId, workspaceId],
    );
    await owner.query(
      `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name) VALUES ($1, $2, $3, 'OAuth App'), ($4, $2, $5, 'Target App'), ($6, $2, $7, 'Cascade App')`,
      [
        oauthAppId,
        workspaceId,
        oauthAppUniversalId,
        targetAppId,
        targetAppUniversalId,
        cascadeAppId,
        cascadeAppUniversalId,
      ],
    );
  });

  afterAll(async () => {
    if (runtime.isInitialized) await runtime.destroy();
    if (owner.isInitialized) {
      await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
      await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
      await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
      await owner.destroy();
    }
    jest.restoreAllMocks();
  });

  it('audits approvedAccessDomain create, validate, and delete across resolver and service with domain redaction and email-failure rollback', async () => {
    const callerUser = { id: actorUserId };
    const callerImpersonation = { impersonatorUserWorkspaceId };

    let emailHookSawUnchangedCaller = false;
    emailSend.mockImplementationOnce(async () => {
      callerUser.id = randomUUID();
      callerImpersonation.impersonatorUserWorkspaceId = randomUUID();
      emailHookSawUnchangedCaller = true;
    });

    const created =
      await approvedAccessDomainResolver.createApprovedAccessDomain(
        { domain: 'acme-corp.io', email: 'cto@acme-corp.io' } as never,
        { id: workspaceId, displayName: 'Primary WS' } as never,
        callerUser as never,
        actorUserWorkspaceId,
        undefined,
        undefined,
        callerImpersonation as never,
      );

    expect(emailHookSawUnchangedCaller).toBe(true);
    expect(created.domain).toBe('acme-corp.io');
    expect(created.isValidated).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);

    // Email validation failure inside createApprovedAccessDomain rolls back both DB row and audit entry
    await expect(
      approvedAccessDomainResolver.createApprovedAccessDomain(
        { domain: 'second-corp.io', email: 'wrong@other-corp.io' } as never,
        { id: workspaceId, displayName: 'Primary WS' } as never,
        { id: actorUserId } as never,
        actorUserWorkspaceId,
      ),
    ).rejects.toThrow(ApprovedAccessDomainException);

    const remainingSecond = await owner.query(
      `SELECT id FROM core."approvedAccessDomain" WHERE domain='second-corp.io'`,
    );
    expect(remainingSecond).toHaveLength(0);

    // Cross-workspace validateApprovedAccessDomain is rejected before mutating Primary WS row
    const validToken = buildAsymmetricToken({
      sub: created.id,
      type: JwtTokenTypeEnum.APPROVED_ACCESS_DOMAIN,
      workspaceId,
      approvedAccessDomainId: created.id,
      domain: 'acme-corp.io',
    });

    await expect(
      approvedAccessDomainResolver.validateApprovedAccessDomain(
        {
          validationToken: validToken,
          approvedAccessDomainId: created.id,
        },
        { id: foreignWorkspaceId } as never,
        { id: actorUserId } as never,
      ),
    ).rejects.toMatchObject({
      code: ApprovedAccessDomainExceptionCode.APPROVED_ACCESS_DOMAIN_VALIDATION_TOKEN_INVALID,
    });

    // Valid OAuth client (withUser) validates the domain
    const validated =
      await approvedAccessDomainResolver.validateApprovedAccessDomain(
        {
          validationToken: validToken,
          approvedAccessDomainId: created.id,
        },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
        actorUserWorkspaceId,
        undefined,
        { id: oauthAppId } as never,
      );
    expect(validated.isValidated).toBe(true);
    expect(validated.createdAt).toBeInstanceOf(Date);

    // Duplicate validation is rejected without adding another audit entry
    await expect(
      approvedAccessDomainResolver.validateApprovedAccessDomain(
        {
          validationToken: validToken,
          approvedAccessDomainId: created.id,
        },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
        actorUserWorkspaceId,
      ),
    ).rejects.toMatchObject({
      code: ApprovedAccessDomainExceptionCode.APPROVED_ACCESS_DOMAIN_ALREADY_VALIDATED,
    });

    // Delete via API key through resolver
    const deleted =
      await approvedAccessDomainResolver.deleteApprovedAccessDomain(
        { id: created.id },
        { id: workspaceId } as never,
        undefined,
        undefined,
        { id: apiKeyId } as never,
      );
    expect(deleted).toBe(true);

    const domainAuditRows = (await audits()).filter(
      (row) => row.resourceKind === 'approvedAccessDomain',
    );
    expect(domainAuditRows).toHaveLength(3);

    expect(domainAuditRows[0]).toMatchObject({
      workspaceId,
      resourceKind: 'approvedAccessDomain',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['domain', 'isValidated'],
        values: {
          isValidated: { before: null, after: false },
        },
      },
      securityDescriptor: {
        resourceKind: 'approvedAccessDomain',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });

    expect(domainAuditRows[1]).toMatchObject({
      workspaceId,
      resourceKind: 'approvedAccessDomain',
      resourceId: created.id,
      action: 'update',
      actor: { kind: 'application', id: oauthAppId },
      initiator: { kind: 'coreUser', id: actorUserId },
      redactedDiff: {
        changedFields: ['isValidated'],
        values: {
          isValidated: { before: false, after: true },
        },
      },
    });

    expect(domainAuditRows[2]).toMatchObject({
      workspaceId,
      resourceKind: 'approvedAccessDomain',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'apiKey', id: apiKeyId },
      redactedDiff: {
        changedFields: ['domain', 'isValidated'],
        values: {
          isValidated: { before: true, after: null },
        },
      },
    });

    const serialized = JSON.stringify(domainAuditRows);
    expect(serialized).not.toContain('acme-corp.io');
    expect(serialized).not.toContain('cto@acme-corp.io');
  });

  it('audits publicDomain create, validation updates (resolver, cron, Cloudflare webhook), delete, and ApplicationService.delete cascade', async () => {
    const created = await publicDomainResolver.createPublicDomain(
      {
        domain: '  PORTAL.ACME-APP.IO  ',
        applicationId: targetAppId,
      },
      { id: workspaceId } as never,
      { id: actorUserId } as never,
      actorUserWorkspaceId,
      undefined,
      undefined,
      { impersonatorUserWorkspaceId } as never,
    );

    expect(created.domain).toBe('portal.acme-app.io');
    expect(created.isValidated).toBe(false);
    expect(registerHostname).toHaveBeenCalledWith('portal.acme-app.io', {
      isPublicDomain: true,
    });

    // Global duplicate across another workspace is rejected without calling deleteHostnameSilently
    deleteHostnameSilently.mockClear();
    await expect(
      publicDomainResolver.createPublicDomain(
        {
          domain: 'portal.acme-app.io',
          applicationId: targetAppId,
        },
        { id: foreignWorkspaceId } as never,
        { id: actorUserId } as never,
      ),
    ).rejects.toMatchObject({
      code: PublicDomainExceptionCode.PUBLIC_DOMAIN_ALREADY_REGISTERED,
    });
    expect(deleteHostnameSilently).not.toHaveBeenCalled();

    // Cron job validates the domain and records system actor CheckPublicDomainsValidRecordsCronJob
    isHostnameWorking.mockResolvedValueOnce(true);
    await checkPublicDomainsCronJob.handle();

    // Second check with unchanged isValidated=true is a no-op and writes no duplicate audit row
    isHostnameWorking.mockResolvedValueOnce(true);
    await publicDomainResolver.checkPublicDomainValidRecords(
      { domain: 'PORTAL.ACME-APP.IO' },
      { id: workspaceId } as never,
      undefined,
      undefined,
      undefined,
      { id: oauthAppId } as never,
    );

    // Cloudflare webhook transitions isValidated from true -> false and records DnsCloudflareService.checkHostname
    isHostnameWorking.mockResolvedValueOnce(false);
    await dnsCloudflareService.checkHostname('PORTAL.ACME-APP.IO');

    // Foreign workspace deletePublicDomain is a no-op and never calls deleteHostnameSilently on Primary WS domain
    deleteHostnameSilently.mockClear();
    await publicDomainResolver.deletePublicDomain(
      { domain: 'portal.acme-app.io' },
      { id: foreignWorkspaceId } as never,
      { id: actorUserId } as never,
    );
    expect(deleteHostnameSilently).not.toHaveBeenCalled();

    // Owner workspace deletePublicDomain removes the row, records audit, and then calls deleteHostnameSilently
    await publicDomainResolver.deletePublicDomain(
      { domain: 'portal.acme-app.io' },
      { id: workspaceId } as never,
      { id: actorUserId } as never,
      actorUserWorkspaceId,
    );
    expect(deleteHostnameSilently).toHaveBeenCalledTimes(1);
    expect(deleteHostnameSilently).toHaveBeenCalledWith('portal.acme-app.io', {
      isPublicDomain: true,
    });

    // ApplicationService.delete cascade-deletes publicDomain (even when referenced by primaryPublicDomainId) and applicationAuthorization
    const cascadeDomain = await publicDomainResolver.createPublicDomain(
      {
        domain: 'cascade.acme-app.io',
        applicationId: cascadeAppId,
      },
      { id: workspaceId } as never,
      { id: actorUserId } as never,
      actorUserWorkspaceId,
    );
    await owner.query(
      `UPDATE core.application SET "primaryPublicDomainId"=$1 WHERE id=$2`,
      [cascadeDomain.id, cascadeAppId],
    );
    const [cascadeAuth] = await owner.query(
      `INSERT INTO core."applicationAuthorization" ("workspaceId","userId","userWorkspaceId","applicationId",scopes)
       VALUES ($1,$2,$3,$4,ARRAY['read']) RETURNING id`,
      [workspaceId, actorUserId, actorUserWorkspaceId, cascadeAppId],
    );

    const sharedCorrId = `corr-app-delete-${randomUUID()}`;
    await applicationService.delete(cascadeAppUniversalId, workspaceId, {
      auditIdentity: {
        workspaceId,
        actor: { kind: 'coreUser', id: actorUserId },
        impersonatorUserWorkspaceId,
        correlationId: sharedCorrId,
      },
    });

    const remainingCascadeDomains = await owner.query(
      `SELECT id FROM core."publicDomain" WHERE "applicationId"=$1`,
      [cascadeAppId],
    );
    expect(remainingCascadeDomains).toHaveLength(0);

    const allAudits = await audits();
    const portalAudits = allAudits.filter(
      (row) =>
        row.resourceKind === 'publicDomain' && row.resourceId === created.id,
    );
    expect(portalAudits).toHaveLength(4);
    expect(portalAudits.map((row) => row.action)).toEqual([
      'create',
      'update',
      'update',
      'delete',
    ]);
    expect(portalAudits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['applicationId', 'domain', 'isValidated'],
        values: {
          applicationId: { before: null, after: targetAppId },
          isValidated: { before: null, after: false },
        },
      },
    });
    expect(portalAudits[1]).toMatchObject({
      actor: {
        kind: 'system',
        id: 'CheckPublicDomainsValidRecordsCronJob',
      },
      redactedDiff: {
        changedFields: ['isValidated'],
        values: {
          isValidated: { before: false, after: true },
        },
      },
    });
    expect(portalAudits[2]).toMatchObject({
      actor: {
        kind: 'system',
        id: 'DnsCloudflareService.checkHostname',
      },
      redactedDiff: {
        changedFields: ['isValidated'],
        values: {
          isValidated: { before: true, after: false },
        },
      },
    });
    expect(portalAudits[3]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      redactedDiff: {
        changedFields: ['applicationId', 'domain', 'isValidated'],
        values: {
          applicationId: { before: targetAppId, after: null },
          isValidated: { before: false, after: null },
        },
      },
    });

    const cascadeDeleteAudits = allAudits.filter(
      (row) => row.correlationId === sharedCorrId,
    );
    expect(cascadeDeleteAudits).toHaveLength(2);
    expect(cascadeDeleteAudits[0].operationId).toBe(
      cascadeDeleteAudits[1].operationId,
    );
    expect(
      [...cascadeDeleteAudits]
        .sort((a, b) =>
          String(a.resourceKind).localeCompare(String(b.resourceKind)),
        )
        .map((row) => ({
          resourceKind: row.resourceKind,
          resourceId: row.resourceId,
          action: row.action,
          initiator: row.initiator,
        })),
    ).toEqual([
      {
        resourceKind: 'applicationAuthorization',
        resourceId: cascadeAuth.id,
        action: 'delete',
        initiator: { kind: 'coreUser', id: impersonatorUserId },
      },
      {
        resourceKind: 'publicDomain',
        resourceId: cascadeDomain.id,
        action: 'delete',
        initiator: { kind: 'coreUser', id: impersonatorUserId },
      },
    ]);

    const serialized = JSON.stringify(allAudits);
    expect(serialized).not.toContain('portal.acme-app.io');
    expect(serialized).not.toContain('cascade.acme-app.io');

    const createDiff = portalAudits[0].redactedDiff as {
      changedFields: string[];
      values: Record<string, unknown>;
    };
    expect(createDiff.changedFields).toContain('domain');
    expect(Object.keys(createDiff.values)).not.toContain('domain');
  });

  it('rolls back on audit failure or post-flush trigger corruption, rejects request reuse, and preserves NativeTransactionOutcomeUnknownError without deleting DNS hostname', async () => {
    const singleUse = captureWorkspaceDomainAudit({
      workspaceId,
      auditIdentity: {
        workspaceId,
        actor: { kind: 'coreUser', id: actorUserId },
      },
    });

    const seededDomain = await withWorkspaceDomainAudit(
      {
        workspaceId,
        actor: { kind: 'coreUser', id: actorUserId },
      },
      () =>
        approvedAccessDomainService.createApprovedAccessDomain(
          'rollback-corp.io',
          { id: workspaceId, displayName: 'Primary WS' } as never,
          {
            id: actorMemberId,
            userId: actorUserId,
            userEmail: 'admin@rollback-corp.io',
            name: { firstName: 'Ada', lastName: 'Admin' },
            locale: 'en',
          } as never,
          'admin@rollback-corp.io',
          { auditIdentity: singleUse },
        ),
    );

    // Consumed request cannot be reused
    expect(() =>
      captureWorkspaceDomainAudit({
        workspaceId,
        auditIdentity: singleUse,
      }),
    ).toThrow('Workspace domain audit request cannot be reused');

    // Revoking INSERT on crm_audit."crmAuditEntry" rolls back approvedAccessDomain create (without sending email) and publicDomain create (compensating DNS)
    emailSend.mockClear();
    deleteHostnameSilently.mockClear();
    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
    );
    try {
      await expect(
        approvedAccessDomainResolver.createApprovedAccessDomain(
          {
            domain: 'no-audit-corp.io',
            email: 'cto@no-audit-corp.io',
          } as never,
          { id: workspaceId, displayName: 'Primary WS' } as never,
          { id: actorUserId } as never,
          actorUserWorkspaceId,
        ),
      ).rejects.toThrow();
      expect(emailSend).not.toHaveBeenCalled();

      await expect(
        publicDomainResolver.createPublicDomain(
          {
            domain: 'no-audit-public.io',
            applicationId: targetAppId,
          },
          { id: workspaceId } as never,
          { id: actorUserId } as never,
          actorUserWorkspaceId,
        ),
      ).rejects.toThrow();
      expect(deleteHostnameSilently).toHaveBeenCalledWith(
        'no-audit-public.io',
        { isPublicDomain: true },
      );

      await expect(
        approvedAccessDomainResolver.deleteApprovedAccessDomain(
          { id: seededDomain.id },
          { id: workspaceId } as never,
          { id: actorUserId } as never,
          actorUserWorkspaceId,
        ),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
      );
    }

    const stillExists = await owner.query(
      `SELECT id FROM core."approvedAccessDomain" WHERE id=$1`,
      [seededDomain.id],
    );
    expect(stillExists).toHaveLength(1);

    // Post-flush trigger tampering with core."approvedAccessDomain" or core."publicDomain" is detected and rolled back
    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_domain_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'approvedAccessDomain' AND NEW.action = 'update' THEN
          UPDATE core."approvedAccessDomain" SET "isValidated" = false WHERE id = NEW."resourceId"::uuid;
        END IF;
        IF NEW."resourceKind" = 'publicDomain' AND NEW.action = 'create' THEN
          UPDATE core."publicDomain" SET "isValidated" = true WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER corrupt_domain_after_audit_trg
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_domain_after_audit();
    `);
    try {
      const token = buildAsymmetricToken({
        sub: seededDomain.id,
        type: JwtTokenTypeEnum.APPROVED_ACCESS_DOMAIN,
        workspaceId,
        approvedAccessDomainId: seededDomain.id,
        domain: 'rollback-corp.io',
      });
      await expect(
        approvedAccessDomainResolver.validateApprovedAccessDomain(
          {
            validationToken: token,
            approvedAccessDomainId: seededDomain.id,
          },
          { id: workspaceId } as never,
          { id: actorUserId } as never,
          actorUserWorkspaceId,
        ),
      ).rejects.toThrow(
        'Approved access domain state changed during audit flush',
      );

      await expect(
        publicDomainResolver.createPublicDomain(
          {
            domain: 'corrupt-public.io',
            applicationId: targetAppId,
          },
          { id: workspaceId } as never,
          { id: actorUserId } as never,
          actorUserWorkspaceId,
        ),
      ).rejects.toThrow('Public domain state changed during audit flush');
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS corrupt_domain_after_audit_trg ON crm_audit."crmAuditEntry"',
      );
      await owner.query(
        'DROP FUNCTION IF EXISTS core.corrupt_domain_after_audit()',
      );
    }

    // Lost COMMIT ACK is classified as NativeTransactionOutcomeUnknownError and does NOT call deleteHostnameSilently
    deleteHostnameSilently.mockClear();
    const realCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    let lostAckInjected = false;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const qr = realCreateQueryRunner(mode);
      const connect = qr.connect.bind(qr);
      let wrapped = false;
      jest.spyOn(qr, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!wrapped && !lostAckInjected) {
          wrapped = true;
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            const res = await query(sql, ...args);
            if (sql === 'COMMIT' && !lostAckInjected) {
              lostAckInjected = true;
              throw new Error('lost commit ack');
            }

            return res;
          };
        }

        return client;
      });

      return qr;
    });

    await expect(
      publicDomainResolver.createPublicDomain(
        {
          domain: 'unknown-commit.acme-app.io',
          applicationId: targetAppId,
        },
        { id: workspaceId } as never,
        { id: actorUserId } as never,
        actorUserWorkspaceId,
      ),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(deleteHostnameSilently).not.toHaveBeenCalled();
  });
});
