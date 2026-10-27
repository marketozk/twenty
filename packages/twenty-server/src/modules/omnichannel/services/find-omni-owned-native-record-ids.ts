import { isUUID } from 'class-validator';

const OWNERSHIP_QUERY_BATCH_SIZE = 200;

type OwnershipQuery = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

const findOwnedIds = async (
  query: OwnershipQuery,
  workspaceId: string,
  recordIds: string[],
  kind: 'message' | 'thread',
): Promise<Set<string>> => {
  if (!isUUID(workspaceId) || recordIds.some((id) => !isUUID(id))) {
    throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE');
  }
  // Twenty names physical schemas with the unsigned UUID integer in base 36.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const candidates = [...new Set(recordIds.map((id) => id.toLowerCase()))];
  const ownedIds = new Set<string>();
  const messageOwnership = (messageId: string) => `
    EXISTS (SELECT 1 FROM core."omniMessageLink" link
      WHERE link."workspaceId"=$1 AND link."messageId"=${messageId})
    OR EXISTS (SELECT 1 FROM "${schema}"."messageChannelMessageAssociation" association
      JOIN core."omniAccountBinding" binding
        ON binding."workspaceId"=$1 AND binding."messageChannelId"=association."messageChannelId"
      WHERE association."messageId"=${messageId})`;
  const predicate =
    kind === 'message'
      ? `${messageOwnership('candidate.id')}
       OR EXISTS (SELECT 1 FROM "${schema}"."message" message
         JOIN core."omniConversation" conversation
           ON conversation."workspaceId"=$1 AND conversation."messageThreadId"=message."messageThreadId"
         WHERE message.id=candidate.id)`
      : `EXISTS (SELECT 1 FROM core."omniConversation" conversation
         WHERE conversation."workspaceId"=$1 AND conversation."messageThreadId"=candidate.id)
       OR EXISTS (SELECT 1 FROM "${schema}"."message" message
         WHERE message."messageThreadId"=candidate.id AND (${messageOwnership('message.id')}))`;

  for (
    let offset = 0;
    offset < candidates.length;
    offset += OWNERSHIP_QUERY_BATCH_SIZE
  ) {
    const candidateChunk = candidates.slice(
      offset,
      offset + OWNERSHIP_QUERY_BATCH_SIZE,
    );
    const rows = await query.executeRawQuery(
      `SELECT candidate.id FROM unnest($2::uuid[]) candidate(id) WHERE ${predicate}`,
      [workspaceId, candidateChunk],
    );
    if (!Array.isArray(rows))
      throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_RESULT');
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !candidateChunk.includes(row.id)) {
        throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_RESULT');
      }
      ownedIds.add(row.id);
    }
  }
  return ownedIds;
};

export const findOmniOwnedMessageIds = (
  query: OwnershipQuery,
  workspaceId: string,
  messageIds: string[],
) => findOwnedIds(query, workspaceId, messageIds, 'message');

export const findOmniOwnedMessageThreadIds = (
  query: OwnershipQuery,
  workspaceId: string,
  messageThreadIds: string[],
) => findOwnedIds(query, workspaceId, messageThreadIds, 'thread');
