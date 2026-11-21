import { randomUUID } from 'node:crypto';
import { TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER } from 'twenty-shared/application-runtime';
import { EVERYONE_PRINCIPAL_ID } from 'twenty-shared/constants';
import {
  FeatureFlagKey,
  MetadataReadability,
  ObjectSharingReach,
  RecordShareAccessLevel,
  RecordSharePrincipalType,
  RecordShareRowCause,
} from 'twenty-shared/types';
import { DataSource, type FindOperator, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { withWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { type UserWorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  captureCrmAuditRequest,
  withCrmAuditIdentity,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  beginRecordShareAuditTransaction,
  captureRecordShareAudit,
  runAuditedRecordShareScopeMutation,
} from 'src/engine/core-modules/crm-audit/record-share-audit';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

jest.mock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => {},
  }),
);
for (const [modPath, names] of [
  ['src/engine/guards/auth-principal.guard', ['AuthPrincipalGuard']],
  ['src/engine/guards/custom-permission.guard', ['CustomPermissionGuard']],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  [
    'src/engine/metadata-modules/record-permissions/services/record-permissions.service',
    ['RecordPermissionsService'],
  ],
  [
    'src/engine/metadata-modules/user-role/user-role.service',
    ['UserRoleService'],
  ],
  [
    'src/engine/twenty-orm/workspace-orm.manager',
    ['WorkspaceOrmManager'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/core-modules/record-share/services/record-share-principal.service',
    ['RecordSharePrincipalService'],
  ],
] as const) {
  jest.mock(modPath, () => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (name === 'AuthPrincipalGuard') {
        out[name] = () => class {};
      } else {
        out[name] = class {};
      }
    }
    return out;
  });
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RecordShareStorageService } =
  require('src/engine/core-modules/record-share/services/record-share-storage.service') as typeof import('src/engine/core-modules/record-share/services/record-share-storage.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RecordSharingService } =
  require('src/engine/core-modules/record-share/services/record-sharing.service') as typeof import('src/engine/core-modules/record-share/services/record-sharing.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RecordSharingResolver } =
  require('src/engine/core-modules/record-share/resolvers/record-sharing.resolver') as typeof import('src/engine/core-modules/record-share/resolvers/record-sharing.resolver');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RecordShareOwnershipTransferService } =
  require('src/engine/core-modules/record-share/services/record-share-ownership-transfer.service') as typeof import('src/engine/core-modules/record-share/services/record-share-ownership-transfer.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ShareRecordTool } =
  require('src/engine/core-modules/tool/tools/share-record-tool/share-record-tool') as typeof import('src/engine/core-modules/tool/tools/share-record-tool/share-record-tool');

const ownerUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !ownerUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(ownerUrl).pathname)
) {
  throw new Error(
    'FORK_MIGRATION_TEST_URL must target an isolated temporary test database',
  );
}
const databaseRole = `rs_audit_rt_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const runtimeUrl = (() => {
  const parsed = new URL(ownerUrl);
  parsed.username = databaseRole;
  parsed.password = 'isolated-rs-fixture';
  return parsed.toString();
})();

const workspaceId = randomUUID().toLowerCase();
const workspaceSchema = getWorkspaceSchemaName(workspaceId);
const actorUserId = randomUUID().toLowerCase();
const actorUserWorkspaceId = randomUUID().toLowerCase();
const actorMemberId = randomUUID().toLowerCase();
const impersonatorUserId = randomUUID().toLowerCase();
const impersonatorUserWorkspaceId = randomUUID().toLowerCase();
const targetMemberId = randomUUID().toLowerCase();
const custodianUserId = randomUUID().toLowerCase();
const custodianUserWorkspaceId = randomUUID().toLowerCase();
const custodianMemberId = randomUUID().toLowerCase();
const roleId = randomUUID().toLowerCase();
const agentId = randomUUID().toLowerCase();
const applicationId = randomUUID().toLowerCase();
const objectMetadataId = randomUUID().toLowerCase();
const objectMetadataUniversalIdentifier = randomUUID().toLowerCase();
const createdByFieldId = randomUUID().toLowerCase();
const recordId = randomUUID().toLowerCase();
const recordId2 = randomUUID().toLowerCase();

const ownerDataSource = new DataSource({ type: 'postgres', url: ownerUrl });
const runtimeDataSource = new DataSource({ type: 'postgres', url: runtimeUrl });

const buildAuthContext = (
  overrides: Partial<UserWorkspaceAuthContext> = {},
): UserWorkspaceAuthContext =>
  ({
    type: 'user',
    workspace: { id: workspaceId },
    user: { id: actorUserId },
    userWorkspaceId: actorUserWorkspaceId,
    workspaceMemberId: actorMemberId,
    workspaceMember: { id: actorMemberId, userId: actorUserId },
    ...overrides,
  }) as UserWorkspaceAuthContext;

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT id, "operationId", actor, initiator, action, "resourceKind", "resourceId",
            outcome, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
      ORDER BY "createdAt" ASC, id ASC`,
    [workspaceId],
  );

const readRecordShareRows = () =>
  ownerDataSource.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM "${workspaceSchema}"."recordShare"
      ORDER BY id ASC`,
  );

const buildWhereSql = (
  criteria: Record<string, unknown>,
  withDeleted: boolean,
): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!withDeleted) {
    clauses.push(`"deletedAt" IS NULL`);
  }

  for (const [key, rawVal] of Object.entries(criteria)) {
    if (rawVal === undefined) {
      continue;
    }
    const col = `"${key}"`;
    if (
      rawVal &&
      typeof rawVal === 'object' &&
      'type' in (rawVal as FindOperator<unknown>) &&
      'value' in (rawVal as FindOperator<unknown>)
    ) {
      const op = rawVal as FindOperator<unknown>;
      if (op.type === 'in') {
        params.push(op.value);
        clauses.push(`${col} = ANY($${params.length})`);
      } else if (op.type === 'not') {
        params.push(op.value);
        clauses.push(`${col} <> $${params.length}`);
      } else {
        throw new Error(`Unsupported FindOperator ${op.type}`);
      }
    } else {
      params.push(rawVal);
      clauses.push(`${col} = $${params.length}`);
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
};

const createSqlRecordShareRepo = (
  runQuery: (sql: string, params?: unknown[]) => Promise<unknown[]>,
) => ({
  find: async ({
    where,
    withDeleted = false,
  }: {
    where: Record<string, unknown>;
    withDeleted?: boolean;
  }) => {
    const { sql, params } = buildWhereSql(where, withDeleted);
    return runQuery(
      `SELECT id, "recordId", "objectMetadataId", "principalId",
              "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
         FROM "${workspaceSchema}"."recordShare"
         ${sql}
        ORDER BY id ASC`,
      params,
    );
  },
  insert: async (
    rowsInput: Record<string, unknown> | Array<Record<string, unknown>>,
    opts?: { onConflictDoNothing?: boolean },
  ) => {
    const rows = Array.isArray(rowsInput) ? rowsInput : [rowsInput];
    for (const row of rows) {
      await runQuery(
        `INSERT INTO "${workspaceSchema}"."recordShare"
           (id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)${
           opts?.onConflictDoNothing
             ? ' ON CONFLICT ("objectMetadataId", "recordId", "principalId", "rowCause", "sourceId") DO NOTHING'
             : ''
         }`,
        [
          row.id ?? randomUUID(),
          row.recordId,
          row.objectMetadataId,
          row.principalId,
          row.principalType,
          row.accessLevel,
          row.rowCause,
          row.sourceId,
        ],
      );
    }
  },
  update: async (
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => {
    const { sql, params } = buildWhereSql(where, true);
    const sets: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      params.push(v);
      sets.push(`"${k}" = $${params.length}`);
    }
    await runQuery(
      `UPDATE "${workspaceSchema}"."recordShare" SET ${sets.join(', ')} ${sql}`,
      params,
    );
  },
  delete: async (where: Record<string, unknown>) => {
    const { sql, params } = buildWhereSql(where, true);
    await runQuery(
      `DELETE FROM "${workspaceSchema}"."recordShare" ${sql}`,
      params,
    );
  },
});

const createSqlTargetRepo = (
  runQuery: (sql: string, params?: unknown[]) => Promise<unknown[]>,
) => ({
  findRecordIdsAllowedForOperation: async ({
    recordIds,
  }: {
    recordIds: string[];
  }) => {
    const rows = (await runQuery(
      `SELECT id FROM "${workspaceSchema}".company WHERE id = ANY($1::uuid[])`,
      [recordIds],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  },
  isObjectOperationPermittedByRole: () => true,
  createQueryBuilder: () => {
    let targetId: string | undefined;
    const qb = {
      select: () => qb,
      where: (w: { id: string }) => {
        targetId = w.id;
        return qb;
      },
      withDeleted: () => qb,
      getMany: async () =>
        runQuery(
          `SELECT id, "createdByWorkspaceMemberId" FROM "${workspaceSchema}".company WHERE id = $1`,
          [targetId],
        ),
    };
    return qb;
  },
});

const createHarness = ({
  transferableObjects = true,
  custodianUserWorkspace = { id: custodianUserWorkspaceId, userId: custodianUserId } as
    | { id: string; userId: string }
    | null,
  forceLegacyTransaction = false,
}: {
  transferableObjects?: boolean;
  custodianUserWorkspace?: { id: string; userId: string } | null;
  forceLegacyTransaction?: boolean;
} = {}) => {
  const flatCompanyObject = {
    id: objectMetadataId,
    universalIdentifier: objectMetadataUniversalIdentifier,
    applicationUniversalIdentifier:
      TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
    nameSingular: 'company',
    namePlural: 'companies',
    isCustom: false,
    isSystem: false,
    readability: MetadataReadability.OPEN,
    sharingReach: ObjectSharingReach.ROLE_ACCESS,
    fieldIds: [createdByFieldId],
  };

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: transferableObjects
          ? { [objectMetadataUniversalIdentifier]: flatCompanyObject }
          : {},
        universalIdentifierById: transferableObjects
          ? { [objectMetadataId]: objectMetadataUniversalIdentifier }
          : {},
        idByUniversalIdentifier: transferableObjects
          ? { [objectMetadataUniversalIdentifier]: objectMetadataId }
          : {},
      },
      flatFieldMetadataMaps: {
        byUniversalIdentifier: {
          [createdByFieldId]: {
            id: createdByFieldId,
            name: 'createdBy',
            objectMetadataId,
          },
        },
        universalIdentifierById: {
          [createdByFieldId]: createdByFieldId,
        },
      },
      featureFlagsMap: {
        [FeatureFlagKey.IS_RECORD_LEVEL_SHARING_ENABLED]: true,
      },
      flatWorkspaceMemberMaps: {
        byId: {
          [actorMemberId]: { id: actorMemberId, userId: actorUserId },
          [targetMemberId]: { id: targetMemberId, userId: randomUUID() },
          [custodianMemberId]: {
            id: custodianMemberId,
            userId: custodianUserId,
          },
        },
      },
      flatRoleMaps: {
        byUniversalIdentifier: {
          [roleId]: {
            id: roleId,
            label: 'Member',
            canBeAssignedToUsers: true,
          },
        },
        universalIdentifierById: { [roleId]: roleId },
      },
      rolesPermissions: {
        [roleId]: {
          [objectMetadataId]: {
            canReadObjectRecords: true,
            canUpdateObjectRecords: true,
          },
        },
      },
      userWorkspaceRoleMap: { [actorUserWorkspaceId]: roleId },
      apiKeyRoleMap: {},
      flatRoleTargetByAgentIdMaps: {},
      roleIdsWithAllRecordsAccess: [],
    })),
  };

  const workspaceOrmManager = {
    executeInWorkspaceContext: jest.fn(async <T>(fn: () => Promise<T>) => fn()),
    runInWorkspaceTransaction: jest.fn(
      async <T>(
        work: (scope: unknown) => Promise<T>,
        options?: { commitOutcome?: 'strict' | 'legacy' },
      ): Promise<T> => {
        const qr: QueryRunner = runtimeDataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        let active = true;
        let released = false;
        const runQuery = (sql: string, params?: unknown[]) =>
          qr.query(sql, params);
        const scope = {
          workspaceId,
          transactionLifecycle: {
            commitOutcome: forceLegacyTransaction
              ? 'legacy'
              : (options?.commitOutcome ?? 'legacy'),
            get isTransactionActive() {
              return active;
            },
            get isReleased() {
              return released;
            },
          },
          executeRawQuery: runQuery,
          getRepository: (name: string) =>
            name === 'recordShare'
              ? createSqlRecordShareRepo(runQuery)
              : createSqlTargetRepo(runQuery),
        };
        try {
          const out = await work(scope);
          await qr.commitTransaction();
          active = false;
          return out;
        } catch (error) {
          if (active) {
            await qr.rollbackTransaction();
            active = false;
          }
          throw error;
        } finally {
          await qr.release();
          released = true;
        }
      },
    ),
    getRepository: jest.fn((name: string) => {
      const runQuery = (sql: string, params?: unknown[]) =>
        runtimeDataSource.query(sql, params);
      return name === 'recordShare'
        ? createSqlRecordShareRepo(runQuery)
        : createSqlTargetRepo(runQuery);
    }),
    getRepositoryWithContextPermissions: jest.fn(
      (_name: string, scope?: { executeRawQuery?: (s: string, p?: unknown[]) => Promise<unknown[]> }) => {
        const runQuery = scope?.executeRawQuery
          ? scope.executeRawQuery
          : (sql: string, params?: unknown[]) =>
              runtimeDataSource.query(sql, params);
        return createSqlTargetRepo(runQuery);
      },
    ),
  };

  const storageService = new RecordShareStorageService(
    workspaceOrmManager as never,
  );
  const principalService = {
    assertPrincipalsReachRecordsOrThrow: jest.fn().mockResolvedValue(undefined),
    resolveRoleIds: jest.fn(async ({ principals }: { principals: unknown[] }) =>
      principals.map(() => roleId),
    ),
  };
  const recordPermissionsService = {
    getPermissionsForRecords: jest.fn(
      async ({ recordIds }: { recordIds: string[] }) =>
        new Map(
          recordIds.map((id) => [
            id,
            {
              canRead: true,
              canUpdate: true,
              canDelete: true,
              canSoftDelete: true,
            },
          ]),
        ),
    ),
  };

  const sharingService = new RecordSharingService(
    workspaceOrmManager as never,
    workspaceCacheService as never,
    storageService,
    principalService as never,
    recordPermissionsService as never,
  );
  const sharingResolver = new RecordSharingResolver(sharingService);
  const shareTool = new ShareRecordTool(
    { isFeatureEnabled: jest.fn(async () => true) } as never,
    workspaceCacheService as never,
    sharingService,
  );
  const ownershipTransferService = new RecordShareOwnershipTransferService(
    {
      resolveCustodianUserWorkspace: jest.fn(
        async () => custodianUserWorkspace ?? undefined,
      ),
    } as never,
    storageService,
    workspaceCacheService as never,
  );

  return {
    storageService,
    sharingService,
    sharingResolver,
    shareTool,
    ownershipTransferService,
    workspaceOrmManager,
  };
};

beforeAll(async () => {
  await ownerDataSource.initialize();
  await ownerDataSource.query(
    `DROP SCHEMA IF EXISTS core CASCADE;
     DROP SCHEMA IF EXISTS crm_audit CASCADE;
     DROP SCHEMA IF EXISTS "${workspaceSchema}" CASCADE;
     CREATE SCHEMA core;
     CREATE SCHEMA "${workspaceSchema}";`,
  );
  await ownerDataSource.query(
    `CREATE TABLE core.workspace (
       id uuid PRIMARY KEY,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."user" (
       id uuid PRIMARY KEY,
       email text NOT NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE core."userWorkspace" (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
       "userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE "${workspaceSchema}".company (
       id uuid PRIMARY KEY,
       name text NOT NULL,
       "createdByWorkspaceMemberId" uuid NULL,
       "deletedAt" timestamptz NULL
     );
     CREATE TABLE "${workspaceSchema}"."recordShare" (
       id uuid PRIMARY KEY,
       "recordId" uuid NOT NULL,
       "objectMetadataId" uuid NOT NULL,
       "principalId" uuid NOT NULL,
       "principalType" text NOT NULL,
       "accessLevel" text NOT NULL,
       "rowCause" text NOT NULL,
       "sourceId" uuid NOT NULL,
       "createdAt" timestamptz NOT NULL DEFAULT now(),
       "updatedAt" timestamptz NOT NULL DEFAULT now(),
       "deletedAt" timestamptz NULL
     );
     CREATE UNIQUE INDEX "IDX_record_share_unique"
       ON "${workspaceSchema}"."recordShare"
       ("objectMetadataId", "recordId", "principalId", "rowCause", "sourceId");`,
  );

  await ownerDataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await ownerDataSource.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-rs-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, UPDATE ON core.workspace TO "${databaseRole}";
     GRANT SELECT ON core."user", core."userWorkspace" TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();

  await ownerDataSource.query(
    `INSERT INTO core.workspace (id) VALUES ($1)`,
    [workspaceId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email) VALUES ($1, 'actor@example.com'), ($2, 'admin@example.com'), ($3, 'custodian@example.com')`,
    [actorUserId, impersonatorUserId, custodianUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId") VALUES ($1,$2,$3), ($4,$2,$5), ($6,$2,$7)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
      custodianUserWorkspaceId,
      custodianUserId,
    ],
  );
});

afterAll(async () => {
  if (runtimeDataSource.isInitialized) {
    await runtimeDataSource.destroy();
  }
  if (ownerDataSource.isInitialized) {
    await ownerDataSource.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       REVOKE ALL PRIVILEGES ON SCHEMA core, crm_audit, "${workspaceSchema}" FROM "${databaseRole}";
       DROP ROLE IF EXISTS "${databaseRole}";`,
    );
    await ownerDataSource.destroy();
  }
});

beforeEach(async () => {
  await ownerDataSource.query(
    `DELETE FROM crm_audit."crmAuditEntry";
     DELETE FROM "${workspaceSchema}"."recordShare";
     DELETE FROM "${workspaceSchema}".company;`,
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}".company (id, name, "createdByWorkspaceMemberId")
     VALUES ($1, 'Acme Corp', $2), ($3, 'Beta Corp', $2)`,
    [recordId, actorMemberId, recordId2],
  );
});

describe('recordShare CRM audit (LOG-199)', () => {
  it('audits setRecordShare, in-place update, shareWith replacement, removeRecordShare, setRecordGeneralAccess, AI tool, and OAuth app attribution', async () => {
    const { sharingResolver, shareTool } = createHarness();
    const auth = buildAuthContext();
    const target = { objectMetadataId, recordId };

    // 1. setRecordShare create with impersonation
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordShare(
        target,
        { workspaceMemberId: targetMemberId },
        RecordShareAccessLevel.READ,
        {
          req: {
            impersonationContext: { impersonatorUserWorkspaceId },
          },
        },
      ),
    );

    let rows = await readRecordShareRows();
    expect(rows).toHaveLength(1);
    const createdShareId = rows[0].id;

    let audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      action: 'create',
      resourceKind: 'recordShare',
      resourceId: createdShareId,
      outcome: 'success',
      securityDescriptor: {
        resourceKind: 'recordShare',
        resourceId: createdShareId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values).toEqual({
      objectMetadataId: { before: null, after: objectMetadataId },
      recordId: { before: null, after: recordId },
      principalId: { before: null, after: targetMemberId },
      principalType: { before: null, after: 'WORKSPACE_MEMBER' },
      accessLevel: { before: null, after: 'READ' },
      rowCause: { before: null, after: 'MANUAL' },
      sourceId: { before: null, after: recordId },
    });

    // 2. Idempotent repeat with same accessLevel produces 0 new audit rows
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordShare(
        target,
        { workspaceMemberId: targetMemberId },
        RecordShareAccessLevel.READ,
      ),
    );
    expect(await readAuditRows()).toHaveLength(1);

    // 3. Updating accessLevel READ -> READ_WRITE keeps same row id and records clean update
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordShare(
        target,
        { workspaceMemberId: targetMemberId },
        RecordShareAccessLevel.READ_WRITE,
      ),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'update',
      resourceKind: 'recordShare',
      resourceId: createdShareId,
    });
    expect(audits[1].redactedDiff.values).toEqual({
      accessLevel: { before: 'READ', after: 'READ_WRITE' },
    });

    // 4. removeRecordShare deletes row and audits delete
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.removeRecordShare(target, {
        workspaceMemberId: targetMemberId,
      }),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      action: 'delete',
      resourceKind: 'recordShare',
      resourceId: createdShareId,
    });

    // 5. Replacing a legacy shareWith MANUAL row (sourceId = actorMemberId !== recordId) succeeds
    const shareWithRowId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$5)`,
      [shareWithRowId, recordId, objectMetadataId, targetMemberId, actorMemberId],
    );
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordShare(
        target,
        { workspaceMemberId: targetMemberId },
        RecordShareAccessLevel.FULL,
      ),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(5);
    expect(audits.slice(3).map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['delete', 'create']),
    );
    expect(audits[3].operationId).toBe(audits[4].operationId);

    // 6. setRecordGeneralAccess(NONE) creates EVERYONE/MANUAL + OWNER/FULL under one operationId
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordGeneralAccess(
        target,
        RecordShareAccessLevel.NONE,
      ),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(7);
    const restrictAudits = audits.slice(5);
    expect(restrictAudits[0].operationId).toBe(restrictAudits[1].operationId);
    expect(
      restrictAudits.map(
        (a: { redactedDiff: { values: { rowCause: { after: string } } } }) =>
          a.redactedDiff.values.rowCause.after,
      ),
    ).toEqual(expect.arrayContaining(['MANUAL', 'OWNER']));

    // Returning to default general access (READ_WRITE) removes both under one operationId
    await withWorkspaceAuthContext(auth, () =>
      sharingResolver.setRecordGeneralAccess(
        target,
        RecordShareAccessLevel.READ_WRITE,
      ),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(9);
    expect(audits[7].operationId).toBe(audits[8].operationId);
    expect(audits[7].action).toBe('delete');
    expect(audits[8].action).toBe('delete');

    // 7. ShareRecordTool with agentId attributes actor: agent, initiator: workspaceMember
    const toolOut = await shareTool.execute(
      {
        objectNameSingular: 'company',
        recordId,
        roleId,
        accessLevel: RecordShareAccessLevel.READ,
      },
      { workspaceId, authContext: auth, agentId },
    );
    expect(toolOut.success).toBe(true);
    audits = await readAuditRows();
    expect(audits).toHaveLength(10);
    expect(audits[9]).toMatchObject({
      actor: { kind: 'agent', id: agentId },
      initiator: { kind: 'workspaceMember', id: actorMemberId },
      action: 'create',
      resourceKind: 'recordShare',
    });

    // ShareRecordTool rejects workspace mismatch
    const mismatchOut = await shareTool.execute(
      {
        objectNameSingular: 'company',
        recordId,
        roleId,
        accessLevel: RecordShareAccessLevel.READ,
      },
      { workspaceId: randomUUID(), authContext: auth, agentId },
    );
    expect(mismatchOut.success).toBe(false);
    expect(mismatchOut.error).toContain('workspace mismatch');

    // 8. OAuth/App-with-user authContext attributes actor: application, initiator: workspaceMember
    const appAuth = buildAuthContext({
      application: { id: applicationId } as never,
    });
    await withWorkspaceAuthContext(appAuth, () =>
      sharingResolver.setRecordShare(
        target,
        { roleId },
        RecordShareAccessLevel.READ_WRITE,
      ),
    );
    audits = await readAuditRows();
    expect(audits).toHaveLength(11);
    expect(audits[10]).toMatchObject({
      actor: { kind: 'application', id: applicationId },
      initiator: { kind: 'workspaceMember', id: actorMemberId },
      action: 'update',
    });
  });

  it('audits RecordShareOwnershipTransferService (create FULL, raise custodian READ with distinct sourceId, delete departing, no-custodian, SAVEPOINT resilience)', async () => {
    const { ownershipTransferService } = createHarness();
    const auditOp = {
      workspaceId,
      operationId: randomUUID().toLowerCase(),
      actor: { kind: 'coreUser' as const, id: actorUserId },
      correlationId: randomUUID().toLowerCase(),
    };

    // Departing member holds:
    // - FULL MANUAL on recordId (with sourceId = actorMemberId from shareWith)
    // - FULL OWNER on recordId2 (custodian already holds READ MANUAL with sourceId = recordId2, plus another FULL MANUAL on recordId2 where custodian has READ MANUAL)
    // - READ MANUAL on recordId2 (should only be deleted, not transferred)
    const fromFullRec1 = randomUUID().toLowerCase();
    const fromFullRec2 = randomUUID().toLowerCase();
    const custodianReadRec2 = randomUUID().toLowerCase();
    const fromOwnerRec2 = randomUUID().toLowerCase();

    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES
        ($1,$2,$3,$4,'WORKSPACE_MEMBER','FULL','MANUAL',$5),
        ($6,$7,$3,$4,'WORKSPACE_MEMBER','FULL','MANUAL',$5),
        ($8,$7,$3,$9,'WORKSPACE_MEMBER','READ','MANUAL',$7),
        ($10,$7,$3,$4,'WORKSPACE_MEMBER','FULL','OWNER',$7)`,
      [
        fromFullRec1,
        recordId,
        objectMetadataId,
        targetMemberId,
        actorMemberId,
        fromFullRec2,
        recordId2,
        custodianReadRec2,
        custodianMemberId,
        fromOwnerRec2,
      ],
    );

    await ownershipTransferService.transferRecordSharesToCustodian({
      removedUserWorkspace: { id: randomUUID(), workspaceId } as never,
      removedWorkspaceMemberId: targetMemberId,
      actingUserWorkspaceId: actorUserWorkspaceId,
      auditOperation: auditOp,
    });

    const audits = await readAuditRows();
    // Expect: 3 creates for custodian (MANUAL recordId + MANUAL recordId2 + OWNER recordId2),
    // 1 update raising custodianReadRec2 (sourceId=recordId2) READ -> FULL,
    // 3 deletes of departing member's grants
    expect(audits).toHaveLength(7);
    const opIds = new Set(audits.map((a: { operationId: string }) => a.operationId));
    expect(opIds.size).toBe(1);
    expect(audits[0].operationId).not.toBe(auditOp.operationId);
    expect(
      audits.filter((a: { action: string }) => a.action === 'create'),
    ).toHaveLength(3);
    expect(
      audits.filter((a: { action: string }) => a.action === 'update'),
    ).toHaveLength(1);
    expect(
      audits.filter((a: { action: string }) => a.action === 'delete'),
    ).toHaveLength(3);

    // No-custodian path deletes departing grants and audits deletes
    await ownerDataSource.query(
      `DELETE FROM crm_audit."crmAuditEntry";
       DELETE FROM "${workspaceSchema}"."recordShare";`,
    );
    const loneGrantId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','FULL','OWNER',$2)`,
      [loneGrantId, recordId, objectMetadataId, targetMemberId],
    );
    const noCustodianHarness = createHarness({ custodianUserWorkspace: null });
    await noCustodianHarness.ownershipTransferService.transferRecordSharesToCustodian(
      {
        removedUserWorkspace: { id: randomUUID(), workspaceId } as never,
        removedWorkspaceMemberId: targetMemberId,
        auditOperation: auditOp,
      },
    );
    const noCustAudits = await readAuditRows();
    expect(noCustAudits).toHaveLength(1);
    expect(noCustAudits[0]).toMatchObject({
      action: 'delete',
      resourceKind: 'recordShare',
      resourceId: loneGrantId,
    });

    // Fail-closed on workspace mismatch even when workspace has 0 transferable objects
    const emptyObjectsHarness = createHarness({ transferableObjects: false });
    await expect(
      emptyObjectsHarness.ownershipTransferService.transferRecordSharesToCustodian(
        {
          removedUserWorkspace: { id: randomUUID(), workspaceId } as never,
          removedWorkspaceMemberId: targetMemberId,
          auditOperation: { ...auditOp, workspaceId: randomUUID() },
        },
      ),
    ).rejects.toThrow('Record share transfer audit workspace mismatch');

    // Fail-closed on self-transfer (from === to)
    await expect(
      ownershipTransferService.transferRecordSharesToCustodian({
        removedUserWorkspace: { id: randomUUID(), workspaceId } as never,
        removedWorkspaceMemberId: custodianMemberId,
        auditOperation: auditOp,
      }),
    ).rejects.toThrow(
      'Record share ownership transfer cannot target the departing member',
    );

    // SAVEPOINT resilience in offboarding: audit flush failure still completes member grant transfer
    await ownerDataSource.query(
      `DELETE FROM crm_audit."crmAuditEntry";
       DELETE FROM "${workspaceSchema}"."recordShare";`,
    );
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','FULL','MANUAL',$2)`,
      [randomUUID().toLowerCase(), recordId, objectMetadataId, targetMemberId],
    );
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_rs_transfer_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' THEN
          RAISE EXCEPTION 'simulated transfer audit outage';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_rs_transfer_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_rs_transfer_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_rs_transfer_audit();
    `);
    try {
      await ownershipTransferService.transferRecordSharesToCustodian({
        removedUserWorkspace: { id: randomUUID(), workspaceId } as never,
        removedWorkspaceMemberId: targetMemberId,
        auditOperation: auditOp,
      });
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_rs_transfer_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_rs_transfer_audit();`,
      );
    }
    const postOutageShares = await readRecordShareRows();
    expect(postOutageShares).toHaveLength(1);
    expect(postOutageShares[0].principalId).toBe(custodianMemberId);
    expect(await readAuditRows()).toHaveLength(0);
  });

  it('enforces identity conflicts, soft-deleted row rejection, unauthorized rowCause guards, single-use capture, and strict transaction requirement', async () => {
    const auth = buildAuthContext();

    // Conflicting application vs viaApplication
    expect(() =>
      captureRecordShareAudit({
        workspaceId,
        authContext: buildAuthContext({
          application: { id: randomUUID() } as never,
          viaApplication: { id: randomUUID() } as never,
        }),
      }),
    ).toThrow('Conflicting application identifiers in record share auth');

    // Conflicting arg agentId vs authContext.agentId
    expect(() =>
      captureRecordShareAudit({
        workspaceId,
        authContext: buildAuthContext({ agentId: randomUUID() }),
        agentId: randomUUID(),
      }),
    ).toThrow('Conflicting agentId in record share auth');

    // Impersonation combined with agentId fails closed
    expect(() =>
      captureRecordShareAudit({
        workspaceId,
        authContext: auth,
        agentId,
        requestContext: { impersonatorUserWorkspaceId },
      }),
    ).toThrow(
      'Record share audit impersonation cannot combine with agent or application',
    );

    // Conflicting requestContext vs ALS impersonator fails closed
    withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        impersonationContext: { impersonatorUserWorkspaceId: randomUUID() },
      }),
      () => {
        expect(() =>
          captureRecordShareAudit({
            workspaceId,
            authContext: auth,
            requestContext: { impersonatorUserWorkspaceId },
          }),
        ).toThrow('Record share audit impersonation context conflict');
      },
    );

    // Resolved ALS identity preserves impersonation initiator and rejects conflicting ambient user
    withCrmAuditIdentity(
      workspaceId,
      {
        workspaceId,
        actor: { kind: 'coreUser', id: actorUserId },
        initiator: { kind: 'coreUser', id: impersonatorUserId },
        correlationId: randomUUID(),
      },
      () => {
        const resolvedCapture = captureRecordShareAudit({
          workspaceId,
          authContext: auth,
        });
        expect(resolvedCapture.operation.actor).toEqual({
          kind: 'workspaceMember',
          id: actorMemberId,
        });
        expect(resolvedCapture.operation.initiator).toEqual({
          kind: 'coreUser',
          id: impersonatorUserId,
        });
      },
    );
    withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: randomUUID() },
      }),
      () => {
        expect(() =>
          captureRecordShareAudit({
            workspaceId,
            authContext: auth,
          }),
        ).toThrow('Record share audit ambient user conflict');
      },
    );

    // Legacy (non-strict) transaction fails closed
    const legacyHarness = createHarness({ forceLegacyTransaction: true });
    await expect(
      legacyHarness.sharingService.setShare({
        objectMetadataId,
        recordId,
        principal: { workspaceMemberId: targetMemberId },
        accessLevel: RecordShareAccessLevel.READ,
        authContext: auth,
      }),
    ).rejects.toThrow('Audit requires a strict workspace transaction lifecycle');

    // Soft-deleted recordShare row fails closed
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$2,now())`,
      [randomUUID().toLowerCase(), recordId, objectMetadataId, targetMemberId],
    );
    const { sharingService, workspaceOrmManager } = createHarness();
    await expect(
      sharingService.setShare({
        objectMetadataId,
        recordId,
        principal: { workspaceMemberId: targetMemberId },
        accessLevel: RecordShareAccessLevel.READ_WRITE,
        authContext: auth,
      }),
    ).rejects.toThrow('Record share audit detected soft-deleted recordShare row');

    await ownerDataSource.query(`DELETE FROM "${workspaceSchema}"."recordShare"`);

    // Unauthorized mutation of APPLICATION row inside manualPrincipal scope fails closed, and single-use capture cannot be reused
    const capture = captureRecordShareAudit({
      workspaceId,
      authContext: auth,
    });
    const appGrantId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'ROLE','READ','APPLICATION',$2)`,
      [appGrantId, recordId, objectMetadataId, roleId],
    );
    await expect(
      workspaceOrmManager.runInWorkspaceTransaction(
        async (scope: unknown) => {
          const prepared = await beginRecordShareAuditTransaction(
            scope as never,
            capture,
          );
          await runAuditedRecordShareScopeMutation(
            prepared,
            {
              objectMetadataId,
              recordId,
              expectedScope: {
                kind: 'manualPrincipal',
                mode: 'set',
                principalId: targetMemberId,
                principalType: 'WORKSPACE_MEMBER',
                accessLevel: 'READ',
              },
            },
            async () => {
              await (
                scope as {
                  executeRawQuery: (s: string, p?: unknown[]) => Promise<unknown>;
                }
              ).executeRawQuery(
                `DELETE FROM "${workspaceSchema}"."recordShare" WHERE id = $1`,
                [appGrantId],
              );
            },
          );
        },
        { commitOutcome: 'strict' },
      ),
    ).rejects.toThrow(
      'Record share mutation touched unexpected principal or rowCause',
    );

    // Access level escalation inside manualPrincipal write fails closed
    const escalationCapture = captureRecordShareAudit({
      workspaceId,
      authContext: auth,
    });
    await expect(
      workspaceOrmManager.runInWorkspaceTransaction(
        async (scope: unknown) => {
          const prepared = await beginRecordShareAuditTransaction(
            scope as never,
            escalationCapture,
          );
          await runAuditedRecordShareScopeMutation(
            prepared,
            {
              objectMetadataId,
              recordId,
              expectedScope: {
                kind: 'manualPrincipal',
                mode: 'set',
                principalId: targetMemberId,
                principalType: 'WORKSPACE_MEMBER',
                accessLevel: 'READ',
              },
            },
            async () => {
              await (
                scope as {
                  executeRawQuery: (s: string, p?: unknown[]) => Promise<unknown>;
                }
              ).executeRawQuery(
                `INSERT INTO "${workspaceSchema}"."recordShare"
                   (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
                 VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','FULL','MANUAL',$2)`,
                [randomUUID(), recordId, objectMetadataId, targetMemberId],
              );
            },
          );
        },
        { commitOutcome: 'strict' },
      ),
    ).rejects.toThrow(
      'Record share manual write persisted unexpected accessLevel',
    );

    // Reusing the same capture fails closed
    await expect(
      workspaceOrmManager.runInWorkspaceTransaction(
        async (scope: unknown) => {
          await beginRecordShareAuditTransaction(scope as never, capture);
        },
        { commitOutcome: 'strict' },
      ),
    ).rejects.toThrow('Record share audit capture is invalid or reused');
  });

  it('rolls back public setRecordShare on audit flush failure and on post-flush row drift', async () => {
    const { sharingService } = createHarness();
    const auth = buildAuthContext();

    // 1. Audit flush failure rolls back recordShare write completely
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_rs_public_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' THEN
          RAISE EXCEPTION 'simulated recordShare audit flush failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_rs_public_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_rs_public_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_rs_public_audit();
    `);
    try {
      await expect(
        sharingService.setShare({
          objectMetadataId,
          recordId,
          principal: { workspaceMemberId: targetMemberId },
          accessLevel: RecordShareAccessLevel.READ,
          authContext: auth,
        }),
      ).rejects.toThrow('simulated recordShare audit flush failure');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_rs_public_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_rs_public_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);

    // 2. Post-flush row drift rolls back both recordShare and audit entry
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.drift_rs_after_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' AND NEW.action = 'create' THEN
          UPDATE "${workspaceSchema}"."recordShare"
             SET "accessLevel" = 'FULL'
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_drift_rs_after_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_drift_rs_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.drift_rs_after_audit();
    `);
    try {
      await expect(
        sharingService.setShare({
          objectMetadataId,
          recordId,
          principal: { workspaceMemberId: targetMemberId },
          accessLevel: RecordShareAccessLevel.READ,
          authContext: auth,
        }),
      ).rejects.toThrow('Record share audit detected post-flush row drift');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_drift_rs_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.drift_rs_after_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
  });
});
