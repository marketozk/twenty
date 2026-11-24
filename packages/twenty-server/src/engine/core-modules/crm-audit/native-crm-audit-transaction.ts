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
import {
  membershipCleanupOperation,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

import {
  type NativeCrmAuditBinding,
  type NativeCrmAuditOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

export type { NativeCrmAuditBinding };

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

export type NativeCrmAuditTransactionMeta = {
  impersonatorUserWorkspaceId?: string;
  pendingAuthUserWorkspaceId?: string;
  pendingAgentId?: string;
  pendingUserWorkspaceActor?: boolean;
  pendingUserWorkspaceExpectedUserId?: string;
  ambientCorrelationId?: string;
  ambientCausationId?: string;
};

type NativeCrmNavigationRequestLikeIdentity = {
  auth?: NativeCrmAuditAuth;
  workspace?: { id: string };
  apiKey?: { id: string } | null;
  user?: { id?: string } | null;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  application?: { id: string } | null;
  viaApplication?: { id: string } | null;
  agentId?: string;
  impersonatorUserWorkspaceId?: string;
  impersonationContext?: { impersonatorUserWorkspaceId?: string };
  systemActorId?: string;
  correlationId?: string;
  causationId?: string;
};

export type NativeCrmNavigationAuditIdentity =
  | MembershipCleanupIdentity
  | NativeCrmNavigationRequestLikeIdentity;

const trustedNavigationBindings = new WeakSet<NativeCrmAuditBinding>();
const consumedNavigationBindings = new WeakSet<NativeCrmAuditBinding>();

const workspaceSchemaForNormalizedUuid = (workspaceId: string): string =>
  `workspace_${BigInt('0x' + workspaceId.replaceAll('-', '')).toString(36)}`;

const registerTrustedNavigationBinding = (
  binding: NativeCrmAuditBinding,
): NativeCrmAuditBinding => {
  trustedNavigationBindings.add(binding);

  return binding;
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

const hasExplicitNavigationPrincipal = (
  identity: NativeCrmNavigationRequestLikeIdentity,
): boolean =>
  identity.auth !== undefined ||
  (identity.user !== undefined && identity.user !== null) ||
  identity.workspaceMemberId !== undefined ||
  (identity.apiKey !== undefined && identity.apiKey !== null) ||
  (identity.application !== undefined && identity.application !== null) ||
  (identity.viaApplication !== undefined && identity.viaApplication !== null) ||
  identity.agentId !== undefined ||
  identity.systemActorId !== undefined ||
  identity.impersonatorUserWorkspaceId !== undefined ||
  identity.impersonationContext?.impersonatorUserWorkspaceId !== undefined;

export const captureNativeCrmAuditBindingFromNavigationIdentity = ({
  workspaceId,
  operationId,
  auditIdentity,
  authUserWorkspaceId,
  defaultSystemActorId,
}: {
  workspaceId: string;
  operationId: string;
  auditIdentity?: NativeCrmNavigationAuditIdentity;
  authUserWorkspaceId?: string;
  defaultSystemActorId?: string;
}): NativeCrmAuditBinding => {
  const normalizedWorkspaceId = uuid(workspaceId);
  const normalizedOperationId = uuid(operationId);
  const normalizedAuthUserWorkspaceId =
    authUserWorkspaceId !== undefined ? uuid(authUserWorkspaceId) : undefined;

  let ambientLoaded = false;
  let cachedAmbient:
    | ReturnType<typeof captureCurrentCrmAuditOperation>
    | undefined;
  const getAmbient = () => {
    if (!ambientLoaded) {
      cachedAmbient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
      ambientLoaded = true;
    }

    return cachedAmbient;
  };

  const buildAmbientMeta = (
    trace?: { correlationId?: string; causationId?: string },
  ) => ({
    ...(trace?.correlationId !== undefined
      ? { ambientCorrelationId: trace.correlationId }
      : {}),
    ...(trace?.causationId !== undefined
      ? { ambientCausationId: trace.causationId }
      : {}),
  });

  if (
    auditIdentity !== undefined &&
    auditIdentity !== null &&
    typeof auditIdentity === 'object' &&
    'actor' in auditIdentity &&
    !('auth' in auditIdentity)
  ) {
    const cleanupIdentity = auditIdentity as MembershipCleanupIdentity;
    if (cleanupIdentity.workspaceId === undefined)
      throw new Error('CRM audit context requires scoped identity');
    const cleanupOp = membershipCleanupOperation(
      normalizedWorkspaceId,
      cleanupIdentity,
    );
    if (!cleanupOp)
      throw new Error('Authentication cannot perform audited CRM writes');

    if (cleanupOp.actor.kind === 'system') {
      if (normalizedAuthUserWorkspaceId !== undefined)
        throw new Error(
          'Native audit userWorkspace requires a user-scoped actor',
        );
      const trace = captureCurrentCrmAuditTrace(normalizedWorkspaceId);
      const correlationId = cleanupOp.correlationId ?? trace?.correlationId;
      const causationId = cleanupOp.causationId ?? trace?.causationId;

      return registerTrustedNavigationBinding(
        Object.freeze({
          operation: Object.freeze({
            workspaceId: normalizedWorkspaceId,
            operationId: normalizedOperationId,
            actor: Object.freeze({ ...cleanupOp.actor }),
            ...(cleanupOp.initiator !== undefined
              ? { initiator: Object.freeze({ ...cleanupOp.initiator }) }
              : {}),
            ...(correlationId !== undefined ? { correlationId } : {}),
            ...(causationId !== undefined ? { causationId } : {}),
          }),
          ...buildAmbientMeta(trace),
        }),
      );
    }

    const ambient = getAmbient();
    let impersonatorUserWorkspaceId: string | undefined;
    let resolvedInitiator = cleanupOp.initiator;

    if (ambient) {
      if (ambient.impersonatorUserWorkspaceId !== undefined) {
        if (
          cleanupOp.actor.kind !== 'coreUser' &&
          cleanupOp.actor.kind !== 'workspaceMember'
        )
          throw new Error(
            'Native audit impersonation cannot combine with agent or application',
          );
        impersonatorUserWorkspaceId = uuid(ambient.impersonatorUserWorkspaceId);
      }
      const ambientActor = ambient.operation.actor;
      if (
        ambientActor.kind !== cleanupOp.actor.kind ||
        ambientActor.id !== cleanupOp.actor.id
      )
        throw new Error('Native audit ambient principal conflict');
      if (ambient.operation.initiator !== undefined) {
        if (
          cleanupOp.initiator !== undefined &&
          (ambient.operation.initiator.kind !== cleanupOp.initiator.kind ||
            ambient.operation.initiator.id !== cleanupOp.initiator.id)
        )
          throw new Error('Native audit ambient initiator conflict');
        resolvedInitiator = ambient.operation.initiator;
      } else if (cleanupOp.initiator !== undefined) {
        if (
          impersonatorUserWorkspaceId === undefined ||
          cleanupOp.initiator.kind !== 'coreUser'
        )
          throw new Error('Native audit ambient initiator conflict');
      }
    }

    let pendingUserWorkspaceExpectedUserId: string | undefined;
    if (normalizedAuthUserWorkspaceId !== undefined) {
      const userPrincipal =
        cleanupOp.actor.kind === 'coreUser' ||
        cleanupOp.actor.kind === 'workspaceMember'
          ? cleanupOp.actor
          : resolvedInitiator?.kind === 'coreUser' ||
              resolvedInitiator?.kind === 'workspaceMember'
            ? resolvedInitiator
            : undefined;
      if (!userPrincipal)
        throw new Error(
          'Native audit userWorkspace requires a user-scoped actor',
        );
      if (userPrincipal.kind === 'coreUser') {
        pendingUserWorkspaceExpectedUserId = uuid(userPrincipal.id);
      }
    }

    const correlationId =
      cleanupOp.correlationId ?? ambient?.operation.correlationId;
    const causationId = cleanupOp.causationId ?? ambient?.operation.causationId;

    return registerTrustedNavigationBinding(
      Object.freeze({
        operation: Object.freeze({
          workspaceId: normalizedWorkspaceId,
          operationId: normalizedOperationId,
          actor: Object.freeze({ ...cleanupOp.actor }),
          ...(resolvedInitiator !== undefined
            ? { initiator: Object.freeze({ ...resolvedInitiator }) }
            : {}),
          ...(correlationId !== undefined ? { correlationId } : {}),
          ...(causationId !== undefined ? { causationId } : {}),
        }),
        ...(impersonatorUserWorkspaceId !== undefined
          ? { impersonatorUserWorkspaceId }
          : {}),
        ...(normalizedAuthUserWorkspaceId !== undefined
          ? { pendingAuthUserWorkspaceId: normalizedAuthUserWorkspaceId }
          : {}),
        ...(pendingUserWorkspaceExpectedUserId !== undefined
          ? { pendingUserWorkspaceExpectedUserId }
          : {}),
        ...buildAmbientMeta(ambient?.operation),
      }),
    );
  }

  const reqLike = (
    auditIdentity !== undefined &&
    auditIdentity !== null &&
    typeof auditIdentity === 'object'
      ? auditIdentity
      : {}
  ) as NativeCrmNavigationRequestLikeIdentity;

  if (
    reqLike.workspace !== undefined &&
    reqLike.workspace !== null &&
    uuid(reqLike.workspace.id) !== normalizedWorkspaceId
  )
    throw new Error('Native audit workspace mismatch');

  const explicitCorrelationId =
    reqLike.correlationId !== undefined
      ? identifier(reqLike.correlationId)
      : undefined;
  const explicitCausationId =
    reqLike.causationId !== undefined
      ? identifier(reqLike.causationId)
      : undefined;
  const explicitImpersonatorRaw =
    reqLike.impersonatorUserWorkspaceId ??
    reqLike.impersonationContext?.impersonatorUserWorkspaceId;
  const explicitImpersonator =
    explicitImpersonatorRaw !== undefined
      ? uuid(explicitImpersonatorRaw)
      : undefined;
  const explicitAgentId =
    reqLike.agentId !== undefined ? uuid(reqLike.agentId) : undefined;

  const bindUserOrCoreUser = ({
    workspaceMemberId,
    userId,
    applicationId,
    agentId,
  }: {
    workspaceMemberId?: string;
    userId?: string;
    applicationId?: string;
    agentId?: string;
  }): NativeCrmAuditBinding => {
    const ambient = getAmbient();
    let resolvedApplicationId = applicationId;
    let resolvedAgentId = agentId;
    let resolvedAmbientInitiator: CrmAuditPrincipal | undefined;
    let impersonatorUserWorkspaceId = explicitImpersonator;

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
        if (
          workspaceMemberId === undefined ||
          ambientActor.id !== workspaceMemberId
        )
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
                workspaceMemberId !== undefined &&
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
                workspaceMemberId !== undefined &&
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
        const ambientImpersonator = uuid(ambient.impersonatorUserWorkspaceId);
        if (
          impersonatorUserWorkspaceId !== undefined &&
          impersonatorUserWorkspaceId !== ambientImpersonator
        )
          throw new Error('Native audit impersonation context conflict');
        impersonatorUserWorkspaceId = ambientImpersonator;
      } else if (
        impersonatorUserWorkspaceId !== undefined &&
        ambientInitiator === undefined
      ) {
        throw new Error('Native audit impersonation context conflict');
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

    const baseUserPrincipal: CrmAuditPrincipal =
      workspaceMemberId !== undefined
        ? { kind: 'workspaceMember', id: workspaceMemberId }
        : { kind: 'coreUser', id: userId! };

    let actor: CrmAuditPrincipal;
    let initiator: CrmAuditPrincipal | undefined;
    if (resolvedAgentId !== undefined) {
      actor = { kind: 'agent', id: resolvedAgentId };
      initiator = baseUserPrincipal;
    } else if (resolvedApplicationId !== undefined) {
      actor = { kind: 'application', id: resolvedApplicationId };
      initiator = baseUserPrincipal;
    } else {
      actor = baseUserPrincipal;
      initiator = resolvedAmbientInitiator;
    }

    const correlationId =
      explicitCorrelationId ?? ambient?.operation.correlationId;
    const causationId = explicitCausationId ?? ambient?.operation.causationId;

    return registerTrustedNavigationBinding(
      Object.freeze({
        operation: Object.freeze({
          workspaceId: normalizedWorkspaceId,
          operationId: normalizedOperationId,
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
        ...(normalizedAuthUserWorkspaceId !== undefined
          ? { pendingAuthUserWorkspaceId: normalizedAuthUserWorkspaceId }
          : {}),
        ...(normalizedAuthUserWorkspaceId !== undefined && userId !== undefined
          ? { pendingUserWorkspaceExpectedUserId: userId }
          : {}),
        ...buildAmbientMeta(ambient?.operation),
      }),
    );
  };

  if (hasExplicitNavigationPrincipal(reqLike)) {
    if (reqLike.auth !== undefined) {
      if (
        (reqLike.workspace !== undefined && reqLike.workspace !== null) ||
        (reqLike.apiKey !== undefined && reqLike.apiKey !== null) ||
        (reqLike.user !== undefined && reqLike.user !== null) ||
        reqLike.workspaceMemberId !== undefined ||
        (reqLike.application !== undefined && reqLike.application !== null) ||
        (reqLike.viaApplication !== undefined &&
          reqLike.viaApplication !== null)
      )
        throw new Error('Ambiguous navigation audit authentication');
      const auth = reqLike.auth;
      if (uuid(auth.workspace.id) !== normalizedWorkspaceId)
        throw new Error('Native audit workspace mismatch');
      if (auth.type !== 'system' && reqLike.systemActorId !== undefined)
        throw new Error('Only system authentication can name a system audit actor');

      if (auth.type === 'system') {
        if (
          explicitImpersonator !== undefined ||
          explicitAgentId !== undefined ||
          normalizedAuthUserWorkspaceId !== undefined
        )
          throw new Error('Ambiguous navigation audit authentication');
        const resolvedSystemActorId =
          reqLike.systemActorId ?? defaultSystemActorId;
        if (resolvedSystemActorId === undefined)
          throw new Error('System audit actor requires a valid systemActorId');

        return registerTrustedNavigationBinding(
          captureNativeCrmAuditBinding(
            normalizedWorkspaceId,
            { type: 'system', workspace: { id: normalizedWorkspaceId } },
            {
              operationId: normalizedOperationId,
              systemActorId: resolvedSystemActorId,
              ...(explicitCorrelationId !== undefined
                ? { correlationId: explicitCorrelationId }
                : {}),
              ...(explicitCausationId !== undefined
                ? { causationId: explicitCausationId }
                : {}),
            },
          ),
        );
      }

      if (auth.type === 'apiKey') {
        if (
          explicitImpersonator !== undefined ||
          explicitAgentId !== undefined ||
          normalizedAuthUserWorkspaceId !== undefined
        )
          throw new Error('Ambiguous navigation audit authentication');

        return registerTrustedNavigationBinding(
          captureNativeCrmAuditBinding(normalizedWorkspaceId, auth, {
            operationId: normalizedOperationId,
            ...(explicitCorrelationId !== undefined
              ? { correlationId: explicitCorrelationId }
              : {}),
            ...(explicitCausationId !== undefined
              ? { causationId: explicitCausationId }
              : {}),
          }),
        );
      }

      if (auth.type === 'application') {
        if (
          explicitImpersonator !== undefined ||
          normalizedAuthUserWorkspaceId !== undefined
        )
          throw new Error('Ambiguous navigation audit authentication');
        let effectiveAuth = auth;
        if (explicitAgentId !== undefined) {
          if (
            auth.actingAgent !== undefined &&
            uuid(auth.actingAgent.id) !== explicitAgentId
          )
            throw new Error('Native audit ambient agent conflict');
          effectiveAuth =
            auth.actingAgent !== undefined
              ? auth
              : { ...auth, actingAgent: { id: explicitAgentId } };
        }

        return registerTrustedNavigationBinding(
          captureNativeCrmAuditBinding(normalizedWorkspaceId, effectiveAuth, {
            operationId: normalizedOperationId,
            ...(explicitCorrelationId !== undefined
              ? { correlationId: explicitCorrelationId }
              : {}),
            ...(explicitCausationId !== undefined
              ? { causationId: explicitCausationId }
              : {}),
          }),
        );
      }

      if (auth.type === 'user') {
        const workspaceMemberId = uuid(auth.workspaceMemberId);
        const userId = auth.user !== undefined ? uuid(auth.user.id) : undefined;
        const appId =
          auth.application !== undefined
            ? uuid(auth.application.id)
            : undefined;
        const viaAppId =
          auth.viaApplication !== undefined
            ? uuid(auth.viaApplication.id)
            : undefined;
        if (appId !== undefined && viaAppId !== undefined && appId !== viaAppId)
          throw new Error('Native audit application context conflict');
        const authAgentId =
          auth.agentId !== undefined ? uuid(auth.agentId) : undefined;
        if (
          authAgentId !== undefined &&
          explicitAgentId !== undefined &&
          authAgentId !== explicitAgentId
        )
          throw new Error('Native audit ambient agent conflict');

        return bindUserOrCoreUser({
          workspaceMemberId,
          userId,
          applicationId: viaAppId ?? appId,
          agentId: explicitAgentId ?? authAgentId,
        });
      }

      throw new Error('Authentication cannot perform audited CRM writes');
    }

    const reqApiKeyId =
      reqLike.apiKey?.id !== undefined ? uuid(reqLike.apiKey.id) : undefined;
    const reqUserId =
      reqLike.user?.id !== undefined ? uuid(reqLike.user.id) : undefined;
    const reqWorkspaceMemberId =
      reqLike.workspaceMemberId !== undefined
        ? uuid(reqLike.workspaceMemberId)
        : undefined;
    const reqAppId =
      reqLike.application?.id !== undefined
        ? uuid(reqLike.application.id)
        : undefined;
    const reqViaAppId =
      reqLike.viaApplication?.id !== undefined
        ? uuid(reqLike.viaApplication.id)
        : undefined;
    if (
      reqAppId !== undefined &&
      reqViaAppId !== undefined &&
      reqAppId !== reqViaAppId
    )
      throw new Error('Native audit application context conflict');
    const resolvedReqAppId = reqViaAppId ?? reqAppId;

    if (reqApiKeyId !== undefined) {
      if (
        reqUserId !== undefined ||
        reqWorkspaceMemberId !== undefined ||
        resolvedReqAppId !== undefined ||
        explicitAgentId !== undefined ||
        explicitImpersonator !== undefined ||
        reqLike.systemActorId !== undefined ||
        normalizedAuthUserWorkspaceId !== undefined
      )
        throw new Error('Ambiguous navigation audit authentication');

      return registerTrustedNavigationBinding(
        captureNativeCrmAuditBinding(
          normalizedWorkspaceId,
          {
            type: 'apiKey',
            workspace: { id: normalizedWorkspaceId },
            apiKey: { id: reqApiKeyId },
          },
          {
            operationId: normalizedOperationId,
            ...(explicitCorrelationId !== undefined
              ? { correlationId: explicitCorrelationId }
              : {}),
            ...(explicitCausationId !== undefined
              ? { causationId: explicitCausationId }
              : {}),
          },
        ),
      );
    }

    if (reqWorkspaceMemberId !== undefined || reqUserId !== undefined) {
      if (reqLike.systemActorId !== undefined)
        throw new Error('Only system authentication can name a system audit actor');

      return bindUserOrCoreUser({
        workspaceMemberId: reqWorkspaceMemberId,
        userId: reqUserId,
        applicationId: resolvedReqAppId,
        agentId: explicitAgentId,
      });
    }

    if (resolvedReqAppId !== undefined) {
      if (
        explicitImpersonator !== undefined ||
        reqLike.systemActorId !== undefined ||
        normalizedAuthUserWorkspaceId !== undefined
      )
        throw new Error('Ambiguous navigation audit authentication');

      return registerTrustedNavigationBinding(
        captureNativeCrmAuditBinding(
          normalizedWorkspaceId,
          {
            type: 'application',
            workspace: { id: normalizedWorkspaceId },
            application: { id: resolvedReqAppId },
            ...(explicitAgentId !== undefined
              ? { actingAgent: { id: explicitAgentId } }
              : {}),
          },
          {
            operationId: normalizedOperationId,
            ...(explicitCorrelationId !== undefined
              ? { correlationId: explicitCorrelationId }
              : {}),
            ...(explicitCausationId !== undefined
              ? { causationId: explicitCausationId }
              : {}),
          },
        ),
      );
    }

    if (
      explicitAgentId !== undefined &&
      normalizedAuthUserWorkspaceId !== undefined &&
      reqLike.systemActorId === undefined
    ) {
      const ambient = getAmbient();
      if (
        explicitImpersonator !== undefined ||
        ambient?.impersonatorUserWorkspaceId !== undefined
      )
        throw new Error(
          'Native audit impersonation cannot combine with agent or application',
        );
      let pendingUserWorkspaceExpectedUserId: string | undefined;
      if (ambient) {
        const ambientActor = ambient.operation.actor;
        const ambientInitiator = ambient.operation.initiator;
        if (ambientActor.kind === 'coreUser') {
          if (ambientInitiator !== undefined)
            throw new Error(
              'Native audit impersonation cannot combine with agent or application',
            );
          pendingUserWorkspaceExpectedUserId = ambientActor.id;
        } else if (
          ambientActor.kind === 'agent' &&
          ambientActor.id === explicitAgentId &&
          ambientInitiator?.kind === 'coreUser'
        ) {
          pendingUserWorkspaceExpectedUserId = ambientInitiator.id;
        } else {
          throw new Error('Native audit ambient principal conflict');
        }
      }
      const correlationId =
        explicitCorrelationId ?? ambient?.operation.correlationId;
      const causationId = explicitCausationId ?? ambient?.operation.causationId;

      return registerTrustedNavigationBinding(
        Object.freeze({
          operation: Object.freeze({
            workspaceId: normalizedWorkspaceId,
            operationId: normalizedOperationId,
            actor: Object.freeze({ kind: 'agent', id: explicitAgentId }),
            ...(correlationId !== undefined ? { correlationId } : {}),
            ...(causationId !== undefined ? { causationId } : {}),
          }),
          pendingAuthUserWorkspaceId: normalizedAuthUserWorkspaceId,
          pendingAgentId: explicitAgentId,
          pendingUserWorkspaceActor: true,
          ...(pendingUserWorkspaceExpectedUserId !== undefined
            ? { pendingUserWorkspaceExpectedUserId }
            : {}),
          ...buildAmbientMeta(ambient?.operation),
        }),
      );
    }

    if (
      reqLike.systemActorId !== undefined &&
      explicitAgentId === undefined &&
      explicitImpersonator === undefined &&
      normalizedAuthUserWorkspaceId === undefined
    ) {
      return registerTrustedNavigationBinding(
        captureNativeCrmAuditBinding(
          normalizedWorkspaceId,
          { type: 'system', workspace: { id: normalizedWorkspaceId } },
          {
            operationId: normalizedOperationId,
            systemActorId: reqLike.systemActorId,
            ...(explicitCorrelationId !== undefined
              ? { correlationId: explicitCorrelationId }
              : {}),
            ...(explicitCausationId !== undefined
              ? { causationId: explicitCausationId }
              : {}),
          },
        ),
      );
    }

    throw new Error('Authentication cannot perform audited CRM writes');
  }

  if (normalizedAuthUserWorkspaceId !== undefined) {
    const ambient = getAmbient();
    let pendingUserWorkspaceExpectedUserId: string | undefined;
    let pendingAgentId: string | undefined;
    let pendingApplicationId: string | undefined;
    let resolvedAmbientInitiator: CrmAuditPrincipal | undefined;
    let impersonatorUserWorkspaceId: string | undefined;

    if (ambient) {
      const ambientActor = ambient.operation.actor;
      const ambientInitiator = ambient.operation.initiator;
      if (ambientActor.kind === 'coreUser') {
        pendingUserWorkspaceExpectedUserId = ambientActor.id;
        resolvedAmbientInitiator = ambientInitiator;
      } else if (
        ambientActor.kind === 'agent' &&
        ambientInitiator?.kind === 'coreUser'
      ) {
        pendingAgentId = ambientActor.id;
        pendingUserWorkspaceExpectedUserId = ambientInitiator.id;
      } else if (
        ambientActor.kind === 'application' &&
        ambientInitiator?.kind === 'coreUser'
      ) {
        pendingApplicationId = ambientActor.id;
        pendingUserWorkspaceExpectedUserId = ambientInitiator.id;
      } else {
        throw new Error('Native audit ambient principal conflict');
      }
      if (ambient.impersonatorUserWorkspaceId !== undefined) {
        if (pendingAgentId !== undefined || pendingApplicationId !== undefined)
          throw new Error(
            'Native audit impersonation cannot combine with agent or application',
          );
        impersonatorUserWorkspaceId = uuid(ambient.impersonatorUserWorkspaceId);
      }
    }

    const correlationId =
      explicitCorrelationId ?? ambient?.operation.correlationId;
    const causationId = explicitCausationId ?? ambient?.operation.causationId;

    if (pendingApplicationId !== undefined) {
      return registerTrustedNavigationBinding(
        Object.freeze({
          operation: Object.freeze({
            workspaceId: normalizedWorkspaceId,
            operationId: normalizedOperationId,
            actor: Object.freeze({
              kind: 'application',
              id: pendingApplicationId,
            }),
            initiator: Object.freeze({
              kind: 'coreUser',
              id: pendingUserWorkspaceExpectedUserId!,
            }),
            ...(correlationId !== undefined ? { correlationId } : {}),
            ...(causationId !== undefined ? { causationId } : {}),
          }),
          pendingAuthUserWorkspaceId: normalizedAuthUserWorkspaceId,
          pendingUserWorkspaceExpectedUserId,
          ...buildAmbientMeta(ambient?.operation),
        }),
      );
    }

    return registerTrustedNavigationBinding(
      Object.freeze({
        operation: Object.freeze({
          workspaceId: normalizedWorkspaceId,
          operationId: normalizedOperationId,
          actor: Object.freeze(
            pendingAgentId !== undefined
              ? { kind: 'agent', id: pendingAgentId }
              : {
                  kind: 'coreUser',
                  id:
                    pendingUserWorkspaceExpectedUserId ??
                    normalizedAuthUserWorkspaceId,
                },
          ),
          ...(resolvedAmbientInitiator !== undefined
            ? { initiator: Object.freeze(resolvedAmbientInitiator) }
            : {}),
          ...(correlationId !== undefined ? { correlationId } : {}),
          ...(causationId !== undefined ? { causationId } : {}),
        }),
        ...(impersonatorUserWorkspaceId !== undefined
          ? { impersonatorUserWorkspaceId }
          : {}),
        pendingAuthUserWorkspaceId: normalizedAuthUserWorkspaceId,
        ...(pendingAgentId !== undefined ? { pendingAgentId } : {}),
        pendingUserWorkspaceActor: true,
        ...(pendingUserWorkspaceExpectedUserId !== undefined
          ? { pendingUserWorkspaceExpectedUserId }
          : {}),
        ...buildAmbientMeta(ambient?.operation),
      }),
    );
  }

  let ambientForFallback:
    | ReturnType<typeof captureCurrentCrmAuditOperation>
    | undefined;
  try {
    ambientForFallback = getAmbient();
  } catch (error) {
    if (
      defaultSystemActorId === undefined ||
      !(error instanceof Error) ||
      error.message !== 'Membership audit authentication is unavailable'
    ) {
      throw error;
    }
  }

  if (ambientForFallback) {
    const correlationId =
      explicitCorrelationId ?? ambientForFallback.operation.correlationId;
    const causationId =
      explicitCausationId ?? ambientForFallback.operation.causationId;

    return registerTrustedNavigationBinding(
      Object.freeze({
        operation: Object.freeze({
          workspaceId: normalizedWorkspaceId,
          operationId: normalizedOperationId,
          actor: Object.freeze({ ...ambientForFallback.operation.actor }),
          ...(ambientForFallback.operation.initiator !== undefined
            ? {
                initiator: Object.freeze({
                  ...ambientForFallback.operation.initiator,
                }),
              }
            : {}),
          ...(correlationId !== undefined ? { correlationId } : {}),
          ...(causationId !== undefined ? { causationId } : {}),
        }),
        ...(ambientForFallback.impersonatorUserWorkspaceId !== undefined
          ? {
              impersonatorUserWorkspaceId: uuid(
                ambientForFallback.impersonatorUserWorkspaceId,
              ),
            }
          : {}),
        ...buildAmbientMeta(ambientForFallback.operation),
      }),
    );
  }

  if (defaultSystemActorId !== undefined) {
    return registerTrustedNavigationBinding(
      captureNativeCrmAuditBinding(
        normalizedWorkspaceId,
        { type: 'system', workspace: { id: normalizedWorkspaceId } },
        {
          operationId: normalizedOperationId,
          systemActorId: defaultSystemActorId,
          ...(explicitCorrelationId !== undefined
            ? { correlationId: explicitCorrelationId }
            : {}),
          ...(explicitCausationId !== undefined
            ? { causationId: explicitCausationId }
            : {}),
        },
      ),
    );
  }

  throw new Error('Authentication cannot perform audited CRM writes');
};

export const assertTrustedNativeCrmAuditBinding = (
  binding: NativeCrmAuditBinding,
  workspaceId: string,
  auth: NativeCrmAuditAuth,
): NativeCrmAuditBinding => {
  if (auth.type !== 'system')
    throw new Error('Trusted native audit binding requires system context');
  if (!trustedNavigationBindings.has(binding))
    throw new Error('Untrusted native audit binding');
  if (consumedNavigationBindings.has(binding))
    throw new Error('Native audit binding was already consumed');
  const normalizedWorkspaceId = uuid(workspaceId);
  if (
    uuid(auth.workspace.id) !== normalizedWorkspaceId ||
    uuid(binding.operation.workspaceId) !== normalizedWorkspaceId
  )
    throw new Error('Native audit workspace mismatch');
  consumedNavigationBindings.add(binding);

  return binding;
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
  const normalizedPendingAuthUserWorkspaceId =
    meta?.pendingAuthUserWorkspaceId !== undefined
      ? uuid(meta.pendingAuthUserWorkspaceId)
      : undefined;
  const normalizedPendingAgentId =
    meta?.pendingAgentId !== undefined ? uuid(meta.pendingAgentId) : undefined;
  const normalizedPendingExpectedUserId =
    meta?.pendingUserWorkspaceExpectedUserId !== undefined
      ? uuid(meta.pendingUserWorkspaceExpectedUserId)
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
    operation.actor.kind !== 'workspaceMember' &&
    operation.actor.kind !== 'coreUser'
  )
    throw new Error('Native audit impersonation requires a user actor');
  operation = {
    ...operation,
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const auditExecutor = createCrmAuditWorkspaceExecutor(scope);
  if (normalizedPendingAuthUserWorkspaceId !== undefined) {
    const rows = await auditExecutor.query(
      'SELECT "userId" FROM core."userWorkspace" WHERE id = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL',
      [normalizedPendingAuthUserWorkspaceId, operation.workspaceId],
    );
    const membershipRow = rows[0] as { userId?: unknown } | undefined;
    if (rows.length !== 1 || typeof membershipRow?.userId !== 'string')
      throw new Error('Native audit authUserWorkspaceId unavailable');
    const resolvedUserId = uuid(membershipRow.userId);
    if (
      normalizedPendingExpectedUserId !== undefined &&
      normalizedPendingExpectedUserId !== resolvedUserId
    )
      throw new Error('Native audit userWorkspace mismatch');
    if (meta?.pendingUserWorkspaceActor) {
      operation =
        normalizedPendingAgentId !== undefined
          ? {
              ...operation,
              actor: { kind: 'agent', id: normalizedPendingAgentId },
              initiator: { kind: 'coreUser', id: resolvedUserId },
            }
          : {
              ...operation,
              actor: { kind: 'coreUser', id: resolvedUserId },
            };
    } else {
      const workspaceMemberPrincipal =
        operation.actor.kind === 'workspaceMember'
          ? operation.actor
          : operation.initiator?.kind === 'workspaceMember'
            ? operation.initiator
            : undefined;
      if (
        (operation.actor.kind === 'coreUser' &&
          uuid(operation.actor.id) !== resolvedUserId) ||
        (operation.initiator?.kind === 'coreUser' &&
          uuid(operation.initiator.id) !== resolvedUserId)
      ) {
        throw new Error('Native audit userWorkspace mismatch');
      }
      if (workspaceMemberPrincipal !== undefined) {
        const workspaceSchema = workspaceSchemaForNormalizedUuid(
          operation.workspaceId,
        );
        const memberRows = await auditExecutor.query(
          `SELECT "userId" FROM "${workspaceSchema}"."workspaceMember" WHERE id = $1 AND "deletedAt" IS NULL`,
          [uuid(workspaceMemberPrincipal.id)],
        );
        const memberRow = memberRows[0] as { userId?: unknown } | undefined;
        if (
          memberRows.length !== 1 ||
          typeof memberRow?.userId !== 'string' ||
          uuid(memberRow.userId) !== resolvedUserId
        ) {
          throw new Error('Native audit userWorkspace mismatch');
        }
      }
    }
  }
  if (normalizedImpersonator !== undefined) {
    if (
      operation.actor.kind !== 'workspaceMember' &&
      operation.actor.kind !== 'coreUser'
    )
      throw new Error('Native audit impersonation requires a user actor');
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
