import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniConversationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-conversation.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniConversationMember', schema: 'core' })
@Unique('UQ_omniConversationMember_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniConversationMember_conversation_member', [
  'workspaceId',
  'conversationId',
  'workspaceMemberId',
])
export class OmniConversationMemberEntity extends OmniWorkspaceRow {
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
}
