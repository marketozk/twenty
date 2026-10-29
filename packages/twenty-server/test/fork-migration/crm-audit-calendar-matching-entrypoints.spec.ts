import { randomUUID } from 'node:crypto';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class CreateCompanyAndContactJob {} }),
);

const build = (autoCreate = true) => {
  const workspaceId = randomUUID(),
    participantId = randomUUID(),
    eventId = randomUUID();
  const trace: string[] = [];
  const rows = [
    {
      id: participantId,
      handle: 'persisted@example.test',
      displayName: 'Persisted participant',
    },
  ];
  const find = jest.fn().mockResolvedValue(rows);
  const enqueue = jest.fn().mockImplementation(async () => {
    trace.push('enqueue');
  });
  const match = jest.fn().mockImplementation(async () => {
    trace.push('match');
  });
  const service = new CalendarEventParticipantService(
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
      getRepository: () => ({ find }),
    } as never,
    { matchCalendarImportParticipantsWithAudit: match } as never,
    { add: enqueue } as never,
  );
  const input = {
    workspaceId,
    savedParticipantIds: [participantId],
    calendarEventIds: [eventId],
    participantsOfLinkedEvents: [
      {
        handle: 'linked@example.test',
        displayName: 'Linked participant',
        responseStatus: 'ACCEPTED',
        isOrganizer: false,
      },
    ],
    calendarChannel: {
      id: randomUUID(),
      isContactAutoCreationEnabled: autoCreate,
    },
    connectedAccount: {
      id: randomUUID(),
      handleAliases: ['captured@example.test'],
    },
    auditOperation: {
      workspaceId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      actor: { kind: 'coreUser' as const, id: randomUUID() },
      initiator: { kind: 'coreUser' as const, id: randomUUID() },
    },
  };
  const run = () =>
    service.matchParticipantsAndEnqueueContactCreationJob(input as never);
  return {
    workspaceId,
    participantId,
    eventId,
    trace,
    find,
    enqueue,
    match,
    service,
    input,
    run,
  };
};

it('enqueues captured actual and linked contacts before a separate closed matching operation', async () => {
  const f = build();
  await f.run();
  expect(f.trace).toEqual(['enqueue', 'match']);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.enqueue.mock.calls[0][1]).toMatchObject({
    workspaceId: f.workspaceId,
    contactsToCreate: [
      {
        handle: 'persisted@example.test',
        displayName: 'Persisted participant',
      },
      { handle: 'linked@example.test', displayName: 'Linked participant' },
    ],
  });
  const input = f.match.mock.calls[0][0];
  expect(input).toEqual({
    workspaceId: f.workspaceId,
    participantIds: [f.participantId],
    eventIds: [f.eventId],
    operation: expect.objectContaining({
      workspaceId: f.workspaceId,
      actor: f.input.auditOperation.actor,
      initiator: f.input.auditOperation.initiator,
      correlationId: f.input.auditOperation.correlationId,
      causationId: f.input.auditOperation.operationId,
    }),
  });
  expect(input.operation.operationId).not.toBe(
    f.input.auditOperation.operationId,
  );
});

it('still reconciles event targets with no newly inserted participants and disabled contact creation', async () => {
  const f = build(false);
  f.input.savedParticipantIds = [];
  f.find.mockResolvedValue([]);
  await f.run();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.match).toHaveBeenCalledWith(
    expect.objectContaining({ participantIds: [], eventIds: [f.eventId] }),
  );
});

it('does not start matching when enqueue fails and does not retry the enqueue', async () => {
  const f = build(),
    error = new Error('queue unavailable');
  f.enqueue.mockRejectedValue(error);
  await expect(f.run()).rejects.toBe(error);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.match).not.toHaveBeenCalled();
});

it.each(['ordinary', 'unknown'] as const)(
  'preserves %s matching failure after the already successful enqueue without replay',
  async (kind) => {
    const f = build();
    const error =
      kind === 'ordinary'
        ? new Error('matching failed')
        : new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('commit acknowledgement lost'),
          );
    f.match.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.match).toHaveBeenCalledTimes(1);
  },
);

it('captures IDs, authority, aliases, contact flag and linked text before the first await', async () => {
  const f = build(),
    actor = { ...f.input.auditOperation.actor },
    initiator = { ...f.input.auditOperation.initiator };
  const causationId = f.input.auditOperation.operationId,
    correlationId = f.input.auditOperation.correlationId,
    accountId = f.input.connectedAccount.id;
  f.find.mockImplementation(async () => {
    f.input.savedParticipantIds[0] = randomUUID();
    f.input.calendarEventIds[0] = randomUUID();
    f.input.auditOperation.actor.id = randomUUID();
    f.input.auditOperation.initiator.id = randomUUID();
    f.input.auditOperation.operationId = randomUUID();
    f.input.connectedAccount.id = randomUUID();
    f.input.connectedAccount.handleAliases[0] = 'mutated@example.test';
    f.input.calendarChannel.isContactAutoCreationEnabled = false;
    f.input.participantsOfLinkedEvents[0].handle = 'mutated@example.test';
    return [
      {
        id: f.participantId,
        handle: 'persisted@example.test',
        displayName: 'Persisted participant',
      },
    ];
  });
  await f.run();
  expect(f.match.mock.calls[0][0]).toMatchObject({
    participantIds: [f.participantId],
    eventIds: [f.eventId],
    operation: { actor, initiator, causationId, correlationId },
  });
  expect(f.enqueue.mock.calls[0][1]).toMatchObject({
    connectedAccount: {
      id: accountId,
      handleAliases: ['captured@example.test'],
    },
    contactsToCreate: expect.arrayContaining([
      { handle: 'linked@example.test', displayName: 'Linked participant' },
    ]),
  });
});

it.each(['missing', 'foreign'] as const)(
  'refuses %s audit scope before queue or matching',
  async (kind) => {
    const f = build();
    if (kind === 'missing') Reflect.deleteProperty(f.input, 'auditOperation');
    else f.input.auditOperation.workspaceId = randomUUID();
    await expect(f.run()).rejects.toThrow('scoped save audit operation');
    expect(f.find).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.match).not.toHaveBeenCalled();
  },
);
