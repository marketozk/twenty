import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniAutomationPolicyVersionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy-version.entity';
import { type OmniConversationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-conversation.entity';
import { type OmniMessageLinkEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-message-link.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniOutgoingCommandState =
  | 'pending'
  | 'dispatching'
  | 'accepted'
  | 'outcome_unknown'
  | 'sent'
  | 'failed'
  | 'cancelled';

@Entity({ name: 'omniOutgoingCommand', schema: 'core' })
@Unique('UQ_omniOutgoingCommand_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniOutgoingCommand_conversation_id', [
  'workspaceId',
  'conversationId',
  'id',
])
@Unique('UQ_omniOutgoingCommand_actor_key', [
  'workspaceId',
  'actorKind',
  'actorId',
  'idempotencyKey',
])
@Unique('UQ_omniOutgoingCommand_sequence', [
  'workspaceId',
  'conversationId',
  'outboundSequence',
])
@Index('IDX_omniOutgoingCommand_recovery', [
  'workspaceId',
  'state',
  'nextAttemptAt',
  'leaseUntil',
])
@Index(
  'IDX_omniOutgoingCommand_policy_cleanup',
  ['workspaceId', 'policyId', 'policyVersion', 'state', 'id'],
  { where: `"senderClass" != 'human'` },
)
@Check(
  'CHK_omniOutgoingCommand_state',
  `"state" IN ('pending', 'dispatching', 'accepted', 'outcome_unknown', 'sent', 'failed', 'cancelled')`,
)
@Check(
  'CHK_omniOutgoingCommand_identity',
  `length("actorKind") > 0 AND length("actorId") > 0 AND ` +
    `length("initiatingActorId") > 0 AND length("idempotencyKey") > 0 AND ` +
    `length("senderClass") > 0 AND length("contentProvenance") > 0`,
)
@Check(
  'CHK_omniOutgoingCommand_payloadHash',
  `"payloadHash" ~ '^[a-f0-9]{64}$'`,
)
@Check(
  'CHK_omniOutgoingCommand_payload',
  `jsonb_typeof("payload") = 'object' AND jsonb_typeof("workflowCancellationRefs") = 'array'`,
)
@Check(
  'CHK_omniOutgoingCommand_counters',
  '"generation" > 0 AND "policyVersion" >= 0 AND ' +
    '"outboundSequence" > 0 AND "statusRevision" > 0 AND ' +
    '("expectedAutomationEpoch" IS NULL OR "expectedAutomationEpoch" > 0) AND ' +
    '("journalSequence" IS NULL OR "journalSequence" >= 0)',
)
@Check(
  'CHK_omniOutgoingCommand_nonHuman_context',
  `"senderClass" = 'human' OR ("referenceId" IS NOT NULL AND "expectedAutomationEpoch" IS NOT NULL)`,
)
@Check(
  'CHK_omniOutgoingCommand_producer_fence',
  '("producerTurnId" IS NULL AND "capturedTurnFence" IS NULL) OR ' +
    '("producerTurnId" IS NOT NULL AND "capturedTurnFence" IS NOT NULL AND "capturedTurnFence" > 0)',
)
@Check(
  'CHK_omniOutgoingCommand_ai_producer',
  `"senderClass" != 'ai_turn' OR "producerTurnId" IS NOT NULL`,
)
@Check(
  'CHK_omniOutgoingCommand_lease',
  '("leaseToken" IS NULL AND "leaseUntil" IS NULL) OR ' +
    '("leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL)',
)
@Check(
  'CHK_omniOutgoingCommand_replacement',
  `"replacesCommandId" IS NULL OR ("replacesCommandId" != "id" AND "senderClass" = 'human')`,
)
@Check(
  'CHK_omniOutgoingCommand_reply_snapshot',
  '("replyToMessageLinkId" IS NULL AND "resolvedReplyNativeRef" IS NULL) OR ' +
    '("replyToMessageLinkId" IS NOT NULL AND "resolvedReplyNativeRef" IS NOT NULL AND ' +
    `jsonb_typeof("resolvedReplyNativeRef") = 'object')`,
)
export class OmniOutgoingCommandEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  conversationId: string;

  @ManyToOne('OmniConversationEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'id' },
  ])
  conversation: Relation<OmniConversationEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  actorKind: string;

  @Column({ type: 'text', nullable: false, update: false })
  actorId: string;

  @Column({ type: 'text', nullable: false, update: false })
  initiatingActorId: string;

  @Column({ type: 'text', nullable: false, update: false })
  idempotencyKey: string;

  @Column({ type: 'text', nullable: false, update: false })
  payloadHash: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  payload: Record<string, unknown>;

  @Column({ type: 'bigint', nullable: true, update: false })
  expectedAutomationEpoch: string | null;

  @Column({ type: 'uuid', nullable: false, update: false })
  policyId: string;

  @Column({ type: 'bigint', nullable: false, update: false })
  policyVersion: string;

  @ManyToOne('OmniAutomationPolicyVersionEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'policyId', referencedColumnName: 'policyId' },
    { name: 'policyVersion', referencedColumnName: 'version' },
  ])
  automationPolicyVersion: Relation<OmniAutomationPolicyVersionEntity>;

  @Column({ type: 'bigint', nullable: false, update: false })
  generation: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  createdRestoreIncarnation: string | null;

  @Column({ type: 'jsonb', nullable: false, default: [], update: false })
  workflowCancellationRefs: Record<string, unknown>[];

  @Column({ type: 'text', nullable: false, update: false })
  senderClass: string;

  @Column({ type: 'text', nullable: false, update: false })
  contentProvenance: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  producerTurnId: string | null;

  @Column({ type: 'bigint', nullable: true, update: false })
  capturedTurnFence: string | null;

  @Column({ type: 'uuid', nullable: true, update: false })
  referenceId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  cancelReason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  cancelEvidence: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true, update: false })
  replacesCommandId: string | null;

  @ManyToOne('OmniOutgoingCommandEntity', {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'conversationId' },
    { name: 'replacesCommandId', referencedColumnName: 'id' },
  ])
  replacedCommand: Relation<OmniOutgoingCommandEntity> | null;

  @Column({ type: 'bigint', nullable: false, update: false })
  outboundSequence: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  replyToMessageLinkId: string | null;

  @ManyToOne('OmniMessageLinkEntity', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'conversationId' },
    { name: 'replyToMessageLinkId', referencedColumnName: 'id' },
  ])
  replyToMessageLink: Relation<OmniMessageLinkEntity> | null;

  @Column({ type: 'jsonb', nullable: true, update: false })
  resolvedReplyNativeRef: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: false, default: 'pending' })
  state: OmniOutgoingCommandState;

  @Column({ type: 'text', nullable: true })
  connectorJobId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  connectorAcceptedEvidence: Record<string, unknown> | null;

  @Column({ type: 'bigint', nullable: true })
  journalSequence: string | null;

  @Column({ type: 'uuid', nullable: true })
  leaseToken: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  statusRevision: string;
}
