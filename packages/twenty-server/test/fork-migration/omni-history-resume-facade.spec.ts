import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { appendOmniHistoryResumeFailure } from 'src/modules/omnichannel/services/append-omni-history-resume-failure';
import { type OmniHistoryApplyScope } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import {
  resumeOmniBlockedHistoryReceipts,
  type OmniBlockedHistoryResumeAuthorizer,
} from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';

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
  'src/modules/omnichannel/services/append-omni-history-resume-failure',
  () => ({
    appendOmniHistoryResumeFailure: jest.fn(),
  }),
);
jest.mock(
  'src/modules/omnichannel/services/resume-omni-blocked-history-receipts',
  () => ({
    ...jest.requireActual<
      typeof import('src/modules/omnichannel/services/resume-omni-blocked-history-receipts')
    >('src/modules/omnichannel/services/resume-omni-blocked-history-receipts'),
    resumeOmniBlockedHistoryReceipts: jest.fn(),
  }),
);

const resume = jest.mocked(resumeOmniBlockedHistoryReceipts);
const auditFailure = jest.mocked(appendOmniHistoryResumeFailure);

const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingSaveMessagesAndEnqueueContactCreationService
  >;
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'resume-test-worker' },
  };
  const input = {
    routeGeneration: '1',
    limit: 5,
    after: { nextAttemptAt: '2026-10-27T10:00:00.123456Z', id: randomUUID() },
  };
  const scope: OmniHistoryApplyScope = {
    workspaceId: principal.workspaceId,
    executeRawQuery: jest.fn().mockResolvedValue([]),
  };
  const events: string[] = [];
  const transaction = jest.fn(
    async (callback: (value: OmniHistoryApplyScope) => Promise<unknown>) => {
      events.push('begin');
      try {
        const result = await callback(scope);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  );
  const context = jest.fn(async (callback: () => Promise<unknown>) =>
    callback(),
  );
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
      ReturnType<OmniBlockedHistoryResumeAuthorizer>,
      Parameters<OmniBlockedHistoryResumeAuthorizer>
    >()
    .mockResolvedValue(undefined);
  const descriptor: Parameters<OmniBlockedHistoryResumeAuthorizer>[1] = {
    ...principal,
    action: 'history.resume',
    routeGeneration: '1',
    bindingRevision: '1',
    policyId: randomUUID(),
    policyVersion: '0',
  };
  const result = {
    scannedCount: 0,
    resumedReceiptIds: [],
    nextCursor: null,
    needsRescan: false,
  };
  resume.mockImplementation(
    async (nativeScope, _principal, _input, callback) => {
      await callback(nativeScope, descriptor);
      return result;
    },
  );
  auditFailure.mockImplementation(async () => {
    events.push('audit');
  });
  return {
    service,
    principal,
    input,
    scope,
    events,
    transaction,
    context,
    authorize,
    result,
  };
};

beforeEach(() => jest.resetAllMocks());

describe('blocked history resume transaction facade', () => {
  it('snapshots nested input and principal before waiting for workspace context', async () => {
    const test = fixture();
    const expectedPrincipal = structuredClone(test.principal);
    const expectedInput = structuredClone(test.input);
    test.context.mockImplementation(async (callback) => {
      await Promise.resolve();
      test.input.after.id = randomUUID();
      test.input.after.nextAttemptAt = '2026-10-28T00:00:00.000001Z';
      test.input.routeGeneration = '99';
      test.principal.bindingId = randomUUID();
      test.principal.actor.id = 'replacement';
      return callback();
    });

    await expect(
      test.service.resumeOmniBlockedHistoryReceipts(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).resolves.toEqual(test.result);
    expect(resume).toHaveBeenCalledWith(
      test.scope,
      expectedPrincipal,
      expectedInput,
      expect.any(Function),
    );
    expect(test.transaction).toHaveBeenCalledWith(expect.any(Function), {
      commitOutcome: 'strict',
    });
    expect(auditFailure).not.toHaveBeenCalled();
  });

  it('records authorization denial only in a fresh transaction after rollback', async () => {
    const test = fixture();
    const denied = new Error('current grant revoked');
    test.authorize.mockRejectedValue(denied);

    await expect(
      test.service.resumeOmniBlockedHistoryReceipts(
        test.principal,
        test.input,
        test.authorize,
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
      true,
    );
  });

  it.each(['commit', 'rollback', 'release'] as const)(
    'never appends a false failure audit after an unknown %s outcome',
    async (phase) => {
      const test = fixture();
      const unknown = new NativeTransactionOutcomeUnknownError(
        phase,
        new Error('lost acknowledgement'),
      );
      test.transaction.mockImplementationOnce(async (callback) => {
        await callback(test.scope);
        throw unknown;
      });

      await expect(
        test.service.resumeOmniBlockedHistoryReceipts(
          test.principal,
          test.input,
          test.authorize,
        ),
      ).rejects.toBe(unknown);
      expect(auditFailure).not.toHaveBeenCalled();
      expect(test.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the original failure and the failed attempt-audit outcome', async () => {
    const test = fixture();
    const failure = new Error('receipt update failed');
    const auditError = new Error('audit unavailable');
    resume.mockRejectedValue(failure);
    auditFailure.mockRejectedValue(auditError);

    const result = await test.service
      .resumeOmniBlockedHistoryReceipts(
        test.principal,
        test.input,
        test.authorize,
      )
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result).toMatchObject({
      message: 'OMNI_HISTORY_RESUME_FAILURE_AUDIT_UNCONFIRMED',
      errors: [failure, auditError],
    });
    expect(auditFailure).toHaveBeenCalledWith(
      test.scope,
      test.principal,
      expect.any(String),
      false,
    );
  });

  it('does not audit a transaction that never entered its callback', async () => {
    const test = fixture();
    const failure = new Error('connection unavailable');
    test.transaction.mockRejectedValue(failure);

    await expect(
      test.service.resumeOmniBlockedHistoryReceipts(
        test.principal,
        test.input,
        test.authorize,
      ),
    ).rejects.toBe(failure);
    expect(resume).not.toHaveBeenCalled();
    expect(auditFailure).not.toHaveBeenCalled();
  });
});
