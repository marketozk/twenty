import { randomUUID } from 'node:crypto';

import { createOmniHistoryApplyFixture } from 'test/fork-migration/omni-history-apply.fixture';

export const createOmniHumanCommandFixture = () => {
  const history = createOmniHistoryApplyFixture({
    includeWorkspaceMember: true,
  });
  const initialize = async () => {
    await history.initialize();
    // Core identity projection is bounded to admission; native membership uses generated metadata.
    await history.owner.query(
      'CREATE TABLE core."user" (id uuid PRIMARY KEY,"deletedAt" timestamptz)',
    );
    await history.owner.query(
      'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,"deletedAt" timestamptz)',
    );
    await history.owner.query(
      'CREATE UNIQUE INDEX "IDX_USER_WORKSPACE_USER_ID_WORKSPACE_ID_UNIQUE" ON core."userWorkspace" ("userId","workspaceId") WHERE "deletedAt" IS NULL',
    );
    await history.owner.query(
      `GRANT SELECT,UPDATE(id) ON core."user",core."userWorkspace" TO "${history.roleName}"`,
    );
    await history.owner.query(
      `GRANT INSERT,UPDATE ON core."omniOutgoingCommand" TO "${history.roleName}"`,
    );
  };
  const reset = async () => {
    const context = await history.reset();
    await history.owner.query('TRUNCATE core."user" CASCADE');
    const human = {
      workspaceId: history.workspaceId,
      userId: randomUUID(),
      workspaceMemberId: randomUUID(),
    };
    await history.owner.query('INSERT INTO core."user" (id) VALUES ($1)', [
      human.userId,
    ]);
    await history.owner.query(
      'INSERT INTO core."userWorkspace" (id,"userId","workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), human.userId, history.workspaceId],
    );
    await history.withContext(() =>
      history.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('workspaceMember', {
              shouldBypassPermissionChecks: true,
            })
            .insert({
              id: human.workspaceMemberId,
              userId: human.userId,
              name: { firstName: 'Human', lastName: 'Operator' },
              userEmail: 'operator@example.test',
            });
        },
        { commitOutcome: 'strict' },
      ),
    );
    history.eventEmitter.mockClear();
    const admit = async () => {
      const [conversation] = await history.owner.query(
        'SELECT "controlEpoch","replyRevision" FROM core."omniConversation" WHERE id=$1',
        [context.conversationId],
      );
      return history.service.admitOmniHumanTextCommand(
        human,
        {
          conversationId: context.conversationId,
          text: 'Fixture human intent',
          idempotencyKey: randomUUID(),
          expectedControlEpoch: conversation.controlEpoch,
          observedReplyRevision: conversation.replyRevision,
        },
        async (scope, request) => {
          if (
            scope.workspaceId !== human.workspaceId ||
            request.bindingId !== context.bindingId ||
            request.workspaceMemberId !== human.workspaceMemberId
          )
            throw new Error('Fixture human admission grant denied');
        },
      );
    };
    return { ...context, human, admit };
  };
  return { ...history, initialize, reset };
};
