import { Injectable, Logger } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import { In } from 'typeorm';

import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { TRASH_CLEANUP_BATCH_SIZE } from 'src/engine/trash-cleanup/constants/trash-cleanup-batch-size.constant';
import { TRASH_CLEANUP_MAX_RECORDS_PER_WORKSPACE } from 'src/engine/trash-cleanup/constants/trash-cleanup-max-records-per-workspace.constant';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { findOmniProtectedParentIds } from 'src/modules/omnichannel/services/find-omni-protected-parent-ids';
import { findOmniNativeWriteOwnedRecords } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';

export type TrashCleanupInput = {
  workspaceId: string;
  trashRetentionDays: number;
};

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);
  private readonly maxRecordsPerWorkspace =
    TRASH_CLEANUP_MAX_RECORDS_PER_WORKSPACE;
  private readonly batchSize = TRASH_CLEANUP_BATCH_SIZE;

  constructor(
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
  ) {}

  async cleanupWorkspaceTrash(input: TrashCleanupInput): Promise<number> {
    const { workspaceId, trashRetentionDays } = input;

    const { flatObjectMetadataMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatObjectMetadataMaps'],
        },
      );

    const objects = Object.values(
      flatObjectMetadataMaps.byUniversalIdentifier ?? {},
    ).filter(isDefined);

    if (objects.length === 0) {
      this.logger.log(`No objects found in workspace ${workspaceId}`);

      return 0;
    }

    const cutoffDate = this.calculateCutoffDate(trashRetentionDays);
    let deletedCount = 0;

    for (const object of objects) {
      const objectName = object.nameSingular;
      if (deletedCount >= this.maxRecordsPerWorkspace) {
        this.logger.log(
          `Reached deletion limit (${this.maxRecordsPerWorkspace}) for workspace ${workspaceId}`,
        );
        break;
      }

      const remainingQuota = this.maxRecordsPerWorkspace - deletedCount;
      const deletedForObject = await this.deleteSoftDeletedRecords({
        workspaceId,
        objectName,
        objectMetadataId: object.id,
        cutoffDate,
        remainingQuota,
      });

      if (deletedForObject > 0) {
        this.logger.log(
          `Deleted ${deletedForObject} record(s) from ${objectName} in workspace ${workspaceId}`,
        );
      }

      deletedCount += deletedForObject;
    }

    this.logger.log(
      `Deleted ${deletedCount} record(s) from workspace ${workspaceId}`,
    );

    return deletedCount;
  }

  private async deleteSoftDeletedRecords({
    workspaceId,
    objectName,
    objectMetadataId,
    cutoffDate,
    remainingQuota,
  }: {
    workspaceId: string;
    objectName: string;
    objectMetadataId: string;
    cutoffDate: Date;
    remainingQuota: number;
  }): Promise<number> {
    if (remainingQuota <= 0) {
      return 0;
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      let deleted = 0;
      let cursor: { deletedAt: string; id: string } | undefined;
      if (!objectMetadataId)
        throw new Error('OMNI_MISSING_TRASH_OBJECT_METADATA');

      while (deleted < remainingQuota) {
        const take = Math.min(this.batchSize, remainingQuota - deleted);
        const page = await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            if (scope.workspaceId !== workspaceId)
              throw new Error('OMNI_INVALID_TRASH_WORKSPACE');
            const repository = scope.getRepository(objectName, {
              shouldBypassPermissionChecks: true,
            });
            const builder = repository
              .createQueryBuilder('trash')
              .withDeleted()
              .addSelect('"trash"."deletedAt"::text', 'omniDeletionCursor')
              .where('"trash"."deletedAt" < :cutoffDate', { cutoffDate })
              .orderBy('"trash"."deletedAt"', 'ASC')
              .addOrderBy('"trash"."id"', 'ASC')
              .take(take);
            if (cursor)
              builder.andWhere(
                '("trash"."deletedAt", "trash"."id") > (:cursorDate::timestamptz, :cursorId::uuid)',
                { cursorDate: cursor.deletedAt, cursorId: cursor.id },
              );
            // Keep PostgreSQL microseconds; a JS Date cursor can repeat a retained page.
            const { entities: records, raw } = await builder.getRawAndEntities<
              { id: string } & Record<string, unknown>
            >();
            const last = records.at(-1);
            const exactTimestamp = raw.at(-1)?.omniDeletionCursor;
            if (last && typeof exactTimestamp !== 'string')
              throw new Error('OMNI_INVALID_TRASH_CURSOR');
            const protectedIds = await findOmniProtectedParentIds(
              scope,
              workspaceId,
              objectMetadataId,
              objectName,
              records.map((record) => record.id),
            );
            for (const record of await findOmniNativeWriteOwnedRecords(
              scope,
              workspaceId,
              objectName,
              records,
            ))
              protectedIds.add(String(record.id));
            const ids = records
              .filter((record) => !protectedIds.has(record.id))
              .map((record) => record.id);
            // Recheck retention in the delete predicate: a concurrent restore must survive.
            const result = ids.length
              ? await repository.runMutation({
                  selectQueryBuilder: repository
                    .createQueryBuilder('trash')
                    .withDeleted()
                    .where({ id: In(ids) })
                    .andWhere('"trash"."deletedAt" < :cutoffDate', {
                      cutoffDate,
                    }),
                  rowLevelPermissionsApplied: false,
                  kind: 'delete',
                  columnsToReturn: ['id'],
                })
              : [];
            return {
              last: last
                ? { id: last.id, deletedAt: String(exactTimestamp) }
                : undefined,
              count: records.length,
              deleted: result.length,
            };
          },
          { commitOutcome: 'strict' },
        );
        if (!page.last) break;
        cursor = { deletedAt: page.last.deletedAt, id: page.last.id };
        deleted += page.deleted;
        if (page.count < take) break;
      }

      return deleted;
    }, authContext);
  }

  private calculateCutoffDate(trashRetentionDays: number): Date {
    const cutoffDate = new Date();

    cutoffDate.setUTCHours(0, 0, 0, 0);
    cutoffDate.setDate(cutoffDate.getDate() - trashRetentionDays + 1);

    return cutoffDate;
  }
}
