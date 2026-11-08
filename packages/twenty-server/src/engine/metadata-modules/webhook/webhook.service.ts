import { Injectable } from '@nestjs/common';
import { isDefined } from 'twenty-shared/utils';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
  type NavigationMenuItemAuditIdentity,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { fromCreateWebhookInputToFlatWebhookToCreate } from 'src/engine/metadata-modules/flat-webhook/utils/from-create-webhook-input-to-flat-webhook-to-create.util';
import { fromDeleteWebhookInputToFlatWebhookOrThrow } from 'src/engine/metadata-modules/flat-webhook/utils/from-delete-webhook-input-to-flat-webhook-or-throw.util';
import { fromFlatWebhookToWebhookDto } from 'src/engine/metadata-modules/flat-webhook/utils/from-flat-webhook-to-webhook-dto.util';
import { fromUpdateWebhookInputToFlatWebhookToUpdateOrThrow } from 'src/engine/metadata-modules/flat-webhook/utils/from-update-webhook-input-to-flat-webhook-to-update-or-throw.util';
import { type CreateWebhookInput } from 'src/engine/metadata-modules/webhook/dtos/create-webhook.input';
import { type UpdateWebhookInput } from 'src/engine/metadata-modules/webhook/dtos/update-webhook.input';
import { type WebhookDTO } from 'src/engine/metadata-modules/webhook/dtos/webhook.dto';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

export type WebhookAuditOptions = {
  auditIdentity?: NavigationMenuItemAuditIdentity;
  authUserWorkspaceId?: string;
  authApiKeyId?: string;
  authApplicationId?: string;
  authAgentId?: string;
  capturedAudit?: ReturnType<typeof captureNavigationMenuItemAudit>;
};

@Injectable()
export class WebhookService {
  constructor(
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly workspaceManyOrAllFlatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly applicationService: ApplicationService,
  ) {}

  private normalizeTargetUrl(targetUrl: string): string {
    try {
      const url = new URL(targetUrl);

      return url.toString();
    } catch {
      return targetUrl;
    }
  }

  async findAll(workspaceId: string): Promise<WebhookDTO[]> {
    const { flatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        { workspaceId, flatMapsKeys: ['flatWebhookMaps'] },
      );

    return Object.values(flatWebhookMaps.byUniversalIdentifier)
      .filter(isDefined)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
      .map(fromFlatWebhookToWebhookDto);
  }

  async findById(id: string, workspaceId: string): Promise<WebhookDTO | null> {
    const { flatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        { workspaceId, flatMapsKeys: ['flatWebhookMaps'] },
      );
    const webhook = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: id,
      flatEntityMaps: flatWebhookMaps,
    });

    if (!isDefined(webhook)) {
      return null;
    }

    return fromFlatWebhookToWebhookDto(webhook);
  }

  async create(
    input: CreateWebhookInput,
    workspaceId: string,
    options?: WebhookAuditOptions,
  ): Promise<WebhookDTO> {
    const capturedInput: CreateWebhookInput = {
      ...(input.id !== undefined ? { id: input.id } : {}),
      targetUrl: input.targetUrl,
      operations: Array.isArray(input.operations)
        ? [...input.operations]
        : input.operations,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.secret !== undefined ? { secret: input.secret } : {}),
    };
    const getWebhookAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'webhook',
        auditIdentity: options?.auditIdentity,
        authUserWorkspaceId: options?.authUserWorkspaceId,
        authApiKeyId: options?.authApiKeyId,
        authApplicationId: options?.authApplicationId,
        authAgentId: options?.authAgentId,
      });

    const normalizedTargetUrl = this.normalizeTargetUrl(
      capturedInput.targetUrl,
    );

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const flatWebhookToCreate = fromCreateWebhookInputToFlatWebhookToCreate({
      createWebhookInput: {
        ...capturedInput,
        targetUrl: normalizedTargetUrl,
      },
      workspaceId,
      flatApplication: workspaceCustomFlatApplication,
    });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getWebhookAudit({
        expectedWebhookCreateIds: [flatWebhookToCreate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              webhook: {
                flatEntityToCreate: [flatWebhookToCreate],
                flatEntityToDelete: [],
                flatEntityToUpdate: [],
              },
            },
            workspaceId,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while creating webhook',
      );
    }

    const { flatWebhookMaps: recomputedFlatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatWebhookMaps'],
        },
      );

    return fromFlatWebhookToWebhookDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: flatWebhookToCreate.id,
        flatEntityMaps: recomputedFlatWebhookMaps,
      }),
    );
  }

  async update(
    input: UpdateWebhookInput,
    workspaceId: string,
    options?: WebhookAuditOptions,
  ): Promise<WebhookDTO> {
    const capturedUpdate = {
      ...(input.update.targetUrl !== undefined
        ? { targetUrl: input.update.targetUrl }
        : {}),
      ...(input.update.operations !== undefined
        ? {
            operations: Array.isArray(input.update.operations)
              ? [...input.update.operations]
              : input.update.operations,
          }
        : {}),
      ...(input.update.description !== undefined
        ? { description: input.update.description }
        : {}),
      ...(input.update.secret !== undefined
        ? { secret: input.update.secret }
        : {}),
    };
    const capturedInput: UpdateWebhookInput = {
      id: input.id,
      update: capturedUpdate,
    };
    const getWebhookAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'webhook',
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

    const normalizedInput = {
      ...capturedInput,
      update: {
        ...capturedInput.update,
        ...(isDefined(capturedInput.update.targetUrl) && {
          targetUrl: this.normalizeTargetUrl(capturedInput.update.targetUrl),
        }),
      },
    };

    const { flatWebhookMaps: existingFlatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatWebhookMaps'],
        },
      );

    const flatWebhookToUpdate =
      fromUpdateWebhookInputToFlatWebhookToUpdateOrThrow({
        flatWebhookMaps: existingFlatWebhookMaps,
        updateWebhookInput: normalizedInput,
      });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getWebhookAudit({
        expectedWebhookUpdateIds: [flatWebhookToUpdate.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              webhook: {
                flatEntityToCreate: [],
                flatEntityToDelete: [],
                flatEntityToUpdate: [flatWebhookToUpdate],
              },
            },
            workspaceId,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while updating webhook',
      );
    }

    const { flatWebhookMaps: recomputedFlatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatWebhookMaps'],
        },
      );

    return fromFlatWebhookToWebhookDto(
      findFlatEntityByIdInFlatEntityMapsOrThrow({
        flatEntityId: capturedInput.id,
        flatEntityMaps: recomputedFlatWebhookMaps,
      }),
    );
  }

  async delete(
    id: string,
    workspaceId: string,
    options?: WebhookAuditOptions,
  ): Promise<WebhookDTO> {
    const capturedId = id;
    const getWebhookAudit =
      options?.capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'webhook',
        expectedWebhookDeleteIds: [capturedId],
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

    const { flatWebhookMaps: existingFlatWebhookMaps } =
      await this.workspaceManyOrAllFlatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatWebhookMaps'],
        },
      );

    const flatWebhookToDelete = fromDeleteWebhookInputToFlatWebhookOrThrow({
      flatWebhookMaps: existingFlatWebhookMaps,
      webhookId: capturedId,
    });

    const validateAndBuildResult = await withNavigationMenuItemAudit(
      getWebhookAudit({
        expectedWebhookDeleteIds: [flatWebhookToDelete.id],
      }),
      () =>
        this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
          {
            allFlatEntityOperationByMetadataName: {
              webhook: {
                flatEntityToCreate: [],
                flatEntityToDelete: [flatWebhookToDelete],
                flatEntityToUpdate: [],
              },
            },
            workspaceId,
            applicationUniversalIdentifier:
              workspaceCustomFlatApplication.universalIdentifier,
          },
        ),
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while deleting webhook',
      );
    }

    return fromFlatWebhookToWebhookDto(flatWebhookToDelete);
  }
}
