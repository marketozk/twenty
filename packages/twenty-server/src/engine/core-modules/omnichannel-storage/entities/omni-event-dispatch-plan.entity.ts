import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniDomainEventEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-domain-event.entity';
import { type OmniRootExecutionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-root-execution.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniEventDispatchPlan', schema: 'core' })
@Unique('UQ_omniEventDispatchPlan_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniEventDispatchPlan_event', ['workspaceId', 'eventId'])
@Check(
  'CHK_omniEventDispatchPlan_identity',
  'length("rootKind") > 0 AND length("state") > 0',
)
@Check(
  'CHK_omniEventDispatchPlan_versions',
  '"policyVersion" >= 0 AND ("activationVersion" IS NULL OR "activationVersion" > 0)',
)
@Check('CHK_omniEventDispatchPlan_targets', `jsonb_typeof("targets") = 'array'`)
@Check(
  'CHK_omniEventDispatchPlan_payloadHash',
  `"payloadHash" ~ '^[a-f0-9]{64}$'`,
)
export class OmniEventDispatchPlanEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  eventId: string;

  @ManyToOne('OmniDomainEventEntity', { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'eventId', referencedColumnName: 'id' },
  ])
  event: Relation<OmniDomainEventEntity>;

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

  @Column({ type: 'bigint', nullable: true, update: false })
  activationVersion: string | null;

  @Column({ type: 'jsonb', nullable: false, update: false })
  targets: Record<string, unknown>[];

  @Column({ type: 'text', nullable: false, update: false })
  payloadHash: string;

  @Column({ type: 'boolean', nullable: false, update: false })
  initialPlan: boolean;

  @Column({ type: 'text', nullable: false })
  state: string;
}
