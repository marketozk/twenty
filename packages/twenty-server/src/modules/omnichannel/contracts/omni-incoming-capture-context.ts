import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  omniIncomingEnvelopeSchema,
  parseOmniIncomingEnvelope,
} from 'src/modules/omnichannel/contracts/omni-incoming-envelope';

const identifier = omniIncomingEnvelopeSchema.shape.providerMessageId;

export const omniIncomingCaptureContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    envelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.enum(['live', 'history_import', 'restore_replay']),
    qualification: z
      .strictObject({ adapterId: identifier, adapterVersion: identifier })
      .readonly(),
    nativeMessageKeyVersion:
      omniIncomingEnvelopeSchema.shape.nativeMessageKeyVersion,
    nativeMessageKey: identifier,
    sourceVariant: omniIncomingEnvelopeSchema.shape.sourceVariant,
    sourcePosition: omniIncomingEnvelopeSchema.shape.sourcePosition
      .unwrap()
      .readonly()
      .nullable(),
  })
  .readonly();

export type OmniIncomingCaptureContext = z.infer<
  typeof omniIncomingCaptureContextSchema
>;

// Validation is not authorization: only the trusted adapter/import boundary may supply this context.
export const snapshotOmniIncomingCaptureContext = (
  input: unknown,
  envelopeInput: unknown,
) => {
  const envelope = parseOmniIncomingEnvelope(envelopeInput);
  const parsed = omniIncomingCaptureContextSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error('OMNI_INVALID_CAPTURE_CONTEXT');
  }

  const context = parsed.data;

  if (
    context.envelopeHash !== auditPayloadHash(envelope) ||
    context.nativeMessageKeyVersion !== envelope.nativeMessageKeyVersion ||
    context.sourceVariant !== envelope.sourceVariant ||
    canonicalAuditJson(context.sourcePosition) !==
      canonicalAuditJson(envelope.sourcePosition)
  ) {
    throw new Error('OMNI_CAPTURE_ENVELOPE_MISMATCH');
  }

  return Object.freeze({
    context,
    canonicalJson: canonicalAuditJson(context),
    hash: auditPayloadHash(context),
  });
};
