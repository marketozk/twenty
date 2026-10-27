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
import { type OmniAutomationPolicyVersionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy-version.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniAutomationPolicy', schema: 'core' })
@Unique('UQ_omniAutomationPolicy_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniAutomationPolicy_binding', ['workspaceId', 'bindingId'])
@Unique('UQ_omniAutomationPolicy_binding_id', [
  'workspaceId',
  'bindingId',
  'id',
])
@Check('CHK_omniAutomationPolicy_revision', '"revision" > 0')
@Check(
  'CHK_omniAutomationPolicy_version',
  '"currentVersion" IS NULL OR "currentVersion" >= 0',
)
export class OmniAutomationPolicyEntity extends OmniWorkspaceRow {
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

  @Column({ type: 'bigint', nullable: true })
  currentVersion: string | null;

  @ManyToOne('OmniAutomationPolicyVersionEntity', {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'id', referencedColumnName: 'policyId' },
    { name: 'currentVersion', referencedColumnName: 'version' },
  ])
  currentPolicyVersion: Relation<OmniAutomationPolicyVersionEntity> | null;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
