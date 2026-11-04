import { randomUUID } from 'node:crypto';
import {
  buildMessageImportMatchingPages,
  captureMessageImportMatchingContext,
  captureMessageImportMatchingIntentPayload,
  captureMessageImportMatchingManifest,
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
  type MessageImportMatchingContext,
  type MessageImportMatchingManifest,
} from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { applyNativeMessageImportMatchingWithAudit } from 'src/engine/core-modules/crm-audit/apply-native-message-import-matching-with-audit';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

jest.mock(
  'src/engine/core-modules/crm-audit/apply-native-message-import-matching-with-audit',
  () => ({
    ...jest.requireActual(
      'src/engine/core-modules/crm-audit/message-import-matching-context',
    ),
    applyNativeMessageImportMatchingWithAudit: jest.fn(),
  }),
);
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

const fixture = () => {
  const workspaceId = randomUUID(),
    channelId = randomUUID(),
    connectedAccountId = randomUUID();
  const context: MessageImportMatchingContext = {
    operation: {
      workspaceId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      actor: { kind: 'system', id: 'ImportOrchestrationTest' },
    },
    authority: {
      kind: 'inbound',
      workspaceId,
      connectedAccountId,
      channelId,
      channelType: 'EMAIL_GROUP',
      recipient: 'recipient@example.test',
    },
  };
  const messageId = randomUUID(),
    messageThreadId = randomUUID();
  const manifest: MessageImportMatchingManifest = {
    mode: 'both',
    messages: [{ messageId, messageThreadId }],
    participants: [
      {
        id: randomUUID(),
        messageId,
        personId: null,
        workspaceMemberId: null,
        handle: 'client@example.test',
      },
    ],
  };
  const scope = { workspaceId };
  const manager = {
    executeInWorkspaceContext: jest.fn(async (work: () => Promise<unknown>) =>
      work(),
    ),
    runInWorkspaceTransaction: jest.fn(
      async (
        work: (input: typeof scope) => Promise<unknown>,
        _options?: unknown,
      ) => work(scope),
    ),
  };
  const matcher = new MatchParticipantService(
    manager as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const page = jest.mocked(applyNativeMessageImportMatchingWithAudit);
  page.mockResolvedValue('applied');
  return {
    workspaceId,
    context,
    manifest,
    manager,
    matcher,
    page,
    run: () =>
      matcher.matchMessageImportParticipantsWithAudit({
        workspaceId,
        context,
        manifest,
      }),
  };
};
beforeEach(() => jest.clearAllMocks());

it('captures full saved references and attribution before caller mutation', () => {
  const f = fixture();
  const context = captureMessageImportMatchingContext(f.context),
    manifest = captureMessageImportMatchingManifest(f.manifest);
  f.context.operation.actor.id = 'Mutated';
  const mutableRow = f.manifest.participants[0] as { handle: string | null };
  mutableRow.handle = 'changed@example.test';
  expect(context.operation.actor.id).toBe('ImportOrchestrationTest');
  expect(manifest.participants[0].handle).toBe('client@example.test');
  expect(Object.isFrozen(context.authority)).toBe(true);
  expect(Object.isFrozen(manifest.participants[0])).toBe(true);
});

it('equal references deduplicate while conflicting message and participant identities fail', () => {
  const f = fixture(),
    message = f.manifest.messages[0],
    participant = f.manifest.participants[0];
  expect(
    captureMessageImportMatchingManifest({
      ...f.manifest,
      messages: [message, { ...message }],
      participants: [participant, { ...participant }],
    }),
  ).toEqual(f.manifest);
  expect(() =>
    captureMessageImportMatchingManifest({
      ...f.manifest,
      messages: [message, { ...message, messageThreadId: randomUUID() }],
    }),
  ).toThrow('conflicting message reference');
  expect(() =>
    captureMessageImportMatchingManifest({
      ...f.manifest,
      participants: [participant, { ...participant, personId: randomUUID() }],
    }),
  ).toThrow('conflicting participant reference');
  expect(() =>
    captureMessageImportMatchingManifest({ ...f.manifest, messages: [] }),
  ).toThrow('missing original message');
});

it('saved manifests preserve batches larger than one page', () => {
  const f = fixture(),
    messageId = f.manifest.messages[0].messageId;
  const participants = Array.from({ length: 501 }, () => ({
    id: randomUUID(),
    messageId,
    handle: null,
    personId: null,
    workspaceMemberId: null,
  }));
  expect(
    captureMessageImportMatchingManifest({ ...f.manifest, participants })
      .participants,
  ).toHaveLength(501);
});

it('sent context requires request attribution and application context requires its authenticated application', () => {
  const f = fixture();
  expect(() =>
    captureMessageImportMatchingContext({
      ...f.context,
      authority: {
        ...f.context.authority,
        kind: 'sent',
        userWorkspaceId: randomUUID(),
      },
    }),
  ).toThrow('request attribution');
  const applicationId = randomUUID();
  const applicationContext: MessageImportMatchingContext = {
    operation: {
      ...f.context.operation,
      actor: { kind: 'application', id: applicationId },
      initiator: { kind: 'coreUser', id: randomUUID() },
    },
    authority: {
      ...f.context.authority,
      kind: 'application',
      channelType: 'APP',
      applicationId,
      requestUserWorkspaceId: null,
    },
  };
  expect(
    captureMessageImportMatchingContext(applicationContext).operation.initiator,
  ).toEqual(applicationContext.operation.initiator);
  expect(() =>
    captureMessageImportMatchingContext({
      ...applicationContext,
      authority: {
        ...applicationContext.authority,
        kind: 'application',
        applicationId: randomUUID(),
        requestUserWorkspaceId: null,
      },
    }),
  ).toThrow('application attribution mismatch');
});

it('adapter splits touched participants then untouched Messages into bounded strict pages', async () => {
  const f = fixture(),
    message = f.manifest.messages[0];
  const participants = Array.from({ length: 401 }, () => ({
    id: randomUUID(),
    messageId: message.messageId,
    handle: 'client@example.test',
    personId: null,
    workspaceMemberId: null,
  }));
  const extraMessages = Array.from({ length: 201 }, () => ({
    messageId: randomUUID(),
    messageThreadId: randomUUID(),
  }));
  expect(
    await f.matcher.matchMessageImportParticipantsWithAudit({
      workspaceId: f.workspaceId,
      context: f.context,
      manifest: {
        ...f.manifest,
        participants,
        messages: [message, ...extraMessages],
      },
    }),
  ).toBe('applied');
  expect(f.page).toHaveBeenCalledTimes(5);
  const pages = f.page.mock.calls.map(([input]) => input.manifest);
  expect(pages.map((page) => page.participants.length)).toEqual([
    200, 200, 1, 0, 0,
  ]);
  expect(pages.map((page) => page.messages.length)).toEqual([1, 1, 1, 200, 1]);
  expect(
    pages.flatMap((page) => page.participants.map((row) => row.id)).sort(),
  ).toEqual(participants.map((row) => row.id).sort());
  expect(
    new Set(pages.flatMap((page) => page.messages.map((row) => row.messageId))),
  ).toEqual(
    new Set([message.messageId, ...extraMessages.map((row) => row.messageId)]),
  );
  for (const call of f.manager.runInWorkspaceTransaction.mock.calls)
    expect(call[1]).toEqual(
      expect.objectContaining({
        commitOutcome: 'strict',
        nativeOwnershipLock: 'exclusive',
      }),
    );
});

it('APP targetsOnly adapter never schedules participant identity updates', async () => {
  const f = fixture(),
    applicationId = randomUUID();
  const context: MessageImportMatchingContext = {
    operation: {
      ...f.context.operation,
      actor: { kind: 'application', id: applicationId },
    },
    authority: {
      ...f.context.authority,
      kind: 'application',
      channelType: 'APP',
      applicationId,
      requestUserWorkspaceId: null,
    },
  };
  await f.matcher.matchMessageImportParticipantsWithAudit({
    workspaceId: f.workspaceId,
    context,
    manifest: { ...f.manifest, mode: 'targetsOnly' },
  });
  expect(f.page.mock.calls).toHaveLength(1);
  expect(f.page.mock.calls[0][0].manifest.mode).toBe('targetsOnly');
  expect(f.page.mock.calls[0][0].manifest.participants).toEqual([]);
});

it('stale page stops remaining participant and target-only pages', async () => {
  const f = fixture();
  f.page.mockResolvedValueOnce('stale-run');
  const participants = Array.from({ length: 201 }, () => ({
    ...f.manifest.participants[0],
    id: randomUUID(),
  }));
  expect(
    await f.matcher.matchMessageImportParticipantsWithAudit({
      workspaceId: f.workspaceId,
      context: f.context,
      manifest: { ...f.manifest, participants },
    }),
  ).toBe('stale-run');
  expect(f.page).toHaveBeenCalledTimes(1);
});

it('unknown matching commit is propagated unchanged and does not replay the page', async () => {
  const f = fixture(),
    error = new NativeTransactionOutcomeUnknownError(
      'commit',
      new Error('ACK lost'),
    );
  f.page.mockRejectedValueOnce(error);
  await expect(f.run()).rejects.toBe(error);
  expect(f.page).toHaveBeenCalledTimes(1);
});

it.each(['sent', 'sent-tool'] as const)(
  'derives the %s effective user from its authenticated actor and refuses contradiction',
  (kind) => {
    const f = fixture();
    const userId = randomUUID();
    const context: MessageImportMatchingContext = {
      operation: {
        ...f.context.operation,
        actor: { kind: 'coreUser', id: userId },
      },
      authority: {
        kind,
        workspaceId: f.workspaceId,
        connectedAccountId: f.context.authority.connectedAccountId,
        channelId: f.context.authority.channelId,
        channelType: 'EMAIL',
        userWorkspaceId: randomUUID(),
      },
    };
    expect(
      captureMessageImportMatchingContext(context).authority,
    ).toMatchObject({ effectiveUserId: userId });
    expect(() =>
      captureMessageImportMatchingContext({
        ...context,
        authority: {
          ...context.authority,
          effectiveUserId: randomUUID(),
        } as MessageImportMatchingContext['authority'],
      }),
    ).toThrow(
      kind === 'sent'
        ? 'caller attribution mismatch'
        : 'tool user attribution mismatch',
    );
  },
);

it('validates durable matching intent payloads and rejects structural tampering', () => {
  const f = fixture();
  const pages = buildMessageImportMatchingPages(f.manifest);
  const payload = captureMessageImportMatchingIntentPayload({
    version: 1,
    context: f.context,
    pages,
    nextPageIndex: 0,
  });
  expect(payload.pages).toHaveLength(1);
  expect(Object.isFrozen(payload)).toBe(true);
  expect(() =>
    captureMessageImportMatchingIntentPayload({
      version: 1,
      context: f.context,
      pages,
      nextPageIndex: 1,
    }),
  ).toThrow('cursor invalid');
  expect(() =>
    captureMessageImportMatchingIntentPayload({
      version: 1,
      context: f.context,
      pages,
      nextPageIndex: 0,
      unsafeOutcome: { pageIndex: 0, reason: '' },
    }),
  ).toThrow('outcome invalid');
});

it('fences unsafe outcomes into FAILED with unsafeOutcome during durable intent execution', async () => {
  const f = fixture();
  const intentId = randomUUID();
  const pages = buildMessageImportMatchingPages(f.manifest);
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      {
        id: intentId,
        payload: {
          version: 1,
          context: f.context,
          pages,
          nextPageIndex: 0,
        },
      },
    ])
    .mockResolvedValueOnce([]);
  const matcher = new MatchParticipantService(
    f.manager as never,
    {} as never,
    {} as never,
    { query } as never,
  );
  const error = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('ACK lost'),
  );
  f.page.mockRejectedValueOnce(error);
  await expect(
    matcher.matchMessageImportParticipantsWithAudit({
      workspaceId: f.workspaceId,
      context: f.context,
      manifest: f.manifest,
      intentId,
    }),
  ).rejects.toBe(error);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][0]).toContain("SET status='FAILED'");
  expect(query.mock.calls[1][1]).toEqual([
    intentId.toLowerCase(),
    f.workspaceId.toLowerCase(),
    MESSAGE_IMPORT_MATCHING_INTENT_NAME,
    error.message,
    JSON.stringify({ pageIndex: 0, reason: error.message }),
  ]);
});
