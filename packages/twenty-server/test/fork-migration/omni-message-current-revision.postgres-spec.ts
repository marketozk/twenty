import { randomUUID } from 'node:crypto';
import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';
import { createOmniHistoryApplyFixture } from 'test/fork-migration/omni-history-apply.fixture';
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
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service',
  () => ({ MessagingMessageFolderAssociationService: class {} }),
);

const fixture = createOmniHistoryApplyFixture();
let context: Awaited<ReturnType<typeof fixture.reset>>;
const migration = FORK_MIGRATIONS[7];
const core = (table: string) =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const seed = async () => {
  const linkId = await fixture.coreInsert('omniMessageLink', {
    workspaceId: fixture.workspaceId,
    bindingId: context.bindingId,
    conversationId: context.conversationId,
    messageId: randomUUID(),
    rawNativeMessageId: randomUUID(),
    nativeMessageKey: randomUUID(),
    nativeMessageKeyVersion: 1,
    displayOccurredAt: new Date('2026-10-28T00:00:00Z'),
    displayTimeSource: 'capture',
    immutableAuthorSnapshot: '{}',
    senderProvenance: 'unresolved_external',
    correlationState: 'not_applicable',
  });
  const revisionId = await fixture.coreInsert('omniMessageRevision', {
    workspaceId: fixture.workspaceId,
    messageLinkId: linkId,
    sourceRevisionKey: 'initial:' + randomUUID(),
    sourceEventId: randomUUID(),
    contentHash: 'a'.repeat(64),
    tombstone: false,
    origin: 'history_import',
  });
  return { linkId, revisionId };
};
const setHead = (linkId: string, revisionId: string) =>
  fixture.owner.query(
    'UPDATE core."omniMessageLink" SET "currentRevisionId"=$2 WHERE id=$1',
    [linkId, revisionId],
  );
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
});
afterAll(() => fixture.dispose());

it('preserves populated prefix seven without guessing a head, replays, and supports null-head down/up', async () => {
  await seed();
  const beforeLinks = (await core('omniMessageLink')).map(
    ({ currentRevisionId: _head, ...row }: Record<string, unknown>) => row,
  );
  const beforeRevisions = await core('omniMessageRevision');
  await fixture.owner.transaction(async (manager) => {
    await migration.command.down(manager.queryRunner!);
    await manager.query(
      'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
      [migration.migrationId],
    );
  });
  await new ForkSchemaVerifier(
    fixture.owner,
    FORK_SCHEMA_CHECKS.slice(0, 7),
  ).verifyReady();
  await expect(
    new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady(),
  ).rejects.toThrow('Pending fork migrations');
  expect(
    await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
  ).toEqual([migration.migrationId]);
  expect(await core('omniMessageLink')).toEqual(
    beforeLinks.map((row: Record<string, unknown>) => ({
      ...row,
      currentRevisionId: null,
    })),
  );
  expect(await core('omniMessageRevision')).toEqual(beforeRevisions);
  expect(
    await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
  ).toEqual([]);
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});

it('accepts a circular graph built with null then exact head and refuses deleting retained revision', async () => {
  const { linkId, revisionId } = await seed();
  await setHead(linkId, revisionId);
  expect((await core('omniMessageLink'))[0].currentRevisionId).toBe(revisionId);
  await expect(
    fixture.owner.query('DELETE FROM core."omniMessageRevision" WHERE id=$1', [
      revisionId,
    ]),
  ).rejects.toMatchObject({ code: '23503' });
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});
it('rejects a head belonging to another message even in the same workspace', async () => {
  const first = await seed(),
    second = await seed();
  await expect(setHead(first.linkId, second.revisionId)).rejects.toMatchObject({
    code: '23503',
  });
  expect(
    (await core('omniMessageLink')).every(
      (row: Record<string, unknown>) => row.currentRevisionId === null,
    ),
  ).toBe(true);
});
it('refuses populated-head down without removing evidence', async () => {
  const { linkId, revisionId } = await seed();
  await setHead(linkId, revisionId);
  const before = await core('omniMessageLink');
  await expect(
    fixture.owner.transaction((manager) =>
      migration.command.down(manager.queryRunner!),
    ),
  ).rejects.toThrow('OMNI_CURRENT_REVISION_ROLLBACK_REQUIRES_RECONCILIATION');
  expect(await core('omniMessageLink')).toEqual(before);
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});

it('rejects a revision from another workspace', async () => {
  const first = await seed();
  const workspaceId = randomUUID();
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    workspaceId,
  ]);
  const connectedAccountId = await fixture.coreInsert('connectedAccount', {
    workspaceId,
  });
  const messageChannelId = await fixture.coreInsert('messageChannel', {
    workspaceId,
    connectedAccountId,
    type: 'APP',
  });
  const bindingId = await fixture.coreInsert('omniAccountBinding', {
    workspaceId,
    platform: 'telegram',
    connectorInstanceId: 'other',
    accountId: randomUUID(),
    connectedAccountId,
    messageChannelId,
    capabilitiesVersion: 'v1',
    capabilities: '{}',
  });
  const policyId = await fixture.coreInsert('omniAutomationPolicy', {
    workspaceId,
    bindingId,
  });
  await fixture.coreInsert('omniAutomationPolicyVersion', {
    workspaceId,
    policyId,
    version: '0',
    settings: '{}',
    settingsHash: 'a'.repeat(64),
    publishedBy: '{"kind":"system","id":"test"}',
    publishedAt: new Date(),
  });
  const conversationId = await fixture.coreInsert('omniConversation', {
    workspaceId,
    bindingId,
    policyId,
    policyVersion: '0',
    providerChatId: randomUUID(),
    messageThreadId: randomUUID(),
  });
  const otherLinkId = await fixture.coreInsert('omniMessageLink', {
    workspaceId,
    bindingId,
    conversationId,
    messageId: randomUUID(),
    rawNativeMessageId: 'other',
    nativeMessageKey: 'other',
    nativeMessageKeyVersion: 1,
    displayOccurredAt: new Date(),
    displayTimeSource: 'capture',
    immutableAuthorSnapshot: '{}',
    senderProvenance: 'unresolved_external',
    correlationState: 'not_applicable',
  });
  const otherRevisionId = await fixture.coreInsert('omniMessageRevision', {
    workspaceId,
    messageLinkId: otherLinkId,
    sourceRevisionKey: 'initial',
    sourceEventId: 'other',
    contentHash: 'a'.repeat(64),
    tombstone: false,
    origin: 'history_import',
  });
  await expect(setHead(first.linkId, otherRevisionId)).rejects.toMatchObject({
    code: '23503',
  });
  await setHead(otherLinkId, otherRevisionId);
});
it.each([
  'ALTER COLUMN "currentRevisionId" TYPE text USING "currentRevisionId"::text',
  'ALTER COLUMN "currentRevisionId" SET DEFAULT uuid_generate_v4()',
  'ALTER COLUMN "currentRevisionId" SET NOT NULL',
  'DROP CONSTRAINT "FK_omniMessageLink_current_revision"',
  'ADD COLUMN "unexpectedRevision" uuid',
])('rejects head schema drift: %s', async (alteration) => {
  const runner = fixture.owner.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    if (alteration.includes('TYPE text'))
      await runner.query(
        'ALTER TABLE core."omniMessageLink" DROP CONSTRAINT "FK_omniMessageLink_current_revision"',
      );
    await runner.query('ALTER TABLE core."omniMessageLink" ' + alteration);
    await expect(
      FORK_SCHEMA_CHECKS[7].verify(
        runner,
        FORK_SCHEMA_CHECKS.map((row) => row.migrationId),
      ),
    ).rejects.toThrow();
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});
