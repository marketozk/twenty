import { randomUUID } from 'node:crypto';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniSentReceiptFailure } from 'src/modules/omnichannel/services/append-omni-sent-receipt-failure';
import {
  acceptOmniSentReceipt,
  claimOmniSentReceipt,
  type OmniSentReceiptCallbacks,
  type OmniSentReceiptScope,
} from 'src/modules/omnichannel/services/omni-sent-receipt';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message.service',
  () => ({ MessagingMessageService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service',
  () => ({ MessagingMessageParticipantService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service',
  () => ({ MessagingMessageFolderAssociationService: class {} }),
);
jest.mock(
  'src/modules/omnichannel/services/append-omni-sent-receipt-failure',
  () => ({ appendOmniSentReceiptFailure: jest.fn() }),
);
jest.mock('src/modules/omnichannel/services/omni-sent-receipt', () => ({
  ...jest.requireActual<
    typeof import('src/modules/omnichannel/services/omni-sent-receipt')
  >('src/modules/omnichannel/services/omni-sent-receipt'),
  acceptOmniSentReceipt: jest.fn(),
  claimOmniSentReceipt: jest.fn(),
}));

const accept = jest.mocked(acceptOmniSentReceipt);
const claim = jest.mocked(claimOmniSentReceipt);
const failureAudit = jest.mocked(appendOmniSentReceiptFailure);
const fixture = (operation: 'accept' | 'claim') => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture-reconciler' },
  };
  const envelope = {
    schemaVersion: 1 as const,
    kind: 'command.sent' as const,
    eventId: 'fixture-outcome',
    accountBindingId: principal.bindingId,
    routeGeneration: '1',
    commandId: randomUUID(),
    providerChatId: 'fixture-chat',
    payloadHash: 'a'.repeat(64),
    connectorJobId: 'fixture-job',
    journalSequence: '0',
    providerMessageId: 'fixture-native',
    direction: 'outgoing' as const,
    sourceVariant: 'complete' as const,
    nativeMessageKeyVersion: 1 as const,
    occurredAt: null,
    sourcePosition: null,
  };
  const input = {
    envelope,
    capture: {
      schemaVersion: 1 as const,
      origin: 'connector_outcome' as const,
      envelopeHash: auditPayloadHash(envelope),
      qualification: { adapterId: 'fixture-adapter', adapterVersion: 'v1' },
      nativeMessageKey: 'v1:outgoing:fixture-native',
      nativeMessageKeyVersion: 1 as const,
      sourceVariant: 'complete' as const,
      sourcePosition: null,
    },
  };
  const claimInput = {
    receiptId: randomUUID(),
    leaseOwner: randomUUID(),
    leaseMilliseconds: 1000,
  };
  const scope: OmniSentReceiptScope = {
    workspaceId: principal.workspaceId,
    transactionLifecycle: {
      commitOutcome: 'strict',
      isTransactionActive: true,
      isReleased: false,
    },
    executeRawQuery: jest.fn(async () => []),
  };
  const events: string[] = [];
  const transaction = jest.fn(
    async (work: (value: OmniSentReceiptScope) => Promise<unknown>) => {
      events.push('begin');
      try {
        const result = await work(scope);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  );
  const context = jest.fn(async (work: () => Promise<unknown>) => work());
  const manager = {
    executeInWorkspaceContext: context,
    runInWorkspaceTransaction: transaction,
  } as unknown as Dependencies[4];
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    {} as Dependencies[0],
    {} as Dependencies[1],
    {} as Dependencies[2],
    {} as Dependencies[3],
    manager,
    {} as Dependencies[5],
  );
  const authorize = jest
    .fn<
      ReturnType<OmniSentReceiptCallbacks['authorize']>,
      Parameters<OmniSentReceiptCallbacks['authorize']>
    >()
    .mockResolvedValue(undefined);
  const verifyEvidence = jest
    .fn<
      ReturnType<OmniSentReceiptCallbacks['verifyEvidence']>,
      Parameters<OmniSentReceiptCallbacks['verifyEvidence']>
    >()
    .mockResolvedValue(undefined);
  const callbacks: OmniSentReceiptCallbacks = { authorize, verifyEvidence };
  const accepted = {
    receiptId: claimInput.receiptId,
    state: 'accepted' as const,
    created: true,
  };
  const claimed = {
    claimed: true as const,
    proof: {
      receiptId: claimInput.receiptId,
      leaseOwner: claimInput.leaseOwner,
      leaseToken: '1',
      leaseUntil: '2026-10-27T12:00:00.123456Z',
      routeGeneration: '1',
    },
    envelope,
    capture: input.capture,
  };
  // Only owner lifecycle is mocked; real immutable descriptors are covered by PostgreSQL tests.
  const descriptor = Object.freeze({ fixture: 'owner-lifecycle' });
  const invokeCallbacks = async (
    nativeScope: OmniSentReceiptScope,
    captured: OmniSentReceiptCallbacks,
  ) => {
    await Reflect.apply(captured.authorize, undefined, [
      nativeScope,
      descriptor,
    ]);
    await Reflect.apply(captured.verifyEvidence, undefined, [
      nativeScope,
      descriptor,
    ]);
  };
  accept.mockImplementation(
    async (nativeScope, _principal, _input, captured) => {
      await invokeCallbacks(nativeScope, captured);
      return accepted;
    },
  );
  claim.mockImplementation(
    async (nativeScope, _principal, _input, captured) => {
      await invokeCallbacks(nativeScope, captured);
      return claimed;
    },
  );
  failureAudit.mockImplementation(async () => {
    events.push('audit');
  });
  const run = () =>
    operation === 'accept'
      ? service.acceptOmniSentReceipt(principal, input, callbacks)
      : service.claimOmniSentReceipt(principal, claimInput, callbacks);
  return {
    principal,
    input,
    claimInput,
    scope,
    events,
    transaction,
    context,
    service,
    authorize,
    verifyEvidence,
    callbacks,
    accepted,
    claimed,
    descriptor,
    run,
    target: {
      operation,
      resourceId:
        operation === 'accept' ? envelope.commandId : claimInput.receiptId,
    },
  };
};

beforeEach(() => jest.resetAllMocks());

describe.each(['accept', 'claim'] as const)(
  'sent receipt %s strict transaction owner',
  (operation) => {
    it('snapshots worker, nested input and callback references before context loading', async () => {
      const test = fixture(operation);
      const expectedPrincipal = structuredClone(test.principal);
      const expectedInput = structuredClone(
        operation === 'accept' ? test.input : test.claimInput,
      );
      const replacement = jest.fn(async () => undefined);
      test.context.mockImplementation(async (work) => {
        await Promise.resolve();
        test.principal.actor.id = 'changed';
        test.input.envelope.commandId = randomUUID();
        test.input.capture.qualification.adapterVersion = 'changed';
        test.claimInput.receiptId = randomUUID();
        test.claimInput.leaseMilliseconds = 99999;
        Reflect.set(test.callbacks, 'authorize', replacement);
        Reflect.set(test.callbacks, 'verifyEvidence', replacement);
        return work();
      });
      await test.run();
      expect(operation === 'accept' ? accept : claim).toHaveBeenCalledWith(
        test.scope,
        expectedPrincipal,
        expectedInput,
        expect.objectContaining({
          authorize: expect.any(Function),
          verifyEvidence: test.verifyEvidence,
        }),
      );
      expect(test.authorize).toHaveBeenCalledWith(test.scope, test.descriptor);
      expect(test.verifyEvidence).toHaveBeenCalledWith(
        test.scope,
        test.descriptor,
      );
      expect(replacement).not.toHaveBeenCalled();
      expect(failureAudit).not.toHaveBeenCalled();
      expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
        commitOutcome: 'strict',
      });
    });

    it('reads callback accessors exactly once', async () => {
      const test = fixture(operation);
      let authorizationReads = 0;
      let verificationReads = 0;
      Object.defineProperty(test.callbacks, 'authorize', {
        get: () => (++authorizationReads === 1 ? test.authorize : undefined),
      });
      Object.defineProperty(test.callbacks, 'verifyEvidence', {
        get: () =>
          ++verificationReads === 1 ? test.verifyEvidence : undefined,
      });
      await test.run();
      expect(authorizationReads).toBe(1);
      expect(verificationReads).toBe(1);
      expect(test.authorize).toHaveBeenCalledTimes(1);
      expect(test.verifyEvidence).toHaveBeenCalledTimes(1);
    });

    it('records grant denial only after confirmed rollback in a fresh transaction', async () => {
      const test = fixture(operation);
      const error = new Error('grant revoked');
      test.authorize.mockRejectedValue(error);
      await expect(test.run()).rejects.toBe(error);
      expect(test.events).toEqual([
        'begin',
        'rollback',
        'begin',
        'audit',
        'commit',
      ]);
      expect(failureAudit).toHaveBeenCalledWith(
        test.scope,
        test.principal,
        test.target,
        expect.any(String),
        true,
      );
    });

    it('records evidence mismatch as failed rather than denied', async () => {
      const test = fixture(operation);
      const error = new Error('proof mismatch');
      test.verifyEvidence.mockRejectedValue(error);
      await expect(test.run()).rejects.toBe(error);
      expect(failureAudit).toHaveBeenCalledWith(
        test.scope,
        test.principal,
        test.target,
        expect.any(String),
        false,
      );
    });

    it.each(['commit', 'rollback', 'release'] as const)(
      'never records a false failed attempt after unknown %s',
      async (phase) => {
        const test = fixture(operation);
        const error = new NativeTransactionOutcomeUnknownError(
          phase,
          new Error('lost acknowledgement'),
        );
        test.transaction.mockImplementationOnce(async (work) => {
          await work(test.scope);
          throw error;
        });
        await expect(test.run()).rejects.toBe(error);
        expect(failureAudit).not.toHaveBeenCalled();
        expect(test.transaction).toHaveBeenCalledTimes(1);
      },
    );

    it('preserves original and audit failure causes', async () => {
      const test = fixture(operation);
      const original = new Error('write failed');
      const audit = new Error('audit unavailable');
      test.verifyEvidence.mockRejectedValue(original);
      failureAudit.mockRejectedValue(audit);
      await expect(test.run()).rejects.toMatchObject({
        message: 'OMNI_SENT_RECEIPT_FAILURE_AUDIT_UNCONFIRMED',
        errors: [original, audit],
      });
    });

    it('does not audit before a transaction callback ran', async () => {
      const test = fixture(operation);
      const error = new Error('connection unavailable');
      test.transaction.mockRejectedValue(error);
      await expect(test.run()).rejects.toBe(error);
      expect(accept).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(failureAudit).not.toHaveBeenCalled();
    });

    it('rejects malformed input before context loading', async () => {
      const test = fixture(operation);
      if (operation === 'accept')
        test.input.capture.envelopeHash = 'f'.repeat(64);
      else test.claimInput.leaseMilliseconds = 999;
      await expect(test.run()).rejects.toThrow();
      expect(test.context).not.toHaveBeenCalled();
      expect(failureAudit).not.toHaveBeenCalled();
    });
  },
);

it('does not audit a busy claim as failed', async () => {
  const test = fixture('claim');
  claim.mockResolvedValue({ claimed: false, reason: 'lease_live' });
  await expect(test.run()).resolves.toEqual({
    claimed: false,
    reason: 'lease_live',
  });
  expect(failureAudit).not.toHaveBeenCalled();
  expect(test.events).toEqual(['begin', 'commit']);
});

it('returns exact accept replay without another attempt audit', async () => {
  const test = fixture('accept');
  accept.mockResolvedValue({ ...test.accepted, created: false });
  await expect(test.run()).resolves.toMatchObject({ created: false });
  expect(failureAudit).not.toHaveBeenCalled();
});
