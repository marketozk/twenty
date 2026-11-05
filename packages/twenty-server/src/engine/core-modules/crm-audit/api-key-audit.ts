import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { getRoleAssignmentAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import { getRolePermissionAudit } from 'src/engine/core-modules/crm-audit/role-permission-audit';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  getRoleMutationAudit,
  hasConflictingMetadataAuditScope,
  projectRoleTargetAuditFields,
  registerMetadataAuditScopeCheck,
  resolveRoleAuditInitiator,
  verifyRoleAuditApplication,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export class ApiKeyAuditError extends Error {
  constructor(
    message: string,
    readonly code: 'API_KEY_REVOKED' | 'INVALID_API_KEY_INPUT',
  ) {
    super(message);
  }
}

export type PersistedApiKeyRow = Readonly<{
  id: string;
  name: string;
  expiresAt: Date;
  revokedAt: Date | null;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ApiKeyCreateAuditRequest = Readonly<{
  operation: CrmAuditOperation;
  workspaceId: string;
  apiKeyId: string;
  roleId: string;
  name: string;
  expiresAtIso: string;
  revokedAtIso: string | null;
  impersonatorUserWorkspaceId?: string;
}>;

type MigrationAction = {
  type: string;
  metadataName: string;
  id?: string;
  universalIdentifier?: string;
  flatEntity?: object;
};

type Mapping = Record<string, { id: string } | undefined>;

const storage = new AsyncLocalStorage<ApiKeyCreateAuditRequest>();
const active = new WeakSet<ApiKeyCreateAuditRequest>();
const consumed = new WeakSet<ApiKeyCreateAuditRequest>();
const persistedByRequest = new WeakMap<
  ApiKeyCreateAuditRequest,
  PersistedApiKeyRow
>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('API key audit identity is invalid');
  return value.toLowerCase();
};

const normalizeDateToIso = (value: unknown, field: string): string => {
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time))
      throw new ApiKeyAuditError(
        `API key ${field} is not a valid Date`,
        'INVALID_API_KEY_INPUT',
      );
    return new Date(time).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
      throw new ApiKeyAuditError(
        `API key ${field} is not a valid timestamp`,
        'INVALID_API_KEY_INPUT',
      );
    return new Date(parsed).toISOString();
  }
  throw new ApiKeyAuditError(
    `API key ${field} is invalid`,
    'INVALID_API_KEY_INPUT',
  );
};

export const projectApiKeyAuditFields = (
  row: Record<string, unknown>,
): Record<string, unknown> => ({
  name: row.name,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt === undefined ? null : row.revokedAt,
});

const hydratePersistedApiKey = (
  row: Record<string, unknown>,
): PersistedApiKeyRow => {
  const id = uuid(row.id);
  const workspaceId = uuid(row.workspaceId);
  if (typeof row.name !== 'string')
    throw new Error('API key audit persisted name is invalid');
  const expiresAt = new Date(normalizeDateToIso(row.expiresAt, 'expiresAt'));
  const revokedAt =
    row.revokedAt === null || row.revokedAt === undefined
      ? null
      : new Date(normalizeDateToIso(row.revokedAt, 'revokedAt'));
  const createdAt = new Date(normalizeDateToIso(row.createdAt, 'createdAt'));
  const updatedAt = new Date(normalizeDateToIso(row.updatedAt, 'updatedAt'));
  return Object.freeze({
    id,
    name: row.name,
    expiresAt,
    revokedAt,
    workspaceId,
    createdAt,
    updatedAt,
  });
};

export const captureApiKeyCreateInput = (
  input: unknown,
): Readonly<{
  apiKeyId: string;
  workspaceId: string;
  roleId: string;
  name: string;
  expiresAtIso: string;
  revokedAtIso: string | null;
  identity: RoleUpdateAuditIdentity;
}> => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('API key create input must be an object');
  const allowedKeys = new Set([
    'name',
    'expiresAt',
    'revokedAt',
    'roleId',
    'workspaceId',
    'auditIdentity',
  ]);
  const extracted: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedKeys.has(key))
      throw new Error('API key create input contains unexpected key');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || 'get' in descriptor || 'set' in descriptor)
      throw new Error('API key create input cannot use accessors');
    extracted[key] = descriptor.value;
  }
  const workspaceId = uuid(extracted.workspaceId);
  const roleId = uuid(extracted.roleId);
  if (typeof extracted.name !== 'string')
    throw new ApiKeyAuditError(
      'API key name must be a string',
      'INVALID_API_KEY_INPUT',
    );
  const expiresAtIso = normalizeDateToIso(extracted.expiresAt, 'expiresAt');
  const revokedAtIso =
    extracted.revokedAt === undefined || extracted.revokedAt === null
      ? null
      : normalizeDateToIso(extracted.revokedAt, 'revokedAt');
  const identity = captureRoleAuditIdentity(
    extracted.auditIdentity as RoleUpdateAuditIdentity,
  );
  captureRoleAuditOperation(workspaceId, identity);
  return Object.freeze({
    apiKeyId: randomUUID(),
    workspaceId,
    roleId,
    name: extracted.name,
    expiresAtIso,
    revokedAtIso,
    identity,
  });
};

export const withApiKeyCreateAudit = async (
  input: {
    workspaceId: string;
    apiKeyId: string;
    roleId: string;
    name: string;
    expiresAtIso: string;
    revokedAtIso: string | null;
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<unknown>,
): Promise<PersistedApiKeyRow> => {
  const workspaceId = uuid(input.workspaceId);
  if (
    storage.getStore() ||
    getRoleMutationAudit(workspaceId) ||
    getRoleAssignmentAudit(workspaceId) ||
    getRolePermissionAudit(workspaceId) ||
    hasConflictingMetadataAuditScope(workspaceId, getApiKeyCreateAudit)
  )
    throw new Error('Nested API key create audit is unsupported');
  const apiKeyId = uuid(input.apiKeyId);
  const roleId = uuid(input.roleId);
  if (typeof input.name !== 'string')
    throw new Error('API key create audit requires string name');
  const expiresAtIso = normalizeDateToIso(input.expiresAtIso, 'expiresAt');
  const revokedAtIso =
    input.revokedAtIso === null || input.revokedAtIso === undefined
      ? null
      : normalizeDateToIso(input.revokedAtIso, 'revokedAt');
  const capturedIdentity = captureRoleAuditIdentity(identity);
  const operation = captureRoleAuditOperation(workspaceId, capturedIdentity);
  const request: ApiKeyCreateAuditRequest = Object.freeze({
    operation,
    workspaceId,
    apiKeyId,
    roleId,
    name: input.name,
    expiresAtIso,
    revokedAtIso,
    ...(capturedIdentity.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            capturedIdentity.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
  });
  active.add(request);
  try {
    await storage.run(request, work);
  } finally {
    active.delete(request);
  }
  const persisted = persistedByRequest.get(request);
  if (!consumed.has(request) || !persisted)
    throw new Error('API key create audit was not executed');
  return persisted;
};

export const getApiKeyCreateAudit = (
  workspaceId: string,
): ApiKeyCreateAuditRequest | undefined => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId))
    throw new Error(
      'API key create audit scope is inactive or belongs to another workspace',
    );
  return request;
};
registerMetadataAuditScopeCheck(getApiKeyCreateAudit);

export const runAuditedApiKeyCreate = async <T>(
  dataSource: DataSource,
  request: ApiKeyCreateAuditRequest,
  actions: MigrationAction[],
  mappings: {
    application: { id: string; universalIdentifier: string };
    roles: Mapping;
  },
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (
    getApiKeyCreateAudit(request.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error('API key create audit is inactive or already consumed');
  if (
    actions.length !== 1 ||
    actions[0].type !== 'create' ||
    actions[0].metadataName !== 'roleTarget'
  )
    throw new Error(
      'API key create audit requires exactly one roleTarget create',
    );
  const createAction = { ...actions[0] };
  const input = createAction.flatEntity
    ? ({ ...createAction.flatEntity } as Record<string, unknown>)
    : undefined;
  if (!input || !createAction.id)
    throw new Error('API key create audit requires enriched roleTarget create');
  const createdRoleTargetId = uuid(createAction.id);
  const createdRoleTargetUniversalIdentifier = uuid(input.universalIdentifier);
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const mappedRoleId =
    mappings.roles[String(input.roleUniversalIdentifier)]?.id;
  if (
    uuid(input.applicationUniversalIdentifier) !==
      applicationUniversalIdentifier ||
    !mappedRoleId ||
    uuid(mappedRoleId) !== request.roleId ||
    uuid(input.apiKeyId) !== request.apiKeyId ||
    input.userWorkspaceId !== null ||
    input.agentUniversalIdentifier !== null
  )
    throw new Error('API key create audit plan points to a different target');
  const roleTargetCreatedAt = normalizeDateToIso(
    input.createdAt,
    'roleTarget.createdAt',
  );
  const roleTargetUpdatedAt = normalizeDateToIso(
    input.updatedAt,
    'roleTarget.updatedAt',
  );

  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [request.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('API key create audit workspace unavailable');
    const verifyApplication = () =>
      verifyRoleAuditApplication(
        runner,
        request.workspaceId,
        applicationId,
        applicationUniversalIdentifier,
      );
    await verifyApplication();

    const readRole = () =>
      runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
        [request.workspaceId, request.roleId],
      );
    const roles = await readRole();
    const destinationRole = roles[0]?.row as
      | Record<string, unknown>
      | undefined;
    if (
      roles.length !== 1 ||
      !destinationRole ||
      destinationRole.canBeAssignedToApiKeys !== true ||
      uuid(destinationRole.universalIdentifier) !==
        uuid(input.roleUniversalIdentifier)
    )
      throw new Error(
        'API key create audit role is unavailable or not assignable to API keys',
      );

    const existingApiKeys = await runner.query(
      'SELECT id FROM core."apiKey" WHERE id=$1 FOR UPDATE',
      [request.apiKeyId],
    );
    const existingTargets = await runner.query(
      'SELECT id FROM core."roleTarget" WHERE "workspaceId"=$1 AND ("apiKeyId"=$2 OR id=$3) FOR UPDATE',
      [request.workspaceId, request.apiKeyId, createdRoleTargetId],
    );
    if (existingApiKeys.length > 0 || existingTargets.length > 0)
      throw new Error('API key create audit target already exists');

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);

    await runner.query(
      'INSERT INTO core."apiKey" ("id","name","expiresAt","revokedAt","workspaceId") VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5)',
      [
        request.apiKeyId,
        request.name,
        request.expiresAtIso,
        request.revokedAtIso,
        request.workspaceId,
      ],
    );

    const result = await work(runner);

    const readApiKey = () =>
      runner.query(
        'SELECT "id","name","expiresAt","revokedAt","workspaceId","createdAt","updatedAt",to_jsonb(k) AS row FROM core."apiKey" k WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',
        [request.apiKeyId, request.workspaceId],
      );
    const afterApiKeyRows = await readApiKey();
    const afterApiKeyJson: Record<string, unknown> | undefined =
      afterApiKeyRows[0]?.row;
    const expectedApiKeyScalars = {
      id: request.apiKeyId,
      workspaceId: request.workspaceId,
      name: request.name,
    };
    const apiKeyScalars = (row: Record<string, unknown>) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
    });
    if (
      afterApiKeyRows.length !== 1 ||
      !afterApiKeyJson ||
      canonicalAuditJson(apiKeyScalars(afterApiKeyJson)) !==
        canonicalAuditJson(expectedApiKeyScalars)
    )
      throw new Error('API key create audit persisted apiKey mismatch');
    const [apiKeyTimestampCheck] = await runner.query(
      'SELECT "expiresAt"=$2::timestamptz AND "revokedAt" IS NOT DISTINCT FROM $3::timestamptz AND "createdAt" IS NOT NULL AND "updatedAt" IS NOT NULL AS matches FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$4',
      [
        request.apiKeyId,
        request.expiresAtIso,
        request.revokedAtIso,
        request.workspaceId,
      ],
    );
    if (apiKeyTimestampCheck?.matches !== true)
      throw new Error(
        'API key create audit persisted apiKey timestamps mismatch',
      );

    const readTargets = () =>
      runner.query(
        'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("apiKeyId"=$2 OR id=$3) FOR UPDATE',
        [request.workspaceId, request.apiKeyId, createdRoleTargetId],
      );
    const afterTargetRows = await readTargets();
    const afterTarget: Record<string, unknown> | undefined =
      afterTargetRows[0]?.row;
    const expectedTargetScalars = {
      id: createdRoleTargetId,
      universalIdentifier: createdRoleTargetUniversalIdentifier,
      workspaceId: request.workspaceId,
      applicationId,
      roleId: request.roleId,
      userWorkspaceId: null,
      agentId: null,
      apiKeyId: request.apiKeyId,
    };
    const targetScalars = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => key !== 'createdAt' && key !== 'updatedAt',
        ),
      );
    if (
      afterTargetRows.length !== 1 ||
      !afterTarget ||
      canonicalAuditJson(targetScalars(afterTarget)) !==
        canonicalAuditJson(expectedTargetScalars)
    )
      throw new Error('API key create audit persisted roleTarget mismatch');
    const [targetTimestampCheck] = await runner.query(
      'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$4',
      [
        createdRoleTargetId,
        roleTargetCreatedAt,
        roleTargetUpdatedAt,
        request.workspaceId,
      ],
    );
    if (targetTimestampCheck?.matches !== true)
      throw new Error('API key create audit roleTarget timestamps mismatch');

    audit.record({
      resourceKind: 'apiKey',
      resourceId: request.apiKeyId,
      action: 'create',
      before: null,
      after: projectApiKeyAuditFields(afterApiKeyJson),
      securityDescriptor: {
        resourceKind: 'apiKey',
        resourceId: request.apiKeyId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    audit.record({
      resourceKind: 'roleTarget',
      resourceId: createdRoleTargetId,
      action: 'create',
      before: null,
      after: projectRoleTargetAuditFields(afterTarget),
      securityDescriptor: {
        resourceKind: 'roleTarget',
        resourceId: createdRoleTargetId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await audit.flush();

    const postFlushApiKeyRows = await readApiKey();
    const postFlushTargetRows = await readTargets();
    if (
      postFlushApiKeyRows.length !== 1 ||
      canonicalAuditJson(afterApiKeyJson) !==
        canonicalAuditJson(postFlushApiKeyRows[0]?.row) ||
      canonicalAuditJson(afterTargetRows) !==
        canonicalAuditJson(postFlushTargetRows) ||
      canonicalAuditJson(roles) !== canonicalAuditJson(await readRole())
    )
      throw new Error('API key create audit state changed during flush');
    await verifyApplication();

    persistedByRequest.set(request, hydratePersistedApiKey(afterApiKeyRows[0]));
    return result;
  });
};

type CapturedApiKeyUpdatePatch = Readonly<{
  hasName: boolean;
  name?: string;
  hasExpiresAt: boolean;
  expiresAtIso?: string;
  hasRevokedAt: boolean;
  revokedAtIso?: string | null;
}>;

export const captureApiKeyUpdatePatch = (
  updateData: unknown,
): CapturedApiKeyUpdatePatch => {
  if (
    !updateData ||
    typeof updateData !== 'object' ||
    Array.isArray(updateData)
  )
    throw new ApiKeyAuditError(
      'API key update data must be an object',
      'INVALID_API_KEY_INPUT',
    );
  const allowedKeys = new Set(['name', 'expiresAt', 'revokedAt']);
  let hasName = false;
  let name: string | undefined;
  let hasExpiresAt = false;
  let expiresAtIso: string | undefined;
  let hasRevokedAt = false;
  let revokedAtIso: string | null | undefined;

  for (const key of Reflect.ownKeys(updateData)) {
    if (typeof key !== 'string' || !allowedKeys.has(key))
      throw new ApiKeyAuditError(
        'API key update data contains unexpected key',
        'INVALID_API_KEY_INPUT',
      );
    const descriptor = Object.getOwnPropertyDescriptor(updateData, key);
    if (!descriptor || 'get' in descriptor || 'set' in descriptor)
      throw new ApiKeyAuditError(
        'API key update data cannot use accessors',
        'INVALID_API_KEY_INPUT',
      );
    const value = descriptor.value;
    if (value === undefined) continue;
    if (key === 'name') {
      if (typeof value !== 'string')
        throw new ApiKeyAuditError(
          'API key name must be a string',
          'INVALID_API_KEY_INPUT',
        );
      hasName = true;
      name = value;
    } else if (key === 'expiresAt') {
      hasExpiresAt = true;
      expiresAtIso = normalizeDateToIso(value, 'expiresAt');
    } else if (key === 'revokedAt') {
      hasRevokedAt = true;
      revokedAtIso =
        value === null ? null : normalizeDateToIso(value, 'revokedAt');
    }
  }

  return Object.freeze({
    hasName,
    ...(hasName ? { name } : {}),
    hasExpiresAt,
    ...(hasExpiresAt ? { expiresAtIso } : {}),
    hasRevokedAt,
    ...(hasRevokedAt ? { revokedAtIso } : {}),
  });
};

export const runAuditedApiKeyUpdate = async ({
  dataSource,
  id,
  workspaceId,
  updateData,
  auditIdentity,
}: {
  dataSource: DataSource;
  id: string;
  workspaceId: string;
  updateData: unknown;
  auditIdentity: RoleUpdateAuditIdentity;
}): Promise<PersistedApiKeyRow | null> => {
  const capturedId = uuid(id);
  const capturedWorkspaceId = uuid(workspaceId);
  const patch = captureApiKeyUpdatePatch(updateData);
  const capturedIdentity = captureRoleAuditIdentity(auditIdentity);
  const capturedOperation = captureRoleAuditOperation(
    capturedWorkspaceId,
    capturedIdentity,
  );
  const impersonatorUserWorkspaceId =
    capturedIdentity.impersonatorUserWorkspaceId !== undefined
      ? uuid(capturedIdentity.impersonatorUserWorkspaceId)
      : undefined;

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [capturedWorkspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('API key update audit workspace unavailable');

    const readApiKey = () =>
      runner.query(
        'SELECT "id","name","expiresAt","revokedAt","workspaceId","createdAt","updatedAt",to_jsonb(k) AS row FROM core."apiKey" k WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',
        [capturedId, capturedWorkspaceId],
      );
    const beforeRows = await readApiKey();
    if (beforeRows.length === 0) return null;
    const beforeJson = beforeRows[0].row as Record<string, unknown>;
    if (
      beforeRows.length !== 1 ||
      !beforeJson ||
      uuid(beforeJson.id) !== capturedId ||
      uuid(beforeJson.workspaceId) !== capturedWorkspaceId
    )
      throw new Error('API key update audit persisted row invalid');

    const beforeIsRevoked =
      beforeJson.revokedAt !== null && beforeJson.revokedAt !== undefined;
    if (patch.hasRevokedAt && patch.revokedAtIso === null && beforeIsRevoked) {
      throw new ApiKeyAuditError(
        `API Key with id ${id} is revoked and cannot be reactivated`,
        'API_KEY_REVOKED',
      );
    }

    const readTargets = () =>
      runner.query(
        'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "apiKeyId"=$2 ORDER BY id FOR SHARE',
        [capturedWorkspaceId, capturedId],
      );
    const beforeTargets = await readTargets();

    const nextName = patch.hasName ? patch.name! : String(beforeJson.name);
    const nextExpiresAtParam = patch.hasExpiresAt
      ? patch.expiresAtIso!
      : String(beforeJson.expiresAt);
    const nextRevokedAtParam = patch.hasRevokedAt
      ? (patch.revokedAtIso ?? null)
      : beforeJson.revokedAt === null || beforeJson.revokedAt === undefined
        ? null
        : String(beforeJson.revokedAt);
    const beforeCreatedAtParam = String(beforeJson.createdAt);

    const operation = await resolveRoleAuditInitiator(
      runner,
      capturedOperation,
      impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);

    await runner.query(
      'UPDATE core."apiKey" SET "name"=$3,"expiresAt"=$4::timestamptz,"revokedAt"=$5::timestamptz,"updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2',
      [
        capturedId,
        capturedWorkspaceId,
        nextName,
        nextExpiresAtParam,
        nextRevokedAtParam,
      ],
    );

    const afterRows = await readApiKey();
    const afterJson: Record<string, unknown> | undefined = afterRows[0]?.row;
    const expectedScalars = {
      id: capturedId,
      workspaceId: capturedWorkspaceId,
      name: nextName,
    };
    const apiKeyScalars = (row: Record<string, unknown>) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
    });
    if (
      afterRows.length !== 1 ||
      !afterJson ||
      canonicalAuditJson(apiKeyScalars(afterJson)) !==
        canonicalAuditJson(expectedScalars)
    )
      throw new Error('API key update audit persisted row mismatch');

    const [timestampCheck] = await runner.query(
      'SELECT "expiresAt"=$2::timestamptz AND "revokedAt" IS NOT DISTINCT FROM $3::timestamptz AND "createdAt"=$4::timestamptz AND "updatedAt" IS NOT NULL AS matches FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$5',
      [
        capturedId,
        nextExpiresAtParam,
        nextRevokedAtParam,
        beforeCreatedAtParam,
        capturedWorkspaceId,
      ],
    );
    if (timestampCheck?.matches !== true)
      throw new Error('API key update audit persisted timestamps mismatch');

    audit.record({
      resourceKind: 'apiKey',
      resourceId: capturedId,
      action: 'update',
      before: projectApiKeyAuditFields(beforeJson),
      after: projectApiKeyAuditFields(afterJson),
      securityDescriptor: {
        resourceKind: 'apiKey',
        resourceId: capturedId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await audit.flush();

    const postFlushRows = await readApiKey();
    const postFlushTargets = await readTargets();
    if (
      postFlushRows.length !== 1 ||
      canonicalAuditJson(afterJson) !==
        canonicalAuditJson(postFlushRows[0]?.row) ||
      canonicalAuditJson(beforeTargets) !== canonicalAuditJson(postFlushTargets)
    )
      throw new Error('API key update audit state changed during flush');

    return hydratePersistedApiKey(afterRows[0]);
  });
};
