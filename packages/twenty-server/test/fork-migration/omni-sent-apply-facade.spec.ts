import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniSentApplyFailure } from 'src/modules/omnichannel/services/append-omni-sent-apply-failure';
import {
  applyOmniSentReceipt,
  type OmniSentApplyCallbacks,
  type OmniSentApplyNativePort,
} from 'src/modules/omnichannel/services/apply-omni-sent-receipt';

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
  'src/modules/omnichannel/services/append-omni-sent-apply-failure',
  () => ({ appendOmniSentApplyFailure: jest.fn() }),
);
jest.mock('src/modules/omnichannel/services/apply-omni-sent-receipt', () => ({
  ...jest.requireActual<
    typeof import('src/modules/omnichannel/services/apply-omni-sent-receipt')
  >('src/modules/omnichannel/services/apply-omni-sent-receipt'),
  applyOmniSentReceipt: jest.fn(),
}));

const apply = jest.mocked(applyOmniSentReceipt);
const failureAudit = jest.mocked(appendOmniSentApplyFailure);
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture-worker' },
  };
  const proof = {
    receiptId: randomUUID(),
    leaseOwner: randomUUID(),
    leaseToken: '1',
    routeGeneration: '1',
    leaseUntil: '2026-10-27T12:00:00.123456Z',
  };
  const scope: WorkspaceTransactionScope = {
    workspaceId: principal.workspaceId,
    transactionLifecycle: {
      commitOutcome: 'strict',
      isTransactionActive: true,
      isReleased: false,
    },
    executeRawQuery: jest.fn(async () => []),
    getRepository: jest.fn(),
    afterCommit: jest.fn(),
  };
  const events: string[] = [];
  const transaction = jest.fn(
    async (work: (value: WorkspaceTransactionScope) => Promise<unknown>) => {
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
  const nativeInput: Parameters<
    OmniSentApplyNativePort['createInitialMessage']
  >[0] = {
    workspaceId: principal.workspaceId,
    messageChannelId: randomUUID(),
    messageThreadId: randomUUID(),
    headerMessageId: 'omni:v1:fixture',
    messageExternalId: 'v1:outgoing:fixture',
    messageThreadExternalId: 'fixture-chat',
    subject: null,
    text: 'saved command text',
    receivedAt: '2026-10-27T11:00:00.123Z',
    workspaceMemberId: randomUUID(),
  };
  const messageId = randomUUID();
  const associationId = randomUUID();
  const participantId = randomUUID();
  const nativeResult = {
    createdMessages: [{ id: messageId }],
    createdMessageThreadIds: [] as string[],
    messageExternalIdsAndIdsMap: new Map([
      [nativeInput.messageExternalId, messageId],
    ]),
    messageExternalIdToMessageChannelMessageAssociationIdMap: new Map([
      [nativeInput.messageExternalId, associationId],
    ]),
    messageExternalIdToMessageThreadIdMap: new Map([
      [nativeInput.messageExternalId, nativeInput.messageThreadId],
    ]),
  };
  const saveMessages = jest.fn(
    async (
      ..._args: Parameters<Dependencies[1]['saveMessagesWithinTransaction']>
    ) => nativeResult,
  );
  const saveParticipants = jest.fn(
    async (
      ..._args: Parameters<Dependencies[2]['saveMessageParticipants']>
    ) => [{ id: participantId, messageId }],
  );
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    {} as Dependencies[0],
    {
      saveMessagesWithinTransaction: saveMessages,
    } as unknown as Dependencies[1],
    { saveMessageParticipants: saveParticipants } as unknown as Dependencies[2],
    {} as Dependencies[3],
    manager,
    {} as Dependencies[5],
  );
  const authorize = jest
    .fn<
      ReturnType<OmniSentApplyCallbacks['authorize']>,
      Parameters<OmniSentApplyCallbacks['authorize']>
    >()
    .mockResolvedValue(undefined);
  const verifyEvidence = jest
    .fn<
      ReturnType<OmniSentApplyCallbacks['verifyEvidence']>,
      Parameters<OmniSentApplyCallbacks['verifyEvidence']>
    >()
    .mockResolvedValue(undefined);
  const callbacks: OmniSentApplyCallbacks = { authorize, verifyEvidence };
  const result = {
    receiptId: proof.receiptId,
    messageLinkId: randomUUID(),
    messageId,
    conversationId: randomUUID(),
    created: true,
    state: 'applied' as const,
  };
  const descriptor = Object.freeze({ fixture: 'owner-lifecycle-only' });
  apply.mockImplementation(
    async (nativeScope, _principal, _proof, captured, nativePort) => {
      await Reflect.apply(captured.authorize, undefined, [
        nativeScope,
        descriptor,
      ]);
      await Reflect.apply(captured.verifyEvidence, undefined, [
        nativeScope,
        descriptor,
      ]);
      await nativePort.createInitialMessage(nativeInput);
      return result;
    },
  );
  failureAudit.mockImplementation(async () => {
    events.push('audit');
  });
  const run = () => service.applyOmniSentReceipt(principal, proof, callbacks);
  return {
    principal,
    proof,
    scope,
    events,
    transaction,
    context,
    authorize,
    verifyEvidence,
    callbacks,
    nativeInput,
    nativeResult,
    saveMessages,
    saveParticipants,
    result,
    descriptor,
    run,
    messageId,
    associationId,
    participantId,
  };
};

beforeEach(() => jest.resetAllMocks());

describe('sent receipt apply strict native owner', () => {
  it.each([true, false])(
    'saves OUTGOING in the same guarded scope with nullable author projection: present=%s',
    async (present) => {
      const test = fixture();
      if (!present) Reflect.set(test.nativeInput, 'workspaceMemberId', null);
      await expect(test.run()).resolves.toEqual(test.result);
      const wrapped = test.saveMessages.mock.calls[0][2];
      expect(wrapped.transactionLifecycle).toBe(
        test.scope.transactionLifecycle,
      );
      expect(test.saveMessages).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            direction: 'OUTGOING',
            subject: null,
            text: test.nativeInput.text,
            attachments: [],
            participants: [],
            isDraft: false,
          }),
        ],
        test.nativeInput.messageChannelId,
        wrapped,
        test.principal.workspaceId,
        {
          canonicalThreadIdByThreadExternalId: new Map([
            [
              test.nativeInput.messageThreadExternalId,
              test.nativeInput.messageThreadId,
            ],
          ]),
        },
      );
      expect(test.saveParticipants).toHaveBeenCalledWith(
        [
          {
            messageId: test.messageId,
            workspaceMemberId: present
              ? test.nativeInput.workspaceMemberId
              : null,
            personId: null,
            handle: null,
            displayName: null,
            role: 'FROM',
          },
        ],
        test.principal.workspaceId,
        wrapped,
      );
      wrapped.getRepository('messageParticipant', {
        shouldBypassPermissionChecks: true,
      });
      expect(test.scope.getRepository).toHaveBeenCalledWith(
        'messageParticipant',
        { shouldBypassPermissionChecks: true },
        { shouldSkipEventEmission: true },
      );
      expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
        commitOutcome: 'strict',
      });
      expect(failureAudit).not.toHaveBeenCalled();
    },
  );

  it('snapshots request and callbacks before workspace loading', async () => {
    const test = fixture();
    const originalProof = structuredClone(test.proof);
    const originalPrincipal = structuredClone(test.principal);
    const replacement = jest.fn(async () => undefined);
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      test.proof.receiptId = randomUUID();
      test.proof.leaseToken = '99';
      test.principal.actor.id = 'changed';
      Reflect.set(test.callbacks, 'authorize', replacement);
      Reflect.set(test.callbacks, 'verifyEvidence', replacement);
      return work();
    });
    await test.run();
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      originalPrincipal,
      originalProof,
      expect.objectContaining({
        authorize: expect.any(Function),
        verifyEvidence: test.verifyEvidence,
      }),
      expect.anything(),
    );
    expect(test.authorize).toHaveBeenCalled();
    expect(test.verifyEvidence).toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });

  it('captures callback getters once', async () => {
    const test = fixture();
    let authorizeReads = 0;
    let verifierReads = 0;
    Object.defineProperty(test.callbacks, 'authorize', {
      get: () => (++authorizeReads === 1 ? test.authorize : undefined),
    });
    Object.defineProperty(test.callbacks, 'verifyEvidence', {
      get: () => (++verifierReads === 1 ? test.verifyEvidence : undefined),
    });
    await test.run();
    expect(authorizeReads).toBe(1);
    expect(verifierReads).toBe(1);
  });

  it.each([
    'foreign workspace',
    'missing mapping',
    'reused message',
    'created thread',
    'missing participant',
  ] as const)('rejects %s native results', async (reason) => {
    const test = fixture();
    if (reason === 'foreign workspace')
      Reflect.set(test.nativeInput, 'workspaceId', randomUUID());
    if (reason === 'missing mapping')
      test.nativeResult.messageExternalIdToMessageThreadIdMap.clear();
    if (reason === 'reused message') test.nativeResult.createdMessages = [];
    if (reason === 'created thread')
      test.nativeResult.createdMessageThreadIds.push(
        test.nativeInput.messageThreadId,
      );
    if (reason === 'missing participant')
      test.saveParticipants.mockResolvedValue([]);
    await expect(test.run()).rejects.toThrow('OMNI_SENT_APPLY_NATIVE_');
    expect(failureAudit).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.proof,
      expect.any(String),
      false,
    );
    if (reason !== 'missing participant')
      expect(test.saveParticipants).not.toHaveBeenCalled();
  });

  it('records current authorization denial only after rollback', async () => {
    const test = fixture();
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
      test.proof,
      expect.any(String),
      true,
    );
    expect(test.saveMessages).not.toHaveBeenCalled();
  });

  it('classifies evidence rejection as failed rather than permission denial', async () => {
    const test = fixture();
    const error = new Error('unqualified outcome');
    test.verifyEvidence.mockRejectedValue(error);
    await expect(test.run()).rejects.toBe(error);
    expect(failureAudit).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.proof,
      expect.any(String),
      false,
    );
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'does not append failure audit after unknown %s',
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
      await expect(test.run()).rejects.toBe(error);
      expect(failureAudit).not.toHaveBeenCalled();
    },
  );

  it('surfaces both operation and negative audit failures', async () => {
    const test = fixture();
    const error = new Error('operation');
    const audit = new Error('audit');
    test.verifyEvidence.mockRejectedValue(error);
    failureAudit.mockRejectedValue(audit);
    await expect(test.run()).rejects.toMatchObject({
      message: 'OMNI_SENT_APPLY_FAILURE_AUDIT_UNCONFIRMED',
      errors: [error, audit],
    });
  });

  it('does not audit a failure before entering the transaction callback', async () => {
    const test = fixture();
    const error = new Error('connection');
    test.transaction.mockRejectedValue(error);
    await expect(test.run()).rejects.toBe(error);
    expect(failureAudit).not.toHaveBeenCalled();
  });

  it('replays without calling native persistence again', async () => {
    const test = fixture();
    apply.mockResolvedValue({ ...test.result, created: false });
    await expect(test.run()).resolves.toMatchObject({ created: false });
    expect(test.saveMessages).not.toHaveBeenCalled();
    expect(test.saveParticipants).not.toHaveBeenCalled();
    expect(failureAudit).not.toHaveBeenCalled();
  });
});
