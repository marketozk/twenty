import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniRootExecutionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-root-execution.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniReplyBudget', schema: 'core' })
@Unique('UQ_omniReplyBudget_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniReplyBudget_root', ['workspaceId', 'rootKind', 'rootId'])
@Check('CHK_omniReplyBudget_root_kind', 'length("rootKind") > 0')
@Check(
  'CHK_omniReplyBudget_limits',
  '"policyVersion" >= 0 AND "maxReplies" >= 0',
)
export class OmniReplyBudgetEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false, update: false })
  rootKind: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  rootId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  policyId: string;

  @Column({ type: 'bigint', nullable: false, update: false })
  policyVersion: string;

  @ManyToOne('OmniRootExecutionEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'rootKind', referencedColumnName: 'rootKind' },
    { name: 'rootId', referencedColumnName: 'rootId' },
    { name: 'policyId', referencedColumnName: 'policyId' },
    { name: 'policyVersion', referencedColumnName: 'policyVersion' },
  ])
  root: Relation<OmniRootExecutionEntity>;

  @Column({ type: 'bigint', nullable: false, update: false })
  maxReplies: string;
}
