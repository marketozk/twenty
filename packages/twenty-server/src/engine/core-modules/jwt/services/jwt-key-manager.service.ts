import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { generateKeyPairSync, randomUUID } from 'crypto';

import { isNonEmptyString } from '@sniptt/guards';
import { isDefined, isValidUuid } from 'twenty-shared/utils';
import { type DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';

import { CoreEntityCacheService } from 'src/engine/core-entity-cache/services/core-entity-cache.service';
import {
  captureWorkspaceDomainAudit,
  runAuditedSigningKeyBootstrapCreate,
  runAuditedSigningKeyRevoke,
  runAuditedSigningKeyRotate,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { SigningKeyEntity } from 'src/engine/core-modules/jwt/entities/signing-key.entity';
import {
  JwtKeyManagerException,
  JwtKeyManagerExceptionCode,
} from 'src/engine/core-modules/jwt/jwt-key-manager.exception';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';

export type CurrentSigningKey = {
  id: string;
  privateKeyPem: string;
};

const UNIQUE_VIOLATION_PG_CODE = '23505';
const CURRENT_SIGNING_KEY_LOCAL_TTL_MS = 60 * 1000;

@Injectable()
export class JwtKeyManagerService {
  private readonly logger = new Logger(JwtKeyManagerService.name);

  private currentSigningKeyPromise: Promise<CurrentSigningKey | null> | null =
    null;
  private currentSigningKeyCachedAt = 0;

  constructor(
    @InjectRepository(SigningKeyEntity)
    private readonly signingKeyRepository: Repository<SigningKeyEntity>,
    private readonly coreEntityCacheService: CoreEntityCacheService,
    private readonly secretEncryptionService: SecretEncryptionService,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.dataSource ??
      (this.signingKeyRepository?.manager?.connection as DataSource | undefined)
    );
  }

  async getCurrentSigningKey(): Promise<CurrentSigningKey | null> {
    const isLocalCacheExpired =
      Date.now() - this.currentSigningKeyCachedAt >
      CURRENT_SIGNING_KEY_LOCAL_TTL_MS;

    if (!isDefined(this.currentSigningKeyPromise) || isLocalCacheExpired) {
      this.currentSigningKeyPromise = this.loadOrCreateCurrentSigningKey();
      this.currentSigningKeyCachedAt = Date.now();
    }

    try {
      const result = await this.currentSigningKeyPromise;

      if (!isDefined(result)) {
        this.invalidateCurrentSigningKeyLocalCache();
      }

      return result;
    } catch (error) {
      this.invalidateCurrentSigningKeyLocalCache();
      throw error;
    }
  }

  async getValidPublicKeyPemById(id: string): Promise<string | null> {
    if (!isNonEmptyString(id) || !isValidUuid(id)) {
      return null;
    }

    return this.coreEntityCacheService.get('signingKeyPublicKey', id);
  }

  async listSigningKeys(): Promise<SigningKeyEntity[]> {
    return this.signingKeyRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async rotateCurrent(
    auditIdentity?: WorkspaceDomainAuditIdentity,
  ): Promise<CurrentSigningKey> {
    const generated = this.generateEcP256KeyPair();
    const newId = randomUUID();

    await runAuditedSigningKeyRotate(this.resolveDataSource(), {
      auditIdentity,
      work: async (runner) => {
        const repository = runner.manager.getRepository(SigningKeyEntity);

        await repository.update(
          { isCurrent: true },
          { isCurrent: false, privateKey: null },
        );

        await repository.insert({
          id: newId,
          publicKey: generated.publicKeyPem,
          privateKey: this.secretEncryptionService.encryptVersioned(
            generated.privateKeyPem,
          ),
          isCurrent: true,
          revokedAt: null,
        });

        return newId;
      },
      extractNewSigningKeyId: (id) => id,
    });

    await this.coreEntityCacheService.invalidate('signingKeyPublicKey', newId);
    this.invalidateCurrentSigningKeyLocalCache();

    return { id: newId, privateKeyPem: generated.privateKeyPem };
  }

  async revokeSigningKey(
    id: string,
    auditIdentity?: WorkspaceDomainAuditIdentity,
  ): Promise<SigningKeyEntity> {
    if (!isNonEmptyString(id) || !isValidUuid(id)) {
      throw new JwtKeyManagerException(
        `Invalid signing key id: ${id}`,
        JwtKeyManagerExceptionCode.SIGNING_KEY_NOT_FOUND,
      );
    }

    const auditRequest = captureWorkspaceDomainAudit({
      auditIdentity,
    });

    const revoked = await runAuditedSigningKeyRevoke(
      this.resolveDataSource(),
      auditRequest,
      {
        signingKeyId: id,
        work: async (runner, beforeRow) => {
          if (!beforeRow) {
            throw new JwtKeyManagerException(
              `Signing key not found: ${id}`,
              JwtKeyManagerExceptionCode.SIGNING_KEY_NOT_FOUND,
            );
          }

          const repository = runner.manager.getRepository(SigningKeyEntity);
          const existing = await repository.findOne({ where: { id } });

          if (!isDefined(existing)) {
            throw new JwtKeyManagerException(
              `Signing key not found: ${id}`,
              JwtKeyManagerExceptionCode.SIGNING_KEY_NOT_FOUND,
            );
          }

          if (!isDefined(existing.revokedAt)) {
            await repository.update(
              { id },
              {
                revokedAt: new Date(),
                isCurrent: false,
                privateKey: null,
              },
            );
          }

          return repository.findOneByOrFail({ id });
        },
      },
    );

    await this.coreEntityCacheService.invalidate('signingKeyPublicKey', id);
    this.invalidateCurrentSigningKeyLocalCache();

    return revoked;
  }

  private invalidateCurrentSigningKeyLocalCache(): void {
    this.currentSigningKeyPromise = null;
    this.currentSigningKeyCachedAt = 0;
  }

  private async loadOrCreateCurrentSigningKey(): Promise<CurrentSigningKey | null> {
    try {
      const existing = await this.findCurrentSigningKeyRow();

      if (isDefined(existing)) {
        return {
          id: existing.id,
          privateKeyPem: this.decryptPrivateKey(
            existing.privateKey,
            existing.id,
          ),
        };
      }

      return await this.generateAndPersistCurrent();
    } catch (error) {
      this.logger.error(
        `Failed to load or create current signing key. Falling back to legacy HS256 signing. Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }

  private async findCurrentSigningKeyRow(): Promise<SigningKeyEntity | null> {
    return this.signingKeyRepository.findOne({
      where: { isCurrent: true, revokedAt: IsNull() },
    });
  }

  private decryptPrivateKey(
    encryptedPrivateKey: EncryptedString | null,
    id: string,
  ): string {
    if (!isDefined(encryptedPrivateKey)) {
      throw new JwtKeyManagerException(
        `Current signing key (id=${id}) has no privateKey`,
        JwtKeyManagerExceptionCode.INVALID_PRIVATE_KEY,
      );
    }

    return this.secretEncryptionService.decryptVersionedOrThrow(
      encryptedPrivateKey,
    );
  }

  private async generateAndPersistCurrent(): Promise<CurrentSigningKey> {
    const generated = this.generateEcP256KeyPair();
    const id = randomUUID();

    try {
      await runAuditedSigningKeyBootstrapCreate(this.resolveDataSource(), {
        work: async (runner) => {
          await runner.manager.getRepository(SigningKeyEntity).insert({
            id,
            publicKey: generated.publicKeyPem,
            privateKey: this.secretEncryptionService.encryptVersioned(
              generated.privateKeyPem,
            ),
            isCurrent: true,
            revokedAt: null,
          });

          return id;
        },
        extractSigningKeyId: (createdId) => createdId,
      });

      await this.coreEntityCacheService.invalidate('signingKeyPublicKey', id);

      return { id, privateKeyPem: generated.privateKeyPem };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findCurrentSigningKeyRow();

        if (isDefined(existing)) {
          return {
            id: existing.id,
            privateKeyPem: this.decryptPrivateKey(
              existing.privateKey,
              existing.id,
            ),
          };
        }
      }

      throw error;
    }
  }

  private generateEcP256KeyPair(): {
    privateKeyPem: PlaintextString;
    publicKeyPem: string;
  } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });

    const privateKeyPem = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString() as PlaintextString;
    const publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    return { privateKeyPem, publicKeyPem };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error as QueryFailedError & { code?: string }).code ===
        UNIQUE_VIOLATION_PG_CODE
    );
  }
}
