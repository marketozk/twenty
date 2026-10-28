import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';
import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { snapshotOmniIncomingApplicationResult } from 'src/modules/omnichannel/contracts/omni-incoming-application-result';
import { snapshotOmniIncomingCaptureContext } from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import { parseOmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import { omniIncomingTextRevisionContent } from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const timestamp = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString());
const fail = (): never => {
  throw new Error('OMNI_INCOMING_REVISION_HEAD_INTEGRITY');
};
const freeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export const omniIncomingTextApplyOperationId = (receiptId: string) =>
  uuidV5('omni:incoming.text.apply:v1', uuid.parse(receiptId));
export const omniIncomingTextRevisionId = (receiptId: string) =>
  uuidV5('omni:incoming.text.revision:v1', uuid.parse(receiptId));

// Caller holds the conversation and native ownership locks. Retained receipts/revisions are immutable evidence.
export const loadOmniIncomingRevisionChain = async (input: {
  query: (sql: string, parameters?: unknown[]) => Promise<unknown[]>;
  workspaceId: string;
  bindingId: string;
  conversationId: string;
  providerChatId: string;
  nativeMessageKey: string;
  link: unknown;
}) => {
  const link = z
    .object({
      id: uuid,
      workspaceId: uuid,
      bindingId: uuid,
      conversationId: uuid,
      messageId: uuid,
      currentRevisionId: uuid.nullable(),
      nativeMessageKey: z.string(),
      nativeMessageKeyVersion: z.literal(1),
      rawNativeMessageId: z.string(),
      sourcePosition: z.unknown(),
      displayOccurredAt: timestamp,
      displayTimeSource: z.enum(['source', 'capture']),
      immutableAuthorSnapshot: z.unknown(),
      sourceAuthorId: z.string().nullable(),
      sourceDisplayName: z.string().nullable(),
      authorVerification: z.string().nullable(),
      senderProvenance: z.literal('unresolved_external'),
      correlationState: z.literal('not_applicable'),
      providerRevision: z.null(),
      outgoingCommandId: z.null(),
    })
    .parse(input.link);
  if (
    link.workspaceId !== input.workspaceId ||
    link.bindingId !== input.bindingId ||
    link.conversationId !== input.conversationId ||
    link.nativeMessageKey !== input.nativeMessageKey
  )
    return fail();
  const rows = z
    .array(
      z.object({
        id: uuid,
        messageLinkId: uuid,
        sourceRevisionKey: z.string(),
        sourceEventId: z.string(),
        contentHash: z.string(),
        tombstone: z.boolean(),
        origin: z.enum(['live', 'history_import', 'restore_replay']),
        protectedPayloadRef: z.null(),
      }),
    )
    .parse(
      await input.query(
        'SELECT * FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND "messageLinkId"=$2',
        [input.workspaceId, link.id],
      ),
    );
  if (!rows.length) return fail();
  const receiptEvidence = z
    .array(z.object({ eventId: z.string(), receipt: z.unknown() }))
    .parse(
      await input.query(
        'SELECT "eventId",(to_jsonb(receipt) || jsonb_build_object(\'routeGeneration\',\"routeGeneration\"::text)) AS receipt FROM core."omniIncomingReceipt" receipt WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "eventId"=ANY($3::text[])',
        [
          input.workspaceId,
          input.bindingId,
          rows.map((row) => row.sourceEventId),
        ],
      ),
    );
  const evidence = [];
  for (const revision of rows) {
    const receiptRows = receiptEvidence
      .filter((item) => item.eventId === revision.sourceEventId)
      .map((item) => item.receipt);
    if (receiptRows.length !== 1) return fail();
    const receipt = z
      .object({
        id: uuid,
        eventId: z.string(),
        kind: z.string(),
        schemaVersion: z.literal(1),
        routeGeneration: z.string(),
        canonicalPayloadHash: z.string(),
        validatedEnvelope: z.unknown(),
        trustedCaptureContext: z.unknown(),
        trustedCaptureContextHash: z.string(),
        state: z.literal('applied'),
        resultId: uuid,
        applicationResult: z.unknown(),
        createdAt: timestamp,
        leaseOwner: z.null(),
        leaseUntil: z.null(),
        errorCode: z.null(),
      })
      .parse(receiptRows[0]);
    const envelope = freeze(
      parseOmniIncomingEnvelope(receipt.validatedEnvelope),
    );
    const capture = snapshotOmniIncomingCaptureContext(
      receipt.trustedCaptureContext,
      envelope,
    );
    if (
      receipt.resultId !== link.id ||
      receipt.canonicalPayloadHash !== auditPayloadHash(envelope) ||
      receipt.trustedCaptureContextHash !== capture.hash ||
      receipt.eventId !== envelope.eventId ||
      receipt.kind !== envelope.kind ||
      receipt.routeGeneration !== envelope.routeGeneration ||
      envelope.accountBindingId !== input.bindingId ||
      envelope.providerChatId !== input.providerChatId ||
      envelope.providerMessageId !== link.rawNativeMessageId ||
      envelope.direction !== 'incoming' ||
      capture.context.nativeMessageKey !== link.nativeMessageKey ||
      revision.origin !== capture.context.origin
    )
      return fail();
    const facts = freeze({ envelope, captureContext: capture.context });
    const content = (() => {
      try {
        return omniIncomingTextRevisionContent(facts);
      } catch {
        return fail();
      }
    })();
    const outcome =
      receipt.applicationResult === null
        ? null
        : snapshotOmniIncomingApplicationResult(receipt.applicationResult);
    const receivedAt =
      envelope.occurredAt === null
        ? receipt.createdAt
        : new Date(envelope.occurredAt).toISOString();
    if (outcome === null) {
      if (
        revision.id !==
          uuidV5('omni:history.initial.revision:v1', receipt.id) ||
        envelope.kind !== 'message.received' ||
        envelope.sourceVariant !== 'complete' ||
        envelope.payload.text === null ||
        capture.context.origin !== 'history_import' ||
        revision.tombstone ||
        revision.sourceRevisionKey !==
          `initial:${auditPayloadHash({ eventId: envelope.eventId, captureHash: capture.hash })}` ||
        revision.contentHash !==
          auditPayloadHash({
            direction: envelope.direction,
            text: envelope.payload.text,
            receivedAt,
            sourceAuthorId: envelope.payload.sourceAuthorId,
            sourceDisplayName: envelope.payload.sourceDisplayName,
            nativeMessageKey: capture.context.nativeMessageKey,
            sourceVariant: envelope.sourceVariant,
          })
      )
        return fail();
    } else if (
      !['created', 'advanced'].includes(outcome.disposition) ||
      outcome.selectedRevisionId !== revision.id ||
      revision.id !== omniIncomingTextRevisionId(receipt.id) ||
      revision.sourceRevisionKey !== outcome.candidateSourceRevisionKey ||
      revision.contentHash !== outcome.candidateContentHash ||
      revision.contentHash !== content.contentHash ||
      revision.tombstone !== content.tombstone
    )
      return fail();
    evidence.push({ revision, receipt, facts, content, outcome, receivedAt });
  }
  const auditRows = z
    .array(
      z.object({
        operationId: uuid,
        resourceKind: z.string(),
        resourceId: uuid,
        action: z.string(),
        redactedDiff: z.object({
          changedFields: z.array(z.string()),
          values: z.record(
            z.string(),
            z.object({ before: z.unknown(), after: z.unknown() }),
          ),
        }),
      }),
    )
    .parse(
      await input.query(
        'SELECT "operationId","resourceKind","resourceId",action,"redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=ANY($2::uuid[]) AND outcome=\'success\'',
        [
          input.workspaceId,
          evidence.map((item) =>
            item.outcome === null
              ? uuidV5('omni:history.apply:v1', item.receipt.id)
              : omniIncomingTextApplyOperationId(item.receipt.id),
          ),
        ],
      ),
    );
  for (const item of evidence) {
    const operationId =
      item.outcome === null
        ? uuidV5('omni:history.apply:v1', item.receipt.id)
        : omniIncomingTextApplyOperationId(item.receipt.id);
    const successes = auditRows.filter(
      (row) => row.operationId === operationId,
    );
    const revisionEntries = successes.filter(
      (row) =>
        row.resourceKind === 'omniMessageRevision' &&
        row.resourceId === item.revision.id &&
        row.action === 'create',
    );
    const receiptEntries = successes.filter(
      (row) =>
        row.resourceKind === 'omniIncomingReceipt' &&
        row.resourceId === item.receipt.id &&
        row.action === 'update',
    );
    const linkEntries = successes.filter(
      (row) =>
        row.resourceKind === 'omniMessageLink' &&
        row.resourceId === link.id &&
        row.action ===
          (item.outcome?.disposition === 'advanced' ? 'update' : 'create'),
    );
    if (
      revisionEntries.length !== 1 ||
      receiptEntries.length !== 1 ||
      linkEntries.length !== 1 ||
      revisionEntries[0].redactedDiff.values.contentHash?.after !==
        item.revision.contentHash ||
      receiptEntries[0].redactedDiff.values.resultId?.after !== link.id ||
      (item.outcome !== null &&
        (linkEntries[0].redactedDiff.values.currentRevisionId?.after !==
          item.revision.id ||
          !receiptEntries[0].redactedDiff.changedFields.includes(
            'applicationResult',
          )))
    )
      return fail();
  }
  const byId = new Map(evidence.map((item) => [item.revision.id, item]));
  const head =
    link.currentRevisionId === null
      ? evidence.length === 1 && evidence[0].outcome === null
        ? evidence[0]
        : fail()
      : byId.get(link.currentRevisionId);
  if (!head) return fail();
  const visited = new Set<string>();
  let initial = head;
  for (;;) {
    if (visited.has(initial.revision.id)) return fail();
    visited.add(initial.revision.id);
    if (initial.outcome === null || initial.outcome.disposition === 'created')
      break;
    const previous = byId.get(initial.outcome.observedHeadRevisionId ?? '');
    if (!previous) return fail();
    initial = previous;
  }
  if (visited.size !== evidence.length) return fail();
  const author = z
    .object({
      externalIdentityId: uuid,
      identityRevision: z.string(),
      providerPeerId: z.string(),
      personId: uuid.nullable(),
      sourceAuthorId: z.string().nullable(),
      sourceDisplayName: z.string().nullable(),
    })
    .parse(link.immutableAuthorSnapshot);
  if (
    link.displayOccurredAt !== initial.receivedAt ||
    link.displayTimeSource !==
      (initial.facts.envelope.occurredAt === null ? 'capture' : 'source') ||
    link.sourceAuthorId !== initial.facts.envelope.payload.sourceAuthorId ||
    link.sourceDisplayName !==
      initial.facts.envelope.payload.sourceDisplayName ||
    author.sourceAuthorId !== link.sourceAuthorId ||
    author.sourceDisplayName !== link.sourceDisplayName ||
    canonicalAuditJson(link.sourcePosition) !==
      canonicalAuditJson(head.facts.captureContext.sourcePosition)
  )
    return fail();
  return { link, head, initial, revisions: evidence, author };
};
export type OmniIncomingRevisionChain = Awaited<
  ReturnType<typeof loadOmniIncomingRevisionChain>
>;
