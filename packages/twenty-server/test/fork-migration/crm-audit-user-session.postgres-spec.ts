import { randomUUID } from 'node:crypto';
import { type Request } from 'express';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { UserSessionEntity } from 'src/engine/core-modules/user-session/user-session.entity';
import { type CreateUserSessionInput } from 'src/engine/core-modules/user-session/types/create-user-session-input.type';
import { hashUserSessionToken } from 'src/engine/core-modules/user-session/utils/hash-user-session-token.util';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

// Only unrelated dependency graphs are replaced. The session entity, service,
// repository, transaction owner and audit writer execute against PostgreSQL.
jest.mock('src/engine/core-modules/user/user.entity', () => {
  const { Entity, PrimaryColumn } = require('typeorm');
  class UserEntity {}
  Entity({ schema: 'core', name: 'user' })(UserEntity);
  PrimaryColumn({ type: 'uuid' })(UserEntity.prototype, 'id');
  return { UserEntity };
});
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => {
  const { Entity, PrimaryColumn } = require('typeorm');
  class WorkspaceEntity {}
  Entity({ schema: 'core', name: 'workspace' })(WorkspaceEntity);
  PrimaryColumn({ type: 'uuid' })(WorkspaceEntity.prototype, 'id');
  return { WorkspaceEntity };
});
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => {
    const { Entity, PrimaryColumn, Column } = require('typeorm');
    class UserWorkspaceEntity {}
    Entity({ schema: 'core', name: 'userWorkspace' })(UserWorkspaceEntity);
    PrimaryColumn({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'id');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'userId');
    Column({ type: 'uuid' })(UserWorkspaceEntity.prototype, 'workspaceId');
    Column({ type: 'timestamptz', nullable: true })(
      UserWorkspaceEntity.prototype,
      'deletedAt',
    );
    return { UserWorkspaceEntity };
  },
);
jest.mock('src/engine/core-modules/app-token/app-token.entity', () => ({
  AppTokenEntity: class AppTokenEntity {},
  AppTokenType: { RefreshToken: 'RefreshToken' },
}));
jest.mock(
  'src/engine/core-modules/event-logs/emit/event-log-emitter.service',
  () => ({ EventLogEmitterService: class EventLogEmitterService {} }),
);
jest.mock('src/engine/core-modules/jwt/services/jwt-wrapper.service', () => ({
  JwtWrapperService: class JwtWrapperService {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class TwentyConfigService {} }),
);
jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({ CacheStorageService: class CacheStorageService {} }),
);
jest.mock(
  'src/engine/core-modules/user-session/services/user-session-cookie.service',
  () => ({ UserSessionCookieService: class UserSessionCookieService {} }),
);

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
const role = `session_audit_${randomUUID().replaceAll('-', '')}`;
const entities = [
  UserSessionEntity,
  UserEntity,
  WorkspaceEntity,
  UserWorkspaceEntity,
];
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  synchronize: false,
  extra: { max: 3, statement_timeout: 10000 },
});
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = 'isolated-session-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities,
  synchronize: false,
  extra: { max: 3, statement_timeout: 10000 },
});
const workspaceId = randomUUID(),
  otherWorkspaceId = randomUUID(),
  userId = randomUUID(),
  initiatingUserId = randomUUID(),
  userWorkspaceId = randomUUID(),
  initiatorMembershipId = randomUUID();
const input = (
  override: Partial<CreateUserSessionInput> = {},
): CreateUserSessionInput => ({
  userId,
  workspaceId,
  userWorkspaceId,
  authProvider: AuthProviderEnum.Password,
  origin: 'sign_in',
  userAgent: 'private-device',
  ipAddress: '192.0.2.55',
  ...override,
});
const makeService = () => {
  const event = jest.fn(),
    attach = jest.fn();
  const decode = jest
    .fn()
    .mockReturnValue({ ...input(), type: 'ACCESS', sub: userId });
  const service = new UserSessionService(
    runtime.getRepository(UserSessionEntity),
    {} as never,
    { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
    { get: jest.fn().mockReturnValue('7d') } as never,
    { decode } as never,
    {
      createContext: jest.fn().mockReturnValue({ insertWorkspaceEvent: event }),
    } as never,
    {
      extractSessionTokenFromRequest: jest.fn(),
      attachSessionTokenToResponse: attach,
    } as never,
  );
  return { service, event, attach, decode };
};
const issue = (service: UserSessionService) =>
  service.issueSessionForTokenPair({
    tokenPair: {
      accessOrWorkspaceAgnosticToken: {
        token: 'fixture-access',
        expiresAt: new Date(),
      },
      refreshToken: { token: 'fixture-refresh', expiresAt: new Date() },
    },
    request: { headers: {}, res: {}, ip: '192.0.2.55' } as Request,
    origin: 'sign_in',
  });
const audits = () => owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
const sessions = () => owner.getRepository(UserSessionEntity).find();
const auditFault = () =>
  owner.query(`CREATE FUNCTION crm_audit.reject_session_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SESSION_AUDIT_FAILURE'; END $$;
  CREATE TRIGGER fail_session_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.reject_session_audit()`);
const causes = (error: unknown): string => {
  const seen = new Set<unknown>();
  let result = '';
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    result += error.message;
    error = error.cause;
  }
  return result;
};

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-session-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core, crm_audit TO "${role}";
    GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}";
    GRANT INSERT, UPDATE ON core."userSession" TO "${role}";
    GRANT UPDATE ON core."userWorkspace" TO "${role}";
    GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}"`);
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  await owner.query(`DROP TRIGGER IF EXISTS fail_session_audit ON crm_audit."crmAuditEntry";
    DROP FUNCTION IF EXISTS crm_audit.reject_session_audit();
    DROP TRIGGER IF EXISTS change_session_scope ON core."userSession";
    DROP FUNCTION IF EXISTS core.change_session_scope();
    TRUNCATE core."userSession", core."userWorkspace", core."user", core.workspace, crm_audit."crmAuditEntry" CASCADE`);
  await owner.query('INSERT INTO core.workspace VALUES ($1),($2)', [
    workspaceId,
    otherWorkspaceId,
  ]);
  await owner.query('INSERT INTO core."user" VALUES ($1),($2)', [
    userId,
    initiatingUserId,
  ]);
  await owner.query(
    'INSERT INTO core."userWorkspace" (id,"userId","workspaceId") VALUES ($1,$2,$3),($4,$5,$6)',
    [
      userWorkspaceId,
      userId,
      workspaceId,
      initiatorMembershipId,
      initiatingUserId,
      otherWorkspaceId,
    ],
  );
});
afterAll(async () => {
  jest.restoreAllMocks();
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(
      'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE',
    );
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.destroy();
  }
});

describe('actual workspace user-session creation audit', () => {
  it.each(['sign_in', 'renewal_bridge'] as const)(
    'records %s after the real session insert without secrets',
    async (origin) => {
      const { service, event } = makeService();
      const result = await service.createSession(input({ origin }));
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        resourceKind: 'userSession',
        resourceId: result.session.id,
        actor: { kind: 'coreUser', id: userId },
        initiator: null,
        action: 'create',
        outcome: 'success',
        securityDescriptor: {
          sessionOwner: {
            userId,
            userWorkspaceId,
            access: 'currentWorkspaceAdministration',
          },
        },
      });
      expect(rows[0].redactedDiff.values).toEqual({
        authProvider: { before: null, after: 'password' },
        isImpersonating: { before: null, after: false },
        origin: { before: null, after: origin },
      });
      expect((await sessions())[0].tokenHash).toBe(
        hashUserSessionToken(result.sessionToken),
      );
      for (const secret of [
        result.sessionToken,
        result.session.tokenHash,
        'private-device',
        '192.0.2.55',
        'tokenHash',
        'userAgent',
        'ipAddress',
      ])
        expect(JSON.stringify(rows)).not.toContain(secret);
      expect(event).toHaveBeenCalledTimes(origin === 'sign_in' ? 1 : 0);
    },
  );
  it('issues the cookie only after successful commit', async () => {
    const { service, attach } = makeService();
    await issue(service);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(await sessions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
  it('rolls session creation back on audit failure and issues no cookie/event', async () => {
    await auditFault();
    const { service, attach, event } = makeService();
    try {
      await issue(service);
      throw new Error('expected failure');
    } catch (error) {
      expect(causes(error)).toContain('SESSION_AUDIT_FAILURE');
    }
    expect(await sessions()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(attach).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });
  it('preserves a workspace-agnostic session without inventing audit tenancy', async () => {
    await auditFault();
    const { service } = makeService();
    const { session } = await service.createSession(
      input({ workspaceId: null, userWorkspaceId: null }),
    );
    expect(session.workspaceId).toBeNull();
    expect(await sessions()).toHaveLength(1);
    expect(await audits()).toHaveLength(0);
  });
  it.each([false, true])(
    'resolves actual impersonation initiator across workspace=%s',
    async (sameWorkspace) => {
      if (sameWorkspace)
        await owner.query(
          'UPDATE core."userWorkspace" SET "workspaceId"=$1 WHERE id=$2',
          [workspaceId, initiatorMembershipId],
        );
      const { service } = makeService();
      await service.createSession(
        input({
          authProvider: AuthProviderEnum.Impersonation,
          isImpersonating: true,
          impersonatorUserWorkspaceId: initiatorMembershipId,
          impersonatedUserWorkspaceId: userWorkspaceId,
        }),
      );
      expect((await audits())[0]).toMatchObject({
        workspaceId,
        actor: { kind: 'coreUser', id: userId },
        initiator: { kind: 'coreUser', id: initiatingUserId },
      });
    },
  );
  it.each([
    'user',
    'workspace',
    'missing',
    'deleted',
    'impersonated',
    'initiator',
  ] as const)(
    'rejects mismatched %s membership before session publication',
    async (kind) => {
      const value = input();
      if (kind === 'user') value.userId = initiatingUserId;
      if (kind === 'workspace') value.workspaceId = otherWorkspaceId;
      if (kind === 'missing') value.userWorkspaceId = randomUUID();
      if (kind === 'deleted')
        await owner.query(
          'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
          [userWorkspaceId],
        );
      if (kind === 'impersonated' || kind === 'initiator')
        Object.assign(value, {
          isImpersonating: true,
          impersonatedUserWorkspaceId:
            kind === 'impersonated' ? randomUUID() : userWorkspaceId,
          impersonatorUserWorkspaceId:
            kind === 'initiator' ? randomUUID() : initiatorMembershipId,
        });
      await expect(
        makeService().service.createSession(value),
      ).rejects.toThrow();
      expect(await sessions()).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    },
  );
  it('captures caller values before await and accepts UUID case normalization', async () => {
    const value = input({
      userId: userId.toUpperCase(),
      workspaceId: workspaceId.toUpperCase(),
      userWorkspaceId: userWorkspaceId.toUpperCase(),
    });
    const pending = makeService().service.createSession(value);
    value.userId = initiatingUserId;
    value.workspaceId = otherWorkspaceId;
    value.origin = 'renewal_bridge';
    const { session } = await pending;
    expect(session.userId).toBe(userId);
    expect((await audits())[0].redactedDiff.values.origin.after).toBe(
      'sign_in',
    );
  });
  it('rejects trigger-altered credential scope and rolls it back', async () => {
    await owner.query(`CREATE FUNCTION core.change_session_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."tokenHash"='substituted';RETURN NEW; END $$;
      CREATE TRIGGER change_session_scope BEFORE INSERT ON core."userSession" FOR EACH ROW EXECUTE FUNCTION core.change_session_scope()`);
    await expect(makeService().service.createSession(input())).rejects.toThrow(
      'persisted credential',
    );
    expect(await sessions()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });
  it.each(['tokenHash', 'revokedAt', 'expiresAt', 'createdAt'])(
    'rejects audit-trigger corruption of %s before commit',
    async (field) => {
      const expression =
        field === 'tokenHash' ? "'altered'" : "now() - interval '2 days'";
      await owner.query(`CREATE FUNCTION crm_audit.reject_session_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE core."userSession" SET "${field}"=${expression} WHERE id=NEW."resourceId"::uuid; RETURN NEW; END $$;
      CREATE TRIGGER fail_session_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.reject_session_audit()`);
      const { service, attach, event } = makeService();
      await expect(issue(service)).rejects.toThrow('Session');
      expect(await sessions()).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
      expect(attach).not.toHaveBeenCalled();
      expect(event).not.toHaveBeenCalled();
    },
  );
  it('rejects an unowned enclosing transaction', async () => {
    const { service } = makeService();
    await runtime.transaction(async (manager) => {
      Object.defineProperty(service, 'userSessionRepository', {
        value: manager.getRepository(UserSessionEntity),
      });
      await expect(service.createSession(input())).rejects.toThrow('ownership');
    });
    expect(await sessions()).toHaveLength(0);
  });
  it('reports actual lost COMMIT acknowledgement without retry or cookie', async () => {
    const original = runtime.createQueryRunner.bind(runtime);
    let inserts = 0;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = original(mode);
      const connect = runner.connect.bind(runner);
      let patched = false;
      jest.spyOn(runner, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!patched) {
          patched = true;
          const query = client.query.bind(client);
          client.query = async (sql: string, ...args: unknown[]) => {
            if (sql.startsWith('INSERT INTO "core"."userSession"')) inserts++;
            const result = await query(sql, ...args);
            if (sql === 'COMMIT') throw new Error('lost actual COMMIT ACK');
            return result;
          };
        }
        return client;
      });
      return runner;
    });
    const { service, attach, event } = makeService();
    await expect(issue(service)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(await sessions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
    expect(inserts).toBe(1);
    expect(attach).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });
});

describe('strict TypeORM core transaction owner', () => {
  it('retains work, rollback and release causes in a combined failure', async () => {
    const create = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = create(mode) as ReturnType<typeof create> & {
        releasePostgresConnection: (error?: Error) => Promise<void>;
      };
      jest
        .spyOn(runner, 'rollbackTransaction')
        .mockRejectedValue(new Error('rollback-fault'));
      const release = runner.releasePostgresConnection.bind(runner);
      jest
        .spyOn(runner, 'releasePostgresConnection')
        .mockImplementation(async (error) => {
          await release(error);
          throw new Error('release-fault');
        });
      return runner;
    });
    const flatten = (error: unknown): string =>
      error instanceof AggregateError
        ? error.errors.map(flatten).join(' ')
        : error instanceof Error
          ? error.message + ' ' + flatten(error.cause)
          : '';
    try {
      await runInCoreAuditTransaction(runtime, async () => {
        throw new Error('work-fault');
      });
      throw new Error('expected rejection');
    } catch (error) {
      const messages = flatten(error);
      for (const expected of ['work-fault', 'rollback-fault', 'release-fault'])
        expect(messages).toContain(expected);
    }
  });
  it('marks a failed after-commit hook as committed, never rolled back', async () => {
    const subscriber = {
      afterTransactionCommit() {
        throw new Error('hook-fault');
      },
    };
    runtime.subscribers.push(subscriber);
    try {
      await expect(
        runInCoreAuditTransaction(runtime, async (runner) => {
          await runner.query('SELECT 1');
        }),
      ).rejects.toMatchObject({
        commitConfirmed: true,
        cause: { message: 'hook-fault' },
      });
    } finally {
      runtime.subscribers.splice(runtime.subscribers.indexOf(subscriber), 1);
    }
  });

  it.each(['rollback', 'release'] as const)(
    'classifies %s cleanup failure without returning success',
    async (phase) => {
      const create = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
        const runner = create(mode) as ReturnType<typeof create> & {
          releasePostgresConnection: (error?: Error) => Promise<void>;
        };
        if (phase === 'rollback')
          jest
            .spyOn(runner, 'rollbackTransaction')
            .mockRejectedValue(new Error('rollback transport lost'));
        else {
          const release = runner.releasePostgresConnection.bind(runner);
          jest
            .spyOn(runner, 'releasePostgresConnection')
            .mockImplementation(async (error) => {
              await release(error);
              throw new Error('release acknowledgement lost');
            });
        }
        return runner;
      });
      await expect(
        runInCoreAuditTransaction(runtime, async (runner) => {
          await runner.query('SELECT 1');
          if (phase === 'rollback') throw new Error('original failure');
          return 'result';
        }),
      ).rejects.toMatchObject({ phase });
      jest.restoreAllMocks();
      expect(await runtime.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
    },
  );
  it('preserves TypeORM transaction subscriber hooks', async () => {
    const events: string[] = [];
    const subscriber = {
      beforeTransactionStart() {
        events.push('before-start');
      },
      afterTransactionStart() {
        events.push('after-start');
      },
      beforeTransactionCommit() {
        events.push('before-commit');
      },
      afterTransactionCommit() {
        events.push('after-commit');
      },
    };
    runtime.subscribers.push(subscriber);
    try {
      await runInCoreAuditTransaction(runtime, async (runner) => {
        await runner.query('SELECT 1');
        events.push('work');
      });
      expect(events).toEqual([
        'before-start',
        'after-start',
        'work',
        'before-commit',
        'after-commit',
      ]);
    } finally {
      runtime.subscribers.splice(runtime.subscribers.indexOf(subscriber), 1);
    }
  });

  it('does not call a swallowed aborted transaction a committed success', async () => {
    await expect(
      runInCoreAuditTransaction(runtime, async (runner) => {
        try {
          await runner.query('SELECT 1/0');
        } catch {
          /* PostgreSQL remains aborted. */
        }
        return 'not committed';
      }),
    ).rejects.toMatchObject({ phase: 'commit' });
    expect(await runtime.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });
  it('keeps TypeORM transaction lifecycle active for real repository work', async () => {
    await runInCoreAuditTransaction(runtime, async (runner) => {
      expect(runner.isTransactionActive).toBe(true);
      expect(runner.manager.getRepository(UserSessionEntity).queryRunner).toBe(
        runner,
      );
      expect(
        await runner.query('SELECT txid_current()::text AS id'),
      ).toHaveLength(1);
    });
  });
});
