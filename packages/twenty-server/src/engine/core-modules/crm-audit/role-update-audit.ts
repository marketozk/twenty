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

type RoleUpdateAuditRequest = Readonly<{
  operation: CrmAuditOperation;
  roleId: string;
  impersonatorUserWorkspaceId?: string;
}>;

const storage = new AsyncLocalStorage<RoleUpdateAuditRequest>();
const active = new WeakSet<RoleUpdateAuditRequest>();
const consumed = new WeakSet<RoleUpdateAuditRequest>();
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
  if (storage.getStore()) throw new Error('Nested role audit is unsupported');
  if (!identity?.auth)
    throw new Error('Role update requires authenticated audit identity');
  const captured = captureNativeCrmAuditOperation(workspaceId, identity.auth, {
    operationId: randomUUID(),
  });
  const operation: CrmAuditOperation = identity.agentId
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
  const request = Object.freeze({
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

export const getRoleUpdateAudit = (workspaceId: string) => {
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
};

export const runAuditedRoleUpdate = async <T>(
  dataSource: DataSource,
  request: RoleUpdateAuditRequest,
  actions: RoleUpdateAction[],
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (
    getRoleUpdateAudit(request.operation.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error(
      'Role audit operation is not active or was already consumed',
    );
  if (
    actions.length !== 1 ||
    actions[0].type !== 'update' ||
    actions[0].metadataName !== 'role'
  )
    throw new Error('Role audit requires exactly one role update action');
  const action = actions[0];
  const universalIdentifier = uuid(action.universalIdentifier!);
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
    const before = await read(true);
    if (
      before.universalIdentifier !== universalIdentifier ||
      before.isEditable !== true
    )
      throw new Error('Role audit persisted identity or editability changed');
    let operation = request.operation;
    if (request.impersonatorUserWorkspaceId) {
      const rows = await runner.query(
        'SELECT "userId" FROM core."userWorkspace" WHERE id=$1 AND "deletedAt" IS NULL',
        [request.impersonatorUserWorkspaceId],
      );
      if (rows.length !== 1)
        throw new Error('Role audit impersonation initiator unavailable');
      operation = {
        ...operation,
        initiator: { kind: 'coreUser', id: uuid(rows[0].userId) },
      };
    }
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const after = await read();
    const expected = { ...before, ...update, updatedAt: after.updatedAt };
    if (canonicalAuditJson(expected) !== canonicalAuditJson(after))
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
      action: 'update',
      before: project(before),
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
    return result;
  });
};
