import { Check, Column, Entity, Unique } from 'typeorm';

import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmRecordRevision', schema: 'core' })
@Unique('UQ_crmRecordRevision_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmRecordRevision_record', [
  'workspaceId',
  'objectMetadataId',
  'recordId',
])
@Check('CHK_crmRecordRevision_revision', '"revision" > 0')
export class CrmRecordRevisionEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false, update: false })
  objectMetadataId: string;

  @Column({ type: 'uuid', nullable: false, update: false })
  recordId: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
