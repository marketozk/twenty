import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { type EntityManager, IsNull, Repository } from 'typeorm';

import { ApplicationRegistrationVersionEntity } from 'src/engine/core-modules/application/application-registration-version/application-registration-version.entity';
import { ApplicationRegistrationSourceType } from 'src/engine/core-modules/application/application-registration/enums/application-registration-source-type.enum';
import {
  captureWorkspaceDomainAudit,
  runAuditedApplicationRegistrationVersionSync,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { type FileEntity } from 'src/engine/core-modules/file/entities/file.entity';

export type CreateApplicationRegistrationVersionParams = {
  applicationRegistrationId: string;
  version: string;
  sourceType: ApplicationRegistrationSourceType;
  sourcePackage?: string | null;
  tarballFileId?: string | null;
  tarballUrl?: string | null;
};

@Injectable()
export class ApplicationRegistrationVersionService {
  private readonly logger = new Logger(
    ApplicationRegistrationVersionService.name,
  );

  constructor(
    @InjectRepository(ApplicationRegistrationVersionEntity)
    private readonly applicationRegistrationVersionRepository: Repository<ApplicationRegistrationVersionEntity>,
  ) {}

  async createApplicationRegistrationVersion(
    params: CreateApplicationRegistrationVersionParams,
    entityManager?: EntityManager,
    options?: {
      workspaceId?: string;
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<ApplicationRegistrationVersionEntity> {
    const dataSource =
      this.applicationRegistrationVersionRepository.manager?.connection;
    if (
      !isDefined(entityManager) &&
      isDefined(dataSource) &&
      isDefined(options?.workspaceId)
    ) {
      const auditRequest = captureWorkspaceDomainAudit({
        workspaceId: options.workspaceId,
        auditIdentity: options.auditIdentity,
        defaultSystemActorId:
          'ApplicationRegistrationVersionService.createApplicationRegistrationVersion',
      });

      return runAuditedApplicationRegistrationVersionSync(
        dataSource,
        auditRequest,
        {
          applicationRegistrationId: params.applicationRegistrationId,
          work: (runner) =>
            this.createApplicationRegistrationVersionWithManager(
              params,
              runner.manager,
            ),
        },
      );
    }

    return this.createApplicationRegistrationVersionWithManager(
      params,
      entityManager,
    );
  }

  private async createApplicationRegistrationVersionWithManager(
    params: CreateApplicationRegistrationVersionParams,
    entityManager?: EntityManager,
  ): Promise<ApplicationRegistrationVersionEntity> {
    const repository =
      entityManager?.getRepository(ApplicationRegistrationVersionEntity) ??
      this.applicationRegistrationVersionRepository;
    const insertResult = await repository
      .createQueryBuilder()
      .insert()
      .values({
        applicationRegistrationId: params.applicationRegistrationId,
        version: params.version,
        sourceType: params.sourceType,
        sourcePackage: params.sourcePackage ?? null,
        tarballFileId: params.tarballFileId ?? null,
        tarballUrl: params.tarballUrl ?? null,
        publishedAt: new Date(),
      })
      .orIgnore()
      .execute();

    if (insertResult.raw.length > 0) {
      this.logger.log(
        `Recorded version ${params.version} of registration ${params.applicationRegistrationId}`,
      );
    }

    return repository.findOneOrFail({
      where: {
        applicationRegistrationId: params.applicationRegistrationId,
        version: params.version,
      },
    });
  }

  async ensureNpmVersion(
    {
      applicationRegistrationId,
      version,
      sourcePackage,
      tarballUrl,
    }: {
      applicationRegistrationId: string;
      version: string;
      sourcePackage: string | null;
      tarballUrl: string;
    },
    options?: {
      workspaceId?: string;
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<void> {
    const dataSource =
      this.applicationRegistrationVersionRepository.manager?.connection;
    if (isDefined(dataSource) && isDefined(options?.workspaceId)) {
      const auditRequest = captureWorkspaceDomainAudit({
        workspaceId: options.workspaceId,
        auditIdentity: options.auditIdentity,
        defaultSystemActorId:
          'ApplicationRegistrationVersionService.ensureNpmVersion',
      });
      await runAuditedApplicationRegistrationVersionSync(
        dataSource,
        auditRequest,
        {
          applicationRegistrationId,
          work: async (runner) => {
            const publishedVersion =
              await this.createApplicationRegistrationVersionWithManager(
                {
                  applicationRegistrationId,
                  version,
                  sourceType: ApplicationRegistrationSourceType.NPM,
                  sourcePackage,
                  tarballUrl,
                },
                runner.manager,
              );

            if (!isDefined(publishedVersion.tarballUrl)) {
              await runner.manager
                .getRepository(ApplicationRegistrationVersionEntity)
                .update(
                  { id: publishedVersion.id, tarballUrl: IsNull() },
                  { tarballUrl },
                );
            }
          },
        },
      );

      return;
    }

    const publishedVersion =
      await this.createApplicationRegistrationVersionWithManager({
        applicationRegistrationId,
        version,
        sourceType: ApplicationRegistrationSourceType.NPM,
        sourcePackage,
        tarballUrl,
      });

    if (!isDefined(publishedVersion.tarballUrl)) {
      await this.applicationRegistrationVersionRepository.update(
        { id: publishedVersion.id, tarballUrl: IsNull() },
        { tarballUrl },
      );
    }
  }

  async findOneByApplicationRegistrationIdAndVersion({
    applicationRegistrationId,
    version,
  }: {
    applicationRegistrationId: string;
    version: string;
  }): Promise<ApplicationRegistrationVersionEntity | null> {
    return this.applicationRegistrationVersionRepository.findOne({
      where: { applicationRegistrationId, version },
    });
  }

  async isTarballFileReferenced(tarballFileId: string): Promise<boolean> {
    return this.applicationRegistrationVersionRepository.exists({
      where: { tarballFileId },
    });
  }

  async findTarballFilesOfRegistration(
    applicationRegistrationId: string,
  ): Promise<FileEntity[]> {
    const versions = await this.applicationRegistrationVersionRepository.find({
      where: { applicationRegistrationId },
      relations: { tarballFile: true },
    });

    return versions.map(({ tarballFile }) => tarballFile).filter(isDefined);
  }
}
