import { randomUUID } from 'node:crypto';
import { FieldMetadataType } from 'twenty-shared/types';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';

export const addCustomCrmMetadata = ({
  flatObjectMetadataMaps,
  flatFieldMetadataMaps,
}: Pick<
  WorkspaceInternalContext,
  'flatObjectMetadataMaps' | 'flatFieldMetadataMaps'
>) => {
  const company = Object.values(
    flatObjectMetadataMaps.byUniversalIdentifier,
  ).find((object) => object?.nameSingular === 'company')!;
  const person = Object.values(
    flatObjectMetadataMaps.byUniversalIdentifier,
  ).find((object) => object?.nameSingular === 'person')!;
  const applicationId = randomUUID(),
    applicationUniversalIdentifier = randomUUID();
  const custom = {
    ...company,
    id: randomUUID(),
    universalIdentifier: randomUUID(),
    applicationId,
    applicationUniversalIdentifier,
    nameSingular: 'customCase',
    namePlural: 'customCases',
    labelSingular: 'Case',
    labelPlural: 'Cases',
    targetTableName: '_customCase',
    isRemote: false,
    isSystem: false,
    fieldIds: [],
    fieldUniversalIdentifiers: [],
    indexMetadataIds: [],
    indexMetadataUniversalIdentifiers: [],
    labelIdentifierFieldMetadataId: null,
    labelIdentifierFieldMetadataUniversalIdentifier: null,
    imageIdentifierFieldMetadataId: null,
    imageIdentifierFieldMetadataUniversalIdentifier: null,
  };
  flatObjectMetadataMaps.byUniversalIdentifier[custom.universalIdentifier] =
    custom;
  flatObjectMetadataMaps.universalIdentifierById[custom.id] =
    custom.universalIdentifier;
  const sourceFields = Object.values(
    flatFieldMetadataMaps.byUniversalIdentifier,
  ).filter(
    (field) =>
      field?.objectMetadataId === company.id &&
      [
        'id',
        'name',
        'position',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'createdBy',
        'updatedBy',
      ].includes(field.name),
  );
  for (const source of sourceFields) {
    const field = {
      ...source!,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      applicationId,
      objectMetadataId: custom.id,
    };
    flatFieldMetadataMaps.byUniversalIdentifier[field.universalIdentifier] =
      field;
    flatFieldMetadataMaps.universalIdentifierById[field.id] =
      field.universalIdentifier;
  }
  const relation = Object.values(
    flatFieldMetadataMaps.byUniversalIdentifier,
  ).find(
    (field) =>
      field?.objectMetadataId === person.id && field.name === 'company',
  )!;
  for (const [parent, target, name, inverseName] of [
    [company, custom, 'case', 'companies'],
    [custom, company, 'company', 'cases'],
  ] as const) {
    const field = {
      ...relation,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      objectMetadataId: parent.id,
      applicationId,
      name,
      label: name,
      type: FieldMetadataType.RELATION,
      relationTargetObjectMetadataId: target.id,
      relationTargetFieldMetadataId: null,
      settings: {
        ...relation.settings,
        relationType: 'MANY_TO_ONE',
        joinColumnName: name + 'Id',
      },
    } as typeof relation;
    const inverse = {
      ...field,
      id: randomUUID(),
      universalIdentifier: randomUUID(),
      objectMetadataId: target.id,
      name: inverseName,
      label: inverseName,
      relationTargetObjectMetadataId: parent.id,
      relationTargetFieldMetadataId: field.id,
      settings: { ...relation.settings, relationType: 'ONE_TO_MANY' },
    } as typeof relation;
    field.relationTargetFieldMetadataId = inverse.id;
    flatFieldMetadataMaps.byUniversalIdentifier[field.universalIdentifier] =
      field;
    flatFieldMetadataMaps.universalIdentifierById[field.id] =
      field.universalIdentifier;
    flatFieldMetadataMaps.byUniversalIdentifier[inverse.universalIdentifier] =
      inverse;
    flatFieldMetadataMaps.universalIdentifierById[inverse.id] =
      inverse.universalIdentifier;
  }
};
