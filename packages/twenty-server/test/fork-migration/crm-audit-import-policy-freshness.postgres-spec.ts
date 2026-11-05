import { randomUUID } from 'node:crypto';
import {
  BlocklistScope,
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
  MessageChannelContactAutoCreationPolicy,
  MessageChannelSyncStage,
  MessageChannelType,
  MessageParticipantRole,
} from 'twenty-shared/types';
import { type CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type MessageImportMatchingContext } from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { deleteOrdinarySyncCalendarAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/native-calendar-cleanup-with-audit';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  type WorkspaceTransactionOptions,
  type WorkspaceTransactionScope,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({
    CreateCompanyAndContactJob: { name: 'CreateCompanyAndContactJob' },
  }),
);

describe('CRM audit transactional import-policy and blocklist freshness (LOG155)', () => {
  const fixture = createOmniNativeMessageFixture({
    useStandardForeignKeyActions: true,
    additionalTables: [
      'company',
      'opportunity',
      'workspaceMember',
      'blocklist',
      'messageChannelMessageAssociationMessageFolder',
      'calendarEvent',
      'calendarEventParticipant',
      'calendarChannelEventAssociation',
      'calendarEventTarget',
      'callRecording',
    ],
  });

  const startedAt = '2030-01-01T00:00:00.123456Z';
  const table = (name: string) => `"${fixture.schemaName}"."${name}"`;

  const manager = {
    getWorkspaceId: () => fixture.workspaceId,
    executeInWorkspaceContext: async <T>(work: () => Promise<T>) =>
      fixture.withContext(work),
    runInWorkspaceTransaction: async <T>(
      work: (scope: WorkspaceTransactionScope) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ) => fixture.dataSource.transaction(work, options),
    getRepository: () => {
      throw new Error('NATIVE_READ_ESCAPED_TRANSACTION');
    },
  } as unknown as WorkspaceOrmManager;

  let queueAdd: jest.Mock;
  let matchMessageParticipants: jest.Mock;
  let matchCalendarParticipants: jest.Mock;
  let messageSaveService: MessagingSaveMessagesAndEnqueueContactCreationService;
  let calendarSaveService: CalendarSaveEventsService;
  let userWorkspaceId: string;
  let userId: string;
  let memberId: string;
  let otherUserWorkspaceId: string;
  let otherUserId: string;
  let otherMemberId: string;
  let account: ConnectedAccountEntity;
  let messageChannel: MessageChannelEntity;
  let calendarChannel: CalendarChannelEntity;

  const auditOperation = (): CrmAuditOperation => ({
    workspaceId: fixture.workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'system', id: 'import-policy-freshness-test' },
  });

  const messageRun = (): OrdinaryMetadataSyncRun => ({
    workspaceId: fixture.workspaceId,
    channelId: messageChannel.id,
    connectedAccountId: account.id,
    kind: 'message',
    stage: MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING,
    startedAt,
  });

  const calendarRun = (): OrdinaryMetadataSyncRun => ({
    workspaceId: fixture.workspaceId,
    channelId: calendarChannel.id,
    connectedAccountId: account.id,
    kind: 'calendar',
    stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    startedAt,
  });

  const providerMessageContext = (): MessageImportMatchingContext => ({
    operation: auditOperation(),
    authority: {
      kind: 'provider',
      workspaceId: fixture.workspaceId,
      connectedAccountId: account.id,
      channelId: messageChannel.id,
      channelType: MessageChannelType.EMAIL,
      run: messageRun(),
    },
  });

  const inboundMessageContext = (): MessageImportMatchingContext => ({
    operation: auditOperation(),
    authority: {
      kind: 'inbound',
      workspaceId: fixture.workspaceId,
      connectedAccountId: account.id,
      channelId: messageChannel.id,
      channelType: MessageChannelType.EMAIL_GROUP,
      recipient: messageChannel.handle,
    },
  });

  const makeMessage = (
    overrides: Partial<MessageWithParticipants> = {},
  ): MessageWithParticipants => ({
    externalId: 'ext-msg-1',
    headerMessageId: 'hdr-msg-1',
    subject: 'Customer inquiry',
    messageThreadExternalId: 'ext-thread-1',
    receivedAt: new Date('2030-01-02T10:00:00.000Z'),
    direction: MessageDirection.INCOMING,
    isDraft: false,
    text: 'Hello team',
    attachments: [],
    participants: [
      {
        role: MessageParticipantRole.FROM,
        handle: 'client@customer.com',
        displayName: 'Client User',
      },
      {
        role: MessageParticipantRole.TO,
        handle: 'owner@company.com',
        displayName: 'Owner User',
      },
    ],
    ...overrides,
  });

  const makeCalendarEvent = (
    overrides: Partial<FetchedCalendarEvent> = {},
  ): FetchedCalendarEvent => ({
    id: 'ext-cal-1',
    title: 'Client meeting',
    iCalUid: 'ical-cal-1',
    description: 'Discuss proposal',
    startsAt: '2030-01-01T10:00:00.000123Z',
    endsAt: '2030-01-01T11:00:00.000789Z',
    location: 'Room A',
    isFullDay: false,
    isCanceled: false,
    isPrivate: false,
    conferenceLinkLabel: 'Call link',
    conferenceLinkUrl: 'https://example.test/call',
    externalCreatedAt: '2029-01-01T00:00:00Z',
    externalUpdatedAt: '2029-01-02T00:00:00Z',
    conferenceSolution: '',
    organizerHandle: 'owner@company.com',
    status: 'confirmed',
    participants: [
      {
        displayName: 'Client Attendee',
        handle: 'client@customer.com',
        responseStatus: 'ACCEPTED',
        isOrganizer: false,
      },
    ],
    ...overrides,
  });

  const auditTrigger = async (body: string) =>
    fixture.owner.query(
      `CREATE FUNCTION "${fixture.schemaName}".policy_freshness_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER policy_freshness_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${fixture.schemaName}".policy_freshness_test()`,
    );

  beforeAll(async () => {
    await fixture.initialize();
    await fixture.owner.query(
      'ALTER TABLE core.workspace ADD "isInternalMessagesImportEnabled" boolean DEFAULT true',
    );
    await fixture.owner.query(
      'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "userId" uuid NOT NULL, "deletedAt" timestamptz)',
    );
    await fixture.owner.query(
      'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD scope text, ADD "userWorkspaceId" uuid, ADD provider text, ADD handle text, ADD "handleAliases" jsonb, ADD "applicationId" uuid, ADD "connectionProviderId" uuid, ADD "archivedAt" timestamptz',
    );
    await fixture.owner.query(
      'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid, ADD handle text, ADD "isSyncEnabled" boolean, ADD "syncStage" text, ADD "syncStageStartedAt" timestamptz, ADD "isContactAutoCreationEnabled" boolean, ADD "contactAutoCreationPolicy" text, ADD "excludeNonProfessionalEmails" boolean, ADD "excludeGroupEmails" boolean',
    );
    await fixture.owner.query(
      'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY, "workspaceId" uuid, "connectedAccountId" uuid, handle text, "isSyncEnabled" boolean, "syncStatus" text, "syncStage" text, "syncStageStartedAt" timestamptz, "isContactAutoCreationEnabled" boolean, "contactAutoCreationPolicy" text, "excludePrivateEvents" boolean)',
    );
    await fixture.owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
    );
  });

  beforeEach(async () => {
    await fixture.owner.query(
      `DROP TRIGGER IF EXISTS policy_freshness_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS "${fixture.schemaName}".policy_freshness_test()`,
    );
    await fixture.reset();
    await fixture.owner.query(
      `TRUNCATE core.workspace, core."connectedAccount", core."messageChannel", core."calendarChannel", core."userWorkspace", ${table('blocklist')}, ${table('workspaceMember')}, ${table('calendarEventTarget')}, ${table('calendarEventParticipant')}, ${table('calendarChannelEventAssociation')}, ${table('callRecording')}, ${table('calendarEvent')} CASCADE`,
    );
    await fixture.owner.query(
      'INSERT INTO core.workspace(id,"isInternalMessagesImportEnabled") VALUES($1,true)',
      [fixture.workspaceId],
    );

    userWorkspaceId = randomUUID();
    userId = randomUUID();
    memberId = randomUUID();
    otherUserWorkspaceId = randomUUID();
    otherUserId = randomUUID();
    otherMemberId = randomUUID();

    await fixture.owner.query(
      'INSERT INTO core."userWorkspace"(id,"workspaceId","userId","deletedAt") VALUES($1,$2,$3,NULL),($4,$2,$5,NULL)',
      [
        userWorkspaceId,
        fixture.workspaceId,
        userId,
        otherUserWorkspaceId,
        otherUserId,
      ],
    );
    await fixture.owner.query(
      `INSERT INTO ${table('workspaceMember')}(id,"userId") VALUES($1,$2),($3,$4)`,
      [memberId, userId, otherMemberId, otherUserId],
    );

    account = {
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      userWorkspaceId,
      provider: ConnectedAccountProvider.GOOGLE,
      handle: 'owner@company.com',
      handleAliases: ['alias@company.com'],
    } as unknown as ConnectedAccountEntity;

    messageChannel = {
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      connectedAccountId: account.id,
      type: MessageChannelType.EMAIL,
      handle: 'owner@company.com',
      isSyncEnabled: true,
      syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING,
      syncStageStartedAt: new Date(startedAt),
      isContactAutoCreationEnabled: true,
      contactAutoCreationPolicy:
        MessageChannelContactAutoCreationPolicy.SENT_AND_RECEIVED,
      excludeNonProfessionalEmails: false,
      excludeGroupEmails: false,
    } as unknown as MessageChannelEntity;

    calendarChannel = {
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      connectedAccountId: account.id,
      handle: 'owner@company.com',
      isSyncEnabled: true,
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      syncStageStartedAt: new Date(startedAt),
      isContactAutoCreationEnabled: false,
      contactAutoCreationPolicy: 'AS_PARTICIPANT_AND_ORGANIZER',
      excludePrivateEvents: false,
    } as unknown as CalendarChannelEntity;

    await fixture.owner.query(
      `INSERT INTO core."connectedAccount"(id,"workspaceId",scope,"userWorkspaceId",provider,handle,"handleAliases","archivedAt") VALUES($1,$2,'USER',$3,$4,$5,$6::jsonb,NULL)`,
      [
        account.id,
        fixture.workspaceId,
        userWorkspaceId,
        account.provider,
        account.handle,
        JSON.stringify(account.handleAliases),
      ],
    );
    await fixture.owner.query(
      `INSERT INTO core."messageChannel"(id,"workspaceId","connectedAccountId",type,handle,"isSyncEnabled","syncStage","syncStageStartedAt","isContactAutoCreationEnabled","contactAutoCreationPolicy","excludeNonProfessionalEmails","excludeGroupEmails") VALUES($1,$2,$3,$4,$5,true,$6,$7,true,$8,false,false)`,
      [
        messageChannel.id,
        fixture.workspaceId,
        account.id,
        messageChannel.type,
        messageChannel.handle,
        MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING,
        startedAt,
        MessageChannelContactAutoCreationPolicy.SENT_AND_RECEIVED,
      ],
    );
    await fixture.owner.query(
      `INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId",handle,"isSyncEnabled","syncStatus","syncStage","syncStageStartedAt","isContactAutoCreationEnabled","contactAutoCreationPolicy","excludePrivateEvents") VALUES($1,$2,$3,$4,true,'ONGOING',$5,$6,false,'AS_PARTICIPANT_AND_ORGANIZER',false)`,
      [
        calendarChannel.id,
        fixture.workspaceId,
        account.id,
        calendarChannel.handle,
        CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
        startedAt,
      ],
    );

    queueAdd = jest.fn(async () => undefined);
    matchMessageParticipants = jest.fn(async () => 'applied' as const);
    matchCalendarParticipants = jest.fn(async () => undefined);

    const messageService = new MessagingMessageService(manager);
    const messageParticipantService = new MessagingMessageParticipantService(
      manager,
      {
        matchParticipants: matchMessageParticipants,
        matchMessageImportParticipantsWithAudit: matchMessageParticipants,
      } as never,
    );
    const folderAssociationService =
      new MessagingMessageFolderAssociationService(manager);

    messageSaveService =
      new MessagingSaveMessagesAndEnqueueContactCreationService(
        { add: queueAdd } as unknown as MessageQueueService,
        messageService,
        messageParticipantService,
        folderAssociationService,
        manager,
        fixture.dataSource as never,
      );

    const calendarParticipantService = new CalendarEventParticipantService(
      manager,
      { matchParticipants: jest.fn() } as never,
      { add: jest.fn() } as never,
    );
    jest
      .spyOn(
        calendarParticipantService,
        'matchParticipantsAndEnqueueContactCreationJob',
      )
      .mockImplementation(matchCalendarParticipants);

    calendarSaveService = new CalendarSaveEventsService(
      manager,
      calendarParticipantService,
      { isFeatureEnabled: jest.fn(async () => false) } as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('declines provider message save when workspace or matching member blocklist blocks participant while ignoring unrelated member blocklist', async () => {
    // Unrelated member blocklist does NOT block save
    await fixture.owner.query(
      `INSERT INTO ${table('blocklist')}(id,handle,"workspaceMemberId",scope) VALUES($1,'@customer.com',$2,$3)`,
      [randomUUID(), otherMemberId, BlocklistScope.WORKSPACE_MEMBER],
    );

    // Matching member blocklist inserted after fetch / before save transaction locks blocklist
    const matchingRuleId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO ${table('blocklist')}(id,handle,"workspaceMemberId",scope) VALUES($1,'@customer.com',$2,$3)`,
      [matchingRuleId, memberId, BlocklistScope.WORKSPACE_MEMBER],
    );

    const declined =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [makeMessage()],
        messageChannel,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      );
    expect(declined).toBeUndefined();
    expect(queueAdd).not.toHaveBeenCalled();
    expect(matchMessageParticipants).not.toHaveBeenCalled();
    expect(
      await fixture.owner.query(`SELECT id FROM ${table('message')}`),
    ).toEqual([]);
    expect(
      await fixture.owner.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toEqual([]);
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."deferredWorkspaceMigrationAction"',
      ),
    ).toEqual([]);

    // Removing the matching member rule allows the save to succeed despite the other member's rule
    await fixture.owner.query(
      `DELETE FROM ${table('blocklist')} WHERE id = $1`,
      [matchingRuleId],
    );
    const saved =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [makeMessage()],
        messageChannel,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      );
    expect(saved?.messageExternalIdsAndIdsMap.size).toBe(1);
    expect(matchMessageParticipants).toHaveBeenCalledTimes(1);
  });

  it('enforces live DB excludeGroupEmails, isInternalMessagesImportEnabled, and isContactAutoCreationEnabled on message save', async () => {
    // 1. Live DB excludeGroupEmails = true declines bulk/group email even when caller passed excludeGroupEmails = false
    await fixture.owner.query(
      'UPDATE core."messageChannel" SET "excludeGroupEmails" = true WHERE id = $1',
      [messageChannel.id],
    );
    const groupDeclined =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [
          makeMessage({
            messageHeaders: [
              {
                name: 'List-Unsubscribe',
                value: '<mailto:unsub@customer.com>',
              },
            ],
          }),
        ],
        {
          ...messageChannel,
          excludeGroupEmails: false,
        } as MessageChannelEntity,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      );
    expect(groupDeclined).toBeUndefined();

    // 2. Live DB inbound EMAIL_GROUP with excludeGroupEmails = true declines group email
    await fixture.owner.query(
      `UPDATE core."messageChannel" SET type = $2, handle = 'group@inbound.company.com', "excludeGroupEmails" = true WHERE id = $1`,
      [messageChannel.id, MessageChannelType.EMAIL_GROUP],
    );
    messageChannel.type = MessageChannelType.EMAIL_GROUP;
    messageChannel.handle = 'group@inbound.company.com';
    const inboundDeclined =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [
          makeMessage({
            participants: [
              {
                role: MessageParticipantRole.FROM,
                handle: 'noreply@customer.com',
                displayName: 'No Reply',
              },
            ],
          }),
        ],
        {
          ...messageChannel,
          excludeGroupEmails: false,
        } as MessageChannelEntity,
        account,
        fixture.workspaceId,
        { context: inboundMessageContext() },
      );
    expect(inboundDeclined).toBeUndefined();

    // Restore EMAIL channel and test live isInternalMessagesImportEnabled = false
    await fixture.owner.query(
      `UPDATE core."messageChannel" SET type = $2, handle = 'owner@company.com', "excludeGroupEmails" = false, "isContactAutoCreationEnabled" = false WHERE id = $1`,
      [messageChannel.id, MessageChannelType.EMAIL],
    );
    messageChannel.type = MessageChannelType.EMAIL;
    messageChannel.handle = 'owner@company.com';
    await fixture.owner.query(
      'UPDATE core.workspace SET "isInternalMessagesImportEnabled" = false WHERE id = $1',
      [fixture.workspaceId],
    );

    const internalDeclined =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [
          makeMessage({
            participants: [
              {
                role: MessageParticipantRole.FROM,
                handle: 'colleague@company.com',
                displayName: 'Colleague',
              },
              {
                role: MessageParticipantRole.TO,
                handle: 'owner@company.com',
                displayName: 'Owner',
              },
            ],
          }),
        ],
        messageChannel,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      );
    expect(internalDeclined).toBeUndefined();

    // External email succeeds, and live DB isContactAutoCreationEnabled = false suppresses contact queue despite caller passing true
    const externalSaved =
      await messageSaveService.saveMessagesAndEnqueueContactCreation(
        [makeMessage()],
        {
          ...messageChannel,
          isContactAutoCreationEnabled: true,
        } as MessageChannelEntity,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      );
    expect(externalSaved?.messageExternalIdsAndIdsMap.size).toBe(1);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('rolls back message save, durable intent, and audit when blocklist or channel policy drifts before commit', async () => {
    const ruleId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO ${table('blocklist')}(id,handle,scope) VALUES($1,'@other-blocked.com',$2)`,
      [ruleId, BlocklistScope.WORKSPACE],
    );
    await auditTrigger(
      `UPDATE ${table('blocklist')} SET handle = '@customer.com' WHERE id = '${ruleId}';`,
    );

    await expect(
      messageSaveService.saveMessagesAndEnqueueContactCreation(
        [makeMessage()],
        messageChannel,
        account,
        fixture.workspaceId,
        { context: providerMessageContext(), expectedRun: messageRun() },
      ),
    ).rejects.toThrow('Import blocklist policy sources changed before commit');

    expect(
      await fixture.owner.query(`SELECT id FROM ${table('message')}`),
    ).toEqual([]);
    expect(
      await fixture.owner.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toEqual([]);
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."deferredWorkspaceMigrationAction"',
      ),
    ).toEqual([]);
  });

  it('declines provider calendar save on live blocklist or excludePrivateEvents and rolls back calendar save and sync cleanup on late policy drift', async () => {
    // 1. Live blocklist rule blocks calendar save
    const ruleId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO ${table('blocklist')}(id,handle,"workspaceMemberId",scope) VALUES($1,'@customer.com',$2,$3)`,
      [ruleId, memberId, BlocklistScope.WORKSPACE_MEMBER],
    );

    const blocklistDeclined =
      await calendarSaveService.saveCalendarEventsAndEnqueueContactCreationJob(
        [makeCalendarEvent()],
        calendarChannel,
        account,
        fixture.workspaceId,
        auditOperation(),
        calendarRun(),
      );
    expect(blocklistDeclined).toEqual({ calendarEventIds: [], applied: false });
    expect(matchCalendarParticipants).not.toHaveBeenCalled();
    expect(
      await fixture.owner.query(`SELECT id FROM ${table('calendarEvent')}`),
    ).toEqual([]);
    expect(
      await fixture.owner.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toEqual([]);
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."deferredWorkspaceMigrationAction"',
      ),
    ).toEqual([]);

    // 2. Remove blocklist rule, enable live excludePrivateEvents in DB -> declines private event even when caller passed excludePrivateEvents = false
    await fixture.owner.query(
      `DELETE FROM ${table('blocklist')} WHERE id = $1`,
      [ruleId],
    );
    await fixture.owner.query(
      'UPDATE core."calendarChannel" SET "excludePrivateEvents" = true WHERE id = $1',
      [calendarChannel.id],
    );

    const privateDeclined =
      await calendarSaveService.saveCalendarEventsAndEnqueueContactCreationJob(
        [makeCalendarEvent({ isPrivate: true })],
        {
          ...calendarChannel,
          excludePrivateEvents: false,
        } as CalendarChannelEntity,
        account,
        fixture.workspaceId,
        auditOperation(),
        calendarRun(),
      );
    expect(privateDeclined).toEqual({ calendarEventIds: [], applied: false });

    // 3. Non-private event succeeds
    const saved =
      await calendarSaveService.saveCalendarEventsAndEnqueueContactCreationJob(
        [makeCalendarEvent({ isPrivate: false })],
        calendarChannel,
        account,
        fixture.workspaceId,
        auditOperation(),
        calendarRun(),
      );
    expect(saved.applied).toBe(true);
    expect(saved.calendarEventIds).toHaveLength(1);

    // 4. Late blocklist drift rolls back deleteOrdinarySyncCalendarAssociationsWithAudit
    const cleanupRuleId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO ${table('blocklist')}(id,handle,scope) VALUES($1,'@other.com',$2)`,
      [cleanupRuleId, BlocklistScope.WORKSPACE],
    );
    await auditTrigger(
      `UPDATE ${table('blocklist')} SET handle = '@customer.com' WHERE id = '${cleanupRuleId}';`,
    );

    await expect(
      fixture.withContext(() =>
        fixture.dataSource.transaction(
          (scope) =>
            deleteOrdinarySyncCalendarAssociationsWithAudit({
              scope,
              operation: auditOperation(),
              expectedRun: calendarRun(),
              eventExternalIds: ['ext-cal-1'],
            }),
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      ),
    ).rejects.toThrow('Import blocklist policy sources changed before commit');

    expect(
      await fixture.owner.query(
        `SELECT id FROM ${table('calendarChannelEventAssociation')}`,
      ),
    ).toHaveLength(1);
  });
});
