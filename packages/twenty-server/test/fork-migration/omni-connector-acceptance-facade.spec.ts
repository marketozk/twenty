import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniConnectorAcceptanceFailure } from 'src/modules/omnichannel/services/append-omni-connector-acceptance-failure';
import {
  applyOmniConnectorAcceptance,
  type OmniConnectorAcceptanceCallbacks,
  type OmniConnectorAcceptanceScope,
} from 'src/modules/omnichannel/services/apply-omni-connector-acceptance';

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
  'src/modules/omnichannel/services/append-omni-connector-acceptance-failure',
  () => ({ appendOmniConnectorAcceptanceFailure: jest.fn() }),
);
jest.mock(
  'src/modules/omnichannel/services/apply-omni-connector-acceptance',
  () => ({
    ...jest.requireActual<
      typeof import('src/modules/omnichannel/services/apply-omni-connector-acceptance')
    >('src/modules/omnichannel/services/apply-omni-connector-acceptance'),
    applyOmniConnectorAcceptance: jest.fn(),
  }),
);

const apply = jest.mocked(applyOmniConnectorAcceptance);
const failureAudit = jest.mocked(appendOmniConnectorAcceptanceFailure);
const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture-reconciler' },
  };
  const input = {
    commandId: randomUUID(),
    providerChatId: 'fixture-chat',
    payloadHash: 'a'.repeat(64),
    generation: '1',
    connectorJobId: 'fixture-job',
    journalSequence: '0',
    qualification: {
      adapterId: 'fixture-adapter',
      adapterVersion: 'fixture-v1',
    },
  };
  const scope: OmniConnectorAcceptanceScope = {
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
    async (work: (value: OmniConnectorAcceptanceScope) => Promise<unknown>) => {
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
      ReturnType<OmniConnectorAcceptanceCallbacks['authorize']>,
      Parameters<OmniConnectorAcceptanceCallbacks['authorize']>
    >()
    .mockResolvedValue(undefined);
  const verifyEvidence = jest
    .fn<
      ReturnType<OmniConnectorAcceptanceCallbacks['verifyEvidence']>,
      Parameters<OmniConnectorAcceptanceCallbacks['verifyEvidence']>
    >()
    .mockResolvedValue(undefined);
  const callbacks: OmniConnectorAcceptanceCallbacks = {
    authorize,
    verifyEvidence,
  };
  const result = {
    commandId: input.commandId,
    state: 'accepted' as const,
    statusRevision: '3',
    applied: true,
  };
  // Scope/transaction tests only; real evidence descriptors are exercised by the PostgreSQL suite.
  const descriptor = Object.freeze({ fixture: 'owner-lifecycle-only' });
  apply.mockImplementation(
    async (nativeScope, _principal, _input, captured) => {
      await Reflect.apply(captured.authorize, undefined, [
        nativeScope,
        descriptor,
      ]);
      await Reflect.apply(captured.verifyEvidence, undefined, [
        nativeScope,
        descriptor,
      ]);
      return result;
    },
  );
  failureAudit.mockImplementation(async () => {
    events.push('audit');
  });
  return {
    principal,
    input,
    scope,
    events,
    transaction,
    context,
    service,
    authorize,
    verifyEvidence,
    callbacks,
    result,
    descriptor,
  };
};

beforeEach(() => jest.resetAllMocks());

describe('connector acceptance strict transaction owner', () => {
  it('snapshots nested proof metadata, worker and callbacks before context loading', async () => {
    const test = fixture();
    const expected = structuredClone({
      principal: test.principal,
      input: test.input,
    });
    const replacement = jest.fn(async () => undefined);
    test.context.mockImplementation(async (work) => {
      await Promise.resolve();
      test.input.commandId = randomUUID();
      test.input.qualification.adapterVersion = 'changed';
      test.input.journalSequence = '99';
      test.principal.actor.id = 'changed-worker';
      Reflect.set(test.callbacks, 'authorize', replacement);
      Reflect.set(test.callbacks, 'verifyEvidence', replacement);
      return work();
    });
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toEqual(test.result);
    expect(apply).toHaveBeenCalledWith(
      test.scope,
      expected.principal,
      expected.input,
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

  it('captures accessor callbacks once', async () => {
    const test = fixture();
    let authorizeReads = 0;
    let verifierReads = 0;
    Object.defineProperty(test.callbacks, 'authorize', {
      get: () => (++authorizeReads === 1 ? test.authorize : undefined),
    });
    Object.defineProperty(test.callbacks, 'verifyEvidence', {
      get: () => (++verifierReads === 1 ? test.verifyEvidence : undefined),
    });
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toEqual(test.result);
    expect(authorizeReads).toBe(1);
    expect(verifierReads).toBe(1);
    expect(test.authorize).toHaveBeenCalledTimes(1);
    expect(test.verifyEvidence).toHaveBeenCalledTimes(1);
  });

  it('returns an already-applied replay without another attempt audit', async () => {
    const test = fixture();
    apply.mockResolvedValue({ ...test.result, applied: false });
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).resolves.toMatchObject({ applied: false });
    expect(failureAudit).not.toHaveBeenCalled();
    expect(test.events).toEqual(['begin', 'commit']);
  });

  it('records denial only after confirmed rollback', async () => {
    const test = fixture();
    const error = new Error('reconciliation grant revoked');
    test.authorize.mockRejectedValue(error);
    await expect(
      test.service.applyOmniConnectorAcceptance(
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
    expect(failureAudit).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      true,
    );
  });

  it('records evidence-verifier errors as failed, not as grant denial', async () => {
    const test = fixture();
    const error = new Error('journal proof mismatch');
    test.verifyEvidence.mockRejectedValue(error);
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(failureAudit).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      test.input,
      expect.any(String),
      false,
    );
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'never emits failed audit after unknown %s',
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
        test.service.applyOmniConnectorAcceptance(
          test.principal,
          test.input,
          test.callbacks,
        ),
      ).rejects.toBe(error);
      expect(failureAudit).not.toHaveBeenCalled();
      expect(test.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('retains both original failure and unconfirmed negative audit', async () => {
    const test = fixture();
    const original = new Error('write failed');
    const audit = new Error('audit failed');
    apply.mockRejectedValue(original);
    failureAudit.mockRejectedValue(audit);
    const error = await test.service
      .applyOmniConnectorAcceptance(test.principal, test.input, test.callbacks)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: 'OMNI_CONNECTOR_ACCEPTANCE_FAILURE_AUDIT_UNCONFIRMED',
      errors: [original, audit],
    });
  });

  it('does not manufacture failure audit when no transaction callback ran', async () => {
    const test = fixture();
    const error = new Error('connection unavailable');
    test.transaction.mockRejectedValue(error);
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toBe(error);
    expect(apply).not.toHaveBeenCalled();
    expect(failureAudit).not.toHaveBeenCalled();
  });

  it('rejects negative journal sequence before context loading', async () => {
    const test = fixture();
    test.input.journalSequence = '-1';
    await expect(
      test.service.applyOmniConnectorAcceptance(
        test.principal,
        test.input,
        test.callbacks,
      ),
    ).rejects.toThrow();
    expect(test.context).not.toHaveBeenCalled();
    expect(failureAudit).not.toHaveBeenCalled();
  });
});
