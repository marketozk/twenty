import { Module } from '@nestjs/common';

import { CrmAuditAlertSinkService } from 'src/engine/core-modules/crm-audit/crm-audit-alert-sink.service';
import { CrmAuditHealthService } from 'src/engine/core-modules/crm-audit/crm-audit-health';

@Module({
  providers: [CrmAuditHealthService, CrmAuditAlertSinkService],
  exports: [CrmAuditHealthService, CrmAuditAlertSinkService],
})
export class CrmAuditHealthModule {}
