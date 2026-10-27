export type CrmAuditPrincipal = {
  kind: 'workspaceMember' | 'system' | 'agent' | 'workflow' | 'application';
  id: string;
};

export type CrmAuditResourceKind =
  | 'omniAccountBinding'
  | 'omniIncomingReceipt'
  | 'omniMessage'
  | 'omniAutomationPolicy'
  | 'omniAutomationPolicyVersion'
  | 'omniWorkspacePolicyState'
  | 'omniQueue';

export type CrmAuditAction = 'create' | 'update' | 'delete';

export type CrmAuditSecurityDescriptor = {
  resourceKind: CrmAuditResourceKind;
  resourceId: string;
  bindingId?: string;
  conversationId?: string;
  queueId?: string;
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
