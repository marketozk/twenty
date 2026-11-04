import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { withWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { SendEmailResolver } from 'src/modules/messaging/message-outbound-manager/resolvers/send-email.resolver';
import { MessagingDraftSendService } from 'src/modules/messaging/message-outbound-manager/services/messaging-draft-send.service';

// Actual resolver control flow and actual request ALS; these adapters replace
// HTTP guards and unrelated composer/provider/persistence collaborators only.
jest.mock(
  'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
  () => ({ ConnectedAccountMetadataService: class {} }),
);
jest.mock(
  'src/engine/core-modules/tool/tools/email-tool/email-composer.service',
  () => ({ EmailComposerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/file/file-email-attachment/services/file-email-attachment.service',
  () => ({ FileEmailAttachmentService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-outbound-manager/services/send-email.service',
  () => ({ SendEmailService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-outbound-manager/services/sent-message-record-link.service',
  () => ({ SentMessageRecordLinkService: class {} }),
);
jest.mock('src/engine/core-modules/i18n/i18n.service', () => ({
  I18nService: class {},
}));
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock('src/engine/guards/settings-permission.guard', () => ({
  SettingsPermissionGuard: () => class {},
}));
jest.mock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.mock(
  'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
  () => ({ AuthGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
  () => ({ ResolverValidationPipe: class {} }),
);
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

const build = () => {
  const workspaceId = randomUUID(),
    userWorkspaceId = randomUUID(),
    userId = randomUUID(),
    connectedAccountId = randomUUID(),
    draftMessageId = randomUUID();
  const operation: CrmAuditOperation = {
    workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'coreUser', id: userId },
  };
  const authentication = {
    type: 'user' as const,
    workspace: { id: workspaceId },
    userWorkspaceId,
    user: { id: userId },
  };
  const input = {
    connectedAccountId,
    draftMessageId,
    to: 'recipient@example.test',
    subject: 'Subject',
    body: '<p>Body</p>',
  };
  const cleanupTarget = Object.freeze({
    associationId: randomUUID(),
    messageChannelId: randomUUID(),
    messageExternalId: 'provider-selected-draft',
  });
  const send = {
    captureRequestAuditOperation: jest.fn().mockResolvedValue(operation),
    sendComposedDraft: jest.fn().mockResolvedValue({
      sendResult: { messageExternalId: 'confirmed-provider-id' },
      cleanupTarget,
    }),
    sendComposedEmail: jest
      .fn()
      .mockResolvedValue({ messageExternalId: 'confirmed-provider-id' }),
    persistSentMessage: jest.fn(),
    deleteSentDraft: jest.fn().mockResolvedValue(undefined),
    getSentMessageThreadId: jest.fn().mockResolvedValue(undefined),
  };
  const account = {
    verifyUsableByCaller: jest.fn().mockResolvedValue(undefined),
  };
  const compose = {
    composeEmail: jest.fn().mockResolvedValue({
      success: true,
      data: {
        shouldPersistMessage: false,
        connectedAccount: { id: connectedAccountId },
      },
    }),
  };
  const resolver = new SendEmailResolver(
    account as never,
    compose as never,
    { deleteFiles: jest.fn() } as never,
    send as never,
    { linkSentMessageThreadToRecord: jest.fn() } as never,
    { getI18nInstance: () => ({ _: (value: unknown) => value }) } as never,
  );
  const invoke = () =>
    withWorkspaceAuthContext(authentication as never, () =>
      resolver.sendEmail(
        input as never,
        { id: workspaceId } as never,
        userWorkspaceId,
        { req: { locale: 'en' } },
      ),
    );
  return {
    resolver,
    send,
    account,
    compose,
    input,
    authentication,
    operation,
    cleanupTarget,
    invoke,
    workspaceId,
    userWorkspaceId,
    userId,
    connectedAccountId,
    draftMessageId,
  };
};
afterEach(() => jest.restoreAllMocks());

it('captures immutable cleanup IDs and the effective user before audit identity lookup and provider awaits', async () => {
  const f = build();
  let release!: () => void;
  f.send.captureRequestAuditOperation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(f.operation);
      }),
  );
  const result = f.invoke();
  f.input.draftMessageId = randomUUID();
  f.input.connectedAccountId = randomUUID();
  f.authentication.user.id = randomUUID();
  f.authentication.userWorkspaceId = randomUUID();
  release();
  expect(await result).toMatchObject({ success: true });
  expect(f.send.captureRequestAuditOperation).toHaveBeenCalledWith(
    f.workspaceId,
  );
  expect(
    f.send.captureRequestAuditOperation.mock.invocationCallOrder[0],
  ).toBeLessThan(f.send.sendComposedDraft.mock.invocationCallOrder[0]);
  expect(f.account.verifyUsableByCaller).toHaveBeenCalledWith({
    id: f.connectedAccountId,
    userWorkspaceId: f.userWorkspaceId,
    workspaceId: f.workspaceId,
  });
  expect(f.send.sendComposedDraft).toHaveBeenCalledWith(
    expect.anything(),
    f.draftMessageId,
    f.workspaceId,
  );
  expect(f.send.deleteSentDraft).toHaveBeenCalledWith(
    f.draftMessageId,
    f.connectedAccountId,
    f.workspaceId,
    { userWorkspaceId: f.userWorkspaceId, userId: f.userId },
    f.operation,
    f.cleanupTarget,
  );
  expect(f.send.sendComposedDraft).toHaveBeenCalledTimes(1);
});

it.each([
  'unknown-commit',
  'confirmed-postcommit',
  'ordinary-cleanup',
] as const)(
  'preserves confirmed send success when %s and logging both fail',
  async (kind) => {
    const f = build();
    const failure =
      kind === 'unknown-commit'
        ? new NativeTransactionOutcomeUnknownError(
            'commit',
            new Error('ACK lost'),
          )
        : kind === 'confirmed-postcommit'
          ? new CoreAuditPostCommitError(new Error('hook failed'))
          : new Error('cleanup unavailable');
    f.send.deleteSentDraft.mockRejectedValueOnce(failure);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    expect(await f.invoke()).toMatchObject({ success: true });
    expect(f.send.sendComposedDraft).toHaveBeenCalledTimes(1);
    expect(f.send.sendComposedEmail).not.toHaveBeenCalled();
    expect(f.send.deleteSentDraft).toHaveBeenCalledTimes(1);
    expect(f.send.getSentMessageThreadId).not.toHaveBeenCalled();
  },
);

it('does not send when request audit identity cannot be captured', async () => {
  const f = build();
  f.send.captureRequestAuditOperation.mockRejectedValueOnce(
    new Error('request identity unavailable'),
  );
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  expect(await f.invoke()).toEqual({ success: false });
  expect(f.compose.composeEmail).not.toHaveBeenCalled();
  expect(f.send.sendComposedDraft).not.toHaveBeenCalled();
  expect(f.send.deleteSentDraft).not.toHaveBeenCalled();
});

it.each(['workspace', 'membership'] as const)(
  'rejects mismatched authenticated %s before provider or audit attribution',
  async (kind) => {
    const f = build();
    if (kind === 'workspace') f.authentication.workspace.id = randomUUID();
    else f.authentication.userWorkspaceId = randomUUID();
    await expect(f.invoke()).rejects.toThrow(
      'Draft cleanup requires the authenticated workspace member.',
    );
    expect(f.send.captureRequestAuditOperation).not.toHaveBeenCalled();
    expect(f.send.sendComposedDraft).not.toHaveBeenCalled();
  },
);

it('captures request attribution for a non-draft send and keeps cleanup draft-only', async () => {
  const f = build();
  const { draftMessageId: _unused, ...input } = f.input;
  const result = await withWorkspaceAuthContext(f.authentication as never, () =>
    f.resolver.sendEmail(
      input as never,
      { id: f.workspaceId } as never,
      f.userWorkspaceId,
      { req: { locale: 'en' } },
    ),
  );
  expect(result).toMatchObject({ success: true });
  expect(f.send.captureRequestAuditOperation).toHaveBeenCalledWith(
    f.workspaceId,
  );
  expect(f.send.sendComposedDraft).not.toHaveBeenCalled();
  expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
  expect(f.send.deleteSentDraft).not.toHaveBeenCalled();
});

it('rejects a contradictory application when ambient request attribution is an agent', async () => {
  const workspaceId = randomUUID();
  const service = new MessagingDraftSendService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await expect(
    withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        application: { id: randomUUID() },
        agentId: randomUUID(),
      }),
      () =>
        service.captureRequestAuditOperation(workspaceId, {
          workspaceId,
          actor: { kind: 'application', id: randomUUID() },
          correlationId: randomUUID(),
        }),
    ),
  ).rejects.toThrow('Native messaging audit identity mismatch');
});

it.each(['user', 'apiKey', 'application', 'oauth', 'impersonated'] as const)(
  'preserves actual %s request attribution through non-draft persistence',
  async (kind) => {
    const f = build();
    const applicationId = randomUUID();
    const apiKeyId = randomUUID();
    const initiatorId = randomUUID();
    const membershipId = randomUUID();
    const request = {
      workspace: { id: f.workspaceId },
      ...(kind === 'apiKey' ? { apiKey: { id: apiKeyId } } : {}),
      ...(['user', 'oauth', 'impersonated'].includes(kind)
        ? { user: { id: f.userId } }
        : {}),
      ...(['application', 'oauth'].includes(kind)
        ? { application: { id: applicationId } }
        : {}),
      ...(kind === 'impersonated'
        ? {
            impersonationContext: { impersonatorUserWorkspaceId: membershipId },
          }
        : {}),
    };
    const capture = new MessagingDraftSendService(
      {} as never,
      {} as never,
      {} as never,
      {
        manager: {
          query: jest.fn().mockResolvedValue([{ userId: initiatorId }]),
        },
      } as never,
    );
    f.send.captureRequestAuditOperation.mockImplementation(
      (workspaceId: string) =>
        capture.captureRequestAuditOperation(workspaceId),
    );
    const channelId = randomUUID();
    f.compose.composeEmail.mockResolvedValue({
      success: true,
      data: {
        shouldPersistMessage: true,
        connectedAccount: { id: f.connectedAccountId },
        messageChannelId: channelId,
      },
    });
    const { draftMessageId: _unused, ...input } = f.input;
    const authentication =
      kind === 'apiKey'
        ? {
            type: 'apiKey',
            workspace: request.workspace,
            apiKey: request.apiKey,
          }
        : kind === 'application'
          ? {
              type: 'application',
              workspace: request.workspace,
              application: request.application,
            }
          : f.authentication;
    const result = await withCrmAuditRequest(
      captureCrmAuditRequest(request),
      () =>
        withWorkspaceAuthContext(authentication as never, () =>
          f.resolver.sendEmail(
            input as never,
            { id: f.workspaceId } as never,
            f.userWorkspaceId,
            { req: { locale: 'en' } },
          ),
        ),
    );
    expect(result).toMatchObject({ success: true });
    const actor =
      kind === 'apiKey'
        ? { kind: 'apiKey', id: apiKeyId }
        : ['application', 'oauth'].includes(kind)
          ? { kind: 'application', id: applicationId }
          : { kind: 'coreUser', id: f.userId };
    expect(f.send.persistSentMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      f.workspaceId,
      expect.objectContaining({
        operation: expect.objectContaining({
          workspaceId: f.workspaceId,
          actor,
          ...(kind === 'oauth'
            ? { initiator: { kind: 'coreUser', id: f.userId } }
            : {}),
          ...(kind === 'impersonated'
            ? { initiator: { kind: 'coreUser', id: initiatorId } }
            : {}),
        }),
        connectedAccountId: f.connectedAccountId,
        messageChannelId: channelId,
        userWorkspaceId: f.userWorkspaceId,
      }),
    );
    expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(f.send.deleteSentDraft).not.toHaveBeenCalled();
  },
);

it('preserves confirmed non-draft send when matching persistence and diagnostics fail', async () => {
  const f = build();
  f.compose.composeEmail.mockResolvedValue({
    success: true,
    data: {
      shouldPersistMessage: true,
      connectedAccount: { id: f.connectedAccountId },
    },
  });
  f.send.persistSentMessage.mockRejectedValueOnce(
    new NativeTransactionOutcomeUnknownError('commit', new Error('ACK lost')),
  );
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
    throw new Error('logger unavailable');
  });
  const { draftMessageId: _unused, ...input } = f.input;
  const result = await withWorkspaceAuthContext(f.authentication as never, () =>
    f.resolver.sendEmail(
      input as never,
      { id: f.workspaceId } as never,
      f.userWorkspaceId,
      { req: { locale: 'en' } },
    ),
  );
  expect(result).toMatchObject({ success: true });
  expect(f.send.persistSentMessage).toHaveBeenCalledTimes(1);
  expect(f.send.sendComposedEmail).toHaveBeenCalledTimes(1);
});

it('actual DraftSendService captures exactly the selected association before the provider changes available rows', async () => {
  const workspaceId = randomUUID(),
    accountId = randomUUID(),
    draftId = randomUUID();
  const selected = {
    id: randomUUID(),
    messageChannelId: randomUUID(),
    messageExternalId: 'actually-sent',
  };
  const alternative = {
    id: randomUUID(),
    messageChannelId: randomUUID(),
    messageExternalId: 'not-sent',
  };
  const original = { ...selected };
  const rows = [selected, alternative];
  const find = jest.fn().mockResolvedValue(rows);
  const manager = {
    executeInWorkspaceContext: async <T>(work: () => Promise<T>) => work(),
    getRepository: () => ({ find }),
  };
  const provider = {
    sendDraft: jest.fn().mockImplementation(async () => {
      selected.id = randomUUID();
      selected.messageChannelId = randomUUID();
      selected.messageExternalId = 'changed-after-provider-start';
      rows.reverse();
      return { messageExternalId: 'confirmed-sent-result' };
    }),
  };
  const channelRepository = {
    find: jest
      .fn()
      .mockResolvedValue([
        { id: selected.messageChannelId },
        { id: alternative.messageChannelId },
      ]),
  };
  const service = new MessagingDraftSendService(
    manager as never,
    provider as never,
    {} as never,
    channelRepository as never,
  );
  const result = await service.sendDraftMessage({
    workspaceId,
    draftMessageId: draftId,
    connectedAccount: { id: accountId } as never,
    sendMessageInput: {
      body: 'Body',
      html: '<p>Body</p>',
      subject: 'Subject',
      to: 'recipient@example.test',
    },
  });
  expect(provider.sendDraft).toHaveBeenCalledTimes(1);
  expect(provider.sendDraft.mock.calls[0][0]).toBe(original.messageExternalId);
  expect(result.sendResult).toEqual({
    messageExternalId: 'confirmed-sent-result',
  });
  expect(result.cleanupTarget).toEqual({
    associationId: original.id,
    messageChannelId: original.messageChannelId,
    messageExternalId: original.messageExternalId,
  });
  expect(Object.isFrozen(result.cleanupTarget)).toBe(true);
  expect(find).toHaveBeenCalledTimes(1);
});
