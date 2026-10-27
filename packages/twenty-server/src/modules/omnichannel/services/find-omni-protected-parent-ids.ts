import { isUUID } from 'class-validator';

import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

// Retained core references count even without a native projection or active link.
// Call under the ownership fence; the delete kernel also locks candidate parents.
export const findOmniProtectedParentIds = async (
  query: OmniNativeOwnershipQuery,
  workspaceId: string,
  objectMetadataId: string,
  name: string,
  ids: string[],
): Promise<Set<string>> => {
  if (![workspaceId, objectMetadataId, ...ids].every((id) => isUUID(id)))
    throw new Error('OMNI_INVALID_PARENT_LIFECYCLE_SCOPE');
  const protectedIds = new Set<string>();
  const candidates = [...new Set(ids.map((id) => id.toLowerCase()))];
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const targetColumn =
    name === 'person'
      ? 'targetPersonId'
      : name === 'company'
        ? 'targetCompanyId'
        : name === 'opportunity'
          ? 'targetOpportunityId'
          : null;
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const batch = candidates.slice(offset, offset + 200);
    const retained = await query.executeRawQuery(
      `SELECT "recordId" AS id FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND "objectMetadataId"=$2 AND "recordId"=ANY($3::uuid[])
      ${name === 'person' ? 'UNION SELECT "personId" AS id FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "personId"=ANY($3::uuid[])' : ''}`,
      [workspaceId, objectMetadataId, batch],
    );
    for (const row of retained) {
      if (typeof row.id !== 'string' || !batch.includes(row.id))
        throw new Error('OMNI_INVALID_PARENT_LIFECYCLE_RESULT');
      protectedIds.add(row.id);
    }
    const references: Record<string, unknown>[] = [];
    if (name === 'person' || name === 'messageCampaign') {
      const column = name === 'person' ? 'personId' : 'messageCampaignId';
      references.push(
        ...(await query.executeRawQuery(
          `SELECT "${column}" AS id, "messageId" FROM "${schema}"."messageParticipant" WHERE "${column}"=ANY($1::uuid[]) AND "messageId" IS NOT NULL
        ${name === 'messageCampaign' ? `UNION SELECT "messageCampaignId" AS id, id AS "messageId" FROM "${schema}"."message" WHERE "messageCampaignId"=ANY($1::uuid[])` : ''}`,
          [batch],
        )),
      );
    }
    if (targetColumn)
      references.push(
        ...(await query.executeRawQuery(
          `SELECT "${targetColumn}" AS id, "messageThreadId" FROM "${schema}"."messageThreadTarget" WHERE "${targetColumn}"=ANY($1::uuid[]) AND "messageThreadId" IS NOT NULL`,
          [batch],
        )),
      );
    const messageIds: string[] = [];
    const threadIds: string[] = [];
    for (const row of references) {
      if (typeof row.id !== 'string' || !batch.includes(row.id))
        throw new Error('OMNI_INVALID_PARENT_LIFECYCLE_RESULT');
      if (row.messageId !== undefined) {
        if (typeof row.messageId !== 'string' || !isUUID(row.messageId))
          throw new Error('OMNI_INVALID_PARENT_LIFECYCLE_RESULT');
        messageIds.push(row.messageId);
      }
      if (row.messageThreadId !== undefined) {
        if (
          typeof row.messageThreadId !== 'string' ||
          !isUUID(row.messageThreadId)
        )
          throw new Error('OMNI_INVALID_PARENT_LIFECYCLE_RESULT');
        threadIds.push(row.messageThreadId);
      }
    }
    const ownedMessages = await findOmniOwnedMessageIds(
      query,
      workspaceId,
      messageIds,
    );
    const ownedThreads = await findOmniOwnedMessageThreadIds(
      query,
      workspaceId,
      threadIds,
    );
    for (const row of references)
      if (
        ownedMessages.has(String(row.messageId)) ||
        ownedThreads.has(String(row.messageThreadId))
      )
        protectedIds.add(String(row.id));
  }
  return protectedIds;
};
