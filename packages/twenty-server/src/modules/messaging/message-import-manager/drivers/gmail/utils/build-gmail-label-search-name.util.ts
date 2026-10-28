import { type MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';

const MAXIMUM_GMAIL_FOLDER_DEPTH = 50;

type FolderInput = Pick<
  MessageFolderEntity,
  'externalId' | 'name' | 'parentFolderId'
>;

export const buildGmailLabelSearchName = (
  folder: FolderInput,
  allFolders: FolderInput[],
  requireCompleteHierarchy = false,
): string | null => {
  if (!folder.name || (requireCompleteHierarchy && !folder.name.trim())) {
    return null;
  }

  const folderMap = new Map(
    allFolders
      .filter((folder) => folder.externalId)
      .map((folder) => [folder.externalId, folder]),
  );

  const pathParts: string[] = [];
  let current: FolderInput | undefined = folder;
  let depth = 0;

  while (current?.name && depth < MAXIMUM_GMAIL_FOLDER_DEPTH) {
    pathParts.unshift(current.name);
    const parentId: string | null = current.parentFolderId;
    current = parentId ? folderMap.get(parentId) : undefined;
    if (requireCompleteHierarchy && parentId && !current?.name?.trim())
      return null;
    depth++;
  }

  if (depth >= MAXIMUM_GMAIL_FOLDER_DEPTH) {
    return null;
  }

  return pathParts
    .join('/')
    .replace(/[\s/]+/g, '-')
    .toLowerCase();
};
