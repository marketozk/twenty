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
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

export type OmniIncomingReceiptState =
  | 'accepted'
  | 'processing'
  | 'applied'
  | 'retryable_error'
  | 'blocked_config'
  | 'quarantined';

@Entity({ name: 'omniIncomingReceipt', schema: 'core' })
@Unique('UQ_omniIncomingReceipt_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniIncomingReceipt_binding_event', [
  'workspaceId',
  'bindingId',
  'eventId',
])
@Index('IDX_omniIncomingReceipt_due', [
  'workspaceId',
  'state',
  'nextAttemptAt',
  'leaseUntil',
])
@Index('IDX_omniIncomingReceipt_binding_due', [
  'workspaceId',
  'bindingId',
  'state',
  'nextAttemptAt',
])
@Check(
  'CHK_omniIncomingReceipt_state',
  `"state" IN ('accepted', 'processing', 'applied', ` +
    `'retryable_error', 'blocked_config', 'quarantined')`,
)
@Check(
  'CHK_omniIncomingReceipt_counters',
  '"schemaVersion" > 0 AND "routeGeneration" > 0 AND ' +
    '"attempts" >= 0 AND "leaseToken" >= 0',
)
@Check(
  'CHK_omniIncomingReceipt_hash',
  `"canonicalPayloadHash" ~ '^[a-f0-9]{64}$'`,
)
@Check(
  'CHK_omniIncomingReceipt_lease',
  '("leaseOwner" IS NULL) = ("leaseUntil" IS NULL) AND ' +
    `("state" <> 'processing' OR ` +
    '("leaseOwner" IS NOT NULL AND "leaseToken" > 0))',
)
@Check(
  'CHK_omniIncomingReceipt_identity',
  'length("eventId") > 0 AND length("kind") > 0',
)
@Check(
  'CHK_omniIncomingReceipt_trusted_capture',
  '("trustedCaptureContext" IS NULL AND "trustedCaptureContextHash" IS NULL) OR ' +
    '("trustedCaptureContext" IS NOT NULL AND "trustedCaptureContextHash" IS NOT NULL AND ' +
    `jsonb_typeof("trustedCaptureContext") = 'object' AND ` +
    `"trustedCaptureContextHash" ~ '^[a-f0-9]{64}$')`,
)
export class OmniIncomingReceiptEntity extends OmniWorkspaceRow {
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

  @Column({ type: 'text', nullable: false, update: false })
  eventId: string;

  @Column({ type: 'text', nullable: false, update: false })
  kind: string;

  @Column({ type: 'integer', nullable: false, update: false })
  schemaVersion: number;

  @Column({ type: 'bigint', nullable: false, update: false })
  routeGeneration: string;

  @Column({ type: 'text', nullable: false, update: false })
  canonicalPayloadHash: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  validatedEnvelope: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true, update: false })
  trustedCaptureContext: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true, update: false })
  trustedCaptureContextHash: string | null;

  @Column({ type: 'text', nullable: false, default: 'accepted' })
  state: OmniIncomingReceiptState;

  @Column({ type: 'integer', nullable: false, default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'text', nullable: true })
  leaseOwner: string | null;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  leaseToken: string;

  @Column({ type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resultId: string | null;

  @Column({ type: 'text', nullable: true })
  errorCode: string | null;
}
