import { randomUUID } from 'node:crypto';

import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import { assertOmniWorkspaceAcceptsBootstrap } from 'src/modules/omnichannel/services/omni-workspace-deletion';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';

type BootstrapActor = { kind: 'workspaceMember' | 'system'; id: string };
type BootstrapInput = {
  workspaceId: string;
  platform: 'telegram' | 'max';
  connectorInstanceId: string;
  accountId: string;
  connectedAccountId: string;
  messageChannelId: string;
  idempotencyKey: string;
  expectedRevision: '0';
};
type BootstrapPublicResult = {
  bindingId: string;
  policyId: string;
  policyVersion: '0';
  revision: '1';
  status: 'inactive';
};
type BootstrapResult = BootstrapPublicResult & { operationId: string };
type BootstrapAuthorization = {
  workspaceId: string;
  actor: BootstrapActor;
  action: 'binding.create';
  resourceDescriptor: Readonly<Record<string, string>>;
};
export type BootstrapAuthorizer = (
  queryRunner: QueryRunner,
  authorization: BootstrapAuthorization,
) => Promise<void>;

export class BootstrapOutcomeUnknownError extends Error {
  constructor(
    readonly operationId: string,
    cause: unknown,
  ) {
    super('BOOTSTRAP_OUTCOME_UNKNOWN: retry the same idempotency key', {
      cause,
    });
    this.name = 'BootstrapOutcomeUnknownError';
  }
}

const appendFailedBootstrapAttempt = async (
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

const boundedText = (value: unknown, limit: number): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Invalid bootstrap input');
  }

  return value;
};

const canonicalUuid = (value: string): string => {
  if (!isUUID(value)) throw new Error('Invalid bootstrap UUID');

  return value.toLowerCase();
};

const parseStoredResult = (value: BootstrapPublicResult | null) => {
  if (value === null) throw new Error('Bootstrap result expired');
  if (
    !isUUID(value.bindingId) ||
    !isUUID(value.policyId) ||
    value.policyVersion !== '0' ||
    value.revision !== '1' ||
    value.status !== 'inactive'
  ) {
    throw new Error('Invalid bootstrap receipt');
  }

  return {
    bindingId: value.bindingId,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    revision: value.revision,
    status: value.status,
  };
};

// Internal only: ROB-766 must supply current authorization before exposing a caller.
export const bootstrapOmniAccountBinding = async (
  dataSource: DataSource,
  trustedActor: BootstrapActor,
  input: BootstrapInput,
  authorize: BootstrapAuthorizer,
): Promise<BootstrapResult> => {
  if (
    !['workspaceMember', 'system'].includes(trustedActor.kind) ||
    !['telegram', 'max'].includes(input.platform) ||
    input.expectedRevision !== '0' ||
    typeof authorize !== 'function' ||
    Object.keys(input).some(
      (key) =>
        ![
          'workspaceId',
          'platform',
          'connectorInstanceId',
          'accountId',
          'connectedAccountId',
          'messageChannelId',
          'idempotencyKey',
          'expectedRevision',
        ].includes(key),
    )
  ) {
    throw new Error('Invalid bootstrap input');
  }

  const actor = Object.freeze({
    kind: trustedActor.kind,
    id:
      trustedActor.kind === 'workspaceMember'
        ? canonicalUuid(trustedActor.id)
        : boundedText(trustedActor.id, 256),
  });
  const normalized = Object.freeze({
    workspaceId: canonicalUuid(input.workspaceId),
    platform: input.platform,
    connectorInstanceId: boundedText(input.connectorInstanceId, 256),
    accountId: boundedText(input.accountId, 512),
    connectedAccountId: canonicalUuid(input.connectedAccountId),
    messageChannelId: canonicalUuid(input.messageChannelId),
    expectedRevision: input.expectedRevision,
  });
  const idempotencyKey = boundedText(input.idempotencyKey, 256);
  const action = 'binding.create' as const;
  const payloadHash = auditPayloadHash({ action, ...normalized });
  let operationId: string = randomUUID();
  const bindingId = randomUUID();
  const attemptId = randomUUID();
  let failureResourceId: string = bindingId;
  let auditEligible = false;
  let authorizationDenied = false;
  let commitAttempted = false;
  let operationFailure: unknown;
  let hasFailure = false;
  const queryRunner = dataSource.createQueryRunner('master');
  const authorizeRequest = async (
    resourceDescriptor: Readonly<Record<string, string>>,
  ) => {
    auditEligible = true;
    try {
      await authorize(queryRunner, {
        workspaceId: normalized.workspaceId,
        actor,
        action,
        resourceDescriptor,
      });
    } catch (error) {
      authorizationDenied = true;
      throw error;
    }
  };

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await lockOmniNativeOwnership(
      {
        executeRawQuery: (sql, parameters) =>
          queryRunner.query(sql, parameters),
      },
      normalized.workspaceId,
      'exclusive',
    );
    await assertOmniWorkspaceAcceptsBootstrap(
      queryRunner,
      normalized.workspaceId,
    );
    const createdState: { id: string }[] = await queryRunner.query(
      `INSERT INTO core."omniWorkspacePolicyState" ("workspaceId")
       VALUES ($1) ON CONFLICT ("workspaceId") DO NOTHING RETURNING id`,
      [normalized.workspaceId],
    );
    const [state]: { id: string; epoch: string; restoreIncarnation: string }[] =
      await queryRunner.query(
        `SELECT id, epoch, "restoreIncarnation" FROM core."omniWorkspacePolicyState"
       WHERE "workspaceId" = $1 FOR UPDATE`,
        [normalized.workspaceId],
      );
    const requestedDescriptor = Object.freeze({
      resourceKind: 'omniAccountBinding',
      platform: normalized.platform,
      connectorInstanceId: normalized.connectorInstanceId,
      accountId: normalized.accountId,
      connectedAccountId: normalized.connectedAccountId,
      messageChannelId: normalized.messageChannelId,
    });
    await authorizeRequest(requestedDescriptor);
    if (createdState.length > 0) {
      const existingBindings: { id: string }[] = await queryRunner.query(
        `SELECT id FROM core."omniAccountBinding" WHERE "workspaceId" = $1 LIMIT 1`,
        [normalized.workspaceId],
      );
      if (existingBindings.length > 0) {
        throw new Error('Missing policy state requires explicit recovery');
      }
    }
    const [receipt]: {
      operationId: string;
      action: string;
      payloadHash: string;
      resourceDescriptor: Record<string, string>;
      resultPublic: BootstrapPublicResult | null;
    }[] = await queryRunner.query(
      `SELECT "operationId", action, "payloadHash", "resourceDescriptor", "resultPublic"
       FROM core."omniPolicyMutationReceipt"
       WHERE "workspaceId" = $1 AND "actorKind" = $2 AND "actorId" = $3
         AND "idempotencyKey" = $4 FOR UPDATE`,
      [normalized.workspaceId, actor.kind, actor.id, idempotencyKey],
    );
    if (receipt) {
      operationId = canonicalUuid(receipt.operationId);
      if (
        receipt.resourceDescriptor.resourceKind !== 'omniAccountBinding' ||
        !isUUID(receipt.resourceDescriptor.resourceId)
      ) {
        throw new Error('Bootstrap idempotency conflict');
      }
      failureResourceId = canonicalUuid(receipt.resourceDescriptor.resourceId);
      if (createdState.length > 0) {
        throw new Error('Missing policy state requires explicit recovery');
      }
      await authorizeRequest(Object.freeze({ ...receipt.resourceDescriptor }));
      if (receipt.action !== action || receipt.payloadHash !== payloadHash) {
        throw new Error('Bootstrap idempotency conflict');
      }
      const result = parseStoredResult(receipt.resultPublic);

      commitAttempted = true;
      await queryRunner.commitTransaction();

      return { ...result, operationId: receipt.operationId };
    }

    const accounts: { id: string }[] = await queryRunner.query(
      `SELECT id FROM core."connectedAccount"
       WHERE id = $1 AND "workspaceId" = $2 AND "archivedAt" IS NULL
         AND "applicationId" IS NULL AND "connectionProviderId" IS NULL FOR SHARE`,
      [normalized.connectedAccountId, normalized.workspaceId],
    );
    const channels: { id: string }[] = await queryRunner.query(
      `SELECT id FROM core."messageChannel"
       WHERE id = $1 AND "workspaceId" = $2 AND "connectedAccountId" = $3
         AND type = 'APP' FOR SHARE`,
      [
        normalized.messageChannelId,
        normalized.workspaceId,
        normalized.connectedAccountId,
      ],
    );
    if (accounts.length !== 1 || channels.length !== 1) {
      throw new Error('Bootstrap native account/channel mismatch');
    }

    const policyId = randomUUID();
    const versionId = randomUUID();
    const audit = new CrmAuditTransactionContext(queryRunner, {
      workspaceId: normalized.workspaceId,
      operationId,
      actor,
    });
    await queryRunner.query(
      `INSERT INTO core."omniAccountBinding"
       (id, "workspaceId", platform, "connectorInstanceId", "accountId", "connectedAccountId",
        "messageChannelId", "capabilitiesVersion", capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified','{}')`,
      [
        bindingId,
        normalized.workspaceId,
        normalized.platform,
        normalized.connectorInstanceId,
        normalized.accountId,
        normalized.connectedAccountId,
        normalized.messageChannelId,
      ],
    );
    await queryRunner.query(
      `INSERT INTO core."omniAutomationPolicy" (id, "workspaceId", "bindingId") VALUES ($1,$2,$3)`,
      [policyId, normalized.workspaceId, bindingId],
    );
    const settings = {
      enabled: false,
      maxReplies: 0,
      maxCrmEffects: 0,
      maxHops: 0,
    };
    const settingsHash = auditPayloadHash(settings);

    await queryRunner.query(
      `INSERT INTO core."omniAutomationPolicyVersion"
       (id, "workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
       VALUES ($1,$2,$3,0,$4::jsonb,$5,$6::jsonb,now())`,
      [
        versionId,
        normalized.workspaceId,
        policyId,
        JSON.stringify(settings),
        settingsHash,
        JSON.stringify(actor),
      ],
    );
    await queryRunner.query(
      `UPDATE core."omniAutomationPolicy" SET "currentVersion" = 0, "updatedAt" = now()
       WHERE "workspaceId" = $1 AND id = $2`,
      [normalized.workspaceId, policyId],
    );
    const [updatedState]: { epoch: string }[] = await queryRunner.query(
      `WITH updated AS (
         UPDATE core."omniWorkspacePolicyState" SET epoch = epoch + 1, "updatedAt" = now()
         WHERE "workspaceId" = $1 RETURNING epoch
       ) SELECT epoch FROM updated`,
      [normalized.workspaceId],
    );
    const entries = [
      {
        resourceKind: 'omniAccountBinding' as const,
        resourceId: bindingId,
        after: {
          platform: normalized.platform,
          status: 'inactive',
          routeGeneration: '1',
          revision: '1',
          defaultConversationMode: 'human',
          autoCreatePersonEnabled: false,
          defaultQueueId: null,
          connectedAccountId: normalized.connectedAccountId,
          messageChannelId: normalized.messageChannelId,
          capabilitiesVersion: 'unverified',
          capabilities: {},
          accountId: normalized.accountId,
          connectorInstanceId: normalized.connectorInstanceId,
        },
      },
      {
        resourceKind: 'omniAutomationPolicy' as const,
        resourceId: policyId,
        after: { bindingId, currentVersion: '0', revision: '1' },
      },
      {
        resourceKind: 'omniAutomationPolicyVersion' as const,
        resourceId: versionId,
        after: {
          policyId,
          version: '0',
          settingsHash,
          settings,
          publishedBy: actor,
        },
      },
    ];
    for (const entry of entries) {
      audit.record({
        ...entry,
        action: 'create',
        before: null,
        securityDescriptor: {
          resourceKind: entry.resourceKind,
          resourceId: entry.resourceId,
          bindingId,
        },
      });
    }
    audit.record({
      resourceKind: 'omniWorkspacePolicyState',
      resourceId: state.id,
      action: createdState.length ? 'create' : 'update',
      before: createdState.length
        ? null
        : { epoch: state.epoch, restoreIncarnation: state.restoreIncarnation },
      after: {
        epoch: updatedState.epoch,
        restoreIncarnation: state.restoreIncarnation,
      },
      securityDescriptor: {
        resourceKind: 'omniWorkspacePolicyState',
        resourceId: state.id,
      },
    });
    await audit.flush();

    const result: BootstrapPublicResult = {
      bindingId,
      policyId,
      policyVersion: '0',
      revision: '1',
      status: 'inactive',
    };
    const resourceDescriptor = {
      ...requestedDescriptor,
      resourceId: bindingId,
      bindingId,
    };

    await queryRunner.query(
      `INSERT INTO core."omniPolicyMutationReceipt"
       ("workspaceId", "actorKind", "actorId", "idempotencyKey", "operationId", action,
        "resourceDescriptor", "payloadHash", "resultPublic", "committedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,now())`,
      [
        normalized.workspaceId,
        actor.kind,
        actor.id,
        idempotencyKey,
        operationId,
        action,
        JSON.stringify(resourceDescriptor),
        payloadHash,
        JSON.stringify(result),
      ],
    );
    commitAttempted = true;
    await queryRunner.commitTransaction();

    return { ...result, operationId };
  } catch (error) {
    hasFailure = true;
    operationFailure = error;
    let rollbackFailed = false;
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
      } catch (rollbackError) {
        rollbackFailed = true;
        operationFailure = new AggregateError(
          [error, rollbackError],
          'BOOTSTRAP_ROLLBACK_UNCONFIRMED',
        );
        // A failed ORM hook must not return an open transaction to the pool.
        try {
          await queryRunner.query('ROLLBACK');
        } catch (cleanupError) {
          operationFailure = new AggregateError(
            [operationFailure, cleanupError],
            'BOOTSTRAP_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    }
    if (commitAttempted) {
      operationFailure = new BootstrapOutcomeUnknownError(
        operationId,
        operationFailure,
      );
      throw operationFailure;
    }
    if (rollbackFailed) throw operationFailure;
    if (auditEligible) {
      try {
        await queryRunner.release();
        await appendFailedBootstrapAttempt(
          dataSource,
          {
            workspaceId: normalized.workspaceId,
            operationId,
            actor,
          },
          {
            attemptId,
            resourceKind: 'omniAccountBinding',
            resourceId: failureResourceId,
            action: 'create',
            outcome: authorizationDenied ? 'denied' : 'failed',
            reasonCode: authorizationDenied
              ? 'bootstrap.authorization_denied'
              : 'bootstrap.failed',
            securityDescriptor: {
              resourceKind: 'omniAccountBinding',
              resourceId: failureResourceId,
            },
          },
        );
      } catch (auditError) {
        operationFailure = new AggregateError(
          [error, auditError],
          'BOOTSTRAP_FAILURE_AUDIT_UNCONFIRMED',
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
          throw new BootstrapOutcomeUnknownError(
            operationId,
            hasFailure
              ? new AggregateError([operationFailure, releaseError])
              : releaseError,
          );
        }
        if (hasFailure)
          throw new AggregateError(
            [operationFailure, releaseError],
            'BOOTSTRAP_CLEANUP_FAILED',
          );
        throw releaseError;
      }
    }
  }
};
