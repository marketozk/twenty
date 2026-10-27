import { randomUUID } from 'node:crypto';

import {
  omniHumanCommandDeferInputSchema,
  omniHumanCommandDiscoveryInputSchema,
} from 'src/modules/omnichannel/contracts/omni-human-command-recovery';
import {
  deferOmniHumanCommandReconciliation,
  discoverOmniHumanCommandRecovery,
  snapshotOmniHumanCommandDeferRequest,
  snapshotOmniHumanCommandDiscoveryRequest,
} from 'src/modules/omnichannel/services/recover-omni-human-command';

const valid = () => ({
  commandId: randomUUID(),
  leaseToken: randomUUID(),
  leaseUntil: '2026-10-27T12:00:00.123456Z',
  capturedRestoreIncarnation: randomUUID(),
  retryAfterMilliseconds: 30000,
});
it.each([
  ['commandId', 'not-a-uuid'],
  ['leaseToken', null],
  ['leaseUntil', '2026-10-27T12:00:00.123Z'],
  ['leaseUntil', '2026-10-27T12:00:00.123456Z\n'],
  ['capturedRestoreIncarnation', null],
  ['retryAfterMilliseconds', 999],
  ['retryAfterMilliseconds', 86400001],
  ['retryAfterMilliseconds', 1000.1],
  ['retryAfterMilliseconds', '1000'],
  ['state', 'sent'],
  ['payloadHash', 'anything'],
  ['reason', 'operator says sent'],
])('rejects defer input %s=%s', (key, value) => {
  expect(
    omniHumanCommandDeferInputSchema.safeParse({ ...valid(), [key]: value })
      .success,
  ).toBe(false);
});
it('retains exact expiry and canonical identifiers in a readonly request', () => {
  const input = valid();
  const parsed = omniHumanCommandDeferInputSchema.parse({
    ...input,
    commandId: input.commandId.toUpperCase(),
  });
  expect(parsed).toEqual(input);
  expect(Object.isFrozen(parsed)).toBe(true);
});
it.each([
  { limit: 0, cursor: null },
  { limit: 101, cursor: null },
  { limit: 2.5, cursor: null },
  {
    limit: 1,
    cursor: {
      commandId: randomUUID(),
      nextAttemptAt: '2026-10-27T12:00:00.123Z',
    },
  },
  { limit: 1, cursor: null, bindingId: randomUUID() },
  { limit: 1 },
])('rejects invalid discovery input %j', (input) => {
  expect(omniHumanCommandDiscoveryInputSchema.safeParse(input).success).toBe(
    false,
  );
});
it('preserves and freezes the exact microsecond cursor', () => {
  const input = {
    limit: 100,
    cursor: {
      commandId: randomUUID(),
      nextAttemptAt: '2026-10-27T12:00:00.000001Z',
    },
  };
  const parsed = omniHumanCommandDiscoveryInputSchema.parse(input);
  expect(parsed).toEqual(input);
  expect(Object.isFrozen(parsed.cursor)).toBe(true);
});
it('requires both trusted defer callbacks and current discovery authorization', () => {
  const principal = {
    workspaceId: randomUUID(),
    bindingId: randomUUID(),
    actor: { kind: 'system' as const, id: 'fixture' },
  };
  const input = valid();
  const callbacks = {
    authorize: async () => {},
    qualifyTransport: async () => {},
  };
  Reflect.deleteProperty(callbacks, 'qualifyTransport');
  expect(() =>
    snapshotOmniHumanCommandDeferRequest(principal, input, callbacks),
  ).toThrow('CALLBACKS_REQUIRED');
  const discoverCallbacks = { authorize: async () => {} };
  Reflect.deleteProperty(discoverCallbacks, 'authorize');
  expect(() =>
    snapshotOmniHumanCommandDiscoveryRequest(
      principal,
      { limit: 1, cursor: null },
      discoverCallbacks,
    ),
  ).toThrow('CALLBACKS_REQUIRED');
});
it.each(['defer', 'discovery'] as const)(
  'rejects foreign transaction scope before %s reads',
  async (kind) => {
    const principal = {
      workspaceId: randomUUID(),
      bindingId: randomUUID(),
      actor: { kind: 'system' as const, id: 'fixture' },
    };
    const executeRawQuery = jest.fn(async () => []);
    const scope = { workspaceId: randomUUID(), executeRawQuery };
    const result =
      kind === 'defer'
        ? deferOmniHumanCommandReconciliation(scope, principal, valid(), {
            authorize: async () => {},
            qualifyTransport: async () => {},
          })
        : discoverOmniHumanCommandRecovery(
            scope,
            principal,
            { limit: 1, cursor: null },
            { authorize: async () => {} },
          );
    await expect(result).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(executeRawQuery).not.toHaveBeenCalled();
  },
);
