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
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmAutomationArtifactScope', schema: 'core' })
@Unique('UQ_crmAutomationArtifactScope_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmAutomationArtifactScope_artifact', [
  'workspaceId',
  'artifactKind',
  'artifactId',
])
@Index('IDX_crmAutomationArtifactScope_conversation', [
  'workspaceId',
  'conversationId',
  'artifactKind',
])
@Check(
  'CHK_crmAutomationArtifactScope_kind',
  `btrim("artifactKind") = "artifactKind" AND "artifactKind" <> ''`,
)
@Check(
  'CHK_crmAutomationArtifactScope_scope',
  `jsonb_typeof("capturedResourceScope") = 'object'`,
)
export class CrmAutomationArtifactScopeEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false, update: false })
  artifactKind: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  artifactId: string;

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

  // Composite FK to OmniExecutionReference is added in ROB-769 (spec §3).
  @Column({ type: 'uuid', nullable: true })
  referenceId: string | null;

  @Column({ type: 'jsonb', nullable: false })
  capturedResourceScope: Record<string, unknown>;
}
