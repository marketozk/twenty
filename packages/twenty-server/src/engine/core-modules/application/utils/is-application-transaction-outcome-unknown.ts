import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';

export const isApplicationTransactionOutcomeUnknown = (
  error: unknown,
): boolean =>
  error instanceof NativeTransactionOutcomeUnknownError ||
  error instanceof OmniCoreTransactionOutcomeUnknownError;
