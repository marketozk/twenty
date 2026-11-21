import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { JwtKeyManagerExceptionCode } from 'src/engine/core-modules/jwt/jwt-key-manager.exception';

for (const [modPath, names] of [
  [
    'src/engine/core-entity-cache/services/core-entity-cache.service',
    ['CoreEntityCacheService'],
  ],
  [
    'src/engine/core-modules/jwt/entities/signing-key.entity',
    ['SigningKeyEntity'],
  ],
  [
    'src/engine/core-modules/secret-encryption/secret-encryption.service',
    ['SecretEncryptionService'],
  ],
  [
    'src/engine/core-modules/admin-panel/dtos/signing-key.dto',
    ['SigningKeyDTO'],
  ],
  [
    'src/engine/core-modules/admin-panel/dtos/signing-keys-admin-panel.dto',
    ['SigningKeysAdminPanelDTO'],
  ],
  [
    'src/engine/core-modules/jwt/services/signing-key-verify-counter.service',
    ['SigningKeyVerifyCounterService'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SigningKeyEntity } =
  require('src/engine/core-modules/jwt/entities/signing-key.entity') as {
    SigningKeyEntity: new () => Record<string, unknown>;
  };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JwtKeyManagerService } =
  require('src/engine/core-modules/jwt/services/jwt-key-manager.service') as typeof import('src/engine/core-modules/jwt/services/jwt-key-manager.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AdminPanelSigningKeyService } =
  require('src/engine/core-modules/admin-panel/services/admin-panel-signing-key.service') as typeof import('src/engine/core-modules/admin-panel/services/admin-panel-signing-key.service');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url) throw new Error('FORK_MIGRATION_TEST_URL is required');

const role = `signing_key_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const signingKeySchema = new EntitySchema<Record<string, unknown>>({
  name: 'SigningKeyAuditFixture',
  target: SigningKeyEntity,
  schema: 'core',
  tableName: 'signingKey',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    publicKey: { type: 'varchar' },
    privateKey: { type: 'varchar', nullable: true },
    isCurrent: { type: 'boolean', default: false },
    revokedAt: { type: 'timestamptz', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [signingKeySchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-signing-key-audit';

const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [signingKeySchema],
  extra: { max: 6, statement_timeout: 12000 },
});

const workspaceId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();

const cacheInvalidateMock = jest.fn(async () => {});

const createKeyManager = () =>
  new JwtKeyManagerService(
    runtime.getRepository(SigningKeyEntity) as never,
    {
      get: jest.fn(async () => null),
      invalidate: cacheInvalidateMock,
    } as never,
    {
      encryptVersioned: (plaintext: string) =>
        `enc:v2:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
      decryptVersionedOrThrow: (ciphertext: string) =>
        Buffer.from(ciphertext.replace(/^enc:v2:/, ''), 'base64').toString(
          'utf8',
        ),
    } as never,
    runtime,
  );

const createAdminSigningKeyService = (
  keyManager: InstanceType<typeof JwtKeyManagerService>,
) =>
  new AdminPanelSigningKeyService(keyManager, {
    getUsageInWindow: jest.fn(async () => ({
      byKid: {},
      legacyCount: 0,
      windowDays: 30,
    })),
  } as never);

const readSigningKeyAudits = async (wsId = workspaceId) =>
  owner.query(
    `SELECT id, "operationId", "correlationId", "resourceKind", "resourceId", action,
            actor, initiator, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
        AND "resourceKind" = 'signingKey'
      ORDER BY "createdAt" ASC, id ASC`,
    [wsId],
  );

describe('LOG195 transactional signingKey audit (PostgreSQL)', () => {
  beforeAll(async () => {
    await owner.initialize();

    await owner.query(`DROP SCHEMA IF EXISTS crm_audit CASCADE`);
    await owner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
    await owner.query(`CREATE SCHEMA core`);

    await owner.query(`
      CREATE TABLE core.workspace (
        id uuid PRIMARY KEY,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."user" (
        id uuid PRIMARY KEY,
        email text UNIQUE NOT NULL,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."userWorkspace" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."signingKey" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "publicKey" varchar NOT NULL,
        "privateKey" varchar NULL,
        "isCurrent" boolean NOT NULL DEFAULT false,
        "revokedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_signingKey_privateKey_encrypted"
          CHECK ("privateKey" IS NULL OR "privateKey" LIKE 'enc:v2:%')
      );
      CREATE UNIQUE INDEX "IDX_SIGNING_KEY_IS_CURRENT_UNIQUE"
        ON core."signingKey" ("isCurrent")
        WHERE "isCurrent" = true;
    `);

    const bootstrapRunner = owner.createQueryRunner();
    try {
      await new OmniAuditBootstrapFastInstanceCommand().up(bootstrapRunner);
    } finally {
      await bootstrapRunner.release();
    }

    await owner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-signing-key-audit';
        END IF;
      END
      $$;
    `);
    await owner.query(`GRANT USAGE ON SCHEMA core, crm_audit TO "${role}"`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${role}"`,
    );
    await owner.query(
      `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
    );
    await owner.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON crm_audit."crmAuditEntry" FROM "${role}"`,
    );

    await owner.query(`INSERT INTO core.workspace (id) VALUES ($1)`, [
      workspaceId,
    ]);
    await owner.query(
      `INSERT INTO core."user" (id, email) VALUES ($1, $2), ($3, $4)`,
      [
        actorUserId,
        'admin@acme.test',
        impersonatorUserId,
        'impersonator@acme.test',
      ],
    );
    await owner.query(
      `INSERT INTO core."userWorkspace" (id, "userId", "workspaceId")
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        actorUserWorkspaceId,
        actorUserId,
        workspaceId,
        impersonatorUserWorkspaceId,
        impersonatorUserId,
        workspaceId,
      ],
    );

    await runtime.initialize();
  });

  beforeEach(async () => {
    cacheInvalidateMock.mockClear();
    await owner.query(`DELETE FROM core."signingKey"`);
    await owner.query(`DELETE FROM crm_audit."crmAuditEntry"`);
  });

  afterAll(async () => {
    if (runtime.isInitialized) await runtime.destroy();
    if (owner.isInitialized) {
      await owner.query(`DROP SCHEMA IF EXISTS crm_audit CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.destroy();
    }
  });

  it('audits bootstrap creation via getCurrentSigningKey with system actor and redaction', async () => {
    const keyManager = createKeyManager();

    const current = await keyManager.getCurrentSigningKey();
    expect(current).not.toBeNull();
    expect(current?.privateKeyPem).toContain('BEGIN PRIVATE KEY');

    const [dbKey] = await owner.query(
      `SELECT id, "publicKey", "privateKey", "isCurrent", "revokedAt"
         FROM core."signingKey" WHERE id = $1`,
      [current?.id],
    );
    expect(dbKey.isCurrent).toBe(true);
    expect(dbKey.privateKey).toMatch(/^enc:v2:/);

    const audits = await readSigningKeyAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      resourceKind: 'signingKey',
      resourceId: current?.id,
      action: 'create',
      actor: { kind: 'system', id: 'jwt-key-manager:bootstrap-current' },
      securityDescriptor: {
        resourceKind: 'signingKey',
        resourceId: current?.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values).toEqual({
      isCurrent: { before: null, after: true },
      hasPrivateKey: { before: null, after: true },
    });
    expect(audits[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining([
        'publicKey',
        'privateKey',
        'isCurrent',
        'hasPrivateKey',
      ]),
    );
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain('BEGIN PUBLIC KEY');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain('enc:v2:');
  });

  it('audits revokeSigningKey through AdminPanelSigningKeyService with impersonation, idempotency, and not-found handling', async () => {
    const keyManager = createKeyManager();
    const adminService = createAdminSigningKeyService(keyManager);

    const bootstrapped = await keyManager.getCurrentSigningKey();
    expect(bootstrapped).not.toBeNull();
    const keyId = bootstrapped!.id;
    cacheInvalidateMock.mockClear();

    const requestIdentity = {
      workspace: { id: workspaceId },
      user: { id: actorUserId },
      userWorkspaceId: actorUserWorkspaceId,
      impersonationContext: {
        impersonatorUserWorkspaceId,
      },
    };

    const revoked = await adminService.revokeSigningKey(keyId, requestIdentity);
    expect(revoked.id).toBe(keyId);
    expect(revoked.isCurrent).toBe(false);
    expect(revoked.revokedAt).not.toBeNull();
    expect(cacheInvalidateMock).toHaveBeenCalledWith(
      'signingKeyPublicKey',
      keyId,
    );

    const revokedAgain = await adminService.revokeSigningKey(
      keyId,
      requestIdentity,
    );
    expect(revokedAgain.id).toBe(keyId);

    await expect(
      adminService.revokeSigningKey(randomUUID(), requestIdentity),
    ).rejects.toMatchObject({
      code: JwtKeyManagerExceptionCode.SIGNING_KEY_NOT_FOUND,
    });

    const audits = await readSigningKeyAudits();
    expect(audits).toHaveLength(2);
    const revokeAudit = audits[1];
    expect(revokeAudit).toMatchObject({
      resourceKind: 'signingKey',
      resourceId: keyId,
      action: 'update',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
    expect(revokeAudit.redactedDiff.values).toEqual({
      isCurrent: { before: true, after: false },
      hasPrivateKey: { before: true, after: false },
    });
    expect(revokeAudit.redactedDiff.changedFields).toEqual(
      expect.arrayContaining([
        'isCurrent',
        'hasPrivateKey',
        'privateKey',
        'revokedAt',
      ]),
    );
    const serialized = JSON.stringify(revokeAudit);
    expect(serialized).not.toContain('BEGIN PUBLIC KEY');
    expect(serialized).not.toContain('enc:v2:');
  });

  it('audits rotateCurrent with one operationId for both explicit identity and system rotation', async () => {
    const keyManager = createKeyManager();
    const first = await keyManager.getCurrentSigningKey();
    expect(first).not.toBeNull();

    const explicitIdentity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
      impersonatorUserWorkspaceId,
    };

    const second = await keyManager.rotateCurrent(explicitIdentity);
    expect(second.id).not.toBe(first!.id);

    const auditsAfterFirstRotate = await readSigningKeyAudits();
    expect(auditsAfterFirstRotate).toHaveLength(3);
    const deactivateAudit = auditsAfterFirstRotate[1];
    const createAudit = auditsAfterFirstRotate[2];
    expect(deactivateAudit.operationId).toBe(createAudit.operationId);
    expect(deactivateAudit).toMatchObject({
      resourceId: first!.id,
      action: 'update',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
    expect(deactivateAudit.redactedDiff.values).toEqual({
      isCurrent: { before: true, after: false },
      hasPrivateKey: { before: true, after: false },
    });
    expect(createAudit).toMatchObject({
      resourceId: second.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
    expect(createAudit.redactedDiff.values).toEqual({
      isCurrent: { before: null, after: true },
      hasPrivateKey: { before: null, after: true },
    });

    const third = await keyManager.rotateCurrent();
    expect(third.id).not.toBe(second.id);

    const auditsAfterSystemRotate = await readSigningKeyAudits();
    expect(auditsAfterSystemRotate).toHaveLength(5);
    expect(auditsAfterSystemRotate[3].operationId).toBe(
      auditsAfterSystemRotate[4].operationId,
    );
    expect(auditsAfterSystemRotate[3].actor).toEqual({
      kind: 'system',
      id: 'jwt-key-manager:rotate-current',
    });
    expect(auditsAfterSystemRotate[4].actor).toEqual({
      kind: 'system',
      id: 'jwt-key-manager:rotate-current',
    });
  });

  it('fails closed when revokeSigningKey is called without auditIdentity', async () => {
    const keyManager = createKeyManager();
    const first = await keyManager.getCurrentSigningKey();
    expect(first).not.toBeNull();
    cacheInvalidateMock.mockClear();

    await expect(keyManager.revokeSigningKey(first!.id)).rejects.toThrow();

    expect(cacheInvalidateMock).not.toHaveBeenCalled();
    const [dbKey] = await owner.query(
      `SELECT "isCurrent", "revokedAt", "privateKey" FROM core."signingKey" WHERE id = $1`,
      [first!.id],
    );
    expect(dbKey.isCurrent).toBe(true);
    expect(dbKey.revokedAt).toBeNull();
    expect(dbKey.privateKey).toMatch(/^enc:v2:/);
  });

  it('rolls back revokeSigningKey and rotateCurrent on audit flush failure or post-flush drift', async () => {
    const keyManager = createKeyManager();
    const first = await keyManager.getCurrentSigningKey();
    expect(first).not.toBeNull();
    cacheInvalidateMock.mockClear();

    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorUserId },
    };

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_signing_key_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'signingKey' THEN
          RAISE EXCEPTION 'simulated signingKey audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_fail_signing_key_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_signing_key_audit();
    `);

    try {
      await expect(
        keyManager.revokeSigningKey(first!.id, identity),
      ).rejects.toThrow('simulated signingKey audit failure');

      await expect(keyManager.rotateCurrent(identity)).rejects.toThrow(
        'simulated signingKey audit failure',
      );
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_fail_signing_key_audit ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.fail_on_signing_key_audit()`,
      );
    }

    expect(cacheInvalidateMock).not.toHaveBeenCalled();
    const keysAfterFail = await owner.query(
      `SELECT id, "isCurrent", "revokedAt" FROM core."signingKey"`,
    );
    expect(keysAfterFail).toHaveLength(1);
    expect(keysAfterFail[0].id).toBe(first!.id);
    expect(keysAfterFail[0].isCurrent).toBe(true);
    expect(keysAfterFail[0].revokedAt).toBeNull();

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.tamper_signing_key_after_flush()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'signingKey' AND NEW.action = 'update' THEN
          UPDATE core."signingKey"
             SET "revokedAt" = NULL
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_tamper_signing_key_after_flush
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_signing_key_after_flush();
    `);

    try {
      await expect(
        keyManager.revokeSigningKey(first!.id, identity),
      ).rejects.toThrow('Signing key state changed during audit flush');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_tamper_signing_key_after_flush ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.tamper_signing_key_after_flush()`,
      );
    }

    expect(cacheInvalidateMock).not.toHaveBeenCalled();
    const [keyAfterDrift] = await owner.query(
      `SELECT "isCurrent", "revokedAt" FROM core."signingKey" WHERE id = $1`,
      [first!.id],
    );
    expect(keyAfterDrift.isCurrent).toBe(true);
    expect(keyAfterDrift.revokedAt).toBeNull();
  });
});
