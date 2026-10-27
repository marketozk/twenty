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

import {
  type OmniAccountBindingEntity,
  type OmniConversationMode,
} from 'src/engine/core-modules/omnichannel-storage/entities/omni-account-binding.entity';
import { type OmniAutomationPolicyEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy.entity';
import { type OmniAutomationPolicyVersionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy-version.entity';
import { type OmniQueueEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-queue.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniConversationStatus = 'open' | 'closed';

@Entity({ name: 'omniConversation', schema: 'core' })
@Unique('UQ_omniConversation_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniConversation_binding_id', ['workspaceId', 'bindingId', 'id'])
@Unique('UQ_omniConversation_binding_chat', [
  'workspaceId',
  'bindingId',
  'providerChatId',
])
@Index('IDX_omniConversation_assignee_status_updated', [
  'workspaceId',
  'assigneeMemberId',
  'status',
  'updatedAt',
])
@Index('IDX_omniConversation_queue', ['workspaceId', 'bindingId', 'queueId'])
@Check('CHK_omniConversation_status', `"status" IN ('open', 'closed')`)
@Check('CHK_omniConversation_mode', `"mode" IN ('human', 'assist', 'auto')`)
@Check(
  'CHK_omniConversation_counters',
  '"conversationSequence" >= 0 AND "replyRevision" > 0 AND ' +
    '"controlEpoch" > 0 AND "automationEpoch" > 0 AND ' +
    '"nextOutboundSequence" > 0 AND "policyVersion" >= 0',
)
export class OmniConversationEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false })
  bindingId: string;

  @ManyToOne('OmniAccountBindingEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'id' },
  ])
  binding: Relation<OmniAccountBindingEntity>;

  @Column({ type: 'text', nullable: false })
  providerChatId: string;

  @Column({ type: 'uuid', nullable: false })
  messageThreadId: string;

  @Column({ type: 'uuid', nullable: true })
  assigneeMemberId: string | null;

  @Column({ type: 'text', nullable: false, default: 'open' })
  status: OmniConversationStatus;

  @Column({ type: 'text', nullable: false, default: 'human' })
  mode: OmniConversationMode;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  conversationSequence: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  replyRevision: string;

  @Column({ type: 'uuid', nullable: true })
  queueId: string | null;

  @ManyToOne('OmniQueueEntity', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'queueId', referencedColumnName: 'id' },
  ])
  queue: Relation<OmniQueueEntity> | null;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  controlEpoch: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  automationEpoch: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  nextOutboundSequence: string;

  @Column({ type: 'uuid', nullable: false })
  policyId: string;

  @ManyToOne('OmniAutomationPolicyEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'policyId', referencedColumnName: 'id' },
  ])
  policy: Relation<OmniAutomationPolicyEntity>;

  @Column({ type: 'bigint', nullable: false })
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
}
