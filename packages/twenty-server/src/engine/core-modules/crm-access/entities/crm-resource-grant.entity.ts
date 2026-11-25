import { Check, Column, Entity, Index, Unique } from 'typeorm';

import {
  type CrmAccessEffect,
  type CrmAccessPrincipalKind,
} from 'src/engine/core-modules/crm-access/types/crm-access-schema.types';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmResourceGrant', schema: 'core' })
@Unique('UQ_crmResourceGrant_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmResourceGrant_grant', [
  'workspaceId',
  'resourceKind',
  'resourceId',
  'principalKind',
  'principalId',
  'action',
])
@Index('IDX_crmResourceGrant_principal_resource', [
  'workspaceId',
  'principalKind',
  'principalId',
  'resourceKind',
  'action',
])
@Check(
  'CHK_crmResourceGrant_resourceKind',
  `btrim("resourceKind") = "resourceKind" AND "resourceKind" <> ''`,
)
@Check(
  'CHK_crmResourceGrant_principalKind',
  `"principalKind" IN ('workspaceMember', 'team', 'role', 'application', 'agent', 'apiKey', 'workflow')`,
)
@Check(
  'CHK_crmResourceGrant_action',
  `btrim("action") = "action" AND "action" <> ''`,
)
@Check('CHK_crmResourceGrant_effect', `"effect" IN ('allow', 'deny')`)
@Check('CHK_crmResourceGrant_revision', '"revision" > 0')
export class CrmResourceGrantEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false })
  resourceKind: string;

  @Column({ type: 'uuid', nullable: false })
  resourceId: string;

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
