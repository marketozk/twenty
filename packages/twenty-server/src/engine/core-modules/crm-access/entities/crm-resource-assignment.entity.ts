import { Check, Column, Entity, Index, Unique } from 'typeorm';

import {
  type CrmAccessPrincipalKind,
  type CrmResourceAssignmentKind,
} from 'src/engine/core-modules/crm-access/types/crm-access-schema.types';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmResourceAssignment', schema: 'core' })
@Unique('UQ_crmResourceAssignment_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmResourceAssignment_assignment', [
  'workspaceId',
  'resourceKind',
  'resourceId',
  'principalKind',
  'principalId',
  'assignmentKind',
])
@Index(
  'UQ_crmResourceAssignment_primary_owner',
  ['workspaceId', 'resourceKind', 'resourceId'],
  { unique: true, where: `"assignmentKind" = 'primary_owner'` },
)
@Index('IDX_crmResourceAssignment_principal', [
  'workspaceId',
  'principalKind',
  'principalId',
  'resourceKind',
])
@Check(
  'CHK_crmResourceAssignment_resourceKind',
  `btrim("resourceKind") = "resourceKind" AND "resourceKind" <> ''`,
)
@Check(
  'CHK_crmResourceAssignment_kind',
  `"assignmentKind" IN ('primary_owner', 'team')`,
)
@Check(
  'CHK_crmResourceAssignment_principal',
  `("assignmentKind" = 'primary_owner' AND "principalKind" = 'workspaceMember') OR ("assignmentKind" = 'team' AND "principalKind" = 'team')`,
)
@Check('CHK_crmResourceAssignment_revision', '"revision" > 0')
export class CrmResourceAssignmentEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false })
  resourceKind: string;

  @Column({ type: 'uuid', nullable: false })
  resourceId: string;

  @Column({ type: 'text', nullable: false })
  principalKind: Extract<CrmAccessPrincipalKind, 'workspaceMember' | 'team'>;

  @Column({ type: 'uuid', nullable: false })
  principalId: string;

  @Column({ type: 'text', nullable: false })
  assignmentKind: CrmResourceAssignmentKind;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
