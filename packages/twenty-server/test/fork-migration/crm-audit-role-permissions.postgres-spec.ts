import { randomUUID } from 'node:crypto';
import {
  PermissionFlagType,
  SystemPermissionFlag,
} from 'twenty-shared/constants';
import {
  FieldMetadataType,
  RowLevelPermissionPredicateGroupLogicalOperator,
  RowLevelPermissionPredicateOperand,
} from 'twenty-shared/types';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  getRolePermissionAudit,
  runAuditedRolePermissionUpsert,
  withFieldPermissionUpsertAudit,
  withObjectPermissionUpsertAudit,
  withRolePermissionFlagUpsertAudit,
  withRowLevelPermissionUpsertAudit,
} from 'src/engine/core-modules/crm-audit/role-permission-audit';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { compareTwoFlatEntity } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/utils/compare-two-universal-flat-entity.util';
import { flatEntityToScalarFlatEntity } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/flat-entity-to-scalar-flat-entity.util';

jest.mock('twenty-shared/ai', () => ({ ToolCategory: { ROLE: 'ROLE' } }));
for (const [path, name] of [
  ['core-modules/application/application.service', 'ApplicationService'],
  ['core-modules/billing/services/billing.service', 'BillingService'],
  [
    'core-modules/enterprise/services/enterprise-plan.service',
    'EnterprisePlanService',
  ],
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

for (const [path, name] of [
  ['metadata-modules/role/role.entity', 'RoleEntity'],
  ['metadata-modules/role-target/role-target.entity', 'RoleTargetEntity'],
  [
    'metadata-modules/permission-flag/permission-flag.entity',
    'PermissionFlagEntity',
  ],
  [
    'metadata-modules/role-permission-flag/role-permission-flag.entity',
    'RolePermissionFlagEntity',
  ],
  [
    'metadata-modules/object-permission/object-permission.entity',
    'ObjectPermissionEntity',
  ],
  [
    'metadata-modules/object-permission/field-permission/field-permission.entity',
    'FieldPermissionEntity',
  ],
  [
    'metadata-modules/row-level-permission-predicate/entities/row-level-permission-predicate-group.entity',
    'RowLevelPermissionPredicateGroupEntity',
  ],
  [
    'metadata-modules/row-level-permission-predicate/entities/row-level-permission-predicate.entity',
    'RowLevelPermissionPredicateEntity',
  ],
  [
    'metadata-modules/row-level-permission-predicate/dtos/row-level-permission-predicate-group.dto',
    'RowLevelPermissionPredicateGroupDTO',
  ],
  [
    'metadata-modules/row-level-permission-predicate/dtos/row-level-permission-predicate.dto',
    'RowLevelPermissionPredicateDTO',
  ],
])
  jest.doMock('src/engine/' + path, () => ({ [name]: class {} }));

const { RoleEntity } = require('src/engine/metadata-modules/role/role.entity');
const {
  RolePermissionFlagEntity,
} = require('src/engine/metadata-modules/role-permission-flag/role-permission-flag.entity');
const {
  ObjectPermissionEntity,
} = require('src/engine/metadata-modules/object-permission/object-permission.entity');
const {
  FieldPermissionEntity,
} = require('src/engine/metadata-modules/object-permission/field-permission/field-permission.entity');
const {
  RowLevelPermissionPredicateGroupEntity,
} = require('src/engine/metadata-modules/row-level-permission-predicate/entities/row-level-permission-predicate-group.entity');
const {
  RowLevelPermissionPredicateEntity,
} = require('src/engine/metadata-modules/row-level-permission-predicate/entities/row-level-permission-predicate.entity');

const entityByMetadataName: Record<string, unknown> = {
  rolePermissionFlag: RolePermissionFlagEntity,
  objectPermission: ObjectPermissionEntity,
  fieldPermission: FieldPermissionEntity,
  rowLevelPermissionPredicateGroup: RowLevelPermissionPredicateGroupEntity,
  rowLevelPermissionPredicate: RowLevelPermissionPredicateEntity,
};

const mapsKeyByMetadataName: Record<string, string> = {
  rolePermissionFlag: 'flatRolePermissionFlagMaps',
  objectPermission: 'flatObjectPermissionMaps',
  fieldPermission: 'flatFieldPermissionMaps',
  rowLevelPermissionPredicateGroup: 'flatRowLevelPermissionPredicateGroupMaps',
  rowLevelPermissionPredicate: 'flatRowLevelPermissionPredicateMaps',
};

jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({
    WorkspaceMigrationRunnerActionHandler: (
      _actionType: string,
      metadataName: string,
    ) =>
      class {
        async insertFlatEntitiesInRepository({
          queryRunner,
          flatEntities,
        }: {
          queryRunner: QueryRunner;
          flatEntities: Record<string, unknown>[];
        }) {
          const entityTarget = entityByMetadataName[metadataName];
          await queryRunner.manager.getRepository(entityTarget as never).insert(
            flatEntities.map((flatEntity) => {
              const scalar = flatEntityToScalarFlatEntity({
                metadataName: metadataName as never,
                flatEntity: flatEntity as never,
              }) as Record<string, unknown>;
              if (metadataName === 'rolePermissionFlag') {
                delete scalar.flag;
              }
              return scalar;
            }),
          );
        }

        transpileUniversalDeleteActionToFlatDeleteAction(context: {
          action: {
            metadataName: string;
            universalIdentifier: string;
          };
          allFlatEntityMaps: Record<
            string,
            { byUniversalIdentifier: Record<string, { id: string }> }
          >;
        }) {
          const mapsKey = mapsKeyByMetadataName[context.action.metadataName];
          return {
            ...context.action,
            entityId:
              context.allFlatEntityMaps[mapsKey].byUniversalIdentifier[
                context.action.universalIdentifier
              ].id,
          };
        }
      },
  }),
);

const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
const { CreateRolePermissionFlagActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-permission-flag/services/create-role-permission-flag-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-permission-flag/services/create-role-permission-flag-action-handler.service');
const { DeleteRolePermissionFlagActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-permission-flag/services/delete-role-permission-flag-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/role-permission-flag/services/delete-role-permission-flag-action-handler.service');
const { CreateObjectPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/create-object-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/create-object-permission-action-handler.service');
const { UpdateObjectPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/update-object-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/update-object-permission-action-handler.service');
const { DeleteObjectPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/delete-object-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object-permission/services/delete-object-permission-action-handler.service');
const { CreateFieldPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/create-field-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/create-field-permission-action-handler.service');
const { UpdateFieldPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/update-field-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/update-field-permission-action-handler.service');
const { DeleteFieldPermissionActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/delete-field-permission-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field-permission/services/delete-field-permission-action-handler.service');
const { CreateRowLevelPermissionPredicateGroupActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/create-row-level-permission-predicate-group-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/create-row-level-permission-predicate-group-action-handler.service');
const { UpdateRowLevelPermissionPredicateGroupActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/update-row-level-permission-predicate-group-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/update-row-level-permission-predicate-group-action-handler.service');
const { DeleteRowLevelPermissionPredicateGroupActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/delete-row-level-permission-predicate-group-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate-group/services/delete-row-level-permission-predicate-group-action-handler.service');
const { CreateRowLevelPermissionPredicateActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/create-row-level-permission-predicate-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/create-row-level-permission-predicate-action-handler.service');
const { UpdateRowLevelPermissionPredicateActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/update-row-level-permission-predicate-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/update-row-level-permission-predicate-action-handler.service');
const { DeleteRowLevelPermissionPredicateActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/delete-row-level-permission-predicate-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/row-level-permission-predicate/services/delete-row-level-permission-predicate-action-handler.service');

const { RolePermissionFlagService } =
  require('src/engine/metadata-modules/role-permission-flag/role-permission-flag.service') as typeof import('src/engine/metadata-modules/role-permission-flag/role-permission-flag.service');
const { ObjectPermissionService } =
  require('src/engine/metadata-modules/object-permission/object-permission.service') as typeof import('src/engine/metadata-modules/object-permission/object-permission.service');
const { FieldPermissionService } =
  require('src/engine/metadata-modules/object-permission/field-permission/field-permission.service') as typeof import('src/engine/metadata-modules/object-permission/field-permission/field-permission.service');
const { RowLevelPermissionPredicateService } =
  require('src/engine/metadata-modules/row-level-permission-predicate/services/row-level-permission-predicate.service') as typeof import('src/engine/metadata-modules/row-level-permission-predicate/services/row-level-permission-predicate.service');
const { UpsertObjectPermissionsTool } =
  require('src/engine/metadata-modules/role/tools/upsert-object-permissions.tool') as typeof import('src/engine/metadata-modules/role/tools/upsert-object-permissions.tool');
const { UpsertRowLevelPermissionRulesTool } =
  require('src/engine/metadata-modules/role/tools/upsert-row-level-permission-rules.tool') as typeof import('src/engine/metadata-modules/role/tools/upsert-row-level-permission-rules.tool');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');

const databaseRole = `role_perm_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalIdentifier = randomUUID();
const roleId = randomUUID();
const roleUniversalIdentifier = randomUUID();
const actorMemberId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const actorCoreUserId = randomUUID();
const agentActorId = randomUUID();

const rolesFlagId = randomUUID();
const rolesFlagUniversalId = SystemPermissionFlag[PermissionFlagType.ROLES];
const dataModelFlagId = randomUUID();
const dataModelFlagUniversalId =
  SystemPermissionFlag[PermissionFlagType.DATA_MODEL];
const workflowsFlagId = randomUUID();
const workflowsFlagUniversalId =
  SystemPermissionFlag[PermissionFlagType.WORKFLOWS];

const companyObjectId = randomUUID();
const companyObjectUniversalId = randomUUID();
const personObjectId = randomUUID();
const personObjectUniversalId = randomUUID();
const systemObjectId = randomUUID();
const systemObjectUniversalId = randomUUID();
const workspaceMemberObjectId = randomUUID();
const workspaceMemberObjectUniversalId = randomUUID();

const companyNameFieldId = randomUUID();
const companyNameFieldUniversalId = randomUUID();
const companyPeopleRelationFieldId = randomUUID();
const companyPeopleRelationFieldUniversalId = randomUUID();
const personCompanyRelationFieldId = randomUUID();
const personCompanyRelationFieldUniversalId = randomUUID();
const personJobTitleFieldId = randomUUID();
const personJobTitleFieldUniversalId = randomUUID();
const workspaceMemberIdFieldId = randomUUID();
const workspaceMemberIdFieldUniversalId = randomUUID();

const roleBooleans = [
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
      roleBooleans.map((name) => [name, { type: Boolean, default: false }]),
    ),
  },
});

const rolePermissionFlagSchema = new EntitySchema({
  name: 'RolePermissionFlagEntity',
  target: RolePermissionFlagEntity,
  tableName: 'rolePermissionFlag',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    permissionFlagId: { type: 'uuid' },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const objectPermissionSchema = new EntitySchema({
  name: 'ObjectPermissionEntity',
  target: ObjectPermissionEntity,
  tableName: 'objectPermission',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    objectMetadataId: { type: 'uuid' },
    canReadObjectRecords: { type: Boolean, nullable: true },
    canUpdateObjectRecords: { type: Boolean, nullable: true },
    canSoftDeleteObjectRecords: { type: Boolean, nullable: true },
    canDestroyObjectRecords: { type: Boolean, nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const fieldPermissionSchema = new EntitySchema({
  name: 'FieldPermissionEntity',
  target: FieldPermissionEntity,
  tableName: 'fieldPermission',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    objectMetadataId: { type: 'uuid' },
    fieldMetadataId: { type: 'uuid' },
    canReadFieldValue: { type: Boolean, nullable: true },
    canUpdateFieldValue: { type: Boolean, nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const predicateGroupSchema = new EntitySchema({
  name: 'RowLevelPermissionPredicateGroupEntity',
  target: RowLevelPermissionPredicateGroupEntity,
  tableName: 'rowLevelPermissionPredicateGroup',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    objectMetadataId: { type: 'uuid' },
    parentRowLevelPermissionPredicateGroupId: { type: 'uuid', nullable: true },
    logicalOperator: { type: 'text' },
    positionInRowLevelPermissionPredicateGroup: {
      type: 'double precision',
      nullable: true,
    },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true },
  },
});

const predicateSchema = new EntitySchema({
  name: 'RowLevelPermissionPredicateEntity',
  target: RowLevelPermissionPredicateEntity,
  tableName: 'rowLevelPermissionPredicate',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    universalIdentifier: { type: 'uuid' },
    applicationId: { type: 'uuid' },
    roleId: { type: 'uuid' },
    objectMetadataId: { type: 'uuid' },
    fieldMetadataId: { type: 'uuid' },
    operand: { type: 'text' },
    value: { type: 'jsonb', nullable: true },
    subFieldName: { type: 'text', nullable: true },
    workspaceMemberFieldMetadataId: { type: 'uuid', nullable: true },
    workspaceMemberSubFieldName: { type: 'text', nullable: true },
    rowLevelPermissionPredicateGroupId: { type: 'uuid', nullable: true },
    positionInRowLevelPermissionPredicateGroup: {
      type: 'double precision',
      nullable: true,
    },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true },
  },
});

const entities = [
  roleSchema,
  rolePermissionFlagSchema,
  objectPermissionSchema,
  fieldPermissionSchema,
  predicateGroupSchema,
  predicateSchema,
];

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = databaseRole;
runtimeUrl.password = 'isolated-role-perm-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities,
  extra: { max: 4, statement_timeout: 10000 },
});

const identity = (): RoleUpdateAuditIdentity => ({
  auth: {
    type: 'user',
    workspace: { id: workspaceId },
    workspaceMemberId: actorMemberId,
  },
});

const audits = () =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt", id',
  );

const buildFlatMapsFromDb = async () => {
  const [
    roleRows,
    flagRows,
    roleFlagRows,
    objectRows,
    fieldRows,
    objectPermRows,
    fieldPermRows,
    groupRows,
    predicateRows,
  ] = await Promise.all([
    owner.query('SELECT * FROM core.role WHERE "workspaceId"=$1 ORDER BY id', [
      workspaceId,
    ]),
    owner.query(
      'SELECT * FROM core."permissionFlag" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."rolePermissionFlag" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."objectMetadata" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."fieldMetadata" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."objectPermission" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."fieldPermission" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."rowLevelPermissionPredicateGroup" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
    owner.query(
      'SELECT * FROM core."rowLevelPermissionPredicate" WHERE "workspaceId"=$1 ORDER BY id',
      [workspaceId],
    ),
  ]);

  const makeMap = <T extends { id: string; universalIdentifier: string }>(
    items: T[],
  ) => ({
    byUniversalIdentifier: Object.fromEntries(
      items.map((item) => [item.universalIdentifier, item]),
    ),
    idByUniversalIdentifier: Object.fromEntries(
      items.map((item) => [item.universalIdentifier, item.id]),
    ),
    universalIdentifierById: Object.fromEntries(
      items.map((item) => [item.id, item.universalIdentifier]),
    ),
  });

  const roleUidById = Object.fromEntries(
    roleRows.map((row: Record<string, string>) => [
      row.id,
      row.universalIdentifier,
    ]),
  );
  const flagUidById = Object.fromEntries(
    flagRows.map((row: Record<string, string>) => [
      row.id,
      row.universalIdentifier,
    ]),
  );
  const objectUidById = Object.fromEntries(
    objectRows.map((row: Record<string, string>) => [
      row.id,
      row.universalIdentifier,
    ]),
  );
  const fieldUidById = Object.fromEntries(
    fieldRows.map((row: Record<string, string>) => [
      row.id,
      row.universalIdentifier,
    ]),
  );
  const groupUidById = Object.fromEntries(
    groupRows.map((row: Record<string, string>) => [
      row.id,
      row.universalIdentifier,
    ]),
  );

  const flatRoles = roleRows.map((row: Record<string, unknown>) => ({
    ...row,
    applicationUniversalIdentifier,
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
    roleTargetIds: [],
    roleTargetUniversalIdentifiers: [],
    rowLevelPermissionPredicateIds: [],
    rowLevelPermissionPredicateUniversalIdentifiers: [],
    rowLevelPermissionPredicateGroupIds: [],
    rowLevelPermissionPredicateGroupUniversalIdentifiers: [],
    objectPermissionIds: objectPermRows
      .filter((op: Record<string, unknown>) => op.roleId === row.id)
      .map((op: Record<string, unknown>) => op.id),
    objectPermissionUniversalIdentifiers: objectPermRows
      .filter((op: Record<string, unknown>) => op.roleId === row.id)
      .map((op: Record<string, unknown>) => op.universalIdentifier),
    permissionFlagIds: [],
    permissionFlagUniversalIdentifiers: [],
    rolePermissionFlagIds: roleFlagRows
      .filter((rf: Record<string, unknown>) => rf.roleId === row.id)
      .map((rf: Record<string, unknown>) => rf.id),
    rolePermissionFlagUniversalIdentifiers: roleFlagRows
      .filter((rf: Record<string, unknown>) => rf.roleId === row.id)
      .map((rf: Record<string, unknown>) => rf.universalIdentifier),
    fieldPermissionIds: fieldPermRows
      .filter((fp: Record<string, unknown>) => fp.roleId === row.id)
      .map((fp: Record<string, unknown>) => fp.id),
    fieldPermissionUniversalIdentifiers: fieldPermRows
      .filter((fp: Record<string, unknown>) => fp.roleId === row.id)
      .map((fp: Record<string, unknown>) => fp.universalIdentifier),
  }));

  const flatPermissionFlags = flagRows.map((row: Record<string, unknown>) => ({
    ...row,
    applicationUniversalIdentifier,
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
  }));

  const flatRolePermissionFlags = roleFlagRows.map(
    (row: Record<string, unknown>) => ({
      ...row,
      applicationUniversalIdentifier,
      roleUniversalIdentifier: roleUidById[row.roleId as string],
      permissionFlagUniversalIdentifier:
        flagUidById[row.permissionFlagId as string],
      createdAt: new Date(row.createdAt as string).toISOString(),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    }),
  );

  const flatObjectMetadatas = objectRows.map(
    (row: Record<string, unknown>) => ({
      ...row,
      applicationUniversalIdentifier,
      createdAt: new Date(row.createdAt as string).toISOString(),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    }),
  );

  const flatFieldMetadatas = fieldRows.map((row: Record<string, unknown>) => ({
    ...row,
    applicationUniversalIdentifier,
    objectMetadataUniversalIdentifier:
      objectUidById[row.objectMetadataId as string],
    relationTargetObjectMetadataUniversalIdentifier:
      row.relationTargetObjectMetadataId
        ? objectUidById[row.relationTargetObjectMetadataId as string]
        : null,
    relationTargetFieldMetadataUniversalIdentifier:
      row.relationTargetFieldMetadataId
        ? fieldUidById[row.relationTargetFieldMetadataId as string]
        : null,
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
  }));

  const flatObjectPermissions = objectPermRows.map(
    (row: Record<string, unknown>) => ({
      ...row,
      applicationUniversalIdentifier,
      roleUniversalIdentifier: roleUidById[row.roleId as string],
      objectMetadataUniversalIdentifier:
        objectUidById[row.objectMetadataId as string],
      createdAt: new Date(row.createdAt as string).toISOString(),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    }),
  );

  const flatFieldPermissions = fieldPermRows.map(
    (row: Record<string, unknown>) => ({
      ...row,
      applicationUniversalIdentifier,
      roleUniversalIdentifier: roleUidById[row.roleId as string],
      objectMetadataUniversalIdentifier:
        objectUidById[row.objectMetadataId as string],
      fieldMetadataUniversalIdentifier:
        fieldUidById[row.fieldMetadataId as string],
      createdAt: new Date(row.createdAt as string).toISOString(),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    }),
  );

  const flatGroups = groupRows.map((row: Record<string, unknown>) => ({
    ...row,
    applicationUniversalIdentifier,
    roleUniversalIdentifier: roleUidById[row.roleId as string],
    objectMetadataUniversalIdentifier:
      objectUidById[row.objectMetadataId as string],
    parentRowLevelPermissionPredicateGroupUniversalIdentifier:
      row.parentRowLevelPermissionPredicateGroupId
        ? groupUidById[row.parentRowLevelPermissionPredicateGroupId as string]
        : null,
    childRowLevelPermissionPredicateGroupIds: [],
    childRowLevelPermissionPredicateGroupUniversalIdentifiers: [],
    rowLevelPermissionPredicateIds: [],
    rowLevelPermissionPredicateUniversalIdentifiers: [],
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
    deletedAt: row.deletedAt
      ? new Date(row.deletedAt as string).toISOString()
      : null,
  }));

  const flatPredicates = predicateRows.map((row: Record<string, unknown>) => ({
    ...row,
    applicationUniversalIdentifier,
    roleUniversalIdentifier: roleUidById[row.roleId as string],
    objectMetadataUniversalIdentifier:
      objectUidById[row.objectMetadataId as string],
    fieldMetadataUniversalIdentifier:
      fieldUidById[row.fieldMetadataId as string],
    workspaceMemberFieldMetadataUniversalIdentifier:
      row.workspaceMemberFieldMetadataId
        ? fieldUidById[row.workspaceMemberFieldMetadataId as string]
        : null,
    rowLevelPermissionPredicateGroupUniversalIdentifier:
      row.rowLevelPermissionPredicateGroupId
        ? groupUidById[row.rowLevelPermissionPredicateGroupId as string]
        : null,
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
    deletedAt: row.deletedAt
      ? new Date(row.deletedAt as string).toISOString()
      : null,
  }));

  return {
    flatRoleMaps: makeMap(flatRoles),
    flatPermissionFlagMaps: makeMap(flatPermissionFlags),
    flatRolePermissionFlagMaps: makeMap(flatRolePermissionFlags),
    flatObjectMetadataMaps: makeMap(flatObjectMetadatas),
    flatFieldMetadataMaps: makeMap(flatFieldMetadatas),
    flatObjectPermissionMaps: makeMap(flatObjectPermissions),
    flatFieldPermissionMaps: makeMap(flatFieldPermissions),
    flatRowLevelPermissionPredicateGroupMaps: makeMap(flatGroups),
    flatRowLevelPermissionPredicateMaps: makeMap(flatPredicates),
  };
};

const buildHarness = (
  options: {
    staleRolePermissionFlagIdsToHide?: string[];
    staleObjectPermissionIdsToHide?: string[];
    stalePredicateIdsToHide?: string[];
    onBeforeAction?: (queryRunner: QueryRunner) => Promise<void>;
  } = {},
) => {
  const handlers: Record<
    string,
    {
      transpileUniversalActionToFlatAction: (
        args: never,
      ) => Promise<Record<string, unknown>>;
      executeForMetadata: (args: never) => Promise<void>;
    }
  > = {
    'create:rolePermissionFlag':
      new CreateRolePermissionFlagActionHandlerService(),
    'delete:rolePermissionFlag':
      new DeleteRolePermissionFlagActionHandlerService(),
    'create:objectPermission': new CreateObjectPermissionActionHandlerService(),
    'update:objectPermission': new UpdateObjectPermissionActionHandlerService(),
    'delete:objectPermission': new DeleteObjectPermissionActionHandlerService(),
    'create:fieldPermission': new CreateFieldPermissionActionHandlerService(),
    'update:fieldPermission': new UpdateFieldPermissionActionHandlerService(),
    'delete:fieldPermission': new DeleteFieldPermissionActionHandlerService(),
    'create:rowLevelPermissionPredicateGroup':
      new CreateRowLevelPermissionPredicateGroupActionHandlerService(),
    'update:rowLevelPermissionPredicateGroup':
      new UpdateRowLevelPermissionPredicateGroupActionHandlerService(),
    'delete:rowLevelPermissionPredicateGroup':
      new DeleteRowLevelPermissionPredicateGroupActionHandlerService(),
    'create:rowLevelPermissionPredicate':
      new CreateRowLevelPermissionPredicateActionHandlerService(),
    'update:rowLevelPermissionPredicate':
      new UpdateRowLevelPermissionPredicateActionHandlerService(),
    'delete:rowLevelPermissionPredicate':
      new DeleteRowLevelPermissionPredicateActionHandlerService(),
  };

  const getFilteredMaps = async () => {
    const maps = await buildFlatMapsFromDb();
    for (const hiddenId of options.staleRolePermissionFlagIdsToHide ?? []) {
      const uid =
        maps.flatRolePermissionFlagMaps.universalIdentifierById[hiddenId];
      if (uid) {
        delete maps.flatRolePermissionFlagMaps.byUniversalIdentifier[uid];
        delete maps.flatRolePermissionFlagMaps.idByUniversalIdentifier[uid];
        delete maps.flatRolePermissionFlagMaps.universalIdentifierById[
          hiddenId
        ];
      }
    }
    for (const hiddenId of options.staleObjectPermissionIdsToHide ?? []) {
      const uid =
        maps.flatObjectPermissionMaps.universalIdentifierById[hiddenId];
      if (uid) {
        delete maps.flatObjectPermissionMaps.byUniversalIdentifier[uid];
        delete maps.flatObjectPermissionMaps.idByUniversalIdentifier[uid];
        delete maps.flatObjectPermissionMaps.universalIdentifierById[hiddenId];
      }
    }
    for (const hiddenId of options.stalePredicateIdsToHide ?? []) {
      const uid =
        maps.flatRowLevelPermissionPredicateMaps.universalIdentifierById[
          hiddenId
        ];
      if (uid) {
        delete maps.flatRowLevelPermissionPredicateMaps.byUniversalIdentifier[
          uid
        ];
        delete maps.flatRowLevelPermissionPredicateMaps.idByUniversalIdentifier[
          uid
        ];
        delete maps.flatRowLevelPermissionPredicateMaps.universalIdentifierById[
          hiddenId
        ];
      }
    }
    return maps;
  };

  const flatEntityMapsCacheService = {
    getOrRecomputeManyOrAllFlatEntityMaps: jest.fn(async () =>
      getFilteredMaps(),
    ),
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async (_wsId: string, keys: string[]) => {
      const maps = await getFilteredMaps();
      return {
        ...maps,
        flatApplicationMaps: {
          idByUniversalIdentifier: {
            [applicationUniversalIdentifier]: applicationId,
          },
          byId: {
            [applicationId]: {
              id: applicationId,
              universalIdentifier: applicationUniversalIdentifier,
              workspaceId,
            },
          },
        },
        rolesPermissions: {
          [roleId]: {
            [companyObjectId]: { canReadObjectRecords: true },
            [personObjectId]: { canReadObjectRecords: true },
          },
        },
      };
    }),
    invalidateAndRecompute: jest.fn().mockResolvedValue(undefined),
  };

  let hookRan = false;
  const registry = {
    executeActionHandler: jest.fn(
      async ({
        action,
        context,
      }: {
        action: { type: string; metadataName: string };
        context: { queryRunner: QueryRunner };
      }) => {
        if (!hookRan && options.onBeforeAction) {
          hookRan = true;
          await options.onBeforeAction(context.queryRunner);
        }
        const handler = handlers[`${action.type}:${action.metadataName}`];
        if (!handler)
          throw new Error(
            `Missing fixture handler ${action.type}:${action.metadataName}`,
          );
        const flatAction = await handler.transpileUniversalActionToFlatAction(
          context as never,
        );
        await handler.executeForMetadata({ ...context, flatAction } as never);
        const allFlatEntityMaps = (
          context as unknown as {
            allFlatEntityMaps: Record<
              string,
              {
                byUniversalIdentifier: Record<string, unknown>;
                idByUniversalIdentifier: Record<string, string>;
                universalIdentifierById: Record<string, string>;
              }
            >;
          }
        ).allFlatEntityMaps;
        if (action.type === 'create' && flatAction.flatEntity) {
          const flatEntity = flatAction.flatEntity as {
            id: string;
            universalIdentifier: string;
          };
          const mapsKey = mapsKeyByMetadataName[action.metadataName];
          if (mapsKey && allFlatEntityMaps[mapsKey]) {
            allFlatEntityMaps[mapsKey].byUniversalIdentifier[
              flatEntity.universalIdentifier
            ] = flatEntity;
            allFlatEntityMaps[mapsKey].idByUniversalIdentifier[
              flatEntity.universalIdentifier
            ] = flatEntity.id;
            allFlatEntityMaps[mapsKey].universalIdentifierById[flatEntity.id] =
              flatEntity.universalIdentifier;
          }
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

  const runner = new WorkspaceMigrationRunnerService(
    flatEntityMapsCacheService as never,
    runtime,
    registry as never,
    { incrementMetadataVersion: jest.fn() } as never,
    workspaceCacheService as never,
    { recordHistogram: jest.fn() } as never,
    {
      perfTime: jest.fn(),
      perfTimeEnd: jest.fn(),
      perf: jest.fn(),
      error: jest.fn(),
    } as never,
    { get: jest.fn().mockReturnValue(false) } as never,
    { getWorkspaceFeatureFlagsMap: jest.fn().mockResolvedValue({}) } as never,
    { persist: jest.fn(), dispatchAfterCommit: jest.fn() } as never,
    {
      throwIfSchemaAffectingActionsAreInProgress: jest.fn(),
    } as never,
  );

  const validateBuildAndRunService = {
    validateBuildAndRunWorkspaceMigration: jest.fn(
      async ({
        allFlatEntityOperationByMetadataName,
        workspaceId: targetWorkspaceId,
      }: {
        allFlatEntityOperationByMetadataName: Record<
          string,
          {
            flatEntityToCreate: Record<string, unknown>[];
            flatEntityToUpdate: Record<string, unknown>[];
            flatEntityToDelete: Record<string, unknown>[];
          }
        >;
        workspaceId: string;
      }) => {
        const maps = await getFilteredMaps();
        const actions: Record<string, unknown>[] = [];
        for (const [metadataName, operations] of Object.entries(
          allFlatEntityOperationByMetadataName,
        )) {
          const mapsKey = mapsKeyByMetadataName[
            metadataName
          ] as keyof typeof maps;
          const currentMap = maps[mapsKey].byUniversalIdentifier as Record<
            string,
            Record<string, unknown>
          >;
          for (const flatEntity of operations.flatEntityToDelete) {
            actions.push({
              type: 'delete',
              metadataName,
              universalIdentifier: flatEntity.universalIdentifier,
            });
          }
          for (const flatEntity of operations.flatEntityToUpdate) {
            const fromEntity =
              currentMap[flatEntity.universalIdentifier as string];
            const update = compareTwoFlatEntity({
              fromUniversalFlatEntity: fromEntity as never,
              toUniversalFlatEntity: flatEntity as never,
              metadataName: metadataName as never,
            });
            if (update && Object.keys(update).length > 0) {
              actions.push({
                type: 'update',
                metadataName,
                universalIdentifier: flatEntity.universalIdentifier,
                update,
              });
            }
          }
          for (const flatEntity of operations.flatEntityToCreate) {
            actions.push({
              type: 'create',
              metadataName,
              id: flatEntity.id,
              flatEntity,
            });
          }
        }
        if (actions.length === 0) {
          return {
            status: 'success',
            workspaceMigration: {
              actions: [],
              applicationUniversalIdentifier,
            },
            hasSchemaMetadataChanged: false,
          };
        }
        await runner.run({
          workspaceId: targetWorkspaceId,
          workspaceMigration: {
            actions: actions as never,
            applicationUniversalIdentifier,
          },
        });
        return {
          status: 'success',
          workspaceMigration: {
            actions,
            applicationUniversalIdentifier,
          },
          hasSchemaMetadataChanged: false,
        };
      },
    ),
  };

  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
      .fn()
      .mockResolvedValue({
        workspaceCustomFlatApplication: {
          id: applicationId,
          universalIdentifier: applicationUniversalIdentifier,
          workspaceId,
        },
      }),
  };

  const rolePermissionFlagService = new RolePermissionFlagService(
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
  );
  const objectPermissionService = new ObjectPermissionService(
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    applicationService as never,
  );
  const fieldPermissionService = new FieldPermissionService(
    validateBuildAndRunService as never,
    flatEntityMapsCacheService as never,
    workspaceCacheService as never,
    applicationService as never,
  );
  const rowLevelPermissionPredicateService =
    new RowLevelPermissionPredicateService(
      validateBuildAndRunService as never,
      flatEntityMapsCacheService as never,
      workspaceCacheService as never,
      { hasEntitlement: jest.fn().mockResolvedValue(true) } as never,
      applicationService as never,
      { isValid: jest.fn().mockReturnValue(true) } as never,
    );

  return {
    runner,
    workspaceCacheService,
    rolePermissionFlagService,
    objectPermissionService,
    fieldPermissionService,
    rowLevelPermissionPredicateService,
    upsertObjectPermissionsTool: new UpsertObjectPermissionsTool(
      objectPermissionService,
    ),
    upsertRowLevelPermissionRulesTool: new UpsertRowLevelPermissionRulesTool(
      rowLevelPermissionPredicateService,
    ),
  };
};

describe('CRM audit role permission upserts (PostgreSQL)', () => {
  beforeAll(async () => {
    await owner.initialize();
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
    );
    await owner.query(
      `CREATE TABLE core.workspace (
        id uuid PRIMARY KEY,
        "defaultRoleId" uuid NULL,
        "deletedAt" timestamptz NULL
      )`,
    );
    await owner.query(
      `CREATE TABLE core.application (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      )`,
    );
    await owner.query(
      `CREATE TABLE core.role (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        label text NOT NULL,
        description text NULL,
        icon text NULL,
        "isEditable" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        ${roleBooleans
          .map((col) => `"${col}" boolean NOT NULL DEFAULT false`)
          .join(',\n        ')}
      )`,
    );
    await owner.query(
      `CREATE TABLE core."userWorkspace" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      )`,
    );
    await owner.query(
      `CREATE TABLE core."roleTarget" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "userWorkspaceId" uuid NULL,
        "agentId" uuid NULL,
        "apiKeyId" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await owner.query(
      `CREATE TABLE core."permissionFlag" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        key varchar NOT NULL,
        label varchar NOT NULL,
        description text NULL,
        icon varchar NULL,
        "permissionType" varchar NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await owner.query(
      `CREATE TABLE core."rolePermissionFlag" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "permissionFlagId" uuid NOT NULL REFERENCES core."permissionFlag"(id) ON DELETE CASCADE,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("permissionFlagId", "roleId")
      )`,
    );
    await owner.query(
      `CREATE TABLE core."objectMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "nameSingular" varchar NOT NULL,
        "isSystem" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await owner.query(
      `CREATE TABLE core."fieldMetadata" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        name varchar NOT NULL,
        type varchar NOT NULL,
        settings jsonb NULL,
        "relationTargetObjectMetadataId" uuid NULL,
        "relationTargetFieldMetadataId" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await owner.query(
      `CREATE TABLE core."objectPermission" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "canReadObjectRecords" boolean NULL,
        "canUpdateObjectRecords" boolean NULL,
        "canSoftDeleteObjectRecords" boolean NULL,
        "canDestroyObjectRecords" boolean NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("objectMetadataId", "roleId")
      )`,
    );
    await owner.query(
      `CREATE TABLE core."fieldPermission" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
        "canReadFieldValue" boolean NULL,
        "canUpdateFieldValue" boolean NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("fieldMetadataId", "roleId")
      )`,
    );
    await owner.query(
      `CREATE TABLE core."rowLevelPermissionPredicateGroup" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "parentRowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
        "logicalOperator" text NOT NULL DEFAULT 'AND',
        "positionInRowLevelPermissionPredicateGroup" double precision NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz NULL
      )`,
    );
    await owner.query(
      `CREATE TABLE core."rowLevelPermissionPredicate" (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        "applicationId" uuid NOT NULL,
        "roleId" uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        "objectMetadataId" uuid NOT NULL REFERENCES core."objectMetadata"(id) ON DELETE CASCADE,
        "fieldMetadataId" uuid NOT NULL REFERENCES core."fieldMetadata"(id) ON DELETE CASCADE,
        operand text NOT NULL,
        value jsonb NULL,
        "subFieldName" text NULL,
        "workspaceMemberFieldMetadataId" uuid NULL REFERENCES core."fieldMetadata"(id) ON DELETE SET NULL,
        "workspaceMemberSubFieldName" text NULL,
        "rowLevelPermissionPredicateGroupId" uuid NULL REFERENCES core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE,
        "positionInRowLevelPermissionPredicateGroup" double precision NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz NULL
      )`,
    );

    const qr = owner.createQueryRunner();
    await qr.connect();
    try {
      await new OmniAuditBootstrapFastInstanceCommand().up(qr);
    } finally {
      await qr.release();
    }

    await owner.query(
      `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-role-perm-fixture'`,
    );
    await owner.query(
      `GRANT USAGE ON SCHEMA core, crm_audit TO "${databaseRole}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
    );
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime.isInitialized) await runtime.destroy();
    if (owner.isInitialized) {
      await owner.query('DROP SCHEMA IF EXISTS core, crm_audit CASCADE');
      await owner.query(`DROP ROLE IF EXISTS "${databaseRole}"`);
      await owner.destroy();
    }
  });

  beforeEach(async () => {
    await owner.query(
      'TRUNCATE core.workspace, core.application, core.role, core."userWorkspace", core."roleTarget", core."permissionFlag", core."rolePermissionFlag", core."objectMetadata", core."fieldMetadata", core."objectPermission", core."fieldPermission", core."rowLevelPermissionPredicateGroup", core."rowLevelPermissionPredicate", crm_audit."crmAuditEntry" CASCADE',
    );
    await owner.query(
      'INSERT INTO core.workspace (id, "defaultRoleId", "deletedAt") VALUES ($1, $2, NULL)',
      [workspaceId, roleId],
    );
    await owner.query(
      'INSERT INTO core.application (id, "workspaceId", "universalIdentifier", "deletedAt") VALUES ($1, $2, $3, NULL)',
      [applicationId, workspaceId, applicationUniversalIdentifier],
    );
    await owner.query(
      `INSERT INTO core.role (
        id, "workspaceId", "universalIdentifier", "applicationId", label, "isEditable",
        "canUpdateAllSettings", "canReadAllObjectRecords", "canUpdateAllObjectRecords",
        "canSoftDeleteAllObjectRecords", "canDestroyAllObjectRecords",
        "canBeAssignedToUsers", "canBeAssignedToAgents", "canBeAssignedToApiKeys"
      ) VALUES ($1, $2, $3, $4, 'Custom Support', true, true, true, false, false, false, true, true, true)`,
      [roleId, workspaceId, roleUniversalIdentifier, applicationId],
    );
    await owner.query(
      'INSERT INTO core."userWorkspace" (id, "workspaceId", "userId", "deletedAt") VALUES ($1, $2, $3, NULL)',
      [actorUserWorkspaceId, workspaceId, actorCoreUserId],
    );
    for (const [id, uid, key] of [
      [rolesFlagId, rolesFlagUniversalId, PermissionFlagType.ROLES],
      [
        dataModelFlagId,
        dataModelFlagUniversalId,
        PermissionFlagType.DATA_MODEL,
      ],
      [workflowsFlagId, workflowsFlagUniversalId, PermissionFlagType.WORKFLOWS],
    ]) {
      await owner.query(
        'INSERT INTO core."permissionFlag" (id, "workspaceId", "universalIdentifier", "applicationId", key, label, "permissionType") VALUES ($1, $2, $3, $4, $5, $5, \'SETTING\')',
        [id, workspaceId, uid, applicationId, key],
      );
    }
    for (const [id, uid, name, isSystem] of [
      [companyObjectId, companyObjectUniversalId, 'company', false],
      [personObjectId, personObjectUniversalId, 'person', false],
      [systemObjectId, systemObjectUniversalId, 'sysInternal', true],
      [
        workspaceMemberObjectId,
        workspaceMemberObjectUniversalId,
        'workspaceMember',
        false,
      ],
    ]) {
      await owner.query(
        'INSERT INTO core."objectMetadata" (id, "workspaceId", "universalIdentifier", "applicationId", "nameSingular", "isSystem") VALUES ($1, $2, $3, $4, $5, $6)',
        [id, workspaceId, uid, applicationId, name, isSystem],
      );
    }
    await owner.query(
      `INSERT INTO core."fieldMetadata" (id, "workspaceId", "universalIdentifier", "applicationId", "objectMetadataId", name, type, settings, "relationTargetObjectMetadataId", "relationTargetFieldMetadataId")
       VALUES
         ($1, $2, $3, $4, $5, 'name', $6, NULL, NULL, NULL),
         ($7, $2, $8, $4, $5, 'people', $9, $10::jsonb, $11, $12),
         ($12, $2, $13, $4, $11, 'company', $9, $14::jsonb, $5, $7),
         ($15, $2, $16, $4, $11, 'jobTitle', $6, NULL, NULL, NULL),
         ($17, $2, $18, $4, $19, 'id', $20, NULL, NULL, NULL)`,
      [
        companyNameFieldId,
        workspaceId,
        companyNameFieldUniversalId,
        applicationId,
        companyObjectId,
        FieldMetadataType.TEXT,
        companyPeopleRelationFieldId,
        companyPeopleRelationFieldUniversalId,
        FieldMetadataType.RELATION,
        JSON.stringify({ relationType: RelationType.ONE_TO_MANY }),
        personObjectId,
        personCompanyRelationFieldId,
        personCompanyRelationFieldUniversalId,
        JSON.stringify({ relationType: RelationType.MANY_TO_ONE }),
        personJobTitleFieldId,
        personJobTitleFieldUniversalId,
        workspaceMemberIdFieldId,
        workspaceMemberIdFieldUniversalId,
        workspaceMemberObjectId,
        FieldMetadataType.UUID,
      ],
    );
  });

  it('audits rolePermissionFlag create and delete in one atomic commit and skips no-op', async () => {
    const existingFlagRowId = randomUUID();
    await owner.query(
      'INSERT INTO core."rolePermissionFlag" (id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "permissionFlagId") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        existingFlagRowId,
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        rolesFlagId,
      ],
    );

    const { rolePermissionFlagService } = buildHarness();
    const result = await rolePermissionFlagService.upsertPermissionFlags({
      workspaceId,
      input: {
        roleId,
        permissionFlagKeys: [
          PermissionFlagType.DATA_MODEL,
          PermissionFlagType.WORKFLOWS,
        ],
      },
      auditIdentity: identity(),
    });

    expect(result).toHaveLength(2);
    const dbFlags = await owner.query(
      'SELECT "permissionFlagId" FROM core."rolePermissionFlag" WHERE "roleId"=$1 ORDER BY "permissionFlagId"',
      [roleId],
    );
    expect(
      dbFlags.map((row: { permissionFlagId: string }) => row.permissionFlagId),
    ).toEqual([dataModelFlagId, workflowsFlagId].sort());

    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(
      new Set(
        entries.map((entry: { operationId: string }) => entry.operationId),
      ).size,
    ).toBe(1);
    const deleteEntry = entries.find(
      (entry: { action: string; resourceId: string }) =>
        entry.action === 'delete' && entry.resourceId === existingFlagRowId,
    );
    expect(deleteEntry).toMatchObject({
      resourceKind: 'rolePermissionFlag',
      action: 'delete',
      redactedDiff: {
        changedFields: ['permissionFlagId', 'roleId'],
        values: {
          roleId: { before: roleId, after: null },
          permissionFlagId: { before: rolesFlagId, after: null },
        },
      },
    });
    const createEntries = entries.filter(
      (entry: { action: string }) => entry.action === 'create',
    );
    expect(createEntries).toHaveLength(2);

    const noopResult = await rolePermissionFlagService.upsertPermissionFlags({
      workspaceId,
      input: {
        roleId,
        permissionFlagKeys: [
          PermissionFlagType.DATA_MODEL,
          PermissionFlagType.WORKFLOWS,
        ],
      },
      auditIdentity: identity(),
    });
    expect(noopResult).toHaveLength(2);
    expect(await audits()).toHaveLength(3);
  });

  it('rejects self-lockout when revoking ROLES flag from caller role with canUpdateAllSettings=false (pre-check and concurrent DB lock)', async () => {
    const existingFlagRowId = randomUUID();
    await owner.query(
      'UPDATE core.role SET "canUpdateAllSettings"=false WHERE id=$1',
      [roleId],
    );
    await owner.query(
      'INSERT INTO core."rolePermissionFlag" (id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "permissionFlagId") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        existingFlagRowId,
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        rolesFlagId,
      ],
    );

    const { rolePermissionFlagService } = buildHarness();
    await expect(
      rolePermissionFlagService.upsertPermissionFlags({
        workspaceId,
        input: {
          roleId,
          permissionFlagKeys: [PermissionFlagType.DATA_MODEL],
        },
        actingRoleIds: [roleId],
        auditIdentity: identity(),
      }),
    ).rejects.toThrow('Cannot revoke settings access');
    expect(await audits()).toHaveLength(0);

    await owner.query(
      'UPDATE core.role SET "canUpdateAllSettings"=true WHERE id=$1',
      [roleId],
    );
    await owner.query(
      'INSERT INTO core."roleTarget" (id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "userWorkspaceId") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        randomUUID(),
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        actorUserWorkspaceId,
      ],
    );

    const concurrentHarness = buildHarness({
      onBeforeAction: async () => {
        throw new Error(
          'Handler must not execute when DB lock catches lockout',
        );
      },
    });
    const originalGetMaps =
      concurrentHarness.rolePermissionFlagService[
        'workspaceManyOrAllFlatEntityMapsCacheService'
      ].getOrRecomputeManyOrAllFlatEntityMaps;
    let firstCall = true;
    concurrentHarness.rolePermissionFlagService[
      'workspaceManyOrAllFlatEntityMapsCacheService'
    ].getOrRecomputeManyOrAllFlatEntityMaps = jest.fn(async (args) => {
      const maps = await originalGetMaps(args);
      if (firstCall) {
        firstCall = false;
        await owner.query(
          'UPDATE core.role SET "canUpdateAllSettings"=false WHERE id=$1',
          [roleId],
        );
      }
      return maps;
    }) as never;

    await expect(
      concurrentHarness.rolePermissionFlagService.upsertPermissionFlags({
        workspaceId,
        input: {
          roleId,
          permissionFlagKeys: [PermissionFlagType.DATA_MODEL],
        },
        actingUserWorkspaceId: actorUserWorkspaceId,
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Role permission flag audit cannot revoke caller settings access',
    );
    expect(await audits()).toHaveLength(0);
    const remainingFlags = await owner.query(
      'SELECT id FROM core."rolePermissionFlag" WHERE "roleId"=$1',
      [roleId],
    );
    expect(remainingFlags).toEqual([{ id: existingFlagRowId }]);
  });

  it('rejects stale rolePermissionFlag set and rolls back on post-flush corruption', async () => {
    const hiddenFlagRowId = randomUUID();
    await owner.query(
      'INSERT INTO core."rolePermissionFlag" (id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "permissionFlagId") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        hiddenFlagRowId,
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        workflowsFlagId,
      ],
    );

    const staleHarness = buildHarness({
      staleRolePermissionFlagIdsToHide: [hiddenFlagRowId],
    });
    await expect(
      staleHarness.rolePermissionFlagService.upsertPermissionFlags({
        workspaceId,
        input: {
          roleId,
          permissionFlagKeys: [PermissionFlagType.DATA_MODEL],
        },
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Role permission flag audit plan diverges from persisted state',
    );
    expect(await audits()).toHaveLength(0);

    await owner.query('DELETE FROM core."rolePermissionFlag"');
    await owner.query(
      `CREATE OR REPLACE FUNCTION core.corrupt_role_flag_on_audit() RETURNS trigger AS $$
       BEGIN
         DELETE FROM core."rolePermissionFlag" WHERE "workspaceId" = NEW."workspaceId";
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await owner.query(
      `CREATE TRIGGER corrupt_role_flag_trigger
       AFTER INSERT ON crm_audit."crmAuditEntry"
       FOR EACH ROW EXECUTE FUNCTION core.corrupt_role_flag_on_audit()`,
    );
    try {
      const { rolePermissionFlagService } = buildHarness();
      await expect(
        rolePermissionFlagService.upsertPermissionFlags({
          workspaceId,
          input: {
            roleId,
            permissionFlagKeys: [PermissionFlagType.DATA_MODEL],
          },
          auditIdentity: identity(),
        }),
      ).rejects.toThrow(
        'Role permission flag audit persisted state changed during flush',
      );
      expect(await audits()).toHaveLength(0);
      expect(
        await owner.query('SELECT * FROM core."rolePermissionFlag"'),
      ).toHaveLength(0);
    } finally {
      await owner.query(
        'DROP TRIGGER IF EXISTS corrupt_role_flag_trigger ON crm_audit."crmAuditEntry"',
      );
      await owner.query(
        'DROP FUNCTION IF EXISTS core.corrupt_role_flag_on_audit()',
      );
    }
  });

  it('audits objectPermission create, update, and delete via UpsertObjectPermissionsTool with agent initiator attribution', async () => {
    const companyPermId = randomUUID();
    const personPermId = randomUUID();
    await owner.query(
      `INSERT INTO core."objectPermission" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId",
        "canReadObjectRecords", "canUpdateObjectRecords", "canSoftDeleteObjectRecords", "canDestroyObjectRecords"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, true, false, false, false),
        ($7, $2, $8, $4, $5, $9, true, true, false, false)`,
      [
        companyPermId,
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        companyObjectId,
        personPermId,
        randomUUID(),
        personObjectId,
      ],
    );

    const { upsertObjectPermissionsTool } = buildHarness();
    const output = await upsertObjectPermissionsTool.execute({
      input: {
        roleId,
        objectPermissions: [
          {
            objectMetadataId: companyObjectId,
            canReadObjectRecords: true,
            canUpdateObjectRecords: true,
            canSoftDeleteObjectRecords: false,
            canDestroyObjectRecords: false,
          },
          {
            objectMetadataId: workspaceMemberObjectId,
            canReadObjectRecords: true,
            canUpdateObjectRecords: false,
            canSoftDeleteObjectRecords: false,
            canDestroyObjectRecords: false,
          },
        ],
      },
      context: {
        workspaceId,
        agentId: agentActorId,
        authContext: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: actorMemberId,
        } as never,
      } as never,
    });

    expect(output.success).toBe(true);
    const entries = await audits();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'agent', id: agentActorId },
      initiator: { kind: 'workspaceMember', id: actorMemberId },
    });
    const deleteEntry = entries.find(
      (entry: { action: string }) => entry.action === 'delete',
    );
    expect(deleteEntry).toMatchObject({
      resourceKind: 'objectPermission',
      resourceId: personPermId,
      redactedDiff: {
        values: {
          roleId: { before: roleId, after: null },
          objectMetadataId: { before: personObjectId, after: null },
          canReadObjectRecords: { before: true, after: null },
          canUpdateObjectRecords: { before: true, after: null },
          canSoftDeleteObjectRecords: { before: false, after: null },
          canDestroyObjectRecords: { before: false, after: null },
        },
      },
    });
    const updateEntry = entries.find(
      (entry: { action: string }) => entry.action === 'update',
    );
    expect(updateEntry).toMatchObject({
      resourceKind: 'objectPermission',
      resourceId: companyPermId,
      redactedDiff: {
        changedFields: ['canUpdateObjectRecords'],
        values: {
          canUpdateObjectRecords: { before: false, after: true },
        },
      },
    });
    const createEntry = entries.find(
      (entry: { action: string }) => entry.action === 'create',
    );
    expect(createEntry).toMatchObject({
      resourceKind: 'objectPermission',
      redactedDiff: {
        values: {
          roleId: { before: null, after: roleId },
          objectMetadataId: { before: null, after: workspaceMemberObjectId },
          canReadObjectRecords: { before: null, after: true },
          canUpdateObjectRecords: { before: null, after: false },
          canSoftDeleteObjectRecords: { before: null, after: false },
          canDestroyObjectRecords: { before: null, after: false },
        },
      },
    });
  });

  it('enforces objectPermission read/write consistency against locked core.role and preserves commit on lost ACK', async () => {
    const harness = buildHarness();
    const originalGetMaps =
      harness.objectPermissionService[
        'workspaceManyOrAllFlatEntityMapsCacheService'
      ].getOrRecomputeManyOrAllFlatEntityMaps;
    let firstCall = true;
    harness.objectPermissionService[
      'workspaceManyOrAllFlatEntityMapsCacheService'
    ].getOrRecomputeManyOrAllFlatEntityMaps = jest.fn(async (args) => {
      const maps = await originalGetMaps(args);
      if (firstCall) {
        firstCall = false;
        await owner.query(
          'UPDATE core.role SET "canReadAllObjectRecords"=false WHERE id=$1',
          [roleId],
        );
      }
      return maps;
    }) as never;

    await expect(
      harness.objectPermissionService.upsertObjectPermissions({
        workspaceId,
        input: {
          roleId,
          objectPermissions: [
            {
              objectMetadataId: companyObjectId,
              canUpdateObjectRecords: true,
            },
          ],
        },
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Object permission audit read/write consistency violated',
    );
    expect(await audits()).toHaveLength(0);
    expect(
      await owner.query('SELECT * FROM core."objectPermission"'),
    ).toHaveLength(0);

    await owner.query(
      'UPDATE core.role SET "canReadAllObjectRecords"=true WHERE id=$1',
      [roleId],
    );
    const lostAckHarness = buildHarness();
    const originalCreateQueryRunner = runtime.createQueryRunner.bind(runtime);
    const clients = new WeakSet<object>();
    const spy = jest
      .spyOn(runtime, 'createQueryRunner')
      .mockImplementationOnce((mode) => {
        const qr = originalCreateQueryRunner(mode);
        const connect = qr.connect.bind(qr);
        jest.spyOn(qr, 'connect').mockImplementation(async () => {
          const client = await connect();
          if (!clients.has(client)) {
            clients.add(client);
            const query = client.query.bind(client);
            client.query = async (sql: string, ...args: unknown[]) => {
              const res = await query(sql, ...args);
              if (sql === 'COMMIT')
                throw new Error('lost objectPermission ACK');
              return res;
            };
          }
          return client;
        });
        return qr;
      });

    try {
      await expect(
        lostAckHarness.objectPermissionService.upsertObjectPermissions({
          workspaceId,
          input: {
            roleId,
            objectPermissions: [
              {
                objectMetadataId: companyObjectId,
                canReadObjectRecords: true,
                canUpdateObjectRecords: false,
              },
            ],
          },
          auditIdentity: identity(),
        }),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    } finally {
      spy.mockRestore();
    }

    expect(await audits()).toHaveLength(1);
    expect(
      await owner.query('SELECT * FROM core."objectPermission"'),
    ).toHaveLength(1);
    expect(
      lostAckHarness.workspaceCacheService.invalidateAndRecompute,
    ).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining(['flatObjectPermissionMaps', 'rolesPermissions']),
    );
  });

  it('audits fieldPermission create, update, delete, and relation mirror while preserving untargeted fieldPermissions', async () => {
    const jobTitlePermId = randomUUID();
    const companyNamePermId = randomUUID();
    await owner.query(
      `INSERT INTO core."fieldPermission" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId",
        "objectMetadataId", "fieldMetadataId", "canReadFieldValue", "canUpdateFieldValue"
      ) VALUES
        ($1, $2, $3, $4, $5, $6, $7, null, false),
        ($8, $2, $9, $4, $5, $10, $11, null, false)`,
      [
        jobTitlePermId,
        workspaceId,
        randomUUID(),
        applicationId,
        roleId,
        personObjectId,
        personJobTitleFieldId,
        companyNamePermId,
        randomUUID(),
        companyObjectId,
        companyNameFieldId,
      ],
    );

    const { fieldPermissionService } = buildHarness();
    const updated = await fieldPermissionService.upsertFieldPermissions({
      workspaceId,
      input: {
        roleId,
        fieldPermissions: [
          {
            objectMetadataId: companyObjectId,
            fieldMetadataId: companyNameFieldId,
            canReadFieldValue: false,
            canUpdateFieldValue: false,
          },
          {
            objectMetadataId: companyObjectId,
            fieldMetadataId: companyPeopleRelationFieldId,
            canReadFieldValue: false,
            canUpdateFieldValue: false,
          },
        ],
      },
      auditIdentity: identity(),
    });

    expect(updated).toHaveLength(2);
    const dbFieldPerms = await owner.query(
      'SELECT "objectMetadataId", "fieldMetadataId", "canReadFieldValue", "canUpdateFieldValue" FROM core."fieldPermission" WHERE "roleId"=$1 ORDER BY "fieldMetadataId"',
      [roleId],
    );
    expect(dbFieldPerms).toHaveLength(4);

    const entries = await audits();
    expect(entries).toHaveLength(3);
    const updateEntry = entries.find(
      (entry: { action: string }) => entry.action === 'update',
    );
    expect(updateEntry).toMatchObject({
      resourceKind: 'fieldPermission',
      resourceId: companyNamePermId,
      redactedDiff: {
        changedFields: ['canReadFieldValue'],
        values: {
          canReadFieldValue: { before: null, after: false },
        },
      },
    });
    const createdFieldIds = entries
      .filter((entry: { action: string }) => entry.action === 'create')
      .map(
        (entry: {
          redactedDiff: { values: { fieldMetadataId: { after: string } } };
        }) => entry.redactedDiff.values.fieldMetadataId.after,
      )
      .sort();
    expect(createdFieldIds).toEqual(
      [companyPeopleRelationFieldId, personCompanyRelationFieldId].sort(),
    );

    await owner.query('DELETE FROM crm_audit."crmAuditEntry"');
    await fieldPermissionService.upsertFieldPermissions({
      workspaceId,
      input: {
        roleId,
        fieldPermissions: [
          {
            objectMetadataId: companyObjectId,
            fieldMetadataId: companyPeopleRelationFieldId,
            canReadFieldValue: null,
            canUpdateFieldValue: null,
          },
        ],
      },
      auditIdentity: identity(),
    });
    const deleteEntries = await audits();
    expect(deleteEntries).toHaveLength(2);
    expect(
      deleteEntries.every(
        (entry: { action: string; resourceKind: string }) =>
          entry.action === 'delete' && entry.resourceKind === 'fieldPermission',
      ),
    ).toBe(true);
    const remainingJobTitle = await owner.query(
      'SELECT id FROM core."fieldPermission" WHERE id=$1',
      [jobTitlePermId],
    );
    expect(remainingJobTitle).toEqual([{ id: jobTitlePermId }]);
  });

  it('rejects fieldPermission upsert when objectMetadata becomes system or fieldMetadata ownership mismatches in DB', async () => {
    const harness = buildHarness();
    const originalGetMaps =
      harness.fieldPermissionService[
        'workspaceManyOrAllFlatEntityMapsCacheService'
      ].getOrRecomputeManyOrAllFlatEntityMaps;
    let firstCall = true;
    harness.fieldPermissionService[
      'workspaceManyOrAllFlatEntityMapsCacheService'
    ].getOrRecomputeManyOrAllFlatEntityMaps = jest.fn(async (args) => {
      const maps = await originalGetMaps(args);
      if (firstCall) {
        firstCall = false;
        await owner.query(
          'UPDATE core."objectMetadata" SET "isSystem"=true WHERE id=$1',
          [companyObjectId],
        );
      }
      return maps;
    }) as never;

    await expect(
      harness.fieldPermissionService.upsertFieldPermissions({
        workspaceId,
        input: {
          roleId,
          fieldPermissions: [
            {
              objectMetadataId: companyObjectId,
              fieldMetadataId: companyNameFieldId,
              canReadFieldValue: false,
              canUpdateFieldValue: false,
            },
          ],
        },
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Field permission audit referenced objectMetadata/fieldMetadata unavailable or system',
    );
    expect(await audits()).toHaveLength(0);
  });

  it('audits rowLevelPermissionPredicateGroup and rowLevelPermissionPredicate create, update, and delete with redacted value hash', async () => {
    const oldGroupId = randomUUID();
    const keptGroupId = randomUUID();
    const oldPredicateId = randomUUID();
    const updatedPredicateId = randomUUID();
    const newGroupId = randomUUID();

    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId",
        "parentRowLevelPermissionPredicateGroupId", "logicalOperator", "positionInRowLevelPermissionPredicateGroup"
      ) VALUES
        ($1, $2, $1, $3, $4, $5, NULL, 'AND', 0),
        ($6, $2, $6, $3, $4, $5, NULL, 'AND', 1)`,
      [
        oldGroupId,
        workspaceId,
        applicationId,
        roleId,
        companyObjectId,
        keptGroupId,
      ],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId",
        "fieldMetadataId", operand, value, "rowLevelPermissionPredicateGroupId", "positionInRowLevelPermissionPredicateGroup"
      ) VALUES
        ($1, $2, $1, $3, $4, $5, $6, 'CONTAINS', '"OldSecretLiteral"'::jsonb, $7, 0),
        ($8, $2, $8, $3, $4, $5, $6, 'CONTAINS', '"InitialClientName"'::jsonb, $9, 1)`,
      [
        oldPredicateId,
        workspaceId,
        applicationId,
        roleId,
        companyObjectId,
        companyNameFieldId,
        oldGroupId,
        updatedPredicateId,
        keptGroupId,
      ],
    );

    const { upsertRowLevelPermissionRulesTool } = buildHarness();
    const output = await upsertRowLevelPermissionRulesTool.execute({
      input: {
        roleId,
        objectMetadataId: companyObjectId,
        predicateGroups: [
          {
            id: keptGroupId,
            logicalOperator: RowLevelPermissionPredicateGroupLogicalOperator.OR,
            positionInRowLevelPermissionPredicateGroup: 1,
          },
          {
            id: newGroupId,
            logicalOperator:
              RowLevelPermissionPredicateGroupLogicalOperator.AND,
            parentRowLevelPermissionPredicateGroupId: keptGroupId,
            positionInRowLevelPermissionPredicateGroup: 2,
          },
        ],
        predicates: [
          {
            id: updatedPredicateId,
            fieldMetadataId: companyNameFieldId,
            operand: RowLevelPermissionPredicateOperand.CONTAINS,
            value: 'UpdatedConfidentialClientName',
            rowLevelPermissionPredicateGroupId: keptGroupId,
            positionInRowLevelPermissionPredicateGroup: 1,
          },
          {
            fieldMetadataId: companyNameFieldId,
            operand: RowLevelPermissionPredicateOperand.IS,
            workspaceMemberFieldMetadataId: workspaceMemberIdFieldId,
            rowLevelPermissionPredicateGroupId: newGroupId,
            positionInRowLevelPermissionPredicateGroup: 2,
          },
        ],
      },
      context: {
        workspaceId,
        authContext: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: actorMemberId,
        } as never,
      } as never,
    });

    expect(output.success).toBe(true);
    const entries = await audits();
    expect(entries).toHaveLength(6);
    expect(
      new Set(
        entries.map((entry: { operationId: string }) => entry.operationId),
      ).size,
    ).toBe(1);

    const serializedAudit = JSON.stringify(entries);
    expect(serializedAudit).not.toContain('OldSecretLiteral');
    expect(serializedAudit).not.toContain('InitialClientName');
    expect(serializedAudit).not.toContain('UpdatedConfidentialClientName');

    const groupUpdateEntry = entries.find(
      (entry: { resourceKind: string; action: string }) =>
        entry.resourceKind === 'rowLevelPermissionPredicateGroup' &&
        entry.action === 'update',
    );
    expect(groupUpdateEntry).toMatchObject({
      resourceId: keptGroupId,
      redactedDiff: {
        changedFields: ['logicalOperator'],
        values: {
          logicalOperator: { before: 'AND', after: 'OR' },
        },
      },
    });

    const predicateUpdateEntry = entries.find(
      (entry: { resourceKind: string; action: string }) =>
        entry.resourceKind === 'rowLevelPermissionPredicate' &&
        entry.action === 'update',
    );
    expect(predicateUpdateEntry).toMatchObject({
      resourceId: updatedPredicateId,
      redactedDiff: {
        changedFields: ['value'],
        values: {},
      },
    });

    const predicateCreateEntry = entries.find(
      (entry: { resourceKind: string; action: string }) =>
        entry.resourceKind === 'rowLevelPermissionPredicate' &&
        entry.action === 'create',
    );
    expect(predicateCreateEntry).toMatchObject({
      resourceKind: 'rowLevelPermissionPredicate',
      redactedDiff: {
        values: {
          roleId: { before: null, after: roleId },
          objectMetadataId: { before: null, after: companyObjectId },
          fieldMetadataId: { before: null, after: companyNameFieldId },
          operand: { before: null, after: 'IS' },
          workspaceMemberFieldMetadataId: {
            before: null,
            after: workspaceMemberIdFieldId,
          },
          rowLevelPermissionPredicateGroupId: {
            before: null,
            after: newGroupId,
          },
        },
      },
    });
  });

  it('rejects rowLevelPermissionPredicate upsert when concurrent DB predicate exists or workspaceMember object mismatches in DB', async () => {
    const hiddenPredicateId = randomUUID();
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId",
        "fieldMetadataId", operand, value
      ) VALUES ($1, $2, $1, $3, $4, $5, $6, 'CONTAINS', '"ConcurrentRule"'::jsonb)`,
      [
        hiddenPredicateId,
        workspaceId,
        applicationId,
        roleId,
        companyObjectId,
        companyNameFieldId,
      ],
    );

    const staleHarness = buildHarness({
      stalePredicateIdsToHide: [hiddenPredicateId],
    });
    await expect(
      staleHarness.rowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates(
        {
          workspaceId,
          input: {
            roleId,
            objectMetadataId: companyObjectId,
            predicateGroups: [],
            predicates: [
              {
                fieldMetadataId: companyNameFieldId,
                operand: RowLevelPermissionPredicateOperand.CONTAINS,
                value: 'Allowed',
              },
            ],
          },
          auditIdentity: identity(),
        },
      ),
    ).rejects.toThrow(
      'Row level permission audit predicate plan diverges from persisted state',
    );
    expect(await audits()).toHaveLength(0);

    await owner.query('DELETE FROM core."rowLevelPermissionPredicate"');
    const memberObjectMismatchHarness = buildHarness();
    const originalGetMaps =
      memberObjectMismatchHarness.rowLevelPermissionPredicateService[
        'flatEntityMapsCacheService'
      ].getOrRecomputeManyOrAllFlatEntityMaps;
    let firstCall = true;
    memberObjectMismatchHarness.rowLevelPermissionPredicateService[
      'flatEntityMapsCacheService'
    ].getOrRecomputeManyOrAllFlatEntityMaps = jest.fn(async (args) => {
      const maps = await originalGetMaps(args);
      if (firstCall) {
        firstCall = false;
        await owner.query(
          'UPDATE core."objectMetadata" SET "nameSingular"=\'notWorkspaceMember\' WHERE id=$1',
          [workspaceMemberObjectId],
        );
      }
      return maps;
    }) as never;

    await expect(
      memberObjectMismatchHarness.rowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates(
        {
          workspaceId,
          input: {
            roleId,
            objectMetadataId: companyObjectId,
            predicateGroups: [],
            predicates: [
              {
                fieldMetadataId: companyNameFieldId,
                operand: RowLevelPermissionPredicateOperand.IS,
                workspaceMemberFieldMetadataId: workspaceMemberIdFieldId,
              },
            ],
          },
          auditIdentity: identity(),
        },
      ),
    ).rejects.toThrow(
      'Row level permission audit workspaceMemberFieldMetadataId does not belong to workspaceMember object',
    );
    expect(await audits()).toHaveLength(0);
  });

  it('enforces administrative securityDescriptor, nested scope, and single-consumption invariants across all 5 resource kinds', async () => {
    const qr = runtime.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const ctx = new CrmAuditTransactionContext(qr, {
        workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'workspaceMember', id: actorMemberId },
      });
      const resourceId = randomUUID();
      expect(() =>
        ctx.record({
          resourceKind: 'rolePermissionFlag',
          resourceId,
          action: 'update',
          before: { roleId, permissionFlagId: rolesFlagId },
          after: { roleId, permissionFlagId: dataModelFlagId },
          securityDescriptor: {
            resourceKind: 'rolePermissionFlag',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        }),
      ).toThrow('Role audit requires exact current administrative scope');

      for (const resourceKind of [
        'objectPermission',
        'fieldPermission',
        'rowLevelPermissionPredicateGroup',
        'rowLevelPermissionPredicate',
      ] as const) {
        expect(() =>
          ctx.record({
            resourceKind,
            resourceId,
            action: 'create',
            before: null,
            after: { roleId, objectMetadataId: companyObjectId },
            securityDescriptor: {
              resourceKind,
              resourceId,
            },
          }),
        ).toThrow('Role audit requires exact current administrative scope');
      }
    } finally {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }

    await expect(
      withRolePermissionFlagUpsertAudit(
        {
          workspaceId,
          roleId,
          permissionFlagKeys: [PermissionFlagType.ROLES],
        },
        identity(),
        async () => {
          await withObjectPermissionUpsertAudit(
            {
              workspaceId,
              roleId,
              desiredObjectMetadataIds: [companyObjectId],
            },
            identity(),
            async () => undefined,
          );
        },
      ),
    ).rejects.toThrow('Nested role permission audit is unsupported');

    await expect(
      withFieldPermissionUpsertAudit(
        {
          workspaceId,
          roleId,
          touchedFieldKeys: [`${companyObjectId}:${companyNameFieldId}`],
          desiredActiveFieldKeys: [`${companyObjectId}:${companyNameFieldId}`],
        },
        identity(),
        async () => {
          const req = getRolePermissionAudit(workspaceId)!;
          await expect(
            runAuditedRolePermissionUpsert(
              runtime,
              req,
              [],
              undefined,
              async () => undefined,
            ),
          ).rejects.toThrow(
            'Role permission audit requires application and entity mappings',
          );
        },
      ),
    ).resolves.toBeUndefined();

    await expect(
      withRowLevelPermissionUpsertAudit(
        {
          workspaceId,
          roleId,
          objectMetadataId: companyObjectId,
          desiredGroupIds: [companyObjectId, companyObjectId],
          desiredPredicateIds: [],
        },
        identity(),
        async () => undefined,
      ),
    ).rejects.toThrow('Row level permission audit duplicate desired ID');
  });

  it('rejects rowLevelPermissionPredicateGroup deletion when a soft-deleted child row would be cascade-deleted', async () => {
    const parentGroupId = randomUUID();
    const softDeletedChildPredicateId = randomUUID();
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicateGroup" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId", "logicalOperator"
      ) VALUES ($1, $2, $1, $3, $4, $5, 'AND')`,
      [parentGroupId, workspaceId, applicationId, roleId, companyObjectId],
    );
    await owner.query(
      `INSERT INTO core."rowLevelPermissionPredicate" (
        id, "workspaceId", "universalIdentifier", "applicationId", "roleId", "objectMetadataId",
        "fieldMetadataId", operand, value, "rowLevelPermissionPredicateGroupId", "deletedAt"
      ) VALUES ($1, $2, $1, $3, $4, $5, $6, 'CONTAINS', '"RetainedSoftDeleted"'::jsonb, $7, now())`,
      [
        softDeletedChildPredicateId,
        workspaceId,
        applicationId,
        roleId,
        companyObjectId,
        companyNameFieldId,
        parentGroupId,
      ],
    );

    const { rowLevelPermissionPredicateService } = buildHarness();
    await expect(
      rowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates({
        workspaceId,
        input: {
          roleId,
          objectMetadataId: companyObjectId,
          predicateGroups: [],
          predicates: [],
        },
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Row level permission audit foreign or colliding existing row',
    );
    expect(await audits()).toHaveLength(0);
    expect(
      await owner.query(
        'SELECT id FROM core."rowLevelPermissionPredicate" WHERE id=$1',
        [softDeletedChildPredicateId],
      ),
    ).toEqual([{ id: softDeletedChildPredicateId }]);
  });

  it('rejects permission upserts under DB lock when role becomes non-editable or belongs to another application', async () => {
    const harness = buildHarness();
    const originalGetMaps =
      harness.objectPermissionService[
        'workspaceManyOrAllFlatEntityMapsCacheService'
      ].getOrRecomputeManyOrAllFlatEntityMaps;
    let firstCall = true;
    harness.objectPermissionService[
      'workspaceManyOrAllFlatEntityMapsCacheService'
    ].getOrRecomputeManyOrAllFlatEntityMaps = jest.fn(async (args) => {
      const maps = await originalGetMaps(args);
      if (firstCall) {
        firstCall = false;
        await owner.query(
          'UPDATE core.role SET "isEditable"=false WHERE id=$1',
          [roleId],
        );
      }
      return maps;
    }) as never;

    await expect(
      harness.objectPermissionService.upsertObjectPermissions({
        workspaceId,
        input: {
          roleId,
          objectPermissions: [
            {
              objectMetadataId: companyObjectId,
              canReadObjectRecords: true,
            },
          ],
        },
        auditIdentity: identity(),
      }),
    ).rejects.toThrow(
      'Role permission audit persisted role is not editable or belongs to another application',
    );
    expect(await audits()).toHaveLength(0);
  });
});
