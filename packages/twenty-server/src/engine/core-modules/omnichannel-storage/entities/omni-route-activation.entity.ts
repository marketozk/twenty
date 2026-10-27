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

@Entity({ name: 'omniRouteActivation', schema: 'core' })
@Unique('UQ_omniRouteActivation_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniRouteActivation_binding_version', [
  'workspaceId',
  'bindingId',
  'activationVersion',
])
@Check('CHK_omniRouteActivation_version', '"activationVersion" > 0')
@Check(
  'CHK_omniRouteActivation_position_type',
  'length("sourcePositionType") > 0',
)
export class OmniRouteActivationEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
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

  @Column({ type: 'bigint', nullable: false, update: false })
  activationVersion: string;

  @Column({ type: 'text', nullable: false, update: false })
  sourcePositionType: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  boundary: Record<string, unknown>;
}
