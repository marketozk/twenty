import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import {
  IMPORT_MATCHING_INTENT_RECONCILIATION,
  ReconcileCalendarImportMatchingDeferredActionHandlerService,
  ReconcileMessageImportMatchingDeferredActionHandlerService,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/reconcile-import-matching-deferred-action-handler.service';
import { ReconcilePersonCompanyTargetsJob } from 'src/modules/match-participant/jobs/reconcile-person-company-targets.job';
import { ParticipantTargetPersonListener } from 'src/modules/match-participant/listeners/participant-target-person.listener';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';

@Module({
  imports: [TypeOrmModule.forFeature([MessageChannelEntity])],
  providers: [
    MatchParticipantService,
    ParticipantTargetReconciliationService,
    ReconcilePersonCompanyTargetsJob,
    ParticipantTargetPersonListener,
    ReconcileMessageImportMatchingDeferredActionHandlerService,
    ReconcileCalendarImportMatchingDeferredActionHandlerService,
    {
      provide: IMPORT_MATCHING_INTENT_RECONCILIATION,
      useExisting: MatchParticipantService,
    },
  ],
  exports: [
    MatchParticipantService,
    ParticipantTargetReconciliationService,
    IMPORT_MATCHING_INTENT_RECONCILIATION,
  ],
})
export class MatchParticipantModule {}
