import { msg } from '@lingui/core/macro';
import {
  extractAndSanitizeObjectStringFields,
  isDefined,
  trimAndRemoveDuplicatedWhitespacesFromObjectStringProperties,
} from 'twenty-shared/utils';
import { v4 } from 'uuid';

import {
  AiException,
  AiExceptionCode,
} from 'src/engine/metadata-modules/ai/ai.exception';
import { type UpdateAgentInput } from 'src/engine/metadata-modules/ai/ai-agent/dtos/update-agent.input';
import { FLAT_AGENT_EDITABLE_PROPERTIES } from 'src/engine/metadata-modules/flat-agent/constants/flat-agent-editable-properties.constant';
import { type FlatAgentMaps } from 'src/engine/metadata-modules/flat-agent/types/flat-agent-maps.type';
import { type FlatAgent } from 'src/engine/metadata-modules/flat-agent/types/flat-agent.type';
import { type FlatRoleTargetByAgentIdMaps } from 'src/engine/metadata-modules/flat-agent/types/flat-role-target-by-agent-id-maps.type';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { type FlatRoleTarget } from 'src/engine/metadata-modules/flat-role-target/types/flat-role-target.type';
import { computeMetadataNameFromLabelOrThrow } from 'src/engine/metadata-modules/utils/compute-metadata-name-from-label-or-throw.util';
import { mergeUpdateInExistingRecord } from 'src/utils/merge-update-in-existing-record.util';

type FlatRoleTargetToCreateDelete = {
  flatRoleTargetToCreate?: FlatRoleTarget;
  flatRoleTargetToDelete?: FlatRoleTarget;
};

type RoleTargetApplication = Pick<
  FlatRoleTarget,
  'applicationId' | 'applicationUniversalIdentifier'
>;

const computeAgentFlatRoleTargetToUpdate = ({
  roleId,
  flatAgent,
  flatRoleTargetByAgentIdMaps,
  flatRoleMaps,
  roleTargetApplication,
}: {
  roleId: string | null | undefined;
  flatRoleTargetByAgentIdMaps: FlatRoleTargetByAgentIdMaps;
  flatAgent: FlatAgent;
  flatRoleMaps: AllFlatEntityMaps['flatRoleMaps'];
  roleTargetApplication: RoleTargetApplication;
}): FlatRoleTargetToCreateDelete => {
  if (roleId === undefined) {
    return {};
  }

  const existingRoleTarget = flatRoleTargetByAgentIdMaps[flatAgent.id];
  const updatedAt = new Date().toISOString();

  if (roleId === null) {
    if (isDefined(existingRoleTarget)) {
      return {
        flatRoleTargetToDelete: existingRoleTarget,
      };
    }

    return {};
  }

  const flatRole = findFlatEntityByIdInFlatEntityMapsOrThrow({
    flatEntityMaps: flatRoleMaps,
    flatEntityId: roleId,
  });

  if (
    isDefined(existingRoleTarget) &&
    existingRoleTarget.roleId.toLowerCase() === flatRole.id.toLowerCase()
  ) {
    return {};
  }

  const flatRoleTargetToCreate: FlatRoleTarget = {
    id: v4(),
    roleId: flatRole.id,
    roleUniversalIdentifier: flatRole.universalIdentifier,
    userWorkspaceId: null,
    agentId: flatAgent.id,
    agentUniversalIdentifier: flatAgent.universalIdentifier,
    apiKeyId: null,
    createdAt: updatedAt,
    updatedAt,
    universalIdentifier: v4(),
    workspaceId: flatAgent.workspaceId,
    applicationId: roleTargetApplication.applicationId,
    applicationUniversalIdentifier:
      roleTargetApplication.applicationUniversalIdentifier,
  };

  if (isDefined(existingRoleTarget)) {
    return {
      flatRoleTargetToDelete: existingRoleTarget,
      flatRoleTargetToCreate,
    };
  }

  return {
    flatRoleTargetToCreate,
  };
};

export type FromUpdateAgentInputToFlatAgentToUpdateArgs = {
  updateAgentInput: UpdateAgentInput;
  flatAgentMaps: FlatAgentMaps;
  flatRoleTargetByAgentIdMaps: FlatRoleTargetByAgentIdMaps;
  // The runner stores new role targets under the migration application.
  roleTargetApplication: RoleTargetApplication;
} & Pick<AllFlatEntityMaps, 'flatRoleMaps'>;

export const fromUpdateAgentInputToFlatAgentToUpdate = ({
  updateAgentInput: rawUpdateAgentInput,
  flatAgentMaps,
  flatRoleTargetByAgentIdMaps,
  flatRoleMaps,
  roleTargetApplication,
}: FromUpdateAgentInputToFlatAgentToUpdateArgs): {
  flatAgentToUpdate: FlatAgent;
} & FlatRoleTargetToCreateDelete => {
  const { id: agentIdToUpdate } =
    trimAndRemoveDuplicatedWhitespacesFromObjectStringProperties(
      rawUpdateAgentInput,
      ['id'],
    );

  const existingFlatAgent = findFlatEntityByIdInFlatEntityMaps({
    flatEntityId: agentIdToUpdate,
    flatEntityMaps: flatAgentMaps,
  });

  if (!isDefined(existingFlatAgent)) {
    throw new AiException('Agent not found', AiExceptionCode.AGENT_NOT_FOUND, {
      userFriendlyMessage: msg`The agent you are looking for could not be found. It may have been deleted or you may not have access to it.`,
    });
  }

  const updatedEditableAgentProperties = extractAndSanitizeObjectStringFields(
    rawUpdateAgentInput,
    FLAT_AGENT_EDITABLE_PROPERTIES,
  );

  if (
    isDefined(updatedEditableAgentProperties.label) &&
    !isDefined(updatedEditableAgentProperties.name)
  ) {
    updatedEditableAgentProperties.name = computeMetadataNameFromLabelOrThrow(
      updatedEditableAgentProperties.label,
    );
  }

  const flatAgentToUpdate: FlatAgent = mergeUpdateInExistingRecord({
    existing: existingFlatAgent,
    properties: FLAT_AGENT_EDITABLE_PROPERTIES,
    update: updatedEditableAgentProperties,
  });

  const { flatRoleTargetToCreate, flatRoleTargetToDelete } =
    computeAgentFlatRoleTargetToUpdate({
      roleId: rawUpdateAgentInput.roleId,
      flatAgent: existingFlatAgent,
      flatRoleTargetByAgentIdMaps,
      flatRoleMaps,
      roleTargetApplication,
    });

  return {
    flatAgentToUpdate,
    flatRoleTargetToCreate,
    flatRoleTargetToDelete,
  };
};
