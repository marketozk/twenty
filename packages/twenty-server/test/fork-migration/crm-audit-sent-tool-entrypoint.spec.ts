import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SendEmailTool } from 'src/engine/core-modules/tool/tools/email-tool/send-email-tool';
import { MessagingDraftSendService } from 'src/modules/messaging/message-outbound-manager/services/messaging-draft-send.service';
import { withResolvedToolAuthContext } from 'src/engine/core-modules/tool-provider/utils/with-resolved-tool-auth-context.util';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { type MembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

jest.mock(
  'src/engine/core-modules/tool/tools/email-tool/email-composer.service',
  () => ({ EmailComposerService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-outbound-manager/services/send-email.service',
  () => ({ SendEmailService: class {} }),
);
jest.mock('src/engine/core-modules/i18n/i18n.service', () => ({
  I18nService: class {},
}));
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/modules/messaging/message-outbound-manager/services/messaging-message-outbound.service',
  () => ({ MessagingMessageOutboundService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service',
  () => ({ MessagingMessageCleanerService: class {} }),
);

const build = (
  kind: 'user' | 'application' | 'workflow' | 'agent' | 'missing' | 'system',
) => {
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    userWorkspaceId = randomUUID(),
    applicationId = randomUUID(),
    agentId = randomUUID(),
    accountId = randomUUID(),
    channelId = randomUUID();
  const userAuth = {
    type: 'user',
    workspace: { id: workspaceId },
    user: { id: userId },
    userWorkspaceId,
  };
  const applicationAuth = {
    type: 'application',
    workspace: { id: workspaceId },
    application: { id: applicationId },
    ...(kind === 'agent' ? { actingAgent: { id: agentId } } : {}),
  };
  const authContext =
    kind === 'missing'
      ? undefined
      : kind === 'system'
        ? { type: 'system', workspace: { id: workspaceId } }
        : kind === 'application' || kind === 'agent'
          ? applicationAuth
          : userAuth;
  const context: ToolExecutionContext = {
    workspaceId,
    ...(kind === 'user' || kind === 'workflow'
      ? { userId, userWorkspaceId }
      : {}),
    authContext: authContext as never,
  };
  const parameters = {
    recipients: { to: 'recipient@example.test', cc: '', bcc: '' },
    subject: 'Subject',
    body: '<p>Body</p>',
    files: [],
  };
  const composed = {
    recipients: { to: ['recipient@example.test'], cc: [], bcc: [] },
    toRecipientsDisplay: 'recipient@example.test',
    sanitizedSubject: 'Subject',
    plainTextBody: 'Body',
    sanitizedHtmlBody: '<p>Body</p>',
    attachments: [],
    connectedAccount: { id: accountId },
    messageChannelId: channelId,
    shouldPersistMessage: true,
  };
  const compose = {
    composeEmail: jest
      .fn()
      .mockResolvedValue({ success: true, data: composed }),
  };
  const resolver = {
    messageChannelRepository: {
      manager: { query: jest.fn().mockResolvedValue([]) },
    },
  };
  const capture = jest.fn((id: string, identity?: MembershipCleanupIdentity) =>
    MessagingDraftSendService.prototype.captureRequestAuditOperation.call(
      resolver as never,
      id,
      identity,
    ),
  );
  const send = {
    captureRequestAuditOperation: capture,
    sendComposedEmail: jest.fn().mockResolvedValue({
      headerMessageId: 'sent-header',
      messageExternalId: 'sent-external',
      threadExternalId: 'sent-thread',
    }),
    persistSentMessage: jest.fn().mockResolvedValue({
      messageId: randomUUID(),
      messageThreadId: randomUUID(),
    }),
  };
  const tool = new SendEmailTool(
    compose as never,
    send as never,
    { getI18nInstance: () => ({ _: (message: unknown) => message }) } as never,
  );
  const dispatch = () =>
    withResolvedToolAuthContext(
      {
        context: {
          ...context,
          rolePermissionConfig: {
            intersectionOf: { applicationRoleId: randomUUID() },
          },
        },
        userRepository: {} as never,
        workspaceCacheService: {} as never,
      },
      (resolved) => tool.execute(parameters, resolved),
    );
  const invoke = () =>
    kind === 'user' || kind === 'application'
      ? withCrmAuditRequest(
          captureCrmAuditRequest({
            workspace: { id: workspaceId },
            ...(kind === 'user'
              ? { user: { id: userId } }
              : { application: { id: applicationId } }),
          }),
          dispatch,
        )
      : dispatch();
  return {
    workspaceId,
    userId,
    userWorkspaceId,
    applicationId,
    agentId,
    accountId,
    channelId,
    context,
    userAuth,
    composed,
    compose,
    send,
    tool,
    invoke,
  };
};

afterEach(() => jest.restoreAllMocks());

it.each(['user', 'application', 'workflow', 'agent'] as const)(
  'actual tool and auth wrapper capture %s identity before compose and send',
  async (kind) => {
    const f = build(kind);
    expect(await f.invoke()).toMatchObject({ success: true });
    expect(
      f.send.captureRequestAuditOperation.mock.invocationCallOrder[0],
    ).toBeLessThan(f.compose.composeEmail.mock.invocationCallOrder[0]);
    expect(f.compose.composeEmail.mock.invocationCallOrder[0]).toBeLessThan(
      f.send.sendComposedEmail.mock.invocationCallOrder[0],
    );
    const matching = f.send.persistSentMessage.mock.calls[0][3];
    expect(matching).toMatchObject({
      kind: 'sent-tool',
      connectedAccountId: f.accountId,
      messageChannelId: f.channelId,
      userWorkspaceId:
        kind === 'user' || kind === 'workflow' ? f.userWorkspaceId : null,
    });
    expect(matching.operation.actor).toEqual(
      kind === 'application'
        ? { kind: 'application', id: f.applicationId }
        : kind === 'agent'
          ? { kind: 'agent', id: f.agentId }
          : { kind: 'coreUser', id: f.userId },
    );
    if (kind === 'agent')
      expect(matching.operation.initiator).toEqual({
        kind: 'application',
        id: f.applicationId,
      });
    expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
  },
);

it('workflow trusted context and selected account are copied before external awaits mutate the inputs', async () => {
  const f = build('workflow');
  f.compose.composeEmail.mockImplementationOnce(async () => {
    f.context.workspaceId = randomUUID();
    f.context.userWorkspaceId = randomUUID();
    f.userAuth.user.id = randomUUID();
    return { success: true, data: f.composed };
  });
  f.send.sendComposedEmail.mockImplementationOnce(async () => {
    f.composed.connectedAccount.id = randomUUID();
    f.composed.messageChannelId = randomUUID();
    return {
      headerMessageId: 'sent-header',
      messageExternalId: 'sent-external',
      threadExternalId: 'sent-thread',
    };
  });
  expect(await f.invoke()).toMatchObject({ success: true });
  expect(f.send.persistSentMessage.mock.calls[0][2]).toBe(f.workspaceId);
  expect(f.send.persistSentMessage.mock.calls[0][3]).toMatchObject({
    userWorkspaceId: f.userWorkspaceId,
    effectiveUserId: f.userId,
    connectedAccountId: f.accountId,
    messageChannelId: f.channelId,
    operation: { actor: { kind: 'coreUser', id: f.userId } },
  });
});

it.each(['missing', 'system'] as const)(
  'tool refuses %s attribution before any external send',
  async (kind) => {
    const f = build(kind);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(await f.invoke()).toMatchObject({ success: false });
    expect(f.compose.composeEmail).not.toHaveBeenCalled();
    expect(f.send.sendComposedEmail).not.toHaveBeenCalled();
    expect(f.send.persistSentMessage).not.toHaveBeenCalled();
  },
);

it.each(['ordinary', 'unknown', 'confirmed'] as const)(
  'tool preserves one successful provider send after %s persistence failure',
  async (kind) => {
    const f = build('workflow');
    const error =
      kind === 'ordinary'
        ? new Error('persistence failed')
        : kind === 'unknown'
          ? new NativeTransactionOutcomeUnknownError(
              'commit',
              new Error('ACK lost'),
            )
          : new CoreAuditPostCommitError(new Error('hook failed'));
    f.send.persistSentMessage.mockRejectedValueOnce(error);
    expect(await f.invoke()).toMatchObject({
      success: true,
      result: {
        headerMessageId: 'sent-header',
        threadExternalId: 'sent-thread',
        messageId: undefined,
        messageThreadId: undefined,
      },
    });
    expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(f.send.persistSentMessage).toHaveBeenCalledTimes(1);
  },
);

it('post-send logger failure preserves provider success', async () => {
  const f = build('workflow');
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
    throw new Error('logger failed');
  });
  expect(await f.invoke()).toMatchObject({
    success: true,
    result: { headerMessageId: 'sent-header' },
  });
  expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
});
