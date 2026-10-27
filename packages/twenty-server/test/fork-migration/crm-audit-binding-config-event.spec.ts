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
  () => ({
    verifyCrmAuditPrivileges: jest.fn(async () => undefined),
  }),
);

const append = jest.mocked(appendCrmAuditEntry);
const fixture = () => {
  const operation = {
    workspaceId: randomUUID(),
    operationId: randomUUID(),
    actor: { kind: 'system' as const, id: 'audit-binding-config-test' },
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
const configMutation = (
  resourceKind: 'omniAccountBinding' | 'omniQueue' = 'omniAccountBinding',
): CrmAuditMutation => {
  const bindingId = randomUUID();
  const id = randomUUID();
  return {
    resourceKind: 'omniDomainEvent',
    resourceId: id,
    action: 'create',
    before: null,
    after: {
      kind: 'binding.config_changed',
      origin: 'configuration_change',
      payloadVersion: 1,
      conversationId: null,
      conversationSequence: null,
      rootExecutionId: null,
      causationId: null,
      payload: {
        bindingId,
        bindingRevision: '2',
        resourceKind,
        resourceId:
          resourceKind === 'omniAccountBinding' ? bindingId : randomUUID(),
        resourceRevision: resourceKind === 'omniAccountBinding' ? '2' : '7',
        policyEpoch: '3',
      },
    },
    securityDescriptor: {
      resourceKind: 'omniDomainEvent',
      resourceId: id,
      bindingId,
    },
  };
};
const payloadOf = (mutation: CrmAuditMutation) =>
  mutation.after!.payload as Record<string, unknown>;

beforeEach(() => jest.clearAllMocks());

describe('binding config wakeup audit scope', () => {
  const mutation = (): CrmAuditMutation => {
    const resourceId = randomUUID();
    const bindingId = randomUUID();
    return {
      resourceKind: 'omniBindingConfigWakeup',
      resourceId,
      action: 'create',
      before: null,
      after: {
        bindingId,
        eventId: randomUUID(),
        handlerVersion: 1,
        state: 'running',
        attempts: 1,
        leaseToken: '1',
        leaseOwner: 'private-worker-identifier',
        leaseUntil: '2026-10-27T12:00:00.123456Z',
        needsRescan: false,
      },
      securityDescriptor: {
        resourceKind: 'omniBindingConfigWakeup',
        resourceId,
        bindingId,
      },
    };
  };

  it('records lifecycle metadata and redacts the lease owner', async () => {
    const { context } = fixture();
    context.record(mutation());
    await context.flush();
    const entry = append.mock.calls[0][1];
    expect(entry.redactedDiff.values.state.after).toBe('running');
    expect(entry.redactedDiff.changedFields).toContain('leaseOwner');
    expect(JSON.stringify(entry)).not.toContain('private-worker-identifier');
  });

  it('requires a binding scope', () => {
    const { context } = fixture();
    const value = mutation();
    delete value.securityDescriptor.bindingId;
    expect(() => context.record(value)).toThrow('binding-only scope');
  });

  it.each(['conversationId', 'queueId'] as const)(
    'forbids a %s scope',
    (field) => {
      const { context } = fixture();
      const value = mutation();
      value.securityDescriptor[field] = randomUUID();
      expect(() => context.record(value)).toThrow('binding-only scope');
    },
  );
});

describe('binding configuration events have one narrowly validated audit scope', () => {
  it.each(['omniAccountBinding', 'omniQueue'] as const)(
    'records a binding-scoped %s event while retaining payload redaction',
    async (resourceKind) => {
      const { context, executor } = fixture();
      const mutation = configMutation(resourceKind);
      context.record(mutation);
      await context.flush();

      expect(append).toHaveBeenCalledTimes(1);
      const entry = append.mock.calls[0][1];
      expect(entry).toMatchObject({
        action: 'create',
        resourceKind: 'omniDomainEvent',
        resourceId: mutation.resourceId,
        securityDescriptor: mutation.securityDescriptor,
      });
      expect(entry.redactedDiff.changedFields).toContain('payload');
      expect(entry.redactedDiff.values).not.toHaveProperty('payload');
      expect(entry.redactedDiff.values).toMatchObject({
        kind: { before: null, after: 'binding.config_changed' },
        conversationId: { before: null, after: null },
        rootExecutionId: { before: null, after: null },
      });
      if (resourceKind === 'omniQueue')
        expect(JSON.stringify(entry)).not.toContain(
          payloadOf(mutation).resourceId,
        );
      expect(executor.query).not.toHaveBeenCalled();
    },
  );

  it('normalizes UUID comparisons without relaxing the binding identity', async () => {
    const { context } = fixture();
    const mutation = configMutation();
    const payload = payloadOf(mutation);
    payload.bindingId = String(payload.bindingId).toUpperCase();
    payload.resourceId = String(payload.resourceId).toUpperCase();
    mutation.securityDescriptor.bindingId =
      mutation.securityDescriptor.bindingId!.toUpperCase();
    context.record(mutation);
    await context.flush();
    expect(append.mock.calls[0][1].securityDescriptor.bindingId).toBe(
      String(payload.bindingId).toLowerCase(),
    );
  });

  it.each(['update', 'delete'] as const)('rejects the %s action', (action) => {
    const { context } = fixture();
    const mutation = configMutation();
    mutation.action = action;
    expect(() => context.record(mutation)).toThrow();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects a non-null before snapshot', () => {
    const { context } = fixture();
    const mutation = configMutation();
    mutation.before = {};
    expect(() => context.record(mutation)).toThrow();
  });

  it.each([
    ['kind', 'message.received'],
    ['origin', 'history_import'],
    ['payloadVersion', 2],
    ['payloadVersion', '1'],
    ['unexpected', 'not part of the event contract'],
  ] as const)('rejects invalid event field %s=%s', (field, value) => {
    const { context } = fixture();
    const mutation = configMutation();
    mutation.after![field] = value;
    expect(() => context.record(mutation)).toThrow();
  });

  it.each(['kind', 'origin', 'payloadVersion', 'payload'] as const)(
    'rejects a missing event field %s',
    (field) => {
      const { context } = fixture();
      const mutation = configMutation();
      delete mutation.after![field];
      expect(() => context.record(mutation)).toThrow();
    },
  );

  it('rejects an absent after snapshot', () => {
    const { context } = fixture();
    const mutation = configMutation();
    mutation.after = null;
    expect(() => context.record(mutation)).toThrow();
  });

  it.each([
    'conversationId',
    'conversationSequence',
    'rootExecutionId',
    'causationId',
  ] as const)('requires explicit null %s', (field) => {
    const { context } = fixture();
    const mutation = configMutation();
    delete mutation.after![field];
    expect(() => context.record(mutation)).toThrow();
    mutation.after![field] =
      field === 'conversationSequence' ? '1' : randomUUID();
    expect(() => context.record(mutation)).toThrow();
  });

  it.each([null, undefined, [], 'binding.config_changed'])(
    'rejects an invalid payload container %p',
    (value) => {
      const { context } = fixture();
      const mutation = configMutation();
      mutation.after!.payload = value;
      expect(() => context.record(mutation)).toThrow();
    },
  );

  it.each([
    'bindingId',
    'bindingRevision',
    'resourceKind',
    'resourceId',
    'resourceRevision',
    'policyEpoch',
  ] as const)('requires payload field %s', (field) => {
    const { context } = fixture();
    const mutation = configMutation();
    delete payloadOf(mutation)[field];
    expect(() => context.record(mutation)).toThrow();
  });

  it.each([
    ['bindingId', 'not-a-uuid'],
    ['resourceId', 'not-a-uuid'],
    ['resourceKind', 'omniMessage'],
    ['bindingRevision', '0'],
    ['bindingRevision', '02'],
    ['resourceRevision', 2],
    ['resourceRevision', '-1'],
    ['policyEpoch', '0'],
    ['policyEpoch', '9223372036854775808'],
    ['secret', 'not allowed in configuration event'],
  ] as const)('rejects malformed payload field %s=%s', (field, value) => {
    const { context } = fixture();
    const mutation = configMutation('omniQueue');
    payloadOf(mutation)[field] = value;
    expect(() => context.record(mutation)).toThrow();
  });

  it.each(['resourceId', 'resourceRevision'] as const)(
    'requires a binding mutation to use the same %s',
    (field) => {
      const { context } = fixture();
      const mutation = configMutation();
      payloadOf(mutation)[field] = field === 'resourceId' ? randomUUID() : '3';
      expect(() => context.record(mutation)).toThrow();
    },
  );

  it('rejects a missing or foreign descriptor binding', () => {
    const { context } = fixture();
    const mutation = configMutation();
    delete mutation.securityDescriptor.bindingId;
    expect(() => context.record(mutation)).toThrow();
    mutation.securityDescriptor.bindingId = randomUUID();
    expect(() => context.record(mutation)).toThrow();
  });

  it.each(['conversationId', 'queueId'] as const)(
    'rejects descriptor %s on a binding event',
    (field) => {
      const { context } = fixture();
      const mutation = configMutation();
      mutation.securityDescriptor[field] = randomUUID();
      expect(() => context.record(mutation)).toThrow();
    },
  );

  it('does not accept another resource kind or mismatched descriptor ID', () => {
    const { context } = fixture();
    const mutation = configMutation();
    mutation.securityDescriptor.resourceId = randomUUID();
    expect(() => context.record(mutation)).toThrow();
    mutation.securityDescriptor.resourceId = mutation.resourceId;
    mutation.securityDescriptor.resourceKind = 'omniAccountBinding';
    expect(() => context.record(mutation)).toThrow();
  });

  it('retains ordinary conversation-event validation and redaction', async () => {
    const { context } = fixture();
    const mutation = configMutation();
    const conversationId = randomUUID();
    mutation.after = {
      kind: 'message.received',
      origin: 'history_import',
      payloadVersion: 1,
      conversationId,
      conversationSequence: '1',
      rootExecutionId: randomUUID(),
      payload: { body: 'private message' },
    };
    expect(() => context.record(mutation)).toThrow('conversation scope');
    mutation.securityDescriptor.conversationId = conversationId;
    context.record(mutation);
    await context.flush();
    expect(append.mock.calls[0][1].securityDescriptor.conversationId).toBe(
      conversationId,
    );
    expect(JSON.stringify(append.mock.calls[0][1])).not.toContain(
      'private message',
    );
  });

  it.each(['denied', 'failed'] as const)(
    'does not grant binding-only scope to a %s attempt',
    async (outcome) => {
      const { executor, operation } = fixture();
      const mutation = configMutation();
      await expect(
        appendCrmAuditAttempt(executor, operation, {
          resourceKind: mutation.resourceKind,
          resourceId: mutation.resourceId,
          action: 'create',
          securityDescriptor: mutation.securityDescriptor,
          attemptId: randomUUID(),
          outcome,
          reasonCode: 'config.test',
        }),
      ).rejects.toThrow('conversation scope');
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('captures the validated event before the caller mutates it', async () => {
    const { context } = fixture();
    const mutation = configMutation();
    context.record(mutation);
    mutation.after!.kind = 'message.received';
    payloadOf(mutation).resourceRevision = '999';
    mutation.securityDescriptor.bindingId = randomUUID();
    await context.flush();
    expect(append.mock.calls[0][1].redactedDiff.values.kind.after).toBe(
      'binding.config_changed',
    );
    expect(append.mock.calls[0][1].securityDescriptor.bindingId).toBe(
      payloadOf(mutation).bindingId,
    );
  });
});
