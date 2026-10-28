import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { captureNativeCrmAuditOperation } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type RoleUpdateAuditIdentity = {
  auth: Parameters<typeof captureNativeCrmAuditOperation>[1];
  agentId?: string;
  impersonatorUserWorkspaceId?: string;
};

export const captureRoleAuditIdentity = (
  identity: RoleUpdateAuditIdentity,
): RoleUpdateAuditIdentity => {
  if (!identity?.auth)
    throw new Error('Role mutation requires authenticated audit identity');
  const auth = identity.auth;
  const base = { workspace: { id: auth.workspace.id } };
  return {
    auth:
      auth.type === 'user'
        ? { ...base, type: 'user', workspaceMemberId: auth.workspaceMemberId }
        : auth.type === 'apiKey'
          ? { ...base, type: 'apiKey', apiKey: { id: auth.apiKey.id } }
          : auth.type === 'application'
            ? {
                ...base,
                type: 'application',
                application: { id: auth.application.id },
                ...(auth.actingAgent
                  ? { actingAgent: { id: auth.actingAgent.id } }
                  : {}),
              }
            : { ...base, type: auth.type },
    agentId: identity.agentId,
    impersonatorUserWorkspaceId: identity.impersonatorUserWorkspaceId,
  };
};

// Only authenticated request fields are projected; metadata audit must not import
// the complete authorization graph (which includes Enterprise-only modules).
export const roleAuditIdentityFromRequest = (request: {
  workspace?: { id: string };
  apiKey?: { id: string } | null;
  user?: object | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  application?: { id: string } | null;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
}): RoleUpdateAuditIdentity => {
  if (!request.workspace)
    throw new Error('Role audit requires authenticated workspace');
  const base = { workspace: { id: request.workspace.id } };
  const auth: RoleUpdateAuditIdentity['auth'] = request.apiKey
    ? { ...base, type: 'apiKey', apiKey: { id: request.apiKey.id } }
    : request.user && request.userWorkspaceId && request.workspaceMemberId
      ? { ...base, type: 'user', workspaceMemberId: request.workspaceMemberId }
      : request.application
        ? {
            ...base,
            type: 'application',
            application: { id: request.application.id },
          }
        : { ...base, type: 'pendingActivationUser' };
  return {
    auth,
    impersonatorUserWorkspaceId:
      request.impersonationContext?.impersonatorUserWorkspaceId,
  };
};

type RoleAuditRequest = Readonly<
  {
    operation: CrmAuditOperation;
    roleId: string;
    impersonatorUserWorkspaceId?: string;
  } & (
    | { action: 'update' }
    | { action: 'create'; expected: Readonly<Record<string, unknown>> }
  )
>;

const storage = new AsyncLocalStorage<RoleAuditRequest>();
const active = new WeakSet<RoleAuditRequest>();
const consumed = new WeakSet<RoleAuditRequest>();
const uuid = (value: string) => {
  if (!isUUID(value)) throw new Error('Role audit identity is invalid');
  return value.toLowerCase();
};

export const withRoleUpdateAudit = async <T>(
  workspaceId: string,
  roleId: string,
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  return withRoleAudit(
    workspaceId,
    roleId,
    identity,
    { action: 'update' },
    work,
  );
};

export const withRoleCreateAudit = async <T>(
  flatRole: { id: string; workspaceId: string } & object,
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const fields = flatRole as Record<string, unknown>;
  const expected = Object.fromEntries(
    [
      'id',
      'workspaceId',
      'universalIdentifier',
      'applicationId',
      'applicationUniversalIdentifier',
      'isEditable',
      'createdAt',
      'updatedAt',
      ...BOOLEAN_FIELDS,
      ...TEXT_FIELDS,
    ].map((key) => [key, fields[key]]),
  );
  for (const key of [
    'id',
    'workspaceId',
    'universalIdentifier',
    'applicationId',
    'applicationUniversalIdentifier',
  ])
    expected[key] = uuid(expected[key] as string);
  if (
    expected.isEditable !== true ||
    BOOLEAN_FIELDS.some((key) => typeof expected[key] !== 'boolean') ||
    typeof expected.label !== 'string' ||
    ['description', 'icon'].some(
      (key) => expected[key] !== null && typeof expected[key] !== 'string',
    )
  )
    throw new Error('Role create audit requires normalized scalar fields');
  for (const key of ['createdAt', 'updatedAt']) {
    if (
      typeof expected[key] !== 'string' ||
      !Number.isFinite(Date.parse(expected[key]))
    )
      throw new Error('Role create audit requires normalized timestamps');
  }
  return withRoleAudit(
    flatRole.workspaceId,
    flatRole.id,
    identity,
    { action: 'create', expected: Object.freeze(expected) },
    work,
  );
};

export const captureRoleAuditOperation = (
  workspaceId: string,
  identity: RoleUpdateAuditIdentity,
): CrmAuditOperation => {
  if (!identity?.auth)
    throw new Error('Role update requires authenticated audit identity');
  const captured = captureNativeCrmAuditOperation(workspaceId, identity.auth, {
    operationId: randomUUID(),
  });
  return identity.agentId
    ? Object.freeze({
        ...captured,
        actor: Object.freeze({
          kind: 'agent' as const,
          id: uuid(identity.agentId),
        }),
        ...(captured.actor.kind === 'agent'
          ? {}
          : { initiator: captured.actor }),
      })
    : captured;
};

export const resolveRoleAuditInitiator = async (
  runner: QueryRunner,
  operation: CrmAuditOperation,
  impersonatorUserWorkspaceId?: string,
): Promise<CrmAuditOperation> => {
  if (!impersonatorUserWorkspaceId) return operation;
  const rows = await runner.query(
    'SELECT "userId" FROM core."userWorkspace" WHERE id=$1 AND "deletedAt" IS NULL',
    [uuid(impersonatorUserWorkspaceId)],
  );
  if (rows.length !== 1)
    throw new Error('Role audit impersonation initiator unavailable');
  return {
    ...operation,
    initiator: { kind: 'coreUser', id: uuid(rows[0].userId) },
  };
};

export const verifyRoleAuditApplication = async (
  runner: QueryRunner,
  workspaceId: string,
  applicationId: string,
  universalIdentifier: string,
): Promise<void> => {
  const rows = await runner.query(
    'SELECT "workspaceId","universalIdentifier","deletedAt" FROM core.application WHERE id=$1 FOR SHARE',
    [uuid(applicationId)],
  );
  if (
    rows.length !== 1 ||
    rows[0].workspaceId !== uuid(workspaceId) ||
    rows[0].universalIdentifier !== uuid(universalIdentifier) ||
    rows[0].deletedAt !== null
  )
    throw new Error('Role audit application ownership changed or unavailable');
};

const withRoleAudit = async <T>(
  workspaceId: string,
  roleId: string,
  identity: RoleUpdateAuditIdentity,
  mutation:
    | { action: 'update' }
    | { action: 'create'; expected: Readonly<Record<string, unknown>> },
  work: () => Promise<T>,
): Promise<T> => {
  if (storage.getStore()) throw new Error('Nested role audit is unsupported');
  const operation = captureRoleAuditOperation(workspaceId, identity);
  const request = Object.freeze({
    ...mutation,
    operation,
    roleId: uuid(roleId),
    ...(identity.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            identity.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
  });
  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

export const getRoleMutationAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (
    !active.has(request) ||
    request.operation.workspaceId !== uuid(workspaceId)
  )
    throw new Error(
      'Role audit scope is inactive or belongs to another workspace',
    );
  return request;
};

const BOOLEAN_FIELDS = [
  'canUpdateAllSettings',
  'canAccessAllTools',
  'canAccessAllAgentChatChannels',
  'canReadAllObjectRecords',
  'canUpdateAllObjectRecords',
  'canSoftDeleteAllObjectRecords',
  'canDestroyAllObjectRecords',
  'canBeAssignedToUsers',
  'canBeAssignedToAgents',
  'canBeAssignedToApiKeys',
];
const TEXT_FIELDS = ['label', 'description', 'icon'];

type RoleUpdateAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: object;
  id?: string;
  flatEntity?: object;
};

export const runAuditedRoleMutation = async <T>(
  dataSource: DataSource,
  request: RoleAuditRequest,
  actions: RoleUpdateAction[],
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (
    getRoleMutationAudit(request.operation.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error(
      'Role audit operation is not active or was already consumed',
    );
  if (
    actions.length !== 1 ||
    actions[0].type !== request.action ||
    actions[0].metadataName !== 'role'
  )
    throw new Error('Role audit requires exactly one matching role action');
  const action = actions[0];
  const universalIdentifier =
    request.action === 'update'
      ? uuid(action.universalIdentifier!)
      : request.expected.universalIdentifier;
  if (request.action === 'create') {
    const input = action.flatEntity as Record<string, unknown> | undefined;
    if (!input || action.id !== request.roleId)
      throw new Error('Role create audit requires its exact enriched ID');
    for (const [key, value] of Object.entries(request.expected)) {
      if (key === 'id' || key === 'applicationId' || key === 'workspaceId')
        continue;
      if (canonicalAuditJson(input[key]) !== canonicalAuditJson(value))
        throw new Error('Role create audit final fields changed');
    }
  }
  const update: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(action.update ?? {}),
  )) {
    if (!('value' in descriptor))
      throw new Error('Role audit update cannot contain accessors');
    const value = descriptor.value;
    if (value === undefined) continue;
    if (
      !(BOOLEAN_FIELDS.includes(key) && typeof value === 'boolean') &&
      !(
        TEXT_FIELDS.includes(key) &&
        (typeof value === 'string' || (key !== 'label' && value === null))
      )
    )
      throw new Error('Role audit update field is unsupported');
    update[key] = value;
  }
  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const read = async (lock = false): Promise<Record<string, unknown>> => {
      const rows = await runner.query(
        `SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2${lock ? ' FOR UPDATE' : ''}`,
        [request.roleId, request.operation.workspaceId],
      );
      if (rows.length !== 1)
        throw new Error('Role audit persisted role unavailable');
      return rows[0].row;
    };
    const before = request.action === 'update' ? await read(true) : null;
    const verifyApplication = async () => {
      if (request.action === 'create')
        await verifyRoleAuditApplication(
          runner,
          request.operation.workspaceId,
          request.expected.applicationId as string,
          request.expected.applicationUniversalIdentifier as string,
        );
    };
    await verifyApplication();
    if (
      before &&
      (before.universalIdentifier !== universalIdentifier ||
        before.isEditable !== true)
    )
      throw new Error('Role audit persisted identity or editability changed');
    if (request.action === 'create') {
      const existing = await runner.query(
        'SELECT id FROM core.role WHERE id=$1',
        [request.roleId],
      );
      if (existing.length)
        throw new Error('Role create audit ID already exists');
    }
    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const after = await read();
    const expected =
      request.action === 'update'
        ? { ...before, ...update, updatedAt: after.updatedAt }
        : Object.fromEntries(
            Object.entries(request.expected).filter(
              ([key]) => key !== 'applicationUniversalIdentifier',
            ),
          );
    const comparable = (snapshot: Record<string, unknown>) =>
      request.action === 'create'
        ? Object.fromEntries(
            Object.entries(snapshot).filter(
              ([key]) => key !== 'createdAt' && key !== 'updatedAt',
            ),
          )
        : snapshot;
    if (request.action === 'create') {
      // PostgreSQL compares all microseconds; JavaScript Date would truncate them.
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$3::timestamptz AND "updatedAt"=$4::timestamptz AS matches FROM core.role WHERE id=$1 AND "workspaceId"=$2',
        [
          request.roleId,
          operation.workspaceId,
          expected.createdAt,
          expected.updatedAt,
        ],
      );
      if (timestamps?.matches !== true)
        throw new Error('Role create audit persisted timestamps changed');
    }
    if (
      canonicalAuditJson(comparable(expected)) !==
      canonicalAuditJson(comparable(after))
    )
      throw new Error(
        'Role audit persisted mutation differs from requested update',
      );
    const project = (row: Record<string, unknown>) =>
      Object.fromEntries(
        [...BOOLEAN_FIELDS, ...TEXT_FIELDS].map((key) => [key, row[key]]),
      );
    audit.record({
      resourceKind: 'role',
      resourceId: request.roleId,
      action: request.action,
      before: before ? project(before) : null,
      after: project(after),
      securityDescriptor: {
        resourceKind: 'role',
        resourceId: request.roleId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await audit.flush();
    if (canonicalAuditJson(after) !== canonicalAuditJson(await read()))
      throw new Error('Role audit persisted snapshot changed during flush');
    await verifyApplication();
    return result;
  });
};
