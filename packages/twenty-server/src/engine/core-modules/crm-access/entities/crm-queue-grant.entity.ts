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

import {
  type CrmAccessEffect,
  type CrmAccessPrincipalKind,
} from 'src/engine/core-modules/crm-access/types/crm-access-schema.types';
import { type OmniQueueEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-queue.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmQueueGrant', schema: 'core' })
@Unique('UQ_crmQueueGrant_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmQueueGrant_grant', [
  'workspaceId',
  'bindingId',
  'queueId',
  'principalKind',
  'principalId',
  'action',
])
@Index('IDX_crmQueueGrant_principal', [
  'workspaceId',
  'principalKind',
  'principalId',
  'action',
])
@Check(
  'CHK_crmQueueGrant_principalKind',
  `"principalKind" IN ('workspaceMember', 'team', 'role', 'application', 'agent', 'apiKey', 'workflow')`,
)
@Check(
  'CHK_crmQueueGrant_action',
  `btrim("action") = "action" AND "action" <> ''`,
)
@Check('CHK_crmQueueGrant_effect', `"effect" IN ('allow', 'deny')`)
@Check('CHK_crmQueueGrant_revision', '"revision" > 0')
export class CrmQueueGrantEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false })
  bindingId: string;

  @Column({ type: 'uuid', nullable: false })
  queueId: string;

  @ManyToOne('OmniQueueEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'queueId', referencedColumnName: 'id' },
  ])
  queue: Relation<OmniQueueEntity>;

  @Column({ type: 'text', nullable: false })
  principalKind: CrmAccessPrincipalKind;

  @Column({ type: 'uuid', nullable: false })
  principalId: string;

  @Column({ type: 'text', nullable: false })
  action: string;

  @Column({ type: 'text', nullable: false })
  effect: CrmAccessEffect;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
