import { randomUUID } from 'node:crypto';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { createOmniHumanCommandFixture } from 'test/fork-migration/omni-human-command.fixture';

export const createOmniSentApplyFixture = () => {
  const base = createOmniHumanCommandFixture({
    useStandardForeignKeyActions: true,
    includeTargets: true,
  });
  type Observation = Parameters<typeof base.service.acceptOmniSentReceipt>[1];
  type Callbacks = Parameters<typeof base.service.acceptOmniSentReceipt>[2];
  type Scope = Pick<Parameters<Callbacks['authorize']>[0], 'workspaceId'>;
  type Descriptor = Pick<
    Parameters<Callbacks['authorize']>[1],
    'principal' | 'bindingId' | 'conversationId' | 'envelope' | 'capture'
  >;
  const reset = async (options: { withoutAcceptance?: boolean } = {}) => {
    const context = await base.reset();
    const commandId = (await context.admit()).commandId;
    const principal = {
      workspaceId: base.workspaceId,
      bindingId: context.bindingId,
      actor: { kind: 'system' as const, id: context.principal.actor.id },
    };
    const commandLease = await base.service.claimOmniHumanCommandLease(
      principal,
      { commandId, leaseMilliseconds: 300000 },
      { authorize: async () => {}, qualifyTransport: async () => {} },
    );
    if (!commandLease.claimed) throw new Error('Fixture command lease missing');
    const [command] = await base.owner.query(
      'SELECT * FROM core."omniOutgoingCommand" WHERE id=$1',
      [commandId],
    );
    if (!options.withoutAcceptance) {
      await base.service.applyOmniConnectorAcceptance(
        principal,
        {
          commandId,
          providerChatId: 'history-chat',
          payloadHash: command.payloadHash,
          generation: '1',
          connectorJobId: `fixture-job-${commandId}`,
          journalSequence: '1',
          qualification: { adapterId: 'fixture-outcome', adapterVersion: '1' },
        },
        { authorize: async () => {}, verifyEvidence: async () => {} },
      );
    }
    const makeObservation = (
      changes: Partial<Observation['envelope']> = {},
      captureChanges: Partial<Observation['capture']> = {},
    ): Observation => {
      const envelope: Observation['envelope'] = {
        schemaVersion: 1,
        kind: 'command.sent',
        eventId: randomUUID(),
        accountBindingId: context.bindingId,
        routeGeneration: '1',
        commandId,
        providerChatId: 'history-chat',
        payloadHash: command.payloadHash,
        connectorJobId: `fixture-job-${commandId}`,
        journalSequence: '1',
        providerMessageId: 'fixture-sent-message',
        direction: 'outgoing',
        sourceVariant: 'complete',
        nativeMessageKeyVersion: 1,
        occurredAt: '2026-10-27T12:00:00.000Z',
        sourcePosition: { type: 'journal', value: '1' },
        ...changes,
      };
      return {
        envelope,
        capture: {
          schemaVersion: 1,
          origin: 'connector_outcome',
          envelopeHash: auditPayloadHash(envelope),
          qualification: { adapterId: 'fixture-outcome', adapterVersion: '1' },
          nativeMessageKey: `fixture:v1:${envelope.providerMessageId}`,
          nativeMessageKeyVersion: 1,
          sourceVariant: 'complete',
          sourcePosition: envelope.sourcePosition,
          ...captureChanges,
        },
      };
    };
    const callbacks = (observation: Observation) => ({
      authorize: async (scope: Scope, descriptor: Descriptor) => {
        // Explicit fixture grants; no production ACL or live transport qualification is implied.
        expect(scope.workspaceId).toBe(base.workspaceId);
        expect(descriptor).toMatchObject({
          principal,
          bindingId: context.bindingId,
          conversationId: context.conversationId,
        });
      },
      verifyEvidence: async (scope: Scope, descriptor: Descriptor) => {
        expect(scope.workspaceId).toBe(base.workspaceId);
        expect(descriptor.envelope).toEqual(observation.envelope);
        expect(descriptor.capture).toEqual(observation.capture);
      },
    });
    const capture = async (
      changes: Partial<Observation['envelope']> = {},
      captureChanges: Partial<Observation['capture']> = {},
      leaseMilliseconds = 300000,
    ) => {
      const observation = makeObservation(changes, captureChanges);
      const accepted = await base.service.acceptOmniSentReceipt(
        principal,
        observation,
        callbacks(observation),
      );
      const claimed = await base.service.claimOmniSentReceipt(
        principal,
        {
          receiptId: accepted.receiptId,
          leaseOwner: randomUUID(),
          leaseMilliseconds,
        },
        callbacks(observation),
      );
      if (!claimed.claimed)
        throw new Error(
          `Fixture sent receipt not claimable: ${claimed.reason}`,
        );
      return {
        observation,
        proof: claimed.proof,
        receiptId: accepted.receiptId,
      };
    };
    return {
      ...context,
      commandId,
      commandLeaseProof: commandLease.proof,
      principal,
      callbacks,
      capture,
      makeObservation,
    };
  };
  return { ...base, reset };
};
