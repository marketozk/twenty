import {
  isOmniConnectorAcceptanceProof,
  omniConnectorAcceptanceInputSchema,
  omniConnectorAcceptanceProofSchema,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = {
  commandId,
  providerChatId: 'chat-1',
  payloadHash: 'a'.repeat(64),
  generation: '1',
  connectorJobId: 'job-1',
  journalSequence: '0',
  qualification: { adapterId: 'synthetic', adapterVersion: 'v1' },
};
const proof = {
  ...input,
  schemaVersion: 1,
  evidenceKind: 'connector.durable_acceptance',
  workspaceId,
  bindingId,
  conversationId,
};
const context = {
  ...input,
  workspaceId,
  bindingId,
  conversationId,
  state: 'accepted',
  payload: {
    workspaceId,
    bindingId,
    conversationId,
    providerChatId: input.providerChatId,
  },
};

describe('connector acceptance closed proof contract', () => {
  it.each(['nonsense', '1.5', '', '-1', '01', '9223372036854775808', '1\n'])(
    'returns false instead of throwing for malformed counters (%j)',
    (value) => {
      expect(
        omniConnectorAcceptanceInputSchema.safeParse({
          ...input,
          generation: value,
        }).success,
      ).toBe(false);
      expect(
        omniConnectorAcceptanceInputSchema.safeParse({
          ...input,
          journalSequence: value,
        }).success,
      ).toBe(false);
      expect(
        isOmniConnectorAcceptanceProof(
          { ...proof, generation: value },
          context,
        ),
      ).toBe(false);
      expect(
        isOmniConnectorAcceptanceProof(
          { ...proof, journalSequence: value },
          context,
        ),
      ).toBe(false);
    },
  );

  it.each([
    'commandId',
    'providerChatId',
    'payloadHash',
    'generation',
    'connectorJobId',
    'journalSequence',
  ] as const)('rejects a final newline in %s', (field) => {
    expect(
      omniConnectorAcceptanceInputSchema.safeParse({
        ...input,
        [field]: `${input[field]}\n`,
      }).success,
    ).toBe(false);
  });

  it.each(['adapterId', 'adapterVersion'] as const)(
    'rejects a final newline in qualification.%s',
    (field) => {
      expect(
        omniConnectorAcceptanceInputSchema.safeParse({
          ...input,
          qualification: {
            ...input.qualification,
            [field]: `${input.qualification[field]}\n`,
          },
        }).success,
      ).toBe(false);
    },
  );

  it.each(['\u0000', '\r', '\n', '\u007f', '\ud800', '\udfff'])(
    'rejects control or lone surrogate identifiers (%j)',
    (suffix) => {
      expect(
        omniConnectorAcceptanceInputSchema.safeParse({
          ...input,
          connectorJobId: `job${suffix}`,
        }).success,
      ).toBe(false);
    },
  );

  it('accepts complete Unicode code points and applies the identifier limit by code point', () => {
    expect(
      omniConnectorAcceptanceInputSchema.safeParse({
        ...input,
        providerChatId: 'чат-😀',
      }).success,
    ).toBe(true);
    expect(
      omniConnectorAcceptanceInputSchema.safeParse({
        ...input,
        connectorJobId: '😀'.repeat(512),
      }).success,
    ).toBe(true);
    expect(
      omniConnectorAcceptanceInputSchema.safeParse({
        ...input,
        connectorJobId: '😀'.repeat(513),
      }).success,
    ).toBe(false);
  });

  it('rejects non-ASCII adapter provenance but accepts zero journal sequence', () => {
    expect(omniConnectorAcceptanceInputSchema.safeParse(input).success).toBe(
      true,
    );
    expect(
      omniConnectorAcceptanceInputSchema.safeParse({
        ...input,
        qualification: { ...input.qualification, adapterId: 'адаптер' },
      }).success,
    ).toBe(false);
  });

  it('normalizes new UUID input while refusing noncanonical persisted evidence', () => {
    expect(
      omniConnectorAcceptanceInputSchema.parse({
        ...input,
        commandId: commandId.toUpperCase(),
      }).commandId,
    ).toBe(commandId);
    expect(isOmniConnectorAcceptanceProof(proof, context)).toBe(true);
    expect(
      isOmniConnectorAcceptanceProof(
        { ...proof, commandId: commandId.toUpperCase() },
        context,
      ),
    ).toBe(false);
  });

  it('captures and freezes nested qualification without retaining caller references', () => {
    const mutable = { ...proof, qualification: { ...proof.qualification } };
    const snapshot = omniConnectorAcceptanceProofSchema.parse(mutable);
    mutable.qualification.adapterId = 'changed';
    expect(snapshot.qualification.adapterId).toBe('synthetic');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.qualification)).toBe(true);
  });
});
