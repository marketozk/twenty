export class NativeTransactionOutcomeUnknownError extends Error {
  constructor(
    readonly phase: 'commit' | 'rollback' | 'release',
    cause: unknown,
  ) {
    super(`Native transaction outcome is unknown after ${phase}`, { cause });
    this.name = 'NativeTransactionOutcomeUnknownError';
  }
}
