import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { getRoleAssignmentAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  captureRoleAuditOperation,
  getRoleMutationAudit,
  resolveRoleAuditInitiator,
  verifyRoleAuditApplication,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type RolePermissionAuditMappings = {
  application: { id: string; universalIdentifier: string };
  roles: Record<string, { id: string } | undefined>;
  permissionFlags?: Record<string, { id: string; key?: string } | undefined>;
  rolePermissionFlags?: Record<string, { id: string } | undefined>;
  objectMetadatas?: Record<string, { id: string } | undefined>;
  fieldMetadatas?: Record<
    string,
    { id: string; objectMetadataId?: string } | undefined
  >;
  objectPermissions?: Record<string, { id: string } | undefined>;
  fieldPermissions?: Record<string, { id: string } | undefined>;
  rowLevelPermissionPredicates?: Record<string, { id: string } | undefined>;
  rowLevelPermissionPredicateGroups?: Record<
    string,
    { id: string } | undefined
  >;
};

export type RolePermissionAuditRequest = Readonly<
  {
    operation: CrmAuditOperation;
    roleId: string;
    impersonatorUserWorkspaceId?: string;
  } & (
    | {
        kind: 'rolePermissionFlag';
        permissionFlagKeys: readonly string[];
        actingRoleIds?: readonly string[];
        actingUserWorkspaceId?: string;
      }
    | {
        kind: 'objectPermission';
        desiredObjectMetadataIds: readonly string[];
      }
    | {
        kind: 'fieldPermission';
        touchedFieldKeys: readonly string[];
        desiredActiveFieldKeys: readonly string[];
      }
    | {
        kind: 'rowLevelPermissionPredicate';
        objectMetadataId: string;
        desiredGroupIds: readonly string[];
        desiredPredicateIds: readonly string[];
      }
  )
>;

type MigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: object;
  id?: string;
  flatEntity?: object;
};

const storage = new AsyncLocalStorage<RolePermissionAuditRequest>();
const active = new WeakSet<RolePermissionAuditRequest>();
const consumed = new WeakSet<RolePermissionAuditRequest>();

const uuid = (value: string) => {
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Role permission audit identity is invalid');
  return value.toLowerCase();
};

const optionalUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new Error('Role permission audit optional UUID is invalid');
  return uuid(value);
};

const fieldKeyPair = (key: string) => {
  const parts = key.split(':');
  if (parts.length !== 2)
    throw new Error('Role permission audit field key is invalid');
  return `${uuid(parts[0])}:${uuid(parts[1])}`;
};

const requireTimestamp = (value: unknown) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Role permission audit requires normalized timestamps');
  return value;
};

const extractPlainObject = (input: object | undefined) => {
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(input ?? {}),
  )) {
    if (!('value' in descriptor))
      throw new Error('Role permission audit update cannot contain accessors');
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  return result;
};

const withRolePermissionAudit = async <T>(
  workspaceId: string,
  roleId: string,
  identity: RoleUpdateAuditIdentity,
  mutation:
    | {
        kind: 'rolePermissionFlag';
        permissionFlagKeys: readonly string[];
        actingRoleIds?: readonly string[];
        actingUserWorkspaceId?: string;
      }
    | {
        kind: 'objectPermission';
        desiredObjectMetadataIds: readonly string[];
      }
    | {
        kind: 'fieldPermission';
        touchedFieldKeys: readonly string[];
        desiredActiveFieldKeys: readonly string[];
      }
    | {
        kind: 'rowLevelPermissionPredicate';
        objectMetadataId: string;
        desiredGroupIds: readonly string[];
        desiredPredicateIds: readonly string[];
      },
  work: () => Promise<T>,
): Promise<T> => {
  if (
    storage.getStore() ||
    getRoleMutationAudit(workspaceId) ||
    getRoleAssignmentAudit(workspaceId)
  )
    throw new Error('Nested role permission audit is unsupported');
  const operation = captureRoleAuditOperation(workspaceId, identity);
  const request: RolePermissionAuditRequest = Object.freeze({
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

export const withRolePermissionFlagUpsertAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    permissionFlagKeys: readonly string[];
    actingRoleIds?: readonly string[];
    actingUserWorkspaceId?: string;
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const permissionFlagKeys = Object.freeze(
    [
      ...new Set(
        input.permissionFlagKeys.map((key) => {
          if (typeof key !== 'string' || key.length === 0)
            throw new Error('Role permission flag key is invalid');
          return key;
        }),
      ),
    ].sort(),
  );
  const actingRoleIds = input.actingRoleIds
    ? Object.freeze(input.actingRoleIds.map(uuid))
    : undefined;
  const actingUserWorkspaceId =
    input.actingUserWorkspaceId !== undefined
      ? uuid(input.actingUserWorkspaceId)
      : undefined;
  return withRolePermissionAudit(
    input.workspaceId,
    input.roleId,
    identity,
    {
      kind: 'rolePermissionFlag',
      permissionFlagKeys,
      ...(actingRoleIds ? { actingRoleIds } : {}),
      ...(actingUserWorkspaceId ? { actingUserWorkspaceId } : {}),
    },
    work,
  );
};

export const withObjectPermissionUpsertAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    desiredObjectMetadataIds: readonly string[];
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const desiredObjectMetadataIds = Object.freeze(
    [...new Set(input.desiredObjectMetadataIds.map(uuid))].sort(),
  );
  return withRolePermissionAudit(
    input.workspaceId,
    input.roleId,
    identity,
    { kind: 'objectPermission', desiredObjectMetadataIds },
    work,
  );
};

export const withFieldPermissionUpsertAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    touchedFieldKeys: readonly string[];
    desiredActiveFieldKeys: readonly string[];
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const touchedFieldKeys = Object.freeze(
    [...new Set(input.touchedFieldKeys.map(fieldKeyPair))].sort(),
  );
  const desiredActiveFieldKeys = Object.freeze(
    [...new Set(input.desiredActiveFieldKeys.map(fieldKeyPair))].sort(),
  );
  if (desiredActiveFieldKeys.some((key) => !touchedFieldKeys.includes(key)))
    throw new Error('Field permission audit active key must be in touched set');
  return withRolePermissionAudit(
    input.workspaceId,
    input.roleId,
    identity,
    {
      kind: 'fieldPermission',
      touchedFieldKeys,
      desiredActiveFieldKeys,
    },
    work,
  );
};

export const withRowLevelPermissionUpsertAudit = async <T>(
  input: {
    workspaceId: string;
    roleId: string;
    objectMetadataId: string;
    desiredGroupIds: readonly string[];
    desiredPredicateIds: readonly string[];
  },
  identity: RoleUpdateAuditIdentity,
  work: () => Promise<T>,
): Promise<T> => {
  const objectMetadataId = uuid(input.objectMetadataId);
  const desiredGroupIds = Object.freeze(
    [...new Set(input.desiredGroupIds.map(uuid))].sort(),
  );
  const desiredPredicateIds = Object.freeze(
    [...new Set(input.desiredPredicateIds.map(uuid))].sort(),
  );
  if (
    desiredGroupIds.length !== input.desiredGroupIds.length ||
    desiredPredicateIds.length !== input.desiredPredicateIds.length
  )
    throw new Error('Row level permission audit duplicate desired ID');
  return withRolePermissionAudit(
    input.workspaceId,
    input.roleId,
    identity,
    {
      kind: 'rowLevelPermissionPredicate',
      objectMetadataId,
      desiredGroupIds,
      desiredPredicateIds,
    },
    work,
  );
};

export const getRolePermissionAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (
    !active.has(request) ||
    request.operation.workspaceId !== uuid(workspaceId)
  )
    throw new Error(
      'Role permission audit scope is inactive or belongs to another workspace',
    );
  return request;
};

const scalarWithoutTimestamps = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'createdAt' && key !== 'updatedAt',
    ),
  );

const verifyRoleAndWorkspaceAndApplication = async (
  runner: QueryRunner,
  workspaceId: string,
  roleId: string,
  applicationId: string,
  applicationUniversalIdentifier: string,
): Promise<Record<string, unknown>> => {
  const [workspace] = await runner.query(
    `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`,
    [workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error('Role permission audit workspace unavailable');
  await verifyRoleAuditApplication(
    runner,
    workspaceId,
    applicationId,
    applicationUniversalIdentifier,
  );
  const roleRows = await runner.query(
    'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
    [workspaceId, roleId],
  );
  if (roleRows.length !== 1)
    throw new Error('Role permission audit persisted role unavailable');
  const role = roleRows[0].row as Record<string, unknown>;
  if (
    role.isEditable !== true ||
    uuid(String(role.applicationId)) !== applicationId
  )
    throw new Error(
      'Role permission audit persisted role is not editable or belongs to another application',
    );
  return role;
};

const projectRolePermissionFlag = (row: Record<string, unknown>) => ({
  roleId: uuid(String(row.roleId)),
  permissionFlagId: uuid(String(row.permissionFlagId)),
});

const projectObjectPermission = (row: Record<string, unknown>) => ({
  roleId: uuid(String(row.roleId)),
  objectMetadataId: uuid(String(row.objectMetadataId)),
  canReadObjectRecords:
    row.canReadObjectRecords === undefined ? null : row.canReadObjectRecords,
  canUpdateObjectRecords:
    row.canUpdateObjectRecords === undefined
      ? null
      : row.canUpdateObjectRecords,
  canSoftDeleteObjectRecords:
    row.canSoftDeleteObjectRecords === undefined
      ? null
      : row.canSoftDeleteObjectRecords,
  canDestroyObjectRecords:
    row.canDestroyObjectRecords === undefined
      ? null
      : row.canDestroyObjectRecords,
});

const projectFieldPermission = (row: Record<string, unknown>) => ({
  roleId: uuid(String(row.roleId)),
  objectMetadataId: uuid(String(row.objectMetadataId)),
  fieldMetadataId: uuid(String(row.fieldMetadataId)),
  canReadFieldValue:
    row.canReadFieldValue === undefined ? null : row.canReadFieldValue,
  canUpdateFieldValue:
    row.canUpdateFieldValue === undefined ? null : row.canUpdateFieldValue,
});

const projectPredicateGroup = (row: Record<string, unknown>) => ({
  roleId: uuid(String(row.roleId)),
  objectMetadataId: uuid(String(row.objectMetadataId)),
  parentRowLevelPermissionPredicateGroupId:
    row.parentRowLevelPermissionPredicateGroupId === undefined
      ? null
      : row.parentRowLevelPermissionPredicateGroupId,
  logicalOperator: row.logicalOperator,
  positionInRowLevelPermissionPredicateGroup:
    row.positionInRowLevelPermissionPredicateGroup === undefined
      ? null
      : row.positionInRowLevelPermissionPredicateGroup,
  deletedAt: row.deletedAt === undefined ? null : row.deletedAt,
});

const projectPredicate = (row: Record<string, unknown>) => ({
  roleId: uuid(String(row.roleId)),
  objectMetadataId: uuid(String(row.objectMetadataId)),
  fieldMetadataId: uuid(String(row.fieldMetadataId)),
  operand: row.operand,
  value: row.value === undefined ? null : row.value,
  subFieldName: row.subFieldName === undefined ? null : row.subFieldName,
  workspaceMemberFieldMetadataId:
    row.workspaceMemberFieldMetadataId === undefined
      ? null
      : row.workspaceMemberFieldMetadataId,
  workspaceMemberSubFieldName:
    row.workspaceMemberSubFieldName === undefined
      ? null
      : row.workspaceMemberSubFieldName,
  rowLevelPermissionPredicateGroupId:
    row.rowLevelPermissionPredicateGroupId === undefined
      ? null
      : row.rowLevelPermissionPredicateGroupId,
  positionInRowLevelPermissionPredicateGroup:
    row.positionInRowLevelPermissionPredicateGroup === undefined
      ? null
      : row.positionInRowLevelPermissionPredicateGroup,
  deletedAt: row.deletedAt === undefined ? null : row.deletedAt,
});

const runAuditedRolePermissionFlagUpsert = async <T>(
  dataSource: DataSource,
  request: Extract<RolePermissionAuditRequest, { kind: 'rolePermissionFlag' }>,
  actions: MigrationAction[],
  mappings: RolePermissionAuditMappings,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const creates = actions.filter(
    (action) =>
      action.metadataName === 'rolePermissionFlag' && action.type === 'create',
  );
  const deletes = actions.filter(
    (action) =>
      action.metadataName === 'rolePermissionFlag' && action.type === 'delete',
  );
  if (
    actions.length === 0 ||
    actions.length !== creates.length + deletes.length
  )
    throw new Error(
      'Role permission flag audit requires only rolePermissionFlag create/delete actions',
    );

  const plannedDeletes = deletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.rolePermissionFlags?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Role permission flag audit missing delete mapping');
    return { id: uuid(mappedId), universalIdentifier };
  });
  if (
    new Set(plannedDeletes.map((item) => item.id)).size !==
      plannedDeletes.length ||
    new Set(plannedDeletes.map((item) => item.universalIdentifier)).size !==
      plannedDeletes.length
  )
    throw new Error('Role permission flag audit duplicate delete action');

  const plannedCreates = creates.map((action) => {
    const input = action.flatEntity
      ? extractPlainObject(action.flatEntity)
      : undefined;
    if (!input || !action.id)
      throw new Error('Role permission flag audit requires enriched create');
    const id = uuid(action.id);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const permissionFlagUniversalIdentifier = uuid(
      String(input.permissionFlagUniversalIdentifier),
    );
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    const mappedPermissionFlagId =
      mappings.permissionFlags?.[permissionFlagUniversalIdentifier]?.id;
    if (
      !mappedRoleId ||
      uuid(mappedRoleId) !== request.roleId ||
      !mappedPermissionFlagId ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier
    )
      throw new Error(
        'Role permission flag audit invalid create relation mapping',
      );
    return {
      id,
      universalIdentifier,
      roleUniversalIdentifier,
      permissionFlagId: uuid(mappedPermissionFlagId),
      permissionFlagUniversalIdentifier,
      createdAt: requireTimestamp(input.createdAt),
      updatedAt: requireTimestamp(input.updatedAt),
    };
  });
  if (
    new Set(plannedCreates.map((item) => item.id)).size !==
      plannedCreates.length ||
    new Set(plannedCreates.map((item) => item.universalIdentifier)).size !==
      plannedCreates.length ||
    new Set(plannedCreates.map((item) => item.permissionFlagId)).size !==
      plannedCreates.length
  )
    throw new Error('Role permission flag audit duplicate create action');

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const beforeRole = await verifyRoleAndWorkspaceAndApplication(
      runner,
      request.operation.workspaceId,
      request.roleId,
      applicationId,
      applicationUniversalIdentifier,
    );
    const roleUniversalIdentifier = uuid(
      String(beforeRole.universalIdentifier),
    );
    if (
      plannedCreates.some(
        (item) => item.roleUniversalIdentifier !== roleUniversalIdentifier,
      )
    )
      throw new Error('Role permission flag audit role universalId mismatch');

    let callerHoldsRole = Boolean(
      request.actingRoleIds?.includes(request.roleId),
    );
    if (!callerHoldsRole && request.actingUserWorkspaceId) {
      const callerTargets = await runner.query(
        'SELECT id FROM core."roleTarget" WHERE "workspaceId"=$1 AND "userWorkspaceId"=$2 AND "roleId"=$3 FOR SHARE',
        [
          request.operation.workspaceId,
          request.actingUserWorkspaceId,
          request.roleId,
        ],
      );
      if (callerTargets.length > 0) callerHoldsRole = true;
    }
    if (
      callerHoldsRole &&
      beforeRole.canUpdateAllSettings !== true &&
      !request.permissionFlagKeys.includes('ROLES')
    )
      throw new Error(
        'Role permission flag audit cannot revoke caller settings access',
      );

    const readPermissionFlags = (lock = false) =>
      runner.query(
        `SELECT id,"workspaceId","universalIdentifier",key FROM core."permissionFlag" WHERE "workspaceId"=$1 ORDER BY id${lock ? ' FOR SHARE' : ''}`,
        [request.operation.workspaceId],
      );
    const lockedPermissionFlags: Record<string, unknown>[] =
      await readPermissionFlags(true);
    const flagByKey = new Map(
      lockedPermissionFlags.map((row) => [
        String(row.key),
        {
          id: uuid(String(row.id)),
          universalIdentifier: uuid(String(row.universalIdentifier)),
        },
      ]),
    );
    const desiredFlagIds = new Set<string>();
    for (const key of request.permissionFlagKeys) {
      const flag = flagByKey.get(key);
      if (!flag)
        throw new Error(
          'Role permission flag audit referenced permissionFlag unavailable',
        );
      desiredFlagIds.add(flag.id);
    }
    for (const create of plannedCreates) {
      const matchedFlag = lockedPermissionFlags.find(
        (row) => uuid(String(row.id)) === create.permissionFlagId,
      );
      if (
        !matchedFlag ||
        uuid(String(matchedFlag.universalIdentifier)) !==
          create.permissionFlagUniversalIdentifier ||
        !desiredFlagIds.has(create.permissionFlagId)
      )
        throw new Error(
          'Role permission flag audit create does not match locked permissionFlag',
        );
    }

    const readRolePermissionFlags = async (lock = false) => {
      const rows = await runner.query(
        `SELECT to_jsonb(f) AS row FROM core."rolePermissionFlag" f WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [
          request.operation.workspaceId,
          request.roleId,
          [
            ...plannedDeletes.map((item) => item.id),
            ...plannedCreates.map((item) => item.id),
          ],
        ],
      );
      return rows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      ) as Record<string, unknown>[];
    };
    const beforeRows = await readRolePermissionFlags(true);
    if (
      beforeRows.some(
        (row) =>
          uuid(String(row.roleId)) !== request.roleId ||
          plannedCreates.some((item) => item.id === uuid(String(row.id))),
      )
    )
      throw new Error(
        'Role permission flag audit foreign or colliding existing row',
      );
    const deleteIdSet = new Set(plannedDeletes.map((item) => item.id));
    for (const plannedDelete of plannedDeletes) {
      const match = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedDelete.universalIdentifier
      )
        throw new Error(
          'Role permission flag audit planned delete missing or mismatched',
        );
    }
    const keptRows = beforeRows.filter(
      (row) => !deleteIdSet.has(uuid(String(row.id))),
    );
    const keptFlagIds = new Set(
      keptRows.map((row) => uuid(String(row.permissionFlagId))),
    );
    if (
      beforeRows.some(
        (row) =>
          deleteIdSet.has(uuid(String(row.id))) ===
          desiredFlagIds.has(uuid(String(row.permissionFlagId))),
      ) ||
      keptFlagIds.size + plannedCreates.length !== desiredFlagIds.size ||
      plannedCreates.some((item) => keptFlagIds.has(item.permissionFlagId))
    )
      throw new Error(
        'Role permission flag audit plan diverges from persisted state',
      );

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const afterRows = await readRolePermissionFlags(false);
    if (
      afterRows.length !== keptRows.length + plannedCreates.length ||
      afterRows.some((row) => deleteIdSet.has(uuid(String(row.id))))
    )
      throw new Error('Role permission flag audit post-handler count mismatch');
    for (const kept of keptRows) {
      const actual = afterRows.find(
        (row) => uuid(String(row.id)) === uuid(String(kept.id)),
      );
      if (!actual || canonicalAuditJson(actual) !== canonicalAuditJson(kept))
        throw new Error('Role permission flag audit kept row changed');
    }
    for (const plannedCreate of plannedCreates) {
      const actual = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      );
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: request.roleId,
        permissionFlagId: plannedCreate.permissionFlagId,
      };
      if (
        !actual ||
        canonicalAuditJson(scalarWithoutTimestamps(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error('Role permission flag audit created row mismatch');
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."rolePermissionFlag" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error(
          'Role permission flag audit created timestamps changed',
        );
    }

    for (const plannedDelete of plannedDeletes) {
      const beforeRow = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      )!;
      audit.record({
        resourceKind: 'rolePermissionFlag',
        resourceId: plannedDelete.id,
        action: 'delete',
        before: projectRolePermissionFlag(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'rolePermissionFlag',
          resourceId: plannedDelete.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedCreate of plannedCreates) {
      const afterRow = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      )!;
      audit.record({
        resourceKind: 'rolePermissionFlag',
        resourceId: plannedCreate.id,
        action: 'create',
        before: null,
        after: projectRolePermissionFlag(afterRow),
        securityDescriptor: {
          resourceKind: 'rolePermissionFlag',
          resourceId: plannedCreate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    await audit.flush();

    const [currentRole] = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
      [request.operation.workspaceId, request.roleId],
    );
    if (
      !currentRole ||
      canonicalAuditJson(currentRole.row) !== canonicalAuditJson(beforeRole) ||
      canonicalAuditJson(await readRolePermissionFlags(false)) !==
        canonicalAuditJson(afterRows) ||
      canonicalAuditJson(await readPermissionFlags(false)) !==
        canonicalAuditJson(lockedPermissionFlags)
    )
      throw new Error(
        'Role permission flag audit persisted state changed during flush',
      );
    await verifyRoleAuditApplication(
      runner,
      request.operation.workspaceId,
      applicationId,
      applicationUniversalIdentifier,
    );
    return result;
  });
};

const OBJECT_PERMISSION_BOOLEAN_FIELDS = [
  'canReadObjectRecords',
  'canUpdateObjectRecords',
  'canSoftDeleteObjectRecords',
  'canDestroyObjectRecords',
] as const;

const runAuditedObjectPermissionUpsert = async <T>(
  dataSource: DataSource,
  request: Extract<RolePermissionAuditRequest, { kind: 'objectPermission' }>,
  actions: MigrationAction[],
  mappings: RolePermissionAuditMappings,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const creates = actions.filter(
    (action) =>
      action.metadataName === 'objectPermission' && action.type === 'create',
  );
  const updates = actions.filter(
    (action) =>
      action.metadataName === 'objectPermission' && action.type === 'update',
  );
  const deletes = actions.filter(
    (action) =>
      action.metadataName === 'objectPermission' && action.type === 'delete',
  );
  if (
    actions.length === 0 ||
    actions.length !== creates.length + updates.length + deletes.length
  )
    throw new Error(
      'Object permission audit requires only objectPermission create/update/delete actions',
    );

  const plannedDeletes = deletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.objectPermissions?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Object permission audit missing delete mapping');
    return { id: uuid(mappedId), universalIdentifier };
  });
  const plannedUpdates = updates.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.objectPermissions?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Object permission audit missing update mapping');
    const rawUpdate = extractPlainObject(action.update);
    const update: Record<string, boolean | null> = {};
    for (const [key, value] of Object.entries(rawUpdate)) {
      if (
        !(OBJECT_PERMISSION_BOOLEAN_FIELDS as readonly string[]).includes(
          key,
        ) ||
        (typeof value !== 'boolean' && value !== null)
      )
        throw new Error('Object permission audit update field is unsupported');
      update[key] = value;
    }
    if (Object.keys(update).length === 0)
      throw new Error('Object permission audit empty update action');
    return { id: uuid(mappedId), universalIdentifier, update };
  });
  const plannedCreates = creates.map((action) => {
    const input = action.flatEntity
      ? extractPlainObject(action.flatEntity)
      : undefined;
    if (!input || !action.id)
      throw new Error('Object permission audit requires enriched create');
    const id = uuid(action.id);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const objectMetadataUniversalIdentifier = uuid(
      String(input.objectMetadataUniversalIdentifier),
    );
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    const mappedObjectId =
      mappings.objectMetadatas?.[objectMetadataUniversalIdentifier]?.id;
    if (
      !mappedRoleId ||
      uuid(mappedRoleId) !== request.roleId ||
      !mappedObjectId ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier
    )
      throw new Error(
        'Object permission audit invalid create relation mapping',
      );
    const booleans = {} as Record<
      (typeof OBJECT_PERMISSION_BOOLEAN_FIELDS)[number],
      boolean | null
    >;
    for (const key of OBJECT_PERMISSION_BOOLEAN_FIELDS) {
      const value = input[key] ?? null;
      if (typeof value !== 'boolean' && value !== null)
        throw new Error('Object permission audit invalid create boolean');
      booleans[key] = value;
    }
    return {
      id,
      universalIdentifier,
      roleUniversalIdentifier,
      objectMetadataId: uuid(mappedObjectId),
      objectMetadataUniversalIdentifier,
      ...booleans,
      createdAt: requireTimestamp(input.createdAt),
      updatedAt: requireTimestamp(input.updatedAt),
    };
  });

  const allTouchedIds = [
    ...plannedDeletes.map((item) => item.id),
    ...plannedUpdates.map((item) => item.id),
    ...plannedCreates.map((item) => item.id),
  ];
  const allTouchedUniversalIds = [
    ...plannedDeletes.map((item) => item.universalIdentifier),
    ...plannedUpdates.map((item) => item.universalIdentifier),
    ...plannedCreates.map((item) => item.universalIdentifier),
  ];
  if (
    new Set(allTouchedIds).size !== allTouchedIds.length ||
    new Set(allTouchedUniversalIds).size !== allTouchedUniversalIds.length ||
    new Set(plannedCreates.map((item) => item.objectMetadataId)).size !==
      plannedCreates.length
  )
    throw new Error('Object permission audit duplicate action target');

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const beforeRole = await verifyRoleAndWorkspaceAndApplication(
      runner,
      request.operation.workspaceId,
      request.roleId,
      applicationId,
      applicationUniversalIdentifier,
    );
    const roleUniversalIdentifier = uuid(
      String(beforeRole.universalIdentifier),
    );
    if (
      plannedCreates.some(
        (item) => item.roleUniversalIdentifier !== roleUniversalIdentifier,
      )
    )
      throw new Error('Object permission audit role universalId mismatch');

    const readObjectPermissions = async (lock = false) => {
      const rows = await runner.query(
        `SELECT to_jsonb(op) AS row FROM core."objectPermission" op WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [request.operation.workspaceId, request.roleId, allTouchedIds],
      );
      return rows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      ) as Record<string, unknown>[];
    };
    const beforeRows = await readObjectPermissions(true);
    if (
      beforeRows.some(
        (row) =>
          uuid(String(row.roleId)) !== request.roleId ||
          plannedCreates.some((item) => item.id === uuid(String(row.id))),
      )
    )
      throw new Error(
        'Object permission audit foreign or colliding existing row',
      );

    const objectMetadataIds = [
      ...new Set([
        ...request.desiredObjectMetadataIds,
        ...beforeRows.map((row) => uuid(String(row.objectMetadataId))),
        ...plannedCreates.map((item) => item.objectMetadataId),
      ]),
    ].sort();
    const readObjectMetadatas = (lock = false) =>
      objectMetadataIds.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : runner.query(
            `SELECT id,"workspaceId","universalIdentifier" FROM core."objectMetadata" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, objectMetadataIds],
          );
    const lockedObjects = await readObjectMetadatas(true);
    if (lockedObjects.length !== objectMetadataIds.length)
      throw new Error(
        'Object permission audit referenced objectMetadata unavailable',
      );
    for (const create of plannedCreates) {
      const matchedObject = lockedObjects.find(
        (row: Record<string, unknown>) =>
          uuid(String(row.id)) === create.objectMetadataId,
      );
      if (
        !matchedObject ||
        uuid(String(matchedObject.universalIdentifier)) !==
          create.objectMetadataUniversalIdentifier
      )
        throw new Error(
          'Object permission audit create objectMetadata universalId mismatch',
        );
    }

    const desiredObjectSet = new Set(request.desiredObjectMetadataIds);
    const deleteIdSet = new Set(plannedDeletes.map((item) => item.id));
    const updateById = new Map(plannedUpdates.map((item) => [item.id, item]));
    for (const plannedDelete of plannedDeletes) {
      const match = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedDelete.universalIdentifier
      )
        throw new Error(
          'Object permission audit planned delete missing or mismatched',
        );
    }
    for (const plannedUpdate of plannedUpdates) {
      const match = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedUpdate.universalIdentifier ||
        !desiredObjectSet.has(uuid(String(match.objectMetadataId)))
      )
        throw new Error(
          'Object permission audit planned update missing or mismatched',
        );
    }
    const survivingRows = beforeRows.filter(
      (row) => !deleteIdSet.has(uuid(String(row.id))),
    );
    const survivingObjectIds = new Set(
      survivingRows.map((row) => uuid(String(row.objectMetadataId))),
    );
    if (
      beforeRows.some(
        (row) =>
          deleteIdSet.has(uuid(String(row.id))) ===
          desiredObjectSet.has(uuid(String(row.objectMetadataId))),
      ) ||
      survivingObjectIds.size + plannedCreates.length !==
        desiredObjectSet.size ||
      plannedCreates.some(
        (item) =>
          !desiredObjectSet.has(item.objectMetadataId) ||
          survivingObjectIds.has(item.objectMetadataId),
      )
    )
      throw new Error(
        'Object permission audit plan diverges from persisted state',
      );

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const afterRows = await readObjectPermissions(false);
    if (
      afterRows.length !== survivingRows.length + plannedCreates.length ||
      afterRows.some((row) => deleteIdSet.has(uuid(String(row.id))))
    )
      throw new Error('Object permission audit post-handler count mismatch');

    for (const beforeRow of survivingRows) {
      const id = uuid(String(beforeRow.id));
      const actual = afterRows.find((row) => uuid(String(row.id)) === id);
      const plannedUpdate = updateById.get(id);
      const expected = plannedUpdate
        ? {
            ...beforeRow,
            ...plannedUpdate.update,
            updatedAt: actual?.updatedAt,
          }
        : beforeRow;
      if (
        !actual ||
        canonicalAuditJson(actual) !== canonicalAuditJson(expected)
      )
        throw new Error('Object permission audit updated or kept row mismatch');
    }
    for (const plannedCreate of plannedCreates) {
      const actual = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      );
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: request.roleId,
        objectMetadataId: plannedCreate.objectMetadataId,
        canReadObjectRecords: plannedCreate.canReadObjectRecords,
        canUpdateObjectRecords: plannedCreate.canUpdateObjectRecords,
        canSoftDeleteObjectRecords: plannedCreate.canSoftDeleteObjectRecords,
        canDestroyObjectRecords: plannedCreate.canDestroyObjectRecords,
      };
      if (
        !actual ||
        canonicalAuditJson(scalarWithoutTimestamps(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error('Object permission audit created row mismatch');
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."objectPermission" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error('Object permission audit created timestamps changed');
    }

    for (const afterRow of afterRows) {
      const canRead =
        afterRow.canReadObjectRecords ?? beforeRole.canReadAllObjectRecords;
      const canUpdate =
        afterRow.canUpdateObjectRecords ?? beforeRole.canUpdateAllObjectRecords;
      const canSoftDelete =
        afterRow.canSoftDeleteObjectRecords ??
        beforeRole.canSoftDeleteAllObjectRecords;
      const canDestroy =
        afterRow.canDestroyObjectRecords ??
        beforeRole.canDestroyAllObjectRecords;
      if (
        canRead === false &&
        (canUpdate === true || canSoftDelete === true || canDestroy === true)
      )
        throw new Error(
          'Object permission audit read/write consistency violated',
        );
    }

    for (const plannedDelete of plannedDeletes) {
      const beforeRow = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      )!;
      audit.record({
        resourceKind: 'objectPermission',
        resourceId: plannedDelete.id,
        action: 'delete',
        before: projectObjectPermission(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'objectPermission',
          resourceId: plannedDelete.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedUpdate of plannedUpdates) {
      const beforeRow = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      const afterRow = afterRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      audit.record({
        resourceKind: 'objectPermission',
        resourceId: plannedUpdate.id,
        action: 'update',
        before: projectObjectPermission(beforeRow),
        after: projectObjectPermission(afterRow),
        securityDescriptor: {
          resourceKind: 'objectPermission',
          resourceId: plannedUpdate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedCreate of plannedCreates) {
      const afterRow = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      )!;
      audit.record({
        resourceKind: 'objectPermission',
        resourceId: plannedCreate.id,
        action: 'create',
        before: null,
        after: projectObjectPermission(afterRow),
        securityDescriptor: {
          resourceKind: 'objectPermission',
          resourceId: plannedCreate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    await audit.flush();

    const [currentRole] = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
      [request.operation.workspaceId, request.roleId],
    );
    if (
      !currentRole ||
      canonicalAuditJson(currentRole.row) !== canonicalAuditJson(beforeRole) ||
      canonicalAuditJson(await readObjectPermissions(false)) !==
        canonicalAuditJson(afterRows) ||
      canonicalAuditJson(await readObjectMetadatas(false)) !==
        canonicalAuditJson(lockedObjects)
    )
      throw new Error(
        'Object permission audit persisted state changed during flush',
      );
    await verifyRoleAuditApplication(
      runner,
      request.operation.workspaceId,
      applicationId,
      applicationUniversalIdentifier,
    );
    return result;
  });
};

const FIELD_PERMISSION_BOOLEAN_FIELDS = [
  'canReadFieldValue',
  'canUpdateFieldValue',
] as const;

const runAuditedFieldPermissionUpsert = async <T>(
  dataSource: DataSource,
  request: Extract<RolePermissionAuditRequest, { kind: 'fieldPermission' }>,
  actions: MigrationAction[],
  mappings: RolePermissionAuditMappings,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const creates = actions.filter(
    (action) =>
      action.metadataName === 'fieldPermission' && action.type === 'create',
  );
  const updates = actions.filter(
    (action) =>
      action.metadataName === 'fieldPermission' && action.type === 'update',
  );
  const deletes = actions.filter(
    (action) =>
      action.metadataName === 'fieldPermission' && action.type === 'delete',
  );
  if (
    actions.length === 0 ||
    actions.length !== creates.length + updates.length + deletes.length
  )
    throw new Error(
      'Field permission audit requires only fieldPermission create/update/delete actions',
    );

  const plannedDeletes = deletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.fieldPermissions?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Field permission audit missing delete mapping');
    return { id: uuid(mappedId), universalIdentifier };
  });
  const plannedUpdates = updates.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId = mappings.fieldPermissions?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error('Field permission audit missing update mapping');
    const rawUpdate = extractPlainObject(action.update);
    const update: Record<string, boolean | null> = {};
    for (const [key, value] of Object.entries(rawUpdate)) {
      if (
        !(FIELD_PERMISSION_BOOLEAN_FIELDS as readonly string[]).includes(key) ||
        (value !== false && value !== null)
      )
        throw new Error('Field permission audit update field is unsupported');
      update[key] = value;
    }
    if (Object.keys(update).length === 0)
      throw new Error('Field permission audit empty update action');
    return { id: uuid(mappedId), universalIdentifier, update };
  });
  const plannedCreates = creates.map((action) => {
    const input = action.flatEntity
      ? extractPlainObject(action.flatEntity)
      : undefined;
    if (!input || !action.id)
      throw new Error('Field permission audit requires enriched create');
    const id = uuid(action.id);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const objectMetadataUniversalIdentifier = uuid(
      String(input.objectMetadataUniversalIdentifier),
    );
    const fieldMetadataUniversalIdentifier = uuid(
      String(input.fieldMetadataUniversalIdentifier),
    );
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    const mappedObjectId =
      mappings.objectMetadatas?.[objectMetadataUniversalIdentifier]?.id;
    const mappedFieldId =
      mappings.fieldMetadatas?.[fieldMetadataUniversalIdentifier]?.id;
    if (
      !mappedRoleId ||
      uuid(mappedRoleId) !== request.roleId ||
      !mappedObjectId ||
      !mappedFieldId ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier
    )
      throw new Error('Field permission audit invalid create relation mapping');
    const canReadFieldValue = input.canReadFieldValue ?? null;
    const canUpdateFieldValue = input.canUpdateFieldValue ?? null;
    if (
      (canReadFieldValue !== false && canReadFieldValue !== null) ||
      (canUpdateFieldValue !== false && canUpdateFieldValue !== null) ||
      (canReadFieldValue === null && canUpdateFieldValue === null)
    )
      throw new Error('Field permission audit invalid create restriction');
    return {
      id,
      universalIdentifier,
      roleUniversalIdentifier,
      objectMetadataId: uuid(mappedObjectId),
      objectMetadataUniversalIdentifier,
      fieldMetadataId: uuid(mappedFieldId),
      fieldMetadataUniversalIdentifier,
      canReadFieldValue,
      canUpdateFieldValue,
      createdAt: requireTimestamp(input.createdAt),
      updatedAt: requireTimestamp(input.updatedAt),
    };
  });

  const allTouchedIds = [
    ...plannedDeletes.map((item) => item.id),
    ...plannedUpdates.map((item) => item.id),
    ...plannedCreates.map((item) => item.id),
  ];
  const allTouchedUniversalIds = [
    ...plannedDeletes.map((item) => item.universalIdentifier),
    ...plannedUpdates.map((item) => item.universalIdentifier),
    ...plannedCreates.map((item) => item.universalIdentifier),
  ];
  if (
    new Set(allTouchedIds).size !== allTouchedIds.length ||
    new Set(allTouchedUniversalIds).size !== allTouchedUniversalIds.length ||
    new Set(plannedCreates.map((item) => item.fieldMetadataId)).size !==
      plannedCreates.length
  )
    throw new Error('Field permission audit duplicate action target');

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const beforeRole = await verifyRoleAndWorkspaceAndApplication(
      runner,
      request.operation.workspaceId,
      request.roleId,
      applicationId,
      applicationUniversalIdentifier,
    );
    const roleUniversalIdentifier = uuid(
      String(beforeRole.universalIdentifier),
    );
    if (
      plannedCreates.some(
        (item) => item.roleUniversalIdentifier !== roleUniversalIdentifier,
      )
    )
      throw new Error('Field permission audit role universalId mismatch');

    const readFieldPermissions = async (lock = false) => {
      const rows = await runner.query(
        `SELECT to_jsonb(fp) AS row FROM core."fieldPermission" fp WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [request.operation.workspaceId, request.roleId, allTouchedIds],
      );
      return rows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      ) as Record<string, unknown>[];
    };
    const beforeRows = await readFieldPermissions(true);
    if (
      beforeRows.some(
        (row) =>
          uuid(String(row.roleId)) !== request.roleId ||
          plannedCreates.some((item) => item.id === uuid(String(row.id))),
      )
    )
      throw new Error(
        'Field permission audit foreign or colliding existing row',
      );

    const touchedSet = new Set(request.touchedFieldKeys);
    const desiredActiveSet = new Set(request.desiredActiveFieldKeys);
    const deleteIdSet = new Set(plannedDeletes.map((item) => item.id));
    const updateById = new Map(plannedUpdates.map((item) => [item.id, item]));
    const rowPairKey = (row: Record<string, unknown>) =>
      `${uuid(String(row.objectMetadataId))}:${uuid(String(row.fieldMetadataId))}`;

    for (const plannedDelete of plannedDeletes) {
      const match = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedDelete.universalIdentifier ||
        !touchedSet.has(rowPairKey(match)) ||
        desiredActiveSet.has(rowPairKey(match))
      )
        throw new Error(
          'Field permission audit planned delete missing or mismatched',
        );
    }
    for (const plannedUpdate of plannedUpdates) {
      const match = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedUpdate.universalIdentifier ||
        !desiredActiveSet.has(rowPairKey(match))
      )
        throw new Error(
          'Field permission audit planned update missing or mismatched',
        );
    }
    for (const beforeRow of beforeRows) {
      const id = uuid(String(beforeRow.id));
      const key = rowPairKey(beforeRow);
      if (!touchedSet.has(key)) {
        if (deleteIdSet.has(id) || updateById.has(id))
          throw new Error(
            'Field permission audit modified untargeted fieldPermission row',
          );
      } else if (
        desiredActiveSet.has(key) ? deleteIdSet.has(id) : !deleteIdSet.has(id)
      ) {
        throw new Error(
          'Field permission audit touched row does not match desired active set',
        );
      }
    }
    const existingActiveKeys = new Set(
      beforeRows
        .filter((row) => !deleteIdSet.has(uuid(String(row.id))))
        .map(rowPairKey),
    );
    for (const create of plannedCreates) {
      const key = `${create.objectMetadataId}:${create.fieldMetadataId}`;
      if (!desiredActiveSet.has(key) || existingActiveKeys.has(key))
        throw new Error(
          'Field permission audit create does not match desired active set',
        );
    }
    for (const activeKey of desiredActiveSet) {
      if (
        !existingActiveKeys.has(activeKey) &&
        !plannedCreates.some(
          (item) =>
            `${item.objectMetadataId}:${item.fieldMetadataId}` === activeKey,
        )
      )
        throw new Error(
          'Field permission audit missing create for desired active field',
        );
    }

    const touchedObjectIds = [
      ...new Set([
        ...request.touchedFieldKeys.map((key) => key.split(':')[0]),
        ...plannedCreates.map((item) => item.objectMetadataId),
      ]),
    ].sort();
    const touchedFieldIds = [
      ...new Set([
        ...request.touchedFieldKeys.map((key) => key.split(':')[1]),
        ...plannedCreates.map((item) => item.fieldMetadataId),
      ]),
    ].sort();
    const readObjectMetadatas = (lock = false) =>
      touchedObjectIds.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : runner.query(
            `SELECT id,"workspaceId","universalIdentifier","isSystem" FROM core."objectMetadata" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, touchedObjectIds],
          );
    const readFieldMetadatas = (lock = false) =>
      touchedFieldIds.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : runner.query(
            `SELECT id,"workspaceId","universalIdentifier","objectMetadataId" FROM core."fieldMetadata" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, touchedFieldIds],
          );
    const lockedObjects = await readObjectMetadatas(true);
    const lockedFields = await readFieldMetadatas(true);
    if (
      lockedObjects.length !== touchedObjectIds.length ||
      lockedObjects.some(
        (row: Record<string, unknown>) => row.isSystem === true,
      ) ||
      lockedFields.length !== touchedFieldIds.length
    )
      throw new Error(
        'Field permission audit referenced objectMetadata/fieldMetadata unavailable or system',
      );
    for (const pair of request.touchedFieldKeys) {
      const [objectId, fieldId] = pair.split(':');
      const field = lockedFields.find(
        (row: Record<string, unknown>) => uuid(String(row.id)) === fieldId,
      );
      if (!field || uuid(String(field.objectMetadataId)) !== objectId)
        throw new Error(
          'Field permission audit fieldMetadata does not belong to objectMetadata',
        );
    }
    for (const create of plannedCreates) {
      const matchedObject = lockedObjects.find(
        (row: Record<string, unknown>) =>
          uuid(String(row.id)) === create.objectMetadataId,
      );
      const matchedField = lockedFields.find(
        (row: Record<string, unknown>) =>
          uuid(String(row.id)) === create.fieldMetadataId,
      );
      if (
        !matchedObject ||
        uuid(String(matchedObject.universalIdentifier)) !==
          create.objectMetadataUniversalIdentifier ||
        !matchedField ||
        uuid(String(matchedField.universalIdentifier)) !==
          create.fieldMetadataUniversalIdentifier
      )
        throw new Error('Field permission audit create universalId mismatch');
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const afterRows = await readFieldPermissions(false);
    const survivingRows = beforeRows.filter(
      (row) => !deleteIdSet.has(uuid(String(row.id))),
    );
    if (
      afterRows.length !== survivingRows.length + plannedCreates.length ||
      afterRows.some((row) => deleteIdSet.has(uuid(String(row.id))))
    )
      throw new Error('Field permission audit post-handler count mismatch');

    for (const beforeRow of survivingRows) {
      const id = uuid(String(beforeRow.id));
      const actual = afterRows.find((row) => uuid(String(row.id)) === id);
      const plannedUpdate = updateById.get(id);
      const expected = plannedUpdate
        ? {
            ...beforeRow,
            ...plannedUpdate.update,
            updatedAt: actual?.updatedAt,
          }
        : beforeRow;
      if (
        !actual ||
        canonicalAuditJson(actual) !== canonicalAuditJson(expected) ||
        (plannedUpdate &&
          actual.canReadFieldValue === null &&
          actual.canUpdateFieldValue === null)
      )
        throw new Error('Field permission audit updated or kept row mismatch');
    }
    for (const plannedCreate of plannedCreates) {
      const actual = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      );
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: request.roleId,
        objectMetadataId: plannedCreate.objectMetadataId,
        fieldMetadataId: plannedCreate.fieldMetadataId,
        canReadFieldValue: plannedCreate.canReadFieldValue,
        canUpdateFieldValue: plannedCreate.canUpdateFieldValue,
      };
      if (
        !actual ||
        canonicalAuditJson(scalarWithoutTimestamps(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error('Field permission audit created row mismatch');
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."fieldPermission" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error('Field permission audit created timestamps changed');
    }

    for (const plannedDelete of plannedDeletes) {
      const beforeRow = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      )!;
      audit.record({
        resourceKind: 'fieldPermission',
        resourceId: plannedDelete.id,
        action: 'delete',
        before: projectFieldPermission(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'fieldPermission',
          resourceId: plannedDelete.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedUpdate of plannedUpdates) {
      const beforeRow = beforeRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      const afterRow = afterRows.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      audit.record({
        resourceKind: 'fieldPermission',
        resourceId: plannedUpdate.id,
        action: 'update',
        before: projectFieldPermission(beforeRow),
        after: projectFieldPermission(afterRow),
        securityDescriptor: {
          resourceKind: 'fieldPermission',
          resourceId: plannedUpdate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedCreate of plannedCreates) {
      const afterRow = afterRows.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      )!;
      audit.record({
        resourceKind: 'fieldPermission',
        resourceId: plannedCreate.id,
        action: 'create',
        before: null,
        after: projectFieldPermission(afterRow),
        securityDescriptor: {
          resourceKind: 'fieldPermission',
          resourceId: plannedCreate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    await audit.flush();

    const [currentRole] = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
      [request.operation.workspaceId, request.roleId],
    );
    if (
      !currentRole ||
      canonicalAuditJson(currentRole.row) !== canonicalAuditJson(beforeRole) ||
      canonicalAuditJson(await readFieldPermissions(false)) !==
        canonicalAuditJson(afterRows) ||
      canonicalAuditJson(await readObjectMetadatas(false)) !==
        canonicalAuditJson(lockedObjects) ||
      canonicalAuditJson(await readFieldMetadatas(false)) !==
        canonicalAuditJson(lockedFields)
    )
      throw new Error(
        'Field permission audit persisted state changed during flush',
      );
    await verifyRoleAuditApplication(
      runner,
      request.operation.workspaceId,
      applicationId,
      applicationUniversalIdentifier,
    );
    return result;
  });
};

const runAuditedRowLevelPermissionUpsert = async <T>(
  dataSource: DataSource,
  request: Extract<
    RolePermissionAuditRequest,
    { kind: 'rowLevelPermissionPredicate' }
  >,
  actions: MigrationAction[],
  mappings: RolePermissionAuditMappings,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  const applicationId = uuid(mappings.application.id);
  const applicationUniversalIdentifier = uuid(
    mappings.application.universalIdentifier,
  );
  const groupCreates = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicateGroup' &&
      action.type === 'create',
  );
  const groupUpdates = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicateGroup' &&
      action.type === 'update',
  );
  const groupDeletes = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicateGroup' &&
      action.type === 'delete',
  );
  const predicateCreates = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicate' &&
      action.type === 'create',
  );
  const predicateUpdates = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicate' &&
      action.type === 'update',
  );
  const predicateDeletes = actions.filter(
    (action) =>
      action.metadataName === 'rowLevelPermissionPredicate' &&
      action.type === 'delete',
  );
  if (
    actions.length === 0 ||
    actions.length !==
      groupCreates.length +
        groupUpdates.length +
        groupDeletes.length +
        predicateCreates.length +
        predicateUpdates.length +
        predicateDeletes.length
  )
    throw new Error(
      'Row level permission audit requires only predicateGroup and predicate actions',
    );

  const createdGroupIdByUniversalId = new Map<string, string>();
  for (const action of groupCreates) {
    const input = action.flatEntity
      ? extractPlainObject(action.flatEntity)
      : undefined;
    if (!input || !action.id)
      throw new Error(
        'Row level permission audit requires enriched group create',
      );
    createdGroupIdByUniversalId.set(
      uuid(String(input.universalIdentifier)),
      uuid(action.id),
    );
  }
  const resolveGroupId = (universalId: unknown): string | null => {
    const normalized = optionalUuid(universalId);
    if (!normalized) return null;
    const mapped =
      mappings.rowLevelPermissionPredicateGroups?.[normalized]?.id ??
      createdGroupIdByUniversalId.get(normalized);
    if (!mapped)
      throw new Error('Row level permission audit unresolved group reference');
    return uuid(mapped);
  };

  const plannedGroupDeletes = groupDeletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId =
      mappings.rowLevelPermissionPredicateGroups?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error(
        'Row level permission audit missing group delete mapping',
      );
    return { id: uuid(mappedId), universalIdentifier };
  });
  const plannedGroupUpdates = groupUpdates.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId =
      mappings.rowLevelPermissionPredicateGroups?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error(
        'Row level permission audit missing group update mapping',
      );
    const rawUpdate = extractPlainObject(action.update);
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawUpdate)) {
      if (key === 'logicalOperator') {
        if (value !== 'AND' && value !== 'OR')
          throw new Error('Row level permission audit invalid group operator');
        update.logicalOperator = value;
      } else if (key === 'positionInRowLevelPermissionPredicateGroup') {
        if (typeof value !== 'number' && value !== null)
          throw new Error('Row level permission audit invalid group position');
        update.positionInRowLevelPermissionPredicateGroup = value;
      } else if (
        key === 'parentRowLevelPermissionPredicateGroupUniversalIdentifier'
      ) {
        update.parentRowLevelPermissionPredicateGroupId = resolveGroupId(value);
      } else {
        throw new Error(
          'Row level permission audit unsupported group update field',
        );
      }
    }
    if (Object.keys(update).length === 0)
      throw new Error('Row level permission audit empty group update');
    return { id: uuid(mappedId), universalIdentifier, update };
  });
  const plannedGroupCreates = groupCreates.map((action) => {
    const input = extractPlainObject(action.flatEntity);
    const id = uuid(action.id!);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const objectMetadataUniversalIdentifier = uuid(
      String(input.objectMetadataUniversalIdentifier),
    );
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    const mappedObjectId =
      mappings.objectMetadatas?.[objectMetadataUniversalIdentifier]?.id;
    if (
      !mappedRoleId ||
      uuid(mappedRoleId) !== request.roleId ||
      !mappedObjectId ||
      uuid(mappedObjectId) !== request.objectMetadataId ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier ||
      (input.logicalOperator !== 'AND' && input.logicalOperator !== 'OR') ||
      (input.positionInRowLevelPermissionPredicateGroup !== null &&
        input.positionInRowLevelPermissionPredicateGroup !== undefined &&
        typeof input.positionInRowLevelPermissionPredicateGroup !== 'number') ||
      (input.deletedAt !== null && input.deletedAt !== undefined)
    )
      throw new Error('Row level permission audit invalid group create');
    return {
      id,
      universalIdentifier,
      roleUniversalIdentifier,
      objectMetadataUniversalIdentifier,
      parentRowLevelPermissionPredicateGroupId: resolveGroupId(
        input.parentRowLevelPermissionPredicateGroupUniversalIdentifier,
      ),
      logicalOperator: input.logicalOperator,
      positionInRowLevelPermissionPredicateGroup:
        input.positionInRowLevelPermissionPredicateGroup ?? null,
      deletedAt: null,
      createdAt: requireTimestamp(input.createdAt),
      updatedAt: requireTimestamp(input.updatedAt),
    };
  });

  const plannedPredicateDeletes = predicateDeletes.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId =
      mappings.rowLevelPermissionPredicates?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error(
        'Row level permission audit missing predicate delete mapping',
      );
    return { id: uuid(mappedId), universalIdentifier };
  });
  const plannedPredicateUpdates = predicateUpdates.map((action) => {
    const universalIdentifier = uuid(action.universalIdentifier!);
    const mappedId =
      mappings.rowLevelPermissionPredicates?.[universalIdentifier]?.id;
    if (!mappedId)
      throw new Error(
        'Row level permission audit missing predicate update mapping',
      );
    const rawUpdate = extractPlainObject(action.update);
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawUpdate)) {
      if (key === 'fieldMetadataUniversalIdentifier') {
        const mappedFieldId =
          mappings.fieldMetadatas?.[uuid(String(value))]?.id;
        if (!mappedFieldId)
          throw new Error(
            'Row level permission audit unresolved fieldMetadata',
          );
        update.fieldMetadataId = uuid(mappedFieldId);
      } else if (key === 'workspaceMemberFieldMetadataUniversalIdentifier') {
        if (value === null) {
          update.workspaceMemberFieldMetadataId = null;
        } else {
          const mappedMemberFieldId =
            mappings.fieldMetadatas?.[uuid(String(value))]?.id;
          if (!mappedMemberFieldId)
            throw new Error(
              'Row level permission audit unresolved workspaceMember fieldMetadata',
            );
          update.workspaceMemberFieldMetadataId = uuid(mappedMemberFieldId);
        }
      } else if (
        key === 'rowLevelPermissionPredicateGroupUniversalIdentifier'
      ) {
        update.rowLevelPermissionPredicateGroupId = resolveGroupId(value);
      } else if (key === 'operand') {
        if (typeof value !== 'string' || value.length === 0)
          throw new Error('Row level permission audit invalid operand');
        update.operand = value;
      } else if (key === 'value') {
        update.value = value ?? null;
      } else if (
        key === 'subFieldName' ||
        key === 'workspaceMemberSubFieldName'
      ) {
        if (typeof value !== 'string' && value !== null)
          throw new Error('Row level permission audit invalid subFieldName');
        update[key] = value;
      } else if (key === 'positionInRowLevelPermissionPredicateGroup') {
        if (typeof value !== 'number' && value !== null)
          throw new Error(
            'Row level permission audit invalid predicate position',
          );
        update.positionInRowLevelPermissionPredicateGroup = value;
      } else {
        throw new Error(
          'Row level permission audit unsupported predicate update field',
        );
      }
    }
    if (Object.keys(update).length === 0)
      throw new Error('Row level permission audit empty predicate update');
    return { id: uuid(mappedId), universalIdentifier, update };
  });
  const plannedPredicateCreates = predicateCreates.map((action) => {
    const input = action.flatEntity
      ? extractPlainObject(action.flatEntity)
      : undefined;
    if (!input || !action.id)
      throw new Error(
        'Row level permission audit requires enriched predicate create',
      );
    const id = uuid(action.id);
    const universalIdentifier = uuid(String(input.universalIdentifier));
    const roleUniversalIdentifier = uuid(String(input.roleUniversalIdentifier));
    const objectMetadataUniversalIdentifier = uuid(
      String(input.objectMetadataUniversalIdentifier),
    );
    const fieldMetadataUniversalIdentifier = uuid(
      String(input.fieldMetadataUniversalIdentifier),
    );
    const mappedRoleId = mappings.roles[roleUniversalIdentifier]?.id;
    const mappedObjectId =
      mappings.objectMetadatas?.[objectMetadataUniversalIdentifier]?.id;
    const mappedFieldId =
      mappings.fieldMetadatas?.[fieldMetadataUniversalIdentifier]?.id;
    const memberFieldUniversalId = optionalUuid(
      input.workspaceMemberFieldMetadataUniversalIdentifier,
    );
    const mappedMemberFieldId = memberFieldUniversalId
      ? mappings.fieldMetadatas?.[memberFieldUniversalId]?.id
      : null;
    if (
      !mappedRoleId ||
      uuid(mappedRoleId) !== request.roleId ||
      !mappedObjectId ||
      uuid(mappedObjectId) !== request.objectMetadataId ||
      !mappedFieldId ||
      (memberFieldUniversalId !== null && !mappedMemberFieldId) ||
      uuid(String(input.applicationUniversalIdentifier)) !==
        applicationUniversalIdentifier ||
      typeof input.operand !== 'string' ||
      input.operand.length === 0 ||
      (input.subFieldName !== null &&
        input.subFieldName !== undefined &&
        typeof input.subFieldName !== 'string') ||
      (input.workspaceMemberSubFieldName !== null &&
        input.workspaceMemberSubFieldName !== undefined &&
        typeof input.workspaceMemberSubFieldName !== 'string') ||
      (input.positionInRowLevelPermissionPredicateGroup !== null &&
        input.positionInRowLevelPermissionPredicateGroup !== undefined &&
        typeof input.positionInRowLevelPermissionPredicateGroup !== 'number') ||
      (input.deletedAt !== null && input.deletedAt !== undefined)
    )
      throw new Error('Row level permission audit invalid predicate create');
    return {
      id,
      universalIdentifier,
      roleUniversalIdentifier,
      objectMetadataUniversalIdentifier,
      fieldMetadataId: uuid(mappedFieldId),
      fieldMetadataUniversalIdentifier,
      operand: input.operand,
      value: input.value ?? null,
      subFieldName: input.subFieldName ?? null,
      workspaceMemberFieldMetadataId: mappedMemberFieldId
        ? uuid(mappedMemberFieldId)
        : null,
      workspaceMemberFieldMetadataUniversalIdentifier: memberFieldUniversalId,
      workspaceMemberSubFieldName: input.workspaceMemberSubFieldName ?? null,
      rowLevelPermissionPredicateGroupId: resolveGroupId(
        input.rowLevelPermissionPredicateGroupUniversalIdentifier,
      ),
      positionInRowLevelPermissionPredicateGroup:
        input.positionInRowLevelPermissionPredicateGroup ?? null,
      deletedAt: null,
      createdAt: requireTimestamp(input.createdAt),
      updatedAt: requireTimestamp(input.updatedAt),
    };
  });

  const allTouchedGroupIds = [
    ...plannedGroupDeletes.map((item) => item.id),
    ...plannedGroupUpdates.map((item) => item.id),
    ...plannedGroupCreates.map((item) => item.id),
  ];
  const allTouchedPredicateIds = [
    ...plannedPredicateDeletes.map((item) => item.id),
    ...plannedPredicateUpdates.map((item) => item.id),
    ...plannedPredicateCreates.map((item) => item.id),
  ];
  if (
    new Set(allTouchedGroupIds).size !== allTouchedGroupIds.length ||
    new Set(allTouchedPredicateIds).size !== allTouchedPredicateIds.length
  )
    throw new Error('Row level permission audit duplicate action target');

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    const beforeRole = await verifyRoleAndWorkspaceAndApplication(
      runner,
      request.operation.workspaceId,
      request.roleId,
      applicationId,
      applicationUniversalIdentifier,
    );
    const roleUniversalIdentifier = uuid(
      String(beforeRole.universalIdentifier),
    );
    if (
      plannedGroupCreates.some(
        (item) => item.roleUniversalIdentifier !== roleUniversalIdentifier,
      ) ||
      plannedPredicateCreates.some(
        (item) => item.roleUniversalIdentifier !== roleUniversalIdentifier,
      )
    )
      throw new Error('Row level permission audit role universalId mismatch');

    const deletedGroupIds = plannedGroupDeletes.map((item) => item.id);
    const readGroups = async (lock = false) => {
      const rows = await runner.query(
        `SELECT to_jsonb(g) AS row FROM core."rowLevelPermissionPredicateGroup" g WHERE "workspaceId"=$1 AND (("roleId"=$2 AND "objectMetadataId"=$3 AND "deletedAt" IS NULL) OR id=ANY($4::uuid[]) OR "parentRowLevelPermissionPredicateGroupId"=ANY($5::uuid[])) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [
          request.operation.workspaceId,
          request.roleId,
          request.objectMetadataId,
          allTouchedGroupIds,
          deletedGroupIds,
        ],
      );
      return rows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      ) as Record<string, unknown>[];
    };
    const readPredicates = async (lock = false) => {
      const rows = await runner.query(
        `SELECT to_jsonb(p) AS row FROM core."rowLevelPermissionPredicate" p WHERE "workspaceId"=$1 AND (("roleId"=$2 AND "objectMetadataId"=$3 AND "deletedAt" IS NULL) OR id=ANY($4::uuid[]) OR "rowLevelPermissionPredicateGroupId"=ANY($5::uuid[])) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [
          request.operation.workspaceId,
          request.roleId,
          request.objectMetadataId,
          allTouchedPredicateIds,
          deletedGroupIds,
        ],
      );
      return rows.map(
        (entry: { row: Record<string, unknown> }) => entry.row,
      ) as Record<string, unknown>[];
    };
    const beforeGroups = await readGroups(true);
    const beforePredicates = await readPredicates(true);
    if (
      beforeGroups.some(
        (row) =>
          uuid(String(row.roleId)) !== request.roleId ||
          uuid(String(row.objectMetadataId)) !== request.objectMetadataId ||
          row.deletedAt !== null ||
          plannedGroupCreates.some((item) => item.id === uuid(String(row.id))),
      ) ||
      beforePredicates.some(
        (row) =>
          uuid(String(row.roleId)) !== request.roleId ||
          uuid(String(row.objectMetadataId)) !== request.objectMetadataId ||
          row.deletedAt !== null ||
          plannedPredicateCreates.some(
            (item) => item.id === uuid(String(row.id)),
          ),
      )
    )
      throw new Error(
        'Row level permission audit foreign or colliding existing row',
      );

    const desiredGroupSet = new Set(request.desiredGroupIds);
    const groupDeleteIdSet = new Set(
      plannedGroupDeletes.map((item) => item.id),
    );
    const groupUpdateById = new Map(
      plannedGroupUpdates.map((item) => [item.id, item]),
    );
    for (const plannedDelete of plannedGroupDeletes) {
      const match = beforeGroups.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedDelete.universalIdentifier
      )
        throw new Error(
          'Row level permission audit planned group delete mismatch',
        );
    }
    for (const plannedUpdate of plannedGroupUpdates) {
      const match = beforeGroups.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedUpdate.universalIdentifier ||
        !desiredGroupSet.has(plannedUpdate.id)
      )
        throw new Error(
          'Row level permission audit planned group update mismatch',
        );
    }
    const survivingGroups = beforeGroups.filter(
      (row) => !groupDeleteIdSet.has(uuid(String(row.id))),
    );
    const survivingGroupIds = new Set(
      survivingGroups.map((row) => uuid(String(row.id))),
    );
    if (
      beforeGroups.some(
        (row) =>
          groupDeleteIdSet.has(uuid(String(row.id))) ===
          desiredGroupSet.has(uuid(String(row.id))),
      ) ||
      survivingGroupIds.size + plannedGroupCreates.length !==
        desiredGroupSet.size ||
      plannedGroupCreates.some(
        (item) =>
          !desiredGroupSet.has(item.id) || survivingGroupIds.has(item.id),
      )
    )
      throw new Error(
        'Row level permission audit group plan diverges from persisted state',
      );

    const desiredPredicateSet = new Set(request.desiredPredicateIds);
    const predicateDeleteIdSet = new Set(
      plannedPredicateDeletes.map((item) => item.id),
    );
    const predicateUpdateById = new Map(
      plannedPredicateUpdates.map((item) => [item.id, item]),
    );
    for (const plannedDelete of plannedPredicateDeletes) {
      const match = beforePredicates.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedDelete.universalIdentifier
      )
        throw new Error(
          'Row level permission audit planned predicate delete mismatch',
        );
    }
    for (const plannedUpdate of plannedPredicateUpdates) {
      const match = beforePredicates.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      );
      if (
        !match ||
        uuid(String(match.universalIdentifier)) !==
          plannedUpdate.universalIdentifier ||
        !desiredPredicateSet.has(plannedUpdate.id)
      )
        throw new Error(
          'Row level permission audit planned predicate update mismatch',
        );
    }
    const survivingPredicates = beforePredicates.filter(
      (row) => !predicateDeleteIdSet.has(uuid(String(row.id))),
    );
    const survivingPredicateIds = new Set(
      survivingPredicates.map((row) => uuid(String(row.id))),
    );
    if (
      beforePredicates.some(
        (row) =>
          predicateDeleteIdSet.has(uuid(String(row.id))) ===
          desiredPredicateSet.has(uuid(String(row.id))),
      ) ||
      survivingPredicateIds.size + plannedPredicateCreates.length !==
        desiredPredicateSet.size ||
      plannedPredicateCreates.some(
        (item) =>
          !desiredPredicateSet.has(item.id) ||
          survivingPredicateIds.has(item.id),
      )
    )
      throw new Error(
        'Row level permission audit predicate plan diverges from persisted state',
      );

    const targetFieldIds = [
      ...new Set([
        ...survivingPredicates.map((row) => uuid(String(row.fieldMetadataId))),
        ...plannedPredicateCreates.map((item) => item.fieldMetadataId),
        ...plannedPredicateUpdates.flatMap((item) =>
          typeof item.update.fieldMetadataId === 'string'
            ? [item.update.fieldMetadataId]
            : [],
        ),
      ]),
    ].sort();
    const memberFieldIds = [
      ...new Set([
        ...survivingPredicates.flatMap((row) =>
          typeof row.workspaceMemberFieldMetadataId === 'string'
            ? [uuid(row.workspaceMemberFieldMetadataId)]
            : [],
        ),
        ...plannedPredicateCreates.flatMap((item) =>
          item.workspaceMemberFieldMetadataId
            ? [item.workspaceMemberFieldMetadataId]
            : [],
        ),
        ...plannedPredicateUpdates.flatMap((item) =>
          typeof item.update.workspaceMemberFieldMetadataId === 'string'
            ? [item.update.workspaceMemberFieldMetadataId]
            : [],
        ),
      ]),
    ].sort();
    const allFieldIds = [
      ...new Set([...targetFieldIds, ...memberFieldIds]),
    ].sort();
    const readFieldMetadatas = (lock = false) =>
      allFieldIds.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : runner.query(
            `SELECT id,"workspaceId","universalIdentifier","objectMetadataId" FROM core."fieldMetadata" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
            [request.operation.workspaceId, allFieldIds],
          );
    const lockedFields = await readFieldMetadatas(true);
    if (lockedFields.length !== allFieldIds.length)
      throw new Error(
        'Row level permission audit referenced fieldMetadata unavailable',
      );
    for (const fieldId of targetFieldIds) {
      const field = lockedFields.find(
        (row: Record<string, unknown>) => uuid(String(row.id)) === fieldId,
      );
      if (
        !field ||
        uuid(String(field.objectMetadataId)) !== request.objectMetadataId
      )
        throw new Error(
          'Row level permission audit predicate field does not belong to target object',
        );
    }
    const memberObjectIds = [
      ...new Set(
        memberFieldIds.map((fieldId) => {
          const field = lockedFields.find(
            (row: Record<string, unknown>) => uuid(String(row.id)) === fieldId,
          );
          if (!field)
            throw new Error(
              'Row level permission audit workspaceMember field unavailable',
            );
          return uuid(String(field.objectMetadataId));
        }),
      ),
    ];
    const allObjectIds = [
      ...new Set([request.objectMetadataId, ...memberObjectIds]),
    ].sort();
    const readObjectMetadatas = (lock = false) =>
      runner.query(
        `SELECT id,"workspaceId","universalIdentifier","nameSingular" FROM core."objectMetadata" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
        [request.operation.workspaceId, allObjectIds],
      );
    const lockedObjects = await readObjectMetadatas(true);
    if (lockedObjects.length !== allObjectIds.length)
      throw new Error(
        'Row level permission audit referenced objectMetadata unavailable',
      );
    const targetObject = lockedObjects.find(
      (row: Record<string, unknown>) =>
        uuid(String(row.id)) === request.objectMetadataId,
    );
    if (!targetObject)
      throw new Error('Row level permission audit target object unavailable');
    const targetObjectUniversalId = uuid(
      String(targetObject.universalIdentifier),
    );
    if (
      plannedGroupCreates.some(
        (item) =>
          item.objectMetadataUniversalIdentifier !== targetObjectUniversalId,
      ) ||
      plannedPredicateCreates.some(
        (item) =>
          item.objectMetadataUniversalIdentifier !== targetObjectUniversalId,
      )
    )
      throw new Error(
        'Row level permission audit objectMetadata universalId mismatch',
      );
    for (const memberObjectId of memberObjectIds) {
      const memberObject = lockedObjects.find(
        (row: Record<string, unknown>) =>
          uuid(String(row.id)) === memberObjectId,
      );
      if (!memberObject || memberObject.nameSingular !== 'workspaceMember')
        throw new Error(
          'Row level permission audit workspaceMemberFieldMetadataId does not belong to workspaceMember object',
        );
    }

    const operation = await resolveRoleAuditInitiator(
      runner,
      request.operation,
      request.impersonatorUserWorkspaceId,
    );
    const audit = new CrmAuditTransactionContext(runner, operation);
    const result = await work(runner);
    const afterGroups = await readGroups(false);
    const afterPredicates = await readPredicates(false);
    if (
      afterGroups.length !==
        survivingGroups.length + plannedGroupCreates.length ||
      afterGroups.some((row) => groupDeleteIdSet.has(uuid(String(row.id)))) ||
      afterPredicates.length !==
        survivingPredicates.length + plannedPredicateCreates.length ||
      afterPredicates.some((row) =>
        predicateDeleteIdSet.has(uuid(String(row.id))),
      )
    )
      throw new Error('Row level permission audit post-handler count mismatch');

    for (const beforeGroup of survivingGroups) {
      const id = uuid(String(beforeGroup.id));
      const actual = afterGroups.find((row) => uuid(String(row.id)) === id);
      const plannedUpdate = groupUpdateById.get(id);
      const expected = plannedUpdate
        ? {
            ...beforeGroup,
            ...plannedUpdate.update,
            updatedAt: actual?.updatedAt,
          }
        : beforeGroup;
      if (
        !actual ||
        canonicalAuditJson(actual) !== canonicalAuditJson(expected)
      )
        throw new Error(
          'Row level permission audit updated or kept group mismatch',
        );
    }
    for (const plannedCreate of plannedGroupCreates) {
      const actual = afterGroups.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      );
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: request.roleId,
        objectMetadataId: request.objectMetadataId,
        parentRowLevelPermissionPredicateGroupId:
          plannedCreate.parentRowLevelPermissionPredicateGroupId,
        logicalOperator: plannedCreate.logicalOperator,
        positionInRowLevelPermissionPredicateGroup:
          plannedCreate.positionInRowLevelPermissionPredicateGroup,
        deletedAt: null,
      };
      if (
        !actual ||
        canonicalAuditJson(scalarWithoutTimestamps(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error('Row level permission audit created group mismatch');
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."rowLevelPermissionPredicateGroup" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error(
          'Row level permission audit created group timestamps changed',
        );
    }

    for (const beforePredicate of survivingPredicates) {
      const id = uuid(String(beforePredicate.id));
      const actual = afterPredicates.find((row) => uuid(String(row.id)) === id);
      const plannedUpdate = predicateUpdateById.get(id);
      const expected = plannedUpdate
        ? {
            ...beforePredicate,
            ...plannedUpdate.update,
            updatedAt: actual?.updatedAt,
          }
        : beforePredicate;
      if (
        !actual ||
        canonicalAuditJson(actual) !== canonicalAuditJson(expected)
      )
        throw new Error(
          'Row level permission audit updated or kept predicate mismatch',
        );
    }
    for (const plannedCreate of plannedPredicateCreates) {
      const actual = afterPredicates.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      );
      const expectedScalar = {
        id: plannedCreate.id,
        universalIdentifier: plannedCreate.universalIdentifier,
        workspaceId: request.operation.workspaceId,
        applicationId,
        roleId: request.roleId,
        objectMetadataId: request.objectMetadataId,
        fieldMetadataId: plannedCreate.fieldMetadataId,
        operand: plannedCreate.operand,
        value: plannedCreate.value,
        subFieldName: plannedCreate.subFieldName,
        workspaceMemberFieldMetadataId:
          plannedCreate.workspaceMemberFieldMetadataId,
        workspaceMemberSubFieldName: plannedCreate.workspaceMemberSubFieldName,
        rowLevelPermissionPredicateGroupId:
          plannedCreate.rowLevelPermissionPredicateGroupId,
        positionInRowLevelPermissionPredicateGroup:
          plannedCreate.positionInRowLevelPermissionPredicateGroup,
        deletedAt: null,
      };
      if (
        !actual ||
        canonicalAuditJson(scalarWithoutTimestamps(actual)) !==
          canonicalAuditJson(expectedScalar)
      )
        throw new Error(
          'Row level permission audit created predicate mismatch',
        );
      const [timestamps] = await runner.query(
        'SELECT "createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz AS matches FROM core."rowLevelPermissionPredicate" WHERE id=$1',
        [plannedCreate.id, plannedCreate.createdAt, plannedCreate.updatedAt],
      );
      if (timestamps?.matches !== true)
        throw new Error(
          'Row level permission audit created predicate timestamps changed',
        );
    }

    const afterGroupIdSet = new Set(
      afterGroups.map((row) => uuid(String(row.id))),
    );
    if (
      afterGroups.some(
        (row) =>
          row.parentRowLevelPermissionPredicateGroupId !== null &&
          row.parentRowLevelPermissionPredicateGroupId !== undefined &&
          !afterGroupIdSet.has(
            uuid(String(row.parentRowLevelPermissionPredicateGroupId)),
          ),
      ) ||
      afterPredicates.some(
        (row) =>
          row.rowLevelPermissionPredicateGroupId !== null &&
          row.rowLevelPermissionPredicateGroupId !== undefined &&
          !afterGroupIdSet.has(
            uuid(String(row.rowLevelPermissionPredicateGroupId)),
          ),
      )
    )
      throw new Error(
        'Row level permission audit dangling group reference after upsert',
      );

    for (const plannedDelete of plannedGroupDeletes) {
      const beforeRow = beforeGroups.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicateGroup',
        resourceId: plannedDelete.id,
        action: 'delete',
        before: projectPredicateGroup(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicateGroup',
          resourceId: plannedDelete.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedUpdate of plannedGroupUpdates) {
      const beforeRow = beforeGroups.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      const afterRow = afterGroups.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicateGroup',
        resourceId: plannedUpdate.id,
        action: 'update',
        before: projectPredicateGroup(beforeRow),
        after: projectPredicateGroup(afterRow),
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicateGroup',
          resourceId: plannedUpdate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedCreate of plannedGroupCreates) {
      const afterRow = afterGroups.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicateGroup',
        resourceId: plannedCreate.id,
        action: 'create',
        before: null,
        after: projectPredicateGroup(afterRow),
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicateGroup',
          resourceId: plannedCreate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedDelete of plannedPredicateDeletes) {
      const beforeRow = beforePredicates.find(
        (row) => uuid(String(row.id)) === plannedDelete.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicate',
        resourceId: plannedDelete.id,
        action: 'delete',
        before: projectPredicate(beforeRow),
        after: null,
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicate',
          resourceId: plannedDelete.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedUpdate of plannedPredicateUpdates) {
      const beforeRow = beforePredicates.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      const afterRow = afterPredicates.find(
        (row) => uuid(String(row.id)) === plannedUpdate.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicate',
        resourceId: plannedUpdate.id,
        action: 'update',
        before: projectPredicate(beforeRow),
        after: projectPredicate(afterRow),
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicate',
          resourceId: plannedUpdate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    for (const plannedCreate of plannedPredicateCreates) {
      const afterRow = afterPredicates.find(
        (row) => uuid(String(row.id)) === plannedCreate.id,
      )!;
      audit.record({
        resourceKind: 'rowLevelPermissionPredicate',
        resourceId: plannedCreate.id,
        action: 'create',
        before: null,
        after: projectPredicate(afterRow),
        securityDescriptor: {
          resourceKind: 'rowLevelPermissionPredicate',
          resourceId: plannedCreate.id,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
    }
    await audit.flush();

    const [currentRole] = await runner.query(
      'SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2',
      [request.operation.workspaceId, request.roleId],
    );
    if (
      !currentRole ||
      canonicalAuditJson(currentRole.row) !== canonicalAuditJson(beforeRole) ||
      canonicalAuditJson(await readGroups(false)) !==
        canonicalAuditJson(afterGroups) ||
      canonicalAuditJson(await readPredicates(false)) !==
        canonicalAuditJson(afterPredicates) ||
      canonicalAuditJson(await readObjectMetadatas(false)) !==
        canonicalAuditJson(lockedObjects) ||
      canonicalAuditJson(await readFieldMetadatas(false)) !==
        canonicalAuditJson(lockedFields)
    )
      throw new Error(
        'Row level permission audit persisted state changed during flush',
      );
    await verifyRoleAuditApplication(
      runner,
      request.operation.workspaceId,
      applicationId,
      applicationUniversalIdentifier,
    );
    return result;
  });
};

export const runAuditedRolePermissionUpsert = async <T>(
  dataSource: DataSource,
  request: RolePermissionAuditRequest,
  actions: MigrationAction[],
  mappings: RolePermissionAuditMappings | undefined,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (
    getRolePermissionAudit(request.operation.workspaceId) !== request ||
    consumed.has(request)
  )
    throw new Error(
      'Role permission audit operation is not active or was already consumed',
    );
  if (!mappings?.application?.id || !mappings?.application?.universalIdentifier)
    throw new Error(
      'Role permission audit requires application and entity mappings',
    );
  consumed.add(request);
  switch (request.kind) {
    case 'rolePermissionFlag':
      return runAuditedRolePermissionFlagUpsert(
        dataSource,
        request,
        actions,
        mappings,
        work,
      );
    case 'objectPermission':
      return runAuditedObjectPermissionUpsert(
        dataSource,
        request,
        actions,
        mappings,
        work,
      );
    case 'fieldPermission':
      return runAuditedFieldPermissionUpsert(
        dataSource,
        request,
        actions,
        mappings,
        work,
      );
    case 'rowLevelPermissionPredicate':
      return runAuditedRowLevelPermissionUpsert(
        dataSource,
        request,
        actions,
        mappings,
        work,
      );
  }
};
