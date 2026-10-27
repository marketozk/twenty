import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniAccountBindingEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-account-binding.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniExternalIdentity', schema: 'core' })
@Unique('UQ_omniExternalIdentity_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniExternalIdentity_binding_peer', [
  'workspaceId',
  'bindingId',
  'providerPeerId',
])
@Check('CHK_omniExternalIdentity_revision', '"revision" > 0')
export class OmniExternalIdentityEntity extends OmniWorkspaceRow {
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
  providerPeerId: string;

  @Column({ type: 'uuid', nullable: true })
  personId: string | null;

  @Column({ type: 'text', nullable: false })
  verificationSource: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
