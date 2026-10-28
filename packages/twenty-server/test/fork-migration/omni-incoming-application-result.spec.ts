import { randomUUID } from 'node:crypto';
import { snapshotOmniIncomingApplicationResult } from 'src/modules/omnichannel/contracts/omni-incoming-application-result';

const fixture = () => ({
  schemaVersion: 1,
  kind: 'incoming_text_revision',
  disposition: 'advanced',
  selectedRevisionId: randomUUID(),
  observedHeadRevisionId: randomUUID(),
  candidateSourceRevisionKey: 'provider:revision:2',
  candidateContentHash: 'a'.repeat(64),
});

it.each(['created', 'advanced', 'duplicate', 'stale'])(
  'snapshots a consistent %s disposition',
  (disposition) => {
    const input = {
      ...fixture(),
      disposition,
      observedHeadRevisionId: disposition === 'created' ? null : randomUUID(),
    };
    if (disposition === 'stale')
      input.selectedRevisionId = input.observedHeadRevisionId!;
    const result = snapshotOmniIncomingApplicationResult(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.candidateSourceRevisionKey = 'changed';
    expect(result.candidateSourceRevisionKey).toBe('provider:revision:2');
  },
);
it('normalizes revision UUIDs before equality checks', () => {
  const input = fixture();
  const result = snapshotOmniIncomingApplicationResult({
    ...input,
    disposition: 'stale',
    selectedRevisionId: input.observedHeadRevisionId.toUpperCase(),
  });
  expect(result.selectedRevisionId).toBe(input.observedHeadRevisionId);
});
it.each([
  { schemaVersion: 2 },
  { kind: 'outgoing' },
  { disposition: 'incomparable' },
  { extra: true },
  { selectedRevisionId: 'wrong' },
  { observedHeadRevisionId: 'wrong' },
  { candidateSourceRevisionKey: '' },
  { candidateSourceRevisionKey: 'x'.repeat(513) },
  { candidateSourceRevisionKey: 'x\n' },
  { candidateSourceRevisionKey: 'x\u0000' },
  { candidateSourceRevisionKey: '\ud800' },
  { candidateContentHash: 'a'.repeat(63) },
  { candidateContentHash: 'A'.repeat(64) },
  { candidateContentHash: 'a'.repeat(64) + '\n' },
  { observedHeadRevisionId: null },
  { disposition: 'created' },
])('rejects malformed application outcome %#', (patch) => {
  expect(() =>
    snapshotOmniIncomingApplicationResult({ ...fixture(), ...patch }),
  ).toThrow('OMNI_INVALID_INCOMING_APPLICATION_RESULT');
});
it('rejects advanced self-reference and stale selection of a different revision', () => {
  const input = fixture();
  input.observedHeadRevisionId = input.selectedRevisionId;
  expect(() => snapshotOmniIncomingApplicationResult(input)).toThrow();
  input.disposition = 'stale';
  input.observedHeadRevisionId = randomUUID();
  expect(() => snapshotOmniIncomingApplicationResult(input)).toThrow();
});
it.each([null, [], {}, 'private payload'])(
  'rejects invalid outer shape %# without echoing its content',
  (input) => {
    expect(() => snapshotOmniIncomingApplicationResult(input)).toThrow(
      'OMNI_INVALID_INCOMING_APPLICATION_RESULT',
    );
  },
);
