import { z } from 'zod';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type OmniIncomingCaptureContext } from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import { type OmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import { createOmniIncomingRevisionConflict } from 'src/modules/omnichannel/services/omni-incoming-revision-conflict.error';

const sourceKey = z
  .string()
  .regex(/^[^\u0000-\u001f\u007f\uD800-\uDFFF]{1,512}(?![\s\S])/u);
export type OmniIncomingRevisionFacts = Readonly<{
  envelope: Readonly<OmniIncomingEnvelope>;
  captureContext: OmniIncomingCaptureContext;
}>;
export type OmniIncomingRevisionAdapter = Readonly<{
  adapterId: string;
  adapterVersion: string;
  revisionKey: (facts: OmniIncomingRevisionFacts) => string;
  compare: (
    candidate: OmniIncomingRevisionFacts,
    current: OmniIncomingRevisionFacts,
  ) => 'newer' | 'older' | 'equal' | 'incomparable';
}>;
export const snapshotOmniIncomingRevisionAdapter = (
  adapter: OmniIncomingRevisionAdapter,
): OmniIncomingRevisionAdapter => {
  if (
    !adapter ||
    typeof adapter.revisionKey !== 'function' ||
    typeof adapter.compare !== 'function'
  )
    throw new Error('OMNI_INCOMING_REVISION_ADAPTER_REQUIRED');
  return Object.freeze({
    adapterId: sourceKey.parse(adapter.adapterId),
    adapterVersion: sourceKey.parse(adapter.adapterVersion),
    revisionKey: adapter.revisionKey,
    compare: adapter.compare,
  });
};
export const qualifyOmniIncomingRevisionKey = (
  adapter: OmniIncomingRevisionAdapter,
  facts: OmniIncomingRevisionFacts,
): string => {
  const qualification = facts.captureContext.qualification;
  if (
    qualification.adapterId !== adapter.adapterId ||
    qualification.adapterVersion !== adapter.adapterVersion
  )
    throw createOmniIncomingRevisionConflict();
  const parsed = sourceKey.safeParse(adapter.revisionKey(facts));
  if (!parsed.success) throw createOmniIncomingRevisionConflict();
  return `revision:v1:${auditPayloadHash({ qualification, sourceRevisionKey: parsed.data })}`;
};
export const omniIncomingTextRevisionContent = (
  facts: OmniIncomingRevisionFacts,
) => {
  const envelope = facts.envelope;
  const tombstone = envelope.kind === 'message.deleted';
  const placeholder = envelope.sourceVariant === 'placeholder';
  if (
    envelope.direction !== 'incoming' ||
    (tombstone && (placeholder || envelope.payload.text !== null)) ||
    (placeholder &&
      (envelope.kind !== 'message.received' ||
        envelope.payload.text !== null)) ||
    (!placeholder && !tombstone && envelope.payload.text === null)
  )
    throw createOmniIncomingRevisionConflict();
  const text = tombstone || placeholder ? null : envelope.payload.text;
  return Object.freeze({
    text,
    tombstone,
    contentHash: auditPayloadHash({
      schemaVersion: 1,
      kind: 'incoming_text_revision',
      nativeMessageKey: facts.captureContext.nativeMessageKey,
      text,
      tombstone,
      sourceVariant: envelope.sourceVariant,
    }),
  });
};
