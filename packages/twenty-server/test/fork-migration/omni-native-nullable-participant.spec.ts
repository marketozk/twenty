import { randomUUID } from 'node:crypto';

import { MessageParticipantRole } from 'twenty-shared/types';

import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));

const fixture = () => {
  type Dependencies = ConstructorParameters<
    typeof MessagingMessageParticipantService
  >;
  type ParticipantInput = Parameters<
    MessagingMessageParticipantService['saveMessageParticipants']
  >[0][number];
  const workspaceId = randomUUID();
  const participantId = randomUUID();
  const input: ParticipantInput = {
    messageId: randomUUID(),
    role: MessageParticipantRole.FROM,
    personId: null,
    workspaceMemberId: null,
    handle: null,
    displayName: null,
  };
  const repository = {
    find: jest.fn(),
    insert: jest.fn(async () => ({ identifiers: [{ id: participantId }] })),
    updateMany: jest.fn(),
  };
  const scope: WorkspaceTransactionScope = {
    workspaceId,
    getRepository: jest.fn().mockReturnValue(repository),
    transactionLifecycle: {
      commitOutcome: 'strict',
      isTransactionActive: true,
      isReleased: false,
    },
    executeRawQuery: jest.fn(async () => []),
    afterCommit: jest.fn(),
  };
  const manager = {
    executeInWorkspaceContext: jest.fn(async (work: () => Promise<unknown>) =>
      work(),
    ),
  } as unknown as Dependencies[0];
  const matcher = { matchParticipants: jest.fn() };
  const service = new MessagingMessageParticipantService(
    manager,
    matcher as unknown as Dependencies[1],
  );
  const saved = { ...input, id: participantId };
  repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([saved]);
  return {
    workspaceId,
    participantId,
    input,
    repository,
    scope,
    matcher,
    service,
    saved,
  };
};

it.each([true, false])(
  'persists nullable historical identity without inventing a handle/name: relation=%s',
  async (linked) => {
    const test = fixture();
    if (linked) test.input.workspaceMemberId = randomUUID();
    await test.service.saveMessageParticipants(
      [test.input],
      test.workspaceId,
      test.scope,
    );
    expect(test.repository.insert).toHaveBeenCalledWith([test.input]);
    expect(test.repository.updateMany).not.toHaveBeenCalled();
    expect(test.matcher.matchParticipants).not.toHaveBeenCalled();
  },
);

it('matches an existing null-identity participant without a duplicate or name rewrite', async () => {
  const test = fixture();
  test.repository.find.mockReset();
  test.repository.find
    .mockResolvedValueOnce([test.saved])
    .mockResolvedValueOnce([]);
  test.repository.insert.mockResolvedValue({ identifiers: [] });
  await expect(
    test.service.saveMessageParticipants(
      [test.input],
      test.workspaceId,
      test.scope,
    ),
  ).resolves.toEqual([]);
  expect(test.repository.insert).toHaveBeenCalledWith([]);
  expect(test.repository.updateMany).not.toHaveBeenCalled();
});

it('preserves ordinary email handle/name persistence', async () => {
  const test = fixture();
  test.input.handle = 'sender@example.test';
  test.input.displayName = 'Email sender';
  await test.service.saveMessageParticipants(
    [test.input],
    test.workspaceId,
    test.scope,
  );
  expect(test.repository.insert).toHaveBeenCalledWith([
    expect.objectContaining({
      handle: 'sender@example.test',
      displayName: 'Email sender',
    }),
  ]);
  expect(test.matcher.matchParticipants).not.toHaveBeenCalled();
});
