import {
  captureCurrentCrmAuditOperation,
  captureCurrentCrmAuditTrace,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type CrmAuditOperation,
  type CrmAuditPrincipal,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

import { type NativeCrmAuditOptions } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

// Structural authentication port: keeps core audit independent of full auth/ORM metadata graphs.
type NativeCrmAuditAuth = { workspace: { id: string } } & (
  | {
      type: 'user';
      workspaceMemberId: string;
      user?: { id: string };
      application?: { id: string };
      viaApplication?: { id: string };
      agentId?: string;
    }
  | { type: 'apiKey'; apiKey: { id: string } }
  | {
      type: 'application';
      application: { id: string };
      actingAgent?: { id: string };
      agentId?: string;
    }
  | { type: 'system' | 'pendingActivationUser' }
);

export type NativeCrmAuditBinding = Readonly<{
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  ambientCorrelationId?: string;
  ambientCausationId?: string;
}>;

export type NativeCrmAuditTransactionMeta = {
  impersonatorUserWorkspaceId?: string;
  ambientCorrelationId?: string;
  ambientCausationId?: string;
};

const contexts = new WeakMap<
  object,
  {
    audit: CrmAuditTransactionContext;
    operation: CrmAuditOperation;
    postFlushChecks: Array<() => Promise<void>>;
    failure?: unknown;
  }
>();
const scopes = new WeakMap<
  object,
  {
    executor: object;
    operation: CrmAuditOperation;
    impersonatorUserWorkspaceId?: string;
    ambientCorrelationId?: string;
    ambientCausationId?: string;
  }
>();
const standaloneShareWithScopes = new WeakSet<object>();
const delegatedRecordShareExecutors = new WeakSet<object>();
const mergeChildScopes = new WeakMap<object, NativeCrmMergeChildGrant>();
const targetLifecycleScopes = new WeakMap<
  object,
  NativeCrmTargetLifecycleGrant
>();

export type NativeCrmMergeChildGrant =
  | Readonly<{
      objectMetadataId: string;
      kind: 'soft-delete';
    }>
  | Readonly<{
      objectMetadataId: string;
      kind: 'update';
      allowedJoinColumnName: string;
      allowedTargetRecordId: string;
    }>;

export type NativeCrmTargetLifecycleGrant = Readonly<{
  objectMetadataId: string;
  kind: 'soft-delete' | 'restore';
}>;

export const getNativeCrmMergeChildScope = (
  executor: object,
): NativeCrmMergeChildGrant | undefined => mergeChildScopes.get(executor);

export const getNativeCrmTargetLifecycleScope = (
  executor: object,
): NativeCrmTargetLifecycleGrant | undefined =>
  targetLifecycleScopes.get(executor);

export const runInNativeCrmMergeChildScope = async <TData>(
  scope: object,
  grant: NativeCrmMergeChildGrant,
  work: () => Promise<TData>,
): Promise<TData> => {
  const binding = scopes.get(scope);
  if (!binding) {
    throw new Error(
      'Native audit merge child scope requires a proven native audit scope',
    );
  }
  const objectMetadataId = uuid(grant.objectMetadataId);
  let normalizedGrant: NativeCrmMergeChildGrant;
  if (grant.kind === 'soft-delete') {
    normalizedGrant = {
      objectMetadataId,
      kind: 'soft-delete',
    };
  } else if (grant.kind === 'update') {
    if (
      typeof grant.allowedJoinColumnName !== 'string' ||
      grant.allowedJoinColumnName.length === 0
    ) {
      throw new Error('Native audit merge child join column is invalid');
    }
    normalizedGrant = {
      objectMetadataId,
      kind: 'update',
      allowedJoinColumnName: grant.allowedJoinColumnName,
      allowedTargetRecordId: uuid(grant.allowedTargetRecordId),
    };
  } else {
    throw new Error('Native audit merge child grant kind is invalid');
  }
  if (
    mergeChildScopes.has(binding.executor) ||
    targetLifecycleScopes.has(binding.executor) ||
    delegatedRecordShareExecutors.has(binding.executor)
  ) {
    throw new Error('Nested native audit merge child scope is unsupported');
  }
  mergeChildScopes.set(binding.executor, normalizedGrant);
  try {
    return await work();
  } finally {
    mergeChildScopes.delete(binding.executor);
  }
};

export const runInNativeCrmTargetLifecycleScope = async <TData>(
  scope: object,
  grant: NativeCrmTargetLifecycleGrant,
  work: () => Promise<TData>,
): Promise<TData> => {
  const binding = scopes.get(scope);
  if (!binding) {
    throw new Error(
      'Native audit target lifecycle scope requires a proven native audit scope',
    );
  }
  const objectMetadataId = uuid(grant.objectMetadataId);
  if (grant.kind !== 'soft-delete' && grant.kind !== 'restore') {
    throw new Error('Native audit target lifecycle grant kind is invalid');
  }
  if (
    targetLifecycleScopes.has(binding.executor) ||
    mergeChildScopes.has(binding.executor) ||
    delegatedRecordShareExecutors.has(binding.executor)
  ) {
    throw new Error(
      'Nested native audit target lifecycle scope is unsupported',
    );
  }
  targetLifecycleScopes.set(binding.executor, {
    objectMetadataId,
    kind: grant.kind,
  });
  try {
    return await work();
  } finally {
    targetLifecycleScopes.delete(binding.executor);
  }
};

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

const principalsMatch = (
  left: CrmAuditPrincipal | undefined,
  right: CrmAuditPrincipal | undefined,
): boolean =>
  (left?.kind ?? null) === (right?.kind ?? null) &&
  (left?.id ?? null) === (right?.id ?? null);

const assertNestedScopeAttribution = (
  binding: {
    operation: CrmAuditOperation;
    impersonatorUserWorkspaceId?: string;
    ambientCorrelationId?: string;
    ambientCausationId?: string;
  },
  expected: NativeCrmAuditBinding,
  checkDirectInitiator: boolean,
): void => {
  if (
    expected.operation.workspaceId !== binding.operation.workspaceId ||
    expected.operation.actor.kind !== binding.operation.actor.kind ||
    expected.operation.actor.id !== binding.operation.actor.id
  ) {
    throw new Error(
      'Public CRM mutation scope has a different workspace or actor',
    );
  }
  if (
    expected.impersonatorUserWorkspaceId !==
      binding.impersonatorUserWorkspaceId ||
    (checkDirectInitiator &&
      expected.impersonatorUserWorkspaceId === undefined &&
      !principalsMatch(expected.operation.initiator, binding.operation.initiator))
  ) {
    throw new Error(
      'Public CRM mutation scope has a different initiator or impersonation context',
    );
  }
  const correlationConflict =
    binding.ambientCorrelationId !== undefined
      ? expected.ambientCorrelationId !== binding.ambientCorrelationId
      : expected.ambientCorrelationId !== undefined ||
        (expected.operation.correlationId !== undefined &&
          expected.operation.correlationId !== binding.operation.correlationId);
  const causationConflict =
    binding.ambientCausationId !== undefined
      ? expected.ambientCausationId !== binding.ambientCausationId
      : expected.ambientCausationId !== undefined ||
        (expected.operation.causationId !== undefined &&
          expected.operation.causationId !== binding.operation.causationId);
  if (correlationConflict || causationConflict) {
    throw new Error(
      'Public CRM mutation scope has a conflicting correlation or causation context',
    );
  }
};

export const runInNativeCrmAuditScopeIfPresent = async <TData>(
  scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  auth: NativeCrmAuditAuth,
  work: (context: {
    operation: CrmAuditOperation;
    impersonatorUserWorkspaceId?: string;
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
    const expected = captureNativeCrmAuditBinding(scope.workspaceId, auth, {
      operationId: binding.operation.operationId,
      ...(auth.type === 'system'
        ? { systemActorId: binding.operation.actor.id }
        : {}),
    });
    assertNestedScopeAttribution(binding, expected, false);

    return work({
      operation: binding.operation,
      ...(binding.impersonatorUserWorkspaceId !== undefined
        ? { impersonatorUserWorkspaceId: binding.impersonatorUserWorkspaceId }
        : {}),
      record: (mutation) => ctx.audit.record(mutation),
      registerPostFlushCheck: (check) => {
        ctx.postFlushChecks.push(check);
      },
      runDelegatedRecordShareWrite: async <TWrite>(
        execute: () => Promise<TWrite>,
      ): Promise<TWrite> => {
        if (
          delegatedRecordShareExecutors.has(binding.executor) ||
          mergeChildScopes.has(binding.executor) ||
          targetLifecycleScopes.has(binding.executor)
        ) {
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
    const expected = captureNativeCrmAuditBinding(scope.workspaceId, auth, {
      operationId: binding.operation.operationId,
      ...(auth.type === 'system'
        ? { systemActorId: binding.operation.actor.id }
        : {}),
    });
    assertNestedScopeAttribution(binding, expected, true);
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

export const getNativeCrmAuditOperation = (
  executor: object,
): CrmAuditOperation | undefined => contexts.get(executor)?.operation;

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

// Pure auth-to-operation mapper (no ALS reads) so metadata/role callers managing ALS separately stay isolated.
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
  const normalizedWorkspaceId = uuid(workspaceId);
  if (uuid(auth.workspace.id) !== normalizedWorkspaceId)
    throw new Error('Native audit workspace mismatch');
  if (auth.type !== 'system' && options.systemActorId !== undefined)
    throw new Error('Only system authentication can name a system audit actor');
  let actor: CrmAuditPrincipal;
  let initiator: CrmAuditPrincipal | undefined;
  switch (auth.type) {
    case 'user': {
      const workspaceMemberId = uuid(auth.workspaceMemberId);
      const appId =
        auth.application !== undefined ? uuid(auth.application.id) : undefined;
      const viaAppId =
        auth.viaApplication !== undefined
          ? uuid(auth.viaApplication.id)
          : undefined;
      if (appId !== undefined && viaAppId !== undefined && appId !== viaAppId)
        throw new Error('Native audit application context conflict');
      const resolvedApplicationId = viaAppId ?? appId;
      const resolvedAgentId =
        auth.agentId !== undefined ? uuid(auth.agentId) : undefined;
      if (resolvedAgentId !== undefined && resolvedApplicationId === undefined)
        throw new Error('Native audit agent requires an authenticated application');
      if (resolvedAgentId !== undefined) {
        actor = { kind: 'agent', id: resolvedAgentId };
        initiator = { kind: 'workspaceMember', id: workspaceMemberId };
      } else if (resolvedApplicationId !== undefined) {
        actor = { kind: 'application', id: resolvedApplicationId };
        initiator = { kind: 'workspaceMember', id: workspaceMemberId };
      } else {
        actor = { kind: 'workspaceMember', id: workspaceMemberId };
      }
      break;
    }
    case 'application': {
      const appId = uuid(auth.application.id);
      if (auth.agentId !== undefined) uuid(auth.agentId);
      if (auth.actingAgent !== undefined) {
        actor = { kind: 'agent', id: uuid(auth.actingAgent.id) };
        initiator = { kind: 'application', id: appId };
      } else {
        actor = { kind: 'application', id: appId };
      }
      break;
    }
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
    workspaceId: normalizedWorkspaceId,
    operationId: uuid(options.operationId),
    actor: Object.freeze(actor),
    ...(initiator !== undefined ? { initiator: Object.freeze(initiator) } : {}),
    ...(options.correlationId === undefined
      ? {}
      : { correlationId: identifier(options.correlationId) }),
    ...(options.causationId === undefined
      ? {}
      : { causationId: identifier(options.causationId) }),
  });
};

export const captureNativeCrmAuditBinding = (
  workspaceId: string,
  auth: NativeCrmAuditAuth,
  options: NativeCrmAuditOptions,
): NativeCrmAuditBinding => {
  const baseOperation = captureNativeCrmAuditOperation(
    workspaceId,
    auth,
    options,
  );
  const normalizedWorkspaceId = baseOperation.workspaceId;

  if (auth.type === 'system') {
    const trace = captureCurrentCrmAuditTrace(normalizedWorkspaceId);
    const correlationId =
      options.correlationId !== undefined
        ? identifier(options.correlationId)
        : trace?.correlationId;
    const causationId =
      options.causationId !== undefined
        ? identifier(options.causationId)
        : trace?.causationId;
    return Object.freeze({
      operation: Object.freeze({
        ...baseOperation,
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(causationId !== undefined ? { causationId } : {}),
      }),
      ...(trace?.correlationId !== undefined
        ? { ambientCorrelationId: trace.correlationId }
        : {}),
      ...(trace?.causationId !== undefined
        ? { ambientCausationId: trace.causationId }
        : {}),
    });
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  let actor: CrmAuditPrincipal = baseOperation.actor;
  let initiator: CrmAuditPrincipal | undefined = baseOperation.initiator;
  let impersonatorUserWorkspaceId: string | undefined;

  if (auth.type === 'user') {
    const workspaceMemberId = uuid(auth.workspaceMemberId);
    const userId = auth.user !== undefined ? uuid(auth.user.id) : undefined;
    let resolvedApplicationId =
      auth.viaApplication !== undefined
        ? uuid(auth.viaApplication.id)
        : auth.application !== undefined
          ? uuid(auth.application.id)
          : undefined;
    let resolvedAgentId =
      auth.agentId !== undefined ? uuid(auth.agentId) : undefined;
    let resolvedAmbientInitiator: CrmAuditPrincipal | undefined;

    if (ambient) {
      const ambientActor = ambient.operation.actor;
      const ambientInitiator = ambient.operation.initiator;
      if (ambientActor.kind === 'coreUser') {
        if (userId === undefined || ambientActor.id !== userId)
          throw new Error('Native audit ambient user conflict');
        if (ambientInitiator !== undefined) {
          resolvedAmbientInitiator = ambientInitiator;
        }
      } else if (ambientActor.kind === 'workspaceMember') {
        if (ambientActor.id !== workspaceMemberId)
          throw new Error('Native audit ambient member conflict');
        if (ambientInitiator !== undefined) {
          resolvedAmbientInitiator = ambientInitiator;
        }
      } else if (ambientActor.kind === 'application') {
        if (
          resolvedApplicationId !== undefined &&
          resolvedApplicationId !== ambientActor.id
        )
          throw new Error('Native audit ambient application conflict');
        const initiatorValid =
          ambientInitiator === undefined
            ? resolvedApplicationId === ambientActor.id
            : (ambientInitiator.kind === 'coreUser' &&
                userId !== undefined &&
                ambientInitiator.id === userId) ||
              (ambientInitiator.kind === 'workspaceMember' &&
                ambientInitiator.id === workspaceMemberId);
        if (!initiatorValid)
          throw new Error('Native audit ambient initiator conflict');
        resolvedApplicationId = ambientActor.id;
      } else if (ambientActor.kind === 'agent') {
        if (resolvedAgentId !== undefined && resolvedAgentId !== ambientActor.id)
          throw new Error('Native audit ambient agent conflict');
        const initiatorValid =
          ambientInitiator === undefined
            ? resolvedAgentId === ambientActor.id &&
              resolvedApplicationId !== undefined
            : (ambientInitiator.kind === 'coreUser' &&
                userId !== undefined &&
                ambientInitiator.id === userId) ||
              (ambientInitiator.kind === 'workspaceMember' &&
                ambientInitiator.id === workspaceMemberId) ||
              (ambientInitiator.kind === 'application' &&
                resolvedApplicationId !== undefined &&
                ambientInitiator.id === resolvedApplicationId);
        if (!initiatorValid)
          throw new Error('Native audit ambient initiator conflict');
        resolvedAgentId = ambientActor.id;
      } else {
        throw new Error('Native audit ambient principal conflict');
      }

      if (ambient.impersonatorUserWorkspaceId !== undefined) {
        impersonatorUserWorkspaceId = uuid(ambient.impersonatorUserWorkspaceId);
      }
    }

    if (
      (impersonatorUserWorkspaceId !== undefined ||
        resolvedAmbientInitiator !== undefined) &&
      (resolvedAgentId !== undefined || resolvedApplicationId !== undefined)
    ) {
      throw new Error(
        'Native audit impersonation cannot combine with agent or application',
      );
    }

    if (resolvedAgentId !== undefined) {
      actor = { kind: 'agent', id: resolvedAgentId };
      initiator = { kind: 'workspaceMember', id: workspaceMemberId };
    } else if (resolvedApplicationId !== undefined) {
      actor = { kind: 'application', id: resolvedApplicationId };
      initiator = { kind: 'workspaceMember', id: workspaceMemberId };
    } else {
      actor = { kind: 'workspaceMember', id: workspaceMemberId };
      initiator = resolvedAmbientInitiator;
    }
  } else if (auth.type === 'application') {
    const appId = uuid(auth.application.id);
    const actingAgentId =
      auth.actingAgent !== undefined ? uuid(auth.actingAgent.id) : undefined;
    const narrowedAgentId =
      auth.agentId !== undefined ? uuid(auth.agentId) : undefined;
    if (ambient) {
      if (ambient.impersonatorUserWorkspaceId !== undefined)
        throw new Error('Native audit impersonation cannot combine with application');
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
        if (!validAgentAmbient && !validAppAmbient)
          throw new Error('Native audit ambient agent conflict');
      } else {
        const validAppAmbient =
          a.kind === 'application' && a.id === appId && ambInit === undefined;
        const validNarrowedAgentAmbient =
          a.kind === 'agent' &&
          ambInit?.kind === 'application' &&
          ambInit.id === appId &&
          (narrowedAgentId === undefined || a.id === narrowedAgentId);
        if (!validAppAmbient && !validNarrowedAgentAmbient)
          throw new Error('Native audit ambient application conflict');
      }
    }
  } else if (auth.type === 'apiKey') {
    const apiKeyId = uuid(auth.apiKey.id);
    if (ambient) {
      if (
        ambient.impersonatorUserWorkspaceId !== undefined ||
        ambient.operation.initiator !== undefined ||
        ambient.operation.actor.kind !== 'apiKey' ||
        ambient.operation.actor.id !== apiKeyId
      )
        throw new Error('Native audit ambient apiKey conflict');
    }
  }

  const correlationId =
    options.correlationId !== undefined
      ? identifier(options.correlationId)
      : ambient?.operation.correlationId;
  const causationId =
    options.causationId !== undefined
      ? identifier(options.causationId)
      : ambient?.operation.causationId;

  return Object.freeze({
    operation: Object.freeze({
      workspaceId: normalizedWorkspaceId,
      operationId: baseOperation.operationId,
      actor: Object.freeze(actor),
      ...(initiator !== undefined
        ? { initiator: Object.freeze(initiator) }
        : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(causationId !== undefined ? { causationId } : {}),
    }),
    ...(impersonatorUserWorkspaceId !== undefined
      ? { impersonatorUserWorkspaceId }
      : {}),
    ...(ambient?.operation.correlationId !== undefined
      ? { ambientCorrelationId: ambient.operation.correlationId }
      : {}),
    ...(ambient?.operation.causationId !== undefined
      ? { ambientCausationId: ambient.operation.causationId }
      : {}),
  });
};

export const withNativeCrmAuditTransaction = async <T>(
  executor: object,
  scope: Parameters<typeof createCrmAuditWorkspaceExecutor>[0],
  operation: CrmAuditOperation,
  work: () => Promise<T>,
  meta?: NativeCrmAuditTransactionMeta,
): Promise<T> => {
  if (
    contexts.has(executor) ||
    scopes.has(scope) ||
    standaloneShareWithScopes.has(scope)
  )
    throw new Error('Native audit owner already exists');
  const normalizedImpersonator =
    meta?.impersonatorUserWorkspaceId !== undefined
      ? uuid(meta.impersonatorUserWorkspaceId)
      : undefined;
  const normalizedAmbientCorrelationId =
    meta?.ambientCorrelationId !== undefined
      ? identifier(meta.ambientCorrelationId)
      : undefined;
  const normalizedAmbientCausationId =
    meta?.ambientCausationId !== undefined
      ? identifier(meta.ambientCausationId)
      : undefined;
  if (
    normalizedImpersonator !== undefined &&
    operation.actor.kind !== 'workspaceMember'
  )
    throw new Error('Native audit impersonation requires a user actor');
  operation = {
    ...operation,
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const auditExecutor = createCrmAuditWorkspaceExecutor(scope);
  if (normalizedImpersonator !== undefined) {
    // Server-level impersonation allows an admin userWorkspace from another workspace.
    const rows = await auditExecutor.query(
      'SELECT "userId" FROM core."userWorkspace" WHERE id = $1 AND "deletedAt" IS NULL',
      [normalizedImpersonator],
    );
    const impersonatorRow = rows[0] as { userId?: unknown } | undefined;
    if (rows.length !== 1 || typeof impersonatorRow?.userId !== 'string')
      throw new Error('Native audit impersonation initiator unavailable');
    const resolvedInitiatorId = uuid(impersonatorRow.userId);
    if (
      operation.initiator &&
      (operation.initiator.kind !== 'coreUser' ||
        uuid(operation.initiator.id) !== resolvedInitiatorId)
    )
      throw new Error('Native audit impersonation context conflict');
    operation = {
      ...operation,
      initiator: { kind: 'coreUser', id: resolvedInitiatorId },
    };
  }
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
    operation: CrmAuditOperation;
    postFlushChecks: Array<() => Promise<void>>;
    failure?: unknown;
  } = {
    audit,
    operation,
    postFlushChecks: [],
  };
  contexts.set(executor, binding);
  scopes.set(scope, {
    executor,
    operation,
    ...(normalizedImpersonator !== undefined
      ? { impersonatorUserWorkspaceId: normalizedImpersonator }
      : {}),
    ...(normalizedAmbientCorrelationId !== undefined
      ? { ambientCorrelationId: normalizedAmbientCorrelationId }
      : {}),
    ...(normalizedAmbientCausationId !== undefined
      ? { ambientCausationId: normalizedAmbientCausationId }
      : {}),
  });
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
