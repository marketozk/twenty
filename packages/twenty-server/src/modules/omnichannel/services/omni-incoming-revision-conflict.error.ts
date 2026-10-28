const issuedErrors = new WeakSet<object>();
export const createOmniIncomingRevisionConflict = (): Error => {
  const error = new Error('OMNI_INCOMING_INCONSISTENT_SOURCE');
  issuedErrors.add(error);
  return error;
};
export const isOmniIncomingRevisionConflict = (
  error: unknown,
): error is Error => error instanceof Error && issuedErrors.has(error);
