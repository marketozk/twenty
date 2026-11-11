import { UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { Args, Context, Mutation, Query } from '@nestjs/graphql';

import { PermissionFlagType } from 'twenty-shared/constants';

import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import { type WorkspaceDomainAuditIdentity } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { CreateEmailingDomainInput } from 'src/engine/core-modules/emailing-domain/dtos/create-emailing-domain.input';
import { EmailingDomainDTO } from 'src/engine/core-modules/emailing-domain/dtos/emailing-domain.dto';
import { EmailGroupAccessGraphqlApiExceptionFilter } from 'src/engine/core-modules/emailing-domain/filters/email-group-access-graphql-api-exception.filter';
import { EmailingDomainGraphqlApiExceptionFilter } from 'src/engine/core-modules/emailing-domain/filters/emailing-domain-graphql-api-exception.filter';
import { EmailGroupAccessService } from 'src/engine/core-modules/emailing-domain/services/email-group-access.service';
import { EmailingDomainService } from 'src/engine/core-modules/emailing-domain/services/emailing-domain.service';
import { ResolverValidationPipe } from 'src/engine/core-modules/graphql/pipes/resolver-validation.pipe';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { SettingsPermissionGuard } from 'src/engine/guards/settings-permission.guard';
import { AuthPrincipalGuard } from 'src/engine/guards/auth-principal.guard';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';

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
  SettingsPermissionGuard(PermissionFlagType.WORKSPACE),
)
@UseFilters(
  EmailGroupAccessGraphqlApiExceptionFilter,
  EmailingDomainGraphqlApiExceptionFilter,
  AuthGraphqlApiExceptionFilter,
)
@UsePipes(ResolverValidationPipe)
@MetadataResolver(() => EmailingDomainDTO)
export class EmailingDomainResolver {
  constructor(
    private readonly emailingDomainService: EmailingDomainService,
    private readonly emailGroupAccessService: EmailGroupAccessService,
  ) {}

  @Mutation(() => EmailingDomainDTO)
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
  async createEmailingDomain(
    @Args('input') input: CreateEmailingDomainInput,
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
    @Context() context?: { req?: WorkspaceDomainAuditIdentity },
  ): Promise<EmailingDomainDTO> {
    this.emailGroupAccessService.validateEmailGroupAccessOrThrow();

    const emailingDomain =
      await this.emailingDomainService.createEmailingDomain(
        input.domain.trim().toLowerCase(),
        currentWorkspace.id,
        context !== undefined ? { auditIdentity: context.req } : undefined,
      );

    return emailingDomain;
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
  async deleteEmailingDomain(
    @Args('id') id: string,
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
    @Context() context?: { req?: WorkspaceDomainAuditIdentity },
  ): Promise<boolean> {
    this.emailGroupAccessService.validateEmailGroupAccessOrThrow();

    await this.emailingDomainService.deleteEmailingDomain(
      currentWorkspace,
      id,
      context !== undefined ? { auditIdentity: context.req } : undefined,
    );

    return true;
  }

  @Mutation(() => EmailingDomainDTO)
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
  async verifyEmailingDomain(
    @Args('id') id: string,
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
    @Context() context?: { req?: WorkspaceDomainAuditIdentity },
  ): Promise<EmailingDomainDTO> {
    this.emailGroupAccessService.validateEmailGroupAccessOrThrow();

    const emailingDomain =
      await this.emailingDomainService.verifyEmailingDomain({
        workspaceId: currentWorkspace.id,
        emailingDomainId: id,
        ...(context !== undefined ? { auditIdentity: context.req } : {}),
      });

    return emailingDomain;
  }

  @Query(() => [EmailingDomainDTO])
  async getEmailingDomains(
    @AuthWorkspace() currentWorkspace: WorkspaceEntity,
  ): Promise<EmailingDomainDTO[]> {
    this.emailGroupAccessService.validateEmailGroupAccessOrThrow();

    const emailingDomains =
      await this.emailingDomainService.getEmailingDomains(currentWorkspace);

    return emailingDomains;
  }
}
