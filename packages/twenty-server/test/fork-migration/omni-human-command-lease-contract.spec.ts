import { randomUUID } from 'node:crypto';

import {
  omniHumanCommandLeaseInputSchema,
  omniHumanCommandLeasePrincipalSchema,
} from 'src/modules/omnichannel/contracts/omni-human-command-lease';

describe('human command lease internal request contract', () => {
  it.each([
    999,
    300001,
    1000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1000',
    null,
  ])('rejects invalid lease duration %#', (leaseMilliseconds) => {
    expect(() =>
      omniHumanCommandLeaseInputSchema.parse({
        commandId: randomUUID(),
        leaseMilliseconds,
      }),
    ).toThrow();
  });

  it.each([1000, 300000])(
    'accepts and freezes bounded lease duration %i',
    (leaseMilliseconds) => {
      const commandId = randomUUID();
      const parsed = omniHumanCommandLeaseInputSchema.parse({
        commandId: commandId.toUpperCase(),
        leaseMilliseconds,
      });
      expect(parsed).toEqual({ commandId, leaseMilliseconds });
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it.each<[string, unknown]>([
    ['purpose', 'first_attempt'],
    ['leaseToken', randomUUID()],
    ['leaseUntil', '2099-01-01T00:00:00.000000Z'],
    ['capturedRestoreIncarnation', randomUUID()],
    ['generation', '1'],
    ['providerChatId', 'forged-target'],
    ['payload', { text: 'forged-body' }],
  ])('rejects caller-supplied %s', (field, value) => {
    expect(() =>
      omniHumanCommandLeaseInputSchema.parse({
        commandId: randomUUID(),
        leaseMilliseconds: 1000,
        [field]: value,
      }),
    ).toThrow();
  });

  it.each(['workspaceMember', 'application', 'agent', 'workflow'])(
    'rejects %s as the worker principal',
    (kind) => {
      expect(() =>
        omniHumanCommandLeasePrincipalSchema.parse({
          workspaceId: randomUUID(),
          bindingId: randomUUID(),
          actor: { kind, id: randomUUID() },
        }),
      ).toThrow();
    },
  );

  it.each([
    '',
    ' padded',
    'trailing ',
    'line\nbreak',
    '\u0000',
    '\ud800',
    'x'.repeat(257),
  ])('rejects invalid worker identity %#', (id) => {
    expect(() =>
      omniHumanCommandLeasePrincipalSchema.parse({
        workspaceId: randomUUID(),
        bindingId: randomUUID(),
        actor: { kind: 'system', id },
      }),
    ).toThrow();
  });

  it('snapshots and freezes the nested worker identity without mutating the caller', () => {
    const workspaceId = randomUUID();
    const bindingId = randomUUID();
    const caller = {
      workspaceId: workspaceId.toUpperCase(),
      bindingId: bindingId.toUpperCase(),
      actor: { kind: 'system', id: 'fixture-worker' },
    };
    const parsed = omniHumanCommandLeasePrincipalSchema.parse(caller);
    expect(parsed).toEqual({
      workspaceId,
      bindingId,
      actor: { kind: 'system', id: 'fixture-worker' },
    });
    caller.actor.id = 'replacement';
    expect(parsed.actor.id).toBe('fixture-worker');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.actor)).toBe(true);
    expect(Reflect.set(parsed.actor, 'id', 'forged')).toBe(false);
  });
});
