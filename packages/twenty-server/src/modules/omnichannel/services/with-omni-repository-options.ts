import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import {
  assertIssuedOmniNativeScope,
  grantOmniNativeRepositoryWrite,
} from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { OMNI_NATIVE_REPOSITORIES } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';

type OmniRepositoryScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  getRepository: (
    name: string,
    permissions?: RolePermissionConfig,
    options?: { shouldSkipEventEmission?: boolean },
  ) => unknown;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
  afterCommit: (callback: () => void | Promise<void>) => void;
};

export const withOmniRepositoryOptions = <TScope extends OmniRepositoryScope>(
  scope: TScope,
): TScope => {
  const lifecycle = scope.transactionLifecycle;

  if (!lifecycle || lifecycle.commitOutcome !== 'strict') {
    throw new Error('Omnichannel requires a strict workspace transaction');
  }

  const assertActive = () => {
    if (!lifecycle.isTransactionActive || lifecycle.isReleased) {
      throw new Error('Omnichannel requires an active workspace transaction');
    }
  };

  assertActive();
  assertIssuedOmniNativeScope(scope);

  return Object.freeze({
    ...scope,
    transactionLifecycle: lifecycle,
    getRepository: (
      name: string,
      permissions?: RolePermissionConfig,
      options?: { shouldSkipEventEmission?: boolean },
    ) => {
      assertActive();

      const repository = scope.getRepository(
        name,
        permissions,
        OMNI_NATIVE_REPOSITORIES.has(name)
          ? { ...options, shouldSkipEventEmission: true }
          : options,
      );
      if (OMNI_NATIVE_REPOSITORIES.has(name))
        grantOmniNativeRepositoryWrite(scope, repository);
      return repository;
    },
    executeRawQuery: (sql: string, parameters?: unknown[]) => {
      assertActive();

      return scope.executeRawQuery(sql, parameters);
    },
    afterCommit: (callback: () => void | Promise<void>): void => {
      assertActive();
      scope.afterCommit(callback);
    },
  });
};
