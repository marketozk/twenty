import { createHash, randomUUID } from 'node:crypto';
import { ALL_METADATA_NAME } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { ApplicationRegistrationSourceType } from 'src/engine/core-modules/application/application-registration/enums/application-registration-source-type.enum';
import {
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: { ROLE: 'ROLE', METADATA: 'METADATA' },
  isAiModelTier: jest.fn(() => true),
}));
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
jest.mock(
  'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars',
  () => ({
    UUIDScalarType: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/application/utils/serialize-application-for-broadcast.util',
  () => ({
    serializeApplicationForBroadcast: jest.fn((app: unknown) => app),
  }),
);
for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/application-registration/application-registration.entity',
    ['ApplicationRegistrationEntity'],
  ],
  [
    'src/engine/core-modules/application/application-registration/application-registration.service',
    ['ApplicationRegistrationService'],
  ],
  [
    'src/engine/core-modules/application/application-install/application-install.service',
    ['ApplicationInstallService'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable.entity',
    ['ApplicationVariableEntity'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable.service',
    ['ApplicationVariableEntityService'],
  ],
  [
    'src/engine/core-modules/application/application-variable/user-application-variable-value.entity',
    ['UserApplicationVariableValueEntity'],
  ],
  [
    'src/engine/core-modules/application/application-authorization/application-authorization.entity',
    ['ApplicationAuthorizationEntity'],
  ],
  [
    'src/engine/core-modules/application/application.entity',
    ['ApplicationEntity'],
  ],
  [
    'src/engine/core-modules/application/application-lookup/application-lookup.service',
    ['ApplicationLookupService'],
  ],
  [
    'src/engine/core-modules/application/application-manifest/application-manifest-migration.service',
    ['ApplicationManifestMigrationService'],
  ],
  [
    'src/engine/core-modules/application/application-manifest/services/application-uninstall.service',
    ['ApplicationUninstallService'],
  ],
  [
    'src/engine/core-modules/application/application-translation/application-translation-sync.service',
    ['ApplicationTranslationSyncService'],
  ],
  [
    'src/engine/core-modules/auth/token/services/application-token.service',
    ['ApplicationTokenService'],
  ],
  [
    'src/engine/core-modules/app-token/app-token.entity',
    ['AppTokenEntity', 'AppTokenType'],
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    ['UserWorkspaceEntity'],
  ],
  [
    'src/engine/core-modules/file-storage/services/file-storage.service',
    ['FileStorageService'],
  ],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  ['src/engine/core-modules/logger/logger.service', ['LoggerService']],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
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
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
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
    'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    ['WorkspaceMetadataVersionService'],
  ],
  [
    'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service',
    ['WorkspaceEventBroadcaster'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    ['WorkspaceMigrationValidateBuildAndRunService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    ['WorkspaceMigrationRunnerActionHandlerRegistryService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    ['DeferredWorkspaceMigrationActionRunnerService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    ['InFlightDeferredWorkspaceMigrationActionsService'],
  ],
  [
    'src/engine/core-modules/secret-encryption/secret-encryption.service',
    ['SecretEncryptionService'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  [
    'src/engine/core-modules/application/application-exception-filter',
    ['ApplicationExceptionFilter'],
  ],
  [
    'src/engine/core-modules/application/application-variable/application-variable-exception-filter',
    ['ApplicationVariableEntityExceptionFilter'],
  ],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  ['src/engine/guards/application-target.guard', ['ApplicationTargetGuard']],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, class {}])),
  );
}
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/settings-permission.guard', ['SettingsPermissionGuard']],
  ['src/engine/decorators/auth/auth-user.decorator', ['AuthUser']],
  ['src/engine/decorators/auth/auth-workspace.decorator', ['AuthWorkspace']],
  [
    'src/engine/decorators/auth/auth-user-workspace-id.decorator',
    ['AuthUserWorkspaceId'],
  ],
  [
    'src/engine/decorators/auth/auth-application.decorator',
    ['AuthApplication'],
  ],
  [
    'src/engine/decorators/auth/application-target-args.decorator',
    ['ApplicationTargetArgs'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((n) => [n, () => () => {}])),
  );
}

const { ApplicationAuthorizationResolver } =
  require('src/engine/core-modules/application/application-authorization/application-authorization.resolver') as typeof import('src/engine/core-modules/application/application-authorization/application-authorization.resolver');
const { ApplicationAuthorizationService } =
  require('src/engine/core-modules/application/application-authorization/services/application-authorization.service') as typeof import('src/engine/core-modules/application/application-authorization/services/application-authorization.service');
const { ApplicationSyncService } =
  require('src/engine/core-modules/application/application-manifest/application-sync.service') as typeof import('src/engine/core-modules/application/application-manifest/application-sync.service');
const { OAuthService } =
  require('src/engine/core-modules/application/application-oauth/oauth.service') as typeof import('src/engine/core-modules/application/application-oauth/oauth.service');
const { UserApplicationVariableValueResolver } =
  require('src/engine/core-modules/application/application-variable/user-application-variable-value.resolver') as typeof import('src/engine/core-modules/application/application-variable/user-application-variable-value.resolver');
const { UserApplicationVariableValueService } =
  require('src/engine/core-modules/application/application-variable/user-application-variable-value.service') as typeof import('src/engine/core-modules/application/application-variable/user-application-variable-value.service');
const { ApplicationEntity } =
  require('src/engine/core-modules/application/application.entity') as typeof import('src/engine/core-modules/application/application.entity');
const { ApplicationService } =
  require('src/engine/core-modules/application/application.service') as typeof import('src/engine/core-modules/application/application.service');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

jest.setTimeout(120000);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `app_auth_var_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorMemberId = randomUUID();
const secondUserId = randomUUID();
const secondUserWorkspaceId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();

const standardAppId = randomUUID();
const customAppId = randomUUID();
const customAppUniversalId = randomUUID();
const oauthAppId = randomUUID();
const oauthAppUniversalId = randomUUID();
const oauthAppRegistrationId = randomUUID();
const oauthClientId = `client-${randomUUID()}`;
const userVariableId = randomUUID();
const userVariableUniversalId = randomUUID();

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-app-auth-var-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 5, statement_timeout: 12000 },
});

type Row = Record<string, unknown> & { id: string };

const audits = (): Promise<Row[]> =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt",id',
  );

const userIdentity = (
  extra: Partial<RoleUpdateAuditIdentity> = {},
): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    user: { id: actorUserId },
    workspace: { id: workspaceId },
    userWorkspaceId: actorUserWorkspaceId,
    workspaceMemberId: actorMemberId,
  } as RoleUpdateAuditIdentity['auth'],
  ...extra,
});

const emptyMap = () => ({
  byId: {} as Record<string, Row>,
  idByUniversalIdentifier: {} as Record<string, string>,
  universalIdentifierById: {} as Record<string, string>,
  universalIdentifiersByApplicationId: {} as Record<string, string[]>,
  byUniversalIdentifier: {} as Record<string, Row>,
});

const addEntityToMap = (
  map: ReturnType<typeof emptyMap>,
  entity: Row & {
    universalIdentifier: string;
    applicationId: string;
    applicationUniversalIdentifier: string;
  },
) => {
  map.byId[entity.id] = entity;
  map.idByUniversalIdentifier[entity.universalIdentifier] = entity.id;
  map.universalIdentifierById[entity.id] = entity.universalIdentifier;
  map.byUniversalIdentifier[entity.universalIdentifier] = entity;
  const list =
    map.universalIdentifiersByApplicationId[entity.applicationId] ?? [];
  if (!list.includes(entity.universalIdentifier)) {
    list.push(entity.universalIdentifier);
  }
  map.universalIdentifiersByApplicationId[entity.applicationId] = list;
};

const loadAllMapsFromDb = async (wsId: string) => {
  const apps: Row[] = await owner.query(
    'SELECT * FROM core.application WHERE "workspaceId"=$1 AND "deletedAt" IS NULL ORDER BY id',
    [wsId],
  );
  const appUidById = new Map<string, string>(
    apps.map((a) => [a.id, String(a.universalIdentifier)]),
  );

  const flatApplicationMaps = emptyMap();
  for (const app of apps) {
    addEntityToMap(flatApplicationMaps, {
      ...app,
      universalIdentifier: String(app.universalIdentifier),
      applicationId: app.id,
      applicationUniversalIdentifier: String(app.universalIdentifier),
    });
  }

  const roles: Row[] = await owner.query(
    'SELECT * FROM core.role WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatRoleMaps = emptyMap();
  for (const role of roles) {
    addEntityToMap(flatRoleMaps, {
      ...role,
      universalIdentifier: String(role.universalIdentifier),
      applicationId: String(role.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(role.applicationId),
      )!,
      roleTargetIds: [],
      rowLevelPermissionPredicateIds: [],
      rowLevelPermissionPredicateGroupIds: [],
      objectPermissionIds: [],
      fieldPermissionIds: [],
      permissionFlagIds: [],
    });
  }

  const vars: Row[] = await owner.query(
    'SELECT * FROM core."applicationVariable" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatApplicationVariableMaps = emptyMap();
  for (const v of vars) {
    addEntityToMap(flatApplicationVariableMaps, {
      ...v,
      universalIdentifier: String(v.universalIdentifier),
      applicationId: String(v.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(v.applicationId))!,
    });
  }

  const base: Record<string, unknown> = {
    flatApplicationMaps,
    flatRoleMaps,
    flatApplicationVariableMaps,
    featureFlagsMap: {},
    billingEntitlements: {},
  };
  for (const metadataName of Object.values(ALL_METADATA_NAME)) {
    const key = getMetadataFlatEntityMapsKey(metadataName);
    if (!(key in base)) {
      base[key] = emptyMap();
    }
  }
  return base;
};

const buildHarness = () => {
  const workspaceCacheService = {
    invalidateAndRecompute: jest.fn(async () => {}),
    getOrRecompute: jest.fn(async (wsId: string) => loadAllMapsFromDb(wsId)),
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(
      async ({ workspaceId: wsId }: { workspaceId: string }) =>
        loadAllMapsFromDb(wsId),
    ),
    invalidateFlatEntityMaps: jest.fn(async () => {}),
  };

  const executeSqlAction = async (
    action: {
      type: 'create' | 'update' | 'delete';
      metadataName: string;
      universalIdentifier?: string;
    },
    context: {
      allFlatEntityMaps: Record<string, ReturnType<typeof emptyMap>>;
      queryRunner: QueryRunner;
      workspaceId: string;
    },
  ) => {
    const { queryRunner: qr, workspaceId: wsId, allFlatEntityMaps } = context;
    const resolveId = (mapsKey: string, uid: unknown): string | null => {
      if (!isDefined(uid)) return null;
      return (
        allFlatEntityMaps[mapsKey]?.idByUniversalIdentifier[String(uid)] ?? null
      );
    };
    if (action.metadataName === 'role' && action.type === 'delete') {
      const id = resolveId('flatRoleMaps', action.universalIdentifier)!;
      await qr.query('DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2', [
        id,
        wsId,
      ]);
    } else if (
      action.metadataName === 'applicationVariable' &&
      action.type === 'delete'
    ) {
      const id = resolveId(
        'flatApplicationVariableMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."applicationVariable" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    }
  };

  const actionHandlerRegistry = {
    executeActionHandler: jest.fn(async ({ action, context }) => {
      await executeSqlAction(action, context);
      return {
        partialOptimisticCache: {},
        metadataEvents: [],
        deferredActions: [],
      };
    }),
    executeActionRollbackHandler: jest.fn(async () => {}),
  };

  const runnerService = new WorkspaceMigrationRunnerService(
    flatEntityMapsCacheService as never,
    runtime,
    actionHandlerRegistry as never,
    { incrementMetadataVersion: jest.fn(async () => {}) } as never,
    workspaceCacheService as never,
    { recordHistogram: jest.fn() } as never,
    {
      perfTime: jest.fn(),
      perfTimeEnd: jest.fn(),
      perf: jest.fn(),
      error: jest.fn(),
    } as never,
    { get: jest.fn(() => false) } as never,
    { getWorkspaceFeatureFlagsMap: jest.fn(async () => ({})) } as never,
    {
      persist: jest.fn(async () => {}),
      dispatchAfterCommit: jest.fn(async () => {}),
    } as never,
    {
      throwIfSchemaAffectingActionsAreInProgress: jest.fn(async () => {}),
    } as never,
  );

  const workspaceMigrationValidateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigrationFromRecord: jest.fn(
      async ({
        allFlatEntityOperationRecordByMetadataName,
        workspaceId: wsId,
        applicationUniversalIdentifier,
      }: {
        allFlatEntityOperationRecordByMetadataName: Record<
          string,
          | {
              flatEntityToCreate: Record<string, Record<string, unknown>>;
              flatEntityToUpdate: Record<string, Record<string, unknown>>;
              flatEntityToDelete: Record<string, Record<string, unknown>>;
            }
          | undefined
        >;
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const actions: Array<Record<string, unknown>> = [];
        for (const metadataName of ['role', 'applicationVariable'] as const) {
          for (const entity of Object.values(
            allFlatEntityOperationRecordByMetadataName[metadataName]
              ?.flatEntityToDelete ?? {},
          )) {
            actions.push({
              type: 'delete',
              metadataName,
              universalIdentifier: entity.universalIdentifier,
            });
          }
        }
        await runnerService.run({
          workspaceId: wsId,
          workspaceMigration: {
            actions,
            applicationUniversalIdentifier,
          } as never,
        });
        return {
          status: 'success' as const,
          workspaceMigration: { actions, applicationUniversalIdentifier },
          hasSchemaMetadataChanged: false,
        };
      },
    ),
  };

  const applicationAuthorizationRepository = {
    manager: { connection: runtime },
    findOneBy: jest.fn(
      async ({
        userId,
        applicationId,
      }: {
        userId: string;
        applicationId: string;
      }) => {
        const rows = await owner.query(
          'SELECT * FROM core."applicationAuthorization" WHERE "userId"=$1 AND "applicationId"=$2',
          [userId, applicationId],
        );
        return rows[0] ?? null;
      },
    ),
    update: jest.fn(
      async (criteria: { id: string }, partial: { lastUsedAt: Date }) => {
        await owner.query(
          'UPDATE core."applicationAuthorization" SET "lastUsedAt"=$1, "updatedAt"=now() WHERE id=$2',
          [partial.lastUsedAt, criteria.id],
        );
      },
    ),
  };

  const applicationAuthorizationService = new ApplicationAuthorizationService(
    applicationAuthorizationRepository as never,
    runtime,
  );
  const applicationAuthorizationResolver = new ApplicationAuthorizationResolver(
    applicationAuthorizationService,
  );

  const secretEncryptionService = {
    encryptVersioned: jest.fn(
      (val: PlaintextString) =>
        `enc:v2:${Buffer.from(String(val)).toString('base64')}` as EncryptedString,
    ),
    decryptVersionedOrThrow: jest.fn(
      (val: EncryptedString) =>
        Buffer.from(String(val).replace(/^enc:v2:/, ''), 'base64').toString(
          'utf8',
        ) as PlaintextString,
    ),
  };

  const applicationVariableService = {
    findFlatApplicationVariables: jest.fn(
      async ({
        workspaceId: wsId,
        applicationId: appId,
      }: {
        workspaceId: string;
        applicationId: string;
      }) => {
        const maps = await loadAllMapsFromDb(wsId);
        const flatVars = (
          maps.flatApplicationVariableMaps as ReturnType<typeof emptyMap>
        ).byUniversalIdentifier;
        return Object.values(flatVars).filter(
          (v) => String(v.applicationId) === appId,
        );
      },
    ),
    getDisplayValue: jest.fn(({ value }: { value: string }) => value),
  };

  const userApplicationVariableValueService =
    new UserApplicationVariableValueService(
      { manager: { connection: runtime } } as never,
      {} as never,
      applicationVariableService as never,
      workspaceCacheService as never,
      secretEncryptionService as never,
      runtime,
    );
  const userApplicationVariableValueResolver =
    new UserApplicationVariableValueResolver(
      userApplicationVariableValueService,
    );

  const fileStorageService = {
    deleteApplicationFileRows: jest.fn(async () => {}),
    invalidateStorageStock: jest.fn(async () => {}),
    deleteApplicationFilesFromStorage: jest.fn(async () => {}),
  };
  const workspaceEventBroadcaster = {
    broadcast: jest.fn(async () => {}),
  };

  const applicationLookupService = {
    findByUniversalIdentifier: jest.fn(
      async ({
        universalIdentifier,
        workspaceId: wsId,
      }: {
        universalIdentifier: string;
        workspaceId: string;
      }) => {
        const rows = await owner.query(
          'SELECT * FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
          [universalIdentifier, wsId],
        );
        return rows[0] ?? null;
      },
    ),
  };

  const applicationService = Object.assign(
    Object.create(ApplicationService.prototype),
    {
      coreDataSource: runtime,
      applicationLookupService,
      fileStorageService,
      workspaceCacheService,
      workspaceEventBroadcaster,
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
      findOneApplicationWithRelationsOrThrow: jest.fn(
        async ({
          universalIdentifier,
          workspaceId: wsId,
        }: {
          universalIdentifier: string;
          workspaceId: string;
        }) => {
          const app = await applicationLookupService.findByUniversalIdentifier({
            universalIdentifier,
            workspaceId: wsId,
          });
          if (!app) {
            throw new Error('Application not found');
          }
          return app;
        },
      ),
    },
  ) as InstanceType<typeof ApplicationService>;

  const origManager = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const qr = origManager(mode);
    const origUpdate = qr.manager.update.bind(qr.manager);
    const origDelete = qr.manager.delete.bind(qr.manager);
    qr.manager.update = (async (
      target: unknown,
      criteria: Record<string, unknown>,
      partial: Record<string, unknown>,
    ) => {
      if (target === ApplicationEntity) {
        return qr.query(
          'UPDATE core.application SET "packageJsonFileId"=$1, "yarnLockFileId"=$2, "updatedAt"=now() WHERE id=$3',
          [
            partial.packageJsonFileId ?? null,
            partial.yarnLockFileId ?? null,
            criteria.id,
          ],
        );
      }
      return origUpdate(target as never, criteria, partial);
    }) as typeof qr.manager.update;
    qr.manager.delete = (async (
      target: unknown,
      criteria: Record<string, unknown>,
    ) => {
      if (target === ApplicationEntity) {
        return qr.query(
          'DELETE FROM core.application WHERE "universalIdentifier"=$1 AND "workspaceId"=$2',
          [criteria.universalIdentifier, criteria.workspaceId],
        );
      }
      return origDelete(target as never, criteria);
    }) as typeof qr.manager.delete;
    return qr;
  });

  const applicationSyncService = Object.assign(
    Object.create(ApplicationSyncService.prototype),
    {
      applicationService,
      applicationLookupService,
      workspaceMigrationValidateBuildAndRunService,
      workspaceCacheService,
      fileStorageService,
      applicationUninstallService: {
        runUninstallHookBestEffort: jest.fn(async () => {}),
      },
      cleanupApplicationRuntimeResources: jest.fn(async () => {}),
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    },
  ) as InstanceType<typeof ApplicationSyncService>;

  const verifier = 'pkce-verifier-log167-secret-value';
  const codeChallenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');
  const authCodeToken = {
    id: randomUUID(),
    userId: actorUserId,
    workspaceId,
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 300_000),
    context: {
      clientId: oauthClientId,
      redirectUri: 'https://example.com/oauth/callback',
      scope: 'read:crm write:crm',
      codeChallenge,
      codeChallengeMethod: 'S256',
      auditIdentity: {
        workspaceId,
        actor: { kind: 'coreUser' as const, id: actorUserId },
        initiator: { kind: 'coreUser' as const, id: impersonatorUserId },
        correlationId: randomUUID(),
      },
    },
  };

  const oauthRegistration = {
    id: oauthAppRegistrationId,
    name: 'OAuth Integration App',
    universalIdentifier: oauthAppUniversalId,
    sourceType: ApplicationRegistrationSourceType.OAUTH_ONLY,
    oAuthClientId: oauthClientId,
    oAuthClientSecretHash: null,
    oAuthRedirectUris: ['https://example.com/oauth/callback'],
    oAuthScopes: ['read:crm', 'write:crm'],
  };

  const oauthService = Object.assign(Object.create(OAuthService.prototype), {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    appTokenRepository: {
      findOne: jest.fn(async () => authCodeToken),
      update: jest.fn(async () => ({ affected: 1 })),
    },
    applicationRepository: {
      findOne: jest.fn(
        async (
          wsId: string,
          opts: { where: { id?: string; applicationRegistrationId?: string } },
        ) => {
          if (opts.where.id) {
            const rows = await owner.query(
              'SELECT * FROM core.application WHERE id=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
              [opts.where.id, wsId],
            );
            return rows[0] ?? null;
          }
          const rows = await owner.query(
            'SELECT * FROM core.application WHERE "applicationRegistrationId"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
            [opts.where.applicationRegistrationId, wsId],
          );
          return rows[0] ?? null;
        },
      ),
    },
    userWorkspaceRepository: {
      findOne: jest.fn(
        async ({
          where: { userId, workspaceId: wsId },
        }: {
          where: { userId: string; workspaceId: string };
        }) => {
          const rows = await owner.query(
            'SELECT * FROM core."userWorkspace" WHERE "userId"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
            [userId, wsId],
          );
          return rows[0] ?? null;
        },
      ),
    },
    applicationRegistrationService: {
      findOneByClientId: jest.fn(async (cId: string) =>
        cId === oauthClientId ? oauthRegistration : null,
      ),
      verifyClientSecret: jest.fn(async () => true),
    },
    applicationInstallService: {
      installApplication: jest.fn(async () => true),
    },
    applicationService,
    applicationAuthorizationService,
    applicationTokenService: {
      generateApplicationTokenPair: jest.fn(async () => ({
        applicationAccessToken: { token: 'issued-access-token' },
        applicationRefreshToken: { token: 'issued-refresh-token' },
      })),
      validateApplicationRefreshToken: jest.fn(async (tok: string) => {
        if (tok === 'refresh-second-user') {
          return {
            userId: secondUserId,
            workspaceId,
            applicationId: oauthAppId,
            userWorkspaceId: secondUserWorkspaceId,
          };
        }
        if (tok === 'refresh-actor-user') {
          return {
            userId: actorUserId,
            workspaceId,
            applicationId: oauthAppId,
            userWorkspaceId: actorUserWorkspaceId,
          };
        }
        throw new Error('Invalid refresh token');
      }),
      renewApplicationTokens: jest.fn(async () => ({
        applicationAccessToken: { token: 'renewed-access-token' },
        applicationRefreshToken: { token: 'renewed-refresh-token' },
      })),
    },
    twentyConfigService: { get: jest.fn(() => '1h') },
  }) as InstanceType<typeof OAuthService>;

  return {
    runnerService,
    actionHandlerRegistry,
    workspaceCacheService,
    applicationAuthorizationService,
    applicationAuthorizationResolver,
    userApplicationVariableValueService,
    userApplicationVariableValueResolver,
    applicationService,
    applicationSyncService,
    fileStorageService,
    workspaceEventBroadcaster,
    oauthService,
    verifier,
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
      "defaultRoleId" uuid NULL,
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.application (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL DEFAULT 'App',
      "applicationRegistrationId" uuid NULL,
      "canBeUninstalled" boolean NOT NULL DEFAULT true,
      "packageJsonFileId" uuid NULL,
      "yarnLockFileId" uuid NULL,
      "defaultRoleId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL,
      UNIQUE ("workspaceId", "universalIdentifier")
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "userId" uuid NOT NULL,
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.role (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      label text NOT NULL,
      description text NULL,
      icon text NULL,
      "canUpdateAllSettings" boolean NOT NULL DEFAULT false,
      "canAccessAllTools" boolean NOT NULL DEFAULT false,
      "canAccessAllAgentChatChannels" boolean NOT NULL DEFAULT false,
      "canReadAllObjectRecords" boolean NOT NULL DEFAULT true,
      "canUpdateAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canSoftDeleteAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canDestroyAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canBeAssignedToUsers" boolean NOT NULL DEFAULT true,
      "canBeAssignedToAgents" boolean NOT NULL DEFAULT true,
      "canBeAssignedToApiKeys" boolean NOT NULL DEFAULT true,
      "isEditable" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("workspaceId", "universalIdentifier")
    );
    CREATE TABLE core."applicationAuthorization" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" uuid NOT NULL,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "userWorkspaceId" uuid NOT NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
      scopes text[] NULL,
      "lastAuthorizedAt" timestamptz NULL,
      "lastUsedAt" timestamptz NOT NULL,
      "revokedAt" timestamptz NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("userId", "applicationId")
    );
    CREATE TABLE core."applicationVariable" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      key text NOT NULL,
      value text NULL,
      scope text NOT NULL DEFAULT 'USER',
      "isSecret" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, scope),
      UNIQUE ("workspaceId", "universalIdentifier")
    );
    CREATE TABLE core."userApplicationVariableValue" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
      "applicationVariableId" uuid NOT NULL,
      "userWorkspaceId" uuid NOT NULL REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
      scope text NOT NULL DEFAULT 'USER',
      value text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("applicationVariableId", "userWorkspaceId"),
      FOREIGN KEY ("applicationVariableId", scope) REFERENCES core."applicationVariable"(id, scope) ON DELETE CASCADE ON UPDATE NO ACTION
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
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-app-auth-var-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
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
      core."userApplicationVariableValue",
      core."applicationVariable",
      core."applicationAuthorization",
      core.role,
      core.application,
      core."userWorkspace",
      crm_audit."crmAuditEntry"`,
  );
  await owner.query(
    'UPDATE core.workspace SET "defaultRoleId"=NULL, "deletedAt"=NULL WHERE id IN ($1, $2)',
    [workspaceId, foreignWorkspaceId],
  );
  await owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name, "applicationRegistrationId", "canBeUninstalled") VALUES
      ($1, $2, $3, 'Twenty Standard', NULL, false),
      ($4, $2, $5, 'Workspace Custom', NULL, false),
      ($6, $2, $7, 'OAuth Integration App', $8, true)`,
    [
      standardAppId,
      workspaceId,
      TWENTY_STANDARD_APPLICATION.universalIdentifier,
      customAppId,
      customAppUniversalId,
      oauthAppId,
      oauthAppUniversalId,
      oauthAppRegistrationId,
    ],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt") VALUES
      ($1, $2, $3, NULL),
      ($4, $2, $5, NULL),
      ($6, $2, $7, NULL)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      secondUserWorkspaceId,
      secondUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await owner.query(
    `INSERT INTO core."applicationVariable" (id, "workspaceId", "applicationId", "universalIdentifier", key, value, scope, "isSecret")
     VALUES ($1, $2, $3, $4, 'PERSONAL_API_TOKEN', NULL, 'USER', true)`,
    [userVariableId, workspaceId, oauthAppId, userVariableUniversalId],
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

describe('ApplicationAuthorization and UserApplicationVariableValue lifecycle & cascade CRM audit (LOG167)', () => {
  it('audits applicationAuthorization create, same-millisecond re-consent update, refresh-token backfill, resolver revocation, and OAuth token revocation with redacted scopes', async () => {
    const {
      oauthService,
      applicationAuthorizationService,
      applicationAuthorizationResolver,
      verifier,
    } = buildHarness();

    // 1. OAuth authorization code exchange -> recordAuthorization (create)
    const tokenRes = await oauthService.exchangeAuthorizationCode({
      authorizationCode: 'auth-code-1',
      clientId: oauthClientId,
      redirectUri: 'https://example.com/oauth/callback',
      codeVerifier: verifier,
    });
    expect('access_token' in tokenRes && tokenRes.access_token).toBe(
      'issued-access-token',
    );

    let entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'applicationAuthorization',
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        values: {
          userId: { before: null, after: actorUserId },
          userWorkspaceId: { before: null, after: actorUserWorkspaceId },
          applicationId: { before: null, after: oauthAppId },
        },
      },
    });
    expect(
      (entries[0].redactedDiff as { changedFields: string[] }).changedFields,
    ).toEqual(
      expect.arrayContaining([
        'applicationId',
        'lastAuthorizedAt',
        'lastUsedAt',
        'scopes',
        'userId',
        'userWorkspaceId',
      ]),
    );
    expect(JSON.stringify(entries[0].redactedDiff)).not.toContain('read:crm');

    const grantId = String(entries[0].resourceId);

    // 2. Back-to-back same-millisecond recordAuthorization with identical scopes still advances timestamps and records update (T1)
    await applicationAuthorizationService.recordAuthorization({
      userId: actorUserId,
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      applicationId: oauthAppId,
      scopes: ['read:crm', 'write:crm'],
      auditIdentity: userIdentity(),
    });
    entries = await audits();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      resourceKind: 'applicationAuthorization',
      resourceId: grantId,
      action: 'update',
      actor: { kind: 'workspaceMember', id: actorMemberId },
    });
    expect(
      (entries[1].redactedDiff as { changedFields: string[] }).changedFields,
    ).toEqual(expect.arrayContaining(['lastAuthorizedAt', 'lastUsedAt']));

    // 3. Resolver revokeApplicationAuthorization -> update (revokedAt)
    const revoked =
      await applicationAuthorizationResolver.revokeApplicationAuthorization(
        { id: actorUserId } as never,
        { id: workspaceId } as never,
        grantId,
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: actorUserId },
            userWorkspaceId: actorUserWorkspaceId,
            impersonationContext: { impersonatorUserWorkspaceId },
          },
        },
      );
    expect(revoked).toBe(true);

    // Repeated revoke returns false and writes 0 new audit entries
    const revokedAgain =
      await applicationAuthorizationResolver.revokeApplicationAuthorization(
        { id: actorUserId } as never,
        { id: workspaceId } as never,
        grantId,
        {
          req: {
            workspace: { id: workspaceId },
            user: { id: actorUserId },
          },
        },
      );
    expect(revokedAgain).toBe(false);

    entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      resourceKind: 'applicationAuthorization',
      resourceId: grantId,
      action: 'update',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      redactedDiff: {
        changedFields: ['revokedAt'],
        values: {},
      },
    });

    // 4. Refresh token grant for pre-table token -> backfillAuthorizationFromRefreshToken (create), then second refresh -> touchLastUsedAt (0 audit entries)
    const refreshOne = await oauthService.refreshTokenGrant({
      refreshToken: 'refresh-second-user',
      clientId: oauthClientId,
    });
    expect('access_token' in refreshOne && refreshOne.access_token).toBe(
      'renewed-access-token',
    );
    const refreshTwo = await oauthService.refreshTokenGrant({
      refreshToken: 'refresh-second-user',
      clientId: oauthClientId,
    });
    expect('access_token' in refreshTwo && refreshTwo.access_token).toBe(
      'renewed-access-token',
    );

    entries = await audits();
    expect(entries).toHaveLength(4);
    expect(entries[3]).toMatchObject({
      resourceKind: 'applicationAuthorization',
      action: 'create',
      actor: { kind: 'coreUser', id: secondUserId },
      redactedDiff: {
        values: {
          userId: { before: null, after: secondUserId },
          userWorkspaceId: { before: null, after: secondUserWorkspaceId },
          applicationId: { before: null, after: oauthAppId },
        },
      },
    });

    // 5. OAuth /oauth/revoke on a pre-table refresh token -> backfill (create) + revoke (update) with shared correlationId
    await owner.query(
      'DELETE FROM core."applicationAuthorization" WHERE "userId"=$1 AND "applicationId"=$2',
      [secondUserId, oauthAppId],
    );
    await oauthService.revokeToken({
      token: 'refresh-second-user',
      clientId: oauthClientId,
    });

    entries = await audits();
    expect(entries).toHaveLength(6);
    expect(entries[4].action).toBe('create');
    expect(entries[5].action).toBe('update');
    expect(entries[4].resourceId).toBe(entries[5].resourceId);
    expect(entries[4].correlationId).toBeDefined();
    expect(entries[4].correlationId).toBe(entries[5].correlationId);
    expect(entries[4].operationId).not.toBe(entries[5].operationId);
  });

  it('audits applicationAuthorization ON DELETE CASCADE in ApplicationSyncService.uninstallApplication and ApplicationService.delete and blocks unauthenticated delete when grants exist', async () => {
    const {
      applicationAuthorizationService,
      applicationService,
      applicationSyncService,
    } = buildHarness();

    await applicationAuthorizationService.recordAuthorization({
      userId: actorUserId,
      workspaceId,
      userWorkspaceId: actorUserWorkspaceId,
      applicationId: oauthAppId,
      scopes: ['read:crm'],
      auditIdentity: userIdentity(),
    });
    await applicationAuthorizationService.recordAuthorization({
      userId: secondUserId,
      workspaceId,
      userWorkspaceId: secondUserWorkspaceId,
      applicationId: oauthAppId,
      scopes: ['write:crm'],
      auditIdentity: userIdentity(),
    });
    const appRoleId = randomUUID();
    const appRoleUid = randomUUID();
    await owner.query(
      `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label)
       VALUES ($1, $2, $3, $4, 'OAuth App Role')`,
      [appRoleId, workspaceId, oauthAppId, appRoleUid],
    );
    await owner.query('DELETE FROM core."applicationVariable" WHERE id=$1', [
      userVariableId,
    ]);
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    // Unauthenticated direct ApplicationService.delete fails closed when role/permission metadata remains
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // Even if role/permission metadata is absent, unauthenticated direct ApplicationService.delete fails closed when applicationAuthorization rows exist
    await owner.query('DELETE FROM core.role WHERE id=$1', [appRoleId]);
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId),
    ).rejects.toThrow(
      'Application authorization mutation requires authenticated audit identity',
    );
    expect(
      await owner.query(
        'SELECT id FROM core."applicationAuthorization" WHERE "applicationId"=$1',
        [oauthAppId],
      ),
    ).toHaveLength(2);

    // Re-insert role and run full ApplicationSyncService.uninstallApplication with explicit auditIdentity (no ambient ALS - M1)
    await owner.query(
      `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label)
       VALUES ($1, $2, $3, $4, 'OAuth App Role')`,
      [appRoleId, workspaceId, oauthAppId, appRoleUid],
    );

    await applicationSyncService.uninstallApplication({
      workspaceId,
      applicationUniversalIdentifier: oauthAppUniversalId,
      auditIdentity: userIdentity({
        impersonatorUserWorkspaceId,
      }),
    });

    expect(
      await owner.query('SELECT id FROM core.application WHERE id=$1', [
        oauthAppId,
      ]),
    ).toHaveLength(0);
    expect(
      await owner.query(
        'SELECT id FROM core."applicationAuthorization" WHERE "applicationId"=$1',
        [oauthAppId],
      ),
    ).toHaveLength(0);

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => `${e.resourceKind}:${e.action}`).sort()).toEqual([
      'applicationAuthorization:delete',
      'applicationAuthorization:delete',
      'role:delete',
    ]);
    for (const entry of entries) {
      expect(entry.actor).toEqual({
        kind: 'workspaceMember',
        id: actorMemberId,
      });
      expect(entry.initiator).toEqual({
        kind: 'coreUser',
        id: impersonatorUserId,
      });
    }
    const authDeleteOpIds = new Set(
      entries
        .filter((e) => e.resourceKind === 'applicationAuthorization')
        .map((e) => e.operationId),
    );
    expect(authDeleteOpIds.size).toBe(1);
    const roleDeleteEntry = entries.find((e) => e.resourceKind === 'role')!;
    expect(authDeleteOpIds.has(roleDeleteEntry.operationId)).toBe(false);
  });

  it('audits userApplicationVariableValue create, update, and delete on UserApplicationVariableValueResolver.updateMyUserApplicationVariable with redacted secret value', async () => {
    const { userApplicationVariableValueResolver, workspaceCacheService } =
      buildHarness();

    const reqContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
        impersonationContext: { impersonatorUserWorkspaceId },
      },
    };

    // 1. Create secret user variable value
    await userApplicationVariableValueResolver.updateMyUserApplicationVariable(
      {
        applicationUniversalIdentifier: oauthAppUniversalId,
        key: 'PERSONAL_API_TOKEN',
        value: 'super-secret-token-v1' as PlaintextString,
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      reqContext,
    );

    // 2. Update secret user variable value
    await userApplicationVariableValueResolver.updateMyUserApplicationVariable(
      {
        applicationUniversalIdentifier: oauthAppUniversalId,
        key: 'PERSONAL_API_TOKEN',
        value: 'super-secret-token-v2' as PlaintextString,
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      reqContext,
    );

    // 3. Delete secret user variable value with empty string (and repeat empty string for no-op)
    await userApplicationVariableValueResolver.updateMyUserApplicationVariable(
      {
        applicationUniversalIdentifier: oauthAppUniversalId,
        key: 'PERSONAL_API_TOKEN',
        value: '' as PlaintextString,
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      reqContext,
    );
    await userApplicationVariableValueResolver.updateMyUserApplicationVariable(
      {
        applicationUniversalIdentifier: oauthAppUniversalId,
        key: 'PERSONAL_API_TOKEN',
        value: '' as PlaintextString,
      },
      { id: workspaceId } as never,
      actorUserWorkspaceId,
      reqContext,
    );

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => `${e.resourceKind}:${e.action}`)).toEqual([
      'userApplicationVariableValue:create',
      'userApplicationVariableValue:update',
      'userApplicationVariableValue:delete',
    ]);
    for (const entry of entries) {
      expect(entry.actor).toEqual({
        kind: 'workspaceMember',
        id: actorMemberId,
      });
      expect(entry.initiator).toEqual({
        kind: 'coreUser',
        id: impersonatorUserId,
      });
      const serialized = JSON.stringify(entry.redactedDiff);
      expect(serialized).not.toContain('super-secret-token-v1');
      expect(serialized).not.toContain('super-secret-token-v2');
      expect(serialized).not.toContain('enc:v2:');
    }
    expect(entries[0].redactedDiff).toEqual({
      changedFields: [
        'applicationVariableId',
        'scope',
        'userWorkspaceId',
        'value',
      ],
      values: {
        applicationVariableId: { before: null, after: userVariableId },
        scope: { before: null, after: 'USER' },
        userWorkspaceId: { before: null, after: actorUserWorkspaceId },
      },
    });
    expect(entries[1].redactedDiff).toEqual({
      changedFields: ['value'],
      values: {},
    });
    expect(entries[2].redactedDiff).toEqual({
      changedFields: [
        'applicationVariableId',
        'scope',
        'userWorkspaceId',
        'value',
      ],
      values: {
        applicationVariableId: { before: userVariableId, after: null },
        scope: { before: 'USER', after: null },
        userWorkspaceId: { before: actorUserWorkspaceId, after: null },
      },
    });
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['userApplicationVariableValueMaps'],
    );
  });

  it('audits userApplicationVariableValue ON DELETE CASCADE when applicationVariable is deleted in runAuditedApplicationMetadataMigration and blocks direct ApplicationService.delete while variable values remain', async () => {
    const {
      runnerService,
      applicationService,
      userApplicationVariableValueService,
      workspaceCacheService,
    } = buildHarness();

    await userApplicationVariableValueService.updateMyUserApplicationVariable({
      workspaceId,
      applicationUniversalIdentifier: oauthAppUniversalId,
      userWorkspaceId: actorUserWorkspaceId,
      key: 'PERSONAL_API_TOKEN',
      plainTextValue: 'member-1-secret' as PlaintextString,
      auditIdentity: userIdentity(),
    });
    await userApplicationVariableValueService.updateMyUserApplicationVariable({
      workspaceId,
      applicationUniversalIdentifier: oauthAppUniversalId,
      userWorkspaceId: secondUserWorkspaceId,
      key: 'PERSONAL_API_TOKEN',
      plainTextValue: 'member-2-secret' as PlaintextString,
      auditIdentity: {
        workspaceId,
        actor: { kind: 'coreUser', id: secondUserId },
      },
    });
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');

    // Direct ApplicationService.delete is blocked while userApplicationVariableValue rows remain
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId, {
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Application delete requires prior audited removal of role and permission metadata',
    );

    // Unaudited runner delete on applicationVariable fails closed
    await expect(
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: oauthAppUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'applicationVariable',
              universalIdentifier: userVariableUniversalId,
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    workspaceCacheService.invalidateAndRecompute.mockClear();

    const op = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: userIdentity(),
      mode: 'manifest',
    });
    const req = bindApplicationMetadataAuditOperation(op, {
      applicationId: oauthAppId,
      applicationUniversalIdentifier: oauthAppUniversalId,
    });

    await withApplicationMetadataAudit(req, () =>
      runnerService.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: oauthAppUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'applicationVariable',
              universalIdentifier: userVariableUniversalId,
            },
          ],
        } as never,
      }),
    );

    const entries = await audits();
    expect(entries).toHaveLength(2);
    const opIds = new Set(entries.map((e) => e.operationId));
    expect(opIds.size).toBe(1);
    for (const entry of entries) {
      expect(entry.resourceKind).toBe('userApplicationVariableValue');
      expect(entry.action).toBe('delete');
      expect(JSON.stringify(entry.redactedDiff)).not.toContain('secret');
    }
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining(['userApplicationVariableValueMaps']),
    );
  });

  it('enforces fail-closed invariants on unauthenticated callers, cross-workspace FK rows (M3), and actor/userWorkspace mismatch (M4)', async () => {
    const {
      applicationAuthorizationService,
      userApplicationVariableValueService,
      applicationService,
    } = buildHarness();

    await expect(
      applicationAuthorizationService.recordAuthorization({
        userId: actorUserId,
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        applicationId: oauthAppId,
        scopes: ['read:crm'],
      }),
    ).rejects.toThrow(
      'Application authorization mutation requires authenticated audit identity',
    );

    await expect(
      applicationAuthorizationService.backfillAuthorizationFromRefreshToken({
        userId: actorUserId,
        workspaceId,
        userWorkspaceId: actorUserWorkspaceId,
        applicationId: oauthAppId,
      }),
    ).rejects.toThrow(
      'Application authorization mutation requires authenticated audit identity',
    );

    await expect(
      applicationAuthorizationService.revokeAuthorizationByIdForUserWorkspace({
        authorizationId: randomUUID(),
        userId: actorUserId,
        workspaceId,
      }),
    ).rejects.toThrow(
      'Application authorization mutation requires authenticated audit identity',
    );

    await expect(
      applicationAuthorizationService.revokeAuthorizationForApplication({
        userId: actorUserId,
        applicationId: oauthAppId,
      }),
    ).rejects.toThrow(
      'Application authorization mutation requires authenticated audit identity',
    );

    await expect(
      userApplicationVariableValueService.updateMyUserApplicationVariable({
        workspaceId,
        applicationUniversalIdentifier: oauthAppUniversalId,
        userWorkspaceId: actorUserWorkspaceId,
        key: 'PERSONAL_API_TOKEN',
        plainTextValue: 'val' as PlaintextString,
      }),
    ).rejects.toThrow(
      'User application variable value mutation requires authenticated audit identity',
    );

    // Actor userId mismatch with target userWorkspaceId is rejected (M4)
    await expect(
      userApplicationVariableValueService.updateMyUserApplicationVariable({
        workspaceId,
        applicationUniversalIdentifier: oauthAppUniversalId,
        userWorkspaceId: secondUserWorkspaceId,
        key: 'PERSONAL_API_TOKEN',
        plainTextValue: 'val' as PlaintextString,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'User application variable value audit actor mismatch with userWorkspace',
    );

    // Cross-workspace applicationAuthorization row is rejected on ApplicationService.delete (M3)
    const crossAuthId = randomUUID();
    await owner.query(
      `INSERT INTO core."applicationAuthorization" (id, "userId", "workspaceId", "applicationId", "userWorkspaceId", "lastUsedAt")
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        crossAuthId,
        actorUserId,
        foreignWorkspaceId,
        oauthAppId,
        actorUserWorkspaceId,
      ],
    );
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId, {
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Application delete audit detected cross-workspace applicationAuthorization',
    );
    await owner.query(
      'DELETE FROM core."applicationAuthorization" WHERE id=$1',
      [crossAuthId],
    );

    expect(await audits()).toHaveLength(0);
  });

  it('propagates NativeTransactionOutcomeUnknownError and CoreAuditPostCommitError across OAuthService, UserApplicationVariableValueService, and ApplicationService.delete while suppressing post-delete side effects (M5, T2)', async () => {
    const {
      oauthService,
      userApplicationVariableValueService,
      applicationService,
      workspaceCacheService,
      fileStorageService,
      workspaceEventBroadcaster,
    } = buildHarness();

    const origCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const injectCommitFailure = () => {
      jest
        .spyOn(runtime, 'createQueryRunner')
        .mockImplementationOnce((mode) => {
          const qr = origCreateQueryRunner(mode);
          const origConnect = qr.connect.bind(qr);
          jest.spyOn(qr, 'connect').mockImplementationOnce(async () => {
            const client = await origConnect();
            const origClientQuery = client.query.bind(client);
            const querySpy = jest
              .spyOn(client, 'query')
              .mockImplementation((...args: unknown[]) => {
                if (args[0] === 'COMMIT') {
                  querySpy.mockRestore();
                  return Promise.reject(
                    new Error('connection terminated during COMMIT'),
                  );
                }
                return (origClientQuery as (...a: unknown[]) => unknown)(
                  ...args,
                );
              });
            return client;
          });
          return qr;
        });
    };

    const injectPostCommitFailure = () => {
      jest
        .spyOn(runtime, 'createQueryRunner')
        .mockImplementationOnce((mode) => {
          const qr = origCreateQueryRunner(mode);
          const origCommit = qr.commitTransaction.bind(qr);
          jest
            .spyOn(qr, 'commitTransaction')
            .mockImplementationOnce(async () => {
              await origCommit();
              throw new Error('post-commit failure');
            });
          return qr;
        });
    };

    // 1. OAuthService.refreshTokenGrant and OAuthService.revokeToken propagate NativeTransactionOutcomeUnknownError
    injectCommitFailure();
    await expect(
      oauthService.refreshTokenGrant({
        refreshToken: 'refresh-second-user',
        clientId: oauthClientId,
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);

    injectPostCommitFailure();
    await expect(
      oauthService.revokeToken({
        token: 'refresh-second-user',
        clientId: oauthClientId,
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);

    // 2. UserApplicationVariableValueService invalidates cache on NativeTransactionOutcomeUnknownError
    workspaceCacheService.invalidateAndRecompute.mockClear();
    injectCommitFailure();
    await expect(
      userApplicationVariableValueService.updateMyUserApplicationVariable({
        workspaceId,
        applicationUniversalIdentifier: oauthAppUniversalId,
        userWorkspaceId: actorUserWorkspaceId,
        key: 'PERSONAL_API_TOKEN',
        plainTextValue: 'secret' as PlaintextString,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      ['userApplicationVariableValueMaps'],
    );

    // 3. ApplicationService.delete calls invalidateStorageStock on ordinary pre-commit rollback after deleteApplicationFileRows, but suppresses it on NativeTransactionOutcomeUnknownError / CoreAuditPostCommitError (T2)
    fileStorageService.invalidateStorageStock.mockClear();
    fileStorageService.deleteApplicationFilesFromStorage.mockClear();
    workspaceEventBroadcaster.broadcast.mockClear();
    workspaceCacheService.invalidateAndRecompute.mockClear();

    fileStorageService.deleteApplicationFileRows.mockImplementationOnce(
      async () => {
        throw new Error('pre-commit file row deletion failure');
      },
    );
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId, {
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow('pre-commit file row deletion failure');
    expect(fileStorageService.invalidateStorageStock).toHaveBeenCalledTimes(1);
    expect(
      fileStorageService.deleteApplicationFilesFromStorage,
    ).not.toHaveBeenCalled();
    expect(workspaceEventBroadcaster.broadcast).not.toHaveBeenCalled();

    fileStorageService.invalidateStorageStock.mockClear();
    workspaceCacheService.invalidateAndRecompute.mockClear();
    injectCommitFailure();
    await expect(
      applicationService.delete(oauthAppUniversalId, workspaceId, {
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(fileStorageService.invalidateStorageStock).not.toHaveBeenCalled();
    expect(
      fileStorageService.deleteApplicationFilesFromStorage,
    ).not.toHaveBeenCalled();
    expect(workspaceEventBroadcaster.broadcast).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalled();
  });
});
