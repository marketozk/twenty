import { Check, Column, Entity, Unique } from 'typeorm';

import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmTeam', schema: 'core' })
@Unique('UQ_crmTeam_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmTeam_workspace_name', ['workspaceId', 'name'])
@Check('CHK_crmTeam_name', `btrim("name") = "name" AND "name" <> ''`)
@Check('CHK_crmTeam_revision', '"revision" > 0')
export class CrmTeamEntity extends OmniWorkspaceRow {
  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
