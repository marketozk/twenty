import { randomUUID } from 'node:crypto';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAudit,
  captureApplicationMetadataAuditOperation,
  reconcileApplicationRoleAndPermissionOperations,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { captureValidationRuleAudit } from 'src/engine/core-modules/crm-audit/validation-rule-audit';

jest.mock('twenty-shared/ai', () => ({
  ToolCategory: { METADATA: 'METADATA' },
}));
jest.mock(
  'src/engine/core-modules/tool-provider/decorators/define-tool.decorator',
  () => ({
    DefineTool: () => () => {},
  }),
);
jest.mock(
  'src/engine/core-modules/tool-provider/interfaces/base-tool.interface',
  () => ({
    BaseTool: class {},
  }),
);
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  [
    'src/engine/core-modules/billing/services/billing-subscription.service',
    ['BillingSubscriptionService'],
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
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
  ],
  [
    'src/engine/metadata-modules/validation-rule/filters/validation-rule-graphql-api-exception.filter',
    ['ValidationRuleGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/validation-rule/utils/compute-validation-rule-bindings.util',
    ['computeValidationRuleBindings'],
  ],
  [
    'src/engine/metadata-modules/validation-rule/utils/compile-validation-rule-expression-or-throw.util',
    ['compileValidationRuleExpressionOrThrow'],
  ],
  [
    'src/engine/metadata-modules/object-metadata/tools/services/metadata-tool-identifier.service',
    ['MetadataToolIdentifierService'],
  ],
  ['src/engine/guards/feature-flag.guard', ['FeatureFlagGuard']],
  ['src/engine/guards/no-permission.guard', ['NoPermissionGuard']],
  [
    'src/engine/guards/settings-permission.guard',
    ['SettingsPermissionGuard'],
  ],
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  [
    'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    ['WorkspaceMetadataVersionService'],
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
    'src/engine/workspace-manager/workspace-migration/interceptors/workspace-migration-graphql-api-exception.interceptor',
    ['WorkspaceMigrationGraphqlApiExceptionInterceptor'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    ['WorkspaceMigrationRunnerActionHandlerRegistryService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    ['DeferredWorkspaceMigrationActionRunnerService'],
  ],
] as const) {
  jest.mock(modPath, () => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (
        name === 'SettingsPermissionGuard' ||
        name === 'AuthPrincipalGuard' ||
        name === 'FeatureFlagGuard'
      ) {
        out[name] = () => class {};
      } else if (name === 'computeValidationRuleBindings') {
        out[name] = () => ({ amount: 'field-binding-ref' });
      } else if (name === 'compileValidationRuleExpressionOrThrow') {
        out[name] = () => {};
      } else {
        out[name] = class {};
      }
    }
    return out;
  });
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ValidationRuleService } =
  require('src/engine/metadata-modules/validation-rule/validation-rule.service') as typeof import('src/engine/metadata-modules/validation-rule/validation-rule.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ValidationRuleResolver } =
  require('src/engine/metadata-modules/validation-rule/validation-rule.resolver') as typeof import('src/engine/metadata-modules/validation-rule/validation-rule.resolver');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CreateValidationRuleTool } =
  require('src/engine/metadata-modules/validation-rule/tools/create-validation-rule.tool') as typeof import('src/engine/metadata-modules/validation-rule/tools/create-validation-rule.tool');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UpdateValidationRuleTool } =
  require('src/engine/metadata-modules/validation-rule/tools/update-validation-rule.tool') as typeof import('src/engine/metadata-modules/validation-rule/tools/update-validation-rule.tool');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

const ownerUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !ownerUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(ownerUrl).pathname)
) {
  throw new Error(
    'FORK_MIGRATION_TEST_URL must target an isolated temporary test database',
  );
}
const databaseRole = `vr_audit_rt_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const runtimeUrl = (() => {
  const parsed = new URL(ownerUrl);
  parsed.username = databaseRole;
  parsed.password = 'isolated-vr-fixture';
  return parsed.toString();
})();

const workspaceId = randomUUID().toLowerCase();
const workspaceSchema = `workspace_${workspaceId.replaceAll('-', '')}`;
const actorUserId = randomUUID().toLowerCase();
const actorUserWorkspaceId = randomUUID().toLowerCase();
const actorMemberId = randomUUID().toLowerCase();
const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();
const impersonatorMemberId = randomUUID().toLowerCase();
const agentId = randomUUID().toLowerCase();

const customApplicationId = randomUUID().toLowerCase();
const customApplicationUniversalIdentifier = randomUUID().toLowerCase();
const standardApplicationId = randomUUID().toLowerCase();
const standardApplicationUniversalIdentifier = randomUUID().toLowerCase();
const thirdPartyApplicationId = randomUUID().toLowerCase();
const thirdPartyApplicationUniversalIdentifier = randomUUID().toLowerCase();

const objectMetadataId = randomUUID().toLowerCase();
const objectMetadataUniversalIdentifier = randomUUID().toLowerCase();
const fieldMetadataId = randomUUID().toLowerCase();
const fieldMetadataUniversalIdentifier = randomUUID().toLowerCase();

const ownerDataSource = new DataSource({ type: 'postgres', url: ownerUrl });
const runtimeDataSource = new DataSource({ type: 'postgres', url: runtimeUrl });

const identity = (impersonated = false): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    user: { id: actorUserId },
    userWorkspaceId: actorUserWorkspaceId,
    workspaceMemberId: actorMemberId,
  } as never,
  ...(impersonated ? { impersonatorUserWorkspaceId } : {}),
});

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT id, "operationId", actor, initiator, action, "resourceKind", "resourceId",
            outcome, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
      ORDER BY "createdAt" ASC, id ASC`,
    [workspaceId],
  );

const createHarness = () => {
  const readFlatMaps = async () => {
    const appRows = await ownerDataSource.query(
      `SELECT id, "universalIdentifier" FROM core.application WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const appUidById = new Map<string, string>(
      appRows.map((row: { id: string; universalIdentifier: string }) => [
        row.id,
        row.universalIdentifier,
      ]),
    );
    const objectRows = await ownerDataSource.query(
      `SELECT * FROM core."objectMetadata" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const fieldRows = await ownerDataSource.query(
      `SELECT * FROM core."fieldMetadata" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const ruleRows = await ownerDataSource.query(
      `SELECT * FROM core."validationRule" WHERE "workspaceId" = $1`,
      [workspaceId],
    );

    const objUidById = new Map<string, string>(
      objectRows.map((row: { id: string; universalIdentifier: string }) => [
        row.id,
        row.universalIdentifier,
      ]),
    );
    const fieldUidById = new Map<string, string>(
      fieldRows.map((row: { id: string; universalIdentifier: string }) => [
        row.id,
        row.universalIdentifier,
      ]),
    );

    const buildMap = <TRow extends { id: string; universalIdentifier: string }>(
      rows: TRow[],
      enrich?: (row: TRow) => Record<string, unknown>,
    ) => {
      const byUniversalIdentifier: Record<string, Record<string, unknown>> = {};
      const universalIdentifierById: Record<string, string> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      for (const row of rows) {
        const enriched = enrich ? enrich(row) : row;
        byUniversalIdentifier[row.universalIdentifier] = enriched;
        universalIdentifierById[row.id] = row.universalIdentifier;
        idByUniversalIdentifier[row.universalIdentifier] = row.id;
      }
      return {
        byUniversalIdentifier,
        universalIdentifierById,
        idByUniversalIdentifier,
      };
    };

    const flatObjectMetadataMaps = buildMap(
      objectRows,
      (row: Record<string, unknown>) => ({
        ...row,
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
        fieldUniversalIdentifiers: [],
      }),
    );

    const flatFieldMetadataMaps = buildMap(
      fieldRows,
      (row: Record<string, unknown>) => ({
        ...row,
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
        objectMetadataUniversalIdentifier:
          objUidById.get(String(row.objectMetadataId)) ??
          objectMetadataUniversalIdentifier,
      }),
    );

    const flatValidationRuleMaps = buildMap(
      ruleRows,
      (row: Record<string, unknown>) => ({
        ...row,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : String(row.updatedAt),
        applicationUniversalIdentifier:
          appUidById.get(String(row.applicationId)) ??
          customApplicationUniversalIdentifier,
        objectMetadataUniversalIdentifier:
          objUidById.get(String(row.objectMetadataId)) ??
          objectMetadataUniversalIdentifier,
        errorFieldMetadataUniversalIdentifier: row.errorFieldMetadataId
          ? (fieldUidById.get(String(row.errorFieldMetadataId)) ?? null)
          : null,
      }),
    );

    const emptyMap = {
      byUniversalIdentifier: {},
      universalIdentifierById: {},
      idByUniversalIdentifier: {},
    };

    return {
      flatValidationRuleMaps,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatNavigationMenuItemMaps: emptyMap,
      flatViewMaps: emptyMap,
      flatViewGroupMaps: emptyMap,
      flatViewFieldMaps: emptyMap,
      flatViewFilterMaps: emptyMap,
      flatViewSortMaps: emptyMap,
      flatViewFieldGroupMaps: emptyMap,
      flatViewFilterGroupMaps: emptyMap,
      flatRoleMaps: emptyMap,
      flatRoleTargetMaps: emptyMap,
      flatAgentMaps: emptyMap,
      flatPermissionFlagMaps: emptyMap,
      flatRolePermissionFlagMaps: emptyMap,
      flatObjectPermissionMaps: emptyMap,
      flatFieldPermissionMaps: emptyMap,
      flatRowLevelPermissionPredicateMaps: emptyMap,
      flatRowLevelPermissionPredicateGroupMaps: emptyMap,
      flatWorkflowMaps: emptyMap,
      flatIndexMaps: emptyMap,
      flatPageLayoutMaps: emptyMap,
      flatPageLayoutTabMaps: emptyMap,
      flatPageLayoutWidgetMaps: emptyMap,
      flatAgentChatChannelMaps: emptyMap,
      flatAgentChatChannelRoleMaps: emptyMap,
      flatWebhookMaps: emptyMap,
      flatConnectionProviderMaps: emptyMap,
      flatSkillMaps: emptyMap,
      flatFrontComponentMaps: emptyMap,
      flatSettingsMenuItemMaps: emptyMap,
      flatLogicFunctionMaps: emptyMap,
      flatWorkflowVersionMaps: emptyMap,
      flatTimelineActivityTypeMaps: emptyMap,
      flatCommandMenuItemMaps: emptyMap,
      flatSearchFieldMetadataMaps: emptyMap,
    };
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () => readFlatMaps()),
    invalidateFlatEntityMaps: jest.fn().mockResolvedValue(undefined),
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => {
      const appRows = await ownerDataSource.query(
        `SELECT id, "universalIdentifier" FROM core.application WHERE "workspaceId" = $1`,
        [workspaceId],
      );
      const byId: Record<string, unknown> = {};
      const byUniversalIdentifier: Record<string, unknown> = {};
      const universalIdentifierById: Record<string, string> = {};
      const idByUniversalIdentifier: Record<string, string> = {};
      for (const row of appRows) {
        const flatApp = {
          id: row.id,
          workspaceId,
          universalIdentifier: row.universalIdentifier,
        };
        byId[row.id] = flatApp;
        byUniversalIdentifier[row.universalIdentifier] = flatApp;
        universalIdentifierById[row.id] = row.universalIdentifier;
        idByUniversalIdentifier[row.universalIdentifier] = row.id;
      }
      return {
        flatApplicationMaps: {
          byId,
          byUniversalIdentifier,
          universalIdentifierById,
          idByUniversalIdentifier,
        },
        flatWorkspace: {
          id: workspaceId,
          activationStatus: WorkspaceActivationStatus.ACTIVE,
        },
      };
    }),
    invalidateAndRecompute: jest.fn().mockResolvedValue(undefined),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async () => ({
        workspaceCustomFlatApplication: {
          id: customApplicationId,
          workspaceId,
          universalIdentifier: customApplicationUniversalIdentifier,
        },
        twentyStandardFlatApplication: {
          id: standardApplicationId,
          workspaceId,
          universalIdentifier: standardApplicationUniversalIdentifier,
        },
      }),
    ),
  };

  const actionHandlerRegistry = {
    executeActionHandler: jest.fn(
      async ({
        action,
        context,
      }: {
        action: {
          type: string;
          metadataName: string;
          id?: string;
          universalIdentifier?: string;
          flatEntity?: Record<string, unknown>;
          update?: Record<string, unknown>;
        };
        context: {
          flatApplication: { id: string };
          allFlatEntityMaps: Awaited<ReturnType<typeof readFlatMaps>>;
          queryRunner: QueryRunner;
          workspaceId: string;
        };
      }) => {
        if (action.metadataName === 'validationRule') {
          if (action.type === 'create' && action.flatEntity) {
            const flat = action.flatEntity;
            const id = String(action.id ?? flat.id ?? randomUUID());
            const objUid = String(
              flat.objectMetadataUniversalIdentifier ??
                objectMetadataUniversalIdentifier,
            );
            const objId =
              context.allFlatEntityMaps.flatObjectMetadataMaps
                .idByUniversalIdentifier[objUid] ??
              String(flat.objectMetadataId ?? objectMetadataId);
            const errFieldUid = flat.errorFieldMetadataUniversalIdentifier as
              | string
              | null
              | undefined;
            const errFieldId = errFieldUid
              ? (context.allFlatEntityMaps.flatFieldMetadataMaps
                  .idByUniversalIdentifier[errFieldUid] ?? null)
              : (flat.errorFieldMetadataId ?? null);
            await context.queryRunner.query(
              `INSERT INTO core."validationRule"
                (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
                 "errorFieldMetadataId", name, description, icon, expression, bindings, message, "isActive")
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
              [
                id,
                String(flat.universalIdentifier),
                context.workspaceId,
                context.flatApplication.id,
                objId,
                errFieldId,
                String(flat.name ?? 'Rule'),
                flat.description ?? null,
                flat.icon ?? null,
                String(flat.expression ?? 'amount > 0'),
                JSON.stringify(flat.bindings ?? {}),
                String(flat.message ?? 'Invalid value'),
                flat.isActive ?? true,
              ],
            );
          } else if (action.type === 'update' && action.update) {
            const existing =
              context.allFlatEntityMaps.flatValidationRuleMaps
                .byUniversalIdentifier[action.universalIdentifier!];
            const id = String(existing?.id);
            const update = action.update;
            const setClauses: string[] = ['"updatedAt" = now()'];
            const params: unknown[] = [id, context.workspaceId];
            for (const [key, col] of [
              ['name', 'name'],
              ['description', 'description'],
              ['icon', 'icon'],
              ['expression', 'expression'],
              ['message', 'message'],
              ['isActive', '"isActive"'],
            ] as const) {
              if (key in update && update[key] !== undefined) {
                params.push(update[key]);
                setClauses.push(`${col} = $${params.length}`);
              }
            }
            if ('errorFieldMetadataId' in update && update.errorFieldMetadataId !== undefined) {
              params.push(update.errorFieldMetadataId);
              setClauses.push(`"errorFieldMetadataId" = $${params.length}`);
            } else if ('errorFieldMetadataUniversalIdentifier' in update) {
              const uid = update.errorFieldMetadataUniversalIdentifier as
                | string
                | null;
              const resolvedId = uid
                ? (context.allFlatEntityMaps.flatFieldMetadataMaps
                    .idByUniversalIdentifier[uid] ?? null)
                : null;
              params.push(resolvedId);
              setClauses.push(`"errorFieldMetadataId" = $${params.length}`);
            }
            if ('bindings' in update && update.bindings !== undefined) {
              params.push(JSON.stringify(update.bindings));
              setClauses.push(`bindings = $${params.length}::jsonb`);
            }
            await context.queryRunner.query(
              `UPDATE core."validationRule" SET ${setClauses.join(', ')} WHERE id = $1 AND "workspaceId" = $2`,
              params,
            );
          } else if (action.type === 'delete') {
            const existing =
              context.allFlatEntityMaps.flatValidationRuleMaps
                .byUniversalIdentifier[action.universalIdentifier!];
            await context.queryRunner.query(
              `DELETE FROM core."validationRule" WHERE id = $1 AND "workspaceId" = $2`,
              [String(existing?.id), context.workspaceId],
            );
          }
        } else if (
          action.metadataName === 'fieldMetadata' &&
          action.type === 'update'
        ) {
          const existing =
            context.allFlatEntityMaps.flatFieldMetadataMaps
              .byUniversalIdentifier[action.universalIdentifier!];
          await context.queryRunner.query(
            `UPDATE core."fieldMetadata" SET name = COALESCE($3, name) WHERE id = $1 AND "workspaceId" = $2`,
            [String(existing?.id), context.workspaceId, action.update?.name ?? null],
          );
        } else if (
          action.metadataName === 'fieldMetadata' &&
          action.type === 'delete'
        ) {
          const existing =
            context.allFlatEntityMaps.flatFieldMetadataMaps
              .byUniversalIdentifier[action.universalIdentifier!];
          await context.queryRunner.query(
            `DELETE FROM core."fieldMetadata" WHERE id = $1 AND "workspaceId" = $2`,
            [String(existing?.id), context.workspaceId],
          );
        } else if (
          action.metadataName === 'objectMetadata' &&
          action.type === 'delete'
        ) {
          const existing =
            context.allFlatEntityMaps.flatObjectMetadataMaps
              .byUniversalIdentifier[action.universalIdentifier!];
          await context.queryRunner.query(
            `DELETE FROM core."objectMetadata" WHERE id = $1 AND "workspaceId" = $2`,
            [String(existing?.id), context.workspaceId],
          );
        }
        return {
          partialOptimisticCache: {},
          metadataEvents: [],
          deferredActions: [],
        };
      },
    ),
    executeActionRollbackHandler: jest.fn().mockResolvedValue(undefined),
  };

  const migrationRunner = new WorkspaceMigrationRunnerService(
    flatEntityMapsCacheService as never,
    runtimeDataSource,
    actionHandlerRegistry as never,
    {
      incrementMetadataVersion: jest.fn().mockResolvedValue(undefined),
    } as never,
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
      persist: jest.fn().mockResolvedValue(undefined),
      dispatchAfterCommit: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      throwIfSchemaAffectingActionsAreInProgress: jest
        .fn()
        .mockResolvedValue(undefined),
    } as never,
  );

  const validateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: wsId,
        applicationUniversalIdentifier: appUid,
      }: {
        allFlatEntityOperationByMetadataName: {
          validationRule?: {
            flatEntityToCreate?: Array<Record<string, unknown>>;
            flatEntityToUpdate?: Array<Record<string, unknown>>;
            flatEntityToDelete?: Array<Record<string, unknown>>;
          };
        };
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const actions: Array<Record<string, unknown>> = [];
        for (const toCreate of allFlatEntityOperationByMetadataName
          .validationRule?.flatEntityToCreate ?? []) {
          actions.push({
            type: 'create',
            metadataName: 'validationRule',
            id: toCreate.id,
            flatEntity: toCreate,
          });
        }
        for (const toUpdate of allFlatEntityOperationByMetadataName
          .validationRule?.flatEntityToUpdate ?? []) {
          actions.push({
            type: 'update',
            metadataName: 'validationRule',
            universalIdentifier: String(toUpdate.universalIdentifier),
            update: toUpdate,
          });
        }
        for (const toDelete of allFlatEntityOperationByMetadataName
          .validationRule?.flatEntityToDelete ?? []) {
          actions.push({
            type: 'delete',
            metadataName: 'validationRule',
            universalIdentifier: String(toDelete.universalIdentifier),
          });
        }
        await migrationRunner.run({
          workspaceId: wsId,
          workspaceMigration: {
            applicationUniversalIdentifier: appUid,
            actions: actions as never,
          },
        });
        return { status: 'success' as const };
      },
    ),
  };

  const billingSubscriptionService = {
    getWorkspaceEntitlementValue: jest.fn(async () => true),
  };

  const validationRuleService = new ValidationRuleService(
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
    billingSubscriptionService as never,
  );

  const validationRuleResolver = new ValidationRuleResolver(
    validationRuleService,
  );

  const createTool = new CreateValidationRuleTool(validationRuleService, {
    getObjectMetadataIdOrThrow: jest.fn(async () => objectMetadataId),
  } as never);

  const updateTool = new UpdateValidationRuleTool(validationRuleService);

  return {
    validationRuleService,
    validationRuleResolver,
    createTool,
    updateTool,
    migrationRunner,
  };
};

beforeAll(async () => {
  await ownerDataSource.initialize();
  await ownerDataSource.query(
    `DROP SCHEMA IF EXISTS core CASCADE;
     DROP SCHEMA IF EXISTS crm_audit CASCADE;
     DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
     CREATE SCHEMA core;
     CREATE SCHEMA "${workspaceSchema}";`,
  );
  await ownerDataSource.query(
    `CREATE TABLE core.workspace (
       id uuid PRIMARY KEY,
       "activationStatus" text NOT NULL DEFAULT 'ACTIVE',
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."user" (
       id uuid PRIMARY KEY,
       email text NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core.application (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."objectMetadata" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "nameSingular" text NOT NULL DEFAULT 'opportunity',
       "namePlural" text NOT NULL DEFAULT 'opportunities',
       "labelSingular" text NOT NULL DEFAULT 'Opportunity',
       "labelPlural" text NOT NULL DEFAULT 'Opportunities',
       "isSystem" boolean NOT NULL DEFAULT false,
       "isActive" boolean NOT NULL DEFAULT true,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."fieldMetadata" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL,
       "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
       type text NOT NULL DEFAULT 'NUMBER',
       name text NOT NULL DEFAULT 'amount',
       label text NOT NULL DEFAULT 'Amount',
       "isSystem" boolean NOT NULL DEFAULT false,
       "isSystemSideEffect" boolean NOT NULL DEFAULT false,
       "isActive" boolean NOT NULL DEFAULT true,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."validationRule" (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
       "errorFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE SET NULL,
       name varchar NOT NULL,
       description text NULL,
       icon varchar NULL,
       expression text NOT NULL,
       bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
       message text NOT NULL,
       "isActive" boolean NOT NULL DEFAULT true,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     );
     CREATE TABLE core."navigationMenuItem" (
       id uuid PRIMARY KEY,
       "universalIdentifier" uuid NOT NULL,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
       "userWorkspaceId" uuid NULL,
       "targetObjectMetadataId" uuid NULL,
       type text NOT NULL DEFAULT 'OBJECT',
       name text NULL,
       position double precision NOT NULL DEFAULT 0,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now()
     );
     CREATE TABLE "${workspaceSchema}"."workspaceMember" (
       id uuid PRIMARY KEY,
       "userId" uuid NOT NULL,
       "deletedAt" timestamptz NULL
     );`,
  );

  await ownerDataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await ownerDataSource.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-vr-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();

  await ownerDataSource.query(
    `INSERT INTO core.workspace (id, "activationStatus") VALUES ($1, 'ACTIVE')`,
    [workspaceId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email) VALUES ($1, 'actor@example.com'), ($2, 'admin@example.com')`,
    [actorUserId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId") VALUES ($1, $2, $3), ($4, $2, $5)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId") VALUES ($1, $2), ($3, $4)`,
    [actorMemberId, actorUserId, impersonatorMemberId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier") VALUES ($1, $2, $3), ($4, $2, $5), ($6, $2, $7)`,
    [
      customApplicationId,
      workspaceId,
      customApplicationUniversalIdentifier,
      standardApplicationId,
      standardApplicationUniversalIdentifier,
      thirdPartyApplicationId,
      thirdPartyApplicationUniversalIdentifier,
    ],
  );
});

afterAll(async () => {
  if (runtimeDataSource.isInitialized) {
    await runtimeDataSource.destroy();
  }
  if (ownerDataSource.isInitialized) {
    await ownerDataSource.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       REVOKE ALL PRIVILEGES ON SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       DROP ROLE IF EXISTS "${databaseRole}";`,
    );
    await ownerDataSource.destroy();
  }
});

beforeEach(async () => {
  await ownerDataSource.query(
    `DELETE FROM crm_audit."crmAuditEntry";
     DELETE FROM core."validationRule";
     DELETE FROM core."fieldMetadata";
     DELETE FROM core."objectMetadata";`,
  );
  await ownerDataSource.query(
    `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier")
     VALUES ($1, $2, $3, $4)`,
    [
      objectMetadataId,
      workspaceId,
      customApplicationId,
      objectMetadataUniversalIdentifier,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      fieldMetadataId,
      workspaceId,
      customApplicationId,
      fieldMetadataUniversalIdentifier,
      objectMetadataId,
    ],
  );
});

describe('validationRule lifecycle CRM audit (LOG-198)', () => {
  it('audits create, update, and delete via ValidationRuleResolver and AI tools with impersonation, agent attribution, and formula redaction', async () => {
    const { validationRuleResolver, createTool, updateTool } = createHarness();

    const created = await validationRuleResolver.createValidationRule(
      {
        objectMetadataId,
        errorFieldMetadataId: fieldMetadataId,
        name: 'Positive Deal Amount',
        description: 'Confidential business rule description',
        icon: 'IconAlertTriangle',
        expression: 'amount > 0 && secretMargin >= 0.25',
        message: 'Deal amount must satisfy confidential margin policy',
        isActive: true,
      },
      { id: workspaceId } as never,
      { req: identity(true) },
    );

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      action: 'create',
      resourceKind: 'validationRule',
      resourceId: created.id,
      outcome: 'success',
      securityDescriptor: {
        resourceKind: 'validationRule',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values).toEqual({
      applicationId: { before: null, after: customApplicationId },
      objectMetadataId: { before: null, after: objectMetadataId },
      errorFieldMetadataId: { before: null, after: fieldMetadataId },
      isActive: { before: null, after: true },
    });
    expect(audits[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining([
        'name',
        'description',
        'icon',
        'expression',
        'bindings',
        'message',
      ]),
    );
    expect(JSON.stringify(audits[0].redactedDiff)).not.toContain(
      'secretMargin',
    );
    expect(JSON.stringify(audits[0].redactedDiff)).not.toContain(
      'confidential margin policy',
    );

    await validationRuleResolver.updateValidationRule(
      {
        id: created.id,
        update: {
          isActive: false,
          errorFieldMetadataId: null,
          expression: 'amount >= 100',
        },
      },
      { id: workspaceId } as never,
      { req: identity() },
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'update',
      resourceKind: 'validationRule',
      resourceId: created.id,
    });
    expect(audits[1].redactedDiff.values).toEqual({
      errorFieldMetadataId: { before: fieldMetadataId, after: null },
      isActive: { before: true, after: false },
    });
    expect(audits[1].redactedDiff.changedFields).toContain('expression');
    expect(JSON.stringify(audits[1].redactedDiff)).not.toContain(
      'amount >= 100',
    );

    await validationRuleResolver.deleteValidationRule(
      created.id,
      { id: workspaceId } as never,
      { req: identity() },
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      action: 'delete',
      resourceKind: 'validationRule',
      resourceId: created.id,
    });
    expect(audits[2].redactedDiff.values).toEqual({
      applicationId: { before: customApplicationId, after: null },
      objectMetadataId: { before: objectMetadataId, after: null },
      errorFieldMetadataId: { before: null, after: null },
      isActive: { before: false, after: null },
    });

    // AI tools preserve agentId + coreUser initiator attribution
    const toolCreateOut = await createTool.execute({
      input: {
        objectName: 'opportunity',
        name: 'AI Guard Rule',
        expression: 'amount > 10',
        message: 'Must exceed 10',
      },
      context: {
        workspaceId,
        userId: actorUserId,
        agentId,
      } as never,
    });
    const toolRuleId = toolCreateOut.result!.id;

    await updateTool.execute({
      input: {
        id: toolRuleId,
        isActive: false,
      },
      context: {
        workspaceId,
        userId: actorUserId,
        agentId,
      } as never,
    });

    audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    expect(audits[3]).toMatchObject({
      action: 'create',
      resourceKind: 'validationRule',
      resourceId: toolRuleId,
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'coreUser', id: actorUserId },
    });
    expect(audits[4]).toMatchObject({
      action: 'update',
      resourceKind: 'validationRule',
      resourceId: toolRuleId,
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'coreUser', id: actorUserId },
    });
  });

  it('enforces fail-closed barrier and strict cascade invariants on validationRule mutations', async () => {
    const { migrationRunner, validationRuleService } = createHarness();

    // Unaudited create is blocked
    const rogueRuleId = randomUUID().toLowerCase();
    const rogueRuleUid = randomUUID().toLowerCase();
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'create',
              metadataName: 'validationRule',
              id: rogueRuleId,
              flatEntity: {
                id: rogueRuleId,
                universalIdentifier: rogueRuleUid,
                objectMetadataUniversalIdentifier,
                applicationUniversalIdentifier:
                  customApplicationUniversalIdentifier,
                name: 'Rogue Rule',
                expression: 'false',
                message: 'Blocked',
              },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Seed rule for update/delete checks
    await ownerDataSource.query(
      `INSERT INTO core."validationRule"
        (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
         name, expression, bindings, message, "isActive")
       VALUES ($1,$2,$3,$4,$5,'Seeded Rule','amount > 0','{}'::jsonb,'Bad',false)`,
      [
        rogueRuleId,
        rogueRuleUid,
        workspaceId,
        customApplicationId,
        objectMetadataId,
      ],
    );

    // Unaudited update and delete are blocked
    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'update',
              metadataName: 'validationRule',
              universalIdentifier: rogueRuleUid,
              update: { isActive: true },
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    await expect(
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: customApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'validationRule',
              universalIdentifier: rogueRuleUid,
            },
          ] as never,
        },
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    // Missing auditIdentity fails closed in ValidationRuleService
    await expect(
      validationRuleService.create({
        input: {
          objectMetadataId,
          name: 'No Auth Rule',
          expression: 'amount > 0',
          message: 'No auth',
        },
        workspaceId,
      }),
    ).rejects.toThrow(
      'Validation rule mutation requires authenticated audit identity',
    );

    // Bare agentId without authenticated base principal fails closed
    await expect(
      validationRuleService.create({
        input: {
          objectMetadataId,
          name: 'Bare Agent Rule',
          expression: 'amount > 0',
          message: 'Bare agent',
        },
        workspaceId,
        auditIdentity: { agentId },
      }),
    ).rejects.toThrow(
      'Validation rule mutation requires authenticated audit identity',
    );

    // Conflicting apiKey + user principals fail closed
    await expect(
      validationRuleService.create({
        input: {
          objectMetadataId,
          name: 'Conflicting Principals Rule',
          expression: 'amount > 0',
          message: 'Conflicting',
        },
        workspaceId,
        auditIdentity: {
          apiKey: { id: randomUUID() },
          user: { id: actorUserId },
        },
      }),
    ).rejects.toThrow('Conflicting validation rule audit principals');

    // captureValidationRuleAudit factory is single-use
    const singleUseFactory = captureValidationRuleAudit({
      workspaceId,
      expectedAction: 'create',
      auditIdentity: identity(),
    });
    singleUseFactory();
    expect(() => singleUseFactory()).toThrow(
      'Validation rule audit capture cannot be reused',
    );

    // Cascade rejects validationRule:update on a rule that does not reference the updated field
    const getUnrelatedCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: identity(),
    });
    await expect(
      withNavigationMenuItemAudit(
        getUnrelatedCascade({ expectedUpdatedFieldCount: 1 }),
        () =>
          migrationRunner.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier:
                customApplicationUniversalIdentifier,
              actions: [
                {
                  type: 'update',
                  metadataName: 'fieldMetadata',
                  universalIdentifier: fieldMetadataUniversalIdentifier,
                  update: { name: 'renamedAmount' },
                },
                {
                  type: 'update',
                  metadataName: 'validationRule',
                  universalIdentifier: rogueRuleUid,
                  update: { expression: 'renamedAmount > 0' },
                },
              ] as never,
            },
          }),
      ),
    ).rejects.toThrow(
      'Navigation menu item cascade audit cannot update unrelated validationRule',
    );

    // Bind rogueRule to fieldMetadataUniversalIdentifier and verify cascade still rejects activation (false -> true)
    await ownerDataSource.query(
      `UPDATE core."validationRule" SET bindings = jsonb_build_object('amount', $2::text) WHERE id = $1`,
      [rogueRuleId, fieldMetadataUniversalIdentifier],
    );
    const getCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: identity(),
    });
    await expect(
      withNavigationMenuItemAudit(
        getCascade({ expectedUpdatedFieldCount: 1 }),
        () =>
          migrationRunner.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier:
                customApplicationUniversalIdentifier,
              actions: [
                {
                  type: 'update',
                  metadataName: 'fieldMetadata',
                  universalIdentifier: fieldMetadataUniversalIdentifier,
                  update: { name: 'renamedAmount' },
                },
                {
                  type: 'update',
                  metadataName: 'validationRule',
                  universalIdentifier: rogueRuleUid,
                  update: { isActive: true },
                },
              ] as never,
            },
          }),
      ),
    ).rejects.toThrow('Validation rule side-effect update cannot activate rule');
  });

  it('audits cross-application side-effects, manifest CRUD, FK cascades, reconciler, and leftover checks on application delete', async () => {
    const { migrationRunner } = createHarness();

    // Create a third-party object and field, and a custom-app validationRule referencing both
    const tpObjId = randomUUID().toLowerCase();
    const tpObjUid = randomUUID().toLowerCase();
    const tpFieldId = randomUUID().toLowerCase();
    const tpFieldUid = randomUUID().toLowerCase();
    const customRuleId = randomUUID().toLowerCase();
    const customRuleUid = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier")
       VALUES ($1,$2,$3,$4)`,
      [tpObjId, workspaceId, thirdPartyApplicationId, tpObjUid],
    );
    await ownerDataSource.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId")
       VALUES ($1,$2,$3,$4,$5)`,
      [tpFieldId, workspaceId, thirdPartyApplicationId, tpFieldUid, tpObjId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."validationRule"
        (id, "universalIdentifier", "workspaceId", "applicationId", "objectMetadataId",
         "errorFieldMetadataId", name, expression, bindings, message, "isActive")
       VALUES ($1,$2,$3,$4,$5,$6,'Custom Rule On App Object','amount > 0',jsonb_build_object('amount', $7::text),'Bad',true)`,
      [
        customRuleId,
        customRuleUid,
        workspaceId,
        customApplicationId,
        tpObjId,
        tpFieldId,
        tpFieldUid,
      ],
    );

    // 1. Navigation cascade: field update triggers cross-app validationRule:update side effect
    const getCascade = captureNavigationMenuItemAudit({
      workspaceId,
      mode: 'cascade',
      auditIdentity: identity(),
    });
    await withNavigationMenuItemAudit(
      getCascade({ expectedUpdatedFieldCount: 1 }),
      () =>
        migrationRunner.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier:
              thirdPartyApplicationUniversalIdentifier,
            actions: [
              {
                type: 'update',
                metadataName: 'fieldMetadata',
                universalIdentifier: tpFieldUid,
                update: { name: 'totalAmount' },
              },
              {
                type: 'update',
                metadataName: 'validationRule',
                universalIdentifier: customRuleUid,
                update: {
                  expression: 'totalAmount > 0',
                  bindings: { totalAmount: tpFieldUid },
                },
              },
            ] as never,
          },
        }),
    );

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'update',
      resourceKind: 'validationRule',
      resourceId: customRuleId,
    });
    expect(audits[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining(['expression', 'bindings']),
    );

    // 2. Manifest sync: create own rule, cross-app side-effect update on field rename, then delete own rule
    const tpRuleId = randomUUID().toLowerCase();
    const tpRuleUid = randomUUID().toLowerCase();
    const getManifestCreate = captureApplicationMetadataAudit({
      workspaceId,
      applicationId: thirdPartyApplicationId,
      applicationUniversalIdentifier: thirdPartyApplicationUniversalIdentifier,
      auditIdentity: identity(),
    });
    await withApplicationMetadataAudit(getManifestCreate(), () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'create',
              metadataName: 'validationRule',
              id: tpRuleId,
              flatEntity: {
                id: tpRuleId,
                universalIdentifier: tpRuleUid,
                objectMetadataUniversalIdentifier: tpObjUid,
                applicationUniversalIdentifier:
                  thirdPartyApplicationUniversalIdentifier,
                name: 'App Rule',
                expression: 'totalAmount > 5',
                message: 'App rule failed',
              },
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'create',
      resourceKind: 'validationRule',
      resourceId: tpRuleId,
    });

    // 2b. fieldDelete rejects explicit side-effect update on an unrelated validationRule
    const unrelatedFieldDeleteOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        mode: 'fieldDelete',
        expectedDeletedFieldId: tpFieldId,
        auditIdentity: identity(),
      }),
      {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier:
          thirdPartyApplicationUniversalIdentifier,
      },
    );
    await expect(
      withApplicationMetadataAudit(unrelatedFieldDeleteOp, () =>
        migrationRunner.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier:
              thirdPartyApplicationUniversalIdentifier,
            actions: [
              {
                type: 'delete',
                metadataName: 'fieldMetadata',
                universalIdentifier: tpFieldUid,
              },
              {
                type: 'update',
                metadataName: 'validationRule',
                universalIdentifier: tpRuleUid,
                update: { isActive: false },
              },
            ] as never,
          },
        }),
      ),
    ).rejects.toThrow(
      'Application metadata audit cannot update unrelated validationRule',
    );

    // 3. fieldDelete: implicit FK ON DELETE SET NULL on errorFieldMetadataId audits customRule update
    const fieldDeleteOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        mode: 'fieldDelete',
        expectedDeletedFieldId: tpFieldId,
        auditIdentity: identity(),
      }),
      {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier:
          thirdPartyApplicationUniversalIdentifier,
      },
    );
    await withApplicationMetadataAudit(fieldDeleteOp, () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'fieldMetadata',
              universalIdentifier: tpFieldUid,
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      action: 'update',
      resourceKind: 'validationRule',
      resourceId: customRuleId,
    });
    expect(audits[2].redactedDiff.values).toEqual({
      errorFieldMetadataId: { before: tpFieldId, after: null },
    });

    // 4. assertNoRemainingApplicationRoleOrPermissionMetadata blocks on 2-hop object->field->validationRule too
    const checkRunner = ownerDataSource.createQueryRunner();
    await checkRunner.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await checkRunner.release();
    }

    // 5. objectDelete: implicit FK ON DELETE CASCADE removes both tpRule and foreign customRule and audits both
    const objectDeleteOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        mode: 'objectDelete',
        expectedDeletedObjectIds: [tpObjId],
        auditIdentity: identity(),
      }),
      {
        applicationId: thirdPartyApplicationId,
        applicationUniversalIdentifier:
          thirdPartyApplicationUniversalIdentifier,
      },
    );
    await withApplicationMetadataAudit(objectDeleteOp, () =>
      migrationRunner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier:
            thirdPartyApplicationUniversalIdentifier,
          actions: [
            {
              type: 'delete',
              metadataName: 'objectMetadata',
              universalIdentifier: tpObjUid,
            },
          ] as never,
        },
      }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    expect(
      audits
        .slice(3)
        .map((r: { resourceKind: string; action: string; resourceId: string }) => ({
          resourceKind: r.resourceKind,
          action: r.action,
          resourceId: r.resourceId,
        })),
    ).toEqual(
      expect.arrayContaining([
        { resourceKind: 'validationRule', action: 'delete', resourceId: tpRuleId },
        {
          resourceKind: 'validationRule',
          action: 'delete',
          resourceId: customRuleId,
        },
      ]),
    );

    // After object deletion, thirdPartyApplicationId has zero remaining metadata
    const checkRunner2 = ownerDataSource.createQueryRunner();
    await checkRunner2.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner2,
          workspaceId,
          thirdPartyApplicationId,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await checkRunner2.release();
    }

    // 6. reconcileApplicationRoleAndPermissionOperations includes validationRule deletes for deleted object
    const opsRecord: Record<string, unknown> = {
      objectMetadata: {
        flatEntityToCreate: {},
        flatEntityToUpdate: {},
        flatEntityToDelete: {
          [tpObjUid]: { id: tpObjId, universalIdentifier: tpObjUid },
        },
      },
    };
    reconcileApplicationRoleAndPermissionOperations({
      allFlatEntityOperationRecordByMetadataName: opsRecord,
      existingAllFlatEntityMaps: {
        flatValidationRuleMaps: {
          byUniversalIdentifier: {
            [customRuleUid]: {
              id: customRuleId,
              universalIdentifier: customRuleUid,
              objectMetadataUniversalIdentifier: tpObjUid,
            },
          },
        },
      },
    });
    expect(
      (
        opsRecord.validationRule as {
          flatEntityToDelete: Record<string, unknown>;
        }
      ).flatEntityToDelete[customRuleUid],
    ).toBeDefined();
  });

  it('rolls back validationRule create on audit flush failure and on post-flush row drift', async () => {
    const { validationRuleService } = createHarness();

    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_vr_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'validationRule' THEN
          RAISE EXCEPTION 'simulated validationRule audit flush failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_on_vr_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_on_vr_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_vr_audit();
    `);

    try {
      await expect(
        validationRuleService.create({
          input: {
            objectMetadataId,
            name: 'Rolled Back Rule',
            expression: 'amount > 0',
            message: 'Rolled back',
          },
          workspaceId,
          auditIdentity: identity(),
        }),
      ).rejects.toThrow('simulated validationRule audit flush failure');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_on_vr_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_on_vr_audit();`,
      );
    }

    expect(
      await ownerDataSource.query(
        `SELECT id FROM core."validationRule" WHERE "workspaceId" = $1`,
        [workspaceId],
      ),
    ).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);

    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.drift_vr_after_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'validationRule' AND NEW.action = 'create' THEN
          UPDATE core."validationRule" SET name = 'Drifted Rule' WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_drift_vr_after_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_drift_vr_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.drift_vr_after_audit();
    `);

    try {
      await expect(
        validationRuleService.create({
          input: {
            objectMetadataId,
            name: 'Drift Victim Rule',
            expression: 'amount > 0',
            message: 'Drift victim',
          },
          workspaceId,
          auditIdentity: identity(),
        }),
      ).rejects.toThrow('Validation rule state changed during audit flush');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_drift_vr_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.drift_vr_after_audit();`,
      );
    }

    expect(
      await ownerDataSource.query(
        `SELECT id FROM core."validationRule" WHERE "workspaceId" = $1`,
        [workspaceId],
      ),
    ).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
  });
});
