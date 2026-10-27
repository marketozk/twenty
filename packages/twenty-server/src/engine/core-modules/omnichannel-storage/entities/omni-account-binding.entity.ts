import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniQueueEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-queue.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniConversationMode = 'human' | 'assist' | 'auto';

@Entity({ name: 'omniAccountBinding', schema: 'core' })
@Unique('UQ_omniAccountBinding_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniAccountBinding_account', [
  'workspaceId',
  'platform',
  'connectorInstanceId',
  'accountId',
])
@Unique('UQ_omniAccountBinding_channel', ['workspaceId', 'messageChannelId'])
@Check('CHK_omniAccountBinding_generation', '"routeGeneration" > 0')
@Check('CHK_omniAccountBinding_revision', '"revision" > 0')
@Check(
  'CHK_omniAccountBinding_active_queue',
  `"status" <> 'active' OR "defaultQueueId" IS NOT NULL`,
)
@Check(
  'CHK_omniAccountBinding_mode',
  `"defaultConversationMode" IN ('human', 'assist', 'auto')`,
)
export class OmniAccountBindingEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false })
  platform: string;

  @Column({ type: 'text', nullable: false })
  connectorInstanceId: string;

  @Column({ type: 'text', nullable: false })
  accountId: string;

  @Column({ type: 'uuid', nullable: false })
  connectedAccountId: string;

  @ManyToOne('ConnectedAccountEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'connectedAccountId' })
  connectedAccount: Relation<{ id: string }>;

  @Column({ type: 'uuid', nullable: false })
  messageChannelId: string;

  @ManyToOne('MessageChannelEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'messageChannelId' })
  messageChannel: Relation<{ id: string }>;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  routeGeneration: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;

  @Column({ type: 'text', nullable: false, default: 'inactive' })
  status: string;

  @Column({ type: 'text', nullable: false })
  capabilitiesVersion: string;

  @Column({ type: 'jsonb', nullable: false })
  capabilities: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true })
  defaultQueueId: string | null;

  @ManyToOne('OmniQueueEntity', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'id', referencedColumnName: 'bindingId' },
    { name: 'defaultQueueId', referencedColumnName: 'id' },
  ])
  defaultQueue: Relation<OmniQueueEntity> | null;

  @Column({ type: 'text', nullable: false, default: 'human' })
  defaultConversationMode: OmniConversationMode;

  @Column({ type: 'boolean', nullable: false, default: false })
  autoCreatePersonEnabled: boolean;
}
