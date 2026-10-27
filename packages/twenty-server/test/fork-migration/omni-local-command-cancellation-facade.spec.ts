import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniLocalCommandCancellationFailure } from 'src/modules/omnichannel/services/append-omni-local-command-cancellation-failure';
import { cancelOmniLocalHumanCommand } from 'src/modules/omnichannel/services/cancel-omni-local-human-command';

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
  'src/modules/omnichannel/services/append-omni-local-command-cancellation-failure',
  () => ({ appendOmniLocalCommandCancellationFailure: jest.fn() }),
);
jest.mock(
  'src/modules/omnichannel/services/cancel-omni-local-human-command',
  () => ({
    ...jest.requireActual<
      typeof import('src/modules/omnichannel/services/cancel-omni-local-human-command')
    >('src/modules/omnichannel/services/cancel-omni-local-human-command'),
    cancelOmniLocalHumanCommand: jest.fn(),
  }),
);
const cancel = jest.mocked(cancelOmniLocalHumanCommand),
  failure = jest.mocked(appendOmniLocalCommandCancellationFailure);
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
    commandId: randomUUID(),
  };
  const scopes: WorkspaceTransactionScope[] = [];
  const events: string[] = [];
  const transaction = jest.fn(
    async (work: (scope: WorkspaceTransactionScope) => Promise<unknown>) => {
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
      scopes.push(scope);
      events.push('begin');
      try {
        const value = await work(scope);
        events.push('commit');
        return value;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  );
  const context = jest.fn(async (work: () => Promise<unknown>) => work());
  const service = new MessagingSaveMessagesAndEnqueueContactCreationService(
    {} as Dependencies[0],
    {} as Dependencies[1],
    {} as Dependencies[2],
    {} as Dependencies[3],
    {
      executeInWorkspaceContext: context,
      runInWorkspaceTransaction: transaction,
    } as unknown as Dependencies[4],
    {} as Dependencies[5],
  );
  const authorizeRead = jest.fn(async () => {}),
    authorizeDelegatedCancel = jest.fn(async () => {});
  const callbacks = { authorizeRead, authorizeDelegatedCancel };
  cancel.mockImplementation(async (scope, _principal, _input, captured) => {
    await Reflect.apply(captured.authorizeRead, undefined, [
      scope,
      { action: 'fixture' },
    ]);
    if (!captured.authorizeDelegatedCancel)
      throw new Error('Fixture delegated grant missing');
    await Reflect.apply(captured.authorizeDelegatedCancel, undefined, [
      scope,
      { action: 'fixture' },
    ]);
    return {
      cancelled: false,
      commandId: _input.commandId,
      reason: 'requires_reconciliation',
    };
  });
  failure.mockImplementation(async () => {
    events.push('audit');
  });
  return {
    principal,
    input,
    callbacks,
    authorizeRead,
    authorizeDelegatedCancel,
    context,
    transaction,
    scopes,
    events,
    service,
    run: () => service.cancelOmniLocalHumanCommand(principal, input, callbacks),
  };
};
beforeEach(() => jest.resetAllMocks());
it('rejects malformed mutation input before opening a context', async () => {
  const test = fixture();
  Reflect.set(test.input, 'state', 'sent');
  await expect(test.run()).rejects.toThrow();
  expect(test.context).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
});
it('uses the same strict scope and never writes an audit for an ordinary no-op', async () => {
  const test = fixture();
  await expect(test.run()).resolves.toEqual({
    cancelled: false,
    commandId: test.input.commandId,
    reason: 'requires_reconciliation',
  });
  expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
    commitOutcome: 'strict',
  });
  expect(cancel.mock.calls[0][0]).toBe(test.scopes[0]);
  expect(failure).not.toHaveBeenCalled();
  expect(test.events).toEqual(['begin', 'commit']);
});
it.each(['authorizeRead', 'authorizeDelegatedCancel'] as const)(
  'writes failure on a fresh strict scope after %s rollback',
  async (which) => {
    const test = fixture();
    test[which].mockRejectedValueOnce(Error('fixture denied'));
    await expect(test.run()).rejects.toThrow('fixture denied');
    expect(test.events).toEqual([
      'begin',
      'rollback',
      'begin',
      'audit',
      'commit',
    ]);
    expect(failure.mock.calls[0][0]).toBe(test.scopes[1]);
    expect(failure.mock.calls[0][0]).not.toBe(test.scopes[0]);
    expect(failure.mock.calls[0][4]).toBe(true);
  },
);
it('does not write a failed attempt when no transaction callback was entered', async () => {
  const test = fixture();
  test.transaction.mockRejectedValueOnce(Error('connection failed'));
  await expect(test.run()).rejects.toThrow('connection failed');
  expect(failure).not.toHaveBeenCalled();
});
it('keeps both original failure and audit failure visible', async () => {
  const test = fixture();
  cancel.mockRejectedValueOnce(Error('first'));
  failure.mockRejectedValueOnce(Error('second'));
  const error = await test.run().catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AggregateError);
  if (error instanceof AggregateError)
    expect(error.errors.map((item: Error) => item.message)).toEqual([
      'first',
      'second',
    ]);
});
it.each(['commit', 'rollback', 'release'] as const)(
  'propagates unknown %s outcome without a false failure audit',
  async (phase) => {
    const test = fixture();
    const error = new NativeTransactionOutcomeUnknownError(
      phase,
      Error('unknown'),
    );
    cancel.mockRejectedValueOnce(error);
    await expect(test.run()).rejects.toBe(error);
    expect(failure).not.toHaveBeenCalled();
  },
);
it('snapshots mutable request and callback references before awaiting context', async () => {
  const test = fixture();
  const principal = structuredClone(test.principal),
    input = { ...test.input };
  const authorizeRead = test.authorizeRead,
    qualify = test.authorizeDelegatedCancel;
  test.context.mockImplementationOnce(async (work) => {
    test.principal.workspaceMemberId = randomUUID();
    test.input.commandId = randomUUID();
    test.callbacks.authorizeRead = jest.fn(async () => {
      throw Error('mutated');
    });
    test.callbacks.authorizeDelegatedCancel = jest.fn(async () => {
      throw Error('mutated');
    });
    return work();
  });
  await test.run();
  expect(cancel.mock.calls[0][1]).toEqual(principal);
  expect(cancel.mock.calls[0][2]).toEqual(input);
  expect(authorizeRead).toHaveBeenCalledTimes(1);
  expect(qualify).toHaveBeenCalledTimes(1);
});
