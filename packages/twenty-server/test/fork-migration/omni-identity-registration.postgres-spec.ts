import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';
import {
  registerOmniExternalIdentity,
  type OmniIdentityRegistrationAuthorizer,
} from 'src/modules/omnichannel/services/register-omni-external-identity';
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
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: { kind: 'system' as const, id: 'qualified-test-registrar' },
});
const command = () => ({
  bindingId: context.bindingId,
  routeGeneration: '1',
  providerPeerId: 'new-qualified-peer',
  verificationSource: 'fixture-confirmed',
  expectedRevision: '0' as const,
  idempotencyKey: 'register-new-peer',
});
const authorize: OmniIdentityRegistrationAuthorizer = async (
  _runner,
  facts,
) => {
  if (
    facts.workspaceId !== fixture.workspaceId ||
    facts.command.bindingId !== context.bindingId ||
    facts.command.verificationSource !== 'fixture-confirmed' ||
    facts.actor.id !== 'qualified-test-registrar'
  )
    throw new Error('TEST_DENIED');
};
const apply = (input = command(), auth = authorize) =>
  registerOmniExternalIdentity(fixture.runtime, principal(), input, auth);
const rows = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const snapshot = async () => ({
  identities: await rows('omniExternalIdentity'),
  receipts: await rows('omniPolicyMutationReceipt'),
  state: await rows('omniWorkspacePolicyState'),
  people: await fixture.read('person'),
  messages: await fixture.read('message'),
  events: await rows('omniDomainEvent'),
});
const interceptOnce = (visit: (runner: QueryRunner) => void) => {
  const create = fixture.runtime.createQueryRunner.bind(fixture.runtime);
  jest
    .spyOn(fixture.runtime, 'createQueryRunner')
    .mockImplementationOnce(() => {
      const runner = create();
      visit(runner);
      return runner;
    });
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT UPDATE (id) ON core.workspace TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    `GRANT INSERT, UPDATE ON core."omniExternalIdentity",core."omniPolicyMutationReceipt",core."omniWorkspacePolicyState" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('qualified unbound identity registration', () => {
  it('creates one unbound identity, receipt and redacted audit with atomic epoch', async () => {
    const before = await snapshot();
    const result = await apply();
    expect(result).toMatchObject({
      personId: null,
      revision: '1',
      replayed: false,
    });
    expect(await rows('omniExternalIdentity')).toHaveLength(2);
    expect(
      (await rows('omniExternalIdentity')).find(
        (x) => x.id === result.externalIdentityId,
      ),
    ).toMatchObject({
      bindingId: context.bindingId,
      providerPeerId: 'new-qualified-peer',
      verificationSource: 'fixture-confirmed',
      personId: null,
      revision: '1',
    });
    expect(await fixture.read('person')).toEqual(before.people);
    expect((await rows('omniWorkspacePolicyState'))[0].epoch).toBe(
      (BigInt(String(before.state[0].epoch)) + 1n).toString(),
    );
    expect(await rows('omniPolicyMutationReceipt')).toHaveLength(1);
    const entries = await audit();
    expect(entries).toHaveLength(2);
    expect(
      entries.every(
        (x) => x.operationId === result.operationId && x.outcome === 'success',
      ),
    ).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('new-qualified-peer');
    expect(JSON.stringify(entries)).not.toContain('fixture-confirmed');
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });
  it('replays the same result with current authorization and no repeated writes', async () => {
    const first = await apply();
    const before = await snapshot();
    const entries = await audit();
    const auth = jest.fn(authorize);
    expect(await apply(command(), auth)).toEqual({ ...first, replayed: true });
    expect(auth.mock.calls[0][1]).toMatchObject({
      replay: true,
      currentIdentity: { id: first.externalIdentityId },
    });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual(entries);
  });
  it('serializes twenty concurrent retries to one identity and one success operation', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => apply()),
    );
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    expect(new Set(results.map((x) => x.externalIdentityId)).size).toBe(1);
    expect(new Set(results.map((x) => x.operationId)).size).toBe(1);
    expect(await rows('omniPolicyMutationReceipt')).toHaveLength(1);
    expect(await audit()).toHaveLength(2);
  });
  it('does not overwrite an existing bound identity or reuse it under a new create key', async () => {
    const before = await snapshot();
    await expect(
      apply({ ...command(), providerPeerId: 'history-author' }),
    ).rejects.toThrow('ALREADY_REGISTERED');
    expect(await snapshot()).toEqual(before);
  });
  it('conflicts on different payload under the same actor key', async () => {
    await apply();
    const before = await snapshot();
    await expect(
      apply({ ...command(), providerPeerId: 'another-peer' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
  it('does not recreate an expired result', async () => {
    await apply();
    await fixture.owner.query(
      'UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=NULL',
    );
    const before = await snapshot();
    await expect(apply()).rejects.toThrow('RESULT_EXPIRED');
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])(
    'denies unauthorized initial/replay request: replay=%s',
    async (replay) => {
      if (replay) await apply();
      const before = await snapshot();
      await expect(
        apply(command(), async () => {
          throw new Error('CURRENT_ACCESS_REVOKED');
        }),
      ).rejects.toThrow('CURRENT_ACCESS_REVOKED');
      expect(await snapshot()).toEqual(before);
      expect(
        (await audit()).filter((x) => x.outcome === 'denied'),
      ).toHaveLength(1);
    },
  );
  it('rejects stale route registration without creating identity', async () => {
    const before = await snapshot();
    await expect(apply({ ...command(), routeGeneration: '2' })).rejects.toThrow(
      'STALE_ROUTE_GENERATION',
    );
    expect(await snapshot()).toEqual(before);
  });
  it('returns prior registration on authorized replay after route generation changes', async () => {
    const first = await apply();
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2',
    );
    const before = await snapshot();
    expect(await apply()).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('rejects another workspace and a workspace pending deletion', async () => {
    const before = await snapshot();
    await expect(
      registerOmniExternalIdentity(
        fixture.runtime,
        { ...principal(), workspaceId: randomUUID() },
        command(),
        authorize,
      ),
    ).rejects.toThrow('WORKSPACE_NOT_ACCEPTING');
    expect(await snapshot()).toEqual(before);
    await fixture.owner.query('UPDATE core.workspace SET "deletedAt"=now()');
    await expect(apply()).rejects.toThrow('WORKSPACE_NOT_ACCEPTING');
    expect(await rows('omniPolicyMutationReceipt')).toHaveLength(0);
  });
  it.each(['identity', 'audit', 'receipt'])(
    'rolls back every successful write when %s fails',
    async (stage) => {
      const before = await snapshot();
      interceptOnce((runner) => {
        const query = runner.query.bind(runner);
        runner.query = async (...args: Parameters<QueryRunner['query']>) => {
          const result = await query(...args);
          const marker =
            stage === 'identity'
              ? 'INSERT INTO core."omniExternalIdentity"'
              : stage === 'audit'
                ? 'INSERT INTO crm_audit."crmAuditEntry"'
                : 'INSERT INTO core."omniPolicyMutationReceipt"';
          if (args[0].includes(marker)) throw new Error('INJECTED_FAILURE');
          return result;
        };
      });
      await expect(apply()).rejects.toThrow('INJECTED_FAILURE');
      expect(await snapshot()).toEqual(before);
      expect(
        (await audit()).filter((x) => x.outcome === 'success'),
      ).toHaveLength(0);
      expect(
        (await audit()).filter((x) => x.outcome === 'failed'),
      ).toHaveLength(1);
    },
  );
  it('replays safely after actual COMMIT succeeds but its acknowledgement is lost', async () => {
    interceptOnce((runner) => {
      const commit = runner.commitTransaction.bind(runner);
      jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
        await commit();
        throw new Error('LOST_ACK');
      });
    });
    await expect(apply()).rejects.toThrow('OUTCOME_UNKNOWN');
    const before = await snapshot();
    expect((await apply()).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await audit()).filter((x) => x.outcome !== 'success')).toHaveLength(
      0,
    );
  });
  it('does not record failure when rollback is unconfirmed, and discards its connection', async () => {
    let runnerSeen: QueryRunner | undefined;
    interceptOnce((runner) => {
      runnerSeen = runner;
      jest
        .spyOn(runner, 'rollbackTransaction')
        .mockRejectedValue(new Error('ROLLBACK_NOT_CONFIRMED'));
    });
    const before = await snapshot();
    await expect(
      apply(command(), async () => {
        throw new Error('DENIED');
      }),
    ).rejects.toThrow('ROLLBACK_UNCONFIRMED');
    expect(runnerSeen?.isReleased).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });
  it('rejects a corrupted retained result rather than returning another identity', async () => {
    await apply();
    await fixture.owner.query(
      `UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=jsonb_set("resultPublic",'{externalIdentityId}',to_jsonb($1::text))`,
      [context.externalIdentityId],
    );
    await expect(apply()).rejects.toThrow('RECEIPT_IDENTITY_MISMATCH');
  });
  it('captures caller values before asynchronous authorization', async () => {
    const input = command();
    const actor = principal();
    const result = await registerOmniExternalIdentity(
      fixture.runtime,
      actor,
      input,
      async (runner, facts) => {
        input.providerPeerId = 'injected-peer';
        input.bindingId = randomUUID();
        actor.actor.id = 'injected-actor';
        await authorize(runner, facts);
        expect(Object.isFrozen(facts.command)).toBe(true);
        expect(Object.isFrozen(facts.actor)).toBe(true);
      },
    );
    expect(
      (await rows('omniExternalIdentity')).find(
        (x) => x.id === result.externalIdentityId,
      )?.providerPeerId,
    ).toBe('new-qualified-peer');
  });
  it('rejects untrusted extra properties, missing authorizer and malformed generation', async () => {
    const before = await snapshot();
    await expect(
      apply({ ...command(), personId: context.personId } as ReturnType<
        typeof command
      >),
    ).rejects.toThrow();
    await expect(
      apply({ ...command(), routeGeneration: '1\n' }),
    ).rejects.toThrow();
    await expect(
      registerOmniExternalIdentity(
        fixture.runtime,
        principal(),
        command(),
        undefined as unknown as OmniIdentityRegistrationAuthorizer,
      ),
    ).rejects.toThrow('AUTHORIZER_REQUIRED');
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });
  it('feeds the registered unbound identity into actual native incoming persistence', async () => {
    const result = await apply();
    const next = { ...context, externalIdentityId: result.externalIdentityId };
    const captured = await fixture.capture(next, {
      payload: {
        text: 'new identity first message',
        sourceAuthorId: 'new-qualified-peer',
        sourceDisplayName: 'New author',
      },
    });
    const native = await fixture.service.applyOmniHistoryReceipt(
      next.principal,
      captured.proof,
      async (_scope, facts) => {
        expect(facts.externalIdentityId).toBe(result.externalIdentityId);
        expect(facts.personId).toBeNull();
        expect(facts.providerPeerId).toBe('new-qualified-peer');
      },
    );
    expect(native.created).toBe(true);
    expect((await fixture.read('messageParticipant'))[0].personId).toBeNull();
    expect(await fixture.read('person')).toHaveLength(1);
  });
  it('keeps actor-scoped keys independent while natural peer identity remains unique', async () => {
    await apply();
    const other = {
      ...principal(),
      actor: { kind: 'system' as const, id: 'other-registrar' },
    };
    await registerOmniExternalIdentity(
      fixture.runtime,
      other,
      { ...command(), providerPeerId: 'other-peer' },
      async () => {},
    );
    expect(await rows('omniPolicyMutationReceipt')).toHaveLength(2);
    await expect(
      registerOmniExternalIdentity(
        fixture.runtime,
        other,
        { ...command(), idempotencyKey: 'third-key' },
        async () => {},
      ),
    ).rejects.toThrow('ALREADY_REGISTERED');
    expect(await rows('omniExternalIdentity')).toHaveLength(3);
  });
  it('rejects cross-action reuse of an actor key without overwriting its receipt', async () => {
    await apply();
    await fixture.owner.query(
      `UPDATE core."omniPolicyMutationReceipt" SET action='binding.create'`,
    );
    const before = await snapshot();
    await expect(apply()).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
  it('keeps route-generation precision beyond Number.MAX_SAFE_INTEGER', async () => {
    await fixture.owner.query(
      `UPDATE core."omniAccountBinding" SET "routeGeneration"=9007199254740993`,
    );
    await expect(
      apply({ ...command(), routeGeneration: '9007199254740992' }),
    ).rejects.toThrow('STALE_ROUTE_GENERATION');
    expect(
      (await apply({ ...command(), routeGeneration: '9007199254740993' }))
        .replayed,
    ).toBe(false);
  });
  it('rolls back late identity corruption after the receipt insert', async () => {
    const before = await snapshot();
    interceptOnce((runner) => {
      const query = runner.query.bind(runner);
      runner.query = async (...args: Parameters<QueryRunner['query']>) => {
        const result = await query(...args);
        if (args[0].includes('INSERT INTO core."omniPolicyMutationReceipt"'))
          await query(
            `UPDATE core."omniExternalIdentity" SET "personId"=$1 WHERE "providerPeerId"=$2`,
            [context.personId, 'new-qualified-peer'],
          );
        return result;
      };
    });
    await expect(apply()).rejects.toThrow('FINAL_INTEGRITY');
    expect(await snapshot()).toEqual(before);
    expect((await audit()).filter((x) => x.outcome === 'success')).toHaveLength(
      0,
    );
  });
  it.each(['operation', 'identity-audit', 'policy-audit'])(
    'rejects broken retained registration evidence: %s',
    async (corruption) => {
      await apply();
      if (corruption === 'operation')
        await fixture.owner.query(
          'UPDATE core."omniPolicyMutationReceipt" SET "operationId"=$1',
          [randomUUID()],
        );
      else
        await fixture.owner.query(
          'DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceKind"=$1',
          [
            corruption === 'identity-audit'
              ? 'omniExternalIdentity'
              : 'omniWorkspacePolicyState',
          ],
        );
      await expect(apply()).rejects.toThrow('RETAINED_AUDIT_INTEGRITY');
    },
  );
});
