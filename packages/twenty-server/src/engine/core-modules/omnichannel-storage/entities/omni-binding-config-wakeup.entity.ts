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

import { type OmniAccountBindingEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-account-binding.entity';
import { type OmniDomainEventEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-domain-event.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniBindingConfigWakeupState =
  | 'pending'
  | 'running'
  | 'retryable'
  | 'completed'
  | 'blocked';
export type OmniBindingConfigWakeupError =
  | 'binding_inactive'
  | 'unsupported_handler'
  | 'rescan_required'
  | 'transient_failure';

@Entity({ name: 'omniBindingConfigWakeup', schema: 'core' })
@Unique('UQ_omniBindingConfigWakeup_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniBindingConfigWakeup_event', ['workspaceId', 'eventId'])
@Index('IDX_omniBindingConfigWakeup_due', [
  'workspaceId',
  'bindingId',
  'state',
  'nextAttemptAt',
])
@Check(
  'CHK_omniBindingConfigWakeup_state',
  `"state" IN ('pending', 'running', 'retryable', 'completed', 'blocked')`,
)
@Check(
  'CHK_omniBindingConfigWakeup_counters',
  '"handlerVersion" > 0 AND "attempts" >= 0 AND "leaseToken" >= 0',
)
@Check(
  'CHK_omniBindingConfigWakeup_lease',
  `("state" = 'running' AND "leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "leaseToken" > 0) OR ` +
    `("state" <> 'running' AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL)`,
)
@Check(
  'CHK_omniBindingConfigWakeup_cursor',
  '("cursorNextAttemptAt" IS NULL) = ("cursorReceiptId" IS NULL)',
)
@Check(
  'CHK_omniBindingConfigWakeup_generation',
  '"observedRouteGeneration" IS NULL OR "observedRouteGeneration" > 0',
)
@Check(
  'CHK_omniBindingConfigWakeup_error',
  `"errorCode" IS NULL OR "errorCode" IN ('binding_inactive', 'unsupported_handler', 'rescan_required', 'transient_failure')`,
)
export class OmniBindingConfigWakeupEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  eventId: string;

  @ManyToOne('OmniDomainEventEntity', { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'eventId', referencedColumnName: 'id' },
  ])
  event: Relation<OmniDomainEventEntity>;

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

  @Column({ type: 'integer', nullable: false, default: 1, update: false })
  handlerVersion: number;

  @Column({ type: 'text', nullable: false, default: 'pending' })
  state: OmniBindingConfigWakeupState;

  @Column({ type: 'integer', nullable: false, default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  leaseOwner: string | null;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  leaseToken: string;

  @Column({ type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  cursorNextAttemptAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  cursorReceiptId: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  needsRescan: boolean;

  @Column({ type: 'bigint', nullable: true })
  observedRouteGeneration: string | null;

  @Column({ type: 'text', nullable: true })
  errorCode: OmniBindingConfigWakeupError | null;
}
