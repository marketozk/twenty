export type CrmAuditPrincipal = {
  kind:
    | 'workspaceMember'
    | 'system'
    | 'agent'
    | 'workflow'
    | 'application'
    | 'apiKey';
  id: string;
};

export type CrmAuditResourceKind =
  | 'crmRecord'
  | 'crmFile'
  | 'omniAccountBinding'
  | 'omniPerson'
  | 'omniCompany'
  | 'omniExternalIdentity'
  | 'omniConversationTarget'
  | 'omniMessageThreadTarget'
  | 'omniBindingConfigWakeup'
  | 'omniIncomingReceipt'
  | 'omniOutgoingCommand'
  | 'omniMessage'
  | 'omniMessageThread'
  | 'omniMessageParticipant'
  | 'omniMessageAssociation'
  | 'omniMessageLink'
  | 'omniMessageRevision'
  | 'omniConversation'
  | 'omniDomainEvent'
  | 'omniRootExecution'
  | 'omniEventDispatchPlan'
  | 'omniAutomationPolicy'
  | 'omniAutomationPolicyVersion'
  | 'omniWorkspacePolicyState'
  | 'omniQueue';

export type CrmAuditAction = 'create' | 'update' | 'delete';

export type CrmAuditSecurityDescriptor = {
  resourceKind: CrmAuditResourceKind;
  resourceId: string;
  objectMetadataId?: string;
  fileParent?: {
    objectMetadataId: string;
    recordId: string;
    fieldMetadataId: string;
  };
  bindingId?: string;
  conversationId?: string;
  queueId?: string;
  deletedParent?: {
    objectMetadataId: string;
    name: 'person' | 'company';
    access: 'currentWorkspaceAdministration';
  };
};

export type CrmAuditOperation = {
  workspaceId: string;
  operationId: string;
  actor: CrmAuditPrincipal;
  initiator?: CrmAuditPrincipal;
  correlationId?: string;
  causationId?: string;
};

export type CrmAuditMutation = {
  resourceKind: CrmAuditResourceKind;
  resourceId: string;
  action: CrmAuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  securityDescriptor: CrmAuditSecurityDescriptor;
};
