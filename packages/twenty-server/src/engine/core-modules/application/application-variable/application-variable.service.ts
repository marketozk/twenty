import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ApplicationVariableEntity } from 'src/engine/core-modules/application/application-variable/application-variable.entity';
import {
  ApplicationVariableEntityException,
  ApplicationVariableEntityExceptionCode,
} from 'src/engine/core-modules/application/application-variable/application-variable.exception';
import { SECRET_APPLICATION_VARIABLE_MASK } from 'src/engine/core-modules/application/application-variable/constants/secret-application-variable-mask.constant';
import {
  captureApplicationVariableUpdateAudit,
  runAuditedApplicationVariableUpdate,
  type ApplicationAuthorizationAuditIdentity,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type FlatApplicationVariableMaps } from 'src/engine/metadata-modules/flat-application-variable/types/flat-application-variable-maps.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';
import { type FlatApplicationVariable } from 'src/engine/metadata-modules/flat-application-variable/types/flat-application-variable.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

type GetEnvVariablesArgs = {
  workspaceId: string;
  applicationId: string;
  flatApplicationVariableMaps?: FlatApplicationVariableMaps;
};

@Injectable()
export class ApplicationVariableEntityService {
  constructor(
    @InjectWorkspaceScopedRepository(ApplicationVariableEntity)
    private readonly applicationVariableRepository: WorkspaceScopedRepository<ApplicationVariableEntity>,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly secretEncryptionService: SecretEncryptionService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private getDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      (
        this.applicationVariableRepository as unknown as {
          manager?: { connection?: DataSource };
        }
      )?.manager?.connection
    );
  }

  getDisplayValue(
    applicationVariable: Pick<
      ApplicationVariableEntity,
      'value' | 'workspaceId' | 'isSecret'
    >,
  ): string {
    const plaintextValue = this.decryptValue(applicationVariable);

    if (plaintextValue === '') {
      return '';
    }

    if (applicationVariable.isSecret) {
      return this.secretEncryptionService.maskDecryptedValue(
        plaintextValue,
        SECRET_APPLICATION_VARIABLE_MASK,
      );
    }

    return plaintextValue;
  }

  async getServerEnvVariables(
    args: GetEnvVariablesArgs,
  ): Promise<Record<string, string>> {
    const flatApplicationVariables =
      await this.findFlatApplicationVariables(args);

    return this.toEnvVariables(flatApplicationVariables);
  }

  async getPublicEnvVariables(
    args: GetEnvVariablesArgs,
  ): Promise<Record<string, string>> {
    const flatApplicationVariables =
      await this.findFlatApplicationVariables(args);

    return this.toEnvVariables(
      flatApplicationVariables.filter(({ isSecret }) => !isSecret),
    );
  }

  async findFlatApplicationVariables({
    workspaceId,
    applicationId,
    flatApplicationVariableMaps: preloadedFlatApplicationVariableMaps,
  }: GetEnvVariablesArgs): Promise<FlatApplicationVariable[]> {
    const flatApplicationVariableMaps =
      preloadedFlatApplicationVariableMaps ??
      (
        await this.workspaceCacheService.getOrRecompute(workspaceId, [
          'flatApplicationVariableMaps',
        ])
      ).flatApplicationVariableMaps;

    const universalIdentifiers =
      flatApplicationVariableMaps.universalIdentifiersByApplicationId[
        applicationId
      ] ?? [];

    return universalIdentifiers
      .map(
        (universalIdentifier) =>
          flatApplicationVariableMaps.byUniversalIdentifier[
            universalIdentifier
          ],
      )
      .filter(isDefined);
  }

  private toEnvVariables(
    flatApplicationVariables: FlatApplicationVariable[],
  ): Record<string, string> {
    return flatApplicationVariables
      .filter(({ scope }) => scope !== 'USER')
      .reduce<Record<string, string>>((acc, flatApplicationVariable) => {
        acc[flatApplicationVariable.key] = this.decryptValue(
          flatApplicationVariable,
        );

        return acc;
      }, {});
  }

  private decryptValue({
    value,
    workspaceId,
  }: Pick<FlatApplicationVariable, 'value' | 'workspaceId'>): string {
    if (!isDefined(value)) {
      return '';
    }

    return this.secretEncryptionService.decryptVersionedOrThrow(value, {
      workspaceId,
    });
  }

  async update({
    key,
    plainTextValue,
    applicationId,
    workspaceId,
    callingApplicationId,
    auditIdentity,
  }: Pick<ApplicationVariableEntity, 'key'> & {
    applicationId: string;
    workspaceId: string;
    plainTextValue: PlaintextString;
    callingApplicationId?: string;
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }) {
    const capturedKey = String(key);
    const capturedPlainTextValue = plainTextValue;
    const capturedApplicationId = applicationId;
    const capturedWorkspaceId = workspaceId;
    const capturedCallingApplicationId = callingApplicationId;
    const auditRequest = captureApplicationVariableUpdateAudit({
      workspaceId: capturedWorkspaceId,
      auditIdentity,
    });

    const encryptedValue = this.secretEncryptionService.encryptVersioned(
      capturedPlainTextValue,
      {
        workspaceId: capturedWorkspaceId,
      },
    );

    let outcome: Awaited<
      ReturnType<typeof runAuditedApplicationVariableUpdate>
    >;
    try {
      outcome = await runAuditedApplicationVariableUpdate(
        this.getDataSource(),
        auditRequest,
        {
          applicationId: capturedApplicationId,
          callingApplicationId: capturedCallingApplicationId,
          key: capturedKey,
          encryptedValue,
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
            ['flatApplicationVariableMaps'],
          );
        } catch {
          // Preserve the commit uncertainty error over cache refresh failures.
        }
      }
      throw error;
    }

    if (outcome.status === 'not_found') {
      throw new ApplicationVariableEntityException(
        `Application variable with key ${capturedKey} not found`,
        ApplicationVariableEntityExceptionCode.APPLICATION_VARIABLE_NOT_FOUND,
      );
    }

    if (outcome.status === 'user_variable') {
      throw new ApplicationVariableEntityException(
        `Application variable with key ${capturedKey} is a user variable`,
        ApplicationVariableEntityExceptionCode.INVALID_APPLICATION_VARIABLE_INPUT,
      );
    }

    await this.workspaceCacheService.invalidateAndRecompute(
      capturedWorkspaceId,
      ['flatApplicationVariableMaps'],
    );
  }
}
