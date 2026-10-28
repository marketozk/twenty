import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CacheLockModule } from 'src/engine/core-modules/cache-lock/cache-lock.module';
import { RecordShareStorageModule } from 'src/engine/core-modules/record-share/record-share-storage.module';
import { WorkflowEntity } from 'src/engine/core-modules/workflow/entities/workflow.entity';
import { WorkflowRunRecordShareService } from 'src/engine/core-modules/workflow/services/workflow-run-record-share.service';
import { provideWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/provide-workspace-scoped-repository';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import {
  WORKFLOW_RUN_SHARE_RECONCILIATION,
  SyncWorkflowRunSharesDeferredActionHandlerService,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/sync-workflow-run-shares-deferred-action-handler.service';

// Its own module because its callers (run creation, visibility changes, member removal) already depend on each other
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowEntity]),
    CacheLockModule,
    RecordShareStorageModule,
    WorkspaceCacheModule,
  ],
  providers: [
    WorkflowRunRecordShareService,
    SyncWorkflowRunSharesDeferredActionHandlerService,
    {
      provide: WORKFLOW_RUN_SHARE_RECONCILIATION,
      useExisting: WorkflowRunRecordShareService,
    },
    provideWorkspaceScopedRepository(WorkflowEntity),
  ],
  exports: [WorkflowRunRecordShareService, WORKFLOW_RUN_SHARE_RECONCILIATION],
})
export class WorkflowRunRecordShareModule {}
