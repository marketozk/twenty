import { z } from 'zod';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';
import { verifyOmniConversationTargetHistory } from 'src/modules/omnichannel/services/verify-omni-conversation-target-history';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const targetSchema = z.strictObject({ id: uuid, revision }).readonly();
const manifestSchema = z
  .strictObject({
    workspaceId: uuid,
    objectMetadataId: uuid,
    recordId: uuid,
    name: z.enum(['person', 'company']),
    retainedTargets: z
      .array(targetSchema)
      .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
      .transform((rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id)))
      .readonly(),
  })
  .readonly();
export type OmniDetachedParentManifest = z.infer<typeof manifestSchema>;
export const snapshotOmniDetachedParentManifest = (
  input: OmniDetachedParentManifest,
) => manifestSchema.parse(input);
const fail = (): never => {
  throw new Error('OMNI_PARENT_NOT_DETACHED');
};
const one = <T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T> => {
  if (rows.length !== 1) return fail();
  return schema.parse(rows[0]);
};

// Retained tombstones stay in place. Only their proven inactive state can be exempted.
export const verifyOmniDetachedParent = async (
  scope: OmniNativeOwnershipQuery,
  input: OmniDetachedParentManifest,
): Promise<void> => {
  const manifest = snapshotOmniDetachedParentManifest(input);
  const { workspaceId, objectMetadataId, recordId, name } = manifest;
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const state = one(
    z.object({ id: uuid, epoch: revision }),
    await scope.executeRawQuery(
      'SELECT id,epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  const targets = z
    .array(
      z.object({
        id: uuid,
        revision,
        conversationId: uuid,
        objectMetadataId: uuid,
        recordId: uuid,
        active: z.literal(false),
        projectionId: z.null(),
        bindingId: uuid,
        messageThreadId: uuid,
      }),
    )
    .parse(
      await scope.executeRawQuery(
        `SELECT target.id,target.revision,target."conversationId",target."objectMetadataId",target."recordId",target.active,target."projectionId",conversation."bindingId",conversation."messageThreadId"
      FROM core."omniConversationTarget" target LEFT JOIN core."omniConversation" conversation
      ON conversation."workspaceId"=target."workspaceId" AND conversation.id=target."conversationId"
      WHERE target."workspaceId"=$1 AND target."objectMetadataId"=$2 AND target."recordId"=$3 ORDER BY target.id`,
        [workspaceId, objectMetadataId, recordId],
      ),
    );
  if (
    auditPayloadHash(targets.map(({ id, revision }) => ({ id, revision }))) !==
    auditPayloadHash(manifest.retainedTargets)
  )
    return fail();
  const projectionField =
    name === 'person' ? 'targetPersonId' : 'targetCompanyId';
  for (const { bindingId, messageThreadId, ...edge } of targets)
    await verifyOmniConversationTargetHistory(scope, {
      workspaceId,
      bindingId,
      messageThreadId,
      policyState: state,
      edge,
      projectionField,
    });
  if (name === 'person') {
    if (
      (
        await scope.executeRawQuery(
          'SELECT id FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "personId"=$2 LIMIT 1',
          [workspaceId, recordId],
        )
      ).length
    )
      return fail();
    const participants = z
      .array(z.object({ messageId: uuid }))
      .parse(
        await scope.executeRawQuery(
          `SELECT "messageId" FROM "${schema}"."messageParticipant" WHERE "personId"=$1 AND "messageId" IS NOT NULL`,
          [recordId],
        ),
      );
    if (
      (
        await findOmniOwnedMessageIds(
          scope,
          workspaceId,
          participants.map((row) => row.messageId),
        )
      ).size
    )
      return fail();
  }
  const projections = z
    .array(z.object({ messageThreadId: uuid }))
    .parse(
      await scope.executeRawQuery(
        `SELECT "messageThreadId" FROM "${schema}"."messageThreadTarget" WHERE "${projectionField}"=$1 AND "messageThreadId" IS NOT NULL`,
        [recordId],
      ),
    );
  if (
    (
      await findOmniOwnedMessageThreadIds(
        scope,
        workspaceId,
        projections.map((row) => row.messageThreadId),
      )
    ).size
  )
    return fail();
};
