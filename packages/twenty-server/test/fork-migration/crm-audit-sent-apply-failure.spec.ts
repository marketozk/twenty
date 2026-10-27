import { randomUUID } from 'node:crypto';

import { appendCrmAuditEntry } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { appendOmniSentApplyFailure } from 'src/modules/omnichannel/services/append-omni-sent-apply-failure';

jest.mock('src/engine/core-modules/crm-audit/append-crm-audit-entry', () => ({
  appendCrmAuditEntry: jest.fn(async () => undefined),
}));
jest.mock(
  'src/engine/core-modules/crm-audit/verify-crm-audit-privileges',
  () => ({ verifyCrmAuditPrivileges: jest.fn(async () => undefined) }),
);
const append = jest.mocked(appendCrmAuditEntry);
beforeEach(() => jest.clearAllMocks());

const fixture = () => {
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
  const query = jest.fn(
    async (
      _sql: string,
      _parameters?: unknown[],
    ): Promise<Record<string, unknown>[]> => [
      { id: proof.receiptId, bindingId: principal.bindingId },
    ],
  );
  const scope = {
    workspaceId: principal.workspaceId,
    executeRawQuery: query,
    transactionLifecycle: {
      commitOutcome: 'strict' as const,
      isTransactionActive: true,
      isReleased: false,
    },
  };
  return { principal, proof, query, scope };
};

it.each([true, false])(
  'attributes only the scoped persisted sent receipt, denied=%s',
  async (denied) => {
    const test = fixture();
    await appendOmniSentApplyFailure(
      test.scope,
      test.principal,
      test.proof,
      randomUUID(),
      denied,
    );
    const entry = append.mock.calls[0][1];
    expect(entry).toMatchObject({
      resourceKind: 'omniIncomingReceipt',
      resourceId: test.proof.receiptId,
      outcome: denied ? 'denied' : 'failed',
      reasonCode: `sent_receipt.apply.${denied ? 'denied' : 'failed'}`,
      securityDescriptor: {
        resourceKind: 'omniIncomingReceipt',
        resourceId: test.proof.receiptId,
        bindingId: test.principal.bindingId,
      },
    });
    expect(test.query.mock.calls[0][1]).toEqual([
      test.principal.workspaceId,
      test.proof.receiptId,
      test.principal.bindingId,
    ]);
    expect(test.query.mock.calls[0][0]).toContain(
      "receipt.kind='command.sent'",
    );
    expect(JSON.stringify(entry)).not.toContain(test.proof.leaseOwner);
  },
);

it('does not fabricate a resource for an absent or foreign receipt', async () => {
  const test = fixture();
  test.query.mockResolvedValue([]);
  await appendOmniSentApplyFailure(
    test.scope,
    test.principal,
    test.proof,
    randomUUID(),
    false,
  );
  expect(append).not.toHaveBeenCalled();
});

it('rejects mismatched scope before reading or auditing', async () => {
  const test = fixture();
  await expect(
    appendOmniSentApplyFailure(
      test.scope,
      { ...test.principal, workspaceId: randomUUID() },
      test.proof,
      randomUUID(),
      false,
    ),
  ).rejects.toThrow('WORKSPACE_MISMATCH');
  expect(test.query).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});
