import { isUUID } from 'class-validator';

export type MessageImportCacheScope = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
};

export const messageImportCacheKeys = (scope: MessageImportCacheScope) => {
  const ids = [
    scope.workspaceId,
    scope.messageChannelId,
    scope.connectedAccountId,
  ];
  if (!ids.every((id) => typeof id === 'string' && isUUID(id)))
    throw new Error('INVALID_MESSAGE_IMPORT_CACHE_SCOPE');
  const suffix = ids.map((id) => id.toLowerCase()).join(':');
  return {
    pending: `messages-to-import:v2:${suffix}`,
    total: `messages-to-import-total:v2:${suffix}`,
    imported: `messages-imported:v2:${suffix}`,
  };
};

// Old queued cleanup jobs may remove only their old, unprovenanced namespace.
// Never adopt its contents as belonging to the current connected account.
export const legacyMessageImportCacheKeys = (
  workspaceId: string,
  messageChannelId: string,
) => {
  if (
    ![workspaceId, messageChannelId].every(
      (id) => typeof id === 'string' && isUUID(id),
    )
  )
    throw new Error('INVALID_MESSAGE_IMPORT_CACHE_SCOPE');
  return {
    pending: `messages-to-import:${workspaceId.toLowerCase()}:${messageChannelId.toLowerCase()}`,
    total: `messages-to-import-total:${workspaceId.toLowerCase()}:${messageChannelId.toLowerCase()}`,
    imported: `messages-imported:${workspaceId.toLowerCase()}:${messageChannelId.toLowerCase()}`,
  };
};
