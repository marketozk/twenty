import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { FeatureFlagKey } from 'twenty-shared/types';
import { DataSource } from 'typeorm';

import {
  captureFeatureFlagAudit,
  runAuditedFeatureFlagsEnable,
  runAuditedFeatureFlagUpsert,
  type ApplicationAuthorizationAuditIdentity,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type FeatureFlagMap } from 'src/engine/core-modules/feature-flag/interfaces/feature-flag-map.interface';

import { type FeatureFlagDTO } from 'src/engine/core-modules/feature-flag/dtos/feature-flag.dto';
import { FeatureFlagEntity } from 'src/engine/core-modules/feature-flag/feature-flag.entity';
import {
  FeatureFlagException,
  FeatureFlagExceptionCode,
} from 'src/engine/core-modules/feature-flag/feature-flag.exception';
import { featureFlagValidator } from 'src/engine/core-modules/feature-flag/validates/feature-flag.validate';
import { publicFeatureFlagValidator } from 'src/engine/core-modules/feature-flag/validates/is-public-feature-flag.validate';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

@Injectable()
export class FeatureFlagService {
  constructor(
    @InjectWorkspaceScopedRepository(FeatureFlagEntity)
    private readonly featureFlagRepository: WorkspaceScopedRepository<FeatureFlagEntity>,
    private readonly workspaceCacheService: WorkspaceCacheService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private getDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      (
        this.featureFlagRepository as unknown as {
          manager?: { connection?: DataSource };
        }
      )?.manager?.connection
    );
  }

  public async isFeatureEnabled(
    key: FeatureFlagKey,
    workspaceId: string,
  ): Promise<boolean> {
    const featureFlagMap = await this.getWorkspaceFeatureFlagsMap(workspaceId);

    return !!featureFlagMap[key];
  }

  public async getWorkspaceFeatureFlags(
    workspaceId: string,
  ): Promise<FeatureFlagDTO[]> {
    const { featureFlagsMap: workspaceFeatureFlagsMap } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'featureFlagsMap',
      ]);

    return Object.entries(workspaceFeatureFlagsMap).map(([key, value]) => ({
      key: key as FeatureFlagKey,
      value,
    }));
  }

  public async getWorkspaceFeatureFlagsMap(
    workspaceId: string,
  ): Promise<FeatureFlagMap> {
    const { featureFlagsMap: workspaceFeatureFlagsMap } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'featureFlagsMap',
      ]);

    return workspaceFeatureFlagsMap;
  }

  public async enableFeatureFlags(
    keys: readonly FeatureFlagKey[],
    workspaceId: string,
    options?: {
      auditIdentity?: ApplicationAuthorizationAuditIdentity;
    },
  ): Promise<void> {
    const capturedKeys = [...keys];
    const capturedWorkspaceId = workspaceId;
    if (capturedKeys.length === 0) {
      return;
    }

    const auditRequest = captureFeatureFlagAudit({
      workspaceId: capturedWorkspaceId,
      auditIdentity: options?.auditIdentity,
      fallbackSystemActorId: 'feature-flag-service:enable-feature-flags',
    });

    for (const key of capturedKeys) {
      featureFlagValidator.assertIsFeatureFlagKey(
        key,
        new FeatureFlagException(
          'Invalid feature flag key',
          FeatureFlagExceptionCode.INVALID_FEATURE_FLAG_KEY,
        ),
      );
    }

    let mutated: boolean;
    try {
      mutated = await runAuditedFeatureFlagsEnable(
        this.getDataSource(),
        auditRequest,
        {
          keys: capturedKeys,
        },
      );
    } catch (error) {
      if (
        error instanceof NativeTransactionOutcomeUnknownError ||
        error instanceof CoreAuditPostCommitError
      ) {
        try {
          await this.workspaceCacheService.invalidateAndRecompute(
            capturedWorkspaceId,
            ['featureFlagsMap'],
          );
        } catch {
          // Preserve the commit uncertainty error over cache refresh failures.
        }
      }
      throw error;
    }

    if (mutated) {
      await this.workspaceCacheService.invalidateAndRecompute(
        capturedWorkspaceId,
        ['featureFlagsMap'],
      );
    }
  }

  public async upsertWorkspaceFeatureFlag({
    workspaceId,
    featureFlag,
    value,
    shouldBePublic = false,
    auditIdentity,
  }: {
    workspaceId: string;
    featureFlag: FeatureFlagKey;
    value: boolean;
    shouldBePublic?: boolean;
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }): Promise<FeatureFlagEntity> {
    const capturedWorkspaceId = workspaceId;
    const capturedFeatureFlag = featureFlag;
    const capturedValue = value;
    const capturedShouldBePublic = shouldBePublic;
    const auditRequest = captureFeatureFlagAudit({
      workspaceId: capturedWorkspaceId,
      auditIdentity,
    });

    featureFlagValidator.assertIsFeatureFlagKey(
      capturedFeatureFlag,
      new FeatureFlagException(
        'Invalid feature flag key',
        FeatureFlagExceptionCode.INVALID_FEATURE_FLAG_KEY,
      ),
    );

    if (capturedShouldBePublic) {
      publicFeatureFlagValidator.assertIsPublicFeatureFlag(
        capturedFeatureFlag,
        new FeatureFlagException(
          'Invalid feature flag key, flag is not public',
          FeatureFlagExceptionCode.INVALID_FEATURE_FLAG_KEY,
        ),
      );
    }

    let outcome: Awaited<ReturnType<typeof runAuditedFeatureFlagUpsert>>;
    try {
      outcome = await runAuditedFeatureFlagUpsert(
        this.getDataSource(),
        auditRequest,
        {
          key: capturedFeatureFlag,
          value: capturedValue,
        },
      );
    } catch (error) {
      if (
        error instanceof NativeTransactionOutcomeUnknownError ||
        error instanceof CoreAuditPostCommitError
      ) {
        try {
          await this.workspaceCacheService.invalidateAndRecompute(
            capturedWorkspaceId,
            ['featureFlagsMap'],
          );
        } catch {
          // Preserve the commit uncertainty error over cache refresh failures.
        }
      }
      throw error;
    }

    if (outcome.mutated) {
      await this.workspaceCacheService.invalidateAndRecompute(
        capturedWorkspaceId,
        ['featureFlagsMap'],
      );
    }

    return {
      ...(outcome.row as unknown as FeatureFlagEntity),
      id: String(outcome.row.id),
      workspaceId: String(outcome.row.workspaceId),
      key: outcome.row.key as FeatureFlagKey,
      value: Boolean(outcome.row.value),
      createdAt: new Date(String(outcome.row.createdAt)),
      updatedAt: new Date(String(outcome.row.updatedAt)),
    };
  }
}
