import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { snapshotOmniIncomingCaptureContext } from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import { parseOmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';

import telegram from './fixtures/telegram-incoming-v1.json';

const fixture = () => {
  const envelope = parseOmniIncomingEnvelope(structuredClone(telegram));
  const context = {
    schemaVersion: 1,
    envelopeHash: auditPayloadHash(envelope),
    origin: 'live',
    qualification: {
      adapterId: 'synthetic-telegram-contract-fixture',
      adapterVersion: 'fixture-v1',
    },
    nativeMessageKeyVersion: 1,
    nativeMessageKey: `fixture:v1:incoming:${envelope.providerMessageId}`,
    sourceVariant: envelope.sourceVariant,
    sourcePosition: envelope.sourcePosition
      ? { ...envelope.sourcePosition }
      : null,
  };

  return { envelope, context };
};

describe('incoming capture context internal contract', () => {
  it.each(['live', 'history_import', 'restore_replay'])(
    'snapshots the explicit server-selected %s origin',
    (origin) => {
      const { envelope, context } = fixture();
      context.origin = origin;
      const snapshot = snapshotOmniIncomingCaptureContext(context, envelope);

      expect(snapshot.context).toEqual(context);
      expect(snapshot.canonicalJson).toBe(canonicalAuditJson(context));
      expect(snapshot.hash).toBe(auditPayloadHash(context));
      expect(snapshot.context).not.toBe(context);
      expect(snapshot.context.qualification).not.toBe(context.qualification);
    },
  );

  it('freezes every nested object that can influence the snapshot hash', () => {
    const { envelope, context } = fixture();
    const snapshot = snapshotOmniIncomingCaptureContext(context, envelope);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.context)).toBe(true);
    expect(Object.isFrozen(snapshot.context.qualification)).toBe(true);
    expect(Object.isFrozen(snapshot.context.sourcePosition)).toBe(true);
    expect(Reflect.set(snapshot.context, 'origin', 'history_import')).toBe(
      false,
    );
    expect(
      Reflect.set(snapshot.context.qualification, 'adapterVersion', 'changed'),
    ).toBe(false);
    expect(snapshot.hash).toBe(auditPayloadHash(snapshot.context));
  });

  it('is unaffected by caller mutation after the first async boundary', async () => {
    const { envelope, context } = fixture();
    const snapshot = snapshotOmniIncomingCaptureContext(context, envelope);
    const expectedJson = snapshot.canonicalJson;
    const expectedHash = snapshot.hash;

    await Promise.resolve();
    context.origin = 'history_import';
    context.nativeMessageKey = 'changed-key';
    context.qualification.adapterVersion = 'changed-version';
    if (context.sourcePosition)
      context.sourcePosition.value = 'changed-position';
    envelope.payload.text = 'changed-private-text';
    envelope.direction = 'outgoing';
    if (envelope.sourcePosition)
      envelope.sourcePosition.value = 'another-position';

    expect(snapshot.canonicalJson).toBe(expectedJson);
    expect(snapshot.hash).toBe(expectedHash);
    expect(canonicalAuditJson(snapshot.context)).toBe(expectedJson);
    expect(auditPayloadHash(snapshot.context)).toBe(expectedHash);
  });

  it('normalizes object key order without changing capture identity', () => {
    const { envelope, context } = fixture();
    const reordered = Object.fromEntries(Object.entries(context).reverse());
    reordered.qualification = {
      adapterVersion: context.qualification.adapterVersion,
      adapterId: context.qualification.adapterId,
    };

    expect(snapshotOmniIncomingCaptureContext(reordered, envelope)).toEqual(
      snapshotOmniIncomingCaptureContext(context, envelope),
    );
  });

  it.each([
    ['origin', 'history_import'],
    ['nativeMessageKey', 'fixture:v1:another-key'],
  ])('captures %s in its own hash', (field, value) => {
    const { envelope, context } = fixture();

    expect(
      snapshotOmniIncomingCaptureContext(
        { ...context, [field]: value },
        envelope,
      ).hash,
    ).not.toBe(snapshotOmniIncomingCaptureContext(context, envelope).hash);
  });

  it('captures the exact qualification version in its own hash', () => {
    const { envelope, context } = fixture();
    const changed = {
      ...context,
      qualification: { ...context.qualification, adapterVersion: 'fixture-v2' },
    };

    expect(snapshotOmniIncomingCaptureContext(changed, envelope).hash).not.toBe(
      snapshotOmniIncomingCaptureContext(context, envelope).hash,
    );
  });

  it.each([
    ['direction', 'outgoing'],
    ['providerChatId', 'different-chat'],
    ['providerMessageId', 'different-native-id'],
    ['accountBindingId', '995e610b-a136-47d9-95f4-390bfcc9055b'],
    ['routeGeneration', '2'],
    ['eventId', 'different-event'],
    ['kind', 'message.edited'],
    ['sourceVariant', 'placeholder'],
  ])(
    'rejects a capture applied to an envelope with a different %s',
    (field, value) => {
      const { envelope, context } = fixture();

      expect(() =>
        snapshotOmniIncomingCaptureContext(context, {
          ...envelope,
          [field]: value,
        }),
      ).toThrow('OMNI_CAPTURE_ENVELOPE_MISMATCH');
    },
  );

  it('binds private content without copying it into capture metadata', () => {
    const { envelope, context } = fixture();
    const changed = {
      ...envelope,
      payload: { ...envelope.payload, text: 'changed-private-body' },
    };

    expect(() => snapshotOmniIncomingCaptureContext(context, changed)).toThrow(
      'OMNI_CAPTURE_ENVELOPE_MISMATCH',
    );
    const snapshot = snapshotOmniIncomingCaptureContext(context, envelope);
    expect(snapshot.context).not.toHaveProperty('payload');
    expect(snapshot.context).not.toHaveProperty('text');
  });

  it('checks qualified completeness even when envelopeHash is current', () => {
    const { envelope, context } = fixture();
    const changed = { ...envelope, sourceVariant: 'placeholder' };

    expect(() =>
      snapshotOmniIncomingCaptureContext(
        { ...context, envelopeHash: auditPayloadHash(changed) },
        changed,
      ),
    ).toThrow('OMNI_CAPTURE_ENVELOPE_MISMATCH');
  });

  it.each([
    null,
    { type: 'different-ordering', value: '1' },
    { type: 'journal', value: '900719925474099399999' },
  ])('checks qualified opaque source position %j', (position) => {
    const { envelope, context } = fixture();
    const changed = { ...envelope, sourcePosition: position };

    expect(() =>
      snapshotOmniIncomingCaptureContext(
        { ...context, envelopeHash: auditPayloadHash(changed) },
        changed,
      ),
    ).toThrow('OMNI_CAPTURE_ENVELOPE_MISMATCH');
  });

  it('preserves unknown ordering as null without inventing a sequence', () => {
    const { envelope, context } = fixture();
    envelope.sourcePosition = null;
    context.sourcePosition = null;
    context.envelopeHash = auditPayloadHash(envelope);

    expect(
      snapshotOmniIncomingCaptureContext(context, envelope).context
        .sourcePosition,
    ).toBeNull();
  });

  it.each([
    { schemaVersion: 2 },
    { origin: 'import' },
    { origin: 'external_human' },
    { nativeMessageKeyVersion: 2 },
    { nativeMessageKeyVersion: '1' },
    { nativeMessageKey: '' },
    { nativeMessageKey: 9007199254740992 },
    { nativeMessageKey: 'x'.repeat(513) },
    { nativeMessageKey: '\ud800' },
    { nativeMessageKey: 'raw\u0000id' },
    { envelopeHash: 'f'.repeat(63) },
    { envelopeHash: 'F'.repeat(64) },
    { qualification: { adapterId: '', adapterVersion: 'v1' } },
    { qualification: { adapterId: 'fixture', adapterVersion: 1 } },
    { sourceVariant: 'verified_complete' },
  ])('rejects invalid context %j', (change) => {
    const { envelope, context } = fixture();

    expect(() =>
      snapshotOmniIncomingCaptureContext({ ...context, ...change }, envelope),
    ).toThrow('OMNI_INVALID_CAPTURE_CONTEXT');
  });

  it.each([
    'actor',
    'personId',
    'workspaceId',
    'grants',
    'verified',
    'credentials',
    'signature',
    'payload',
  ])('rejects forged or unknown top-level %s metadata', (field) => {
    const { envelope, context } = fixture();

    expect(() =>
      snapshotOmniIncomingCaptureContext(
        { ...context, [field]: 'forged' },
        envelope,
      ),
    ).toThrow('OMNI_INVALID_CAPTURE_CONTEXT');
  });

  it.each(['verified', 'admin', 'token', 'callback', 'personId'])(
    'rejects qualification %s flags as substitutes for server verification',
    (field) => {
      const { envelope, context } = fixture();
      const changed = {
        ...context,
        qualification: { ...context.qualification, [field]: true },
      };

      expect(() =>
        snapshotOmniIncomingCaptureContext(changed, envelope),
      ).toThrow('OMNI_INVALID_CAPTURE_CONTEXT');
    },
  );

  it('rejects forged source position metadata', () => {
    const { envelope, context } = fixture();
    const changed = {
      ...context,
      sourcePosition: { ...context.sourcePosition, verified: true },
    };

    expect(() => snapshotOmniIncomingCaptureContext(changed, envelope)).toThrow(
      'OMNI_INVALID_CAPTURE_CONTEXT',
    );
  });

  it('rejects unsupported envelope identity versions before snapshotting', () => {
    const { envelope, context } = fixture();

    expect(() =>
      snapshotOmniIncomingCaptureContext(context, {
        ...envelope,
        nativeMessageKeyVersion: 2,
      }),
    ).toThrow('OMNI_INVALID_ENVELOPE');
  });
});
