import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { type MessageDescriptor } from '@lingui/core';
import { isNonEmptyString } from '@sniptt/guards';
import { authenticator } from 'otplib';
import { TwoFactorAuthenticationStrategy } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, type EntityManager, IsNull, Repository } from 'typeorm';

import {
  AppTokenEntity,
  AppTokenType,
} from 'src/engine/core-modules/app-token/app-token.entity';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { acquireUserAuthenticationLock } from 'src/engine/core-modules/auth/utils/acquire-user-authentication-lock.util';
import { peekCurrentCrmAuditWorkspaceId } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  captureTwoFactorAuthenticationAudit,
  runAuditedTwoFactorDeletion,
  runAuditedTwoFactorProvisioning,
  runAuditedTwoFactorValidation,
  type TwoFactorAuthenticationAuditIdentity,
} from 'src/engine/core-modules/crm-audit/two-factor-authentication-audit';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';
import { ThrottlerService } from 'src/engine/core-modules/throttler/throttler.service';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import {
  TWO_FACTOR_AUTHENTICATION_OTP_RATE_LIMIT_MAX,
  TWO_FACTOR_AUTHENTICATION_OTP_RATE_LIMIT_WINDOW_MS,
} from 'src/engine/core-modules/two-factor-authentication/constants/two-factor-authentication-otp-rate-limit.constant';
import { TwoFactorAuthenticationMethodEntity } from 'src/engine/core-modules/two-factor-authentication/entities/two-factor-authentication-method.entity';
import { TOTP_DEFAULT_CONFIGURATION } from 'src/engine/core-modules/two-factor-authentication/strategies/otp/totp/constants/totp.strategy.constants';
import { TotpStrategy } from 'src/engine/core-modules/two-factor-authentication/strategies/otp/totp/totp.strategy';
import { buildTwoFactorAuthenticationOtpRateLimitKey } from 'src/engine/core-modules/two-factor-authentication/utils/build-two-factor-authentication-otp-rate-limit-key.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { UserWorkspaceService } from 'src/engine/core-modules/user-workspace/user-workspace.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

import {
  TwoFactorAuthenticationException,
  TwoFactorAuthenticationExceptionCode,
} from './two-factor-authentication.exception';
import { twoFactorAuthenticationMethodsValidator } from './two-factor-authentication.validation';

import { OTPStatus } from './strategies/otp/otp.constants';

const PENDING_METHOD_REUSE_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
// oxlint-disable-next-line twenty/inject-workspace-repository
export class TwoFactorAuthenticationService {
  constructor(
    @InjectWorkspaceScopedRepository(TwoFactorAuthenticationMethodEntity)
    private readonly twoFactorAuthenticationMethodRepository: WorkspaceScopedRepository<TwoFactorAuthenticationMethodEntity>,
    @InjectRepository(AppTokenEntity)
    private readonly appTokenRepository: Repository<AppTokenEntity>,
    private readonly userWorkspaceService: UserWorkspaceService,
    private readonly secretEncryptionService: SecretEncryptionService,
    private readonly throttlerService: ThrottlerService,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.dataSource ??
      (this.appTokenRepository?.manager?.connection as DataSource | undefined)
    );
  }

  private async decryptStoredSecret({
    storedSecret,
    workspaceId,
  }: {
    storedSecret: EncryptedString;
    workspaceId: string;
  }): Promise<PlaintextString> {
    return this.secretEncryptionService.decryptVersionedOrThrow(storedSecret, {
      workspaceId,
    });
  }

  async validateTwoFactorAuthenticationRequirement(
    targetWorkspace: WorkspaceEntity,
    userTwoFactorAuthenticationMethods?: TwoFactorAuthenticationMethodEntity[],
  ) {
    if (
      twoFactorAuthenticationMethodsValidator.areDefined(
        userTwoFactorAuthenticationMethods,
      ) &&
      twoFactorAuthenticationMethodsValidator.areVerified(
        userTwoFactorAuthenticationMethods,
      )
    ) {
      throw new AuthException(
        'Two factor authentication verification required',
        AuthExceptionCode.TWO_FACTOR_AUTHENTICATION_VERIFICATION_REQUIRED,
      );
    } else if (targetWorkspace?.isTwoFactorAuthenticationEnforced) {
      throw new AuthException(
        'Two factor authentication setup required',
        AuthExceptionCode.TWO_FACTOR_AUTHENTICATION_PROVISION_REQUIRED,
      );
    }
  }

  async initiateStrategyConfiguration(
    userId: string,
    userEmail: string,
    workspaceId: string,
    workspaceDisplayName?: string,
    options?: {
      auditIdentity?: TwoFactorAuthenticationAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const hasExplicitAuditIdentity =
      options !== undefined && 'auditIdentity' in options;
    const auditRequest =
      resolvedDataSource || hasExplicitAuditIdentity
        ? captureTwoFactorAuthenticationAudit(
            workspaceId,
            hasExplicitAuditIdentity
              ? options.auditIdentity
              : peekCurrentCrmAuditWorkspaceId() ===
                  workspaceId?.toLowerCase?.()
                ? undefined
                : { workspaceId, actor: { kind: 'coreUser', id: userId } },
            { expectedUserId: userId },
          )
        : undefined;

    if (resolvedDataSource && auditRequest) {
      const result = await runAuditedTwoFactorProvisioning({
        dataSource: resolvedDataSource,
        request: auditRequest,
        userId,
        strategy: TwoFactorAuthenticationStrategy.TOTP,
        pendingMethodReuseWindowMs: PENDING_METHOD_REUSE_WINDOW_MS,
        generateCandidate: () =>
          this.generatePendingTotpSecret({
            userEmail,
            workspaceId,
            workspaceDisplayName,
          }),
        onUserWorkspaceMissing: () => {
          throw new AuthException(
            'User is not a member of the workspace',
            AuthExceptionCode.FORBIDDEN_EXCEPTION,
          );
        },
        onAlreadyProvisioned: () => {
          throw new TwoFactorAuthenticationException(
            'A two factor authentication method has already been set. Please delete it and try again.',
            TwoFactorAuthenticationExceptionCode.TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED,
          );
        },
        onRecoveryEnrollmentRestricted: () => {
          throw new TwoFactorAuthenticationException(
            'Enrollment after a recovery must use the authenticator issued with the recovery code',
            TwoFactorAuthenticationExceptionCode.RECOVERY_ENROLLMENT_RESTRICTED,
          );
        },
      });

      if (result.reused) {
        const existingSecret = await this.decryptStoredSecret({
          storedSecret: result.existingSecret as EncryptedString,
          workspaceId,
        });
        const issuer = `Twenty${workspaceDisplayName ? ` - ${workspaceDisplayName}` : ''}`;

        return authenticator.keyuri(userEmail, issuer, existingSecret);
      }

      return result.uri;
    }

    const userWorkspace =
      await this.userWorkspaceService.getUserWorkspaceForUserOrThrow({
        userId,
        workspaceId,
      });

    const existing2FAMethod =
      await this.twoFactorAuthenticationMethodRepository.findOne(workspaceId, {
        where: {
          userWorkspace: { id: userWorkspace.id },
          strategy: TwoFactorAuthenticationStrategy.TOTP,
        },
      });

    if (existing2FAMethod && existing2FAMethod.status !== 'PENDING') {
      throw new TwoFactorAuthenticationException(
        'A two factor authentication method has already been set. Please delete it and try again.',
        TwoFactorAuthenticationExceptionCode.TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED,
      );
    }

    if (
      existing2FAMethod &&
      existing2FAMethod.status === 'PENDING' &&
      existing2FAMethod.createdAt &&
      Date.now() - existing2FAMethod.createdAt.getTime() <
        PENDING_METHOD_REUSE_WINDOW_MS
    ) {
      const existingSecret = await this.decryptStoredSecret({
        storedSecret: existing2FAMethod.secret,
        workspaceId,
      });

      const issuer = `Twenty${workspaceDisplayName ? ` - ${workspaceDisplayName}` : ''}`;
      const reuseUri = authenticator.keyuri(userEmail, issuer, existingSecret);

      return reuseUri;
    }

    const { uri, encryptedSecret, status } = this.generatePendingTotpSecret({
      userEmail,
      workspaceId,
      workspaceDisplayName,
    });

    await this.twoFactorAuthenticationMethodRepository.upsert(
      workspaceId,
      {
        userWorkspaceId: userWorkspace.id,
        secret: encryptedSecret,
        status,
        strategy: TwoFactorAuthenticationStrategy.TOTP,
      },
      ['userWorkspaceId', 'strategy'],
    );

    return uri;
  }

  generatePendingTotpSecret({
    userEmail,
    workspaceId,
    workspaceDisplayName,
  }: {
    userEmail: string;
    workspaceId: WorkspaceEntity['id'];
    workspaceDisplayName?: string;
  }): { uri: string; encryptedSecret: EncryptedString; status: OTPStatus } {
    const { uri, context } = new TotpStrategy(
      TOTP_DEFAULT_CONFIGURATION,
    ).initiate(
      userEmail,
      `Twenty${workspaceDisplayName ? ` - ${workspaceDisplayName}` : ''}`,
    );

    return {
      uri,
      encryptedSecret: this.secretEncryptionService.encryptVersioned(
        context.secret,
        { workspaceId },
      ),
      status: context.status,
    };
  }

  async validateStrategy(
    userId: UserEntity['id'],
    token: string,
    workspaceId: WorkspaceEntity['id'],
    twoFactorAuthenticationStrategy: TwoFactorAuthenticationStrategy,
    options?: {
      auditIdentity?: TwoFactorAuthenticationAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const hasExplicitAuditIdentity =
      options !== undefined && 'auditIdentity' in options;
    const auditRequest =
      resolvedDataSource || hasExplicitAuditIdentity
        ? captureTwoFactorAuthenticationAudit(
            workspaceId,
            hasExplicitAuditIdentity
              ? options.auditIdentity
              : peekCurrentCrmAuditWorkspaceId() ===
                  workspaceId?.toLowerCase?.()
                ? undefined
                : { workspaceId, actor: { kind: 'coreUser', id: userId } },
            { expectedUserId: userId },
          )
        : undefined;

    await this.throttlerService.tokenBucketThrottleOrThrow(
      buildTwoFactorAuthenticationOtpRateLimitKey({ userId, workspaceId }),
      1,
      TWO_FACTOR_AUTHENTICATION_OTP_RATE_LIMIT_MAX,
      TWO_FACTOR_AUTHENTICATION_OTP_RATE_LIMIT_WINDOW_MS,
    );

    const userTwoFactorAuthenticationMethod =
      await this.twoFactorAuthenticationMethodRepository.findOne(workspaceId, {
        where: {
          strategy: twoFactorAuthenticationStrategy,
          userWorkspace: {
            userId,
            workspaceId,
          },
        },
      });

    if (!isDefined(userTwoFactorAuthenticationMethod)) {
      throw new TwoFactorAuthenticationException(
        'Two Factor Authentication Method not found.',
        TwoFactorAuthenticationExceptionCode.INVALID_CONFIGURATION,
      );
    }

    if (!isDefined(userTwoFactorAuthenticationMethod.secret)) {
      throw new TwoFactorAuthenticationException(
        'Malformed Two Factor Authentication Method object',
        TwoFactorAuthenticationExceptionCode.MALFORMED_DATABASE_OBJECT,
      );
    }

    const originalSecret = await this.decryptStoredSecret({
      storedSecret: userTwoFactorAuthenticationMethod.secret,
      workspaceId,
    });

    const otpContext = {
      status: userTwoFactorAuthenticationMethod.status,
      secret: originalSecret,
    };

    const validationResult = new TotpStrategy(
      TOTP_DEFAULT_CONFIGURATION,
    ).validate(token, otpContext);

    if (!validationResult.isValid) {
      throw new TwoFactorAuthenticationException(
        'Invalid OTP',
        TwoFactorAuthenticationExceptionCode.INVALID_OTP,
      );
    }

    if (resolvedDataSource && auditRequest) {
      await runAuditedTwoFactorValidation({
        dataSource: resolvedDataSource,
        request: auditRequest,
        methodId: userTwoFactorAuthenticationMethod.id,
        userId,
        expectedSecret: userTwoFactorAuthenticationMethod.secret,
        verifiedStatus: OTPStatus.VERIFIED,
        onMethodNotFound: () => {
          throw new TwoFactorAuthenticationException(
            'Two Factor Authentication Method not found.',
            TwoFactorAuthenticationExceptionCode.INVALID_CONFIGURATION,
          );
        },
      });

      return;
    }

    await this.appTokenRepository.manager.transaction(async (entityManager) => {
      await acquireUserAuthenticationLock({
        entityManager,
        userId,
        mode: 'exclusive',
      });

      // A recovery that committed after the read replaced this method, and its enrollment reservation must survive
      const updateResult = await entityManager
        .getRepository(TwoFactorAuthenticationMethodEntity)
        .update(
          {
            id: userTwoFactorAuthenticationMethod.id,
            workspaceId,
            secret: userTwoFactorAuthenticationMethod.secret,
          },
          { status: OTPStatus.VERIFIED },
        );

      if ((updateResult.affected ?? 0) === 0) {
        throw new TwoFactorAuthenticationException(
          'Two Factor Authentication Method not found.',
          TwoFactorAuthenticationExceptionCode.INVALID_CONFIGURATION,
        );
      }

      await this.revokeRecoveryCodes({
        workspaceId,
        userId,
        includeRedeemed: true,
        entityManager,
      });
    });
  }

  async revokeRecoveryCodes({
    workspaceId,
    userId,
    includeRedeemed = false,
    entityManager,
  }: {
    workspaceId: WorkspaceEntity['id'];
    userId: UserEntity['id'];
    includeRedeemed?: boolean;
    entityManager?: EntityManager;
  }): Promise<number> {
    const appTokenRepository =
      entityManager?.getRepository(AppTokenEntity) ?? this.appTokenRepository;

    const updateResult = await appTokenRepository.update(
      {
        workspaceId,
        userId,
        type: AppTokenType.TwoFactorAuthenticationRecoveryCode,
        revokedAt: IsNull(),
        ...(includeRedeemed ? {} : { deletedAt: IsNull() }),
      },
      { revokedAt: new Date() },
    );

    return updateResult.affected ?? 0;
  }

  async assertFreshStepUpAuthenticationOrThrow({
    userId,
    workspaceId,
    otp,
    otpRequiredMessage,
    twoFactorAuthenticationRequiredMessage,
  }: {
    userId: UserEntity['id'];
    workspaceId: WorkspaceEntity['id'];
    otp?: string;
    otpRequiredMessage: MessageDescriptor;
    twoFactorAuthenticationRequiredMessage: MessageDescriptor;
  }): Promise<void> {
    if (!isNonEmptyString(otp)) {
      throw new TwoFactorAuthenticationException(
        'A two-factor authentication code is required for this action',
        TwoFactorAuthenticationExceptionCode.STEP_UP_AUTHENTICATION_REQUIRED,
        { userFriendlyMessage: otpRequiredMessage },
      );
    }

    const hasVerifiedTwoFactorAuthenticationMethod =
      await this.twoFactorAuthenticationMethodRepository.exists(workspaceId, {
        where: { userWorkspace: { userId }, status: OTPStatus.VERIFIED },
      });

    if (!hasVerifiedTwoFactorAuthenticationMethod) {
      throw new TwoFactorAuthenticationException(
        'Two-factor authentication must be enabled in the current workspace for this action',
        TwoFactorAuthenticationExceptionCode.STEP_UP_AUTHENTICATION_REQUIRED,
        { userFriendlyMessage: twoFactorAuthenticationRequiredMessage },
      );
    }

    await this.verifyTwoFactorAuthenticationMethodForAuthenticatedUser(
      userId,
      otp,
      workspaceId,
    );
  }

  async verifyTwoFactorAuthenticationMethodForAuthenticatedUser(
    userId: UserEntity['id'],
    token: string,
    workspaceId: WorkspaceEntity['id'],
    options?: {
      auditIdentity?: TwoFactorAuthenticationAuditIdentity;
    },
  ) {
    await this.validateStrategy(
      userId,
      token,
      workspaceId,
      TwoFactorAuthenticationStrategy.TOTP,
      options,
    );

    return { success: true };
  }

  async deleteTwoFactorAuthenticationMethod(params: {
    twoFactorAuthenticationMethodId: string;
    workspaceId: WorkspaceEntity['id'];
    userId: UserEntity['id'];
    auditIdentity?: TwoFactorAuthenticationAuditIdentity;
  }): Promise<void> {
    const hasExplicitAuditIdentity = 'auditIdentity' in params;
    const auditRequest = captureTwoFactorAuthenticationAudit(
      params.workspaceId,
      hasExplicitAuditIdentity
        ? params.auditIdentity
        : peekCurrentCrmAuditWorkspaceId() ===
            params.workspaceId?.toLowerCase?.()
          ? undefined
          : {
              workspaceId: params.workspaceId,
              actor: { kind: 'coreUser', id: params.userId },
            },
      { expectedUserId: params.userId },
    );
    const resolvedDataSource = this.resolveDataSource();
    if (!resolvedDataSource) {
      throw new Error(
        'TwoFactorAuthenticationService requires DataSource for audited method deletion',
      );
    }

    await runAuditedTwoFactorDeletion({
      dataSource: resolvedDataSource,
      request: auditRequest,
      methodId: params.twoFactorAuthenticationMethodId,
      userId: params.userId,
      onMethodNotFound: () => {
        throw new AuthException(
          'Two-factor authentication method not found',
          AuthExceptionCode.INVALID_INPUT,
        );
      },
      onForbiddenOwner: () => {
        throw new AuthException(
          'You can only delete your own two-factor authentication methods',
          AuthExceptionCode.FORBIDDEN_EXCEPTION,
        );
      },
    });
  }
}
