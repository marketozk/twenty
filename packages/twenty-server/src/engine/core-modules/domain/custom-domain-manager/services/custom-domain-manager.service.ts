import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { msg } from '@lingui/core/macro';
import { assertIsDefinedOrThrow, isDefined } from 'twenty-shared/utils';
import { DataSource, Repository } from 'typeorm';

import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import {
  captureWorkspaceSettingsAudit,
  runAuditedWorkspaceSettingsUpdate,
} from 'src/engine/core-modules/crm-audit/workspace-default-role-audit';
import { EventLogEmitterService } from 'src/engine/core-modules/event-logs/emit/event-log-emitter.service';
import { CUSTOM_DOMAIN_ACTIVATED_EVENT } from 'src/engine/core-modules/event-logs/emit/events/workspace-event/custom-domain/custom-domain-activated';
import { CUSTOM_DOMAIN_DEACTIVATED_EVENT } from 'src/engine/core-modules/event-logs/emit/events/workspace-event/custom-domain/custom-domain-deactivated';
import { BillingEntitlementKey } from 'src/engine/core-modules/billing/enums/billing-entitlement-key.enum';
import { BillingService } from 'src/engine/core-modules/billing/services/billing.service';
import { DomainValidRecords } from 'src/engine/core-modules/dns-manager/dtos/domain-valid-records';
import { DnsManagerService } from 'src/engine/core-modules/dns-manager/services/dns-manager.service';
import { PublicDomainEntity } from 'src/engine/core-modules/public-domain/public-domain.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import {
  WorkspaceException,
  WorkspaceExceptionCode,
} from 'src/engine/core-modules/workspace/workspace.exception';

@Injectable()
export class CustomDomainManagerService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    // Enforces global uniqueness of a custom domain across all workspaces.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(PublicDomainEntity)
    private readonly publicDomainRepository: Repository<PublicDomainEntity>,
    private readonly billingService: BillingService,
    private readonly dnsManagerService: DnsManagerService,
    private readonly eventLogEmitterService: EventLogEmitterService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      (this.workspaceRepository?.manager?.connection as DataSource | undefined)
    );
  }

  async isCustomDomainEnabled(workspaceId: string) {
    const isCustomDomainBillingEnabled =
      await this.billingService.hasEntitlement(
        workspaceId,
        BillingEntitlementKey.CUSTOM_DOMAIN,
      );

    if (!isCustomDomainBillingEnabled) {
      throw new WorkspaceException(
        `No entitlement found for this workspace`,
        WorkspaceExceptionCode.WORKSPACE_CUSTOM_DOMAIN_DISABLED,
      );
    }
  }

  async setCustomDomain(workspace: WorkspaceEntity, customDomain: string) {
    await this.isCustomDomainEnabled(workspace.id);

    const existingWorkspace = await this.workspaceRepository.findOne({
      where: { customDomain },
    });

    if (existingWorkspace && existingWorkspace.id !== workspace.id) {
      throw new WorkspaceException(
        'Domain already taken',
        WorkspaceExceptionCode.DOMAIN_ALREADY_TAKEN,
      );
    }

    if (
      await this.publicDomainRepository.findOneBy({
        domain: customDomain,
      })
    ) {
      throw new WorkspaceException(
        'Domain is already registered as public domain',
        WorkspaceExceptionCode.DOMAIN_ALREADY_TAKEN,
        {
          userFriendlyMessage: msg`Domain is already registered as public domain`,
        },
      );
    }

    if (!isDefined(customDomain) || workspace.customDomain === customDomain) {
      return;
    }

    if (isDefined(workspace.customDomain)) {
      await this.dnsManagerService.updateHostname(
        workspace.customDomain,
        customDomain,
      );
    } else {
      await this.dnsManagerService.registerHostname(customDomain);
    }
  }

  async checkCustomDomainValidRecords(
    workspace: WorkspaceEntity,
    domainValidRecord?: DomainValidRecords,
    options?: {
      auditIdentity?: RoleUpdateAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const requireSettingsAudit =
      isDefined(options?.auditIdentity) || isDefined(resolvedDataSource)
        ? captureWorkspaceSettingsAudit(
            workspace.id,
            options?.auditIdentity ?? {
              auth: { type: 'system', workspace: { id: workspace.id } },
              systemActorId: CustomDomainManagerService.name,
            },
          )
        : undefined;

    assertIsDefinedOrThrow(workspace.customDomain);

    const customDomainWithRecords =
      domainValidRecord ??
      (await this.dnsManagerService.getHostnameWithRecords(
        workspace.customDomain,
      ));

    assertIsDefinedOrThrow(customDomainWithRecords);

    const isCustomDomainWorking =
      await this.dnsManagerService.isHostnameWorking(workspace.customDomain);

    if (workspace.isCustomDomainEnabled !== isCustomDomainWorking) {
      if (isDefined(resolvedDataSource) && isDefined(requireSettingsAudit)) {
        await runAuditedWorkspaceSettingsUpdate(
          resolvedDataSource,
          requireSettingsAudit(),
          ['isCustomDomainEnabled'],
          async (runner) => {
            await runner.manager.update(WorkspaceEntity, workspace.id, {
              isCustomDomainEnabled: isCustomDomainWorking,
            });
          },
        );
      } else {
        await this.workspaceRepository.update(workspace.id, {
          isCustomDomainEnabled: isCustomDomainWorking,
        });
      }

      workspace.isCustomDomainEnabled = isCustomDomainWorking;

      if (isDefined(this.eventLogEmitterService)) {
        const eventLogContext = this.eventLogEmitterService.createContext({
          workspaceId: workspace.id,
        });

        void eventLogContext.insertWorkspaceEvent(
          workspace.isCustomDomainEnabled
            ? CUSTOM_DOMAIN_ACTIVATED_EVENT
            : CUSTOM_DOMAIN_DEACTIVATED_EVENT,
          {},
        );
      }
    }

    return {
      ...customDomainWithRecords,
      isCustomDomainEnabled: workspace.isCustomDomainEnabled,
    };
  }
}
