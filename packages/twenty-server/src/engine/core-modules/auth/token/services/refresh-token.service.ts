import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';

import { addMilliseconds } from 'date-fns';
import ms from 'ms';
import { type QueryRunner, Repository } from 'typeorm';
import { reportCrmAuditUnavailable } from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
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
import { UserSessionRevokedReason } from 'src/engine/core-modules/user-session/types/user-session-revoked-reason.type';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';

type RefreshTokenPayload = Omit<RefreshTokenJwtPayload, 'type' | 'sub' | 'jti'>;

type ActiveSubjectCheckResult =
  | {
      active: true;
      initiator?: { kind: 'coreUser'; id: string };
    }
  | {
      active: false;
      error: Error;
    };

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

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

    if (
      !(
        jwtPayload.jti &&
        jwtPayload.sub &&
        isUUID(jwtPayload.jti) &&
        isUUID(jwtPayload.sub)
      ) ||
      (jwtPayload.userId != null &&
        (typeof jwtPayload.userId !== 'string' ||
          jwtPayload.userId.toLowerCase() !== jwtPayload.sub.toLowerCase())) ||
      (jwtPayload.workspaceId != null &&
        (typeof jwtPayload.workspaceId !== 'string' ||
          !isUUID(jwtPayload.workspaceId)))
    ) {
      throw new AuthException(
        'This refresh token is malformed',
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    const token = await this.appTokenRepository.findOneBy({
      id: jwtPayload.jti,
    });

    if (
      !token ||
      token.type !== AppTokenType.RefreshToken ||
      !token.userId ||
      token.userId.toLowerCase() !== jwtPayload.sub.toLowerCase() ||
      (jwtPayload.workspaceId != null &&
        token.workspaceId?.toLowerCase() !==
          jwtPayload.workspaceId.toLowerCase())
    ) {
      throw new AuthException(
        "This refresh token doesn't exist",
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
        const familyId = token.context?.familyId;
        if (
          token.context?.revokedReason == null &&
          typeof familyId === 'string' &&
          isUUID(familyId)
        ) {
          await this.revokeRefreshTokenFamilyOnReuse({
            userId: token.userId.toLowerCase(),
            familyId: familyId.toLowerCase(),
            presentedTokenId: token.id,
            impersonatorUserWorkspaceId:
              jwtPayload.isImpersonating === true &&
              typeof jwtPayload.impersonatorUserWorkspaceId === 'string' &&
              isUUID(jwtPayload.impersonatorUserWorkspaceId)
                ? jwtPayload.impersonatorUserWorkspaceId.toLowerCase()
                : undefined,
          });
        }

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

    const user = await this.userRepository.findOneBy({
      id: jwtPayload.sub,
    });

    if (!user) {
      throw new AuthException(
        'User not found',
        AuthExceptionCode.INVALID_INPUT,
      );
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
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: payload.userId,
          mode: 'shared',
        });
        const subject = await this.lockAndCheckActiveSubject(runner, payload);
        if (!subject.active) throw subject.error;
        const audit = this.createAudit(runner, payload, subject.initiator);
        const issued = await this.issueRefreshToken(
          runner,
          payload,
          isImpersonationToken,
          randomUUID(),
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
    if (typeof tokenId !== 'string' || !isUUID(tokenId)) {
      throw new AuthException(
        'This refresh token is malformed',
        AuthExceptionCode.INVALID_INPUT,
      );
    }
    payload = this.capturePayload(payload);
    this.assertOwnTransaction();
    const outcome = await runInCoreAuditTransaction(
      this.appTokenRepository.manager.connection,
      async (
        runner,
      ): Promise<
        | { replayDetected: false; token: AuthToken }
        | {
            replayDetected: true;
            userId: string;
            familyId: string;
            presentedTokenId: string;
            impersonatorUserWorkspaceId?: string;
          }
      > => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await acquireUserAuthenticationLock({
          entityManager: runner.manager,
          userId: payload.userId,
          mode: 'shared',
        });
        // Lock subject rows before appToken (W -> U -> UW -> AT) to avoid ON DELETE CASCADE deadlocks,
        // but defer throwing subject errors until after token revocation/replay checks.
        const subject = await this.lockAndCheckActiveSubject(runner, payload);
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
          before.context?.revokedReason != null
        )
          throw new AuthException(
            'This refresh token has been revoked.',
            AuthExceptionCode.FORBIDDEN_EXCEPTION,
          );
        if (
          before.context !== null &&
          (typeof before.context !== 'object' || Array.isArray(before.context))
        )
          throw new Error('Refresh rotation context is invalid');
        const rawFamilyId = before.context?.familyId;
        if (
          rawFamilyId !== undefined &&
          (typeof rawFamilyId !== 'string' || !isUUID(rawFamilyId))
        )
          throw new Error('Refresh rotation family is invalid');
        if (
          before.revokedAt &&
          !isRevokedRefreshTokenStillRenewable({
            revokedAt: before.revokedAt,
            revokedReason: before.context?.revokedReason,
            reuseGracePeriod: this.twentyConfigService.get(
              'REFRESH_TOKEN_REUSE_GRACE_PERIOD',
            ),
            now: new Date(),
          })
        ) {
          if (typeof rawFamilyId === 'string') {
            return {
              replayDetected: true,
              userId: payload.userId,
              familyId: rawFamilyId.toLowerCase(),
              presentedTokenId: before.id,
              impersonatorUserWorkspaceId: payload.impersonatorUserWorkspaceId,
            };
          }
          throw new AuthException(
            'This refresh token has been revoked.',
            AuthExceptionCode.FORBIDDEN_EXCEPTION,
          );
        }
        if (!subject.active) throw subject.error;
        const familyId = rawFamilyId
          ? rawFamilyId.toLowerCase()
          : before.id.toLowerCase();
        const audit = this.createAudit(runner, payload, subject.initiator);
        const revokedAt = before.revokedAt ?? new Date();
        let expectedContext = before.context;
        if (!before.revokedAt) {
          const updateFields: {
            revokedAt: Date;
            context?: AppTokenEntity['context'];
          } = { revokedAt };
          if (!rawFamilyId) {
            expectedContext = { ...before.context, familyId };
            updateFields.context = expectedContext;
          }
          const result = await repository
            .createQueryBuilder()
            .update(AppTokenEntity)
            .set(updateFields)
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
        const expected = { ...before, revokedAt, context: expectedContext };
        await this.validateSnapshot(runner, expected);
        const issued = await this.issueRefreshToken(
          runner,
          payload,
          false,
          familyId,
          audit,
        );
        await audit?.flush();
        await this.validateSnapshot(runner, expected);
        await this.validateSnapshot(runner, issued.snapshot);
        return { replayDetected: false, token: issued.token };
      },
    );

    if (outcome.replayDetected) {
      await this.revokeRefreshTokenFamilyOnReuse({
        userId: outcome.userId,
        familyId: outcome.familyId,
        presentedTokenId: outcome.presentedTokenId,
        impersonatorUserWorkspaceId: outcome.impersonatorUserWorkspaceId,
      });
      throw new AuthException(
        'This refresh token has been revoked.',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }

    return outcome.token;
  }

  private async revokeRefreshTokenFamilyOnReuse({
    userId,
    familyId,
    presentedTokenId,
    impersonatorUserWorkspaceId,
  }: {
    userId: string;
    familyId: string;
    presentedTokenId: string;
    impersonatorUserWorkspaceId?: string;
  }): Promise<void> {
    this.assertOwnTransaction();
    const operationId = randomUUID();
    let auditLost = false;
    let committed = false;
    let uncertainOutcome = false;
    try {
      await runInCoreAuditTransaction(
        this.appTokenRepository.manager.connection,
        async (runner) => {
          await runner.query("SET LOCAL lock_timeout = '8s'");
          await acquireUserAuthenticationLock({
            entityManager: runner.manager,
            userId,
            mode: 'exclusive',
          });
          const repository = runner.manager.getRepository(AppTokenEntity);
          const now = new Date();
          const beforeRows = await repository
            .createQueryBuilder('token')
            .where('token."userId" = :userId', { userId })
            .andWhere('token.type = :type', { type: AppTokenType.RefreshToken })
            .andWhere("LOWER(token.context->>'familyId') = :familyId", {
              familyId,
            })
            .andWhere(
              '(token."revokedAt" IS NULL OR token."expiresAt" > :now OR token.id = :presentedTokenId)',
              { now, presentedTokenId },
            )
            .andWhere(
              '(token."revokedAt" IS NULL OR (token.context->>\'revokedReason\') IS NULL)',
            )
            .orderBy('token.id', 'ASC')
            .setLock('pessimistic_write')
            .getMany();

          if (beforeRows.length === 0) return;

          const expectedById = new Map<string, AppTokenEntity>();
          for (const row of beforeRows) {
            if (
              row.context !== null &&
              (typeof row.context !== 'object' || Array.isArray(row.context))
            )
              throw new Error('Refresh family revocation context is invalid');
            const revokedAt = row.revokedAt ?? now;
            const context = {
              ...row.context,
              revokedReason: UserSessionRevokedReason.RefreshTokenReuseDetected,
            };
            const result = await repository
              .createQueryBuilder()
              .update(AppTokenEntity)
              .set({ revokedAt, context })
              .where('id = :id', { id: row.id })
              .returning(['id'])
              .execute();
            if (result.raw.length !== 1 || result.raw[0].id !== row.id)
              throw new Error(
                'Refresh family revocation affected unexpected rows',
              );
            expectedById.set(row.id, { ...row, revokedAt, context });
          }

          const validateAll = async () => {
            for (const expected of expectedById.values()) {
              await this.validateSnapshot(runner, expected);
            }
          };
          await validateAll();

          await runner.query('SAVEPOINT refresh_family_revocation_audit');
          try {
            let initiator: { kind: 'coreUser'; id: string } | undefined;
            if (impersonatorUserWorkspaceId) {
              // Read without row-lock inside revocation SAVEPOINT to preserve W -> U -> UW -> AT order.
              const memberships: { userId: string }[] = await runner.query(
                'SELECT "userId" FROM core."userWorkspace" WHERE id=$1 AND "deletedAt" IS NULL',
                [impersonatorUserWorkspaceId],
              );
              if (memberships.length !== 1)
                throw new Error('Refresh revocation initiator unavailable');
              initiator = { kind: 'coreUser', id: memberships[0].userId };
            }
            const contexts = new Map<string, CrmAuditTransactionContext>();
            for (const row of beforeRows) {
              if (!row.workspaceId) continue;
              let context = contexts.get(row.workspaceId);
              if (!context) {
                context = new CrmAuditTransactionContext(runner, {
                  workspaceId: row.workspaceId,
                  operationId,
                  actor: { kind: 'coreUser', id: userId },
                  ...(initiator ? { initiator } : {}),
                });
                contexts.set(row.workspaceId, context);
              }
              const expected = expectedById.get(row.id)!;
              context.record({
                resourceKind: 'refreshToken',
                resourceId: row.id,
                action: 'update',
                before: {
                  revokedAt: row.revokedAt?.toISOString() ?? null,
                  revokedReason: row.context?.revokedReason ?? null,
                },
                after: {
                  revokedAt: expected.revokedAt!.toISOString(),
                  revokedReason:
                    UserSessionRevokedReason.RefreshTokenReuseDetected,
                },
                securityDescriptor: this.tokenDescriptor(row),
              });
            }
            for (const context of contexts.values()) await context.flush();
            await validateAll();
          } catch {
            auditLost = true;
            await runner.query(
              'ROLLBACK TO SAVEPOINT refresh_family_revocation_audit',
            );
          }
          await runner.query(
            'RELEASE SAVEPOINT refresh_family_revocation_audit',
          );
          await validateAll();
        },
      );
      committed = true;
    } catch (error) {
      uncertainOutcome = isTransactionUnsafeToRetry(error);
      throw error;
    } finally {
      if (auditLost && (committed || uncertainOutcome))
        reportCrmAuditUnavailable({
          code: 'REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE',
          loggerContext: RefreshTokenService.name,
          operationId,
        });
    }
  }

  private capturePayload(payload: RefreshTokenPayload): RefreshTokenPayload {
    if (
      !isUUID(payload.userId) ||
      (payload.workspaceId != null && !isUUID(payload.workspaceId)) ||
      (payload.impersonatorUserWorkspaceId != null &&
        !isUUID(payload.impersonatorUserWorkspaceId)) ||
      (payload.impersonatedUserWorkspaceId != null &&
        !isUUID(payload.impersonatedUserWorkspaceId))
    )
      throw new Error('Refresh issuance scope is invalid');
    return {
      ...payload,
      userId: payload.userId.toLowerCase(),
      ...(payload.workspaceId
        ? { workspaceId: payload.workspaceId.toLowerCase() }
        : {}),
      ...(payload.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId:
              payload.impersonatorUserWorkspaceId.toLowerCase(),
          }
        : {}),
      ...(payload.impersonatedUserWorkspaceId
        ? {
            impersonatedUserWorkspaceId:
              payload.impersonatedUserWorkspaceId.toLowerCase(),
          }
        : {}),
    };
  }

  private async lockAndCheckActiveSubject(
    runner: QueryRunner,
    payload: RefreshTokenPayload,
  ): Promise<ActiveSubjectCheckResult> {
    if (payload.workspaceId) {
      const workspaces: { id: string }[] = await runner.query(
        'SELECT id FROM core.workspace WHERE id=$1 AND "deletedAt" IS NULL FOR KEY SHARE',
        [payload.workspaceId],
      );
      if (workspaces.length !== 1) {
        return {
          active: false,
          error: new AuthException(
            'Workspace not found',
            AuthExceptionCode.FORBIDDEN_EXCEPTION,
          ),
        };
      }
    }

    const users: { id: string }[] = await runner.query(
      `SELECT u.id FROM core."user" u
       WHERE u.id=$1 AND u."deletedAt" IS NULL
         AND COALESCE((to_jsonb(u)->>'disabled')::boolean, false) = false
       FOR SHARE`,
      [payload.userId],
    );
    if (users.length !== 1) {
      return {
        active: false,
        error: new AuthException(
          'User not found',
          AuthExceptionCode.FORBIDDEN_EXCEPTION,
        ),
      };
    }

    let initiator: { kind: 'coreUser'; id: string } | undefined;
    if (payload.workspaceId || payload.impersonatorUserWorkspaceId) {
      const memberships: {
        id: string;
        userId: string;
        workspaceId: string;
        userActive: boolean;
      }[] = await runner.query(
        `SELECT uw.id, uw."userId", uw."workspaceId",
           (u.id IS NOT NULL AND u."deletedAt" IS NULL
             AND COALESCE((to_jsonb(u)->>'disabled')::boolean, false) = false) AS "userActive"
         FROM core."userWorkspace" uw
         LEFT JOIN core."user" u ON u.id = uw."userId"
         WHERE uw."deletedAt" IS NULL
           AND (
             ($1::uuid IS NOT NULL AND uw."userId" = $2 AND uw."workspaceId" = $1)
             OR ($3::uuid IS NOT NULL AND uw.id = $3)
           )
         ORDER BY uw.id FOR SHARE OF uw`,
        [
          payload.workspaceId ?? null,
          payload.userId,
          payload.impersonatorUserWorkspaceId ?? null,
        ],
      );

      if (payload.workspaceId) {
        const targetMembership = memberships.find(
          (row) =>
            row.userId.toLowerCase() === payload.userId &&
            row.workspaceId.toLowerCase() === payload.workspaceId,
        );
        if (
          !targetMembership ||
          (payload.impersonatedUserWorkspaceId &&
            targetMembership.id.toLowerCase() !==
              payload.impersonatedUserWorkspaceId)
        ) {
          return {
            active: false,
            error: new AuthException(
              'User workspace not found',
              AuthExceptionCode.FORBIDDEN_EXCEPTION,
            ),
          };
        }
      }

      if (payload.impersonatorUserWorkspaceId) {
        const initiatorMembership = memberships.find(
          (row) => row.id.toLowerCase() === payload.impersonatorUserWorkspaceId,
        );
        if (!initiatorMembership || !initiatorMembership.userActive) {
          return {
            active: false,
            error: new Error('Refresh issuance initiator unavailable'),
          };
        }
        initiator = { kind: 'coreUser', id: initiatorMembership.userId };
      }
    }

    return { active: true, ...(initiator ? { initiator } : {}) };
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

  private createAudit(
    runner: QueryRunner,
    payload: RefreshTokenPayload,
    initiator: { kind: 'coreUser'; id: string } | undefined,
  ): CrmAuditTransactionContext | undefined {
    if (!payload.workspaceId) return undefined;
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
    familyId: string,
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
    const expectedContext = { familyId: familyId.toLowerCase() };

    const appTokenRepository = runner.manager.getRepository(AppTokenEntity);

    const refreshToken = appTokenRepository.create({
      userId: payload.userId,
      workspaceId: payload.workspaceId ?? null,
      expiresAt,
      type: AppTokenType.RefreshToken,
      context: expectedContext,
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
      canonicalAuditJson(snapshot.context) !==
        canonicalAuditJson(expectedContext)
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
