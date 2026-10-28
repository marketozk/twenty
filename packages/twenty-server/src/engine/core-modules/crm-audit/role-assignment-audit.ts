import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  captureRoleAuditOperation,
  getRoleMutationAudit,
  resolveRoleAuditInitiator,
  verifyRoleAuditApplication,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

type Assignment = Readonly<{
  workspaceId: string;
  workspaceMemberId: string;
  userId: string;
  userWorkspaceId: string;
  roleId: string;
  actingUserWorkspaceId?: string;
}>;
type Request = Readonly<
  Assignment & {
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
  const captured = Object.fromEntries(
    Object.entries(assignment)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, uuid(value)]),
  ) as Assignment;
  const request: Request = Object.freeze({
    ...captured,
    operation: captureRoleAuditOperation(captured.workspaceId, identity),
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
  const applicationId = uuid(mappings.application.id);
  const deletedUniversalIdentifier = deletes[0]?.universalIdentifier;
  const deletedId = deletedUniversalIdentifier
    ? mappings.targets[deletedUniversalIdentifier]?.id
    : undefined;
  if (
    input.userWorkspaceId !== request.userWorkspaceId ||
    input.apiKeyId !== null ||
    input.agentUniversalIdentifier !== null ||
    input.applicationUniversalIdentifier !==
      mappings.application.universalIdentifier ||
    mappings.roles[String(input.roleUniversalIdentifier)]?.id !== request.roleId
  )
    throw new Error('Role assignment final plan points to a different target');
  consumed.add(request);
  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const [workspace] = await runner.query(
      'SELECT "databaseSchema" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [request.workspaceId],
    );
    if (!workspace?.databaseSchema)
      throw new Error('Role assignment workspace unavailable');
    const verifyApplication = () =>
      verifyRoleAuditApplication(
        runner,
        request.workspaceId,
        applicationId,
        String(input.applicationUniversalIdentifier),
      );
    await verifyApplication();
    const memberTable = `${dataSource.driver.escape(workspace.databaseSchema)}."workspaceMember"`;
    const readMembership = async () => {
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
    };
    await readMembership();
    if (
      request.actingUserWorkspaceId === request.userWorkspaceId ||
      (request.operation.actor.kind === 'workspaceMember' &&
        request.operation.actor.id === request.workspaceMemberId) ||
      (request.operation.initiator?.kind === 'workspaceMember' &&
        request.operation.initiator.id === request.workspaceMemberId)
    )
      throw new Error('Role assignment cannot change your own role');
    const readTargets = () =>
      runner.query(
        'SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "userWorkspaceId"=$2 FOR UPDATE',
        [request.workspaceId, request.userWorkspaceId],
      );
    const beforeRows = await readTargets();
    if (beforeRows.length > 1 || beforeRows.length !== deletes.length)
      throw new Error('Role assignment old target changed');
    const before: Record<string, unknown> | null = beforeRows[0]?.row ?? null;
    if (
      before &&
      (before.universalIdentifier !== deletedUniversalIdentifier ||
        deletedId !== before.id ||
        before.agentId !== null ||
        before.apiKeyId !== null)
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
    if (
      !destination ||
      destination.canBeAssignedToUsers !== true ||
      destination.universalIdentifier !== input.roleUniversalIdentifier ||
      (before && !source)
    )
      throw new Error(
        'Role assignment destination is unavailable or not assignable',
      );
    if (
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
      userWorkspaceId: request.userWorkspaceId,
      agentId: null,
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
    const project = (row: Record<string, unknown>) => ({
      roleId: row.roleId,
      userWorkspaceId: row.userWorkspaceId,
    });
    const record = (
      row: Record<string, unknown>,
      action: 'create' | 'delete',
    ) =>
      audit.record({
        resourceKind: 'roleTarget',
        resourceId: row.id as string,
        action,
        before: action === 'delete' ? project(row) : null,
        after: action === 'create' ? project(row) : null,
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
    await readMembership();
    await verifyApplication();
    return result;
  });
};
