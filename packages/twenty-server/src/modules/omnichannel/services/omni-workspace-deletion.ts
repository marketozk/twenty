import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';

import {
  withOmniNativeOwnershipTransaction,
  OmniCoreTransactionOutcomeUnknownError,
} from 'src/modules/omnichannel/services/omni-core-transaction';

export class OmniWorkspaceLifecycleOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('OMNI_WORKSPACE_LIFECYCLE_OUTCOME_UNKNOWN', { cause });
    this.name = 'OmniWorkspaceLifecycleOutcomeUnknownError';
  }
}

const assertWorkspaceUnowned = async (
  runner: QueryRunner,
  workspaceId: string,
) => {
  const tables: { name: string }[] = await runner.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspaceId' AND NOT a.attisdropped
    WHERE n.nspname='core' AND c.relkind IN ('r','p') AND c.relname LIKE 'omni%'
    ORDER BY c.relname`);
  if (
    !tables.some((row) => row.name === 'omniAccountBinding') ||
    !tables.some((row) => row.name === 'omniWorkspacePolicyState')
  )
    throw new Error('OMNI_WORKSPACE_RETENTION_SCHEMA_MISSING');
  for (const { name } of tables) {
    if (!/^omni[A-Za-z0-9]+$/.test(name))
      throw new Error('OMNI_INVALID_WORKSPACE_RETENTION_TABLE');
    const rows: { retained: boolean }[] = await runner.query(
      `SELECT EXISTS (SELECT 1 FROM core."${name}" WHERE "workspaceId"=$1) AS retained`,
      [workspaceId],
    );
    if (rows.length !== 1 || typeof rows[0].retained !== 'boolean')
      throw new Error('OMNI_INVALID_WORKSPACE_RETENTION_RESULT');
    if (rows[0].retained)
      throw new Error('OMNI_WORKSPACE_DELETE_REQUIRES_CONTROLLED_PURGE');
  }
};

const withLifecycleTransaction = async <TResult>(
  dataSource: DataSource,
  workspaceId: string,
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (!isUUID(workspaceId))
    throw new Error('OMNI_INVALID_WORKSPACE_LIFECYCLE_SCOPE');
  try {
    return await withOmniNativeOwnershipTransaction(
      dataSource,
      workspaceId,
      'exclusive',
      work,
    );
  } catch (error) {
    if (error instanceof OmniCoreTransactionOutcomeUnknownError)
      throw new OmniWorkspaceLifecycleOutcomeUnknownError(error.cause);
    throw error;
  }
};

// The durable tombstone survives later billing/uninstall failures. Do not clear it
// automatically: bootstrap eligibility and uninstall-token identity depend on it.
export const admitOmniWorkspaceDeletion = (
  dataSource: DataSource,
  workspaceId: string,
): Promise<Date> =>
  withLifecycleTransaction(dataSource, workspaceId, async (runner) => {
    const rows: { id: string }[] = await runner.query(
      'SELECT id FROM core.workspace WHERE id=$1 FOR UPDATE',
      [workspaceId],
    );
    if (rows.length !== 1) throw new Error('OMNI_WORKSPACE_NOT_FOUND');
    await assertWorkspaceUnowned(runner, workspaceId);
    const [updated, affected]: [{ deletedAt: Date }[], number] =
      await runner.query(
        'UPDATE core.workspace SET "deletedAt"=COALESCE("deletedAt",clock_timestamp()) WHERE id=$1 RETURNING "deletedAt"',
        [workspaceId],
      );
    if (
      affected !== 1 ||
      updated.length !== 1 ||
      !(updated[0].deletedAt instanceof Date) ||
      !Number.isFinite(updated[0].deletedAt.getTime())
    )
      throw new Error('OMNI_INVALID_WORKSPACE_TOMBSTONE');
    return updated[0].deletedAt;
  });

export const assertOmniWorkspaceAcceptsBootstrap = async (
  runner: QueryRunner,
  workspaceId: string,
): Promise<void> => {
  if (!isUUID(workspaceId) || !runner.isTransactionActive)
    throw new Error('OMNI_INVALID_WORKSPACE_BOOTSTRAP_SCOPE');
  const rows: { deletedAt: Date | null }[] = await runner.query(
    'SELECT "deletedAt" FROM core.workspace WHERE id=$1 FOR SHARE',
    [workspaceId],
  );
  if (rows.length !== 1 || rows[0].deletedAt !== null)
    throw new Error('OMNI_WORKSPACE_NOT_ACCEPTING_BINDINGS');
};

export const dropOmniUnownedWorkspaceSchema = (
  dataSource: DataSource,
  workspaceId: string,
): Promise<void> =>
  withLifecycleTransaction(dataSource, workspaceId, async (runner) => {
    const rows: { deletedAt: Date | null }[] = await runner.query(
      'SELECT "deletedAt" FROM core.workspace WHERE id=$1 FOR UPDATE',
      [workspaceId],
    );
    if (rows.length !== 1 || rows[0].deletedAt === null)
      throw new Error('OMNI_WORKSPACE_DELETION_NOT_ADMITTED');
    await assertWorkspaceUnowned(runner, workspaceId);
    const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
    await runner.dropSchema(schema, true, true);
  });
