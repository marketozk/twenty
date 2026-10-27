import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import {
  type OmniHistoryApplyAuthorizer,
  type OmniHistoryApplyResult,
} from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import {
  createOmniHistoryMissingConfigurationError,
  OmniHistoryMissingConfigurationError,
} from 'src/modules/omnichannel/services/omni-history-missing-configuration.error';
import {
  deferOmniIncomingReceipt,
  type OmniIncomingReceiptLeaseAuthorizer,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';

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
  'src/modules/omnichannel/services/omni-incoming-receipt-lease',
  () => ({ deferOmniIncomingReceipt: jest.fn() }),
);

const defer = jest.mocked(deferOmniIncomingReceipt);
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const dataSource = {} as Dependencies[5];
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    {} as Dependencies[0],
    {} as Dependencies[1],
    {} as Dependencies[2],
    {} as Dependencies[3],
    {} as Dependencies[4],
    dataSource,
  );
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'test-history-worker' },
  };
  const proof = {
    receiptId: randomUUID(),
    leaseOwner: randomUUID(),
    leaseToken: '1',
    routeGeneration: '1',
    externalIdentityId: randomUUID(),
  };
  const authorizeHistory = jest
    .fn<
      ReturnType<OmniHistoryApplyAuthorizer>,
      Parameters<OmniHistoryApplyAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const authorizeLease = jest
    .fn<
      ReturnType<OmniIncomingReceiptLeaseAuthorizer>,
      Parameters<OmniIncomingReceiptLeaseAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const apply = jest.spyOn(service, 'applyOmniHistoryReceipt');
  const deferred = {
    receiptId: proof.receiptId,
    state: 'blocked_config' as const,
    errorCode: 'configuration_missing' as const,
    nextAttemptAt: '2026-10-27T00:00:00.000Z',
  };
  defer.mockResolvedValue(deferred);
  return {
    service,
    dataSource,
    principal,
    proof,
    authorizeHistory,
    authorizeLease,
    apply,
    deferred,
    process: () =>
      service.processOmniHistoryReceipt(
        principal,
        proof,
        authorizeHistory,
        authorizeLease,
      ),
  };
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe('history config-defer orchestration boundary', () => {
  it('returns an applied result without a separate receipt mutation', async () => {
    const test = fixture();
    const result: OmniHistoryApplyResult = {
      receiptId: test.proof.receiptId,
      messageLinkId: randomUUID(),
      messageId: randomUUID(),
      conversationId: randomUUID(),
      created: true,
      state: 'applied',
    };
    test.apply.mockResolvedValue(result);
    await expect(test.process()).resolves.toBe(result);
    expect(defer).not.toHaveBeenCalled();
  });

  it('uses the existing defer lifecycle and a separate required current lease authorizer after a trusted configuration failure', async () => {
    const test = fixture();
    test.apply.mockRejectedValue(createOmniHistoryMissingConfigurationError());
    await expect(test.process()).resolves.toEqual(test.deferred);
    expect(defer).toHaveBeenCalledWith(
      test.dataSource,
      test.principal,
      {
        receiptId: test.proof.receiptId,
        leaseOwner: test.proof.leaseOwner,
        leaseToken: '1',
        routeGeneration: '1',
      },
      { state: 'blocked_config', errorCode: 'configuration_missing' },
      test.authorizeLease,
    );
    expect(test.authorizeHistory).not.toHaveBeenCalled();
  });

  it('does not interpret a directly constructed lookalike configuration error as an issued domain signal', async () => {
    const test = fixture();
    const error = new OmniHistoryMissingConfigurationError();
    test.apply.mockRejectedValue(error);
    await expect(test.process()).rejects.toBe(error);
    expect(defer).not.toHaveBeenCalled();
  });

  it('never turns an authorizer-thrown issued configuration error into blocked_config', async () => {
    const test = fixture();
    const error = createOmniHistoryMissingConfigurationError();
    test.authorizeHistory.mockRejectedValue(error);
    test.apply.mockImplementation(async (_principal, _proof, authorize) => {
      await authorize(
        {} as Parameters<OmniHistoryApplyAuthorizer>[0],
        {} as Parameters<OmniHistoryApplyAuthorizer>[1],
      );
      throw new Error('Expected authorization to reject');
    });
    await expect(test.process()).rejects.toBe(error);
    expect(defer).not.toHaveBeenCalled();
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'never defers after unknown native %s outcome, even with a configuration error as cause',
    async (phase) => {
      const test = fixture();
      const error = new NativeTransactionOutcomeUnknownError(
        phase,
        createOmniHistoryMissingConfigurationError(),
      );
      test.apply.mockRejectedValue(error);
      await expect(test.process()).rejects.toBe(error);
      expect(defer).not.toHaveBeenCalled();
    },
  );

  it('propagates defer authorization/storage/unknown failure without claiming blocked_config', async () => {
    const test = fixture();
    test.apply.mockRejectedValue(createOmniHistoryMissingConfigurationError());
    const error = new Error('defer denied or unconfirmed');
    defer.mockRejectedValue(error);
    await expect(test.process()).rejects.toBe(error);
  });

  it('requires a lease authorizer before entering any apply transaction', async () => {
    const test = fixture();
    await expect(
      test.service.processOmniHistoryReceipt(
        test.principal,
        test.proof,
        test.authorizeHistory,
        undefined as unknown as OmniIncomingReceiptLeaseAuthorizer,
      ),
    ).rejects.toThrow('LEASE_AUTHORIZER_REQUIRED');
    expect(test.apply).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });

  it('keeps the principal and proof snapshots across the asynchronous apply attempt', async () => {
    const test = fixture();
    const initialPrincipal = structuredClone(test.principal);
    const initialProof = structuredClone(test.proof);
    let rejectApply!: (reason: unknown) => void;
    test.apply.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectApply = reject;
        }),
    );
    const pending = test.process();
    test.principal.bindingId = randomUUID();
    test.principal.actor.id = 'mutated';
    test.proof.receiptId = randomUUID();
    test.proof.leaseToken = '999';
    rejectApply(createOmniHistoryMissingConfigurationError());
    await pending;
    expect(defer).toHaveBeenCalledWith(
      test.dataSource,
      initialPrincipal,
      {
        receiptId: initialProof.receiptId,
        leaseOwner: initialProof.leaseOwner,
        leaseToken: initialProof.leaseToken,
        routeGeneration: initialProof.routeGeneration,
      },
      { state: 'blocked_config', errorCode: 'configuration_missing' },
      test.authorizeLease,
    );
  });
});
