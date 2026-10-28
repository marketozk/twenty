import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';

import { addMilliseconds } from 'date-fns';
import ms from 'ms';
import { type QueryRunner, Repository } from 'typeorm';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { acquireUserAuthenticationLock } from 'src/engine/core-modules/auth/utils/acquire-user-authentication-lock.util';

import {
  AppTokenEntity,
  AppTokenType,
} from 'src/engine/core-modules/app-token/app-token.entity';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { type AuthToken } from 'src/engine/core-modules/auth/dto/auth-token.dto';
import { type RefreshTokenJwtPayload } from 'src/engine/core-modules/auth/types/refresh-token-jwt-payload.type';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import { isRevokedRefreshTokenStillRenewable } from 'src/engine/core-modules/auth/utils/is-revoked-refresh-token-still-renewable.util';
import { JwtWrapperService } from 'src/engine/core-modules/jwt/services/jwt-wrapper.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';

type RefreshTokenPayload = Omit<RefreshTokenJwtPayload, 'type' | 'sub' | 'jti'>;

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly jwtWrapperService: JwtWrapperService,
    private readonly twentyConfigService: TwentyConfigService,
    @InjectRepository(AppTokenEntity)
    private readonly appTokenRepository: Repository<AppTokenEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async verifyRefreshToken(refreshToken: string) {
    const reuseGracePeriod = this.twentyConfigService.get(
      'REFRESH_TOKEN_REUSE_GRACE_PERIOD',
    );

    await this.jwtWrapperService.verifyJwtToken(refreshToken);
    const jwtPayload =
      this.jwtWrapperService.decode<RefreshTokenJwtPayload>(refreshToken);

    if (jwtPayload.type !== JwtTokenTypeEnum.REFRESH) {
      throw new AuthException(
        'Expected a refresh token',
        AuthExceptionCode.INVALID_JWT_TOKEN_TYPE,
      );
    }

    if (!(jwtPayload.jti && jwtPayload.sub)) {
      throw new AuthException(
        'This refresh token is malformed',
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    const token = await this.appTokenRepository.findOneBy({
      id: jwtPayload.jti,
    });

    if (!token) {
      throw new AuthException(
        "This refresh token doesn't exist",
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    const user = await this.userRepository.findOneBy({
      id: jwtPayload.sub,
    });

    if (!user) {
      throw new AuthException(
        'User not found',
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    if (token.revokedAt) {
      const isStillRenewable = isRevokedRefreshTokenStillRenewable({
        revokedAt: token.revokedAt,
        revokedReason: token.context?.revokedReason,
        reuseGracePeriod,
        now: new Date(),
      });

      if (!isStillRenewable) {
        // Reject the stale token but don't revoke all tokens — the most
        // common cause is a lost renewal response, not actual token theft.
        throw new AuthException(
          'This refresh token has been revoked.',
          AuthExceptionCode.FORBIDDEN_EXCEPTION,
        );
      }

      // Token was revoked recently (within grace period). This is expected
      // when concurrent requests (e.g. two browser tabs) race to refresh
      // at the same time. Allow it but don't reset the original revokedAt
      // timestamp so the grace window stays anchored and cannot be extended.
    }

    return {
      user,
      token,
      authProvider: jwtPayload.authProvider,
      targetedTokenType: jwtPayload.targetedTokenType,
      isImpersonating: jwtPayload.isImpersonating,
      impersonatorUserWorkspaceId: jwtPayload.impersonatorUserWorkspaceId,
      impersonatedUserWorkspaceId: jwtPayload.impersonatedUserWorkspaceId,
    };
  }

  async generateRefreshToken(
    payload: RefreshTokenPayload,
    isImpersonationToken: boolean = false,
  ): Promise<AuthToken> {
    payload = this.capturePayload(payload);
    this.assertOwnTransaction();
    return runInCoreAuditTransaction(
      this.appTokenRepository.manager.connection,
      async (runner) => {
        const audit = await this.createAudit(runner, payload);
        const issued = await this.issueRefreshToken(
          runner,
          payload,
          isImpersonationToken,
          audit,
        );
        await audit?.flush();
        await this.validateSnapshot(runner, issued.snapshot);
        return issued.token;
      },
    );
  }

  async rotateRefreshToken({
    tokenId,
    payload,
  }: {
    tokenId: string;
    payload: RefreshTokenPayload;
  }): Promise<AuthToken> {
    payload = this.capturePayload(payload);
    this.assertOwnTransaction();
    return runInCoreAuditTransaction(
      this.appTokenRepository.manager.connection,
      async (runner) => {
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: payload.userId,
          mode: 'shared',
        });
        const repository = runner.manager.getRepository(AppTokenEntity);
        const before = await repository.findOne({
          where: {
            id: tokenId,
            userId: payload.userId,
            type: AppTokenType.RefreshToken,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !before ||
          before.workspaceId !== (payload.workspaceId ?? null) ||
          before.context?.revokedReason != null ||
          (before.revokedAt &&
            !isRevokedRefreshTokenStillRenewable({
              revokedAt: before.revokedAt,
              revokedReason: before.context?.revokedReason,
              reuseGracePeriod: this.twentyConfigService.get(
                'REFRESH_TOKEN_REUSE_GRACE_PERIOD',
              ),
              now: new Date(),
            }))
        )
          throw new AuthException(
            'This refresh token has been revoked.',
            AuthExceptionCode.FORBIDDEN_EXCEPTION,
          );
        const audit = await this.createAudit(runner, payload);
        const revokedAt = before.revokedAt ?? new Date();
        if (!before.revokedAt) {
          const result = await repository
            .createQueryBuilder()
            .update(AppTokenEntity)
            .set({ revokedAt })
            .where('id = :id', { id: before.id })
            .andWhere('"revokedAt" IS NULL')
            .returning(['id'])
            .execute();
          if (result.raw.length !== 1 || result.raw[0].id !== before.id)
            throw new Error('Refresh rotation affected unexpected rows');
          audit?.record({
            resourceKind: 'refreshToken',
            resourceId: before.id,
            action: 'update',
            before: { revokedAt: null },
            after: { revokedAt: revokedAt.toISOString() },
            securityDescriptor: this.tokenDescriptor(before),
          });
        }
        const expected = { ...before, revokedAt };
        await this.validateSnapshot(runner, expected);
        const issued = await this.issueRefreshToken(
          runner,
          payload,
          false,
          audit,
        );
        await audit?.flush();
        await this.validateSnapshot(runner, expected);
        await this.validateSnapshot(runner, issued.snapshot);
        return issued.token;
      },
    );
  }

  private capturePayload(payload: RefreshTokenPayload): RefreshTokenPayload {
    if (
      !isUUID(payload.userId) ||
      (payload.workspaceId != null && !isUUID(payload.workspaceId))
    )
      throw new Error('Refresh issuance scope is invalid');
    return {
      ...payload,
      userId: payload.userId.toLowerCase(),
      ...(payload.workspaceId
        ? { workspaceId: payload.workspaceId.toLowerCase() }
        : {}),
    };
  }

  private assertOwnTransaction(): void {
    if (this.appTokenRepository.manager.queryRunner)
      throw new Error(
        'Refresh issuance requires ownership of the core transaction',
      );
  }

  private tokenDescriptor(token: Pick<AppTokenEntity, 'id' | 'userId'>) {
    if (!token.userId)
      throw new Error('Refresh audit requires a credential owner');
    return {
      resourceKind: 'refreshToken' as const,
      resourceId: token.id,
      tokenOwner: {
        userId: token.userId,
        access: 'currentWorkspaceAdministration' as const,
      },
    };
  }

  private async createAudit(
    runner: QueryRunner,
    payload: RefreshTokenPayload,
  ): Promise<CrmAuditTransactionContext | undefined> {
    if (!payload.workspaceId) return undefined;
    let initiator: { kind: 'coreUser'; id: string } | undefined;
    if (payload.impersonatorUserWorkspaceId) {
      const rows: { userId: string }[] = await runner.query(
        'SELECT "userId" FROM core."userWorkspace" WHERE id=$1 AND "deletedAt" IS NULL',
        [payload.impersonatorUserWorkspaceId],
      );
      if (rows.length !== 1)
        throw new Error('Refresh issuance initiator unavailable');
      initiator = { kind: 'coreUser', id: rows[0].userId };
    }
    return new CrmAuditTransactionContext(runner, {
      workspaceId: payload.workspaceId,
      operationId: randomUUID(),
      actor: { kind: 'coreUser', id: payload.userId },
      ...(initiator ? { initiator } : {}),
    });
  }

  private async validateSnapshot(
    runner: QueryRunner,
    expected: AppTokenEntity,
  ): Promise<void> {
    const actual = await runner.manager
      .getRepository(AppTokenEntity)
      .findOneBy({ id: expected.id });
    if (!actual) throw new Error('Refresh persisted credential vanished');
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'updatedAt') continue;
      const stored = (actual as unknown as Record<string, unknown>)[key];
      if (value === undefined && stored === undefined) continue;
      const normalize = (item: unknown) =>
        item instanceof Date ? item.toISOString() : item;
      if (
        canonicalAuditJson(normalize(value)) !==
        canonicalAuditJson(normalize(stored))
      )
        throw new Error('Refresh persisted credential changed');
    }
  }

  private async issueRefreshToken(
    runner: QueryRunner,
    payload: RefreshTokenPayload,
    isImpersonationToken: boolean,
    audit: CrmAuditTransactionContext | undefined,
  ): Promise<{ token: AuthToken; snapshot: AppTokenEntity }> {
    const expiresIn = isImpersonationToken
      ? '1d'
      : this.twentyConfigService.get('REFRESH_TOKEN_EXPIRES_IN');

    if (!expiresIn) {
      throw new AuthException(
        'Expiration time for access token is not set',
        AuthExceptionCode.INTERNAL_SERVER_ERROR,
      );
    }

    const expiresAt = addMilliseconds(new Date().getTime(), ms(expiresIn));

    const appTokenRepository = runner.manager.getRepository(AppTokenEntity);

    const refreshToken = appTokenRepository.create({
      userId: payload.userId,
      workspaceId: payload.workspaceId ?? null,
      expiresAt,
      type: AppTokenType.RefreshToken,
    });

    await appTokenRepository.save(refreshToken);

    const snapshot = await appTokenRepository.findOneByOrFail({
      id: refreshToken.id,
    });
    if (
      snapshot.userId !== payload.userId ||
      snapshot.workspaceId !== (payload.workspaceId ?? null) ||
      snapshot.type !== AppTokenType.RefreshToken ||
      snapshot.expiresAt.getTime() !== expiresAt.getTime() ||
      snapshot.revokedAt !== null ||
      snapshot.deletedAt !== null ||
      snapshot.value !== null ||
      snapshot.context !== null
    )
      throw new Error('Refresh issuance persisted credential does not match');

    const jwtPayload: RefreshTokenJwtPayload = {
      ...payload,
      sub: payload.userId,
      type: JwtTokenTypeEnum.REFRESH,
    };

    const token = await this.jwtWrapperService.signAsyncOrThrow(jwtPayload, {
      expiresIn,
      jwtid: refreshToken.id,
    });

    await this.validateSnapshot(runner, snapshot);
    audit?.record({
      resourceKind: 'refreshToken',
      resourceId: snapshot.id,
      action: 'create',
      before: null,
      after: {
        createdAt: snapshot.createdAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
      },
      securityDescriptor: this.tokenDescriptor(snapshot),
    });
    return { token: { token, expiresAt }, snapshot };
  }
}
