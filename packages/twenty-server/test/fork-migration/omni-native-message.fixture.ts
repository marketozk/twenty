import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { compositeTypeDefinitions } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { computeCompositeColumnName } from 'src/engine/metadata-modules/field-metadata/utils/compute-column-name.util';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { buildWorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/utils/build-workspace-table-shape.util';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceSchemaEnumManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-enum-manager.service';
import { WorkspaceSchemaForeignKeyManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-foreign-key-manager.service';
import { WorkspaceSchemaIndexManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-index-manager.service';
import { WorkspaceSchemaTableManagerService } from 'src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-table-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { buildStandardFlatFieldMetadataMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/build-standard-flat-field-metadata-maps.util';
import { getStandardObjectMetadataRelatedEntityIds } from 'src/engine/workspace-manager/twenty-standard-application/utils/get-standard-object-metadata-related-entity-ids.util';
import { buildStandardFlatIndexMetadataMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/index/build-standard-flat-index-metadata-maps.util';
import { buildStandardFlatObjectMetadataMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/object-metadata/build-standard-flat-object-metadata-maps.util';
import { computePostgresEnumName } from 'src/engine/workspace-manager/workspace-migration/utils/compute-postgres-enum-name.util';
import { computeFlatIndexFieldColumnNames } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils';
import { generateColumnDefinitions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/generate-column-definitions.util';

const TABLE_NAMES = [
  'messageThread',
  'message',
  'messageChannelMessageAssociation',
  'messageParticipant',
  'person',
] as const;
type TableName = (typeof TABLE_NAMES)[number];

export const createOmniNativeMessageFixture = () => {
  const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

  if (
    !databaseUrl ||
    !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
  ) {
    throw new Error(
      'A dedicated twenty_rob764_test_<16 hex> database is required',
    );
  }

  const workspaceId = randomUUID();
  const schemaName = getWorkspaceSchemaName(workspaceId);
  const roleName = `native_message_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const runtimeUrl = new URL(databaseUrl);

  runtimeUrl.username = roleName;
  runtimeUrl.password = password;

  const owner = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 3, statement_timeout: 10000 },
  });
  const pool = new Pool({
    connectionString: runtimeUrl.toString(),
    max: 3,
    statement_timeout: 10000,
  });
  const metadataArguments = {
    now: '2026-10-27T00:00:00.000Z',
    workspaceId,
    twentyStandardApplicationId: randomUUID(),
    standardObjectMetadataRelatedEntityIds:
      getStandardObjectMetadataRelatedEntityIds(),
  };
  const flatObjectMetadataMaps = buildStandardFlatObjectMetadataMaps({
    ...metadataArguments,
    dependencyFlatEntityMaps: {
      flatFieldMetadataMaps: createEmptyFlatEntityMaps(),
    },
  });
  const flatFieldMetadataMaps = buildStandardFlatFieldMetadataMaps({
    ...metadataArguments,
    dependencyFlatEntityMaps: { flatObjectMetadataMaps },
  });
  const flatIndexMaps = buildStandardFlatIndexMetadataMaps({
    ...metadataArguments,
    dependencyFlatEntityMaps: { flatObjectMetadataMaps, flatFieldMetadataMaps },
  });
  const objects = Object.values(
    flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  const fields = Object.values(
    flatFieldMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  const indexes = Object.values(flatIndexMaps.byUniversalIdentifier).filter(
    isDefined,
  );

  // Runtime caches hydrate reverse links after standard metadata is persisted.
  for (const object of objects) {
    const objectFields = fields.filter(
      (field) => field.objectMetadataId === object.id,
    );
    const objectIndexes = indexes.filter(
      (index) => index.objectMetadataId === object.id,
    );

    object.fieldIds = objectFields.map((field) => field.id);
    object.fieldUniversalIdentifiers = objectFields.map(
      (field) => field.universalIdentifier,
    );
    object.indexMetadataIds = objectIndexes.map((index) => index.id);
    object.indexMetadataUniversalIdentifiers = objectIndexes.map(
      (index) => index.universalIdentifier,
    );
  }
  const selected = objects.filter((object) =>
    TABLE_NAMES.some((name) => name === object.nameSingular),
  );
  const eventEmitter = jest.fn();
  const recordStock = {
    assertRecordStockAvailable: jest.fn().mockResolvedValue(undefined),
    acquireRecordStock: jest.fn().mockResolvedValue(undefined),
    releaseRecordStock: jest.fn().mockResolvedValue(undefined),
  };
  const internalContext: WorkspaceInternalContext = {
    workspaceId,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    flatIndexMaps,
    objectIdByNameSingular: Object.fromEntries(
      objects.map((object) => [object.nameSingular, object.id]),
    ),
    featureFlagsMap: {} as WorkspaceInternalContext['featureFlagsMap'],
    billingEntitlements: {},
    userWorkspaceRoleMap: {},
    roleIdsWithAllRecordsAccess: [],
    apiKeyRoleMap: {},
    flatRoleTargetByAgentIdMaps: {},
    flatRowLevelPermissionPredicateMaps: createEmptyFlatEntityMaps(),
    flatRowLevelPermissionPredicateGroupMaps: createEmptyFlatEntityMaps(),
    eventEmitterService: { emitDatabaseBatchEvent: eventEmitter },
    recordStock,
    coreDataSource: owner,
  };
  const dataSource = new WorkspaceDataSource({
    pool,
    internalContext,
    authContext: buildSystemAuthContext(workspaceId),
    objectPermissionsByRoleId: {},
  });
  const read = (tableName: TableName) =>
    owner.query(`SELECT * FROM "${schemaName}"."${tableName}" ORDER BY id`);

  const initialize = async () => {
    await owner.initialize();
    await owner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await owner.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
    await owner.query('CREATE SCHEMA core');
    await owner.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
    await owner.query(`CREATE SCHEMA "${schemaName}"`);
    const queryRunner = owner.createQueryRunner();

    await queryRunner.connect();
    try {
      await new OmniAuditBootstrapFastInstanceCommand().up(queryRunner);
      for (const object of selected) {
        const shape = buildWorkspaceTableShape({
          workspaceId,
          flatObjectMetadata: object,
          flatFieldMetadataMaps,
        });
        const fields = object.fieldIds.map((id) => {
          const universalIdentifier =
            flatFieldMetadataMaps.universalIdentifierById[id];

          if (!universalIdentifier)
            throw new Error('Missing standard field identifier');
          const field =
            flatFieldMetadataMaps.byUniversalIdentifier[universalIdentifier];

          if (!field) throw new Error('Missing standard field fixture');

          return field;
        });
        const columns = fields.flatMap((field) =>
          generateColumnDefinitions({
            flatFieldMetadata: field,
            flatObjectMetadata: object,
            workspaceId,
          }),
        );

        for (const column of columns.filter((column) =>
          column.type.startsWith('"'),
        )) {
          let options: { value: string }[] | undefined;

          for (const field of fields) {
            if (field.name === column.name && Array.isArray(field.options)) {
              options = field.options;
              break;
            }
            const properties =
              compositeTypeDefinitions.get(field.type)?.properties ?? [];
            const property = properties.find(
              (candidate) =>
                computeCompositeColumnName(field.name, candidate) ===
                column.name,
            );

            if (property && Array.isArray(property.options))
              options = property.options;
          }
          if (!options)
            throw new Error(`Missing enum fixture options: ${column.name}`);
          await new WorkspaceSchemaEnumManagerService().createEnum({
            queryRunner,
            schemaName,
            enumName: computePostgresEnumName({
              tableName: shape.tableName,
              columnName: column.name,
            }),
            values: options.map((option) => option.value),
          });
        }
        await new WorkspaceSchemaTableManagerService().createTable({
          queryRunner,
          schemaName,
          tableName: shape.tableName,
          columnDefinitions: columns,
        });
      }
      for (const object of selected) {
        const shape = buildWorkspaceTableShape({
          workspaceId,
          flatObjectMetadata: object,
          flatFieldMetadataMaps,
        });

        for (const relation of Object.values(shape.relationShapeByFieldName)) {
          const target = selected.find(
            (candidate) => candidate.id === relation.targetObjectMetadataId,
          );

          if (!target || !relation.joinColumnName) continue;
          await new WorkspaceSchemaForeignKeyManagerService().createForeignKey({
            queryRunner,
            schemaName,
            foreignKey: {
              tableName: shape.tableName,
              columnName: relation.joinColumnName,
              referencedTableName: target.nameSingular,
              referencedColumnName: 'id',
            },
          });
        }
        for (const index of Object.values(flatIndexMaps.byUniversalIdentifier)
          .filter(isDefined)
          .filter((index) => index.objectMetadataId === object.id)) {
          await new WorkspaceSchemaIndexManagerService().createIndex({
            queryRunner,
            schemaName,
            tableName: shape.tableName,
            index: {
              name: index.name,
              columns: computeFlatIndexFieldColumnNames({
                flatIndexFieldMetadatas: index.flatIndexFieldMetadatas,
                flatFieldMetadataMaps,
              }),
              type: index.indexType,
              isUnique: index.isUnique,
              where: index.indexWhereClause ?? undefined,
            },
          });
        }
      }
    } finally {
      await queryRunner.release();
    }
    await owner.query(
      `GRANT USAGE ON SCHEMA "${schemaName}", crm_audit TO "${roleName}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${roleName}"`,
    );
  };
  const reset = async () => {
    await owner.query(
      `TRUNCATE ${TABLE_NAMES.map((name) => `"${schemaName}"."${name}"`).join(', ')} CASCADE`,
    );
    await owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    eventEmitter.mockClear();
    Object.values(recordStock).forEach((method) => method.mockClear());
  };
  const dispose = async () => {
    await pool.end();
    if (owner.isInitialized) {
      await owner.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
      await owner.query(`DROP OWNED BY "${roleName}"`);
      await owner.query(`DROP ROLE "${roleName}"`);
      await owner.destroy();
    }
  };

  return {
    workspaceId,
    schemaName,
    dataSource,
    owner,
    pool,
    eventEmitter,
    recordStock,
    read,
    initialize,
    reset,
    dispose,
    flatFieldMetadataMaps,
  };
};
