import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { parseOmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import {
  OMNI_SENT_RECEIPT_MAX_BYTES,
  parseOmniSentReceiptInput,
} from 'src/modules/omnichannel/contracts/omni-sent-receipt';

const envelope = {
  schemaVersion: 1,
  kind: 'command.sent',
  eventId: 'event-1',
  accountBindingId: '11111111-1111-4111-8111-111111111111',
  routeGeneration: '1',
  commandId: '22222222-2222-4222-8222-222222222222',
  providerChatId: 'chat-1',
  payloadHash: 'a'.repeat(64),
  connectorJobId: 'job-1',
  journalSequence: '0',
  providerMessageId: 'message-1',
  direction: 'outgoing',
  sourceVariant: 'complete',
  nativeMessageKeyVersion: 1,
  occurredAt: null,
  sourcePosition: { type: 'journal', value: '0' },
};
const capture = {
  schemaVersion: 1,
  origin: 'connector_outcome',
  envelopeHash: auditPayloadHash(envelope),
  qualification: { adapterId: 'synthetic', adapterVersion: 'v1' },
  nativeMessageKey: 'native-1',
  nativeMessageKeyVersion: 1,
  sourceVariant: 'complete',
  sourcePosition: { type: 'journal', value: '0' },
};
const input = { envelope, capture };

describe('closed sent receipt contract', () => {
  it('preserves the ordinary message ingress rejection of command.sent', () => {
    expect(() => parseOmniIncomingEnvelope(envelope)).toThrow(
      'OMNI_INVALID_ENVELOPE',
    );
    expect(parseOmniSentReceiptInput(input).envelope.kind).toBe('command.sent');
  });

  it.each([
    { ...input, unknown: true },
    { ...input, envelope: { ...envelope, unknown: true } },
    { ...input, capture: { ...capture, unknown: true } },
    {
      ...input,
      capture: {
        ...capture,
        qualification: { ...capture.qualification, verified: true },
      },
    },
    {
      ...input,
      envelope: {
        ...envelope,
        sourcePosition: { ...envelope.sourcePosition, unknown: true },
      },
    },
    {
      ...input,
      capture: {
        ...capture,
        sourcePosition: { ...capture.sourcePosition, unknown: true },
      },
    },
  ])('rejects extra fields at every boundary', (value) => {
    expect(() => parseOmniSentReceiptInput(value)).toThrow();
  });

  it.each([
    { kind: 'message.received' },
    { direction: 'incoming' },
    { sourceVariant: 'placeholder' },
    { nativeMessageKeyVersion: 2 },
    { journalSequence: '-1' },
    { journalSequence: 'garbage' },
    { routeGeneration: '0' },
    { routeGeneration: '1\n' },
    { providerMessageId: 'message\n' },
    { providerChatId: 'chat\ud800' },
    { occurredAt: '2026-10-27T12:00:00Z\n' },
  ])('rejects unsupported or malformed envelope fields', (patch) => {
    const changed = { ...envelope, ...patch };
    expect(() =>
      parseOmniSentReceiptInput({
        envelope: changed,
        capture: { ...capture, envelopeHash: auditPayloadHash(changed) },
      }),
    ).toThrow();
  });

  it('rejects mismatched envelope hashes and source positions', () => {
    expect(() =>
      parseOmniSentReceiptInput({
        ...input,
        capture: { ...capture, envelopeHash: 'b'.repeat(64) },
      }),
    ).toThrow('OMNI_SENT_RECEIPT_CAPTURE_MISMATCH');
    expect(() =>
      parseOmniSentReceiptInput({
        ...input,
        capture: {
          ...capture,
          sourcePosition: { type: 'journal', value: '1' },
        },
      }),
    ).toThrow('OMNI_SENT_RECEIPT_CAPTURE_MISMATCH');
  });

  it('accepts explicit null positions and occurrence time', () => {
    const changed = { ...envelope, sourcePosition: null };
    const parsed = parseOmniSentReceiptInput({
      envelope: changed,
      capture: {
        ...capture,
        envelopeHash: auditPayloadHash(changed),
        sourcePosition: null,
      },
    });
    expect(parsed.envelope.occurredAt).toBeNull();
    expect(parsed.capture.sourcePosition).toBeNull();
  });

  it('rejects oversized input without relaxing the smaller closed field limits', () => {
    expect(OMNI_SENT_RECEIPT_MAX_BYTES).toBe(128 * 1024);
    expect(() =>
      parseOmniSentReceiptInput({
        ...input,
        envelope: {
          ...envelope,
          eventId: 'x'.repeat(OMNI_SENT_RECEIPT_MAX_BYTES + 1),
        },
      }),
    ).toThrow();
  });

  it('detaches and freezes every nested object before authorization', () => {
    const mutable = {
      envelope: { ...envelope, sourcePosition: { ...envelope.sourcePosition } },
      capture: {
        ...capture,
        qualification: { ...capture.qualification },
        sourcePosition: { ...capture.sourcePosition },
      },
    };
    const parsed = parseOmniSentReceiptInput(mutable);
    mutable.envelope.sourcePosition.value = 'changed';
    mutable.capture.qualification.adapterId = 'changed';
    mutable.capture.sourcePosition.value = 'changed';
    expect(parsed.envelope.sourcePosition?.value).toBe('0');
    expect(parsed.capture.qualification.adapterId).toBe('synthetic');
    expect(parsed.capture.sourcePosition?.value).toBe('0');
    for (const value of [
      parsed,
      parsed.envelope,
      parsed.capture,
      parsed.envelope.sourcePosition,
      parsed.capture.sourcePosition,
      parsed.capture.qualification,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
});
