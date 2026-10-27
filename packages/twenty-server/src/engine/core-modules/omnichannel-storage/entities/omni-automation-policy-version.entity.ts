import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniAutomationPolicyEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniAutomationPolicyVersion', schema: 'core' })
@Unique('UQ_omniAutomationPolicyVersion_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniAutomationPolicyVersion_policy_version', [
  'workspaceId',
  'policyId',
  'version',
])
@Check('CHK_omniAutomationPolicyVersion_version', '"version" >= 0')
@Check(
  'CHK_omniAutomationPolicyVersion_settingsHash',
  `"settingsHash" ~ '^[a-f0-9]{64}$'`,
)
export class OmniAutomationPolicyVersionEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  policyId: string;

  @ManyToOne('OmniAutomationPolicyEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'policyId', referencedColumnName: 'id' },
  ])
  policy: Relation<OmniAutomationPolicyEntity>;

  @Column({ type: 'bigint', nullable: false, update: false })
  version: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  settings: Record<string, unknown>;

  @Column({ type: 'text', nullable: false, update: false })
  settingsHash: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  publishedBy: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: false, update: false })
  publishedAt: Date;
}
