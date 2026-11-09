import { UseFilters, UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Parent, ResolveField } from '@nestjs/graphql';

import { PermissionFlagType } from 'twenty-shared/constants';
import { assertIsDefinedOrThrow, isDefined } from 'twenty-shared/utils';

import { ApplicationExceptionFilter } from 'src/engine/core-modules/application/application-exception-filter';
import { ApplicationVariableEntityExceptionFilter } from 'src/engine/core-modules/application/application-variable/application-variable-exception-filter';
import { ApplicationVariableEntity } from 'src/engine/core-modules/application/application-variable/application-variable.entity';
import { ApplicationVariableEntityService } from 'src/engine/core-modules/application/application-variable/application-variable.service';
import { ApplicationVariableEntityDTO } from 'src/engine/core-modules/application/application-variable/dtos/application-variable.dto';
import { UpdateApplicationVariableEntityInput } from 'src/engine/core-modules/application/application-variable/dtos/update-application-variable.input';
import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { resolveTargetApplicationOrThrow } from 'src/engine/core-modules/application/utils/resolve-target-application-or-throw.util';
import { roleAuditIdentityFromRequest } from 'src/engine/core-modules/crm-audit/role-update-audit';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthApplication } from 'src/engine/decorators/auth/auth-application.decorator';
import { AuthWorkspace } from 'src/engine/decorators/auth/auth-workspace.decorator';
import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
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
  SettingsPermissionGuard(PermissionFlagType.APPLICATIONS),
)
@MetadataResolver(() => ApplicationVariableEntityDTO)
@UseFilters(
  ApplicationVariableEntityExceptionFilter,
  ApplicationExceptionFilter,
  AuthGraphqlApiExceptionFilter,
)
export class ApplicationVariableEntityResolver {
  constructor(
    private readonly applicationVariableService: ApplicationVariableEntityService,
  ) {}

  @ResolveField(() => String)
  value(@Parent() applicationVariable: ApplicationVariableEntity): string {
    return this.applicationVariableService.getDisplayValue(applicationVariable);
  }

  @Mutation(() => Boolean)
  async updateOneApplicationVariable(
    @Args() { key, value, applicationId }: UpdateApplicationVariableEntityInput,
    @AuthWorkspace() { id: workspaceId }: WorkspaceEntity,
    @AuthApplication({ allowUndefined: true })
    callingApplication: FlatApplication | undefined,
    @Context()
    context?: {
      req?: Parameters<typeof roleAuditIdentityFromRequest>[0];
    },
  ) {
    const capturedKey = key;
    const capturedValue = value;
    const capturedApplicationId = applicationId;
    const capturedWorkspaceId = workspaceId;
    const capturedCallingApplication = callingApplication
      ? { ...callingApplication }
      : undefined;
    const auditIdentity = isDefined(context?.req)
      ? roleAuditIdentityFromRequest(context.req)
      : isDefined(capturedCallingApplication)
        ? {
            auth: {
              type: 'application' as const,
              workspace: { id: capturedWorkspaceId },
              application: { id: capturedCallingApplication.id },
            },
          }
        : undefined;

    const { targetApplicationId } = resolveTargetApplicationOrThrow({
      callingApplication: capturedCallingApplication,
      applicationId: capturedApplicationId,
    });

    // Without a universal identifier the lookup always carries an id
    assertIsDefinedOrThrow(targetApplicationId);

    await this.applicationVariableService.update({
      key: capturedKey,
      plainTextValue: capturedValue,
      applicationId: targetApplicationId,
      workspaceId: capturedWorkspaceId,
      callingApplicationId: capturedCallingApplication?.id,
      auditIdentity,
    });

    return true;
  }
}
