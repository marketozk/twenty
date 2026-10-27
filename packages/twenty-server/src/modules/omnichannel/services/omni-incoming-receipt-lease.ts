import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type OmniIncomingReceiptState } from 'src/engine/core-modules/omnichannel-storage/entities/omni-incoming-receipt.entity';
import { type OmniIncomingPrincipal } from 'src/modules/omnichannel/services/accept-omni-incoming-event';

type LeaseAction = 'claim' | 'renew' | 'defer';

export type OmniIncomingReceiptLeaseProof = Readonly<{
  receiptId: string;
  leaseOwner: string;
  leaseToken: string;
  routeGeneration: string;
}>;

export type OmniIncomingReceiptLeaseClaim = OmniIncomingReceiptLeaseProof & {
  leaseUntil: string;
  attempts: number;
};

export type OmniIncomingReceiptLeaseAuthorizer = (
  queryRunner: QueryRunner,
  authorization: Readonly<OmniIncomingPrincipal & { action: LeaseAction }>,
) => Promise<void>;

export type OmniIncomingReceiptDeferOutcome =
  | {
      state: 'retryable_error';
      errorCode: 'transient_failure';
      retryAfterMilliseconds: number;
    }
  | { state: 'blocked_config'; errorCode: 'configuration_missing' }
  | {
      state: 'quarantined';
      errorCode:
        | 'invalid_envelope'
        | 'unsupported_event'
        | 'inconsistent_source';
    };

export type OmniIncomingReceiptDeferred = {
  receiptId: string;
  state: OmniIncomingReceiptDeferOutcome['state'];
  nextAttemptAt: string;
  errorCode: OmniIncomingReceiptDeferOutcome['errorCode'];
};

export class OmniIncomingLeaseLostError extends Error {
  constructor() {
    super('OMNI_INCOMING_LEASE_LOST');
    this.name = 'OmniIncomingLeaseLostError';
  }
}

export class OmniIncomingLeaseOutcomeUnknownError extends Error {
  constructor(
    readonly action: LeaseAction,
    readonly receiptIds: readonly string[],
    cause: unknown,
  ) {
    super('OMNI_INCOMING_LEASE_OUTCOME_UNKNOWN', { cause });
    this.name = 'OmniIncomingLeaseOutcomeUnknownError';
  }
}

type ReceiptRow = {
  id: string;
  bindingId: string;
  routeGeneration: string;
  state: OmniIncomingReceiptState;
  attempts: number;
  leaseToken: string;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  nextAttemptAt: Date;
  errorCode: string | null;
};

const RECEIPT_COLUMNS = `id, "bindingId", "routeGeneration", state, attempts,
  "leaseToken", "leaseOwner", "leaseUntil", "nextAttemptAt", "errorCode"`;

const invalidInput = (): never => {
  throw new Error('OMNI_INCOMING_LEASE_INVALID_INPUT');
};

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value)) return invalidInput();

  return value.toLowerCase();
};

const positiveBigint = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return invalidInput();

  return value;
};

const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalidInput();
  }

  return value;
};

const onlyKeys = (value: object, keys: string[]) => {
  if (!value || Object.keys(value).some((key) => !keys.includes(key)))
    invalidInput();
};

const principalSnapshot = (
  principal: OmniIncomingPrincipal,
  authorize: OmniIncomingReceiptLeaseAuthorizer,
): OmniIncomingPrincipal => {
  if (
    !principal ||
    principal.actor?.kind !== 'system' ||
    typeof principal.actor.id !== 'string' ||
    principal.actor.id.length === 0 ||
    principal.actor.id.length > 256 ||
    principal.actor.id.trim() !== principal.actor.id ||
    /[\u0000-\u001f\u007f]/.test(principal.actor.id) ||
    typeof authorize !== 'function'
  )
    return invalidInput();

  return Object.freeze({
    workspaceId: uuid(principal.workspaceId),
    bindingId: uuid(principal.bindingId),
    actor: Object.freeze({ kind: 'system' as const, id: principal.actor.id }),
  });
};

const proofSnapshot = (
  proof: OmniIncomingReceiptLeaseProof,
): OmniIncomingReceiptLeaseProof => {
  if (!proof) return invalidInput();

  return Object.freeze({
    receiptId: uuid(proof.receiptId),
    leaseOwner: uuid(proof.leaseOwner),
    leaseToken: positiveBigint(proof.leaseToken),
    routeGeneration: positiveBigint(proof.routeGeneration),
  });
};

const auditSnapshot = (row: ReceiptRow) => ({
  bindingId: row.bindingId,
  routeGeneration: row.routeGeneration,
  state: row.state,
  attempts: row.attempts,
  leaseToken: row.leaseToken,
  leaseOwner: row.leaseOwner,
  leaseUntil: row.leaseUntil?.toISOString() ?? null,
  nextAttemptAt: row.nextAttemptAt.toISOString(),
  errorCode: row.errorCode,
});

const claimResult = (row: ReceiptRow): OmniIncomingReceiptLeaseClaim => {
  if (!row.leaseOwner || !row.leaseUntil)
    throw new OmniIncomingLeaseLostError();

  return {
    receiptId: row.id,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    routeGeneration: row.routeGeneration,
    leaseUntil: row.leaseUntil.toISOString(),
    attempts: row.attempts,
  };
};

const appendFailure = async (
  dataSource: DataSource,
  operation: Parameters<typeof appendCrmAuditAttempt>[1],
  attempt: Parameters<typeof appendCrmAuditAttempt>[2],
) => {
  const queryRunner = dataSource.createQueryRunner('master');
  let failure: unknown;
  let hasFailure = false;

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await appendCrmAuditAttempt(queryRunner, operation, attempt);
    await queryRunner.commitTransaction();
  } catch (error) {
    hasFailure = true;
    failure = error;
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          'AUDIT_ROLLBACK_UNCONFIRMED',
        );
        try {
          await queryRunner.query('ROLLBACK');
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'AUDIT_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    }
    throw failure;
  } finally {
    try {
      await queryRunner.release();
    } catch (releaseError) {
      if (hasFailure)
        throw new AggregateError(
          [failure, releaseError],
          'AUDIT_CLEANUP_FAILED',
        );
      throw releaseError;
    }
  }
};

type LeaseTransaction = {
  queryRunner: QueryRunner;
  routeGeneration: string;
  receiptIds: string[];
  record: (before: ReceiptRow, after: ReceiptRow) => void;
};

const runLeaseTransaction = async <TResult>(
  dataSource: DataSource,
  principal: OmniIncomingPrincipal,
  action: LeaseAction,
  authorize: OmniIncomingReceiptLeaseAuthorizer,
  requestedReceiptIds: string[],
  work: (transaction: LeaseTransaction) => Promise<TResult>,
): Promise<TResult> => {
  const operationId = randomUUID();
  const receiptIds = [...requestedReceiptIds];
  const queryRunner = dataSource.createQueryRunner('master');
  let commitAttempted = false;
  let auditEligible = false;
  let authorizationDenied = false;
  let hasFailure = false;
  let failure: unknown;

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const [policy]: { id: string }[] = await queryRunner.query(
      `SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE`,
      [principal.workspaceId],
    );
    if (!policy) throw new Error('OMNI_INCOMING_LEASE_POLICY_STATE_MISSING');
    const [binding]: { status: string; routeGeneration: string }[] =
      await queryRunner.query(
        `SELECT status,"routeGeneration" FROM core."omniAccountBinding"
       WHERE "workspaceId"=$1 AND id=$2 FOR SHARE`,
        [principal.workspaceId, principal.bindingId],
      );
    if (!binding) throw new Error('OMNI_INCOMING_LEASE_BINDING_NOT_FOUND');
    auditEligible = true;
    try {
      await authorize(queryRunner, Object.freeze({ ...principal, action }));
    } catch (error) {
      authorizationDenied = true;
      throw error;
    }
    if (binding.status !== 'active')
      throw new Error('OMNI_INCOMING_LEASE_BINDING_INACTIVE');
    const audit = new CrmAuditTransactionContext(queryRunner, {
      workspaceId: principal.workspaceId,
      operationId,
      actor: principal.actor,
    });
    const result = await work({
      queryRunner,
      routeGeneration: binding.routeGeneration,
      receiptIds,
      record: (before, after) =>
        audit.record({
          resourceKind: 'omniIncomingReceipt',
          resourceId: after.id,
          action: 'update',
          before: auditSnapshot(before),
          after: auditSnapshot(after),
          securityDescriptor: {
            resourceKind: 'omniIncomingReceipt',
            resourceId: after.id,
            bindingId: principal.bindingId,
          },
        }),
    });
    await audit.flush();
    commitAttempted = true;
    await queryRunner.commitTransaction();

    return result;
  } catch (error) {
    hasFailure = true;
    failure = error;
    let rollbackConfirmed = false;
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
        rollbackConfirmed = true;
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          'OMNI_INCOMING_LEASE_ROLLBACK_UNCONFIRMED',
        );
        try {
          await queryRunner.query('ROLLBACK');
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'OMNI_INCOMING_LEASE_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    }
    if (commitAttempted) {
      failure = new OmniIncomingLeaseOutcomeUnknownError(
        action,
        [...receiptIds],
        failure,
      );
      throw failure;
    }
    if (auditEligible && rollbackConfirmed) {
      const resourceKind = receiptIds.length
        ? 'omniIncomingReceipt'
        : 'omniAccountBinding';
      const resourceId = receiptIds[0] ?? principal.bindingId;
      try {
        await queryRunner.release();
        await appendFailure(
          dataSource,
          {
            workspaceId: principal.workspaceId,
            operationId,
            actor: principal.actor,
          },
          {
            attemptId: randomUUID(),
            resourceKind,
            resourceId,
            action: 'update',
            outcome: authorizationDenied ? 'denied' : 'failed',
            reasonCode: `receipt_lease.${action}.${authorizationDenied ? 'denied' : 'failed'}`,
            securityDescriptor: {
              resourceKind,
              resourceId,
              bindingId: principal.bindingId,
            },
          },
        );
      } catch (auditError) {
        failure = new AggregateError(
          [error, auditError],
          'OMNI_INCOMING_LEASE_FAILURE_AUDIT_UNCONFIRMED',
        );
      }
    }
    throw failure;
  } finally {
    if (!queryRunner.isReleased) {
      try {
        await queryRunner.release();
      } catch (releaseError) {
        if (commitAttempted)
          throw new OmniIncomingLeaseOutcomeUnknownError(
            action,
            [...receiptIds],
            hasFailure
              ? new AggregateError([failure, releaseError])
              : releaseError,
          );
        if (hasFailure)
          throw new AggregateError(
            [failure, releaseError],
            'OMNI_INCOMING_LEASE_CLEANUP_FAILED',
          );
        throw releaseError;
      }
    }
  }
};

// Internal lifecycle only; no caller can mark a receipt applied through this service.
export const claimOmniIncomingReceipts = async (
  dataSource: DataSource,
  trustedPrincipal: OmniIncomingPrincipal,
  input: { leaseOwner: string; limit: number; leaseMilliseconds: number },
  authorize: OmniIncomingReceiptLeaseAuthorizer,
): Promise<OmniIncomingReceiptLeaseClaim[]> => {
  const principal = principalSnapshot(trustedPrincipal, authorize);
  onlyKeys(input, ['leaseOwner', 'limit', 'leaseMilliseconds']);
  const leaseOwner = uuid(input.leaseOwner);
  const limit = boundedInteger(input.limit, 1, 100);
  const leaseMilliseconds = boundedInteger(
    input.leaseMilliseconds,
    1000,
    300000,
  );

  return runLeaseTransaction(
    dataSource,
    principal,
    'claim',
    authorize,
    [],
    async (transaction) => {
      const rows: ReceiptRow[] = await transaction.queryRunner.query(
        `SELECT ${RECEIPT_COLUMNS} FROM core."omniIncomingReceipt"
       WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "routeGeneration"=$3
         AND ((state IN ('accepted','retryable_error') AND "nextAttemptAt" <= clock_timestamp())
           OR (state='processing' AND "leaseUntil" <= clock_timestamp()))
       ORDER BY "nextAttemptAt", id LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [
          principal.workspaceId,
          principal.bindingId,
          transaction.routeGeneration,
          limit,
        ],
      );
      transaction.receiptIds.push(...rows.map((row) => row.id));
      const results: OmniIncomingReceiptLeaseClaim[] = [];

      for (const before of rows) {
        const [after]: ReceiptRow[] = await transaction.queryRunner.query(
          `WITH changed AS (
         UPDATE core."omniIncomingReceipt" SET state='processing', "leaseOwner"=$4,
           "leaseToken"="leaseToken"+1, attempts=attempts+1,
           "leaseUntil"=clock_timestamp()+$5*interval '1 millisecond', "updatedAt"=clock_timestamp()
         WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 RETURNING ${RECEIPT_COLUMNS}
         ) SELECT * FROM changed`,
          [
            principal.workspaceId,
            principal.bindingId,
            before.id,
            leaseOwner,
            leaseMilliseconds,
          ],
        );
        transaction.record(before, after);
        results.push(claimResult(after));
      }

      return results;
    },
  );
};

const lockReceipt = async (
  transaction: LeaseTransaction,
  principal: OmniIncomingPrincipal,
  proof: OmniIncomingReceiptLeaseProof,
): Promise<ReceiptRow> => {
  const [receipt]: ReceiptRow[] = await transaction.queryRunner.query(
    `SELECT ${RECEIPT_COLUMNS} FROM core."omniIncomingReceipt"
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
    [principal.workspaceId, principal.bindingId, proof.receiptId],
  );
  if (
    !receipt ||
    transaction.routeGeneration !== proof.routeGeneration ||
    receipt.routeGeneration !== proof.routeGeneration ||
    receipt.state !== 'processing' ||
    receipt.leaseOwner !== proof.leaseOwner ||
    receipt.leaseToken !== proof.leaseToken
  ) {
    throw new OmniIncomingLeaseLostError();
  }

  return receipt;
};

export const renewOmniIncomingReceiptLease = async (
  dataSource: DataSource,
  trustedPrincipal: OmniIncomingPrincipal,
  inputProof: OmniIncomingReceiptLeaseProof,
  input: { leaseMilliseconds: number },
  authorize: OmniIncomingReceiptLeaseAuthorizer,
): Promise<OmniIncomingReceiptLeaseClaim> => {
  const principal = principalSnapshot(trustedPrincipal, authorize);
  const proof = proofSnapshot(inputProof);
  onlyKeys(input, ['leaseMilliseconds']);
  const duration = boundedInteger(input.leaseMilliseconds, 1000, 300000);

  return runLeaseTransaction(
    dataSource,
    principal,
    'renew',
    authorize,
    [proof.receiptId],
    async (transaction) => {
      const before = await lockReceipt(transaction, principal, proof);
      const [after]: ReceiptRow[] = await transaction.queryRunner.query(
        `WITH changed AS (
       UPDATE core."omniIncomingReceipt"
       SET "leaseUntil"=GREATEST("leaseUntil",clock_timestamp()+$7*interval '1 millisecond'),
         "updatedAt"=clock_timestamp()
       WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing'
         AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6
         AND "leaseUntil">clock_timestamp() RETURNING ${RECEIPT_COLUMNS}
       ) SELECT * FROM changed`,
        [
          principal.workspaceId,
          principal.bindingId,
          proof.receiptId,
          proof.leaseOwner,
          proof.leaseToken,
          proof.routeGeneration,
          duration,
        ],
      );
      if (!after) throw new OmniIncomingLeaseLostError();
      transaction.record(before, after);

      return claimResult(after);
    },
  );
};

export const deferOmniIncomingReceipt = async (
  dataSource: DataSource,
  trustedPrincipal: OmniIncomingPrincipal,
  inputProof: OmniIncomingReceiptLeaseProof,
  input: OmniIncomingReceiptDeferOutcome,
  authorize: OmniIncomingReceiptLeaseAuthorizer,
): Promise<OmniIncomingReceiptDeferred> => {
  const principal = principalSnapshot(trustedPrincipal, authorize);
  const proof = proofSnapshot(inputProof);
  if (!input) return invalidInput();
  const state = input.state;
  const errorCode = input.errorCode;
  let retryAfterMilliseconds: number | null = null;

  if (state === 'retryable_error' && errorCode === 'transient_failure') {
    onlyKeys(input, ['state', 'errorCode', 'retryAfterMilliseconds']);
    retryAfterMilliseconds = boundedInteger(
      input.retryAfterMilliseconds,
      1000,
      86400000,
    );
  } else if (
    (state === 'blocked_config' && errorCode === 'configuration_missing') ||
    (state === 'quarantined' &&
      ['invalid_envelope', 'unsupported_event', 'inconsistent_source'].includes(
        errorCode,
      ))
  ) {
    onlyKeys(input, ['state', 'errorCode']);
  } else return invalidInput();

  return runLeaseTransaction(
    dataSource,
    principal,
    'defer',
    authorize,
    [proof.receiptId],
    async (transaction) => {
      const before = await lockReceipt(transaction, principal, proof);
      const [after]: ReceiptRow[] = await transaction.queryRunner.query(
        `WITH changed AS (
       UPDATE core."omniIncomingReceipt" SET state=$7, "errorCode"=$8,
         "leaseOwner"=NULL, "leaseUntil"=NULL,
         "nextAttemptAt"=CASE WHEN $9::integer IS NULL THEN "nextAttemptAt"
           ELSE clock_timestamp()+$9*interval '1 millisecond' END, "updatedAt"=clock_timestamp()
       WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing'
         AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6
         AND "leaseUntil">clock_timestamp() RETURNING ${RECEIPT_COLUMNS}
       ) SELECT * FROM changed`,
        [
          principal.workspaceId,
          principal.bindingId,
          proof.receiptId,
          proof.leaseOwner,
          proof.leaseToken,
          proof.routeGeneration,
          state,
          errorCode,
          retryAfterMilliseconds,
        ],
      );
      if (!after) throw new OmniIncomingLeaseLostError();
      transaction.record(before, after);

      return {
        receiptId: after.id,
        state,
        errorCode,
        nextAttemptAt: after.nextAttemptAt.toISOString(),
      };
    },
  );
};
