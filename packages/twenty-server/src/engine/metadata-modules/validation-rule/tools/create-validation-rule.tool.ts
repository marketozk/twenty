/* @license Enterprise */

import { ToolCategory } from 'twenty-shared/ai';
import {
  PermissionFlagType,
  VALIDATION_RULE_EXPRESSION_SYNTAX_DESCRIPTION,
} from 'twenty-shared/constants';
import { FeatureFlagKey } from 'twenty-shared/types';
import { z } from 'zod';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { type ValidationRuleAuditIdentity } from 'src/engine/core-modules/crm-audit/validation-rule-audit';
import { DefineTool } from 'src/engine/core-modules/tool-provider/decorators/define-tool.decorator';
import { BaseTool } from 'src/engine/core-modules/tool-provider/interfaces/base-tool.interface';
import { type ToolExecuteArgs } from 'src/engine/core-modules/tool-provider/types/tool-execute-args.type';
import { type ToolOutput } from 'src/engine/core-modules/tool/types/tool-output.type';
import { MetadataToolIdentifierService } from 'src/engine/metadata-modules/object-metadata/tools/services/metadata-tool-identifier.service';
import { type ValidationRuleDTO } from 'src/engine/metadata-modules/validation-rule/dtos/validation-rule.dto';
import { VALIDATION_RULE_MESSAGE_DESCRIPTION } from 'src/engine/metadata-modules/validation-rule/tools/constants/validation-rule-message-description.constant';
import { VALIDATION_RULE_OBJECT_NAME_DESCRIPTION } from 'src/engine/metadata-modules/validation-rule/tools/constants/validation-rule-object-name-description.constant';
import { ValidationRuleService } from 'src/engine/metadata-modules/validation-rule/validation-rule.service';

const createValidationRuleInputSchema = z.object({
  objectName: z.string().describe(VALIDATION_RULE_OBJECT_NAME_DESCRIPTION),
  name: z.string().describe('Short rule name'),
  expression: z
    .string()
    .describe(VALIDATION_RULE_EXPRESSION_SYNTAX_DESCRIPTION),
  message: z.string().describe(VALIDATION_RULE_MESSAGE_DESCRIPTION),
  errorFieldMetadataId: z
    .uuid()
    .optional()
    .describe(
      'ID of the field the message is shown on. Omit to show it on the whole record.',
    ),
});

@DefineTool({
  name: 'create_validation_rule',
  category: ToolCategory.METADATA,
  requiredPermissionFlags: [PermissionFlagType.DATA_MODEL],
  requiredFeatureFlags: [FeatureFlagKey.IS_RECORD_CREATION_FORM_ENABLED],
  icon: 'IconSettings',
  description:
    'Create a validation rule on an object. An invalid expression is rejected with the reason. When the user is on a validation rule page (a settings path ending in /validation-rules/<id>), they mean that rule: update it with update_validation_rule instead of creating another one.',
})
export class CreateValidationRuleTool extends BaseTool<
  typeof createValidationRuleInputSchema
> {
  readonly inputSchema = createValidationRuleInputSchema;

  constructor(
    private readonly validationRuleService: ValidationRuleService,
    private readonly metadataToolIdentifierService: MetadataToolIdentifierService,
  ) {
    super();
  }

  async execute({
    input: { objectName, ...input },
    context: {
      workspaceId,
      application,
      agentId,
      authContext,
      userId,
      actorContext,
    },
  }: ToolExecuteArgs<typeof createValidationRuleInputSchema>): Promise<
    ToolOutput<ValidationRuleDTO>
  > {
    const ambientOperation =
      !authContext &&
      !userId &&
      !actorContext?.workspaceMemberId &&
      !application?.id &&
      !agentId
        ? captureCurrentCrmAuditOperation(workspaceId)
        : undefined;
    const auditIdentity: ValidationRuleAuditIdentity | undefined = authContext
      ? { auth: authContext, ...(agentId ? { agentId } : {}) }
      : userId || actorContext?.workspaceMemberId || application?.id || agentId
        ? {
            ...(userId ? { user: { id: userId } } : {}),
            ...(actorContext?.workspaceMemberId
              ? { workspaceMemberId: actorContext.workspaceMemberId }
              : {}),
            ...(application?.id
              ? { application: { id: application.id } }
              : {}),
            ...(agentId ? { agentId } : {}),
          }
        : ambientOperation
          ? {
              operation: ambientOperation.operation,
              ...(ambientOperation.impersonatorUserWorkspaceId
                ? {
                    impersonatorUserWorkspaceId:
                      ambientOperation.impersonatorUserWorkspaceId,
                  }
                : {}),
            }
          : undefined;

    const validationRule = await this.validationRuleService.create({
      input: {
        ...input,
        objectMetadataId:
          await this.metadataToolIdentifierService.getObjectMetadataIdOrThrow({
            workspaceId,
            objectName,
          }),
      },
      workspaceId,
      ...(auditIdentity ? { auditIdentity } : {}),
    });

    return {
      success: true,
      message: `Created the validation rule "${validationRule.name}".`,
      result: validationRule,
    };
  }
}
