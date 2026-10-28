import { randomUUID } from 'node:crypto';

import { MessageParticipantRole } from 'twenty-shared/types';

import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { createOmniNativeReconciliationFixture } from 'test/fork-migration/omni-native-reconciliation.fixture';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeReconciliationFixture();
const permissions = { shouldBypassPermissionChecks: true } as const;
const run = async <T>(work: (scope: WorkspaceTransactionScope) => Promise<T>) =>
  fixture.withContext(() =>
    fixture.dataSource.transaction(work, { commitOutcome: 'strict' }),
  );
// Only construct the protected fixture with domain authority. Reconciliation
// still runs through the ordinary scope above and must filter owned records.
const seedRun = async <T>(
  work: (scope: WorkspaceTransactionScope) => Promise<T>,
) =>
  fixture.withContext(() =>
    fixture.dataSource.transaction(
      (scope) => work(withOmniRepositoryOptions(scope)),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const insertNative = async (
  scope: WorkspaceTransactionScope,
  name: string,
  fields: Record<string, unknown>,
) => {
  const id = randomUUID();
  await scope.getRepository(name, permissions).insert({ id, ...fields });
  return id;
};
type Marker = 'binding' | 'link' | 'conversation';
type Seed = {
  personId: string;
  oldPersonId: string;
  memberId: string;
  oldMemberId: string;
  companyId: string;
  oldCompanyId: string;
  opportunityId: string;
  email: { threadId: string; messageId: string; participantId: string };
  omni: { threadId: string; messageId: string; participantId: string };
};
let seed: Seed;

const createSeed = async (
  marker: Marker = 'binding',
  identity = 'old',
  beforeOwnership?: (seed: Seed) => Promise<void>,
) => {
  const binding = await fixture.createBinding();
  const result = await seedRun(async (scope) => {
    const oldCompanyId = await insertNative(scope, 'company', {
      name: 'Prior company',
    });
    const companyId = await insertNative(scope, 'company', {
      name: 'Current company',
    });
    const oldPersonId = await insertNative(scope, 'person', {
      name: { firstName: 'Prior', lastName: 'Person' },
      emails: { primaryEmail: 'old@example.test', additionalEmails: [] },
      companyId: oldCompanyId,
    });
    const personId = await insertNative(scope, 'person', {
      name: { firstName: 'Current', lastName: 'Person' },
      emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
      companyId,
    });
    const oldMemberId = await insertNative(scope, 'workspaceMember', {
      name: { firstName: 'Prior', lastName: 'Member' },
      userId: randomUUID(),
      userEmail: 'old@example.test',
    });
    const memberId = await insertNative(scope, 'workspaceMember', {
      name: { firstName: 'Current', lastName: 'Member' },
      userId: randomUUID(),
      userEmail: 'client@example.test',
    });
    const opportunityId = await insertNative(scope, 'opportunity', {
      name: 'Current opportunity',
      pointOfContactId: personId,
      companyId,
    });
    const createMessage = async () => {
      const threadId = await insertNative(scope, 'messageThread', {
        subject: 'Fixture thread',
      });
      const messageId = await insertNative(scope, 'message', {
        messageThreadId: threadId,
        headerMessageId: randomUUID(),
        subject: 'Fixture subject',
        text: 'Fixture body',
        receivedAt: new Date('2026-10-27T00:00:00Z'),
        isDraft: false,
      });
      const participantId = await insertNative(scope, 'messageParticipant', {
        messageId,
        role: MessageParticipantRole.FROM,
        handle: 'client@example.test',
        displayName: 'Captured author',
        personId: identity === 'old' ? oldPersonId : personId,
        workspaceMemberId: oldMemberId,
      });
      await insertNative(scope, 'messageThreadTarget', {
        messageThreadId: threadId,
        targetPersonId: oldPersonId,
        targetCompanyId: null,
        targetOpportunityId: null,
        isAutomaticallyAssigned: true,
        isManuallyAssigned: false,
      });
      return { threadId, messageId, participantId };
    };
    const email = await createMessage();
    const omni = await createMessage();
    if (marker === 'binding') {
      await insertNative(scope, 'messageChannelMessageAssociation', {
        messageId: omni.messageId,
        messageChannelId: binding.channelId,
        messageExternalId: 'fixture-message',
        messageThreadExternalId: 'fixture-chat',
        direction: 'INCOMING',
        deletedAt: new Date('2026-10-26T00:00:00Z'),
      });
    }
    return {
      personId,
      oldPersonId,
      memberId,
      oldMemberId,
      companyId,
      oldCompanyId,
      opportunityId,
      email,
      omni,
    };
  });
  if (beforeOwnership) await beforeOwnership(result);
  if (marker !== 'binding') {
    const conversationId = await fixture.markConversation(
      binding,
      result.omni.threadId,
    );
    if (marker === 'link')
      await fixture.markMessage(binding, conversationId, result.omni.messageId);
  }
  fixture.eventEmitter.mockClear();
  return result;
};
const participants = (scope: WorkspaceTransactionScope) =>
  scope
    .getRepository<MessageParticipantWorkspaceEntity>(
      'messageParticipant',
      permissions,
    )
    .find();
const omniSnapshot = async () => ({
  participants: (await fixture.read('messageParticipant')).filter(
    (row: Record<string, unknown>) => row.messageId === seed.omni.messageId,
  ),
  targets: (await fixture.read('messageThreadTarget')).filter(
    (row: Record<string, unknown>) =>
      row.messageThreadId === seed.omni.threadId,
  ),
});
const expectEmailTargets = async () => {
  const targets: Record<string, unknown>[] = (
    await fixture.read('messageThreadTarget')
  ).filter(
    (row: Record<string, unknown>) =>
      row.messageThreadId === seed.email.threadId,
  );
  expect(targets).toHaveLength(3);
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPersonId: seed.personId }),
      expect.objectContaining({ targetCompanyId: seed.companyId }),
      expect.objectContaining({ targetOpportunityId: seed.opportunityId }),
    ]),
  );
};
const expectOnlyEmailEvents = () => {
  expect(fixture.eventEmitter).toHaveBeenCalled();
  const events = JSON.stringify(fixture.eventEmitter.mock.calls);
  expect(events).not.toContain(seed.omni.participantId);
  expect(events).not.toContain(seed.omni.threadId);
  expect(events).toMatch(
    new RegExp(`${seed.email.participantId}|${seed.email.threadId}`),
  );
};

beforeAll(() => fixture.initialize());
beforeEach(() => fixture.reset());
afterAll(() => fixture.dispose());

describe('native mixed email and omnichannel participant/target reconciliation', () => {
  it.each<Marker>(['binding', 'link', 'conversation'])(
    'preserves omni participants and targets for persisted %s ownership during direct rematch',
    async (marker) => {
      seed = await createSeed(marker);
      const before = await omniSnapshot();
      await run(async (scope) =>
        fixture.matcher.matchParticipants({
          participants: await participants(scope),
          sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
          objectMetadataName: 'messageParticipant',
          matchWith: 'workspaceMemberAndPerson',
          transactionScope: scope,
        }),
      );
      expect(await omniSnapshot()).toEqual(before);
      expect(
        (await fixture.read('messageParticipant')).find(
          (row: Record<string, unknown>) => row.id === seed.email.participantId,
        ),
      ).toMatchObject({
        personId: seed.personId,
        workspaceMemberId: seed.memberId,
      });
      await expectEmailTargets();
      expectOnlyEmailEvents();
    },
  );

  it('keeps ordinary APP participant matching behavior when no omni binding owns the channel', async () => {
    seed = await createSeed();
    const channelId = await fixture.coreInsert('messageChannel', {
      workspaceId: fixture.workspaceId,
      type: 'APP',
    });
    await run(async (scope) => {
      await insertNative(scope, 'messageChannelMessageAssociation', {
        messageId: seed.email.messageId,
        messageChannelId: channelId,
        messageExternalId: 'ordinary-app-message',
        messageThreadExternalId: 'ordinary-app-chat',
        direction: 'INCOMING',
      });
    });
    fixture.eventEmitter.mockClear();
    const before = await omniSnapshot();
    await run(async (scope) =>
      fixture.matcher.matchParticipants({
        participants: await participants(scope),
        sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
        objectMetadataName: 'messageParticipant',
        matchWith: 'workspaceMemberAndPerson',
        transactionScope: scope,
      }),
    );
    expect(await omniSnapshot()).toEqual(before);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: Record<string, unknown>) => row.id === seed.email.participantId,
      ),
    ).toMatchObject({
      personId: seed.personId,
      workspaceMemberId: seed.memberId,
    });
    await expectEmailTargets();
    expectOnlyEmailEvents();
  });

  it('protects mixed participant and direct thread reconciliation without a transaction scope', async () => {
    seed = await createSeed('conversation');
    const before = await omniSnapshot();
    await fixture.withContext(async () => {
      const rows = await fixture.dataSource
        .getRepository<MessageParticipantWorkspaceEntity>(
          'messageParticipant',
          permissions,
        )
        .find();
      await fixture.matcher.matchParticipants({
        participants: rows,
        sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
        objectMetadataName: 'messageParticipant',
        matchWith: 'workspaceMemberAndPerson',
      });
      await fixture.targets.reconcileMessageThreadTargets({
        messageThreadIds: [seed.email.threadId, seed.omni.threadId],
      });
    });
    expect(await omniSnapshot()).toEqual(before);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: Record<string, unknown>) => row.id === seed.email.participantId,
      ),
    ).toMatchObject({
      personId: seed.personId,
      workspaceMemberId: seed.memberId,
    });
    await expectEmailTargets();
    expectOnlyEmailEvents();
  });

  it('preserves calendar participant matching and person/company/opportunity targets', async () => {
    seed = await createSeed();
    const before = await omniSnapshot();
    const calendar = await run(async (scope) => {
      const eventId = await insertNative(scope, 'calendarEvent', {
        title: 'Calendar fixture',
        startsAt: '2026-10-27T10:00:00Z',
        endsAt: '2026-10-27T11:00:00Z',
      });
      const participantId = await insertNative(
        scope,
        'calendarEventParticipant',
        {
          calendarEventId: eventId,
          handle: 'client@example.test',
          displayName: 'Calendar author',
          personId: seed.oldPersonId,
          workspaceMemberId: seed.oldMemberId,
          responseStatus: 'ACCEPTED',
          isOrganizer: false,
        },
      );
      await insertNative(scope, 'calendarEventTarget', {
        calendarEventId: eventId,
        targetPersonId: seed.oldPersonId,
        targetCompanyId: null,
        targetOpportunityId: null,
        isAutomaticallyAssigned: true,
        isManuallyAssigned: false,
      });
      return { eventId, participantId };
    });
    fixture.eventEmitter.mockClear();
    await run(async (scope) => {
      const rows = await scope
        .getRepository<CalendarEventParticipantWorkspaceEntity>(
          'calendarEventParticipant',
          permissions,
        )
        .find();
      await fixture.calendarMatcher.matchParticipants({
        participants: rows,
        sourceRecordIds: [calendar.eventId],
        objectMetadataName: 'calendarEventParticipant',
        matchWith: 'workspaceMemberAndPerson',
        transactionScope: scope,
      });
    });
    expect(await omniSnapshot()).toEqual(before);
    expect(await fixture.read('calendarEventParticipant')).toEqual([
      expect.objectContaining({
        id: calendar.participantId,
        personId: seed.personId,
        workspaceMemberId: seed.memberId,
      }),
    ]);
    const targets = await fixture.read('calendarEventTarget');
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          calendarEventId: calendar.eventId,
          targetPersonId: seed.personId,
        }),
        expect.objectContaining({
          calendarEventId: calendar.eventId,
          targetCompanyId: seed.companyId,
        }),
        expect.objectContaining({
          calendarEventId: calendar.eventId,
          targetOpportunityId: seed.opportunityId,
        }),
      ]),
    );
    expect(fixture.eventEmitter).toHaveBeenCalled();
    const events = JSON.stringify(fixture.eventEmitter.mock.calls);
    expect(events).toContain(calendar.participantId);
    expect(events).not.toContain(seed.omni.participantId);
    expect(events).not.toContain(seed.omni.threadId);
  });

  it('preserves member links for omni rows through the member rematch entry point', async () => {
    seed = await createSeed();
    const before = await omniSnapshot();
    await fixture.matcher.matchParticipantsForWorkspaceMembers({
      participantMatching: { workspaceMemberIds: [seed.oldMemberId] },
      objectMetadataName: 'messageParticipant',
      workspaceId: fixture.workspaceId,
    });
    expect(await omniSnapshot()).toEqual(before);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: Record<string, unknown>) => row.id === seed.email.participantId,
      ),
    ).toMatchObject({
      personId: seed.oldPersonId,
      workspaceMemberId: seed.memberId,
    });
    expectOnlyEmailEvents();
  });

  it('preserves link-owned rows without an APP association through the person rematch entry point', async () => {
    seed = await createSeed('link');
    const before = await omniSnapshot();
    await fixture.matcher.matchParticipantsForPeople({
      participantMatching: { personEmails: ['CLIENT@example.test'] },
      objectMetadataName: 'messageParticipant',
      workspaceId: fixture.workspaceId,
    });
    expect(await omniSnapshot()).toEqual(before);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: Record<string, unknown>) => row.id === seed.email.participantId,
      ),
    ).toMatchObject({
      personId: seed.personId,
      workspaceMemberId: seed.oldMemberId,
    });
    await expectEmailTargets();
    expectOnlyEmailEvents();
  });

  it.each(['targetsOnly', 'emptyParticipants'] as const)(
    'filters source IDs before %s target reconciliation',
    async (variant) => {
      seed = await createSeed('binding', 'current');
      const before = await omniSnapshot();
      await run(async (scope) =>
        fixture.matcher.matchParticipants({
          participants:
            variant === 'targetsOnly' ? await participants(scope) : [],
          sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
          objectMetadataName: 'messageParticipant',
          matchWith: variant === 'targetsOnly' ? 'targetsOnly' : 'personOnly',
          transactionScope: scope,
        }),
      );
      expect(await omniSnapshot()).toEqual(before);
      await expectEmailTargets();
      expectOnlyEmailEvents();
    },
  );

  it.each<Marker>(['binding', 'link', 'conversation'])(
    'filters persisted %s thread ownership before direct target reconciliation',
    async (marker) => {
      seed = await createSeed(marker, 'current');
      const before = await omniSnapshot();
      await run(async (scope) =>
        fixture.targets.reconcileMessageThreadTargets({
          messageThreadIds: [seed.email.threadId, seed.omni.threadId],
          transactionScope: scope,
        }),
      );
      expect(await omniSnapshot()).toEqual(before);
      await expectEmailTargets();
      expectOnlyEmailEvents();
    },
  );

  it('keeps omni targets when company and opportunity relations change through the people reconciliation entry point', async () => {
    seed = await createSeed('binding', 'current');
    const before = await omniSnapshot();
    await run(async (scope) => {
      await scope
        .getRepository('person', permissions)
        .update(seed.personId, { companyId: seed.oldCompanyId });
      await scope
        .getRepository('opportunity', permissions)
        .update(seed.opportunityId, { pointOfContactId: seed.oldPersonId });
      await fixture.targets.reconcileMessageThreadTargets({
        messageThreadIds: [seed.email.threadId],
        transactionScope: scope,
      });
      await scope
        .getRepository('person', permissions)
        .update(seed.personId, { companyId: seed.companyId });
      await scope
        .getRepository('opportunity', permissions)
        .update(seed.opportunityId, { pointOfContactId: seed.personId });
    });
    fixture.eventEmitter.mockClear();
    await fixture.targets.reconcileTargetsForPeople({
      personIds: [seed.personId],
      workspaceId: fixture.workspaceId,
    });
    expect(await omniSnapshot()).toEqual(before);
    await expectEmailTargets();
    expectOnlyEmailEvents();
  });

  it('uses persisted thread ownership even when the thread has no current native messages', async () => {
    seed = await createSeed('conversation', 'current');
    await seedRun(async (scope) => {
      await scope
        .getRepository('messageParticipant', permissions)
        .delete({ id: seed.omni.participantId });
      await scope
        .getRepository('message', permissions)
        .delete({ id: seed.omni.messageId });
    });
    fixture.eventEmitter.mockClear();
    const before = await omniSnapshot();
    await run(async (scope) =>
      fixture.targets.reconcileMessageThreadTargets({
        messageThreadIds: [seed.email.threadId, seed.omni.threadId],
        transactionScope: scope,
      }),
    );
    expect(await omniSnapshot()).toEqual(before);
    await expectEmailTargets();
    expectOnlyEmailEvents();
  });

  it('does not change or emit events for an all-omni batch', async () => {
    seed = await createSeed('conversation');
    const before = await omniSnapshot();
    await run(async (scope) =>
      fixture.matcher.matchParticipants({
        participants: (await participants(scope)).filter(
          (row) => row.messageId === seed.omni.messageId,
        ),
        sourceRecordIds: [seed.omni.messageId],
        objectMetadataName: 'messageParticipant',
        matchWith: 'workspaceMemberAndPerson',
        transactionScope: scope,
      }),
    );
    expect(await omniSnapshot()).toEqual(before);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('rolls back earlier native changes and emits no events if ownership lookup fails', async () => {
    seed = await createSeed();
    const before = await fixture.read('person');
    const beforeOmni = await omniSnapshot();
    await expect(
      run(async (scope) => {
        await scope
          .getRepository('person', permissions)
          .update(seed.personId, { jobTitle: 'Must roll back' });
        const failingScope = {
          ...scope,
          executeRawQuery: (sql: string, parameters?: unknown[]) =>
            sql.includes('core."omniMessageLink"')
              ? scope.executeRawQuery('SELECT 1/0')
              : scope.executeRawQuery(sql, parameters),
        };
        await fixture.matcher.matchParticipants({
          participants: await participants(scope),
          sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
          objectMetadataName: 'messageParticipant',
          matchWith: 'personOnly',
          transactionScope: failingScope,
        });
      }),
    ).rejects.toThrow();
    expect(await fixture.read('person')).toEqual(before);
    expect(await omniSnapshot()).toEqual(beforeOmni);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('rejects a transaction scope from another workspace before native mutations', async () => {
    seed = await createSeed();
    const before = await fixture.read('messageParticipant');
    await expect(
      run(async (scope) =>
        fixture.matcher.matchParticipants({
          participants: await participants(scope),
          sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
          objectMetadataName: 'messageParticipant',
          matchWith: 'personOnly',
          transactionScope: { ...scope, workspaceId: randomUUID() },
        }),
      ),
    ).rejects.toThrow('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
    expect(await fixture.read('messageParticipant')).toEqual(before);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });
});

it('postcommit participant snapshot captured before enrollment cannot rematch newly owned history', async () => {
  let queued: MessageParticipantWorkspaceEntity[] = [];
  seed = await createSeed('conversation', 'old', async () => {
    queued = await run((scope) => participants(scope));
  });
  expect(queued).toHaveLength(2);
  const before = await omniSnapshot();
  const messagesBefore = await fixture.read('message');
  await fixture.withContext(async () => {
    await fixture.matcher.matchParticipants({
      participants: queued,
      sourceRecordIds: [seed.email.messageId, seed.omni.messageId],
      objectMetadataName: 'messageParticipant',
      matchWith: 'workspaceMemberAndPerson',
    });
    await fixture.targets.reconcileMessageThreadTargets({
      messageThreadIds: [seed.email.threadId, seed.omni.threadId],
    });
  });
  expect(await omniSnapshot()).toEqual(before);
  expect(await fixture.read('message')).toEqual(messagesBefore);
  expect(
    (await fixture.read('messageParticipant')).find(
      (row: Record<string, unknown>) => row.id === seed.email.participantId,
    ),
  ).toMatchObject({
    personId: seed.personId,
    workspaceMemberId: seed.memberId,
  });
  await expectEmailTargets();
  expectOnlyEmailEvents();
});
