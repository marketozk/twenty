import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  assertNoRemainingApplicationRoleOrPermissionMetadata,
  bindApplicationMetadataAuditOperation,
  captureApplicationMetadataAuditOperation,
  runAuditedApplicationMetadataMigration,
  withApplicationMetadataAudit,
} from 'src/engine/core-modules/crm-audit/application-metadata-audit';
import {
  captureIndexMetadataAudit,
  withIndexMetadataAudit,
} from 'src/engine/core-modules/crm-audit/index-metadata-audit';
import { FieldMetadataType, IndexType } from 'twenty-shared/types';

for (const [modPath, names] of [
  [
    'src/engine/core-modules/application/application.service',
    ['ApplicationService'],
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    ['AuthGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/core-modules/feature-flag/services/feature-flag.service',
    ['FeatureFlagService'],
  ],
  [
    'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
    ['PreventNestToAutoLogGraphqlErrorsFilter'],
  ],
  [
    'src/engine/core-modules/graphql/pipes/resolver-validation.pipe',
    ['ResolverValidationPipe'],
  ],
  ['src/engine/core-modules/logger/logger.service', ['LoggerService']],
  ['src/engine/core-modules/metrics/metrics.service', ['MetricsService']],
  [
    'src/engine/core-modules/twenty-config/twenty-config.service',
    ['TwentyConfigService'],
  ],
  ['src/engine/core-modules/workspace/workspace.entity', ['WorkspaceEntity']],
  [
    'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
    ['WorkspaceManyOrAllFlatEntityMapsCacheService'],
  ],
  [
    'src/engine/metadata-modules/index-metadata/dtos/create-one-index.input',
    ['CreateOneIndexInput'],
  ],
  [
    'src/engine/metadata-modules/index-metadata/dtos/delete-index.input',
    ['DeleteOneIndexInput'],
  ],
  [
    'src/engine/metadata-modules/index-metadata/dtos/index-field-metadata.dto',
    ['IndexFieldMetadataDTO'],
  ],
  [
    'src/engine/metadata-modules/index-metadata/dtos/index-metadata.dto',
    ['IndexMetadataDTO'],
  ],
  [
    'src/engine/metadata-modules/permissions/utils/permissions-graphql-api-exception.filter',
    ['PermissionsGraphqlApiExceptionFilter'],
  ],
  [
    'src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service',
    ['WorkspaceMetadataVersionService'],
  ],
  [
    'src/engine/workspace-cache/services/workspace-cache.service',
    ['WorkspaceCacheService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
    ['WorkspaceMigrationValidateBuildAndRunService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/workspace-migration-runner-action-handler-registry.service',
    ['WorkspaceMigrationRunnerActionHandlerRegistryService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service',
    ['DeferredWorkspaceMigrationActionRunnerService'],
  ],
  [
    'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/in-flight-deferred-workspace-migration-actions.service',
    ['InFlightDeferredWorkspaceMigrationActionsService'],
  ],
] as const) {
  jest.doMock(modPath, () =>
    Object.fromEntries(names.map((name) => [name, class {}])),
  );
}

jest.doMock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({
    MetadataResolver: () => () => undefined,
  }),
);
jest.doMock('src/engine/decorators/auth/auth-workspace.decorator', () => ({
  AuthWorkspace: () => () => undefined,
}));
jest.doMock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.doMock('src/engine/guards/settings-permission.guard', () => ({
  SettingsPermissionGuard: () => class {},
}));
jest.doMock(
  'src/engine/metadata-modules/flat-index-metadata/utils/from-flat-index-metadata-to-index-metadata-dto.util',
  () => ({
    fromFlatIndexMetadataToIndexMetadataDto: (flat: unknown) => flat,
  }),
);
jest.doMock(
  'src/engine/metadata-modules/index-metadata/utils/index-metadata-graphql-api-exception-handler.util',
  () => ({
    indexMetadataGraphqlApiExceptionHandler: (error: unknown) => {
      throw error;
    },
  }),
);
jest.doMock(
  'src/engine/metadata-modules/object-metadata/utils/object-metadata-graphql-api-exception-handler.util',
  () => ({
    objectMetadataGraphqlApiExceptionHandler: (error: unknown) => {
      throw error;
    },
  }),
);
jest.doMock(
  'src/engine/metadata-modules/index-metadata/utils/generate-flat-index.util',
  () => ({
    generateFlatIndexMetadataWithNameOrThrow: ({
      flatIndex,
    }: {
      flatIndex: Record<string, unknown>;
    }) => ({
      ...flatIndex,
      name: 'IDX_CUSTOM_TEST_AUDIT',
    }),
  }),
);
jest.doMock(
  'src/engine/metadata-modules/index-metadata/utils/validate-index-type-against-fields.util',
  () => ({
    validateIndexTypeAgainstFieldsOrThrow: () => undefined,
  }),
);
jest.doMock(
  'src/engine/metadata-modules/index-metadata/utils/validate-no-duplicate-unique-index.util',
  () => ({
    validateNoDuplicateUniqueIndexOrThrow: () => undefined,
  }),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkspaceMigrationRunnerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IndexMetadataService } =
  require('src/engine/metadata-modules/index-metadata/services/index-metadata.service') as typeof import('src/engine/metadata-modules/index-metadata/services/index-metadata.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IndexMetadataResolver } =
  require('src/engine/metadata-modules/index-metadata/index-metadata.resolver') as typeof import('src/engine/metadata-modules/index-metadata/index-metadata.resolver');

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url) throw new Error('FORK_MIGRATION_TEST_URL is required');

const role = `index_metadata_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const owner = new DataSource({
  type: 'postgres',
  url,
  extra: { max: 6, statement_timeout: 12000 },
});

const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-index-metadata-audit';

const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  extra: { max: 6, statement_timeout: 12000 },
});

const workspaceId = randomUUID();
const applicationId = randomUUID();
const applicationUniversalId = randomUUID();
const objectMetadataId = randomUUID();
const objectUniversalId = randomUUID();
const fieldMetadataId = randomUUID();
const fieldUniversalId = randomUUID();
const actorUserId = randomUUID();
const actorUserWorkspaceId = randomUUID();
const impersonatorUserId = randomUUID();
const impersonatorUserWorkspaceId = randomUUID();

const dispatchAfterCommitMock = jest.fn(async () => {});
const rollbackHandlerMock = jest.fn(async () => {});

const buildRunner = (
  flatIndexMapsByUniversalId: Record<string, Record<string, unknown>>,
) =>
  new WorkspaceMigrationRunnerService(
    {
      getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
        flatIndexMaps: {
          byUniversalIdentifier: flatIndexMapsByUniversalId,
        },
        flatObjectMetadataMaps: {
          byUniversalIdentifier: {
            [objectUniversalId]: {
              id: objectMetadataId,
              universalIdentifier: objectUniversalId,
            },
          },
        },
        flatFieldMetadataMaps: {
          byUniversalIdentifier: {
            [fieldUniversalId]: {
              id: fieldMetadataId,
              universalIdentifier: fieldUniversalId,
              objectMetadataId,
              type: FieldMetadataType.TEXT,
            },
          },
        },
        flatSearchFieldMetadataMaps: { byUniversalIdentifier: {} },
      }),
    } as never,
    runtime,
    {
      executeActionHandler: async ({
        action,
        context,
      }: {
        action: Record<string, unknown>;
        context: {
          queryRunner: DataSource['manager'] extends never
            ? never
            : { query: (sql: string, params?: unknown[]) => Promise<unknown> };
        };
      }) => {
        if (action.metadataName === 'index' && action.type === 'create') {
          const flat = action.flatEntity as Record<string, unknown>;
          const newId = (flat.id as string | undefined) ?? randomUUID();
          await context.queryRunner.query(
            `INSERT INTO core."indexMetadata" (
               id, "workspaceId", "applicationId", "objectMetadataId",
               "universalIdentifier", name, "indexType", "isCustom",
               "isUnique", "isSystemSideEffect", "indexWhereClause"
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              newId,
              workspaceId,
              applicationId,
              objectMetadataId,
              flat.universalIdentifier,
              flat.name,
              flat.indexType ?? IndexType.BTREE,
              flat.isCustom ?? true,
              flat.isUnique ?? false,
              flat.isSystemSideEffect ?? false,
              flat.indexWhereClause ?? null,
            ],
          );

          return {
            partialOptimisticCache: {},
            metadataEvents: [],
            deferredActions: [
              {
                type: 'buildIndex',
                indexMetadataUniversalIdentifier: flat.universalIdentifier,
              },
            ],
          };
        }

        if (action.metadataName === 'index' && action.type === 'delete') {
          await context.queryRunner.query(
            `DELETE FROM core."indexMetadata"
              WHERE "workspaceId" = $1
                AND "universalIdentifier" = $2`,
            [workspaceId, action.universalIdentifier],
          );

          return {
            partialOptimisticCache: {},
            metadataEvents: [],
            deferredActions: [],
          };
        }

        return {
          partialOptimisticCache: {},
          metadataEvents: [],
          deferredActions: [],
        };
      },
      executeActionRollbackHandler: rollbackHandlerMock,
    } as never,
    { incrementMetadataVersion: async () => {} } as never,
    {
      getOrRecompute: async () => ({
        flatApplicationMaps: {
          idByUniversalIdentifier: {
            [applicationUniversalId]: applicationId,
          },
          byId: {
            [applicationId]: {
              id: applicationId,
              universalIdentifier: applicationUniversalId,
            },
          },
        },
      }),
      invalidateAndRecompute: async () => {},
    } as never,
    { recordHistogram: () => {} } as never,
    {
      perfTime: () => {},
      perfTimeEnd: () => {},
      perf: () => {},
      error: () => {},
    } as never,
    { get: () => false } as never,
    { getWorkspaceFeatureFlagsMap: async () => ({}) } as never,
    {
      persist: async () => {},
      dispatchAfterCommit: dispatchAfterCommitMock,
      enqueue: async () => {},
    } as never,
    { throwIfSchemaAffectingActionsAreInProgress: async () => {} } as never,
  );

const readIndexAudits = async () =>
  owner.query(
    `SELECT id, "operationId", "correlationId", "resourceKind", "resourceId", action,
            actor, initiator, "redactedDiff", "securityDescriptor"
       FROM crm_audit."crmAuditEntry"
      WHERE "workspaceId" = $1
        AND "resourceKind" = 'indexMetadata'
      ORDER BY "createdAt" ASC, id ASC`,
    [workspaceId],
  );

describe('LOG196 transactional indexMetadata audit (PostgreSQL)', () => {
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
      CREATE TABLE core.application (
        id uuid PRIMARY KEY,
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "universalIdentifier" uuid NOT NULL,
        "deletedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await owner.query(`
      CREATE TABLE core."indexMetadata" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,
        "applicationId" uuid NULL REFERENCES core.application(id) ON DELETE CASCADE,
        "objectMetadataId" uuid NOT NULL,
        "universalIdentifier" uuid NOT NULL,
        name text NOT NULL,
        "indexType" text NOT NULL DEFAULT 'BTREE',
        "isCustom" boolean NOT NULL DEFAULT false,
        "isUnique" boolean NOT NULL DEFAULT false,
        "isSystemSideEffect" boolean NOT NULL DEFAULT false,
        "indexWhereClause" text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
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
          CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-index-metadata-audit';
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
      `INSERT INTO core.application (id, "workspaceId", "universalIdentifier")
       VALUES ($1, $2, $3)`,
      [applicationId, workspaceId, applicationUniversalId],
    );
    await owner.query(
      `INSERT INTO core."user" (id, email) VALUES ($1, $2), ($3, $4)`,
      [
        actorUserId,
        'owner@acme.test',
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
    dispatchAfterCommitMock.mockClear();
    rollbackHandlerMock.mockClear();
    await owner.query(`DELETE FROM core."indexMetadata"`);
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

  it('audits createOneIndex and deleteOneIndex via IndexMetadataResolver -> IndexMetadataService -> WorkspaceMigrationRunnerService with redaction and impersonation', async () => {
    const flatIndexesByUid: Record<string, Record<string, unknown>> = {};
    const runner = buildRunner(flatIndexesByUid);

    const validateBuildAndRunService = {
      validateBuildAndRunWorkspaceMigration: async ({
        allFlatEntityOperationByMetadataName,
      }: {
        allFlatEntityOperationByMetadataName: {
          index: {
            flatEntityToCreate: Array<Record<string, unknown>>;
            flatEntityToDelete: Array<Record<string, unknown>>;
          };
        };
      }) => {
        const actions = [
          ...allFlatEntityOperationByMetadataName.index.flatEntityToCreate.map(
            (flatEntity) => ({
              type: 'create',
              metadataName: 'index',
              flatEntity: {
                ...flatEntity,
                id: randomUUID(),
                objectMetadataId,
              },
            }),
          ),
          ...allFlatEntityOperationByMetadataName.index.flatEntityToDelete.map(
            (flatEntity) => ({
              type: 'delete',
              metadataName: 'index',
              universalIdentifier: flatEntity.universalIdentifier,
            }),
          ),
        ];

        await runner.run({
          workspaceId,
          workspaceMigration: {
            actions,
            applicationUniversalIdentifier: applicationUniversalId,
          } as never,
        });

        for (const action of actions) {
          if (action.type === 'create' && 'flatEntity' in action) {
            const flat = action.flatEntity as Record<string, unknown>;
            flatIndexesByUid[String(flat.universalIdentifier)] = flat;
          } else if (
            action.type === 'delete' &&
            'universalIdentifier' in action
          ) {
            delete flatIndexesByUid[String(action.universalIdentifier)];
          }
        }

        return { status: 'success' };
      },
    };

    const service = new IndexMetadataService(
      {
        getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
          flatObjectMetadataMaps: {
            byUniversalIdentifier: {
              [objectUniversalId]: {
                id: objectMetadataId,
                universalIdentifier: objectUniversalId,
                nameSingular: 'company',
              },
            },
            universalIdentifierById: {
              [objectMetadataId]: objectUniversalId,
            },
          },
          flatFieldMetadataMaps: {
            byUniversalIdentifier: {
              [fieldUniversalId]: {
                id: fieldMetadataId,
                universalIdentifier: fieldUniversalId,
                objectMetadataId,
                name: 'domainName',
                label: 'Domain',
                type: FieldMetadataType.TEXT,
              },
            },
            universalIdentifierById: {
              [fieldMetadataId]: fieldUniversalId,
            },
          },
          flatIndexMaps: {
            byUniversalIdentifier: flatIndexesByUid,
            universalIdentifierById: Object.fromEntries(
              Object.entries(flatIndexesByUid).map(([uid, val]) => [
                String(val.id),
                uid,
              ]),
            ),
          },
        }),
      } as never,
      validateBuildAndRunService as never,
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
          workspaceCustomFlatApplication: {
            id: applicationId,
            universalIdentifier: applicationUniversalId,
          },
        }),
      } as never,
    );

    const resolver = new IndexMetadataResolver(service);
    const requestContext = {
      req: {
        workspace: { id: workspaceId },
        user: { id: actorUserId },
        userWorkspaceId: actorUserWorkspaceId,
        impersonationContext: {
          impersonatorUserWorkspaceId,
        },
      },
    };

    const created = await resolver.createOneIndex(
      {
        index: {
          objectMetadataId,
          indexType: IndexType.BTREE,
          fields: [{ fieldMetadataId }],
        },
      } as never,
      { id: workspaceId } as never,
      requestContext,
    );

    expect(created.id).toBeDefined();
    expect(dispatchAfterCommitMock).toHaveBeenCalledTimes(1);

    await resolver.deleteOneIndex(
      { id: created.id } as never,
      { id: workspaceId } as never,
      requestContext,
    );

    const audits = await readIndexAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      resourceKind: 'indexMetadata',
      resourceId: created.id,
      action: 'create',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
      securityDescriptor: {
        resourceKind: 'indexMetadata',
        resourceId: created.id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    expect(audits[0].redactedDiff.values).toEqual({
      applicationId: { before: null, after: applicationId },
      objectMetadataId: { before: null, after: objectMetadataId },
      indexType: { before: null, after: IndexType.BTREE },
      isCustom: { before: null, after: true },
      isUnique: { before: null, after: false },
      isSystemSideEffect: { before: null, after: false },
    });
    expect(audits[0].redactedDiff.changedFields).toEqual(
      expect.arrayContaining(['name']),
    );
    expect(JSON.stringify(audits[0])).not.toContain('IDX_CUSTOM_TEST_AUDIT');

    expect(audits[1]).toMatchObject({
      resourceKind: 'indexMetadata',
      resourceId: created.id,
      action: 'delete',
      actor: { kind: 'coreUser', id: actorUserId },
      initiator: { kind: 'coreUser', id: impersonatorUserId },
    });
  });

  it('enforces fail-closed barrier for custom indexes without audit scope while allowing system side-effect indexes', async () => {
    const customUid = randomUUID();
    const customId = randomUUID();
    const flatIndexesByUid: Record<string, Record<string, unknown>> = {
      [customUid]: {
        id: customId,
        universalIdentifier: customUid,
        isCustom: true,
      },
    };
    const runner = buildRunner(flatIndexesByUid);

    await expect(
      runner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: applicationUniversalId,
          actions: [
            {
              type: 'create',
              metadataName: 'index',
              flatEntity: {
                id: randomUUID(),
                universalIdentifier: randomUUID(),
                name: 'IDX_UNAUDITED_CUSTOM',
                indexType: IndexType.BTREE,
                isCustom: true,
                isUnique: false,
                isSystemSideEffect: false,
              },
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    await expect(
      runner.run({
        workspaceId,
        workspaceMigration: {
          applicationUniversalIdentifier: applicationUniversalId,
          actions: [
            {
              type: 'delete',
              metadataName: 'index',
              universalIdentifier: customUid,
            },
          ],
        } as never,
      }),
    ).rejects.toThrow(
      'Workspace migration touching role or permission metadata requires an active CRM audit scope',
    );

    const systemUid = randomUUID();
    const systemId = randomUUID();
    await runner.run({
      workspaceId,
      workspaceMigration: {
        applicationUniversalIdentifier: applicationUniversalId,
        actions: [
          {
            type: 'create',
            metadataName: 'index',
            flatEntity: {
              id: systemId,
              universalIdentifier: systemUid,
              name: 'IDX_SYSTEM_SIDE_EFFECT',
              indexType: IndexType.GIN,
              isCustom: false,
              isUnique: false,
              isSystemSideEffect: true,
            },
          },
        ],
      } as never,
    });

    const rows = await owner.query(
      `SELECT id, "isCustom", "isSystemSideEffect" FROM core."indexMetadata" WHERE id = $1`,
      [systemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(false);
    expect(rows[0].isSystemSideEffect).toBe(true);
  });

  it('audits indexMetadata create/update/delete inside runAuditedApplicationMetadataMigration and blocks leftover rows on application delete', async () => {
    const idxId = randomUUID();
    const idxUid = randomUUID();

    const createOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: workspaceId },
            user: { id: actorUserId },
            userWorkspaceId: actorUserWorkspaceId,
            workspaceMemberId: randomUUID(),
          },
        } as never,
      }),
      {
        applicationId,
        applicationUniversalIdentifier: applicationUniversalId,
      },
    );

    await withApplicationMetadataAudit(createOp, () =>
      runAuditedApplicationMetadataMigration(
        runtime,
        createOp,
        [],
        {
          application: {
            id: applicationId,
            universalIdentifier: applicationUniversalId,
          },
          roles: {},
          targets: {},
          agents: {},
          permissionFlags: {},
          rolePermissionFlags: {},
          objectMetadatas: {},
          fieldMetadatas: {},
          objectPermissions: {},
          fieldPermissions: {},
          rowLevelPermissionPredicates: {},
          rowLevelPermissionPredicateGroups: {},
        },
        async (queryRunner) => {
          await queryRunner.query(
            `INSERT INTO core."indexMetadata" (
             id, "workspaceId", "applicationId", "objectMetadataId",
             "universalIdentifier", name, "indexType", "isCustom",
             "isUnique", "isSystemSideEffect", "indexWhereClause"
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              idxId,
              workspaceId,
              applicationId,
              objectMetadataId,
              idxUid,
              'IDX_APP_MANIFEST_SECRET',
              IndexType.BTREE,
              true,
              false,
              false,
              '"deletedAt" IS NULL',
            ],
          );
        },
      ),
    );

    const checkRunner = runtime.createQueryRunner();
    await checkRunner.connect();
    try {
      await expect(
        assertNoRemainingApplicationRoleOrPermissionMetadata(
          checkRunner,
          workspaceId,
          applicationId,
        ),
      ).rejects.toThrow(
        'Application delete requires prior audited removal of role and permission metadata',
      );
    } finally {
      await checkRunner.release();
    }

    const deleteOp = bindApplicationMetadataAuditOperation(
      captureApplicationMetadataAuditOperation({
        workspaceId,
        auditIdentity: {
          auth: {
            type: 'user',
            workspace: { id: workspaceId },
            user: { id: actorUserId },
            userWorkspaceId: actorUserWorkspaceId,
            workspaceMemberId: randomUUID(),
          },
        } as never,
      }),
      {
        applicationId,
        applicationUniversalIdentifier: applicationUniversalId,
      },
    );

    await withApplicationMetadataAudit(deleteOp, () =>
      runAuditedApplicationMetadataMigration(
        runtime,
        deleteOp,
        [],
        {
          application: {
            id: applicationId,
            universalIdentifier: applicationUniversalId,
          },
          roles: {},
          targets: {},
          agents: {},
          permissionFlags: {},
          rolePermissionFlags: {},
          objectMetadatas: {},
          fieldMetadatas: {},
          objectPermissions: {},
          fieldPermissions: {},
          rowLevelPermissionPredicates: {},
          rowLevelPermissionPredicateGroups: {},
        },
        async (queryRunner) => {
          await queryRunner.query(
            `DELETE FROM core."indexMetadata" WHERE id = $1`,
            [idxId],
          );
        },
      ),
    );

    const audits = await readIndexAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0].action).toBe('create');
    expect(audits[0].resourceId).toBe(idxId);
    expect(JSON.stringify(audits[0])).not.toContain('IDX_APP_MANIFEST_SECRET');
    expect(JSON.stringify(audits[0])).not.toContain('"deletedAt" IS NULL');
    expect(audits[1].action).toBe('delete');
    expect(audits[1].resourceId).toBe(idxId);
  });

  it('rolls back indexMetadata create on audit flush failure and on post-flush row drift without dispatching deferred actions', async () => {
    const runner = buildRunner({});

    const createAction = (id: string, uid: string) => ({
      type: 'create',
      metadataName: 'index',
      flatEntity: {
        id,
        universalIdentifier: uid,
        name: 'IDX_ROLLBACK_TEST',
        indexType: IndexType.BTREE,
        isCustom: true,
        isUnique: false,
        isSystemSideEffect: false,
      },
    });

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.fail_on_index_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'indexMetadata' THEN
          RAISE EXCEPTION 'simulated indexMetadata audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_fail_index_audit
      BEFORE INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_on_index_audit();
    `);

    const failedId = randomUUID();
    try {
      const req = captureIndexMetadataAudit({
        workspaceId,
        expectedAction: 'create',
        expectedObjectMetadataId: objectMetadataId,
        auditIdentity: {
          workspaceId,
          actor: { kind: 'coreUser', id: actorUserId },
        },
      });
      await expect(
        withIndexMetadataAudit(req, () =>
          runner.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: applicationUniversalId,
              actions: [createAction(failedId, randomUUID())],
            } as never,
          }),
        ),
      ).rejects.toThrow('simulated indexMetadata audit failure');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_fail_index_audit ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.fail_on_index_audit()`,
      );
    }

    expect(dispatchAfterCommitMock).not.toHaveBeenCalled();
    expect(rollbackHandlerMock).toHaveBeenCalledTimes(1);
    const failedRows = await owner.query(
      `SELECT id FROM core."indexMetadata" WHERE id = $1`,
      [failedId],
    );
    expect(failedRows).toHaveLength(0);

    await owner.query(`
      CREATE OR REPLACE FUNCTION crm_audit.tamper_index_after_flush()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceKind" = 'indexMetadata' AND NEW.action = 'create' THEN
          UPDATE core."indexMetadata"
             SET name = 'IDX_TAMPERED_AFTER_FLUSH'
           WHERE id = NEW."resourceId"::uuid;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_tamper_index_after_flush
      AFTER INSERT ON crm_audit."crmAuditEntry"
      FOR EACH ROW EXECUTE FUNCTION crm_audit.tamper_index_after_flush();
    `);

    const driftedId = randomUUID();
    try {
      const req = captureIndexMetadataAudit({
        workspaceId,
        expectedAction: 'create',
        expectedObjectMetadataId: objectMetadataId,
        auditIdentity: {
          workspaceId,
          actor: { kind: 'coreUser', id: actorUserId },
        },
      });
      await expect(
        withIndexMetadataAudit(req, () =>
          runner.run({
            workspaceId,
            workspaceMigration: {
              applicationUniversalIdentifier: applicationUniversalId,
              actions: [createAction(driftedId, randomUUID())],
            } as never,
          }),
        ),
      ).rejects.toThrow('Index metadata state changed during audit flush');
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS trg_tamper_index_after_flush ON crm_audit."crmAuditEntry"`,
      );
      await owner.query(
        `DROP FUNCTION IF EXISTS crm_audit.tamper_index_after_flush()`,
      );
    }

    expect(dispatchAfterCommitMock).not.toHaveBeenCalled();
    const driftedRows = await owner.query(
      `SELECT id FROM core."indexMetadata" WHERE id = $1`,
      [driftedId],
    );
    expect(driftedRows).toHaveLength(0);
  });
});
