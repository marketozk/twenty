import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  registerMetadataAuditScopeCheck,
  resolveRoleAuditInitiator,
  roleAuditIdentityFromRequest,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type IndexMetadataRequestIdentity = {
  workspaceId?: string;
  workspace?: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  apiKey?: { id?: string } | null;
  application?: { id?: string } | null;
  agentId?: string;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  impersonatorUserWorkspaceId?: string;
  correlationId?: string;
  causationId?: string;
};

export type IndexMetadataAuditIdentity =
  | RoleUpdateAuditIdentity
  | CrmAuditOperation
  | {
      workspaceId: string;
      operationId?: string;
      actor: CrmAuditOperation['actor'];
      initiator?: CrmAuditOperation['initiator'];
      impersonatorUserWorkspaceId?: string;
      correlationId?: string;
      causationId?: string;
    }
  | IndexMetadataRequestIdentity;

export type IndexMetadataAuditRequest = Readonly<{
  workspaceId: string;
  expectedAction: 'create' | 'delete';
  expectedObjectMetadataId?: string;
  expectedDeleteId?: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type IndexMetadataAuditMappings = {
  application: { id: string; universalIdentifier: string };
  indexes?: Record<string, { id: string; isCustom?: boolean } | undefined>;
};

type IndexMigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

const storage = new AsyncLocalStorage<IndexMetadataAuditRequest>();
const active = new WeakSet<IndexMetadataAuditRequest>();
const consumed = new WeakSet<IndexMetadataAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Index metadata audit UUID is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const projectIndexMetadata = (row: Record<string, unknown>) => {
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error('Index metadata audit row name is invalid');
  }

  return {
    applicationId: nullableUuid(row.applicationId),
    objectMetadataId: uuid(row.objectMetadataId),
    indexType:
      row.indexType === undefined || row.indexType === null
        ? 'BTREE'
        : String(row.indexType),
    isCustom: Boolean(row.isCustom),
    isUnique: Boolean(row.isUnique),
    isSystemSideEffect: Boolean(row.isSystemSideEffect),
    name: row.name,
    indexWhereClause:
      row.indexWhereClause === undefined || row.indexWhereClause === null
        ? null
        : String(row.indexWhereClause),
  };
};

export const isAuditedCustomIndexAction = (
  action: IndexMigrationAction,
  flatIndexesByUniversalIdentifier?: Record<
    string,
    { isCustom?: boolean } | undefined
  >,
): boolean => {
  if (action.metadataName !== 'index') {
    return false;
  }
  if (action.type === 'create') {
    return action.flatEntity?.isCustom === true;
  }
  if (action.type === 'delete') {
    if (action.universalIdentifier === undefined) {
      return true;
    }
    const existing =
      flatIndexesByUniversalIdentifier?.[action.universalIdentifier];

    return existing?.isCustom === true;
  }
  if (action.type === 'update') {
    if (action.update?.isCustom === true) {
      return true;
    }
    if (action.universalIdentifier === undefined) {
      return true;
    }
    const existing =
      flatIndexesByUniversalIdentifier?.[action.universalIdentifier];

    return existing?.isCustom === true;
  }

  return true;
};

export const getIndexMetadataAudit = (
  workspaceId: string,
): IndexMetadataAuditRequest | undefined => {
  const request = storage.getStore();
  if (!request) {
    return undefined;
  }
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Index metadata audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getIndexMetadataAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: IndexMetadataAuditIdentity | undefined,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
  if (identity !== undefined) {
    if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      const direct = identity as {
        workspaceId?: string;
        operationId?: string;
        actor: CrmAuditOperation['actor'];
        initiator?: CrmAuditOperation['initiator'];
        impersonatorUserWorkspaceId?: string;
        correlationId?: string;
        causationId?: string;
      };
      if (
        direct.workspaceId !== undefined &&
        uuid(direct.workspaceId) !== normalizedWorkspaceId
      ) {
        throw new Error('CRM audit context workspace mismatch');
      }
      const operation = Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId:
            direct.operationId !== undefined
              ? uuid(direct.operationId)
              : randomUUID(),
          actor: direct.actor,
          ...(direct.initiator ? { initiator: direct.initiator } : {}),
          correlationId: direct.correlationId ?? randomUUID(),
          ...(direct.causationId ? { causationId: direct.causationId } : {}),
        }),
      );

      return {
        operation,
        ...(direct.impersonatorUserWorkspaceId
          ? {
              impersonatorUserWorkspaceId: uuid(
                direct.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
      };
    }

    if (identity && typeof identity === 'object' && 'auth' in identity) {
      const capturedIdentity = captureRoleAuditIdentity(
        identity as RoleUpdateAuditIdentity,
      );
      const operation = captureRoleAuditOperation(
        normalizedWorkspaceId,
        capturedIdentity,
      );

      return {
        operation,
        ...(capturedIdentity.impersonatorUserWorkspaceId
          ? {
              impersonatorUserWorkspaceId: uuid(
                capturedIdentity.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
      };
    }

    const req = identity as IndexMetadataRequestIdentity;
    if (
      (req.workspace?.id !== undefined &&
        uuid(req.workspace.id) !== normalizedWorkspaceId) ||
      (req.workspaceId !== undefined &&
        uuid(req.workspaceId) !== normalizedWorkspaceId)
    ) {
      throw new Error('CRM audit context workspace mismatch');
    }

    const impersonatorRaw =
      req.impersonationContext?.impersonatorUserWorkspaceId ??
      req.impersonatorUserWorkspaceId;
    const impersonatorUserWorkspaceId =
      impersonatorRaw !== undefined ? uuid(impersonatorRaw) : undefined;

    if (req.user?.id !== undefined) {
      const operation = Object.freeze(
        captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor: { kind: 'coreUser', id: uuid(req.user.id) },
          correlationId: req.correlationId ?? randomUUID(),
          ...(req.causationId ? { causationId: req.causationId } : {}),
        }),
      );

      return {
        operation,
        ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      };
    }

    if (req.apiKey?.id !== undefined) {
      return {
        operation: Object.freeze(
          captureCrmAuditOperation({
            workspaceId: normalizedWorkspaceId,
            operationId: randomUUID(),
            actor: { kind: 'apiKey', id: uuid(req.apiKey.id) },
            correlationId: req.correlationId ?? randomUUID(),
            ...(req.causationId ? { causationId: req.causationId } : {}),
          }),
        ),
      };
    }

    if (req.application?.id !== undefined) {
      return {
        operation: Object.freeze(
          captureCrmAuditOperation({
            workspaceId: normalizedWorkspaceId,
            operationId: randomUUID(),
            actor: { kind: 'application', id: uuid(req.application.id) },
            correlationId: req.correlationId ?? randomUUID(),
            ...(req.causationId ? { causationId: req.causationId } : {}),
          }),
        ),
      };
    }

    const roleIdentity = roleAuditIdentityFromRequest(
      identity as Parameters<typeof roleAuditIdentityFromRequest>[0],
    );
    const capturedIdentity = captureRoleAuditIdentity(roleIdentity);
    const operation = captureRoleAuditOperation(
      normalizedWorkspaceId,
      capturedIdentity,
    );

    return {
      operation,
      ...(capturedIdentity.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              capturedIdentity.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    };
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  if (ambient) {
    return {
      operation: ambient.operation,
      ...(ambient.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              ambient.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    };
  }

  throw new Error(
    'Index metadata mutation requires authenticated audit identity',
  );
};

export const captureIndexMetadataAudit = ({
  workspaceId,
  expectedAction,
  expectedObjectMetadataId,
  expectedDeleteId,
  auditIdentity,
}: {
  workspaceId: string;
  expectedAction: 'create' | 'delete';
  expectedObjectMetadataId?: string;
  expectedDeleteId?: string;
  auditIdentity?: IndexMetadataAuditIdentity;
}): IndexMetadataAuditRequest => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    getIndexMetadataAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getIndexMetadataAudit,
    )
  ) {
    throw new Error('Nested index metadata audit is unsupported');
  }

  const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
    normalizedWorkspaceId,
    auditIdentity,
  );
  const request: IndexMetadataAuditRequest = Object.freeze({
    workspaceId: normalizedWorkspaceId,
    expectedAction,
    ...(expectedObjectMetadataId !== undefined
      ? { expectedObjectMetadataId: uuid(expectedObjectMetadataId) }
      : {}),
    ...(expectedDeleteId !== undefined
      ? { expectedDeleteId: uuid(expectedDeleteId) }
      : {}),
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
  });
  active.add(request);

  return request;
};

export const withIndexMetadataAudit = async <TResult>(
  request: IndexMetadataAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (!request || !active.has(request) || consumed.has(request)) {
    throw new Error('Index metadata audit request is invalid or already used');
  }

  return storage.run(request, work);
};

const readIndexMetadataRows = async (
  runner: QueryRunner,
  workspaceId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows: Array<{ row: Record<string, unknown> }> = await runner.query(
    `SELECT to_jsonb(im) AS row
       FROM core."indexMetadata" im
      WHERE im."workspaceId" = $1
      ORDER BY im.id ASC${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  );

  return new Map(rows.map(({ row }) => [uuid(row.id), row] as const));
};

export const runAuditedIndexMetadataMigration = async <TResult>(
  dataSource: DataSource,
  request: IndexMetadataAuditRequest,
  actions: readonly IndexMigrationAction[],
  mappings: IndexMetadataAuditMappings,
  execute: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (!request || !active.has(request) || consumed.has(request)) {
    throw new Error('Index metadata audit request is invalid or already used');
  }
  consumed.add(request);

  if (actions.length !== 1) {
    throw new Error(
      'Index metadata audit requires exactly one index migration action',
    );
  }
  const [action] = actions;
  if (
    action.metadataName !== 'index' ||
    action.type !== request.expectedAction
  ) {
    throw new Error(
      `Index metadata audit action mismatch: expected index/${request.expectedAction}`,
    );
  }

  if (request.expectedAction === 'create') {
    if (action.flatEntity?.isCustom !== true) {
      throw new Error('Index metadata create audit requires custom index');
    }
  } else {
    const mapped =
      action.universalIdentifier !== undefined
        ? mappings.indexes?.[action.universalIdentifier]
        : undefined;
    if (
      request.expectedDeleteId !== undefined &&
      mapped?.id !== undefined &&
      uuid(mapped.id) !== request.expectedDeleteId
    ) {
      throw new Error('Index metadata delete target mismatch');
    }
  }

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");

    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [request.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null) {
      throw new Error('Index metadata audit workspace unavailable');
    }

    const operation = Object.freeze(
      await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      ),
    );

    const beforeMap = await readIndexMetadataRows(
      runner,
      request.workspaceId,
      true,
    );

    const result = await execute(runner);

    const afterMap = await readIndexMetadataRows(
      runner,
      request.workspaceId,
      true,
    );

    const audit = new CrmAuditTransactionContext(runner, operation);
    let recordedCount = 0;

    if (request.expectedAction === 'create') {
      for (const [id, beforeRow] of beforeMap.entries()) {
        const afterRow = afterMap.get(id);
        if (
          !afterRow ||
          canonicalAuditJson(projectIndexMetadata(beforeRow)) !==
            canonicalAuditJson(projectIndexMetadata(afterRow))
        ) {
          throw new Error(
            'Index metadata create audit detected unexpected modification of existing index',
          );
        }
      }
      const createdEntries = [...afterMap.entries()].filter(
        ([id]) => !beforeMap.has(id),
      );
      if (createdEntries.length !== 1) {
        throw new Error(
          'Index metadata create audit expected exactly one created row',
        );
      }
      const [createdId, createdRow] = createdEntries[0];
      const createdProj = projectIndexMetadata(createdRow);
      if (
        request.expectedObjectMetadataId !== undefined &&
        createdProj.objectMetadataId !== request.expectedObjectMetadataId
      ) {
        throw new Error('Index metadata create persisted unexpected object');
      }
      if (!createdProj.isCustom) {
        throw new Error('Index metadata create persisted non-custom index');
      }
      audit.record({
        resourceKind: 'indexMetadata',
        resourceId: createdId,
        action: 'create',
        before: null,
        after: createdProj,
        securityDescriptor: {
          resourceKind: 'indexMetadata',
          resourceId: createdId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedCount += 1;
    } else {
      for (const id of afterMap.keys()) {
        if (!beforeMap.has(id)) {
          throw new Error(
            'Index metadata delete audit detected unexpected created index',
          );
        }
      }
      const deletedEntries: Array<[string, Record<string, unknown>]> = [];
      for (const [id, beforeRow] of beforeMap.entries()) {
        const afterRow = afterMap.get(id);
        if (!afterRow) {
          deletedEntries.push([id, beforeRow]);
        } else if (
          canonicalAuditJson(projectIndexMetadata(beforeRow)) !==
          canonicalAuditJson(projectIndexMetadata(afterRow))
        ) {
          throw new Error(
            'Index metadata delete audit detected unexpected update of existing index',
          );
        }
      }
      if (deletedEntries.length !== 1) {
        throw new Error(
          'Index metadata delete audit expected exactly one deleted row',
        );
      }
      const [deletedId, deletedRow] = deletedEntries[0];
      if (
        request.expectedDeleteId !== undefined &&
        deletedId !== request.expectedDeleteId
      ) {
        throw new Error('Index metadata delete removed unexpected row');
      }
      const deletedProj = projectIndexMetadata(deletedRow);
      if (!deletedProj.isCustom) {
        throw new Error('Index metadata delete removed non-custom index');
      }
      audit.record({
        resourceKind: 'indexMetadata',
        resourceId: deletedId,
        action: 'delete',
        before: deletedProj,
        after: null,
        securityDescriptor: {
          resourceKind: 'indexMetadata',
          resourceId: deletedId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedCount += 1;
    }

    if (recordedCount > 0) {
      const expectedSerialized = canonicalAuditJson(
        [...afterMap.entries()].map(([id, row]) => ({
          id,
          ...projectIndexMetadata(row),
        })),
      );
      await audit.flush();

      const postFlushMap = await readIndexMetadataRows(
        runner,
        request.workspaceId,
        false,
      );
      const actualSerialized = canonicalAuditJson(
        [...postFlushMap.entries()].map(([id, row]) => ({
          id,
          ...projectIndexMetadata(row),
        })),
      );
      if (actualSerialized !== expectedSerialized) {
        throw new Error('Index metadata state changed during audit flush');
      }
    }

    return result;
  });
};
