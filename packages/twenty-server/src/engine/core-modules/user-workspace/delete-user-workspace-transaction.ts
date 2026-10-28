import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type DataSource, type EntityTarget, type QueryRunner } from 'typeorm';

import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { captureMembershipCleanupAudit } from 'src/engine/core-modules/crm-audit/membership-cleanup-audit';

export const deleteUserWorkspaceTransaction = async ({
  dataSource,
  entities: { membership: membershipEntity, roleTarget: roleTargetEntity },
  workspaceId,
  userWorkspaceId,
  softDelete,
  persistReconciliation,
  auditOperation,
}: {
  dataSource: DataSource;
  entities: {
    membership: EntityTarget<{ id: string; workspaceId: string }>;
    roleTarget: EntityTarget<{
      workspaceId: string;
      userWorkspaceId: string | null;
    }>;
  };
  workspaceId: string;
  userWorkspaceId: string;
  softDelete: boolean;
  auditOperation?: CrmAuditOperation;
  persistReconciliation: (args: {
    queryRunner: QueryRunner;
    coreWorkflowId: string;
    applicationUniversalIdentifier: string;
  }) => Promise<() => Promise<void>>;
}): Promise<string[]> => {
  if (!isUUID(workspaceId) || !isUUID(userWorkspaceId))
    throw new Error('Membership deletion identity invalid');
  workspaceId = workspaceId.toLowerCase();
  userWorkspaceId = userWorkspaceId.toLowerCase();
  const operation = auditOperation
    ? {
        ...auditOperation,
        actor: { ...auditOperation.actor },
        ...(auditOperation.initiator
          ? { initiator: { ...auditOperation.initiator } }
          : {}),
      }
    : undefined;
  if (operation && operation.workspaceId.toLowerCase() !== workspaceId)
    throw new Error('Membership audit workspace mismatch');
  let auditUnavailable = false;

  try {
    return await runInCoreAuditTransaction(dataSource, async (queryRunner) => {
      const context = operation
        ? new CrmAuditTransactionContext(queryRunner, operation)
        : undefined;
      await queryRunner.query("SET LOCAL lock_timeout = '8s'");
      const [workspace] = await queryRunner.query(
        'SELECT "deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
        [workspaceId],
      );
      const [membership] = await queryRunner.query(
        'SELECT "workspaceId" FROM core."userWorkspace" WHERE id=$1 FOR UPDATE',
        [userWorkspaceId],
      );
      if (!membership) return [];
      if (!workspace || membership.workspaceId !== workspaceId)
        throw new Error('Membership deletion workspace mismatch');

      let audit:
        | Awaited<ReturnType<typeof captureMembershipCleanupAudit>>
        | undefined;
      if (context) {
        // Scope and mutation checks remain mandatory even if journal coverage fails.
        audit = await captureMembershipCleanupAudit({
          runner: queryRunner,
          context,
          workspaceId,
          userWorkspaceId,
          softDelete,
        });
        await queryRunner.query('SAVEPOINT membership_audit_capture');
        try {
          await audit.verifyCoverage();
        } catch {
          auditUnavailable = true;
          await queryRunner.query(
            'ROLLBACK TO SAVEPOINT membership_audit_capture',
          );
        }
        await queryRunner.query('RELEASE SAVEPOINT membership_audit_capture');
      }
      const finishAudit = async (verifyCleanup: () => Promise<void>) => {
        await verifyCleanup();
        if (!audit) return;
        await audit.verify();
        if (auditUnavailable) return;
        await queryRunner.query('SAVEPOINT membership_cleanup_audit');
        try {
          await audit.append();
          await audit.verify();
          await verifyCleanup();
        } catch {
          auditUnavailable = true;
          await queryRunner.query(
            'ROLLBACK TO SAVEPOINT membership_cleanup_audit',
          );
        }
        await queryRunner.query('RELEASE SAVEPOINT membership_cleanup_audit');
        await audit.verify();
        await verifyCleanup();
      };

      const membershipRepository =
        queryRunner.manager.getRepository(membershipEntity);
      const criteria = { id: userWorkspaceId, workspaceId };
      if (softDelete) {
        // Retained role targets have no deletedAt; access is gated by membership.
        await membershipRepository.softDelete(criteria);
        const [deletedMembership] = await queryRunner.query(
          'SELECT "workspaceId", "deletedAt" FROM core."userWorkspace" WHERE id=$1',
          [userWorkspaceId],
        );
        if (
          deletedMembership?.workspaceId !== workspaceId ||
          !deletedMembership.deletedAt
        )
          throw new Error('Membership soft deletion was not applied');
        await finishAudit(async () => {
          const [row] = await queryRunner.query(
            'SELECT "workspaceId", "deletedAt" FROM core."userWorkspace" WHERE id=$1',
            [userWorkspaceId],
          );
          if (row?.workspaceId !== workspaceId || !row.deletedAt)
            throw new Error('Membership soft deletion was not applied');
        });
        return [];
      }

      const workflows: {
        id: string;
        workspaceId: string;
        applicationWorkspaceId: string | null;
        applicationUniversalIdentifier: string | null;
      }[] = await queryRunner.query(
        `SELECT w.id, w."workspaceId", a."workspaceId" AS "applicationWorkspaceId",
         a."universalIdentifier" AS "applicationUniversalIdentifier"
       FROM core.workflow w LEFT JOIN core.application a ON a.id=w."applicationId"
       WHERE w."createdByUserWorkspaceId"=$1 ORDER BY w.id FOR UPDATE OF w`,
        [userWorkspaceId],
      );
      const [foreignTarget] = await queryRunner.query(
        'SELECT id FROM core."roleTarget" WHERE "userWorkspaceId"=$1 AND "workspaceId"<>$2 LIMIT 1',
        [userWorkspaceId, workspaceId],
      );
      if (
        foreignTarget ||
        workflows.some((workflow) => workflow.workspaceId !== workspaceId)
      )
        throw new Error('Membership deletion has foreign dependencies');

      const coreWorkflowIds: string[] = [];
      const verifyIntents: (() => Promise<void>)[] = [];
      if (!workspace.deletedAt) {
        for (const workflow of workflows) {
          if (
            workflow.applicationWorkspaceId !== workspaceId ||
            !workflow.applicationUniversalIdentifier ||
            !isUUID(workflow.applicationUniversalIdentifier)
          )
            throw new Error('Workflow reconciliation application unavailable');
          verifyIntents.push(
            await persistReconciliation({
              queryRunner,
              coreWorkflowId: workflow.id,
              applicationUniversalIdentifier:
                workflow.applicationUniversalIdentifier,
            }),
          );
          coreWorkflowIds.push(workflow.id);
        }
      }

      const targetRepository =
        queryRunner.manager.getRepository(roleTargetEntity);
      if (audit) {
        const result = await targetRepository
          .createQueryBuilder()
          .delete()
          .where({ workspaceId, userWorkspaceId })
          .returning('id')
          .execute();
        audit.verifyDeletedRoleTargets(
          result.raw.map((row: { id: string }) => row.id),
        );
      } else await targetRepository.delete({ workspaceId, userWorkspaceId });
      await membershipRepository.delete(criteria);
      const verifyCleanup = async () => {
        const remaining = await queryRunner.query(
          'SELECT id FROM core."userWorkspace" WHERE id=$1 UNION ALL SELECT id FROM core."roleTarget" WHERE "userWorkspaceId"=$1',
          [userWorkspaceId],
        );
        if (remaining.length !== 0)
          throw new Error('Membership deletion was not applied');
        for (const verify of verifyIntents) await verify();
      };
      await finishAudit(verifyCleanup);
      return coreWorkflowIds;
    });
  } finally {
    if (auditUnavailable)
      new Logger('MembershipCleanupAudit').error(
        `MEMBERSHIP_CLEANUP_AUDIT_UNAVAILABLE operationId=${operation?.operationId}`,
      );
  }
};
