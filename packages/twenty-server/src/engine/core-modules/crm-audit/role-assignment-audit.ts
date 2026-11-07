import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
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
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

type UserAssignment = Readonly<{
  targetKind?: 'userWorkspace';
  mode?: 'assign';
  workspaceId: string;
  workspaceMemberId: string;
  userId: string;
  userWorkspaceId: string;
  roleId: string;
  actingUserWorkspaceId?: string;
}>;

export type BulkUserAssignmentTarget = Readonly<{
  userWorkspaceId: string;
  userId: string;
  workspaceMemberId?: string | null;
}>;

type BulkUserAssignment = Readonly<{
  targetKind: 'userWorkspaceBulk';
  mode?: 'assign';
  workspaceId: string;
  targets: readonly BulkUserAssignmentTarget[];
  roleId: string;
  actingUserWorkspaceId?: string;
  requireWorkspaceMember: boolean;
}>;

type AgentAssignment = Readonly<{
  targetKind: 'agent';
  mode: 'assign';
  workspaceId: string;
  agentId: string;
  roleId: string;
}>;

type AgentRemoval = Readonly<{
  targetKind: 'agent';
  mode: 'remove';
  workspaceId: string;
  agentId: string;
  roleTargetId: string;
}>;

type ApiKeyAssignment = Readonly<{
  targetKind: 'apiKey';
  mode: 'assign';
  workspaceId: string;
  apiKeyId: string;
  roleId: string;
}>;

export type AgentMetadataDeleteTarget = Readonly<{
  agentId: string;
  roleTargetId: string;
}>;

type AgentMetadataCreateAssignment = Readonly<{
  targetKind: 'agentMetadata';
  mode?: 'assign' | 'remove';
  agentMode: 'create';
  workspaceId: string;
  agentId: string;
  agentUniversalIdentifier: string;
  roleId: string;
}>;

type AgentMetadataUpdateAssignment = Readonly<{
  targetKind: 'agentMetadata';
  mode?: 'assign' | 'remove';
  agentMode: 'update';
  workspaceId: string;
  agentId: string;
  agentUniversalIdentifier: string;
  roleId: string | null;
  expectedDeletedRoleTargetId: string | null;
}>;

type AgentMetadataDeleteAssignment = Readonly<{
  targetKind: 'agentMetadata';
  mode?: 'assign' | 'remove';
  agentMode: 'delete';
  workspaceId: string;
  targets: readonly AgentMetadataDeleteTarget[];
}>;

type AgentMetadataAssignment =
  | AgentMetadataCreateAssignment
  | AgentMetadataUpdateAssignment
  | AgentMetadataDeleteAssignment;

type Assignment =
  | UserAssignment
  | BulkUserAssignment
  | AgentAssignment
  | AgentRemoval
  | ApiKeyAssignment
  | AgentMetadataAssignment;

type Request = Readonly<
  Assignment & {
    targetKind:
      | 'userWorkspace'
      | 'userWorkspaceBulk'
      | 'agent'
      | 'apiKey'
      | 'agentMetadata';
    mode: 'assign' | 'remove';
    operation: CrmAuditOperation;
    impersonatorUserWorkspaceId?: string;
  }
>;
type Action = {
  type: string;
  metadataName: string;
  id?: string;
  universalIdentifier?: string;
  flatEntity?: object;
};
type Mapping = Record<string, { id: string } | undefined>;
const storage = new AsyncLocalStorage<Request>();
const active = new WeakSet<Request>();
const consumed = new WeakSet<Request>();
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Role assignment audit identity invalid');
  return value.toLowerCase();
};

export const withRoleAssignmentAudit = async <T>(
  assignment: Assignment,
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  if (
    storage.getStore() ||
    getRoleMutationAudit(assignment.workspaceId) ||
    hasConflictingMetadataAuditScope(
      assignment.workspaceId,
      getRoleAssignmentAudit,
    )
  )
    throw new Error('Nested role assignment audit unsupported');
  const targetKind = assignment.targetKind ?? 'userWorkspace';
  const mode = assignment.mode ?? 'assign';
  const workspaceId = uuid(assignment.workspaceId);
  const capturedIdentity = captureRoleAuditIdentity(identity);

  if (targetKind === 'userWorkspaceBulk') {
    const bulk = assignment as BulkUserAssignment;
    const requireWorkspaceMember = bulk.requireWorkspaceMember !== false;
    if (!requireWorkspaceMember && capturedIdentity.auth.type !== 'system')
      throw new Error(
        'Only system authentication can assign roles without workspaceMember verification',
      );
    if (!Array.isArray(bulk.targets) || bulk.targets.length === 0)
      throw new Error(
        'Bulk role assignment audit requires at least one target',
      );
    const seenUserWorkspaceIds = new Set<string>();
    const seenWorkspaceMemberIds = new Set<string>();
    const normalizedTargets = Object.freeze(
      bulk.targets.map((target) => {
        if (!target || typeof target !== 'object')
          throw new Error('Bulk role assignment target invalid');
        const userWorkspaceId = uuid(target.userWorkspaceId);
        const userId = uuid(target.userId);
        if (seenUserWorkspaceIds.has(userWorkspaceId))
          throw new Error('Bulk role assignment duplicate userWorkspaceId');
        seenUserWorkspaceIds.add(userWorkspaceId);
        let workspaceMemberId: string | null = null;
        if (
          target.workspaceMemberId !== undefined &&
          target.workspaceMemberId !== null
        ) {
          workspaceMemberId = uuid(target.workspaceMemberId);
          if (seenWorkspaceMemberIds.has(workspaceMemberId))
            throw new Error('Bulk role assignment duplicate workspaceMemberId');
          seenWorkspaceMemberIds.add(workspaceMemberId);
        } else if (requireWorkspaceMember) {
          throw new Error(
            'Bulk role assignment requires workspaceMemberId for every target',
          );
        }
        return Object.freeze({
          userWorkspaceId,
          userId,
          workspaceMemberId,
        });
      }),
    );
    const request = Object.freeze({
      targetKind: 'userWorkspaceBulk' as const,
      mode: 'assign' as const,
      workspaceId,
      roleId: uuid(bulk.roleId),
      targets: normalizedTargets,
      requireWorkspaceMember,
      ...(bulk.actingUserWorkspaceId !== undefined
        ? { actingUserWorkspaceId: uuid(bulk.actingUserWorkspaceId) }
        : {}),
      operation: captureRoleAuditOperation(workspaceId, capturedIdentity),
      ...(capturedIdentity.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              capturedIdentity.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    }) as Request;
    active.add(request);
    try {
      return await storage.run(request, work);
    } finally {
      active.delete(request);
    }
  }

  if (targetKind === 'agentMetadata') {
    const agentMeta = assignment as AgentMetadataAssignment;
    const operation = captureRoleAuditOperation(workspaceId, capturedIdentity);
    const impersonatorField = capturedIdentity.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            capturedIdentity.impersonatorUserWorkspaceId,
          ),
        }
      : {};
    let request: Request;
    if (agentMeta.agentMode === 'create') {
      request = Object.freeze({
        targetKind: 'agentMetadata' as const,
        mode: 'assign' as const,
        agentMode: 'create' as const,
        workspaceId,
        agentId: uuid(agentMeta.agentId),
        agentUniversalIdentifier: uuid(agentMeta.agentUniversalIdentifier),
        roleId: uuid(agentMeta.roleId),
        operation,
        ...impersonatorField,
      }) as Request;
    } else if (agentMeta.agentMode === 'update') {
      const roleId = agentMeta.roleId !== null ? uuid(agentMeta.roleId) : null;
      const expectedDeletedRoleTargetId =
        agentMeta.expectedDeletedRoleTargetId !== null
          ? uuid(agentMeta.expectedDeletedRoleTargetId)
          : null;
      if (roleId === null && expectedDeletedRoleTargetId === null)
        throw new Error(
          'Agent metadata role update audit requires at least one roleTarget change',
        );
      request = Object.freeze({
        targetKind: 'agentMetadata' as const,
        mode: (roleId !== null ? 'assign' : 'remove') as 'assign' | 'remove',
        agentMode: 'update' as const,
        workspaceId,
        agentId: uuid(agentMeta.agentId),
        agentUniversalIdentifier: uuid(agentMeta.agentUniversalIdentifier),
        roleId,
        expectedDeletedRoleTargetId,
        operation,
        ...impersonatorField,
      }) as Request;
    } else if (agentMeta.agentMode === 'delete') {
      // Empty targets still lock and verify the agents' roleTargets, because
      // deleting an agent cascades any binding the plan did not see.
      if (!Array.isArray(agentMeta.targets))
        throw new Error('Agent metadata role delete audit targets invalid');
      const seenAgentIds = new Set<string>();
      const seenRoleTargetIds = new Set<string>();
      const normalizedTargets = Object.freeze(
        agentMeta.targets.map((target) => {
          if (!target || typeof target !== 'object')
            throw new Error('Agent metadata role delete target invalid');
          const agentId = uuid(target.agentId);
          const roleTargetId = uuid(target.roleTargetId);
          if (seenAgentIds.has(agentId) || seenRoleTargetIds.has(roleTargetId))
            throw new Error(
              'Agent metadata role delete duplicate agentId or roleTargetId',
            );
          seenAgentIds.add(agentId);
          seenRoleTargetIds.add(roleTargetId);
          return Object.freeze({ agentId, roleTargetId });
        }),
      );
      request = Object.freeze({
        targetKind: 'agentMetadata' as const,
        mode: 'remove' as const,
        agentMode: 'delete' as const,
        workspaceId,
        targets: normalizedTargets,
        operation,
        ...impersonatorField,
      }) as Request;
    } else {
      throw new Error('Agent metadata role assignment mode invalid');
    }
    active.add(request);
    try {
      return await storage.run(request, work);
    } finally {
      active.delete(request);
    }
  }

  const capturedUuidFields = Object.fromEntries(
    Object.entries(assignment)
      .filter(
        ([key, value]) =>
          value !== undefined && key !== 'targetKind' && key !== 'mode',
      )
      .map(([key, value]) => [key, uuid(value)]),
  );
  const request = Object.freeze({
    ...capturedUuidFields,
    targetKind,
    mode,
    workspaceId,
    operation: captureRoleAuditOperation(workspaceId, capturedIdentity),
    ...(capturedIdentity.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            capturedIdentity.impersonatorUserWorkspaceId,
          ),
        }
      : {}),
  }) as Request;
  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

export const withBulkUserRoleAssignmentAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    targets: readonly BulkUserAssignmentTarget[];
    actingUserWorkspaceId?: string;
    requireWorkspaceMember?: boolean;
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> =>
  withRoleAssignmentAudit(
    {
      ...input,
      targetKind: 'userWorkspaceBulk',
      mode: 'assign',
      requireWorkspaceMember: input.requireWorkspaceMember !== false,
    },
    identity,
    work,
  );

export const withAgentRoleAssignmentAudit = async <T>(
  input: { workspaceId: string; agentId: string; roleId: string },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> =>
  withRoleAssignmentAudit(
    { ...input, targetKind: 'agent', mode: 'assign' },
    identity,
    work,
  );

export const withAgentRoleRemovalAudit = async <T>(
  input: { workspaceId: string; agentId: string; roleTargetId: string },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> =>
  withRoleAssignmentAudit(
    { ...input, targetKind: 'agent', mode: 'remove' },
    identity,
    work,
  );

export const withApiKeyRoleAssignmentAudit = async <T>(
  input: { workspaceId: string; apiKeyId: string; roleId: string },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> =>
  withRoleAssignmentAudit(
    { ...input, targetKind: 'apiKey', mode: 'assign' },
    identity,
    work,
  );

export const withAgentMetadataRoleTargetAudit = async <T>(
  input:
    | {
        agentMode: 'create';
        workspaceId: string;
        agentId: string;
        agentUniversalIdentifier: string;
        roleId: string;
      }
    | {
        agentMode: 'update';
        workspaceId: string;
        agentId: string;
        agentUniversalIdentifier: string;
        roleId: string | null;
        expectedDeletedRoleTargetId: string | null;
      }
    | {
        agentMode: 'delete';
        workspaceId: string;
        targets: readonly AgentMetadataDeleteTarget[];
      },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> =>
  withRoleAssignmentAudit(
    { ...input, targetKind: 'agentMetadata' },
    identity,
    work,
  );

export const getRoleAssignmentAudit = (
  workspaceId: string,
): Request | undefined => {
  const request = storage.getStore();
  if (
    request &&
    (!active.has(request) || request.workspaceId !== uuid(workspaceId))
  )
    throw new Error('Role assignment audit scope inactive or foreign');
  return request;
};
registerMetadataAuditScopeCheck(getRoleAssignmentAudit);

export const runAuditedRoleAssignment = async <T>(
  dataSource: DataSource,
  request: Request,
  actions: Action[],
  mappings: {
    application: { id: string; universalIdentifier: string };
    roles: Mapping;
    targets: Mapping;
    agents?: Mapping;
  },
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (
    getRoleAssignmentAudit(request.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error('Role assignment audit is inactive or consumed');
  const creates = actions.filter((action) => action.type === 'create');
  const deletes = actions.filter((action) => action.type === 'delete');
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );

  if (request.targetKind === 'agentMetadata') {
    const agentActions = actions.filter(
      (action) => action.metadataName === 'agent',
    );
    const roleTargetActions = actions.filter(
      (action) => action.metadataName === 'roleTarget',
    );
    if (
      actions.length !== agentActions.length + roleTargetActions.length ||
      roleTargetActions.some(
        (action) => action.type !== 'create' && action.type !== 'delete',
      )
    )
      throw new Error(
        'Agent metadata role audit requires only agent and roleTarget create/delete actions',
      );

    if (request.agentMode === 'create') {
      if (
        agentActions.length !== 1 ||
        roleTargetActions.length !== 1 ||
        agentActions[0].type !== 'create' ||
        roleTargetActions[0].type !== 'create'
      )
        throw new Error(
          'Agent metadata role create audit requires one agent create and one roleTarget create',
        );
      const agentCreate = agentActions[0];
      const agentInput = agentCreate.flatEntity
        ? ({ ...agentCreate.flatEntity } as Record<string, unknown>)
        : undefined;
      const targetCreate = roleTargetActions[0];
      const targetInput = targetCreate.flatEntity
        ? ({ ...targetCreate.flatEntity } as Record<string, unknown>)
        : undefined;
      if (!agentInput || !agentCreate.id || !targetInput || !targetCreate.id)
        throw new Error(
          'Agent metadata role create audit requires enriched create identity',
        );
      const createdTargetId = uuid(targetCreate.id);
      const createdTargetUniversalIdentifier = uuid(
        targetInput.universalIdentifier,
      );
      const mappedRoleId =
        mappings.roles[String(targetInput.roleUniversalIdentifier)]?.id;
      // The runner writes the migration application as applicationId; the
      // planned universal application only has to agree between both rows.
      if (
        uuid(agentCreate.id) !== request.agentId ||
        uuid(agentInput.universalIdentifier) !==
          request.agentUniversalIdentifier ||
        targetInput.userWorkspaceId !== null ||
        targetInput.apiKeyId !== null ||
        uuid(targetInput.agentUniversalIdentifier) !==
          request.agentUniversalIdentifier ||
        uuid(targetInput.applicationUniversalIdentifier) !==
          uuid(agentInput.applicationUniversalIdentifier) ||
        !mappedRoleId ||
        uuid(mappedRoleId) !== request.roleId ||
        typeof targetInput.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(targetInput.createdAt)) ||
        typeof targetInput.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(targetInput.updatedAt))
      )
        throw new Error(
          'Agent metadata role create final plan points to a different target',
        );
      const roleUniversalIdentifier = uuid(targetInput.roleUniversalIdentifier);
      const createdAt = targetInput.createdAt;
      const updatedAt = targetInput.updatedAt;

      consumed.add(request);
      return runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const [workspace] = await runner.query(
          `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
          [request.workspaceId],
        );
        if (!workspace || workspace.deletedAt !== null)
          throw new Error('Role assignment workspace unavailable');
        const verifyApplication = () =>
          verifyRoleAuditApplication(
            runner,
            request.workspaceId,
            applicationId,
            applicationUniversalIdentifier,
          );
        await verifyApplication();
        if (
          (
            await runner.query(
              'SELECT id FROM core.agent WHERE "workspaceId"=$1 AND (id=$2 OR "universalIdentifier"=$3) FOR UPDATE',
              [
                request.workspaceId,
                request.agentId,
                request.agentUniversalIdentifier,
              ],
            )
          ).length > 0 ||
          (
            await runner.query(
              'SELECT id FROM core."roleTarget" WHERE "workspaceId"=$1 AND ("agentId"=$2 OR id=$3 OR "universalIdentifier"=$4) FOR UPDATE',
              [
                request.workspaceId,
                request.agentId,
                createdTargetId,
                createdTargetUniversalIdentifier,
              ],
            )
          ).length > 0
        )
          throw new Error('Role assignment old target changed');
        const roles = await runner.query(
          'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
          [request.workspaceId, request.roleId],
        );
        const destination: Record<string, unknown> | undefined = roles[0]?.row;
        if (
          roles.length !== 1 ||
          !destination ||
          destination.canBeAssignedToAgents !== true ||
          uuid(destination.universalIdentifier) !== roleUniversalIdentifier
        )
          throw new Error(
            'Role assignment destination is unavailable or not assignable',
          );

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        const result = await work(runner);

        const readAgent = () =>
          runner.query(
            'SELECT id,"workspaceId","applicationId","universalIdentifier","deletedAt" FROM core.agent WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
            [request.agentId, request.workspaceId],
          );
        const afterAgents = await readAgent();
        if (
          afterAgents.length !== 1 ||
          afterAgents[0].deletedAt !== null ||
          uuid(afterAgents[0].applicationId) !== applicationId ||
          uuid(afterAgents[0].universalIdentifier) !==
            request.agentUniversalIdentifier
        )
          throw new Error('Role assignment agent changed or unavailable');

        const readTargets = () =>
          runner.query(
            'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("agentId"=$2 OR id=$3) ORDER BY id FOR UPDATE',
            [request.workspaceId, request.agentId, createdTargetId],
          );
        const afterRows = await readTargets();
        const after: Record<string, unknown> | undefined = afterRows[0]?.row;
        const expected = {
          id: createdTargetId,
          universalIdentifier: createdTargetUniversalIdentifier,
          workspaceId: request.workspaceId,
          applicationId,
          roleId: request.roleId,
          userWorkspaceId: null,
          agentId: request.agentId,
          apiKeyId: null,
        };
        const scalar = (row: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => key !== 'createdAt' && key !== 'updatedAt',
            ),
          );
        if (
          afterRows.length !== 1 ||
          !after ||
          canonicalAuditJson(scalar(after)) !== canonicalAuditJson(expected)
        )
          throw new Error('Role assignment persisted replacement mismatch');
        const [timestamps] = await runner.query(
          'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1',
          [createdTargetId, createdAt, updatedAt],
        );
        if (timestamps?.matches !== true)
          throw new Error('Role assignment timestamps changed');

        audit.record({
          resourceKind: 'roleTarget',
          resourceId: createdTargetId,
          action: 'create',
          before: null,
          after: projectRoleTargetAuditFields(after),
          securityDescriptor: {
            resourceKind: 'roleTarget',
            resourceId: createdTargetId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();

        if (
          canonicalAuditJson(afterRows) !==
            canonicalAuditJson(await readTargets()) ||
          canonicalAuditJson(afterAgents) !==
            canonicalAuditJson(await readAgent())
        )
          throw new Error('Role assignment changed during audit flush');
        const currentRoles = await runner.query(
          'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
          [request.workspaceId, request.roleId],
        );
        if (canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles))
          throw new Error(
            'Role assignment role state changed during audit flush',
          );
        await verifyApplication();
        return result;
      });
    }

    if (request.agentMode === 'update') {
      const targetDeletes = roleTargetActions.filter(
        (action) => action.type === 'delete',
      );
      const targetCreates = roleTargetActions.filter(
        (action) => action.type === 'create',
      );
      if (
        agentActions.length > 1 ||
        agentActions.some(
          (action) =>
            action.type !== 'update' ||
            action.id !== undefined ||
            uuid(action.universalIdentifier) !==
              request.agentUniversalIdentifier,
        ) ||
        targetDeletes.length !==
          (request.expectedDeletedRoleTargetId ? 1 : 0) ||
        targetCreates.length !== (request.roleId ? 1 : 0) ||
        targetDeletes.length + targetCreates.length < 1 ||
        roleTargetActions
          .slice(0, targetDeletes.length)
          .some((action) => action.type !== 'delete') ||
        roleTargetActions
          .slice(targetDeletes.length)
          .some((action) => action.type !== 'create')
      )
        throw new Error(
          'Agent metadata role update audit requires bounded roleTarget actions',
        );

      let deletedTargetUniversalIdentifier: string | null = null;
      if (targetDeletes.length === 1) {
        deletedTargetUniversalIdentifier = uuid(
          targetDeletes[0].universalIdentifier,
        );
        const mappedDeletedId =
          mappings.targets[deletedTargetUniversalIdentifier]?.id;
        if (
          !mappedDeletedId ||
          uuid(mappedDeletedId) !== request.expectedDeletedRoleTargetId
        )
          throw new Error(
            'Agent metadata role update delete target mapping mismatch',
          );
      }

      let plannedTargetCreate: {
        id: string;
        universalIdentifier: string;
        roleUniversalIdentifier: string;
        createdAt: string;
        updatedAt: string;
      } | null = null;
      if (targetCreates.length === 1) {
        const targetCreate = targetCreates[0];
        const targetInput = targetCreate.flatEntity
          ? ({ ...targetCreate.flatEntity } as Record<string, unknown>)
          : undefined;
        if (!targetInput || !targetCreate.id)
          throw new Error(
            'Agent metadata role update requires enriched create identity',
          );
        const mappedAgentId =
          mappings.agents?.[request.agentUniversalIdentifier]?.id;
        const mappedRoleId =
          mappings.roles[String(targetInput.roleUniversalIdentifier)]?.id;
        if (
          targetInput.userWorkspaceId !== null ||
          targetInput.apiKeyId !== null ||
          uuid(targetInput.agentUniversalIdentifier) !==
            request.agentUniversalIdentifier ||
          !mappedAgentId ||
          uuid(mappedAgentId) !== request.agentId ||
          uuid(targetInput.applicationUniversalIdentifier) !==
            applicationUniversalIdentifier ||
          !mappedRoleId ||
          uuid(mappedRoleId) !== request.roleId ||
          typeof targetInput.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(targetInput.createdAt)) ||
          typeof targetInput.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(targetInput.updatedAt))
        )
          throw new Error(
            'Agent metadata role update final plan points to a different target',
          );
        plannedTargetCreate = {
          id: uuid(targetCreate.id),
          universalIdentifier: uuid(targetInput.universalIdentifier),
          roleUniversalIdentifier: uuid(targetInput.roleUniversalIdentifier),
          createdAt: targetInput.createdAt,
          updatedAt: targetInput.updatedAt,
        };
      }

      consumed.add(request);
      return runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        const [workspace] = await runner.query(
          `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
          [request.workspaceId],
        );
        if (!workspace || workspace.deletedAt !== null)
          throw new Error('Role assignment workspace unavailable');
        const verifyApplication = () =>
          verifyRoleAuditApplication(
            runner,
            request.workspaceId,
            applicationId,
            applicationUniversalIdentifier,
          );
        await verifyApplication();

        const readAgent = () =>
          runner.query(
            'SELECT id,"workspaceId","applicationId","universalIdentifier","deletedAt" FROM core.agent WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
            [request.agentId, request.workspaceId],
          );
        const beforeAgents = await readAgent();
        if (
          beforeAgents.length !== 1 ||
          beforeAgents[0].deletedAt !== null ||
          uuid(beforeAgents[0].universalIdentifier) !==
            request.agentUniversalIdentifier
        )
          throw new Error('Role assignment agent changed or unavailable');

        const readTargets = () =>
          runner.query(
            'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("agentId"=$2 OR ($3::uuid IS NOT NULL AND id=$3::uuid) OR ($4::uuid IS NOT NULL AND id=$4::uuid)) ORDER BY id FOR UPDATE',
            [
              request.workspaceId,
              request.agentId,
              request.expectedDeletedRoleTargetId,
              plannedTargetCreate?.id ?? null,
            ],
          );
        const beforeRows = await readTargets();
        if (beforeRows.length !== (request.expectedDeletedRoleTargetId ? 1 : 0))
          throw new Error('Role assignment old target changed');
        const beforeTarget: Record<string, unknown> | null =
          beforeRows[0]?.row ?? null;
        if (
          beforeTarget &&
          (uuid(beforeTarget.id) !== request.expectedDeletedRoleTargetId ||
            uuid(beforeTarget.universalIdentifier) !==
              deletedTargetUniversalIdentifier ||
            uuid(beforeTarget.agentId) !== request.agentId ||
            beforeTarget.userWorkspaceId !== null ||
            beforeTarget.apiKeyId !== null)
        )
          throw new Error('Role assignment old target changed');

        const roleIdsToLock = [
          ...new Set([
            ...(request.roleId ? [request.roleId] : []),
            ...(beforeTarget ? [uuid(beforeTarget.roleId)] : []),
          ]),
        ];
        const roles = await runner.query(
          'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
          [request.workspaceId, roleIdsToLock],
        );
        const roleById = new Map<string, Record<string, unknown>>(
          roles.map((entry: { row: Record<string, unknown> }) => [
            uuid(entry.row.id),
            entry.row,
          ]),
        );
        if (plannedTargetCreate && request.roleId) {
          const destination = roleById.get(request.roleId);
          if (
            !destination ||
            destination.canBeAssignedToAgents !== true ||
            uuid(destination.universalIdentifier) !==
              plannedTargetCreate.roleUniversalIdentifier
          )
            throw new Error(
              'Role assignment destination is unavailable or not assignable',
            );
        }
        if (beforeTarget && !roleById.has(uuid(beforeTarget.roleId)))
          throw new Error('Role assignment source role unavailable');

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        const result = await work(runner);

        const afterAgents = await readAgent();
        if (
          canonicalAuditJson(afterAgents) !== canonicalAuditJson(beforeAgents)
        )
          throw new Error('Role assignment agent changed or unavailable');

        const afterRows = await readTargets();
        if (
          request.expectedDeletedRoleTargetId &&
          (
            await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
              request.expectedDeletedRoleTargetId,
            ])
          ).length > 0
        )
          throw new Error('Role assignment old target still exists');

        let afterTarget: Record<string, unknown> | null = null;
        if (plannedTargetCreate && request.roleId) {
          const after: Record<string, unknown> | undefined = afterRows[0]?.row;
          const expected = {
            id: plannedTargetCreate.id,
            universalIdentifier: plannedTargetCreate.universalIdentifier,
            workspaceId: request.workspaceId,
            applicationId,
            roleId: request.roleId,
            userWorkspaceId: null,
            agentId: request.agentId,
            apiKeyId: null,
          };
          const scalar = (row: Record<string, unknown>) =>
            Object.fromEntries(
              Object.entries(row).filter(
                ([key]) => key !== 'createdAt' && key !== 'updatedAt',
              ),
            );
          if (
            afterRows.length !== 1 ||
            !after ||
            canonicalAuditJson(scalar(after)) !== canonicalAuditJson(expected)
          )
            throw new Error('Role assignment persisted replacement mismatch');
          const [timestamps] = await runner.query(
            'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1',
            [
              plannedTargetCreate.id,
              plannedTargetCreate.createdAt,
              plannedTargetCreate.updatedAt,
            ],
          );
          if (timestamps?.matches !== true)
            throw new Error('Role assignment timestamps changed');
          afterTarget = after;
        } else if (afterRows.length > 0) {
          throw new Error('Role assignment old target still exists');
        }

        const record = (
          row: Record<string, unknown>,
          action: 'create' | 'delete',
        ) =>
          audit.record({
            resourceKind: 'roleTarget',
            resourceId: uuid(row.id),
            action,
            before:
              action === 'delete' ? projectRoleTargetAuditFields(row) : null,
            after:
              action === 'create' ? projectRoleTargetAuditFields(row) : null,
            securityDescriptor: {
              resourceKind: 'roleTarget',
              resourceId: uuid(row.id),
              metadataAccess: 'currentWorkspaceAdministration',
            },
          });
        if (beforeTarget) record(beforeTarget, 'delete');
        if (afterTarget) record(afterTarget, 'create');
        await audit.flush();

        if (
          canonicalAuditJson(afterRows) !==
            canonicalAuditJson(await readTargets()) ||
          canonicalAuditJson(afterAgents) !==
            canonicalAuditJson(await readAgent())
        )
          throw new Error('Role assignment changed during audit flush');
        if (
          request.expectedDeletedRoleTargetId &&
          (
            await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
              request.expectedDeletedRoleTargetId,
            ])
          ).length > 0
        )
          throw new Error('Role assignment deleted target reappeared');
        const currentRoles = await runner.query(
          'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
          [request.workspaceId, roleIdsToLock],
        );
        if (canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles))
          throw new Error(
            'Role assignment role state changed during audit flush',
          );
        await verifyApplication();
        return result;
      });
    }

    if (
      request.agentMode !== 'delete' ||
      agentActions.length === 0 ||
      agentActions.length < request.targets.length ||
      roleTargetActions.length !== request.targets.length ||
      agentActions.some((action) => action.type !== 'delete') ||
      roleTargetActions.some((action) => action.type !== 'delete')
    )
      throw new Error(
        'Agent metadata role delete audit requires bounded agent and roleTarget delete actions',
      );

    const plannedAgentDeleteIds = agentActions.map((action) => {
      const universalIdentifier = uuid(action.universalIdentifier);
      const mappedId = mappings.agents?.[universalIdentifier]?.id;
      if (!mappedId)
        throw new Error('Agent metadata role delete agent mapping missing');
      return uuid(mappedId);
    });
    const plannedAgentDeleteIdSet = new Set(plannedAgentDeleteIds);
    if (
      plannedAgentDeleteIdSet.size !== plannedAgentDeleteIds.length ||
      request.targets.some(
        (target) => !plannedAgentDeleteIdSet.has(target.agentId),
      )
    )
      throw new Error('Agent metadata role delete agent set mismatch');

    const expectedAgentByRoleTargetId = new Map(
      request.targets.map((target) => [target.roleTargetId, target.agentId]),
    );
    const plannedTargetDeletes = roleTargetActions.map((deleteAction) => {
      const universalIdentifier = uuid(deleteAction.universalIdentifier);
      const mappedId = mappings.targets[universalIdentifier]?.id;
      if (!mappedId)
        throw new Error('Agent metadata role delete target mapping missing');
      const id = uuid(mappedId);
      const expectedAgentId = expectedAgentByRoleTargetId.get(id);
      if (!expectedAgentId)
        throw new Error(
          'Agent metadata role delete final plan points to a different target',
        );
      return { id, universalIdentifier, agentId: expectedAgentId };
    });
    if (
      new Set(plannedTargetDeletes.map((item) => item.id)).size !==
        plannedTargetDeletes.length ||
      new Set(plannedTargetDeletes.map((item) => item.universalIdentifier))
        .size !== plannedTargetDeletes.length
    )
      throw new Error('Agent metadata role delete duplicate delete action');

    consumed.add(request);
    return runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null)
        throw new Error('Role assignment workspace unavailable');
      const verifyApplication = () =>
        verifyRoleAuditApplication(
          runner,
          request.workspaceId,
          applicationId,
          applicationUniversalIdentifier,
        );
      await verifyApplication();

      // FOR UPDATE conflicts with the KEY SHARE lock of any roleTarget insert,
      // so no binding can appear between this check and the cascading delete.
      const beforeAgents = await runner.query(
        'SELECT id,"deletedAt" FROM core.agent WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [request.workspaceId, plannedAgentDeleteIds],
      );
      if (
        beforeAgents.length !== plannedAgentDeleteIds.length ||
        beforeAgents.some(
          (agent: { deletedAt: unknown }) => agent.deletedAt !== null,
        )
      )
        throw new Error('Role assignment agent changed or unavailable');

      const readTargets = () =>
        runner.query(
          'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("agentId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE',
          [
            request.workspaceId,
            plannedAgentDeleteIds,
            plannedTargetDeletes.map((item) => item.id),
          ],
        );
      const beforeRows = await readTargets();
      if (beforeRows.length !== plannedTargetDeletes.length)
        throw new Error('Role assignment old target changed');
      const beforeTargets: Record<string, unknown>[] = beforeRows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      );
      const plannedById = new Map(
        plannedTargetDeletes.map((item) => [item.id, item]),
      );
      for (const before of beforeTargets) {
        const beforeId = uuid(before.id);
        const planned = plannedById.get(beforeId);
        if (
          !planned ||
          uuid(before.universalIdentifier) !== planned.universalIdentifier ||
          uuid(before.agentId) !== planned.agentId ||
          before.userWorkspaceId !== null ||
          before.apiKeyId !== null
        )
          throw new Error('Role assignment old target changed');
      }

      const roleIdsToLock = [
        ...new Set(beforeTargets.map((before) => uuid(before.roleId))),
      ];
      const roles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [request.workspaceId, roleIdsToLock],
      );
      if (roles.length !== roleIdsToLock.length)
        throw new Error('Role assignment source role unavailable');

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      const result = await work(runner);

      if (
        (await readTargets()).length > 0 ||
        (
          await runner.query(
            'SELECT id FROM core.agent WHERE id=ANY($1::uuid[])',
            [plannedAgentDeleteIds],
          )
        ).length > 0
      )
        throw new Error('Role assignment old target still exists');

      for (const before of beforeTargets) {
        audit.record({
          resourceKind: 'roleTarget',
          resourceId: uuid(before.id),
          action: 'delete',
          before: projectRoleTargetAuditFields(before),
          after: null,
          securityDescriptor: {
            resourceKind: 'roleTarget',
            resourceId: uuid(before.id),
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
      await audit.flush();

      if (
        (await readTargets()).length > 0 ||
        (
          await runner.query(
            'SELECT id FROM core.agent WHERE id=ANY($1::uuid[])',
            [plannedAgentDeleteIds],
          )
        ).length > 0
      )
        throw new Error('Role assignment deleted target reappeared');
      const currentRoles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [request.workspaceId, roleIdsToLock],
      );
      if (canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles))
        throw new Error(
          'Role assignment role state changed during audit flush',
        );
      await verifyApplication();
      return result;
    });
  }

  if (request.targetKind === 'userWorkspaceBulk') {
    const expectedCount = request.targets.length;
    if (
      creates.length !== expectedCount ||
      deletes.length > expectedCount ||
      actions.length !== creates.length + deletes.length ||
      actions.some((action) => action.metadataName !== 'roleTarget') ||
      actions
        .slice(0, deletes.length)
        .some((action) => action.type !== 'delete') ||
      actions.slice(deletes.length).some((action) => action.type !== 'create')
    )
      throw new Error(
        'Bulk role assignment audit requires bounded roleTarget deletes followed by creates',
      );

    const targetByUserWorkspaceId = new Map(
      request.targets.map((target) => [target.userWorkspaceId, target]),
    );
    const plannedDeletes = deletes.map((deleteAction) => {
      const universalIdentifier = uuid(deleteAction.universalIdentifier);
      const mappedId = mappings.targets[universalIdentifier]?.id;
      if (!mappedId)
        throw new Error('Bulk role assignment delete target mapping missing');
      return { id: uuid(mappedId), universalIdentifier };
    });
    if (
      new Set(plannedDeletes.map((item) => item.id)).size !==
        plannedDeletes.length ||
      new Set(plannedDeletes.map((item) => item.universalIdentifier)).size !==
        plannedDeletes.length
    )
      throw new Error('Bulk role assignment duplicate delete action');

    const plannedCreates = creates.map((createAction) => {
      const input = createAction.flatEntity
        ? ({ ...createAction.flatEntity } as Record<string, unknown>)
        : undefined;
      if (!input || !createAction.id)
        throw new Error(
          'Bulk role assignment requires enriched create identity',
        );
      const id = uuid(createAction.id);
      const universalIdentifier = uuid(input.universalIdentifier);
      const userWorkspaceId = uuid(input.userWorkspaceId);
      const roleUniversalIdentifier = uuid(input.roleUniversalIdentifier);
      const mappedRoleId =
        mappings.roles[String(input.roleUniversalIdentifier)]?.id;
      if (
        !targetByUserWorkspaceId.has(userWorkspaceId) ||
        input.apiKeyId !== null ||
        input.agentUniversalIdentifier !== null ||
        uuid(input.applicationUniversalIdentifier) !==
          applicationUniversalIdentifier ||
        !mappedRoleId ||
        uuid(mappedRoleId) !== request.roleId ||
        typeof input.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(input.createdAt)) ||
        typeof input.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(input.updatedAt))
      )
        throw new Error(
          'Bulk role assignment final plan points to a different target',
        );
      return {
        id,
        universalIdentifier,
        userWorkspaceId,
        roleUniversalIdentifier,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
    });
    if (
      new Set(plannedCreates.map((item) => item.id)).size !==
        plannedCreates.length ||
      new Set(plannedCreates.map((item) => item.universalIdentifier)).size !==
        plannedCreates.length ||
      new Set(plannedCreates.map((item) => item.userWorkspaceId)).size !==
        plannedCreates.length
    )
      throw new Error('Bulk role assignment duplicate create action');

    consumed.add(request);
    return runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'databaseSchema' AS "databaseSchema",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (
        !workspace ||
        workspace.deletedAt !== null ||
        (request.requireWorkspaceMember && !workspace.databaseSchema)
      )
        throw new Error('Role assignment workspace unavailable');
      const verifyApplication = () =>
        verifyRoleAuditApplication(
          runner,
          request.workspaceId,
          applicationId,
          applicationUniversalIdentifier,
        );
      await verifyApplication();

      const memberTable = workspace.databaseSchema
        ? `${dataSource.driver.escape(workspace.databaseSchema)}."workspaceMember"`
        : '';
      const targetUserWorkspaceIds = request.targets.map(
        (target) => target.userWorkspaceId,
      );
      const targetMemberIds = request.targets
        .map((target) => target.workspaceMemberId)
        .filter((id): id is string => typeof id === 'string');

      const verifyBulkTargetOwners = async () => {
        const memberships = await runner.query(
          'SELECT id,"userId","workspaceId","deletedAt" FROM core."userWorkspace" WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [targetUserWorkspaceIds],
        );
        if (memberships.length !== request.targets.length)
          throw new Error('Role assignment membership changed or unavailable');
        for (const membership of memberships) {
          const expectedTarget = targetByUserWorkspaceId.get(
            uuid(membership.id),
          );
          if (
            !expectedTarget ||
            uuid(membership.userId) !== expectedTarget.userId ||
            uuid(membership.workspaceId) !== request.workspaceId ||
            membership.deletedAt !== null
          )
            throw new Error(
              'Role assignment membership changed or unavailable',
            );
        }
        if (request.requireWorkspaceMember || targetMemberIds.length > 0) {
          if (!memberTable)
            throw new Error(
              'Role assignment membership changed or unavailable',
            );
          const members = await runner.query(
            `SELECT id,"userId","deletedAt" FROM ${memberTable} WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
            [targetMemberIds],
          );
          const memberById = new Map<
            string,
            { id: string; userId: string; deletedAt: unknown }
          >(
            members.map(
              (m: { id: string; userId: string; deletedAt: unknown }) => [
                uuid(m.id),
                m,
              ],
            ),
          );
          for (const target of request.targets) {
            if (!target.workspaceMemberId) {
              if (request.requireWorkspaceMember)
                throw new Error(
                  'Role assignment membership changed or unavailable',
                );
              continue;
            }
            const member = memberById.get(target.workspaceMemberId);
            if (
              !member ||
              uuid(member.userId) !== target.userId ||
              member.deletedAt !== null
            )
              throw new Error(
                'Role assignment membership changed or unavailable',
              );
          }
        }
      };
      await verifyBulkTargetOwners();

      for (const target of request.targets) {
        if (
          request.actingUserWorkspaceId === target.userWorkspaceId ||
          (target.workspaceMemberId &&
            request.operation.actor.kind === 'workspaceMember' &&
            request.operation.actor.id === target.workspaceMemberId) ||
          (target.workspaceMemberId &&
            request.operation.initiator?.kind === 'workspaceMember' &&
            request.operation.initiator.id === target.workspaceMemberId)
        )
          throw new Error('Role assignment cannot change your own role');
      }

      const readTargets = () =>
        runner.query(
          'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("userWorkspaceId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE',
          [
            request.workspaceId,
            targetUserWorkspaceIds,
            plannedDeletes.map((item) => item.id),
          ],
        );
      const beforeRows = await readTargets();
      if (beforeRows.length !== plannedDeletes.length)
        throw new Error('Role assignment old target changed');
      const beforeTargets: Record<string, unknown>[] = beforeRows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      );
      const seenBeforeUserWorkspaces = new Set<string>();
      for (const before of beforeTargets) {
        const beforeId = uuid(before.id);
        const beforeUniversalIdentifier = uuid(before.universalIdentifier);
        const beforeUserWorkspaceId =
          typeof before.userWorkspaceId === 'string'
            ? uuid(before.userWorkspaceId)
            : null;
        const planned = plannedDeletes.find((item) => item.id === beforeId);
        if (
          !planned ||
          planned.universalIdentifier !== beforeUniversalIdentifier ||
          !beforeUserWorkspaceId ||
          !targetByUserWorkspaceId.has(beforeUserWorkspaceId) ||
          seenBeforeUserWorkspaces.has(beforeUserWorkspaceId) ||
          before.agentId !== null ||
          before.apiKeyId !== null
        )
          throw new Error('Role assignment old target changed');
        seenBeforeUserWorkspaces.add(beforeUserWorkspaceId);
      }

      const roleIdsToLock = [
        ...new Set([
          request.roleId,
          ...beforeTargets.map((before) => uuid(before.roleId)),
        ]),
      ];
      const roles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [request.workspaceId, roleIdsToLock],
      );
      const roleById = new Map<string, Record<string, unknown>>(
        roles.map((entry: { row: Record<string, unknown> }) => [
          uuid(entry.row.id),
          entry.row,
        ]),
      );
      const destination = roleById.get(request.roleId);
      if (
        !destination ||
        destination.canBeAssignedToUsers !== true ||
        plannedCreates.some(
          (item) =>
            uuid(destination.universalIdentifier) !==
            item.roleUniversalIdentifier,
        ) ||
        beforeTargets.some((before) => !roleById.has(uuid(before.roleId)))
      )
        throw new Error(
          'Role assignment destination is unavailable or not assignable',
        );

      const demotedAdminUserWorkspaceIds = beforeTargets
        .filter((before) => {
          const sourceRole = roleById.get(uuid(before.roleId));
          return (
            sourceRole?.universalIdentifier ===
              STANDARD_ROLE.admin.universalIdentifier &&
            destination.universalIdentifier !==
              STANDARD_ROLE.admin.universalIdentifier
          );
        })
        .map((before) => uuid(before.userWorkspaceId));

      if (demotedAdminUserWorkspaceIds.length > 0) {
        if (!memberTable)
          throw new Error(
            'Role assignment cannot remove the last administrator',
          );
        const [count] = await runner.query(
          `SELECT count(DISTINCT u.id)::int AS total FROM core."roleTarget" t JOIN core.role r ON r.id=t."roleId" AND r."workspaceId"=t."workspaceId" JOIN core."userWorkspace" u ON u.id=t."userWorkspaceId" AND u."workspaceId"=t."workspaceId" AND u."deletedAt" IS NULL JOIN ${memberTable} m ON m."userId"=u."userId" AND m."deletedAt" IS NULL WHERE t."workspaceId"=$1 AND r."universalIdentifier"=$2 AND NOT (u.id=ANY($3::uuid[]))`,
          [
            request.workspaceId,
            STANDARD_ROLE.admin.universalIdentifier,
            demotedAdminUserWorkspaceIds,
          ],
        );
        if ((count?.total ?? 0) < 1)
          throw new Error(
            'Role assignment cannot remove the last administrator',
          );
      }

      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      const result = await work(runner);

      const afterRows = await readTargets();
      if (afterRows.length !== plannedCreates.length)
        throw new Error('Role assignment persisted replacement mismatch');
      if (
        plannedDeletes.length > 0 &&
        (
          await runner.query(
            'SELECT id FROM core."roleTarget" WHERE id=ANY($1::uuid[])',
            [plannedDeletes.map((item) => item.id)],
          )
        ).length > 0
      )
        throw new Error('Role assignment old target still exists');

      const afterById = new Map<string, Record<string, unknown>>(
        afterRows.map((entry: { row: Record<string, unknown> }) => [
          uuid(entry.row.id),
          entry.row,
        ]),
      );
      const scalar = (row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => key !== 'createdAt' && key !== 'updatedAt',
          ),
        );
      for (const plannedCreate of plannedCreates) {
        const after = afterById.get(plannedCreate.id);
        const expected = {
          id: plannedCreate.id,
          universalIdentifier: plannedCreate.universalIdentifier,
          workspaceId: request.workspaceId,
          applicationId,
          roleId: request.roleId,
          userWorkspaceId: plannedCreate.userWorkspaceId,
          agentId: null,
          apiKeyId: null,
        };
        if (
          !after ||
          canonicalAuditJson(scalar(after)) !== canonicalAuditJson(expected)
        )
          throw new Error('Role assignment persisted replacement mismatch');
        const [timestamps] = await runner.query(
          'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1',
          [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
        );
        if (timestamps?.matches !== true)
          throw new Error('Role assignment timestamps changed');
      }

      const record = (
        row: Record<string, unknown>,
        action: 'create' | 'delete',
      ) =>
        audit.record({
          resourceKind: 'roleTarget',
          resourceId: uuid(row.id),
          action,
          before:
            action === 'delete' ? projectRoleTargetAuditFields(row) : null,
          after: action === 'create' ? projectRoleTargetAuditFields(row) : null,
          securityDescriptor: {
            resourceKind: 'roleTarget',
            resourceId: uuid(row.id),
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      for (const before of beforeTargets) record(before, 'delete');
      for (const plannedCreate of plannedCreates) {
        record(afterById.get(plannedCreate.id)!, 'create');
      }
      await audit.flush();

      if (
        canonicalAuditJson(afterRows) !==
        canonicalAuditJson(await readTargets())
      )
        throw new Error('Role assignment changed during audit flush');
      if (
        plannedDeletes.length > 0 &&
        (
          await runner.query(
            'SELECT id FROM core."roleTarget" WHERE id=ANY($1::uuid[])',
            [plannedDeletes.map((item) => item.id)],
          )
        ).length > 0
      )
        throw new Error('Role assignment deleted target reappeared');
      const currentRoles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [request.workspaceId, roleIdsToLock],
      );
      if (canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles))
        throw new Error(
          'Role assignment role state changed during audit flush',
        );
      await verifyBulkTargetOwners();
      await verifyApplication();
      return result;
    });
  }

  if (request.mode === 'remove') {
    if (
      request.targetKind !== 'agent' ||
      creates.length !== 0 ||
      deletes.length !== 1 ||
      actions.length !== 1 ||
      actions[0].metadataName !== 'roleTarget'
    )
      throw new Error('Role assignment removal requires one roleTarget delete');
    const deletedUniversalIdentifier = uuid(deletes[0].universalIdentifier);
    const deletedId = mappings.targets[deletedUniversalIdentifier]?.id;
    if (!deletedId || uuid(deletedId) !== request.roleTargetId)
      throw new Error('Role assignment removal target mismatch');
    consumed.add(request);
    return runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query("SET LOCAL lock_timeout = '8s'");
      const [workspace] = await runner.query(
        `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
        [request.workspaceId],
      );
      if (!workspace || workspace.deletedAt !== null)
        throw new Error('Role assignment workspace unavailable');
      const verifyApplication = () =>
        verifyRoleAuditApplication(
          runner,
          request.workspaceId,
          applicationId,
          applicationUniversalIdentifier,
        );
      await verifyApplication();
      const readAgent = () =>
        runner.query(
          'SELECT id,"workspaceId","universalIdentifier","deletedAt" FROM core.agent WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
          [request.agentId, request.workspaceId],
        );
      const agents = await readAgent();
      if (agents.length !== 1 || agents[0].deletedAt !== null)
        throw new Error('Role assignment agent unavailable');
      const readTargets = () =>
        runner.query(
          'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "agentId"=$2 FOR UPDATE',
          [request.workspaceId, request.agentId],
        );
      const beforeRows = await readTargets();
      const before: Record<string, unknown> | undefined = beforeRows[0]?.row;
      if (
        beforeRows.length !== 1 ||
        !before ||
        uuid(before.id) !== request.roleTargetId ||
        uuid(before.universalIdentifier) !== deletedUniversalIdentifier ||
        before.userWorkspaceId !== null ||
        before.apiKeyId !== null
      )
        throw new Error('Role assignment old target changed');
      const roles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
        [request.workspaceId, uuid(before.roleId)],
      );
      if (roles.length !== 1)
        throw new Error('Role assignment source role unavailable');
      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      const result = await work(runner);
      if (
        (await readTargets()).length > 0 ||
        (
          await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
            request.roleTargetId,
          ])
        ).length > 0
      )
        throw new Error('Role assignment old target still exists');
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: request.roleTargetId,
        action: 'delete',
        before: projectRoleTargetAuditFields(before),
        after: null,
        securityDescriptor: {
          resourceKind: 'roleTarget',
          resourceId: request.roleTargetId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      await audit.flush();
      if (
        (await readTargets()).length > 0 ||
        (
          await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
            request.roleTargetId,
          ])
        ).length > 0
      )
        throw new Error('Role assignment deleted target reappeared');
      const currentRoles = await runner.query(
        'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
        [request.workspaceId, uuid(before.roleId)],
      );
      if (
        canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles) ||
        canonicalAuditJson(agents) !== canonicalAuditJson(await readAgent())
      )
        throw new Error('Role assignment state changed during audit flush');
      await verifyApplication();
      return result;
    });
  }

  if (
    creates.length !== 1 ||
    deletes.length > 1 ||
    actions.length !== creates.length + deletes.length ||
    actions.some((action) => action.metadataName !== 'roleTarget') ||
    actions.at(-1) !== creates[0]
  )
    throw new Error('Role assignment audit requires one bounded replacement');
  const create = { ...creates[0] },
    input = create.flatEntity
      ? ({ ...create.flatEntity } as Record<string, unknown>)
      : undefined;
  if (!input || !create.id)
    throw new Error('Role assignment requires enriched create identity');
  const createdId = uuid(create.id),
    createdUniversalIdentifier = uuid(input.universalIdentifier);
  const deletedUniversalIdentifier = deletes[0]?.universalIdentifier;
  const deletedId = deletedUniversalIdentifier
    ? mappings.targets[deletedUniversalIdentifier]?.id
    : undefined;
  const mappedRoleId =
    mappings.roles[String(input.roleUniversalIdentifier)]?.id;
  if (
    uuid(input.applicationUniversalIdentifier) !==
      applicationUniversalIdentifier ||
    !mappedRoleId ||
    uuid(mappedRoleId) !== request.roleId
  )
    throw new Error('Role assignment final plan points to a different target');

  if (request.targetKind === 'userWorkspace') {
    if (
      input.userWorkspaceId !== request.userWorkspaceId ||
      input.apiKeyId !== null ||
      input.agentUniversalIdentifier !== null
    )
      throw new Error(
        'Role assignment final plan points to a different target',
      );
  } else if (request.targetKind === 'agent') {
    const agentUniversalIdentifier =
      typeof input.agentUniversalIdentifier === 'string'
        ? uuid(input.agentUniversalIdentifier)
        : undefined;
    const mappedAgentId = agentUniversalIdentifier
      ? mappings.agents?.[agentUniversalIdentifier]?.id
      : undefined;
    if (
      input.userWorkspaceId !== null ||
      input.apiKeyId !== null ||
      !agentUniversalIdentifier ||
      !mappedAgentId ||
      uuid(mappedAgentId) !== request.agentId
    )
      throw new Error(
        'Role assignment final plan points to a different target',
      );
  } else {
    if (
      input.apiKeyId !== request.apiKeyId ||
      input.userWorkspaceId !== null ||
      input.agentUniversalIdentifier !== null
    )
      throw new Error(
        'Role assignment final plan points to a different target',
      );
  }

  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      `SELECT id,to_jsonb(w)->>'databaseSchema' AS "databaseSchema",to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
      [request.workspaceId],
    );
    if (
      !workspace ||
      workspace.deletedAt !== null ||
      (request.targetKind === 'userWorkspace' && !workspace.databaseSchema)
    )
      throw new Error('Role assignment workspace unavailable');
    const verifyApplication = () =>
      verifyRoleAuditApplication(
        runner,
        request.workspaceId,
        applicationId,
        applicationUniversalIdentifier,
      );
    await verifyApplication();

    const memberTable = workspace.databaseSchema
      ? `${dataSource.driver.escape(workspace.databaseSchema)}."workspaceMember"`
      : '';
    const verifyTargetOwner = async () => {
      if (request.targetKind === 'userWorkspace') {
        const memberships = await runner.query(
          'SELECT "userId","workspaceId","deletedAt" FROM core."userWorkspace" WHERE id=$1 FOR SHARE',
          [request.userWorkspaceId],
        );
        const members = await runner.query(
          `SELECT "userId","deletedAt" FROM ${memberTable} WHERE id=$1 FOR SHARE`,
          [request.workspaceMemberId],
        );
        if (
          memberships.length !== 1 ||
          memberships[0].userId !== request.userId ||
          memberships[0].workspaceId !== request.workspaceId ||
          memberships[0].deletedAt !== null ||
          members.length !== 1 ||
          members[0].userId !== request.userId ||
          members[0].deletedAt !== null
        )
          throw new Error('Role assignment membership changed or unavailable');
      } else if (request.targetKind === 'agent') {
        const agents = await runner.query(
          'SELECT id,"workspaceId","universalIdentifier","deletedAt" FROM core.agent WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
          [request.agentId, request.workspaceId],
        );
        if (
          agents.length !== 1 ||
          agents[0].deletedAt !== null ||
          uuid(agents[0].universalIdentifier) !==
            uuid(input.agentUniversalIdentifier)
        )
          throw new Error('Role assignment agent changed or unavailable');
      } else {
        const apiKeys = await runner.query(
          'SELECT id,"workspaceId","revokedAt" FROM core."apiKey" WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
          [request.apiKeyId, request.workspaceId],
        );
        if (apiKeys.length !== 1 || apiKeys[0].revokedAt !== null)
          throw new Error('Role assignment API key changed or unavailable');
      }
    };
    await verifyTargetOwner();

    if (
      request.targetKind === 'userWorkspace' &&
      (request.actingUserWorkspaceId === request.userWorkspaceId ||
        (request.operation.actor.kind === 'workspaceMember' &&
          request.operation.actor.id === request.workspaceMemberId) ||
        (request.operation.initiator?.kind === 'workspaceMember' &&
          request.operation.initiator.id === request.workspaceMemberId))
    )
      throw new Error('Role assignment cannot change your own role');

    const targetColumn =
      request.targetKind === 'userWorkspace'
        ? '"userWorkspaceId"'
        : request.targetKind === 'agent'
          ? '"agentId"'
          : '"apiKeyId"';
    const targetValue =
      request.targetKind === 'userWorkspace'
        ? request.userWorkspaceId
        : request.targetKind === 'agent'
          ? request.agentId
          : request.apiKeyId;
    const readTargets = () =>
      runner.query(
        `SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ${targetColumn}=$2 FOR UPDATE`,
        [request.workspaceId, targetValue],
      );
    const beforeRows = await readTargets();
    if (beforeRows.length > 1 || beforeRows.length !== deletes.length)
      throw new Error('Role assignment old target changed');
    const before: Record<string, unknown> | null = beforeRows[0]?.row ?? null;
    if (
      before &&
      (before.universalIdentifier !== deletedUniversalIdentifier ||
        deletedId !== before.id ||
        (request.targetKind === 'userWorkspace' &&
          (before.agentId !== null || before.apiKeyId !== null)) ||
        (request.targetKind === 'agent' &&
          (before.userWorkspaceId !== null || before.apiKeyId !== null)) ||
        (request.targetKind === 'apiKey' &&
          (before.userWorkspaceId !== null || before.agentId !== null)))
    )
      throw new Error('Role assignment old target changed');

    const roles = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
      [
        request.workspaceId,
        [...new Set([request.roleId, ...(before ? [before.roleId] : [])])],
      ],
    );
    const destination = roles.find(
      (entry: { row: Record<string, unknown> }) =>
        entry.row.id === request.roleId,
    )?.row;
    const source = before
      ? roles.find(
          (entry: { row: Record<string, unknown> }) =>
            entry.row.id === before.roleId,
        )?.row
      : null;
    const assignabilityColumn =
      request.targetKind === 'userWorkspace'
        ? 'canBeAssignedToUsers'
        : request.targetKind === 'agent'
          ? 'canBeAssignedToAgents'
          : 'canBeAssignedToApiKeys';
    if (
      !destination ||
      destination[assignabilityColumn] !== true ||
      destination.universalIdentifier !== input.roleUniversalIdentifier ||
      (before && !source)
    )
      throw new Error(
        'Role assignment destination is unavailable or not assignable',
      );
    if (
      request.targetKind === 'userWorkspace' &&
      source?.universalIdentifier === STANDARD_ROLE.admin.universalIdentifier &&
      destination.universalIdentifier !==
        STANDARD_ROLE.admin.universalIdentifier
    ) {
      const [count] = await runner.query(
        `SELECT count(DISTINCT u.id)::int AS total FROM core."roleTarget" t JOIN core.role r ON r.id=t."roleId" AND r."workspaceId"=t."workspaceId" JOIN core."userWorkspace" u ON u.id=t."userWorkspaceId" AND u."workspaceId"=t."workspaceId" AND u."deletedAt" IS NULL JOIN ${memberTable} m ON m."userId"=u."userId" AND m."deletedAt" IS NULL WHERE t."workspaceId"=$1 AND r."universalIdentifier"=$2`,
        [request.workspaceId, STANDARD_ROLE.admin.universalIdentifier],
      );
      if (count.total <= 1)
        throw new Error('Role assignment cannot remove the last administrator');
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const afterRows = await readTargets();
    const after: Record<string, unknown> | undefined = afterRows[0]?.row;
    const expected = {
      id: createdId,
      universalIdentifier: createdUniversalIdentifier,
      workspaceId: request.workspaceId,
      applicationId,
      roleId: request.roleId,
      userWorkspaceId:
        request.targetKind === 'userWorkspace' ? request.userWorkspaceId : null,
      agentId: request.targetKind === 'agent' ? request.agentId : null,
      apiKeyId: request.targetKind === 'apiKey' ? request.apiKeyId : null,
    };
    const scalar = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => key !== 'createdAt' && key !== 'updatedAt',
        ),
      );
    if (
      afterRows.length !== 1 ||
      !after ||
      canonicalAuditJson(scalar(after)) !== canonicalAuditJson(expected)
    )
      throw new Error('Role assignment persisted replacement mismatch');
    const [timestamps] = await runner.query(
      'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."roleTarget" WHERE id=$1',
      [createdId, input.createdAt, input.updatedAt],
    );
    if (timestamps?.matches !== true)
      throw new Error('Role assignment timestamps changed');
    if (
      before &&
      (
        await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
          before.id,
        ])
      ).length
    )
      throw new Error('Role assignment old target still exists');
    const record = (
      row: Record<string, unknown>,
      action: 'create' | 'delete',
    ) =>
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: row.id as string,
        action,
        before: action === 'delete' ? projectRoleTargetAuditFields(row) : null,
        after: action === 'create' ? projectRoleTargetAuditFields(row) : null,
        securityDescriptor: {
          resourceKind: 'roleTarget',
          resourceId: row.id as string,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    if (before) record(before, 'delete');
    record(after, 'create');
    await audit.flush();
    if (
      canonicalAuditJson(afterRows) !== canonicalAuditJson(await readTargets())
    )
      throw new Error('Role assignment changed during audit flush');
    if (
      before &&
      (
        await runner.query('SELECT id FROM core."roleTarget" WHERE id=$1', [
          before.id,
        ])
      ).length
    )
      throw new Error('Role assignment deleted target reappeared');
    const currentRoles = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [
        request.workspaceId,
        [...new Set([request.roleId, ...(before ? [before.roleId] : [])])],
      ],
    );
    if (canonicalAuditJson(roles) !== canonicalAuditJson(currentRoles))
      throw new Error('Role assignment role state changed during audit flush');
    await verifyTargetOwner();
    await verifyApplication();
    return result;
  });
};
