import { Injectable } from '@nestjs/common';

import { msg } from '@lingui/core/macro';
import chunk from 'lodash.chunk';
import { TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER } from 'twenty-shared/application-runtime';
import {
  MUTATION_MAX_MERGE_RECORDS,
  QUERY_MAX_RECORDS,
  QUERY_MAX_RECORDS_FROM_RELATION,
} from 'twenty-shared/constants';
import {
  FieldMetadataSettingsMapping,
  FieldMetadataType,
  ObjectRecord,
  RelationType,
} from 'twenty-shared/types';
import { isDefined, isValidUuid, uuidToBase36 } from 'twenty-shared/utils';
import { FindOptionsRelations, In, IsNull, ObjectLiteral } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { CommonBaseQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-base-query-runner.service';
import {
  CommonQueryRunnerException,
  CommonQueryRunnerExceptionCode,
} from 'src/engine/api/common/common-query-runners/errors/common-query-runner.exception';
import { STANDARD_ERROR_MESSAGE } from 'src/engine/api/common/common-query-runners/errors/standard-error-message.constant';
import { computeDuplicateKeyColumnGroupsForJoinColumn } from 'src/engine/api/common/common-query-runners/utils/compute-duplicate-key-column-groups-for-join-column.util';
import { splitRelatedRecordIdsToMigrateAndSoftDelete } from 'src/engine/api/common/common-query-runners/utils/split-related-record-ids-to-migrate-and-soft-delete.util';
import { CommonBaseQueryRunnerContext } from 'src/engine/api/common/types/common-base-query-runner-context.type';
import { CommonExtendedQueryRunnerContext } from 'src/engine/api/common/types/common-extended-query-runner-context.type';
import {
  CommonExtendedInput,
  CommonInput,
  CommonQueryNames,
  MergeManyQueryArgs,
} from 'src/engine/api/common/types/common-query-args.type';
import { getAllSelectableColumnNames } from 'src/engine/api/utils/get-all-selectable-column-names.util';
import { buildColumnsToReturn } from 'src/engine/api/graphql/graphql-query-runner/utils/build-columns-to-return';
import { hasRecordFieldValue } from 'src/engine/api/graphql/graphql-query-runner/utils/has-record-field-value.util';
import { mergeFieldValues } from 'src/engine/api/graphql/graphql-query-runner/utils/merge-field-values.util';
import { WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  isNativeCrmAuditMetadata,
  isNativeCrmAuditObject,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { isRegisteredNativeCrmAuditScope } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { computeMorphOrRelationFieldJoinColumnName } from 'src/engine/metadata-modules/field-metadata/utils/compute-morph-or-relation-field-join-column-name.util';
import { FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { buildFieldMapsFromFlatObjectMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { type FlatIndexMetadata } from 'src/engine/metadata-modules/flat-index-metadata/types/flat-index-metadata.type';
import { FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { assertMutationNotOnRemoteObject } from 'src/engine/metadata-modules/object-metadata/utils/assert-mutation-not-on-remote-object.util';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { resolveEffectiveFlatEntityProperty } from 'src/engine/metadata-modules/overrides/utils/resolve-effective-flat-entity-property.util';
import { computeTableName } from 'src/engine/utils/compute-table-name.util';

const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const getTargetTableName = (
  objectMetadata: Pick<
    FlatObjectMetadata,
    'nameSingular' | 'applicationUniversalIdentifier'
  >,
): string =>
  computeTableName(
    objectMetadata.nameSingular,
    objectMetadata.applicationUniversalIdentifier !==
      TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
  );

@Injectable()
export class CommonMergeManyQueryRunnerService extends CommonBaseQueryRunnerService<
  MergeManyQueryArgs,
  ObjectRecord
> {
  protected readonly operationName = CommonQueryNames.MERGE_MANY;

  async run(
    args: CommonExtendedInput<MergeManyQueryArgs>,
    queryRunnerContext: CommonExtendedQueryRunnerContext,
  ): Promise<ObjectRecord> {
    const { flatFieldMetadataMaps, flatObjectMetadata } = queryRunnerContext;
    const normalizedArgs: CommonExtendedInput<MergeManyQueryArgs> = {
      ...args,
      ids: args.ids.map((id) => id.toLowerCase()),
    };

    if (normalizedArgs.dryRun) {
      const recordsToMerge = await this.fetchRecordsToMerge(
        queryRunnerContext,
        normalizedArgs,
      );

      const priorityRecord = this.validateAndGetPriorityRecord(
        recordsToMerge,
        normalizedArgs.ids,
        normalizedArgs.conflictPriorityIndex,
      );

      const mergedData = this.performDeepMerge(
        recordsToMerge,
        priorityRecord.id,
        flatObjectMetadata,
        flatFieldMetadataMaps,
        true,
      );

      this.assertMergeFilesSupported({
        flatObjectMetadata,
        flatFieldMetadataMaps,
        priorityRecord,
        mergedData,
        recordsToMerge,
      });

      return this.createDryRunResponse(priorityRecord, mergedData);
    }

    const runMerge = async (
      transactionScope: WorkspaceTransactionScope,
    ): Promise<ObjectRecord> => {
      const objectRepository = transactionScope.getRepository<ObjectRecord>(
        flatObjectMetadata.nameSingular,
        queryRunnerContext.rolePermissionConfig,
      );

      // Verify object permissions and select-RLS visibility before acquiring FOR UPDATE row locks.
      objectRepository.validateWriteIsPermitted({
        operationType: 'delete',
        columnsToReturn: ['id'],
        updatedColumns: [],
      });
      objectRepository.validateWriteIsPermitted({
        operationType: 'update',
        columnsToReturn: ['id'],
        updatedColumns: [],
      });

      const visibleRecords = await objectRepository
        .createQueryBuilder(flatObjectMetadata.nameSingular)
        .select(['id'])
        .where({ id: In(normalizedArgs.ids) })
        .getMany<ObjectRecord>({ noFormatting: true });

      if (visibleRecords.length !== normalizedArgs.ids.length) {
        throw new CommonQueryRunnerException(
          'One or more records not found',
          CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
          { userFriendlyMessage: msg`One or more records were not found.` },
        );
      }

      const schemaName = `workspace_${uuidToBase36(transactionScope.workspaceId)}`;
      const tableName = getTargetTableName(flatObjectMetadata);

      // Lock parent rows in canonical id order before reading or migrating children
      // to prevent READ COMMITTED TOCTOU and child->parent lock-order inversions.
      await transactionScope.executeRawQuery(
        `SELECT id FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [normalizedArgs.ids],
      );

      const scopedContext: CommonExtendedQueryRunnerContext = {
        ...queryRunnerContext,
        transactionScope,
        repository: objectRepository,
      };

      const recordsToMerge = await this.fetchRecordsToMerge(
        scopedContext,
        normalizedArgs,
      );

      const priorityRecord = this.validateAndGetPriorityRecord(
        recordsToMerge,
        normalizedArgs.ids,
        normalizedArgs.conflictPriorityIndex,
      );

      const mergedData = this.performDeepMerge(
        recordsToMerge,
        priorityRecord.id,
        flatObjectMetadata,
        flatFieldMetadataMaps,
        false,
      );

      this.assertMergeFilesSupported({
        flatObjectMetadata,
        flatFieldMetadataMaps,
        priorityRecord,
        mergedData,
        recordsToMerge,
      });

      const idsToDelete = normalizedArgs.ids.filter(
        (id) => id !== priorityRecord.id,
      );

      await this.assertNoSharedFilesAcrossLockedRows({
        transactionScope,
        schemaName,
        tableName,
        flatObjectMetadata,
        flatFieldMetadataMaps,
        priorityRecordId: priorityRecord.id,
        idsToDelete,
      });

      const updatedRecord = await this.executeMergeWithinScope({
        args: normalizedArgs,
        queryRunnerContext: scopedContext,
        transactionScope,
        objectRepository,
        schemaName,
        idsToDelete,
        priorityRecordId: priorityRecord.id,
        mergedData,
      });

      await this.processNestedRelations({
        args: normalizedArgs,
        queryRunnerContext: scopedContext,
        updatedRecords: [updatedRecord],
      });

      return updatedRecord;
    };

    const isCoveredObject =
      isNativeCrmAuditObject(
        flatObjectMetadata.nameSingular,
        flatObjectMetadata.universalIdentifier,
      ) ||
      isNativeCrmAuditMetadata(
        flatObjectMetadata,
        queryRunnerContext.authContext.workspace.id,
      );

    if (isDefined(queryRunnerContext.transactionScope)) {
      if (
        isCoveredObject &&
        !isRegisteredNativeCrmAuditScope(queryRunnerContext.transactionScope)
      ) {
        throw new Error('Public CRM merge requires a proven native audit scope');
      }

      return runMerge(queryRunnerContext.transactionScope);
    }

    if (isCoveredObject) {
      throw new Error('Public CRM merge requires a proven native audit scope');
    }

    return this.workspaceOrmManager.runInWorkspaceTransaction(runMerge);
  }

  private async fetchRecordsToMerge(
    context: CommonExtendedQueryRunnerContext,
    args: CommonExtendedInput<MergeManyQueryArgs>,
  ): Promise<ObjectRecord[]> {
    const restrictedFields =
      context.repository.objectRecordsPermissions?.[
        context.flatObjectMetadata.id
      ]?.restrictedFields;

    const columnsToSelect = getAllSelectableColumnNames({
      restrictedFields: restrictedFields ?? {},
      objectMetadata: {
        objectMetadataMapItem: context.flatObjectMetadata,
        flatFieldMetadataMaps: context.flatFieldMetadataMaps,
      },
    });

    const fetchedRecords = (await context.repository.find({
      where: { id: In(args.ids) },
      select: columnsToSelect,
    })) as ObjectRecord[];

    if (fetchedRecords.length !== args.ids.length) {
      throw new CommonQueryRunnerException(
        'One or more records not found',
        CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
        { userFriendlyMessage: msg`One or more records were not found.` },
      );
    }

    const orderIndex = new Map(args.ids.map((id, index) => [id, index]));

    fetchedRecords.sort(
      (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
    );

    const recordsToMerge = fetchedRecords;

    if (args.dryRun && args.selectedFieldsResult.relations) {
      await this.processNestedRelationsHelper.processNestedRelations({
        flatObjectMetadataMaps: context.flatObjectMetadataMaps,
        flatFieldMetadataMaps: context.flatFieldMetadataMaps,
        parentObjectMetadataItem: context.flatObjectMetadata,
        parentObjectRecords: recordsToMerge,
        relations: args.selectedFieldsResult.relations as Record<
          string,
          FindOptionsRelations<ObjectLiteral>
        >,
        limit: QUERY_MAX_RECORDS_FROM_RELATION,
        authContext: context.authContext,
        rolePermissionConfig: context.rolePermissionConfig,
        repository: context.repository,
        selectedFields: args.selectedFieldsResult.select,
        ...this.getNestedRelationsReadPathOptions(),
      });
    }

    return recordsToMerge;
  }

  private validateAndGetPriorityRecord(
    recordsToMerge: ObjectRecord[],
    ids: string[],
    conflictPriorityIndex: number,
  ): ObjectRecord {
    const priorityRecordId = ids[conflictPriorityIndex];
    const priorityRecord = recordsToMerge.find(
      (record) => record.id === priorityRecordId,
    );

    if (!priorityRecord) {
      throw new CommonQueryRunnerException(
        'Priority record not found',
        CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
        {
          userFriendlyMessage: msg`This record does not exist or has been deleted.`,
        },
      );
    }

    return priorityRecord;
  }

  private performDeepMerge(
    recordsToMerge: ObjectRecord[],
    priorityRecordId: string,
    flatObjectMetadata: FlatObjectMetadata,
    flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
    isDryRun = false,
  ): Partial<ObjectRecord> {
    const mergedResult: Partial<ObjectRecord> = {};

    const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
      flatFieldMetadataMaps,
      flatObjectMetadata,
    );

    const allFieldNames = new Set<string>();

    recordsToMerge.forEach((record) => {
      Object.keys(record).forEach((fieldName) => {
        if (
          !this.shouldExcludeFieldFromMerge(
            fieldName,
            fieldIdByName,
            flatFieldMetadataMaps,
          )
        ) {
          allFieldNames.add(fieldName);
        }
      });
    });

    allFieldNames.forEach((fieldName) => {
      const recordsWithValues: { value: unknown; recordId: string }[] = [];

      recordsToMerge.forEach((record) => {
        const fieldValue = record[fieldName];

        if (hasRecordFieldValue(fieldValue)) {
          recordsWithValues.push({ value: fieldValue, recordId: record.id });
        }
      });

      if (recordsWithValues.length === 0) {
        return;
      } else if (recordsWithValues.length === 1) {
        mergedResult[fieldName] = recordsWithValues[0].value;
      } else {
        const fieldMetadata = findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: fieldIdByName[fieldName],
          flatEntityMaps: flatFieldMetadataMaps,
        });

        if (!fieldMetadata) {
          return;
        }

        const relationType =
          isDryRun && fieldMetadata.type === FieldMetadataType.RELATION
            ? (
                fieldMetadata.settings as FieldMetadataSettingsMapping['RELATION']
              )?.relationType
            : undefined;

        mergedResult[fieldName] = mergeFieldValues(
          fieldMetadata.type,
          recordsWithValues,
          priorityRecordId,
          isDryRun,
          relationType,
        );
      }
    });

    return mergedResult;
  }

  private shouldExcludeFieldFromMerge(
    fieldName: string,
    fieldIdByName: Record<string, string>,
    flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
  ): boolean {
    const fieldMetadata = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: fieldIdByName[fieldName],
      flatEntityMaps: flatFieldMetadataMaps,
    });

    return fieldMetadata?.isSystem ?? false;
  }

  private createDryRunResponse(
    priorityRecord: ObjectRecord,
    mergedData: Partial<ObjectRecord>,
  ): ObjectRecord {
    const dryRunRecord: ObjectRecord = {
      ...priorityRecord,
      ...mergedData,
      id: uuidv4(),
      deletedAt: new Date().toISOString(),
    };

    return dryRunRecord;
  }

  private getRelationFieldsPointingToCurrentObject(
    context: CommonExtendedQueryRunnerContext,
  ): Array<{ objectMetadata: FlatObjectMetadata; joinColumnName: string }> {
    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatObjectMetadata,
    } = context;

    const relationFields: Array<{
      objectMetadata: FlatObjectMetadata;
      joinColumnName: string;
    }> = [];

    for (const field of Object.values(
      flatFieldMetadataMaps.byUniversalIdentifier,
    ).filter(isDefined)) {
      if (
        !isMorphOrRelationFlatFieldMetadata(field) ||
        field.relationTargetObjectMetadataId !== flatObjectMetadata.id ||
        !resolveEffectiveFlatEntityProperty({
          metadataName: 'fieldMetadata',
          flatEntity: field,
          property: 'isActive',
        })
      ) {
        continue;
      }

      const relationSettings = field.settings as
        | FieldMetadataSettingsMapping['RELATION']
        | FieldMetadataSettingsMapping['MORPH_RELATION']
        | undefined;

      if (relationSettings?.relationType !== RelationType.MANY_TO_ONE) {
        continue;
      }

      const objMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: field.objectMetadataId,
        flatEntityMaps: flatObjectMetadataMaps,
      });

      if (
        !objMetadata ||
        objMetadata.isRemote ||
        !resolveEffectiveFlatEntityProperty({
          metadataName: 'objectMetadata',
          flatEntity: objMetadata,
          property: 'isActive',
        })
      ) {
        continue;
      }

      relationFields.push({
        objectMetadata: objMetadata,
        joinColumnName: computeMorphOrRelationFieldJoinColumnName({
          name: field.name,
        }),
      });
    }

    return relationFields.sort(
      (a, b) =>
        a.objectMetadata.nameSingular.localeCompare(
          b.objectMetadata.nameSingular,
        ) || a.joinColumnName.localeCompare(b.joinColumnName),
    );
  }

  private async mergeRelatedRecordsIntoPriorityRecord({
    transactionScope,
    schemaName,
    targetObjectMetadataId,
    relationField,
    flatFieldMetadataMaps,
    flatIndexMaps,
    rolePermissionConfig,
    idsToDelete,
    priorityRecordId,
  }: {
    transactionScope: WorkspaceTransactionScope;
    schemaName: string;
    targetObjectMetadataId: string;
    relationField: {
      objectMetadata: FlatObjectMetadata;
      joinColumnName: string;
    };
    flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
    flatIndexMaps: FlatEntityMaps<FlatIndexMetadata>;
    rolePermissionConfig: RolePermissionConfig;
    idsToDelete: string[];
    priorityRecordId: string;
  }): Promise<void> {
    const { joinColumnName } = relationField;
    const alias = relationField.objectMetadata.nameSingular;
    const isSelfRelation =
      relationField.objectMetadata.id === targetObjectMetadataId;

    const relatedRepository = transactionScope.getRepository(
      alias,
      rolePermissionConfig,
    );

    const duplicateKeyColumnGroups =
      computeDuplicateKeyColumnGroupsForJoinColumn({
        flatObjectMetadata: relationField.objectMetadata,
        flatFieldMetadataMaps,
        flatIndexMaps,
        joinColumnName,
      });

    const columnsToSelect = ['id', ...new Set(duplicateKeyColumnGroups.flat())];

    const relatedRecordsOfRecordsToDelete = await relatedRepository
      .createQueryBuilder(alias)
      .select(columnsToSelect)
      .where({ [joinColumnName]: In(idsToDelete) })
      .getMany<ObjectRecord>({ noFormatting: true });

    relatedRecordsOfRecordsToDelete.sort((a, b) => a.id.localeCompare(b.id));

    const relatedTableName = getTargetTableName(relationField.objectMetadata);
    const hasDeletedAtColumn = isDefined(
      buildFieldMapsFromFlatObjectMetadata(
        flatFieldMetadataMaps,
        relationField.objectMetadata,
      ).fieldIdByName['deletedAt'],
    );
    const activeFilterSql = hasDeletedAtColumn
      ? ' AND "deletedAt" IS NULL'
      : '';
    const [actualDeleteCountRow] = await transactionScope.executeRawQuery(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(relatedTableName)} WHERE ${quoteIdentifier(joinColumnName)} = ANY($1::uuid[])${activeFilterSql}`,
      [idsToDelete],
    );

    // Fail closed if select-RLS hid live child rows so DELETE cannot silently SET NULL or CASCADE them.
    if (
      Number(actualDeleteCountRow?.count ?? 0) >
      relatedRecordsOfRecordsToDelete.length
    ) {
      throw new CommonQueryRunnerException(
        'Cannot merge records with inaccessible related records',
        CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    if (relatedRecordsOfRecordsToDelete.length === 0) {
      return;
    }

    const idsToDeleteSet = new Set(idsToDelete);
    const priorityPointsToDeleted =
      isSelfRelation &&
      relatedRecordsOfRecordsToDelete.some(
        (record) => record.id === priorityRecordId,
      );
    const externalRelatedRecords = isSelfRelation
      ? relatedRecordsOfRecordsToDelete.filter(
          (record) =>
            record.id !== priorityRecordId && !idsToDeleteSet.has(record.id),
        )
      : relatedRecordsOfRecordsToDelete;

    if (priorityPointsToDeleted) {
      const cleared = await relatedRepository.runMutation({
        selectQueryBuilder: relatedRepository
          .createQueryBuilder(alias)
          .where({
            id: priorityRecordId,
            [joinColumnName]: In(idsToDelete),
            ...(hasDeletedAtColumn ? { deletedAt: IsNull() } : {}),
          }),
        rowLevelPermissionsApplied: false,
        kind: 'update',
        columnsToReturn: ['id'],
        data: { [joinColumnName]: null },
      });

      if (cleared.length !== 1) {
        throw new CommonQueryRunnerException(
          'One or more related records could not be migrated during merge',
          CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
          { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
        );
      }
    }

    if (externalRelatedRecords.length === 0) {
      return;
    }

    const relatedRecordsOfPriorityRecord =
      duplicateKeyColumnGroups.length === 0
        ? []
        : await relatedRepository
            .createQueryBuilder(alias)
            .select(columnsToSelect)
            .where({ [joinColumnName]: priorityRecordId })
            .getMany<ObjectRecord>({ noFormatting: true });

    if (duplicateKeyColumnGroups.length > 0) {
      const [actualPriorityCountRow] = await transactionScope.executeRawQuery(
        `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(relatedTableName)} WHERE ${quoteIdentifier(joinColumnName)} = $1${activeFilterSql}`,
        [priorityRecordId],
      );

      if (
        Number(actualPriorityCountRow?.count ?? 0) >
        relatedRecordsOfPriorityRecord.length
      ) {
        throw new CommonQueryRunnerException(
          'Cannot merge records with inaccessible related records',
          CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
          { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
        );
      }
    }

    const { idsToMigrate, idsToSoftDelete } =
      splitRelatedRecordIdsToMigrateAndSoftDelete({
        relatedRecordsOfRecordsToDelete: externalRelatedRecords,
        relatedRecordsOfPriorityRecord,
        duplicateKeyColumnGroups,
      });

    for (const idsChunk of chunk(idsToSoftDelete, QUERY_MAX_RECORDS)) {
      const softDeleted = await relatedRepository.runMutation({
        selectQueryBuilder: relatedRepository
          .createQueryBuilder(alias)
          .where({
            id: In(idsChunk),
            [joinColumnName]: In(idsToDelete),
            ...(hasDeletedAtColumn ? { deletedAt: IsNull() } : {}),
          }),
        rowLevelPermissionsApplied: false,
        kind: 'soft-delete',
        columnsToReturn: ['id'],
      });

      if (softDeleted.length !== idsChunk.length) {
        throw new CommonQueryRunnerException(
          'One or more related records could not be soft-deleted during merge',
          CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
          { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
        );
      }
    }

    for (const idsChunk of chunk(idsToMigrate, QUERY_MAX_RECORDS)) {
      const migrated = await relatedRepository.runMutation({
        selectQueryBuilder: relatedRepository
          .createQueryBuilder(alias)
          .where({
            id: In(idsChunk),
            [joinColumnName]: In(idsToDelete),
            ...(hasDeletedAtColumn ? { deletedAt: IsNull() } : {}),
          }),
        rowLevelPermissionsApplied: false,
        kind: 'update',
        columnsToReturn: ['id'],
        data: { [joinColumnName]: priorityRecordId },
      });

      if (migrated.length !== idsChunk.length) {
        throw new CommonQueryRunnerException(
          'One or more related records could not be migrated during merge',
          CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
          { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
        );
      }
    }
  }

  private async executeMergeWithinScope({
    args,
    queryRunnerContext,
    transactionScope,
    objectRepository,
    schemaName,
    idsToDelete,
    priorityRecordId,
    mergedData,
  }: {
    args: CommonExtendedInput<MergeManyQueryArgs>;
    queryRunnerContext: CommonExtendedQueryRunnerContext;
    transactionScope: WorkspaceTransactionScope;
    objectRepository: CommonExtendedQueryRunnerContext['repository'];
    schemaName: string;
    idsToDelete: string[];
    priorityRecordId: string;
    mergedData: Partial<ObjectRecord>;
  }): Promise<ObjectRecord> {
    const {
      flatObjectMetadata,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatIndexMaps,
      rolePermissionConfig,
    } = queryRunnerContext;

    if (!isDefined(flatIndexMaps)) {
      throw new CommonQueryRunnerException(
        `Missing flatIndexMaps in queryRunnerContext`,
        CommonQueryRunnerExceptionCode.MISSING_FLAT_INDEX_MAPS,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    const alias = flatObjectMetadata.nameSingular;

    const columnsToReturn = buildColumnsToReturn({
      select: args.selectedFieldsResult.select,
      relations: args.selectedFieldsResult.relations,
      flatObjectMetadata,
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
    });

    this.metricsService.incrementCounterBy({
      key: MetricsKeys.OrmV2WritePathUsed,
      amount: 1,
      attributes: { operation: this.operationName },
    });

    const relationFields =
      this.getRelationFieldsPointingToCurrentObject(queryRunnerContext);
    const allMergedIds = new Set([priorityRecordId, ...idsToDelete]);

    for (const relationField of relationFields) {
      await this.mergeRelatedRecordsIntoPriorityRecord({
        transactionScope,
        schemaName,
        targetObjectMetadataId: flatObjectMetadata.id,
        relationField,
        flatFieldMetadataMaps,
        flatIndexMaps,
        rolePermissionConfig,
        idsToDelete,
        priorityRecordId,
      });

      if (
        relationField.objectMetadata.id === flatObjectMetadata.id &&
        typeof mergedData[relationField.joinColumnName] === 'string' &&
        allMergedIds.has(
          (mergedData[relationField.joinColumnName] as string).toLowerCase(),
        )
      ) {
        mergedData[relationField.joinColumnName] = null;
      }
    }

    const deletedRecords = await objectRepository.runMutation({
      selectQueryBuilder: objectRepository
        .createQueryBuilder(alias)
        .where({ id: In(idsToDelete) }),
      rowLevelPermissionsApplied: false,
      kind: 'delete',
      columnsToReturn,
    });

    if (deletedRecords.length !== idsToDelete.length) {
      throw new CommonQueryRunnerException(
        'One or more records could not be deleted during merge',
        CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
        {
          userFriendlyMessage: msg`One or more records could not be deleted during merge.`,
        },
      );
    }

    const [resolvedMergedData] = await this.resolveNestedRelations({
      records: [mergedData],
      queryRunnerContext,
      writeRepository: objectRepository,
    });

    const updatedRecords = await objectRepository.runMutation({
      selectQueryBuilder: objectRepository
        .createQueryBuilder(alias)
        .where({ id: priorityRecordId }),
      rowLevelPermissionsApplied: false,
      kind: 'update',
      columnsToReturn,
      data: resolvedMergedData,
    });

    if (!isDefined(updatedRecords[0])) {
      throw new CommonQueryRunnerException(
        'Failed to update record',
        CommonQueryRunnerExceptionCode.RECORD_NOT_FOUND,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    return updatedRecords[0];
  }

  private extractNormalizedFileIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter(
        (item): item is { fileId: string } =>
          isDefined(item) &&
          typeof item === 'object' &&
          typeof (item as { fileId?: unknown }).fileId === 'string',
      )
      .map((item) => item.fileId.toLowerCase());
  }

  private assertMergeFilesSupported({
    flatObjectMetadata,
    flatFieldMetadataMaps,
    priorityRecord,
    mergedData,
    recordsToMerge,
  }: {
    flatObjectMetadata: CommonExtendedQueryRunnerContext['flatObjectMetadata'];
    flatFieldMetadataMaps: CommonExtendedQueryRunnerContext['flatFieldMetadataMaps'];
    priorityRecord: ObjectRecord;
    mergedData: Partial<ObjectRecord>;
    recordsToMerge: ObjectRecord[];
  }): void {
    const priorityAllFileIds = new Set<string>();
    const filesFieldNames: string[] = [];

    for (const fieldId of flatObjectMetadata.fieldIds) {
      const fieldMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: fieldId,
        flatEntityMaps: flatFieldMetadataMaps,
      });
      if (fieldMetadata?.type !== FieldMetadataType.FILES) {
        continue;
      }
      filesFieldNames.push(fieldMetadata.name);
      const priorityIds = this.extractNormalizedFileIds(
        priorityRecord[fieldMetadata.name],
      );
      const priorityFieldSet = new Set(priorityIds);
      for (const fileId of priorityIds) {
        priorityAllFileIds.add(fileId);
      }

      const mergedValue = mergedData[fieldMetadata.name];
      if (!Array.isArray(mergedValue) || mergedValue.length === 0) {
        continue;
      }
      const introducesDuplicateFile = mergedValue.some((item) => {
        const candidateId =
          isDefined(item) &&
          typeof item === 'object' &&
          typeof (item as { fileId?: unknown }).fileId === 'string'
            ? (item as { fileId: string }).fileId.toLowerCase()
            : undefined;

        return !isDefined(candidateId) || !priorityFieldSet.has(candidateId);
      });
      if (introducesDuplicateFile) {
        throw new CommonQueryRunnerException(
          'Merging files from duplicate records onto a priority record without files is not supported',
          CommonQueryRunnerExceptionCode.BAD_REQUEST,
          {
            userFriendlyMessage: msg`Merging files from duplicate records onto a priority record without files is not supported.`,
          },
        );
      }
    }

    if (priorityAllFileIds.size === 0) {
      return;
    }

    for (const record of recordsToMerge) {
      if (record.id === priorityRecord.id) {
        continue;
      }
      for (const fieldName of filesFieldNames) {
        if (
          this.extractNormalizedFileIds(record[fieldName]).some((fileId) =>
            priorityAllFileIds.has(fileId),
          )
        ) {
          throw new CommonQueryRunnerException(
            'Merging records that share the same file is not supported',
            CommonQueryRunnerExceptionCode.BAD_REQUEST,
            {
              userFriendlyMessage: msg`Merging records that share the same file is not supported.`,
            },
          );
        }
      }
    }
  }

  private async assertNoSharedFilesAcrossLockedRows({
    transactionScope,
    schemaName,
    tableName,
    flatObjectMetadata,
    flatFieldMetadataMaps,
    priorityRecordId,
    idsToDelete,
  }: {
    transactionScope: WorkspaceTransactionScope;
    schemaName: string;
    tableName: string;
    flatObjectMetadata: CommonExtendedQueryRunnerContext['flatObjectMetadata'];
    flatFieldMetadataMaps: CommonExtendedQueryRunnerContext['flatFieldMetadataMaps'];
    priorityRecordId: string;
    idsToDelete: string[];
  }): Promise<void> {
    const filesFieldNames: string[] = [];
    for (const fieldId of flatObjectMetadata.fieldIds) {
      const fieldMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: fieldId,
        flatEntityMaps: flatFieldMetadataMaps,
      });
      if (fieldMetadata?.type === FieldMetadataType.FILES) {
        filesFieldNames.push(fieldMetadata.name);
      }
    }
    if (filesFieldNames.length === 0 || idsToDelete.length === 0) {
      return;
    }

    // Read raw FILES columns bypassing restrictedFields so shared fileIds on hidden fields are never hard-deleted.
    const columnSelect = filesFieldNames
      .map((name) => quoteIdentifier(name))
      .join(', ');
    const rows = (await transactionScope.executeRawQuery(
      `SELECT id, ${columnSelect} FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} WHERE id = ANY($1::uuid[])`,
      [[priorityRecordId, ...idsToDelete]],
    )) as Array<Record<string, unknown>>;

    const priorityRow = rows.find(
      (row) => String(row.id).toLowerCase() === priorityRecordId.toLowerCase(),
    );
    if (!priorityRow) {
      return;
    }

    const priorityFileIds = new Set<string>();
    for (const fieldName of filesFieldNames) {
      const raw = priorityRow[fieldName];
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      for (const fileId of this.extractNormalizedFileIds(parsed)) {
        priorityFileIds.add(fileId);
      }
    }
    if (priorityFileIds.size === 0) {
      return;
    }

    for (const row of rows) {
      if (String(row.id).toLowerCase() === priorityRecordId.toLowerCase()) {
        continue;
      }
      for (const fieldName of filesFieldNames) {
        const raw = row[fieldName];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (
          this.extractNormalizedFileIds(parsed).some((fileId) =>
            priorityFileIds.has(fileId),
          )
        ) {
          throw new CommonQueryRunnerException(
            'Merging records that share the same file is not supported',
            CommonQueryRunnerExceptionCode.BAD_REQUEST,
            {
              userFriendlyMessage: msg`Merging records that share the same file is not supported.`,
            },
          );
        }
      }
    }
  }

  private async processNestedRelations({
    args,
    queryRunnerContext,
    updatedRecords,
  }: {
    args: CommonExtendedInput<MergeManyQueryArgs>;
    queryRunnerContext: CommonExtendedQueryRunnerContext;
    updatedRecords: ObjectRecord[];
  }): Promise<void> {
    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatObjectMetadata,
      authContext,
      rolePermissionConfig,
    } = queryRunnerContext;

    if (args.selectedFieldsResult.relations) {
      await this.processNestedRelationsHelper.processNestedRelations({
        flatObjectMetadataMaps,
        flatFieldMetadataMaps,
        parentObjectMetadataItem: flatObjectMetadata,
        parentObjectRecords: updatedRecords,
        relations: args.selectedFieldsResult.relations as Record<
          string,
          FindOptionsRelations<ObjectLiteral>
        >,
        limit: QUERY_MAX_RECORDS_FROM_RELATION,
        authContext,
        rolePermissionConfig,
        repository: queryRunnerContext.repository,
        selectedFields: args.selectedFieldsResult.select,
        ...this.getNestedRelationsReadPathOptions(),
      });
    }
  }

  async computeArgs(
    args: CommonInput<MergeManyQueryArgs>,
    _queryRunnerContext: CommonBaseQueryRunnerContext,
  ): Promise<CommonInput<MergeManyQueryArgs>> {
    return args;
  }

  async processQueryResult(
    queryResult: ObjectRecord,
    _flatObjectMetadata: FlatObjectMetadata,
    _flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>,
    _flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
    _authContext: WorkspaceAuthContext,
  ): Promise<ObjectRecord> {
    return queryResult;
  }

  async validate(
    args: CommonInput<MergeManyQueryArgs>,
    queryRunnerContext: CommonExtendedQueryRunnerContext,
  ): Promise<void> {
    const { flatObjectMetadata } = queryRunnerContext;

    assertMutationNotOnRemoteObject(flatObjectMetadata);

    if (!isDefined(flatObjectMetadata.duplicateCriteria)) {
      throw new CommonQueryRunnerException(
        `Merge is only available for objects with duplicate criteria. Object '${flatObjectMetadata.nameSingular}' does not have duplicate criteria defined.`,
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        { userFriendlyMessage: msg`This type of record cannot be merged.` },
      );
    }

    const { ids, conflictPriorityIndex, dryRun } = args;

    if (!Array.isArray(ids) || ids.length < 2) {
      throw new CommonQueryRunnerException(
        'At least 2 record IDs are required for merge',
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        {
          userFriendlyMessage: msg`Please select at least 2 records to merge.`,
        },
      );
    }

    if (ids.length > MUTATION_MAX_MERGE_RECORDS) {
      throw new CommonQueryRunnerException(
        `Maximum ${MUTATION_MAX_MERGE_RECORDS} records can be merged at once`,
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        {
          userFriendlyMessage: msg`You can merge up to ${MUTATION_MAX_MERGE_RECORDS} records at once.`,
        },
      );
    }

    for (const id of ids) {
      if (typeof id !== 'string' || !isValidUuid(id)) {
        throw new CommonQueryRunnerException(
          `Value "${String(id)}" is not a valid UUID`,
          CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
          { userFriendlyMessage: msg`Invalid UUID format.` },
        );
      }
    }

    if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
      throw new CommonQueryRunnerException(
        'Duplicate record IDs are not allowed for merge',
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    if (
      !Number.isInteger(conflictPriorityIndex) ||
      conflictPriorityIndex < 0 ||
      conflictPriorityIndex >= ids.length
    ) {
      throw new CommonQueryRunnerException(
        `Invalid conflict priority '${conflictPriorityIndex}'. Valid options for ${ids.length} records: 0-${ids.length - 1}`,
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    if (isDefined(dryRun) && typeof dryRun !== 'boolean') {
      throw new CommonQueryRunnerException(
        'Invalid argument: "dryRun" must be a boolean',
        CommonQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }
  }
}
