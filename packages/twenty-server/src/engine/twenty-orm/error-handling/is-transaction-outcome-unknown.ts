import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';

export const isTransactionOutcomeUnknown = (error: unknown): boolean =>
  error instanceof NativeTransactionOutcomeUnknownError ||
  error instanceof OmniCoreTransactionOutcomeUnknownError;

export const isTransactionUnsafeToRetry = (error: unknown): boolean =>
  isTransactionOutcomeUnknown(error) ||
  error instanceof CoreAuditPostCommitError;
