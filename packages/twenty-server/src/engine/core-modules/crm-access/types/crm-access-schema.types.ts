export const CRM_ACCESS_PRINCIPAL_KINDS = [
  'workspaceMember',
  'team',
  'role',
  'application',
  'agent',
  'apiKey',
  'workflow',
] as const;

export type CrmAccessPrincipalKind =
  (typeof CRM_ACCESS_PRINCIPAL_KINDS)[number];

export const CRM_ACCESS_EFFECTS = ['allow', 'deny'] as const;

export type CrmAccessEffect = (typeof CRM_ACCESS_EFFECTS)[number];

export const CRM_RESOURCE_ASSIGNMENT_KINDS = [
  'primary_owner',
  'team',
] as const;

export type CrmResourceAssignmentKind =
  (typeof CRM_RESOURCE_ASSIGNMENT_KINDS)[number];

export const CRM_STAGE_RULE_ACTIONS = [
  'read',
  'edit',
  'transition',
  'configure',
] as const;

export type CrmStageRuleAction = (typeof CRM_STAGE_RULE_ACTIONS)[number];

export const CRM_STAGE_RULE_WILDCARD = '*' as const;
