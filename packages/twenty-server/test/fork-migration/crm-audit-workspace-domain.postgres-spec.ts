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
import { EmailingDomainStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/emailing-domain-status.type';
import { EmailingDomainTenantStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/emailing-domain-tenant-status.type';
import { UnsubscribeHostnameStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/unsubscribe-hostname-status.type';
import { UnsubscribeTopicVisibility } from 'src/engine/core-modules/emailing-domain/types/unsubscribe-topic-visibility.type';
import { DpaAgreementType } from 'src/engine/core-modules/dpa/enums/dpa-agreement-type.enum';
import { DpaRegion } from 'src/engine/core-modules/dpa/enums/dpa-region.enum';
import {
  SsoException,
  SsoExceptionCode,
} from 'src/engine/core-modules/sso/sso.exception';
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
    'src/engine/core-modules/emailing-domain/filters/email-group-access-graphql-api-exception.filter',
    ['EmailGroupAccessGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/emailing-domain/filters/emailing-domain-graphql-api-exception.filter',
    ['EmailingDomainGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/emailing-domain/services/email-group-access.service',
    ['EmailGroupAccessService'],
  ],
  [
    'src/engine/core-modules/emailing-domain/drivers/emailing-domain-driver.factory',
    ['EmailingDomainDriverFactory'],
  ],
  [
    'src/engine/core-modules/emailing-domain/services/dmarc-record.service',
    ['DmarcRecordService'],
  ],
  [
    'src/modules/emailing/standard-objects/campaign-delivery.workspace-entity',
    ['CampaignDeliveryWorkspaceEntity'],
  ],
  [
    'src/modules/emailing/standard-objects/message-campaign.workspace-entity',
    ['MessageCampaignWorkspaceEntity'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/dpa/services/dpa-region.service',
    ['DpaRegionService'],
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
  [
    'src/engine/core-modules/auth/guards/enterprise-features-enabled.guard',
    ['EnterpriseFeaturesEnabledGuard'],
  ],
  [
    'src/engine/core-modules/sso/filters/sso-graphql-api-exception.filter',
    ['SsoGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/billing/services/billing.service',
    ['BillingService'],
  ],
  [
    'src/engine/core-modules/exception-handler/exception-handler.service',
    ['ExceptionHandlerService'],
  ],
  [
    'src/engine/core-modules/secure-http-client/secure-http-client.service',
    ['SecureHttpClientService'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

for (const [modPath, names] of [
  [
    'src/engine/api/graphql/graphql-config/decorators/core-resolver.decorator',
    ['CoreResolver'],
  ],
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
  ['src/engine/guards/feature-flag.guard', ['FeatureFlagGuard']],
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

const EmailingDomainEntity = class EmailingDomainEntity {};
jest.doMock(
  'src/engine/core-modules/emailing-domain/emailing-domain.entity',
  () => ({
    EmailingDomainEntity,
  }),
);

const DpaAgreementEntity = class DpaAgreementEntity {};
jest.doMock(
  'src/engine/core-modules/dpa/entities/dpa-agreement.entity',
  () => ({
    DpaAgreementEntity,
  }),
);

const UnsubscribeTopicEntity = class UnsubscribeTopicEntity {};
jest.doMock(
  'src/engine/core-modules/emailing-domain/unsubscribe-topic.entity',
  () => ({
    UnsubscribeTopicEntity,
  }),
);

const WorkspaceSsoIdentityProviderEntity = class WorkspaceSsoIdentityProviderEntity {};
const IdentityProviderType = {
  OIDC: 'OIDC',
  SAML: 'SAML',
} as const;
const OidcResponseType = {
  CODE: 'code',
  ID_TOKEN: 'id_token',
  TOKEN: 'token',
  NONE: 'none',
} as const;
const SsoIdentityProviderStatus = {
  Active: 'Active',
  Inactive: 'Inactive',
  Error: 'Error',
} as const;
jest.doMock(
  'src/engine/core-modules/sso/workspace-sso-identity-provider.entity',
  () => ({
    WorkspaceSsoIdentityProviderEntity,
    IdentityProviderType,
    OidcResponseType,
    SsoIdentityProviderStatus,
  }),
);

jest.doMock('src/engine/core-modules/dpa/pdf/render-dpa-to-pdf.util', () => ({
  renderDpaToPdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 mock dpa')),
}));

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
const { EmailingDomainService } =
  require('src/engine/core-modules/emailing-domain/services/emailing-domain.service') as typeof import('src/engine/core-modules/emailing-domain/services/emailing-domain.service');
const { EmailingDomainResolver } =
  require('src/engine/core-modules/emailing-domain/emailing-domain.resolver') as typeof import('src/engine/core-modules/emailing-domain/emailing-domain.resolver');
const { EmailingDomainTenantStatusService } =
  require('src/engine/core-modules/emailing-domain/services/emailing-domain-tenant-status.service') as typeof import('src/engine/core-modules/emailing-domain/services/emailing-domain-tenant-status.service');
const { CheckEmailingDomainVerificationCronJob } =
  require('src/engine/core-modules/emailing-domain/crons/jobs/check-emailing-domain-verification.cron.job') as typeof import('src/engine/core-modules/emailing-domain/crons/jobs/check-emailing-domain-verification.cron.job');
const { OutboundSendingStateHandlerService } =
  require('src/modules/messaging-webhooks/handlers/outbound-sending-state-handler.service') as typeof import('src/modules/messaging-webhooks/handlers/outbound-sending-state-handler.service');
const { UnsubscribeHostnameService } =
  require('src/engine/core-modules/emailing-domain/services/unsubscribe-hostname.service') as typeof import('src/engine/core-modules/emailing-domain/services/unsubscribe-hostname.service');
const { seedEmailingDomains } =
  require('src/engine/workspace-manager/dev-seeder/core/utils/seed-emailing-domains.util') as typeof import('src/engine/workspace-manager/dev-seeder/core/utils/seed-emailing-domains.util');
const { DpaService } =
  require('src/engine/core-modules/dpa/services/dpa.service') as typeof import('src/engine/core-modules/dpa/services/dpa.service');
const { DpaResolver } =
  require('src/engine/core-modules/dpa/dpa.resolver') as typeof import('src/engine/core-modules/dpa/dpa.resolver');
const { UnsubscribeTopicService } =
  require('src/modules/emailing/services/unsubscribe-topic.service') as typeof import('src/modules/emailing/services/unsubscribe-topic.service');
const { UnsubscribeTopicResolver } =
  require('src/modules/emailing/resolvers/unsubscribe-topic.resolver') as typeof import('src/modules/emailing/resolvers/unsubscribe-topic.resolver');
const { seedUnsubscribeTopics } =
  require('src/engine/workspace-manager/dev-seeder/core/utils/seed-unsubscribe-topics.util') as typeof import('src/engine/workspace-manager/dev-seeder/core/utils/seed-unsubscribe-topics.util');
const { SsoService } =
  require('src/engine/core-modules/sso/services/sso.service') as typeof import('src/engine/core-modules/sso/services/sso.service');
const { SsoResolver } =
  require('src/engine/core-modules/sso/sso.resolver') as typeof import('src/engine/core-modules/sso/sso.resolver');

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
  new EntitySchema({
    name: 'EmailingDomainEntity',
    target: EmailingDomainEntity,
    schema: 'core',
    tableName: 'emailingDomain',
    columns: {
      id: { type: 'uuid', primary: true, generated: 'uuid' },
      workspaceId: { type: 'uuid' },
      domain: { type: 'varchar' },
      status: { type: 'varchar', default: 'PENDING' },
      verificationRecords: { type: 'jsonb', nullable: true },
      verifiedAt: { type: 'timestamptz', nullable: true },
      tenantStatus: { type: 'varchar', default: 'ACTIVE' },
      unsubscribeHostname: { type: 'varchar', nullable: true },
      unsubscribeHostnameId: { type: 'varchar', nullable: true },
      unsubscribeHostnameStatus: { type: 'varchar', nullable: true },
      createdAt: { type: 'timestamptz' },
      updatedAt: { type: 'timestamptz' },
    },
  }),
  new EntitySchema({
    name: 'DpaAgreementEntity',
    target: DpaAgreementEntity,
    schema: 'core',
    tableName: 'dpaAgreement',
    columns: {
      id: { type: 'uuid', primary: true, generated: 'uuid' },
      workspaceId: { type: 'uuid' },
      type: { type: 'varchar' },
      templateVersion: { type: 'varchar' },
      region: { type: 'varchar' },
      processorEntity: { type: 'varchar' },
      customerLegalEntityName: { type: 'varchar', nullable: true },
      signatoryName: { type: 'varchar', nullable: true },
      signatoryTitle: { type: 'varchar', nullable: true },
      signedFileId: { type: 'uuid', nullable: true },
      acceptedByUserId: { type: 'uuid', nullable: true },
      acceptedByEmail: { type: 'varchar', nullable: true },
      acceptedAt: { type: 'timestamptz' },
      createdAt: { type: 'timestamptz' },
      updatedAt: { type: 'timestamptz' },
    },
  }),
  new EntitySchema({
    name: 'UnsubscribeTopicEntity',
    target: UnsubscribeTopicEntity,
    schema: 'core',
    tableName: 'unsubscribeTopic',
    columns: {
      id: { type: 'uuid', primary: true, generated: 'uuid' },
      workspaceId: { type: 'uuid' },
      name: { type: 'varchar', nullable: true },
      description: { type: 'varchar', nullable: true },
      visibility: { type: 'varchar', default: 'PRIVATE' },
      createdAt: { type: 'timestamptz' },
      updatedAt: { type: 'timestamptz' },
    },
  }),
  new EntitySchema({
    name: 'WorkspaceSsoIdentityProviderEntity',
    target: WorkspaceSsoIdentityProviderEntity,
    schema: 'core',
    tableName: 'workspaceSSOIdentityProvider',
    columns: {
      id: { type: 'uuid', primary: true, generated: 'uuid' },
      workspaceId: { type: 'uuid' },
      name: { type: 'varchar' },
      status: { type: 'varchar', default: 'Active' },
      type: { type: 'varchar', default: 'OIDC' },
      issuer: { type: 'varchar' },
      clientID: { type: 'varchar', nullable: true },
      clientSecret: { type: 'varchar', nullable: true },
      ssoURL: { type: 'varchar', nullable: true },
      certificate: { type: 'varchar', nullable: true },
      fingerprint: { type: 'varchar', nullable: true },
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
  let emailingDomainService: InstanceType<typeof EmailingDomainService>;
  let emailingDomainResolver: InstanceType<typeof EmailingDomainResolver>;
  let emailingDomainTenantStatusService: InstanceType<
    typeof EmailingDomainTenantStatusService
  >;
  let checkEmailingDomainCronJob: InstanceType<
    typeof CheckEmailingDomainVerificationCronJob
  >;
  let outboundSendingStateHandler: InstanceType<
    typeof OutboundSendingStateHandlerService
  >;
  let dpaService: InstanceType<typeof DpaService>;
  let dpaResolver: InstanceType<typeof DpaResolver>;
  let unsubscribeTopicService: InstanceType<typeof UnsubscribeTopicService>;
  let unsubscribeTopicResolver: InstanceType<typeof UnsubscribeTopicResolver>;
  let ssoService: InstanceType<typeof SsoService>;
  let ssoResolver: InstanceType<typeof SsoResolver>;
  const emailingDriverMock = {
    provisionWorkspace: jest.fn(async () => undefined),
    deprovisionWorkspace: jest.fn(async () => undefined),
    verifyDomain: jest.fn(async ({ domain }: { domain: string }) => ({
      status: EmailingDomainStatus.PENDING,
      verificationRecords: [
        {
          type: 'TXT',
          key: `_amazonses.${domain}`,
          value: 'secret-ses-token-123',
        },
      ],
    })),
    registerDomain: jest.fn(async () => undefined),
    cleanupDomain: jest.fn(async () => undefined),
  };
  let campaignSending = false;
  let isSelfHostedConfig = false;

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
        CREATE TABLE core."emailingDomain" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          domain varchar NOT NULL UNIQUE,
          status varchar NOT NULL DEFAULT 'PENDING',
          "verificationRecords" jsonb NULL,
          "verifiedAt" timestamptz NULL,
          "tenantStatus" varchar NOT NULL DEFAULT 'ACTIVE',
          "unsubscribeHostname" varchar NULL,
          "unsubscribeHostnameId" varchar NULL,
          "unsubscribeHostnameStatus" varchar NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE core."dpaAgreement" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          type varchar NOT NULL,
          "templateVersion" varchar NOT NULL,
          region varchar NOT NULL,
          "processorEntity" varchar NOT NULL,
          "customerLegalEntityName" varchar NULL,
          "signatoryName" varchar NULL,
          "signatoryTitle" varchar NULL,
          "signedFileId" uuid NULL,
          "acceptedByUserId" uuid NULL,
          "acceptedByEmail" varchar NULL,
          "acceptedAt" timestamptz NOT NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE core."unsubscribeTopic" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          name varchar NULL,
          description varchar NULL,
          visibility varchar NOT NULL DEFAULT 'PRIVATE',
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE core."workspaceSSOIdentityProvider" (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
          name varchar NOT NULL,
          status varchar NOT NULL DEFAULT 'Active',
          type varchar NOT NULL DEFAULT 'OIDC',
          issuer varchar NOT NULL,
          "clientID" varchar NULL,
          "clientSecret" varchar NULL,
          "ssoURL" varchar NULL,
          certificate varchar NULL,
          fingerprint varchar NULL,
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
        findOneOrFail: (wsId: string, opts?: Record<string, unknown>) =>
          repo.findOneOrFail({
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

    const dnsManagerWithConfiguredMock = {
      isConfigured: () => true,
      registerHostname,
      deleteHostnameSilently,
      refreshHostname,
      getHostnameWithRecords,
      isHostnameWorking,
    };

    const unsubscribeHostnameService = new UnsubscribeHostnameService(
      makeScopedRepo(EmailingDomainEntity) as never,
      dnsManagerWithConfiguredMock as never,
      { get: () => 'https://crm.twenty.local' } as never,
    );

    emailingDomainService = new EmailingDomainService(
      makeScopedRepo(EmailingDomainEntity) as never,
      runtime.getRepository(EmailingDomainEntity) as never,
      { getCurrentDriver: () => emailingDriverMock } as never,
      unsubscribeHostnameService,
      { withDnsRecord: (ed: unknown) => ed } as never,
      {
        executeInWorkspaceContext: async <TResult>(
          fn: () => Promise<TResult>,
        ) => fn(),
        getRepository: () => ({
          exists: async () => campaignSending,
        }),
      } as never,
      runtime,
    );

    emailingDomainResolver = new EmailingDomainResolver(emailingDomainService, {
      validateEmailGroupAccessOrThrow: () => undefined,
    } as never);

    emailingDomainTenantStatusService = new EmailingDomainTenantStatusService(
      makeScopedRepo(EmailingDomainEntity) as never,
      runtime,
    );

    outboundSendingStateHandler = new OutboundSendingStateHandlerService(
      emailingDomainTenantStatusService,
    );

    checkEmailingDomainCronJob = new CheckEmailingDomainVerificationCronJob(
      runtime.getRepository(EmailingDomainEntity) as never,
      emailingDomainService,
      unsubscribeHostnameService,
      { getCurrentDriver: () => emailingDriverMock } as never,
    );

    dpaService = new DpaService(
      runtime.getRepository(DpaAgreementEntity) as never,
      { getRegionForWorkspace: () => DpaRegion.EU } as never,
      { writeFile: jest.fn(async () => undefined) } as never,
      {
        signFileByIdUrl: jest.fn(
          async ({ fileId }: { fileId: string }) =>
            `https://crm.twenty.local/dpa/${fileId}.pdf`,
        ),
      } as never,
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
          workspaceCustomFlatApplication: {
            id: targetAppId,
            universalIdentifier: targetAppUniversalId,
          },
        }),
      } as never,
      {
        get: (key: string) =>
          key === 'IS_MULTIWORKSPACE_ENABLED' ? !isSelfHostedConfig : undefined,
      } as never,
      runtime,
    );

    dpaResolver = new DpaResolver(dpaService);

    unsubscribeTopicService = new UnsubscribeTopicService(
      makeScopedRepo(UnsubscribeTopicEntity) as never,
      runtime,
    );

    unsubscribeTopicResolver = new UnsubscribeTopicResolver(
      unsubscribeTopicService,
      { validateEmailGroupAccessOrThrow: () => undefined } as never,
    );

    ssoService = new SsoService(
      runtime.getRepository(WorkspaceSsoIdentityProviderEntity) as never,
      { get: () => 'https://crm.twenty.local' } as never,
      { hasEntitlement: async () => true } as never,
      { captureExceptions: jest.fn() } as never,
      { getSsrfSafeAgent: () => undefined } as never,
      runtime,
    );
    jest.spyOn(ssoService, 'discoverOidcIssuer').mockImplementation(
      async (issuerUrl: string) =>
        ({
          metadata: { issuer: issuerUrl.trim() },
        }) as never,
    );

    ssoResolver = new SsoResolver(ssoService);
  });

  beforeEach(async () => {
    emailSend.mockClear();
    registerHostname.mockClear();
    deleteHostnameSilently.mockClear();
    refreshHostname.mockClear();
    getHostnameWithRecords.mockClear();
    isHostnameWorking.mockClear();
    emailingDriverMock.provisionWorkspace.mockClear();
    emailingDriverMock.deprovisionWorkspace.mockClear();
    emailingDriverMock.verifyDomain.mockClear();
    emailingDriverMock.registerDomain.mockClear();
    emailingDriverMock.cleanupDomain.mockClear();
    campaignSending = false;
    isSelfHostedConfig = false;
    verifyJwtTokenImpl = async (token: string) => {
      const [, payloadSeg] = token.split('.');

      return JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
    };

    await owner.query(
      'TRUNCATE TABLE crm_audit."crmAuditEntry", core."workspaceSSOIdentityProvider", core."unsubscribeTopic", core."dpaAgreement", core."emailingDomain", core."applicationAuthorization", core."publicDomain", core."approvedAccessDomain", core.application, core."apiKey", core."userWorkspace", core."user", core.workspace CASCADE',
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

  it('audits emailingDomain create, unsubscribeHostname sync, verify, cron refresh, tenantStatus update, ensure/deleteByDomain, delete, and seedEmailingDomains with redaction (LOG184)', async () => {
    const memberContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    };

    // 1. Create emailingDomain via EmailingDomainResolver (provisions unsubscribeHostname and refreshes status)
    isHostnameWorking.mockResolvedValueOnce(false);
    const created = await emailingDomainResolver.createEmailingDomain(
      { domain: '  MAIL.ACME-CORP.IO  ' },
      { id: workspaceId } as never,
      memberContext,
    );
    expect(created.domain).toBe('mail.acme-corp.io');
    expect(created.status).toBe(EmailingDomainStatus.PENDING);
    expect(
      (created as unknown as Record<string, unknown>).unsubscribeHostname,
    ).toBe('unsubscribe.mail.acme-corp.io');
    expect(
      (created as unknown as Record<string, unknown>).unsubscribeHostnameId,
    ).toBe('cf-host-1');
    expect(created.unsubscribeHostnameStatus).toBe(
      UnsubscribeHostnameStatus.PENDING,
    );

    // 2. Cron job refreshes unverified domain -> VERIFIED and refreshes pending unsubscribe hostname -> ACTIVE
    emailingDriverMock.verifyDomain.mockResolvedValueOnce({
      status: EmailingDomainStatus.VERIFIED,
      verificationRecords: [
        {
          type: 'TXT',
          key: '_amazonses.mail.acme-corp.io',
          value: 'verified-ses-token',
        },
      ],
    });
    isHostnameWorking.mockResolvedValueOnce(false);
    isHostnameWorking.mockResolvedValueOnce(true);
    await checkEmailingDomainCronJob.handle();

    // 3. Ensure second domain (MessageChannelMetadataService path) and seed a SANDBOX domain to test tenantStatus filtering
    await emailingDomainService.ensureEmailingDomain(
      'inbound.acme-corp.io',
      workspaceId,
      {
        auditIdentity: {
          workspaceId,
          userWorkspaceId: actorUserWorkspaceId,
        },
      },
    );
    const [sandboxRow] = await owner.query(
      `INSERT INTO core."emailingDomain" ("workspaceId", domain, status, "tenantStatus")
       VALUES ($1, 'sandbox.acme-corp.io', 'VERIFIED', 'SANDBOX')
       RETURNING id`,
      [workspaceId],
    );

    // 4. OutboundSendingStateHandlerService transitions non-SANDBOX domains to PAUSED
    await outboundSendingStateHandler.handle({
      workspaceId,
      status: EmailingDomainTenantStatus.PAUSED,
    } as never);

    const [sandboxAfter] = await owner.query(
      `SELECT "tenantStatus" FROM core."emailingDomain" WHERE id=$1`,
      [sandboxRow.id],
    );
    expect(sandboxAfter.tenantStatus).toBe('SANDBOX');

    // 5. Delete inbound domain via deleteEmailingDomainByDomainIfExists and primary domain via EmailingDomainResolver
    await emailingDomainService.deleteEmailingDomainByDomainIfExists(
      workspaceId,
      'inbound.acme-corp.io',
      {
        auditIdentity: {
          workspaceId,
          userWorkspaceId: actorUserWorkspaceId,
        },
      },
    );
    await emailingDomainResolver.deleteEmailingDomain(
      created.id,
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          apiKey: { id: apiKeyId },
        },
      },
    );

    // 6. seedEmailingDomains records system create audit entries
    const seedQr = runtime.createQueryRunner();
    await seedQr.connect();
    await seedQr.startTransaction();
    try {
      await seedEmailingDomains({
        queryRunner: seedQr,
        schemaName: 'core',
        workspaceId,
      });
      await seedQr.commitTransaction();
    } finally {
      await seedQr.release();
    }

    const edAudits = (await audits()).filter(
      (row) => row.resourceKind === 'emailingDomain',
    );
    const createdDomainAudits = edAudits.filter(
      (row) => row.resourceId === created.id,
    );
    expect(createdDomainAudits.map((row) => row.action)).toEqual([
      'create',
      'update',
      'update',
      'update',
      'update',
      'delete',
    ]);
    expect(createdDomainAudits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'domain',
          'status',
          'tenantStatus',
          'verificationRecords',
        ]),
        values: {
          status: { before: null, after: 'PENDING' },
          tenantStatus: { before: null, after: 'ACTIVE' },
        },
      },
    });
    const createdEdValues = (
      createdDomainAudits[0].redactedDiff as { values: Record<string, unknown> }
    ).values;
    expect(createdEdValues).not.toHaveProperty('domain');
    expect(createdEdValues).not.toHaveProperty('verificationRecords');
    expect(createdDomainAudits[1]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'unsubscribeHostname',
          'unsubscribeHostnameId',
          'unsubscribeHostnameStatus',
        ]),
        values: {
          unsubscribeHostnameStatus: { before: null, after: 'PENDING' },
        },
      },
    });
    expect(createdDomainAudits[2]).toMatchObject({
      actor: {
        kind: 'system',
        id: 'CheckEmailingDomainVerificationCronJob',
      },
      redactedDiff: {
        values: {
          status: { before: 'PENDING', after: 'VERIFIED' },
        },
      },
    });
    expect(createdDomainAudits[3]).toMatchObject({
      actor: {
        kind: 'system',
        id: 'CheckEmailingDomainVerificationCronJob',
      },
      redactedDiff: {
        values: {
          unsubscribeHostnameStatus: { before: 'PENDING', after: 'ACTIVE' },
        },
      },
    });
    expect(createdDomainAudits[4]).toMatchObject({
      actor: {
        kind: 'system',
        id: 'OutboundSendingStateHandlerService',
      },
      redactedDiff: {
        values: {
          tenantStatus: { before: 'ACTIVE', after: 'PAUSED' },
        },
      },
    });
    expect(createdDomainAudits[5]).toMatchObject({
      actor: { kind: 'apiKey', id: apiKeyId },
      action: 'delete',
    });

    const seededAudits = edAudits.filter(
      (row) =>
        (row.actor as { kind?: string; id?: string })?.id ===
        'dev-seeder:seed-emailing-domains',
    );
    expect(seededAudits).toHaveLength(2);

    const serialized = JSON.stringify(edAudits);
    expect(serialized).not.toContain('mail.acme-corp.io');
    expect(serialized).not.toContain('secret-ses-token-123');
    expect(serialized).not.toContain('verified-ses-token');
    expect(serialized).not.toContain('cf-host-1');
  });

  it('audits dpaAgreement create via DpaResolver and DpaService with PII redaction, actor mismatch rejection, and post-flush tamper rollback (LOG184)', async () => {
    const { agreement, downloadUrl } = await dpaResolver.generateSignedDpa(
      { id: workspaceId } as never,
      { id: actorUserId, email: 'admin@acme-corp.io' } as never,
      {
        customerLegalEntityName: 'Acme Corporation GmbH',
        signatoryName: 'Ada Lovelace',
        signatoryTitle: 'Chief Executive Officer',
      },
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: actorUserId },
          userWorkspaceId: actorUserWorkspaceId,
          impersonationContext: { impersonatorUserWorkspaceId },
        },
      },
    );

    expect(agreement.id).toBeDefined();
    expect(agreement.type).toBe(DpaAgreementType.SIGNED);
    expect(downloadUrl).toContain(agreement.signedFileId!);

    const dpaAudits = (await audits()).filter(
      (row) => row.resourceKind === 'dpaAgreement',
    );
    expect(dpaAudits).toHaveLength(1);
    expect(dpaAudits[0]).toMatchObject({
      workspaceId,
      resourceKind: 'dpaAgreement',
      resourceId: agreement.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'acceptedAt',
          'acceptedByEmail',
          'acceptedByUserId',
          'customerLegalEntityName',
          'processorEntity',
          'region',
          'signatoryName',
          'signatoryTitle',
          'signedFileId',
          'templateVersion',
          'type',
        ]),
        values: {
          type: { before: null, after: 'SIGNED' },
          region: { before: null, after: 'EU' },
          signedFileId: { before: null, after: agreement.signedFileId },
          acceptedByUserId: { before: null, after: actorUserId },
        },
      },
      securityDescriptor: {
        resourceKind: 'dpaAgreement',
        resourceId: agreement.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    const dpaValues = (
      dpaAudits[0].redactedDiff as { values: Record<string, unknown> }
    ).values;
    expect(dpaValues).not.toHaveProperty('customerLegalEntityName');
    expect(dpaValues).not.toHaveProperty('signatoryName');
    expect(dpaValues).not.toHaveProperty('signatoryTitle');
    expect(dpaValues).not.toHaveProperty('acceptedByEmail');
    expect(dpaValues).not.toHaveProperty('processorEntity');
    expect(dpaValues).not.toHaveProperty('acceptedAt');

    const serialized = JSON.stringify(dpaAudits);
    expect(serialized).not.toContain('Acme Corporation GmbH');
    expect(serialized).not.toContain('Ada Lovelace');
    expect(serialized).not.toContain('Chief Executive Officer');
    expect(serialized).not.toContain('admin@acme-corp.io');

    // Actor mismatch between context user and userId is rejected
    await expect(
      dpaResolver.generateSignedDpa(
        { id: workspaceId } as never,
        { id: impersonatorUserId, email: 'support@twenty.io' } as never,
        {
          customerLegalEntityName: 'Mismatch Corp',
          signatoryName: 'Mallory',
          signatoryTitle: 'Director',
        },
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: actorUserId },
            userWorkspaceId: actorUserWorkspaceId,
          },
        },
      ),
    ).rejects.toThrow(
      'DPA agreement audit actor mismatch with acceptedByUserId',
    );

    // Post-flush trigger tampering on core."dpaAgreement" and core."emailingDomain" rolls back transaction
    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_log184_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'dpaAgreement' AND NEW.action = 'create' THEN
          UPDATE core."dpaAgreement" SET "signatoryName" = 'Tampered' WHERE id = NEW."resourceId"::uuid;
        END IF;
        IF NEW."resourceKind" = 'emailingDomain' AND NEW.action = 'create' THEN
          UPDATE core."emailingDomain" SET status = 'VERIFIED' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER corrupt_log184_after_audit_trg
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_log184_after_audit();
    `);
    try {
      await expect(
        dpaResolver.generateSignedDpa(
          { id: workspaceId } as never,
          { id: actorUserId, email: 'admin@acme-corp.io' } as never,
          {
            customerLegalEntityName: 'Tampered Corp',
            signatoryName: 'Tampered Signer',
            signatoryTitle: 'CTO',
          },
          {
            req: {
              workspace: { id: workspaceId },
              user: { id: actorUserId },
              userWorkspaceId: actorUserWorkspaceId,
            },
          },
        ),
      ).rejects.toThrow('DPA agreement state changed during audit flush');

      emailingDriverMock.cleanupDomain.mockClear();
      await expect(
        emailingDomainResolver.createEmailingDomain(
          { domain: 'tampered.acme-corp.io' },
          { id: workspaceId } as never,
          {
            req: {
              workspace: { id: workspaceId },
              user: { id: actorUserId },
              userWorkspaceId: actorUserWorkspaceId,
            },
          },
        ),
      ).rejects.toThrow('Emailing domain state changed during audit flush');
      expect(emailingDriverMock.cleanupDomain).toHaveBeenCalledWith({
        domain: 'tampered.acme-corp.io',
        workspaceId,
      });
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS corrupt_log184_after_audit_trg ON crm_audit."crmAuditEntry"',
      );
      await owner.query(
        'DROP FUNCTION IF EXISTS core.corrupt_log184_after_audit()',
      );
    }
  });

  it('audits unsubscribeTopic create, update, delete, and seedUnsubscribeTopics with redaction and post-flush tamper rollback (LOG185)', async () => {
    const memberContext = () => ({
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    });

    // 1. Seed unsubscribe topics (3 seeded rows, idempotent on re-run)
    const seedRunner = runtime.createQueryRunner();
    try {
      await seedRunner.connect();
      await seedRunner.startTransaction();
      await seedUnsubscribeTopics({
        queryRunner: seedRunner,
        schemaName: 'core',
        workspaceId,
      });
      await seedUnsubscribeTopics({
        queryRunner: seedRunner,
        schemaName: 'core',
        workspaceId,
      });
      await seedRunner.commitTransaction();
    } finally {
      await seedRunner.release();
    }

    const seededAudits = (await audits()).filter(
      (row) => row.resourceKind === 'unsubscribeTopic',
    );
    expect(seededAudits).toHaveLength(3);
    expect(seededAudits[0]).toMatchObject({
      workspaceId,
      resourceKind: 'unsubscribeTopic',
      action: 'create',
      actor: { kind: 'system', id: 'dev-seeder:seed-unsubscribe-topics' },
      redactedDiff: {
        changedFields: ['description', 'name', 'visibility'],
        values: {
          visibility: { before: null, after: 'PUBLIC' },
        },
      },
    });

    // 2. Create custom topic via UnsubscribeTopicResolver
    const createdTopic = await unsubscribeTopicResolver.createUnsubscribeTopic(
      {
        name: 'VIP Security Advisories',
        description: 'Critical security bulletins for enterprise admins',
        visibility: UnsubscribeTopicVisibility.PRIVATE,
      },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(createdTopic.name).toBe('VIP Security Advisories');
    expect(createdTopic.visibility).toBe(UnsubscribeTopicVisibility.PRIVATE);

    // 3. Update topic via UnsubscribeTopicResolver
    const updatedTopic = await unsubscribeTopicResolver.updateUnsubscribeTopic(
      {
        id: createdTopic.id,
        name: 'Public Security Advisories',
        visibility: UnsubscribeTopicVisibility.PUBLIC,
      },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(updatedTopic.name).toBe('Public Security Advisories');
    expect(updatedTopic.visibility).toBe(UnsubscribeTopicVisibility.PUBLIC);

    // No-op update does not emit a duplicate audit row
    await unsubscribeTopicResolver.updateUnsubscribeTopic(
      {
        id: createdTopic.id,
        name: 'Public Security Advisories',
        visibility: UnsubscribeTopicVisibility.PUBLIC,
      },
      { id: workspaceId } as never,
      memberContext(),
    );

    // 4. Delete topic via UnsubscribeTopicResolver
    const deleted = await unsubscribeTopicResolver.deleteUnsubscribeTopic(
      createdTopic.id,
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(deleted).toBe(true);

    const topicAudits = (await audits()).filter(
      (row) =>
        row.resourceKind === 'unsubscribeTopic' &&
        row.resourceId === createdTopic.id,
    );
    expect(topicAudits).toHaveLength(3);
    expect(topicAudits.map((row) => row.action)).toEqual([
      'create',
      'update',
      'delete',
    ]);
    expect(topicAudits[0]).toMatchObject({
      workspaceId,
      resourceKind: 'unsubscribeTopic',
      resourceId: createdTopic.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['description', 'name', 'visibility'],
        values: {
          visibility: { before: null, after: 'PRIVATE' },
        },
      },
      securityDescriptor: {
        resourceKind: 'unsubscribeTopic',
        resourceId: createdTopic.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(topicAudits[1]).toMatchObject({
      action: 'update',
      redactedDiff: {
        changedFields: ['name', 'visibility'],
        values: {
          visibility: { before: 'PRIVATE', after: 'PUBLIC' },
        },
      },
    });
    expect(topicAudits[2]).toMatchObject({
      action: 'delete',
      redactedDiff: {
        changedFields: ['description', 'name', 'visibility'],
        values: {
          visibility: { before: 'PUBLIC', after: null },
        },
      },
    });

    const serializedTopicAudits = JSON.stringify(topicAudits);
    expect(serializedTopicAudits).not.toContain('VIP Security Advisories');
    expect(serializedTopicAudits).not.toContain('Public Security Advisories');
    expect(serializedTopicAudits).not.toContain(
      'Critical security bulletins for enterprise admins',
    );

    // Post-flush trigger tampering on core."unsubscribeTopic" rolls back transaction
    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_log185_topic_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'unsubscribeTopic' AND NEW.action = 'create' THEN
          UPDATE core."unsubscribeTopic" SET visibility = 'PUBLIC' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER corrupt_log185_topic_after_audit_trg
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_log185_topic_after_audit();
    `);
    try {
      await expect(
        unsubscribeTopicResolver.createUnsubscribeTopic(
          {
            name: 'Tampered Topic',
            visibility: UnsubscribeTopicVisibility.PRIVATE,
          },
          { id: workspaceId } as never,
          memberContext(),
        ),
      ).rejects.toThrow('Unsubscribe topic state changed during audit flush');
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS corrupt_log185_topic_after_audit_trg ON crm_audit."crmAuditEntry"',
      );
      await owner.query(
        'DROP FUNCTION IF EXISTS core.corrupt_log185_topic_after_audit()',
      );
    }
  });

  it('audits ssoIdentityProvider OIDC/SAML create, status edit, delete, duplicate rejection, secret redaction, and post-flush tamper rollback (LOG185)', async () => {
    const memberContext = () => ({
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    });

    // 1. Create OIDC SSO identity provider via SsoResolver
    const oidcResult = await ssoResolver.createOIDCIdentityProvider(
      {
        name: 'Acme Okta OIDC',
        issuer: 'https://okta.acme-corp.io/oauth2/default',
        clientID: 'oidc-client-id-secret-123',
        clientSecret: 'super-secret-oidc-client-secret-xyz',
      },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(oidcResult).not.toBeInstanceOf(SsoException);
    const oidcIdp = oidcResult as {
      id: string;
      type: string;
      name: string;
      status: string;
      issuer: string;
    };
    expect(oidcIdp.type).toBe('OIDC');
    expect(oidcIdp.status).toBe('Active');

    // 2. Create SAML SSO identity provider via SsoResolver
    const samlId = randomUUID();
    const samlResult = await ssoResolver.createSAMLIdentityProvider(
      {
        id: samlId,
        name: 'Acme Entra SAML',
        issuer: 'https://sts.windows.net/acme-tenant-id/',
        ssoURL: 'https://login.microsoftonline.com/acme-tenant-id/saml2',
        certificate: 'MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAw',
        fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33',
      },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(samlResult).toMatchObject({
      id: samlId,
      type: 'SAML',
      name: 'Acme Entra SAML',
      status: 'Active',
    });

    // Duplicate SAML id throws IDENTITY_PROVIDER_ALREADY_EXISTS and writes no extra audit entry
    await expect(
      ssoResolver.createSAMLIdentityProvider(
        {
          id: samlId,
          name: 'Duplicate SAML',
          issuer: 'https://sts.windows.net/acme-tenant-id/',
          ssoURL: 'https://login.microsoftonline.com/acme-tenant-id/saml2',
          certificate:
            'MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAw',
        },
        { id: workspaceId } as never,
        memberContext(),
      ),
    ).rejects.toMatchObject({
      code: SsoExceptionCode.IDENTITY_PROVIDER_ALREADY_EXISTS,
    });

    // 3. Edit status via SsoResolver
    const edited = await ssoResolver.editSSOIdentityProvider(
      {
        id: oidcIdp.id,
        status: SsoIdentityProviderStatus.Inactive as never,
      },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(edited.status).toBe('Inactive');

    // 4. Delete SAML IdP via SsoResolver
    const deletedSaml = await ssoResolver.deleteSSOIdentityProvider(
      { identityProviderId: samlId },
      { id: workspaceId } as never,
      memberContext(),
    );
    expect(deletedSaml).toEqual({ identityProviderId: samlId });

    const ssoAudits = (await audits()).filter(
      (row) => row.resourceKind === 'ssoIdentityProvider',
    );
    expect(ssoAudits).toHaveLength(4);
    expect(ssoAudits.map((row) => [row.resourceId, row.action])).toEqual([
      [oidcIdp.id, 'create'],
      [samlId, 'create'],
      [oidcIdp.id, 'update'],
      [samlId, 'delete'],
    ]);
    expect(ssoAudits[0]).toMatchObject({
      workspaceId,
      resourceKind: 'ssoIdentityProvider',
      resourceId: oidcIdp.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: expect.arrayContaining([
          'clientID',
          'clientSecret',
          'issuer',
          'name',
          'status',
          'type',
        ]),
        values: {
          type: { before: null, after: 'OIDC' },
          status: { before: null, after: 'Active' },
        },
      },
      securityDescriptor: {
        resourceKind: 'ssoIdentityProvider',
        resourceId: oidcIdp.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(ssoAudits[2]).toMatchObject({
      resourceId: oidcIdp.id,
      action: 'update',
      redactedDiff: {
        changedFields: ['status'],
        values: {
          status: { before: 'Active', after: 'Inactive' },
        },
      },
    });
    expect(ssoAudits[3]).toMatchObject({
      resourceId: samlId,
      action: 'delete',
      redactedDiff: {
        values: {
          type: { before: 'SAML', after: null },
          status: { before: 'Active', after: null },
        },
      },
    });

    const serializedSsoAudits = JSON.stringify(ssoAudits);
    expect(serializedSsoAudits).not.toContain(
      'super-secret-oidc-client-secret-xyz',
    );
    expect(serializedSsoAudits).not.toContain('oidc-client-id-secret-123');
    expect(serializedSsoAudits).not.toContain(
      'MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAw',
    );
    expect(serializedSsoAudits).not.toContain('AA:BB:CC:DD:EE:FF:00:11:22:33');
    expect(serializedSsoAudits).not.toContain('Acme Okta OIDC');
    expect(serializedSsoAudits).not.toContain('Acme Entra SAML');

    // Post-flush trigger tampering on core."workspaceSSOIdentityProvider" rolls back transaction
    await owner.query(`
      CREATE OR REPLACE FUNCTION core.corrupt_log185_sso_after_audit()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW."resourceKind" = 'ssoIdentityProvider' AND NEW.action = 'update' THEN
          UPDATE core."workspaceSSOIdentityProvider" SET status = 'Error' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER corrupt_log185_sso_after_audit_trg
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION core.corrupt_log185_sso_after_audit();
    `);
    try {
      await expect(
        ssoResolver.editSSOIdentityProvider(
          {
            id: oidcIdp.id,
            status: SsoIdentityProviderStatus.Active as never,
          },
          { id: workspaceId } as never,
          memberContext(),
        ),
      ).rejects.toThrow(
        'SSO identity provider state changed during audit flush',
      );
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS corrupt_log185_sso_after_audit_trg ON crm_audit."crmAuditEntry"',
      );
      await owner.query(
        'DROP FUNCTION IF EXISTS core.corrupt_log185_sso_after_audit()',
      );
    }
  });
});
