import { Check, Column, Entity, Generated, Unique } from 'typeorm';

import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniWorkspacePolicyState', schema: 'core' })
@Unique('UQ_omniWorkspacePolicyState_workspace', ['workspaceId'])
@Unique('UQ_omniWorkspacePolicyState_workspace_id', ['workspaceId', 'id'])
@Check('CHK_omniWorkspacePolicyState_epoch', '"epoch" > 0')
export class OmniWorkspacePolicyStateEntity extends OmniWorkspaceRow {
  @Column({ type: 'bigint', nullable: false, default: '1' })
  epoch: string;

  @Generated('uuid')
  @Column({
    type: 'uuid',
    nullable: false,
    default: () => 'uuid_generate_v4()',
  })
  restoreIncarnation: string;
}
