import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { type TranslationsManifest } from 'twenty-shared/application';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, Repository } from 'typeorm';

import { ApplicationTranslationCacheService } from 'src/engine/core-modules/application/application-translation/application-translation-cache.service';
import { ApplicationTranslationEntity } from 'src/engine/core-modules/application/application-translation/application-translation.entity';
import { computeApplicationTranslationSyncPlan } from 'src/engine/core-modules/application/application-translation/utils/compute-application-translation-sync-plan.util';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import {
  captureWorkspaceDomainAudit,
  runAuditedApplicationTranslationSync,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

@Injectable()
export class ApplicationTranslationSyncService {
  constructor(
    // applicationTranslation is a core cross-workspace table keyed by applicationRegistrationId, not workspaceId.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(ApplicationTranslationEntity)
    private readonly applicationTranslationRepository: Repository<ApplicationTranslationEntity>,
    private readonly applicationTranslationCacheService: ApplicationTranslationCacheService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      (this.applicationTranslationRepository?.manager?.connection as
        | DataSource
        | undefined)
    );
  }

  async syncFromManifest({
    workspaceId,
    applicationRegistrationId,
    translations,
    auditIdentity,
  }: {
    workspaceId?: string;
    applicationRegistrationId: string;
    translations: TranslationsManifest | undefined;
    auditIdentity?: WorkspaceDomainAuditIdentity;
  }): Promise<void> {
    // Absence must not prune: this cross-workspace table would lose the app's locales everywhere
    if (!isDefined(translations)) {
      return;
    }

    const resolvedDataSource = this.resolveDataSource();
    if (isDefined(workspaceId) && isDefined(resolvedDataSource)) {
      const capturedAudit = captureWorkspaceDomainAudit({
        workspaceId,
        auditIdentity,
        defaultSystemActorId: isDefined(auditIdentity)
          ? undefined
          : 'ApplicationTranslationSyncService.syncFromManifest',
      });
      try {
        await runAuditedApplicationTranslationSync(
          resolvedDataSource,
          capturedAudit,
          {
            applicationRegistrationId,
            translations: translations as Record<
              string,
              Record<string, string>
            >,
          },
        );
      } catch (error) {
        if (
          error instanceof NativeTransactionOutcomeUnknownError ||
          error instanceof CoreAuditPostCommitError
        ) {
          try {
            await this.applicationTranslationCacheService.invalidate(
              applicationRegistrationId,
            );
          } catch {
            // Preserve the commit-outcome error as the primary failure.
          }
        }
        throw error;
      }

      await this.applicationTranslationCacheService.invalidate(
        applicationRegistrationId,
      );
      return;
    }

    const existingRows = await this.applicationTranslationRepository.find({
      where: { applicationRegistrationId },
      withDeleted: true,
    });

    const { rowsToUpdate, rowsToInsert, rowIdsToSoftDelete } =
      computeApplicationTranslationSyncPlan({ existingRows, translations });

    await Promise.all([
      ...rowsToUpdate.map(({ id, messages }) =>
        this.applicationTranslationRepository.update(id, {
          messages,
          deletedAt: null,
        }),
      ),
      ...rowsToInsert.map(({ locale, messages }) =>
        this.applicationTranslationRepository.insert({
          applicationRegistrationId,
          locale,
          messages,
        }),
      ),
    ]);

    if (rowIdsToSoftDelete.length > 0) {
      await this.applicationTranslationRepository.softDelete(
        rowIdsToSoftDelete,
      );
    }

    await this.applicationTranslationCacheService.invalidate(
      applicationRegistrationId,
    );
  }
}
