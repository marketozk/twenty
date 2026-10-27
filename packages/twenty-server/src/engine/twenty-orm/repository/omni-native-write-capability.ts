import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

type Transaction = {
  workspaceId: string;
  executor: object;
  lifecycle: WorkspaceTransactionLifecycle;
  nativeOwnershipLock: 'shared' | 'exclusive';
};

// Internal issuance, not a permission option: a caller-created scope, a copied
// repository or shouldBypassPermissionChecks cannot confer domain write authority.
const scopes = new WeakMap<object, Transaction>();
const executors = new WeakMap<object, Transaction>();
const repositories = new WeakMap<object, Transaction>();
const grants = new WeakMap<object, Transaction>();

export const registerOmniWorkspaceTransaction = (
  scope: object,
  transaction: Transaction,
): void => {
  const issued = Object.freeze({ ...transaction });
  scopes.set(scope, issued);
  executors.set(transaction.executor, issued);
};

export const registerOmniWorkspaceRepository = (
  repository: object,
  executor: object,
  workspaceId: string,
): void => {
  const transaction = executors.get(executor);
  if (transaction?.workspaceId === workspaceId)
    repositories.set(repository, transaction);
};

const assertActive = (transaction: Transaction | undefined): Transaction => {
  if (
    !transaction ||
    transaction.lifecycle.commitOutcome !== 'strict' ||
    transaction.nativeOwnershipLock !== 'exclusive'
  )
    throw new Error('OMNI_UNISSUED_NATIVE_WRITE_SCOPE');
  if (
    !transaction.lifecycle.isTransactionActive ||
    transaction.lifecycle.isReleased
  )
    throw new Error('OMNI_INACTIVE_NATIVE_WRITE_SCOPE');
  return transaction;
};

export const assertIssuedOmniNativeScope = (scope: object): void => {
  const transaction = assertActive(scopes.get(scope));
  if (
    Reflect.get(scope, 'workspaceId') !== transaction.workspaceId ||
    Reflect.get(scope, 'transactionLifecycle') !== transaction.lifecycle
  )
    throw new Error('OMNI_ALTERED_NATIVE_WRITE_SCOPE');
};

export const grantOmniNativeRepositoryWrite = (
  scope: object,
  repository: unknown,
): void => {
  assertIssuedOmniNativeScope(scope);
  const transaction = assertActive(scopes.get(scope));
  if (
    typeof repository !== 'object' ||
    repository === null ||
    repositories.get(repository) !== transaction
  )
    throw new Error('OMNI_FOREIGN_NATIVE_WRITE_REPOSITORY');
  grants.set(repository, transaction);
};

export const hasOmniNativeRepositoryWrite = (repository: object): boolean => {
  const transaction = grants.get(repository);
  if (!transaction) return false;
  assertActive(transaction);
  return true;
};
