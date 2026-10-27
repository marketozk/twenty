import { Check, Column, Entity, Unique } from 'typeorm';

import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniPolicyMutationReceipt', schema: 'core' })
@Unique('UQ_omniPolicyMutationReceipt_actor_key', [
  'workspaceId',
  'actorKind',
  'actorId',
  'idempotencyKey',
])
@Check('CHK_omniPolicyMutationReceipt_hash', `"payloadHash" ~ '^[a-f0-9]{64}$'`)
export class OmniPolicyMutationReceiptEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false })
  actorKind: string;

  @Column({ type: 'text', nullable: false })
  actorId: string;

  @Column({ type: 'text', nullable: false })
  idempotencyKey: string;

  @Column({ type: 'uuid', nullable: false })
  operationId: string;

  @Column({ type: 'text', nullable: false })
  action: string;

  @Column({ type: 'jsonb', nullable: false })
  resourceDescriptor: Record<string, unknown>;

  @Column({ type: 'text', nullable: false })
  payloadHash: string;

  @Column({ type: 'jsonb', nullable: true })
  resultPublic: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: false })
  committedAt: Date;
}
