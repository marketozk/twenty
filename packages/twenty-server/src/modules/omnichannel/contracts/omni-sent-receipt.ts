import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  omniConnectorAcceptanceInputSchema,
  omniConnectorAcceptancePrincipalSchema,
  type OmniConnectorAcceptancePrincipal,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';

const acceptance = omniConnectorAcceptanceInputSchema.unwrap().shape;
const identifier = acceptance.providerChatId;
const uuid = acceptance.commandId;
const position = z
  .strictObject({ type: identifier, value: identifier })
  .readonly()
  .nullable();
export const OMNI_SENT_RECEIPT_MAX_BYTES = 128 * 1024;
export const omniSentReceiptPrincipalSchema =
  omniConnectorAcceptancePrincipalSchema;
export type OmniSentReceiptPrincipal = OmniConnectorAcceptancePrincipal;

// A separate internal qualified-outcome boundary; ordinary message ingress stays unchanged.
export const omniSentReceiptEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('command.sent'),
    eventId: identifier,
    accountBindingId: uuid,
    routeGeneration: acceptance.generation,
    commandId: uuid,
    providerChatId: identifier,
    payloadHash: acceptance.payloadHash,
    connectorJobId: acceptance.connectorJobId,
    journalSequence: acceptance.journalSequence,
    providerMessageId: identifier,
    direction: z.literal('outgoing'),
    sourceVariant: z.literal('complete'),
    nativeMessageKeyVersion: z.literal(1),
    occurredAt: z.iso
      .datetime({ offset: true })
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
      .nullable(),
    sourcePosition: position,
  })
  .readonly();
export const omniSentReceiptCaptureContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    origin: z.literal('connector_outcome'),
    envelopeHash: acceptance.payloadHash,
    qualification: acceptance.qualification,
    nativeMessageKey: identifier,
    nativeMessageKeyVersion: z.literal(1),
    sourceVariant: z.literal('complete'),
    sourcePosition: position,
  })
  .readonly();
export const omniSentReceiptInputSchema = z
  .strictObject({
    envelope: omniSentReceiptEnvelopeSchema,
    capture: omniSentReceiptCaptureContextSchema,
  })
  .readonly();
export const omniSentReceiptClaimInputSchema = z
  .strictObject({
    receiptId: uuid,
    leaseOwner: uuid,
    leaseMilliseconds: z.number().int().min(1000).max(300000),
  })
  .readonly();
export type OmniSentReceiptEnvelope = z.infer<
  typeof omniSentReceiptEnvelopeSchema
>;
export type OmniSentReceiptCaptureContext = z.infer<
  typeof omniSentReceiptCaptureContextSchema
>;
export type OmniSentReceiptInput = z.infer<typeof omniSentReceiptInputSchema>;
export type OmniSentReceiptClaimInput = z.infer<
  typeof omniSentReceiptClaimInputSchema
>;
export type OmniSentReceiptState =
  | 'accepted'
  | 'processing'
  | 'applied'
  | 'retryable_error'
  | 'blocked_config'
  | 'quarantined';
export type OmniSentReceiptAcceptance = Readonly<{
  receiptId: string;
  state: OmniSentReceiptState;
  created: boolean;
}>;
export type OmniSentReceiptClaimResult =
  | Readonly<{
      claimed: true;
      proof: Readonly<{
        receiptId: string;
        leaseOwner: string;
        leaseToken: string;
        leaseUntil: string;
        routeGeneration: string;
      }>;
      envelope: OmniSentReceiptEnvelope;
      capture: OmniSentReceiptCaptureContext;
    }>
  | Readonly<{
      claimed: false;
      reason: 'lease_live' | 'not_due' | 'applied' | 'not_claimable';
    }>;

export const parseOmniSentReceiptInput = (
  input: unknown,
): OmniSentReceiptInput => {
  const parsed = omniSentReceiptInputSchema.parse(input);
  if (
    Buffer.byteLength(canonicalAuditJson(parsed), 'utf8') >
    OMNI_SENT_RECEIPT_MAX_BYTES
  )
    throw new Error('OMNI_SENT_RECEIPT_TOO_LARGE');
  if (
    parsed.capture.envelopeHash !== auditPayloadHash(parsed.envelope) ||
    parsed.capture.nativeMessageKeyVersion !==
      parsed.envelope.nativeMessageKeyVersion ||
    parsed.capture.sourceVariant !== parsed.envelope.sourceVariant ||
    canonicalAuditJson(parsed.capture.sourcePosition) !==
      canonicalAuditJson(parsed.envelope.sourcePosition)
  )
    throw new Error('OMNI_SENT_RECEIPT_CAPTURE_MISMATCH');
  return parsed;
};
