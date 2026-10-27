import { randomUUID } from 'node:crypto';

import { appendCrmAuditEntry } from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
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
  const workspaceId = randomUUID();
  const resourceId = randomUUID();
  const executor = {
    workspaceId,
    isTransactionActive: true,
    isReleased: false,
    query: jest.fn(async () => []),
  };
  const context = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'system', id: 'fixture-reconciler' },
  });
  const change: CrmAuditMutation = {
    resourceKind: 'omniOutgoingCommand',
    resourceId,
    action: 'update',
    before: {
      state: 'dispatching',
      statusRevision: '2',
      journalSequence: null,
      connectorJobId: null,
      connectorAcceptedEvidence: null,
    },
    after: {
      state: 'accepted',
      statusRevision: '3',
      journalSequence: '0',
      connectorJobId: 'private-connector-job',
      connectorAcceptedEvidence: {
        providerChatId: 'private-chat',
        connectorJobId: 'private-connector-job',
        qualification: { adapterId: 'private-adapter' },
      },
    },
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId,
      bindingId: randomUUID(),
      conversationId: randomUUID(),
    },
  };
  return { context, change };
};

beforeEach(() => jest.clearAllMocks());

describe('connector acceptance audit catalog', () => {
  it('keeps zero journal sequence visible and hashes job identifiers and proof contents', async () => {
    const { context, change } = fixture();
    context.record(change);
    await context.flush();
    const entry = append.mock.calls[0][1];
    expect(entry.redactedDiff.values).toMatchObject({
      state: { before: 'dispatching', after: 'accepted' },
      statusRevision: { before: '2', after: '3' },
      journalSequence: { before: null, after: '0' },
    });
    for (const key of ['connectorJobId', 'connectorAcceptedEvidence']) {
      expect(entry.redactedDiff.changedFields).toContain(key);
      expect(entry.redactedDiff.values).not.toHaveProperty(key);
    }
    expect(JSON.stringify(entry)).not.toContain('private-');
  });

  it('captures exact accepted metadata before caller mutation', async () => {
    const { context, change } = fixture();
    context.record(change);
    change.after!.journalSequence = '999';
    change.after!.connectorJobId = 'new-private-job';
    change.after!.connectorAcceptedEvidence = { forged: 'new-private-proof' };
    await context.flush();
    const entry = append.mock.calls[0][1];
    expect(entry.redactedDiff.values.journalSequence.after).toBe('0');
    expect(JSON.stringify(entry)).not.toContain('new-private-');
  });
});
