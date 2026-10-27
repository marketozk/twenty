const issuedErrors = new WeakSet<object>();

export class OmniHistoryMissingConfigurationError extends Error {
  constructor() {
    super('OMNI_HISTORY_CONFIGURATION_MISSING');
    this.name = 'OmniHistoryMissingConfigurationError';
  }
}

export const createOmniHistoryMissingConfigurationError = () => {
  const error = new OmniHistoryMissingConfigurationError();

  issuedErrors.add(error);

  return error;
};

export const isOmniHistoryMissingConfigurationError = (
  error: unknown,
): error is OmniHistoryMissingConfigurationError =>
  error instanceof OmniHistoryMissingConfigurationError &&
  issuedErrors.has(error);
