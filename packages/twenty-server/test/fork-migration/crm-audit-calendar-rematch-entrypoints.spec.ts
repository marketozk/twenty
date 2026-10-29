import { randomUUID } from 'node:crypto';
import { CalendarEventParticipantMatchParticipantJob } from 'src/modules/calendar/calendar-event-participant-manager/jobs/calendar-event-participant-match-participant.job';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));

const buildRematchJob = () => {
  const workspaceId = randomUUID(),
    memberId = randomUUID();
  const workspace = jest
    .fn()
    .mockResolvedValue({ id: workspaceId, activationStatus: 'ACTIVE' });
  const page = jest.fn().mockResolvedValue({ nextCursor: null });
  const legacyPerson = jest.fn(),
    legacyMember = jest.fn();
  const job = new CalendarEventParticipantMatchParticipantJob(
    { findOne: workspace } as never,
    {
      rematchCalendarParticipantsWithAudit: page,
      matchParticipantsForPeople: legacyPerson,
      matchParticipantsForWorkspaceMembers: legacyMember,
    } as never,
  );
  const input = {
    workspaceId,
    participantMatching: {
      personEmails: ['Before@example.test'],
      workspaceMemberIds: [memberId],
    },
  };
  return {
    workspaceId,
    memberId,
    workspace,
    page,
    legacyPerson,
    legacyMember,
    job,
    input,
    run: () => job.handle(input),
  };
};

it('calendar job pages people before members with separate cursors and captured system attribution', async () => {
  const f = buildRematchJob(),
    personCursor = randomUUID(),
    memberCursor = randomUUID();
  f.page
    .mockResolvedValueOnce({ nextCursor: personCursor })
    .mockResolvedValueOnce({ nextCursor: null })
    .mockResolvedValueOnce({ nextCursor: memberCursor })
    .mockResolvedValueOnce({ nextCursor: null });
  await f.run();
  expect(f.workspace).toHaveBeenCalledWith({ where: { id: f.workspaceId } });
  expect(f.page.mock.calls.map((call) => call[0].selector.kind)).toEqual([
    'personOnly',
    'personOnly',
    'workspaceMemberOnly',
    'workspaceMemberOnly',
  ]);
  expect(f.page.mock.calls.map((call) => call[0].afterParticipantId)).toEqual([
    undefined,
    personCursor,
    undefined,
    memberCursor,
  ]);
  const operations = f.page.mock.calls.map((call) => call[0].operation);
  expect(new Set(operations.map((op) => op.correlationId)).size).toBe(1);
  expect(operations[0].correlationId).toEqual(expect.any(String));
  for (const op of operations)
    expect(op).toMatchObject({
      workspaceId: f.workspaceId,
      actor: {
        kind: 'system',
        id: CalendarEventParticipantMatchParticipantJob.name,
      },
    });
  expect(f.legacyPerson).not.toHaveBeenCalled();
  expect(f.legacyMember).not.toHaveBeenCalled();
});

it('calendar job captures caller-owned arrays before the workspace lookup awaits', async () => {
  const f = buildRematchJob(),
    originalWorkspace = f.workspaceId;
  f.workspace.mockImplementation(async () => {
    f.input.workspaceId = randomUUID();
    f.input.participantMatching.personEmails[0] = 'mutated@example.test';
    f.input.participantMatching.workspaceMemberIds[0] = randomUUID();
    return { id: originalWorkspace, activationStatus: 'ACTIVE' };
  });
  await f.run();
  expect(f.page.mock.calls[0][0]).toMatchObject({
    workspaceId: originalWorkspace,
    selector: { kind: 'personOnly', personEmails: ['Before@example.test'] },
  });
  expect(f.page.mock.calls[1][0]).toMatchObject({
    workspaceId: originalWorkspace,
    selector: { kind: 'workspaceMemberOnly', workspaceMemberIds: [f.memberId] },
  });
});

it.each([null, 'PENDING_CREATION', 'SUSPENDED'])(
  'calendar job retains the non-active workspace guard: %s',
  async (status) => {
    const f = buildRematchJob();
    f.workspace.mockResolvedValue(status ? { activationStatus: status } : null);
    await f.run();
    expect(f.page).not.toHaveBeenCalled();
  },
);

it('calendar job skips empty lanes', async () => {
  const f = buildRematchJob();
  f.input.participantMatching.personEmails = [];
  f.input.participantMatching.workspaceMemberIds = [];
  await f.run();
  expect(f.page).not.toHaveBeenCalled();
});

it.each(['ordinary', 'unknown', 'confirmed'] as const)(
  'calendar job preserves %s page failure and does not enter later pages or member lane',
  async (kind) => {
    const f = buildRematchJob(),
      cursor = randomUUID();
    const error =
      kind === 'ordinary'
        ? new Error('page failed')
        : kind === 'confirmed'
          ? new CoreAuditPostCommitError(new Error('hook failed'))
          : new NativeTransactionOutcomeUnknownError(
              'commit',
              new Error('ack lost'),
            );
    f.page
      .mockResolvedValueOnce({ nextCursor: cursor })
      .mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.page).toHaveBeenCalledTimes(2);
    expect(
      f.page.mock.calls.every((call) => call[0].selector.kind === 'personOnly'),
    ).toBe(true);
  },
);

it('calendar job continues beyond five full page cursors without imposing the import event-count cap', async () => {
  const f = buildRematchJob();
  f.input.participantMatching.workspaceMemberIds = [];
  const cursors = Array.from({ length: 6 }, () => randomUUID()).sort();
  for (const nextCursor of cursors)
    f.page.mockResolvedValueOnce({ nextCursor });
  f.page.mockResolvedValueOnce({ nextCursor: null });
  await f.run();
  expect(f.page).toHaveBeenCalledTimes(7);
  expect(f.page.mock.calls.map((call) => call[0].afterParticipantId)).toEqual([
    undefined,
    ...cursors,
  ]);
});
