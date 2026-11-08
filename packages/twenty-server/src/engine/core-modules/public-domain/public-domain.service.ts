import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { msg } from '@lingui/core/macro';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, Repository } from 'typeorm';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ApplicationEntity } from 'src/engine/core-modules/application/application.entity';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import {
  captureWorkspaceDomainAudit,
  consumeWorkspaceDomainAuditRequest,
  runAuditedPublicDomainCreate,
  runAuditedPublicDomainDelete,
  runAuditedPublicDomainValidationUpdate,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { DnsManagerService } from 'src/engine/core-modules/dns-manager/services/dns-manager.service';
import { PublicDomainDTO } from 'src/engine/core-modules/public-domain/dtos/public-domain.dto';
import { PublicDomainEntity } from 'src/engine/core-modules/public-domain/public-domain.entity';
import {
  PublicDomainException,
  PublicDomainExceptionCode,
} from 'src/engine/core-modules/public-domain/public-domain.exception';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { DomainValidRecords } from 'src/engine/core-modules/dns-manager/dtos/domain-valid-records';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
@Injectable()
export class PublicDomainService {
  constructor(
    private readonly dnsManagerService: DnsManagerService,
    @InjectWorkspaceScopedRepository(PublicDomainEntity)
    private readonly publicDomainRepository: WorkspaceScopedRepository<PublicDomainEntity>,
    // Hostname-to-workspace resolution at request-routing time, before workspace context exists.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(PublicDomainEntity)
    private readonly publicDomainRepositoryUnscoped: Repository<PublicDomainEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectWorkspaceScopedRepository(ApplicationEntity)
    private readonly applicationRepository: WorkspaceScopedRepository<ApplicationEntity>,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.dataSource ??
      (this.publicDomainRepositoryUnscoped?.manager?.connection as
        | DataSource
        | undefined) ??
      (this.workspaceRepository?.manager?.connection as DataSource | undefined)
    );
  }

  async deletePublicDomain(
    {
      domain,
      workspace,
    }: {
      domain: string;
      workspace: WorkspaceEntity;
    },
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<void> {
    const resolvedDataSource = this.resolveDataSource();
    const hasExplicitAuditIdentity =
      options !== undefined && 'auditIdentity' in options;
    const auditRequest =
      resolvedDataSource || hasExplicitAuditIdentity
        ? captureWorkspaceDomainAudit({
            workspaceId: workspace?.id,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    const formattedDomain = domain.trim().toLowerCase();

    try {
      if (resolvedDataSource && auditRequest) {
        const { deleted } = await runAuditedPublicDomainDelete(
          resolvedDataSource,
          auditRequest,
          { domain: formattedDomain },
        );
        if (deleted) {
          await this.dnsManagerService.deleteHostnameSilently(formattedDomain, {
            isPublicDomain: true,
          });
        }

        return;
      }

      await this.dnsManagerService.deleteHostnameSilently(formattedDomain, {
        isPublicDomain: true,
      });

      await this.publicDomainRepository.delete(workspace.id, {
        domain: formattedDomain,
      });
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async createPublicDomain(
    {
      domain,
      workspace,
      applicationId,
    }: {
      domain: string;
      workspace: WorkspaceEntity;
      applicationId: string;
    },
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<PublicDomainDTO> {
    const resolvedDataSource = this.resolveDataSource();
    const hasExplicitAuditIdentity =
      options !== undefined && 'auditIdentity' in options;
    const auditRequest =
      resolvedDataSource || hasExplicitAuditIdentity
        ? captureWorkspaceDomainAudit({
            workspaceId: workspace?.id,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    const formattedDomain = domain.trim().toLowerCase();

    try {
      const [workspaceWithCustomDomain, existingPublicDomain, application] =
        await Promise.all([
          this.workspaceRepository.findOneBy({ customDomain: formattedDomain }),
          this.publicDomainRepositoryUnscoped?.findOne
            ? this.publicDomainRepositoryUnscoped.findOne({
                where: { domain: formattedDomain },
              })
            : this.publicDomainRepository.findOne(workspace.id, {
                where: { domain: formattedDomain },
              }),
          this.applicationRepository.findOneBy(workspace.id, {
            id: applicationId,
          }),
        ]);

      if (isDefined(workspaceWithCustomDomain)) {
        throw new PublicDomainException(
          'Domain already used for workspace custom domain',
          PublicDomainExceptionCode.DOMAIN_ALREADY_REGISTERED_AS_CUSTOM_DOMAIN,
          {
            userFriendlyMessage: msg`Domain already used for workspace custom domain`,
          },
        );
      }

      if (isDefined(existingPublicDomain)) {
        throw new PublicDomainException(
          'Public domain already registered',
          PublicDomainExceptionCode.PUBLIC_DOMAIN_ALREADY_REGISTERED,
          {
            userFriendlyMessage: msg`Public domain already registered`,
          },
        );
      }

      if (!isDefined(application)) {
        throw new PublicDomainException(
          'Application not found in this workspace',
          PublicDomainExceptionCode.APPLICATION_NOT_FOUND,
        );
      }

      await this.dnsManagerService.registerHostname(formattedDomain, {
        isPublicDomain: true,
      });

      if (resolvedDataSource && auditRequest) {
        try {
          const createdRow = await runAuditedPublicDomainCreate(
            resolvedDataSource,
            auditRequest,
            {
              domain: formattedDomain,
              applicationId,
              onApplicationNotFound: () => {
                throw new PublicDomainException(
                  'Application not found in this workspace',
                  PublicDomainExceptionCode.APPLICATION_NOT_FOUND,
                );
              },
              onCustomDomainCollision: () => {
                throw new PublicDomainException(
                  'Domain already used for workspace custom domain',
                  PublicDomainExceptionCode.DOMAIN_ALREADY_REGISTERED_AS_CUSTOM_DOMAIN,
                  {
                    userFriendlyMessage: msg`Domain already used for workspace custom domain`,
                  },
                );
              },
              onAlreadyRegistered: () => {
                throw new PublicDomainException(
                  'Public domain already registered',
                  PublicDomainExceptionCode.PUBLIC_DOMAIN_ALREADY_REGISTERED,
                  {
                    userFriendlyMessage: msg`Public domain already registered`,
                  },
                );
              },
            },
          );

          return Object.assign(new PublicDomainEntity(), createdRow);
        } catch (error) {
          const shouldSkipDnsCleanup =
            error instanceof NativeTransactionOutcomeUnknownError ||
            error instanceof CoreAuditPostCommitError ||
            (error instanceof PublicDomainException &&
              (error.code ===
                PublicDomainExceptionCode.PUBLIC_DOMAIN_ALREADY_REGISTERED ||
                error.code ===
                  PublicDomainExceptionCode.DOMAIN_ALREADY_REGISTERED_AS_CUSTOM_DOMAIN));
          if (!shouldSkipDnsCleanup) {
            await this.dnsManagerService.deleteHostnameSilently(
              formattedDomain,
              {
                isPublicDomain: true,
              },
            );
          }

          throw error;
        }
      }

      const publicDomain = {
        domain: formattedDomain,
        workspaceId: workspace.id,
        applicationId,
      } as PublicDomainEntity;

      try {
        await this.publicDomainRepository.insert(
          workspace.id,
          publicDomain as QueryDeepPartialEntity<PublicDomainEntity>,
        );
      } catch (error) {
        await this.dnsManagerService.deleteHostnameSilently(formattedDomain, {
          isPublicDomain: true,
        });

        throw error;
      }

      return publicDomain;
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async checkPublicDomainValidRecords(
    publicDomain: PublicDomainEntity,
    domainValidRecords?: DomainValidRecords,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<DomainValidRecords | undefined> {
    const resolvedDataSource = this.resolveDataSource();
    const hasExplicitAuditIdentity =
      options !== undefined && 'auditIdentity' in options;
    const auditRequest =
      resolvedDataSource || hasExplicitAuditIdentity
        ? captureWorkspaceDomainAudit({
            workspaceId: publicDomain.workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    try {
      const publicDomainWithRecords =
        domainValidRecords ??
        (await this.dnsManagerService.getHostnameWithRecords(
          publicDomain.domain,
          {
            isPublicDomain: true,
          },
        ));

      if (!publicDomainWithRecords) return;

      const isCustomDomainWorking =
        await this.dnsManagerService.isHostnameWorking(publicDomain.domain, {
          isPublicDomain: true,
        });

      if (resolvedDataSource && auditRequest) {
        await runAuditedPublicDomainValidationUpdate(
          resolvedDataSource,
          auditRequest,
          {
            publicDomainId: publicDomain.id,
            isValidated: isCustomDomainWorking,
            onNotFound: () => {
              throw new PublicDomainException(
                'Public domain not found',
                PublicDomainExceptionCode.PUBLIC_DOMAIN_NOT_FOUND,
              );
            },
            onApplicationNotFound: () => {
              throw new PublicDomainException(
                'Application not found in this workspace',
                PublicDomainExceptionCode.APPLICATION_NOT_FOUND,
              );
            },
          },
        );
        publicDomain.isValidated = isCustomDomainWorking;

        return publicDomainWithRecords;
      }

      if (publicDomain.isValidated !== isCustomDomainWorking) {
        await this.publicDomainRepository.update(
          publicDomain.workspaceId,
          { id: publicDomain.id },
          { isValidated: isCustomDomainWorking },
        );
      }

      return publicDomainWithRecords;
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async findByDomain(domain: string) {
    const formattedDomain = domain.trim().toLowerCase();

    return this.publicDomainRepositoryUnscoped.findOne({
      where: { domain: formattedDomain },
    });
  }
}
