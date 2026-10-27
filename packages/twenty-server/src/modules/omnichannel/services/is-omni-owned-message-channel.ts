type OmniOwnershipQuery = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

export const isOmniOwnedMessageChannel = async (
  query: OmniOwnershipQuery,
  workspaceId: string,
  messageChannelId: string,
): Promise<boolean> => {
  const rows = await query.executeRawQuery(
    `SELECT EXISTS (
       SELECT 1 FROM core."omniAccountBinding"
       WHERE "workspaceId"=$1 AND "messageChannelId"=$2
     ) AS owned`,
    [workspaceId, messageChannelId],
  );

  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0]?.owned !== 'boolean'
  ) {
    throw new Error('OMNI_INVALID_CHANNEL_OWNERSHIP_RESULT');
  }

  return rows[0].owned;
};
