import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  CrmAuditTransactionContext,
  appendCrmAuditAttempt,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  type CrmAuditMutation,
  type CrmAuditOperation,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtimeRole = `audit_test_${randomUUID().replaceAll('-', '')}`;
const writableRole = `audit_writer_${randomUUID().replaceAll('-', '')}`;
const runtimeUrl = new URL(databaseUrl);

runtimeUrl.username = runtimeRole;
runtimeUrl.password = 'isolated-audit-fixture';

const runtimeSource = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const operation: CrmAuditOperation = {
  workspaceId: randomUUID(),
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'isolated-fixture' },
};
const resourceId = randomUUID();

const mutation = (before = '1', after = '3'): CrmAuditMutation => ({
  resourceKind: 'omniAccountBinding',
  resourceId,
  action: 'update',
  before: {
    revision: before,
    capabilities: { secret: 'original-token' },
    unknown: 'never-retained',
  },
  after: {
    revision: after,
    capabilities: { secret: 'new-token' },
    unknown: 'also-not-retained',
  },
  securityDescriptor: {
    resourceKind: 'omniAccountBinding',
    resourceId,
    bindingId: resourceId,
  },
});

const transaction = async <T>(
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> =>
  runtimeSource.transaction(async (manager) => work(manager.queryRunner!));

beforeAll(async () => {
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await dataSource.query(
    `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'isolated-audit-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  await dataSource.query(
    `CREATE ROLE "${writableRole}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  await runtimeSource.initialize();
});

beforeEach(async () => {
  await dataSource.query(`REVOKE "${writableRole}" FROM "${runtimeRole}"`);
  await dataSource.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
  await dataSource.query('CREATE SCHEMA core');
  await dataSource.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await dataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await dataSource.query(
    'CREATE TABLE crm_audit."mutationProbe" (id integer PRIMARY KEY, value integer NOT NULL)',
  );
  await dataSource.query('INSERT INTO crm_audit."mutationProbe" VALUES (1, 1)');
  await dataSource.query(`GRANT USAGE ON SCHEMA crm_audit TO "${runtimeRole}"`);
  await dataSource.query(
    `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
  );
  await dataSource.query(
    `GRANT SELECT, UPDATE ON crm_audit."mutationProbe" TO "${runtimeRole}"`,
  );
});

afterAll(async () => {
  if (dataSource.isInitialized) {
    if (runtimeSource.isInitialized) await runtimeSource.destroy();
    await dataSource.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
    await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
    await dataSource.query(`DROP ROLE "${runtimeRole}"`);
    await dataSource.query(`DROP ROLE "${writableRole}"`);
    await dataSource.destroy();
  }
});

describe('transactional CRM audit', () => {
  it('records application result changes without retaining provider revision evidence', async () => {
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);
      context.record({
        resourceKind: 'omniIncomingReceipt',
        resourceId,
        action: 'update',
        before: { state: 'processing', applicationResult: null },
        after: {
          state: 'applied',
          applicationResult: {
            schemaVersion: 1,
            kind: 'incoming_text_revision',
            disposition: 'stale',
            candidateSourceRevisionKey: 'private-provider-revision',
            candidateContentHash: 'a'.repeat(64),
            selectedRevisionId: randomUUID(),
            observedHeadRevisionId: randomUUID(),
          },
        },
        securityDescriptor: {
          resourceKind: 'omniIncomingReceipt',
          resourceId,
          bindingId: randomUUID(),
        },
      });
      await context.flush();
    });
    const rows = await dataSource.query(
      'SELECT * FROM crm_audit."crmAuditEntry"',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].redactedDiff).toEqual({
      changedFields: ['applicationResult', 'state'],
      values: { state: { before: 'processing', after: 'applied' } },
    });
    expect(JSON.stringify(rows)).not.toContain('private-provider-revision');
    expect(JSON.stringify(rows)).not.toContain('a'.repeat(64));
  });
  it('aggregates first before and final after before commit without sensitive values', async () => {
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);

      await runner.query(
        'UPDATE crm_audit."mutationProbe" SET value=2 WHERE id=1',
      );
      context.record(mutation('1', '2'));
      await runner.query(
        'UPDATE crm_audit."mutationProbe" SET value=3 WHERE id=1',
      );
      context.record(mutation('2', '3'));
      await context.flush();
      await expect(context.flush()).rejects.toThrow('must be open');
    });
    const rows = await dataSource.query(
      'SELECT * FROM crm_audit."crmAuditEntry"',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].redactedDiff).toEqual({
      changedFields: ['capabilities', 'revision'],
      values: { revision: { before: '1', after: '3' } },
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /original-token|new-token|never-retained|also-not-retained/,
    );
    expect(
      await dataSource.query('SELECT value FROM crm_audit."mutationProbe"'),
    ).toEqual([{ value: 3 }]);
  });

  it('rolls business writes back when audit INSERT fails', async () => {
    await dataSource.query(
      `ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT reject_success CHECK(outcome='denied')`,
    );
    await expect(
      transaction(async (runner) => {
        await runner.query(
          'UPDATE crm_audit."mutationProbe" SET value=4 WHERE id=1',
        );
        const context = new CrmAuditTransactionContext(runner, operation);

        context.record(mutation());
        await context.flush();
      }),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    expect(
      await dataSource.query('SELECT value FROM crm_audit."mutationProbe"'),
    ).toEqual([{ value: 1 }]);
    expect(
      await dataSource.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toEqual([]);
  });

  it('deduplicates concurrent and lost-ACK retries without updating the retained row', async () => {
    const append = () =>
      transaction(async (runner) => {
        const context = new CrmAuditTransactionContext(runner, operation);

        context.record(mutation());
        await context.flush();
      });

    await Promise.all([append(), append()]);
    const before = await dataSource.query(
      'SELECT * FROM crm_audit."crmAuditEntry"',
    );

    await append();
    expect(before).toHaveLength(1);
    expect(
      await dataSource.query('SELECT * FROM crm_audit."crmAuditEntry"'),
    ).toEqual(before);
  });

  it('rejects key/hash conflict and keeps distinct operations distinct', async () => {
    const append = (op: CrmAuditOperation, after: string) =>
      transaction(async (runner) => {
        const context = new CrmAuditTransactionContext(runner, op);

        context.record(mutation('1', after));
        await context.flush();
      });

    await append(operation, '3');
    await expect(append(operation, '4')).rejects.toThrow('conflicts');
    await append({ ...operation, operationId: randomUUID() }, '4');
    expect(
      await dataSource.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toHaveLength(2);
  });

  it('separates failed attempts from a later success under the same operation', async () => {
    const source = mutation();
    const attempt = {
      ...source,
      attemptId: randomUUID(),
      outcome: 'denied' as const,
      reasonCode: 'permission_denied',
    };

    await transaction((runner) =>
      appendCrmAuditAttempt(runner, operation, attempt),
    );
    await transaction((runner) =>
      appendCrmAuditAttempt(runner, operation, attempt),
    );
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);

      context.record(source);
      await context.flush();
    });
    expect(
      await dataSource.query(
        'SELECT outcome FROM crm_audit."crmAuditEntry" ORDER BY outcome',
      ),
    ).toEqual([{ outcome: 'denied' }, { outcome: 'success' }]);
  });

  it('refuses audit schema owner and refuses an overprivileged runtime role', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        const context = new CrmAuditTransactionContext(
          manager.queryRunner!,
          operation,
        );

        context.record(mutation());
        await context.flush();
      }),
    ).rejects.toThrow('append-only privileges');
    await dataSource.query(
      `GRANT UPDATE ON crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
    );
    await expect(
      transaction(async (runner) => {
        const context = new CrmAuditTransactionContext(runner, operation);

        context.record(mutation());
        await context.flush();
      }),
    ).rejects.toThrow('append-only privileges');
  });

  it('actually denies destructive SQL and owner role switching for the runtime role', async () => {
    const [{ current_user: owner }] = await dataSource.query(
      'SELECT current_user',
    );

    expect(owner).toMatch(/^[a-zA-Z0-9_]+$/);
    for (const sql of [
      'UPDATE crm_audit."crmAuditEntry" SET action=\'delete\'',
      'DELETE FROM crm_audit."crmAuditEntry"',
      'TRUNCATE crm_audit."crmAuditEntry"',
      'ALTER TABLE crm_audit."crmAuditEntry" ADD COLUMN forbidden text',
      'DROP TABLE crm_audit."crmAuditEntry"',
      'DROP SCHEMA crm_audit CASCADE',
      `SET LOCAL ROLE "${owner}"`,
    ]) {
      await expect(
        transaction((runner) => runner.query(sql)),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
    }
  });

  it('rejects column UPDATE and SET-role privilege escalation even with NOINHERIT', async () => {
    const flush = () =>
      transaction(async (runner) => {
        const context = new CrmAuditTransactionContext(runner, operation);

        context.record(mutation());
        await context.flush();
      });

    await dataSource.query(
      `GRANT UPDATE(action) ON crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
    );
    await expect(flush()).rejects.toThrow('append-only privileges');
    await dataSource.query(
      `REVOKE UPDATE(action) ON crm_audit."crmAuditEntry" FROM "${runtimeRole}"`,
    );
    await dataSource.query(
      `GRANT UPDATE ON crm_audit."crmAuditEntry" TO "${writableRole}"`,
    );
    await dataSource.query(`GRANT "${writableRole}" TO "${runtimeRole}"`);
    await expect(flush()).rejects.toThrow('append-only privileges');
    await dataSource.query(
      `REVOKE UPDATE ON crm_audit."crmAuditEntry" FROM "${writableRole}"`,
    );
    await dataSource.query(`ALTER SCHEMA crm_audit OWNER TO "${writableRole}"`);
    await expect(flush()).rejects.toThrow('append-only privileges');
  });

  it('rejects closed transactions, unsupported resources and non-JSON snapshots', async () => {
    const runner = dataSource.createQueryRunner();

    expect(() => new CrmAuditTransactionContext(runner, operation)).toThrow(
      'must be open',
    );
    await runner.release();
    await transaction(async (active) => {
      const context = new CrmAuditTransactionContext(active, operation);
      const unsupported = {
        ...mutation(),
        resourceKind: 'unknown',
      } as unknown as CrmAuditMutation;

      expect(() =>
        context.record({
          ...unsupported,
          securityDescriptor: {
            ...unsupported.securityDescriptor,
            resourceKind: unsupported.resourceKind,
          },
        }),
      ).toThrow('not in the catalog');
      expect(() =>
        context.record({
          ...mutation(),
          after: { revision: { token: 'hidden' } },
        }),
      ).toThrow('JSON scalar');
      expect(() =>
        context.record({
          ...mutation(),
          after: { capabilities: { value: undefined } },
        }),
      ).toThrow('finite JSON');
    });
  });

  it('uses canonical JSON independent of property insertion order', () => {
    expect(auditPayloadHash({ second: 2, first: { z: null, a: true } })).toBe(
      auditPayloadHash({ first: { a: true, z: null }, second: 2 }),
    );
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      Array(1),
      [1, , 3],
    ]) {
      expect(() => canonicalAuditJson(value)).toThrow('finite JSON');
    }
  });

  it('normalizes UUID case before aggregation, success keys and attempt keys', async () => {
    const upperMutation = (before: string, after: string): CrmAuditMutation => {
      const source = mutation(before, after);

      return {
        ...source,
        resourceId: source.resourceId.toUpperCase(),
        securityDescriptor: {
          ...source.securityDescriptor,
          resourceId: source.resourceId.toUpperCase(),
          bindingId: source.resourceId.toUpperCase(),
        },
      };
    };

    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);

      context.record(upperMutation('1', '2'));
      context.record(mutation('2', '3'));
      await context.flush();
    });
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);

      context.record(mutation('1', '3'));
      await context.flush();
    });
    const attemptId = randomUUID();

    await transaction((runner) =>
      appendCrmAuditAttempt(runner, operation, {
        ...upperMutation('1', '3'),
        attemptId: attemptId.toUpperCase(),
        outcome: 'denied',
        reasonCode: 'permission_denied',
      }),
    );
    await transaction((runner) =>
      appendCrmAuditAttempt(runner, operation, {
        ...mutation('1', '3'),
        attemptId,
        outcome: 'denied',
        reasonCode: 'permission_denied',
      }),
    );
    const rows = await dataSource.query(
      'SELECT "resourceId", "redactedDiff", outcome FROM crm_audit."crmAuditEntry" ORDER BY outcome',
    );

    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row: { resourceId: string }) => row.resourceId === resourceId,
      ),
    ).toBe(true);
    expect(rows[1].redactedDiff.values.revision).toEqual({
      before: '1',
      after: '3',
    });
  });

  it('does not copy unknown actor and security metadata into the audit payload', async () => {
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, {
        ...operation,
        actor: {
          ...operation.actor,
          token: 'private-actor-token',
        } as CrmAuditOperation['actor'],
      });
      const source = mutation();

      context.record({
        ...source,
        securityDescriptor: {
          ...source.securityDescriptor,
          cookie: 'private-scope-cookie',
        } as CrmAuditMutation['securityDescriptor'],
      });
      await context.flush();
    });
    const rows = await dataSource.query(
      'SELECT actor, "securityDescriptor" FROM crm_audit."crmAuditEntry"',
    );

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(
      /private-actor-token|private-scope-cookie/,
    );
  });

  it('retains audit facts after the referenced workspace has been removed', async () => {
    await dataSource.query('INSERT INTO core.workspace VALUES ($1)', [
      operation.workspaceId,
    ]);
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);

      context.record(mutation());
      await context.flush();
    });
    await dataSource.query('DELETE FROM core.workspace WHERE id=$1', [
      operation.workspaceId,
    ]);
    expect(
      await dataSource.query(
        'SELECT "workspaceId" FROM crm_audit."crmAuditEntry"',
      ),
    ).toEqual([{ workspaceId: operation.workspaceId }]);
  });

  it('keeps native message text and subject out of the audit payload', async () => {
    const messageId = randomUUID();
    const threadId = randomUUID();
    await transaction(async (runner) => {
      const context = new CrmAuditTransactionContext(runner, operation);
      context.record({
        resourceKind: 'omniMessage',
        resourceId: messageId,
        action: 'create',
        before: null,
        after: {
          text: 'private customer message',
          subject: 'private subject',
          headerMessageId: 'private provider header',
          messageThreadId: threadId,
          isDraft: false,
        },
        securityDescriptor: {
          resourceKind: 'omniMessage',
          resourceId: messageId,
          bindingId: randomUUID(),
          conversationId: randomUUID(),
        },
      });
      await context.flush();
    });
    const rows = await dataSource.query(
      'SELECT * FROM crm_audit."crmAuditEntry"',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].redactedDiff.values).toEqual({
      messageThreadId: { before: null, after: threadId },
      isDraft: { before: null, after: false },
    });
    expect(rows[0].redactedDiff.changedFields).toContain('text');
    expect(JSON.stringify(rows)).not.toMatch(
      /private customer|private subject|private provider/,
    );
  });

  it.each(['bindingId', 'conversationId'] as const)(
    'rejects native message audit without %s scope',
    async (missing) => {
      await expect(
        transaction(async (runner) => {
          const context = new CrmAuditTransactionContext(runner, operation);
          const securityDescriptor = {
            resourceKind: 'omniMessage' as const,
            resourceId,
            bindingId: randomUUID(),
            conversationId: randomUUID(),
            [missing]: undefined,
          };
          context.record({
            resourceKind: 'omniMessage',
            resourceId,
            action: 'create',
            before: null,
            after: { text: 'must not be saved' },
            securityDescriptor,
          });
          await context.flush();
        }),
      ).rejects.toThrow('binding and conversation scope');
      expect(
        await dataSource.query('SELECT * FROM crm_audit."crmAuditEntry"'),
      ).toEqual([]);
    },
  );
});
