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

import { type OmniConversationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-conversation.entity';
import { type OmniMessageRevisionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-message-revision.entity';
import { type OmniOutgoingCommandEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-outgoing-command.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniMessageDisplayTimeSource = 'source' | 'capture';

@Entity({ name: 'omniMessageLink', schema: 'core' })
@Unique('UQ_omniMessageLink_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniMessageLink_conversation_id', [
  'workspaceId',
  'conversationId',
  'id',
])
@Unique('UQ_omniMessageLink_binding_conversation_id', [
  'workspaceId',
  'bindingId',
  'conversationId',
  'id',
])
@Unique('UQ_omniMessageLink_native_key', [
  'workspaceId',
  'bindingId',
  'conversationId',
  'nativeMessageKey',
])
@Unique('UQ_omniMessageLink_message', ['workspaceId', 'messageId'])
@Index('IDX_omniMessageLink_timeline', [
  'workspaceId',
  'conversationId',
  'displayOccurredAt',
  'id',
])
@Check('CHK_omniMessageLink_key_version', '"nativeMessageKeyVersion" > 0')
@Check(
  'CHK_omniMessageLink_time_source',
  `"displayTimeSource" IN ('source', 'capture')`,
)
@Check(
  'CHK_omniMessageLink_identity',
  `length("rawNativeMessageId") > 0 AND length("nativeMessageKey") > 0 AND ` +
    `length("senderProvenance") > 0 AND length("correlationState") > 0`,
)
export class OmniMessageLinkEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  conversationId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  bindingId: string;

  @ManyToOne('OmniConversationEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'conversationId', referencedColumnName: 'id' },
  ])
  conversation: Relation<OmniConversationEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  rawNativeMessageId: string;

  @Column({ type: 'text', nullable: false, update: false })
  nativeMessageKey: string;

  @Column({ type: 'integer', nullable: false, update: false })
  nativeMessageKeyVersion: number;

  @Column({ type: 'uuid', nullable: false, update: false })
  messageId: string;

  @Column({ type: 'text', nullable: true })
  providerRevision: string | null;

  @Column({ type: 'uuid', nullable: true })
  currentRevisionId: string | null;

  @ManyToOne('OmniMessageRevisionEntity', {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn([
    {
      name: 'workspaceId',
      referencedColumnName: 'workspaceId',
      foreignKeyConstraintName: 'FK_omniMessageLink_current_revision',
    },
    { name: 'id', referencedColumnName: 'messageLinkId' },
    { name: 'currentRevisionId', referencedColumnName: 'id' },
  ])
  currentRevision: Relation<OmniMessageRevisionEntity> | null;

  @Column({ type: 'jsonb', nullable: true })
  sourcePosition: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: false, update: false })
  displayOccurredAt: Date;

  @Column({ type: 'text', nullable: false, update: false })
  displayTimeSource: OmniMessageDisplayTimeSource;

  @Column({ type: 'uuid', nullable: true })
  outgoingCommandId: string | null;

  @ManyToOne('OmniOutgoingCommandEntity', {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'conversationId' },
    { name: 'outgoingCommandId', referencedColumnName: 'id' },
  ])
  outgoingCommand: Relation<OmniOutgoingCommandEntity> | null;

  @Column({ type: 'jsonb', nullable: false, update: false })
  immutableAuthorSnapshot: Record<string, unknown>;

  @Column({ type: 'text', nullable: true, update: false })
  sourceAuthorId: string | null;

  @Column({ type: 'text', nullable: true, update: false })
  sourceDisplayName: string | null;

  @Column({ type: 'text', nullable: true, update: false })
  authorVerification: string | null;

  @Column({ type: 'text', nullable: false })
  senderProvenance: string;

  @Column({ type: 'text', nullable: false })
  correlationState: string;
}
