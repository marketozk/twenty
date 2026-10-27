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
import { type OmniMessageLinkEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-message-link.entity';
import { type OmniRouteActivationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-route-activation.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'omniAutomationAdmission', schema: 'core' })
@Unique('UQ_omniAutomationAdmission_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_omniAutomationAdmission_message_effect', [
  'workspaceId',
  'bindingId',
  'messageLinkId',
  'effectKind',
])
@Check(
  'CHK_omniAutomationAdmission_effect',
  `"effectKind" = 'customer_inbound'`,
)
@Check('CHK_omniAutomationAdmission_activation', '"activationVersion" > 0')
export class OmniAutomationAdmissionEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  bindingId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  conversationId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  messageLinkId: string;

  @ManyToOne('OmniMessageLinkEntity', { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'conversationId', referencedColumnName: 'conversationId' },
    { name: 'messageLinkId', referencedColumnName: 'id' },
  ])
  messageLink: Relation<OmniMessageLinkEntity>;

  @Column({
    type: 'text',
    nullable: false,
    default: 'customer_inbound',
    update: false,
  })
  effectKind: 'customer_inbound';

  @Column({ type: 'bigint', nullable: false, update: false })
  activationVersion: string;

  @ManyToOne('OmniRouteActivationEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'bindingId', referencedColumnName: 'bindingId' },
    { name: 'activationVersion', referencedColumnName: 'activationVersion' },
  ])
  routeActivation: Relation<OmniRouteActivationEntity>;

  @Column({ type: 'jsonb', nullable: false, update: false })
  trustedSourcePosition: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: false, update: false })
  eventId: string;

  @ManyToOne('OmniDomainEventEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'conversationId', referencedColumnName: 'conversationId' },
    { name: 'eventId', referencedColumnName: 'id' },
  ])
  event: Relation<OmniDomainEventEntity>;
}
