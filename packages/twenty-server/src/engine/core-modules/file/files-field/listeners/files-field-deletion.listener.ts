import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type ObjectRecordDestroyEvent } from 'twenty-shared/database-events';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined, isValidUuid } from 'twenty-shared/utils';
import { type DataSource } from 'typeorm';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { FILES_FIELD_HARD_DELETE_INTENT_NAME } from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { isNativeCrmAuditMetadata } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  FilesFieldDeletionJob,
  FilesFieldDeletionJobData,
} from 'src/engine/core-modules/file/files-field/jobs/files-field-deletion.job';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { buildObjectIdByNameMaps } from 'src/engine/metadata-modules/flat-object-metadata/utils/build-object-id-by-name-maps.util';
import { WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { enqueueDeferredWorkspaceMigrationActions } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/enqueue-deferred-workspace-migration-actions';

type FileItem = {
  fileId: string;
  label: string;
  extension?: string;
};

@Injectable()
export class FilesFieldDeletionListener {
  private readonly logger = new Logger(FilesFieldDeletionListener.name);

  constructor(
    @InjectMessageQueue(MessageQueue.deleteCascadeQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly workspaceManyOrAllFlatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    @Optional()
    @InjectMessageQueue(MessageQueue.workspaceQueue)
    private readonly workspaceQueueService?: MessageQueueService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  @OnDatabaseBatchEvent('*', DatabaseEventAction.DESTROYED)
  async handleDestroyedEvent(
    payload: WorkspaceEventBatch<ObjectRecordDestroyEvent>,
  ) {
    const workspaceId = payload.workspaceId;
    const objectMetadata = payload.objectMetadata;

    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatObjectMetadataMaps', 'flatFieldMetadataMaps'],
        },
      );

    const { idByNameSingular } = buildObjectIdByNameMaps(
      flatObjectMetadataMaps,
    );

    const objectId = idByNameSingular[objectMetadata.nameSingular];

    if (!isDefined(objectId)) {
      return;
    }

    const flatObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: objectId,
      flatEntityMaps: flatObjectMetadataMaps,
    });

    if (!isDefined(flatObjectMetadata)) {
      return;
    }

    const isCoveredObject = isNativeCrmAuditMetadata(
      flatObjectMetadata,
      workspaceId,
    );

    const objectFields = getFlatFieldsFromFlatObjectMetadata(
      flatObjectMetadata,
      flatFieldMetadataMaps,
    );

    const filesFields = objectFields.filter(
      (field) => field.type === FieldMetadataType.FILES,
    );

    const fileIds = new Set<string>();

    if (filesFields.length > 0) {
      for (const event of payload.events) {
        const recordBefore = event.properties?.before as
          | Record<string, unknown>
          | undefined;

        if (!isDefined(recordBefore) || typeof recordBefore !== 'object') {
          continue;
        }

        for (const filesField of filesFields) {
          const filesValue = recordBefore[filesField.name];

          if (!isDefined(filesValue)) {
            continue;
          }

          if (!Array.isArray(filesValue)) {
            this.logger.warn(
              `Ignoring non-array FILES value on ${objectMetadata.nameSingular}.${filesField.name} in workspace ${workspaceId}`,
            );
            continue;
          }

          for (const fileItem of filesValue as Array<Partial<FileItem> | null>) {
            const candidateId =
              isDefined(fileItem) && typeof fileItem === 'object'
                ? fileItem.fileId
                : undefined;

            if (typeof candidateId !== 'string' || !isValidUuid(candidateId)) {
              this.logger.warn(
                `Ignoring invalid fileId on ${objectMetadata.nameSingular}.${filesField.name} in workspace ${workspaceId}`,
              );
              continue;
            }

            fileIds.add(candidateId.toLowerCase());
          }
        }
      }
    }

    if (isCoveredObject && isDefined(this.coreDataSource)) {
      let shouldEnqueueDeferred = false;
      const legacyFileIds: string[] = [];

      if (fileIds.size > 0) {
        // Distinguish audited deletes (row already soft-retired with toDelete:true) from un-audited deletes (e.g. TrashCleanupService).
        const rows = (await this.coreDataSource.query(
          `SELECT id, "deletedAt", settings FROM core.file WHERE "workspaceId" = $1 AND id = ANY($2::uuid[])`,
          [workspaceId, Array.from(fileIds)],
        )) as Array<{
          id: string;
          deletedAt: Date | string | null;
          settings: { toDelete?: unknown } | null;
        }>;
        const rowById = new Map(rows.map((row) => [row.id.toLowerCase(), row]));

        for (const fileId of fileIds) {
          const row = rowById.get(fileId.toLowerCase());
          if (!row) {
            continue;
          }
          if (row.deletedAt !== null && row.settings?.toDelete === true) {
            shouldEnqueueDeferred = true;
          } else if (row.deletedAt === null) {
            legacyFileIds.push(fileId);
          }
        }
      }

      if (!shouldEnqueueDeferred) {
        const pendingIntent = (await this.coreDataSource.query(
          `SELECT 1 FROM core."deferredWorkspaceMigrationAction"
           WHERE "workspaceId" = $1 AND name = $2 AND status = 'PENDING'
           LIMIT 1`,
          [workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME],
        )) as unknown[];
        shouldEnqueueDeferred = pendingIntent.length > 0;
      }

      if (shouldEnqueueDeferred && isDefined(this.workspaceQueueService)) {
        await enqueueDeferredWorkspaceMigrationActions(
          this.workspaceQueueService,
          workspaceId,
          (message) => this.logger.error(message),
        );
      }

      if (legacyFileIds.length > 0) {
        await this.messageQueueService.add<FilesFieldDeletionJobData>(
          FilesFieldDeletionJob.name,
          {
            workspaceId,
            fileIds: legacyFileIds,
          },
        );
      }

      return;
    }

    if (fileIds.size > 0) {
      await this.messageQueueService.add<FilesFieldDeletionJobData>(
        FilesFieldDeletionJob.name,
        {
          workspaceId,
          fileIds: Array.from(fileIds),
        },
      );
    }
  }
}
