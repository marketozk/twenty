import { randomUUID } from 'node:crypto';
import { ConnectedAccountProvider } from 'twenty-shared/types';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { membershipCleanupOperation } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
  withCrmAuditIdentity,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventsImportService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service';
import { CreateCalendarEventService } from 'src/modules/calendar/calendar-event-creation-manager/services/create-calendar-event.service';
import { CreateCalendarEventResolver } from 'src/modules/calendar/calendar-event-creation-manager/resolvers/create-calendar-event.resolver';
import { CreateCalendarEventTool } from 'src/engine/core-modules/tool/tools/calendar-tool/create-calendar-event-tool';

// These are constructor tokens only; the save capture, callers and provider-result flow stay real.
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service',
  () => ({ CalendarEventParticipantService: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-creation-manager/drivers/caldav/services/caldav-create-event.service',
  () => ({ CalDavCreateEventService: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-creation-manager/drivers/google-calendar/services/google-calendar-create-event.service',
  () => ({ GoogleCalendarCreateEventService: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-creation-manager/drivers/microsoft-calendar/services/microsoft-calendar-create-event.service',
  () => ({ MicrosoftCalendarCreateEventService: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-creation-manager/services/calendar-event-composer.service',
  () => ({ CalendarEventComposerService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
  () => ({ ConnectedAccountMetadataService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/permissions/permissions.service',
  () => ({ PermissionsService: class {} }),
);
jest.mock('src/engine/core-modules/i18n/i18n.service', () => ({
  I18nService: class {},
}));
jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({ CacheStorageService: class {} }),
);
jest.mock('src/modules/blocklist/repositories/blocklist.repository', () => ({
  BlocklistRepository: class {},
}));
jest.mock(
  'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service',
  () => ({ CalendarEventCleanerService: class {} }),
);
jest.mock(
  'src/modules/calendar/common/services/calendar-channel-sync-status.service',
  () => ({ CalendarChannelSyncStatusService: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-import-manager/services/calendar-import-events.service',
  () => ({ CalendarImportEventsService: class {} }),
);
jest.mock(
  'src/modules/connected-account/email-alias-manager/services/email-alias-manager.service',
  () => ({ EmailAliasManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);

const workspaceId = randomUUID();
const userId = randomUUID();
const membershipId = randomUUID();
const accountId = randomUUID();
const channelId = randomUUID();
const identity = {
  workspaceId,
  actor: { kind: 'coreUser' as const, id: userId },
  correlationId: randomUUID(),
};
const operation = () => membershipCleanupOperation(workspaceId, identity)!;
const input = () => ({
  connectedAccountId: accountId,
  title: 'Calendar fixture',
  startsAt: '2026-10-29T10:00:00Z',
  endsAt: '2026-10-29T11:00:00Z',
});
const composed = () => ({
  input: {},
  connectedAccount: {
    id: accountId,
    provider: ConnectedAccountProvider.GOOGLE,
    handleAliases: ['alias@example.test'],
  },
  calendarChannel: { id: channelId, connectedAccountId: accountId },
});
const fetched = () => ({
  id: 'provider-event',
  iCalUid: 'ical-event',
  title: 'Calendar fixture',
  startsAt: '2026-10-29T10:00:00Z',
  endsAt: '2026-10-29T11:00:00Z',
  participants: [],
  conferenceLinkUrl: '',
});
const build = () => {
  const trace: string[] = [];
  const auditOperation = operation();
  const save = jest
    .fn()
    .mockResolvedValue({ calendarEventIds: ['stored-event'], applied: true });
  const capture = jest.fn().mockImplementation(async () => {
    trace.push('capture');
    return auditOperation;
  });
  const data = composed();
  const provider = jest.fn().mockImplementation(async () => {
    trace.push('provider');
    return fetched();
  });
  const create = new CreateCalendarEventService(
    { createCalendarEvent: provider } as never,
    {} as never,
    {} as never,
    {
      saveCalendarEventsAndEnqueueContactCreationJob: save,
      captureCalendarSaveAuditOperation: capture,
    } as never,
  );
  const compose = jest.fn().mockResolvedValue({ success: true, data });
  const i18n = { getI18nInstance: () => ({ _: (value: unknown) => value }) };
  const resolver = new CreateCalendarEventResolver(
    { verifyUsableByCaller: jest.fn() } as never,
    { composeCalendarEvent: compose } as never,
    create,
    i18n as never,
  );
  const tool = new CreateCalendarEventTool(
    { composeCalendarEvent: compose } as never,
    create,
    i18n as never,
  );
  return {
    trace,
    auditOperation,
    save,
    capture,
    data,
    provider,
    create,
    compose,
    resolver,
    tool,
  };
};
const invokeResolver = (
  resolver: CreateCalendarEventResolver,
  value = input(),
  workspace = { id: workspaceId },
) =>
  resolver.createCalendarEvent(value, workspace as never, membershipId, {
    req: { locale: 'en' },
  });
const toolContext = (auth?: unknown) => ({
  workspaceId,
  authContext: auth ?? {
    type: 'user',
    workspace: { id: workspaceId },
    user: { id: userId },
  },
});

describe('LOG143 calendar save caller attribution', () => {
  it('captures before provider and forwards the exact operation as the fifth save argument', async () => {
    const f = build();
    expect((await invokeResolver(f.resolver)).success).toBe(true);
    expect(f.trace).toEqual(['capture', 'provider']);
    expect(f.save.mock.calls[0][4]).toBe(f.auditOperation);
    expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it('refuses missing request attribution before compose or provider', async () => {
    const f = build();
    f.capture.mockRejectedValue(new Error('identity unavailable'));
    expect((await invokeResolver(f.resolver)).success).toBe(false);
    expect(f.compose).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('pins request fields and workspace before capture awaits', async () => {
    const f = build();
    const value = { ...input(), attendees: 'original@example.test' };
    const workspace = { id: workspaceId };
    f.capture.mockImplementation(async () => {
      value.connectedAccountId = randomUUID();
      value.title = 'changed';
      value.attendees = 'changed@example.test';
      workspace.id = randomUUID();
      return f.auditOperation;
    });
    expect((await invokeResolver(f.resolver, value, workspace)).success).toBe(
      true,
    );
    expect(f.compose.mock.calls[0][0]).toMatchObject({
      connectedAccountId: accountId,
      title: 'Calendar fixture',
      attendees: 'original@example.test',
    });
    expect(f.compose.mock.calls[0][1]).toBe(workspaceId);
    expect(f.save.mock.calls[0][3]).toBe(workspaceId);
  });

  it('pins persistence channel/account/aliases before the external call', async () => {
    const f = build();
    f.provider.mockImplementation(async () => {
      f.data.calendarChannel.id = randomUUID();
      f.data.connectedAccount.id = randomUUID();
      f.data.connectedAccount.handleAliases.push('changed@example.test');
      return fetched();
    });
    expect((await invokeResolver(f.resolver)).success).toBe(true);
    expect(f.save.mock.calls[0][1].id).toBe(channelId);
    expect(f.save.mock.calls[0][2]).toMatchObject({
      id: accountId,
      handleAliases: ['alias@example.test'],
    });
  });

  it.each([
    new Error('local rollback'),
    new NativeTransactionOutcomeUnknownError('commit', new Error('ACK lost')),
    new CoreAuditPostCommitError(new Error('matching failed')),
  ])(
    'preserves provider success when local persistence and its logger fail: %p',
    async (failure) => {
      const f = build();
      f.save.mockRejectedValue(failure);
      jest
        .spyOn(Reflect.get(f.create, 'logger'), 'warn')
        .mockImplementation(() => {
          throw new Error('logging failed');
        });
      const result = await invokeResolver(f.resolver);
      expect(result.success).toBe(true);
      expect(result.calendarEventId).toBeUndefined();
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(f.save).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a provider failure unsuccessful without attempting local save', async () => {
    const f = build();
    f.provider.mockRejectedValue(new Error('provider rejected'));
    expect((await invokeResolver(f.resolver)).success).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it('uses trusted actingAgent attribution and does not promote context.agentId', async () => {
    const f = build();
    const applicationId = randomUUID();
    const actingAgentId = randomUUID();
    const context = {
      ...toolContext({
        type: 'application',
        workspace: { id: workspaceId },
        application: { id: applicationId },
        actingAgent: { id: actingAgentId },
      }),
      agentId: randomUUID(),
    };
    await f.tool.execute(input() as never, context as never);
    expect(f.capture.mock.calls[0][1]).toMatchObject({
      actor: { kind: 'agent', id: actingAgentId },
      initiator: { kind: 'application', id: applicationId },
    });
  });

  it('a token agentId alone leaves application attribution unchanged', async () => {
    const f = build();
    const applicationId = randomUUID();
    await f.tool.execute(
      input() as never,
      {
        ...toolContext({
          type: 'application',
          workspace: { id: workspaceId },
          application: { id: applicationId },
        }),
        agentId: randomUUID(),
      } as never,
    );
    expect(f.capture.mock.calls[0][1].actor).toEqual({
      kind: 'application',
      id: applicationId,
    });
  });

  it('pins tool primitive fields and trusted identity before capture awaits', async () => {
    const f = build();
    const parameters = { ...input(), attendees: 'original@example.test' };
    const auth = {
      type: 'user',
      workspace: { id: workspaceId },
      user: { id: userId },
    };
    const context = { workspaceId, authContext: auth };
    f.capture.mockImplementation(async () => {
      parameters.attendees = 'changed@example.test';
      parameters.connectedAccountId = randomUUID();
      auth.user.id = randomUUID();
      auth.workspace.id = randomUUID();
      context.workspaceId = randomUUID();
      return f.auditOperation;
    });
    expect(
      (await f.tool.execute(parameters as never, context as never)).success,
    ).toBe(true);
    expect(f.capture.mock.calls[0][1]).toMatchObject({
      workspaceId,
      actor: { kind: 'coreUser', id: userId },
    });
    expect(f.compose.mock.calls[0]).toEqual([
      expect.objectContaining({
        attendees: 'original@example.test',
        connectedAccountId: accountId,
      }),
      workspaceId,
    ]);
    expect(f.save.mock.calls[0][3]).toBe(workspaceId);
  });

  it.each([
    undefined,
    { type: 'system', workspace: { id: workspaceId } },
    { type: 'pendingActivationUser', workspace: { id: workspaceId } },
    { type: 'user', workspace: { id: randomUUID() }, user: { id: userId } },
  ])(
    'refuses an untrusted tool identity before provider: %p',
    async (authContext) => {
      const f = build();
      expect(
        (
          await f.tool.execute(
            input() as never,
            { workspaceId, authContext } as never,
          )
        ).success,
      ).toBe(false);
      expect(f.provider).not.toHaveBeenCalled();
      expect(f.capture).not.toHaveBeenCalled();
    },
  );

  it('keeps tool success when local persistence and success logging both fail', async () => {
    const f = build();
    f.save.mockRejectedValue(
      new NativeTransactionOutcomeUnknownError('commit', new Error('ACK lost')),
    );
    jest
      .spyOn(Reflect.get(f.create, 'logger'), 'warn')
      .mockImplementation(() => {
        throw new Error('warn failed');
      });
    jest.spyOn(Reflect.get(f.tool, 'logger'), 'log').mockImplementation(() => {
      throw new Error('log failed');
    });
    const result = await f.tool.execute(
      input() as never,
      toolContext() as never,
    );
    expect(result.success).toBe(true);
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
});

describe('LOG143 trusted save operation capture', () => {
  const queryBuilder = () => ({
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  });
  const service = (query = queryBuilder()) =>
    new CalendarSaveEventsService(
      {} as never,
      {} as never,
      {} as never,
      { createQueryBuilder: jest.fn().mockReturnValue(query) } as never,
    );

  it('uses explicit captured trusted context when request ALS is absent', async () => {
    const captured = await service().captureCalendarSaveAuditOperation(
      workspaceId,
      identity,
    );
    expect(captured.actor).toEqual(identity.actor);
    expect(captured.operationId).toBeDefined();
  });

  it('preserves ambient impersonation initiator when the effective user agrees', async () => {
    const ambient = {
      ...identity,
      initiator: { kind: 'coreUser' as const, id: randomUUID() },
    };
    const captured = await withCrmAuditIdentity(workspaceId, ambient, () =>
      service().captureCalendarSaveAuditOperation(workspaceId, identity),
    );
    expect(captured.initiator).toEqual(ambient.initiator);
  });

  it('resolves real request impersonation through the public query builder escape hatch', async () => {
    const initiatorId = randomUUID();
    const impersonatorMembershipId = randomUUID();
    const query = queryBuilder();
    query.getRawOne.mockResolvedValue({ userId: initiatorId });
    const snapshot = captureCrmAuditRequest({
      workspace: { id: workspaceId },
      user: { id: userId },
      impersonationContext: {
        impersonatorUserWorkspaceId: impersonatorMembershipId,
      },
    });
    const captured = await withCrmAuditRequest(snapshot, () =>
      service(query).captureCalendarSaveAuditOperation(workspaceId, identity),
    );
    expect(captured.actor).toEqual(identity.actor);
    expect(captured.initiator).toEqual({ kind: 'coreUser', id: initiatorId });
    expect(query.select).toHaveBeenCalledWith('member."userId"', 'userId');
    expect(query.from).toHaveBeenCalledWith('core.userWorkspace', 'member');
    expect(query.where).toHaveBeenCalledWith('member.id = :id', {
      id: impersonatorMembershipId,
    });
    expect(query.getRawOne).toHaveBeenCalledTimes(1);
  });

  it('refuses unresolved request impersonator instead of falling back to a first-person identity', async () => {
    const query = queryBuilder();
    query.getRawOne.mockResolvedValue(undefined);
    const snapshot = captureCrmAuditRequest({
      workspace: { id: workspaceId },
      user: { id: userId },
      impersonationContext: { impersonatorUserWorkspaceId: randomUUID() },
    });
    await expect(
      withCrmAuditRequest(snapshot, () =>
        service(query).captureCalendarSaveAuditOperation(workspaceId, identity),
      ),
    ).rejects.toThrow('impersonation initiator unavailable');
  });

  it('refuses inconsistent ambient and trusted effective principals', async () => {
    await expect(
      withCrmAuditIdentity(
        workspaceId,
        { ...identity, actor: { kind: 'coreUser', id: randomUUID() } },
        () =>
          service().captureCalendarSaveAuditOperation(workspaceId, identity),
      ),
    ).rejects.toThrow('identity mismatch');
  });

  it('refuses absent attribution rather than inventing a system actor', async () => {
    await expect(
      service().captureCalendarSaveAuditOperation(workspaceId),
    ).rejects.toThrow('authenticated audit identity');
  });
});

describe('LOG143 importer save attribution', () => {
  const importer = () => {
    const run = {
      kind: 'calendar',
      workspaceId,
      channelId,
      connectedAccountId: accountId,
      startedAt: '2026-10-29T10:00:00.000001Z',
    };
    const account = {
      id: accountId,
      handleAliases: [],
      userWorkspaceId: membershipId,
    };
    const channel = {
      id: channelId,
      connectedAccountId: accountId,
      handle: 'self@example.test',
      connectedAccount: account,
    };
    const save = jest
      .fn()
      .mockResolvedValue({ applied: true, calendarEventIds: [] });
    const handler = jest.fn();
    const completed = jest.fn();
    const service = new CalendarEventsImportService(
      { setPop: jest.fn().mockResolvedValue(['one']) } as never,
      {
        executeInWorkspaceContext: (work: () => unknown) => work(),
        getRepository: () => ({ findOne: async () => ({ id: randomUUID() }) }),
      } as never,
      { getEntriesApplicableToWorkspaceMember: async () => [] } as never,
      {
        deleteCalendarChannelEventAssociationsAndRelatedOrphans: jest.fn(),
      } as never,
      {
        beginCalendarEventsImport: async () => ({ channel, run }),
        recoverLegacyCalendarImport: async () => false,
        markAsCalendarEventSyncCompleted: completed,
      } as never,
      { saveCalendarEventsAndEnqueueContactCreationJob: save } as never,
      { handleDriverException: handler } as never,
      {
        getCalendarEvents: async () =>
          Array.from({ length: 1001 }, (_, i) => ({
            ...fetched(),
            id: String(i),
            isCanceled: false,
            isPrivate: false,
          })),
      } as never,
      {} as never,
      { findOne: async () => ({ userId }) } as never,
    );
    return { service, save, handler, completed, channel, account, run };
  };

  it('uses fresh operations for each batch and keeps expectedRun sixth', async () => {
    const f = importer();
    await f.service.processCalendarEventsImport(
      f.channel as never,
      f.account as never,
      workspaceId,
    );
    expect(f.save).toHaveBeenCalledTimes(2);
    const first = f.save.mock.calls[0][4];
    const second = f.save.mock.calls[1][4];
    expect(first.actor).toEqual({
      kind: 'system',
      id: 'CalendarEventsImportService',
    });
    expect(first.workspaceId).toBe(workspaceId);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.correlationId).toBe(first.correlationId);
    expect(f.save.mock.calls[0][5]).toEqual(f.run);
    expect(f.save.mock.calls[1][5]).toEqual(f.run);
  });

  it('stops after stale save without later batches or status writes', async () => {
    const f = importer();
    f.save.mockResolvedValueOnce({ applied: false, calendarEventIds: [] });
    await f.service.processCalendarEventsImport(
      f.channel as never,
      f.account as never,
      workspaceId,
    );
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.completed).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('propagates an unsafe save outcome without failure handler or later status writes', async () => {
    const f = importer();
    const failure = new CoreAuditPostCommitError(
      new Error('postcommit matching'),
    );
    f.save.mockRejectedValueOnce(failure);
    await expect(
      f.service.processCalendarEventsImport(
        f.channel as never,
        f.account as never,
        workspaceId,
      ),
    ).rejects.toBe(failure);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.completed).not.toHaveBeenCalled();
  });
});
