import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { snapshotOmniIncomingCaptureContext } from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import { parseOmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import {
  acceptOmniIncomingEvent,
  OmniIncomingConflictError,
  OmniIncomingOutcomeUnknownError,
  type OmniIncomingAuthorizer,
  type OmniIncomingCaptureAuthorizer,
  type OmniIncomingPrincipal,
} from 'src/modules/omnichannel/services/accept-omni-incoming-event';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const roleName = `incoming_runtime_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
let authorize: OmniIncomingAuthorizer;
const envelope = (bindingId: string) => ({
  schemaVersion: 1,
  eventId: `fixture:${randomUUID()}`,
  accountBindingId: bindingId,
  routeGeneration: '1',
  kind: 'message.received',
  providerChatId: '90071992547409930001',
  providerMessageId: '90071992547409930002',
  direction: 'incoming',
  sourceVariant: 'complete',
  nativeMessageKeyVersion: 1,
  occurredAt: '2026-10-27T00:00:00.000Z',
  sourcePosition: { type: 'journal', value: '90071992547409930003' },
  payload: {
    text: 'fixture-private-message',
    sourceAuthorId: 'fixture-author-id',
    sourceDisplayName: 'fixture-private-name',
  },
});
let input: ReturnType<typeof envelope>;

const accept = (candidate: unknown = input, authorizer = authorize) =>
  acceptOmniIncomingEvent(runtime, principal, candidate, authorizer);

const captureContext = () => ({
  schemaVersion: 1,
  envelopeHash: auditPayloadHash(parseOmniIncomingEnvelope(input)),
  origin: 'live',
  qualification: {
    adapterId: 'synthetic-capture-fixture',
    adapterVersion: 'fixture-v1',
  },
  nativeMessageKeyVersion: 1,
  nativeMessageKey: `fixture:v1:incoming:${input.providerMessageId}`,
  sourceVariant: input.sourceVariant,
  sourcePosition: { ...input.sourcePosition },
});

// These tests exercise the boundary, not a real connector qualification registry.
const acceptCaptured = (
  context: unknown = captureContext(),
  captureAuthorizer: OmniIncomingCaptureAuthorizer = async () => undefined,
  authorizer: OmniIncomingAuthorizer = authorize,
) =>
  acceptOmniIncomingEvent(runtime, principal, input, authorizer, {
    context,
    authorize: captureAuthorizer,
  });

const receipts = () => owner.query('SELECT * FROM core."omniIncomingReceipt"');
const auditEntries = () =>
  owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt"');

const seedBinding = async (
  workspaceId: string = randomUUID(),
): Promise<{ workspaceId: string; bindingId: string }> => {
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
    'INSERT INTO core."connectedAccount" (id, "workspaceId") VALUES ($1,$2)',
    [connectedAccountId, workspaceId],
  );
  await owner.query(
    'INSERT INTO core."messageChannel" VALUES ($1,$2,$3,\'APP\')',
    [channelId, workspaceId, connectedAccountId],
  );
  await owner.query(
    `INSERT INTO core."omniAccountBinding"
     (id,"workspaceId",platform,"connectorInstanceId","accountId","connectedAccountId",
      "messageChannelId","capabilitiesVersion",capabilities)
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

  return { workspaceId, bindingId };
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
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "archivedAt" timestamptz, "applicationId" uuid, "connectionProviderId" uuid)',
  );
  await owner.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "connectedAccountId" uuid NOT NULL, type text NOT NULL)',
  );
  await new ForkMigrationRunner(owner, FORK_MIGRATIONS).apply();
  await owner.query(`GRANT USAGE ON SCHEMA core, crm_audit TO "${roleName}"`);
  await owner.query(
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO "${roleName}"`,
  );
  await owner.query(
    `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA crm_audit TO "${roleName}"`,
  );
  principal = {
    ...(await seedBinding()),
    actor: { kind: 'system', id: 'fixture' },
  };
  input = envelope(principal.bindingId);
  authorize = async (queryRunner, authorization) => {
    expect(queryRunner.isTransactionActive).toBe(true);
    expect(authorization).toEqual({
      ...principal,
      routeGeneration: input.routeGeneration,
      kind: input.kind,
    });
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

describe('trusted incoming capture persistence on PostgreSQL', () => {
  it('commits the detached capture and its hash with a redacted success audit', async () => {
    const context = captureContext();
    const snapshot = snapshotOmniIncomingCaptureContext(context, input);
    const result = await acceptCaptured(context);

    expect(result).toMatchObject({ created: true, state: 'accepted' });
    expect(await receipts()).toEqual([
      expect.objectContaining({
        id: result.receiptId,
        trustedCaptureContext: snapshot.context,
        trustedCaptureContextHash: snapshot.hash,
        validatedEnvelope: input,
      }),
    ]);
    const audits = await auditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    const serialized = JSON.stringify(audits);
    for (const value of [
      input.payload.text,
      input.payload.sourceAuthorId,
      input.providerChatId,
      context.nativeMessageKey,
      context.qualification.adapterId,
    ])
      expect(serialized).not.toContain(value);
  });

  it('keeps legacy four-argument receipts explicitly unqualified', async () => {
    await accept();
    expect((await receipts())[0]).toMatchObject({
      trustedCaptureContext: null,
      trustedCaptureContextHash: null,
    });
  });

  it('replays a reordered identical capture after fresh authorization without duplicating audit', async () => {
    const context = captureContext();
    const captureAuthorizer = jest.fn(async () => undefined);
    const first = await acceptCaptured(context, captureAuthorizer);
    const reordered = {
      ...Object.fromEntries(Object.entries(context).reverse()),
      qualification: Object.fromEntries(
        Object.entries(context.qualification).reverse(),
      ),
      sourcePosition: Object.fromEntries(
        Object.entries(context.sourcePosition).reverse(),
      ),
    };

    expect(await acceptCaptured(reordered, captureAuthorizer)).toEqual({
      ...first,
      created: false,
    });
    expect(captureAuthorizer).toHaveBeenCalledTimes(2);
    expect(await receipts()).toHaveLength(1);
    expect(await auditEntries()).toHaveLength(1);
  });

  it.each(['origin', 'nativeMessageKey', 'adapterVersion'] as const)(
    'rejects a valid but changed capture %s on replay without replacing the winner',
    async (field) => {
      const context = captureContext();
      await acceptCaptured(context);
      const before = await receipts();
      if (field === 'adapterVersion')
        context.qualification.adapterVersion = 'fixture-v2';
      else if (field === 'origin') context.origin = 'history_import';
      else context.nativeMessageKey = 'fixture:v1:different-canonical-key';

      expect(() =>
        snapshotOmniIncomingCaptureContext(context, input),
      ).not.toThrow();
      await expect(acceptCaptured(context)).rejects.toBeInstanceOf(
        OmniIncomingConflictError,
      );
      expect(await receipts()).toEqual(before);
    },
  );

  it.each([true, false])(
    'rejects qualification upgrade or downgrade on replay (initially qualified: %s)',
    async (qualifiedFirst) => {
      if (qualifiedFirst) await acceptCaptured();
      else await accept();
      const before = await receipts();

      await expect(
        qualifiedFirst ? accept() : acceptCaptured(),
      ).rejects.toBeInstanceOf(OmniIncomingConflictError);
      expect(await receipts()).toEqual(before);
    },
  );

  it('requires an explicit capture authorizer before opening a transaction', async () => {
    const baseAuthorizer = jest.fn(authorize);
    const createQueryRunner = jest.spyOn(runtime, 'createQueryRunner');
    await expect(
      acceptOmniIncomingEvent(runtime, principal, input, baseAuthorizer, {
        context: captureContext(),
        // @ts-expect-error Exercise a malformed runtime caller without its required callback.
        authorize: undefined,
      }),
    ).rejects.toThrow('OMNI_INGRESS_CAPTURE_AUTHORIZER_REQUIRED');
    expect(baseAuthorizer).not.toHaveBeenCalled();
    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
  });

  it.each([false, true])(
    'refuses capture authorization before persistence or replay disclosure (existing: %s)',
    async (existing) => {
      if (existing) await acceptCaptured();
      const before = await receipts();
      const baseAuthorizer = jest.fn(authorize);
      const captureAuthorizer = jest.fn(async () => {
        expect(baseAuthorizer).toHaveBeenCalledTimes(1);
        throw new Error('fixture-private-capture-denial');
      });

      await expect(
        acceptCaptured(captureContext(), captureAuthorizer, baseAuthorizer),
      ).rejects.toThrow('fixture-private-capture-denial');
      expect(captureAuthorizer).toHaveBeenCalledTimes(1);
      expect(await receipts()).toEqual(before);
      const audits = await auditEntries();
      expect(
        audits.filter((row: { outcome: string }) => row.outcome === 'denied'),
      ).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain(
        'fixture-private-capture-denial',
      );
    },
  );

  it('reads a capture authorizer accessor exactly once and executes the retained validator', async () => {
    const captureAuthorizer = jest.fn(async () => {
      throw new Error('fixture-captured-authorizer-denied');
    });
    const trustedCapture = {
      context: captureContext(),
      authorize: captureAuthorizer,
    };
    let reads = 0;
    Object.defineProperty(trustedCapture, 'authorize', {
      get: () => (++reads === 1 ? captureAuthorizer : undefined),
    });

    await expect(
      acceptOmniIncomingEvent(
        runtime,
        principal,
        input,
        authorize,
        trustedCapture,
      ),
    ).rejects.toThrow('fixture-captured-authorizer-denied');
    expect(reads).toBe(1);
    expect(captureAuthorizer).toHaveBeenCalledTimes(1);
    expect(await receipts()).toHaveLength(0);
  });

  it.each(['context accessor', 'asynchronous base authorizer'] as const)(
    'retains the original capture validator when replaced by the %s',
    async (mutationPoint) => {
      const captureAuthorizer = jest.fn(async () => {
        throw new Error('fixture-original-validator-denied');
      });
      const replacement = jest.fn(async () => undefined);
      const context = captureContext();
      const trustedCapture: Parameters<typeof acceptOmniIncomingEvent>[4] = {
        context,
        authorize: captureAuthorizer,
      };
      if (mutationPoint === 'context accessor') {
        Object.defineProperty(trustedCapture, 'context', {
          get: () => {
            trustedCapture.authorize = replacement;
            return context;
          },
        });
      }
      const baseAuthorizer: OmniIncomingAuthorizer = async (
        queryRunner,
        authorization,
      ) => {
        await authorize(queryRunner, authorization);
        if (mutationPoint === 'asynchronous base authorizer') {
          trustedCapture.authorize = replacement;
        }
      };

      await expect(
        acceptOmniIncomingEvent(
          runtime,
          principal,
          input,
          baseAuthorizer,
          trustedCapture,
        ),
      ).rejects.toThrow('fixture-original-validator-denied');
      expect(captureAuthorizer).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
      expect(await receipts()).toHaveLength(0);
    },
  );

  it('snapshots caller-owned capture before base authorization and freezes the capture authorization view', async () => {
    const context = captureContext();
    const original = JSON.parse(JSON.stringify(context));
    const captureAuthorizer: OmniIncomingCaptureAuthorizer = async (
      queryRunner,
      authorization,
    ) => {
      expect(queryRunner.isTransactionActive).toBe(true);
      expect(authorization).toEqual({
        ...principal,
        routeGeneration: input.routeGeneration,
        kind: input.kind,
        captureContext: original,
      });
      for (const value of [
        authorization,
        authorization.actor,
        authorization.captureContext,
        authorization.captureContext.qualification,
        authorization.captureContext.sourcePosition,
      ]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      expect(
        Reflect.set(authorization.captureContext, 'origin', 'restore_replay'),
      ).toBe(false);
      expect(
        Reflect.set(
          authorization.captureContext.qualification,
          'adapterVersion',
          'injected',
        ),
      ).toBe(false);
    };
    await acceptCaptured(context, captureAuthorizer, async () => {
      await Promise.resolve();
      context.origin = 'history_import';
      context.qualification.adapterVersion = 'changed-after-validation';
      context.sourcePosition.value = 'changed-after-validation';
      context.nativeMessageKey = 'changed-after-validation';
    });
    expect((await receipts())[0]).toMatchObject({
      trustedCaptureContext: original,
      trustedCaptureContextHash: auditPayloadHash(original),
    });
  });

  it('holds both policy and binding SHARE fences during capture authorization', async () => {
    const competitor = owner.createQueryRunner();
    try {
      await acceptCaptured(captureContext(), async (queryRunner) => {
        expect(queryRunner.isTransactionActive).toBe(true);
        for (const [table, column, value] of [
          ['omniWorkspacePolicyState', 'workspaceId', principal.workspaceId],
          ['omniAccountBinding', 'id', principal.bindingId],
        ]) {
          await competitor.startTransaction();
          await expect(
            competitor.query(
              `SELECT id FROM core."${table}" WHERE "${column}"=$1 FOR UPDATE NOWAIT`,
              [value],
            ),
          ).rejects.toMatchObject({ driverError: { code: '55P03' } });
          await competitor.rollbackTransaction();
        }
      });
    } finally {
      if (competitor.isTransactionActive)
        await competitor.rollbackTransaction();
      await competitor.release();
    }
    expect(await receipts()).toHaveLength(1);
  });

  it('rolls the trusted capture and receipt back when success audit cannot commit', async () => {
    await owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT fixture_reject_success CHECK (outcome <> \'success\')',
    );
    await expect(acceptCaptured()).rejects.toThrow();
    expect(await receipts()).toHaveLength(0);
    expect(
      (await auditEntries()).map((row: { outcome: string }) => row.outcome),
    ).toEqual(['failed']);
  });

  it('recovers a committed qualified receipt after a lost COMMIT acknowledgement by exact replay', async () => {
    const context = captureContext();
    const queryRunner = runtime.createQueryRunner('master');
    const commit = queryRunner.commitTransaction.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'commitTransaction')
      .mockImplementationOnce(async () => {
        await commit();
        throw new Error('fixture lost capture commit ACK');
      });
    await expect(acceptCaptured(context)).rejects.toBeInstanceOf(
      OmniIncomingOutcomeUnknownError,
    );
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0].trustedCaptureContextHash).toBe(auditPayloadHash(context));
    expect(await acceptCaptured(context)).toEqual({
      receiptId: rows[0].id,
      state: 'accepted',
      created: false,
    });
    expect(
      (await auditEntries()).map((row: { outcome: string }) => row.outcome),
    ).toEqual(['success']);
  });
});

describe('durable incoming event acceptance on PostgreSQL', () => {
  it('commits one accepted receipt and redacted audit before returning acknowledgement', async () => {
    const result = await accept();
    expect(result).toMatchObject({ state: 'accepted', created: true });
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.receiptId,
      workspaceId: principal.workspaceId,
      bindingId: principal.bindingId,
      eventId: input.eventId,
      state: 'accepted',
      routeGeneration: '1',
      validatedEnvelope: input,
      attempts: 0,
    });
    const audits = await auditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    const serialized = JSON.stringify(audits);
    for (const value of [
      input.payload.text,
      input.payload.sourceDisplayName,
      input.providerChatId,
    ])
      expect(serialized).not.toContain(value);
  });

  it('returns the same receipt for reordered keys and its current processing outcome', async () => {
    const first = await accept();
    const reordered = {
      ...Object.fromEntries(Object.entries(input).reverse()),
      payload: Object.fromEntries(Object.entries(input.payload).reverse()),
      sourcePosition: {
        value: input.sourcePosition.value,
        type: input.sourcePosition.type,
      },
    };
    await owner.query(
      'UPDATE core."omniIncomingReceipt" SET state=\'applied\',"resultId"=$1 WHERE id=$2',
      [randomUUID(), first.receiptId],
    );
    expect(await accept(reordered)).toMatchObject({
      receiptId: first.receiptId,
      state: 'applied',
      created: false,
    });
    expect(await auditEntries()).toHaveLength(1);
  });

  it('serializes 20 concurrent duplicate events into one durable receipt and success audit', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => accept()),
    );
    expect(new Set(results.map((result) => result.receiptId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect(
      (await auditEntries()).filter(
        (row: { outcome: string }) => row.outcome === 'success',
      ),
    ).toHaveLength(1);
  });

  it('rejects changed content under the same event identity without overwriting the receipt', async () => {
    await accept();
    const before = await receipts();
    await expect(
      accept({ ...input, payload: { ...input.payload, text: 'changed' } }),
    ).rejects.toBeInstanceOf(OmniIncomingConflictError);
    expect(await receipts()).toEqual(before);
  });

  it('preserves exactly one winner when simultaneous copies have conflicting payloads', async () => {
    const candidates = [
      input,
      { ...input, payload: { ...input.payload, text: 'conflicting-copy' } },
    ];
    let arrived = 0;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        accept(candidate, async (queryRunner, authorization) => {
          await authorize(queryRunner, authorization);
          arrived++;
          if (arrived === candidates.length) release();
          await ready;
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const winnerIndex = results.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const winner = results[winnerIndex];
    const loser = results.find((result) => result.status === 'rejected');
    if (winner.status !== 'fulfilled' || loser?.status !== 'rejected') {
      throw new Error('Expected one accepted event and one conflicting event');
    }
    expect(winner.value.created).toBe(true);
    expect(loser.reason).toBeInstanceOf(OmniIncomingConflictError);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: winner.value.receiptId,
      validatedEnvelope: candidates[winnerIndex],
    });
    expect(
      (await auditEntries()).filter(
        (row: { outcome: string }) => row.outcome === 'success',
      ),
    ).toHaveLength(1);
  });

  it('requires current authorization on replay before returning any retained result', async () => {
    await accept();
    let calls = 0;
    await expect(
      accept(input, async () => {
        calls++;
        throw new Error('fixture-current-access-revoked');
      }),
    ).rejects.toThrow('fixture-current-access-revoked');
    expect(calls).toBe(1);
    expect(await receipts()).toHaveLength(1);
  });

  it('rejects a binding substitution and a cross-workspace trusted principal', async () => {
    const otherBinding = await seedBinding(principal.workspaceId);
    const otherWorkspace = await seedBinding();
    await expect(
      accept({ ...input, accountBindingId: otherBinding.bindingId }),
    ).rejects.toThrow('OMNI_INGRESS_BINDING_MISMATCH');
    await expect(
      acceptOmniIncomingEvent(
        runtime,
        { ...principal, workspaceId: otherWorkspace.workspaceId },
        input,
        authorize,
      ),
    ).rejects.toThrow('OMNI_INGRESS_BINDING_NOT_FOUND');
    expect(await receipts()).toHaveLength(0);
  });

  it('keeps the same source event ID independent between bindings and workspaces', async () => {
    const first = await accept();
    const scopes = [
      await seedBinding(principal.workspaceId),
      await seedBinding(),
    ];
    const receiptIds = new Set([first.receiptId]);
    for (const scope of scopes) {
      const result = await acceptOmniIncomingEvent(
        runtime,
        { ...scope, actor: principal.actor },
        { ...input, accountBindingId: scope.bindingId },
        async () => undefined,
      );
      expect(result.created).toBe(true);
      receiptIds.add(result.receiptId);
    }
    expect(receiptIds.size).toBe(3);
    expect(await receipts()).toHaveLength(3);
    expect(await auditEntries()).toHaveLength(3);
  });

  it('rejects an old generation and an inactive route instead of acknowledging loss', async () => {
    await owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [principal.bindingId],
    );
    await expect(accept()).rejects.toThrow('OMNI_INGRESS_STALE_GENERATION');
    await owner.query(
      'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
      [principal.bindingId],
    );
    await expect(
      accept({ ...input, routeGeneration: '2' }, async () => undefined),
    ).rejects.toThrow('OMNI_INGRESS_BINDING_INACTIVE');
    expect(await receipts()).toHaveLength(0);
  });

  it('refuses a missing policy fence without silently recreating authorization state', async () => {
    await owner.query('DELETE FROM core."omniWorkspacePolicyState"');
    await expect(accept()).rejects.toThrow('OMNI_INGRESS_POLICY_STATE_MISSING');
    expect(await receipts()).toHaveLength(0);
    expect(
      await owner.query('SELECT * FROM core."omniWorkspacePolicyState"'),
    ).toHaveLength(0);
  });

  it.each([
    { workspaceId: randomUUID() },
    { origin: 'history_import' },
    { actor: { kind: 'system', id: 'forged' } },
    { schemaVersion: 2 },
    { kind: 'unsupported.kind' },
    { routeGeneration: 1 },
    { providerMessageId: 9007199254740991 },
    { providerChatId: 'x'.repeat(513) },
    {
      payload: {
        text: 'x'.repeat(65537),
        sourceAuthorId: null,
        sourceDisplayName: null,
      },
    },
    {
      payload: {
        text: 'я'.repeat(65536),
        sourceAuthorId: null,
        sourceDisplayName: null,
      },
    },
    {
      payload: {
        text: 'fixture',
        sourceAuthorId: null,
        sourceDisplayName: null,
        secret: 'injected',
      },
    },
  ])(
    'rejects invalid or privilege-bearing envelope before receipt persistence: case %#',
    async (changes) => {
      const authorizer = jest.fn(authorize);
      await expect(
        accept({ ...input, ...changes }, authorizer),
      ).rejects.toThrow();
      expect(authorizer).not.toHaveBeenCalled();
      expect(await receipts()).toHaveLength(0);
    },
  );

  it.each(['message.edited', 'message.deleted'])(
    'retains a %s placeholder without inventing source metadata',
    async (kind) => {
      const candidate = {
        ...input,
        kind,
        sourceVariant: 'placeholder',
        direction: 'outgoing',
        occurredAt: null,
        sourcePosition: null,
        payload: { text: null, sourceAuthorId: null, sourceDisplayName: null },
      };
      await accept(candidate, async () => undefined);
      expect((await receipts())[0].validatedEnvelope).toEqual(candidate);
    },
  );

  it('keeps a valid bigint generation exact above the JavaScript safe integer range', async () => {
    input.routeGeneration = '9223372036854775807';
    await owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=$1 WHERE id=$2',
      [input.routeGeneration, principal.bindingId],
    );
    await accept();
    expect((await receipts())[0].routeGeneration).toBe(input.routeGeneration);
  });

  it('snapshots nested input before asynchronous authorization can mutate the original', async () => {
    const original = JSON.parse(JSON.stringify(input));
    const result = await accept(input, async () => {
      await Promise.resolve();
      input.payload.text = 'mutated-after-validation';
      input.sourcePosition.value = 'mutated-position';
    });
    expect((await receipts())[0].validatedEnvelope).toEqual(original);
    expect(await accept(original)).toMatchObject({
      receiptId: result.receiptId,
      created: false,
    });
  });

  it('rolls the receipt back if success audit insertion fails and retains no success', async () => {
    await owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT fixture_reject_success CHECK (outcome <> \'success\')',
    );
    await expect(accept()).rejects.toThrow();
    expect(await receipts()).toHaveLength(0);
    const audits = await auditEntries();
    expect(
      audits.filter((row: { outcome: string }) => row.outcome === 'success'),
    ).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('failed');
  });

  it('reports unavailable negative audit without losing the original refusal', async () => {
    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${roleName}"`,
    );
    const refusal = new Error('fixture-denied-secret');
    const error = await accept(input, async () => {
      throw refusal;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(refusal);
    expect(await receipts()).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
  });

  it('does not persist raw denial text or private envelope in the failure audit', async () => {
    await expect(
      accept(input, async () => {
        throw new Error('fixture-denied-secret');
      }),
    ).rejects.toThrow('fixture-denied-secret');
    const audits = await auditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('denied');
    const text = JSON.stringify(audits);
    expect(text).not.toContain('fixture-denied-secret');
    expect(text).not.toContain(input.payload.text);
    expect(text).not.toContain(input.payload.sourceAuthorId);
  });

  it('returns unknown after a lost commit acknowledgement and resolves it by same-event replay', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    const commit = queryRunner.commitTransaction.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'commitTransaction')
      .mockImplementationOnce(async () => {
        await commit();
        throw new Error('fixture lost commit ACK');
      });
    const error = await accept().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmniIncomingOutcomeUnknownError);
    expect((error as OmniIncomingOutcomeUnknownError).eventId).toBe(
      input.eventId,
    );
    const replay = await accept();
    expect(replay.created).toBe(false);
    expect(replay.receiptId).toBe((await receipts())[0].id);
    expect(
      (await auditEntries()).map((row: { outcome: string }) => row.outcome),
    ).toEqual(['success']);
  });

  it('does not acknowledge a commit submission failure or record a false negative outcome', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'commitTransaction')
      .mockRejectedValueOnce(new Error('fixture commit unavailable'));
    await expect(accept()).rejects.toBeInstanceOf(
      OmniIncomingOutcomeUnknownError,
    );
    expect(await receipts()).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
    expect(await accept()).toMatchObject({ created: true, state: 'accepted' });
  });

  it('returns unknown after committed connection release fails and replays the retained receipt', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    const release = queryRunner.release.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest.spyOn(queryRunner, 'release').mockImplementationOnce(async () => {
      await release();
      throw new Error('fixture release acknowledgement lost');
    });
    const error = await accept().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmniIncomingOutcomeUnknownError);
    expect((error as OmniIncomingOutcomeUnknownError).eventId).toBe(
      input.eventId,
    );
    expect(queryRunner.isReleased).toBe(true);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(await accept()).toEqual({
      receiptId: rows[0].id,
      state: 'accepted',
      created: false,
    });
    expect(
      (await auditEntries()).map((row: { outcome: string }) => row.outcome),
    ).toEqual(['success']);
  });

  it('cleans an unconfirmed ORM rollback with raw ROLLBACK without inventing audit outcomes', async () => {
    await owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT fixture_reject_success CHECK (outcome <> \'success\')',
    );
    const queryRunner = runtime.createQueryRunner('master');
    const rollbackError = new Error('fixture ORM rollback unavailable');
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'rollbackTransaction')
      .mockRejectedValueOnce(rollbackError);
    const queries = jest.spyOn(queryRunner, 'query');
    const error = await accept().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'OMNI_INGRESS_ROLLBACK_UNCONFIRMED',
    );
    expect((error as AggregateError).errors).toContain(rollbackError);
    expect(queries).toHaveBeenCalledWith('ROLLBACK');
    expect(queryRunner.isReleased).toBe(true);
    expect(await receipts()).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
    await owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" DROP CONSTRAINT fixture_reject_success',
    );
    expect(await accept()).toMatchObject({ created: true, state: 'accepted' });
    expect(await receipts()).toHaveLength(1);
    expect(
      (await auditEntries()).map((row: { outcome: string }) => row.outcome),
    ).toEqual(['success']);
  });

  it('holds the policy SHARE fence across authorization and durable acceptance', async () => {
    const lock = owner.createQueryRunner();
    try {
      await accept(input, async () => {
        await lock.startTransaction();
        await expect(
          lock.query(
            'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE NOWAIT',
            [principal.workspaceId],
          ),
        ).rejects.toMatchObject({ driverError: { code: '55P03' } });
        await lock.rollbackTransaction();
      });
      expect(await receipts()).toHaveLength(1);
    } finally {
      if (lock.isTransactionActive) await lock.rollbackTransaction();
      await lock.release();
    }
  });

  it('rechecks route state after waiting for a policy mutation to commit', async () => {
    const mutation = owner.createQueryRunner();
    await mutation.startTransaction();
    await mutation.query(
      'UPDATE core."omniWorkspacePolicyState" SET epoch=epoch+1 WHERE "workspaceId"=$1',
      [principal.workspaceId],
    );
    await mutation.query(
      'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
      [principal.bindingId],
    );
    const accepting = accept().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const [row]: { blocked: boolean }[] = await owner.query(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked',
          [roleName],
        );
        blocked = row.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await mutation.commitTransaction();
      expect(await accepting).toHaveProperty('error');
      expect(await receipts()).toHaveLength(0);
    } finally {
      if (mutation.isTransactionActive) await mutation.rollbackTransaction();
      await mutation.release();
      await accepting;
    }
  });
});
