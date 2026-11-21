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
import {
  type CrmAuditOperation,
  type CrmAuditPrincipal,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  membershipCleanupOperation,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
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

export type ValidationRuleRequestIdentity = {
  workspaceId?: string;
  workspace?: { id: string };
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  apiKey?: { id: string } | null;
  application?: { id: string } | null;
  agentId?: string;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  impersonatorUserWorkspaceId?: string;
  correlationId?: string;
  causationId?: string;
};

export type ValidationRuleAuditIdentity =
  | (RoleUpdateAuditIdentity & { agentId?: string })
  | MembershipCleanupIdentity
  | CrmAuditOperation
  | {
      operation: CrmAuditOperation;
      impersonatorUserWorkspaceId?: string;
    }
  | ValidationRuleRequestIdentity;

export type ValidationRuleAuditRequest = Readonly<{
  workspaceId: string;
  expectedAction: 'create' | 'update' | 'delete';
  expectedId?: string;
  expectedObjectMetadataId?: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type ValidationRuleAuditMappings = {
  application: { id: string; universalIdentifier: string };
  validationRules?: Record<string, { id: string } | undefined>;
};

type ValidationRuleMigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

const storage = new AsyncLocalStorage<ValidationRuleAuditRequest>();
const active = new WeakSet<ValidationRuleAuditRequest>();
const consumed = new WeakSet<ValidationRuleAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Validation rule audit UUID is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const scalarValidationRuleWithoutTimestamps = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
};

export const assertValidationRuleRowInvariants = (
  row: Record<string, unknown>,
  workspaceId: string,
): void => {
  uuid(row.id);
  if (uuid(row.workspaceId) !== uuid(workspaceId)) {
    throw new Error('Validation rule audit row workspace mismatch');
  }
  uuid(row.applicationId);
  uuid(row.universalIdentifier);
  uuid(row.objectMetadataId);
  nullableUuid(row.errorFieldMetadataId);
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error('Validation rule audit row name is invalid');
  }
  if (
    row.description !== null &&
    row.description !== undefined &&
    typeof row.description !== 'string'
  ) {
    throw new Error('Validation rule audit row description is invalid');
  }
  if (
    row.icon !== null &&
    row.icon !== undefined &&
    typeof row.icon !== 'string'
  ) {
    throw new Error('Validation rule audit row icon is invalid');
  }
  if (typeof row.expression !== 'string') {
    throw new Error('Validation rule audit row expression is invalid');
  }
  if (typeof row.message !== 'string') {
    throw new Error('Validation rule audit row message is invalid');
  }
  if (typeof row.isActive !== 'boolean') {
    throw new Error('Validation rule audit row isActive is invalid');
  }
  if (
    row.bindings === null ||
    row.bindings === undefined ||
    typeof row.bindings !== 'object' ||
    Array.isArray(row.bindings)
  ) {
    throw new Error('Validation rule audit row bindings is invalid');
  }
};

export const doesValidationRuleReferenceAnyField = (
  row: Record<string, unknown>,
  fieldIds: ReadonlySet<string>,
  fieldUniversalIdentifiers: ReadonlySet<string>,
): boolean => {
  const errorFieldId = nullableUuid(row.errorFieldMetadataId);
  if (errorFieldId !== null && fieldIds.has(errorFieldId)) {
    return true;
  }
  if (
    row.bindings !== null &&
    row.bindings !== undefined &&
    typeof row.bindings === 'object' &&
    !Array.isArray(row.bindings)
  ) {
    for (const boundValue of Object.values(
      row.bindings as Record<string, unknown>,
    )) {
      if (
        typeof boundValue === 'string' &&
        isUUID(boundValue) &&
        fieldUniversalIdentifiers.has(boundValue.toLowerCase())
      ) {
        return true;
      }
    }
  }

  return false;
};

export const projectValidationRule = (row: Record<string, unknown>) => ({
  applicationId: uuid(row.applicationId),
  objectMetadataId: uuid(row.objectMetadataId),
  errorFieldMetadataId: nullableUuid(row.errorFieldMetadataId),
  isActive: Boolean(row.isActive),
  name: typeof row.name === 'string' ? row.name : '',
  description:
    row.description === undefined || row.description === null
      ? null
      : String(row.description),
  icon:
    row.icon === undefined || row.icon === null ? null : String(row.icon),
  expression: typeof row.expression === 'string' ? row.expression : '',
  bindings:
    row.bindings !== undefined &&
    row.bindings !== null &&
    typeof row.bindings === 'object' &&
    !Array.isArray(row.bindings)
      ? row.bindings
      : {},
  message: typeof row.message === 'string' ? row.message : '',
});

export const assertValidationRuleSideEffectUpdateInvariants = (
  beforeRow: Record<string, unknown>,
  afterRow: Record<string, unknown>,
  allowExpressionAndBindingsChange: boolean,
  allowedClearedErrorFieldIds?: ReadonlySet<string>,
): void => {
  const beforeProj = projectValidationRule(beforeRow);
  const afterProj = projectValidationRule(afterRow);

  if (
    beforeProj.applicationId !== afterProj.applicationId ||
    beforeProj.objectMetadataId !== afterProj.objectMetadataId ||
    beforeProj.name !== afterProj.name ||
    beforeProj.description !== afterProj.description ||
    beforeProj.icon !== afterProj.icon ||
    beforeProj.message !== afterProj.message
  ) {
    throw new Error(
      'Validation rule side-effect update mutated immutable or display fields',
    );
  }
  if (!beforeProj.isActive && afterProj.isActive) {
    throw new Error('Validation rule side-effect update cannot activate rule');
  }
  if (afterProj.errorFieldMetadataId !== beforeProj.errorFieldMetadataId) {
    if (afterProj.errorFieldMetadataId !== null) {
      throw new Error(
        'Validation rule side-effect update can only clear errorFieldMetadataId',
      );
    }
    if (
      allowedClearedErrorFieldIds !== undefined &&
      (beforeProj.errorFieldMetadataId === null ||
        !allowedClearedErrorFieldIds.has(beforeProj.errorFieldMetadataId))
    ) {
      throw new Error(
        'Validation rule side-effect update cleared unrelated errorFieldMetadataId',
      );
    }
  }
  if (
    !allowExpressionAndBindingsChange &&
    (beforeProj.expression !== afterProj.expression ||
      canonicalAuditJson(beforeProj.bindings) !==
        canonicalAuditJson(afterProj.bindings))
  ) {
    throw new Error(
      'Validation rule delete side-effect update cannot mutate expression or bindings',
    );
  }
  if (
    uuid(beforeRow.universalIdentifier) !== uuid(afterRow.universalIdentifier)
  ) {
    throw new Error(
      'Validation rule side-effect update mutated universalIdentifier',
    );
  }
};

export const lookupValidationRuleMapping = (
  universalIdentifier: unknown,
  validationRules?: Record<string, { id: string } | undefined>,
): { id: string } | undefined => {
  if (typeof universalIdentifier !== 'string' || !validationRules) {
    return undefined;
  }
  const direct = validationRules[universalIdentifier];
  if (direct) {
    return direct;
  }
  const lower = universalIdentifier.toLowerCase();
  if (validationRules[lower]) {
    return validationRules[lower];
  }
  for (const [key, value] of Object.entries(validationRules)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  return undefined;
};

export const getValidationRuleAudit = (
  workspaceId: string,
): ValidationRuleAuditRequest | undefined => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Validation rule audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getValidationRuleAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: ValidationRuleAuditIdentity | undefined,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
  if (identity !== undefined) {
    if (
      identity &&
      typeof identity === 'object' &&
      'operation' in identity &&
      identity.operation &&
      typeof identity.operation === 'object' &&
      'operationId' in identity.operation
    ) {
      const candidate = identity as {
        operation: CrmAuditOperation;
        impersonatorUserWorkspaceId?: string;
      };
      const op = captureCrmAuditOperation(candidate.operation);
      if (op.workspaceId !== normalizedWorkspaceId) {
        throw new Error('Validation rule audit workspace mismatch');
      }

      return {
        operation: op,
        ...(candidate.impersonatorUserWorkspaceId !== undefined
          ? {
              impersonatorUserWorkspaceId: uuid(
                candidate.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
      };
    }

    if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      const candidate = identity as
        | MembershipCleanupIdentity
        | CrmAuditOperation;
      if (candidate.workspaceId === undefined) {
        throw new Error('CRM audit context requires scoped identity');
      }
      if ('operationId' in candidate && typeof candidate.operationId === 'string') {
        const op = captureCrmAuditOperation(candidate as CrmAuditOperation);
        if (op.workspaceId !== normalizedWorkspaceId) {
          throw new Error('Validation rule audit workspace mismatch');
        }
        return { operation: op };
      }
      const normalizedIdentity: MembershipCleanupIdentity = {
        ...(candidate as MembershipCleanupIdentity),
        correlationId:
          typeof (candidate as { correlationId?: unknown }).correlationId ===
          'string'
            ? (candidate as MembershipCleanupIdentity).correlationId
            : randomUUID(),
      };
      const operation = membershipCleanupOperation(
        normalizedWorkspaceId,
        normalizedIdentity,
      );
      if (!operation) {
        throw new Error(
          'Validation rule mutation requires authenticated audit identity',
        );
      }

      return { operation };
    }

    if (identity && typeof identity === 'object' && 'auth' in identity) {
      const roleWithAgent = identity as RoleUpdateAuditIdentity & {
        agentId?: string;
      };
      const capturedIdentity = captureRoleAuditIdentity(roleWithAgent);
      let operation = captureRoleAuditOperation(
        normalizedWorkspaceId,
        capturedIdentity,
      );
      const explicitAgentId =
        roleWithAgent.agentId !== undefined
          ? uuid(roleWithAgent.agentId)
          : undefined;
      if (explicitAgentId !== undefined) {
        if (capturedIdentity.impersonatorUserWorkspaceId) {
          throw new Error(
            'Validation rule audit impersonation cannot combine with agentId',
          );
        }
        operation = captureCrmAuditOperation({
          workspaceId: operation.workspaceId,
          operationId: operation.operationId,
          actor: { kind: 'agent', id: explicitAgentId },
          initiator: operation.actor,
          ...(operation.correlationId !== undefined
            ? { correlationId: operation.correlationId }
            : {}),
          ...(operation.causationId !== undefined
            ? { causationId: operation.causationId }
            : {}),
        });
      }

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

    const req = identity as ValidationRuleRequestIdentity;
    if (req && typeof req === 'object') {
      const hasExplicitAuth =
        Boolean(req.user?.id) ||
        Boolean(req.workspaceMemberId) ||
        Boolean(req.apiKey?.id) ||
        Boolean(req.application?.id) ||
        Boolean(req.agentId);

      if (hasExplicitAuth) {
        if (
          req.workspace?.id !== undefined &&
          uuid(req.workspace.id) !== normalizedWorkspaceId
        ) {
          throw new Error('Validation rule audit workspace mismatch');
        }
        if (
          req.workspaceId !== undefined &&
          uuid(req.workspaceId) !== normalizedWorkspaceId
        ) {
          throw new Error('Validation rule audit workspace mismatch');
        }

        const impersonatorRaw =
          req.impersonationContext?.impersonatorUserWorkspaceId ??
          req.impersonatorUserWorkspaceId;
        const impersonatorUserWorkspaceId =
          impersonatorRaw !== undefined ? uuid(impersonatorRaw) : undefined;

        const userPrincipal: CrmAuditPrincipal | undefined =
          req.workspaceMemberId
            ? { kind: 'workspaceMember', id: uuid(req.workspaceMemberId) }
            : req.user?.id
              ? { kind: 'coreUser', id: uuid(req.user.id) }
              : undefined;
        const appPrincipal: CrmAuditPrincipal | undefined = req.application?.id
          ? { kind: 'application', id: uuid(req.application.id) }
          : undefined;
        const apiKeyPrincipal: CrmAuditPrincipal | undefined = req.apiKey?.id
          ? { kind: 'apiKey', id: uuid(req.apiKey.id) }
          : undefined;
        const agentId = req.agentId ? uuid(req.agentId) : undefined;

        if (apiKeyPrincipal && (userPrincipal || appPrincipal)) {
          throw new Error('Conflicting validation rule audit principals');
        }
        if (
          impersonatorUserWorkspaceId &&
          (apiKeyPrincipal || appPrincipal || agentId)
        ) {
          throw new Error(
            'Validation rule audit impersonation requires user principal',
          );
        }

        const basePrincipal = appPrincipal ?? userPrincipal ?? apiKeyPrincipal;
        if (!basePrincipal) {
          throw new Error(
            'Validation rule mutation requires authenticated audit identity',
          );
        }

        let actor: CrmAuditPrincipal;
        let initiator: CrmAuditPrincipal | undefined;

        if (agentId) {
          actor = { kind: 'agent', id: agentId };
          initiator = userPrincipal ?? appPrincipal ?? apiKeyPrincipal;
        } else if (appPrincipal) {
          actor = appPrincipal;
          initiator = userPrincipal;
        } else {
          actor = basePrincipal;
        }

        const operation = captureCrmAuditOperation({
          workspaceId: normalizedWorkspaceId,
          operationId: randomUUID(),
          actor,
          ...(initiator ? { initiator } : {}),
          ...(typeof req.correlationId === 'string'
            ? { correlationId: req.correlationId }
            : {}),
          ...(typeof req.causationId === 'string'
            ? { causationId: req.causationId }
            : {}),
        });

        return {
          operation,
          ...(impersonatorUserWorkspaceId
            ? { impersonatorUserWorkspaceId }
            : {}),
        };
      }

      const roleIdentity = roleAuditIdentityFromRequest({
        ...req,
        workspace: req.workspace ?? { id: normalizedWorkspaceId },
      } as Parameters<typeof roleAuditIdentityFromRequest>[0]);
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
    'Validation rule mutation requires authenticated audit identity',
  );
};

export const captureValidationRuleAudit = ({
  workspaceId,
  expectedAction,
  expectedId,
  expectedObjectMetadataId,
  auditIdentity,
}: {
  workspaceId: string;
  expectedAction: 'create' | 'update' | 'delete';
  expectedId?: string;
  expectedObjectMetadataId?: string;
  auditIdentity?: ValidationRuleAuditIdentity;
}): ((boundId?: string) => ValidationRuleAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const baseExpectedId =
      expectedId !== undefined ? uuid(expectedId) : undefined;
    const normalizedObjectMetadataId =
      expectedObjectMetadataId !== undefined
        ? uuid(expectedObjectMetadataId)
        : undefined;
    if (
      getValidationRuleAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getValidationRuleAudit,
      )
    ) {
      throw new Error('Nested validation rule audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );

    let issued = false;

    return (boundId?: string) => {
      if (issued) {
        throw new Error('Validation rule audit capture cannot be reused');
      }
      issued = true;
      const resolvedId =
        boundId !== undefined ? uuid(boundId) : baseExpectedId;
      return Object.freeze({
        workspaceId: normalizedWorkspaceId,
        expectedAction,
        ...(resolvedId !== undefined ? { expectedId: resolvedId } : {}),
        ...(normalizedObjectMetadataId !== undefined
          ? { expectedObjectMetadataId: normalizedObjectMetadataId }
          : {}),
        operation,
        ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      });
    };
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const withValidationRuleAudit = async <TResult>(
  request: ValidationRuleAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    consumed.has(request) ||
    getValidationRuleAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getValidationRuleAudit,
    )
  ) {
    throw new Error('Nested validation rule audit is unsupported');
  }

  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

export const runAuditedValidationRuleMigration = async <TResult>(
  dataSource: DataSource | undefined,
  request: ValidationRuleAuditRequest,
  actions: ValidationRuleMigrationAction[],
  mappings: ValidationRuleAuditMappings | undefined,
  execute: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    !active.has(request) ||
    consumed.has(request) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getValidationRuleAudit,
    )
  ) {
    throw new Error('Validation rule audit scope is invalid or reused');
  }
  if (!dataSource) {
    throw new Error('Validation rule audit requires core DataSource');
  }
  if (!mappings?.application) {
    throw new Error('Validation rule audit requires application mapping');
  }

  const expectedApplicationId = uuid(mappings.application.id);
  const expectedApplicationUniversalId = uuid(
    mappings.application.universalIdentifier,
  );

  if (
    actions.length !== 1 ||
    actions[0].metadataName !== 'validationRule' ||
    actions[0].type !== request.expectedAction
  ) {
    throw new Error(
      `Validation rule audit requires exactly one validationRule ${request.expectedAction} action`,
    );
  }

  const action = actions[0];
  let expectedTargetId = request.expectedId;

  if (request.expectedAction === 'create') {
    if (!action.flatEntity) {
      throw new Error('Validation rule create action requires flatEntity');
    }
    if (
      action.flatEntity.applicationUniversalIdentifier !== undefined &&
      uuid(action.flatEntity.applicationUniversalIdentifier) !==
        expectedApplicationUniversalId
    ) {
      throw new Error('Validation rule create action application mismatch');
    }
    const actionId =
      action.id !== undefined
        ? uuid(action.id)
        : action.flatEntity.id !== undefined
          ? uuid(action.flatEntity.id)
          : undefined;
    if (
      expectedTargetId !== undefined &&
      actionId !== undefined &&
      actionId !== expectedTargetId
    ) {
      throw new Error('Validation rule create action ID mismatch');
    }
    expectedTargetId = expectedTargetId ?? actionId;
  } else {
    const mapped = lookupValidationRuleMapping(
      action.universalIdentifier,
      mappings.validationRules,
    );
    if (!mapped?.id) {
      throw new Error(
        `Validation rule ${request.expectedAction} audit missing mapping`,
      );
    }
    const mappedId = uuid(mapped.id);
    if (expectedTargetId !== undefined && mappedId !== expectedTargetId) {
      throw new Error(
        `Validation rule ${request.expectedAction} audit target ID mismatch`,
      );
    }
    expectedTargetId = mappedId;
  }

  consumed.add(request);

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");

    const [workspaceRow] = await runner.query(
      `SELECT id, to_jsonb(w)->>'deletedAt' AS "deletedAt"
         FROM core.workspace w
        WHERE w.id=$1
          FOR NO KEY UPDATE`,
      [request.workspaceId],
    );
    if (!workspaceRow || workspaceRow.deletedAt !== null) {
      throw new Error('Validation rule audit workspace unavailable');
    }

    const [appRow] = await runner.query(
      `SELECT id, "workspaceId", "universalIdentifier", to_jsonb(a)->>'deletedAt' AS "deletedAt"
         FROM core.application a
        WHERE a.id=$1
          FOR NO KEY UPDATE`,
      [expectedApplicationId],
    );
    if (
      !appRow ||
      appRow.deletedAt !== null ||
      uuid(appRow.workspaceId) !== request.workspaceId ||
      uuid(appRow.universalIdentifier) !== expectedApplicationUniversalId
    ) {
      throw new Error('Validation rule audit application unavailable');
    }

    const readRules = async (lock: boolean) =>
      new Map<string, Record<string, unknown>>(
        (
          await runner.query(
            `SELECT to_jsonb(vr) AS row
               FROM core."validationRule" vr
              WHERE vr."workspaceId"=$1
              ORDER BY vr.id${lock ? ' FOR UPDATE' : ''}`,
            [request.workspaceId],
          )
        ).map((entry: { row: Record<string, unknown> }) => [
          uuid(entry.row.id),
          entry.row,
        ]),
      );

    const beforeRules = await readRules(true);
    for (const row of beforeRules.values()) {
      assertValidationRuleRowInvariants(row, request.workspaceId);
    }

    if (request.expectedAction === 'create') {
      if (expectedTargetId !== undefined && beforeRules.has(expectedTargetId)) {
        throw new Error('Validation rule create target ID already exists');
      }
    } else {
      const beforeTarget = expectedTargetId
        ? beforeRules.get(expectedTargetId)
        : undefined;
      if (!beforeTarget) {
        throw new Error(
          `Validation rule ${request.expectedAction} target row unavailable`,
        );
      }
      if (uuid(beforeTarget.applicationId) !== expectedApplicationId) {
        throw new Error(
          `Validation rule ${request.expectedAction} target belongs to another application`,
        );
      }
    }

    const result = await execute(runner);

    const afterRules = await readRules(false);
    for (const row of afterRules.values()) {
      assertValidationRuleRowInvariants(row, request.workspaceId);
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    let recorded = false;

    if (request.expectedAction === 'create') {
      if (afterRules.size !== beforeRules.size + 1) {
        throw new Error(
          'Validation rule create audit detected unexpected row count change',
        );
      }
      let createdId: string | undefined;
      let createdRow: Record<string, unknown> | undefined;
      for (const [id, row] of afterRules.entries()) {
        if (!beforeRules.has(id)) {
          createdId = id;
          createdRow = row;
        } else if (
          canonicalAuditJson(scalarValidationRuleWithoutTimestamps(row)) !==
          canonicalAuditJson(
            scalarValidationRuleWithoutTimestamps(beforeRules.get(id)!),
          )
        ) {
          throw new Error(
            'Validation rule create audit detected unplanned mutation of another rule',
          );
        }
      }
      if (!createdId || !createdRow) {
        throw new Error('Validation rule create did not persist expected row');
      }
      if (expectedTargetId !== undefined && createdId !== expectedTargetId) {
        throw new Error('Validation rule create persisted unexpected ID');
      }
      const afterProj = projectValidationRule(createdRow);
      if (afterProj.applicationId !== expectedApplicationId) {
        throw new Error(
          'Validation rule create persisted unexpected applicationId',
        );
      }
      if (
        request.expectedObjectMetadataId !== undefined &&
        afterProj.objectMetadataId !== request.expectedObjectMetadataId
      ) {
        throw new Error(
          'Validation rule create persisted unexpected objectMetadataId',
        );
      }
      audit.record({
        action: 'create',
        resourceKind: 'validationRule',
        resourceId: createdId,
        before: null,
        after: afterProj,
        securityDescriptor: {
          resourceKind: 'validationRule',
          resourceId: createdId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recorded = true;
    } else if (request.expectedAction === 'update') {
      if (afterRules.size !== beforeRules.size) {
        throw new Error(
          'Validation rule update audit detected unexpected row count change',
        );
      }
      const targetId = expectedTargetId!;
      const beforeTarget = beforeRules.get(targetId)!;
      const afterTarget = afterRules.get(targetId);
      if (!afterTarget) {
        throw new Error('Validation rule update removed target row');
      }
      for (const [id, beforeRow] of beforeRules.entries()) {
        if (id === targetId) continue;
        const afterRow = afterRules.get(id);
        if (
          !afterRow ||
          canonicalAuditJson(scalarValidationRuleWithoutTimestamps(afterRow)) !==
            canonicalAuditJson(
              scalarValidationRuleWithoutTimestamps(beforeRow),
            )
        ) {
          throw new Error(
            'Validation rule update audit detected unplanned mutation of another rule',
          );
        }
      }
      const beforeProj = projectValidationRule(beforeTarget);
      const afterProj = projectValidationRule(afterTarget);
      if (
        afterProj.applicationId !== beforeProj.applicationId ||
        afterProj.objectMetadataId !== beforeProj.objectMetadataId ||
        uuid(afterTarget.universalIdentifier) !==
          uuid(beforeTarget.universalIdentifier)
      ) {
        throw new Error(
          'Validation rule update audit detected immutable field mutation',
        );
      }
      if (canonicalAuditJson(beforeProj) !== canonicalAuditJson(afterProj)) {
        audit.record({
          action: 'update',
          resourceKind: 'validationRule',
          resourceId: targetId,
          before: beforeProj,
          after: afterProj,
          securityDescriptor: {
            resourceKind: 'validationRule',
            resourceId: targetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        recorded = true;
      }
    } else {
      if (afterRules.size !== beforeRules.size - 1) {
        throw new Error(
          'Validation rule delete audit detected unexpected row count change',
        );
      }
      const targetId = expectedTargetId!;
      const beforeTarget = beforeRules.get(targetId)!;
      if (afterRules.has(targetId)) {
        throw new Error('Validation rule delete did not remove target row');
      }
      for (const [id, beforeRow] of beforeRules.entries()) {
        if (id === targetId) continue;
        const afterRow = afterRules.get(id);
        if (
          !afterRow ||
          canonicalAuditJson(scalarValidationRuleWithoutTimestamps(afterRow)) !==
            canonicalAuditJson(
              scalarValidationRuleWithoutTimestamps(beforeRow),
            )
        ) {
          throw new Error(
            'Validation rule delete audit detected unplanned mutation of another rule',
          );
        }
      }
      audit.record({
        action: 'delete',
        resourceKind: 'validationRule',
        resourceId: targetId,
        before: projectValidationRule(beforeTarget),
        after: null,
        securityDescriptor: {
          resourceKind: 'validationRule',
          resourceId: targetId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      recorded = true;
    }

    if (recorded) {
      await audit.flush();

      const postFlushRules = await readRules(false);
      const expectedSerialized = canonicalAuditJson(
        [...afterRules.entries()].map(([id, row]) => [id, row]),
      );
      const postFlushSerialized = canonicalAuditJson(
        [...postFlushRules.entries()].map(([id, row]) => [id, row]),
      );
      if (postFlushSerialized !== expectedSerialized) {
        throw new Error('Validation rule state changed during audit flush');
      }
    }

    return result;
  });
};
