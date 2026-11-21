import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { isUUID } from 'class-validator';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  createCrmAuditWorkspaceExecutor,
  type CrmAuditTransactionExecutor,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type CrmAuditOperation,
  type CrmAuditPrincipal,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

export type RecordShareAuditWorkspaceScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0];

export type RecordShareRequestContext = {
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  impersonatorUserWorkspaceId?: string;
  correlationId?: string;
  causationId?: string;
};

export type RecordShareAuthContext = {
  type: string;
  workspace: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  application?: { id?: string } | null;
  viaApplication?: { id?: string } | null;
  agentId?: string;
};

export type RecordShareAuditCapture = Readonly<{
  workspaceId: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type PreparedRecordShareAuditTransaction = Readonly<{
  executor: CrmAuditTransactionExecutor;
  workspaceId: string;
  operation: CrmAuditOperation;
}>;

export type RecordShareExpectedScope =
  | {
      kind: 'manualPrincipal';
      mode: 'set';
      principalId: string;
      principalType: 'WORKSPACE_MEMBER' | 'ROLE';
      accessLevel: 'READ' | 'READ_WRITE' | 'FULL';
    }
  | {
      kind: 'manualPrincipal';
      mode: 'remove';
      principalId: string;
      principalType: 'WORKSPACE_MEMBER' | 'ROLE';
    }
  | {
      kind: 'generalAccess';
      sharingMode: 'OPEN_BY_DEFAULT' | 'PRIVATE' | 'INHERITED' | 'ROLE_ONLY';
      accessLevel: 'NONE' | 'READ' | 'READ_WRITE' | 'FULL';
      isDefaultAccess: boolean;
      allowedOwnerPrincipalIds: readonly string[];
    };

type RecordShareRowProjection = {
  objectMetadataId: string;
  recordId: string;
  principalId: string;
  principalType: string;
  accessLevel: string;
  rowCause: string;
  sourceId: string;
};

// Matches EVERYONE_PRINCIPAL_ID without pulling Enterprise-reachable barrels.
const EVERYONE_PRINCIPAL_ID_LOWER = '5047ca8f-514a-4609-8ef4-1bb63f3084c5';
const VALID_PRINCIPAL_TYPES = new Set([
  'EVERYONE',
  'WORKSPACE_MEMBER',
  'ROLE',
]);
const VALID_ACCESS_LEVELS = new Set(['NONE', 'READ', 'READ_WRITE', 'FULL']);
const VALID_ROW_CAUSES = new Set(['MANUAL', 'OWNER', 'APPLICATION', 'RULE']);

const consumedCaptures = new WeakSet<RecordShareAuditCapture>();
const consumedPrepared = new WeakSet<PreparedRecordShareAuditTransaction>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Record share audit UUID is invalid');
  }

  return value.toLowerCase();
};

const quoteIdent = (name: string): string =>
  '"' + name.replaceAll('"', '""') + '"';

const workspaceSchemaName = (workspaceId: string): string =>
  `workspace_${BigInt('0x' + uuid(workspaceId).replaceAll('-', '')).toString(36)}`;

const recordShareTable = (workspaceId: string): string =>
  `${quoteIdent(workspaceSchemaName(workspaceId))}.${quoteIdent('recordShare')}`;

export const assertRecordShareRowInvariants = (
  row: Record<string, unknown>,
  expectedObjectMetadataId?: string,
  expectedRecordId?: string,
): void => {
  uuid(row.id);
  const objectMetadataId = uuid(row.objectMetadataId);
  const recordId = uuid(row.recordId);
  uuid(row.principalId);
  uuid(row.sourceId);

  if (
    expectedObjectMetadataId !== undefined &&
    objectMetadataId !== uuid(expectedObjectMetadataId)
  ) {
    throw new Error('Record share audit row objectMetadataId mismatch');
  }
  if (expectedRecordId !== undefined && recordId !== uuid(expectedRecordId)) {
    throw new Error('Record share audit row recordId mismatch');
  }
  if (
    typeof row.principalType !== 'string' ||
    !VALID_PRINCIPAL_TYPES.has(row.principalType)
  ) {
    throw new Error('Record share audit row principalType is invalid');
  }
  if (
    typeof row.accessLevel !== 'string' ||
    !VALID_ACCESS_LEVELS.has(row.accessLevel)
  ) {
    throw new Error('Record share audit row accessLevel is invalid');
  }
  if (
    typeof row.rowCause !== 'string' ||
    !VALID_ROW_CAUSES.has(row.rowCause)
  ) {
    throw new Error('Record share audit row rowCause is invalid');
  }
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    throw new Error('Record share audit detected soft-deleted recordShare row');
  }
};

export const projectRecordShare = (
  row: Record<string, unknown>,
): RecordShareRowProjection => ({
  objectMetadataId: uuid(row.objectMetadataId),
  recordId: uuid(row.recordId),
  principalId: uuid(row.principalId),
  principalType: String(row.principalType),
  accessLevel: String(row.accessLevel),
  rowCause: String(row.rowCause),
  sourceId: uuid(row.sourceId),
});

const serializeSnapshot = (
  rows: Map<string, Record<string, unknown>>,
): string =>
  canonicalAuditJson(
    [...rows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, row]) => [id, projectRecordShare(row)]),
  );

const verifyWorkspaceActive = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  lock: boolean,
): Promise<void> => {
  const rows = (await executor.query(
    `SELECT id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
       FROM core.workspace w
      WHERE w.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [workspaceId],
  )) as Array<{ id: string; deletedAt: string | null }>;

  if (rows.length !== 1 || rows[0].deletedAt !== null) {
    throw new Error('Record share audit workspace unavailable');
  }
};

export const captureRecordShareAudit = ({
  workspaceId,
  authContext,
  agentId,
  requestContext,
}: {
  workspaceId: string;
  authContext: RecordShareAuthContext;
  agentId?: string;
  requestContext?: RecordShareRequestContext;
}): RecordShareAuditCapture => {
  const normalizedWorkspaceId = uuid(workspaceId);
  if (!authContext || authContext.type !== 'user') {
    throw new Error('Record share audit requires authenticated user context');
  }
  if (uuid(authContext.workspace?.id) !== normalizedWorkspaceId) {
    throw new Error('Record share audit workspace mismatch');
  }
  const userId = uuid(authContext.user?.id);
  uuid(authContext.userWorkspaceId);
  const workspaceMemberId = uuid(authContext.workspaceMemberId);

  const directAppId =
    authContext.application !== undefined && authContext.application !== null
      ? uuid(authContext.application.id)
      : undefined;
  const viaAppId =
    authContext.viaApplication !== undefined &&
    authContext.viaApplication !== null
      ? uuid(authContext.viaApplication.id)
      : undefined;
  if (directAppId && viaAppId && directAppId !== viaAppId) {
    throw new Error('Conflicting application identifiers in record share auth');
  }
  let resolvedApplicationId = directAppId ?? viaAppId;

  const argAgentId = agentId !== undefined ? uuid(agentId) : undefined;
  const ctxAgentId =
    authContext.agentId !== undefined ? uuid(authContext.agentId) : undefined;
  if (argAgentId && ctxAgentId && argAgentId !== ctxAgentId) {
    throw new Error('Conflicting agentId in record share auth');
  }
  let resolvedAgentId = argAgentId ?? ctxAgentId;

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  let resolvedAmbientInitiator: CrmAuditPrincipal | undefined;

  if (ambient) {
    const ambientActor = ambient.operation.actor;
    const ambientInitiator = ambient.operation.initiator;
    if (ambientActor.kind === 'coreUser') {
      if (ambientActor.id !== userId) {
        throw new Error('Record share audit ambient user conflict');
      }
      if (ambientInitiator) {
        resolvedAmbientInitiator = ambientInitiator;
      }
    } else if (ambientActor.kind === 'workspaceMember') {
      if (ambientActor.id !== workspaceMemberId) {
        throw new Error('Record share audit ambient member conflict');
      }
      if (ambientInitiator) {
        resolvedAmbientInitiator = ambientInitiator;
      }
    } else if (ambientActor.kind === 'application') {
      if (
        resolvedApplicationId !== undefined &&
        resolvedApplicationId !== ambientActor.id
      ) {
        throw new Error('Record share audit ambient application conflict');
      }
      resolvedApplicationId = resolvedApplicationId ?? ambientActor.id;
      if (
        ambientInitiator &&
        ((ambientInitiator.kind === 'coreUser' &&
          ambientInitiator.id !== userId) ||
          (ambientInitiator.kind === 'workspaceMember' &&
            ambientInitiator.id !== workspaceMemberId))
      ) {
        throw new Error('Record share audit ambient initiator conflict');
      }
    } else if (ambientActor.kind === 'agent') {
      if (resolvedAgentId !== undefined && resolvedAgentId !== ambientActor.id) {
        throw new Error('Record share audit ambient agent conflict');
      }
      resolvedAgentId = resolvedAgentId ?? ambientActor.id;
      if (
        ambientInitiator &&
        ((ambientInitiator.kind === 'coreUser' &&
          ambientInitiator.id !== userId) ||
          (ambientInitiator.kind === 'workspaceMember' &&
            ambientInitiator.id !== workspaceMemberId) ||
          (ambientInitiator.kind === 'application' &&
            resolvedApplicationId !== undefined &&
            ambientInitiator.id !== resolvedApplicationId))
      ) {
        throw new Error('Record share audit ambient initiator conflict');
      }
    } else {
      throw new Error('Record share audit ambient principal conflict');
    }
  }

  const nestedImpersonator =
    requestContext?.impersonationContext?.impersonatorUserWorkspaceId !==
    undefined
      ? uuid(requestContext.impersonationContext.impersonatorUserWorkspaceId)
      : undefined;
  const directImpersonator =
    requestContext?.impersonatorUserWorkspaceId !== undefined
      ? uuid(requestContext.impersonatorUserWorkspaceId)
      : undefined;
  if (
    nestedImpersonator &&
    directImpersonator &&
    nestedImpersonator !== directImpersonator
  ) {
    throw new Error('Record share audit impersonation context conflict');
  }
  const reqImpersonator = nestedImpersonator ?? directImpersonator;
  const ambientImpersonator =
    ambient?.impersonatorUserWorkspaceId !== undefined
      ? uuid(ambient.impersonatorUserWorkspaceId)
      : undefined;

  if (
    reqImpersonator &&
    ambientImpersonator &&
    reqImpersonator !== ambientImpersonator
  ) {
    throw new Error('Record share audit impersonation context conflict');
  }
  const impersonatorUserWorkspaceId = reqImpersonator ?? ambientImpersonator;

  if (
    (impersonatorUserWorkspaceId !== undefined ||
      resolvedAmbientInitiator !== undefined) &&
    (resolvedAgentId !== undefined || resolvedApplicationId !== undefined)
  ) {
    throw new Error(
      'Record share audit impersonation cannot combine with agent or application',
    );
  }

  let actor: CrmAuditPrincipal;
  let initiator: CrmAuditPrincipal | undefined;

  if (resolvedAgentId) {
    actor = { kind: 'agent', id: resolvedAgentId };
    initiator = { kind: 'workspaceMember', id: workspaceMemberId };
  } else if (resolvedApplicationId) {
    actor = { kind: 'application', id: resolvedApplicationId };
    initiator = { kind: 'workspaceMember', id: workspaceMemberId };
  } else {
    actor = { kind: 'workspaceMember', id: workspaceMemberId };
    initiator = resolvedAmbientInitiator;
  }

  const correlationId =
    typeof requestContext?.correlationId === 'string' &&
    requestContext.correlationId.length > 0
      ? requestContext.correlationId
      : ambient?.operation.correlationId;
  const causationId =
    typeof requestContext?.causationId === 'string' &&
    requestContext.causationId.length > 0
      ? requestContext.causationId
      : ambient?.operation.causationId;

  const operation = captureCrmAuditOperation({
    workspaceId: normalizedWorkspaceId,
    operationId: randomUUID(),
    actor,
    ...(initiator ? { initiator } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(causationId ? { causationId } : {}),
  });

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    operation,
    ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
  });
};

export const beginRecordShareAuditTransaction = async (
  scope: RecordShareAuditWorkspaceScope,
  capture: RecordShareAuditCapture,
): Promise<PreparedRecordShareAuditTransaction> => {
  if (!capture || typeof capture !== 'object' || consumedCaptures.has(capture)) {
    throw new Error('Record share audit capture is invalid or reused');
  }
  consumedCaptures.add(capture);

  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (uuid(scope.workspaceId) !== capture.workspaceId) {
    throw new Error('Record share audit transaction workspace mismatch');
  }

  await executor.query("SET LOCAL lock_timeout = '8s'");
  await verifyWorkspaceActive(executor, capture.workspaceId, true);

  let operation = capture.operation;
  if (capture.impersonatorUserWorkspaceId) {
    const rows = (await executor.query(
      `SELECT "userId"
         FROM core."userWorkspace"
        WHERE id = $1 AND "deletedAt" IS NULL`,
      [capture.impersonatorUserWorkspaceId],
    )) as Array<{ userId: string }>;

    if (rows.length !== 1) {
      throw new Error('Record share audit impersonation initiator unavailable');
    }

    const resolvedInitiatorId = uuid(rows[0].userId);
    if (
      operation.initiator &&
      (operation.initiator.kind !== 'coreUser' ||
        operation.initiator.id !== resolvedInitiatorId)
    ) {
      throw new Error('Record share audit impersonation context conflict');
    }

    operation = captureCrmAuditOperation({
      ...operation,
      initiator: { kind: 'coreUser', id: resolvedInitiatorId },
    });
  }

  return Object.freeze({
    executor,
    workspaceId: capture.workspaceId,
    operation,
  });
};

const readRecordShareSnapshotForRecord = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  objectMetadataId: string,
  recordId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = (await executor.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM ${recordShareTable(workspaceId)}
      WHERE "objectMetadataId" = $1 AND "recordId" = $2
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [objectMetadataId, recordId],
  )) as Array<Record<string, unknown>>;

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    assertRecordShareRowInvariants(row, objectMetadataId, recordId);
    map.set(uuid(row.id), row);
  }

  return map;
};

const assertExpectedScopeMutation = ({
  action,
  beforeProj,
  afterProj,
  recordId,
  expectedScope,
}: {
  action: 'create' | 'update' | 'delete';
  beforeProj: RecordShareRowProjection | null;
  afterProj: RecordShareRowProjection | null;
  recordId: string;
  expectedScope: RecordShareExpectedScope;
}): void => {
  if (action === 'update' && beforeProj && afterProj) {
    if (
      beforeProj.objectMetadataId !== afterProj.objectMetadataId ||
      beforeProj.recordId !== afterProj.recordId ||
      beforeProj.principalId !== afterProj.principalId ||
      beforeProj.principalType !== afterProj.principalType ||
      beforeProj.rowCause !== afterProj.rowCause ||
      beforeProj.sourceId !== afterProj.sourceId
    ) {
      throw new Error('Record share update mutated immutable identity fields');
    }
  }

  if (expectedScope.kind === 'manualPrincipal') {
    const expectedPrincipalId = uuid(expectedScope.principalId);
    const proj = afterProj ?? beforeProj;
    if (
      !proj ||
      proj.rowCause !== 'MANUAL' ||
      proj.principalType !== expectedScope.principalType ||
      proj.principalId !== expectedPrincipalId
    ) {
      throw new Error(
        'Record share mutation touched unexpected principal or rowCause',
      );
    }
    if (expectedScope.mode === 'remove' && action !== 'delete') {
      throw new Error('Record share removal only allows delete mutations');
    }
    if ((action === 'create' || action === 'update') && afterProj) {
      if (afterProj.sourceId !== recordId) {
        throw new Error('Record share manual write persisted unexpected sourceId');
      }
      if (
        expectedScope.mode === 'set' &&
        afterProj.accessLevel !== expectedScope.accessLevel
      ) {
        throw new Error(
          'Record share manual write persisted unexpected accessLevel',
        );
      }
    }

    return;
  }

  const proj = afterProj ?? beforeProj;
  if (!proj) {
    throw new Error('Record share mutation missing projection');
  }

  const isEveryoneManual =
    proj.rowCause === 'MANUAL' &&
    proj.principalType === 'EVERYONE' &&
    proj.principalId === EVERYONE_PRINCIPAL_ID_LOWER;

  if (isEveryoneManual) {
    if (action === 'create' || action === 'update') {
      if (
        expectedScope.isDefaultAccess ||
        !afterProj ||
        afterProj.sourceId !== recordId ||
        afterProj.accessLevel !== expectedScope.accessLevel
      ) {
        throw new Error(
          'Record share general access persisted unexpected EVERYONE grant',
        );
      }
    }

    return;
  }

  const isOwnerRow =
    proj.rowCause === 'OWNER' && proj.principalType === 'WORKSPACE_MEMBER';

  if (isOwnerRow && expectedScope.sharingMode === 'OPEN_BY_DEFAULT') {
    if (action === 'update') {
      throw new Error('Record share general access cannot update OWNER rows');
    }
    if (action === 'delete') {
      if (!expectedScope.isDefaultAccess) {
        throw new Error(
          'Record share general access can delete OWNER rows only on default access',
        );
      }

      return;
    }
    const isRestriction =
      expectedScope.accessLevel === 'NONE' ||
      expectedScope.accessLevel === 'READ';
    const allowedOwners = new Set(
      expectedScope.allowedOwnerPrincipalIds.map((id) => uuid(id)),
    );
    if (
      !isRestriction ||
      !afterProj ||
      afterProj.accessLevel !== 'FULL' ||
      afterProj.sourceId !== recordId ||
      !allowedOwners.has(afterProj.principalId)
    ) {
      throw new Error(
        'Record share general access created unexpected OWNER row',
      );
    }

    return;
  }

  throw new Error('Record share general access touched unauthorized share row');
};

export const runAuditedRecordShareScopeMutation = async <TResult>(
  prepared: PreparedRecordShareAuditTransaction,
  {
    objectMetadataId,
    recordId,
    expectedScope,
  }: {
    objectMetadataId: string;
    recordId: string;
    expectedScope: RecordShareExpectedScope;
  },
  write: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !prepared ||
    typeof prepared !== 'object' ||
    consumedPrepared.has(prepared)
  ) {
    throw new Error('Prepared record share audit transaction is invalid or reused');
  }
  consumedPrepared.add(prepared);

  const normalizedObjectMetadataId = uuid(objectMetadataId);
  const normalizedRecordId = uuid(recordId);
  const { executor, workspaceId, operation } = prepared;

  const before = await readRecordShareSnapshotForRecord(
    executor,
    workspaceId,
    normalizedObjectMetadataId,
    normalizedRecordId,
    true,
  );

  const result = await write();

  const after = await readRecordShareSnapshotForRecord(
    executor,
    workspaceId,
    normalizedObjectMetadataId,
    normalizedRecordId,
    false,
  );

  const audit = new CrmAuditTransactionContext(executor, operation);
  let recordedMutations = 0;

  for (const [id, beforeRow] of before.entries()) {
    const beforeProj = projectRecordShare(beforeRow);
    const afterRow = after.get(id);
    if (!afterRow) {
      assertExpectedScopeMutation({
        action: 'delete',
        beforeProj,
        afterProj: null,
        recordId: normalizedRecordId,
        expectedScope,
      });
      audit.record({
        resourceKind: 'recordShare',
        resourceId: id,
        action: 'delete',
        before: beforeProj,
        after: null,
        securityDescriptor: {
          resourceKind: 'recordShare',
          resourceId: id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
      continue;
    }

    const afterProj = projectRecordShare(afterRow);
    if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
      assertExpectedScopeMutation({
        action: 'update',
        beforeProj,
        afterProj,
        recordId: normalizedRecordId,
        expectedScope,
      });
      audit.record({
        resourceKind: 'recordShare',
        resourceId: id,
        action: 'update',
        before: beforeProj,
        after: afterProj,
        securityDescriptor: {
          resourceKind: 'recordShare',
          resourceId: id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
    }
  }

  for (const [id, afterRow] of after.entries()) {
    if (before.has(id)) {
      continue;
    }
    const afterProj = projectRecordShare(afterRow);
    assertExpectedScopeMutation({
      action: 'create',
      beforeProj: null,
      afterProj,
      recordId: normalizedRecordId,
      expectedScope,
    });
    audit.record({
      resourceKind: 'recordShare',
      resourceId: id,
      action: 'create',
      before: null,
      after: afterProj,
      securityDescriptor: {
        resourceKind: 'recordShare',
        resourceId: id,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    recordedMutations += 1;
  }

  const afterProjections = [...after.values()].map(projectRecordShare);
  if (expectedScope.kind === 'manualPrincipal') {
    const expectedPrincipalId = uuid(expectedScope.principalId);
    const matching = afterProjections.filter(
      (proj) =>
        proj.rowCause === 'MANUAL' &&
        proj.principalType === expectedScope.principalType &&
        proj.principalId === expectedPrincipalId,
    );
    if (expectedScope.mode === 'set') {
      if (
        matching.length !== 1 ||
        matching[0].sourceId !== normalizedRecordId ||
        matching[0].accessLevel !== expectedScope.accessLevel
      ) {
        throw new Error(
          'Record share manual write did not persist expected final grant',
        );
      }
    } else if (matching.length !== 0) {
      throw new Error('Record share removal did not remove target grant');
    }
  } else {
    const everyoneManual = afterProjections.filter(
      (proj) =>
        proj.rowCause === 'MANUAL' &&
        proj.principalType === 'EVERYONE' &&
        proj.principalId === EVERYONE_PRINCIPAL_ID_LOWER,
    );
    if (expectedScope.isDefaultAccess) {
      if (everyoneManual.length !== 0) {
        throw new Error(
          'Record share default general access left EVERYONE row behind',
        );
      }
      if (
        expectedScope.sharingMode === 'OPEN_BY_DEFAULT' &&
        afterProjections.some((proj) => proj.rowCause === 'OWNER')
      ) {
        throw new Error(
          'Record share default general access left OWNER row behind',
        );
      }
    } else if (
      everyoneManual.length !== 1 ||
      everyoneManual[0].sourceId !== normalizedRecordId ||
      everyoneManual[0].accessLevel !== expectedScope.accessLevel
    ) {
      throw new Error(
        'Record share general access did not persist expected EVERYONE grant',
      );
    }
  }

  if (recordedMutations > 0) {
    const expectedSerialized = serializeSnapshot(after);
    await audit.flush();
    await executor.query('SET CONSTRAINTS ALL IMMEDIATE');
    await verifyWorkspaceActive(executor, workspaceId, false);
    const postFlush = await readRecordShareSnapshotForRecord(
      executor,
      workspaceId,
      normalizedObjectMetadataId,
      normalizedRecordId,
      false,
    );
    if (serializeSnapshot(postFlush) !== expectedSerialized) {
      throw new Error('Record share audit detected post-flush row drift');
    }
  }

  return result;
};

export const validateRecordShareTransferAuditInput = ({
  workspaceId,
  objectMetadataIds,
  fromWorkspaceMemberId,
  toWorkspaceMemberId,
  auditOperation,
}: {
  workspaceId: string;
  objectMetadataIds?: readonly string[];
  fromWorkspaceMemberId: string;
  toWorkspaceMemberId?: string;
  auditOperation?: CrmAuditOperation;
}): {
  workspaceId: string;
  objectMetadataIds: string[];
  fromWorkspaceMemberId: string;
  toWorkspaceMemberId?: string;
  capturedOperation?: CrmAuditOperation;
} => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedObjectMetadataIds = objectMetadataIds
    ? [...new Set(objectMetadataIds.map((id) => uuid(id)))].sort()
    : [];
  const normalizedFromId = uuid(fromWorkspaceMemberId);
  const normalizedToId =
    toWorkspaceMemberId !== undefined ? uuid(toWorkspaceMemberId) : undefined;

  if (normalizedToId !== undefined && normalizedToId === normalizedFromId) {
    throw new Error(
      'Record share ownership transfer cannot target the departing member',
    );
  }

  let capturedOperation: CrmAuditOperation | undefined;
  if (auditOperation !== undefined) {
    capturedOperation = captureCrmAuditOperation({
      ...auditOperation,
      operationId: randomUUID(),
    });
    if (capturedOperation.workspaceId !== normalizedWorkspaceId) {
      throw new Error('Record share transfer audit workspace mismatch');
    }
  }

  return {
    workspaceId: normalizedWorkspaceId,
    objectMetadataIds: normalizedObjectMetadataIds,
    fromWorkspaceMemberId: normalizedFromId,
    ...(normalizedToId !== undefined
      ? { toWorkspaceMemberId: normalizedToId }
      : {}),
    ...(capturedOperation !== undefined ? { capturedOperation } : {}),
  };
};

const readTransferSnapshot = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  objectMetadataIds: readonly string[],
  principalIds: readonly string[],
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = (await executor.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM ${recordShareTable(workspaceId)}
      WHERE "objectMetadataId" = ANY($1::uuid[])
        AND "principalType" = 'WORKSPACE_MEMBER'
        AND "principalId" = ANY($2::uuid[])
        AND "rowCause" IN ('OWNER', 'MANUAL')
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [objectMetadataIds, principalIds],
  )) as Array<Record<string, unknown>>;

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    assertRecordShareRowInvariants(row);
    map.set(uuid(row.id), row);
  }

  return map;
};

const transferSourceKey = (proj: RecordShareRowProjection): string =>
  `${proj.objectMetadataId}:${proj.recordId}:${proj.rowCause}:${proj.sourceId}`;

const transferRowKey = (proj: RecordShareRowProjection): string =>
  `${proj.objectMetadataId}:${proj.recordId}:${proj.rowCause}`;

export const runAuditedRecordShareTransfer = async ({
  scope,
  workspaceId,
  objectMetadataIds,
  fromWorkspaceMemberId,
  toWorkspaceMemberId,
  auditOperation,
  execute,
}: {
  scope: RecordShareAuditWorkspaceScope;
  workspaceId: string;
  objectMetadataIds: readonly string[];
  fromWorkspaceMemberId: string;
  toWorkspaceMemberId?: string;
  auditOperation?: CrmAuditOperation;
  execute: () => Promise<void>;
}): Promise<void> => {
  const validated = validateRecordShareTransferAuditInput({
    workspaceId,
    objectMetadataIds,
    fromWorkspaceMemberId,
    toWorkspaceMemberId,
    auditOperation,
  });
  const normalizedObjectIds = validated.objectMetadataIds;
  if (normalizedObjectIds.length === 0) {
    return;
  }

  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (uuid(scope.workspaceId) !== validated.workspaceId) {
    throw new Error('Record share transfer transaction workspace mismatch');
  }

  await executor.query("SET LOCAL lock_timeout = '8s'");
  await verifyWorkspaceActive(executor, validated.workspaceId, true);

  const principalIds = validated.toWorkspaceMemberId
    ? [validated.fromWorkspaceMemberId, validated.toWorkspaceMemberId].sort()
    : [validated.fromWorkspaceMemberId];

  const before = await readTransferSnapshot(
    executor,
    validated.workspaceId,
    normalizedObjectIds,
    principalIds,
    true,
  );

  const fromFullSourceKeys = new Set<string>();
  const fromFullRowKeys = new Set<string>();
  for (const beforeRow of before.values()) {
    const proj = projectRecordShare(beforeRow);
    if (
      proj.principalId === validated.fromWorkspaceMemberId &&
      proj.accessLevel === 'FULL'
    ) {
      fromFullSourceKeys.add(transferSourceKey(proj));
      fromFullRowKeys.add(transferRowKey(proj));
    }
  }

  await execute();

  const after = await readTransferSnapshot(
    executor,
    validated.workspaceId,
    normalizedObjectIds,
    principalIds,
    false,
  );

  type TransferMutation =
    | { action: 'create'; id: string; before: null; after: RecordShareRowProjection }
    | {
        action: 'update';
        id: string;
        before: RecordShareRowProjection;
        after: RecordShareRowProjection;
      }
    | { action: 'delete'; id: string; before: RecordShareRowProjection; after: null };

  const mutations: TransferMutation[] = [];

  for (const [id, beforeRow] of before.entries()) {
    const beforeProj = projectRecordShare(beforeRow);
    const afterRow = after.get(id);
    if (!afterRow) {
      if (beforeProj.principalId !== validated.fromWorkspaceMemberId) {
        throw new Error(
          'Record share transfer deleted non-departing member grant',
        );
      }
      mutations.push({ action: 'delete', id, before: beforeProj, after: null });
      continue;
    }

    if (beforeProj.principalId === validated.fromWorkspaceMemberId) {
      throw new Error(
        'Record share transfer left departing member grant unremoved',
      );
    }

    const afterProj = projectRecordShare(afterRow);
    if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
      if (
        !validated.toWorkspaceMemberId ||
        beforeProj.principalId !== validated.toWorkspaceMemberId ||
        beforeProj.objectMetadataId !== afterProj.objectMetadataId ||
        beforeProj.recordId !== afterProj.recordId ||
        beforeProj.principalId !== afterProj.principalId ||
        beforeProj.principalType !== afterProj.principalType ||
        beforeProj.rowCause !== afterProj.rowCause ||
        beforeProj.sourceId !== afterProj.sourceId ||
        beforeProj.accessLevel === 'FULL' ||
        afterProj.accessLevel !== 'FULL' ||
        !fromFullRowKeys.has(transferRowKey(beforeProj))
      ) {
        throw new Error(
          'Record share transfer performed unauthorized custodian update',
        );
      }
      mutations.push({
        action: 'update',
        id,
        before: beforeProj,
        after: afterProj,
      });
    }
  }

  for (const [id, afterRow] of after.entries()) {
    if (before.has(id)) {
      continue;
    }
    const afterProj = projectRecordShare(afterRow);
    if (
      !validated.toWorkspaceMemberId ||
      afterProj.principalId !== validated.toWorkspaceMemberId ||
      afterProj.accessLevel !== 'FULL' ||
      !fromFullSourceKeys.has(transferSourceKey(afterProj))
    ) {
      throw new Error(
        'Record share transfer created unauthorized grant row',
      );
    }
    mutations.push({ action: 'create', id, before: null, after: afterProj });
  }

  if (validated.toWorkspaceMemberId && fromFullRowKeys.size > 0) {
    const custodianFullRowKeys = new Set<string>();
    for (const afterRow of after.values()) {
      const afterProj = projectRecordShare(afterRow);
      if (
        afterProj.principalId === validated.toWorkspaceMemberId &&
        afterProj.accessLevel === 'FULL'
      ) {
        custodianFullRowKeys.add(transferRowKey(afterProj));
      }
    }
    for (const requiredKey of fromFullRowKeys) {
      if (!custodianFullRowKeys.has(requiredKey)) {
        throw new Error(
          'Record share transfer did not persist expected custodian FULL grant',
        );
      }
    }
  }

  const expectedSerialized = serializeSnapshot(after);
  const verifyState = async (): Promise<void> => {
    await executor.query('SET CONSTRAINTS ALL IMMEDIATE');
    await verifyWorkspaceActive(executor, validated.workspaceId, false);
    const current = await readTransferSnapshot(
      executor,
      validated.workspaceId,
      normalizedObjectIds,
      principalIds,
      false,
    );
    if (serializeSnapshot(current) !== expectedSerialized) {
      throw new Error('Record share transfer audit detected post-flush drift');
    }
  };

  if (mutations.length === 0) {
    return;
  }

  await verifyState();

  let unavailable = !validated.capturedOperation;
  if (validated.capturedOperation) {
    await executor.query('SAVEPOINT record_share_transfer_audit');
    try {
      const audit = new CrmAuditTransactionContext(
        executor,
        validated.capturedOperation,
      );
      for (const mutation of mutations) {
        audit.record({
          resourceKind: 'recordShare',
          resourceId: mutation.id,
          action: mutation.action,
          before: mutation.before,
          after: mutation.after,
          securityDescriptor: {
            resourceKind: 'recordShare',
            resourceId: mutation.id,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
      await audit.flush();
      await verifyState();
    } catch {
      await executor.query('ROLLBACK TO SAVEPOINT record_share_transfer_audit');
      unavailable = true;
    }
    await executor.query('RELEASE SAVEPOINT record_share_transfer_audit');
  }

  await verifyState();

  if (unavailable) {
    new Logger('RecordShareTransfer').error(
      'RECORD_SHARE_TRANSFER_AUDIT_UNAVAILABLE',
    );
  }
};
