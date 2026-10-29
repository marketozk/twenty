import {
  captureNativeCrmAuditOperation,
  withNativeCrmAuditTransaction,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { Logger } from '@nestjs/common';

import { type Pool } from 'pg';
import { isDefined } from 'twenty-shared/utils';

import {
  type ObjectRecord,
  type ObjectsPermissionsByRoleId,
} from 'twenty-shared/types';
import { type ObjectLiteral } from 'typeorm';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import {
  type WorkspaceTransactionLifecycle,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { ClientQueryExecutor } from 'src/engine/twenty-orm/executor/client-query-executor';
import { PoolQueryExecutor } from 'src/engine/twenty-orm/executor/pool-query-executor';
import { type QueryExecutor } from 'src/engine/twenty-orm/executor/types/query-executor.type';
import {
  TwentyOrmException,
  TwentyOrmExceptionCode,
} from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { runInRollbackSafeTransaction } from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import { WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { buildWorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/utils/build-workspace-table-shape.util';
import { resolveObjectRecordsPermissions } from 'src/engine/twenty-orm/utils/resolve-object-records-permissions.util';
import { registerOmniWorkspaceTransaction } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

const tableShapeCacheByFlatObjectMetadataMaps = new WeakMap<
  object,
  Map<string, WorkspaceTableShape>
>();

export class WorkspaceDataSource {
  private readonly logger = new Logger(WorkspaceDataSource.name);
  private readonly pool: Pool;
  private readonly internalContext: WorkspaceInternalContext;
  private readonly authContext: WorkspaceAuthContext;
  private readonly objectPermissionsByRoleId: ObjectsPermissionsByRoleId;

  constructor({
    pool,
    internalContext,
    authContext,
    objectPermissionsByRoleId,
  }: {
    pool: Pool;
    internalContext: WorkspaceInternalContext;
    authContext: WorkspaceAuthContext;
    objectPermissionsByRoleId: ObjectsPermissionsByRoleId;
  }) {
    this.pool = pool;
    this.internalContext = internalContext;
    this.authContext = authContext;
    this.objectPermissionsByRoleId = objectPermissionsByRoleId;
  }

  getRepository<T extends ObjectLiteral = ObjectRecord>(
    nameSingular: string,
    rolePermissionConfig?: RolePermissionConfig,
    repositoryOptions?: { shouldSkipEventEmission?: boolean },
  ): WorkspaceRepository<T> {
    return this.buildRepository<T>({
      nameSingular,
      rolePermissionConfig,
      executor: new PoolQueryExecutor({ pool: this.pool }),
      shouldSkipEventEmission:
        repositoryOptions?.shouldSkipEventEmission ?? false,
    });
  }

  async transaction<T>(
    work: (transactionScope: WorkspaceTransactionScope) => Promise<T>,
    options: WorkspaceTransactionOptions = {},
  ): Promise<T> {
    const nativeAuditOperation =
      options.nativeAudit === undefined
        ? undefined
        : captureNativeCrmAuditOperation(
            this.internalContext.workspaceId,
            this.authContext,
            options.nativeAudit,
          );
    if (nativeAuditOperation && options.commitOutcome === 'legacy')
      throw new Error('Native audit requires strict transaction ownership');
    options = {
      ...options,
      ...(nativeAuditOperation ? { commitOutcome: 'strict' as const } : {}),
    };
    const afterCommitCallbacks: Array<() => void | Promise<void>> = [];
    let transactionLifecycle: WorkspaceTransactionLifecycle | undefined;
    const assertActive = () => {
      if (
        transactionLifecycle?.commitOutcome === 'strict' &&
        (!transactionLifecycle.isTransactionActive ||
          transactionLifecycle.isReleased)
      ) {
        throw new Error('Workspace transaction is no longer active');
      }
    };
    const afterCommit: WorkspaceTransactionScope['afterCommit'] = (
      callback,
    ) => {
      assertActive();
      afterCommitCallbacks.push(callback);
    };
    const transactionalInternalContext: WorkspaceInternalContext = {
      ...this.internalContext,
      eventEmitterService: {
        emitDatabaseBatchEvent: (event) =>
          afterCommit(() =>
            this.internalContext.eventEmitterService.emitDatabaseBatchEvent(
              event,
            ),
          ),
      },
      recordStock: {
        assertRecordStockAvailable: (args) =>
          this.internalContext.recordStock.assertRecordStockAvailable(args),
        acquireRecordStock: async (args) => {
          afterCommit(() =>
            this.internalContext.recordStock.acquireRecordStock(args),
          );
        },
        releaseRecordStock: async (args) => {
          afterCommit(() =>
            this.internalContext.recordStock.releaseRecordStock(args),
          );
        },
      },
    };
    const result = await this.runInClientTransaction(
      async (executor, lifecycle) => {
        transactionLifecycle = lifecycle;
        const nativeOwnershipLock = options.nativeOwnershipLock ?? 'shared';
        // First lock, including multi-object merge transactions. Acquiring this in
        // a later native kernel would invert Person -> fence / fence -> Person.
        await lockOmniNativeOwnership(
          {
            executeRawQuery: (sql, parameters = []) =>
              executor.execute({ text: sql, values: parameters }),
          },
          this.internalContext.workspaceId,
          nativeOwnershipLock,
        );

        const scope: WorkspaceTransactionScope = {
          workspaceId: this.internalContext.workspaceId,
          transactionLifecycle: lifecycle,
          getRepository: <T extends ObjectLiteral = ObjectRecord>(
            nameSingular: string,
            rolePermissionConfig?: RolePermissionConfig,
            repositoryOptions?: { shouldSkipEventEmission?: boolean },
          ) => {
            assertActive();

            return this.buildRepository<T>({
              nameSingular,
              rolePermissionConfig,
              executor,
              isTransactional: true,
              shouldSkipEventEmission:
                repositoryOptions?.shouldSkipEventEmission ?? false,
              internalContext: transactionalInternalContext,
            });
          },
          executeRawQuery: (sql, parameters = []) =>
            executor.execute({ text: sql, values: parameters }),
          afterCommit,
        };
        registerOmniWorkspaceTransaction(scope, {
          workspaceId: this.internalContext.workspaceId,
          executor,
          lifecycle,
          nativeOwnershipLock,
          nativeCleanupMetadata: () => ({
            authType: this.authContext.type,
            authWorkspaceId: this.authContext.workspace.id,
            memberObjectId:
              this.internalContext.objectIdByNameSingular.workspaceMember,
            objects: Object.values(
              this.internalContext.flatObjectMetadataMaps.byUniversalIdentifier,
            )
              .filter(isDefined)
              .filter(
                (metadata) =>
                  metadata.workspaceId === this.internalContext.workspaceId &&
                  !metadata.isRemote,
              )
              .map((metadata) => ({
                metadata: { ...metadata },
                shape: this.getTableShape(metadata.id),
              })),
          }),
        });
        return nativeAuditOperation
          ? withNativeCrmAuditTransaction(
              executor,
              scope,
              nativeAuditOperation,
              () => work(scope),
            )
          : work(scope);
      },
      options,
    );

    for (const callback of afterCommitCallbacks) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(
          `After-commit callback failed for workspace ${this.internalContext.workspaceId}`,
          error,
        );
      }
    }

    return result;
  }

  private async runInClientTransaction<T>(
    work: (
      executor: QueryExecutor,
      lifecycle: WorkspaceTransactionLifecycle,
    ) => Promise<T>,
    options: WorkspaceTransactionOptions,
  ): Promise<T> {
    return runInRollbackSafeTransaction({
      pool: this.pool,
      ...options,
      work: (client, lifecycle) => {
        const executor = new ClientQueryExecutor({ client });

        return work(
          {
            execute: async (statement) => {
              if (
                lifecycle.commitOutcome === 'strict' &&
                (!lifecycle.isTransactionActive || lifecycle.isReleased)
              ) {
                throw new Error('Workspace transaction is no longer active');
              }

              return executor.execute(statement);
            },
          },
          lifecycle,
        );
      },
    });
  }

  private buildRepository<T extends ObjectLiteral = ObjectRecord>({
    nameSingular,
    rolePermissionConfig,
    executor,
    isTransactional = false,
    shouldSkipEventEmission = false,
    internalContext = this.internalContext,
  }: {
    nameSingular: string;
    rolePermissionConfig?: RolePermissionConfig;
    executor: QueryExecutor;
    isTransactional?: boolean;
    shouldSkipEventEmission?: boolean;
    internalContext?: WorkspaceInternalContext;
  }): WorkspaceRepository<T> {
    const objectMetadataId =
      internalContext.objectIdByNameSingular[nameSingular];

    if (!isDefined(objectMetadataId)) {
      throw new TwentyOrmException(
        `Object "${nameSingular}" does not exist in this workspace`,
        TwentyOrmExceptionCode.UNKNOWN_OBJECT,
      );
    }

    return this.buildRepositoryForObjectMetadataId<T>({
      objectMetadataId,
      rolePermissionConfig,
      executor,
      isTransactional,
      shouldSkipEventEmission,
      internalContext,
    });
  }

  private buildRepositoryForObjectMetadataId<
    T extends ObjectLiteral = ObjectRecord,
  >({
    objectMetadataId,
    rolePermissionConfig,
    executor,
    isTransactional = false,
    shouldSkipEventEmission = false,
    internalContext = this.internalContext,
  }: {
    objectMetadataId: string;
    rolePermissionConfig?: RolePermissionConfig;
    executor: QueryExecutor;
    isTransactional?: boolean;
    shouldSkipEventEmission?: boolean;
    internalContext?: WorkspaceInternalContext;
  }): WorkspaceRepository<T> {
    const flatObjectMetadata =
      this.getFlatObjectMetadataOrThrow(objectMetadataId);

    const repositoryRolePermissionConfig: RolePermissionConfig =
      rolePermissionConfig ?? { intersectionOf: {} };

    const { objectRecordsPermissions, shouldBypassPermissionChecks } =
      resolveObjectRecordsPermissions({
        rolePermissionConfig: repositoryRolePermissionConfig,
        objectPermissionsByRoleId: this.objectPermissionsByRoleId,
      });

    return new WorkspaceRepository<T>({
      tableShape: this.getTableShape(objectMetadataId),
      flatObjectMetadata,
      internalContext,
      authContext: this.authContext,
      executor,
      objectRecordsPermissions,
      rolePermissionConfig: repositoryRolePermissionConfig,
      shouldBypassPermissionChecks,
      shouldSkipEventEmission: shouldSkipEventEmission ?? false,
      tableShapeByObjectMetadataId: (targetObjectMetadataId) =>
        this.getTableShape(targetObjectMetadataId),
      flatObjectMetadataByObjectMetadataId: (targetObjectMetadataId) =>
        this.getFlatObjectMetadataOrThrow(targetObjectMetadataId),
      getRepositoryForObjectMetadataId: <
        Entity extends ObjectLiteral = ObjectRecord,
      >(
        targetObjectMetadataId: string,
      ) =>
        this.buildRepositoryForObjectMetadataId<Entity>({
          objectMetadataId: targetObjectMetadataId,
          rolePermissionConfig,
          executor,
          isTransactional,
          shouldSkipEventEmission,
          internalContext,
        }),
      isTransactional,
      runInNewTransaction: (work) =>
        this.transaction((transactionScope) =>
          work(
            transactionScope.getRepository<T>(
              flatObjectMetadata.nameSingular,
              rolePermissionConfig,
              { shouldSkipEventEmission },
            ),
          ),
        ),
    });
  }

  private getTableShape(objectMetadataId: string): WorkspaceTableShape {
    const cacheKey = this.internalContext.flatObjectMetadataMaps as object;
    const cachedShapes =
      tableShapeCacheByFlatObjectMetadataMaps.get(cacheKey) ??
      new Map<string, WorkspaceTableShape>();

    tableShapeCacheByFlatObjectMetadataMaps.set(cacheKey, cachedShapes);

    const cachedShape = cachedShapes.get(objectMetadataId);

    if (isDefined(cachedShape)) {
      return cachedShape;
    }

    const tableShape = buildWorkspaceTableShape({
      workspaceId: this.internalContext.workspaceId,
      flatObjectMetadata: this.getFlatObjectMetadataOrThrow(objectMetadataId),
      flatFieldMetadataMaps: this.internalContext.flatFieldMetadataMaps,
    });

    cachedShapes.set(objectMetadataId, tableShape);

    return tableShape;
  }

  private getFlatObjectMetadataOrThrow(
    objectMetadataId: string,
  ): FlatObjectMetadata {
    return findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityId: objectMetadataId,
      flatEntityMaps: this.internalContext.flatObjectMetadataMaps,
    });
  }
}
