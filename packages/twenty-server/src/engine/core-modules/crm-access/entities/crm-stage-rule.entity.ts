import { Check, Column, Entity, Index, Unique } from 'typeorm';

import {
  type CrmAccessEffect,
  type CrmAccessPrincipalKind,
  type CrmStageRuleAction,
} from 'src/engine/core-modules/crm-access/types/crm-access-schema.types';
import { OmniWorkspaceRow } from 'src/engine/core-modules/omnichannel-storage/entities/omni-workspace-row';

@Entity({ name: 'crmStageRule', schema: 'core' })
@Unique('UQ_crmStageRule_workspace_id', ['workspaceId', 'id'])
@Unique('UQ_crmStageRule_rule', [
  'workspaceId',
  'objectMetadataId',
  'fieldMetadataId',
  'action',
  'optionValue',
  'fromValue',
  'toValue',
  'principalKind',
  'principalId',
])
@Index('IDX_crmStageRule_principal_field', [
  'workspaceId',
  'principalKind',
  'principalId',
  'objectMetadataId',
  'fieldMetadataId',
  'action',
])
@Check(
  'CHK_crmStageRule_action',
  `"action" IN ('read', 'edit', 'transition', 'configure')`,
)
@Check(
  'CHK_crmStageRule_values',
  `btrim("optionValue") = "optionValue" AND "optionValue" <> '' AND btrim("fromValue") = "fromValue" AND "fromValue" <> '' AND btrim("toValue") = "toValue" AND "toValue" <> ''`,
)
@Check(
  'CHK_crmStageRule_shape',
  `("action" IN ('read', 'edit') AND "optionValue" <> '*' AND "fromValue" = '*' AND "toValue" = '*') OR ("action" = 'transition' AND "optionValue" = '*' AND "fromValue" <> '*' AND "toValue" <> '*') OR ("action" = 'configure' AND "optionValue" = '*' AND "fromValue" = '*' AND "toValue" = '*')`,
)
@Check(
  'CHK_crmStageRule_principalKind',
  `"principalKind" IN ('workspaceMember', 'team', 'role', 'application', 'agent', 'apiKey', 'workflow')`,
)
@Check('CHK_crmStageRule_effect', `"effect" IN ('allow', 'deny')`)
@Check('CHK_crmStageRule_revision', '"revision" > 0')
export class CrmStageRuleEntity extends OmniWorkspaceRow {
  @Column({ type: 'uuid', nullable: false })
  objectMetadataId: string;

  @Column({ type: 'uuid', nullable: false })
  fieldMetadataId: string;

  @Column({ type: 'text', nullable: false })
  action: CrmStageRuleAction;

  @Column({ type: 'text', nullable: false })
  optionValue: string;

  @Column({ type: 'text', nullable: false })
  fromValue: string;

  @Column({ type: 'text', nullable: false })
  toValue: string;

  @Column({ type: 'text', nullable: false })
  principalKind: CrmAccessPrincipalKind;

  @Column({ type: 'uuid', nullable: false })
  principalId: string;

  @Column({ type: 'text', nullable: false })
  effect: CrmAccessEffect;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  revision: string;
}
