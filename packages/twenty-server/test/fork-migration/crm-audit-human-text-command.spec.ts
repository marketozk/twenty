import { randomUUID } from 'node:crypto';

import { appendCrmAuditEntry } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditMutation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

jest.mock('src/engine/core-modules/crm-audit/append-crm-audit-entry', () => ({
  appendCrmAuditEntry: jest.fn(async () => undefined),
}));
jest.mock(
  'src/engine/core-modules/crm-audit/verify-crm-audit-privileges',
  () => ({ verifyCrmAuditPrivileges: jest.fn(async () => undefined) }),
);
const append = jest.mocked(appendCrmAuditEntry);
const fixture = () => {
  const operation = {
    workspaceId: randomUUID(),
    operationId: randomUUID(),
    actor: { kind: 'workspaceMember' as const, id: randomUUID() },
  };
  const executor = {
    workspaceId: operation.workspaceId,
    isTransactionActive: true,
    isReleased: false,
    query: jest.fn(async () => []),
  };
  return {
    operation,
    executor,
    context: new CrmAuditTransactionContext(executor, operation),
  };
};
const mutation = (): CrmAuditMutation => {
  const resourceId = randomUUID();
  const conversationId = randomUUID();
  return {
    resourceKind: 'omniOutgoingCommand',
    resourceId,
    action: 'create',
    before: null,
    after: {
      conversationId,
      actorKind: 'workspaceMember',
      actorId: 'private-command-author',
      initiatingActorId: 'private-initiator',
      senderClass: 'human',
      contentProvenance: 'human_direct',
      payloadHash: 'a'.repeat(64),
      generation: '1',
      policyId: randomUUID(),
      policyVersion: '0',
      outboundSequence: '2',
      state: 'pending',
      statusRevision: '1',
      expectedAutomationEpoch: null,
      referenceId: null,
      nextAttemptAt: '2026-10-27T10:00:00.123456Z',
      idempotencyKey: 'private-client-key',
      payload: {
        text: 'private-customer-message',
        target: 'private-provider-target',
      },
      resolvedReplyNativeRef: { providerMessageId: 'private-provider-reply' },
      workflowCancellationRefs: [{ key: 'private-workflow-reference' }],
      cancelEvidence: { proof: 'private-cancel-evidence' },
      connectorAcceptedEvidence: { proof: 'private-connector-evidence' },
    },
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId,
      bindingId: randomUUID(),
      conversationId,
    },
  };
};
beforeEach(() => jest.clearAllMocks());

describe('human command audit catalog', () => {
  it('records admission metadata and hashes private payload and transport identity', async () => {
    const test = fixture();
    test.context.record(mutation());
    await test.context.flush();
    const entry = append.mock.calls[0][1];
    expect(entry.resourceKind).toBe('omniOutgoingCommand');
    expect(entry.redactedDiff.values).toMatchObject({
      state: { after: 'pending' },
      senderClass: { after: 'human' },
      outboundSequence: { after: '2' },
      policyVersion: { after: '0' },
    });
    for (const key of [
      'actorId',
      'initiatingActorId',
      'idempotencyKey',
      'payload',
      'workflowCancellationRefs',
      'resolvedReplyNativeRef',
      'connectorAcceptedEvidence',
      'cancelEvidence',
    ]) {
      expect(entry.redactedDiff.changedFields).toContain(key);
      expect(entry.redactedDiff.values).not.toHaveProperty(key);
    }
    expect(JSON.stringify(entry)).not.toContain('private-');
  });

  it.each(['bindingId', 'conversationId'] as const)(
    'rejects missing %s in success and attempt descriptors',
    async (field) => {
      const test = fixture();
      const change = mutation();
      delete change.securityDescriptor[field];
      expect(() => test.context.record(change)).toThrow(
        'binding and conversation',
      );
      await expect(
        appendCrmAuditAttempt(test.executor, test.operation, {
          attemptId: randomUUID(),
          resourceKind: change.resourceKind,
          resourceId: change.resourceId,
          action: 'create',
          outcome: 'denied',
          reasonCode: 'command.admit.denied',
          securityDescriptor: change.securityDescriptor,
        }),
      ).rejects.toThrow('binding and conversation');
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('rejects resource identity substitution', () => {
    const test = fixture();
    const change = mutation();
    change.securityDescriptor.resourceId = randomUUID();
    expect(() => test.context.record(change)).toThrow('does not match');
  });

  it('captures admission snapshot before caller mutation', async () => {
    const test = fixture();
    const change = mutation();
    test.context.record(change);
    change.after!.state = 'sent';
    change.after!.payload = { text: 'replacement-private-message' };
    await test.context.flush();
    expect(append.mock.calls[0][1].redactedDiff.values.state.after).toBe(
      'pending',
    );
    expect(JSON.stringify(append.mock.calls[0][1])).not.toContain(
      'replacement-private-message',
    );
  });

  it('does not permit a binding-only ordinary command event', () => {
    const test = fixture();
    const change = mutation();
    change.resourceKind = 'omniDomainEvent';
    change.securityDescriptor.resourceKind = 'omniDomainEvent';
    delete change.securityDescriptor.conversationId;
    change.after = {
      kind: 'command.created',
      origin: 'human_composer',
      payloadVersion: 1,
      payload: { commandId: randomUUID() },
    };
    expect(() => test.context.record(change)).toThrow(
      'binding and conversation',
    );
  });
});
