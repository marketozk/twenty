import { randomUUID } from 'node:crypto';
import { i18n } from '@lingui/core';
import { ALL_METADATA_NAME } from 'twenty-shared/metadata';
import {
  FieldMetadataType,
  RowLevelPermissionPredicateGroupLogicalOperator,
  RowLevelPermissionPredicateOperand,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { systemMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { getMetadataFlatEntityMapsKey } from 'src/engine/metadata-modules/flat-entity/utils/get-metadata-flat-entity-maps-key.util';
import { PermissionsExceptionCode } from 'src/engine/metadata-modules/permissions/permissions.exception';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';

jest.mock('twenty-shared/ai', () => ({
  AUTO_SELECT_WORKSPACE_DEFAULT_MODEL_ID: 'auto',
  ToolCategory: {
    ROLE: 'ROLE',
    METADATA: 'METADATA',
  },
  isAiModelTier: jest.fn(() => true),
}));
jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration.entity',
  () => ({ ApplicationRegistrationEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-variable/application-variable.entity',
  () => ({ ApplicationVariableEntity: class {} }),
);
jest.mock('src/engine/core-modules/application/application.entity', () => ({
  ApplicationEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/application/application-lookup/application-lookup.service',
  () => ({ ApplicationLookupService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/utils/serialize-application-for-broadcast.util',
  () => ({
    serializeApplicationForBroadcast: jest.fn((app: unknown) => app),
  }),
);
jest.mock(
  'src/engine/core-modules/file-storage/services/file-storage.service',
  () => ({ FileStorageService: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock('src/engine/core-modules/logger/logger.service', () => ({
  LoggerService: class {},
}));
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/metadata-modules/derived-field-metadata-ids/services/derived-field-metadata-ids.service',
  () => ({ DerivedFieldMetadataIdsService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/application-translation-catalog/services/application-translation-catalog.service',
  () => ({ ApplicationTranslationCatalogService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-metadata/mostly-empty-fields.service',
  () => ({ MostlyEmptyFieldsService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/object-metadata/object-record-count.service',
  () => ({ ObjectRecordCountService: class {} }),
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
  'src/engine/metadata-modules/field-metadata/field-metadata.entity',
  () => ({ FieldMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
  () => ({ WorkspaceMetadataVersionService: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/workspace-cache/services/workspace-cache.service',
  () => ({ WorkspaceCacheService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
  () => ({
    WorkspaceMigrationRunnerActionHandlerRegistryService: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
  () => ({
    DeferredWorkspaceMigrationActionRunnerService: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
  () => ({
    InFlightDeferredWorkspaceMigrationActionsService: class {},
  }),
);

const { ObjectMetadataService } =
  require('src/engine/metadata-modules/object-metadata/object-metadata.service') as typeof import('src/engine/metadata-modules/object-metadata/object-metadata.service');
const { ObjectMetadataResolver } =
  require('src/engine/metadata-modules/object-metadata/object-metadata.resolver') as typeof import('src/engine/metadata-modules/object-metadata/object-metadata.resolver');
const { ObjectMetadataController } =
  require('src/engine/metadata-modules/object-metadata/controllers/object-metadata.controller') as typeof import('src/engine/metadata-modules/object-metadata/controllers/object-metadata.controller');
const { DeleteObjectMetadataTool } =
  require('src/engine/metadata-modules/object-metadata/tools/delete-object-metadata.tool') as typeof import('src/engine/metadata-modules/object-metadata/tools/delete-object-metadata.tool');
const { FieldMetadataService } =
  require('src/engine/metadata-modules/field-metadata/services/field-metadata.service') as typeof import('src/engine/metadata-modules/field-metadata/services/field-metadata.service');
const { FieldMetadataResolver } =
  require('src/engine/metadata-modules/field-metadata/field-metadata.resolver') as typeof import('src/engine/metadata-modules/field-metadata/field-metadata.resolver');
const { FieldMetadataController } =
  require('src/engine/metadata-modules/field-metadata/controllers/field-metadata.controller') as typeof import('src/engine/metadata-modules/field-metadata/controllers/field-metadata.controller');
const { DeleteFieldMetadataTool } =
  require('src/engine/metadata-modules/field-metadata/tools/delete-field-metadata.tool') as typeof import('src/engine/metadata-modules/field-metadata/tools/delete-field-metadata.tool');
const { FlatObjectPermissionValidatorService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-object-permission-validator.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-object-permission-validator.service');
const { FlatFieldPermissionValidatorService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-field-permission-validator.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-field-permission-validator.service');
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `obj_fld_del_audit_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorMemberId = randomUUID();
const actorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const callingAgentId = randomUUID();

const standardAppId = randomUUID();
const customAppId = randomUUID();
const customAppUniversalId = randomUUID();
const thirdPartyAppId = randomUUID();
const thirdPartyAppUniversalId = randomUUID();

const editableRoleId = randomUUID();
const editableRoleUniversalId = randomUUID();
const nonEditableRoleId = randomUUID();
const nonEditableRoleUniversalId = STANDARD_ROLE.admin.universalIdentifier;

const companyObjectId = randomUUID();
const companyObjectUniversalId = randomUUID();
const companyNameFieldId = randomUUID();
const companyNameFieldUniversalId = randomUUID();
const workspaceMemberObjectId = randomUUID();
const workspaceMemberObjectUniversalId = randomUUID();

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(databaseUrl);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-obj-fld-del-fixture';
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
    workspace: { id: workspaceId },
    workspaceMemberId: actorMemberId,
  },
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
  const roleUidById = new Map<string, string>(
    roles.map((r) => [r.id, String(r.universalIdentifier)]),
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
      roleTargetUniversalIdentifiers: [],
      objectPermissionUniversalIdentifiers: [],
      fieldPermissionUniversalIdentifiers: [],
      rolePermissionFlagUniversalIdentifiers: [],
      rowLevelPermissionPredicateUniversalIdentifiers: [],
      rowLevelPermissionPredicateGroupUniversalIdentifiers: [],
      agentChatChannelRoleUniversalIdentifiers: [],
    });
  }

  const objects: Row[] = await owner.query(
    'SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const objUidById = new Map<string, string>(
    objects.map((o) => [o.id, String(o.universalIdentifier)]),
  );

  const fields: Row[] = await owner.query(
    'SELECT * FROM core."fieldMetadata" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const fieldUidById = new Map<string, string>(
    fields.map((f) => [f.id, String(f.universalIdentifier)]),
  );

  const flatObjectMetadataMaps = emptyMap();
  for (const obj of objects) {
    const objFields = fields.filter(
      (f) => String(f.objectMetadataId) === obj.id,
    );
    const labelFieldId = obj.labelIdentifierFieldMetadataId
      ? String(obj.labelIdentifierFieldMetadataId)
      : null;
    addEntityToMap(flatObjectMetadataMaps, {
      ...obj,
      universalIdentifier: String(obj.universalIdentifier),
      applicationId: String(obj.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(obj.applicationId),
      )!,
      labelIdentifierFieldMetadataUniversalIdentifier: labelFieldId
        ? (fieldUidById.get(labelFieldId) ?? null)
        : null,
      fieldIds: objFields.map((f) => f.id),
      fieldUniversalIdentifiers: objFields.map((f) =>
        String(f.universalIdentifier),
      ),
      indexMetadataIds: [],
      indexMetadataUniversalIdentifiers: [],
      viewIds: [],
      viewUniversalIdentifiers: [],
      searchFieldMetadataIds: [],
      searchFieldMetadataUniversalIdentifiers: [],
      pageLayoutIds: [],
      pageLayoutUniversalIdentifiers: [],
      commandMenuItemIds: [],
      commandMenuItemUniversalIdentifiers: [],
      navigationMenuItemIds: [],
      navigationMenuItemUniversalIdentifiers: [],
      objectPermissionIds: [],
      objectPermissionUniversalIdentifiers: [],
      fieldPermissionIds: [],
      fieldPermissionUniversalIdentifiers: [],
    });
  }

  const flatFieldMetadataMaps = emptyMap();
  for (const field of fields) {
    const relTargetObjId = field.relationTargetObjectMetadataId
      ? String(field.relationTargetObjectMetadataId)
      : null;
    const relTargetFieldId = field.relationTargetFieldMetadataId
      ? String(field.relationTargetFieldMetadataId)
      : null;
    addEntityToMap(flatFieldMetadataMaps, {
      ...field,
      universalIdentifier: String(field.universalIdentifier),
      applicationId: String(field.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(field.applicationId),
      )!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(field.objectMetadataId),
      )!,
      relationTargetObjectMetadataUniversalIdentifier: relTargetObjId
        ? (objUidById.get(relTargetObjId) ?? null)
        : null,
      relationTargetFieldMetadataUniversalIdentifier: relTargetFieldId
        ? (fieldUidById.get(relTargetFieldId) ?? null)
        : null,
      viewFieldIds: [],
      viewFieldUniversalIdentifiers: [],
      viewFilterIds: [],
      viewFilterUniversalIdentifiers: [],
      viewSortIds: [],
      viewSortUniversalIdentifiers: [],
      kanbanAggregateOperationViewIds: [],
      kanbanAggregateOperationViewUniversalIdentifiers: [],
      calendarViewIds: [],
      calendarViewUniversalIdentifiers: [],
      calendarEndViewIds: [],
      calendarEndViewUniversalIdentifiers: [],
      mainGroupByFieldMetadataViewIds: [],
      mainGroupByFieldMetadataViewUniversalIdentifiers: [],
      searchFieldMetadataIds: [],
      searchFieldMetadataUniversalIdentifiers: [],
      fieldPermissionIds: [],
      fieldPermissionUniversalIdentifiers: [],
    });
  }

  const objPerms: Row[] = await owner.query(
    'SELECT * FROM core."objectPermission" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatObjectPermissionMaps = emptyMap();
  for (const op of objPerms) {
    addEntityToMap(flatObjectPermissionMaps, {
      ...op,
      universalIdentifier: String(op.universalIdentifier),
      applicationId: String(op.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(op.applicationId))!,
      roleUniversalIdentifier: roleUidById.get(String(op.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(op.objectMetadataId),
      )!,
    });
  }

  const fieldPerms: Row[] = await owner.query(
    'SELECT * FROM core."fieldPermission" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatFieldPermissionMaps = emptyMap();
  for (const fp of fieldPerms) {
    addEntityToMap(flatFieldPermissionMaps, {
      ...fp,
      universalIdentifier: String(fp.universalIdentifier),
      applicationId: String(fp.applicationId),
      applicationUniversalIdentifier: appUidById.get(String(fp.applicationId))!,
      roleUniversalIdentifier: roleUidById.get(String(fp.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(fp.objectMetadataId),
      )!,
      fieldMetadataUniversalIdentifier: fieldUidById.get(
        String(fp.fieldMetadataId),
      )!,
    });
  }

  // Matches WorkspaceCacheRowsBatchLoader (withDeleted: true): soft-deleted rows are included in cache maps
  const groups: Row[] = await owner.query(
    'SELECT * FROM core."rowLevelPermissionPredicateGroup" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const groupUidById = new Map<string, string>(
    groups.map((g) => [g.id, String(g.universalIdentifier)]),
  );
  const flatRowLevelPermissionPredicateGroupMaps = emptyMap();
  for (const group of groups) {
    addEntityToMap(flatRowLevelPermissionPredicateGroupMaps, {
      ...group,
      universalIdentifier: String(group.universalIdentifier),
      applicationId: String(group.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(group.applicationId),
      )!,
      roleUniversalIdentifier: roleUidById.get(String(group.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(group.objectMetadataId),
      )!,
      parentRowLevelPermissionPredicateGroupUniversalIdentifier:
        group.parentRowLevelPermissionPredicateGroupId
          ? (groupUidById.get(
              String(group.parentRowLevelPermissionPredicateGroupId),
            ) ?? null)
          : null,
      childRowLevelPermissionPredicateGroupUniversalIdentifiers: [],
      rowLevelPermissionPredicateUniversalIdentifiers: [],
    });
  }

  const preds: Row[] = await owner.query(
    'SELECT * FROM core."rowLevelPermissionPredicate" WHERE "workspaceId"=$1 ORDER BY id',
    [wsId],
  );
  const flatRowLevelPermissionPredicateMaps = emptyMap();
  for (const pred of preds) {
    addEntityToMap(flatRowLevelPermissionPredicateMaps, {
      ...pred,
      universalIdentifier: String(pred.universalIdentifier),
      applicationId: String(pred.applicationId),
      applicationUniversalIdentifier: appUidById.get(
        String(pred.applicationId),
      )!,
      roleUniversalIdentifier: roleUidById.get(String(pred.roleId))!,
      objectMetadataUniversalIdentifier: objUidById.get(
        String(pred.objectMetadataId),
      )!,
      fieldMetadataUniversalIdentifier: fieldUidById.get(
        String(pred.fieldMetadataId),
      )!,
      workspaceMemberFieldMetadataUniversalIdentifier:
        pred.workspaceMemberFieldMetadataId
          ? (fieldUidById.get(String(pred.workspaceMemberFieldMetadataId)) ??
            null)
          : null,
      rowLevelPermissionPredicateGroupUniversalIdentifier:
        pred.rowLevelPermissionPredicateGroupId
          ? (groupUidById.get(
              String(pred.rowLevelPermissionPredicateGroupId),
            ) ?? null)
          : null,
    });
  }

  const base: Record<string, unknown> = {
    flatApplicationMaps,
    flatRoleMaps,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    flatObjectPermissionMaps,
    flatFieldPermissionMaps,
    flatRowLevelPermissionPredicateGroupMaps,
    flatRowLevelPermissionPredicateMaps,
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
    const m = action.metadataName;
    if (m === 'objectMetadata' && action.type === 'delete') {
      const id = resolveId(
        'flatObjectMetadataMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."objectMetadata" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    } else if (m === 'fieldMetadata' && action.type === 'delete') {
      const id = resolveId(
        'flatFieldMetadataMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."fieldMetadata" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    } else if (m === 'objectPermission' && action.type === 'delete') {
      const id = resolveId(
        'flatObjectPermissionMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."objectPermission" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    } else if (m === 'fieldPermission' && action.type === 'delete') {
      const id = resolveId(
        'flatFieldPermissionMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."fieldPermission" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    } else if (
      m === 'rowLevelPermissionPredicateGroup' &&
      action.type === 'delete'
    ) {
      const id = resolveId(
        'flatRowLevelPermissionPredicateGroupMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."rowLevelPermissionPredicateGroup" WHERE id=$1 AND "workspaceId"=$2',
        [id, wsId],
      );
    } else if (
      m === 'rowLevelPermissionPredicate' &&
      action.type === 'delete'
    ) {
      const id = resolveId(
        'flatRowLevelPermissionPredicateMaps',
        action.universalIdentifier,
      )!;
      await qr.query(
        'DELETE FROM core."rowLevelPermissionPredicate" WHERE id=$1 AND "workspaceId"=$2',
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

  const flatObjectPermissionValidator =
    new FlatObjectPermissionValidatorService();
  const flatFieldPermissionValidator =
    new FlatFieldPermissionValidatorService();

  const workspaceMigrationValidateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: wsId,
        applicationUniversalIdentifier,
      }: {
        allFlatEntityOperationByMetadataName: Record<
          string,
          | {
              flatEntityToCreate: Array<Record<string, unknown>>;
              flatEntityToDelete: Array<Record<string, unknown>>;
              flatEntityToUpdate: Array<Record<string, unknown>>;
            }
          | undefined
        >;
        workspaceId: string;
        applicationUniversalIdentifier: string;
      }) => {
        const currentMaps = (await loadAllMapsFromDb(wsId)) as Record<
          string,
          ReturnType<typeof emptyMap>
        >;
        const deletedObjUids = new Set(
          (
            allFlatEntityOperationByMetadataName.objectMetadata
              ?.flatEntityToDelete ?? []
          ).map((e) => String(e.universalIdentifier)),
        );
        const deletedFieldMap = new Map<string, Record<string, unknown>>();
        for (const f of allFlatEntityOperationByMetadataName.fieldMetadata
          ?.flatEntityToDelete ?? []) {
          deletedFieldMap.set(String(f.universalIdentifier), f);
        }
        for (const f of Object.values(
          currentMaps.flatFieldMetadataMaps.byUniversalIdentifier,
        )) {
          if (
            deletedObjUids.has(String(f.objectMetadataUniversalIdentifier)) ||
            (isDefined(f.relationTargetObjectMetadataUniversalIdentifier) &&
              deletedObjUids.has(
                String(f.relationTargetObjectMetadataUniversalIdentifier),
              ))
          ) {
            deletedFieldMap.set(String(f.universalIdentifier), f);
          }
        }
        for (const f of [...deletedFieldMap.values()]) {
          const morphId = f.morphId ? String(f.morphId) : null;
          const objUid = String(f.objectMetadataUniversalIdentifier);
          if (morphId && morphId !== String(f.universalIdentifier)) {
            const hasRemaining = Object.values(
              currentMaps.flatFieldMetadataMaps.byUniversalIdentifier,
            ).some(
              (other) =>
                !deletedFieldMap.has(String(other.universalIdentifier)) &&
                String(other.objectMetadataUniversalIdentifier) === objUid &&
                other.morphId === morphId &&
                String(other.universalIdentifier) !== morphId,
            );
            if (!hasRemaining) {
              const head =
                currentMaps.flatFieldMetadataMaps.byUniversalIdentifier[
                  morphId
                ];
              if (head) {
                deletedFieldMap.set(morphId, head);
              }
            }
          }
        }

        const optimisticObjectMaps = structuredClone(
          currentMaps.flatObjectMetadataMaps,
        );
        for (const uid of deletedObjUids) {
          const id = optimisticObjectMaps.idByUniversalIdentifier[uid];
          delete optimisticObjectMaps.byUniversalIdentifier[uid];
          delete optimisticObjectMaps.idByUniversalIdentifier[uid];
          if (id) {
            delete optimisticObjectMaps.byId[id];
            delete optimisticObjectMaps.universalIdentifierById[id];
          }
        }
        const optimisticFieldMaps = structuredClone(
          currentMaps.flatFieldMetadataMaps,
        );
        for (const uid of deletedFieldMap.keys()) {
          const id = optimisticFieldMaps.idByUniversalIdentifier[uid];
          delete optimisticFieldMaps.byUniversalIdentifier[uid];
          delete optimisticFieldMaps.idByUniversalIdentifier[uid];
          if (id) {
            delete optimisticFieldMaps.byId[id];
            delete optimisticFieldMaps.universalIdentifierById[id];
          }
        }

        for (const op of allFlatEntityOperationByMetadataName.objectPermission
          ?.flatEntityToDelete ?? []) {
          const v =
            flatObjectPermissionValidator.validateFlatObjectPermissionDeletion({
              flatEntityToValidate: op as never,
              optimisticFlatEntityMapsAndRelatedFlatEntityMaps: {
                flatObjectPermissionMaps: currentMaps.flatObjectPermissionMaps,
                flatRoleMaps: currentMaps.flatRoleMaps,
                flatObjectMetadataMaps: optimisticObjectMaps,
              } as never,
              remainingFlatEntityMapsToValidate: emptyMap() as never,
              buildOptions: {
                isSystemBuild: false,
                applicationUniversalIdentifier,
              },
              workspaceId: wsId,
              additionalCacheDataMaps: {} as never,
            });
          if (v.errors.length > 0) {
            return {
              status: 'fail' as const,
              report: { objectPermission: [v] },
            };
          }
        }

        for (const fp of allFlatEntityOperationByMetadataName.fieldPermission
          ?.flatEntityToDelete ?? []) {
          const v =
            flatFieldPermissionValidator.validateFlatFieldPermissionDeletion({
              flatEntityToValidate: fp as never,
              optimisticFlatEntityMapsAndRelatedFlatEntityMaps: {
                flatFieldPermissionMaps: currentMaps.flatFieldPermissionMaps,
                flatRoleMaps: currentMaps.flatRoleMaps,
                flatObjectMetadataMaps: optimisticObjectMaps,
                flatFieldMetadataMaps: optimisticFieldMaps,
              } as never,
              remainingFlatEntityMapsToValidate: emptyMap() as never,
              buildOptions: {
                isSystemBuild: false,
                applicationUniversalIdentifier,
              },
              workspaceId: wsId,
              additionalCacheDataMaps: {} as never,
            });
          if (v.errors.length > 0) {
            return {
              status: 'fail' as const,
              report: { fieldPermission: [v] },
            };
          }
        }

        const actions: Array<Record<string, unknown>> = [];
        for (const f of deletedFieldMap.values()) {
          actions.push({
            type: 'delete',
            metadataName: 'fieldMetadata',
            universalIdentifier: f.universalIdentifier,
          });
        }
        for (const uid of deletedObjUids) {
          actions.push({
            type: 'delete',
            metadataName: 'objectMetadata',
            universalIdentifier: uid,
          });
        }
        for (const metadataName of [
          'objectPermission',
          'fieldPermission',
          'rowLevelPermissionPredicate',
          'rowLevelPermissionPredicateGroup',
        ] as const) {
          for (const entity of allFlatEntityOperationByMetadataName[
            metadataName
          ]?.flatEntityToDelete ?? []) {
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
          workspaceMigration: {
            actions,
            applicationUniversalIdentifier,
          },
          hasSchemaMetadataChanged: true,
        };
      },
    ),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(
      async ({ workspaceId: wsId }: { workspaceId: string }) => {
        const maps = (await loadAllMapsFromDb(wsId)) as Record<
          string,
          ReturnType<typeof emptyMap>
        >;
        return {
          twentyStandardFlatApplication:
            maps.flatApplicationMaps.byId[standardAppId],
          workspaceCustomFlatApplication:
            maps.flatApplicationMaps.byId[customAppId],
        };
      },
    ),
  };

  const objectMetadataService = new ObjectMetadataService(
    {} as never,
    flatEntityMapsCacheService as never,
    workspaceMigrationValidateBuildAndRunService as never,
    workspaceCacheService as never,
    applicationService as never,
  );

  const fieldMetadataService = new FieldMetadataService(
    {} as never,
    flatEntityMapsCacheService as never,
    workspaceMigrationValidateBuildAndRunService as never,
    applicationService as never,
    workspaceCacheService as never,
  );

  const objectMetadataResolver = new ObjectMetadataResolver(
    objectMetadataService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const objectMetadataController = new ObjectMetadataController(
    {} as never,
    {} as never,
    objectMetadataService,
    { isFeatureEnabled: jest.fn(async () => true) } as never,
    {} as never,
    {} as never,
  );

  const deleteObjectMetadataTool = new DeleteObjectMetadataTool(
    objectMetadataService,
  );

  const fieldMetadataResolver = new FieldMetadataResolver(
    fieldMetadataService,
    {} as never,
    {} as never,
    {} as never,
  );

  const fieldMetadataController = new FieldMetadataController(
    {} as never,
    fieldMetadataService,
    { isFeatureEnabled: jest.fn(async () => true) } as never,
    {} as never,
    {} as never,
  );

  const deleteFieldMetadataTool = new DeleteFieldMetadataTool(
    fieldMetadataService,
  );

  return {
    runnerService,
    actionHandlerRegistry,
    workspaceCacheService,
    flatEntityMapsCacheService,
    flatObjectPermissionValidator,
    flatFieldPermissionValidator,
    objectMetadataService,
    objectMetadataResolver,
    objectMetadataController,
    deleteObjectMetadataTool,
    fieldMetadataService,
    fieldMetadataResolver,
    fieldMetadataController,
    deleteFieldMetadataTool,
  };
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.query(`
    CREATE TABLE core.workspace (
      id uuid PRIMARY KEY,
      "displayName" text NULL,
      subdomain text NULL,
      "databaseSchema" text NULL,
      "defaultRoleId" uuid NULL,
      "activationStatus" text NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.application (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL,
      "defaultRoleId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core.role (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      label text NOT NULL,
      description text NULL,
      icon text NULL,
      "isEditable" boolean NOT NULL DEFAULT true,
      "canUpdateAllSettings" boolean NOT NULL DEFAULT false,
      "canAccessAllTools" boolean NOT NULL DEFAULT false,
      "canAccessAllAgentChatChannels" boolean NOT NULL DEFAULT false,
      "canReadAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canUpdateAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canSoftDeleteAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canDestroyAllObjectRecords" boolean NOT NULL DEFAULT false,
      "canBeAssignedToUsers" boolean NOT NULL DEFAULT true,
      "canBeAssignedToAgents" boolean NOT NULL DEFAULT true,
      "canBeAssignedToApiKeys" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core.agent (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      name text NOT NULL,
      label text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."roleTarget" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "agentId" uuid NULL REFERENCES core.agent(id) ON DELETE CASCADE,
      "userWorkspaceId" uuid NULL,
      "apiKeyId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."permissionFlag" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      key text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."rolePermissionFlag" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "permissionFlagId" uuid NOT NULL REFERENCES core."permissionFlag"(id) ON DELETE CASCADE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."objectMetadata" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "nameSingular" text NOT NULL,
      "namePlural" text NOT NULL,
      "labelSingular" text NOT NULL DEFAULT 'Object',
      "labelPlural" text NOT NULL DEFAULT 'Objects',
      "isSystem" boolean NOT NULL DEFAULT false,
      "isCustom" boolean NOT NULL DEFAULT true,
      "isActive" boolean NOT NULL DEFAULT true,
      "labelIdentifierFieldMetadataId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."fieldMetadata" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      name text NOT NULL,
      label text NOT NULL DEFAULT 'Field',
      type text NOT NULL DEFAULT 'TEXT',
      "isSystem" boolean NOT NULL DEFAULT false,
      "isCustom" boolean NOT NULL DEFAULT true,
      "isActive" boolean NOT NULL DEFAULT true,
      "isSystemSideEffect" boolean NOT NULL DEFAULT false,
      "relationTargetObjectMetadataId" uuid NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "relationTargetFieldMetadataId" uuid NULL,
      "morphId" uuid NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."objectPermission" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "canReadObjectRecords" boolean NULL,
      "canUpdateObjectRecords" boolean NULL,
      "canSoftDeleteObjectRecords" boolean NULL,
      "canDestroyObjectRecords" boolean NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."fieldPermission" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
      "canReadFieldValue" boolean NULL,
      "canUpdateFieldValue" boolean NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE core."rowLevelPermissionPredicateGroup" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "parentRowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
      "logicalOperator" text NOT NULL DEFAULT 'AND',
      "positionInRowLevelPermissionPredicateGroup" double precision NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."rowLevelPermissionPredicate" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "applicationId" uuid NOT NULL REFERENCES core.application(id) ON DELETE CASCADE,
      "universalIdentifier" uuid NOT NULL,
      "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
      "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
      "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
      operand text NOT NULL DEFAULT 'CONTAINS',
      value jsonb NULL,
      "subFieldName" text NULL,
      "workspaceMemberFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE SET NULL,
      "workspaceMemberSubFieldName" text NULL,
      "rowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
      "positionInRowLevelPermissionPredicateGroup" double precision NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz NULL
    );
    CREATE TABLE core."userWorkspace" (
      id uuid PRIMARY KEY,
      "workspaceId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "deletedAt" timestamptz NULL
    );
  `);
  await owner.query(
    `INSERT INTO core.workspace (id, "displayName", subdomain, "databaseSchema", "activationStatus")
     VALUES ($1, 'Acme', 'acme', 'workspace_acme', $2)`,
    [workspaceId, WorkspaceActivationStatus.ACTIVE],
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-obj-fld-del-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}";
     GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}";
     GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtime.initialize();
  i18n.load('en', {});
  i18n.activate('en');
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(
    `TRUNCATE
      core."rowLevelPermissionPredicate",
      core."rowLevelPermissionPredicateGroup",
      core."fieldPermission",
      core."objectPermission",
      core."rolePermissionFlag",
      core."permissionFlag",
      core."roleTarget",
      core.agent,
      core.role,
      core."fieldMetadata",
      core."objectMetadata",
      core.application,
      core."userWorkspace",
      crm_audit."crmAuditEntry"`,
  );
  await owner.query(
    'UPDATE core.workspace SET "defaultRoleId"=NULL, "deletedAt"=NULL WHERE id=$1',
    [workspaceId],
  );
  await owner.query(
    `INSERT INTO core.application (id, "workspaceId", "universalIdentifier", name, "defaultRoleId") VALUES
      ($1, $2, $3, 'Twenty Standard', NULL),
      ($4, $2, $5, 'Workspace Custom', NULL),
      ($6, $2, $7, 'Third Party App', NULL)`,
    [
      standardAppId,
      workspaceId,
      TWENTY_STANDARD_APPLICATION.universalIdentifier,
      customAppId,
      customAppUniversalId,
      thirdPartyAppId,
      thirdPartyAppUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core.role (id, "workspaceId", "applicationId", "universalIdentifier", label, "isEditable") VALUES
      ($1, $2, $3, $4, 'Custom Sales Role', true),
      ($5, $2, $6, $7, 'System Member Role', false)`,
    [
      editableRoleId,
      workspaceId,
      customAppId,
      editableRoleUniversalId,
      nonEditableRoleId,
      standardAppId,
      nonEditableRoleUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "isSystem") VALUES
      ($1, $2, $3, $4, 'company', 'companies', false),
      ($5, $2, $3, $6, 'workspaceMember', 'workspaceMembers', true)`,
    [
      companyObjectId,
      workspaceId,
      standardAppId,
      companyObjectUniversalId,
      workspaceMemberObjectId,
      workspaceMemberObjectUniversalId,
    ],
  );
  await owner.query(
    `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type, "isSystem")
     VALUES ($1, $2, $3, $4, $5, 'name', $6, false)`,
    [
      companyNameFieldId,
      workspaceId,
      standardAppId,
      companyNameFieldUniversalId,
      companyObjectId,
      FieldMetadataType.TEXT,
    ],
  );
  await owner.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt")
     VALUES ($1, $2, $3, NULL)`,
    [impersonatorUserWorkspaceId, workspaceId, impersonatorUserId],
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

describe('Standalone ObjectMetadataService and FieldMetadataService deletion permission CRM audit (LOG166)', () => {
  it('audits objectPermission, fieldPermission, nested rowLevelPermissionPredicateGroup, and rowLevelPermissionPredicate cascades across editable and non-editable roles on ObjectMetadataService.deleteOneObject (resolver, controller, AI tool)', async () => {
    const {
      objectMetadataResolver,
      objectMetadataController,
      deleteObjectMetadataTool,
      workspaceCacheService,
    } = buildHarness();

    const dealObjId = randomUUID();
    const dealObjUid = randomUUID();
    const dealAmountFieldId = randomUUID();
    const dealAmountFieldUid = randomUUID();
    const dealToCompanyFieldId = randomUUID();
    const dealToCompanyFieldUid = randomUUID();
    const companyToDealFieldId = randomUUID();
    const companyToDealFieldUid = randomUUID();
    const dealSystemFieldId = randomUUID();
    const dealSystemFieldUid = randomUUID();

    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "isSystem")
       VALUES ($1, $2, $3, $4, 'customDeal', 'customDeals', false)`,
      [dealObjId, workspaceId, customAppId, dealObjUid],
    );
    await owner.query(
      `INSERT INTO core."fieldMetadata" (
        id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type,
        "isSystemSideEffect", "relationTargetObjectMetadataId", "relationTargetFieldMetadataId"
      ) VALUES
        ($1, $2, $3, $4, $5, 'amount', $6, false, NULL, NULL),
        ($7, $2, $3, $8, $5, 'company', $9, false, $10, $11),
        ($11, $2, $3, $12, $10, 'customDeals', $9, false, $5, $7),
        ($13, $2, $3, $14, $5, 'searchVector', $6, true, NULL, NULL)`,
      [
        dealAmountFieldId,
        workspaceId,
        customAppId,
        dealAmountFieldUid,
        dealObjId,
        FieldMetadataType.TEXT,
        dealToCompanyFieldId,
        dealToCompanyFieldUid,
        FieldMetadataType.RELATION,
        companyObjectId,
        companyToDealFieldId,
        companyToDealFieldUid,
        dealSystemFieldId,
        dealSystemFieldUid,
      ],
    );

    const editObjPermId = randomUUID();
    const nonEditObjPermId = randomUUID();
    const dealFieldPermId = randomUUID();
    const reverseFieldPermId = randomUUID();
    const systemFieldPermId = randomUUID();
    const parentGroupId = randomUUID();
    const childGroupId = randomUUID();
    const predId = randomUUID();

    await owner.query(
      `INSERT INTO core."objectPermission" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId",
        "canReadObjectRecords", "canUpdateObjectRecords", "canSoftDeleteObjectRecords", "canDestroyObjectRecords"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, true, true, false, false),
        ($7, $2, $8, $9, $10, $6, true, false, false, false)`,
      [
        editObjPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        dealObjId,
        nonEditObjPermId,
        standardAppId,
        randomUUID(),
        nonEditableRoleId,
      ],
    );
    await owner.query(
      `INSERT INTO core."fieldPermission" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        "canReadFieldValue", "canUpdateFieldValue"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, $7, true, false),
        ($8, $2, $9, $10, $11, $12, $13, true, false),
        ($14, $2, $3, $15, $5, $6, $16, false, false)`,
      [
        dealFieldPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        dealObjId,
        dealAmountFieldId,
        reverseFieldPermId,
        standardAppId,
        randomUUID(),
        nonEditableRoleId,
        companyObjectId,
        companyToDealFieldId,
        systemFieldPermId,
        randomUUID(),
        dealSystemFieldId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId",
        "parentRowLevelPermissionPredicateGroupId", "logicalOperator", "positionInRowLevelPermissionPredicateGroup"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, NULL, $7, 0),
        ($8, $2, $9, $10, $5, $6, $1, $11, 1)`,
      [
        parentGroupId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        dealObjId,
        RowLevelPermissionPredicateGroupLogicalOperator.AND,
        childGroupId,
        thirdPartyAppId,
        randomUUID(),
        RowLevelPermissionPredicateGroupLogicalOperator.OR,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        operand, value, "rowLevelPermissionPredicateGroupId", "positionInRowLevelPermissionPredicateGroup"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 0)`,
      [
        predId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        dealObjId,
        dealAmountFieldId,
        RowLevelPermissionPredicateOperand.CONTAINS,
        JSON.stringify('confidential-deal-secret'),
        childGroupId,
      ],
    );

    await objectMetadataResolver.deleteOneObject(
      { id: dealObjId },
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: actorUserId },
          userWorkspaceId: randomUUID(),
          workspaceMemberId: actorMemberId,
          impersonationContext: { impersonatorUserWorkspaceId },
        },
      },
    );

    const entries = await audits();
    expect(entries).toHaveLength(8);
    const opIds = new Set(entries.map((e) => e.operationId));
    expect(opIds.size).toBe(1);
    for (const entry of entries) {
      expect(entry.actor).toEqual({
        kind: 'workspaceMember',
        id: actorMemberId,
      });
      expect(entry.initiator).toEqual({
        kind: 'coreUser',
        id: impersonatorUserId,
      });
      expect(entry.action).toBe('delete');
      expect(JSON.stringify(entry.redactedDiff)).not.toContain(
        'confidential-deal-secret',
      );
    }

    const byKindAndId = new Map(
      entries.map((e) => [`${e.resourceKind}:${e.resourceId}`, e]),
    );
    expect(byKindAndId.has(`objectPermission:${editObjPermId}`)).toBe(true);
    expect(byKindAndId.has(`objectPermission:${nonEditObjPermId}`)).toBe(true);
    expect(byKindAndId.has(`fieldPermission:${dealFieldPermId}`)).toBe(true);
    expect(byKindAndId.has(`fieldPermission:${reverseFieldPermId}`)).toBe(true);
    expect(byKindAndId.has(`fieldPermission:${systemFieldPermId}`)).toBe(true);
    expect(
      byKindAndId.has(`rowLevelPermissionPredicateGroup:${parentGroupId}`),
    ).toBe(true);
    expect(
      byKindAndId.has(`rowLevelPermissionPredicateGroup:${childGroupId}`),
    ).toBe(true);
    const predEntry = byKindAndId.get(`rowLevelPermissionPredicate:${predId}`)!;
    expect(predEntry).toBeDefined();
    expect(
      (
        predEntry.redactedDiff as {
          changedFields: string[];
          values: Record<string, unknown>;
        }
      ).changedFields,
    ).toContain('value');
    expect(
      (
        predEntry.redactedDiff as {
          values: Record<string, unknown>;
        }
      ).values.value,
    ).toBeUndefined();

    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining([
        'flatObjectPermissionMaps',
        'flatFieldPermissionMaps',
        'flatRowLevelPermissionPredicateGroupMaps',
        'flatRowLevelPermissionPredicateMaps',
        'rolesPermissions',
      ]),
    );

    // Controller and AI tool paths
    const objTwoId = randomUUID();
    const objThreeId = randomUUID();
    const objTwoPermId = randomUUID();
    const objThreePermId = randomUUID();
    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "isSystem") VALUES
        ($1, $2, $3, $4, 'quoteObj', 'quoteObjs', false),
        ($5, $2, $3, $6, 'invoiceObj', 'invoiceObjs', false)`,
      [
        objTwoId,
        workspaceId,
        customAppId,
        randomUUID(),
        objThreeId,
        randomUUID(),
      ],
    );
    await owner.query(
      `INSERT INTO core."objectPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "canReadObjectRecords") VALUES
        ($1, $2, $3, $4, $5, $6, true),
        ($7, $2, $3, $8, $5, $9, true)`,
      [
        objTwoPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        objTwoId,
        objThreePermId,
        randomUUID(),
        objThreeId,
      ],
    );

    await objectMetadataController.deleteOne(
      objTwoId,
      { id: workspaceId } as never,
      {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: randomUUID(),
        workspaceMemberId: actorMemberId,
      } as never,
    );

    await deleteObjectMetadataTool.execute({
      input: { id: objThreeId },
      context: {
        workspaceId,
        agentId: callingAgentId,
        authContext: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: actorMemberId,
        } as never,
      } as never,
    });

    const allEntries = await audits();
    expect(allEntries).toHaveLength(10);
    const toolEntry = allEntries.find((e) => e.resourceId === objThreePermId)!;
    expect(toolEntry.actor).toEqual({ kind: 'agent', id: callingAgentId });
    expect(toolEntry.initiator).toEqual({
      kind: 'workspaceMember',
      id: actorMemberId,
    });
  });

  it('audits fieldPermission and rowLevelPermissionPredicate cascades across paired relation fields and multi-target MORPH_RELATION fields (including morph head and second target reverse field) on FieldMetadataService.deleteOneField', async () => {
    const {
      fieldMetadataResolver,
      fieldMetadataController,
      deleteFieldMetadataTool,
    } = buildHarness();

    const targetObjTwoId = randomUUID();
    const targetObjTwoUid = randomUUID();
    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "isSystem")
       VALUES ($1, $2, $3, $4, 'partnerOrg', 'partnerOrgs', false)`,
      [targetObjTwoId, workspaceId, customAppId, targetObjTwoUid],
    );

    const morphHeadId = randomUUID();
    const morphHeadUid = randomUUID();
    const morphTargetOneId = randomUUID();
    const morphTargetOneUid = randomUUID();
    const morphTargetTwoId = randomUUID();
    const morphTargetTwoUid = randomUUID();
    const reverseOneId = randomUUID();
    const reverseOneUid = randomUUID();
    const reverseTwoId = randomUUID();
    const reverseTwoUid = randomUUID();

    await owner.query(
      `INSERT INTO core."fieldMetadata" (
        id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type,
        "isSystemSideEffect", "relationTargetObjectMetadataId", "relationTargetFieldMetadataId", "morphId"
      ) VALUES
        ($1, $2, $3, $4, $5, 'ownerRef', $6, true, NULL, NULL, $4),
        ($7, $2, $3, $8, $5, 'ownerRefCompany', $6, false, $5, $9, $4),
        ($9, $2, $3, $10, $5, 'companyOwnerRefs', $11, false, $5, $7, NULL),
        ($12, $2, $3, $13, $5, 'ownerRefPartner', $6, false, $14, $15, $4),
        ($15, $2, $3, $16, $14, 'partnerOwnerRefs', $11, false, $5, $12, NULL)`,
      [
        morphHeadId,
        workspaceId,
        customAppId,
        morphHeadUid,
        companyObjectId,
        FieldMetadataType.MORPH_RELATION,
        morphTargetOneId,
        morphTargetOneUid,
        reverseOneId,
        reverseOneUid,
        FieldMetadataType.RELATION,
        morphTargetTwoId,
        morphTargetTwoUid,
        targetObjTwoId,
        reverseTwoId,
        reverseTwoUid,
      ],
    );

    const fpTargetOneId = randomUUID();
    const fpHeadNonEditableId = randomUUID();
    const fpReverseTwoId = randomUUID();
    const predReverseTwoId = randomUUID();

    await owner.query(
      `INSERT INTO core."fieldPermission" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        "canReadFieldValue", "canUpdateFieldValue"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, $7, true, false),
        ($8, $2, $9, $10, $11, $6, $12, false, false),
        ($13, $2, $3, $14, $5, $15, $16, true, true)`,
      [
        fpTargetOneId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        companyObjectId,
        morphTargetOneId,
        fpHeadNonEditableId,
        standardAppId,
        randomUUID(),
        nonEditableRoleId,
        morphHeadId,
        fpReverseTwoId,
        randomUUID(),
        targetObjTwoId,
        reverseTwoId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        operand, value
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        predReverseTwoId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        targetObjTwoId,
        reverseTwoId,
        RowLevelPermissionPredicateOperand.IS,
        JSON.stringify('secret-morph-target-2'),
      ],
    );

    await fieldMetadataResolver.deleteOneField(
      { id: morphTargetOneId },
      { id: workspaceId } as never,
      {
        req: {
          workspace: { id: workspaceId },
          user: { id: actorUserId },
          userWorkspaceId: randomUUID(),
          workspaceMemberId: actorMemberId,
        },
      },
    );

    const entries = await audits();
    expect(entries).toHaveLength(4);
    const ids = new Set(
      entries.map((e) => `${e.resourceKind}:${e.resourceId}`),
    );
    expect(ids).toEqual(
      new Set([
        `fieldPermission:${fpTargetOneId}`,
        `fieldPermission:${fpHeadNonEditableId}`,
        `fieldPermission:${fpReverseTwoId}`,
        `rowLevelPermissionPredicate:${predReverseTwoId}`,
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain('secret-morph-target-2');

    // Controller and AI tool field deletions
    const fieldAId = randomUUID();
    const fieldBId = randomUUID();
    const fpAId = randomUUID();
    const fpBId = randomUUID();
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type) VALUES
        ($1, $2, $3, $4, $5, 'customCodeA', $6),
        ($7, $2, $3, $8, $5, 'customCodeB', $6)`,
      [
        fieldAId,
        workspaceId,
        customAppId,
        randomUUID(),
        companyObjectId,
        FieldMetadataType.TEXT,
        fieldBId,
        randomUUID(),
      ],
    );
    await owner.query(
      `INSERT INTO core."fieldPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId", "canReadFieldValue") VALUES
        ($1, $2, $3, $4, $5, $6, $7, true),
        ($8, $2, $3, $9, $5, $6, $10, true)`,
      [
        fpAId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        companyObjectId,
        fieldAId,
        fpBId,
        randomUUID(),
        fieldBId,
      ],
    );

    await fieldMetadataController.deleteOne(
      fieldAId,
      { id: workspaceId } as never,
      {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: randomUUID(),
        workspaceMemberId: actorMemberId,
      } as never,
    );

    await deleteFieldMetadataTool.execute({
      input: { id: fieldBId },
      context: {
        workspaceId,
        agentId: callingAgentId,
        authContext: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: actorMemberId,
        } as never,
      } as never,
    });

    const allEntries = await audits();
    expect(allEntries).toHaveLength(6);
    const toolFieldEntry = allEntries.find((e) => e.resourceId === fpBId)!;
    expect(toolFieldEntry.actor).toEqual({ kind: 'agent', id: callingAgentId });
  });

  it('audits rowLevelPermissionPredicate ON DELETE SET NULL on workspaceMemberFieldMetadataId and invalidates flatRowLevelPermissionPredicateMaps and rolesPermissions on FieldMetadataService.deleteOneField', async () => {
    const { fieldMetadataService, workspaceCacheService } = buildHarness();

    const memberCustomFieldId = randomUUID();
    const memberCustomFieldUid = randomUUID();
    const predId = randomUUID();

    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, $5, 'regionCode', $6)`,
      [
        memberCustomFieldId,
        workspaceId,
        customAppId,
        memberCustomFieldUid,
        workspaceMemberObjectId,
        FieldMetadataType.TEXT,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        operand, value, "workspaceMemberFieldMetadataId", "workspaceMemberSubFieldName"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NULL)`,
      [
        predId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        companyObjectId,
        companyNameFieldId,
        RowLevelPermissionPredicateOperand.IS,
        JSON.stringify('fallback-secret-token'),
        memberCustomFieldId,
      ],
    );

    workspaceCacheService.invalidateAndRecompute.mockClear();

    await fieldMetadataService.deleteOneField({
      deleteOneFieldInput: { id: memberCustomFieldId },
      workspaceId,
      auditIdentity: userIdentity(),
    });

    const [survivingPred] = await owner.query(
      'SELECT "workspaceMemberFieldMetadataId" FROM core."rowLevelPermissionPredicate" WHERE id=$1',
      [predId],
    );
    expect(survivingPred).toEqual({ workspaceMemberFieldMetadataId: null });

    const entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'rowLevelPermissionPredicate',
      resourceId: predId,
      action: 'update',
      redactedDiff: {
        changedFields: ['workspaceMemberFieldMetadataId'],
        values: {
          workspaceMemberFieldMetadataId: {
            before: memberCustomFieldId,
            after: null,
          },
        },
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain('fallback-secret-token');

    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining([
        'flatRowLevelPermissionPredicateMaps',
        'rolesPermissions',
      ]),
    );
  });

  it('audits concurrently inserted permission rows, handles zero-permission object/field deletes without spurious audit entries, and audits isSystemBuild object deletes with default system actor', async () => {
    const {
      objectMetadataService,
      fieldMetadataService,
      actionHandlerRegistry,
    } = buildHarness();

    // 1. Zero-permission field and object deletes produce 0 audit entries
    const cleanObjId = randomUUID();
    const cleanFieldId = randomUUID();
    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural")
       VALUES ($1, $2, $3, $4, 'cleanObject', 'cleanObjects')`,
      [cleanObjId, workspaceId, customAppId, randomUUID()],
    );
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, $5, 'cleanField', $6)`,
      [
        cleanFieldId,
        workspaceId,
        customAppId,
        randomUUID(),
        cleanObjId,
        FieldMetadataType.TEXT,
      ],
    );

    const request = captureCrmAuditRequest({
      workspace: { id: workspaceId },
      user: { id: actorUserId },
    });
    await withCrmAuditRequest(request, async () => {
      await fieldMetadataService.deleteOneField({
        deleteOneFieldInput: { id: cleanFieldId },
        workspaceId,
      });
      await objectMetadataService.deleteOneObject({
        deleteObjectInput: { id: cleanObjId },
        workspaceId,
      });
    });
    expect(await audits()).toHaveLength(0);

    // 2. System build object delete (like DropFavoriteObjectsCommand) with a concurrently present permission row
    const legacyStandardObjId = randomUUID();
    const legacyObjPermId = randomUUID();
    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural", "isSystem")
       VALUES ($1, $2, $3, $4, 'favorite', 'favorites', true)`,
      [legacyStandardObjId, workspaceId, standardAppId, randomUUID()],
    );

    // Insert permission row AFTER cache read (inside first getOrRecompute call) to simulate TOCTOU before FOR UPDATE lock
    let injected = false;
    const origExecute =
      actionHandlerRegistry.executeActionHandler.getMockImplementation()!;
    await owner.query(
      `INSERT INTO core."objectPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "canReadObjectRecords")
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        legacyObjPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        legacyStandardObjId,
      ],
    );
    actionHandlerRegistry.executeActionHandler.mockImplementation(
      async (args) => {
        injected = true;
        return origExecute(args);
      },
    );

    await objectMetadataService.deleteOneObject({
      deleteObjectInput: { id: legacyStandardObjId },
      workspaceId,
      isSystemBuild: true,
      ownerFlatApplication: {
        id: standardAppId,
        universalIdentifier: TWENTY_STANDARD_APPLICATION.universalIdentifier,
      } as never,
    });
    expect(injected).toBe(true);

    const entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceKind: 'objectPermission',
      resourceId: legacyObjPermId,
      action: 'delete',
      actor: {
        kind: 'system',
        id: 'object-metadata:system-delete',
      },
    });

    // 3. Background job identity via withCrmAuditIdentity
    const jobFieldId = randomUUID();
    const jobFieldPermId = randomUUID();
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, $5, 'jobField', $6)`,
      [
        jobFieldId,
        workspaceId,
        customAppId,
        randomUUID(),
        companyObjectId,
        FieldMetadataType.TEXT,
      ],
    );
    await owner.query(
      `INSERT INTO core."fieldPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId", "canReadFieldValue")
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        jobFieldPermId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        companyObjectId,
        jobFieldId,
      ],
    );

    await withCrmAuditIdentity(
      workspaceId,
      systemMembershipCleanupIdentity(workspaceId, 'metadata-cleanup:job'),
      () =>
        fieldMetadataService.deleteOneField({
          deleteOneFieldInput: { id: jobFieldId },
          workspaceId,
        }),
    );

    const afterJobEntries = await audits();
    expect(afterJobEntries).toHaveLength(2);
    expect(afterJobEntries[1]).toMatchObject({
      resourceKind: 'fieldPermission',
      resourceId: jobFieldPermId,
      action: 'delete',
      actor: { kind: 'system', id: 'metadata-cleanup:job' },
    });
  });

  it('enforces fail-closed invariants on unauthenticated callers, unaudited runner deletes, soft-deleted RLP rows in withDeleted cache, standalone ROLE_NOT_EDITABLE, and unauthorized actions in objectDelete/fieldDelete modes', async () => {
    const {
      runnerService,
      objectMetadataService,
      fieldMetadataService,
      flatEntityMapsCacheService,
      flatObjectPermissionValidator,
      flatFieldPermissionValidator,
    } = buildHarness();

    const guardedObjId = randomUUID();
    const guardedObjUid = randomUUID();
    const guardedFieldId = randomUUID();
    const guardedFieldUid = randomUUID();
    const memberFieldId = randomUUID();
    const memberFieldUid = randomUUID();

    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural")
       VALUES ($1, $2, $3, $4, 'guardedObj', 'guardedObjs')`,
      [guardedObjId, workspaceId, customAppId, guardedObjUid],
    );
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type) VALUES
        ($1, $2, $3, $4, $5, 'guardedField', $6),
        ($7, $2, $3, $8, $9, 'guardedMemberField', $6)`,
      [
        guardedFieldId,
        workspaceId,
        customAppId,
        guardedFieldUid,
        guardedObjId,
        FieldMetadataType.TEXT,
        memberFieldId,
        memberFieldUid,
        workspaceMemberObjectId,
      ],
    );

    // 1. Unauthenticated deleteOneObject / deleteOneField rejected before reading cache
    flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps.mockClear();
    await expect(
      objectMetadataService.deleteOneObject({
        deleteObjectInput: { id: guardedObjId },
        workspaceId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    await expect(
      fieldMetadataService.deleteOneField({
        deleteOneFieldInput: { id: guardedFieldId },
        workspaceId,
      }),
    ).rejects.toThrow('Role mutation requires authenticated audit identity');
    expect(
      flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps,
    ).not.toHaveBeenCalled();

    // 2. Unaudited runner rejects objectMetadata.delete, fieldMetadata.delete, permissionFlag.delete, agent.delete
    for (const metadataName of [
      'objectMetadata',
      'fieldMetadata',
      'permissionFlag',
      'agent',
    ] as const) {
      await expect(
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: customAppUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName,
                universalIdentifier: randomUUID(),
              },
            ],
          } as never,
        }),
      ).rejects.toThrow(
        'Workspace migration touching role or permission metadata requires an active CRM audit scope',
      );
    }

    // 3. Standalone ROLE_NOT_EDITABLE preserved when target object and field still exist
    const nonEditObjPermUid = randomUUID();
    const nonEditFieldPermUid = randomUUID();
    await owner.query(
      `INSERT INTO core."objectPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "canReadObjectRecords")
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        randomUUID(),
        workspaceId,
        standardAppId,
        nonEditObjPermUid,
        nonEditableRoleId,
        guardedObjId,
      ],
    );
    await owner.query(
      `INSERT INTO core."fieldPermission" (id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId", "canReadFieldValue")
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        randomUUID(),
        workspaceId,
        standardAppId,
        nonEditFieldPermUid,
        nonEditableRoleId,
        guardedObjId,
        guardedFieldId,
      ],
    );
    const currentMaps = (await loadAllMapsFromDb(workspaceId)) as Record<
      string,
      ReturnType<typeof emptyMap>
    >;
    const objPermValidation =
      flatObjectPermissionValidator.validateFlatObjectPermissionDeletion({
        flatEntityToValidate: {
          universalIdentifier: nonEditObjPermUid,
        } as never,
        optimisticFlatEntityMapsAndRelatedFlatEntityMaps: {
          flatObjectPermissionMaps: currentMaps.flatObjectPermissionMaps,
          flatRoleMaps: currentMaps.flatRoleMaps,
          flatObjectMetadataMaps: currentMaps.flatObjectMetadataMaps,
        } as never,
        remainingFlatEntityMapsToValidate: emptyMap() as never,
        buildOptions: {
          isSystemBuild: false,
          applicationUniversalIdentifier: customAppUniversalId,
        },
        workspaceId,
        additionalCacheDataMaps: {} as never,
      });
    expect(objPermValidation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: PermissionsExceptionCode.ROLE_NOT_EDITABLE,
        }),
      ]),
    );
    const fieldPermValidation =
      flatFieldPermissionValidator.validateFlatFieldPermissionDeletion({
        flatEntityToValidate: {
          universalIdentifier: nonEditFieldPermUid,
        } as never,
        optimisticFlatEntityMapsAndRelatedFlatEntityMaps: {
          flatFieldPermissionMaps: currentMaps.flatFieldPermissionMaps,
          flatRoleMaps: currentMaps.flatRoleMaps,
          flatObjectMetadataMaps: currentMaps.flatObjectMetadataMaps,
          flatFieldMetadataMaps: currentMaps.flatFieldMetadataMaps,
        } as never,
        remainingFlatEntityMapsToValidate: emptyMap() as never,
        buildOptions: {
          isSystemBuild: false,
          applicationUniversalIdentifier: customAppUniversalId,
        },
        workspaceId,
        additionalCacheDataMaps: {} as never,
      });
    expect(fieldPermValidation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: PermissionsExceptionCode.ROLE_NOT_EDITABLE,
        }),
      ]),
    );

    // 4. Soft-deleted rowLevelPermissionPredicate / Group in DB and withDeleted cache rejects deleteOneObject and deleteOneField (including ON DELETE SET NULL on workspaceMemberFieldMetadataId)
    const softDeletedGroupId = randomUUID();
    const softDeletedPredId = randomUUID();
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "deletedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        softDeletedGroupId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        guardedObjId,
      ],
    );
    await expect(
      objectMetadataService.deleteOneObject({
        deleteObjectInput: { id: guardedObjId },
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
    );
    await owner.query(
      'DELETE FROM core."rowLevelPermissionPredicateGroup" WHERE id=$1',
      [softDeletedGroupId],
    );

    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId", "fieldMetadataId",
        "workspaceMemberFieldMetadataId", "deletedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        softDeletedPredId,
        workspaceId,
        customAppId,
        randomUUID(),
        editableRoleId,
        companyObjectId,
        companyNameFieldId,
        memberFieldId,
      ],
    );
    await expect(
      fieldMetadataService.deleteOneField({
        deleteOneFieldInput: { id: memberFieldId },
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toThrow(
      'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows',
    );
    await owner.query(
      'DELETE FROM core."rowLevelPermissionPredicate" WHERE id=$1',
      [softDeletedPredId],
    );

    // 5. Cross-application non-cascaded rowLevelPermissionPredicateGroup deletion rejected
    const thirdPartyGroupId = randomUUID();
    const thirdPartyGroupUid = randomUUID();
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (
        id, "workspaceId", "applicationId", "universalIdentifier", "roleId", "objectMetadataId"
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        thirdPartyGroupId,
        workspaceId,
        thirdPartyAppId,
        thirdPartyGroupUid,
        editableRoleId,
        companyObjectId,
      ],
    );
    const op = captureApplicationMetadataAuditOperation({
      workspaceId,
      auditIdentity: userIdentity(),
      mode: 'objectDelete',
      expectedDeletedObjectIds: [guardedObjId],
    });
    const req = bindApplicationMetadataAuditOperation(op, {
      applicationId: customAppId,
      applicationUniversalIdentifier: customAppUniversalId,
    });
    await expect(
      withApplicationMetadataAudit(req, () =>
        runnerService.run({
          workspaceId,
          workspaceMigration: {
            applicationUniversalIdentifier: customAppUniversalId,
            actions: [
              {
                type: 'delete',
                metadataName: 'fieldMetadata',
                universalIdentifier: guardedFieldUid,
              },
              {
                type: 'delete',
                metadataName: 'objectMetadata',
                universalIdentifier: guardedObjUid,
              },
              {
                type: 'delete',
                metadataName: 'rowLevelPermissionPredicateGroup',
                universalIdentifier: thirdPartyGroupUid,
              },
            ],
          } as never,
        }),
      ),
    ).rejects.toThrow(
      'Application metadata audit cannot delete another application rowLevelPermissionPredicateGroup without parent cascade',
    );

    expect(await audits()).toHaveLength(0);
  });

  it('propagates NativeTransactionOutcomeUnknownError and CoreAuditPostCommitError without running rollback handlers and still invalidates cache', async () => {
    const {
      objectMetadataService,
      fieldMetadataService,
      actionHandlerRegistry,
      workspaceCacheService,
    } = buildHarness();

    const objId = randomUUID();
    const fieldId = randomUUID();
    await owner.query(
      `INSERT INTO core."objectMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "nameSingular", "namePlural")
       VALUES ($1, $2, $3, $4, 'errObj', 'errObjs')`,
      [objId, workspaceId, customAppId, randomUUID()],
    );
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "applicationId", "universalIdentifier", "objectMetadataId", name, type)
       VALUES ($1, $2, $3, $4, $5, 'errField', $6)`,
      [
        fieldId,
        workspaceId,
        customAppId,
        randomUUID(),
        objId,
        FieldMetadataType.TEXT,
      ],
    );

    const origCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      const qr = origCreateQueryRunner();
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
            return (origClientQuery as (...a: unknown[]) => unknown)(...args);
          });
        return client;
      });
      return qr;
    });

    actionHandlerRegistry.executeActionRollbackHandler.mockClear();
    workspaceCacheService.invalidateAndRecompute.mockClear();

    await expect(
      fieldMetadataService.deleteOneField({
        deleteOneFieldInput: { id: fieldId },
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(
      actionHandlerRegistry.executeActionRollbackHandler,
    ).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalled();

    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      const qr = origCreateQueryRunner();
      const origCommit = qr.commitTransaction.bind(qr);
      jest.spyOn(qr, 'commitTransaction').mockImplementationOnce(async () => {
        await origCommit();
        throw new Error('post-commit failure after object delete');
      });
      return qr;
    });

    actionHandlerRegistry.executeActionRollbackHandler.mockClear();
    workspaceCacheService.invalidateAndRecompute.mockClear();

    await expect(
      objectMetadataService.deleteOneObject({
        deleteObjectInput: { id: objId },
        workspaceId,
        auditIdentity: userIdentity(),
      }),
    ).rejects.toBeInstanceOf(CoreAuditPostCommitError);
    expect(
      actionHandlerRegistry.executeActionRollbackHandler,
    ).not.toHaveBeenCalled();
    expect(workspaceCacheService.invalidateAndRecompute).toHaveBeenCalled();
  });
});
