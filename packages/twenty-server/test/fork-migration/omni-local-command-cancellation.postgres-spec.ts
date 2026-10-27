import { randomUUID } from 'node:crypto';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  isOmniLocalCommandCancellationProof,
  omniLocalCommandCancellationSqlPredicate,
} from 'src/modules/omnichannel/contracts/omni-local-command-cancellation';
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
let commandId: string;
type Callbacks = Parameters<
  typeof fixture.service.cancelOmniLocalHumanCommand
>[2];
const callbacks = (): Callbacks => ({
  authorizeRead: async (scope, descriptor) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(descriptor.conversationId).toBe(context.conversationId);
    expect(Object.isFrozen(descriptor)).toBe(true);
  },
});
const cancel = (id = commandId, grants = callbacks(), actor = context.human) =>
  fixture.service.cancelOmniLocalHumanCommand(actor, { commandId: id }, grants);
const claim = (id = commandId) =>
  fixture.service.claimOmniHumanCommandLease(
    {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      actor: { kind: 'system', id: 'cancel-test' },
    },
    { commandId: id, leaseMilliseconds: 300000 },
    {
      authorize: async () => undefined,
      qualifyTransport: async () => undefined,
    },
  );
const commands = () =>
  fixture.owner.query(
    `SELECT *,to_char("cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt" FROM core."omniOutgoingCommand" ORDER BY id`,
  );
const audits = () =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const graph = async () => ({
  conversation: await fixture.owner.query(
    'SELECT * FROM core."omniConversation" ORDER BY id',
  ),
  events: await fixture.owner.query(
    'SELECT * FROM core."omniDomainEvent" ORDER BY id',
  ),
  roots: await fixture.owner.query(
    'SELECT * FROM core."omniRootExecution" ORDER BY id',
  ),
  messages: await fixture.read('message'),
});
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  commandId = (await context.admit()).commandId;
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('local human cancellation through strict owner', () => {
  it.each(['missing', 'wrong actor'])(
    'rejects replay with %s audit',
    async (variant) => {
      await cancel();
      const before = await commands();
      if (variant === 'missing')
        await fixture.owner.query(
          `DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceId"=$1 AND action='update' AND outcome='success'`,
          [commandId],
        );
      else
        await fixture.owner.query(
          `UPDATE crm_audit."crmAuditEntry" SET actor=$2::jsonb WHERE "resourceId"=$1 AND action='update' AND outcome='success'`,
          [
            commandId,
            JSON.stringify({ kind: 'workspaceMember', id: randomUUID() }),
          ],
        );
      await expect(cancel()).rejects.toThrow();
      expect(await commands()).toEqual(before);
    },
  );
  it('refuses an existing command from a different workspace', async () => {
    const before = await commands();
    await expect(
      cancel(commandId, callbacks(), {
        ...context.human,
        workspaceId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await commands()).toEqual(before);
  });
  it('does not let malformed local proof release FIFO', async () => {
    await cancel();
    await fixture.owner.query(
      `UPDATE core."omniOutgoingCommand" SET "cancelEvidence"="cancelEvidence" || '{"extra":true}'::jsonb WHERE id=$1`,
      [commandId],
    );
    const next = (await context.admit()).commandId;
    await expect(claim(next)).rejects.toThrow();
    expect(
      (await commands()).find((row: { id: string }) => row.id === next).state,
    ).toBe('pending');
  });
  it('detects AFTER UPDATE tamper and rolls back the cancellation', async () => {
    const before = await commands();
    await fixture.owner.query(
      `CREATE FUNCTION core.log048_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN UPDATE core."omniOutgoingCommand" SET "cancelReason"='tampered' WHERE id=NEW.id; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log048_after AFTER UPDATE ON core."omniOutgoingCommand" FOR EACH ROW EXECUTE FUNCTION core.log048_after()',
    );
    try {
      await expect(cancel()).rejects.toThrow();
      expect(await commands()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log048_after ON core."omniOutgoingCommand"',
      );
      await fixture.owner.query('DROP FUNCTION core.log048_after()');
    }
  });
  it('atomically cancels virgin pending with one audit and no message or conversation changes', async () => {
    const before = await graph(),
      prior = await audits();
    expect(await cancel()).toEqual({
      cancelled: true,
      commandId,
      applied: true,
      state: 'cancelled',
      statusRevision: '2',
    });
    const [row] = await commands();
    expect(row).toMatchObject({
      state: 'cancelled',
      statusRevision: '2',
      cancelReason: 'human_cancel_before_enqueue',
      leaseToken: null,
      leaseUntil: null,
      connectorJobId: null,
      connectorAcceptedEvidence: null,
      journalSequence: null,
    });
    expect(row.cancelEvidence).toMatchObject({
      commandId,
      createdRestoreIncarnation: row.createdRestoreIncarnation,
      authorMemberId: context.human.workspaceMemberId,
      cancelledByMemberId: context.human.workspaceMemberId,
      cancelledByUserId: context.human.userId,
      cancelledAt: row.cancelRequestedAt,
    });
    const added = (await audits()).filter(
      (a: { id: string }) => !prior.some((b: { id: string }) => a.id === b.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      outcome: 'success',
      actor: { kind: 'workspaceMember', id: context.human.workspaceMemberId },
    });
    expect(added[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining([
        'state',
        'statusRevision',
        'cancelReason',
        'cancelRequestedAt',
        'cancelEvidence',
      ]),
    );
    expect(await graph()).toEqual(before);
    expect(await claim()).toEqual({ claimed: false, reason: 'terminal' });
  });
  it('replays without another audit even after a subsequent restore', async () => {
    await cancel();
    const before = await commands(),
      prior = await audits();
    await fixture.owner.query(
      'UPDATE core."omniWorkspacePolicyState" SET "restoreIncarnation"=$1',
      [randomUUID()],
    );
    expect(await cancel()).toMatchObject({ cancelled: true, applied: false });
    expect(await commands()).toEqual(before);
    expect(await audits()).toEqual(prior);
  });
  it('serializes concurrent cancels into one mutation', async () => {
    const prior = await audits();
    const results = await Promise.all([cancel(), cancel()]);
    expect(
      results.filter((result) => result.cancelled && result.applied),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.cancelled && !result.applied),
    ).toHaveLength(1);
    expect((await audits()).length - prior.length).toBe(1);
  });
  it('allows exactly one winner in a claim/cancel race', async () => {
    const [cancelled, claimed] = await Promise.all([cancel(), claim()]);
    const [row] = await commands();
    if (cancelled.cancelled) {
      expect(claimed).toEqual({ claimed: false, reason: 'terminal' });
      expect(row.state).toBe('cancelled');
    } else {
      expect(cancelled.reason).toBe('requires_reconciliation');
      expect(claimed.claimed).toBe(true);
      expect(row.state).toBe('dispatching');
    }
  });
  it.each(['dispatching', 'accepted', 'outcome_unknown'])(
    'does not cancel %s locally',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1,"statusRevision"=2 WHERE id=$2',
        [state, commandId],
      );
      const before = await commands(),
        prior = await audits();
      expect(await cancel()).toEqual({
        cancelled: false,
        commandId,
        reason: 'requires_reconciliation',
      });
      expect(await commands()).toEqual(before);
      expect(await audits()).toEqual(prior);
    },
  );
  it.each(['sent', 'failed', 'cancelled'])(
    'preserves terminal %s without inventing a proof',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1,"statusRevision"=2 WHERE id=$2',
        [state, commandId],
      );
      const before = await commands(),
        prior = await audits();
      expect(await cancel()).toEqual({
        cancelled: false,
        commandId,
        reason: 'terminal',
      });
      expect(await commands()).toEqual(before);
      expect(await audits()).toEqual(prior);
    },
  );
  it.each([null, 'old'])(
    'rejects pending with %s creation incarnation',
    async (value) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "createdRestoreIncarnation"=$1 WHERE id=$2',
        [value === null ? null : randomUUID(), commandId],
      );
      const before = await commands();
      expect(await cancel()).toEqual({
        cancelled: false,
        commandId,
        reason: 'restore_reconciliation_required',
      });
      expect(await commands()).toEqual(before);
    },
  );
  it.each([
    'statusRevision',
    'leaseToken',
    'connectorJobId',
    'journalSequence',
    'cancelReason',
  ])(
    'does not infer no enqueue from pending with retained %s',
    async (field) => {
      const values: Record<string, unknown> = {
        statusRevision: '2',
        leaseToken: randomUUID(),
        connectorJobId: 'job',
        journalSequence: '1',
        cancelReason: 'pending_cancel',
      };
      await fixture.owner.query(
        `UPDATE core."omniOutgoingCommand" SET "${field}"=$1${field === 'leaseToken' ? ',"leaseUntil"=clock_timestamp()+interval \'1 minute\'' : ''} WHERE id=$2`,
        [values[field], commandId],
      );
      expect(await cancel()).toEqual({
        cancelled: false,
        commandId,
        reason: 'requires_reconciliation',
      });
    },
  );
  it.each([false, true])(
    'checks current read access on initial/replay=%s',
    async (replay) => {
      if (replay) await cancel();
      const before = await commands();
      await expect(
        cancel(commandId, {
          authorizeRead: async () => {
            throw new Error('read revoked');
          },
        }),
      ).rejects.toThrow();
      expect(await commands()).toEqual(before);
      expect(
        (await audits()).some(
          (row: { reasonCode: string }) =>
            row.reasonCode === 'command.cancel.local.denied',
        ),
      ).toBe(true);
    },
  );
  it('requires live caller membership', async () => {
    await fixture.owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1',
      [context.human.userId],
    );
    const before = await commands();
    await expect(cancel()).rejects.toThrow();
    expect(await commands()).toEqual(before);
  });
  it('requires a separate delegated grant and records the cancelling manager', async () => {
    const manager = {
      workspaceId: fixture.workspaceId,
      userId: randomUUID(),
      workspaceMemberId: randomUUID(),
    };
    await fixture.owner.query('INSERT INTO core."user" (id) VALUES ($1)', [
      manager.userId,
    ]);
    await fixture.owner.query(
      'INSERT INTO core."userWorkspace" (id,"userId","workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), manager.userId, manager.workspaceId],
    );
    await fixture.withContext(() =>
      fixture.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('workspaceMember', {
              shouldBypassPermissionChecks: true,
            })
            .insert({
              id: manager.workspaceMemberId,
              userId: manager.userId,
              name: { firstName: 'Other', lastName: 'Manager' },
              userEmail: 'manager@example.test',
            });
        },
        { commitOutcome: 'strict' },
      ),
    );
    await expect(cancel(commandId, callbacks(), manager)).rejects.toThrow();
    await expect(
      cancel(
        commandId,
        {
          ...callbacks(),
          authorizeDelegatedCancel: async () => {
            throw new Error('delegated grant revoked');
          },
        },
        manager,
      ),
    ).rejects.toThrow();
    expect((await commands())[0].state).toBe('pending');
    const delegated = jest.fn(async () => undefined);
    expect(
      await cancel(
        commandId,
        { ...callbacks(), authorizeDelegatedCancel: delegated },
        manager,
      ),
    ).toMatchObject({ cancelled: true, applied: true });
    expect(delegated).toHaveBeenCalledTimes(1);
    const [row] = await commands();
    expect(row.actorId).toBe(context.human.workspaceMemberId);
    expect(row.cancelEvidence.cancelledByMemberId).toBe(
      manager.workspaceMemberId,
    );
    await expect(cancel(commandId, callbacks(), manager)).rejects.toThrow();
  });
  it('does not require active route/open conversation to stop a never-enqueued intent', async () => {
    await fixture.owner.query(
      `UPDATE core."omniAccountBinding" SET status='inactive',"routeGeneration"="routeGeneration"+1 WHERE id=$1`,
      [context.bindingId],
    );
    await fixture.owner.query(
      `UPDATE core."omniConversation" SET status='closed' WHERE id=$1`,
      [context.conversationId],
    );
    expect(await cancel()).toMatchObject({ cancelled: true, applied: true });
  });
  it('lets the next command pass FIFO without a remote evidence verifier', async () => {
    const next = (await context.admit()).commandId;
    expect(await claim(next)).toEqual({
      claimed: false,
      reason: 'waiting_predecessor',
    });
    await cancel();
    expect(await claim(next)).toMatchObject({ claimed: true });
  });
  it('skips more than one hundred proven local cancellations', async () => {
    await cancel();
    for (let i = 0; i < 101; i++) {
      const id = (await context.admit()).commandId;
      await cancel(id);
    }
    const next = (await context.admit()).commandId;
    expect(await claim(next)).toMatchObject({ claimed: true });
  });
  it('rolls back cancellation if its audit insert fails', async () => {
    const before = await commands();
    await fixture.owner.query(
      `CREATE FUNCTION core.log048_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture cancel audit failure'; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log048_fault BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log048_fault()',
    );
    try {
      await expect(cancel()).rejects.toThrow();
      expect(await commands()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log048_fault ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION core.log048_fault()');
    }
  });
  it('preserves committed cancellation after an actual lost COMMIT ACK and safely replays', async () => {
    const prior = await audits();
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      statements.push(text);
      const result = await query(sql, values);
      if (text === 'COMMIT') throw new Error('fixture lost commit ack');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(cancel()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await commands())[0].state).toBe('cancelled');
    jest.restoreAllMocks();
    expect(await cancel()).toMatchObject({ cancelled: true, applied: false });
    expect((await audits()).length - prior.length).toBe(1);
  });
  it.each(['policy', 'command'])(
    'rolls back audit-trigger tamper of %s',
    async (target) => {
      const before = await commands();
      const update =
        target === 'policy'
          ? `UPDATE core."omniWorkspacePolicyState" SET "restoreIncarnation"='${randomUUID()}'::uuid`
          : `UPDATE core."omniOutgoingCommand" SET "payloadHash"=repeat('b',64) WHERE id='${commandId}'::uuid`;
      await fixture.owner.query(
        `CREATE FUNCTION core.log048_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.outcome='success' THEN ${update}; END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER log048_tamper AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log048_tamper()',
      );
      try {
        await expect(cancel()).rejects.toThrow();
        expect(await commands()).toEqual(before);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER log048_tamper ON crm_audit."crmAuditEntry"',
        );
        await fixture.owner.query('DROP FUNCTION core.log048_tamper()');
      }
    },
  );
  it('keeps JS and SQL retained proof checks aligned for malformed and normalized evidence', async () => {
    await cancel();
    const [row] = await commands();
    const original = row.cancelEvidence;
    const contextProof = {
      ...row,
      commandId: row.id,
      bindingId: context.bindingId,
      providerChatId: row.payload.providerChatId,
    };
    const variants: unknown[] = [
      ...[
        'workspaceId',
        'bindingId',
        'conversationId',
        'commandId',
        'authorMemberId',
      ].map((key) => ({ ...original, [key]: randomUUID() })),
      { ...original, payloadHash: 'a'.repeat(64) },
      { ...original, providerChatId: original.providerChatId + '\n' },
      { ...original, cancelledByUserId: original.cancelledByUserId + '\n' },
      { ...original, providerChatId: '😀'.repeat(513) },
      original,
      null,
      [],
      true,
      {},
      { ...original, extra: true },
      { ...original, schemaVersion: '1' },
      { ...original, cancelledByMemberId: 'bad' },
      {
        ...original,
        cancelledByMemberId: original.cancelledByMemberId.toUpperCase(),
      },
      { ...original, authorMemberId: randomUUID() },
      { ...original, createdRestoreIncarnation: randomUUID() },
      { ...original, generation: '01' },
      { ...original, cancelledAt: original.cancelledAt.replace('Z', '+00:00') },
      {
        ...original,
        cancelledByUserId: '00000000-0000-0000-0000-000000000000',
      },
      {
        ...original,
        cancelledByUserId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      },
    ];
    for (const evidence of variants) {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "cancelEvidence"=$1::jsonb WHERE id=$2',
        [JSON.stringify(evidence), commandId],
      );
      const [result] = await fixture.owner.query(
        `SELECT ${omniLocalCommandCancellationSqlPredicate()} AS valid FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command."conversationId"=$2 AND command.id=$3`,
        [
          fixture.workspaceId,
          context.conversationId,
          commandId,
          context.bindingId,
          row.payload.providerChatId,
        ],
      );
      expect(result.valid).toBe(
        isOmniLocalCommandCancellationProof(evidence, contextProof),
      );
    }
  });
});
