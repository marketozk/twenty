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

import { type CrmTeamEntity } from 'src/engine/core-modules/crm-access/entities/crm-team.entity';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmTeamMember', schema: 'core' })
@Unique('UQ_crmTeamMember_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmTeamMember_team_member', [
  'workspaceId',
  'teamId',
  'workspaceMemberId',
])
@Index('IDX_crmTeamMember_workspace_member', [
  'workspaceId',
  'workspaceMemberId',
])
@Check('CHK_crmTeamMember_revision', '"revision" > 0')
export class CrmTeamMemberEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  teamId: string;

  @ManyToOne('CrmTeamEntity', {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn([
    { name: 'workspaceId', referencedColumnName: 'workspaceId' },
    { name: 'teamId', referencedColumnName: 'id' },
  ])
  team: Relation<CrmTeamEntity>;

  // Dynamic workspace record; validated by server under policy fence.
  @Column({ type: 'uuid', nullable: false, update: false })
  workspaceMemberId: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
