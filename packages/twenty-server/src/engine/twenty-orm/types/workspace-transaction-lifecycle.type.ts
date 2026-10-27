export type WorkspaceTransactionOptions = {
  commitOutcome?: 'strict' | 'legacy';
};

export type WorkspaceTransactionLifecycle = {
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  readonly commitOutcome: 'strict' | 'legacy';
};
