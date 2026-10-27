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

@Entity({ name: 'omniQueue', schema: 'core' })
@Unique('UQ_omniQueue_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniQueue_binding_id', ['workspaceId', 'bindingId', 'id'])
@Unique('UQ_omniQueue_binding_name', ['workspaceId', 'bindingId', 'name'])
@Check('CHK_omniQueue_revision', '"revision" > 0')
export class OmniQueueEntity extends OmniWorkspaceRow {
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
  name: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  active: boolean;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
