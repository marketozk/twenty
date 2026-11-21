import { UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { Args, Context, Mutation, Query } from '@nestjs/graphql';

import { AdminResolver } from 'src/engine/api/graphql/graphql-config/decorators/admin-resolver.decorator';
import {
  AdminPanelCreateUsageLimitInput,
  AdminPanelDeleteUsageLimitInput,
  AdminPanelUpdateUsageLimitInput,
  AdminPanelWorkspaceUsageLimitsInput,
} from 'src/engine/core-modules/admin-panel/dtos/admin-panel-usage-limit.input';
import {
  AdminPanelUsageLimitDTO,
  AdminPanelWorkspaceUsageLimitsDTO,
} from 'src/engine/core-modules/admin-panel/dtos/admin-panel-workspace-usage-limits.dto';
import { AdminPanelUsageLimitService } from 'src/engine/core-modules/admin-panel/services/admin-panel-usage-limit.service';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { roleAuditIdentityFromRequest } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { type WorkspaceDomainAuditIdentity } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { PreventNestToAutoLogGraphqlErrorsFilter } from 'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter';
import { ResolverValidationPipe } from 'src/engine/core-modules/graphql/pipes/resolver-validation.pipe';
import { UsageLimitGraphqlApiExceptionFilter } from 'src/engine/core-modules/usage-limit/filters/usage-limit-graphql-api-exception.filter';
import { UsageLimitService } from 'src/engine/core-modules/usage-limit/services/usage-limit.service';
import { fromUsageLimitEntityToDto } from 'src/engine/core-modules/usage-limit/utils/from-usage-limit-entity-to-dto.util';
import { AuthUser } from 'src/engine/decorators/auth/auth-user.decorator';
import { AdminPanelGuard } from 'src/engine/guards/admin-panel-guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';

@UsePipes(ResolverValidationPipe)
@AdminResolver()
@UseFilters(
  AuthGraphqlApiExceptionFilter,
  UsageLimitGraphqlApiExceptionFilter,
  PreventNestToAutoLogGraphqlErrorsFilter,
)
@UseGuards(
  AuthPrincipalGuard({
    userSession: {
      standard: true,
      impersonated: true,
      playground: true,
      workspaceAgnostic: false,
    },
    apiKey: false,
    oauthClient: false,
    application: false,
  }),
  NoPermissionGuard,
  AdminPanelGuard,
)
export class AdminPanelUsageLimitResolver {
  constructor(
    private readonly adminPanelUsageLimitService: AdminPanelUsageLimitService,
    private readonly usageLimitService: UsageLimitService,
  ) {}

  @Query(() => AdminPanelWorkspaceUsageLimitsDTO)
  async workspaceUsageLimits(
    @Args() { workspaceId }: AdminPanelWorkspaceUsageLimitsInput,
  ): Promise<AdminPanelWorkspaceUsageLimitsDTO> {
    return this.adminPanelUsageLimitService.findWorkspaceUsageLimits(
      workspaceId,
    );
  }

  private resolveOperatorAuditIdentity(
    workspaceId: string,
    actor: { id?: string } | undefined,
    context?: {
      req?: Parameters<typeof roleAuditIdentityFromRequest>[0] & {
        user?: { id?: string } | null;
      };
    },
  ): WorkspaceDomainAuditIdentity | undefined {
    const req = context?.req;
    if (
      req !== undefined &&
      req !== null &&
      req.workspace?.id === workspaceId
    ) {
      return roleAuditIdentityFromRequest(req);
    }

    const actorUserId = actor?.id ?? req?.user?.id;
    if (actorUserId === undefined || actorUserId === null) {
      return undefined;
    }

    const impersonatorUserWorkspaceId =
      req?.impersonationContext?.impersonatorUserWorkspaceId;

    return {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
      ...(impersonatorUserWorkspaceId !== undefined &&
      impersonatorUserWorkspaceId !== null
        ? { impersonatorUserWorkspaceId }
        : {}),
    };
  }

  @Mutation(() => AdminPanelUsageLimitDTO)
  async createWorkspaceUsageLimit(
    @Args() { workspaceId, payload }: AdminPanelCreateUsageLimitInput,
    @AuthUser({ allowUndefined: true }) actor?: { id?: string },
    @Context()
    context?: {
      req?: Parameters<typeof roleAuditIdentityFromRequest>[0] & {
        user?: { id?: string } | null;
      };
    },
  ): Promise<AdminPanelUsageLimitDTO> {
    const usageLimit = await this.usageLimitService.create({
      workspaceId,
      input: payload,
      isOperator: true,
      auditIdentity: this.resolveOperatorAuditIdentity(
        workspaceId,
        actor,
        context,
      ),
    });

    return fromUsageLimitEntityToDto(usageLimit);
  }

  @Mutation(() => AdminPanelUsageLimitDTO)
  async updateWorkspaceUsageLimit(
    @Args() { workspaceId, payload }: AdminPanelUpdateUsageLimitInput,
    @AuthUser({ allowUndefined: true }) actor?: { id?: string },
    @Context()
    context?: {
      req?: Parameters<typeof roleAuditIdentityFromRequest>[0] & {
        user?: { id?: string } | null;
      };
    },
  ): Promise<AdminPanelUsageLimitDTO> {
    const usageLimit = await this.usageLimitService.update({
      workspaceId,
      input: payload,
      isOperator: true,
      auditIdentity: this.resolveOperatorAuditIdentity(
        workspaceId,
        actor,
        context,
      ),
    });

    return fromUsageLimitEntityToDto(usageLimit);
  }

  @Mutation(() => Boolean)
  async deleteWorkspaceUsageLimit(
    @Args() { workspaceId, usageLimitId }: AdminPanelDeleteUsageLimitInput,
    @AuthUser({ allowUndefined: true }) actor?: { id?: string },
    @Context()
    context?: {
      req?: Parameters<typeof roleAuditIdentityFromRequest>[0] & {
        user?: { id?: string } | null;
      };
    },
  ): Promise<boolean> {
    return this.usageLimitService.delete({
      workspaceId,
      usageLimitId,
      isOperator: true,
      auditIdentity: this.resolveOperatorAuditIdentity(
        workspaceId,
        actor,
        context,
      ),
    });
  }
}
