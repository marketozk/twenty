import { type ObjectLiteral } from 'typeorm';

import { type ObjectRecord } from 'twenty-shared/types';

import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config.type';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

export type {
  WorkspaceTransactionOptions,
  WorkspaceTransactionLifecycle,
} from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

export type WorkspaceTransactionScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  getRepository: <T extends ObjectLiteral = ObjectRecord>(
    objectMetadataName: string,
    rolePermissionConfig?: RolePermissionConfig,
    repositoryOptions?: { shouldSkipEventEmission?: boolean },
  ) => WorkspaceRepository<T>;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
  afterCommit: (callback: () => void | Promise<void>) => void;
};
