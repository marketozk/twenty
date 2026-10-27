import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildOmniNativeMessageReferences } from 'src/modules/omnichannel/services/build-omni-native-message-references';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';

const workspaceId = '61c65668-1496-45b8-9375-a39902342677';
const bindingId = '0c21d077-6d03-4a47-8f3a-f1588536bf15';

const fixture = () => {
  const state = { active: true, released: false };
  const repository = {} as WorkspaceRepository;
  const getRepository = jest.fn().mockReturnValue(repository);
  const executeRawQuery = jest.fn().mockResolvedValue([{ value: 1 }]);
  const afterCommit = jest.fn();
  const scope: WorkspaceTransactionScope = {
    workspaceId,
    transactionLifecycle: {
      commitOutcome: 'strict',
      get isTransactionActive() {
        return state.active;
      },
      get isReleased() {
        return state.released;
      },
    },
    getRepository,
    executeRawQuery,
    afterCommit,
  };

  return {
    scope,
    state,
    repository,
    getRepository,
    executeRawQuery,
    afterCommit,
  };
};

describe('omnichannel native transaction adapter', () => {
  it('retains the native generic repository contract and additional scope fields', () => {
    const source = fixture();
    const wrapped = withOmniRepositoryOptions({
      ...source.scope,
      marker: 'retained',
    });
    const nativeScope: WorkspaceTransactionScope = wrapped;
    const repository: WorkspaceRepository<{ id: string; text: string }> =
      nativeScope.getRepository<{ id: string; text: string }>('message');
    const directlyTyped: WorkspaceRepository<{ id: string; text: string }> =
      wrapped.getRepository<{ id: string; text: string }>('message');

    expect(repository).toBe(source.repository);
    expect(directlyTyped).toBe(source.repository);
    expect(wrapped.marker).toBe('retained');
  });

  it.each([
    'message',
    'messageThread',
    'messageParticipant',
    'messageChannelMessageAssociation',
    'messageChannelMessageAssociationMessageFolder',
    'messageThreadTarget',
  ])(
    'suppresses generic events for %s without changing permissions',
    (name) => {
      const source = fixture();
      const wrapped = withOmniRepositoryOptions(source.scope);
      const permissions = {
        intersectionOf: { userWorkspaceRoleId: workspaceId },
      };
      const options = { shouldSkipEventEmission: false };

      expect(wrapped.getRepository(name, permissions, options)).toBe(
        source.repository,
      );
      expect(source.getRepository).toHaveBeenCalledWith(name, permissions, {
        shouldSkipEventEmission: true,
      });
      expect(options.shouldSkipEventEmission).toBe(false);
      expect(source.getRepository.mock.calls[0][1]).toBe(permissions);
    },
  );

  it.each([
    undefined,
    { shouldSkipEventEmission: false },
    { shouldSkipEventEmission: true },
  ])('preserves unrelated CRM repository options %j', (options) => {
    const source = fixture();
    const permissions = { shouldBypassPermissionChecks: true as const };

    withOmniRepositoryOptions(source.scope).getRepository(
      'person',
      permissions,
      options,
    );
    expect(source.getRepository).toHaveBeenCalledWith(
      'person',
      permissions,
      options,
    );
    expect(source.getRepository.mock.calls[0][2]).toBe(options);
  });

  it('delegates SQL and afterCommit to the same scope', async () => {
    const source = fixture();
    const wrapped = withOmniRepositoryOptions(source.scope);
    const parameters = [workspaceId];
    const callback = jest.fn();

    expect(wrapped.workspaceId).toBe(workspaceId);
    expect(wrapped.transactionLifecycle).toBe(
      source.scope.transactionLifecycle,
    );
    expect(await wrapped.executeRawQuery('SELECT $1', parameters)).toEqual([
      { value: 1 },
    ]);
    expect(source.executeRawQuery).toHaveBeenCalledWith(
      'SELECT $1',
      parameters,
    );
    expect(source.executeRawQuery.mock.calls[0][1]).toBe(parameters);
    wrapped.afterCommit(callback);
    expect(source.afterCommit).toHaveBeenCalledWith(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['missing', 'legacy'])('rejects %s lifecycle', (mode) => {
    const source = fixture();

    source.scope.transactionLifecycle =
      mode === 'missing'
        ? undefined
        : {
            isTransactionActive: true,
            isReleased: false,
            commitOutcome: 'legacy',
          };
    expect(() => withOmniRepositoryOptions(source.scope)).toThrow(
      'strict workspace transaction',
    );
    expect(source.getRepository).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'released'])(
    'rejects an initially %s scope',
    (state) => {
      const source = fixture();

      if (state === 'inactive') source.state.active = false;
      else source.state.released = true;
      expect(() => withOmniRepositoryOptions(source.scope)).toThrow(
        'active workspace transaction',
      );
    },
  );

  it.each(['inactive', 'released'])(
    'does not reuse a retained %s scope',
    (state) => {
      const source = fixture();
      const wrapped = withOmniRepositoryOptions(source.scope);

      if (state === 'inactive') source.state.active = false;
      else source.state.released = true;
      expect(() => wrapped.getRepository('message')).toThrow(
        'active workspace transaction',
      );
      expect(() => wrapped.executeRawQuery('SELECT 1')).toThrow(
        'active workspace transaction',
      );
      expect(() => wrapped.afterCommit(jest.fn())).toThrow(
        'active workspace transaction',
      );
      expect(source.getRepository).not.toHaveBeenCalled();
      expect(source.executeRawQuery).not.toHaveBeenCalled();
      expect(source.afterCommit).not.toHaveBeenCalled();
    },
  );
});

describe('qualified native message references', () => {
  const input = {
    bindingId,
    providerChatId: 'чат:😀',
    nativeMessageKeyVersion: 1 as const,
    nativeMessageKey: 'v1:incoming:9007199254740993',
  };

  it('has a stable UTF-8 length-delimited vector and preserves opaque IDs', () => {
    expect(buildOmniNativeMessageReferences(input)).toEqual({
      headerMessageId:
        'omni:v1:37c13b90ade87c3d473c6eab43226fb4cfb00794cc752c1bcf4e63c06a82811c',
      messageExternalId: input.nativeMessageKey,
      messageThreadExternalId: input.providerChatId,
    });
  });

  it('normalizes only UUID case', () => {
    expect(
      buildOmniNativeMessageReferences({
        ...input,
        bindingId: bindingId.toUpperCase(),
      }),
    ).toEqual(buildOmniNativeMessageReferences(input));
  });

  it.each([
    { bindingId: 'aa6b5d74-fad7-4c18-94de-70a77bcf8a25' },
    { providerChatId: 'другой-чат' },
    { nativeMessageKey: 'v1:outgoing:9007199254740993' },
    { nativeMessageKey: 'v1:incoming:9007199254740992' },
  ])('separates scoped identity %j', (change) => {
    expect(
      buildOmniNativeMessageReferences({ ...input, ...change }).headerMessageId,
    ).not.toBe(buildOmniNativeMessageReferences(input).headerMessageId);
  });

  it('does not collide at embedded delimiter boundaries', () => {
    const first = buildOmniNativeMessageReferences({
      ...input,
      providerChatId: '12',
      nativeMessageKey: '3:4',
    });
    const second = buildOmniNativeMessageReferences({
      ...input,
      providerChatId: '12:3',
      nativeMessageKey: '4',
    });

    expect(first.headerMessageId).toBe(
      'omni:v1:1458ea8cee9aa71ce42bbf2102075a2e959657b863c896cc6ebf5b47e3e10f74',
    );
    expect(first.headerMessageId).not.toBe(second.headerMessageId);
  });

  it.each([
    { nativeMessageKey: '' },
    { providerChatId: '' },
    { nativeMessageKey: '\u0000' },
    { nativeMessageKey: '\ud800' },
    { providerChatId: '\udfff' },
    { bindingId: 'not-a-uuid' },
    { nativeMessageKey: 'x'.repeat(513) },
  ])('rejects invalid references %j', (change) => {
    expect(() =>
      buildOmniNativeMessageReferences({ ...input, ...change }),
    ).toThrow();
  });
});
