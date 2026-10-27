import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

type AuditWorkspaceScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

export type CrmAuditTransactionExecutor = {
  readonly workspaceId?: string;
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  query: (sql: string, parameters?: unknown[]) => Promise<unknown[]>;
};

export const createCrmAuditWorkspaceExecutor = (
  scope: AuditWorkspaceScope,
): CrmAuditTransactionExecutor => {
  const lifecycle = scope.transactionLifecycle;

  if (!lifecycle || lifecycle.commitOutcome !== 'strict') {
    throw new Error('Audit requires a strict workspace transaction lifecycle');
  }

  const assertActive = () => {
    if (!lifecycle.isTransactionActive || lifecycle.isReleased) {
      throw new Error('Audit requires an active transaction');
    }
  };

  assertActive();

  return Object.freeze({
    workspaceId: scope.workspaceId,
    get isTransactionActive() {
      return lifecycle.isTransactionActive;
    },
    get isReleased() {
      return lifecycle.isReleased;
    },
    query: async (sql: string, parameters?: unknown[]) => {
      assertActive();

      return scope.executeRawQuery(sql, parameters);
    },
  });
};
