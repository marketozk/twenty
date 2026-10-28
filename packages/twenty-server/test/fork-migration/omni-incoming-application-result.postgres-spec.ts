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
let captured: Awaited<ReturnType<typeof fixture.capture>>;
const migration = FORK_MIGRATIONS[8];
const receipts = () =>
  fixture.owner.query('SELECT * FROM core."omniIncomingReceipt" ORDER BY id');
const outcome = () => ({
  schemaVersion: 1,
  kind: 'incoming_text_revision',
  disposition: 'created',
  selectedRevisionId: randomUUID(),
  observedHeadRevisionId: null,
  candidateSourceRevisionKey: 'source:revision:1',
  candidateContentHash: 'a'.repeat(64),
});
const persist = (
  value: unknown,
  state = 'applied',
  resultId: string | null = randomUUID(),
) =>
  fixture.owner.query(
    'UPDATE core."omniIncomingReceipt" SET state=$2,"resultId"=$3,"applicationResult"=$4::jsonb,"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1',
    [captured.proof.receiptId, state, resultId, JSON.stringify(value)],
  );
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  captured = await fixture.capture(context);
});
afterAll(() => fixture.dispose());

it('upgrades populated prefix eight without inventing outcomes and supports null down/up', async () => {
  await fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    fixture.authorizeFor(context),
  );
  const before = (await receipts()).map(
    ({ applicationResult: _result, ...row }: Record<string, unknown>) => row,
  );
  await fixture.owner.transaction(async (manager) => {
    for (const later of [...FORK_MIGRATIONS.slice(8)].reverse()) {
      await later.command.down(manager.queryRunner!);
      await manager.query(
        'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
        [later.migrationId],
      );
    }
  });
  await new ForkSchemaVerifier(
    fixture.owner,
    FORK_SCHEMA_CHECKS.slice(0, 8),
  ).verifyReady();
  await expect(
    new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady(),
  ).rejects.toThrow('Pending fork migrations');
  expect(
    await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
  ).toEqual(FORK_MIGRATIONS.slice(8).map((entry) => entry.migrationId));
  expect(await receipts()).toEqual(
    before.map((row: Record<string, unknown>) => ({
      ...row,
      applicationResult: null,
    })),
  );
  expect(
    await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
  ).toEqual([]);
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});
it.each(['created', 'advanced', 'duplicate', 'stale'])(
  'permits an applied %s envelope at the SQL version gate',
  async (disposition) => {
    const value = { ...outcome(), disposition };
    await persist(value);
    expect((await receipts())[0].applicationResult).toEqual(value);
  },
);
it.each([
  {},
  [],
  null,
  { schemaVersion: 2, kind: 'incoming_text_revision', disposition: 'created' },
  {
    schemaVersion: '1',
    kind: 'incoming_text_revision',
    disposition: 'created',
  },
  { schemaVersion: 1, kind: 'wrong', disposition: 'created' },
  {
    schemaVersion: 1,
    kind: 'incoming_text_revision',
    disposition: 'incomparable',
  },
  { schemaVersion: 1, kind: 'incoming_text_revision' },
  { schemaVersion: 1, disposition: 'created' },
])(
  'rejects malformed SQL outcome envelope %# without changing receipt',
  async (value) => {
    const before = await receipts();
    await expect(persist(value)).rejects.toMatchObject({ code: '23514' });
    expect(await receipts()).toEqual(before);
  },
);
it.each(['accepted', 'retryable_error', 'blocked_config', 'quarantined'])(
  'rejects an outcome on %s receipt',
  async (state) => {
    const before = await receipts();
    await expect(persist(outcome(), state)).rejects.toMatchObject({
      code: '23514',
    });
    expect(await receipts()).toEqual(before);
  },
);
it('requires canonical resultId when an outcome is present', async () => {
  await expect(persist(outcome(), 'applied', null)).rejects.toMatchObject({
    code: '23514',
  });
});
it('refuses down when an application outcome is retained', async () => {
  await persist(outcome());
  const before = await receipts();
  await expect(
    fixture.owner.transaction((manager) =>
      migration.command.down(manager.queryRunner!),
    ),
  ).rejects.toThrow('OMNI_APPLICATION_RESULT_ROLLBACK_REQUIRES_RECONCILIATION');
  expect(await receipts()).toEqual(before);
  await new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady();
});
it.each([
  'DROP CONSTRAINT "CHK_omniIncomingReceipt_application_result"',
  'ALTER COLUMN "applicationResult" SET DEFAULT \'{}\'::jsonb',
  'ADD COLUMN "unexpectedApplicationResult" jsonb',
])('rejects schema drift: %s', async (alteration) => {
  const runner = fixture.owner.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('ALTER TABLE core."omniIncomingReceipt" ' + alteration);
    await expect(
      FORK_SCHEMA_CHECKS[8].verify(
        runner,
        FORK_SCHEMA_CHECKS.map((row) => row.migrationId),
      ),
    ).rejects.toThrow('does not match');
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});
