import { z } from 'zod';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { omniConnectorAcceptanceInputSchema } from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import { omniHumanTextCommandPrincipalSchema } from 'src/modules/omnichannel/contracts/omni-human-text-command';

const fields = omniConnectorAcceptanceInputSchema.unwrap().shape;
const uuid = fields.commandId;
export const omniLocalCommandCancellationPrincipalSchema =
  omniHumanTextCommandPrincipalSchema;
export const omniLocalCommandCancellationInputSchema = z
  .strictObject({ commandId: uuid })
  .readonly();
const proofObject = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceKind: z.literal('command.local_cancel_before_enqueue'),
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  commandId: uuid,
  providerChatId: fields.providerChatId,
  payloadHash: fields.payloadHash,
  generation: fields.generation,
  createdRestoreIncarnation: uuid,
  authorMemberId: uuid,
  cancelledByMemberId: uuid,
  cancelledByUserId: uuid,
  cancelledAt: z.iso.datetime({ precision: 6 }),
});
export const omniLocalCommandCancellationProofSchema = proofObject.readonly();
export type OmniLocalCommandCancellationPrincipal = z.infer<
  typeof omniLocalCommandCancellationPrincipalSchema
>;
export type OmniLocalCommandCancellationInput = z.infer<
  typeof omniLocalCommandCancellationInputSchema
>;
export type OmniLocalCommandCancellationProof = z.infer<
  typeof omniLocalCommandCancellationProofSchema
>;
export type OmniLocalCommandCancellationResult = Readonly<
  | {
      cancelled: true;
      commandId: string;
      applied: boolean;
      state: 'cancelled';
      statusRevision: '2';
    }
  | {
      cancelled: false;
      commandId: string;
      reason:
        | 'terminal'
        | 'requires_reconciliation'
        | 'restore_reconciliation_required';
    }
>;
export type OmniLocalCommandCancellationProofContext = Readonly<{
  workspaceId: string;
  bindingId: string;
  conversationId: string;
  commandId: string;
  providerChatId: string;
  payloadHash: string;
  generation: string;
  createdRestoreIncarnation: string | null;
  actorKind: string;
  actorId: string;
  senderClass: string;
  contentProvenance: string;
  state: string;
  statusRevision: string;
  leaseToken: string | null;
  leaseUntil: string | null;
  connectorJobId: string | null;
  connectorAcceptedEvidence: unknown;
  journalSequence: string | null;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  payload: unknown;
}>;
const payloadScope = z.object({
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  providerChatId: fields.providerChatId,
});
export const isOmniLocalCommandCancellationProof = (
  input: unknown,
  context: OmniLocalCommandCancellationProofContext,
): boolean => {
  const parsed = omniLocalCommandCancellationProofSchema.safeParse(input);
  const payload = payloadScope.safeParse(context.payload);
  if (
    !parsed.success ||
    !payload.success ||
    canonicalAuditJson(parsed.data) !== canonicalAuditJson(input)
  )
    return false;
  const proof = parsed.data;
  return (
    context.state === 'cancelled' &&
    context.statusRevision === '2' &&
    context.actorKind === 'workspaceMember' &&
    context.senderClass === 'human' &&
    context.contentProvenance === 'human_direct' &&
    context.leaseToken === null &&
    context.leaseUntil === null &&
    context.connectorJobId === null &&
    context.connectorAcceptedEvidence === null &&
    context.journalSequence === null &&
    context.cancelReason === 'human_cancel_before_enqueue' &&
    context.cancelRequestedAt === proof.cancelledAt &&
    proof.workspaceId === context.workspaceId &&
    proof.bindingId === context.bindingId &&
    proof.conversationId === context.conversationId &&
    proof.commandId === context.commandId &&
    proof.providerChatId === context.providerChatId &&
    proof.payloadHash === context.payloadHash &&
    proof.generation === context.generation &&
    proof.createdRestoreIncarnation === context.createdRestoreIncarnation &&
    proof.authorMemberId === context.actorId &&
    canonicalAuditJson(payload.data) ===
      canonicalAuditJson({
        workspaceId: context.workspaceId,
        bindingId: context.bindingId,
        conversationId: context.conversationId,
        providerChatId: context.providerChatId,
      }) &&
    canonicalAuditJson(payload.data) ===
      canonicalAuditJson(
        Object.fromEntries(
          Object.keys(payloadScope.shape).map((key) => [
            key,
            (context.payload as Record<string, unknown>)[key],
          ]),
        ),
      )
  );
};

// Only the fixed command alias and bound conversation scope enter this predicate.
export const omniLocalCommandCancellationSqlPredicate = (): string => {
  const proof = 'command."cancelEvidence"';
  const keys = `ARRAY[${Object.keys(proofObject.shape)
    .map((key) => `'${key}'`)
    .join(',')}]::text[]`;
  const stringKeys = Object.keys(proofObject.shape).filter(
    (key) => !['schemaVersion', 'evidenceKind'].includes(key),
  );
  const stringTypes = stringKeys
    .map((key) => `jsonb_typeof(${proof}->'${key}')='string'`)
    .join(' AND ');
  const actorUuids = [
    'workspaceId',
    'bindingId',
    'conversationId',
    'commandId',
    'createdRestoreIncarnation',
    'authorMemberId',
    'cancelledByMemberId',
    'cancelledByUserId',
  ]
    .map(
      (key) =>
        `(${proof}->>'${key}') ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'`,
    )
    .join(' AND ');
  const scopeTypes = Object.keys(payloadScope.shape)
    .map((key) => `jsonb_typeof(command.payload->'${key}')='string'`)
    .join(' AND ');
  return `COALESCE(CASE WHEN jsonb_typeof(${proof})='object' THEN
    command.state='cancelled' AND command."statusRevision"=2
    AND command."actorKind"='workspaceMember' AND command."senderClass"='human' AND command."contentProvenance"='human_direct'
    AND command."leaseToken" IS NULL AND command."leaseUntil" IS NULL AND command."connectorJobId" IS NULL
    AND command."connectorAcceptedEvidence" IS NULL AND command."journalSequence" IS NULL
    AND command."cancelReason"='human_cancel_before_enqueue'
    AND ${proof} ?& ${keys} AND (${proof}-${keys})='{}'::jsonb
    AND ${proof}->'schemaVersion'='1'::jsonb AND ${proof}->'evidenceKind'='"command.local_cancel_before_enqueue"'::jsonb
    AND ${stringTypes} AND ${actorUuids}
    AND ${proof}->>'workspaceId'=command."workspaceId"::text AND ${proof}->>'bindingId'=$4::text
    AND ${proof}->>'conversationId'=command."conversationId"::text AND ${proof}->>'commandId'=command.id::text
    AND ${proof}->>'providerChatId'=$5::text AND ${proof}->>'payloadHash'=command."payloadHash"
    AND ${proof}->>'generation'=command.generation::text AND command.generation>0
    AND ${proof}->>'createdRestoreIncarnation'=command."createdRestoreIncarnation"::text
    AND ${proof}->>'authorMemberId'=command."actorId"
    AND ${proof}->>'cancelledAt'=to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    AND (${proof}->>'cancelledAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    AND char_length(${proof}->>'providerChatId') BETWEEN 1 AND 512
    AND (${proof}->>'providerChatId') !~ '[\\u0001-\\u001f\\u007f]'
    AND (${proof}->>'payloadHash') ~ '^[a-f0-9]{64}$'
    AND ${scopeTypes}
    AND command.payload->>'workspaceId'=command."workspaceId"::text AND command.payload->>'bindingId'=$4::text
    AND command.payload->>'conversationId'=command."conversationId"::text AND command.payload->>'providerChatId'=$5::text
  ELSE false END,false)`;
};
