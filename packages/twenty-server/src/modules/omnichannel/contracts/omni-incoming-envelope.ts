import { z } from 'zod';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';

export const OMNI_INCOMING_MAX_BYTES = 128 * 1024;

// PostgreSQL jsonb rejects lone UTF-16 surrogates even in escaped JSON strings.
const unicodeText = z.string().regex(/^[^\uD800-\uDFFF]*$/u);
const identifier = unicodeText.regex(/^[^\u0000-\u001f\u007f]{1,512}$/u);
const nullableText = unicodeText.regex(/^[^\u0000]{0,65536}$/u).nullable();

export const omniIncomingEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: identifier,
  accountBindingId: z.uuid(),
  routeGeneration: z
    .string()
    .regex(
      /^(?:[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6]|9223372036854775807)$/,
    ),
  kind: z.enum(['message.received', 'message.edited', 'message.deleted']),
  providerChatId: identifier,
  providerMessageId: identifier,
  direction: z.enum(['incoming', 'outgoing']),
  sourceVariant: z.enum(['complete', 'placeholder']),
  nativeMessageKeyVersion: z.literal(1),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  sourcePosition: z
    .strictObject({ type: identifier, value: identifier })
    .nullable(),
  payload: z.strictObject({
    text: nullableText,
    sourceAuthorId: identifier.nullable(),
    sourceDisplayName: identifier.nullable(),
  }),
});

export type OmniIncomingEnvelope = z.infer<typeof omniIncomingEnvelopeSchema>;

// Internal boundary: the HTTP adapter must also limit the raw body before parsing.
export const parseOmniIncomingEnvelope = (
  input: unknown,
): OmniIncomingEnvelope => {
  const parsed = omniIncomingEnvelopeSchema.safeParse(input);

  if (!parsed.success) throw new Error('OMNI_INVALID_ENVELOPE');

  const envelope = parsed.data;

  if (BigInt(envelope.routeGeneration) > 9223372036854775807n) {
    throw new Error('OMNI_INVALID_GENERATION');
  }

  envelope.accountBindingId = envelope.accountBindingId.toLowerCase();

  if (
    Buffer.byteLength(canonicalAuditJson(envelope), 'utf8') >
    OMNI_INCOMING_MAX_BYTES
  ) {
    throw new Error('OMNI_ENVELOPE_TOO_LARGE');
  }

  return envelope;
};
