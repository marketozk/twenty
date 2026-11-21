import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { AgentChatThreadCreateManyPostQueryHook } from 'src/engine/metadata-modules/ai/ai-chat/query-hooks/agent-chat-thread-create-many.post-query.hook';
import { AgentChatThreadCreateOnePostQueryHook } from 'src/engine/metadata-modules/ai/ai-chat/query-hooks/agent-chat-thread-create-one.post-query.hook';
import { AgentChatSharingService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service';
import { AgentChatThreadService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread.service';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const CREATOR_ID = '20202020-2222-4222-8222-222222222222';
const OTHER_MEMBER_ID = '20202020-2222-4222-8222-222222222223';
const CREATOR_USER_WORKSPACE_ID = '20202020-3333-4333-8333-333333333333';
const THREAD_OBJECT_METADATA_ID = '20202020-4444-4444-8444-444444444444';
const PARTICIPANT_OBJECT_METADATA_ID = '20202020-5555-4555-8555-555555555555';
const NEW_THREAD_ID = '20202020-6666-4666-8666-666666666661';
const FIRST_THREAD_ID = '20202020-6666-4666-8666-666666666662';
const SECOND_THREAD_ID = '20202020-6666-4666-8666-666666666663';
const UPSERTED_THREAD_ID = '20202020-6666-4666-8666-666666666664';
const CHAT_THREAD_ID = '20202020-6666-4666-8666-666666666665';
const OWNER_GRANT_ID = '20202020-7777-4777-8777-777777777771';
const LAST_ACTIVITY_AT = '2026-10-07T10:00:00.000Z';

const creatorAuthContext = {
  type: 'user',
  workspace: { id: WORKSPACE_ID },
  workspaceMemberId: CREATOR_ID,
  userWorkspaceId: CREATOR_USER_WORKSPACE_ID,
} as unknown as WorkspaceAuthContext;

type Thread = {
  id: string;
  workspaceMemberId: string | null;
  lastActivityAt: string | null;
};

// Stands in for the thread and participant tables, applying the inbox setup
// the way its SQL does
const buildStorage = (threads: Thread[]) => {
  const participants: {
    threadId: string;
    workspaceMemberId: string;
    lastReadAt: string | null;
  }[] = [];

  const setUpInboxState = (sql: string, parameters: unknown[]) => {
    expect(sql).toContain('SET "lastActivityAt" = clock_timestamp()');

    const [threadIds, workspaceMemberId] = parameters as [string[], string];
    const setUpThreads = threads.filter(
      (thread) =>
        threadIds.includes(thread.id) && thread.lastActivityAt === null,
    );

    for (const thread of setUpThreads) {
      thread.lastActivityAt = LAST_ACTIVITY_AT;
      participants.push({
        threadId: thread.id,
        workspaceMemberId,
        lastReadAt: thread.lastActivityAt,
      });
    }

    return setUpThreads.map((thread) => ({ ...thread }));
  };

  const recordShares: Array<Record<string, unknown>> = [];

  const manager = {
    queryRunner: { isTransactionActive: true, isReleased: false },
    query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (
        sql.startsWith('SET LOCAL') ||
        sql.startsWith('SET CONSTRAINTS') ||
        sql.includes('pg_advisory_xact_lock') ||
        sql.includes('crm_audit."crmAuditEntry"')
      ) {
        return [];
      }

      if (sql.includes('FROM core.workspace')) {
        return [{ id: WORKSPACE_ID, deletedAt: null }];
      }

      if (sql.startsWith('INSERT INTO "agentChatThread"')) {
        const [id, , workspaceMemberId] = parameters as string[];
        const thread = { id, workspaceMemberId, lastActivityAt: null };

        threads.push(thread);

        return [thread];
      }

      if (sql.includes('SELECT rs.id') && sql.includes('"recordShare"')) {
        return [];
      }

      if (sql.includes('SELECT id, "recordId"') && sql.includes('"recordShare"')) {
        const [objectMetadataId, recordIds] = parameters as [string, string[]];
        return recordShares.filter(
          (row) =>
            row.objectMetadataId === objectMetadataId &&
            recordIds.includes(row.recordId as string),
        );
      }

      if (sql.includes('"agentChatThreadParticipant"')) {
        return setUpInboxState(sql, parameters);
      }

      if (sql.includes('INSERT INTO') && sql.includes('"recordShare"')) {
        const [, , recordIds] = parameters as [string, string, string[]];
        const inserted: Array<{ id: string }> = [];
        for (const recordId of recordIds) {
          recordShares.push({
            id: OWNER_GRANT_ID,
            objectMetadataId: THREAD_OBJECT_METADATA_ID,
            recordId,
            principalId: CREATOR_ID,
            principalType: 'WORKSPACE_MEMBER',
            accessLevel: 'FULL',
            rowCause: 'OWNER',
            sourceId: recordId,
            deletedAt: null,
          });
          inserted.push({ id: OWNER_GRANT_ID });
        }

        return inserted;
      }

      throw new Error(`Unexpected query: ${sql}`);
    }),
  };

  const threadRepository = {
    find: jest.fn(
      async (
        _workspaceId: string,
        {
          where,
        }: { where: { id: { value: string[] }; workspaceMemberId?: unknown } },
      ) =>
        threads
          .filter(
            (thread) =>
              where.id.value.includes(thread.id) &&
              (!('workspaceMemberId' in where) ||
                thread.workspaceMemberId === null),
          )
          .map((thread) => ({ ...thread })),
    ),
    update: jest.fn(
      async (
        _workspaceId: string,
        { id }: { id: { value: string[] } },
        { workspaceMemberId }: { workspaceMemberId: string },
      ) => {
        const assignedThreads = threads.filter(
          (thread) =>
            id.value.includes(thread.id) && thread.workspaceMemberId === null,
        );

        for (const thread of assignedThreads) {
          thread.workspaceMemberId = workspaceMemberId;
        }

        return { generatedMaps: assignedThreads.map(({ id }) => ({ id })) };
      },
    ),
    query: jest.fn(
      async (
        _workspaceId: string,
        work: (context: {
          manager: typeof manager;
          table: (name: string) => string;
        }) => Promise<unknown>,
      ) => work({ manager, table: (name) => `"${name}"` }),
    ),
  };

  return { threads, participants, manager, threadRepository };
};

const buildContext = ({
  threads = [],
}: {
  threads?: Thread[];
} = {}) => {
  const storage = buildStorage(threads);
  const events: string[] = [];
  const workspaceOrmManager = {
    executeInWorkspaceContext: jest.fn(async (work: () => unknown) => work()),
    getRepositoryWithContextPermissions: () => ({
      validateWriteIsPermitted: jest.fn(),
    }),
  };
  const sharingService = new AgentChatSharingService(
    storage.threadRepository as never,
    {} as never,
    { deleteByRecordIdsInTransaction: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    workspaceOrmManager as never,
    {} as never,
  );

  jest
    .spyOn(sharingService, 'getParticipantObjectMetadataId')
    .mockResolvedValue(PARTICIPANT_OBJECT_METADATA_ID);
  jest.spyOn(sharingService, 'getAuthContext').mockResolvedValue({
    workspaceMemberId: CREATOR_ID,
    userWorkspaceId: CREATOR_USER_WORKSPACE_ID,
  } as never);
  jest
    .spyOn(
      sharingService as unknown as {
        getThreadObjectMetadata: () => Promise<unknown>;
      },
      'getThreadObjectMetadata',
    )
    .mockResolvedValue({ id: THREAD_OBJECT_METADATA_ID });

  const participantService = {
    emitParticipantCreated: jest.fn(async ({ threadId }) => {
      events.push(`participant created ${threadId}`);
    }),
  };
  const recordEventService = {
    emitThreadCreated: jest.fn(async ({ threadId }) => {
      events.push(`thread created ${threadId}`);
    }),
    emitThreadUpdated: jest.fn(async ({ threadBefore }) => {
      events.push(`thread updated ${threadBefore.id}`);
    }),
  };
  const threadService = new AgentChatThreadService(
    storage.threadRepository as never,
    sharingService,
    recordEventService as never,
    participantService as never,
    {} as never,
    {} as never,
  );

  return {
    ...storage,
    events,
    threadService,
    recordEventService,
    createOneHook: new AgentChatThreadCreateOnePostQueryHook(threadService),
    createManyHook: new AgentChatThreadCreateManyPostQueryHook(threadService),
  };
};

describe('agentChatThread record API creation', () => {
  it('gives the creator a read participant row and sorts the thread by its creation', async () => {
    const context = buildContext({
      threads: [
        { id: NEW_THREAD_ID, workspaceMemberId: null, lastActivityAt: null },
      ],
    });

    await context.createOneHook.execute(creatorAuthContext, 'agentChatThread', [
      { id: NEW_THREAD_ID },
    ]);

    expect(context.threads).toEqual([
      {
        id: NEW_THREAD_ID,
        workspaceMemberId: CREATOR_ID,
        lastActivityAt: LAST_ACTIVITY_AT,
      },
    ]);
    expect(context.participants).toEqual([
      {
        threadId: NEW_THREAD_ID,
        workspaceMemberId: CREATOR_ID,
        lastReadAt: LAST_ACTIVITY_AT,
      },
    ]);
    expect(context.events).toEqual([
      `participant created ${NEW_THREAD_ID}`,
      `thread updated ${NEW_THREAD_ID}`,
    ]);
  });

  it('sets up every created thread, and leaves alone those another member owns', async () => {
    const context = buildContext({
      threads: [
        { id: FIRST_THREAD_ID, workspaceMemberId: null, lastActivityAt: null },
        { id: SECOND_THREAD_ID, workspaceMemberId: null, lastActivityAt: null },
        {
          id: UPSERTED_THREAD_ID,
          workspaceMemberId: OTHER_MEMBER_ID,
          lastActivityAt: null,
        },
      ],
    });

    await context.createManyHook.execute(
      creatorAuthContext,
      'agentChatThread',
      [
        { id: FIRST_THREAD_ID },
        { id: SECOND_THREAD_ID },
        { id: UPSERTED_THREAD_ID },
      ],
    );

    expect(context.participants).toEqual([
      {
        threadId: FIRST_THREAD_ID,
        workspaceMemberId: CREATOR_ID,
        lastReadAt: LAST_ACTIVITY_AT,
      },
      {
        threadId: SECOND_THREAD_ID,
        workspaceMemberId: CREATOR_ID,
        lastReadAt: LAST_ACTIVITY_AT,
      },
    ]);
    expect(context.threads[2]).toEqual({
      id: UPSERTED_THREAD_ID,
      workspaceMemberId: OTHER_MEMBER_ID,
      lastActivityAt: null,
    });
  });

  it('sets up the inbox state the same way as createChatThread', async () => {
    const context = buildContext();

    const thread = await context.threadService.createThread({
      workspaceId: WORKSPACE_ID,
      workspaceMemberId: CREATOR_ID,
      id: CHAT_THREAD_ID,
    });

    expect(thread.lastActivityAt).toBe(LAST_ACTIVITY_AT);
    expect(context.participants).toEqual([
      {
        threadId: CHAT_THREAD_ID,
        workspaceMemberId: CREATOR_ID,
        lastReadAt: LAST_ACTIVITY_AT,
      },
    ]);
    expect(context.events).toEqual([
      `participant created ${CHAT_THREAD_ID}`,
      `thread created ${CHAT_THREAD_ID}`,
    ]);
  });
});
