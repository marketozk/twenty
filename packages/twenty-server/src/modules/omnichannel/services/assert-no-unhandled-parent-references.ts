import { hasReferencingRecords } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

export const assertNoUnhandledParentReferences = async (
  scope: OmniNativeOwnershipQuery,
  schemaName: string,
  tableName: 'person' | 'company',
  recordId: string,
): Promise<void> => {
  if (await hasReferencingRecords(scope, schemaName, tableName, [recordId]))
    throw new Error('OMNI_PARENT_UNHANDLED_FOREIGN_REFERENCE');
};
