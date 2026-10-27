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

import { type OmniDomainEventEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-domain-event.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniConsumerReceipt', schema: 'core' })
@Unique('UQ_omniConsumerReceipt_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniConsumerReceipt_event_consumer', [
  'workspaceId',
  'eventId',
  'consumerId',
])
@Index('IDX_omniConsumerReceipt_recovery', [
  'workspaceId',
  'state',
  'nextAttemptAt',
  'leaseUntil',
])
@Check(
  'CHK_omniConsumerReceipt_identity',
  'length("consumerId") > 0 AND length("state") > 0',
)
@Check(
  'CHK_omniConsumerReceipt_counters',
  '"attempt" >= 0 AND "leaseToken" >= 0',
)
@Check(
  'CHK_omniConsumerReceipt_lease',
  `"state" <> 'running' OR ("leaseToken" > 0 AND "leaseUntil" IS NOT NULL)`,
)
export class OmniConsumerReceiptEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  eventId: string;

  @ManyToOne('OmniDomainEventEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'eventId', referencedColumnName: 'id' },
  ])
  event: Relation<OmniDomainEventEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  consumerId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  pinnedVersionId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  executionId: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  runIntentId: string | null;

  @Column({ type: 'uuid', nullable: true, update: false })
  referenceId: string | null;

  @Column({ type: 'text', nullable: false, default: 'pending' })
  state: string;

  @Column({ type: 'integer', nullable: false, default: 0 })
  attempt: number;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  leaseToken: string;

  @Column({ type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  nextAttemptAt: Date;
}
