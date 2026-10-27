import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { type OmniOutgoingCommandEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-outgoing-command.entity';
import { type OmniReplyBudgetEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-reply-budget.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniReplySlot', schema: 'core' })
@Unique('UQ_omniReplySlot_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniReplySlot_root_slot', [
  'workspaceId',
  'rootKind',
  'rootId',
  'replySlot',
])
@Check('CHK_omniReplySlot_number', '"replySlot" > 0')
@Check(
  'CHK_omniReplySlot_producer',
  'length("rootKind") > 0 AND length("producerKind") > 0 AND length("producerId") > 0',
)
@Check('CHK_omniReplySlot_payloadHash', `"payloadHash" ~ '^[a-f0-9]{64}$'`)
@Check('CHK_omniReplySlot_effect', `jsonb_typeof("effectRef") = 'object'`)
@Check('CHK_omniReplySlot_state', `"state" = 'bound'`)
export class OmniReplySlotEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false, update: false })
  rootKind: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  rootId: string;

  @ManyToOne('OmniReplyBudgetEntity', { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'rootKind', referencedColumnName: 'rootKind' },
    { name: 'rootId', referencedColumnName: 'rootId' },
  ])
  budget: Relation<OmniReplyBudgetEntity>;

  @Column({ type: 'bigint', nullable: false, update: false })
  replySlot: string;

  @Column({ type: 'text', nullable: false, update: false })
  producerKind: string;

  @Column({ type: 'text', nullable: false, update: false })
  producerId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  commandId: string;

  @ManyToOne('OmniOutgoingCommandEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'commandId', referencedColumnName: 'id' },
  ])
  command: Relation<OmniOutgoingCommandEntity>;

  @Column({ type: 'text', nullable: false, update: false })
  payloadHash: string;

  @Column({ type: 'jsonb', nullable: false, update: false })
  effectRef: Record<string, unknown>;

  @Column({ type: 'text', nullable: false, default: 'bound', update: false })
  state: 'bound';
}
