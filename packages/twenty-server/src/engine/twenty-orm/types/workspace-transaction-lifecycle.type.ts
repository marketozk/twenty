// Server-issued metadata. The actor is derived from the authenticated workspace context.
export type NativeCrmAuditOptions = {
  operationId: string;
  correlationId?: string;
  causationId?: string;
  systemActorId?: string;
};

export type WorkspaceTransactionOptions = {
  // Opt-in internal native CRM audit owner; current coverage is Company/Person/Opportunity updates.
  nativeAudit?: NativeCrmAuditOptions;
  commitOutcome?: 'strict' | 'legacy';
  // Coordination only; this does not grant native domain write authority.
  nativeOwnershipLock?: 'shared' | 'exclusive';
};

export type WorkspaceTransactionLifecycle = {
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  readonly commitOutcome: 'strict' | 'legacy';
};
