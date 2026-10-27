export type WorkspaceTransactionOptions = {
  commitOutcome?: 'strict' | 'legacy';
  // Coordination only; this does not grant native domain write authority.
  nativeOwnershipLock?: 'shared' | 'exclusive';
};

export type WorkspaceTransactionLifecycle = {
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  readonly commitOutcome: 'strict' | 'legacy';
};
