import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniConversationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-conversation.entity';
import { type OmniRootExecutionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-root-execution.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniDomainEvent', schema: 'core' })
@Unique('UQ_omniDomainEvent_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniDomainEvent_conversation_id', [
  'workspaceId',
  'conversationId',
  'id',
])
@Unique('UQ_omniDomainEvent_conversation_sequence', [
  'workspaceId',
  'conversationId',
  'conversationSequence',
])
@Check(
  'CHK_omniDomainEvent_sequence',
  '("conversationId" IS NULL AND "conversationSequence" IS NULL) OR ' +
    '("conversationId" IS NOT NULL AND "conversationSequence" IS NOT NULL AND "conversationSequence" > 0)',
)
@Check(
  'CHK_omniDomainEvent_identity',
  `length("kind") > 0 AND length("origin") > 0 AND "origin" != 'import'`,
)
@Check(
  'CHK_omniDomainEvent_payload',
  `"payloadVersion" > 0 AND jsonb_typeof("payload") = 'object'`,
)
export class OmniDomainEventEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: true, update: false })
  conversationId: string | null;

  @ManyToOne('OmniConversationEntity', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'id' },
  ])
  conversation: Relation<OmniConversationEntity> | null;

  @Column({ type: 'text', nullable: false, update: false })
  kind: string;

  @Column({ type: 'text', nullable: false, update: false })
  origin: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  causationId: string | null;

  @Column({ type: 'uuid', nullable: true, update: false })
  rootExecutionId: string | null;

  @ManyToOne('OmniRootExecutionEntity', {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'rootExecutionId', referencedColumnName: 'id' },
  ])
  rootExecution: Relation<OmniRootExecutionEntity> | null;

  @Column({ type: 'bigint', nullable: true, update: false })
  conversationSequence: string | null;

  @Column({ type: 'integer', nullable: false, update: false })
  payloadVersion: number;

  @Column({ type: 'jsonb', nullable: false, update: false })
  payload: Record<string, unknown>;
}
