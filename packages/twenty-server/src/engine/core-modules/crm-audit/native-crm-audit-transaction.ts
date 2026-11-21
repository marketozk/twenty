import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type CrmAuditOperation,
  type CrmAuditPrincipal,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

import { type NativeCrmAuditOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

// Structural authentication port: keeps core audit independent of full auth/ORM metadata graphs.
type NativeCrmAuditAuth = { workspace: { id: string } } & (
  | { type: 'user'; workspaceMemberId: string }
  | { type: 'apiKey'; apiKey: { id: string } }
  | {
      type: 'application';
      application: { id: string };
      actingAgent?: { id: string };
    }
  | { type: 'system' | 'pendingActivationUser' }
);

const contexts = new WeakMap<
  object,
  {
    audit: CrmAuditTransactionContext;
    postFlushChecks: Array<() => Promise<void>>;
    failure?: unknown;
  }
>();
const scopes = new WeakMap<
  object,
  { executor: object; operation: CrmAuditOperation }
>();
const standaloneShareWithScopes = new WeakSet<object>();
const delegatedRecordShareExecutors = new WeakSet<object>();

export const isDelegatedRecordShareAuditWrite = (
  executor: object,
  objectMetadataNameSingular?: string,
): boolean =>
  objectMetadataNameSingular === 'recordShare' &&
  delegatedRecordShareExecutors.has(executor);

export const isStandaloneShareWithScope = (scope: object): boolean =>
  standaloneShareWithScopes.has(scope);

export const runInStandaloneShareWithScope = async <TData>(
  scope: object,
  work: () => Promise<TData>,
): Promise<TData> => {
  if (scopes.has(scope) || standaloneShareWithScopes.has(scope)) {
    throw new Error('Standalone shareWith audit scope conflict');
  }
  standaloneShareWithScopes.add(scope);
  try {
    return await work();
  } finally {
    standaloneShareWithScopes.delete(scope);
  }
};

export const isRegisteredNativeCrmAuditScope = (scope: object): boolean =>
  scopes.has(scope);

export const runInNativeCrmAuditScopeIfPresent = async <TData>(
  scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  auth: NativeCrmAuditAuth,
  work: (context: {
    operation: CrmAuditOperation;
    record: (mutation: Parameters<CrmAuditTransactionContext['record']>[0]) => void;
    registerPostFlushCheck: (check: () => Promise<void>) => void;
    runDelegatedRecordShareWrite: <TWrite>(
      execute: () => Promise<TWrite>,
    ) => Promise<TWrite>;
  }) => Promise<TData>,
): Promise<{ handled: false } | { handled: true; value: TData }> => {
  const binding = scopes.get(scope);
  if (!binding) {
    return { handled: false };
  }
  const ctx = contexts.get(binding.executor);
  if (!ctx) {
    throw new Error('Native audit scope missing active transaction context');
  }
  const value = await runNativeCrmAuditWrite(binding.executor, async () => {
    createCrmAuditWorkspaceExecutor(scope);
    const expected = captureNativeCrmAuditOperation(scope.workspaceId, auth, {
      operationId: binding.operation.operationId,
      ...(auth.type === 'system'
        ? { systemActorId: binding.operation.actor.id }
        : {}),
    });
    if (
      expected.workspaceId !== binding.operation.workspaceId ||
      expected.actor.kind !== binding.operation.actor.kind ||
      expected.actor.id !== binding.operation.actor.id
    ) {
      throw new Error(
        'Public CRM mutation scope has a different workspace or actor',
      );
    }

    return work({
      operation: binding.operation,
      record: (mutation) => ctx.audit.record(mutation),
      registerPostFlushCheck: (check) => {
        ctx.postFlushChecks.push(check);
      },
      runDelegatedRecordShareWrite: async <TWrite>(
        execute: () => Promise<TWrite>,
      ): Promise<TWrite> => {
        if (delegatedRecordShareExecutors.has(binding.executor)) {
          throw new Error('Nested delegated recordShare write is unsupported');
        }
        delegatedRecordShareExecutors.add(binding.executor);
        try {
          return await execute();
        } finally {
          delegatedRecordShareExecutors.delete(binding.executor);
        }
      },
    });
  });

  return { handled: true, value };
};

export const runInExistingNativeCrmAuditScope = async <TData>(
  scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  auth: NativeCrmAuditAuth,
  work: () => Promise<TData>,
): Promise<TData> => {
  const binding = scopes.get(scope);
  if (!binding)
    throw new Error('Public CRM mutation requires a proven native audit scope');
  return runNativeCrmAuditWrite(binding.executor, async () => {
    createCrmAuditWorkspaceExecutor(scope);
    const expected = captureNativeCrmAuditOperation(scope.workspaceId, auth, {
      operationId: binding.operation.operationId,
      ...(auth.type === 'system'
        ? { systemActorId: binding.operation.actor.id }
        : {}),
    });
    if (
      expected.workspaceId !== binding.operation.workspaceId ||
      expected.actor.kind !== binding.operation.actor.kind ||
      expected.actor.id !== binding.operation.actor.id
    )
      throw new Error(
        'Public CRM mutation scope has a different workspace or actor',
      );
    return work();
  });
};
export const getNativeCrmAuditContext = (
  executor: object,
  objectMetadataNameSingular?: string,
) =>
  isDelegatedRecordShareAuditWrite(executor, objectMetadataNameSingular)
    ? undefined
    : contexts.get(executor)?.audit;

export const runNativeCrmAuditWrite = async <T>(
  executor: object,
  work: () => Promise<T>,
): Promise<T> => {
  const binding = contexts.get(executor);
  if (!binding) return work();
  if (binding.failure !== undefined) throw binding.failure;
  try {
    return await work();
  } catch (error) {
    binding.failure = error ?? new Error('Native audited write failed');
    throw error;
  }
};

const uuid = (value: string): string => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new Error('Native audit UUID is invalid');
  return value.toLowerCase();
};
const identifier = (value: string): string => {
  if (typeof value !== 'string' || !value.length || value.length > 256)
    throw new Error('Native audit identifier is invalid');
  return value;
};

export const captureNativeCrmAuditOperation = (
  workspaceId: string,
  auth: NativeCrmAuditAuth,
  options: NativeCrmAuditOptions,
): CrmAuditOperation => {
  if (
    !options ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).some(
      (key) =>
        ![
          'operationId',
          'correlationId',
          'causationId',
          'systemActorId',
        ].includes(key),
    )
  )
    throw new Error('Native audit operation options are invalid');
  if (uuid(auth.workspace.id) !== uuid(workspaceId))
    throw new Error('Native audit workspace mismatch');
  if (auth.type !== 'system' && options.systemActorId !== undefined)
    throw new Error('Only system authentication can name a system audit actor');
  let actor: CrmAuditPrincipal;
  switch (auth.type) {
    case 'user':
      actor = { kind: 'workspaceMember', id: uuid(auth.workspaceMemberId) };
      break;
    case 'application':
      actor = auth.actingAgent
        ? { kind: 'agent', id: uuid(auth.actingAgent.id) }
        : { kind: 'application', id: uuid(auth.application.id) };
      break;
    case 'apiKey':
      actor = { kind: 'apiKey', id: uuid(auth.apiKey.id) };
      break;
    case 'system':
      actor = { kind: 'system', id: identifier(options.systemActorId!) };
      break;
    default:
      throw new Error('Authentication cannot perform audited CRM writes');
  }
  return Object.freeze({
    workspaceId: uuid(workspaceId),
    operationId: uuid(options.operationId),
    actor: Object.freeze(actor),
    ...(options.correlationId === undefined
      ? {}
      : { correlationId: identifier(options.correlationId) }),
    ...(options.causationId === undefined
      ? {}
      : { causationId: identifier(options.causationId) }),
  });
};

export const withNativeCrmAuditTransaction = async <T>(
  executor: object,
  scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  operation: CrmAuditOperation,
  work: () => Promise<T>,
): Promise<T> => {
  if (
    contexts.has(executor) ||
    scopes.has(scope) ||
    standaloneShareWithScopes.has(scope)
  )
    throw new Error('Native audit owner already exists');
  operation = {
    ...operation,
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const auditExecutor = createCrmAuditWorkspaceExecutor(scope);
  // Native mutations have no command receipt: reusing an operation is not a safe retry.
  await auditExecutor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`native-crm-audit:${operation.workspaceId}:${operation.operationId}`],
  );
  const previous = await auditExecutor.query(
    `SELECT 1 FROM crm_audit."crmAuditEntry"
     WHERE "workspaceId"=$1 AND "operationId"=$2 LIMIT 1`,
    [operation.workspaceId, operation.operationId],
  );
  if (previous.length)
    throw new Error('Native audit operation was already committed');
  const audit = new CrmAuditTransactionContext(auditExecutor, operation);
  const binding: {
    audit: CrmAuditTransactionContext;
    postFlushChecks: Array<() => Promise<void>>;
    failure?: unknown;
  } = {
    audit,
    postFlushChecks: [],
  };
  contexts.set(executor, binding);
  scopes.set(scope, { executor, operation });
  try {
    const result = await work();
    if (binding.failure !== undefined) throw binding.failure;
    await audit.flush();
    for (const postFlushCheck of binding.postFlushChecks) {
      await postFlushCheck();
    }
    return result;
  } finally {
    scopes.delete(scope);
    contexts.delete(executor);
  }
};
