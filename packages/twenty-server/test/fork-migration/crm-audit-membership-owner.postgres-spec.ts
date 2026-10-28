import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteUserWorkspaceTransaction } from 'src/engine/core-modules/user-workspace/delete-user-workspace-transaction';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID(),
  membershipId = randomUUID(),
  otherMembershipId = randomUUID(),
  userId = randomUUID(),
  workflowId = randomUUID(),
  applicationId = randomUUID(),
  applicationUid = randomUUID();
const navigationIds = [randomUUID(), randomUUID(), randomUUID()];
const databaseRole = `membership_audit_${randomUUID().replaceAll('-', '')}`;
const membershipSchema = new EntitySchema({
  name: 'MembershipAuditFixture',
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userId: { type: 'uuid' },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});
const targetSchema = new EntitySchema({
  name: 'TargetAuditFixture',
  schema: 'core',
  tableName: 'roleTarget',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userWorkspaceId: { type: 'uuid' },
    roleId: { type: 'uuid' },
  },
});
const restrictedUrl = new URL(url);
restrictedUrl.username = databaseRole;
restrictedUrl.password = 'isolated-membership-fixture';
const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [membershipSchema, targetSchema],
  extra: { max: 6, statement_timeout: 12000 },
});
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [membershipSchema, targetSchema],
  extra: { max: 6, statement_timeout: 12000 },
});
const childTables = [
  'applicationAuthorization',
  'navigationMenuItem',
  'twoFactorAuthenticationMethod',
  'userApplicationVariableValue',
  'userSession',
];
const operation = (): CrmAuditOperation => ({
  workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'coreUser', id: userId },
});
const audits = () =>
  owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceKind", "resourceId"',
  );
const membership = () =>
  owner.query('SELECT * FROM core."userWorkspace" WHERE id=$1', [membershipId]);
const intents = () => owner.query('SELECT * FROM core.intent');
const remove = (softDelete = false, auditOperation = operation()) =>
  deleteUserWorkspaceTransaction({
    dataSource: runtime,
    entities: { membership: membershipSchema, roleTarget: targetSchema },
    workspaceId,
    userWorkspaceId: membershipId,
    softDelete,
    auditOperation,
    persistReconciliation: async ({
      queryRunner,
      coreWorkflowId,
      applicationUniversalIdentifier,
    }) => {
      await queryRunner.query('INSERT INTO core.intent VALUES($1,$2,$3)', [
        randomUUID(),
        coreWorkflowId,
        applicationUniversalIdentifier,
      ]);
      return async () => {
        const rows = await queryRunner.query(
          'SELECT id FROM core.intent WHERE "workflowId"=$1 AND "applicationUid"=$2',
          [coreWorkflowId, applicationUniversalIdentifier],
        );
        if (rows.length !== 1) throw new Error('Recovery intent changed');
      };
    },
  });

beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY,"deletedAt" timestamptz); CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid,"universalIdentifier" uuid); CREATE TABLE core.intent(id uuid PRIMARY KEY,"workflowId" uuid,"applicationUid" uuid)',
  );
  for (const table of childTables)
    await owner.query(`CREATE TABLE core."${table}"(
    id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"userWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE CASCADE,
    "userId" uuid,"applicationId" uuid,"applicationVariableId" uuid,scope text,strategy text,status text,"authProvider" text,
    "isImpersonating" boolean DEFAULT false, origin text,"revokedReason" text,"revokedAt" timestamptz,"expiresAt" timestamptz,
    "createdAt" timestamptz DEFAULT now(),"folderId" uuid,secret text,value text,"tokenHash" text,"ipAddress" text,"userAgent" text,name text)`);
  await owner.query(
    'ALTER TABLE core."navigationMenuItem" ADD FOREIGN KEY ("folderId") REFERENCES core."navigationMenuItem"(id) ON DELETE CASCADE',
  );
  for (const table of ['workflow', 'view'])
    await owner.query(
      `CREATE TABLE core."${table}"(id uuid PRIMARY KEY,"workspaceId" uuid,"applicationId" uuid,"createdByUserWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE SET NULL,label text,"updatedAt" timestamptz DEFAULT now())`,
    );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-membership-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${databaseRole}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${databaseRole}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.corrupt_audit(); TRUNCATE core.workspace,core.application,core.intent,core."roleTarget",core."userWorkspace",crm_audit."crmAuditEntry" CASCADE',
  );
  await owner.query('INSERT INTO core.workspace VALUES($1,NULL)', [
    workspaceId,
  ]);
  await owner.query('INSERT INTO core.application VALUES($1,$2,$3)', [
    applicationId,
    workspaceId,
    applicationUid,
  ]);
  await owner.query(
    'INSERT INTO core."userWorkspace"(id,"workspaceId","userId") VALUES($1,$2,$3),($4,$2,$3)',
    [membershipId, workspaceId, userId, otherMembershipId],
  );
  await owner.query('INSERT INTO core."roleTarget" VALUES($1,$2,$3,$4)', [
    randomUUID(),
    workspaceId,
    membershipId,
    randomUUID(),
  ]);
  for (const table of childTables)
    await owner.query(
      `INSERT INTO core."${table}"(id,"workspaceId","userWorkspaceId","userId",secret,value,"tokenHash","ipAddress","userAgent",name) VALUES($1,$2,$3,$4,'secret-otp','secret-variable','secret-hash','secret-ip','secret-agent','private-label')`,
      [
        table === 'navigationMenuItem' ? navigationIds[0] : randomUUID(),
        workspaceId,
        membershipId,
        userId,
      ],
    );
  await owner.query(
    'INSERT INTO core."navigationMenuItem"(id,"workspaceId","userWorkspaceId","folderId") VALUES($1,$2,$3,$4),($5,$2,NULL,$1)',
    [
      navigationIds[1],
      workspaceId,
      otherMembershipId,
      navigationIds[0],
      navigationIds[2],
    ],
  );
  for (const table of ['workflow', 'view'])
    await owner.query(
      `INSERT INTO core."${table}"(id,"workspaceId","applicationId","createdByUserWorkspaceId",label) VALUES($1,$2,$3,$4,'original')`,
      [
        table === 'workflow' ? workflowId : randomUUID(),
        workspaceId,
        applicationId,
        membershipId,
      ],
    );
});
afterAll(async () => {
  jest.restoreAllMocks();
  await runtime.destroy();
  await owner.query(
    `DROP OWNED BY "${databaseRole}"; DROP ROLE "${databaseRole}"`,
  );
  await owner.destroy();
});

it('records every actual CASCADE and SET NULL effect with one trusted operation and no secrets', async () => {
  const identity = operation();
  expect(await remove(false, identity)).toEqual([workflowId]);
  const rows = await audits();
  expect(rows).toHaveLength(11);
  expect(
    new Set(rows.map((row: { operationId: string }) => row.operationId)),
  ).toEqual(new Set([identity.operationId]));
  expect(
    rows.filter(
      (row: { resourceKind: string }) =>
        row.resourceKind === 'navigationMenuItem',
    ),
  ).toHaveLength(3);
  expect(
    rows.filter((row: { action: string }) => row.action === 'update'),
  ).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toMatch(
    /secret-|private-label|tokenHash|ipAddress|userAgent/,
  );
  expect(await membership()).toEqual([]);
  expect(await intents()).toHaveLength(1);
  expect(Logger.prototype.error).not.toHaveBeenCalled();
});
it('soft deletion retains dependent rows and records only actual membership update', async () => {
  await remove(true);
  expect((await membership())[0].deletedAt).toBeTruthy();
  expect(await audits()).toHaveLength(1);
  expect(await intents()).toEqual([]);
  expect(await owner.query('SELECT id FROM core."userSession"')).toHaveLength(
    1,
  );
  expect(await owner.query('SELECT id FROM core."roleTarget"')).toHaveLength(1);
});
it('missing membership is an audit-free no-op', async () => {
  await remove();
  const previous = await audits();
  expect(await remove()).toEqual([]);
  expect(await audits()).toEqual(previous);
});
it.each([
  'navigationMenuItem',
  'userSession',
  'applicationAuthorization',
  'view',
])('rejects a foreign workspace dependency in %s', async (table) => {
  await owner.query(`UPDATE core."${table}" SET "workspaceId"=$1`, [
    foreignWorkspaceId,
  ]);
  await expect(remove()).rejects.toThrow('foreign dependencies');
  expect(await membership()).toHaveLength(1);
  expect(await audits()).toEqual([]);
  expect(await intents()).toEqual([]);
});
it('refuses cross-workspace attribution before mutation', async () => {
  await expect(
    remove(false, { ...operation(), workspaceId: foreignWorkspaceId }),
  ).rejects.toThrow('workspace mismatch');
  expect(await membership()).toHaveLength(1);
});
it('copies attribution before the first await', async () => {
  const identity = operation(),
    originalActor = identity.actor.id;
  const pending = remove(false, identity);
  identity.actor.id = randomUUID();
  identity.operationId = randomUUID();
  await pending;
  expect(
    (await audits()).every(
      (row: { actor: { id: string } }) => row.actor.id === originalActor,
    ),
  ).toBe(true);
});
it('rolls back only audit when INSERT permission is absent and retains the recovery intent', async () => {
  await owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${databaseRole}"`,
  );
  try {
    await remove();
    expect(await membership()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(await intents()).toHaveLength(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('MEMBERSHIP_CLEANUP_AUDIT_UNAVAILABLE'),
    );
  } finally {
    await owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}"`,
    );
  }
});
it.each([
  'RETURN NULL;',
  "UPDATE core.workflow SET label='corrupted'; RETURN NEW;",
  'DELETE FROM core.intent; RETURN NEW;',
])(
  'rejects late audit corruption without resurrecting access: %s',
  async (body) => {
    await owner.query(
      `CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER corrupt_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()`,
    );
    await remove();
    expect(await audits()).toEqual([]);
    expect(await membership()).toEqual([]);
    expect(await intents()).toHaveLength(1);
    expect(
      (await owner.query('SELECT label FROM core.workflow'))[0].label,
    ).toBe('original');
    expect(Logger.prototype.error).toHaveBeenCalled();
  },
);
it('unsupported added FK effect reports unavailable audit while still revoking access', async () => {
  await owner.query(
    'CREATE TABLE core.extra(id uuid PRIMARY KEY,"userWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE CASCADE)',
  );
  try {
    await owner.query('INSERT INTO core.extra VALUES($1,$2)', [
      randomUUID(),
      membershipId,
    ]);
    await remove();
    expect(await membership()).toEqual([]);
    expect(await owner.query('SELECT * FROM core.extra')).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalled();
  } finally {
    await owner.query('DROP TABLE core.extra');
  }
});
it('detects a trigger that silently retains a cascaded record and rolls back cleanup', async () => {
  await owner.query(
    'CREATE FUNCTION core.skip_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_child BEFORE DELETE ON core."userSession" FOR EACH ROW EXECUTE FUNCTION core.skip_child()',
  );
  try {
    await expect(remove()).rejects.toThrow('retained a deleted dependency');
    expect(await membership()).toHaveLength(1);
    expect(await audits()).toEqual([]);
    expect(await intents()).toEqual([]);
  } finally {
    await owner.query(
      'DROP TRIGGER skip_child ON core."userSession"; DROP FUNCTION core.skip_child()',
    );
  }
});
it.each(['deletedAt', 'updatedAt'])(
  'rejects late soft-delete timestamp corruption: %s',
  async (field) => {
    await owner.query(
      `CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."userWorkspace" SET "${field}"="${field}" + interval '1 microsecond' WHERE id='${membershipId}'; RETURN NEW; END $$; CREATE TRIGGER corrupt_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()`,
    );
    await remove(true);
    expect((await membership())[0].deletedAt).toBeTruthy();
    expect(await audits()).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalled();
  },
);
it.each(['userSession', 'navigationMenuItem'])(
  'does not bypass known foreign scope when FK coverage is unavailable: %s',
  async (table) => {
    await owner.query(
      'CREATE TABLE core.extra(id uuid PRIMARY KEY,"userWorkspaceId" uuid REFERENCES core."userWorkspace"(id) ON DELETE CASCADE)',
    );
    try {
      await owner.query(`UPDATE core."${table}" SET "workspaceId"=$1`, [
        foreignWorkspaceId,
      ]);
      await expect(remove()).rejects.toThrow('foreign dependencies');
      expect(await membership()).toHaveLength(1);
      expect(await audits()).toEqual([]);
    } finally {
      await owner.query('DROP TABLE core.extra');
    }
  },
);
it('missing scope-read permission cannot downgrade to unchecked cleanup', async () => {
  await owner.query(
    `REVOKE SELECT ON core."userSession" FROM "${databaseRole}"`,
  );
  try {
    await expect(remove()).rejects.toThrow('permission denied');
    expect(await membership()).toHaveLength(1);
    expect(await audits()).toEqual([]);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  } finally {
    await owner.query(
      `GRANT SELECT ON core."userSession" TO "${databaseRole}"`,
    );
  }
});
it('rejects role targets inserted after capture instead of silently missing their audit', async () => {
  await owner.query(
    `CREATE FUNCTION core.add_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO core."roleTarget" VALUES(gen_random_uuid(),'${workspaceId}','${membershipId}',gen_random_uuid()); RETURN NEW; END $$; CREATE TRIGGER add_target AFTER INSERT ON core.intent FOR EACH ROW EXECUTE FUNCTION core.add_target()`,
  );
  try {
    await expect(remove()).rejects.toThrow('unexpected role targets');
    expect(await membership()).toHaveLength(1);
    expect(await audits()).toEqual([]);
  } finally {
    await owner.query(
      'DROP TRIGGER add_target ON core.intent; DROP FUNCTION core.add_target()',
    );
  }
});
it('handles recursive folder cycles once per actual deleted record', async () => {
  await owner.query(
    'UPDATE core."navigationMenuItem" SET "folderId"=$1 WHERE id=$2',
    [navigationIds[2], navigationIds[0]],
  );
  await remove();
  expect(await audits()).toHaveLength(11);
});
it('resamples descendants moved out while waiting for a row lock', async () => {
  const blocker = owner.createQueryRunner();
  await blocker.connect();
  await blocker.startTransaction();
  await blocker.query(
    'SELECT id FROM core."navigationMenuItem" WHERE id=$1 FOR UPDATE',
    [navigationIds[1]],
  );
  const pending = remove();
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await owner.query(
        "SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
        [databaseRole],
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(waiting).toBe(true);
    await blocker.query(
      'UPDATE core."navigationMenuItem" SET "folderId"=NULL WHERE id=$1',
      [navigationIds[1]],
    );
    await blocker.commitTransaction();
    await pending;
    expect(
      await owner.query('SELECT id FROM core."navigationMenuItem"'),
    ).toHaveLength(2);
    expect(await audits()).toHaveLength(9);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    await blocker.release();
    await pending.catch(() => {});
  }
});
it('keeps removal and audit committed after a lost COMMIT acknowledgement without retry', async () => {
  const create = runtime.createQueryRunner.bind(runtime);
  let commits = 0;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    let wrapped = false;
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!wrapped) {
        wrapped = true;
        const query = client.query.bind(client);
        client.query = async (statement: string, ...args: unknown[]) => {
          const result = await query(statement, ...args);
          if (statement === 'COMMIT') {
            commits++;
            throw new Error('lost commit acknowledgement');
          }
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  await expect(remove()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(commits).toBe(1);
  expect(await membership()).toEqual([]);
  expect(await audits()).toHaveLength(11);
  expect(await intents()).toHaveLength(1);
});
it('does not accept administrative payloads with extra scope selectors', async () => {
  const runner = runtime.createQueryRunner();
  await runner.startTransaction();
  try {
    const context = new CrmAuditTransactionContext(runner, operation());
    expect(() =>
      context.record({
        resourceKind: 'userWorkspace',
        resourceId: membershipId,
        action: 'delete',
        before: { userId },
        after: null,
        securityDescriptor: {
          resourceKind: 'userWorkspace',
          resourceId: membershipId,
          metadataAccess: 'currentWorkspaceAdministration',
          conversationId: randomUUID(),
        },
      }),
    ).toThrow('exact current administrative scope');
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});
