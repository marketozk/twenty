import { isUUID } from 'class-validator';
import { type DataSource, type EntityTarget, type QueryRunner } from 'typeorm';

import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';

export const deleteUserWorkspaceTransaction = async ({
  dataSource,
  entities: { membership: membershipEntity, roleTarget: roleTargetEntity },
  workspaceId,
  userWorkspaceId,
  softDelete,
  persistReconciliation,
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

  return runInCoreAuditTransaction(dataSource, async (queryRunner) => {
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

    await queryRunner.manager
      .getRepository(roleTargetEntity)
      .delete({ workspaceId, userWorkspaceId });
    await membershipRepository.delete(criteria);
    const remaining = await queryRunner.query(
      'SELECT id FROM core."userWorkspace" WHERE id=$1 UNION ALL SELECT id FROM core."roleTarget" WHERE "userWorkspaceId"=$1',
      [userWorkspaceId],
    );
    if (remaining.length !== 0)
      throw new Error('Membership deletion was not applied');
    for (const verify of verifyIntents) await verify();
    return coreWorkflowIds;
  });
};
