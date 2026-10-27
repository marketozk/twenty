import {
  omniHumanTextCommandInputSchema,
  omniHumanTextCommandPrincipalSchema,
} from 'src/modules/omnichannel/contracts/omni-human-text-command';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const conversationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const input = () => ({
  conversationId,
  text: 'Ответ клиенту',
  idempotencyKey: 'composer-intent-1',
  expectedControlEpoch: '1',
  observedReplyRevision: '2',
});

describe('human text command closed input contract', () => {
  it.each([
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udfff'],
    ['embedded unpaired surrogate', 'before\ud800after'],
    ['NUL', 'before\u0000after'],
    ['backspace', 'before\u0008after'],
    ['vertical tab', 'before\u000bafter'],
    ['DEL', 'before\u007fafter'],
    ['ASCII length overflow', 'a'.repeat(16001)],
    ['emoji UTF-16 length overflow', '😀'.repeat(8001)],
    ['empty', ''],
    ['spaces only', '   '],
    ['line breaks only', '\t\r\n'],
    ['Unicode whitespace only', '\u00a0\u2003'],
  ])('rejects %s without producing an admission input', (_name, text) => {
    expect(() =>
      omniHumanTextCommandInputSchema.parse({ ...input(), text }),
    ).toThrow();
  });

  it.each<[string, unknown]>([
    ['senderClass', 'human'],
    ['contentProvenance', 'human_direct'],
    ['origin', 'human_composer'],
    ['actorId', workspaceMemberId],
    ['userId', userId],
    ['workspaceId', workspaceId],
    ['providerChatId', 'another-chat'],
    ['routeGeneration', '1'],
    ['replacesCommandId', conversationId],
    ['readyFileIds', []],
    ['replyToMessageLinkId', null],
    ['resolvedReplyNativeRef', null],
  ])(
    'rejects unsupported caller field %s even when its value looks valid',
    (field, value) => {
      expect(() =>
        omniHumanTextCommandInputSchema.parse({ ...input(), [field]: value }),
      ).toThrow();
    },
  );

  it.each([
    '  Добрый день! 😀\r\nВторая строка\tс табуляцией.  ',
    'a'.repeat(16000),
    '😀'.repeat(8000),
    'я'.repeat(16000),
  ])('preserves valid message contents exactly', (text) => {
    const parsed = omniHumanTextCommandInputSchema.parse({ ...input(), text });

    expect(parsed.text).toBe(text);
    expect(Buffer.byteLength(parsed.text, 'utf8')).toBeLessThanOrEqual(64000);
  });

  it.each([
    '',
    ' padded',
    'trailing ',
    'has space',
    'line\nbreak',
    '\u0000',
    '\ud800',
    'x'.repeat(257),
  ])('rejects malformed idempotency key %#', (idempotencyKey) => {
    expect(() =>
      omniHumanTextCommandInputSchema.parse({ ...input(), idempotencyKey }),
    ).toThrow();
  });

  it.each(['expectedControlEpoch', 'observedReplyRevision'] as const)(
    'requires canonical positive bigint %s',
    (field) => {
      for (const value of [
        '0',
        '-1',
        '01',
        '+1',
        '1.5',
        ' 1',
        '1 ',
        '',
        '9223372036854775808',
        1,
        null,
      ]) {
        expect(() =>
          omniHumanTextCommandInputSchema.parse({ ...input(), [field]: value }),
        ).toThrow();
      }
      const parsed = omniHumanTextCommandInputSchema.parse({
        ...input(),
        [field]: '9223372036854775807',
      });
      expect(parsed[field]).toBe('9223372036854775807');
    },
  );

  it('normalizes UUIDs while keeping the principal and input closed and immutable', () => {
    const callerPrincipal = {
      workspaceId: workspaceId.toUpperCase(),
      userId: userId.toUpperCase(),
      workspaceMemberId: workspaceMemberId.toUpperCase(),
    };
    const callerInput = {
      ...input(),
      conversationId: conversationId.toUpperCase(),
    };
    const principal =
      omniHumanTextCommandPrincipalSchema.parse(callerPrincipal);
    const parsed = omniHumanTextCommandInputSchema.parse(callerInput);

    expect(principal).toEqual({ workspaceId, userId, workspaceMemberId });
    expect(parsed.conversationId).toBe(conversationId);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Reflect.set(principal, 'workspaceMemberId', userId)).toBe(false);
    expect(Reflect.set(parsed, 'text', 'replacement')).toBe(false);
    callerPrincipal.workspaceMemberId = userId;
    callerInput.text = 'changed after parsing';
    expect(principal.workspaceMemberId).toBe(workspaceMemberId);
    expect(parsed.text).toBe(input().text);
    expect(() =>
      omniHumanTextCommandPrincipalSchema.parse({
        ...callerPrincipal,
        actor: { kind: 'system', id: 'spoofed' },
      }),
    ).toThrow();
  });

  it.each(['workspaceId', 'userId', 'workspaceMemberId'] as const)(
    'requires a real UUID for principal %s',
    (field) => {
      expect(() =>
        omniHumanTextCommandPrincipalSchema.parse({
          workspaceId,
          userId,
          workspaceMemberId,
          [field]: 'not-a-uuid',
        }),
      ).toThrow();
    },
  );
});
