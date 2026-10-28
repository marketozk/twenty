import { randomUUID } from 'node:crypto';
import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';
import { createOmniHumanCommandFixture } from 'test/fork-migration/omni-human-command.fixture';
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

const fixture = createOmniHumanCommandFixture();
let context: Awaited<ReturnType<typeof fixture.reset>>;
const commands = () =>
  fixture.owner.query('SELECT * FROM core."omniOutgoingCommand" ORDER BY id');
const policy = async () =>
  (
    await fixture.owner.query('SELECT * FROM core."omniWorkspacePolicyState"')
  )[0];
const changeIncarnation = (value = randomUUID()) =>
  fixture.owner.query(
    'UPDATE core."omniWorkspacePolicyState" SET "restoreIncarnation"=$1 WHERE "workspaceId"=$2',
    [value, fixture.workspaceId],
  );
const grants = () => ({
  authorize: jest.fn(async () => undefined),
  qualifyTransport: jest.fn(async () => undefined),
});
const claim = (commandId: string, callbacks = grants()) =>
  fixture.service.claimOmniHumanCommandLease(
    {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      actor: { kind: 'system', id: 'restore-test' },
    },
    { commandId, leaseMilliseconds: 300000 },
    callbacks,
  );
const intent = () => ({
  conversationId: context.conversationId,
  text: 'restore fixture',
  idempotencyKey: randomUUID(),
  expectedControlEpoch: '1',
  observedReplyRevision: '1',
});
const admit = (input = intent(), authorize = async () => undefined) =>
  fixture.service.admitOmniHumanTextCommand(context.human, input, authorize);
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('command creation restore context', () => {
  it('upgrades populated prefix six without inventing creation context, verifies and replays', async () => {
    const { commandId } = await context.admit();
    const [{ createdRestoreIncarnation: _context, ...before }] =
      await commands();
    const migration = FORK_MIGRATIONS[6];
    await fixture.owner.transaction(async (manager) => {
      for (const later of [...FORK_MIGRATIONS.slice(7)].reverse()) {
        await later.command.down(manager.queryRunner!);
        await manager.query(
          'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
          [later.migrationId],
        );
      }
      await migration.command.down(manager.queryRunner!);
      await manager.query(
        'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
        [migration.migrationId],
      );
    });
    await new ForkSchemaVerifier(
      fixture.owner,
      FORK_SCHEMA_CHECKS.slice(0, 6),
    ).verifyReady();
    await expect(
      new ForkSchemaVerifier(fixture.owner, FORK_SCHEMA_CHECKS).verifyReady(),
    ).rejects.toThrow('Pending fork migrations');
    expect(
      await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
    ).toEqual(FORK_MIGRATIONS.slice(6).map((entry) => entry.migrationId));
    expect(await commands()).toEqual([
      { ...before, createdRestoreIncarnation: null },
    ]);
    expect(
      await new ForkMigrationRunner(fixture.owner, FORK_MIGRATIONS).apply(),
    ).toEqual([]);
    await new ForkSchemaVerifier(
      fixture.owner,
      FORK_SCHEMA_CHECKS,
    ).verifyReady();
    expect(await claim(commandId)).toEqual({
      claimed: false,
      reason: 'restore_reconciliation_required',
    });
  });

  it.each([
    'DROP COLUMN "createdRestoreIncarnation"',
    'ALTER COLUMN "createdRestoreIncarnation" TYPE text',
    'ALTER COLUMN "createdRestoreIncarnation" SET DEFAULT uuid_generate_v4()',
    'ALTER COLUMN "createdRestoreIncarnation" SET NOT NULL',
    'ADD COLUMN "unexpectedRestoreContext" uuid',
  ])('rejects schema drift: %s', async (alteration) => {
    await context.admit();
    const runner = fixture.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `ALTER TABLE core."omniOutgoingCommand" ${alteration}`,
      );
      await expect(
        FORK_SCHEMA_CHECKS[6].verify(
          runner,
          FORK_SCHEMA_CHECKS.map((entry) => entry.migrationId),
        ),
      ).rejects.toThrow('does not match');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await new ForkSchemaVerifier(
      fixture.owner,
      FORK_SCHEMA_CHECKS,
    ).verifyReady();
  });
  it('captures the locked policy incarnation and records it in audit without changing payload identity', async () => {
    const current = await policy();
    const input = intent();
    const result = await admit(input);
    const [command] = await commands();
    expect(command.createdRestoreIncarnation).toBe(current.restoreIncarnation);
    expect(command.payload).not.toHaveProperty('createdRestoreIncarnation');
    const entries = await fixture.owner.query(
      `SELECT * FROM crm_audit."crmAuditEntry" WHERE "resourceId"=$1 AND outcome='success'`,
      [result.commandId],
    );
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).toContain(current.restoreIncarnation);
    expect(await claim(result.commandId)).toMatchObject({
      claimed: true,
      proof: {
        purpose: 'first_attempt',
        capturedRestoreIncarnation: current.restoreIncarnation,
      },
    });
  });

  it.each([null, 'different'] as const)(
    'denies a first claim with %s creation context after current authorization',
    async (contextValue) => {
      const { commandId } = await context.admit();
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "createdRestoreIncarnation"=$1 WHERE id=$2',
        [contextValue === null ? null : randomUUID(), commandId],
      );
      const before = await commands();
      const callbacks = grants();
      const priorAudit = await fixture.owner.query(
        'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
      );
      expect(await claim(commandId, callbacks)).toEqual({
        claimed: false,
        reason: 'restore_reconciliation_required',
      });
      expect(callbacks.authorize).toHaveBeenCalledTimes(1);
      expect(callbacks.qualifyTransport).not.toHaveBeenCalled();
      expect(await commands()).toEqual(before);
      expect(
        await fixture.owner.query(
          'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id',
        ),
      ).toEqual(priorAudit);
    },
  );

  it.each([null, 'old'] as const)(
    'replays %s context without relabelling or admitting a second command',
    async (contextValue) => {
      const input = intent();
      const result = await admit(input);
      if (contextValue === null)
        await fixture.owner.query(
          'UPDATE core."omniOutgoingCommand" SET "createdRestoreIncarnation"=NULL WHERE id=$1',
          [result.commandId],
        );
      const before = await commands();
      await changeIncarnation();
      expect(await admit(input)).toMatchObject({
        commandId: result.commandId,
        created: false,
      });
      expect(await commands()).toEqual(before);
      expect(await claim(result.commandId)).toEqual({
        claimed: false,
        reason: 'restore_reconciliation_required',
      });
    },
  );

  it('accepts a new command after the incarnation changes', async () => {
    await changeIncarnation();
    const current = await policy();
    const { commandId } = await context.admit();
    expect((await commands())[0].createdRestoreIncarnation).toBe(
      current.restoreIncarnation,
    );
    expect(await claim(commandId)).toMatchObject({
      claimed: true,
      proof: { capturedRestoreIncarnation: current.restoreIncarnation },
    });
  });

  it.each(
    ['dispatching', 'accepted', 'outcome_unknown'].flatMap((state) => [
      { state, legacy: false },
      { state, legacy: true },
    ]),
  )(
    'retains historical $state reconciliation across restore (legacy=$legacy)',
    async ({ state, legacy }) => {
      const { commandId } = await context.admit();
      const original = legacy
        ? null
        : (await commands())[0].createdRestoreIncarnation;
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1,"statusRevision"=2,"createdRestoreIncarnation"=$3 WHERE id=$2',
        [state, commandId, original],
      );
      await changeIncarnation();
      expect(await claim(commandId)).toMatchObject({
        claimed: true,
        proof: {
          purpose: 'reconcile_only',
          capturedRestoreIncarnation: (await policy()).restoreIncarnation,
        },
      });
      expect((await commands())[0].createdRestoreIncarnation).toBe(original);
    },
  );

  it('does not bypass a revoked worker grant for a stale command', async () => {
    const { commandId } = await context.admit();
    await changeIncarnation();
    const before = await commands();
    const callbacks = grants();
    callbacks.authorize.mockImplementation(async () => {
      throw new Error('revoked grant');
    });
    await expect(claim(commandId, callbacks)).rejects.toThrow();
    expect(await commands()).toEqual(before);
  });

  it('serializes policy restore behind an admission and then refuses its first dispatch', async () => {
    const original = await policy();
    const runner = fixture.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await admit(intent(), async () => {
        await expect(
          runner.query(
            'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE NOWAIT',
            [fixture.workspaceId],
          ),
        ).rejects.toThrow();
      });
      await runner.rollbackTransaction();
      await changeIncarnation();
      expect((await commands())[0].createdRestoreIncarnation).toBe(
        original.restoreIncarnation,
      );
      expect(await claim(result.commandId)).toEqual({
        claimed: false,
        reason: 'restore_reconciliation_required',
      });
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('holds the policy fence throughout the first claim', async () => {
    const { commandId } = await context.admit();
    const original = await policy();
    const runner = fixture.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const callbacks = grants();
    callbacks.qualifyTransport.mockImplementation(async () => {
      await expect(
        runner.query(
          'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE NOWAIT',
          [fixture.workspaceId],
        ),
      ).rejects.toThrow();
    });
    try {
      expect(await claim(commandId, callbacks)).toMatchObject({
        claimed: true,
        proof: { capturedRestoreIncarnation: original.restoreIncarnation },
      });
      await runner.rollbackTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('rolls back admission when an audit trigger changes the creation context', async () => {
    await fixture.owner.query(
      `CREATE FUNCTION core.log047_admission_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.outcome='success' THEN UPDATE core."omniOutgoingCommand" SET "createdRestoreIncarnation"='${randomUUID()}'::uuid; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log047_admission_tamper AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log047_admission_tamper()',
    );
    try {
      await expect(admit()).rejects.toThrow();
      expect(await commands()).toEqual([]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log047_admission_tamper ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION core.log047_admission_tamper()');
    }
  });

  it.each(['admit', 'claim'] as const)(
    'rolls back %s when an audit trigger changes the restore incarnation',
    async (operation) => {
      const commandId =
        operation === 'claim' ? (await context.admit()).commandId : null;
      const before = await commands();
      const original = await policy();
      await fixture.owner.query(
        `CREATE FUNCTION core.log047_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.outcome='success' THEN UPDATE core."omniWorkspacePolicyState" SET "restoreIncarnation"='${randomUUID()}'::uuid; END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER log047_tamper AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log047_tamper()',
      );
      try {
        await expect(commandId ? claim(commandId) : admit()).rejects.toThrow();
        expect(await commands()).toEqual(before);
        expect(await policy()).toEqual(original);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER log047_tamper ON crm_audit."crmAuditEntry"',
        );
        await fixture.owner.query('DROP FUNCTION core.log047_tamper()');
      }
    },
  );

  it('rolls back a claim if an AFTER UPDATE trigger changes its creation context', async () => {
    const { commandId } = await context.admit();
    const before = await commands();
    await fixture.owner.query(
      `CREATE FUNCTION core.log047_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN UPDATE core."omniOutgoingCommand" SET "createdRestoreIncarnation"='${randomUUID()}'::uuid WHERE id=NEW.id; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log047_after AFTER UPDATE ON core."omniOutgoingCommand" FOR EACH ROW EXECUTE FUNCTION core.log047_after()',
    );
    try {
      await expect(claim(commandId)).rejects.toThrow();
      expect(await commands()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log047_after ON core."omniOutgoingCommand"',
      );
      await fixture.owner.query('DROP FUNCTION core.log047_after()');
    }
  });
});
