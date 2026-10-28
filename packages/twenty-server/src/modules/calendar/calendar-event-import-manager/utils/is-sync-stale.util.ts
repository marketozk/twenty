import { CALENDAR_IMPORT_ONGOING_SYNC_TIMEOUT } from 'src/modules/calendar/calendar-event-import-manager/constants/calendar-import-ongoing-sync-timeout.constant';

export const isSyncStale = (syncStageStartedAt?: string | null): boolean => {
  if (syncStageStartedAt === undefined || syncStageStartedAt === null) {
    return true;
  }

  const syncStageStartedTime = new Date(syncStageStartedAt).getTime();

  if (isNaN(syncStageStartedTime)) {
    throw new Error('Invalid date format');
  }

  return (
    Date.now() - syncStageStartedTime > CALENDAR_IMPORT_ONGOING_SYNC_TIMEOUT
  );
};
