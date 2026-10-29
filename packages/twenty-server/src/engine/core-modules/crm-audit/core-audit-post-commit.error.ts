export class CoreAuditPostCommitError extends Error {
  readonly commitConfirmed = true;
  constructor(cause: unknown) {
    super('Core audit transaction committed but its postcommit hook failed', {
      cause,
    });
    this.name = 'CoreAuditPostCommitError';
  }
}
