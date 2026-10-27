import { randomUUID } from 'node:crypto';

import { appendCrmAuditEntry } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditMutation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

jest.mock('src/engine/core-modules/crm-audit/append-crm-audit-entry', () => ({
  appendCrmAuditEntry: jest.fn(async () => undefined),
}));
jest.mock(
  'src/engine/core-modules/crm-audit/verify-crm-audit-privileges',
  () => ({
    verifyCrmAuditPrivileges: jest.fn(async () => undefined),
  }),
);

const append = jest.mocked(appendCrmAuditEntry);
const fixture = () => {
  const workspaceId = randomUUID();
  const operation = {
    workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture-worker' },
  };
  const executor = {
    workspaceId,
    isTransactionActive: true,
    isReleased: false,
    query: jest.fn(async () => []),
  };
  const resourceId = randomUUID();
  const change: CrmAuditMutation = {
    resourceKind: 'omniOutgoingCommand',
    resourceId,
    action: 'update',
    before: {
      state: 'pending',
      statusRevision: '1',
      leaseToken: null,
      leaseUntil: null,
    },
    after: {
      state: 'dispatching',
      statusRevision: '2',
      leaseToken: randomUUID(),
      leaseUntil: '2026-10-27T10:00:00.123456Z',
    },
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId,
      bindingId: randomUUID(),
      conversationId: randomUUID(),
    },
  };
  return {
    context: new CrmAuditTransactionContext(executor, operation),
    change,
  };
};

beforeEach(() => jest.clearAllMocks());

describe('human command lease audit catalog', () => {
  it('records exact lease expiry while hashing the lease token', async () => {
    const { context, change } = fixture();
    context.record(change);
    await context.flush();
    const entry = append.mock.calls[0][1];

    expect(entry.redactedDiff.values).toMatchObject({
      state: { before: 'pending', after: 'dispatching' },
      statusRevision: { before: '1', after: '2' },
      leaseUntil: { before: null, after: '2026-10-27T10:00:00.123456Z' },
    });
    expect(entry.redactedDiff.changedFields).toContain('leaseToken');
    expect(entry.redactedDiff.values).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(entry)).not.toContain(change.after!.leaseToken);
  });

  it('captures lease values before caller mutation', async () => {
    const { context, change } = fixture();
    const token = change.after!.leaseToken;
    context.record(change);
    change.after!.leaseToken = 'replaced-secret-token';
    change.after!.leaseUntil = '2026-10-28T00:00:00.000000Z';
    await context.flush();

    expect(append.mock.calls[0][1].redactedDiff.values.leaseUntil.after).toBe(
      '2026-10-27T10:00:00.123456Z',
    );
    expect(JSON.stringify(append.mock.calls[0][1])).not.toContain(token);
    expect(JSON.stringify(append.mock.calls[0][1])).not.toContain(
      'replaced-secret-token',
    );
  });

  it('rejects Date instances rather than silently changing timestamp precision', () => {
    const { context, change } = fixture();
    change.after!.leaseUntil = new Date();

    expect(() => context.record(change)).toThrow('JSON scalar');
    expect(append).not.toHaveBeenCalled();
  });
});
