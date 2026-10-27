import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniHumanTextCommandFailure } from 'src/modules/omnichannel/services/append-omni-human-text-command-failure';
import {
  admitOmniHumanTextCommand,
  isOmniHumanTextCommandAuthorizationError,
  type OmniHumanTextCommandAuthorizer,
  type OmniHumanTextCommandScope,
} from 'src/modules/omnichannel/services/admit-omni-human-text-command';

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
  'src/modules/omnichannel/services/append-omni-human-text-command-failure',
  () => ({ appendOmniHumanTextCommandFailure: jest.fn() }),
);
jest.mock(
  'src/modules/omnichannel/services/admit-omni-human-text-command',
  () => ({
    ...jest.requireActual<
      typeof import('src/modules/omnichannel/services/admit-omni-human-text-command')
    >('src/modules/omnichannel/services/admit-omni-human-text-command'),
    admitOmniHumanTextCommand: jest.fn(),
    isOmniHumanTextCommandAuthorizationError: jest.fn(),
  }),
);
const admit = jest.mocked(admitOmniHumanTextCommand);
const auditFailure = jest.mocked(appendOmniHumanTextCommandFailure);
const isAuthorizationError = jest.mocked(
  isOmniHumanTextCommandAuthorizationError,
);
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    workspaceMemberId: randomUUID(),
  };
  const input = {
    conversationId: randomUUID(),
    text: 'Test customer reply',
    idempotencyKey: randomUUID(),
    expectedControlEpoch: '1',
    observedReplyRevision: '2',
  };
  const scope: OmniHumanTextCommandScope = {
    workspaceId: principal.workspaceId,
    transactionLifecycle: {
      isTransactionActive: true,
      isReleased: false,
      commitOutcome: 'strict',
    },
    executeRawQuery: jest.fn().mockResolvedValue([]),
  };
  const events: string[] = [];
  const transaction = jest.fn(
    async (work: (value: OmniHumanTextCommandScope) => Promise<unknown>) => {
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
      ReturnType<OmniHumanTextCommandAuthorizer>,
      Parameters<OmniHumanTextCommandAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const descriptor: Parameters<OmniHumanTextCommandAuthorizer>[1] = {
    ...principal,
    action: 'command.admit',
    bindingId: randomUUID(),
    conversationId: input.conversationId,
    queueId: randomUUID(),
    routeGeneration: '1',
    policyId: randomUUID(),
    policyVersion: '0',
    mode: 'human',
    status: 'open',
    command: input,
    replay: false,
  };
  const result = {
    commandId: randomUUID(),
    state: 'pending' as const,
    replyRevision: '3',
    controlEpoch: '1',
    mode: 'human' as const,
    created: true,
  };
  admit.mockImplementation(
    async (nativeScope, _principal, _input, callback) => {
      await callback(nativeScope, descriptor);
      return result;
    },
  );
  auditFailure.mockImplementation(async () => {
    events.push('audit');
  });
  isAuthorizationError.mockReturnValue(false);
  return {
    principal,
    input,
    scope,
    events,
    transaction,
    context,
    service,
    authorize,
    result,
    descriptor,
  };
};
beforeEach(() => jest.resetAllMocks());

describe('human text command admission transaction owner', () => {
  it('uses the actual strict scope and snapshots input before context loading', async () => {
    const test = fixture();
    const expected = structuredClone({
      principal: test.principal,
      input: test.input,
    });
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      test.input.text = 'changed text';
      test.input.conversationId = randomUUID();
      test.input.idempotencyKey = randomUUID();
      test.input.observedReplyRevision = '99';
      test.principal.userId = randomUUID();
      test.principal.workspaceMemberId = randomUUID();
      return work();
    });
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).resolves.toEqual(test.result);
    expect(admit).toHaveBeenCalledWith(
      test.scope,
      expected.principal,
      expected.input,
      expect.any(Function),
    );
    expect(test.authorize).toHaveBeenCalledWith(test.scope, test.descriptor);
    expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
      commitOutcome: 'strict',
    });
    expect(auditFailure).not.toHaveBeenCalled();
  });

  it('preserves the result of an accepted replay without adding a new attempt', async () => {
    const test = fixture();
    test.result.created = false;
    admit.mockImplementation(async (scope, _principal, _input, callback) => {
      await callback(scope, { ...test.descriptor, replay: true });
      return test.result;
    });
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).resolves.toEqual(test.result);
    expect(test.authorize).toHaveBeenCalledTimes(1);
    expect(auditFailure).not.toHaveBeenCalled();
  });

  it('records callback denial only after confirmed rollback', async () => {
    const test = fixture();
    const error = new Error('grant revoked');
    test.authorize.mockRejectedValue(error);
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(test.events).toEqual([
      'begin',
      'rollback',
      'begin',
      'audit',
      'commit',
    ]);
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      true,
    );
  });

  it('classifies a retained membership denial using the issued-error predicate', async () => {
    const test = fixture();
    const error = new Error('issued membership error');
    admit.mockRejectedValue(error);
    isAuthorizationError.mockImplementation((candidate) => candidate === error);
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      true,
    );
    expect(test.authorize).not.toHaveBeenCalled();
  });

  it('does not infer authorization denial from an error message', async () => {
    const test = fixture();
    const error = new Error('OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED');
    admit.mockRejectedValue(error);
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      false,
    );
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'does not append failed audit after unknown %s',
    async (phase) => {
      const test = fixture();
      const error = new NativeTransactionOutcomeUnknownError(
        phase,
        new Error('lost ACK'),
      );
      test.transaction.mockImplementationOnce(async (work) => {
        await work(test.scope);
        throw error;
      });
      await expect(
        test.service.admitOmniHumanTextCommand(
          test.principal,
          test.input,
          test.authorize,
        ),
      ).rejects.toBe(error);
      expect(auditFailure).not.toHaveBeenCalled();
      expect(test.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a failure and its separate audit failure', async () => {
    const test = fixture();
    const error = new Error('write failed');
    const auditError = new Error('audit failed');
    admit.mockRejectedValue(error);
    auditFailure.mockRejectedValue(auditError);
    const result = await test.service
      .admitOmniHumanTextCommand(test.principal, test.input, test.authorize)
      .catch((failure: unknown) => failure);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result).toMatchObject({
      message: 'OMNI_HUMAN_COMMAND_FAILURE_AUDIT_UNCONFIRMED',
      errors: [error, auditError],
    });
    for (const call of test.transaction.mock.calls)
      expect(call).toEqual([expect.any(Function), { commitOutcome: 'strict' }]);
  });

  it('does not audit connection failure before callback entry', async () => {
    const test = fixture();
    const error = new Error('connection failed');
    test.transaction.mockRejectedValue(error);
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(admit).not.toHaveBeenCalled();
    expect(auditFailure).not.toHaveBeenCalled();
  });

  it('rejects an empty message before opening context or transaction', async () => {
    const test = fixture();
    test.input.text = '  ';
    await expect(
      test.service.admitOmniHumanTextCommand(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toThrow();
    expect(test.context).not.toHaveBeenCalled();
    expect(auditFailure).not.toHaveBeenCalled();
  });
});
