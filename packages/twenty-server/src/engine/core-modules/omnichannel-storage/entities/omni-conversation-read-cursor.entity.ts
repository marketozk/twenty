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

@Entity({ name: 'omniConversationReadCursor', schema: 'core' })
@Unique('UQ_omniConversationReadCursor_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniConversationReadCursor_conversation_member', [
  'workspaceId',
  'conversationId',
  'workspaceMemberId',
])
@Check('CHK_omniConversationReadCursor_sequence', '"lastReadSequence" >= 0')
export class OmniConversationReadCursorEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false })
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

  @Column({ type: 'uuid', nullable: false })
  workspaceMemberId: string;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  lastReadSequence: string;
}
