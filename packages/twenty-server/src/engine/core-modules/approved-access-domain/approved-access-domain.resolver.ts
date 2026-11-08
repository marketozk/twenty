import { UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { Args, Mutation, Query } from '@nestjs/graphql';

import { PermissionFlagType } from 'twenty-shared/constants';

import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import { ApprovedAccessDomainExceptionFilter } from 'src/engine/core-modules/approved-access-domain/approved-access-domain-exception-filter';
import { ApprovedAccessDomainDTO } from 'src/engine/core-modules/approved-access-domain/dtos/approved-access-domain.dto';
import { CreateApprovedAccessDomainInput } from 'src/engine/core-modules/approved-access-domain/dtos/create-approved-access.domain.input';
import { DeleteApprovedAccessDomainInput } from 'src/engine/core-modules/approved-access-domain/dtos/delete-approved-access-domain.input';
import { ValidateApprovedAccessDomainInput } from 'src/engine/core-modules/approved-access-domain/dtos/validate-approved-access-domain.input';
import { ApprovedAccessDomainService } from 'src/engine/core-modules/approved-access-domain/services/approved-access-domain.service';
import { type AuthContextUser } from 'src/engine/core-modules/auth/types/auth-context.type';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { captureWorkspaceDomainAudit } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { PreventNestToAutoLogGraphqlErrorsFilter } from 'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter';
import { ResolverValidationPipe } from 'src/engine/core-modules/graphql/pipes/resolver-validation.pipe';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthApiKey } from 'src/engine/decorators/auth/auth-api-key.decorator';
import { AuthApplication } from 'src/engine/decorators/auth/auth-application.decorator';
import { AuthImpersonationContext } from 'src/engine/decorators/auth/auth-impersonation-context.decorator';
import { AuthUser } from 'src/engine/decorators/auth/auth-user.decorator';
import { AuthUserWorkspaceId } from 'src/engine/decorators/auth/auth-user-workspace-id.decorator';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

@UseGuards(
  AuthPrincipalGuard({
    userSession: {
      standard: true,
      impersonated: true,
      playground: true,
      workspaceAgnostic: false,
    },
    apiKey: true,
    oauthClient: true,
    application: true,
  }),
  SettingsPermissionGuard(PermissionFlagType.WORKSPACE_MEMBERS),
)
@UsePipes(ResolverValidationPipe)
@UseFilters(
  ApprovedAccessDomainExceptionFilter,
  PreventNestToAutoLogGraphqlErrorsFilter,
  AuthGraphqlApiExceptionFilter,
)
@MetadataResolver()
export class ApprovedAccessDomainResolver {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly approvedAccessDomainService: ApprovedAccessDomainService,
  ) {}

  @Mutation(() => ApprovedAccessDomainDTO)
  @UseGuards(
    AuthPrincipalGuard({
      userSession: {
        standard: true,
        impersonated: true,
        playground: true,
        workspaceAgnostic: false,
      },
      apiKey: true,
      oauthClient: true,
      application: false,
    }),
  )
  async createApprovedAccessDomain(
    @Args('input') { domain, email }: CreateApprovedAccessDomainInput,
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
    @AuthUser() currentUser: AuthContextUser,
    @AuthUserWorkspaceId({ allowUndefined: true })
    userWorkspaceId?: string,
    @AuthApiKey() apiKey?: { id: string },
    @AuthApplication() application?: { id: string },
    @AuthImpersonationContext()
    impersonationContext?: { impersonatorUserWorkspaceId?: string },
  ): Promise<ApprovedAccessDomainDTO> {
    if (!currentUser?.id) {
      throw new Error(
        'Approved access domain creation requires authenticated user',
      );
    }
    const auditRequest = captureWorkspaceDomainAudit({
      workspaceId: currentWorkspace.id,
      auditIdentity: {
        workspace: currentWorkspace,
        user: currentUser,
        userWorkspaceId,
        apiKey,
        application,
        impersonationContext,
      },
    });
    const authContext = buildSystemAuthContext(currentWorkspace.id);

    const workspaceMember =
      await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
        const workspaceMemberRepository =
          this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        return workspaceMemberRepository.findOneOrFail({
          where: {
            userId: currentUser.id,
          },
        });
      }, authContext);

    return this.approvedAccessDomainService.createApprovedAccessDomain(
      domain,
      currentWorkspace,
      workspaceMember,
      email,
      { auditIdentity: auditRequest },
    );
  }

  @Mutation(() => Boolean)
  @UseGuards(
    AuthPrincipalGuard({
      userSession: {
        standard: true,
        impersonated: true,
        playground: true,
        workspaceAgnostic: false,
      },
      apiKey: true,
      oauthClient: true,
      application: false,
    }),
  )
  async deleteApprovedAccessDomain(
    @Args('input') { id }: DeleteApprovedAccessDomainInput,
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
    @AuthUser({ allowUndefined: true }) currentUser?: AuthContextUser,
    @AuthUserWorkspaceId({ allowUndefined: true })
    userWorkspaceId?: string,
    @AuthApiKey() apiKey?: { id: string },
    @AuthApplication() application?: { id: string },
    @AuthImpersonationContext()
    impersonationContext?: { impersonatorUserWorkspaceId?: string },
  ): Promise<boolean> {
    const auditRequest = captureWorkspaceDomainAudit({
      workspaceId: currentWorkspace.id,
      auditIdentity: {
        workspace: currentWorkspace,
        user: currentUser,
        userWorkspaceId,
        apiKey,
        application,
        impersonationContext,
      },
    });

    await this.approvedAccessDomainService.deleteApprovedAccessDomain(
      currentWorkspace,
      id,
      { auditIdentity: auditRequest },
    );

    return true;
  }

  @Mutation(() => ApprovedAccessDomainDTO)
  @UseGuards(
    AuthPrincipalGuard({
      userSession: {
        standard: true,
        impersonated: true,
        playground: true,
        workspaceAgnostic: false,
      },
      apiKey: true,
      oauthClient: true,
      application: false,
    }),
  )
  async validateApprovedAccessDomain(
    @Args('input')
    {
      validationToken,
      approvedAccessDomainId,
    }: ValidateApprovedAccessDomainInput,
    @AuthWorkspace() currentWorkspace?: WorkspaceEntity,
    @AuthUser({ allowUndefined: true }) currentUser?: AuthContextUser,
    @AuthUserWorkspaceId({ allowUndefined: true })
    userWorkspaceId?: string,
    @AuthApiKey() apiKey?: { id: string },
    @AuthApplication() application?: { id: string },
    @AuthImpersonationContext()
    impersonationContext?: { impersonatorUserWorkspaceId?: string },
  ): Promise<ApprovedAccessDomainDTO> {
    const auditRequest = captureWorkspaceDomainAudit({
      workspaceId: currentWorkspace?.id,
      auditIdentity: {
        workspace: currentWorkspace,
        user: currentUser,
        userWorkspaceId,
        apiKey,
        application,
        impersonationContext,
      },
    });

    return await this.approvedAccessDomainService.validateApprovedAccessDomain(
      {
        validationToken,
        approvedAccessDomainId,
        workspaceId: currentWorkspace?.id ?? auditRequest.workspaceId,
      },
      { auditIdentity: auditRequest },
    );
  }

  @Query(() => [ApprovedAccessDomainDTO])
  async getApprovedAccessDomains(
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
  ): Promise<Array<ApprovedAccessDomainDTO>> {
    return await this.approvedAccessDomainService.getApprovedAccessDomains(
      currentWorkspace,
    );
  }
}
