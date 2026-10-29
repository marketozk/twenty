import {
  snapshotOmniDetachedParentManifest,
  verifyOmniDetachedParent,
  type OmniDetachedParentManifest,
} from 'src/modules/omnichannel/services/verify-omni-detached-parent';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import {
  type NativeCrmAuditObjectMetadata,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';

type NativeCleanupMetadata = {
  authType: string;
  authWorkspaceId: string;
  memberObjectId: string | undefined;
  objects: {
    metadata: NativeCrmAuditObjectMetadata;
    shape: NativeCrmAuditTableShape;
  }[];
};

type Transaction = {
  workspaceId: string;
  executor: object;
  lifecycle: WorkspaceTransactionLifecycle;
  nativeOwnershipLock: 'shared' | 'exclusive';
  nativeCleanupMetadata?: () => NativeCleanupMetadata;
};

// Internal issuance, not a permission option: a caller-created scope, a copied
// repository or shouldBypassPermissionChecks cannot confer domain write authority.
const scopes = new WeakMap<object, Transaction>();
const executors = new WeakMap<object, Transaction>();
const repositories = new WeakMap<object, Transaction>();
const grants = new WeakMap<object, Transaction>();
const parentDeletes = new WeakMap<
  object,
  { transaction: Transaction; manifest: OmniDetachedParentManifest }
>();

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

export const getIssuedNativeCleanupMetadata = (
  scope: object,
): NativeCleanupMetadata => {
  assertIssuedOmniNativeScope(scope);
  const metadata = scopes.get(scope)?.nativeCleanupMetadata;
  if (!metadata) throw new Error('OMNI_NATIVE_CLEANUP_METADATA_REQUIRED');
  return metadata();
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

export const withOmniDetachedParentDelete = async <T>(
  scope: OmniNativeOwnershipQuery,
  repository: unknown,
  input: OmniDetachedParentManifest,
  work: () => Promise<T>,
): Promise<T> => {
  const manifest = snapshotOmniDetachedParentManifest(input);
  if (typeof work !== 'function')
    throw new Error('OMNI_PARENT_DELETE_CALLBACK_REQUIRED');
  assertIssuedOmniNativeScope(scope);
  const transaction = assertActive(scopes.get(scope));
  if (
    typeof repository !== 'object' ||
    repository === null ||
    repositories.get(repository) !== transaction ||
    transaction.workspaceId !== manifest.workspaceId
  )
    throw new Error('OMNI_FOREIGN_PARENT_DELETE_SCOPE');
  if (parentDeletes.has(repository))
    throw new Error('OMNI_PARENT_DELETE_ALREADY_GRANTED');
  // Hold policy before the repository acquires parent rows; never upgrade after DELETE selection.
  const states = await scope.executeRawQuery(
    'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
    [manifest.workspaceId],
  );
  if (states.length !== 1)
    throw new Error('OMNI_PARENT_DELETE_POLICY_REQUIRED');
  await verifyOmniDetachedParent(scope, manifest);
  parentDeletes.set(repository, { transaction, manifest });
  try {
    return await work();
  } finally {
    parentDeletes.delete(repository);
  }
};

export const getOmniDetachedParentDelete = (
  repository: object,
): OmniDetachedParentManifest | null => {
  const grant = parentDeletes.get(repository);
  if (!grant) return null;
  assertActive(grant.transaction);
  if (repositories.get(repository) !== grant.transaction)
    throw new Error('OMNI_FOREIGN_PARENT_DELETE_SCOPE');
  return grant.manifest;
};
