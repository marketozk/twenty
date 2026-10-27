import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type OmniIncomingPrincipal } from 'src/modules/omnichannel/services/accept-omni-incoming-event';
import {
  claimOmniIncomingReceipts,
  deferOmniIncomingReceipt,
  OmniIncomingLeaseLostError,
  OmniIncomingLeaseOutcomeUnknownError,
  renewOmniIncomingReceiptLease,
  type OmniIncomingReceiptLeaseAuthorizer,
  type OmniIncomingReceiptLeaseClaim,
  type OmniIncomingReceiptLeaseProof,
  type OmniIncomingReceiptDeferOutcome,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const roleName = `lease_runtime_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const password = randomUUID();
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = roleName;
runtimeUrl.password = password;
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  synchronize: false,
  migrationsRun: false,
  extra: { max: 8, statement_timeout: 10000 },
});
let principal: OmniIncomingPrincipal;
let authorize: OmniIncomingReceiptLeaseAuthorizer;
let leaseOwner: string;
type Action = 'claim' | 'renew' | 'defer';
type Row = Record<string, unknown>;
const retryOutcome = {
  state: 'retryable_error' as const,
  errorCode: 'transient_failure' as const,
  retryAfterMilliseconds: 1000,
};

const seedBinding = async (
  workspaceId: string = randomUUID(),
): Promise<OmniIncomingPrincipal> => {
  const bindingId = randomUUID();
  const connectedAccountId = randomUUID();
  const channelId = randomUUID();
  const queueId = randomUUID();
  await owner.query(
    'INSERT INTO core.workspace VALUES ($1) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  await owner.query(
    'INSERT INTO core."omniWorkspacePolicyState" ("workspaceId") VALUES ($1) ON CONFLICT ("workspaceId") DO NOTHING',
    [workspaceId],
  );
  await owner.query(
    'INSERT INTO core."connectedAccount" (id,"workspaceId") VALUES ($1,$2)',
    [connectedAccountId, workspaceId],
  );
  await owner.query(
    'INSERT INTO core."messageChannel" VALUES ($1,$2,$3,\'APP\')',
    [channelId, workspaceId, connectedAccountId],
  );
  await owner.query(
    `INSERT INTO core."omniAccountBinding"
    (id,"workspaceId",platform,"connectorInstanceId","accountId","connectedAccountId","messageChannelId","capabilitiesVersion",capabilities)
    VALUES ($1,$2,'telegram','fixture',$3,$4,$5,'fixture-v1','{}')`,
    [bindingId, workspaceId, randomUUID(), connectedAccountId, channelId],
  );
  await owner.query(
    'INSERT INTO core."omniQueue" (id,"workspaceId","bindingId",name) VALUES ($1,$2,$3,\'fixture\')',
    [queueId, workspaceId, bindingId],
  );
  await owner.query(
    'UPDATE core."omniAccountBinding" SET status=\'active\',"defaultQueueId"=$1 WHERE id=$2',
    [queueId, bindingId],
  );
  return { workspaceId, bindingId, actor: { kind: 'system', id: 'fixture' } };
};

const seedReceipt = async (
  changes: Row = {},
  scope = principal,
): Promise<string> => {
  const id = randomUUID();
  const envelope = {
    schemaVersion: 1,
    eventId: `fixture:${id}`,
    accountBindingId: scope.bindingId,
    routeGeneration: '1',
    kind: 'message.received',
    providerChatId: '90071992547409930001',
    providerMessageId: id,
    direction: 'incoming',
    sourceVariant: 'complete',
    nativeMessageKeyVersion: 1,
    occurredAt: null,
    sourcePosition: null,
    payload: {
      text: 'fixture-private-message',
      sourceAuthorId: 'fixture-private-author',
      sourceDisplayName: null,
    },
  };
  const row = {
    id,
    workspaceId: scope.workspaceId,
    bindingId: scope.bindingId,
    eventId: envelope.eventId,
    kind: envelope.kind,
    schemaVersion: 1,
    routeGeneration: '1',
    canonicalPayloadHash: auditPayloadHash(envelope),
    validatedEnvelope: JSON.stringify(envelope),
    ...changes,
  };
  const keys = Object.keys(row);
  await owner.query(
    `INSERT INTO core."omniIncomingReceipt" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
  return id;
};

const rows = () =>
  owner.query('SELECT * FROM core."omniIncomingReceipt" ORDER BY id');
const audits = () =>
  owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt"');
const claim = (changes = {}, authorizer = authorize) =>
  claimOmniIncomingReceipts(
    runtime,
    principal,
    { leaseOwner, limit: 10, leaseMilliseconds: 30000, ...changes },
    authorizer,
  );
const proofOf = (
  claimResult: OmniIncomingReceiptLeaseClaim,
): OmniIncomingReceiptLeaseProof => ({
  receiptId: claimResult.receiptId,
  leaseOwner: claimResult.leaseOwner,
  leaseToken: claimResult.leaseToken,
  routeGeneration: claimResult.routeGeneration,
});
const renew = (proof: OmniIncomingReceiptLeaseProof, authorizer = authorize) =>
  renewOmniIncomingReceiptLease(
    runtime,
    principal,
    proof,
    { leaseMilliseconds: 60000 },
    authorizer,
  );
const defer = (proof: OmniIncomingReceiptLeaseProof, authorizer = authorize) =>
  deferOmniIncomingReceipt(runtime, principal, proof, retryOutcome, authorizer);
const act = (
  action: Action,
  proof: OmniIncomingReceiptLeaseProof,
  authorizer = authorize,
) => {
  if (action === 'claim') return claim({}, authorizer);
  if (action === 'renew') return renew(proof, authorizer);
  return defer(proof, authorizer);
};
const setupAction = async (
  action: Action,
): Promise<OmniIncomingReceiptLeaseProof> => {
  const receiptId = await seedReceipt();
  if (action === 'claim')
    return { receiptId, leaseOwner, leaseToken: '0', routeGeneration: '1' };
  const [claimed] = await claim();
  return proofOf(claimed);
};
const waitForBlockedRuntime = async () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row]: { blocked: boolean }[] = await owner.query(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0) AS blocked',
      [roleName],
    );
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected runtime to wait for the held database lock');
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await owner.query(
    `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
  await owner.query('CREATE SCHEMA core');
  await owner.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await owner.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"archivedAt" timestamptz,"applicationId" uuid,"connectionProviderId" uuid)',
  );
  await owner.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"connectedAccountId" uuid NOT NULL,type text NOT NULL)',
  );
  await new ForkMigrationRunner(owner, FORK_MIGRATIONS).apply();
  await owner.query(`GRANT USAGE ON SCHEMA core,crm_audit TO "${roleName}"`);
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA core TO "${roleName}"`,
  );
  await owner.query(
    `GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA crm_audit TO "${roleName}"`,
  );
  principal = await seedBinding();
  leaseOwner = randomUUID();
  authorize = async (queryRunner, authorization) => {
    expect(queryRunner.isTransactionActive).toBe(true);
    expect(authorization).toMatchObject(principal);
    expect(['claim', 'renew', 'defer']).toContain(authorization.action);
  };
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(`DROP OWNED BY "${roleName}"`);
    await owner.query(`DROP ROLE "${roleName}"`);
    await owner.destroy();
  }
});

describe('incoming receipt leases on PostgreSQL', () => {
  it('claims only due accepted, retryable and expired processing receipts of the current generation', async () => {
    const past = new Date(Date.now() - 60000);
    const future = new Date(Date.now() + 60000);
    const eligible = [
      await seedReceipt(),
      await seedReceipt({ state: 'retryable_error', nextAttemptAt: past }),
      await seedReceipt({
        state: 'processing',
        leaseOwner: randomUUID(),
        leaseToken: '4',
        leaseUntil: past,
      }),
    ];
    await seedReceipt({ state: 'retryable_error', nextAttemptAt: future });
    await seedReceipt({ nextAttemptAt: future });
    await seedReceipt({
      state: 'processing',
      leaseOwner: randomUUID(),
      leaseToken: '7',
      leaseUntil: future,
    });
    for (const state of ['applied', 'blocked_config', 'quarantined'])
      await seedReceipt({ state });
    await seedReceipt({ routeGeneration: '2' });
    const before: Row[] = await rows();
    const claimed = await claim();
    expect(claimed.map((entry) => entry.receiptId).sort()).toEqual(
      eligible.sort(),
    );
    for (const entry of claimed) {
      expect(entry).toMatchObject({
        leaseOwner,
        routeGeneration: '1',
        attempts: 1,
      });
      expect(new Date(entry.leaseUntil).toISOString()).toBe(entry.leaseUntil);
    }
    const after: Row[] = await rows();
    expect(after.filter((row) => !eligible.includes(row.id as string))).toEqual(
      before.filter((row) => !eligible.includes(row.id as string)),
    );
    expect(
      (await audits()).filter((row: Row) => row.outcome === 'success'),
    ).toHaveLength(3);
  });

  it('gives a concurrent claim to exactly one owner', async () => {
    const receiptId = await seedReceipt();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claim({ leaseOwner: randomUUID() })),
    );
    const claims = results.flat();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      receiptId,
      leaseToken: '1',
      attempts: 1,
    });
    expect(await audits()).toHaveLength(1);
  });

  it('skips a locked receipt and claims another available row', async () => {
    const lockedId = await seedReceipt();
    const availableId = await seedReceipt();
    const lock = owner.createQueryRunner();
    try {
      await lock.startTransaction();
      await lock.query(
        'SELECT id FROM core."omniIncomingReceipt" WHERE id=$1 FOR UPDATE',
        [lockedId],
      );
      expect(
        (await claim({ limit: 1 })).map((entry) => entry.receiptId),
      ).toEqual([availableId]);
    } finally {
      if (lock.isTransactionActive) await lock.rollbackTransaction();
      await lock.release();
    }
    expect((await claim()).map((entry) => entry.receiptId)).toEqual([lockedId]);
  });

  it('honors the batch limit and does not audit an empty claim', async () => {
    for (let index = 0; index < 3; index++) await seedReceipt();
    expect(await claim({ limit: 2 })).toHaveLength(2);
    expect(await claim({ limit: 2 })).toHaveLength(1);
    const before = await audits();
    expect(await claim()).toEqual([]);
    expect(await audits()).toEqual(before);
  });

  it('reclaims with a new token and fences the former owner from renew and defer', async () => {
    await seedReceipt();
    const [first] = await claim();
    await owner.query(
      'UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [first.receiptId],
    );
    const [second] = await claim({ leaseOwner: randomUUID() });
    expect(second).toMatchObject({
      receiptId: first.receiptId,
      leaseToken: '2',
      attempts: 2,
    });
    const before = await rows();
    await expect(renew(proofOf(first))).rejects.toBeInstanceOf(
      OmniIncomingLeaseLostError,
    );
    await expect(defer(proofOf(first))).rejects.toBeInstanceOf(
      OmniIncomingLeaseLostError,
    );
    expect(await rows()).toEqual(before);
  });

  it('increments a bigint token exactly above the JavaScript safe integer range', async () => {
    await seedReceipt({ leaseToken: '9007199254740992', attempts: 4 });
    const [claimed] = await claim();
    expect(claimed).toMatchObject({
      leaseToken: '9007199254740993',
      attempts: 5,
    });
    const renewed = await renew(proofOf(claimed));
    expect(renewed).toMatchObject({
      leaseToken: claimed.leaseToken,
      attempts: 5,
    });
  });

  it('renews monotonically without changing the token, attempts or immutable envelope', async () => {
    await seedReceipt();
    const [claimed] = await claim({ leaseMilliseconds: 300000 });
    const before = (await rows())[0];
    const renewed = await renew(proofOf(claimed));
    expect(new Date(renewed.leaseUntil).getTime()).toBeGreaterThanOrEqual(
      new Date(claimed.leaseUntil).getTime(),
    );
    expect(renewed).toMatchObject({ ...proofOf(claimed), attempts: 1 });
    expect((await rows())[0]).toMatchObject({
      canonicalPayloadHash: before.canonicalPayloadHash,
      validatedEnvelope: before.validatedEnvelope,
      eventId: before.eventId,
    });
  });

  it.each(['renew', 'defer'] as const)(
    'rejects an expired proof before %s without changing the row',
    async (action) => {
      const proof = await setupAction(action);
      await owner.query(
        'UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
        [proof.receiptId],
      );
      const before = await rows();
      await expect(act(action, proof)).rejects.toBeInstanceOf(
        OmniIncomingLeaseLostError,
      );
      expect(await rows()).toEqual(before);
    },
  );

  it.each([
    { leaseOwner: randomUUID() },
    { leaseToken: '99' },
    { routeGeneration: '2' },
    { receiptId: randomUUID() },
  ])(
    'does not mutate a receipt with an incorrect proof: case %#',
    async (changes) => {
      const proof = await setupAction('renew');
      const before = await rows();
      await expect(renew({ ...proof, ...changes })).rejects.toBeInstanceOf(
        OmniIncomingLeaseLostError,
      );
      await expect(defer({ ...proof, ...changes })).rejects.toBeInstanceOf(
        OmniIncomingLeaseLostError,
      );
      expect(await rows()).toEqual(before);
    },
  );

  it('isolates claim and proof lookups by the full workspace and binding', async () => {
    const proof = await setupAction('renew');
    await seedReceipt();
    const foreignScopes = [
      await seedBinding(principal.workspaceId),
      await seedBinding(),
    ];
    const before = await rows();
    for (const foreign of foreignScopes) {
      expect(
        await claimOmniIncomingReceipts(
          runtime,
          foreign,
          { leaseOwner, limit: 10, leaseMilliseconds: 30000 },
          async () => undefined,
        ),
      ).toEqual([]);
      await expect(
        renewOmniIncomingReceiptLease(
          runtime,
          foreign,
          proof,
          { leaseMilliseconds: 30000 },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(OmniIncomingLeaseLostError);
      await expect(
        deferOmniIncomingReceipt(
          runtime,
          foreign,
          proof,
          retryOutcome,
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(OmniIncomingLeaseLostError);
    }
    expect(await rows()).toEqual(before);
  });

  it.each(['claim', 'renew', 'defer'] as const)(
    'requires current authorization before %s',
    async (action) => {
      const proof = await setupAction(action);
      const before = await rows();
      const deny = jest.fn(async () => {
        throw new Error('fixture-access-revoked');
      });
      await expect(act(action, proof, deny)).rejects.toThrow(
        'fixture-access-revoked',
      );
      expect(deny).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual(before);
      const serialized = JSON.stringify(await audits());
      expect(serialized).not.toContain('fixture-access-revoked');
      expect(serialized).not.toContain('fixture-private-message');
    },
  );

  it.each(['claim', 'renew', 'defer'] as const)(
    'refuses inactive binding during %s',
    async (action) => {
      const proof = await setupAction(action);
      await owner.query(
        'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
        [principal.bindingId],
      );
      const before = await rows();
      await expect(act(action, proof)).rejects.toThrow();
      expect(await rows()).toEqual(before);
    },
  );

  it.each(['claim', 'renew', 'defer'] as const)(
    'does not recreate a missing policy fence during %s',
    async (action) => {
      const proof = await setupAction(action);
      await owner.query('DELETE FROM core."omniWorkspacePolicyState"');
      const before = await rows();
      await expect(act(action, proof)).rejects.toThrow(
        'OMNI_INCOMING_LEASE_POLICY_STATE_MISSING',
      );
      expect(await rows()).toEqual(before);
      expect(
        await owner.query('SELECT * FROM core."omniWorkspacePolicyState"'),
      ).toEqual([]);
    },
  );

  it('does not claim the previous generation or accept its outstanding proof after route rotation', async () => {
    const proof = await setupAction('renew');
    await seedReceipt();
    await owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [principal.bindingId],
    );
    const before = await rows();
    expect(await claim()).toEqual([]);
    await expect(renew(proof)).rejects.toBeInstanceOf(
      OmniIncomingLeaseLostError,
    );
    await expect(defer(proof)).rejects.toBeInstanceOf(
      OmniIncomingLeaseLostError,
    );
    expect(await rows()).toEqual(before);
  });

  it('uses the database clock after waiting for the policy lock when claiming newly due work', async () => {
    const receiptId = await seedReceipt();
    const lock = owner.createQueryRunner();
    await lock.startTransaction();
    await lock.query(
      'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
      [principal.workspaceId],
    );
    await owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=clock_timestamp()+interval \'300 milliseconds\' WHERE id=$1',
      [receiptId],
    );
    const pending = claim().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForBlockedRuntime();
      await lock.query('SELECT pg_sleep(0.4)');
      await lock.commitTransaction();
      expect(await pending).toMatchObject({ result: [{ receiptId }] });
    } finally {
      if (lock.isTransactionActive) await lock.rollbackTransaction();
      await lock.release();
      await pending;
    }
  });

  it.each(['renew', 'defer'] as const)(
    'rechecks database time after a row-lock wait before %s',
    async (action) => {
      const proof = await setupAction(action);
      const lock = owner.createQueryRunner();
      await lock.startTransaction();
      await lock.query(
        'UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()+interval \'300 milliseconds\' WHERE id=$1',
        [proof.receiptId],
      );
      const pending = act(action, proof).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitForBlockedRuntime();
        await lock.query('SELECT pg_sleep(0.4)');
        await lock.commitTransaction();
        const outcome = await pending;
        expect(outcome).toHaveProperty('error');
        if ('error' in outcome)
          expect(outcome.error).toBeInstanceOf(OmniIncomingLeaseLostError);
        expect((await rows())[0]).toMatchObject({
          state: 'processing',
          leaseToken: proof.leaseToken,
          leaseOwner: proof.leaseOwner,
          attempts: 1,
        });
      } finally {
        if (lock.isTransactionActive) await lock.rollbackTransaction();
        await lock.release();
        await pending;
      }
    },
  );

  it('defers a transient failure, clears ownership and preserves immutable event data', async () => {
    const proof = await setupAction('defer');
    const before = (await rows())[0];
    const result = await defer(proof);
    expect(result).toMatchObject({
      receiptId: proof.receiptId,
      state: 'retryable_error',
      errorCode: 'transient_failure',
    });
    expect((await rows())[0]).toMatchObject({
      state: result.state,
      errorCode: result.errorCode,
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: proof.leaseToken,
      attempts: 1,
      canonicalPayloadHash: before.canonicalPayloadHash,
      validatedEnvelope: before.validatedEnvelope,
    });
    expect(await claim()).toEqual([]);
    await owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [proof.receiptId],
    );
    expect(await claim()).toMatchObject([
      { receiptId: proof.receiptId, leaseToken: '2', attempts: 2 },
    ]);
  });

  it.each([
    {
      state: 'blocked_config' as const,
      errorCode: 'configuration_missing' as const,
    },
    { state: 'quarantined' as const, errorCode: 'invalid_envelope' as const },
    { state: 'quarantined' as const, errorCode: 'unsupported_event' as const },
    {
      state: 'quarantined' as const,
      errorCode: 'inconsistent_source' as const,
    },
  ])(
    'retains $state/$errorCode without blindly scheduling it again',
    async (outcome) => {
      const proof = await setupAction('defer');
      expect(
        await deferOmniIncomingReceipt(
          runtime,
          principal,
          proof,
          outcome,
          authorize,
        ),
      ).toMatchObject({ receiptId: proof.receiptId, ...outcome });
      expect((await rows())[0]).toMatchObject({
        ...outcome,
        leaseOwner: null,
        leaseUntil: null,
      });
      expect(await claim()).toEqual([]);
    },
  );

  it.each(['claim', 'renew', 'defer'] as const)(
    'rolls back %s if its success audit cannot be persisted',
    async (action) => {
      const proof = await setupAction(action);
      const before = await rows();
      const successes = (await audits()).filter(
        (row: Row) => row.outcome === 'success',
      );
      await owner.query(
        'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT fixture_reject_new_success CHECK (outcome <> \'success\') NOT VALID',
      );
      await expect(act(action, proof)).rejects.toThrow();
      expect(await rows()).toEqual(before);
      expect(
        (await audits()).filter((row: Row) => row.outcome === 'success'),
      ).toEqual(successes);
    },
  );

  it.each(['claim', 'renew', 'defer'] as const)(
    'reports unknown after %s commits but its acknowledgement is lost',
    async (action) => {
      const proof = await setupAction(action);
      const auditCount = (await audits()).length;
      const queryRunner = runtime.createQueryRunner('master');
      const commit = queryRunner.commitTransaction.bind(queryRunner);
      jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
      jest
        .spyOn(queryRunner, 'commitTransaction')
        .mockImplementationOnce(async () => {
          await commit();
          throw new Error('fixture commit acknowledgement lost');
        });
      const error = await act(action, proof).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OmniIncomingLeaseOutcomeUnknownError);
      expect(error).toMatchObject({ action, receiptIds: [proof.receiptId] });
      expect((await rows())[0].state).toBe(
        action === 'defer' ? 'retryable_error' : 'processing',
      );
      expect(await audits()).toHaveLength(auditCount + 1);
      expect(
        (await audits()).every((row: Row) => row.outcome === 'success'),
      ).toBe(true);
      if (action === 'claim') expect(await claim()).toEqual([]);
    },
  );

  it('reports unknown after committed claim release fails without granting a second lease', async () => {
    const receiptId = await seedReceipt();
    const queryRunner = runtime.createQueryRunner('master');
    const release = queryRunner.release.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest.spyOn(queryRunner, 'release').mockImplementationOnce(async () => {
      await release();
      throw new Error('fixture release acknowledgement lost');
    });
    const error = await claim().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmniIncomingLeaseOutcomeUnknownError);
    expect(error).toMatchObject({ action: 'claim', receiptIds: [receiptId] });
    expect(await claim()).toEqual([]);
    expect(await audits()).toHaveLength(1);
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { leaseMilliseconds: 999 },
    { leaseMilliseconds: 300001 },
    { leaseOwner: 'not-a-uuid' },
    { unexpected: 'field' },
  ])(
    'rejects invalid claim bounds before mutation: case %#',
    async (changes) => {
      await seedReceipt();
      const before = await rows();
      const authorizer = jest.fn(authorize);
      await expect(claim(changes, authorizer)).rejects.toThrow();
      expect(authorizer).not.toHaveBeenCalled();
      expect(await rows()).toEqual(before);
      expect(await audits()).toEqual([]);
    },
  );

  it.each([999, 300001, 1000.5, Number.NaN])(
    'rejects invalid renewal duration %s before authorization',
    async (leaseMilliseconds) => {
      const proof = await setupAction('renew');
      const before = await rows();
      const auditBefore = await audits();
      const authorizer = jest.fn(authorize);
      await expect(
        renewOmniIncomingReceiptLease(
          runtime,
          principal,
          proof,
          { leaseMilliseconds },
          authorizer,
        ),
      ).rejects.toThrow('OMNI_INCOMING_LEASE_INVALID_INPUT');
      expect(authorizer).not.toHaveBeenCalled();
      expect(await rows()).toEqual(before);
      expect(await audits()).toEqual(auditBefore);
    },
  );

  it.each([
    { ...retryOutcome, retryAfterMilliseconds: 999 },
    { ...retryOutcome, retryAfterMilliseconds: 86400001 },
    { ...retryOutcome, retryAfterMilliseconds: 1000.5 },
    { ...retryOutcome, errorCode: 'raw-provider-secret' },
    { state: 'applied', errorCode: 'transient_failure' },
    {
      state: 'blocked_config',
      errorCode: 'configuration_missing',
      retryAfterMilliseconds: 1000,
    },
  ])(
    'rejects unsupported defer outcomes before authorization: case %#',
    async (outcome) => {
      const proof = await setupAction('defer');
      const before = await rows();
      const auditBefore = await audits();
      const authorizer = jest.fn(authorize);
      await expect(
        deferOmniIncomingReceipt(
          runtime,
          principal,
          proof,
          outcome as OmniIncomingReceiptDeferOutcome,
          authorizer,
        ),
      ).rejects.toThrow('OMNI_INCOMING_LEASE_INVALID_INPUT');
      expect(authorizer).not.toHaveBeenCalled();
      expect(await rows()).toEqual(before);
      expect(await audits()).toEqual(auditBefore);
    },
  );
});
