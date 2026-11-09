import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
  type NavigationMenuItemAuditIdentity,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatSkill } from 'src/engine/metadata-modules/flat-skill/types/flat-skill.type';
import { fromCreateSkillInputToUniversalFlatSkillToCreate } from 'src/engine/metadata-modules/flat-skill/utils/from-create-skill-input-to-flat-skill-to-create.util';
import { fromDeleteSkillInputToFlatSkillOrThrow } from 'src/engine/metadata-modules/flat-skill/utils/from-delete-skill-input-to-flat-skill-or-throw.util';
import { fromFlatSkillToSkillDto } from 'src/engine/metadata-modules/flat-skill/utils/from-flat-skill-to-skill-dto.util';
import { fromUpdateSkillInputToFlatSkillToUpdateOrThrow } from 'src/engine/metadata-modules/flat-skill/utils/from-update-skill-input-to-flat-skill-to-update-or-throw.util';
import { type CreateSkillInput } from 'src/engine/metadata-modules/skill/dtos/create-skill.input';
import { type SkillDTO } from 'src/engine/metadata-modules/skill/dtos/skill.dto';
import { type UpdateSkillInput } from 'src/engine/metadata-modules/skill/dtos/update-skill.input';
import {
  SkillException,
  SkillExceptionCode,
} from 'src/engine/metadata-modules/skill/skill.exception';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

export type SkillAuditOptions = {
  auditIdentity?: NavigationMenuItemAuditIdentity;
  authUserWorkspaceId?: string;
  authApiKeyId?: string;
  authApplicationId?: string;
  authAgentId?: string;
  capturedAudit?: ReturnType<typeof captureNavigationMenuItemAudit>;
};

@Injectable()
export class SkillService {
  constructor(
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly workspaceManyOrAllFlatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly applicationService: ApplicationService,
  ) {}

  async findAll(workspaceId: string): Promise<SkillDTO[]> {
    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return Object.values(flatSkillMaps.byUniversalIdentifier)
      .filter(isDefined)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(fromFlatSkillToSkillDto);
  }

  async findById(id: string, workspaceId: string): Promise<SkillDTO | null> {
    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    const flatSkill = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: id,
      flatEntityMaps: flatSkillMaps,
    });

    if (!isDefined(flatSkill)) {
      return null;
    }

    return fromFlatSkillToSkillDto(flatSkill);
  }

  async create(
    input: CreateSkillInput,
    workspaceId: string,
    options?: SkillAuditOptions,
  ): Promise<SkillDTO> {
    const capturedInput: CreateSkillInput = {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      label: input.label,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      content: input.content,
    };
    const getSkillAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'skill',
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const universalFlatSkillToCreate =
      fromCreateSkillInputToUniversalFlatSkillToCreate({
        createSkillInput: capturedInput,
        flatApplication: workspaceCustomFlatApplication,
      });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getSkillAudit({
        expectedSkillCreateIds: [universalFlatSkillToCreate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              skill: {
                flatEntityToCreate: [universalFlatSkillToCreate],
                flatEntityToDelete: [],
                flatEntityToUpdate: [],
              },
            },
            workspaceId,
            isSystemBuild: false,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while creating skill',
      );
    }

    const { flatSkillMaps: recomputedFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return fromFlatSkillToSkillDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: universalFlatSkillToCreate.id,
        flatEntityMaps: recomputedFlatSkillMaps,
      }),
    );
  }

  async update(
    input: UpdateSkillInput,
    workspaceId: string,
    options?: SkillAuditOptions,
  ): Promise<SkillDTO> {
    const capturedInput: UpdateSkillInput = {
      id: input.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
    const getSkillAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'skill',
        expectedSkillUpdateIds: [capturedInput.id],
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const { flatSkillMaps: existingFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    const flatSkillToUpdate = fromUpdateSkillInputToFlatSkillToUpdateOrThrow({
      flatSkillMaps: existingFlatSkillMaps,
      updateSkillInput: capturedInput,
    });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getSkillAudit({
        expectedSkillUpdateIds: [flatSkillToUpdate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              skill: {
                flatEntityToCreate: [],
                flatEntityToDelete: [],
                flatEntityToUpdate: [flatSkillToUpdate],
              },
            },
            workspaceId,
            isSystemBuild: false,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while updating skill',
      );
    }

    const { flatSkillMaps: recomputedFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return fromFlatSkillToSkillDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: capturedInput.id,
        flatEntityMaps: recomputedFlatSkillMaps,
      }),
    );
  }

  async delete(
    id: string,
    workspaceId: string,
    options?: SkillAuditOptions,
  ): Promise<SkillDTO> {
    const capturedId = id;
    const getSkillAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'skill',
        expectedSkillDeleteIds: [capturedId],
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const { flatSkillMaps: existingFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    const flatSkillToDelete = fromDeleteSkillInputToFlatSkillOrThrow({
      flatSkillMaps: existingFlatSkillMaps,
      skillId: capturedId,
    });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getSkillAudit({
        expectedSkillDeleteIds: [flatSkillToDelete.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              skill: {
                flatEntityToCreate: [],
                flatEntityToDelete: [flatSkillToDelete],
                flatEntityToUpdate: [],
              },
            },
            workspaceId,
            isSystemBuild: false,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while deleting skill',
      );
    }

    return fromFlatSkillToSkillDto(flatSkillToDelete);
  }

  async findAllFlatSkills(workspaceId: string): Promise<FlatSkill[]> {
    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return Object.values(flatSkillMaps.byUniversalIdentifier)
      .filter(isDefined)
      .filter((flatSkill) => flatSkill.isActive)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async findFlatSkillsByNames(
    names: string[],
    workspaceId: string,
  ): Promise<FlatSkill[]> {
    if (names.length === 0) {
      return [];
    }

    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return Object.values(flatSkillMaps.byUniversalIdentifier)
      .filter(isDefined)
      .filter(
        (flatSkill) => names.includes(flatSkill.name) && flatSkill.isActive,
      );
  }

  async findFlatSkillsByIds(
    ids: string[],
    workspaceId: string,
  ): Promise<FlatSkill[]> {
    if (ids.length === 0) {
      return [];
    }

    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return Object.values(flatSkillMaps.byUniversalIdentifier)
      .filter(isDefined)
      .filter((flatSkill) => ids.includes(flatSkill.id) && flatSkill.isActive);
  }

  async activate(
    id: string,
    workspaceId: string,
    options?: SkillAuditOptions,
  ): Promise<SkillDTO> {
    const capturedId = id;
    const getSkillAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'skill',
        expectedSkillUpdateIds: [capturedId],
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    const existingFlatSkill = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityId: capturedId,
      flatEntityMaps: flatSkillMaps,
    });

    const flatSkillToUpdate: FlatSkill = {
      ...existingFlatSkill,
      isActive: true,
      updatedAt: new Date().toISOString(),
    };

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getSkillAudit({
        expectedSkillUpdateIds: [flatSkillToUpdate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              skill: {
                flatEntityToCreate: [],
                flatEntityToDelete: [],
                flatEntityToUpdate: [flatSkillToUpdate],
              },
            },
            workspaceId,
            isSystemBuild: false,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while activating skill',
      );
    }

    const { flatSkillMaps: recomputedFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return fromFlatSkillToSkillDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: capturedId,
        flatEntityMaps: recomputedFlatSkillMaps,
      }),
    );
  }

  async deactivate(
    id: string,
    workspaceId: string,
    options?: SkillAuditOptions,
  ): Promise<SkillDTO> {
    const capturedId = id;
    const getSkillAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'skill',
        expectedSkillUpdateIds: [capturedId],
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const { flatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    const existingFlatSkill = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityId: capturedId,
      flatEntityMaps: flatSkillMaps,
    });

    const flatSkillToUpdate: FlatSkill = {
      ...existingFlatSkill,
      isActive: false,
      updatedAt: new Date().toISOString(),
    };

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getSkillAudit({
        expectedSkillUpdateIds: [flatSkillToUpdate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              skill: {
                flatEntityToCreate: [],
                flatEntityToDelete: [],
                flatEntityToUpdate: [flatSkillToUpdate],
              },
            },
            workspaceId,
            isSystemBuild: false,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while deactivating skill',
      );
    }

    const { flatSkillMaps: recomputedFlatSkillMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatSkillMaps'],
        },
      );

    return fromFlatSkillToSkillDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: capturedId,
        flatEntityMaps: recomputedFlatSkillMaps,
      }),
    );
  }

  async findByIdOrThrow(id: string, workspaceId: string): Promise<SkillDTO> {
    const skill = await this.findById(id, workspaceId);

    if (!isDefined(skill)) {
      throw new SkillException(
        'Skill not found',
        SkillExceptionCode.SKILL_NOT_FOUND,
      );
    }

    return skill;
  }
}
