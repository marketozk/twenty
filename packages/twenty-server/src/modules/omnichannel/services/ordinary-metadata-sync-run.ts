import { type EntityManager } from 'typeorm';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export type OrdinaryMetadataSyncRun = Readonly<{
  workspaceId: string;
  channelId: string;
  connectedAccountId: string;
  kind: 'message' | 'calendar';
  stage: string;
  startedAt: string;
}>;

export const beginOrdinaryMetadataSyncRun = async <T>(
  manager: EntityManager,
  workspaceId: string,
  channelId: string,
  connectedAccountId: string,
  kind: 'message' | 'calendar',
  stages: { scheduled: string; ongoing: string; syncStatus: string },
  load: (
    transaction: EntityManager,
    run: OrdinaryMetadataSyncRun,
  ) => Promise<T>,
): Promise<T | null> => {
  const { scheduled, ongoing, syncStatus } = stages;
  const table = kind === 'message' ? 'messageChannel' : 'calendarChannel';
  return withOrdinaryMetadataChannels(
    manager,
    workspaceId,
    [channelId],
    kind,
    async (transaction, channels) => {
      if (!channels.length) return null;
      const rows: { startedAt: string }[] = await transaction.query(
        `WITH started AS (UPDATE core."${table}" SET "syncStage"=$3,"syncStatus"=$4,
          "syncStageStartedAt"=greatest(clock_timestamp(),"syncStageStartedAt"+interval '1 microsecond'),"updatedAt"=now()
          WHERE "workspaceId"=$1 AND id=$2 AND "isSyncEnabled"=true AND "syncStage"=$5
          RETURNING "syncStageStartedAt")
         SELECT to_char("syncStageStartedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt" FROM started`,
        [workspaceId, channelId, ongoing, syncStatus, scheduled],
      );
      if (!rows.length) return null;
      return load(
        transaction,
        Object.freeze({
          workspaceId,
          channelId,
          connectedAccountId,
          kind,
          stage: ongoing,
          startedAt: rows[0].startedAt,
        }),
      );
    },
    'read',
    connectedAccountId,
  );
};

// Call only under the existing channel lock, in the transaction applying results.
export const matchesOrdinaryMetadataSyncRun = async (
  manager: EntityManager,
  workspaceId: string,
  channelId: string,
  kind: 'message' | 'calendar',
  run: OrdinaryMetadataSyncRun,
): Promise<boolean> => {
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('OMNI_SYNC_RUN_REQUIRES_TRANSACTION');
  if (
    run.workspaceId !== workspaceId ||
    run.channelId !== channelId ||
    run.kind !== kind
  )
    return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(run.startedAt))
    throw new Error('OMNI_INVALID_SYNC_RUN_TOKEN');
  const table = kind === 'message' ? 'messageChannel' : 'calendarChannel';
  const rows: { id: string }[] = await manager.query(
    `SELECT id FROM core."${table}" WHERE "workspaceId"=$1 AND id=$2 AND "connectedAccountId"=$3
       AND "isSyncEnabled"=true AND "syncStage"=$4 AND "syncStageStartedAt"=$5::timestamptz`,
    [workspaceId, channelId, run.connectedAccountId, run.stage, run.startedAt],
  );
  return rows.length === 1;
};
