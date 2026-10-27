import { z } from 'zod';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';

const uuid = z
  .uuid()
  .refine((value) => value.length === 36)
  .transform((value) => value.toLowerCase());
// JavaScript $ also matches before a final newline; persisted proof requires absolute end.
const isCounter = (value: string) =>
  /^(0|[1-9][0-9]{0,18})(?![\s\S])/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const counter = z.string().refine(isCounter);
const positive = counter.refine(
  (value) => isCounter(value) && BigInt(value) > 0n,
);
const identifier = z
  .string()
  .regex(/^[^\u0000-\u001f\u007f\uD800-\uDFFF]{1,512}(?![\s\S])/u);
const adapterIdentifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?![\s\S])/);
const qualificationObject = z.strictObject({
  adapterId: adapterIdentifier,
  adapterVersion: adapterIdentifier,
});
const qualification = qualificationObject.readonly();
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);

export const omniConnectorAcceptancePrincipalSchema = z
  .strictObject({
    workspaceId: uuid,
    bindingId: uuid,
    actor: z
      .strictObject({
        kind: z.literal('system'),
        id: identifier.max(256).refine((value) => value.trim() === value),
      })
      .readonly(),
  })
  .readonly();

// An internal adapter observation; this is not a transport signature or a public wire receipt.
export const omniConnectorAcceptanceInputSchema = z
  .strictObject({
    commandId: uuid,
    providerChatId: identifier,
    payloadHash: hash,
    generation: positive,
    connectorJobId: identifier,
    journalSequence: counter,
    qualification,
  })
  .readonly();
const proofObject = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceKind: z.literal('connector.durable_acceptance'),
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  commandId: uuid,
  providerChatId: identifier,
  payloadHash: hash,
  generation: positive,
  connectorJobId: identifier,
  journalSequence: counter,
  qualification,
});
export const omniConnectorAcceptanceProofSchema = proofObject.readonly();
export type OmniConnectorAcceptancePrincipal = z.infer<
  typeof omniConnectorAcceptancePrincipalSchema
>;
export type OmniConnectorAcceptanceInput = z.infer<
  typeof omniConnectorAcceptanceInputSchema
>;
export type OmniConnectorAcceptanceProof = z.infer<
  typeof omniConnectorAcceptanceProofSchema
>;
export type OmniConnectorAcceptanceResult = Readonly<{
  commandId: string;
  state: 'accepted' | 'outcome_unknown' | 'sent';
  statusRevision: string;
  applied: boolean;
}>;
export type OmniConnectorAcceptanceProofContext = Readonly<{
  workspaceId: string;
  bindingId: string;
  conversationId: string;
  commandId: string;
  providerChatId: string;
  payloadHash: string;
  generation: string;
  connectorJobId: string | null;
  journalSequence: string | null;
  state: string;
  payload: unknown;
}>;
const payloadScopeSchema = z.object({
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  providerChatId: identifier,
});
const proofStates = [
  'dispatching',
  'accepted',
  'outcome_unknown',
  'sent',
  'failed',
  'cancelled',
];

export const isOmniConnectorAcceptanceProof = (
  input: unknown,
  context: OmniConnectorAcceptanceProofContext,
): boolean => {
  const parsed = omniConnectorAcceptanceProofSchema.safeParse(input);
  const payload = payloadScopeSchema.safeParse(context.payload);
  if (
    !parsed.success ||
    !payload.success ||
    !proofStates.includes(context.state)
  )
    return false;
  const proof = parsed.data;
  if (canonicalAuditJson(proof) !== canonicalAuditJson(input)) return false;
  return (
    proof.workspaceId === context.workspaceId &&
    proof.bindingId === context.bindingId &&
    proof.conversationId === context.conversationId &&
    proof.commandId === context.commandId &&
    proof.providerChatId === context.providerChatId &&
    proof.payloadHash === context.payloadHash &&
    proof.generation === context.generation &&
    proof.connectorJobId === context.connectorJobId &&
    proof.journalSequence === context.journalSequence &&
    payload.data.workspaceId === context.workspaceId &&
    payload.data.bindingId === context.bindingId &&
    payload.data.conversationId === context.conversationId &&
    payload.data.providerChatId === context.providerChatId &&
    // Scope is normalized on write; uppercase or type-coerced JSON is not retained proof.
    canonicalAuditJson(payload.data) ===
      canonicalAuditJson({
        workspaceId: (context.payload as Record<string, unknown>).workspaceId,
        bindingId: (context.payload as Record<string, unknown>).bindingId,
        conversationId: (context.payload as Record<string, unknown>)
          .conversationId,
        providerChatId: (context.payload as Record<string, unknown>)
          .providerChatId,
      })
  );
};

const sqlKeys = (keys: string[]) =>
  `ARRAY[${keys.map((key) => `'${key}'`).join(',')}]::text[]`;
const proofKeys = sqlKeys(Object.keys(proofObject.shape));
const qualificationKeys = sqlKeys(Object.keys(qualificationObject.shape));

// Fixed command alias and bound $4/$5 scope; never interpolate caller identifiers or receipt values.
export const omniConnectorAcceptanceSqlPredicate = (): string => {
  const proof = 'command."connectorAcceptedEvidence"';
  const qualified = `${proof}->'qualification'`;
  const strings = [
    'workspaceId',
    'bindingId',
    'conversationId',
    'commandId',
    'providerChatId',
    'payloadHash',
    'generation',
    'connectorJobId',
    'journalSequence',
  ];
  const stringTypes = strings
    .map((field) => `jsonb_typeof(${proof}->'${field}')='string'`)
    .join(' AND ');
  const scopeTypes = [
    'workspaceId',
    'bindingId',
    'conversationId',
    'providerChatId',
  ]
    .map((field) => `jsonb_typeof(command.payload->'${field}')='string'`)
    .join(' AND ');
  return `COALESCE(CASE WHEN jsonb_typeof(${proof})='object' THEN
    command.state IN ('dispatching','accepted','outcome_unknown','sent','failed','cancelled')
    AND ${proof} ?& ${proofKeys} AND (${proof}-${proofKeys})='{}'::jsonb
    AND ${proof}->'schemaVersion'='1'::jsonb AND ${proof}->'evidenceKind'='"connector.durable_acceptance"'::jsonb
    AND ${stringTypes}
    AND ${proof}->>'workspaceId'=command."workspaceId"::text
    AND ${proof}->>'bindingId'=$4::text
    AND ${proof}->>'conversationId'=command."conversationId"::text
    AND ${proof}->>'commandId'=command.id::text
    AND ${proof}->>'providerChatId'=$5::text
    AND ${proof}->>'payloadHash'=command."payloadHash"
    AND ${proof}->>'generation'=command.generation::text
    AND ${proof}->>'connectorJobId'=command."connectorJobId"
    AND ${proof}->>'journalSequence'=command."journalSequence"::text
    AND command.generation>0 AND command."journalSequence">=0
    AND char_length(${proof}->>'providerChatId') BETWEEN 1 AND 512
    AND (${proof}->>'providerChatId') !~ '[\\u0001-\\u001f\\u007f]'
    AND char_length(${proof}->>'connectorJobId') BETWEEN 1 AND 512
    AND (${proof}->>'connectorJobId') !~ '[\\u0001-\\u001f\\u007f]'
    AND (${proof}->>'payloadHash') ~ '^[a-f0-9]{64}$'
    AND ${scopeTypes}
    AND command.payload->>'workspaceId'=command."workspaceId"::text
    AND command.payload->>'bindingId'=$4::text
    AND command.payload->>'conversationId'=command."conversationId"::text
    AND command.payload->>'providerChatId'=$5::text
    AND CASE WHEN jsonb_typeof(${qualified})='object' THEN
      (${qualified}) ?& ${qualificationKeys} AND ((${qualified})-${qualificationKeys})='{}'::jsonb
      AND jsonb_typeof((${qualified})->'adapterId')='string'
      AND jsonb_typeof((${qualified})->'adapterVersion')='string'
      AND (${qualified})->>'adapterId' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      AND (${qualified})->>'adapterVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    ELSE false END
  ELSE false END,false)`;
};
