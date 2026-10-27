import { isUUID } from 'class-validator';

const OWNERSHIP_QUERY_BATCH_SIZE = 200;

type MetadataOwnershipQuery = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

const findOwnedMetadataIds = async (
  query: MetadataOwnershipQuery,
  workspaceId: string,
  recordIds: readonly string[],
  kind: 'channel' | 'account' | 'folder',
): Promise<Set<string>> => {
  if (
    !isUUID(workspaceId) ||
    !Array.isArray(recordIds) ||
    recordIds.some((id) => !isUUID(id)) ||
    typeof query?.executeRawQuery !== 'function'
  ) {
    throw new Error('OMNI_INVALID_METADATA_OWNERSHIP_SCOPE');
  }
  const executeRawQuery = query.executeRawQuery.bind(query);
  const canonicalWorkspaceId = workspaceId.toLowerCase();
  const candidates = [...new Set(recordIds.map((id) => id.toLowerCase()))];
  // Match Twenty's physical schema naming without importing its metadata dependency graph.
  const schema = `workspace_${BigInt(`0x${canonicalWorkspaceId.replaceAll('-', '')}`).toString(36)}`;
  const messageOwnership = (messageId: string) => `
    EXISTS (SELECT 1 FROM core."omniMessageLink" link
      WHERE link."workspaceId"=$1 AND link."messageId"=${messageId})
    OR EXISTS (SELECT 1 FROM "${schema}"."message" message
      JOIN core."omniConversation" conversation
        ON conversation."workspaceId"=$1 AND conversation."messageThreadId"=message."messageThreadId"
      WHERE message.id=${messageId})
    OR EXISTS (SELECT 1 FROM "${schema}"."messageChannelMessageAssociation" bound_association
      JOIN core."omniAccountBinding" message_binding
        ON message_binding."workspaceId"=$1 AND message_binding."messageChannelId"=bound_association."messageChannelId"
      WHERE bound_association."messageId"=${messageId})`;
  const channelOwnership = (channelId: string) => `
    EXISTS (SELECT 1 FROM core."omniAccountBinding" channel_binding
      WHERE channel_binding."workspaceId"=$1 AND channel_binding."messageChannelId"=${channelId})
    OR EXISTS (SELECT 1 FROM "${schema}"."messageChannelMessageAssociation" channel_association
      WHERE channel_association."messageChannelId"=${channelId}
        AND (${messageOwnership('channel_association."messageId"')}))`;
  const scopedChannelOwnership = (channelId: string) => `
    EXISTS (SELECT 1 FROM core."messageChannel" channel
      WHERE channel."workspaceId"=$1 AND channel.id=${channelId} AND (${channelOwnership('channel.id')}))`;
  const predicate =
    kind === 'channel'
      ? scopedChannelOwnership('candidate.id')
      : kind === 'account'
        ? `
      EXISTS (SELECT 1 FROM core."omniAccountBinding" account_binding
        WHERE account_binding."workspaceId"=$1 AND account_binding."connectedAccountId"=candidate.id)
      OR EXISTS (SELECT 1 FROM core."messageChannel" channel
        WHERE channel."workspaceId"=$1 AND channel."connectedAccountId"=candidate.id AND (${channelOwnership('channel.id')}))`
        : `EXISTS (SELECT 1 FROM core."messageFolder" folder
        WHERE folder."workspaceId"=$1 AND folder.id=candidate.id AND (
          EXISTS (SELECT 1 FROM core."omniAccountBinding" folder_binding
            WHERE folder_binding."workspaceId"=$1 AND folder_binding."messageChannelId"=folder."messageChannelId")
          OR EXISTS (SELECT 1 FROM "${schema}"."messageChannelMessageAssociationMessageFolder" junction
            JOIN "${schema}"."messageChannelMessageAssociation" folder_association
              ON folder_association.id=junction."messageChannelMessageAssociationId"
            WHERE junction."messageFolderId"=folder.id AND (${messageOwnership('folder_association."messageId"')}))))`;
  const ownedIds = new Set<string>();
  for (
    let offset = 0;
    offset < candidates.length;
    offset += OWNERSHIP_QUERY_BATCH_SIZE
  ) {
    const candidateChunk = candidates.slice(
      offset,
      offset + OWNERSHIP_QUERY_BATCH_SIZE,
    );
    const rows = await executeRawQuery(
      `SELECT candidate.id FROM unnest($2::uuid[]) candidate(id) WHERE ${predicate}`,
      [canonicalWorkspaceId, candidateChunk],
    );
    if (!Array.isArray(rows))
      throw new Error('OMNI_INVALID_METADATA_OWNERSHIP_RESULT');
    for (const row of rows) {
      if (
        typeof row?.id !== 'string' ||
        !candidateChunk.includes(row.id) ||
        ownedIds.has(row.id)
      ) {
        throw new Error('OMNI_INVALID_METADATA_OWNERSHIP_RESULT');
      }
      ownedIds.add(row.id);
    }
  }
  return ownedIds;
};

export const findOmniOwnedMessageChannelIds = (
  query: MetadataOwnershipQuery,
  workspaceId: string,
  ids: readonly string[],
) => findOwnedMetadataIds(query, workspaceId, ids, 'channel');
export const findOmniOwnedConnectedAccountIds = (
  query: MetadataOwnershipQuery,
  workspaceId: string,
  ids: readonly string[],
) => findOwnedMetadataIds(query, workspaceId, ids, 'account');
export const findOmniOwnedMessageFolderIds = (
  query: MetadataOwnershipQuery,
  workspaceId: string,
  ids: readonly string[],
) => findOwnedMetadataIds(query, workspaceId, ids, 'folder');
