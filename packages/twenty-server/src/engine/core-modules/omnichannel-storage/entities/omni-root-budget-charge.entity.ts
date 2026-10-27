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

export type OmniRootBudgetChargeKind = 'crm_effect' | 'hop';

@Entity({ name: 'omniRootBudgetCharge', schema: 'core' })
@Unique('UQ_omniRootBudgetCharge_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniRootBudgetCharge_charge', [
  'workspaceId',
  'rootKind',
  'rootId',
  'chargeKind',
  'stableChargeKey',
])
@Check(
  'CHK_omniRootBudgetCharge_identity',
  'length("rootKind") > 0 AND length("stableChargeKey") > 0',
)
@Check(
  'CHK_omniRootBudgetCharge_cost',
  `("chargeKind" = 'crm_effect' AND "cost" >= 0) OR ` +
    `("chargeKind" = 'hop' AND "cost" = 1)`,
)
@Check(
  'CHK_omniRootBudgetCharge_execution',
  `jsonb_typeof("executionRef") = 'object'`,
)
export class OmniRootBudgetChargeEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false, update: false })
  rootKind: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  rootId: string;

  @ManyToOne('OmniRootExecutionEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'rootKind', referencedColumnName: 'rootKind' },
    { name: 'rootId', referencedColumnName: 'rootId' },
  ])
  root: Relation<OmniRootExecutionEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  chargeKind: OmniRootBudgetChargeKind;

  @Column({ type: 'text', nullable: false, update: false })
  stableChargeKey: string;

  @Column({ type: 'bigint', nullable: false, update: false })
  cost: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  executionRef: Record<string, unknown>;
}
