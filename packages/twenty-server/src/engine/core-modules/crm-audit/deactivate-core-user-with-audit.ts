import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type DataSource, type EntityTarget } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export const deactivateCoreUserWithAudit = async ({
  dataSource,
  userEntity,
  userId,
  auditOperations,
  invalidate,
}: {
  dataSource: DataSource;
  userEntity: EntityTarget<{ id: string }>;
  userId: string;
  auditOperations: readonly (CrmAuditOperation | undefined)[];
  invalidate: () => Promise<unknown>;
}): Promise<
  'deleted' | 'already-deleted' | 'not-found' | 'active-memberships'
> => {
  if (!isUUID(userId)) throw new Error('Core user deletion identity invalid');
  userId = userId.toLowerCase();
  const incompleteScope =
    auditOperations.length === 0 ||
    auditOperations.some((operation) => operation === undefined);
  const operations = auditOperations
    .filter((operation) => operation !== undefined)
    .map((operation) => ({
      ...operation,
      actor: { ...operation.actor },
      ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
    }));
  if (
    new Set(operations.map((operation) => operation.workspaceId.toLowerCase()))
      .size !== operations.length
  )
    throw new Error('Duplicate core user audit workspace');
  let auditUnavailable = false;
  const logger = new Logger('CoreUserDeactivation');
  try {
    return await runInCoreAuditTransaction(dataSource, async (runner) => {
      const contexts = operations.map(
        (operation) => new CrmAuditTransactionContext(runner, operation),
      );
      await runner.query("SET LOCAL lock_timeout = '8s'");
      const snapshot = async () => {
        const rows = await runner.query(
          'SELECT to_jsonb(account) AS snapshot FROM core."user" AS account WHERE id=$1',
          [userId],
        );
        return rows[0]?.snapshot as Record<string, unknown> | undefined;
      };
      await runner.query('SELECT id FROM core."user" WHERE id=$1 FOR UPDATE', [
        userId,
      ]);
      const before = await snapshot();
      if (!before) return 'not-found';
      if (
        !Object.hasOwn(before, 'deletedAt') ||
        typeof before.updatedAt !== 'string'
      )
        throw new Error('Core user snapshot is invalid');
      if (before.deletedAt !== null) return 'already-deleted';
      const activeMemberships = await runner.query(
        'SELECT id FROM core."userWorkspace" WHERE "userId"=$1 AND "deletedAt" IS NULL LIMIT 1',
        [userId],
      );
      if (activeMemberships.length) return 'active-memberships';
      await runner.manager.getRepository(userEntity).softDelete({ id: userId });
      const after = await snapshot();
      const unaffected = (value: Record<string, unknown>) => {
        const {
          deletedAt: _deletedAt,
          updatedAt: _updatedAt,
          ...other
        } = value;
        return canonicalAuditJson(other);
      };
      if (
        !after ||
        typeof after.deletedAt !== 'string' ||
        typeof after.updatedAt !== 'string' ||
        unaffected(before) !== unaffected(after)
      )
        throw new Error('Core user deletion effects mismatch');
      const pinnedAfter = canonicalAuditJson(after);
      const verify = async () => {
        const current = await snapshot();
        if (!current || canonicalAuditJson(current) !== pinnedAfter)
          throw new Error('Core user deletion changed before commit');
        const remaining = await runner.query(
          'SELECT id FROM core."userWorkspace" WHERE "userId"=$1 AND "deletedAt" IS NULL LIMIT 1',
          [userId],
        );
        if (remaining.length)
          throw new Error('Core user gained active membership during deletion');
      };
      auditUnavailable = incompleteScope;
      if (contexts.length) {
        await runner.query('SAVEPOINT core_user_deactivation_audit');
        try {
          for (const context of contexts) {
            context.record({
              resourceKind: 'coreUser',
              resourceId: userId,
              action: 'update',
              before,
              after,
              securityDescriptor: {
                resourceKind: 'coreUser',
                resourceId: userId,
                metadataAccess: 'currentWorkspaceAdministration',
              },
            });
            await context.flush();
          }
          await verify();
          await runner.query('RELEASE SAVEPOINT core_user_deactivation_audit');
        } catch {
          auditUnavailable = true;
          await runner.query(
            'ROLLBACK TO SAVEPOINT core_user_deactivation_audit',
          );
          await runner.query('RELEASE SAVEPOINT core_user_deactivation_audit');
        }
      }
      await verify();
      return 'deleted';
    });
  } finally {
    if (auditUnavailable)
      logger.error('CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE');
    try {
      await invalidate();
    } catch {
      logger.error('Core user deletion cache invalidation failed');
    }
  }
};
