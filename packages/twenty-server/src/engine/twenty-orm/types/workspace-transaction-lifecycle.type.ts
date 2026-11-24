import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

// Server-issued metadata. The actor is derived from the authenticated workspace context.
export type NativeCrmAuditOptions = {
  operationId: string;
  correlationId?: string;
  causationId?: string;
  systemActorId?: string;
};

export type NativeCrmAuditBinding = Readonly<{
  operation: CrmAuditOperation;
  impersonatorUserWorkspaceId?: string;
  pendingAuthUserWorkspaceId?: string;
  pendingAgentId?: string;
  pendingUserWorkspaceActor?: boolean;
  pendingUserWorkspaceExpectedUserId?: string;
  ambientCorrelationId?: string;
  ambientCausationId?: string;
}>;

export type WorkspaceTransactionOptions = {
  // Opt-in internal native CRM audit owner; current coverage is Company/Person/Opportunity/Note/Task/Dashboard and custom objects.
  nativeAudit?: NativeCrmAuditOptions;
  // Server-issued WeakSet-verified binding from NavigationMenuItemAuditIdentity for system-context bridges.
  nativeAuditBinding?: NativeCrmAuditBinding;
  commitOutcome?: 'strict' | 'legacy';
  // Coordination only; this does not grant native domain write authority.
  nativeOwnershipLock?: 'shared' | 'exclusive' | 'none';
};

export type WorkspaceTransactionLifecycle = {
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  readonly commitOutcome: 'strict' | 'legacy';
};
