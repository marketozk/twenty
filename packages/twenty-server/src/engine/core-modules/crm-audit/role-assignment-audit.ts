import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditOperation,
  getRoleMutationAudit,
  projectRoleTargetAuditFields,
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

type Assignment =
  | UserAssignment
  | AgentAssignment
  | AgentRemoval
  | ApiKeyAssignment;

type Request = Readonly<
  Assignment & {
    targetKind: 'userWorkspace' | 'agent' | 'apiKey';
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
  if (storage.getStore() || getRoleMutationAudit(assignment.workspaceId))
    throw new Error('Nested role assignment audit unsupported');
  const targetKind = assignment.targetKind ?? 'userWorkspace';
  const mode = assignment.mode ?? 'assign';
  const capturedUuidFields = Object.fromEntries(
    Object.entries(assignment)
      .filter(
        ([key, value]) =>
          value !== undefined && key !== 'targetKind' && key !== 'mode',
      )
      .map(([key, value]) => [key, uuid(value)]),
  );
  const workspaceId = uuid(assignment.workspaceId);
  const request = Object.freeze({
    ...capturedUuidFields,
    targetKind,
    mode,
    workspaceId,
    operation: captureRoleAuditOperation(workspaceId, identity),
    ...(identity.impersonatorUserWorkspaceId
      ? {
          impersonatorUserWorkspaceId: uuid(
            identity.impersonatorUserWorkspaceId,
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
      throw new Error('Role assignment role changed during mutation');
    await verifyTargetOwner();
    await verifyApplication();
    return result;
  });
};
