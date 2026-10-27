import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniHumanCommandLeaseFailure } from 'src/modules/omnichannel/services/append-omni-human-command-lease-failure';
import {
  claimOmniHumanCommandLease,
  isOmniHumanCommandLeaseAuthorizationError,
  type OmniHumanCommandLeaseCallbacks,
  type OmniHumanCommandLeaseScope,
} from 'src/modules/omnichannel/services/claim-omni-human-command';

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
  'src/modules/omnichannel/services/append-omni-human-command-lease-failure',
  () => ({ appendOmniHumanCommandLeaseFailure: jest.fn() }),
);
jest.mock('src/modules/omnichannel/services/claim-omni-human-command', () => ({
  ...jest.requireActual<
    typeof import('src/modules/omnichannel/services/claim-omni-human-command')
  >('src/modules/omnichannel/services/claim-omni-human-command'),
  claimOmniHumanCommandLease: jest.fn(),
  isOmniHumanCommandLeaseAuthorizationError: jest.fn(),
}));

const claim = jest.mocked(claimOmniHumanCommandLease);
const appendFailure = jest.mocked(appendOmniHumanCommandLeaseFailure);
const isAuthorizationError = jest.mocked(
  isOmniHumanCommandLeaseAuthorizationError,
);
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture-worker' },
  };
  const input = { commandId: randomUUID(), leaseMilliseconds: 30000 };
  const scope: OmniHumanCommandLeaseScope = {
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
    async (work: (value: OmniHumanCommandLeaseScope) => Promise<unknown>) => {
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
      ReturnType<OmniHumanCommandLeaseCallbacks['authorize']>,
      Parameters<OmniHumanCommandLeaseCallbacks['authorize']>
    >()
    .mockResolvedValue(undefined);
  const qualifyTransport = jest
    .fn<
      ReturnType<OmniHumanCommandLeaseCallbacks['qualifyTransport']>,
      Parameters<OmniHumanCommandLeaseCallbacks['qualifyTransport']>
    >()
    .mockResolvedValue(undefined);
  const callbacks: OmniHumanCommandLeaseCallbacks = {
    authorize,
    qualifyTransport,
  };
  const result = {
    claimed: true as const,
    proof: {
      commandId: input.commandId,
      leaseToken: randomUUID(),
      leaseUntil: '2026-10-27T10:00:00.123456Z',
      capturedRestoreIncarnation: randomUUID(),
      purpose: 'first_attempt' as const,
    },
  };
  // These tests isolate owner ordering; the real descriptor/authorization is covered by PostgreSQL tests.
  const descriptor = Object.freeze({ fixture: 'owner-lifecycle-only' });
  claim.mockImplementation(
    async (nativeScope, _principal, _input, captured) => {
      await Reflect.apply(captured.authorize, undefined, [
        nativeScope,
        descriptor,
      ]);
      await Reflect.apply(captured.qualifyTransport, undefined, [
        nativeScope,
        descriptor,
      ]);
      return result;
    },
  );
  appendFailure.mockImplementation(async () => {
    events.push('audit');
  });
  isAuthorizationError.mockReturnValue(false);
  return {
    principal,
    input,
    scope,
    callbacks,
    authorize,
    qualifyTransport,
    result,
    service,
    events,
    transaction,
    context,
    descriptor,
  };
};

beforeEach(() => jest.resetAllMocks());

describe('human command lease strict transaction owner', () => {
  it('captures input, worker identity and callbacks before context loading', async () => {
    const test = fixture();
    const expected = structuredClone({
      principal: test.principal,
      input: test.input,
    });
    const replacement = jest.fn(async () => undefined);
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      test.input.commandId = randomUUID();
      test.input.leaseMilliseconds = 1000;
      test.principal.actor.id = 'replaced-worker';
      test.principal.bindingId = randomUUID();
      Reflect.set(test.callbacks, 'authorize', replacement);
      Reflect.set(test.callbacks, 'qualifyTransport', replacement);
      return work();
    });
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toEqual(test.result);
    expect(claim).toHaveBeenCalledWith(
      test.scope,
      expected.principal,
      expected.input,
      expect.objectContaining({
        authorize: expect.any(Function),
        qualifyTransport: test.qualifyTransport,
      }),
    );
    expect(test.authorize).toHaveBeenCalledWith(test.scope, test.descriptor);
    expect(test.qualifyTransport).toHaveBeenCalledWith(
      test.scope,
      test.descriptor,
    );
    expect(replacement).not.toHaveBeenCalled();
    expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
      commitOutcome: 'strict',
    });
    expect(appendFailure).not.toHaveBeenCalled();
  });

  it('records a grant denial only in a fresh transaction after rollback', async () => {
    const test = fixture();
    const error = new Error('worker grant denied');
    test.authorize.mockRejectedValue(error);
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(test.events).toEqual([
      'begin',
      'rollback',
      'begin',
      'audit',
      'commit',
    ]);
    expect(appendFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      true,
    );
  });

  it('reads callback accessors once before awaiting context creation', async () => {
    const test = fixture();
    let authorizeReads = 0;
    let qualificationReads = 0;
    Object.defineProperty(test.callbacks, 'authorize', {
      get: () => (++authorizeReads === 1 ? test.authorize : undefined),
    });
    Object.defineProperty(test.callbacks, 'qualifyTransport', {
      get: () =>
        ++qualificationReads === 1 ? test.qualifyTransport : undefined,
    });

    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toEqual(test.result);
    expect(authorizeReads).toBe(1);
    expect(qualificationReads).toBe(1);
    expect(test.authorize).toHaveBeenCalledTimes(1);
    expect(test.qualifyTransport).toHaveBeenCalledTimes(1);
  });

  it('retains the predecessor verifier reference and classifies its failure separately from grants', async () => {
    const test = fixture();
    const error = new Error('local evidence lookup failed');
    const verify = jest.fn(async () => {
      throw error;
    });
    Reflect.set(test.callbacks, 'verifyPredecessor', verify);
    const replacement = jest.fn(async () => 'durably_accepted');
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      Reflect.set(test.callbacks, 'verifyPredecessor', replacement);
      return work();
    });
    claim.mockImplementation(async (scope, _principal, _input, captured) => {
      await Reflect.apply(captured.authorize, undefined, [
        scope,
        test.descriptor,
      ]);
      if (!captured.verifyPredecessor)
        throw new Error('Expected captured verifier');
      await Reflect.apply(captured.verifyPredecessor, undefined, [
        scope,
        test.descriptor,
      ]);
      return test.result;
    });

    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(appendFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      false,
    );
  });

  it('returns a bounded busy outcome without recording a failed attempt', async () => {
    const test = fixture();
    claim.mockResolvedValue({ claimed: false, reason: 'lease_live' });
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toEqual({ claimed: false, reason: 'lease_live' });
    expect(test.events).toEqual(['begin', 'commit']);
    expect(appendFailure).not.toHaveBeenCalled();
  });

  it('records a transport qualification error as failure rather than grant denial', async () => {
    const test = fixture();
    const error = new Error('registry unavailable');
    test.qualifyTransport.mockRejectedValue(error);
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(appendFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      false,
    );
    expect(test.events).toEqual([
      'begin',
      'rollback',
      'begin',
      'audit',
      'commit',
    ]);
  });

  it('uses the issued membership-denial predicate without interpreting error text', async () => {
    const test = fixture();
    const error = new Error('known membership denial');
    claim.mockRejectedValue(error);
    isAuthorizationError.mockImplementation((candidate) => candidate === error);
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(appendFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      true,
    );
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'does not audit an unknown %s outcome as a failed claim',
    async (phase) => {
      const test = fixture();
      const error = new NativeTransactionOutcomeUnknownError(
        phase,
        new Error('lost acknowledgement'),
      );
      test.transaction.mockImplementationOnce(async (work) => {
        await work(test.scope);
        throw error;
      });
      await expect(
        test.service.claimOmniHumanCommandLease(
          test.principal,
          test.input,
          test.callbacks,
        ),
      ).rejects.toBe(error);
      expect(appendFailure).not.toHaveBeenCalled();
      expect(test.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves both the failed claim and a failure-audit error', async () => {
    const test = fixture();
    const original = new Error('command update failed');
    const audit = new Error('audit failed');
    claim.mockRejectedValue(original);
    appendFailure.mockRejectedValue(audit);
    const error = await test.service
      .claimOmniHumanCommandLease(test.principal, test.input, test.callbacks)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: 'OMNI_HUMAN_COMMAND_LEASE_FAILURE_AUDIT_UNCONFIRMED',
      errors: [original, audit],
    });
  });

  it('does not manufacture failure audit when connection acquisition fails before leaf entry', async () => {
    const test = fixture();
    const error = new Error('no connection');
    test.transaction.mockRejectedValue(error);
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(claim).not.toHaveBeenCalled();
    expect(appendFailure).not.toHaveBeenCalled();
  });

  it('rejects invalid leases before opening the workspace context', async () => {
    const test = fixture();
    test.input.leaseMilliseconds = 999;
    await expect(
      test.service.claimOmniHumanCommandLease(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toThrow();
    expect(test.context).not.toHaveBeenCalled();
    expect(appendFailure).not.toHaveBeenCalled();
  });
});
