import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER } from 'src/engine/core-modules/application/constants/workspace-custom-application-role.constant';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { captureNativeCrmAuditOperation } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

const MEMBER_ROLE_UNIVERSAL_IDENTIFIER = '20202020-1337-43f2-b94d-cab1f2b532ec';

export type RoleUpdateAuditIdentity = {
  auth: Parameters<typeof captureNativeCrmAuditOperation>[1];
  agentId?: string;
  impersonatorUserWorkspaceId?: string;
  systemActorId?: string;
};

export type RoleAuditMappings = {
  application: { id: string; universalIdentifier: string };
  roles: Record<string, { id: string } | undefined>;
  targets: Record<string, { id: string } | undefined>;
  agents?: Record<string, { id: string } | undefined>;
  agentChatChannelRoles?: Record<string, { id: string } | undefined>;
};

export const captureRoleAuditIdentity = (
  identity: RoleUpdateAuditIdentity,
): RoleUpdateAuditIdentity => {
  if (!identity?.auth)
    throw new Error('Role mutation requires authenticated audit identity');
  const auth = identity.auth;
  if (
    auth.type === 'system' &&
    (typeof identity.systemActorId !== 'string' ||
      identity.systemActorId.length === 0 ||
      identity.systemActorId.length > 256)
  )
    throw new Error('System role audit requires a valid systemActorId');
  if (auth.type !== 'system' && identity.systemActorId !== undefined)
    throw new Error('Only system authentication can name a systemActorId');
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
    ...(identity.systemActorId !== undefined
      ? { systemActorId: identity.systemActorId }
      : {}),
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
    | {
        action: 'delete';
        actingRoleIds?: readonly string[];
        actingUserWorkspaceId?: string;
      }
  )
>;

const storage = new AsyncLocalStorage<RoleAuditRequest>();
const active = new WeakSet<RoleAuditRequest>();
const consumed = new WeakSet<RoleAuditRequest>();
const metadataScopeChecks = new Set<(workspaceId: string) => unknown>();
export const registerMetadataAuditScopeCheck = (
  check: (workspaceId: string) => unknown,
): void => {
  metadataScopeChecks.add(check);
};
export const hasConflictingMetadataAuditScope = (
  workspaceId: string,
  ignore?: (workspaceId: string) => unknown,
): boolean => {
  for (const check of metadataScopeChecks) {
    if (check !== ignore && Boolean(check(workspaceId))) return true;
  }
  return false;
};
const uuid = (value: string) => {
  if (!isUUID(value)) throw new Error('Role audit identity is invalid');
  return value.toLowerCase();
};

export const projectRoleTargetAuditFields = (
  row: Record<string, unknown>,
): Record<string, unknown> => ({
  roleId: row.roleId,
  ...(row.userWorkspaceId !== null && row.userWorkspaceId !== undefined
    ? { userWorkspaceId: row.userWorkspaceId }
    : {}),
  ...(row.agentId !== null && row.agentId !== undefined
    ? { agentId: row.agentId }
    : {}),
  ...(row.apiKeyId !== null && row.apiKeyId !== undefined
    ? { apiKeyId: row.apiKeyId }
    : {}),
});

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

export const withRoleDeleteAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    actingRoleIds?: readonly string[];
    actingUserWorkspaceId?: string;
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const actingRoleIds = input.actingRoleIds
    ? Object.freeze(input.actingRoleIds.map(uuid))
    : undefined;
  const actingUserWorkspaceId =
    input.actingUserWorkspaceId !== undefined
      ? uuid(input.actingUserWorkspaceId)
      : undefined;
  return withRoleAudit(
    input.workspaceId,
    input.roleId,
    identity,
    {
      action: 'delete',
      ...(actingRoleIds ? { actingRoleIds } : {}),
      ...(actingUserWorkspaceId ? { actingUserWorkspaceId } : {}),
    },
    work,
  );
};

export const withRoleCreateAudit = async <T>(
  flatRole: { id: string; workspaceId: string } & object,
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const capturedIdentity = captureRoleAuditIdentity(identity);
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
  const isSystemWorkspaceCustomApplicationRole =
    capturedIdentity.auth.type === 'system' &&
    expected.universalIdentifier ===
      WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase();
  const hasValidEditability =
    expected.isEditable === true ||
    (isSystemWorkspaceCustomApplicationRole && expected.isEditable === false);
  if (
    !hasValidEditability ||
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
    capturedIdentity,
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
    ...(identity.systemActorId !== undefined
      ? { systemActorId: identity.systemActorId }
      : {}),
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
    | { action: 'create'; expected: Readonly<Record<string, unknown>> }
    | {
        action: 'delete';
        actingRoleIds?: readonly string[];
        actingUserWorkspaceId?: string;
      },
  work: () => Promise<T>,
): Promise<T> => {
  if (
    storage.getStore() ||
    hasConflictingMetadataAuditScope(workspaceId, getRoleMutationAudit)
  )
    throw new Error('Nested role audit is unsupported');
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
registerMetadataAuditScopeCheck(getRoleMutationAudit);

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

const projectRole = (row: Record<string, unknown>) =>
  Object.fromEntries(
    [...BOOLEAN_FIELDS, ...TEXT_FIELDS].map((key) => [key, row[key]]),
  );

const projectAgentChatChannelRoleAuditFields = (
  row: Record<string, unknown>,
) => {
  if (
    typeof row.channelId !== 'string' ||
    !isUUID(row.channelId) ||
    typeof row.roleId !== 'string' ||
    !isUUID(row.roleId)
  )
    throw new Error('Role delete audit invalid agentChatChannelRole row');
  return {
    channelId: uuid(row.channelId),
    roleId: uuid(row.roleId),
  };
};

const runAuditedRoleDelete = async <T>(
  dataSource: DataSource,
  request: Extract<RoleAuditRequest, { action: 'delete' }>,
  actions: RoleUpdateAction[],
  mappings: RoleAuditMappings | undefined,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (!mappings?.application?.id || !mappings?.application?.universalIdentifier)
    throw new Error(
      'Role delete audit requires application and entity mappings',
    );
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const roleDeletes = actions.filter(
    (action) => action.metadataName === 'role' && action.type === 'delete',
  );
  const targetDeletes = actions.filter(
    (action) =>
      action.metadataName === 'roleTarget' && action.type === 'delete',
  );
  const targetCreates = actions.filter(
    (action) =>
      action.metadataName === 'roleTarget' && action.type === 'create',
  );
  const channelRoleDeletes = actions.filter(
    (action) =>
      action.metadataName === 'agentChatChannelRole' &&
      action.type === 'delete',
  );
  if (
    roleDeletes.length !== 1 ||
    actions.length !==
      1 +
        targetDeletes.length +
        targetCreates.length +
        channelRoleDeletes.length
  )
    throw new Error(
      'Role delete audit requires one role delete and bounded roleTarget actions',
    );
  const deletedRoleUniversalIdentifier = uuid(
    roleDeletes[0].universalIdentifier!,
  );
  const mappedDeletedRoleId =
    mappings.roles[deletedRoleUniversalIdentifier]?.id;
  if (!mappedDeletedRoleId || uuid(mappedDeletedRoleId) !== request.roleId)
    throw new Error('Role delete audit resolved a different role');

  const plannedChannelRoleDeletes = channelRoleDeletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.agentChatChannelRoles?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error(
        'Role delete audit missing agentChatChannelRole delete mapping',
      );
    return { id: uuid(mappedId), universalIdentifier };
  });
  if (
    new Set(plannedChannelRoleDeletes.map((item) => item.id)).size !==
      plannedChannelRoleDeletes.length ||
    new Set(plannedChannelRoleDeletes.map((item) => item.universalIdentifier))
      .size !== plannedChannelRoleDeletes.length
  )
    throw new Error(
      'Role delete audit duplicate agentChatChannelRole delete action',
    );

  const plannedTargetDeletes = targetDeletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.targets[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Role delete audit missing target delete mapping');
    return { id: uuid(mappedId), universalIdentifier };
  });
  if (
    new Set(plannedTargetDeletes.map((item) => item.id)).size !==
      plannedTargetDeletes.length ||
    new Set(plannedTargetDeletes.map((item) => item.universalIdentifier))
      .size !== plannedTargetDeletes.length
  )
    throw new Error('Role delete audit duplicate target delete action');

  const plannedTargetCreates = targetCreates.map((action) => {
    const input = action.flatEntity
      ? ({ ...action.flatEntity } as Record<string, unknown>)
      : undefined;
    if (!input || !action.id)
      throw new Error('Role delete audit requires enriched target create');
    const id = uuid(action.id);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    if (
      !mappedRoleId ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier
    )
      throw new Error('Role delete audit invalid replacement target plan');
    const userWorkspaceId =
      input.userWorkspaceId !== null && input.userWorkspaceId !== undefined
        ? uuid(String(input.userWorkspaceId))
        : null;
    const apiKeyId =
      input.apiKeyId !== null && input.apiKeyId !== undefined
        ? uuid(String(input.apiKeyId))
        : null;
    const agentUniversalIdentifier =
      input.agentUniversalIdentifier !== null &&
      input.agentUniversalIdentifier !== undefined
        ? uuid(String(input.agentUniversalIdentifier))
        : null;
    const mappedAgentId = agentUniversalIdentifier
      ? mappings.agents?.[agentUniversalIdentifier]?.id
      : undefined;
    const agentId = agentUniversalIdentifier
      ? uuid(String(mappedAgentId))
      : null;
    if (
      [userWorkspaceId, apiKeyId, agentId].filter((value) => value !== null)
        .length !== 1 ||
      typeof input.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      typeof input.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.updatedAt))
    )
      throw new Error('Role delete audit invalid replacement target fields');
    return {
      id,
      universalIdentifier,
      roleId: uuid(mappedRoleId),
      roleUniversalIdentifier,
      userWorkspaceId,
      apiKeyId,
      agentId,
      agentUniversalIdentifier,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  });
  if (
    new Set(plannedTargetCreates.map((item) => item.id)).size !==
      plannedTargetCreates.length ||
    new Set(plannedTargetCreates.map((item) => item.universalIdentifier))
      .size !== plannedTargetCreates.length
  )
    throw new Error('Role delete audit duplicate target create action');

  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [request.operation.workspaceId],
    );
    if (
      !workspace ||
      workspace.deletedAt !== null ||
      typeof workspace.defaultRoleId !== 'string' ||
      !isUUID(workspace.defaultRoleId)
    )
      throw new Error(
        'Role delete audit workspace or default role unavailable',
      );
    const defaultRoleId = uuid(workspace.defaultRoleId);
    if (defaultRoleId === request.roleId)
      throw new Error('Role delete audit cannot delete workspace default role');
    if (plannedTargetCreates.some((item) => item.roleId !== defaultRoleId))
      throw new Error(
        'Role delete audit replacement target does not point to default role',
      );

    const verifyApplication = () =>
      verifyRoleAuditApplication(
        runner,
        request.operation.workspaceId,
        applicationId,
        applicationUniversalIdentifier,
      );
    await verifyApplication();

    const roleRows = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [request.operation.workspaceId, [request.roleId, defaultRoleId]],
    );
    const beforeRole = roleRows.find(
      (entry: { row: Record<string, unknown> }) =>
        uuid(String(entry.row.id)) === request.roleId,
    )?.row as Record<string, unknown> | undefined;
    const defaultRole = roleRows.find(
      (entry: { row: Record<string, unknown> }) =>
        uuid(String(entry.row.id)) === defaultRoleId,
    )?.row as Record<string, unknown> | undefined;
    if (
      !beforeRole ||
      !defaultRole ||
      uuid(String(beforeRole.universalIdentifier)) !==
        deletedRoleUniversalIdentifier ||
      beforeRole.isEditable !== true ||
      uuid(String(beforeRole.universalIdentifier)) ===
        STANDARD_ROLE.admin.universalIdentifier ||
      uuid(String(beforeRole.universalIdentifier)) ===
        MEMBER_ROLE_UNIVERSAL_IDENTIFIER
    )
      throw new Error('Role delete audit persisted role unavailable or locked');

    if (request.actingRoleIds?.includes(request.roleId))
      throw new Error('Role delete audit cannot delete caller role');
    if (request.actingUserWorkspaceId) {
      const callerTargets = await runner.query(
        'SELECT id FROM core."roleTarget" WHERE "workspaceId"=$1 AND "userWorkspaceId"=$2 AND "roleId"=$3 FOR SHARE',
        [
          request.operation.workspaceId,
          request.actingUserWorkspaceId,
          request.roleId,
        ],
      );
      if (callerTargets.length > 0)
        throw new Error('Role delete audit cannot delete caller role');
    }

    const beforeTargetRows = await runner.query(
      'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE',
      [
        request.operation.workspaceId,
        request.roleId,
        plannedTargetDeletes.map((item) => item.id),
      ],
    );
    const beforeTargets: Record<string, unknown>[] = beforeTargetRows.map(
      (entry: { row: Record<string, unknown> }) => entry.row,
    );
    if (beforeTargets.length !== plannedTargetDeletes.length)
      throw new Error('Role delete audit persisted roleTarget set changed');
    for (const beforeTarget of beforeTargets) {
      const planned = plannedTargetDeletes.find(
        (item) => item.id === uuid(String(beforeTarget.id)),
      );
      if (
        !planned ||
        uuid(String(beforeTarget.roleId)) !== request.roleId ||
        uuid(String(beforeTarget.universalIdentifier)) !==
          planned.universalIdentifier
      )
        throw new Error('Role delete audit persisted roleTarget mismatch');
    }

    const [channelRoleReg] = await runner.query(
      'SELECT to_regclass(\'core."agentChatChannelRole"\') IS NOT NULL AS "hasChannelRoleTable"',
    );
    const hasChannelRoleTable = channelRoleReg?.hasChannelRoleTable === true;
    if (!hasChannelRoleTable && plannedChannelRoleDeletes.length > 0)
      throw new Error(
        'Role delete audit table core.agentChatChannelRole unavailable',
      );
    const beforeChannelRoles: Record<string, unknown>[] = hasChannelRoleTable
      ? (
          await runner.query(
            'SELECT to_jsonb(cr) AS row FROM core."agentChatChannelRole" cr WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE',
            [
              request.operation.workspaceId,
              request.roleId,
              plannedChannelRoleDeletes.map((item) => item.id),
            ],
          )
        ).map((entry: { row: Record<string, unknown> }) => entry.row)
      : [];
    if (beforeChannelRoles.length !== plannedChannelRoleDeletes.length)
      throw new Error(
        'Role delete audit persisted agentChatChannelRole set changed',
      );
    for (const beforeChannelRole of beforeChannelRoles) {
      const planned = plannedChannelRoleDeletes.find(
        (item) => item.id === uuid(String(beforeChannelRole.id)),
      );
      if (
        !planned ||
        uuid(String(beforeChannelRole.roleId)) !== request.roleId ||
        uuid(String(beforeChannelRole.workspaceId)) !==
          request.operation.workspaceId ||
        uuid(String(beforeChannelRole.universalIdentifier)) !==
          planned.universalIdentifier
      )
        throw new Error(
          'Role delete audit persisted agentChatChannelRole mismatch',
        );
      projectAgentChatChannelRoleAuditFields(beforeChannelRole);
    }

    const userWorkspaceIds = [
      ...new Set(
        beforeTargets.flatMap((row) =>
          typeof row.userWorkspaceId === 'string' && isUUID(row.userWorkspaceId)
            ? [uuid(row.userWorkspaceId)]
            : [],
        ),
      ),
    ].sort();
    const apiKeyIds = [
      ...new Set(
        beforeTargets.flatMap((row) =>
          typeof row.apiKeyId === 'string' && isUUID(row.apiKeyId)
            ? [uuid(row.apiKeyId)]
            : [],
        ),
      ),
    ].sort();
    const agentIds = [
      ...new Set(
        beforeTargets.flatMap((row) =>
          typeof row.agentId === 'string' && isUUID(row.agentId)
            ? [uuid(row.agentId)]
            : [],
        ),
      ),
    ].sort();

    const readUserWorkspaces = async (lock = false) =>
      userWorkspaceIds.length === 0
        ? []
        : runner.query(
            `SELECT id,to_jsonb(u)->>'workspaceId' AS "workspaceId",to_jsonb(u)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" u WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [userWorkspaceIds],
          );
    const readApiKeys = async (lock = false) =>
      apiKeyIds.length === 0
        ? []
        : runner.query(
            `SELECT id,"workspaceId","revokedAt"::text AS "revokedAt" FROM core."apiKey" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, apiKeyIds],
          );
    const readAgents = async (lock = false) =>
      agentIds.length === 0
        ? []
        : runner.query(
            `SELECT id,"workspaceId","universalIdentifier","deletedAt"::text AS "deletedAt" FROM core.agent WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, agentIds],
          );

    const lockedUserWorkspaces = await readUserWorkspaces(true);
    const lockedApiKeys = await readApiKeys(true);
    const lockedAgents = await readAgents(true);
    if (
      lockedUserWorkspaces.length !== userWorkspaceIds.length ||
      lockedUserWorkspaces.some(
        (row: Record<string, unknown>) =>
          row.workspaceId !== null &&
          uuid(String(row.workspaceId)) !== request.operation.workspaceId,
      ) ||
      lockedApiKeys.length !== apiKeyIds.length ||
      lockedAgents.length !== agentIds.length
    )
      throw new Error('Role delete audit target owners changed or unavailable');

    const expectedRebinds: {
      userWorkspaceId: string | null;
      apiKeyId: string | null;
      agentId: string | null;
      agentUniversalIdentifier: string | null;
    }[] = [];
    for (const beforeTarget of beforeTargets) {
      const userWorkspaceId =
        typeof beforeTarget.userWorkspaceId === 'string'
          ? uuid(beforeTarget.userWorkspaceId)
          : null;
      const apiKeyId =
        typeof beforeTarget.apiKeyId === 'string'
          ? uuid(beforeTarget.apiKeyId)
          : null;
      const agentId =
        typeof beforeTarget.agentId === 'string'
          ? uuid(beforeTarget.agentId)
          : null;
      if (
        [userWorkspaceId, apiKeyId, agentId].filter((value) => value !== null)
          .length !== 1
      )
        throw new Error('Role delete audit invalid existing roleTarget shape');
      if (userWorkspaceId !== null) {
        if (defaultRole.canBeAssignedToUsers !== true)
          throw new Error(
            'Role delete audit default role cannot be assigned to users',
          );
        expectedRebinds.push({
          userWorkspaceId,
          apiKeyId: null,
          agentId: null,
          agentUniversalIdentifier: null,
        });
      } else if (apiKeyId !== null) {
        const apiKey = lockedApiKeys.find(
          (row: Record<string, unknown>) => uuid(String(row.id)) === apiKeyId,
        );
        if (apiKey?.revokedAt === null) {
          if (defaultRole.canBeAssignedToApiKeys !== true)
            throw new Error(
              'Role delete audit default role cannot be assigned to API keys',
            );
          expectedRebinds.push({
            userWorkspaceId: null,
            apiKeyId,
            agentId: null,
            agentUniversalIdentifier: null,
          });
        }
      } else if (agentId !== null) {
        const agent = lockedAgents.find(
          (row: Record<string, unknown>) => uuid(String(row.id)) === agentId,
        );
        if (agent?.deletedAt === null) {
          if (defaultRole.canBeAssignedToAgents !== true)
            throw new Error(
              'Role delete audit default role cannot be assigned to agents',
            );
          expectedRebinds.push({
            userWorkspaceId: null,
            apiKeyId: null,
            agentId,
            agentUniversalIdentifier: uuid(String(agent.universalIdentifier)),
          });
        }
      }
    }

    if (expectedRebinds.length !== plannedTargetCreates.length)
      throw new Error('Role delete audit replacement count mismatch');
    for (const expectedRebind of expectedRebinds) {
      const match = plannedTargetCreates.find(
        (item) =>
          item.userWorkspaceId === expectedRebind.userWorkspaceId &&
          item.apiKeyId === expectedRebind.apiKeyId &&
          item.agentId === expectedRebind.agentId &&
          item.agentUniversalIdentifier ===
            expectedRebind.agentUniversalIdentifier &&
          item.roleUniversalIdentifier ===
            uuid(String(defaultRole.universalIdentifier)),
      );
      if (!match)
        throw new Error('Role delete audit replacement target mismatch');
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);

    if (
      (
        await runner.query('SELECT id FROM core.role WHERE id=$1', [
          request.roleId,
        ])
      ).length > 0
    )
      throw new Error('Role delete audit role still exists after delete');
    if (
      (
        await runner.query(
          'SELECT id FROM core."roleTarget" WHERE "roleId"=$1 OR id=ANY($2::uuid[])',
          [request.roleId, plannedTargetDeletes.map((item) => item.id)],
        )
      ).length > 0
    )
      throw new Error('Role delete audit old roleTarget still exists');
    if (
      hasChannelRoleTable &&
      (
        await runner.query(
          'SELECT id FROM core."agentChatChannelRole" WHERE "roleId"=$1 OR id=ANY($2::uuid[])',
          [request.roleId, plannedChannelRoleDeletes.map((item) => item.id)],
        )
      ).length > 0
    )
      throw new Error(
        'Role delete audit old agentChatChannelRole still exists',
      );

    const readCreatedTargets = async () =>
      plannedTargetCreates.length === 0
        ? []
        : runner.query(
            'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
            [
              request.operation.workspaceId,
              plannedTargetCreates.map((item) => item.id),
            ],
          );
    const createdRows = await readCreatedTargets();
    if (createdRows.length !== plannedTargetCreates.length)
      throw new Error('Role delete audit created roleTargets missing');
    const scalar = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => key !== 'createdAt' && key !== 'updatedAt',
        ),
      );
    for (const plannedCreate of plannedTargetCreates) {
      const actual = createdRows.find(
        (entry: { row: Record<string, unknown> }) =>
          uuid(String(entry.row.id)) === plannedCreate.id,
      )?.row as Record<string, unknown> | undefined;
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: defaultRoleId,
        userWorkspaceId: plannedCreate.userWorkspaceId,
        agentId: plannedCreate.agentId,
        apiKeyId: plannedCreate.apiKeyId,
      };
      if (
        !actual ||
        canonicalAuditJson(scalar(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error('Role delete audit created roleTarget mismatch');
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error(
          'Role delete audit created roleTarget timestamps changed',
        );
    }

    for (const beforeChannelRole of beforeChannelRoles) {
      const channelRoleId = uuid(String(beforeChannelRole.id));
      audit.record({
        resourceKind: 'agentChatChannelRole',
        resourceId: channelRoleId,
        action: 'delete',
        before: projectAgentChatChannelRoleAuditFields(beforeChannelRole),
        after: null,
        securityDescriptor: {
          resourceKind: 'agentChatChannelRole',
          resourceId: channelRoleId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const beforeTarget of beforeTargets) {
      const targetId = uuid(String(beforeTarget.id));
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: targetId,
        action: 'delete',
        before: projectRoleTargetAuditFields(beforeTarget),
        after: null,
        securityDescriptor: {
          resourceKind: 'roleTarget',
          resourceId: targetId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const entry of createdRows) {
      const row = entry.row as Record<string, unknown>;
      const targetId = uuid(String(row.id));
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: targetId,
        action: 'create',
        before: null,
        after: projectRoleTargetAuditFields(row),
        securityDescriptor: {
          resourceKind: 'roleTarget',
          resourceId: targetId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    audit.record({
      resourceKind: 'role',
      resourceId: request.roleId,
      action: 'delete',
      before: projectRole(beforeRole),
      after: null,
      securityDescriptor: {
        resourceKind: 'role',
        resourceId: request.roleId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await audit.flush();

    if (
      (
        await runner.query('SELECT id FROM core.role WHERE id=$1', [
          request.roleId,
        ])
      ).length > 0 ||
      (
        await runner.query(
          'SELECT id FROM core."roleTarget" WHERE "roleId"=$1 OR id=ANY($2::uuid[])',
          [request.roleId, plannedTargetDeletes.map((item) => item.id)],
        )
      ).length > 0 ||
      (hasChannelRoleTable &&
        (
          await runner.query(
            'SELECT id FROM core."agentChatChannelRole" WHERE "roleId"=$1 OR id=ANY($2::uuid[])',
            [request.roleId, plannedChannelRoleDeletes.map((item) => item.id)],
          )
        ).length > 0)
    )
      throw new Error('Role delete audit deleted record reappeared');
    const [currentDefaultRole] = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
      [request.operation.workspaceId, defaultRoleId],
    );
    if (
      !currentDefaultRole ||
      canonicalAuditJson(currentDefaultRole.row) !==
        canonicalAuditJson(defaultRole) ||
      canonicalAuditJson(await readCreatedTargets()) !==
        canonicalAuditJson(createdRows) ||
      canonicalAuditJson(await readUserWorkspaces(false)) !==
        canonicalAuditJson(lockedUserWorkspaces) ||
      canonicalAuditJson(await readApiKeys(false)) !==
        canonicalAuditJson(lockedApiKeys) ||
      canonicalAuditJson(await readAgents(false)) !==
        canonicalAuditJson(lockedAgents)
    )
      throw new Error('Role delete audit persisted state changed during flush');
    await verifyApplication();
    return result;
  });
};

export const runAuditedRoleMutation = async <T>(
  dataSource: DataSource,
  request: RoleAuditRequest,
  actions: RoleUpdateAction[],
  work: (runner: QueryRunner) => Promise<T>,
  mappings?: RoleAuditMappings,
): Promise<T> => {
  if (
    getRoleMutationAudit(request.operation.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error(
      'Role audit operation is not active or was already consumed',
    );
  if (request.action === 'delete') {
    return runAuditedRoleDelete(dataSource, request, actions, mappings, work);
  }
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
    audit.record({
      resourceKind: 'role',
      resourceId: request.roleId,
      action: request.action,
      before: before ? projectRole(before) : null,
      after: projectRole(after),
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

export const runAuditedUnusedAgentRoleDelete = async (
  dataSource: DataSource | undefined,
  input: {
    workspaceId: string;
    roleId: string;
    roleTargetId: string;
  },
  identity: RoleUpdateAuditIdentity,
  onChannelRolesDeleted?: () => void,
): Promise<boolean> => {
  const normalizedWorkspaceId = uuid(input.workspaceId);
  const normalizedRoleId = uuid(input.roleId);
  const normalizedRoleTargetId = uuid(input.roleTargetId);
  if (
    getRoleMutationAudit(normalizedWorkspaceId) ||
    hasConflictingMetadataAuditScope(
      normalizedWorkspaceId,
      getRoleMutationAudit,
    )
  )
    throw new Error('Nested role audit is unsupported');
  const capturedIdentity = captureRoleAuditIdentity(identity);
  const requestOperation = captureRoleAuditOperation(
    normalizedWorkspaceId,
    capturedIdentity,
  );
  const impersonatorUserWorkspaceId =
    capturedIdentity.impersonatorUserWorkspaceId
      ? uuid(capturedIdentity.impersonatorUserWorkspaceId)
      : undefined;
  if (!dataSource)
    throw new Error('Unused agent role delete audit requires core DataSource');

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [normalizedWorkspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Role delete audit workspace unavailable');
    if (
      typeof workspace.defaultRoleId === 'string' &&
      isUUID(workspace.defaultRoleId) &&
      uuid(workspace.defaultRoleId) === normalizedRoleId
    )
      return false;

    const roleRows = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',
      [normalizedRoleId, normalizedWorkspaceId],
    );
    if (roleRows.length !== 1) return false;
    const beforeRole = roleRows[0].row as Record<string, unknown>;
    const roleUniversalIdentifier =
      typeof beforeRole.universalIdentifier === 'string' &&
      isUUID(beforeRole.universalIdentifier)
        ? uuid(beforeRole.universalIdentifier)
        : '';
    if (
      beforeRole.isEditable !== true ||
      !roleUniversalIdentifier ||
      roleUniversalIdentifier === MEMBER_ROLE_UNIVERSAL_IDENTIFIER ||
      roleUniversalIdentifier === STANDARD_ROLE.admin.universalIdentifier ||
      roleUniversalIdentifier ===
        WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase() ||
      beforeRole.canBeAssignedToAgents !== true ||
      beforeRole.canBeAssignedToUsers !== false ||
      beforeRole.canBeAssignedToApiKeys !== false
    )
      return false;

    const targetRows = await runner.query(
      'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "roleId"=$2 ORDER BY id FOR UPDATE',
      [normalizedWorkspaceId, normalizedRoleId],
    );
    const beforeTargets: Record<string, unknown>[] = targetRows.map(
      (entry: { row: Record<string, unknown> }) => entry.row,
    );
    if (
      beforeTargets.some(
        (row) => uuid(String(row.id)) !== normalizedRoleTargetId,
      )
    )
      return false;
    const residualTarget = beforeTargets[0];
    if (
      residualTarget &&
      (typeof residualTarget.agentId !== 'string' ||
        !isUUID(residualTarget.agentId) ||
        residualTarget.userWorkspaceId !== null ||
        residualTarget.apiKeyId !== null)
    )
      throw new Error(
        'Unused agent role delete target is not an agent binding',
      );

    const [channelRoleReg] = await runner.query(
      'SELECT to_regclass(\'core."agentChatChannelRole"\') IS NOT NULL AS "hasChannelRoleTable"',
    );
    const hasChannelRoleTable = channelRoleReg?.hasChannelRoleTable === true;
    const beforeChannelRoles: Record<string, unknown>[] = hasChannelRoleTable
      ? (
          await runner.query(
            'SELECT to_jsonb(cr) AS row FROM core."agentChatChannelRole" cr WHERE "workspaceId"=$1 AND "roleId"=$2 ORDER BY id FOR UPDATE',
            [normalizedWorkspaceId, normalizedRoleId],
          )
        ).map((entry: { row: Record<string, unknown> }) => entry.row)
      : [];
    for (const beforeChannelRole of beforeChannelRoles) {
      if (uuid(String(beforeChannelRole.workspaceId)) !== normalizedWorkspaceId)
        throw new Error(
          'Unused agent role delete agentChatChannelRole workspace mismatch',
        );
      projectAgentChatChannelRoleAuditFields(beforeChannelRole);
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      requestOperation,
      impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);

    if (beforeChannelRoles.length > 0) {
      onChannelRolesDeleted?.();
      await runner.query(
        'DELETE FROM core."agentChatChannelRole" WHERE "workspaceId"=$1 AND "roleId"=$2',
        [normalizedWorkspaceId, normalizedRoleId],
      );
      for (const beforeChannelRole of beforeChannelRoles) {
        const channelRoleId = uuid(String(beforeChannelRole.id));
        audit.record({
          resourceKind: 'agentChatChannelRole',
          resourceId: channelRoleId,
          action: 'delete',
          before: projectAgentChatChannelRoleAuditFields(beforeChannelRole),
          after: null,
          securityDescriptor: {
            resourceKind: 'agentChatChannelRole',
            resourceId: channelRoleId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
    }

    if (residualTarget) {
      await runner.query(
        'DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2 AND "roleId"=$3',
        [normalizedRoleTargetId, normalizedWorkspaceId, normalizedRoleId],
      );
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: normalizedRoleTargetId,
        action: 'delete',
        before: projectRoleTargetAuditFields(residualTarget),
        after: null,
        securityDescriptor: {
          resourceKind: 'roleTarget',
          resourceId: normalizedRoleTargetId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }

    await runner.query(
      'DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2',
      [normalizedRoleId, normalizedWorkspaceId],
    );

    if (
      (
        await runner.query('SELECT id FROM core.role WHERE id=$1', [
          normalizedRoleId,
        ])
      ).length > 0 ||
      (
        await runner.query(
          'SELECT id FROM core."roleTarget" WHERE "roleId"=$1 OR id=$2',
          [normalizedRoleId, normalizedRoleTargetId],
        )
      ).length > 0 ||
      (hasChannelRoleTable &&
        (
          await runner.query(
            'SELECT id FROM core."agentChatChannelRole" WHERE "roleId"=$1',
            [normalizedRoleId],
          )
        ).length > 0)
    )
      throw new Error('Role delete audit role or roleTarget still exists');

    audit.record({
      resourceKind: 'role',
      resourceId: normalizedRoleId,
      action: 'delete',
      before: projectRole(beforeRole),
      after: null,
      securityDescriptor: {
        resourceKind: 'role',
        resourceId: normalizedRoleId,
        metadataAccess: 'currentWorkspaceAdministration',
      },
    });
    await audit.flush();

    if (
      (
        await runner.query('SELECT id FROM core.role WHERE id=$1', [
          normalizedRoleId,
        ])
      ).length > 0 ||
      (
        await runner.query(
          'SELECT id FROM core."roleTarget" WHERE "roleId"=$1 OR id=$2',
          [normalizedRoleId, normalizedRoleTargetId],
        )
      ).length > 0 ||
      (hasChannelRoleTable &&
        (
          await runner.query(
            'SELECT id FROM core."agentChatChannelRole" WHERE "roleId"=$1',
            [normalizedRoleId],
          )
        ).length > 0)
    )
      throw new Error('Role delete audit deleted record reappeared');

    return true;
  });
};
