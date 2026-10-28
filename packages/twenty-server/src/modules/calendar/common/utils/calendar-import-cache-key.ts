import { isUUID } from 'class-validator';

export const calendarImportCacheKey = (scope: {
  workspaceId: string;
  calendarChannelId: string;
  connectedAccountId: string;
}): string => {
  const ids = [
    scope.workspaceId,
    scope.calendarChannelId,
    scope.connectedAccountId,
  ];
  if (!ids.every((id) => typeof id === 'string' && isUUID(id)))
    throw new Error('INVALID_CALENDAR_IMPORT_CACHE_SCOPE');
  return `calendar-events-to-import:v2:${ids.map((id) => id.toLowerCase()).join(':')}`;
};

// Unknown-origin backlog is refetched from the provider, never adopted by a new account.
export const legacyCalendarImportCacheKey = (
  workspaceId: string,
  calendarChannelId: string,
): string => {
  if (
    ![workspaceId, calendarChannelId].every(
      (id) => typeof id === 'string' && isUUID(id),
    )
  )
    throw new Error('INVALID_CALENDAR_IMPORT_CACHE_SCOPE');
  return `calendar-events-to-import:${workspaceId.toLowerCase()}:${calendarChannelId.toLowerCase()}`;
};
