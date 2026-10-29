import {
  lockOrdinaryMetadataActionChannel,
  METADATA_ACTION_TIMESTAMP_SQL,
  isMetadataActionTimestamp,
  type MetadataActionQuery,
} from 'src/modules/omnichannel/services/lock-ordinary-metadata-action-channel';
export type OrdinaryGroupEmailAction = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
  action: 'GROUP_EMAILS_IMPORT' | 'GROUP_EMAILS_DELETION';
  excludeGroupEmails: boolean;
  updatedAt: string;
};

// Call only inside a transaction holding the shared native-ownership fence.
export const lockCurrentGroupEmailAction = async (
  query: MetadataActionQuery,
  expected: OrdinaryGroupEmailAction,
): Promise<boolean> => {
  if (
    !['GROUP_EMAILS_IMPORT', 'GROUP_EMAILS_DELETION'].includes(
      expected.action,
    ) ||
    expected.excludeGroupEmails !==
      (expected.action === 'GROUP_EMAILS_DELETION') ||
    !isMetadataActionTimestamp(expected.updatedAt)
  )
    throw new Error('OMNI_INVALID_GROUP_ACTION_SCOPE');
  const channel = await lockOrdinaryMetadataActionChannel(query, expected);
  return (
    channel !== null &&
    channel.pendingGroupEmailsAction === expected.action &&
    channel.excludeGroupEmails === expected.excludeGroupEmails &&
    channel.version === expected.updatedAt
  );
};
