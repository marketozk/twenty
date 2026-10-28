import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniMessageLinkEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-message-link.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniMessageRevision', schema: 'core' })
@Unique('UQ_omniMessageRevision_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniMessageRevision_link_id', [
  'workspaceId',
  'messageLinkId',
  'id',
])
@Unique('UQ_omniMessageRevision_source_revision', [
  'workspaceId',
  'messageLinkId',
  'sourceRevisionKey',
])
@Check('CHK_omniMessageRevision_hash', `"contentHash" ~ '^[a-f0-9]{64}$'`)
@Check(
  'CHK_omniMessageRevision_source',
  `length("sourceRevisionKey") > 0 AND length("sourceEventId") > 0 AND ` +
    `length("origin") > 0`,
)
export class OmniMessageRevisionEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  messageLinkId: string;

  @ManyToOne('OmniMessageLinkEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'messageLinkId', referencedColumnName: 'id' },
  ])
  messageLink: Relation<OmniMessageLinkEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  sourceRevisionKey: string;

  @Column({ type: 'text', nullable: false, update: false })
  sourceEventId: string;

  @Column({ type: 'text', nullable: false, update: false })
  contentHash: string;

  @Column({ type: 'boolean', nullable: false, update: false })
  tombstone: boolean;

  @Column({ type: 'text', nullable: false, update: false })
  origin: string;

  @Column({ type: 'text', nullable: true })
  protectedPayloadRef: string | null;
}
