import { randomUUID } from 'node:crypto';

import { appendCrmAuditEntry } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { appendOmniSentReceiptFailure } from 'src/modules/omnichannel/services/append-omni-sent-receipt-failure';

jest.mock('src/engine/core-modules/crm-audit/append-crm-audit-entry', () => ({
  appendCrmAuditEntry: jest.fn(async () => undefined),
}));
jest.mock(
  'src/engine/core-modules/crm-audit/verify-crm-audit-privileges',
  () => ({ verifyCrmAuditPrivileges: jest.fn(async () => undefined) }),
);

const append = jest.mocked(appendCrmAuditEntry);
beforeEach(() => jest.clearAllMocks());

it('redacts sent envelope/capture/event identifiers while preserving receipt state', async () => {
  const workspaceId = randomUUID();
  const bindingId = randomUUID();
  const receiptId = randomUUID();
  const executor = {
    workspaceId,
    isTransactionActive: true,
    isReleased: false,
    query: jest.fn(async () => []),
  };
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'system', id: 'fixture-worker' },
  });
  const after = {
    bindingId,
    kind: 'command.sent',
    state: 'accepted',
    schemaVersion: 1,
    routeGeneration: '1',
    eventId: 'private-event',
    validatedEnvelope: {
      connectorJobId: 'private-job',
      providerChatId: 'private-chat',
    },
    trustedCaptureContext: {
      nativeMessageKey: 'private-key',
      qualification: { adapterId: 'private-adapter' },
    },
  };
  audit.record({
    resourceKind: 'omniIncomingReceipt',
    resourceId: receiptId,
    action: 'create',
    before: null,
    after,
    securityDescriptor: {
      resourceKind: 'omniIncomingReceipt',
      resourceId: receiptId,
      bindingId,
    },
  });
  after.state = 'changed';
  after.validatedEnvelope.connectorJobId = 'mutated-secret';
  await audit.flush();
  const entry = append.mock.calls[0][1];
  expect(entry.redactedDiff.values).toMatchObject({
    kind: { before: null, after: 'command.sent' },
    state: { before: null, after: 'accepted' },
  });
  for (const field of [
    'eventId',
    'validatedEnvelope',
    'trustedCaptureContext',
  ]) {
    expect(entry.redactedDiff.changedFields).toContain(field);
    expect(entry.redactedDiff.values).not.toHaveProperty(field);
  }
  expect(JSON.stringify(entry)).not.toContain('private-');
  expect(JSON.stringify(entry)).not.toContain('mutated-secret');
});

describe.each(['accept', 'claim'] as const)(
  'sent receipt %s failure attribution',
  (operation) => {
    const fixture = () => {
      const workspaceId = randomUUID();
      const bindingId = randomUUID();
      const resourceId = randomUUID();
      const conversationId = operation === 'accept' ? randomUUID() : null;
      const query = jest.fn(
        async (
          _sql: string,
          _parameters?: unknown[],
        ): Promise<Record<string, unknown>[]> => [
          { id: resourceId, bindingId, conversationId },
        ],
      );
      const scope = {
        workspaceId,
        executeRawQuery: query,
        transactionLifecycle: {
          commitOutcome: 'strict' as const,
          isTransactionActive: true,
          isReleased: false,
        },
      };
      const principal = {
        workspaceId,
        bindingId,
        actor: { kind: 'system' as const, id: 'fixture-worker' },
      };
      return {
        scope,
        principal,
        target: { operation, resourceId },
        query,
        conversationId,
      };
    };

    it('attributes a retained scoped resource without exposing submitted proof', async () => {
      const test = fixture();
      await appendOmniSentReceiptFailure(
        test.scope,
        test.principal,
        test.target,
        randomUUID(),
        true,
      );
      const entry = append.mock.calls[0][1];
      expect(entry).toMatchObject({
        resourceKind:
          operation === 'accept'
            ? 'omniOutgoingCommand'
            : 'omniIncomingReceipt',
        resourceId: test.target.resourceId,
        outcome: 'denied',
        reasonCode: `sent_receipt.${operation}.denied`,
        securityDescriptor: {
          bindingId: test.principal.bindingId,
          ...(test.conversationId
            ? { conversationId: test.conversationId }
            : {}),
        },
      });
      expect(test.query.mock.calls[0][1]).toEqual([
        test.principal.workspaceId,
        test.target.resourceId,
        test.principal.bindingId,
      ]);
      if (operation === 'claim')
        expect(test.query.mock.calls[0][0]).toContain(
          "receipt.kind='command.sent'",
        );
    });

    it('does not manufacture an audit resource for absent or foreign evidence', async () => {
      const test = fixture();
      test.query.mockResolvedValue([]);
      await appendOmniSentReceiptFailure(
        test.scope,
        test.principal,
        test.target,
        randomUUID(),
        false,
      );
      expect(append).not.toHaveBeenCalled();
    });

    it('rejects workspace mismatch before reading resources', async () => {
      const test = fixture();
      await expect(
        appendOmniSentReceiptFailure(
          test.scope,
          { ...test.principal, workspaceId: randomUUID() },
          test.target,
          randomUUID(),
          false,
        ),
      ).rejects.toThrow('WORKSPACE_MISMATCH');
      expect(test.query).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });
  },
);
