import { Injectable } from '@nestjs/common';

import { msg } from '@lingui/core/macro';
import { isDefined } from 'twenty-shared/utils';
import { IsNull } from 'typeorm';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ApiKeyEntity } from 'src/engine/core-modules/api-key/api-key.entity';
import {
  ApiKeyException,
  ApiKeyExceptionCode,
} from 'src/engine/core-modules/api-key/exceptions/api-key.exception';
import { isApiKeyActive } from 'src/engine/core-modules/api-key/utils/is-api-key-active.util';
import { isApiKeyExpired } from 'src/engine/core-modules/api-key/utils/is-api-key-expired.util';
import { type ApiKeyToken } from 'src/engine/core-modules/auth/dto/api-key-token.dto';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import {
  ApiKeyAuditError,
  captureApiKeyCreateInput,
  runAuditedApiKeyUpdate,
  withApiKeyCreateAudit,
  type PersistedApiKeyRow,
} from 'src/engine/core-modules/crm-audit/api-key-audit';
import { type RoleUpdateAuditIdentity } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { JwtWrapperService } from 'src/engine/core-modules/jwt/services/jwt-wrapper.service';
import { RoleTargetService } from 'src/engine/metadata-modules/role-target/services/role-target.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectWorkspaceScopedRepository(ApiKeyEntity)
    private readonly apiKeyRepository: WorkspaceScopedRepository<ApiKeyEntity>,
    private readonly jwtWrapperService: JwtWrapperService,
    private readonly roleTargetService: RoleTargetService,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async create(
    apiKeyData: Pick<ApiKeyEntity, 'name' | 'expiresAt' | 'revokedAt'> & {
      roleId: string;
      workspaceId: string;
      auditIdentity: RoleUpdateAuditIdentity;
    },
  ): Promise<ApiKeyEntity> {
    const captured = captureApiKeyCreateInput(apiKeyData);
    let shouldInvalidateCache = false;
    let caughtError: unknown;

    try {
      const persisted = await withApiKeyCreateAudit(
        {
          workspaceId: captured.workspaceId,
          apiKeyId: captured.apiKeyId,
          roleId: captured.roleId,
          name: captured.name,
          expiresAtIso: captured.expiresAtIso,
          revokedAtIso: captured.revokedAtIso,
        },
        captured.identity,
        () =>
          this.roleTargetService.create({
            createRoleTargetInput: {
              roleId: captured.roleId,
              targetId: captured.apiKeyId,
              targetMetadataForeignKey: 'apiKeyId',
            },
            workspaceId: captured.workspaceId,
          }),
      );
      shouldInvalidateCache = true;

      return this.toApiKeyEntity(persisted);
    } catch (error) {
      caughtError = error;
      if (error instanceof NativeTransactionOutcomeUnknownError) {
        shouldInvalidateCache = true;
      }
      throw error;
    } finally {
      if (shouldInvalidateCache) {
        if (caughtError !== undefined) {
          try {
            await this.invalidateApiKeyCache(captured.workspaceId);
          } catch {
            // Preserve the original unknown transaction outcome error.
          }
        } else {
          await this.invalidateApiKeyCache(captured.workspaceId);
        }
      }
    }
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<ApiKeyEntity | null> {
    return this.apiKeyRepository.findOne(workspaceId, {
      where: { id },
    });
  }

  async findByWorkspaceId(workspaceId: string): Promise<ApiKeyEntity[]> {
    return this.apiKeyRepository.find(workspaceId, {
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async findActiveByWorkspaceId(workspaceId: string): Promise<ApiKeyEntity[]> {
    return this.apiKeyRepository.find(workspaceId, {
      where: { revokedAt: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async update(
    id: string,
    workspaceId: string,
    updateData: QueryDeepPartialEntity<ApiKeyEntity>,
    auditIdentity: RoleUpdateAuditIdentity,
  ): Promise<ApiKeyEntity | null> {
    const capturedWorkspaceId = workspaceId;
    let shouldInvalidateCache = false;
    let caughtError: unknown;

    try {
      const updated = await runAuditedApiKeyUpdate({
        dataSource: this.apiKeyRepository.createQueryBuilder().connection,
        id,
        workspaceId: capturedWorkspaceId,
        updateData,
        auditIdentity,
      });

      if (!updated) {
        return null;
      }

      shouldInvalidateCache = true;

      return this.toApiKeyEntity(updated);
    } catch (error) {
      caughtError = error;
      if (error instanceof NativeTransactionOutcomeUnknownError) {
        shouldInvalidateCache = true;
      }
      if (
        error instanceof ApiKeyAuditError &&
        error.code === 'API_KEY_REVOKED'
      ) {
        throw new ApiKeyException(
          `API Key with id ${id} is revoked and cannot be reactivated`,
          ApiKeyExceptionCode.API_KEY_REVOKED,
          {
            userFriendlyMessage: msg`This API key has been revoked and cannot be reactivated. Please create a new API key.`,
          },
        );
      }
      throw error;
    } finally {
      if (shouldInvalidateCache) {
        if (caughtError !== undefined) {
          try {
            await this.invalidateApiKeyCache(capturedWorkspaceId);
          } catch {
            // Preserve the original unknown transaction outcome error.
          }
        } else {
          await this.invalidateApiKeyCache(capturedWorkspaceId);
        }
      }
    }
  }

  async revoke(
    id: string,
    workspaceId: string,
    auditIdentity: RoleUpdateAuditIdentity,
  ): Promise<ApiKeyEntity | null> {
    return this.update(
      id,
      workspaceId,
      { revokedAt: new Date() },
      auditIdentity,
    );
  }

  async validateApiKey(id: string, workspaceId: string): Promise<ApiKeyEntity> {
    const apiKey = await this.findById(id, workspaceId);

    if (!apiKey) {
      throw new ApiKeyException(
        `API Key with id ${id} not found`,
        ApiKeyExceptionCode.API_KEY_NOT_FOUND,
      );
    }

    if (this.isRevoked(apiKey)) {
      throw new ApiKeyException(
        'This API Key is revoked',
        ApiKeyExceptionCode.API_KEY_REVOKED,
        {
          userFriendlyMessage: msg`This API Key has been revoked and can no longer be used.`,
        },
      );
    }

    if (this.isExpired(apiKey)) {
      throw new ApiKeyException(
        'This API Key has expired',
        ApiKeyExceptionCode.API_KEY_EXPIRED,
        {
          userFriendlyMessage: msg`This API Key has expired. Please create a new one.`,
        },
      );
    }

    return apiKey;
  }

  async generateApiKeyToken(
    workspaceId: string,
    apiKeyId?: string,
    expiresAt?: Date | string,
  ): Promise<Pick<ApiKeyToken, 'token'> | undefined> {
    if (!apiKeyId) {
      return;
    }

    await this.validateApiKey(apiKeyId, workspaceId);

    let expiresIn: string | number;

    if (expiresAt) {
      expiresIn = Math.floor(
        (new Date(expiresAt).getTime() - new Date().getTime()) / 1000,
      );
    } else {
      expiresIn = '100y';
    }

    const token = await this.jwtWrapperService.signAsyncOrThrow(
      {
        sub: workspaceId,
        type: JwtTokenTypeEnum.API_KEY,
        workspaceId,
      },
      {
        expiresIn,
        jwtid: apiKeyId,
      },
    );

    return { token };
  }

  isExpired(apiKey: ApiKeyEntity): boolean {
    return isApiKeyExpired(apiKey);
  }

  isRevoked(apiKey: ApiKeyEntity): boolean {
    return isDefined(apiKey.revokedAt);
  }

  isActive(apiKey: ApiKeyEntity): boolean {
    return isApiKeyActive(apiKey);
  }

  private toApiKeyEntity(row: PersistedApiKeyRow): ApiKeyEntity {
    return Object.assign(new ApiKeyEntity(), {
      id: row.id,
      name: row.name,
      expiresAt: new Date(row.expiresAt.getTime()),
      revokedAt: row.revokedAt ? new Date(row.revokedAt.getTime()) : null,
      workspaceId: row.workspaceId,
      createdAt: new Date(row.createdAt.getTime()),
      updatedAt: new Date(row.updatedAt.getTime()),
    });
  }

  private async invalidateApiKeyCache(workspaceId: string): Promise<void> {
    await this.workspaceCacheService.invalidateAndRecompute(workspaceId, [
      'apiKeyMap',
    ]);
  }
}
