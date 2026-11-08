import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { captureCurrentCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  membershipCleanupOperation,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  registerMetadataAuditScopeCheck,
  resolveRoleAuditInitiator,
  roleAuditIdentityFromRequest,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export type CoreWorkflowAndViewAuditIdentity =
  | RoleUpdateAuditIdentity
  | MembershipCleanupIdentity
  | Parameters<typeof roleAuditIdentityFromRequest>[0];

export type CoreWorkflowVisibilityAuditRequest = Readonly<{
  kind: 'coreWorkflowVisibility';
  workspaceId: string;
  coreWorkflowId: string;
  userWorkspaceId: string;
  visibility: 'WORKSPACE' | 'UNLISTED';
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  runByVersion?: string | null;
}>;

export type CoreViewUpdateAuditRequest = Readonly<{
  kind: 'coreViewUpdate';
  workspaceId: string;
  viewId: string;
  userWorkspaceId?: string;
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
}>;

export type CoreWorkflowAndViewAuditRequest =
  | CoreWorkflowVisibilityAuditRequest
  | CoreViewUpdateAuditRequest;

export type CoreViewAuditMappings = {
  application: { id: string; universalIdentifier: string };
  views: Record<string, { id: string } | undefined>;
};

type ViewMigrationAction = {
  type: string;
  metadataName: string;
  universalIdentifier?: string;
  update?: Record<string, unknown>;
  id?: string;
  flatEntity?: Record<string, unknown>;
};

const VALID_VISIBILITIES = new Set<string>(['WORKSPACE', 'UNLISTED']);

const storage = new AsyncLocalStorage<CoreWorkflowAndViewAuditRequest>();
const active = new WeakSet<CoreWorkflowAndViewAuditRequest>();
const consumed = new WeakSet<CoreWorkflowAndViewAuditRequest>();

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error('Core workflow/view audit identity is invalid');
  }

  return value.toLowerCase();
};

const nullableUuid = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return uuid(value);
};

export const assertWorkflowOrViewVisibility = (
  value: unknown,
): 'WORKSPACE' | 'UNLISTED' => {
  if (typeof value !== 'string' || !VALID_VISIBILITIES.has(value)) {
    throw new Error('Core workflow/view audit visibility is invalid');
  }

  return value as 'WORKSPACE' | 'UNLISTED';
};

export const getCoreWorkflowAndViewAudit = (workspaceId: string) => {
  const request = storage.getStore();
  if (!request) return undefined;
  if (!active.has(request) || request.workspaceId !== uuid(workspaceId)) {
    throw new Error('Core workflow/view audit context mismatch');
  }

  return request;
};

export const getCoreViewUpdateAudit = (
  workspaceId: string,
): CoreViewUpdateAuditRequest | undefined => {
  const request = getCoreWorkflowAndViewAudit(workspaceId);
  if (!request) return undefined;
  if (request.kind !== 'coreViewUpdate') {
    throw new Error('Core view update audit context mismatch');
  }

  return request;
};

registerMetadataAuditScopeCheck(getCoreWorkflowAndViewAudit);

const resolveCapturedOperation = (
  normalizedWorkspaceId: string,
  identity: CoreWorkflowAndViewAuditIdentity | undefined,
): {
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
} => {
  if (identity !== undefined) {
    if (
      identity &&
      typeof identity === 'object' &&
      'actor' in identity &&
      !('auth' in identity)
    ) {
      if ((identity as MembershipCleanupIdentity).workspaceId === undefined) {
        throw new Error('CRM audit context requires scoped identity');
      }
      const normalizedIdentity: MembershipCleanupIdentity = {
        ...(identity as MembershipCleanupIdentity),
        correlationId:
          typeof (identity as { correlationId?: unknown }).correlationId ===
          'string'
            ? (identity as MembershipCleanupIdentity).correlationId
            : randomUUID(),
      };
      const operation = membershipCleanupOperation(
        normalizedWorkspaceId,
        normalizedIdentity,
      );
      if (!operation) {
        throw new Error(
          'Core workflow/view mutation requires authenticated audit identity',
        );
      }

      return { operation };
    }

    const roleIdentity =
      identity && typeof identity === 'object' && 'auth' in identity
        ? (identity as RoleUpdateAuditIdentity)
        : roleAuditIdentityFromRequest(
            identity as Parameters<typeof roleAuditIdentityFromRequest>[0],
          );
    const capturedIdentity = captureRoleAuditIdentity(roleIdentity);
    const operation = captureRoleAuditOperation(
      normalizedWorkspaceId,
      capturedIdentity,
    );

    return {
      operation,
      ...(capturedIdentity.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              capturedIdentity.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    };
  }

  const ambient = captureCurrentCrmAuditOperation(normalizedWorkspaceId);
  if (ambient) {
    return {
      operation: ambient.operation,
      ...(ambient.impersonatorUserWorkspaceId
        ? {
            impersonatorUserWorkspaceId: uuid(
              ambient.impersonatorUserWorkspaceId,
            ),
          }
        : {}),
    };
  }

  throw new Error(
    'Core workflow/view mutation requires authenticated audit identity',
  );
};

export const captureCoreWorkflowVisibilityAudit = ({
  workspaceId,
  coreWorkflowId,
  userWorkspaceId,
  visibility,
  auditIdentity,
  runByVersion,
}: {
  workspaceId: string;
  coreWorkflowId: string;
  userWorkspaceId: string;
  visibility: string;
  auditIdentity?: CoreWorkflowAndViewAuditIdentity;
  runByVersion?: string | null;
}): (() => CoreWorkflowVisibilityAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const normalizedWorkflowId = uuid(coreWorkflowId);
    const normalizedUserWorkspaceId = uuid(userWorkspaceId);
    const normalizedVisibility = assertWorkflowOrViewVisibility(visibility);
    if (
      getCoreWorkflowAndViewAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getCoreWorkflowAndViewAudit,
      )
    ) {
      throw new Error('Nested core workflow/view audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );
    const request: CoreWorkflowVisibilityAuditRequest = Object.freeze({
      kind: 'coreWorkflowVisibility',
      workspaceId: normalizedWorkspaceId,
      coreWorkflowId: normalizedWorkflowId,
      userWorkspaceId: normalizedUserWorkspaceId,
      visibility: normalizedVisibility,
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
      runByVersion: runByVersion ?? null,
    });

    return () => request;
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const captureCoreViewUpdateAudit = ({
  workspaceId,
  viewId,
  userWorkspaceId,
  auditIdentity,
}: {
  workspaceId: string;
  viewId: string;
  userWorkspaceId?: string;
  auditIdentity?: CoreWorkflowAndViewAuditIdentity;
}): (() => CoreViewUpdateAuditRequest) => {
  try {
    const normalizedWorkspaceId = uuid(workspaceId);
    const normalizedViewId = uuid(viewId);
    const normalizedUserWorkspaceId =
      userWorkspaceId === undefined ? undefined : uuid(userWorkspaceId);
    if (
      getCoreWorkflowAndViewAudit(normalizedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        normalizedWorkspaceId,
        getCoreWorkflowAndViewAudit,
      )
    ) {
      throw new Error('Nested core workflow/view audit is unsupported');
    }

    const { operation, impersonatorUserWorkspaceId } = resolveCapturedOperation(
      normalizedWorkspaceId,
      auditIdentity,
    );
    const request: CoreViewUpdateAuditRequest = Object.freeze({
      kind: 'coreViewUpdate',
      workspaceId: normalizedWorkspaceId,
      viewId: normalizedViewId,
      ...(normalizedUserWorkspaceId !== undefined
        ? { userWorkspaceId: normalizedUserWorkspaceId }
        : {}),
      operation,
      ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}),
    });

    return () => request;
  } catch (error) {
    return () => {
      throw error;
    };
  }
};

export const withCoreViewUpdateAudit = async <TResult>(
  request: CoreViewUpdateAuditRequest,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    request.kind !== 'coreViewUpdate' ||
    consumed.has(request) ||
    getCoreWorkflowAndViewAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Nested core workflow/view audit is unsupported');
  }

  active.add(request);
  try {
    return await storage.run(request, work);
  } finally {
    active.delete(request);
  }
};

const verifyActiveWorkspaceAndMembership = async (
  runner: QueryRunner,
  workspaceId: string,
  userWorkspaceId: string | undefined,
  operation: CrmAuditOperation,
  requireUserScopedActor = false,
): Promise<void> => {
  const [workspace] = await runner.query(
    `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR KEY SHARE`,
    [workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null) {
    throw new Error('Core workflow/view audit workspace unavailable');
  }

  if (requireUserScopedActor && userWorkspaceId === undefined) {
    throw new Error('Core workflow/view audit requires caller userWorkspaceId');
  }

  if (userWorkspaceId !== undefined) {
    const [membership] = await runner.query(
      `SELECT id,"userId","workspaceId",to_jsonb(uw)->>'deletedAt' AS "deletedAt" FROM core."userWorkspace" uw WHERE uw.id=$1 FOR KEY SHARE`,
      [userWorkspaceId],
    );
    if (
      !membership ||
      membership.deletedAt !== null ||
      uuid(membership.workspaceId) !== workspaceId ||
      membership.userId === null ||
      membership.userId === undefined
    ) {
      throw new Error('Core workflow/view audit caller membership unavailable');
    }
    const normalizedMembershipUserId = uuid(membership.userId);
    const actor = operation.actor;
    const initiator = operation.initiator;
    const userPrincipal =
      actor.kind === 'coreUser' || actor.kind === 'workspaceMember'
        ? actor
        : initiator?.kind === 'coreUser' ||
            initiator?.kind === 'workspaceMember'
          ? initiator
          : undefined;

    if (!userPrincipal) {
      throw new Error(
        'Core workflow/view mutation with userWorkspaceId requires a user-scoped audit actor',
      );
    }

    if (userPrincipal.kind === 'coreUser') {
      if (uuid(userPrincipal.id) !== normalizedMembershipUserId) {
        throw new Error(
          'Core workflow/view audit caller membership user mismatch',
        );
      }
      return;
    }

    const workspaceSchema = `workspace_${workspaceId.replaceAll('-', '')}`;
    const [schemaReg] = await runner.query(
      `SELECT COALESCE(to_regclass($1), to_regclass($2)) AS "exists"`,
      [
        `"workspace_${workspaceId}"."workspaceMember"`,
        `"${workspaceSchema}"."workspaceMember"`,
      ],
    );
    if (schemaReg?.exists) {
      const [hyphenReg] = await runner.query(
        `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
        [`"workspace_${workspaceId}"."workspaceMember"`],
      );
      const targetSchema =
        hyphenReg?.exists === true
          ? `workspace_${workspaceId}`
          : workspaceSchema;
      const [member] = await runner.query(
        `SELECT "userId" FROM "${targetSchema}"."workspaceMember" WHERE id=$1 AND "deletedAt" IS NULL`,
        [uuid(userPrincipal.id)],
      );
      if (!member || uuid(member.userId) !== normalizedMembershipUserId) {
        throw new Error(
          'Core workflow/view audit workspaceMember actor does not match caller userWorkspace',
        );
      }
    }
  }
};

export const persistWorkflowRunShareReconciliationIntent = async ({
  runner,
  workspaceId,
  coreWorkflowId,
  applicationUniversalIdentifier,
  runByVersion,
  position = 0,
}: {
  runner: QueryRunner;
  workspaceId: string;
  coreWorkflowId: string;
  applicationUniversalIdentifier: string | null;
  runByVersion?: string | null;
  position?: number;
}): Promise<{ intentId: string; verify: () => Promise<void> } | undefined> => {
  const [tableReg] = await runner.query(
    `SELECT to_regclass('core."deferredWorkspaceMigrationAction"') IS NOT NULL AS "exists"`,
  );
  if (tableReg?.exists !== true) {
    return undefined;
  }

  let resolvedAppUid = applicationUniversalIdentifier;
  if (!resolvedAppUid) {
    const [fallbackApp] = await runner.query(
      `SELECT "universalIdentifier" FROM core.application a WHERE a."workspaceId"=$1 AND to_jsonb(a)->>'deletedAt' IS NULL ORDER BY id LIMIT 1`,
      [workspaceId],
    );
    resolvedAppUid = nullableUuid(fallbackApp?.universalIdentifier);
  }
  if (!resolvedAppUid) {
    throw new Error('Workflow reconciliation application unavailable');
  }

  const payloadJson = JSON.stringify({ version: 1, coreWorkflowId });
  const inserted = await runner.query(
    `INSERT INTO core."deferredWorkspaceMigrationAction"
      ("workspaceId", "applicationUniversalIdentifier", name, payload, position, "runByVersion")
     VALUES ($1,$2,'sync_workflowRunShares',$3::jsonb,$4,$5) RETURNING id`,
    [workspaceId, resolvedAppUid, payloadJson, position, runByVersion ?? null],
  );
  if (inserted.length !== 1 || !inserted[0]?.id) {
    throw new Error('Workflow reconciliation intent was not persisted');
  }
  const intentId = uuid(inserted[0].id);

  const verify = async () => {
    const rows = await runner.query(
      `SELECT id FROM core."deferredWorkspaceMigrationAction"
       WHERE id=$1 AND "workspaceId"=$2 AND "applicationUniversalIdentifier"=$3
         AND name='sync_workflowRunShares' AND payload=$4::jsonb
         AND status='PENDING' AND attempts=0`,
      [intentId, workspaceId, resolvedAppUid, payloadJson],
    );
    if (rows.length !== 1) {
      throw new Error('Workflow reconciliation intent changed before commit');
    }
  };
  await verify();

  return { intentId, verify };
};

export const completeWorkflowRunShareReconciliationIntent = async (
  dataSource: DataSource | undefined,
  workspaceId: string,
  intentId: string | undefined,
): Promise<void> => {
  if (!dataSource || !intentId) {
    return;
  }
  const [tableReg] = await dataSource.query(
    `SELECT to_regclass('core."deferredWorkspaceMigrationAction"') IS NOT NULL AS "exists"`,
  );
  if (tableReg?.exists !== true) {
    return;
  }
  await dataSource.query(
    `DELETE FROM core."deferredWorkspaceMigrationAction"
      WHERE id=$1 AND "workspaceId"=$2 AND name='sync_workflowRunShares' AND status='PENDING'`,
    [uuid(intentId), uuid(workspaceId)],
  );
};

export const runAuditedCoreWorkflowVisibilityUpdate = async (
  dataSource: DataSource | undefined,
  request: CoreWorkflowVisibilityAuditRequest,
  work: (runner: QueryRunner) => Promise<void>,
): Promise<
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'updated'; changed: boolean; intentId?: string }
> => {
  if (
    !request ||
    typeof request !== 'object' ||
    request.kind !== 'coreWorkflowVisibility' ||
    consumed.has(request) ||
    getCoreWorkflowAndViewAudit(request.workspaceId) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Nested core workflow/view audit is unsupported');
  }
  if (!dataSource) {
    throw new Error('Core workflow visibility audit requires core DataSource');
  }

  consumed.add(request);
  active.add(request);
  try {
    return await storage.run(request, () =>
      runInCoreAuditTransaction(dataSource, async (runner) => {
        await runner.query("SET LOCAL lock_timeout = '8s'");
        await verifyActiveWorkspaceAndMembership(
          runner,
          request.workspaceId,
          request.userWorkspaceId,
          request.operation,
          true,
        );

        const readWorkflow = () =>
          runner.query(
            `SELECT w.id,
                    w."workspaceId",
                    to_jsonb(w)->>'createdByUserWorkspaceId' AS "createdByUserWorkspaceId",
                    to_jsonb(w)->>'visibility' AS "visibility",
                    to_jsonb(w)->>'deletedAt' AS "deletedAt",
                    to_jsonb(a)->>'workspaceId' AS "applicationWorkspaceId",
                    to_jsonb(a)->>'universalIdentifier' AS "applicationUniversalIdentifier"
               FROM core.workflow w
               LEFT JOIN core.application a ON a.id = w."applicationId"
              WHERE w.id=$1 AND w."workspaceId"=$2
                FOR NO KEY UPDATE OF w`,
            [request.coreWorkflowId, request.workspaceId],
          );

        const [beforeWorkflow] = await readWorkflow();
        if (!beforeWorkflow || beforeWorkflow.deletedAt !== null) {
          return { status: 'not_found' as const };
        }
        if (uuid(beforeWorkflow.workspaceId) !== request.workspaceId) {
          throw new Error('Core workflow visibility audit workspace mismatch');
        }

        const beforeCreatedBy = nullableUuid(
          beforeWorkflow.createdByUserWorkspaceId,
        );
        const beforeVisibility = assertWorkflowOrViewVisibility(
          beforeWorkflow.visibility,
        );

        if (
          beforeCreatedBy !== null &&
          beforeCreatedBy !== request.userWorkspaceId
        ) {
          return { status: 'forbidden' as const };
        }

        await work(runner);

        const [afterWorkflow] = await readWorkflow();
        if (
          !afterWorkflow ||
          afterWorkflow.deletedAt !== null ||
          uuid(afterWorkflow.workspaceId) !== request.workspaceId
        ) {
          throw new Error(
            'Core workflow visibility update removed or corrupted target workflow',
          );
        }

        const afterCreatedBy = nullableUuid(
          afterWorkflow.createdByUserWorkspaceId,
        );
        const afterVisibility = assertWorkflowOrViewVisibility(
          afterWorkflow.visibility,
        );

        if (
          afterCreatedBy !== request.userWorkspaceId ||
          afterVisibility !== request.visibility
        ) {
          throw new Error(
            'Core workflow visibility update did not persist expected state',
          );
        }

        const changed =
          beforeCreatedBy !== afterCreatedBy ||
          beforeVisibility !== afterVisibility;

        if (!changed) {
          return { status: 'updated' as const, changed: false };
        }

        const appWorkspaceId = nullableUuid(
          beforeWorkflow.applicationWorkspaceId,
        );
        if (appWorkspaceId !== null && appWorkspaceId !== request.workspaceId) {
          throw new Error(
            'Core workflow visibility audit application belongs to another workspace',
          );
        }

        const persistedIntent =
          await persistWorkflowRunShareReconciliationIntent({
            runner,
            workspaceId: request.workspaceId,
            coreWorkflowId: request.coreWorkflowId,
            applicationUniversalIdentifier: nullableUuid(
              beforeWorkflow.applicationUniversalIdentifier,
            ),
            runByVersion: request.runByVersion,
          });

        const operation = await resolveRoleAuditInitiator(
          runner,
          request.operation,
          request.impersonatorUserWorkspaceId,
        );
        const audit = new CrmAuditTransactionContext(runner, operation);
        audit.record({
          action: 'update',
          resourceKind: 'coreWorkflow',
          resourceId: request.coreWorkflowId,
          before: {
            createdByUserWorkspaceId: beforeCreatedBy,
            visibility: beforeVisibility,
          },
          after: {
            createdByUserWorkspaceId: afterCreatedBy,
            visibility: afterVisibility,
          },
          securityDescriptor: {
            resourceKind: 'coreWorkflow',
            resourceId: request.coreWorkflowId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
        await audit.flush();

        const [postFlushWorkflow] = await readWorkflow();
        if (
          !postFlushWorkflow ||
          postFlushWorkflow.deletedAt !== null ||
          uuid(postFlushWorkflow.workspaceId) !== request.workspaceId ||
          nullableUuid(postFlushWorkflow.createdByUserWorkspaceId) !==
            afterCreatedBy ||
          assertWorkflowOrViewVisibility(postFlushWorkflow.visibility) !==
            afterVisibility
        ) {
          throw new Error(
            'Core workflow visibility state changed during audit flush',
          );
        }
        if (persistedIntent) {
          await persistedIntent.verify();
        }

        return {
          status: 'updated' as const,
          changed: true,
          intentId: persistedIntent?.intentId,
        };
      }),
    );
  } finally {
    active.delete(request);
  }
};

export const runAuditedCoreViewUpdate = async <TResult>(
  dataSource: DataSource | undefined,
  request: CoreViewUpdateAuditRequest,
  actions: ViewMigrationAction[],
  mappings: CoreViewAuditMappings | undefined,
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (
    !request ||
    typeof request !== 'object' ||
    request.kind !== 'coreViewUpdate' ||
    !active.has(request) ||
    consumed.has(request) ||
    hasConflictingMetadataAuditScope(
      request.workspaceId,
      getCoreWorkflowAndViewAudit,
    )
  ) {
    throw new Error('Core view update audit scope is invalid or reused');
  }
  if (!dataSource) {
    throw new Error('Core view update audit requires core DataSource');
  }
  if (!mappings?.views) {
    throw new Error('Core view update audit requires view mappings');
  }

  const viewActions = actions.filter(
    (action) => action.metadataName === 'view',
  );
  for (const action of actions) {
    if (
      action.metadataName !== 'view' &&
      !(
        action.metadataName === 'viewGroup' &&
        (action.type === 'create' || action.type === 'delete')
      )
    ) {
      throw new Error(
        `Core view update audit does not allow ${action.metadataName} ${action.type} action`,
      );
    }
  }
  if (viewActions.some((action) => action.type !== 'update')) {
    throw new Error(
      'Core view update audit allows only update actions on view',
    );
  }
  for (const viewAction of viewActions) {
    const mappedViewId =
      mappings.views[uuid(viewAction.universalIdentifier)]?.id;
    if (!mappedViewId || uuid(mappedViewId) !== request.viewId) {
      throw new Error('Core view update audit resolved a different view ID');
    }
  }

  consumed.add(request);

  return runInCoreAuditTransaction(dataSource, async (runner) => {
    await runner.query("SET LOCAL lock_timeout = '8s'");
    await verifyActiveWorkspaceAndMembership(
      runner,
      request.workspaceId,
      request.userWorkspaceId,
      request.operation,
      false,
    );

    const readView = () =>
      runner.query(
        `SELECT v.id,
                v."workspaceId",
                to_jsonb(v)->>'createdByUserWorkspaceId' AS "createdByUserWorkspaceId",
                to_jsonb(v)->>'visibility' AS "visibility",
                to_jsonb(v)->>'deletedAt' AS "deletedAt",
                to_jsonb(v) AS row
           FROM core.view v
          WHERE v.id=$1 AND v."workspaceId"=$2
            FOR NO KEY UPDATE`,
        [request.viewId, request.workspaceId],
      );

    const [beforeView] = await readView();
    if (
      !beforeView ||
      beforeView.deletedAt !== null ||
      uuid(beforeView.workspaceId) !== request.workspaceId
    ) {
      throw new Error('Core view update target view is unavailable');
    }

    const beforeCreatedBy = nullableUuid(beforeView.createdByUserWorkspaceId);
    const beforeVisibility = assertWorkflowOrViewVisibility(
      beforeView.visibility,
    );

    const expectedVisibility =
      viewActions.length > 0 &&
      viewActions.some(
        (action) =>
          action.update !== undefined &&
          'visibility' in action.update &&
          action.update.visibility !== undefined,
      )
        ? assertWorkflowOrViewVisibility(
            viewActions.find(
              (action) =>
                action.update !== undefined &&
                'visibility' in action.update &&
                action.update.visibility !== undefined,
            )!.update!.visibility,
          )
        : beforeVisibility;

    const expectedCreatedBy =
      viewActions.length > 0 &&
      viewActions.some(
        (action) =>
          action.update !== undefined &&
          'createdByUserWorkspaceId' in action.update &&
          action.update.createdByUserWorkspaceId !== undefined,
      )
        ? nullableUuid(
            viewActions.find(
              (action) =>
                action.update !== undefined &&
                'createdByUserWorkspaceId' in action.update &&
                action.update.createdByUserWorkspaceId !== undefined,
            )!.update!.createdByUserWorkspaceId,
          )
        : beforeCreatedBy;

    if (
      beforeVisibility !== expectedVisibility ||
      beforeCreatedBy !== expectedCreatedBy
    ) {
      if (request.userWorkspaceId === undefined) {
        throw new Error(
          'Core view visibility or creator update requires an authenticated userWorkspaceId',
        );
      }
      if (
        beforeCreatedBy !== null &&
        beforeCreatedBy !== request.userWorkspaceId
      ) {
        throw new Error(
          'Core view visibility or creator can only be changed by its creator',
        );
      }
    }

    if (
      beforeVisibility === 'UNLISTED' &&
      (request.userWorkspaceId === undefined ||
        beforeCreatedBy !== request.userWorkspaceId)
    ) {
      throw new Error('Unlisted core view can only be modified by its creator');
    }

    const result = await work(runner);

    const [afterView] = await readView();
    if (
      !afterView ||
      afterView.deletedAt !== null ||
      uuid(afterView.workspaceId) !== request.workspaceId
    ) {
      throw new Error('Core view update removed or corrupted target view');
    }

    const afterCreatedBy = nullableUuid(afterView.createdByUserWorkspaceId);
    const afterVisibility = assertWorkflowOrViewVisibility(
      afterView.visibility,
    );

    if (afterVisibility !== expectedVisibility) {
      throw new Error('Core view update did not persist expected visibility');
    }
    if (afterCreatedBy !== expectedCreatedBy) {
      throw new Error(
        'Core view update did not persist expected createdByUserWorkspaceId',
      );
    }

    if (afterVisibility === 'UNLISTED') {
      if (afterCreatedBy === null) {
        throw new Error(
          'Unlisted view requires a valid creator userWorkspaceId',
        );
      }
      if (
        request.userWorkspaceId === undefined ||
        afterCreatedBy !== request.userWorkspaceId
      ) {
        throw new Error(
          'Unlisted view transition must assign creator to the authenticated userWorkspaceId',
        );
      }
    }

    const changed =
      beforeCreatedBy !== afterCreatedBy ||
      beforeVisibility !== afterVisibility;

    if (changed) {
      const operation = await resolveRoleAuditInitiator(
        runner,
        request.operation,
        request.impersonatorUserWorkspaceId,
      );
      const audit = new CrmAuditTransactionContext(runner, operation);
      audit.record({
        action: 'update',
        resourceKind: 'coreView',
        resourceId: request.viewId,
        before: {
          createdByUserWorkspaceId: beforeCreatedBy,
          visibility: beforeVisibility,
        },
        after: {
          createdByUserWorkspaceId: afterCreatedBy,
          visibility: afterVisibility,
        },
        securityDescriptor: {
          resourceKind: 'coreView',
          resourceId: request.viewId,
          metadataAccess: 'currentWorkspaceAdministration',
        },
      });
      await audit.flush();

      const [postFlushView] = await readView();
      if (
        !postFlushView ||
        postFlushView.deletedAt !== null ||
        uuid(postFlushView.workspaceId) !== request.workspaceId ||
        nullableUuid(postFlushView.createdByUserWorkspaceId) !==
          afterCreatedBy ||
        assertWorkflowOrViewVisibility(postFlushView.visibility) !==
          afterVisibility ||
        canonicalAuditJson(postFlushView.row) !==
          canonicalAuditJson(afterView.row)
      ) {
        throw new Error('Core view state changed during audit flush');
      }
    }

    return result;
  });
};
