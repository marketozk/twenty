import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource, Not } from 'typeorm';

import {
  captureWorkspaceDomainAudit,
  consumeWorkspaceDomainAuditRequest,
  type EmailingDomainTenantStatusValue,
  runAuditedEmailingDomainTenantStatusUpdate,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { EmailingDomainTenantStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/emailing-domain-tenant-status.type';
import { EmailingDomainEntity } from 'src/engine/core-modules/emailing-domain/emailing-domain.entity';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';

@Injectable()
export class EmailingDomainTenantStatusService {
  private readonly logger = new Logger(EmailingDomainTenantStatusService.name);

  constructor(
    @InjectWorkspaceScopedRepository(EmailingDomainEntity)
    private readonly emailingDomainRepository: WorkspaceScopedRepository<EmailingDomainEntity>,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  async setTenantStatusForWorkspace(
    workspaceId: string,
    tenantStatus: EmailingDomainTenantStatus,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
      defaultSystemActorId?: string;
    },
  ): Promise<void> {
    if (this.dataSource) {
      const auditRequest = captureWorkspaceDomainAudit({
        workspaceId,
        auditIdentity: options?.auditIdentity,
        defaultSystemActorId:
          options?.defaultSystemActorId ?? 'emailing-domain:tenant-status',
      });
      try {
        const { affected } = await runAuditedEmailingDomainTenantStatusUpdate(
          this.dataSource,
          auditRequest,
          {
            tenantStatus: tenantStatus as EmailingDomainTenantStatusValue,
          },
        );
        this.logger.log(
          `Workspace ${workspaceId}: ${affected ?? 0} domain(s) -> ${tenantStatus}`,
        );

        return;
      } finally {
        consumeWorkspaceDomainAuditRequest(auditRequest);
      }
    }

    const { affected } = await this.emailingDomainRepository.update(
      workspaceId,
      { tenantStatus: Not(EmailingDomainTenantStatus.SANDBOX) },
      { tenantStatus },
    );

    this.logger.log(
      `Workspace ${workspaceId}: ${affected ?? 0} domain(s) -> ${tenantStatus}`,
    );
  }
}
