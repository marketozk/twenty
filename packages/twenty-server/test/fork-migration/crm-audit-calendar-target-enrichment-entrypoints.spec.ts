import { randomUUID } from 'node:crypto';
import { ReconcilePersonCompanyTargetsJob } from 'src/modules/match-participant/jobs/reconcile-person-company-targets.job';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
jest.mock(
  'src/modules/match-participant/participant-target-reconciliation.service',
  () => ({ ParticipantTargetReconciliationService: class {} }),
);

it('target enrichment job copies IDs and supplies a named system operation before handing off', async () => {
  const input = { workspaceId: randomUUID(), personIds: [randomUUID()] },
    workspaceId = input.workspaceId,
    personId = input.personIds[0];
  const reconcile = jest.fn().mockImplementation(async (args) => {
    input.workspaceId = randomUUID();
    input.personIds.splice(0);
    expect(args).toMatchObject({
      workspaceId,
      personIds: [personId],
      operation: {
        workspaceId,
        actor: { kind: 'system', id: ReconcilePersonCompanyTargetsJob.name },
        operationId: expect.any(String),
        correlationId: expect.any(String),
      },
    });
    expect(args.personIds).not.toBe(input.personIds);
  });
  await new ReconcilePersonCompanyTargetsJob({
    reconcileTargetsForPeople: reconcile,
  } as never).handle(input);
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it.each(['ordinary', 'unknown', 'confirmed'] as const)(
  'target enrichment job preserves %s errors without retry',
  async (kind) => {
    const error =
      kind === 'ordinary'
        ? new Error('failure')
        : kind === 'confirmed'
          ? new CoreAuditPostCommitError(new Error('hook'))
          : new NativeTransactionOutcomeUnknownError(
              'commit',
              new Error('ACK'),
            );
    const reconcile = jest.fn().mockRejectedValue(error);
    const job = new ReconcilePersonCompanyTargetsJob({
      reconcileTargetsForPeople: reconcile,
    } as never);
    await expect(
      job.handle({ workspaceId: randomUUID(), personIds: [randomUUID()] }),
    ).rejects.toBe(error);
    expect(reconcile).toHaveBeenCalledTimes(1);
  },
);

it('target enrichment job gives independent invocations distinct operation and correlation identifiers', async () => {
  const reconcile = jest.fn().mockResolvedValue(undefined),
    job = new ReconcilePersonCompanyTargetsJob({
      reconcileTargetsForPeople: reconcile,
    } as never);
  const input = { workspaceId: randomUUID(), personIds: [randomUUID()] };
  await job.handle(input);
  await job.handle(input);
  expect(reconcile.mock.calls[0][0].operation.operationId).not.toBe(
    reconcile.mock.calls[1][0].operation.operationId,
  );
  expect(reconcile.mock.calls[0][0].operation.correlationId).not.toBe(
    reconcile.mock.calls[1][0].operation.correlationId,
  );
});
