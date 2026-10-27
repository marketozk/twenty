import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniAutomationPolicyVersionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy-version.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniRootExecution', schema: 'core' })
@Unique('UQ_omniRootExecution_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniRootExecution_source', ['workspaceId', 'rootKind', 'sourceKey'])
@Unique('UQ_omniRootExecution_root', ['workspaceId', 'rootKind', 'rootId'])
@Unique('UQ_omniRootExecution_root_policy', [
  'workspaceId',
  'rootKind',
  'rootId',
  'policyId',
  'policyVersion',
])
@Index('IDX_omniRootExecution_policy_state', [
  'workspaceId',
  'policyId',
  'policyVersion',
  'state',
  'id',
])
@Check(
  'CHK_omniRootExecution_identity',
  `length("rootKind") > 0 AND length("sourceKey") > 0 AND ` +
    `length("origin") > 0 AND "origin" != 'import' AND length("state") > 0`,
)
@Check(
  'CHK_omniRootExecution_budgets',
  '"policyVersion" >= 0 AND "maxCrmEffects" >= 0 AND "maxHops" >= 0 AND ' +
    '"usedCrmEffects" >= 0 AND "usedCrmEffects" <= "maxCrmEffects" AND ' +
    '"usedHops" >= 0 AND "usedHops" <= "maxHops"',
)
@Check(
  'CHK_omniRootExecution_context',
  `jsonb_typeof("scope") = 'object' AND jsonb_typeof("coveredRoots") = 'array'`,
)
@Check(
  'CHK_omniRootExecution_initial_events',
  'array_position("initialEventIds", NULL) IS NULL',
)
export class OmniRootExecutionEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false, update: false })
  rootKind: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  rootId: string;

  @Column({ type: 'text', nullable: false, update: false })
  sourceKey: string;

  @Column({ type: 'uuid', array: true, nullable: false, update: false })
  initialEventIds: string[];

  @Column({ type: 'text', nullable: false, update: false })
  origin: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  scope: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true, update: false })
  causationId: string | null;

  @Column({ type: 'jsonb', nullable: false, update: false })
  coveredRoots: Record<string, unknown>[];

  @Column({ type: 'uuid', nullable: false, update: false })
  policyId: string;

  @Column({ type: 'bigint', nullable: false, update: false })
  policyVersion: string;

  @ManyToOne('OmniAutomationPolicyVersionEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'policyId', referencedColumnName: 'policyId' },
    { name: 'policyVersion', referencedColumnName: 'version' },
  ])
  automationPolicyVersion: Relation<OmniAutomationPolicyVersionEntity>;

  @Column({ type: 'bigint', nullable: false, update: false })
  maxCrmEffects: string;

  @Column({ type: 'bigint', nullable: false, update: false })
  maxHops: string;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  usedCrmEffects: string;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  usedHops: string;

  @Column({ type: 'text', nullable: false })
  state: string;
}
