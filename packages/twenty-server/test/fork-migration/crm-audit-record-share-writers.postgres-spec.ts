import { randomUUID } from 'node:crypto';
import { EVERYONE_PRINCIPAL_ID } from 'twenty-shared/constants';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  RecordShareAccessLevel,
  RecordSharePrincipalType,
  RecordShareRowCause,
  WorkflowVisibility,
} from 'twenty-shared/types';
import { DataSource, type FindOperator, type QueryRunner } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { assertNativeCrmAuditWriteSupported } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  getNativeCrmAuditContext,
  isDelegatedRecordShareAuditWrite,
  isStandaloneShareWithScope,
  runInStandaloneShareWithScope,
  withNativeCrmAuditTransaction,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import {
  runAuditedShareWithInsert,
  runAuditedWorkflowRunShareSync,
} from 'src/engine/core-modules/crm-audit/record-share-audit';
import { RecordSharingMode } from 'src/engine/core-modules/record-share/enums/record-sharing-mode.enum';
import { validateShareWithArgOrThrow } from 'src/engine/core-modules/record-share/utils/validate-share-with-arg-or-throw.util';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { SyncWorkflowRunSharesDeferredActionHandlerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/sync-workflow-run-shares-deferred-action-handler.service';

for (const [modPath, names] of [
  [
    'src/engine/core-modules/cache-lock/cache-lock.service',
    ['CacheLockService'],
  ],
  [
    'src/engine/core-modules/record-share/services/record-share-principal.service',
    ['RecordSharePrincipalService'],
  ],
  [
    'src/engine/core-modules/workflow/entities/workflow.entity',
    ['WorkflowEntity'],
  ],
  [
    'src/engine/twenty-orm/workspace-orm.manager',
    ['WorkspaceOrmManager'],
  ],
  [
    'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
    ['InjectWorkspaceScopedRepository'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
] as const) {
  jest.mock(modPath, () => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (name === 'InjectWorkspaceScopedRepository') {
        out[name] = () => () => {};
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
const { ShareWithService } =
  require('src/engine/core-modules/record-share/services/share-with.service') as typeof import('src/engine/core-modules/record-share/services/share-with.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WorkflowRunRecordShareService } =
  require('src/engine/core-modules/workflow/services/workflow-run-record-share.service') as typeof import('src/engine/core-modules/workflow/services/workflow-run-record-share.service');

const ownerUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !ownerUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(ownerUrl).pathname)
) {
  throw new Error(
    'FORK_MIGRATION_TEST_URL must target an isolated temporary test database',
  );
}
const databaseRole = `rsw_audit_rt_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const runtimeUrl = (() => {
  const parsed = new URL(ownerUrl);
  parsed.username = databaseRole;
  parsed.password = 'isolated-rsw-fixture';
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
const roleId = randomUUID().toLowerCase();
const apiKeyId = randomUUID().toLowerCase();
const applicationId = randomUUID().toLowerCase();
const actingAgentId = randomUUID().toLowerCase();
const customObjectMetadataId = randomUUID().toLowerCase();
const workflowRunObjectMetadataId = randomUUID().toLowerCase();
const coreWorkflowId = randomUUID().toLowerCase();
const workflowRunId1 = randomUUID().toLowerCase();
const workflowRunId2 = randomUUID().toLowerCase();
const recordId1 = randomUUID().toLowerCase();
const recordId2 = randomUUID().toLowerCase();

const ownerDataSource = new DataSource({ type: 'postgres', url: ownerUrl });
const runtimeDataSource = new DataSource({ type: 'postgres', url: runtimeUrl });

const readAuditRows = () =>
  ownerDataSource.query(
    `SELECT id, "operationId", "correlationId", actor, initiator, action,
            "resourceKind", "resourceId", outcome, "redactedDiff", "securityDescriptor"
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

const createHarness = ({
  workflowVisibility = WorkflowVisibility.WORKSPACE,
  workflowCreatorUserWorkspaceId = actorUserWorkspaceId as string | null,
}: {
  workflowVisibility?: WorkflowVisibility;
  workflowCreatorUserWorkspaceId?: string | null;
} = {}) => {
  let currentVisibility = workflowVisibility;
  let currentCreatorUserWorkspaceId = workflowCreatorUserWorkspaceId;

  const workspaceCacheService = {
    getOrRecompute: jest.fn(async () => ({
      flatObjectMetadataMaps: {
        byUniversalIdentifier: {
          [STANDARD_OBJECTS.workflowRun.universalIdentifier]: {
            id: workflowRunObjectMetadataId,
          },
        },
      },
      flatWorkspaceMemberMaps: {
        byId: {
          [actorMemberId]: { id: actorMemberId, userId: actorUserId },
          [targetMemberId]: { id: targetMemberId, userId: randomUUID() },
        },
        idByUserWorkspaceId: {
          [actorUserWorkspaceId]: actorMemberId,
        },
      },
      flatRoleMaps: {
        byUniversalIdentifier: {
          [roleId]: { id: roleId, label: 'Member' },
        },
      },
    })),
  };

  const runStrictTx = async <T>(
    work: (scope: {
      workspaceId: string;
      transactionLifecycle: {
        commitOutcome: 'strict' | 'legacy';
        readonly isTransactionActive: boolean;
        readonly isReleased: boolean;
      };
      executeRawQuery: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
      getRepository: (name: string) => unknown;
    }) => Promise<T>,
    commitOutcome: 'strict' | 'legacy' = 'strict',
  ): Promise<T> => {
    const qr: QueryRunner = runtimeDataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let active = true;
    let released = false;
    const runQuery = (sql: string, params?: unknown[]) =>
      qr.query(sql, params) as Promise<Record<string, unknown>[]>;
    const scope = {
      workspaceId,
      transactionLifecycle: {
        commitOutcome,
        get isTransactionActive() {
          return active;
        },
        get isReleased() {
          return released;
        },
      },
      executeRawQuery: runQuery,
      getRepository: (name: string) => {
        if (name === 'recordShare') {
          return createSqlRecordShareRepo(runQuery);
        }
        return {
          find: async () =>
            runQuery(
              `SELECT id, "coreWorkflowId" FROM "${workspaceSchema}"."workflowRun" ORDER BY id ASC`,
            ),
        };
      },
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
  };

  const workspaceOrmManager = {
    executeInWorkspaceContext: jest.fn(async <T>(fn: () => Promise<T>) => fn()),
    runInWorkspaceTransaction: jest.fn(
      async <T>(
        work: (scope: unknown) => Promise<T>,
        options?: { commitOutcome?: 'strict' | 'legacy' },
      ) => runStrictTx(work as never, options?.commitOutcome ?? 'legacy'),
    ),
    getRepository: jest.fn((name: string) => {
      const runQuery = (sql: string, params?: unknown[]) =>
        runtimeDataSource.query(sql, params);
      if (name === 'recordShare') {
        return createSqlRecordShareRepo(runQuery);
      }
      if (name === 'workspaceMember') {
        return {
          findOne: async ({ where }: { where: { userId: string } }) =>
            where.userId === actorUserId ? { id: actorMemberId } : null,
        };
      }
      return {
        find: async ({ where }: { where?: { coreWorkflowId?: string; id?: FindOperator<string[]> } }) => {
          if (where?.coreWorkflowId) {
            return runQuery(
              `SELECT id, "coreWorkflowId" FROM "${workspaceSchema}"."workflowRun" WHERE "coreWorkflowId" = $1 ORDER BY id ASC`,
              [where.coreWorkflowId],
            );
          }
          if (where?.id && 'value' in where.id) {
            return runQuery(
              `SELECT id, "coreWorkflowId" FROM "${workspaceSchema}"."workflowRun" WHERE id = ANY($1::uuid[]) ORDER BY id ASC`,
              [where.id.value],
            );
          }
          return runQuery(
            `SELECT id, "coreWorkflowId" FROM "${workspaceSchema}"."workflowRun" ORDER BY id ASC`,
          );
        },
      };
    }),
  };

  const storageService = new RecordShareStorageService(
    workspaceOrmManager as never,
  );
  const principalService = {
    assertPrincipalsReachRecordsOrThrow: jest.fn().mockResolvedValue(undefined),
  };
  const shareWithService = new ShareWithService(
    storageService,
    principalService as never,
    workspaceCacheService as never,
  );

  const coreWorkflowRepository = {
    findOne: jest.fn(async () => ({
      id: coreWorkflowId,
      visibility: currentVisibility,
      createdByUserWorkspaceId: currentCreatorUserWorkspaceId,
    })),
    find: jest.fn(async () => [{ id: coreWorkflowId }]),
    manager: {
      query: async (sql: string, params?: unknown[]) =>
        runtimeDataSource.query(sql, params),
    },
  };
  const cacheLockService = {
    withLock: jest.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
  const workflowRunRecordShareService = new WorkflowRunRecordShareService(
    coreWorkflowRepository as never,
    workspaceOrmManager as never,
    workspaceCacheService as never,
    storageService,
    cacheLockService as never,
  );

  return {
    storageService,
    shareWithService,
    workflowRunRecordShareService,
    runStrictTx,
    setWorkflowAccess: (
      visibility: WorkflowVisibility,
      creatorUserWorkspaceId: string | null = currentCreatorUserWorkspaceId,
    ) => {
      currentVisibility = visibility;
      currentCreatorUserWorkspaceId = creatorUserWorkspaceId;
    },
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
     CREATE TABLE core.workflow (
       id uuid PRIMARY KEY,
       "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE
     );
     CREATE TABLE "${workspaceSchema}"."workflowRun" (
       id uuid PRIMARY KEY,
       "coreWorkflowId" uuid NULL
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
     CREATE UNIQUE INDEX "IDX_record_share_writers_unique"
       ON "${workspaceSchema}"."recordShare"
       ("objectMetadataId", "recordId", "principalId", "rowCause", "sourceId");`,
  );

  await ownerDataSource.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await ownerDataSource.query(
    `CREATE ROLE "${databaseRole}" LOGIN PASSWORD 'isolated-rsw-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
     GRANT USAGE ON SCHEMA core, crm_audit, "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, UPDATE ON core.workspace TO "${databaseRole}";
     GRANT SELECT ON core."user", core."userWorkspace", core.workflow TO "${databaseRole}";
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${workspaceSchema}" TO "${databaseRole}";
     GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${databaseRole}";`,
  );
  await runtimeDataSource.initialize();

  await ownerDataSource.query(`INSERT INTO core.workspace (id) VALUES ($1)`, [
    workspaceId,
  ]);
  await ownerDataSource.query(
    `INSERT INTO core."user" (id, email) VALUES ($1, 'actor@example.com'), ($2, 'admin@example.com')`,
    [actorUserId, impersonatorUserId],
  );
  await ownerDataSource.query(
    `INSERT INTO core."userWorkspace" (id, "workspaceId", "userId") VALUES ($1,$2,$3), ($4,$2,$5)`,
    [
      actorUserWorkspaceId,
      workspaceId,
      actorUserId,
      impersonatorUserWorkspaceId,
      impersonatorUserId,
    ],
  );
  await ownerDataSource.query(
    `INSERT INTO core.workflow (id, "workspaceId") VALUES ($1, $2)`,
    [coreWorkflowId, workspaceId],
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
     DELETE FROM "${workspaceSchema}"."workflowRun";`,
  );
  await ownerDataSource.query(
    `INSERT INTO "${workspaceSchema}"."workflowRun" (id, "coreWorkflowId") VALUES ($1, $3), ($2, $3)`,
    [workflowRunId1, workflowRunId2, coreWorkflowId],
  );
});

describe('recordShare writers CRM audit (LOG-200)', () => {
  it('audits ShareWithService both inside withNativeCrmAuditTransaction (single operationId) and in standalone strict transactions across user/impersonation, application/actingAgent, apiKey (uppercase roleId), and system', async () => {
    const { shareWithService, runStrictTx } = createHarness();
    const userAuth = {
      type: 'user' as const,
      workspace: { id: workspaceId },
      user: { id: actorUserId },
      userWorkspaceId: actorUserWorkspaceId,
      workspaceMemberId: actorMemberId,
      workspaceMember: { id: actorMemberId, userId: actorUserId },
    };

    // 1. Branch A: inside withNativeCrmAuditTransaction with pre-existing orphan share on reused recordId1
    // Also exercises real assertNativeCrmAuditWriteSupported + getNativeCrmAuditContext during delegated recordShare write (B-1)
    const orphanId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$2)`,
      [orphanId, recordId1, customObjectMetadataId, targetMemberId],
    );
    const nativeOpId = randomUUID().toLowerCase();
    const recordShareObjId = randomUUID().toLowerCase();
    const standardAppUid = '20202020-64aa-4b6f-b003-9c74b97cee20';
    const recordShareMeta = {
      id: recordShareObjId,
      workspaceId,
      nameSingular: 'recordShare',
      universalIdentifier: randomUUID().toLowerCase(),
      applicationUniversalIdentifier: standardAppUid,
      isSystem: true,
      isRemote: false,
    };
    const recordShareShape = {
      objectMetadataId: recordShareObjId,
      nameSingular: 'recordShare',
      schemaName: workspaceSchema,
      tableName: 'recordShare',
      columnShapeByColumnName: {},
    };
    const otherSystemMeta = {
      ...recordShareMeta,
      id: workflowRunObjectMetadataId,
      nameSingular: 'workflowRun',
    };
    const otherSystemShape = {
      ...recordShareShape,
      objectMetadataId: workflowRunObjectMetadataId,
      nameSingular: 'workflowRun',
      tableName: 'workflowRun',
    };
    let delegatedAssertChecked = false;
    await runStrictTx(async (scope) => {
      const executorToken = { execute: async () => [] };
      const origGetRepo = scope.getRepository;
      scope.getRepository = (name: string) => {
        const repo = origGetRepo(name) as Record<string, (...args: unknown[]) => Promise<unknown>>;
        if (name !== 'recordShare') {
          return repo;
        }
        return {
          ...repo,
          insert: async (...args: unknown[]) => {
            expect(isDelegatedRecordShareAuditWrite(executorToken, 'recordShare')).toBe(true);
            expect(getNativeCrmAuditContext(executorToken, 'recordShare')).toBeUndefined();
            expect(getNativeCrmAuditContext(executorToken, 'company')).toBeDefined();
            // Delegated recordShare write bypasses native workspace-repository guard
            expect(() =>
              assertNativeCrmAuditWriteSupported(
                executorToken,
                recordShareShape,
                recordShareMeta,
                workspaceId,
                'create',
                {},
              ),
            ).not.toThrow();
            // Other system objects are STILL rejected by native audit guard
            expect(() =>
              assertNativeCrmAuditWriteSupported(
                executorToken,
                otherSystemShape,
                otherSystemMeta,
                workspaceId,
                'create',
                {},
              ),
            ).toThrow('Native audit coverage excludes this object or mutation');
            delegatedAssertChecked = true;
            return repo.insert(...args);
          },
        };
      };
      await withNativeCrmAuditTransaction(
        executorToken,
        scope,
        {
          workspaceId,
          operationId: nativeOpId,
          actor: { kind: 'workspaceMember', id: actorMemberId },
        },
        async () => {
          await shareWithService.insertRecordSharesForCreatedRecords({
            authContext: userAuth as never,
            flatObjectMetadata: { id: customObjectMetadataId } as never,
            objectSharing: {
              sharingMode: RecordSharingMode.PRIVATE,
              canShareBeyondRole: false,
              operationTypesGrantedBeyondRole: [],
            },
            recordIds: [recordId1],
            apiKeyRoleMap: {},
            shareWith: [
              {
                workspaceMemberId: targetMemberId,
                accessLevel: RecordShareAccessLevel.READ_WRITE,
              },
            ],
            transactionScope: scope as never,
          });
          expect(isDelegatedRecordShareAuditWrite(executorToken, 'recordShare')).toBe(false);
        },
      );
    });
    expect(delegatedAssertChecked).toBe(true);

    let audits = await readAuditRows();
    // Expect 1 delete (orphanId) + 2 creates (OWNER actorMemberId + MANUAL targetMemberId), all under nativeOpId
    expect(audits).toHaveLength(3);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)),
    ).toEqual(new Set([nativeOpId]));
    expect(
      audits.filter((a: { action: string }) => a.action === 'delete'),
    ).toHaveLength(1);
    expect(
      audits.filter((a: { action: string }) => a.action === 'create'),
    ).toHaveLength(2);

    // 2. Branch B: standalone strict transaction with user impersonation via ALS, two calls sharing correlationId, plus conflict guard with withNativeCrmAuditTransaction (m-1)
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const nestedRecordId = randomUUID().toLowerCase();
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        impersonationContext: { impersonatorUserWorkspaceId },
      }),
      () =>
        runStrictTx(async (scope) => {
          await runInStandaloneShareWithScope(scope, async () => {
            expect(isStandaloneShareWithScope(scope)).toBe(true);
            await expect(
              withNativeCrmAuditTransaction(
                {},
                scope,
                {
                  workspaceId,
                  operationId: randomUUID(),
                  actor: { kind: 'workspaceMember', id: actorMemberId },
                },
                async () => undefined,
              ),
            ).rejects.toThrow('Native audit owner already exists');
            await shareWithService.insertRecordSharesForCreatedRecords({
              authContext: userAuth as never,
              flatObjectMetadata: { id: customObjectMetadataId } as never,
              objectSharing: {
                sharingMode: RecordSharingMode.PRIVATE,
                canShareBeyondRole: false,
                operationTypesGrantedBeyondRole: [],
              },
              recordIds: [recordId2],
              apiKeyRoleMap: {},
              shareWith: [
                {
                  workspaceMemberId: targetMemberId,
                  accessLevel: RecordShareAccessLevel.READ,
                },
              ],
              transactionScope: scope as never,
            });
            await shareWithService.insertRecordSharesForCreatedRecords({
              authContext: userAuth as never,
              flatObjectMetadata: { id: customObjectMetadataId } as never,
              objectSharing: {
                sharingMode: RecordSharingMode.PRIVATE,
                canShareBeyondRole: false,
                operationTypesGrantedBeyondRole: [],
              },
              recordIds: [nestedRecordId],
              apiKeyRoleMap: {},
              shareWith: [
                {
                  workspaceMemberId: targetMemberId,
                  accessLevel: RecordShareAccessLevel.READ,
                },
              ],
              transactionScope: scope as never,
            });
          });
          expect(isStandaloneShareWithScope(scope)).toBe(false);
        }),
    );

    audits = await readAuditRows();
    expect(audits).toHaveLength(4);
    expect(
      new Set(audits.map((a: { correlationId: string }) => a.correlationId)).size,
    ).toBe(1);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)).size,
    ).toBe(2);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      action: 'create',
      resourceKind: 'recordShare',
    });

    // 3. Branch B: apiKey with uppercase roleId matching creatorRoleId (M4 case-insensitive dedup)
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const recordId3 = randomUUID().toLowerCase();
    await runStrictTx(async (scope) => {
      await shareWithService.insertRecordSharesForCreatedRecords({
        authContext: {
          type: 'apiKey',
          workspace: { id: workspaceId },
          apiKey: { id: apiKeyId },
        } as never,
        flatObjectMetadata: { id: customObjectMetadataId } as never,
        objectSharing: {
          sharingMode: RecordSharingMode.PRIVATE,
          canShareBeyondRole: false,
          operationTypesGrantedBeyondRole: [],
        },
        recordIds: [recordId3],
        apiKeyRoleMap: { [apiKeyId]: roleId },
        shareWith: [
          {
            roleId: roleId.toUpperCase(),
            accessLevel: RecordShareAccessLevel.READ,
          },
        ],
        transactionScope: scope as never,
      });
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'apiKey', id: apiKeyId },
      action: 'create',
      redactedDiff: {
        values: expect.objectContaining({
          principalId: { before: null, after: roleId },
          accessLevel: { before: null, after: 'FULL' },
        }),
      },
    });

    // 4. Branch B: application with actingAgent
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const recordId4 = randomUUID().toLowerCase();
    await runStrictTx(async (scope) => {
      await shareWithService.insertRecordSharesForCreatedRecords({
        authContext: {
          type: 'application',
          workspace: { id: workspaceId },
          application: { id: applicationId, defaultRoleId: roleId },
          actingAgent: { id: actingAgentId },
        } as never,
        flatObjectMetadata: { id: customObjectMetadataId } as never,
        objectSharing: {
          sharingMode: RecordSharingMode.PRIVATE,
          canShareBeyondRole: false,
          operationTypesGrantedBeyondRole: [],
        },
        recordIds: [recordId4],
        apiKeyRoleMap: {},
        shareWith: [
          {
            workspaceMemberId: targetMemberId,
            accessLevel: RecordShareAccessLevel.READ,
          },
        ],
        transactionScope: scope as never,
      });
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'agent', id: actingAgentId },
      initiator: { kind: 'application', id: applicationId },
    });

    // 5. Branch B: system authContext
    await ownerDataSource.query(`DELETE FROM crm_audit."crmAuditEntry"`);
    const recordId5 = randomUUID().toLowerCase();
    await runStrictTx(async (scope) => {
      await shareWithService.insertRecordSharesForCreatedRecords({
        authContext: {
          type: 'system',
          workspace: { id: workspaceId },
        } as never,
        flatObjectMetadata: { id: customObjectMetadataId } as never,
        objectSharing: {
          sharingMode: RecordSharingMode.PRIVATE,
          canShareBeyondRole: false,
          operationTypesGrantedBeyondRole: [],
        },
        recordIds: [recordId5],
        apiKeyRoleMap: {},
        shareWith: [
          {
            workspaceMemberId: targetMemberId,
            accessLevel: RecordShareAccessLevel.READ,
          },
        ],
        transactionScope: scope as never,
      });
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'system', id: 'share_with_create' },
      action: 'create',
      resourceKind: 'recordShare',
    });
  });

  it('audits WorkflowRunRecordShareService with impersonator resolution, idempotent no-op, visibility downgrade preserving unmanaged MANUAL grants, and deferred handler attribution', async () => {
    const { workflowRunRecordShareService, setWorkflowAccess } = createHarness({
      workflowVisibility: WorkflowVisibility.WORKSPACE,
      workflowCreatorUserWorkspaceId: actorUserWorkspaceId,
    });

    // Seed an unmanaged MANUAL grant (sourceId !== workflowRunId) and a stale APPLICATION grant on workflowRunId1
    const unmanagedManualId = randomUUID().toLowerCase();
    const staleAppGrantId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES
        ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$5),
        ($6,$2,$3,$7,'ROLE','FULL','APPLICATION',$8)`,
      [
        unmanagedManualId,
        workflowRunId1,
        workflowRunObjectMetadataId,
        targetMemberId,
        actorMemberId,
        staleAppGrantId,
        roleId,
        applicationId,
      ],
    );

    // 1. updateAccessThenSyncRuns with explicit operation + auditImpersonatorUserWorkspaceId (B3)
    const explicitOp = {
      workspaceId,
      operationId: randomUUID().toLowerCase(),
      actor: { kind: 'workspaceMember' as const, id: actorMemberId },
      correlationId: randomUUID().toLowerCase(),
    };
    await workflowRunRecordShareService.updateAccessThenSyncRuns({
      workspaceId,
      coreWorkflowId,
      auditOperation: explicitOp,
      auditImpersonatorUserWorkspaceId: impersonatorUserWorkspaceId,
      updateAccess: async () => undefined,
    });

    let audits = await readAuditRows();
    // Deletes 1 stale APPLICATION grant + creates 4 grants (EVERYONE/RULE + OWNER for 2 runs)
    expect(audits).toHaveLength(5);
    expect(
      new Set(audits.map((a: { operationId: string }) => a.operationId)),
    ).toEqual(new Set([audits[0].operationId]));
    expect(audits[0].operationId).not.toBe(explicitOp.operationId);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'workspaceMember', id: actorMemberId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      correlationId: explicitOp.correlationId,
    });

    // 2. Idempotent repeat produces 0 new audit rows and preserves row IDs
    const rowsBeforeRepeat = await readRecordShareRows();
    await workflowRunRecordShareService.syncRunsOfCoreWorkflows({
      workspaceId,
      coreWorkflowIds: [coreWorkflowId],
      auditOperation: explicitOp,
    });
    expect(await readAuditRows()).toHaveLength(5);
    expect(await readRecordShareRows()).toEqual(rowsBeforeRepeat);

    // 3. Downgrade WORKSPACE -> PRIVATE deletes ONLY the 2 EVERYONE/RULE grants, preserving OWNER and unmanaged MANUAL
    setWorkflowAccess(WorkflowVisibility.PRIVATE, actorUserWorkspaceId);
    await workflowRunRecordShareService.syncRunsOfCoreWorkflows({
      workspaceId,
      coreWorkflowIds: [coreWorkflowId],
      auditOperation: explicitOp,
    });
    audits = await readAuditRows();
    expect(audits).toHaveLength(7);
    expect(audits.slice(5).map((a: { action: string }) => a.action)).toEqual([
      'delete',
      'delete',
    ]);
    const survivingRows = await readRecordShareRows();
    expect(survivingRows.map((r: { id: string }) => r.id)).toContain(
      unmanagedManualId,
    );
    expect(
      survivingRows.filter(
        (r: { principalId: string }) => r.principalId === EVERYONE_PRINCIPAL_ID,
      ),
    ).toHaveLength(0);

    // 4. SyncWorkflowRunSharesDeferredActionHandlerService uses system:sync_workflow_run_shares and rejects transactional queryRunner
    setWorkflowAccess(WorkflowVisibility.WORKSPACE, actorUserWorkspaceId);
    const handler = new SyncWorkflowRunSharesDeferredActionHandlerService(
      workflowRunRecordShareService,
    );
    const txQr = runtimeDataSource.createQueryRunner();
    await txQr.connect();
    await txQr.startTransaction();
    try {
      await expect(
        handler.execute({
          workspaceId,
          payload: { version: 1, coreWorkflowId },
          queryRunner: txQr,
        }),
      ).rejects.toThrow(
        'Workflow share reconciliation requires non-transactional queryRunner',
      );
    } finally {
      await txQr.rollbackTransaction();
      await txQr.release();
    }

    const nonTxQr = runtimeDataSource.createQueryRunner();
    await nonTxQr.connect();
    try {
      await handler.execute({
        workspaceId,
        payload: { version: 1, coreWorkflowId },
        queryRunner: nonTxQr,
      });
    } finally {
      await nonTxQr.release();
    }
    audits = await readAuditRows();
    expect(audits).toHaveLength(9);
    expect(audits[7]).toMatchObject({
      actor: { kind: 'system', id: 'sync_workflow_run_shares' },
      action: 'create',
    });

    // 5. Early workspace mismatch fails closed even on empty coreWorkflowIds
    await expect(
      workflowRunRecordShareService.syncRunsOfCoreWorkflows({
        workspaceId,
        coreWorkflowIds: [],
        auditOperation: { ...explicitOp, workspaceId: randomUUID() },
      }),
    ).rejects.toThrow('Workflow run share sync audit workspace mismatch');
  });

  it('enforces fail-closed invariants on ShareWithService and WorkflowRunRecordShareService (case-insensitive duplicate shareWith, non-strict tx, soft-deleted rows, unmanaged deletion)', async () => {
    const { runStrictTx } = createHarness();

    // Case-insensitive duplicate principalId in validateShareWithArgOrThrow (M4)
    expect(() =>
      validateShareWithArgOrThrow({
        authContext: {
          type: 'user',
          workspace: { id: workspaceId },
          workspaceMemberId: actorMemberId,
        } as never,
        shareWith: [
          {
            workspaceMemberId: targetMemberId.toLowerCase(),
            accessLevel: RecordShareAccessLevel.READ,
          },
          {
            workspaceMemberId: targetMemberId.toUpperCase(),
            accessLevel: RecordShareAccessLevel.FULL,
          },
        ],
      }),
    ).toThrow('shareWith names the same principal more than once');

    // Non-strict transaction fails closed in runAuditedShareWithInsert
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedShareWithInsert({
          scope,
          workspaceId,
          objectMetadataId: customObjectMetadataId,
          recordIds: [recordId1],
          authContext: {
            type: 'system',
            workspace: { id: workspaceId },
          },
          desiredShares: [],
          execute: async () => undefined,
        });
      }, 'legacy'),
    ).rejects.toThrow('Audit requires a strict workspace transaction lifecycle');

    // Soft-deleted recordShare fails closed in runAuditedWorkflowRunShareSync
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt")
       VALUES ($1,$2,$3,$4,'EVERYONE','FULL','RULE',$2,now())`,
      [
        randomUUID().toLowerCase(),
        workflowRunId1,
        workflowRunObjectMetadataId,
        EVERYONE_PRINCIPAL_ID,
      ],
    );
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedWorkflowRunShareSync({
          scope,
          workspaceId,
          objectMetadataId: workflowRunObjectMetadataId,
          workflowRunIds: [workflowRunId1],
          desiredShares: [],
          execute: async () => undefined,
        });
      }),
    ).rejects.toThrow('Record share audit detected soft-deleted recordShare row');

    await ownerDataSource.query(`DELETE FROM "${workspaceSchema}"."recordShare"`);

    // Deleting an unmanaged MANUAL grant inside execute() fails closed in runAuditedWorkflowRunShareSync
    const unmanagedId = randomUUID().toLowerCase();
    await ownerDataSource.query(
      `INSERT INTO "${workspaceSchema}"."recordShare"
        (id, "recordId", "objectMetadataId", "principalId", "principalType", "accessLevel", "rowCause", "sourceId")
       VALUES ($1,$2,$3,$4,'WORKSPACE_MEMBER','READ','MANUAL',$5)`,
      [
        unmanagedId,
        workflowRunId1,
        workflowRunObjectMetadataId,
        targetMemberId,
        actorMemberId,
      ],
    );
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedWorkflowRunShareSync({
          scope,
          workspaceId,
          objectMetadataId: workflowRunObjectMetadataId,
          workflowRunIds: [workflowRunId1],
          desiredShares: [
            {
              objectMetadataId: workflowRunObjectMetadataId,
              recordId: workflowRunId1,
              principalId: EVERYONE_PRINCIPAL_ID,
              principalType: RecordSharePrincipalType.EVERYONE,
              accessLevel: RecordShareAccessLevel.FULL,
              rowCause: RecordShareRowCause.RULE,
              sourceId: workflowRunId1,
            },
          ],
          execute: async () => {
            await scope.executeRawQuery(
              `DELETE FROM "${workspaceSchema}"."recordShare" WHERE id = $1`,
              [unmanagedId],
            );
          },
        });
      }),
    ).rejects.toThrow('Workflow run share sync deleted unmanaged recordShare row');

    // pendingActivationUser authContext fails closed
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedShareWithInsert({
          scope,
          workspaceId,
          objectMetadataId: customObjectMetadataId,
          recordIds: [recordId1],
          authContext: {
            type: 'pendingActivationUser',
            workspace: { id: workspaceId },
          },
          desiredShares: [],
          execute: async () => undefined,
        });
      }),
    ).rejects.toThrow(
      'Record share create audit unsupported authContext type pendingActivationUser',
    );

    // M-1: ambient initiator conflict rejected for application (OAuth user initiator) and Branch A two-way initiator check
    await withCrmAuditRequest(
      captureCrmAuditRequest({
        workspace: { id: workspaceId },
        application: { id: applicationId },
        user: { id: actorUserId },
      }),
      async () => {
        await expect(
          runStrictTx(async (scope) => {
            await runAuditedShareWithInsert({
              scope,
              workspaceId,
              objectMetadataId: customObjectMetadataId,
              recordIds: [recordId1],
              authContext: {
                type: 'application',
                workspace: { id: workspaceId },
                application: { id: applicationId },
              },
              desiredShares: [],
              execute: async () => undefined,
            });
          }),
        ).rejects.toThrow('Record share audit ambient application conflict');
      },
    );

    await expect(
      runStrictTx(async (scope) => {
        await withNativeCrmAuditTransaction(
          {},
          scope,
          {
            workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'workspaceMember', id: actorMemberId },
            initiator: { kind: 'application', id: applicationId },
          },
          () =>
            runAuditedShareWithInsert({
              scope,
              workspaceId,
              objectMetadataId: customObjectMetadataId,
              recordIds: [recordId1],
              authContext: {
                type: 'user',
                workspace: { id: workspaceId },
                user: { id: actorUserId },
                userWorkspaceId: actorUserWorkspaceId,
                workspaceMemberId: actorMemberId,
              },
              desiredShares: [],
              execute: async () => undefined,
            }),
        );
      }),
    ).rejects.toThrow(
      'Record share create audit conflicts with native audit scope attribution',
    );

    // Branch A error latching: caught ShareWith failure still fails withNativeCrmAuditTransaction
    await expect(
      runStrictTx(async (scope) => {
        await withNativeCrmAuditTransaction(
          {},
          scope,
          {
            workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'workspaceMember', id: actorMemberId },
          },
          async () => {
            try {
              await runAuditedShareWithInsert({
                scope,
                workspaceId,
                objectMetadataId: customObjectMetadataId,
                recordIds: [recordId1],
                authContext: {
                  type: 'user',
                  workspace: { id: workspaceId },
                  user: { id: actorUserId },
                  userWorkspaceId: actorUserWorkspaceId,
                  workspaceMemberId: actorMemberId,
                },
                desiredShares: [],
                execute: async () => {
                  throw new Error('simulated swallowed shareWith write failure');
                },
              });
            } catch {
              // Caller tries to swallow error; native audit transaction must still abort
            }
          },
        );
      }),
    ).rejects.toThrow('simulated swallowed shareWith write failure');

    // m-3: auditImpersonatorUserWorkspaceId rejected for non-user actor
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedWorkflowRunShareSync({
          scope,
          workspaceId,
          objectMetadataId: workflowRunObjectMetadataId,
          workflowRunIds: [workflowRunId1],
          desiredShares: [],
          auditOperation: {
            workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'system', id: 'sync_workflow_run_shares' },
          },
          auditImpersonatorUserWorkspaceId: impersonatorUserWorkspaceId,
          execute: async () => undefined,
        });
      }),
    ).rejects.toThrow(
      'Workflow run share sync impersonator requires user actor',
    );

    // m-4: unmanaged desiredShares rejected before execute()
    const executeSpy = jest.fn(async () => undefined);
    await expect(
      runStrictTx(async (scope) => {
        await runAuditedWorkflowRunShareSync({
          scope,
          workspaceId,
          objectMetadataId: workflowRunObjectMetadataId,
          workflowRunIds: [workflowRunId1],
          desiredShares: [
            {
              objectMetadataId: workflowRunObjectMetadataId,
              recordId: workflowRunId1,
              principalId: targetMemberId,
              principalType: RecordSharePrincipalType.WORKSPACE_MEMBER,
              accessLevel: RecordShareAccessLevel.READ,
              rowCause: RecordShareRowCause.MANUAL,
              sourceId: actorMemberId,
            },
          ],
          execute: executeSpy,
        });
      }),
    ).rejects.toThrow(
      'Workflow run share sync desired shares include unmanaged grant',
    );
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rolls back ShareWithService (native and standalone) and WorkflowRunRecordShareService on audit flush failure and post-flush drift', async () => {
    const { shareWithService, workflowRunRecordShareService, runStrictTx } =
      createHarness({
        workflowVisibility: WorkflowVisibility.WORKSPACE,
        workflowCreatorUserWorkspaceId: actorUserWorkspaceId,
      });

    // 1. Audit flush failure rolls back WorkflowRunRecordShareService completely
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_rsw_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' THEN
          RAISE EXCEPTION 'simulated recordShare writers audit flush failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_fail_rsw_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_fail_rsw_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_rsw_audit();
    `);
    try {
      await expect(
        workflowRunRecordShareService.syncRunsOfCoreWorkflows({
          workspaceId,
          coreWorkflowIds: [coreWorkflowId],
        }),
      ).rejects.toThrow('simulated recordShare writers audit flush failure');

      await expect(
        runStrictTx((scope) =>
          shareWithService.insertRecordSharesForCreatedRecords({
            authContext: {
              type: 'system',
              workspace: { id: workspaceId },
            } as never,
            flatObjectMetadata: { id: customObjectMetadataId } as never,
            objectSharing: {
              sharingMode: RecordSharingMode.PRIVATE,
              canShareBeyondRole: false,
              operationTypesGrantedBeyondRole: [],
            },
            recordIds: [recordId1],
            apiKeyRoleMap: {},
            shareWith: [
              {
                workspaceMemberId: targetMemberId,
                accessLevel: RecordShareAccessLevel.READ,
              },
            ],
            transactionScope: scope as never,
          }),
        ),
      ).rejects.toThrow('simulated recordShare writers audit flush failure');
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_fail_rsw_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.fail_rsw_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);

    // 2. Post-flush row drift rolls back both native ShareWithService (via postFlushChecks) and WorkflowRunRecordShareService
    await ownerDataSource.query(`
      CREATE OR REPLACE FUNCTION crm_audit.drift_rsw_after_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."resourceKind" = 'recordShare' AND NEW.action = 'create' THEN
          UPDATE "${workspaceSchema}"."recordShare"
             SET "accessLevel" = 'NONE'
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_drift_rsw_after_audit ON crm_audit."crmAuditEntry";
      CREATE TRIGGER trg_drift_rsw_after_audit
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.drift_rsw_after_audit();
    `);
    try {
      await expect(
        runStrictTx(async (scope) => {
          await withNativeCrmAuditTransaction(
            {},
            scope,
            {
              workspaceId,
              operationId: randomUUID(),
              actor: { kind: 'workspaceMember', id: actorMemberId },
            },
            () =>
              shareWithService.insertRecordSharesForCreatedRecords({
                authContext: {
                  type: 'user',
                  workspace: { id: workspaceId },
                  user: { id: actorUserId },
                  userWorkspaceId: actorUserWorkspaceId,
                  workspaceMemberId: actorMemberId,
                  workspaceMember: { id: actorMemberId, userId: actorUserId },
                } as never,
                flatObjectMetadata: { id: customObjectMetadataId } as never,
                objectSharing: {
                  sharingMode: RecordSharingMode.PRIVATE,
                  canShareBeyondRole: false,
                  operationTypesGrantedBeyondRole: [],
                },
                recordIds: [recordId1],
                apiKeyRoleMap: {},
                shareWith: [
                  {
                    workspaceMemberId: targetMemberId,
                    accessLevel: RecordShareAccessLevel.READ,
                  },
                ],
                transactionScope: scope as never,
              }),
          );
        }),
      ).rejects.toThrow(
        'Record share create audit detected post-flush row drift',
      );

      await expect(
        runStrictTx((scope) =>
          shareWithService.insertRecordSharesForCreatedRecords({
            authContext: {
              type: 'system',
              workspace: { id: workspaceId },
            } as never,
            flatObjectMetadata: { id: customObjectMetadataId } as never,
            objectSharing: {
              sharingMode: RecordSharingMode.PRIVATE,
              canShareBeyondRole: false,
              operationTypesGrantedBeyondRole: [],
            },
            recordIds: [recordId1],
            apiKeyRoleMap: {},
            shareWith: [
              {
                workspaceMemberId: targetMemberId,
                accessLevel: RecordShareAccessLevel.READ,
              },
            ],
            transactionScope: scope as never,
          }),
        ),
      ).rejects.toThrow(
        'Record share create audit detected post-flush row drift',
      );

      await expect(
        workflowRunRecordShareService.syncRunsOfCoreWorkflows({
          workspaceId,
          coreWorkflowIds: [coreWorkflowId],
        }),
      ).rejects.toThrow(
        'Workflow run share sync audit detected post-flush row drift',
      );
    } finally {
      await ownerDataSource.query(
        `DROP TRIGGER IF EXISTS trg_drift_rsw_after_audit ON crm_audit."crmAuditEntry";
         DROP FUNCTION IF EXISTS crm_audit.drift_rsw_after_audit();`,
      );
    }
    expect(await readRecordShareRows()).toHaveLength(0);
    expect(await readAuditRows()).toHaveLength(0);
  });
});
