import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { reportCrmAuditUnavailable } from 'src/engine/core-modules/crm-audit/crm-audit-health';
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
import { runInNativeCrmAuditScopeIfPresent } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';

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
    const emitUnavailable = () =>
      reportCrmAuditUnavailable({
        code: 'RECORD_SHARE_TRANSFER_AUDIT_UNAVAILABLE',
        loggerContext: 'RecordShareTransfer',
        workspaceId: validated.workspaceId,
      });
    const afterCommit = (
      scope as { afterCommit?: (callback: () => void) => void }
    ).afterCommit;

    if (typeof afterCommit === 'function') {
      afterCommit(emitUnavailable);
    } else {
      emitUnavailable();
    }
  }
};

export type RecordShareDesiredInput = {
  objectMetadataId: string;
  recordId: string;
  principalId: string;
  principalType: string;
  accessLevel: string;
  rowCause: string;
  sourceId: string;
};

export type ShareWithAuditAuthContext = {
  type: string;
  workspace: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  apiKey?: { id?: string } | null;
  application?: { id?: string } | null;
  viaApplication?: { id?: string } | null;
  actingAgent?: { id?: string } | null;
  agentId?: string;
};

const standaloneShareWithCorrelationIds = new WeakMap<object, string>();

const verifyWorkspaceKeyShare = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
): Promise<void> => {
  const rows = (await executor.query(
    `SELECT id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
       FROM core.workspace w
      WHERE w.id = $1
        FOR KEY SHARE`,
    [workspaceId],
  )) as Array<{ id: string; deletedAt: string | null }>;

  if (rows.length !== 1 || rows[0].deletedAt !== null) {
    throw new Error('Record share audit workspace unavailable');
  }
};

const readRecordShareSnapshotForRecords = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  objectMetadataId: string,
  recordIds: readonly string[],
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = (await executor.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM ${recordShareTable(workspaceId)}
      WHERE "objectMetadataId" = $1
        AND "recordId" = ANY($2::uuid[])
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [objectMetadataId, recordIds],
  )) as Array<Record<string, unknown>>;

  const recordIdSet = new Set(recordIds);
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    assertRecordShareRowInvariants(row, objectMetadataId);
    if (!recordIdSet.has(uuid(row.recordId))) {
      throw new Error('Record share audit row recordId out of scope');
    }
    map.set(uuid(row.id), row);
  }

  return map;
};

const uniqueShareKey = (proj: RecordShareRowProjection): string =>
  `${proj.objectMetadataId}:${proj.recordId}:${proj.principalId}:${proj.rowCause}:${proj.sourceId}`;

const fullShareTupleKey = (proj: RecordShareRowProjection): string =>
  `${proj.objectMetadataId}:${proj.recordId}:${proj.principalId}:${proj.principalType}:${proj.accessLevel}:${proj.rowCause}:${proj.sourceId}`;

const normalizeDesiredRecordShares = (
  desiredShares: readonly RecordShareDesiredInput[],
  expectedObjectMetadataId: string,
  allowedRecordIds: ReadonlySet<string>,
): Map<string, RecordShareRowProjection> => {
  const byUniqueKey = new Map<string, RecordShareRowProjection>();
  for (const share of desiredShares) {
    const objectMetadataId = uuid(share.objectMetadataId);
    const recordId = uuid(share.recordId);
    const principalId = uuid(share.principalId);
    const sourceId = uuid(share.sourceId);
    if (objectMetadataId !== expectedObjectMetadataId) {
      throw new Error('Record share desired row objectMetadataId mismatch');
    }
    if (!allowedRecordIds.has(recordId)) {
      throw new Error('Record share desired row recordId out of scope');
    }
    if (!VALID_PRINCIPAL_TYPES.has(share.principalType)) {
      throw new Error('Record share desired row principalType is invalid');
    }
    if (!VALID_ACCESS_LEVELS.has(share.accessLevel)) {
      throw new Error('Record share desired row accessLevel is invalid');
    }
    if (!VALID_ROW_CAUSES.has(share.rowCause)) {
      throw new Error('Record share desired row rowCause is invalid');
    }
    const proj: RecordShareRowProjection = {
      objectMetadataId,
      recordId,
      principalId,
      principalType: share.principalType,
      accessLevel: share.accessLevel,
      rowCause: share.rowCause,
      sourceId,
    };
    const key = uniqueShareKey(proj);
    const existing = byUniqueKey.get(key);
    if (existing) {
      if (
        existing.accessLevel !== proj.accessLevel ||
        existing.principalType !== proj.principalType
      ) {
        throw new Error('Record share desired rows have conflicting grants');
      }
      continue;
    }
    byUniqueKey.set(key, proj);
  }

  return byUniqueKey;
};

const resolveShareWithStandaloneOperation = (
  normalizedWorkspaceId: string,
  authContext: ShareWithAuditAuthContext,
  scope: object,
): { operation: CrmAuditOperation; impersonatorUserWorkspaceId?: string } => {
  if (!authContext || typeof authContext !== 'object') {
    throw new Error('Record share create audit requires authContext');
  }
  if (uuid(authContext.workspace?.id) !== normalizedWorkspaceId) {
    throw new Error('Record share create audit workspace mismatch');
  }

  let fallbackCorrelationId = standaloneShareWithCorrelationIds.get(scope);
  if (!fallbackCorrelationId) {
    fallbackCorrelationId = randomUUID();
    standaloneShareWithCorrelationIds.set(scope, fallbackCorrelationId);
  }

  if (authContext.type === 'user') {
    const capture = captureRecordShareAudit({
      workspaceId: normalizedWorkspaceId,
      authContext,
    });
    const op = capture.operation.correlationId
      ? capture.operation
      : captureCrmAuditOperation({
          ...capture.operation,
          correlationId: fallbackCorrelationId,
        });

    return {
      operation: op,
      ...(capture.impersonatorUserWorkspaceId
        ? { impersonatorUserWorkspaceId: capture.impersonatorUserWorkspaceId }
        : {}),
    };
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  const correlationId =
    ambient?.operation.correlationId ?? fallbackCorrelationId;
  const causationId = ambient?.operation.causationId;

  let actor: CrmAuditPrincipal;
  let initiator: CrmAuditPrincipal | undefined;

  if (authContext.type === 'application') {
    const appId = uuid(authContext.application?.id);
    const actingAgentId =
      authContext.actingAgent !== undefined && authContext.actingAgent !== null
        ? uuid(authContext.actingAgent.id)
        : undefined;
    if (ambient) {
      if (ambient.impersonatorUserWorkspaceId) {
        throw new Error(
          'Record share audit impersonation cannot combine with application',
        );
      }
      const a = ambient.operation.actor;
      const ambInit = ambient.operation.initiator;
      if (actingAgentId !== undefined) {
        const validAgentAmbient =
          a.kind === 'agent' &&
          a.id === actingAgentId &&
          (ambInit === undefined ||
            (ambInit.kind === 'application' && ambInit.id === appId));
        const validAppAmbient =
          a.kind === 'application' && a.id === appId && ambInit === undefined;
        if (!validAgentAmbient && !validAppAmbient) {
          throw new Error('Record share audit ambient agent conflict');
        }
      } else {
        const narrowedAgentId =
          authContext.agentId !== undefined
            ? uuid(authContext.agentId)
            : undefined;
        const validAppAmbient =
          a.kind === 'application' && a.id === appId && ambInit === undefined;
        const validNarrowedAgentAmbient =
          a.kind === 'agent' &&
          ambInit?.kind === 'application' &&
          ambInit.id === appId &&
          (narrowedAgentId === undefined || a.id === narrowedAgentId);
        if (!validAppAmbient && !validNarrowedAgentAmbient) {
          throw new Error('Record share audit ambient application conflict');
        }
      }
    }
    if (actingAgentId) {
      actor = { kind: 'agent', id: actingAgentId };
      initiator = { kind: 'application', id: appId };
    } else {
      actor = { kind: 'application', id: appId };
    }
  } else if (authContext.type === 'apiKey') {
    const apiKeyId = uuid(authContext.apiKey?.id);
    if (ambient) {
      if (
        ambient.impersonatorUserWorkspaceId ||
        ambient.operation.initiator !== undefined ||
        ambient.operation.actor.kind !== 'apiKey' ||
        ambient.operation.actor.id !== apiKeyId
      ) {
        throw new Error('Record share audit ambient apiKey conflict');
      }
    }
    actor = { kind: 'apiKey', id: apiKeyId };
  } else if (authContext.type === 'system') {
    actor = { kind: 'system', id: 'share_with_create' };
  } else {
    throw new Error(
      `Record share create audit unsupported authContext type ${authContext.type}`,
    );
  }

  return {
    operation: captureCrmAuditOperation({
      workspaceId: normalizedWorkspaceId,
      operationId: randomUUID(),
      actor,
      ...(initiator ? { initiator } : {}),
      correlationId,
      ...(causationId ? { causationId } : {}),
    }),
  };
};

const toNativeAuthPort = (
  normalizedWorkspaceId: string,
  authContext: ShareWithAuditAuthContext,
): Parameters<typeof runInNativeCrmAuditScopeIfPresent>[1] => {
  if (!authContext || uuid(authContext.workspace?.id) !== normalizedWorkspaceId) {
    throw new Error('Record share create audit workspace mismatch');
  }
  switch (authContext.type) {
    case 'user':
      return {
        type: 'user',
        workspace: { id: normalizedWorkspaceId },
        workspaceMemberId: uuid(authContext.workspaceMemberId),
        ...(authContext.user?.id !== undefined
          ? { user: { id: uuid(authContext.user.id) } }
          : {}),
        ...(authContext.application?.id !== undefined
          ? { application: { id: uuid(authContext.application.id) } }
          : {}),
        ...(authContext.viaApplication?.id !== undefined
          ? { viaApplication: { id: uuid(authContext.viaApplication.id) } }
          : {}),
        ...(authContext.agentId !== undefined
          ? { agentId: uuid(authContext.agentId) }
          : {}),
      };
    case 'application':
      return {
        type: 'application',
        workspace: { id: normalizedWorkspaceId },
        application: { id: uuid(authContext.application?.id) },
        ...(authContext.actingAgent !== undefined &&
        authContext.actingAgent !== null
          ? { actingAgent: { id: uuid(authContext.actingAgent.id) } }
          : {}),
        ...(authContext.agentId !== undefined
          ? { agentId: uuid(authContext.agentId) }
          : {}),
      };
    case 'apiKey':
      return {
        type: 'apiKey',
        workspace: { id: normalizedWorkspaceId },
        apiKey: { id: uuid(authContext.apiKey?.id) },
      };
    case 'system':
      return {
        type: 'system',
        workspace: { id: normalizedWorkspaceId },
      };
    default:
      throw new Error(
        `Record share create audit unsupported authContext type ${authContext.type}`,
      );
  }
};

export const runAuditedShareWithInsert = async ({
  scope,
  workspaceId,
  objectMetadataId,
  recordIds,
  authContext,
  desiredShares,
  execute,
}: {
  scope: RecordShareAuditWorkspaceScope;
  workspaceId: string;
  objectMetadataId: string;
  recordIds: readonly string[];
  authContext: ShareWithAuditAuthContext;
  desiredShares: readonly RecordShareDesiredInput[];
  execute: () => Promise<void>;
}): Promise<void> => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedObjectMetadataId = uuid(objectMetadataId);
  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (uuid(scope.workspaceId) !== normalizedWorkspaceId) {
    throw new Error('Record share create audit transaction workspace mismatch');
  }

  const normalizedRecordIds = [...new Set(recordIds.map((id) => uuid(id)))].sort();
  const recordIdSet = new Set(normalizedRecordIds);
  const expectedByUniqueKey = normalizeDesiredRecordShares(
    desiredShares,
    normalizedObjectMetadataId,
    recordIdSet,
  );
  const nativeAuth = toNativeAuthPort(normalizedWorkspaceId, authContext);

  if (normalizedRecordIds.length === 0) {
    if (authContext.type === 'user') {
      captureRecordShareAudit({ workspaceId: normalizedWorkspaceId, authContext });
    }

    return;
  }

  const runCoreDiffAndVerify = async (
    recordMutation: (mutation: {
      resourceKind: 'recordShare';
      resourceId: string;
      action: 'create' | 'delete';
      before: RecordShareRowProjection | null;
      after: RecordShareRowProjection | null;
      securityDescriptor: {
        resourceKind: 'recordShare';
        resourceId: string;
        metadataAccess: 'currentWorkspaceAdministration';
      };
    }) => void,
    runExecute: () => Promise<void> = execute,
  ): Promise<{ recordedMutations: number; expectedSerialized: string }> => {
    const before = await readRecordShareSnapshotForRecords(
      executor,
      normalizedWorkspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      true,
    );

    await runExecute();

    const after = await readRecordShareSnapshotForRecords(
      executor,
      normalizedWorkspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      false,
    );

    let recordedMutations = 0;
    for (const [id, beforeRow] of before.entries()) {
      if (after.has(id)) {
        throw new Error(
          'Record share create audit detected surviving pre-existing share row',
        );
      }
      recordMutation({
        resourceKind: 'recordShare',
        resourceId: id,
        action: 'delete',
        before: projectRecordShare(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'recordShare',
          resourceId: id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recordedMutations += 1;
    }

    const observedByUniqueKey = new Map<string, RecordShareRowProjection>();
    for (const [id, afterRow] of after.entries()) {
      const afterProj = projectRecordShare(afterRow);
      const key = uniqueShareKey(afterProj);
      const expected = expectedByUniqueKey.get(key);
      if (
        !expected ||
        observedByUniqueKey.has(key) ||
        fullShareTupleKey(expected) !== fullShareTupleKey(afterProj)
      ) {
        throw new Error(
          'Record share create audit detected unexpected persisted share row',
        );
      }
      observedByUniqueKey.set(key, afterProj);
      recordMutation({
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

    if (observedByUniqueKey.size !== expectedByUniqueKey.size) {
      throw new Error(
        'Record share create audit did not persist all expected share rows',
      );
    }

    return {
      recordedMutations,
      expectedSerialized: serializeSnapshot(after),
    };
  };

  const nativeResult = await runInNativeCrmAuditScopeIfPresent(
    scope,
    nativeAuth,
    async ({
      operation,
      impersonatorUserWorkspaceId: scopeImpersonator,
      record,
      registerPostFlushCheck,
      runDelegatedRecordShareWrite,
    }) => {
      if (authContext.type === 'user') {
        const userCapture = captureRecordShareAudit({
          workspaceId: normalizedWorkspaceId,
          authContext,
        });
        const impersonationMatches =
          userCapture.impersonatorUserWorkspaceId !== undefined
            ? userCapture.impersonatorUserWorkspaceId === scopeImpersonator &&
              operation.initiator?.kind === 'coreUser'
            : scopeImpersonator === undefined &&
              canonicalAuditJson(userCapture.operation.initiator ?? null) ===
                canonicalAuditJson(operation.initiator ?? null);
        if (
          userCapture.operation.actor.kind !== operation.actor.kind ||
          userCapture.operation.actor.id !== operation.actor.id ||
          !impersonationMatches
        ) {
          throw new Error(
            'Record share create audit conflicts with native audit scope attribution',
          );
        }
      } else if (
        authContext.type === 'application' ||
        authContext.type === 'apiKey'
      ) {
        const checked = resolveShareWithStandaloneOperation(
          normalizedWorkspaceId,
          authContext,
          scope,
        );
        const initiatorMatches =
          checked.operation.actor.kind === 'agent'
            ? operation.initiator === undefined ||
              canonicalAuditJson(checked.operation.initiator ?? null) ===
                canonicalAuditJson(operation.initiator)
            : operation.initiator === undefined;
        if (
          checked.impersonatorUserWorkspaceId !== undefined ||
          checked.operation.actor.kind !== operation.actor.kind ||
          checked.operation.actor.id !== operation.actor.id ||
          !initiatorMatches
        ) {
          throw new Error(
            'Record share create audit conflicts with native audit scope attribution',
          );
        }
      }

      await executor.query("SET LOCAL lock_timeout = '8s'");
      await verifyWorkspaceKeyShare(executor, normalizedWorkspaceId);
      const { recordedMutations, expectedSerialized } =
        await runCoreDiffAndVerify(record, () =>
          runDelegatedRecordShareWrite(execute),
        );

      if (recordedMutations > 0) {
        registerPostFlushCheck(async () => {
          await executor.query('SET CONSTRAINTS ALL IMMEDIATE');
          await verifyWorkspaceActive(executor, normalizedWorkspaceId, false);
          const postFlush = await readRecordShareSnapshotForRecords(
            executor,
            normalizedWorkspaceId,
            normalizedObjectMetadataId,
            normalizedRecordIds,
            false,
          );
          if (serializeSnapshot(postFlush) !== expectedSerialized) {
            throw new Error(
              'Record share create audit detected post-flush row drift',
            );
          }
        });
      }
    },
  );

  if (nativeResult.handled) {
    return;
  }

  const standalone = resolveShareWithStandaloneOperation(
    normalizedWorkspaceId,
    authContext,
    scope,
  );
  await executor.query("SET LOCAL lock_timeout = '8s'");
  await verifyWorkspaceKeyShare(executor, normalizedWorkspaceId);

  let operation = standalone.operation;
  if (standalone.impersonatorUserWorkspaceId) {
    const rows = (await executor.query(
      `SELECT "userId"
         FROM core."userWorkspace"
        WHERE id = $1 AND "deletedAt" IS NULL`,
      [standalone.impersonatorUserWorkspaceId],
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

  const audit = new CrmAuditTransactionContext(executor, operation);
  const { recordedMutations, expectedSerialized } = await runCoreDiffAndVerify(
    (mutation) => audit.record(mutation),
  );

  if (recordedMutations > 0) {
    await audit.flush();
    await executor.query('SET CONSTRAINTS ALL IMMEDIATE');
    await verifyWorkspaceActive(executor, normalizedWorkspaceId, false);
    const postFlush = await readRecordShareSnapshotForRecords(
      executor,
      normalizedWorkspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      false,
    );
    if (serializeSnapshot(postFlush) !== expectedSerialized) {
      throw new Error(
        'Record share create audit detected post-flush row drift',
      );
    }
  }
};

export const validateWorkflowRunShareSyncAuditInput = ({
  workspaceId,
  auditOperation,
  auditImpersonatorUserWorkspaceId,
}: {
  workspaceId: string;
  auditOperation?: CrmAuditOperation;
  auditImpersonatorUserWorkspaceId?: string;
}): {
  workspaceId: string;
  capturedOperation?: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedImpersonator =
    auditImpersonatorUserWorkspaceId !== undefined
      ? uuid(auditImpersonatorUserWorkspaceId)
      : undefined;

  let capturedOperation: CrmAuditOperation | undefined;
  if (auditOperation !== undefined) {
    capturedOperation = captureCrmAuditOperation({
      ...auditOperation,
      operationId: randomUUID(),
    });
    if (capturedOperation.workspaceId !== normalizedWorkspaceId) {
      throw new Error('Workflow run share sync audit workspace mismatch');
    }
    if (
      normalizedImpersonator !== undefined &&
      capturedOperation.actor.kind !== 'coreUser' &&
      capturedOperation.actor.kind !== 'workspaceMember'
    ) {
      throw new Error(
        'Workflow run share sync impersonator requires user actor',
      );
    }
  } else if (normalizedImpersonator !== undefined) {
    throw new Error(
      'Workflow run share sync impersonator requires explicit auditOperation',
    );
  }

  return {
    workspaceId: normalizedWorkspaceId,
    ...(capturedOperation ? { capturedOperation } : {}),
    ...(normalizedImpersonator
      ? { impersonatorUserWorkspaceId: normalizedImpersonator }
      : {}),
  };
};

export const runAuditedWorkflowRunShareSync = async ({
  scope,
  workspaceId,
  objectMetadataId,
  workflowRunIds,
  desiredShares,
  auditOperation,
  auditImpersonatorUserWorkspaceId,
  execute,
}: {
  scope: RecordShareAuditWorkspaceScope;
  workspaceId: string;
  objectMetadataId: string;
  workflowRunIds: readonly string[];
  desiredShares: readonly RecordShareDesiredInput[];
  auditOperation?: CrmAuditOperation;
  auditImpersonatorUserWorkspaceId?: string;
  execute: (plan: {
    idsToDelete: string[];
    sharesToInsert: RecordShareDesiredInput[];
  }) => Promise<void>;
}): Promise<void> => {
  const validated = validateWorkflowRunShareSyncAuditInput({
    workspaceId,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  });
  const normalizedObjectMetadataId = uuid(objectMetadataId);
  const normalizedRunIds = [...new Set(workflowRunIds.map((id) => uuid(id)))].sort();
  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (uuid(scope.workspaceId) !== validated.workspaceId) {
    throw new Error('Workflow run share sync transaction workspace mismatch');
  }
  if (normalizedRunIds.length === 0) {
    return;
  }

  const runIdSet = new Set(normalizedRunIds);
  const expectedByUniqueKey = normalizeDesiredRecordShares(
    desiredShares,
    normalizedObjectMetadataId,
    runIdSet,
  );
  const expectedByFullTuple = new Map<string, RecordShareRowProjection>();
  for (const proj of expectedByUniqueKey.values()) {
    expectedByFullTuple.set(fullShareTupleKey(proj), proj);
  }

  const isManagedWorkflowRunShare = (proj: RecordShareRowProjection): boolean =>
    runIdSet.has(proj.sourceId) ||
    proj.rowCause === 'APPLICATION' ||
    proj.principalType === 'EVERYONE';

  for (const proj of expectedByUniqueKey.values()) {
    if (!isManagedWorkflowRunShare(proj)) {
      throw new Error(
        'Workflow run share sync desired shares include unmanaged grant',
      );
    }
  }

  let baseOperation: CrmAuditOperation;
  let impersonatorUserWorkspaceId = validated.impersonatorUserWorkspaceId;
  if (validated.capturedOperation) {
    baseOperation = captureCrmAuditOperation({
      ...validated.capturedOperation,
      operationId: randomUUID(),
    });
  } else {
    const ambient = captureCurrentCrmAuditOperation(validated.workspaceId);
    if (ambient) {
      baseOperation = captureCrmAuditOperation({
        ...ambient.operation,
        operationId: randomUUID(),
      });
      impersonatorUserWorkspaceId =
        ambient.impersonatorUserWorkspaceId !== undefined
          ? uuid(ambient.impersonatorUserWorkspaceId)
          : undefined;
    } else {
      baseOperation = captureCrmAuditOperation({
        workspaceId: validated.workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'system', id: 'workflow_run_share_sync' },
      });
    }
  }

  await executor.query("SET LOCAL lock_timeout = '8s'");
  await verifyWorkspaceKeyShare(executor, validated.workspaceId);

  let operation = baseOperation;
  if (impersonatorUserWorkspaceId) {
    const rows = (await executor.query(
      `SELECT "userId"
         FROM core."userWorkspace"
        WHERE id = $1 AND "deletedAt" IS NULL`,
      [impersonatorUserWorkspaceId],
    )) as Array<{ userId: string }>;
    if (rows.length !== 1) {
      throw new Error(
        'Workflow run share sync audit impersonation initiator unavailable',
      );
    }
    const resolvedInitiatorId = uuid(rows[0].userId);
    if (
      operation.initiator &&
      (operation.initiator.kind !== 'coreUser' ||
        operation.initiator.id !== resolvedInitiatorId)
    ) {
      throw new Error(
        'Workflow run share sync audit impersonation context conflict',
      );
    }
    operation = captureCrmAuditOperation({
      ...operation,
      initiator: { kind: 'coreUser', id: resolvedInitiatorId },
    });
  }

  const before = await readRecordShareSnapshotForRecords(
    executor,
    validated.workspaceId,
    normalizedObjectMetadataId,
    normalizedRunIds,
    true,
  );

  const preservedUnmanaged = new Map<string, RecordShareRowProjection>();
  const keptManagedFullTuples = new Set<string>();
  const idsToDelete: string[] = [];

  for (const [id, beforeRow] of before.entries()) {
    const proj = projectRecordShare(beforeRow);
    if (!isManagedWorkflowRunShare(proj)) {
      preservedUnmanaged.set(id, proj);
      continue;
    }
    const fullTuple = fullShareTupleKey(proj);
    if (
      expectedByFullTuple.has(fullTuple) &&
      !keptManagedFullTuples.has(fullTuple)
    ) {
      keptManagedFullTuples.add(fullTuple);
    } else {
      idsToDelete.push(id);
    }
  }

  const sharesToInsert: RecordShareDesiredInput[] = [];
  for (const [fullTuple, proj] of expectedByFullTuple.entries()) {
    if (!keptManagedFullTuples.has(fullTuple)) {
      sharesToInsert.push(proj);
    }
  }

  if (idsToDelete.length === 0 && sharesToInsert.length === 0) {
    return;
  }

  await execute({ idsToDelete, sharesToInsert });

  const after = await readRecordShareSnapshotForRecords(
    executor,
    validated.workspaceId,
    normalizedObjectMetadataId,
    normalizedRunIds,
    false,
  );

  const audit = new CrmAuditTransactionContext(executor, operation);
  let recordedMutations = 0;

  const observedUnmanaged = new Map<string, RecordShareRowProjection>();
  const observedManagedFullTuples = new Set<string>();
  let observedManagedCount = 0;

  for (const [id, beforeRow] of before.entries()) {
    const beforeProj = projectRecordShare(beforeRow);
    const afterRow = after.get(id);
    if (!afterRow) {
      if (preservedUnmanaged.has(id)) {
        throw new Error(
          'Workflow run share sync deleted unmanaged recordShare row',
        );
      }
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
      throw new Error(
        'Workflow run share sync performed unauthorized in-place update',
      );
    }
  }

  for (const [id, afterRow] of after.entries()) {
    const afterProj = projectRecordShare(afterRow);
    if (!isManagedWorkflowRunShare(afterProj)) {
      observedUnmanaged.set(id, afterProj);
      if (!before.has(id)) {
        throw new Error(
          'Workflow run share sync created unmanaged recordShare row',
        );
      }
      continue;
    }

    observedManagedCount += 1;
    const fullTuple = fullShareTupleKey(afterProj);
    if (
      !expectedByFullTuple.has(fullTuple) ||
      observedManagedFullTuples.has(fullTuple)
    ) {
      throw new Error(
        'Workflow run share sync persisted unexpected or duplicate managed share row',
      );
    }
    observedManagedFullTuples.add(fullTuple);

    if (!before.has(id)) {
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
  }

  if (
    observedUnmanaged.size !== preservedUnmanaged.size ||
    observedManagedCount !== expectedByFullTuple.size ||
    observedManagedFullTuples.size !== expectedByFullTuple.size
  ) {
    throw new Error(
      'Workflow run share sync final state does not match expected grants',
    );
  }

  if (recordedMutations > 0) {
    const expectedSerialized = serializeSnapshot(after);
    await audit.flush();
    await executor.query('SET CONSTRAINTS ALL IMMEDIATE');
    await verifyWorkspaceActive(executor, validated.workspaceId, false);
    const postFlush = await readRecordShareSnapshotForRecords(
      executor,
      validated.workspaceId,
      normalizedObjectMetadataId,
      normalizedRunIds,
      false,
    );
    if (serializeSnapshot(postFlush) !== expectedSerialized) {
      throw new Error(
        'Workflow run share sync audit detected post-flush row drift',
      );
    }
  }
};

export type RecordShareAuditEntityManager = {
  query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
  queryRunner?: {
    readonly isTransactionActive: boolean;
    readonly isReleased: boolean;
  };
};

export type AgentChatRecordShareAuditInput = {
  auditOperation?: CrmAuditOperation;
  auditImpersonatorUserWorkspaceId?: string;
  pendingUserWorkspaceActor?: boolean;
  pendingCorrelationId?: string;
  authUserWorkspaceId?: string;
  pendingAgentId?: string;
};

type ActiveAgentChatShareAudit = {
  readonly workspaceId: string;
  readonly executor: CrmAuditTransactionExecutor;
  readonly audit: CrmAuditTransactionContext;
  readonly expectedRows: Map<string, RecordShareRowProjection>;
  readonly trackedRecordScopes: Map<string, Set<string>>;
  readonly trackedChannelScopes: Map<string, Set<string>>;
  readonly trackedParticipantScopes: Map<
    string,
    {
      participantObjectMetadataId: string;
      workspaceMemberId: string;
      threadIds: Set<string>;
    }
  >;
  recordedMutations: number;
  failure?: unknown;
};

const activeAgentChatShareAudits = new WeakMap<
  object,
  ActiveAgentChatShareAudit
>();

const workspaceTable = (workspaceId: string, tableName: string): string =>
  `${quoteIdent(workspaceSchemaName(workspaceId))}.${quoteIdent(tableName)}`;

export const createCrmAuditEntityManagerExecutor = (
  manager: RecordShareAuditEntityManager,
  workspaceId: string,
): CrmAuditTransactionExecutor => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const runner = manager?.queryRunner;

  const assertActive = () => {
    if (!runner || !runner.isTransactionActive || runner.isReleased) {
      throw new Error(
        'Record share audit requires an active EntityManager transaction',
      );
    }
  };

  assertActive();

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    get isTransactionActive() {
      return Boolean(runner?.isTransactionActive);
    },
    get isReleased() {
      return Boolean(runner?.isReleased);
    },
    query: async (sql: string, parameters?: unknown[]) => {
      assertActive();

      return (await manager.query(sql, parameters)) as unknown[];
    },
  });
};

export const validateAgentChatRecordShareAuditInput = ({
  workspaceId,
  auditOperation,
  auditImpersonatorUserWorkspaceId,
  pendingUserWorkspaceActor,
  pendingCorrelationId,
  authUserWorkspaceId,
  pendingAgentId,
}: {
  workspaceId: string;
} & AgentChatRecordShareAuditInput): {
  workspaceId: string;
  capturedOperation?: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  pendingUserWorkspaceActor?: true;
  pendingCorrelationId?: string;
  authUserWorkspaceId?: string;
  pendingAgentId?: string;
} => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedImpersonator =
    auditImpersonatorUserWorkspaceId !== undefined
      ? uuid(auditImpersonatorUserWorkspaceId)
      : undefined;
  const normalizedAuthUserWorkspaceId =
    authUserWorkspaceId !== undefined ? uuid(authUserWorkspaceId) : undefined;
  const normalizedPendingAgentId =
    pendingAgentId !== undefined ? uuid(pendingAgentId) : undefined;
  const normalizedPendingCorrelationId =
    pendingCorrelationId !== undefined ? uuid(pendingCorrelationId) : undefined;

  let capturedOperation: CrmAuditOperation | undefined;
  if (auditOperation !== undefined) {
    if (
      pendingUserWorkspaceActor ||
      normalizedPendingAgentId !== undefined ||
      normalizedPendingCorrelationId !== undefined ||
      normalizedAuthUserWorkspaceId !== undefined
    ) {
      throw new Error(
        'Agent chat record share audit cannot combine pending actor fields with explicit auditOperation',
      );
    }
    capturedOperation = captureCrmAuditOperation({
      ...auditOperation,
      operationId: randomUUID(),
    });
    if (capturedOperation.workspaceId !== normalizedWorkspaceId) {
      throw new Error('Agent chat record share audit workspace mismatch');
    }
    if (
      normalizedImpersonator !== undefined &&
      capturedOperation.actor.kind !== 'coreUser' &&
      capturedOperation.actor.kind !== 'workspaceMember'
    ) {
      throw new Error(
        'Agent chat record share audit impersonator requires user actor',
      );
    }
  } else if (pendingUserWorkspaceActor) {
    if (!normalizedAuthUserWorkspaceId) {
      throw new Error(
        'Agent chat record share audit pendingUserWorkspaceActor requires authUserWorkspaceId',
      );
    }
    if (normalizedImpersonator !== undefined && normalizedPendingAgentId) {
      throw new Error(
        'Agent chat record share audit impersonator cannot combine with pendingAgentId',
      );
    }
  } else {
    if (
      normalizedPendingAgentId !== undefined ||
      normalizedPendingCorrelationId !== undefined ||
      normalizedAuthUserWorkspaceId !== undefined
    ) {
      throw new Error(
        'Agent chat record share audit pending actor fields require pendingUserWorkspaceActor',
      );
    }
    if (normalizedImpersonator !== undefined) {
      throw new Error(
        'Agent chat record share audit impersonator requires explicit auditOperation',
      );
    }
  }

  return {
    workspaceId: normalizedWorkspaceId,
    ...(capturedOperation ? { capturedOperation } : {}),
    ...(normalizedImpersonator
      ? { impersonatorUserWorkspaceId: normalizedImpersonator }
      : {}),
    ...(pendingUserWorkspaceActor ? { pendingUserWorkspaceActor: true } : {}),
    ...(normalizedPendingCorrelationId
      ? { pendingCorrelationId: normalizedPendingCorrelationId }
      : {}),
    ...(normalizedAuthUserWorkspaceId
      ? { authUserWorkspaceId: normalizedAuthUserWorkspaceId }
      : {}),
    ...(normalizedPendingAgentId
      ? { pendingAgentId: normalizedPendingAgentId }
      : {}),
  };
};

const verifyExpectedWorkspaceMemberInTransaction = async ({
  executor,
  workspaceId,
  operation,
  expectedWorkspaceMemberId,
}: {
  executor: CrmAuditTransactionExecutor;
  workspaceId: string;
  operation: CrmAuditOperation;
  expectedWorkspaceMemberId: string;
}): Promise<void> => {
  const normalizedMemberId = uuid(expectedWorkspaceMemberId);
  const userPrincipal =
    operation.actor.kind === 'coreUser' ||
    operation.actor.kind === 'workspaceMember'
      ? operation.actor
      : operation.actor.kind === 'application' ||
          operation.actor.kind === 'agent'
        ? operation.initiator?.kind === 'coreUser' ||
          operation.initiator?.kind === 'workspaceMember'
          ? operation.initiator
          : undefined
        : undefined;

  if (!userPrincipal) {
    throw new Error(
      'Agent chat record share audit requires matching user principal',
    );
  }

  if (userPrincipal.kind === 'workspaceMember') {
    if (userPrincipal.id !== normalizedMemberId) {
      throw new Error(
        'Agent chat record share audit workspaceMember principal mismatch',
      );
    }

    return;
  }

  const rows = (await executor.query(
    `SELECT "userId", to_jsonb(m)->>'deletedAt' AS "deletedAt"
       FROM ${workspaceTable(workspaceId, 'workspaceMember')} m
      WHERE m.id = $1
        FOR SHARE`,
    [normalizedMemberId],
  )) as Array<{ userId: string | null; deletedAt: string | null }>;

  if (
    rows.length !== 1 ||
    rows[0].deletedAt !== null ||
    typeof rows[0].userId !== 'string' ||
    uuid(rows[0].userId) !== userPrincipal.id
  ) {
    throw new Error(
      'Agent chat record share audit coreUser principal does not match workspaceMember',
    );
  }
};

const readRecordShareSnapshotForChannel = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  threadObjectMetadataId: string,
  channelId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = (await executor.query(
    `SELECT id, "recordId", "objectMetadataId", "principalId",
            "principalType", "accessLevel", "rowCause", "sourceId", "deletedAt"
       FROM ${recordShareTable(workspaceId)}
      WHERE "objectMetadataId" = $1
        AND "rowCause" = 'RULE'
        AND "sourceId" = $2
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [threadObjectMetadataId, channelId],
  )) as Array<Record<string, unknown>>;

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    assertRecordShareRowInvariants(row, threadObjectMetadataId);
    if (row.rowCause !== 'RULE' || uuid(row.sourceId) !== channelId) {
      throw new Error(
        'Record share channel snapshot returned out-of-scope row',
      );
    }
    map.set(uuid(row.id), row);
  }

  return map;
};

const readParticipantRecordShareSnapshot = async (
  executor: CrmAuditTransactionExecutor,
  workspaceId: string,
  participantObjectMetadataId: string,
  threadIds: readonly string[],
  workspaceMemberId: string,
  lock: boolean,
): Promise<Map<string, Record<string, unknown>>> => {
  const rows = (await executor.query(
    `SELECT rs.id, rs."recordId", rs."objectMetadataId", rs."principalId",
            rs."principalType", rs."accessLevel", rs."rowCause", rs."sourceId",
            rs."deletedAt"
       FROM ${recordShareTable(workspaceId)} rs
       JOIN ${workspaceTable(workspaceId, 'agentChatThreadParticipant')} p
         ON p.id = rs."recordId"
      WHERE rs."objectMetadataId" = $1
        AND p."threadId" = ANY($2::uuid[])
        AND p."workspaceMemberId" = $3
      ORDER BY rs.id${lock ? ' FOR UPDATE OF rs' : ''}`,
    [participantObjectMetadataId, threadIds, workspaceMemberId],
  )) as Array<Record<string, unknown>>;

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    assertRecordShareRowInvariants(row, participantObjectMetadataId);
    map.set(uuid(row.id), row);
  }

  return map;
};

const readAllTrackedAgentChatSnapshots = async (
  session: ActiveAgentChatShareAudit,
): Promise<Map<string, RecordShareRowProjection>> => {
  const observed = new Map<string, RecordShareRowProjection>();

  for (const [objectMetadataId, recordIdSet] of [
    ...session.trackedRecordScopes.entries(),
  ].sort(([a], [b]) => a.localeCompare(b))) {
    const recordIds = [...recordIdSet].sort();
    if (recordIds.length === 0) {
      continue;
    }
    const snap = await readRecordShareSnapshotForRecords(
      session.executor,
      session.workspaceId,
      objectMetadataId,
      recordIds,
      false,
    );
    for (const [id, row] of snap.entries()) {
      observed.set(id, projectRecordShare(row));
    }
  }

  for (const [threadObjectMetadataId, channelIdSet] of [
    ...session.trackedChannelScopes.entries(),
  ].sort(([a], [b]) => a.localeCompare(b))) {
    for (const channelId of [...channelIdSet].sort()) {
      const snap = await readRecordShareSnapshotForChannel(
        session.executor,
        session.workspaceId,
        threadObjectMetadataId,
        channelId,
        false,
      );
      for (const [id, row] of snap.entries()) {
        observed.set(id, projectRecordShare(row));
      }
    }
  }

  for (const [, scope] of [...session.trackedParticipantScopes.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const threadIds = [...scope.threadIds].sort();
    if (threadIds.length === 0) {
      continue;
    }
    const snap = await readParticipantRecordShareSnapshot(
      session.executor,
      session.workspaceId,
      scope.participantObjectMetadataId,
      threadIds,
      scope.workspaceMemberId,
      false,
    );
    for (const [id, row] of snap.entries()) {
      observed.set(id, projectRecordShare(row));
    }
  }

  return observed;
};

const serializeProjectionMap = (
  rows: ReadonlyMap<string, RecordShareRowProjection>,
): string =>
  canonicalAuditJson(
    [...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, proj]) => ({ id, ...proj })),
  );

const trackRecordScope = (
  session: ActiveAgentChatShareAudit,
  objectMetadataId: string,
  recordIds: readonly string[],
): void => {
  let set = session.trackedRecordScopes.get(objectMetadataId);
  if (!set) {
    set = new Set<string>();
    session.trackedRecordScopes.set(objectMetadataId, set);
  }
  for (const recordId of recordIds) {
    set.add(recordId);
  }
};

const trackChannelScope = (
  session: ActiveAgentChatShareAudit,
  threadObjectMetadataId: string,
  channelId: string,
): void => {
  let set = session.trackedChannelScopes.get(threadObjectMetadataId);
  if (!set) {
    set = new Set<string>();
    session.trackedChannelScopes.set(threadObjectMetadataId, set);
  }
  set.add(channelId);
};

const trackParticipantScope = (
  session: ActiveAgentChatShareAudit,
  participantObjectMetadataId: string,
  workspaceMemberId: string,
  threadIds: readonly string[],
): void => {
  const key = `${participantObjectMetadataId}:${workspaceMemberId}`;
  let entry = session.trackedParticipantScopes.get(key);
  if (!entry) {
    entry = {
      participantObjectMetadataId,
      workspaceMemberId,
      threadIds: new Set<string>(),
    };
    session.trackedParticipantScopes.set(key, entry);
  }
  for (const threadId of threadIds) {
    entry.threadIds.add(threadId);
  }
};

type AgentChatReconcileScope =
  | {
      kind: 'records';
      objectMetadataId: string;
      recordIds: ReadonlySet<string>;
    }
  | {
      kind: 'channel';
      threadObjectMetadataId: string;
      channelId: string;
    }
  | {
      kind: 'participants';
      participantObjectMetadataId: string;
      workspaceMemberId: string;
      threadIds: readonly string[];
    };

const isProjectionAlreadyTracked = (
  session: ActiveAgentChatShareAudit,
  proj: RecordShareRowProjection,
): boolean => {
  if (session.trackedRecordScopes.get(proj.objectMetadataId)?.has(proj.recordId)) {
    return true;
  }
  if (
    proj.rowCause === 'RULE' &&
    session.trackedChannelScopes.get(proj.objectMetadataId)?.has(proj.sourceId)
  ) {
    return true;
  }

  return false;
};

const isProjectionInScope = (
  proj: RecordShareRowProjection,
  scope: AgentChatReconcileScope,
): boolean => {
  if (scope.kind === 'records') {
    return (
      proj.objectMetadataId === scope.objectMetadataId &&
      scope.recordIds.has(proj.recordId)
    );
  }
  if (scope.kind === 'channel') {
    return (
      proj.objectMetadataId === scope.threadObjectMetadataId &&
      proj.rowCause === 'RULE' &&
      proj.sourceId === scope.channelId
    );
  }

  return false;
};

const reconcileBeforeWithExpectedRows = (
  session: ActiveAgentChatShareAudit,
  before: ReadonlyMap<string, Record<string, unknown>>,
  scope: AgentChatReconcileScope,
): void => {
  const participantScopePreviouslyTracked =
    scope.kind === 'participants' &&
    scope.threadIds.every((threadId) =>
      session.trackedParticipantScopes
        .get(`${scope.participantObjectMetadataId}:${scope.workspaceMemberId}`)
        ?.threadIds.has(threadId),
    );

  for (const [id, row] of before.entries()) {
    const proj = projectRecordShare(row);
    const prevExpected = session.expectedRows.get(id);
    if (prevExpected !== undefined) {
      if (canonicalAuditJson(prevExpected) !== canonicalAuditJson(proj)) {
        throw new Error(
          'Agent chat record share audit detected unaudited mid-transaction row drift',
        );
      }
      continue;
    }
    if (
      isProjectionAlreadyTracked(session, proj) ||
      participantScopePreviouslyTracked
    ) {
      throw new Error(
        'Agent chat record share audit detected unaudited mid-transaction row drift',
      );
    }
    session.expectedRows.set(id, proj);
  }

  for (const [id, expectedProj] of session.expectedRows.entries()) {
    if (isProjectionInScope(expectedProj, scope) && !before.has(id)) {
      throw new Error(
        'Agent chat record share audit detected unaudited mid-transaction row drift',
      );
    }
  }
};

export const requireActiveAgentChatShareAudit = (
  manager: RecordShareAuditEntityManager,
  workspaceId: string,
): ActiveAgentChatShareAudit => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const session = activeAgentChatShareAudits.get(manager);
  if (!session) {
    throw new Error(
      'Agent chat record share write requires an active audited transaction',
    );
  }
  if (session.workspaceId !== normalizedWorkspaceId) {
    throw new Error(
      'Agent chat record share active audit transaction workspace mismatch',
    );
  }
  if (session.failure !== undefined) {
    throw session.failure;
  }

  return session;
};

const runLatchedAgentChatStep = async <TResult>(
  session: ActiveAgentChatShareAudit,
  step: () => Promise<TResult>,
): Promise<TResult> => {
  if (session.failure !== undefined) {
    throw session.failure;
  }
  try {
    return await step();
  } catch (error) {
    if (session.failure === undefined) {
      session.failure =
        error ?? new Error('Agent chat record share audit step failed');
    }
    throw error;
  }
};

export const runAuditedAgentChatRecordShareTransaction = async <TResult>({
  manager,
  workspaceId,
  auditInput,
  fallbackActor,
  expectedWorkspaceMemberId,
  work,
}: {
  manager: RecordShareAuditEntityManager;
  workspaceId: string;
  auditInput?: AgentChatRecordShareAuditInput;
  fallbackActor: CrmAuditPrincipal;
  expectedWorkspaceMemberId?: string;
  work: () => Promise<TResult>;
}): Promise<TResult> => {
  if (activeAgentChatShareAudits.has(manager)) {
    throw new Error(
      'Nested agent chat record share audit transaction is unsupported',
    );
  }

  const validated = validateAgentChatRecordShareAuditInput({
    workspaceId,
    ...auditInput,
  });
  const executor = createCrmAuditEntityManagerExecutor(
    manager,
    validated.workspaceId,
  );

  await executor.query("SET LOCAL lock_timeout = '8s'");
  await verifyWorkspaceKeyShare(executor, validated.workspaceId);

  let baseOperation: CrmAuditOperation | undefined = validated.capturedOperation;
  let impersonatorUserWorkspaceId = validated.impersonatorUserWorkspaceId;

  if (validated.pendingUserWorkspaceActor) {
    const rows = (await executor.query(
      `SELECT "userId", to_jsonb(uw)->>'deletedAt' AS "deletedAt"
         FROM core."userWorkspace" uw
        WHERE uw.id = $1 AND uw."workspaceId" = $2
          FOR SHARE`,
      [validated.authUserWorkspaceId, validated.workspaceId],
    )) as Array<{ userId: string | null; deletedAt: string | null }>;
    if (
      rows.length !== 1 ||
      rows[0].deletedAt !== null ||
      typeof rows[0].userId !== 'string'
    ) {
      throw new Error(
        'Agent chat record share audit userWorkspace actor unavailable',
      );
    }
    const resolvedUserId = uuid(rows[0].userId);
    const correlationId = validated.pendingCorrelationId ?? randomUUID();
    baseOperation = captureCrmAuditOperation(
      validated.pendingAgentId !== undefined
        ? {
            workspaceId: validated.workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'agent', id: validated.pendingAgentId },
            initiator: { kind: 'coreUser', id: resolvedUserId },
            correlationId,
          }
        : {
            workspaceId: validated.workspaceId,
            operationId: randomUUID(),
            actor: { kind: 'coreUser', id: resolvedUserId },
            correlationId,
          },
    );
  } else if (!baseOperation) {
    const ambient = captureCurrentCrmAuditOperation(validated.workspaceId);
    if (ambient) {
      baseOperation = captureCrmAuditOperation({
        ...ambient.operation,
        operationId: randomUUID(),
      });
      impersonatorUserWorkspaceId =
        ambient.impersonatorUserWorkspaceId !== undefined
          ? uuid(ambient.impersonatorUserWorkspaceId)
          : undefined;
    } else {
      baseOperation = captureCrmAuditOperation({
        workspaceId: validated.workspaceId,
        operationId: randomUUID(),
        actor: fallbackActor,
      });
    }
  }

  let operation = baseOperation;
  if (impersonatorUserWorkspaceId !== undefined) {
    if (
      operation.actor.kind !== 'coreUser' &&
      operation.actor.kind !== 'workspaceMember'
    ) {
      throw new Error(
        'Agent chat record share audit impersonator requires user actor',
      );
    }
    const rows = (await executor.query(
      `SELECT "userId"
         FROM core."userWorkspace"
        WHERE id = $1 AND "deletedAt" IS NULL`,
      [impersonatorUserWorkspaceId],
    )) as Array<{ userId: string }>;
    if (rows.length !== 1) {
      throw new Error(
        'Agent chat record share audit impersonation initiator unavailable',
      );
    }
    const resolvedInitiatorId = uuid(rows[0].userId);
    if (
      operation.initiator &&
      (operation.initiator.kind !== 'coreUser' ||
        operation.initiator.id !== resolvedInitiatorId)
    ) {
      throw new Error(
        'Agent chat record share audit impersonation context conflict',
      );
    }
    operation = captureCrmAuditOperation({
      ...operation,
      initiator: { kind: 'coreUser', id: resolvedInitiatorId },
    });
  }

  if (expectedWorkspaceMemberId !== undefined) {
    await verifyExpectedWorkspaceMemberInTransaction({
      executor,
      workspaceId: validated.workspaceId,
      operation,
      expectedWorkspaceMemberId,
    });
  }

  const session: ActiveAgentChatShareAudit = {
    workspaceId: validated.workspaceId,
    executor,
    audit: new CrmAuditTransactionContext(executor, operation),
    expectedRows: new Map(),
    trackedRecordScopes: new Map(),
    trackedChannelScopes: new Map(),
    trackedParticipantScopes: new Map(),
    recordedMutations: 0,
  };

  activeAgentChatShareAudits.set(manager, session);
  try {
    const result = await work();
    if (session.failure !== undefined) {
      throw session.failure;
    }

    const hasTrackedScopes =
      session.trackedRecordScopes.size > 0 ||
      session.trackedChannelScopes.size > 0 ||
      session.trackedParticipantScopes.size > 0;
    const expectedSerialized = serializeProjectionMap(session.expectedRows);

    if (hasTrackedScopes) {
      const preFlush = await readAllTrackedAgentChatSnapshots(session);
      if (serializeProjectionMap(preFlush) !== expectedSerialized) {
        throw new Error(
          'Agent chat record share audit detected unaudited pre-flush row drift',
        );
      }
    }

    if (session.recordedMutations > 0) {
      await session.executor.query("SET LOCAL lock_timeout = '8s'");
      await session.audit.flush();
      await session.executor.query('SET CONSTRAINTS ALL IMMEDIATE');
      await verifyWorkspaceActive(session.executor, session.workspaceId, false);
      const postFlush = await readAllTrackedAgentChatSnapshots(session);
      if (serializeProjectionMap(postFlush) !== expectedSerialized) {
        throw new Error(
          'Agent chat record share audit detected post-flush row drift',
        );
      }
    }

    return result;
  } finally {
    activeAgentChatShareAudits.delete(manager);
  }
};

export const auditAgentChatRecordShareCleanup = async ({
  manager,
  workspaceId,
  objectMetadataId,
  recordIds,
  execute,
}: {
  manager: RecordShareAuditEntityManager;
  workspaceId: string;
  objectMetadataId: string;
  recordIds: readonly string[];
  execute: () => Promise<void>;
}): Promise<void> => {
  const session = requireActiveAgentChatShareAudit(manager, workspaceId);

  return runLatchedAgentChatStep(session, async () => {
    const normalizedObjectMetadataId = uuid(objectMetadataId);
    const normalizedRecordIds = [
      ...new Set(recordIds.map((id) => uuid(id))),
    ].sort();
    if (normalizedRecordIds.length === 0) {
      return;
    }

    await session.executor.query("SET LOCAL lock_timeout = '8s'");
    const before = await readRecordShareSnapshotForRecords(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      true,
    );
    reconcileBeforeWithExpectedRows(session, before, {
      kind: 'records',
      objectMetadataId: normalizedObjectMetadataId,
      recordIds: new Set(normalizedRecordIds),
    });
    trackRecordScope(session, normalizedObjectMetadataId, normalizedRecordIds);

    await execute();

    const after = await readRecordShareSnapshotForRecords(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      false,
    );
    if (after.size !== 0) {
      throw new Error(
        'Agent chat record share cleanup left surviving recordShare rows',
      );
    }

    for (const [id, beforeRow] of before.entries()) {
      const beforeProj = projectRecordShare(beforeRow);
      session.audit.record({
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
      session.expectedRows.delete(id);
      session.recordedMutations += 1;
    }
  });
};

export const auditAgentChatThreadOwnerGrantBackfill = async ({
  manager,
  workspaceId,
  objectMetadataId,
  recordIds,
  expectedOwnerWorkspaceMemberId,
  execute,
}: {
  manager: RecordShareAuditEntityManager;
  workspaceId: string;
  objectMetadataId: string;
  recordIds: readonly string[];
  expectedOwnerWorkspaceMemberId: string;
  execute: () => Promise<number>;
}): Promise<number> => {
  const session = requireActiveAgentChatShareAudit(manager, workspaceId);

  return runLatchedAgentChatStep(session, async () => {
    const normalizedObjectMetadataId = uuid(objectMetadataId);
    const normalizedOwnerId = uuid(expectedOwnerWorkspaceMemberId);
    const normalizedRecordIds = [
      ...new Set(recordIds.map((id) => uuid(id))),
    ].sort();
    if (normalizedRecordIds.length === 0) {
      throw new Error(
        'Agent chat thread owner grant audit requires non-empty recordIds',
      );
    }

    await session.executor.query("SET LOCAL lock_timeout = '8s'");
    const before = await readRecordShareSnapshotForRecords(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      true,
    );
    reconcileBeforeWithExpectedRows(session, before, {
      kind: 'records',
      objectMetadataId: normalizedObjectMetadataId,
      recordIds: new Set(normalizedRecordIds),
    });
    trackRecordScope(session, normalizedObjectMetadataId, normalizedRecordIds);

    const insertedCount = await execute();

    const after = await readRecordShareSnapshotForRecords(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedRecordIds,
      false,
    );

    for (const [id, beforeRow] of before.entries()) {
      const afterRow = after.get(id);
      if (!afterRow) {
        throw new Error(
          'Agent chat thread owner grant backfill deleted existing recordShare row',
        );
      }
      if (
        canonicalAuditJson(projectRecordShare(beforeRow)) !==
        canonicalAuditJson(projectRecordShare(afterRow))
      ) {
        throw new Error(
          'Agent chat thread owner grant backfill modified existing recordShare row',
        );
      }
    }

    let createdCount = 0;
    for (const [id, afterRow] of after.entries()) {
      if (before.has(id)) {
        continue;
      }
      const afterProj = projectRecordShare(afterRow);
      if (
        afterProj.rowCause !== 'OWNER' ||
        afterProj.principalType !== 'WORKSPACE_MEMBER' ||
        afterProj.accessLevel !== 'FULL' ||
        afterProj.principalId !== normalizedOwnerId ||
        afterProj.sourceId !== afterProj.recordId
      ) {
        throw new Error(
          'Agent chat thread owner grant backfill created unexpected recordShare row',
        );
      }
      session.audit.record({
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
      session.expectedRows.set(id, afterProj);
      session.recordedMutations += 1;
      createdCount += 1;
    }

    if (createdCount !== insertedCount) {
      throw new Error(
        'Agent chat thread owner grant backfill count mismatch with persisted rows',
      );
    }

    return insertedCount;
  });
};

export const auditAgentChatParticipantOwnerShareWrite = async <TResult>({
  manager,
  workspaceId,
  participantObjectMetadataId,
  threadIds,
  workspaceMemberId,
  execute,
}: {
  manager: RecordShareAuditEntityManager;
  workspaceId: string;
  participantObjectMetadataId: string;
  threadIds: readonly string[];
  workspaceMemberId: string;
  execute: () => Promise<TResult>;
}): Promise<TResult> => {
  const session = requireActiveAgentChatShareAudit(manager, workspaceId);

  return runLatchedAgentChatStep(session, async () => {
    const normalizedObjectMetadataId = uuid(participantObjectMetadataId);
    const normalizedMemberId = uuid(workspaceMemberId);
    const normalizedThreadIds = [
      ...new Set(threadIds.map((id) => uuid(id))),
    ].sort();
    if (normalizedThreadIds.length === 0) {
      throw new Error(
        'Agent chat participant share audit requires non-empty threadIds',
      );
    }

    await session.executor.query("SET LOCAL lock_timeout = '8s'");
    for (const threadId of normalizedThreadIds) {
      await session.executor.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `agent-chat-thread-participant:${session.workspaceId}:${threadId}:${normalizedMemberId}`,
        ],
      );
    }

    const before = await readParticipantRecordShareSnapshot(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedThreadIds,
      normalizedMemberId,
      true,
    );
    reconcileBeforeWithExpectedRows(session, before, {
      kind: 'participants',
      participantObjectMetadataId: normalizedObjectMetadataId,
      workspaceMemberId: normalizedMemberId,
      threadIds: normalizedThreadIds,
    });
    trackParticipantScope(
      session,
      normalizedObjectMetadataId,
      normalizedMemberId,
      normalizedThreadIds,
    );

    const result = await execute();

    const after = await readParticipantRecordShareSnapshot(
      session.executor,
      session.workspaceId,
      normalizedObjectMetadataId,
      normalizedThreadIds,
      normalizedMemberId,
      false,
    );

    const trackedIds = new Set<string>();
    for (const [id, beforeRow] of before.entries()) {
      const beforeProj = projectRecordShare(beforeRow);
      trackedIds.add(beforeProj.recordId);
      const afterRow = after.get(id);
      if (!afterRow) {
        throw new Error(
          'Agent chat participant share write deleted existing recordShare row',
        );
      }
      if (
        canonicalAuditJson(beforeProj) !==
        canonicalAuditJson(projectRecordShare(afterRow))
      ) {
        throw new Error(
          'Agent chat participant share write modified existing recordShare row',
        );
      }
    }

    for (const [id, afterRow] of after.entries()) {
      const afterProj = projectRecordShare(afterRow);
      trackedIds.add(afterProj.recordId);
      if (before.has(id)) {
        continue;
      }
      if (
        afterProj.rowCause !== 'OWNER' ||
        afterProj.principalType !== 'WORKSPACE_MEMBER' ||
        afterProj.accessLevel !== 'FULL' ||
        afterProj.principalId !== normalizedMemberId ||
        afterProj.sourceId !== afterProj.recordId
      ) {
        throw new Error(
          'Agent chat participant share write created unexpected recordShare row',
        );
      }
      session.audit.record({
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
      session.expectedRows.set(id, afterProj);
      session.recordedMutations += 1;
    }

    if (trackedIds.size > 0) {
      trackRecordScope(session, normalizedObjectMetadataId, [...trackedIds]);
    }

    return result;
  });
};

export const auditAgentChatChannelGrantRewrite = async ({
  manager,
  workspaceId,
  threadObjectUniversalIdentifier,
  scope,
  execute,
}: {
  manager: RecordShareAuditEntityManager;
  workspaceId: string;
  threadObjectUniversalIdentifier: string;
  scope: { threadIds: readonly string[] } | { channelId: string };
  execute: () => Promise<void>;
}): Promise<void> => {
  const session = requireActiveAgentChatShareAudit(manager, workspaceId);

  return runLatchedAgentChatStep(session, async () => {
    const normalizedUniversalId = uuid(threadObjectUniversalIdentifier);
    const isThreadScope = 'threadIds' in scope;
    const normalizedThreadIds = isThreadScope
      ? [...new Set(scope.threadIds.map((id) => uuid(id)))].sort()
      : [];
    const normalizedChannelId = isThreadScope
      ? undefined
      : uuid(scope.channelId);

    if (isThreadScope && normalizedThreadIds.length === 0) {
      return;
    }

    await session.executor.query("SET LOCAL lock_timeout = '8s'");
    const objectRows = (await session.executor.query(
      `SELECT id
         FROM core."objectMetadata"
        WHERE "workspaceId" = $1
          AND "universalIdentifier" = $2`,
      [session.workspaceId, normalizedUniversalId],
    )) as Array<{ id: string }>;
    if (objectRows.length === 0) {
      return;
    }
    if (objectRows.length !== 1) {
      throw new Error(
        'Agent chat channel grant rewrite observed ambiguous thread objectMetadata',
      );
    }
    const threadObjectMetadataId = uuid(objectRows[0].id);

    const before = isThreadScope
      ? await readRecordShareSnapshotForRecords(
          session.executor,
          session.workspaceId,
          threadObjectMetadataId,
          normalizedThreadIds,
          true,
        )
      : await readRecordShareSnapshotForChannel(
          session.executor,
          session.workspaceId,
          threadObjectMetadataId,
          normalizedChannelId!,
          true,
        );
    reconcileBeforeWithExpectedRows(
      session,
      before,
      isThreadScope
        ? {
            kind: 'records',
            objectMetadataId: threadObjectMetadataId,
            recordIds: new Set(normalizedThreadIds),
          }
        : {
            kind: 'channel',
            threadObjectMetadataId,
            channelId: normalizedChannelId!,
          },
    );

    if (isThreadScope) {
      trackRecordScope(session, threadObjectMetadataId, normalizedThreadIds);
    } else {
      trackChannelScope(session, threadObjectMetadataId, normalizedChannelId!);
    }

    await execute();

    const after = isThreadScope
      ? await readRecordShareSnapshotForRecords(
          session.executor,
          session.workspaceId,
          threadObjectMetadataId,
          normalizedThreadIds,
          false,
        )
      : await readRecordShareSnapshotForChannel(
          session.executor,
          session.workspaceId,
          threadObjectMetadataId,
          normalizedChannelId!,
          false,
        );

    for (const [id, beforeRow] of before.entries()) {
      const beforeProj = projectRecordShare(beforeRow);
      const afterRow = after.get(id);
      if (!afterRow) {
        if (
          beforeProj.rowCause !== 'RULE' ||
          (!isThreadScope && beforeProj.sourceId !== normalizedChannelId)
        ) {
          throw new Error(
            'Agent chat channel grant rewrite deleted non-RULE or out-of-scope recordShare row',
          );
        }
        session.audit.record({
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
        session.expectedRows.delete(id);
        session.recordedMutations += 1;
        continue;
      }

      const afterProj = projectRecordShare(afterRow);
      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        throw new Error(
          'Agent chat channel grant rewrite performed unauthorized in-place update',
        );
      }
    }

    for (const [id, afterRow] of after.entries()) {
      const afterProj = projectRecordShare(afterRow);
      if (afterProj.rowCause === 'RULE') {
        if (
          afterProj.principalType !== 'ROLE' ||
          afterProj.accessLevel !== 'READ_WRITE' ||
          (!isThreadScope && afterProj.sourceId !== normalizedChannelId)
        ) {
          throw new Error(
            'Agent chat channel grant rewrite observed invalid RULE recordShare row',
          );
        }
      }
      if (before.has(id)) {
        continue;
      }
      if (afterProj.rowCause !== 'RULE') {
        throw new Error(
          'Agent chat channel grant rewrite created non-RULE recordShare row',
        );
      }
      session.audit.record({
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
      session.expectedRows.set(id, afterProj);
      session.recordedMutations += 1;
    }
  });
};
