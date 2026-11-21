import { randomUUID } from 'node:crypto';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  auditAgentChatRecordShareCleanup,
  runAuditedAgentChatRecordShareTransaction,
} from 'src/engine/core-modules/crm-audit/record-share-audit';
import { AgentChatInboxAction } from 'src/engine/metadata-modules/ai/ai-chat/enums/agent-chat-inbox-action.enum';
import { RewriteAgentChatChannelGrantsJob } from 'src/engine/metadata-modules/ai/ai-chat/jobs/rewrite-agent-chat-channel-grants.job';
import { AgentChatChannelGrantService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel-grant.service';
import { AgentHistoryWorkspaceStorageService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-workspace-storage.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

for (const [modPath, names] of [
  [
    'src/engine/core-modules/record-share/services/record-sharing.service',
    ['RecordSharingService'],
  ],
  [
    'src/engine/core-modules/user-workspace/services/user-workspace-auth-context.service',
    ['UserWorkspaceAuthContextService'],
  ],
  [
    'src/engine/metadata-modules/permissions/permissions.service',
    ['PermissionsService'],
  ],
  [
    'src/engine/twenty-orm/workspace-orm.manager',
    ['WorkspaceOrmManager'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-record-event.service',
    ['AgentChatThreadRecordEventService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-participant-event.service',
    ['AgentChatThreadParticipantEventService'],
  ],
  [
    'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-channel-access.service',
    ['AgentChatChannelAccessService'],
  ],
] as const) {
  jest.mock(modPath, () => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      out[name] = class {};
    }
    return out;
  });
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RecordShareStorageService } =
  require('src/engine/core-modules/record-share/services/record-share-storage.service') as typeof import('src/engine/core-modules/record-share/services/record-share-storage.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentChatSharingService } =
  require('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service') as typeof import('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentChatThreadParticipantService } =
  require('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-participant.service') as typeof import('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-participant.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentChatThreadService } =
  require('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread.service') as typeof import('src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread.service');

const ownerUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !ownerUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(ownerUrl).pathname)
) {
  throw new Error(
    'FORK_MIGRATION_TEST_URL must target an isolated temporary test database',
  );
}
const databaseRole = `acrs_audit_rt_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const runtimeUrl = (() => {
  const parsed = new URL(ownerUrl);
  parsed.username = databaseRole;
  parsed.password = 'isolated-acrs-fixture';
  return parsed.toString();
})();

const workspaceId = randomUUID().toLowerCase();
const workspaceSchema = getWorkspaceSchemaName(workspaceId);
const actorUserId = randomUUID().toLowerCase();
const actorUserWorkspaceId = randomUUID().toLowerCase();
const actorMemberId = randomUUID().toLowerCase();
const targetUserId = randomUUID().toLowerCase();
const targetUserWorkspaceId = randomUUID().toLowerCase();
const targetMemberId = randomUUID().toLowerCase();
const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();
const applicationId = randomUUID().toLowerCase();
const threadObjectMetadataId = randomUUID().toLowerCase();
const participantObjectMetadataId = randomUUID().toLowerCase();
const channelAId = randomUUID().toLowerCase();
const channelBId = randomUUID().toLowerCase();
const roleAId = randomUUID().toLowerCase();
const roleBId = randomUUID().toLowerCase();
const allChannelsRoleId = randomUUID().toLowerCase();

const ownerDataSource = new DataSource({ type: 'postgres', url: ownerUrl });
const runtimeDataSource = new DataSource({ type: 'postgres', url: runtimeUrl });

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT id, "operationId", "correlationId", actor, initiator, action,
            "resourceKind", "resourceId", outcome, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
      ORDER BY "createdAt" ASC, id ASC`,
    [workspaceId],
  );

const readRecordShareRows = () =>
  ownerDataSource.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM "${workspaceSchema}"."recordShare"
      ORDER BY id ASC`,
  );

const createHarness = () => {
  const storageService = new AgentHistoryWorkspaceStorageService(
    runtimeDataSource,
  );
  const threadRepository = {
    query: <T>(wsId: string, work: (ctx: unknown) => Promise<T>) =>
      storageService.run(wsId, work as never),
    find: async (_wsId: string, { where }: { where: { id: { value: string[] }; workspaceMemberId?: unknown } }) => {
      const ids = where.id.value;
      const onlyUnassigned = 'workspaceMemberId' in where;
      return runtimeDataSource.query(
        `SELECT * FROM "${workspaceSchema}"."agentChatThread"
          WHERE id = ANY($1::uuid[])${onlyUnassigned ? ' AND "workspaceMemberId" IS NULL' : ''}
          ORDER BY id ASC`,
        [ids],
      );
    },
    findOne: async (_wsId: string, { where }: { where: { id: string } }) => {
      const rows = await runtimeDataSource.query(
        `SELECT * FROM "${workspaceSchema}"."agentChatThread" WHERE id = $1`,
        [where.id],
      );
      return rows[0] ?? null;
    },
    update: async (
      _wsId: string,
      where: { id: { value: string[] }; workspaceMemberId?: unknown },
      patch: { workspaceMemberId: string },
    ) => {
      const raw = await runtimeDataSource.query(
        `UPDATE "${workspaceSchema}"."agentChatThread"
            SET "workspaceMemberId" = $2
          WHERE id = ANY($1::uuid[]) AND "workspaceMemberId" IS NULL
          RETURNING id`,
        [where.id.value, patch.workspaceMemberId],
      );
      const rows = Array.isArray(raw[0]) ? raw[0] : raw;
      return { generatedMaps: rows, raw: rows, affected: rows.length };
    },
  };

  const workspaceOrmManager = {
    executeInWorkspaceContext: jest.fn(async <T>(fn: () => Promise<T>) => fn()),
    getRepositoryWithContextPermissions: jest.fn(() => ({
      validateWriteIsPermitted: jest.fn().mockResolvedValue(undefined),
      findRecordIdsAllowedForOperation: jest.fn(
        async ({ recordIds }: { recordIds: string[] }) => recordIds,
      ),
    })),
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [STANDARD_OBJECTS.agentChatThread.universalIdentifier]: {
            id: threadObjectMetadataId,
            nameSingular: 'agentChatThread',
          },
          [STANDARD_OBJECTS.agentChatThreadParticipant.universalIdentifier]: {
            id: participantObjectMetadataId,
            nameSingular: 'agentChatThreadParticipant',
          },
        },
      },
    })),
  };

  const userAuthContextService = {
    resolveWorkspaceMember: jest.fn(
      async ({ workspaceMemberId }: { workspaceMemberId: string }) => {
        if (workspaceMemberId === actorMemberId) {
          return {
            type: 'user',
            workspace: { id: workspaceId },
            user: { id: actorUserId },
            userWorkspaceId: actorUserWorkspaceId,
            workspaceMemberId: actorMemberId,
          };
        }
        if (workspaceMemberId === targetMemberId) {
          return {
            type: 'user',
            workspace: { id: workspaceId },
            user: { id: targetUserId },
            userWorkspaceId: targetUserWorkspaceId,
            workspaceMemberId: targetMemberId,
          };
        }
        throw new Error(`Unknown workspaceMemberId ${workspaceMemberId}`);
      },
    ),
  };

  const permissionsService = {
    userHasWorkspaceSettingPermission: jest.fn().mockResolvedValue(true),
  };

  const recordShareStorageService = new RecordShareStorageService(
    workspaceOrmManager as never,
  );
  const workspaceQueueService = { add: jest.fn().mockResolvedValue(undefined) };
  const channelGrantService = new AgentChatChannelGrantService(
    threadRepository as never,
    workspaceQueueService as never,
  );
  const sharingService = new AgentChatSharingService(
    threadRepository as never,
    userAuthContextService as never,
    recordShareStorageService,
    {} as never,
    workspaceCacheService as never,
    permissionsService as never,
    workspaceOrmManager as never,
    channelGrantService,
  );
  const participantEventService = {
    emitParticipantWritten: jest.fn().mockResolvedValue(undefined),
  };
  const delayedJobsQueueService = {
    add: jest.fn().mockResolvedValue(undefined),
  };
  const participantService = new AgentChatThreadParticipantService(
    threadRepository as never,
    sharingService,
    participantEventService as never,
    delayedJobsQueueService as never,
    workspaceOrmManager as never,
  );
  const threadRecordEventService = {
    emitThreadCreated: jest.fn().mockResolvedValue(undefined),
    emitThreadUpdated: jest.fn().mockResolvedValue(undefined),
  };
  const channelAccessService = {
    assertChannelAccess: jest.fn().mockResolvedValue(undefined),
  };
  const threadService = new AgentChatThreadService(
    threadRepository as never,
    sharingService,
    threadRecordEventService as never,
    participantService,
    channelAccessService as never,
    channelGrantService,
  );
  const rewriteJob = new RewriteAgentChatChannelGrantsJob(channelGrantService);

  return {
    storageService,
    channelGrantService,
    sharingService,
    participantService,
    threadService,
    rewriteJob,
  };
};

beforeAll(async () => {
  await ownerDataSource.initialize();
  await ownerDataSource.query(
    `DROP SCHEMA IF EXISTS core CASCADE;
     DROP SCHEMA IF EXISTS crm_audit CASCADE;
     DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
     CREATE SCHEMA core;
     CREATE SCHEMA "${workspaceSchema}";`,
  );
  await ownerDataSource.query(
    `CREATE TABLE core.workspace (
       id uuid PRIMARY KEY,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."user" (
       id uuid PRIMARY KEY,
       email text NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."objectMetadata" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "universalIdentifier" uuid NOT NULL
     );
     CREATE TABLE core."role" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "canAccessAllAgentChatChannels" boolean NOT NULL DEFAULT false
     );
     CREATE TABLE core."agentChatChannel" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE
     );
     CREATE TABLE core."agentChatChannelRole" (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "channelId" uuid NOT NULL REFERENCES core."agentChatChannel"(id) ON DELETE CASCADE,
       "roleId" uuid NOT NULL REFERENCES core."role"(id) ON DELETE CASCADE
     );
     CREATE TABLE "${workspaceSchema}"."workspaceMember" (
       id uuid PRIMARY KEY,
       "userId" uuid NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE "${workspaceSchema}"."agentChatThread" (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       title text NULL,
       "workspaceMemberId" uuid NULL,
       "assigneeId" uuid NULL,
       "channelId" uuid NULL,
       "channelArchivedAt" timestamptz NULL,
       "channelSnoozedUntil" timestamptz NULL,
       "lastActivityAt" timestamptz NULL,
       "lastMessageText" text NULL,
       "lastMessageSenderWorkspaceMemberId" uuid NULL,
       "writerWorkspaceMemberIds" text[] NULL,
       "pendingQuestionMessageId" uuid NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE "${workspaceSchema}"."agentMessage" (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       "threadId" uuid NOT NULL,
       role text NOT NULL,
       "senderWorkspaceMemberId" uuid NULL
     );
     CREATE TABLE "${workspaceSchema}"."agentChatThreadParticipant" (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       "threadId" uuid NOT NULL,
       "workspaceMemberId" uuid NOT NULL,
       "lastReadAt" timestamptz NULL,
       "archivedAt" timestamptz NULL,
       "snoozedUntil" timestamptz NULL,
       "isSubscribed" boolean NOT NULL DEFAULT true,
       "lastMentionedAt" timestamptz NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       UNIQUE ("threadId", "workspaceMemberId")
     );
     CREATE TABLE "${workspaceSchema}"."recordShare" (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       "recordId" uuid NOT NULL,
       "objectMetadataId" uuid NOT NULL,
       "principalId" uuid NOT NULL,
       "principalType" text NOT NULL,
       "accessLevel" text NOT NULL,
       "rowCause" text NOT NULL,
       "sourceId" uuid NOT NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE UNIQUE INDEX "IDX_acrs_record_share_unique"
       ON "${workspaceSchema}"."recordShare"
       ("objectMetadataId", "recordId", "principalId", "rowCause", "sourceId");`,
  );

  await ownerDataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );

  await ownerDataSource.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-acrs-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, UPDATE ON core.workspace, core."userWorkspace" TO "${databaseRole}";
     GRANT SELECT ON core."user", core."objectMetadata", core."role", core."agentChatChannel", core."agentChatChannelRole" TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();

  await ownerDataSource.query(`INSERT INTO core.workspace (id) VALUES ($1)`, [
    workspaceId,
  ]);
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email)
     VALUES ($1, 'actor@example.com'), ($2, 'target@example.com'), ($3, 'admin@example.com')`,
    [actorUserId, targetUserId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId")
     VALUES ($1,$2,$3), ($4,$2,$5), ($6,$2,$7)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      targetUserWorkspaceId,
      targetUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO core."objectMetadata" (id, "workspaceId", "universalIdentifier")
     VALUES ($1,$2,$3), ($4,$2,$5)`,
    [
      threadObjectMetadataId,
      workspaceId,
      STANDARD_OBJECTS.agentChatThread.universalIdentifier,
      participantObjectMetadataId,
      STANDARD_OBJECTS.agentChatThreadParticipant.universalIdentifier,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO core."role" (id, "workspaceId", "canAccessAllAgentChatChannels")
     VALUES ($1,$4,false), ($2,$4,false), ($3,$4,true)`,
    [roleAId, roleBId, allChannelsRoleId, workspaceId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."agentChatChannel" (id, "workspaceId")
     VALUES ($1,$3), ($2,$3)`,
    [channelAId, channelBId, workspaceId],
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}"."workspaceMember" (id, "userId")
     VALUES ($1,$2), ($3,$4)`,
    [actorMemberId, actorUserId, targetMemberId, targetUserId],
  );
});

afterAll(async () => {
  if (runtimeDataSource.isInitialized) {
    await runtimeDataSource.destroy();
  }
  if (ownerDataSource.isInitialized) {
    await ownerDataSource.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       REVOKE ALL PRIVILEGES ON SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       DROP ROLE IF EXISTS "${databaseRole}";`,
    );
    await ownerDataSource.destroy();
  }
});

beforeEach(async () => {
  await ownerDataSource.query(
    `DELETE FROM crm_audit."crmAuditEntry";
     DELETE FROM "${workspaceSchema}"."recordShare";
     DELETE FROM "${workspaceSchema}"."agentChatThreadParticipant";
     DELETE FROM "${workspaceSchema}"."agentMessage";
     DELETE FROM "${workspaceSchema}"."agentChatThread";
     DELETE FROM core."agentChatChannelRole";`,
  );
  await ownerDataSource.query(
    `INSERT INTO core."agentChatChannelRole" ("workspaceId", "channelId", "roleId")
     VALUES ($1,$2,$3), ($1,$4,$5)`,
    [workspaceId, channelAId, roleAId, channelBId, roleBId],
  );
});

describe('Agent chat SQL CTE recordShare audit (LOG-201)', () => {
  it('audits AgentChatSharingService.createThread, delegated inbox create, claimUnownedThreadForRun, and assignCreatedThreadsToCreator under single operationId per transaction with real HTTP ALS coreUser/impersonation', async () => {
    const { sharingService, threadService } = createHarness();

    // 1. createThread with channelId and pre-existing orphan share on reused threadId under HTTP ALS (coreUser + impersonation)
    const threadId1 = randomUUID().toLowerCase();
    const orphanShareId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$2)`,
      [orphanShareId, threadId1, threadObjectMetadataId, targetMemberId],
    );

    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        impersonationContext: { impersonatorUserWorkspaceId },
      }),
      () =>
        sharingService.createThread({
          workspaceId,
          workspaceMemberId: actorMemberId,
          id: threadId1,
          title: 'Channel thread',
          channelId: channelAId,
        }),
    );

    // Expect: 1 delete (orphan) + 1 create (thread OWNER) + 2 creates (RULE for roleA + allChannelsRole) + 1 create (participant OWNER) = 5 under ONE operationId
    let audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)).size,
    ).toBe(1);
    expect(
      audits.filter((a: { action: string }) => a.action === 'delete'),
    ).toHaveLength(1);
    expect(
      audits.filter((a: { action: string }) => a.action === 'create'),
    ).toHaveLength(4);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      resourceKind: 'recordShare',
    });

    // 2. Delegated createThread (AgentInboxService application sender) attributes to application, NOT passive recipient targetMemberId
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const threadId2 = randomUUID().toLowerCase();
    await sharingService.createThread({
      workspaceId,
      workspaceMemberId: targetMemberId,
      id: threadId2,
      title: 'Inbox message',
      auditContext: {
        auditOperation: {
          workspaceId,
          operationId: randomUUID(),
          actor: { kind: 'application', id: applicationId },
        },
      },
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'application', id: applicationId },
      initiator: null,
      action: 'create',
    });

    // 3. claimUnownedThreadForRun: first claim emits 2 creates (thread OWNER + participant OWNER); second claim returns null and emits 0 rows
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const unownedThreadId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId") VALUES ($1, NULL)`,
      [unownedThreadId],
    );
    const claimed = await sharingService.claimUnownedThreadForRun({
      workspaceId,
      workspaceMemberId: actorMemberId,
      threadId: unownedThreadId,
    });
    expect(claimed?.id).toBe(unownedThreadId);
    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)).size,
    ).toBe(1);

    const secondClaim = await sharingService.claimUnownedThreadForRun({
      workspaceId,
      workspaceMemberId: targetMemberId,
      threadId: unownedThreadId,
    });
    expect(secondClaim).toBeNull();
    expect(await readAuditRows()).toHaveLength(2);

    // 4. assignCreatedThreadsToCreator sets up inbox state and audits participant OWNER grant
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const recordApiThreadId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId") VALUES ($1, NULL)`,
      [recordApiThreadId],
    );
    await threadService.assignCreatedThreadsToCreator({
      authContext: {
        type: 'user',
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        workspaceMemberId: actorMemberId,
      } as never,
      threadIds: [recordApiThreadId],
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      action: 'create',
      redactedDiff: {
        values: expect.objectContaining({
          objectMetadataId: { before: null, after: participantObjectMetadataId },
          principalId: { before: null, after: actorMemberId },
          rowCause: { before: null, after: 'OWNER' },
        }),
      },
    });
  });

  it('audits AgentChatThreadParticipantService (recordMemberActivity, batched updateInboxState, markAsMentioned/markAsAssigned under calling ALS actor, and endSnooze system actor)', async () => {
    const { participantService } = createHarness();
    const threadA = randomUUID().toLowerCase();
    const threadB = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId", "lastActivityAt")
       VALUES ($1,$3,now()), ($2,$3,now())`,
      [threadA, threadB, actorMemberId],
    );

    // 1. recordMemberActivity: first message creates participant OWNER share; second message is idempotent (0 new audit rows)
    await participantService.recordMemberActivity({
      workspaceId,
      workspaceMemberId: actorMemberId,
      threadId: threadA,
      text: 'Hello',
    });
    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      action: 'create',
    });

    await participantService.recordMemberActivity({
      workspaceId,
      workspaceMemberId: actorMemberId,
      threadId: threadA,
      text: 'Follow-up',
    });
    expect(await readAuditRows()).toHaveLength(1);

    // 2. Batched updateInboxState across 2 threads for targetMemberId creates 2 participant OWNER shares under ONE operationId
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: targetUserId },
      }),
      () =>
        participantService.updateInboxState({
          workspaceId,
          workspaceMemberId: targetMemberId,
          threadIds: [threadA, threadB],
          action: AgentChatInboxAction.READ,
          snoozedUntil: null,
        }),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)).size,
    ).toBe(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: targetUserId },
      action: 'create',
    });

    // 3. markAsMentioned for targetMemberId on a fresh thread under actorUserId ALS attributes to actorUserId, NOT targetMemberId
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const threadC = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId", "lastActivityAt")
       VALUES ($1,$2,now())`,
      [threadC, actorMemberId],
    );
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
      }),
      () =>
        participantService.markAsMentioned({
          workspaceId,
          workspaceMemberId: targetMemberId,
          threadId: threadC,
        }),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      action: 'create',
      redactedDiff: {
        values: expect.objectContaining({
          principalId: { before: null, after: targetMemberId },
          rowCause: { before: null, after: 'OWNER' },
        }),
      },
    });

    // 4. markAsAssigned for targetMemberId under actorUserId ALS attributes to actorUserId and commits writeAssignment atomically
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const threadD = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId", "lastActivityAt")
       VALUES ($1,$2,now())`,
      [threadD, actorMemberId],
    );
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
      }),
      () =>
        participantService.markAsAssigned({
          workspaceId,
          workspaceMemberId: targetMemberId,
          threadId: threadD,
          isSelfAssigned: false,
          writeAssignment: async ({ manager, table, threadId: id }) => {
            await manager.query(
              `UPDATE ${table('agentChatThread')} SET "assigneeId" = $2 WHERE id = $1`,
              [id, targetMemberId],
            );
          },
        }),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      action: 'create',
      redactedDiff: {
        values: expect.objectContaining({
          principalId: { before: null, after: targetMemberId },
          rowCause: { before: null, after: 'OWNER' },
        }),
      },
    });

    // 5. endSnooze uses system actor agent_chat_thread_snooze_end and creates 0 rows when participant OWNER share already exists
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await ownerDataSource.query(
      `UPDATE "${workspaceSchema}"."agentChatThreadParticipant"
          SET "archivedAt" = now(), "snoozedUntil" = $1
        WHERE "threadId" = $2 AND "workspaceMemberId" = $3`,
      [pastIso, threadC, targetMemberId],
    );
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    await participantService.endSnooze({
      workspaceId,
      workspaceMemberId: targetMemberId,
      threadId: threadC,
      snoozedUntil: pastIso,
    });
    expect(await readAuditRows()).toHaveLength(0);
  });

  it('audits AgentChatChannelGrantService (moveToChannel, rewriteChannelGrants with impersonation/pendingUserWorkspaceActor, idempotent no-op, and RewriteAgentChatChannelGrantsJob)', async () => {
    const { sharingService, threadService, channelGrantService, rewriteJob } =
      createHarness();

    const threadId = randomUUID().toLowerCase();
    await sharingService.createThread({
      workspaceId,
      workspaceMemberId: actorMemberId,
      id: threadId,
      channelId: channelAId,
    });
    // Add an unmanaged MANUAL grant to prove moveToChannel preserves non-RULE rows
    const manualShareId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$2)`,
      [manualShareId, threadId, threadObjectMetadataId, targetMemberId],
    );

    // 1. moveToChannel channelA -> channelB deletes channelA RULE grants (roleA + allChannelsRole) and inserts channelB RULE grants (roleB + allChannelsRole)
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    await threadService.moveToChannel({
      workspaceId,
      workspaceMemberId: actorMemberId,
      threadId,
      channelId: channelBId,
    });
    let audits = await readAuditRows();
    expect(audits).toHaveLength(4);
    expect(
      audits.filter((a: { action: string }) => a.action === 'delete'),
    ).toHaveLength(2);
    expect(
      audits.filter((a: { action: string }) => a.action === 'create'),
    ).toHaveLength(2);
    const remainingIds = (await readRecordShareRows()).map(
      (r: { id: string }) => r.id,
    );
    expect(remainingIds).toContain(manualShareId);

    // 2. rewriteChannelGrants with pendingUserWorkspaceActor + pendingCorrelationId + impersonator after role change
    await ownerDataSource.query(
      `DELETE FROM core."agentChatChannelRole" WHERE "channelId" = $1 AND "roleId" = $2`,
      [channelBId, roleBId],
    );
    await ownerDataSource.query(
      `INSERT INTO core."agentChatChannelRole" ("workspaceId", "channelId", "roleId") VALUES ($1,$2,$3)`,
      [workspaceId, channelBId, roleAId],
    );
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const sharedCorrId = randomUUID().toLowerCase();
    await channelGrantService.rewriteChannelGrants({
      workspaceId,
      channelId: channelBId,
      pendingUserWorkspaceActor: true,
      pendingCorrelationId: sharedCorrId,
      authUserWorkspaceId: actorUserWorkspaceId,
      auditImpersonatorUserWorkspaceId: impersonatorUserWorkspaceId,
    });
    audits = await readAuditRows();
    // Deletes roleB RULE grant and creates roleA RULE grant (allChannelsRole unchanged)
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: sharedCorrId,
    });

    // 3. Idempotent repeat emits 0 audit rows
    await channelGrantService.rewriteChannelGrants({
      workspaceId,
      channelId: channelBId,
    });
    expect(await readAuditRows()).toHaveLength(2);

    // 4. RewriteAgentChatChannelGrantsJob (all channels) uses system:rewrite_agent_chat_channel_grants_job with shared correlationId across channels
    const threadInA = randomUUID().toLowerCase();
    await sharingService.createThread({
      workspaceId,
      workspaceMemberId: actorMemberId,
      id: threadInA,
      channelId: channelAId,
    });
    await ownerDataSource.query(
      `DELETE FROM "${workspaceSchema}"."recordShare" WHERE "rowCause" = 'RULE'`,
    );
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    await rewriteJob.handle({ workspaceId });
    audits = await readAuditRows();
    expect(audits).toHaveLength(4);
    expect(
      new Set(audits.map((a: { correlationId: string }) => a.correlationId)).size,
    ).toBe(1);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)).size,
    ).toBe(2);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'system', id: 'rewrite_agent_chat_channel_grants_job' },
      action: 'create',
    });
  });

  it('enforces fail-closed invariants (outside audited tx, ALS coreUser mismatch, soft-deleted row, swallowed error latching) and rolls back completely on audit flush failure and post-flush drift', async () => {
    const { storageService, sharingService, channelGrantService } =
      createHarness();

    // 1. rewriteThreadGrantsInTransaction outside audited transaction fails closed even with empty threadIds
    await expect(
      storageService.run(workspaceId, ({ manager }) =>
        channelGrantService.rewriteThreadGrantsInTransaction({
          manager,
          workspaceId,
          threadIds: [],
          affectedChannelIds: [],
        }),
      ),
    ).rejects.toThrow(
      'Agent chat record share write requires an active audited transaction',
    );

    // 2. Non-transactional EntityManager fails closed
    await expect(
      runAuditedAgentChatRecordShareTransaction({
        manager: runtimeDataSource.manager,
        workspaceId,
        fallbackActor: { kind: 'system', id: 'test' },
        work: async () => undefined,
      }),
    ).rejects.toThrow(
      'Record share audit requires an active EntityManager transaction',
    );

    // 3. ALS coreUser mismatch against expectedWorkspaceMemberId fails closed
    await expect(
      withCrmAuditRequest(
        captureCrmAuditRequest({
          workspace: { id: workspaceId },
          user: { id: targetUserId },
        }),
        () =>
          sharingService.createThread({
            workspaceId,
            workspaceMemberId: actorMemberId,
            id: randomUUID(),
          }),
      ),
    ).rejects.toThrow(
      'Agent chat record share audit coreUser principal does not match workspaceMember',
    );

    // 4. Soft-deleted recordShare row fails closed in rewriteChannelGrants
    const softDelThreadId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        ("recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt")
       VALUES ($1,$2,$3,'ROLE','READ_WRITE','RULE',$4,now())`,
      [softDelThreadId, threadObjectMetadataId, roleAId, channelAId],
    );
    await expect(
      channelGrantService.rewriteChannelGrants({
        workspaceId,
        channelId: channelAId,
      }),
    ).rejects.toThrow('Record share audit detected soft-deleted recordShare row');
    await ownerDataSource.query(`DELETE FROM "${workspaceSchema}"."recordShare"`);

    // 5. Swallowed step failure is latched even when recordedMutations === 0
    await expect(
      storageService.run(workspaceId, ({ manager }) =>
        runAuditedAgentChatRecordShareTransaction({
          manager,
          workspaceId,
          fallbackActor: { kind: 'system', id: 'test' },
          work: async () => {
            try {
              await auditAgentChatRecordShareCleanup({
                manager,
                workspaceId,
                objectMetadataId: threadObjectMetadataId,
                recordIds: [randomUUID()],
                execute: async () => {
                  throw new Error('simulated swallowed agent chat step error');
                },
              });
            } catch {
              // Caller swallows; transaction must still abort
            }
          },
        }),
      ),
    ).rejects.toThrow('simulated swallowed agent chat step error');

    // 5b. Delegated claimThreadForRun (AgentRunService with application token) succeeds without user principal conflict
    const delegatedClaimThreadId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId") VALUES ($1, NULL)`,
      [delegatedClaimThreadId],
    );
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        application: { id: applicationId },
      }),
      () =>
        createHarness().threadService.claimThreadForRun({
          workspaceId,
          workspaceMemberId: targetMemberId,
          threadId: delegatedClaimThreadId,
          title: 'Delegated run',
          auditContext: {
            auditOperation: {
              workspaceId,
              operationId: randomUUID(),
              actor: { kind: 'application', id: applicationId },
            },
          },
        }),
    );
    expect(await readAuditRows()).toHaveLength(2);
    expect((await readAuditRows())[0]).toMatchObject({
      actor: { kind: 'application', id: applicationId },
      action: 'create',
    });

    // 5c. Empty auditContext: {} and invalid pending actor field combinations fail closed (M-5)
    await expect(
      sharingService.createThread({
        workspaceId,
        workspaceMemberId: actorMemberId,
        id: randomUUID(),
        auditContext: {},
      }),
    ).rejects.toThrow(
      'Agent chat delegated auditContext requires auditOperation or pendingUserWorkspaceActor',
    );
    await expect(
      channelGrantService.rewriteChannelGrants({
        workspaceId,
        channelId: channelAId,
        authUserWorkspaceId: actorUserWorkspaceId,
      }),
    ).rejects.toThrow(
      'Agent chat record share audit pending actor fields require pendingUserWorkspaceActor',
    );

    // 5d. Mid-transaction unaudited INSERT and DELETE in an already-tracked scope fail closed (B-1)
    const midDriftThreadId = randomUUID().toLowerCase();
    await expect(
      storageService.run(workspaceId, ({ manager }) =>
        runAuditedAgentChatRecordShareTransaction({
          manager,
          workspaceId,
          fallbackActor: { kind: 'system', id: 'test' },
          work: async () => {
            await auditAgentChatRecordShareCleanup({
              manager,
              workspaceId,
              objectMetadataId: threadObjectMetadataId,
              recordIds: [midDriftThreadId],
              execute: async () => undefined,
            });
            // Unaudited raw INSERT into already-tracked (threadObjectMetadataId, midDriftThreadId)
            await manager.query(
              `INSERT INTO "${workspaceSchema}"."recordShare"
                ("recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
               VALUES ($1,$2,$3,'WORKSPACE_MEMBER','READ','MANUAL',$1)`,
              [midDriftThreadId, threadObjectMetadataId, targetMemberId],
            );
            // Step 2 reads the same scope; reconcileBeforeWithExpectedRows must reject the unaudited insert immediately
            await auditAgentChatRecordShareCleanup({
              manager,
              workspaceId,
              objectMetadataId: threadObjectMetadataId,
              recordIds: [midDriftThreadId],
              execute: async () => undefined,
            });
          },
        }),
      ),
    ).rejects.toThrow(
      'Agent chat record share audit detected unaudited mid-transaction row drift',
    );

    await ownerDataSource.query(
      `DELETE FROM crm_audit."crmAuditEntry";
       DELETE FROM "${workspaceSchema}"."recordShare";
       DELETE FROM "${workspaceSchema}"."agentChatThreadParticipant";
       DELETE FROM "${workspaceSchema}"."agentChatThread";`,
    );

    // 6. Audit flush failure rolls back createThread completely (0 threads, 0 participants, 0 shares, 0 audit rows)
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_acrs_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' THEN
          RAISE EXCEPTION 'simulated agent chat recordShare flush failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_acrs_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_acrs_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_acrs_audit();
    `);
    try {
      await expect(
        sharingService.createThread({
          workspaceId,
          workspaceMemberId: actorMemberId,
          id: randomUUID(),
          channelId: channelAId,
        }),
      ).rejects.toThrow('simulated agent chat recordShare flush failure');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_acrs_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_acrs_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
    expect(
      await ownerDataSource.query(
        `SELECT id FROM "${workspaceSchema}"."agentChatThread"`,
      ),
    ).toHaveLength(0);

    // 7. Post-flush row drift rolls back both createThread (record scope) and rewriteChannelGrants (channel scope)
    const driftThreadId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."agentChatThread" (id, "workspaceMemberId", "channelId")
       VALUES ($1,$2,$3)`,
      [driftThreadId, actorMemberId, channelAId],
    );
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.drift_acrs_after_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' AND NEW.action = 'create' THEN
          UPDATE "${workspaceSchema}"."recordShare"
             SET "accessLevel" = 'NONE'
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_drift_acrs_after_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_drift_acrs_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.drift_acrs_after_audit();
    `);
    try {
      await expect(
        sharingService.createThread({
          workspaceId,
          workspaceMemberId: actorMemberId,
          id: randomUUID(),
          channelId: channelAId,
        }),
      ).rejects.toThrow(
        'Agent chat record share audit detected post-flush row drift',
      );

      await expect(
        channelGrantService.rewriteChannelGrants({
          workspaceId,
          channelId: channelAId,
        }),
      ).rejects.toThrow(
        'Agent chat record share audit detected post-flush row drift',
      );
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_drift_acrs_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.drift_acrs_after_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
  });
});
