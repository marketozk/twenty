import { z } from 'zod';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  omniIncomingEnvelopeSchema,
  parseOmniIncomingEnvelope,
} from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import jsonSchema from 'src/modules/omnichannel/contracts/omni-incoming-envelope-v1.schema.json';

import telegram from './fixtures/telegram-incoming-v1.json';
import max from './fixtures/max-incoming-v1.json';

describe('incoming message envelope v1', () => {
  it.each([telegram, max])(
    'preserves opaque provider IDs in synthetic fixtures',
    (fixture) => {
      expect(parseOmniIncomingEnvelope(fixture)).toEqual(fixture);
    },
  );

  it('keeps the portable JSON Schema synchronized with the runtime validator', () => {
    expect(jsonSchema).toEqual(z.toJSONSchema(omniIncomingEnvelopeSchema));
  });

  it.each([
    'workspaceId',
    'actor',
    'origin',
    'grants',
    'personId',
    'signature',
    'timestamp',
  ])('rejects external authority or transport field %s', (field) => {
    expect(() =>
      parseOmniIncomingEnvelope({ ...telegram, [field]: 'untrusted' }),
    ).toThrow();
    expect(() =>
      parseOmniIncomingEnvelope({
        ...telegram,
        payload: { ...telegram.payload, [field]: 'untrusted' },
      }),
    ).toThrow();
  });

  it.each([0, 1, '0', '-1', '01', '1.0', '1e3', '9223372036854775808'])(
    'rejects noncanonical or out-of-range generation %s',
    (routeGeneration) =>
      expect(() =>
        parseOmniIncomingEnvelope({ ...telegram, routeGeneration }),
      ).toThrow(),
  );

  it('accepts maximum PostgreSQL generation without numeric rounding', () => {
    expect(
      parseOmniIncomingEnvelope({
        ...telegram,
        routeGeneration: '9223372036854775807',
      }).routeGeneration,
    ).toBe('9223372036854775807');
  });

  it.each([
    { schemaVersion: 2 },
    { kind: 'command.receipt' },
    { nativeMessageKeyVersion: 2 },
    { providerMessageId: 42 },
    { sourceVariant: 'unknown' },
    { direction: 'admin' },
    { occurredAt: 'not-a-date' },
    { sourcePosition: { type: 'journal', value: 42 } },
    { sourcePosition: { type: 'journal', value: '1', origin: 'live' } },
    { payload: { ...telegram.payload, text: 'bad\u0000value' } },
  ])('rejects malformed input %#', (changes) => {
    expect(() =>
      parseOmniIncomingEnvelope({ ...telegram, ...changes }),
    ).toThrow();
  });

  it('enforces a UTF-8 byte limit after validation', () => {
    expect(() =>
      parseOmniIncomingEnvelope({
        ...telegram,
        payload: { ...telegram.payload, text: '界'.repeat(50000) },
      }),
    ).toThrow('OMNI_ENVELOPE_TOO_LARGE');
  });

  it.each(['\ud800', '\udfff'])('rejects malformed Unicode %#', (text) => {
    expect(() =>
      parseOmniIncomingEnvelope({
        ...telegram,
        payload: { ...telegram.payload, text },
      }),
    ).toThrow();
    expect(() =>
      parseOmniIncomingEnvelope({ ...telegram, eventId: text }),
    ).toThrow();
  });

  it('preserves valid supplementary Unicode', () => {
    expect(
      parseOmniIncomingEnvelope({
        ...telegram,
        payload: { ...telegram.payload, text: 'Добрый день 👋' },
      }).payload.text,
    ).toBe('Добрый день 👋');
  });

  it('measures identifier limits in Unicode code points', () => {
    expect(
      parseOmniIncomingEnvelope({ ...telegram, eventId: '👋'.repeat(512) })
        .eventId,
    ).toBe('👋'.repeat(512));
    expect(() =>
      parseOmniIncomingEnvelope({ ...telegram, eventId: '👋'.repeat(513) }),
    ).toThrow();
  });

  it('hashes reordered keys identically and snapshots nested values', () => {
    const input = structuredClone(telegram);
    const parsed = parseOmniIncomingEnvelope(input);
    input.payload.text = 'changed';
    expect(parsed.payload.text).toBe(telegram.payload.text);
    expect(auditPayloadHash(parsed)).toBe(
      auditPayloadHash(
        parseOmniIncomingEnvelope(
          Object.fromEntries(Object.entries(telegram).reverse()),
        ),
      ),
    );
  });

  it.each([
    { kind: 'message.edited' },
    { providerChatId: 'other-chat' },
    { routeGeneration: '2' },
    { sourceVariant: 'placeholder' },
    { direction: 'outgoing' },
    { occurredAt: '2026-10-27T10:00:01Z' },
    { payload: { ...telegram.payload, text: 'different text' } },
  ])('includes every semantic change in the hash %#', (changes) => {
    expect(
      auditPayloadHash(parseOmniIncomingEnvelope({ ...telegram, ...changes })),
    ).not.toBe(auditPayloadHash(parseOmniIncomingEnvelope(telegram)));
  });
});
