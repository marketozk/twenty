import { ToolCategory } from 'twenty-shared/ai';
import { PermissionFlagType } from 'twenty-shared/constants';
import { z } from 'zod';

import { DefineTool } from 'src/engine/core-modules/tool-provider/decorators/define-tool.decorator';
import { BaseTool } from 'src/engine/core-modules/tool-provider/interfaces/base-tool.interface';
import { type ToolExecuteArgs } from 'src/engine/core-modules/tool-provider/types/tool-execute-args.type';
import { normalizeIconName } from 'src/engine/core-modules/tool-provider/utils/normalize-icon-name.util';
import { type ToolOutput } from 'src/engine/core-modules/tool/types/tool-output.type';
import { ObjectMetadataService } from 'src/engine/metadata-modules/object-metadata/object-metadata.service';
import { createObjectMetadataInputSchema } from 'src/engine/metadata-modules/object-metadata/tools/schemas/create-object-metadata-input.schema';

const createManyObjectMetadataInputSchema = z.object({
  objects: z
    .array(createObjectMetadataInputSchema)
    .min(1)
    .max(20)
    .describe('Objects to create (max 20).'),
});

@DefineTool({
  name: 'create_many_object_metadata',
  category: ToolCategory.METADATA,
  requiredPermissionFlags: [PermissionFlagType.DATA_MODEL],
  icon: 'IconSettings',
  description:
    'Create multiple objects at once. Batch version of create_object_metadata.',
})
export class CreateManyObjectMetadataTool extends BaseTool<
  typeof createManyObjectMetadataInputSchema
> {
  readonly inputSchema = createManyObjectMetadataInputSchema;

  constructor(private readonly objectMetadataService: ObjectMetadataService) {
    super();
  }

  async execute({
    input,
    context,
  }: ToolExecuteArgs<
    typeof createManyObjectMetadataInputSchema
  >): Promise<ToolOutput> {
    const { workspaceId } = context;
    const auditIdentity = context.authContext
      ? {
          auth: context.authContext,
          agentId: context.agentId,
        }
      : context.userId ||
          context.actorContext?.workspaceMemberId ||
          context.application ||
          context.agentId
        ? {
            user: context.userId ? { id: context.userId } : undefined,
            workspaceMemberId:
              context.actorContext?.workspaceMemberId ?? undefined,
            application: context.application
              ? { id: context.application.id }
              : undefined,
            agentId: context.agentId,
          }
        : undefined;

    for (const { icon, ...createObjectInput } of input.objects) {
      await this.objectMetadataService.createOneObject({
        createObjectInput: {
          ...createObjectInput,
          icon: normalizeIconName(icon),
        } as Parameters<
          typeof this.objectMetadataService.createOneObject
        >[0]['createObjectInput'],
        workspaceId,
        auditIdentity,
      });
    }

    return {
      success: true,
      message: `Created ${input.objects.length} object(s).`,
    };
  }
}
