import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type OmniIncomingReceiptState } from 'src/engine/core-modules/omnichannel-storage/entities/omni-incoming-receipt.entity';
import {
  type OmniIncomingEnvelope,
  parseOmniIncomingEnvelope,
} from 'src/modules/omnichannel/contracts/omni-incoming-envelope';

export type OmniIncomingPrincipal = {
  workspaceId: string;
  bindingId: string;
  actor: { kind: 'system'; id: string };
};

export type OmniIncomingAuthorizer = (
  queryRunner: QueryRunner,
  authorization: Readonly<
    OmniIncomingPrincipal & {
      routeGeneration: string;
      kind: OmniIncomingEnvelope['kind'];
    }
  >,
) => Promise<void>;

export type OmniIncomingAcceptance = {
  receiptId: string;
  state: OmniIncomingReceiptState;
  created: boolean;
};

export class OmniIncomingConflictError extends Error {
  constructor() {
    super('OMNI_INGRESS_EVENT_CONFLICT');
    this.name = 'OmniIncomingConflictError';
  }
}

export class OmniIncomingOutcomeUnknownError extends Error {
  constructor(
    readonly eventId: string,
    cause: unknown,
  ) {
    super('OMNI_INGRESS_OUTCOME_UNKNOWN: retry the same event', { cause });
    this.name = 'OmniIncomingOutcomeUnknownError';
  }
}

const appendFailedIncomingAttempt = async (
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

// Internal only: the adapter supplies a trusted principal and current authorization.
export const acceptOmniIncomingEvent = async (
  dataSource: DataSource,
  trustedPrincipal: OmniIncomingPrincipal,
  input: unknown,
  authorize: OmniIncomingAuthorizer,
): Promise<OmniIncomingAcceptance> => {
  if (
    !trustedPrincipal ||
    !isUUID(trustedPrincipal.workspaceId) ||
    !isUUID(trustedPrincipal.bindingId) ||
    trustedPrincipal.actor?.kind !== 'system' ||
    typeof trustedPrincipal.actor.id !== 'string' ||
    trustedPrincipal.actor.id.length === 0 ||
    trustedPrincipal.actor.id.length > 256 ||
    trustedPrincipal.actor.id.trim() !== trustedPrincipal.actor.id ||
    /[\u0000-\u001f\u007f]/.test(trustedPrincipal.actor.id) ||
    typeof authorize !== 'function'
  ) {
    throw new Error('OMNI_INGRESS_INVALID_PRINCIPAL');
  }

  const workspaceId = trustedPrincipal.workspaceId.toLowerCase();
  const bindingId = trustedPrincipal.bindingId.toLowerCase();
  const actor = Object.freeze({
    kind: 'system' as const,
    id: trustedPrincipal.actor.id,
  });
  const envelope = parseOmniIncomingEnvelope(input);

  if (envelope.accountBindingId !== bindingId) {
    throw new Error('OMNI_INGRESS_BINDING_MISMATCH');
  }

  // Capture detached content before authorization can yield to a mutating caller.
  const envelopeJson = canonicalAuditJson(envelope);
  const payloadHash = auditPayloadHash(envelope);
  let receiptId: string = randomUUID();
  const attemptId = randomUUID();
  let auditEligible = false;
  let authorizationDenied = false;
  let commitAttempted = false;
  let operationFailure: unknown;
  let hasFailure = false;
  const queryRunner = dataSource.createQueryRunner('master');

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const [policyState]: { id: string }[] = await queryRunner.query(
      `SELECT id FROM core."omniWorkspacePolicyState"
       WHERE "workspaceId" = $1 FOR SHARE`,
      [workspaceId],
    );

    if (!policyState) throw new Error('OMNI_INGRESS_POLICY_STATE_MISSING');

    const [binding]: { status: string; routeGeneration: string }[] =
      await queryRunner.query(
        `SELECT status, "routeGeneration" FROM core."omniAccountBinding"
         WHERE "workspaceId" = $1 AND id = $2 FOR SHARE`,
        [workspaceId, bindingId],
      );

    if (!binding) throw new Error('OMNI_INGRESS_BINDING_NOT_FOUND');

    auditEligible = true;
    try {
      await authorize(
        queryRunner,
        Object.freeze({
          workspaceId,
          bindingId,
          actor,
          routeGeneration: envelope.routeGeneration,
          kind: envelope.kind,
        }),
      );
    } catch (error) {
      authorizationDenied = true;
      throw error;
    }

    if (binding.status !== 'active') {
      throw new Error('OMNI_INGRESS_BINDING_INACTIVE');
    }
    if (binding.routeGeneration !== envelope.routeGeneration) {
      throw new Error('OMNI_INGRESS_STALE_GENERATION');
    }

    const inserted: { id: string }[] = await queryRunner.query(
      `INSERT INTO core."omniIncomingReceipt"
       (id, "workspaceId", "bindingId", "eventId", kind, "schemaVersion",
        "routeGeneration", "canonicalPayloadHash", "validatedEnvelope")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT ("workspaceId", "bindingId", "eventId") DO NOTHING RETURNING id`,
      [
        receiptId,
        workspaceId,
        bindingId,
        envelope.eventId,
        envelope.kind,
        envelope.schemaVersion,
        envelope.routeGeneration,
        payloadHash,
        envelopeJson,
      ],
    );
    const [receipt]: {
      id: string;
      canonicalPayloadHash: string;
      state: OmniIncomingReceiptState;
    }[] = await queryRunner.query(
      `SELECT id, "canonicalPayloadHash", state FROM core."omniIncomingReceipt"
       WHERE "workspaceId" = $1 AND "bindingId" = $2 AND "eventId" = $3 FOR SHARE`,
      [workspaceId, bindingId, envelope.eventId],
    );

    if (!receipt) throw new Error('OMNI_INGRESS_RECEIPT_MISSING');
    receiptId = receipt.id;
    if (receipt.canonicalPayloadHash !== payloadHash) {
      throw new OmniIncomingConflictError();
    }

    const created = inserted.length === 1;

    if (created) {
      const audit = new CrmAuditTransactionContext(queryRunner, {
        workspaceId,
        operationId: receiptId,
        actor,
      });

      audit.record({
        resourceKind: 'omniIncomingReceipt',
        resourceId: receiptId,
        action: 'create',
        before: null,
        after: {
          bindingId,
          kind: envelope.kind,
          schemaVersion: envelope.schemaVersion,
          routeGeneration: envelope.routeGeneration,
          state: receipt.state,
          eventId: envelope.eventId,
          validatedEnvelope: envelope,
        },
        securityDescriptor: {
          resourceKind: 'omniIncomingReceipt',
          resourceId: receiptId,
          bindingId,
        },
      });
      await audit.flush();
    }

    commitAttempted = true;
    await queryRunner.commitTransaction();

    return { receiptId, state: receipt.state, created };
  } catch (error) {
    hasFailure = true;
    operationFailure = error;
    let rollbackConfirmed = false;

    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
        rollbackConfirmed = true;
      } catch (rollbackError) {
        operationFailure = new AggregateError(
          [error, rollbackError],
          'OMNI_INGRESS_ROLLBACK_UNCONFIRMED',
        );
        // A failed ORM hook must not return an open transaction to the pool.
        try {
          await queryRunner.query('ROLLBACK');
        } catch (cleanupError) {
          operationFailure = new AggregateError(
            [operationFailure, cleanupError],
            'OMNI_INGRESS_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    }
    if (commitAttempted) {
      operationFailure = new OmniIncomingOutcomeUnknownError(
        envelope.eventId,
        operationFailure,
      );
      throw operationFailure;
    }
    if (auditEligible && rollbackConfirmed) {
      try {
        await queryRunner.release();
        await appendFailedIncomingAttempt(
          dataSource,
          { workspaceId, operationId: receiptId, actor },
          {
            attemptId,
            resourceKind: 'omniIncomingReceipt',
            resourceId: receiptId,
            action: 'create',
            outcome: authorizationDenied ? 'denied' : 'failed',
            reasonCode: authorizationDenied
              ? 'ingress.authorization_denied'
              : 'ingress.failed',
            securityDescriptor: {
              resourceKind: 'omniIncomingReceipt',
              resourceId: receiptId,
              bindingId,
            },
          },
        );
      } catch (auditError) {
        operationFailure = new AggregateError(
          [error, auditError],
          'OMNI_INGRESS_FAILURE_AUDIT_UNCONFIRMED',
        );
        throw operationFailure;
      }
    }
    throw operationFailure;
  } finally {
    if (!queryRunner.isReleased) {
      try {
        await queryRunner.release();
      } catch (releaseError) {
        if (commitAttempted) {
          throw new OmniIncomingOutcomeUnknownError(
            envelope.eventId,
            hasFailure
              ? new AggregateError([operationFailure, releaseError])
              : releaseError,
          );
        }
        if (hasFailure)
          throw new AggregateError(
            [operationFailure, releaseError],
            'OMNI_INGRESS_CLEANUP_FAILED',
          );
        throw releaseError;
      }
    }
  }
};
