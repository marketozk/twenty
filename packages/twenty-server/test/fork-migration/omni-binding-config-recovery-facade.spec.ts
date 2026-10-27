import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniBindingConfigWakeupFailure } from 'src/modules/omnichannel/services/append-omni-binding-config-wakeup-failure';
import {
  claimOmniBindingConfigWakeups,
  housekeepOmniBindingConfigWakeups,
  processOmniBindingConfigWakeupPage,
  rearmOmniBindingConfigWakeup,
  reconcileOmniBindingConfigWakeups,
  type OmniBindingConfigRecoveryCommand,
  type OmniBindingConfigWakeupAuthorizer,
  type OmniBindingConfigWakeupScope,
} from 'src/modules/omnichannel/services/omni-binding-config-wakeup';
import { type OmniBlockedHistoryResumeAuthorizer } from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';

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
  'src/modules/omnichannel/services/append-omni-binding-config-wakeup-failure',
  () => ({ appendOmniBindingConfigWakeupFailure: jest.fn() }),
);
jest.mock(
  'src/modules/omnichannel/services/omni-binding-config-wakeup',
  () => ({
    ...jest.requireActual<
      typeof import('src/modules/omnichannel/services/omni-binding-config-wakeup')
    >('src/modules/omnichannel/services/omni-binding-config-wakeup'),
    claimOmniBindingConfigWakeups: jest.fn(),
    housekeepOmniBindingConfigWakeups: jest.fn(),
    processOmniBindingConfigWakeupPage: jest.fn(),
    rearmOmniBindingConfigWakeup: jest.fn(),
    reconcileOmniBindingConfigWakeups: jest.fn(),
  }),
);

const claim = jest.mocked(claimOmniBindingConfigWakeups);
const processPage = jest.mocked(processOmniBindingConfigWakeupPage);
const reconcile = jest.mocked(reconcileOmniBindingConfigWakeups);
const rearm = jest.mocked(rearmOmniBindingConfigWakeup);
const housekeeping = jest.mocked(housekeepOmniBindingConfigWakeups);
const auditFailure = jest.mocked(appendOmniBindingConfigWakeupFailure);
const operations = [
  'claim',
  'process',
  'reconcile',
  'rearm',
  'housekeeping',
] as const;

const commandFor = (
  operation: (typeof operations)[number],
): OmniBindingConfigRecoveryCommand => {
  switch (operation) {
    case 'claim':
      return {
        operation,
        input: { leaseOwner: randomUUID(), limit: 2, leaseMilliseconds: 10000 },
      };
    case 'process':
      return {
        operation,
        proof: {
          wakeupId: randomUUID(),
          leaseOwner: randomUUID(),
          leaseToken: '1',
        },
        input: { limit: 2 },
      };
    case 'reconcile':
      return {
        operation,
        input: {
          limit: 2,
          after: { createdAt: '2026-10-27T10:00:00.123456Z', id: randomUUID() },
        },
      };
    case 'rearm':
      return { operation, wakeupId: randomUUID() };
    case 'housekeeping':
      return { operation };
  }
};
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'recovery-worker' },
  };
  const scope: OmniBindingConfigWakeupScope = {
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
    async (work: (scope: OmniBindingConfigWakeupScope) => Promise<unknown>) => {
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
      ReturnType<OmniBindingConfigWakeupAuthorizer>,
      Parameters<OmniBindingConfigWakeupAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const authorizeResume = jest
    .fn<
      ReturnType<OmniBlockedHistoryResumeAuthorizer>,
      Parameters<OmniBlockedHistoryResumeAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const descriptor = {
    ...principal,
    action: 'config_wakeup.claim' as const,
    routeGeneration: '1',
    bindingRevision: '1',
  };
  claim.mockImplementation(
    async (nativeScope, _principal, _input, callback) => {
      await callback(nativeScope, descriptor);
      return [];
    },
  );
  reconcile.mockImplementation(
    async (nativeScope, _principal, _input, callback) => {
      await callback(nativeScope, {
        ...descriptor,
        action: 'config_wakeup.reconcile',
      });
      return {
        scannedCount: 0,
        enqueuedIds: [],
        invalidEventIds: [],
        nextCursor: null,
      };
    },
  );
  rearm.mockImplementation(async (nativeScope, _principal, _id, callback) => {
    await callback(nativeScope, {
      ...descriptor,
      action: 'config_wakeup.rearm',
    });
    return true;
  });
  housekeeping.mockImplementation(async (nativeScope, _principal, callback) => {
    await callback(nativeScope, {
      ...descriptor,
      action: 'config_wakeup.housekeeping',
    });
    return { rearmed: false, wakeupId: null, reason: 'no_blocked_receipts' };
  });
  processPage.mockImplementation(
    async (
      nativeScope,
      _principal,
      proof,
      _input,
      callback,
      resumeCallback,
    ) => {
      await callback(nativeScope, {
        ...descriptor,
        action: 'config_wakeup.process',
        wakeupId: proof.wakeupId,
      });
      await resumeCallback(nativeScope, {
        ...principal,
        action: 'history.resume',
        routeGeneration: '1',
        bindingRevision: '1',
        policyId: randomUUID(),
        policyVersion: '0',
      });
      return {
        wakeupId: proof.wakeupId,
        state: 'completed',
        resumedReceiptIds: [],
        nextCursor: null,
        needsRescan: false,
      };
    },
  );
  auditFailure.mockImplementation(async () => {
    events.push('audit');
  });
  return {
    principal,
    scope,
    events,
    transaction,
    context,
    service,
    authorize,
    authorizeResume,
  };
};

beforeEach(() => jest.resetAllMocks());

describe('binding config recovery strict transaction facade', () => {
  it.each(operations)(
    'dispatches %s only through its typed leaf in a strict native transaction',
    async (operation) => {
      const test = fixture();
      const command = commandFor(operation);
      const outcome = await test.service.executeOmniBindingConfigRecovery(
        test.principal,
        command,
        test.authorize,
        test.authorizeResume,
      );
      expect(outcome.operation).toBe(operation);
      const calls = [claim, processPage, reconcile, rearm, housekeeping];
      expect(calls.map((mock) => mock.mock.calls.length)).toEqual(
        operations.map((name) => (name === operation ? 1 : 0)),
      );
      expect(test.authorize).toHaveBeenCalledWith(
        test.scope,
        expect.objectContaining({ action: `config_wakeup.${operation}` }),
      );
      expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
        commitOutcome: 'strict',
      });
      expect(test.events).toEqual(['begin', 'commit']);
      expect(auditFailure).not.toHaveBeenCalled();
      if (operation === 'process')
        expect(test.authorizeResume).toHaveBeenCalledWith(
          test.scope,
          expect.objectContaining({ action: 'history.resume' }),
        );
      else expect(test.authorizeResume).not.toHaveBeenCalled();
    },
  );

  it('snapshots nested command and actor before asynchronous context loading', async () => {
    const test = fixture();
    const command = {
      operation: 'process' as const,
      proof: {
        wakeupId: randomUUID(),
        leaseOwner: randomUUID(),
        leaseToken: '1',
      },
      input: { limit: 5 },
    };
    const expected = structuredClone({ principal: test.principal, command });
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      command.proof.wakeupId = randomUUID();
      command.proof.leaseToken = '99';
      command.input.limit = 99;
      test.principal.actor.id = 'replacement';
      test.principal.bindingId = randomUUID();
      return work();
    });
    await test.service.executeOmniBindingConfigRecovery(
      test.principal,
      command,
      test.authorize,
      test.authorizeResume,
    );
    expect(processPage).toHaveBeenCalledWith(
      test.scope,
      expected.principal,
      expected.command.proof,
      expected.command.input,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not reread callback accessors after awaiting context', async () => {
    const test = fixture();
    const authorizeGetter = jest.fn(() => test.authorize);
    const resumeGetter = jest.fn(() => test.authorizeResume);
    const callbacks = {
      get authorize() {
        return authorizeGetter();
      },
      get resume() {
        return resumeGetter();
      },
    };
    test.context.mockImplementation(async (work) => {
      Object.defineProperty(callbacks, 'authorize', {
        get: () => {
          throw new Error('reread authorizer');
        },
      });
      Object.defineProperty(callbacks, 'resume', {
        get: () => {
          throw new Error('reread resume');
        },
      });
      return work();
    });
    await test.service.executeOmniBindingConfigRecovery(
      test.principal,
      commandFor('process'),
      callbacks.authorize,
      callbacks.resume,
    );
    expect(authorizeGetter).toHaveBeenCalledTimes(1);
    expect(resumeGetter).toHaveBeenCalledTimes(1);
    expect(test.authorize).toHaveBeenCalledTimes(1);
    expect(test.authorizeResume).toHaveBeenCalledTimes(1);
  });

  it.each(operations)(
    'records denied %s only after confirmed rollback',
    async (operation) => {
      const test = fixture();
      const denied = new Error('grant revoked');
      test.authorize.mockRejectedValue(denied);
      await expect(
        test.service.executeOmniBindingConfigRecovery(
          test.principal,
          commandFor(operation),
          test.authorize,
          test.authorizeResume,
        ),
      ).rejects.toBe(denied);
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
        expect.any(String),
        operation,
        true,
      );
      expect(test.transaction.mock.calls).toHaveLength(2);
      for (const call of test.transaction.mock.calls)
        expect(call).toEqual([
          expect.any(Function),
          { commitOutcome: 'strict' },
        ]);
    },
  );

  it('classifies resume authorization denial as denied for the complete process operation', async () => {
    const test = fixture();
    const denied = new Error('history grant revoked');
    test.authorizeResume.mockRejectedValue(denied);
    await expect(
      test.service.executeOmniBindingConfigRecovery(
        test.principal,
        commandFor('process'),
        test.authorize,
        test.authorizeResume,
      ),
    ).rejects.toBe(denied);
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      expect.any(String),
      'process',
      true,
    );
    expect(test.events).toEqual([
      'begin',
      'rollback',
      'begin',
      'audit',
      'commit',
    ]);
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'does not create a false failure attempt after unknown %s',
    async (phase) => {
      const test = fixture();
      const unknown = new NativeTransactionOutcomeUnknownError(
        phase,
        new Error('acknowledgement lost'),
      );
      test.transaction.mockImplementationOnce(async (work) => {
        await work(test.scope);
        throw unknown;
      });
      await expect(
        test.service.executeOmniBindingConfigRecovery(
          test.principal,
          commandFor('claim'),
          test.authorize,
        ),
      ).rejects.toBe(unknown);
      expect(test.transaction).toHaveBeenCalledTimes(1);
      expect(auditFailure).not.toHaveBeenCalled();
    },
  );

  it('records ordinary failure after rollback without classifying it as denial', async () => {
    const test = fixture();
    const error = new Error('write failed');
    claim.mockRejectedValue(error);
    await expect(
      test.service.executeOmniBindingConfigRecovery(
        test.principal,
        commandFor('claim'),
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      expect.any(String),
      'claim',
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

  it('preserves both the original failure and unconfirmed failure audit', async () => {
    const test = fixture();
    const error = new Error('write failed');
    const auditError = new NativeTransactionOutcomeUnknownError(
      'commit',
      new Error('audit ACK lost'),
    );
    claim.mockRejectedValue(error);
    auditFailure.mockRejectedValue(auditError);
    const outcome = await test.service
      .executeOmniBindingConfigRecovery(
        test.principal,
        commandFor('claim'),
        test.authorize,
      )
      .catch((failure: unknown) => failure);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome).toMatchObject({
      message: 'OMNI_CONFIG_WAKEUP_FAILURE_AUDIT_UNCONFIRMED',
      errors: [error, auditError],
    });
    expect(auditFailure).toHaveBeenCalledTimes(1);
  });

  it('does not audit before the transaction callback was entered', async () => {
    const test = fixture();
    const error = new Error('connect failed');
    test.transaction.mockRejectedValue(error);
    await expect(
      test.service.executeOmniBindingConfigRecovery(
        test.principal,
        commandFor('claim'),
        test.authorize,
      ),
    ).rejects.toBe(error);
    expect(auditFailure).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('requires the process resume grant before context or transaction', async () => {
    const test = fixture();
    await expect(
      test.service.executeOmniBindingConfigRecovery(
        test.principal,
        commandFor('process'),
        test.authorize,
      ),
    ).rejects.toThrow();
    expect(test.context).not.toHaveBeenCalled();
    expect(test.transaction).not.toHaveBeenCalled();
    expect(auditFailure).not.toHaveBeenCalled();
  });

  it('rejects malformed command before context loading', async () => {
    const test = fixture();
    const command = {
      operation: 'claim' as const,
      input: { limit: 0, leaseOwner: randomUUID(), leaseMilliseconds: 10000 },
    };
    await expect(
      test.service.executeOmniBindingConfigRecovery(
        test.principal,
        command,
        test.authorize,
      ),
    ).rejects.toThrow();
    expect(test.context).not.toHaveBeenCalled();
    expect(auditFailure).not.toHaveBeenCalled();
  });
});
