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
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniConversationTarget', schema: 'core' })
@Unique('UQ_omniConversationTarget_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniConversationTarget_record', [
  'workspaceId',
  'conversationId',
  'objectMetadataId',
  'recordId',
])
@Check('CHK_omniConversationTarget_revision', '"revision" > 0')
export class OmniConversationTargetEntity extends OmniWorkspaceRow {
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

  @Column({ type: 'uuid', nullable: false, update: false })
  objectMetadataId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  recordId: string;

  @Column({ type: 'boolean', nullable: false, default: true })
  active: boolean;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;

  @Column({ type: 'uuid', nullable: true })
  projectionId: string | null;
}
