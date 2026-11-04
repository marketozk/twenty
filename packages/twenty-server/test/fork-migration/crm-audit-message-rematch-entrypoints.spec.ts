import { randomUUID } from 'node:crypto';
import {
  MessageParticipantMatchParticipantJob,
  type MessageParticipantMatchParticipantJobData,
} from 'src/modules/messaging/message-participant-manager/jobs/message-participant-match-participant.job';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));

const fixture = () => {
  const page = jest.fn().mockResolvedValue({ nextCursor: null });
  const legacyPerson = jest.fn(),
    legacyMember = jest.fn();
  const job = new MessageParticipantMatchParticipantJob({
    rematchMessageParticipantsWithAudit: page,
    matchParticipantsForPeople: legacyPerson,
    matchParticipantsForWorkspaceMembers: legacyMember,
  } as never);
  const input: MessageParticipantMatchParticipantJobData = {
    workspaceId: randomUUID(),
    participantMatching: {
      personEmails: ['Before@example.test'],
      workspaceMemberIds: [randomUUID()],
    },
  };
  return { page, legacyPerson, legacyMember, job, input };
};

it('message rematch drains people before members with independent cursors and one system correlation', async () => {
  const f = fixture(),
    personCursor = randomUUID(),
    memberCursor = randomUUID();
  f.page
    .mockResolvedValueOnce({ nextCursor: personCursor })
    .mockResolvedValueOnce({ nextCursor: null })
    .mockResolvedValueOnce({ nextCursor: memberCursor })
    .mockResolvedValueOnce({ nextCursor: null });
  await f.job.handle(f.input);
  expect(f.page.mock.calls.map(([args]) => args.selector.kind)).toEqual([
    'personOnly',
    'personOnly',
    'workspaceMemberOnly',
    'workspaceMemberOnly',
  ]);
  expect(f.page.mock.calls.map(([args]) => args.afterParticipantId)).toEqual([
    undefined,
    personCursor,
    undefined,
    memberCursor,
  ]);
  const operations = f.page.mock.calls.map(([args]) => args.operation);
  expect(
    new Set(operations.map((operation) => operation.correlationId)).size,
  ).toBe(1);
  expect(
    new Set(operations.map((operation) => operation.operationId)).size,
  ).toBe(4);
  for (const operation of operations)
    expect(operation).toMatchObject({
      workspaceId: f.input.workspaceId,
      actor: { kind: 'system', id: MessageParticipantMatchParticipantJob.name },
    });
  expect(f.legacyPerson).not.toHaveBeenCalled();
  expect(f.legacyMember).not.toHaveBeenCalled();
});

it('message rematch captures both selectors and workspace before its first page awaits', async () => {
  const f = fixture(),
    workspaceId = f.input.workspaceId,
    memberId = f.input.participantMatching.workspaceMemberIds[0];
  f.page.mockImplementationOnce(async () => {
    f.input.workspaceId = randomUUID();
    f.input.participantMatching.personEmails.splice(0);
    f.input.participantMatching.workspaceMemberIds[0] = randomUUID();
    return { nextCursor: null };
  });
  await f.job.handle(f.input);
  expect(f.page.mock.calls[0][0]).toMatchObject({
    workspaceId,
    selector: { kind: 'personOnly' },
  });
  expect(
    f.page.mock.calls[0][0].selector.personEmails.map((email: string) =>
      email.toLowerCase(),
    ),
  ).toEqual(['before@example.test']);
  expect(f.page.mock.calls[1][0]).toMatchObject({
    workspaceId,
    selector: { kind: 'workspaceMemberOnly', workspaceMemberIds: [memberId] },
  });
});

it('message rematch validates a malformed later member selector before any person page', async () => {
  const f = fixture();
  f.input.participantMatching.workspaceMemberIds = ['invalid'];
  await expect(f.job.handle(f.input)).rejects.toThrow();
  expect(f.page).not.toHaveBeenCalled();
});

it('message rematch skips empty lanes and supports more than five pages', async () => {
  const f = fixture();
  f.input.participantMatching.workspaceMemberIds = [];
  const cursors = Array.from({ length: 6 }, () => randomUUID()).sort();
  for (const nextCursor of cursors)
    f.page.mockResolvedValueOnce({ nextCursor });
  f.page.mockResolvedValueOnce({ nextCursor: null });
  await f.job.handle(f.input);
  expect(f.page.mock.calls.map(([args]) => args.afterParticipantId)).toEqual([
    undefined,
    ...cursors,
  ]);
  f.page.mockClear();
  f.input.participantMatching.personEmails = [];
  await f.job.handle(f.input);
  expect(f.page).not.toHaveBeenCalled();
});

it.each(['ordinary', 'unknown', 'confirmed'] as const)(
  'message rematch preserves %s failure identity and stops later work',
  async (kind) => {
    const f = fixture();
    const error =
      kind === 'ordinary'
        ? new Error('page failed')
        : kind === 'unknown'
          ? new NativeTransactionOutcomeUnknownError(
              'commit',
              new Error('ACK lost'),
            )
          : new CoreAuditPostCommitError(new Error('postcommit failed'));
    f.page
      .mockResolvedValueOnce({ nextCursor: randomUUID() })
      .mockRejectedValueOnce(error);
    await expect(f.job.handle(f.input)).rejects.toBe(error);
    expect(f.page).toHaveBeenCalledTimes(2);
    expect(
      f.page.mock.calls.every(([args]) => args.selector.kind === 'personOnly'),
    ).toBe(true);
  },
);
