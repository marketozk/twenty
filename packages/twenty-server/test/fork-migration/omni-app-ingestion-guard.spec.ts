import { randomUUID } from 'node:crypto';

import { MessageParticipantRole } from 'twenty-shared/types';

import { ApplicationMessageIngestionService } from 'src/engine/metadata-modules/message-channel/services/application-message-ingestion.service';
import { buildAppMessageHeaderMessageId } from 'src/engine/metadata-modules/message-channel/utils/build-app-message-header-message-id.util';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';

jest.mock('src/engine/core-modules/cache-lock/cache-lock.service', () => ({
  CacheLockService: class {},
}));
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/services/application-message-channels.service',
  () => ({
    ApplicationMessageChannelsService: class {},
  }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service',
  () => ({
    MessagingSaveMessagesAndEnqueueContactCreationService: class {},
  }),
);

const fixture = () => {
  const personId = randomUUID();
  const messageId = randomUUID();
  const messageThreadId = randomUUID();
  const request = {
    applicationId: randomUUID(),
    workspaceId: randomUUID(),
    requestUserWorkspaceId: randomUUID(),
    messageChannelId: randomUUID(),
    messages: [
      {
        externalId: 'ordinary-app-message',
        threadExternalId: 'ordinary-app-thread',
        text: 'ordinary app body',
        receivedAt: new Date('2026-10-27T00:00:00.000Z'),
        participants: [
          {
            role: MessageParticipantRole.FROM,
            handle: 'external-contact',
            personId,
          },
        ],
      },
    ],
  };
  const messageChannel = {
    id: request.messageChannelId,
    isSyncEnabled: true,
    handle: 'app-account',
  };
  const connectedAccount = { id: randomUUID() };
  const channels = {
    findOwnedOrThrow: jest
      .fn()
      .mockResolvedValue({ messageChannel, connectedAccount }),
  };
  const aggregate = {
    saveMessagesAndEnqueueContactCreation: jest.fn().mockResolvedValue({
      messageExternalIdsAndIdsMap: new Map([
        [request.messages[0].externalId, messageId],
      ]),
      messageExternalIdToMessageThreadIdMap: new Map([
        [request.messages[0].externalId, messageThreadId],
      ]),
    }),
  };
  const personRepository = {
    find: jest.fn().mockResolvedValue([{ id: personId }]),
  };
  const manager = {
    executeInWorkspaceContext: jest.fn(async <T>(work: () => Promise<T>) =>
      work(),
    ),
    getRepository: jest.fn().mockReturnValue(personRepository),
  };
  const cache = {
    withLock: jest.fn(async <T>(work: () => Promise<T>) => work()),
  };
  const core = { query: jest.fn().mockResolvedValue([{ owned: false }]) };
  type Dependencies = ConstructorParameters<
    typeof ApplicationMessageIngestionService
  >;
  const service = new ApplicationMessageIngestionService(
    channels as unknown as Dependencies[0],
    aggregate as unknown as Dependencies[1],
    manager as unknown as Dependencies[2],
    cache as unknown as Dependencies[3],
    core as unknown as Dependencies[4],
  );

  return {
    service,
    request,
    messageChannel,
    connectedAccount,
    channels,
    aggregate,
    manager,
    personRepository,
    cache,
    core,
    messageId,
    messageThreadId,
  };
};

describe('ordinary APP ingestion excludes persisted omnichannel ownership', () => {
  it('rejects an owned channel before identity reads, cache locking and aggregate writes', async () => {
    const test = fixture();
    test.core.query.mockResolvedValue([{ owned: true }]);

    await expect(test.service.ingest(test.request)).rejects.toThrow(
      'not available for application ingestion',
    );
    expect(test.channels.findOwnedOrThrow).toHaveBeenCalledTimes(1);
    expect(test.core.query).toHaveBeenCalledWith(expect.any(String), [
      test.request.workspaceId,
      test.request.messageChannelId,
    ]);
    expect(test.manager.executeInWorkspaceContext).not.toHaveBeenCalled();
    expect(test.manager.getRepository).not.toHaveBeenCalled();
    expect(test.cache.withLock).not.toHaveBeenCalled();
    expect(
      test.aggregate.saveMessagesAndEnqueueContactCreation,
    ).not.toHaveBeenCalled();
  });

  it('fails closed when the ownership query fails', async () => {
    const test = fixture();
    const failure = new Error('fixture ownership query unavailable');
    test.core.query.mockRejectedValue(failure);

    await expect(test.service.ingest(test.request)).rejects.toBe(failure);
    expect(test.manager.getRepository).not.toHaveBeenCalled();
    expect(test.cache.withLock).not.toHaveBeenCalled();
    expect(
      test.aggregate.saveMessagesAndEnqueueContactCreation,
    ).not.toHaveBeenCalled();
  });

  it.each(
    [
      undefined,
      [],
      [{ owned: null }],
      [{ owned: 'false' }],
      [{ owned: false }, { owned: true }],
    ].map((result) => [result]),
  )(
    'does not treat a malformed ownership result as permission: %#',
    async (result) => {
      const test = fixture();
      test.core.query.mockResolvedValue(result);

      await expect(test.service.ingest(test.request)).rejects.toThrow(
        'OMNI_INVALID_CHANNEL_OWNERSHIP_RESULT',
      );
      expect(test.manager.getRepository).not.toHaveBeenCalled();
      expect(test.cache.withLock).not.toHaveBeenCalled();
      expect(
        test.aggregate.saveMessagesAndEnqueueContactCreation,
      ).not.toHaveBeenCalled();
    },
  );

  it('retains app reachability denial before the ownership lookup', async () => {
    const test = fixture();
    const failure = new Error('fixture app cannot reach channel');
    test.channels.findOwnedOrThrow.mockRejectedValue(failure);

    await expect(test.service.ingest(test.request)).rejects.toBe(failure);
    expect(test.core.query).not.toHaveBeenCalled();
    expect(test.cache.withLock).not.toHaveBeenCalled();
    expect(
      test.aggregate.saveMessagesAndEnqueueContactCreation,
    ).not.toHaveBeenCalled();
  });

  it('preserves ordinary APP normalization, identity lookup, cache path and result mapping', async () => {
    const test = fixture();
    const input = test.request.messages[0];

    expect(await test.service.ingest(test.request)).toEqual({
      messages: [
        {
          externalId: input.externalId,
          messageId: test.messageId,
          messageThreadId: test.messageThreadId,
        },
      ],
    });
    expect(test.personRepository.find).toHaveBeenCalledTimes(1);
    expect(test.cache.withLock).toHaveBeenCalledTimes(1);
    expect(
      test.aggregate.saveMessagesAndEnqueueContactCreation,
    ).toHaveBeenCalledWith(
      [
        {
          headerMessageId: buildAppMessageHeaderMessageId({
            applicationId: test.request.applicationId,
            messageChannelId: test.request.messageChannelId,
            externalId: input.externalId,
          }),
          subject: null,
          text: input.text,
          receivedAt: input.receivedAt,
          isDraft: false,
          externalId: input.externalId,
          messageThreadExternalId: input.threadExternalId,
          direction: MessageDirection.INCOMING,
          attachments: [],
          participants: [
            {
              ...input.participants[0],
              displayName: '',
              workspaceMemberId: null,
            },
          ],
        },
      ],
      test.messageChannel,
      test.connectedAccount,
      test.request.workspaceId,
    );
    expect(test.core.query.mock.invocationCallOrder[0]).toBeLessThan(
      test.manager.getRepository.mock.invocationCallOrder[0],
    );
    expect(test.core.query.mock.invocationCallOrder[0]).toBeLessThan(
      test.cache.withLock.mock.invocationCallOrder[0],
    );
  });

  it('keeps sync-disabled ordinary APP channels rejected without aggregate writes', async () => {
    const test = fixture();
    test.messageChannel.isSyncEnabled = false;

    await expect(test.service.ingest(test.request)).rejects.toThrow(
      'sync disabled',
    );
    expect(test.cache.withLock).not.toHaveBeenCalled();
    expect(
      test.aggregate.saveMessagesAndEnqueueContactCreation,
    ).not.toHaveBeenCalled();
  });
});
