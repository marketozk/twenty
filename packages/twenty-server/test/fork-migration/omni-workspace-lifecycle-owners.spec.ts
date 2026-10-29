import { randomUUID } from 'node:crypto';
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
jest.mock(
  'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit',
  () => ({
    deactivateCoreUserWithAudit: jest.fn().mockResolvedValue('deleted'),
  }),
);
const deactivateUser = jest.mocked(deactivateCoreUserWithAudit);
import { systemMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceSchemaService } from 'src/engine/workspace-datasource/workspace-schema.service';
import { DestroySoftDeletedWorkspaceJob } from 'src/engine/workspace-manager/workspace-cleaner/jobs/destroy-soft-deleted-workspace.job';
import {
  admitOmniWorkspaceDeletion,
  dropOmniUnownedWorkspaceSchema,
  OmniWorkspaceLifecycleOutcomeUnknownError,
} from 'src/modules/omnichannel/services/omni-workspace-deletion';

// Isolate unrelated DI graphs; the lifecycle methods and database helper error class remain real.
jest.mock('src/database/typeorm/postgres-advisory-lock.service', () => ({
  PostgresAdvisoryLockService: class {},
}));
jest.mock(
  'src/engine/core-entity-cache/services/core-entity-cache.service',
  () => ({ CoreEntityCacheService: class {} }),
);
jest.mock('src/engine/core-modules/api-key/api-key.entity', () => ({
  ApiKeyEntity: class {},
}));
jest.mock('src/engine/core-modules/application/application.service', () => ({
  ApplicationService: class {},
}));
jest.mock(
  'src/engine/core-modules/application/application-manifest/services/application-uninstall.service',
  () => ({ ApplicationUninstallService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/pre-installed-apps/pre-installed-apps.service',
  () => ({ PreInstalledAppsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/billing/services/billing-subscription.service',
  () => ({ BillingSubscriptionService: class {} }),
);
jest.mock('src/engine/core-modules/billing/services/billing.service', () => ({
  BillingService: class {},
}));
jest.mock(
  'src/engine/core-modules/dns-manager/services/dns-manager.service',
  () => ({ DnsManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/custom-domain-manager/services/custom-domain-manager.service',
  () => ({ CustomDomainManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/domain/subdomain-manager/services/subdomain-manager.service',
  () => ({ SubdomainManagerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/emailing-domain/emailing-domain.entity',
  () => ({ EmailingDomainEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/event-logs/retention/services/event-log-retention.service',
  () => ({ EventLogRetentionService: class {} }),
);
jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock(
  'src/engine/core-modules/file/file-core-picture/services/file-core-picture.service',
  () => ({ FileCorePictureService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/engine/core-modules/sdk-client/sdk-client-generation.service',
  () => ({ SdkClientGenerationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-migration.service',
  () => ({ UpgradeMigrationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-sequence-reader.service',
  () => ({ UpgradeSequenceReaderService: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.service',
  () => ({ UserWorkspaceService: class {} }),
);
jest.mock('src/engine/core-modules/user/user.entity', () => ({
  UserEntity: class {},
}));
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/metadata-modules/ai/ai-models/services/ai-model-registry.service',
  () => ({ AiModelRegistryService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/field-metadata/field-metadata.entity',
  () => ({ FieldMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/constant/all-metadata-entity-by-metadata-name.constant',
  () => ({ ALL_METADATA_ENTITY_BY_METADATA_NAME: {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/permissions/permissions.service',
  () => ({ PermissionsService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/role-assignment-validation/services/role-assignment-validation.service',
  () => ({ RoleAssignmentValidationService: class {} }),
);
jest.mock(
  'src/engine/workspace-cache-storage/workspace-cache-storage.service',
  () => ({ WorkspaceCacheStorageService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/services/prefill-logic-function.service',
  () => ({ PrefillLogicFunctionService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-companies.util',
  () => ({ prefillCompanies: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-dashboards.util',
  () => ({ prefillDashboards: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-opportunities.util',
  () => ({ prefillOpportunities: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-people.util',
  () => ({ prefillPeople: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflow-code-step-logic-functions.util',
  () => ({
    getCreateCompanyWhenAddingNewPersonCodeStepLogicFunctionDefinitions: class {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflow-command-menu-items.util',
  () => ({ prefillWorkflowCommandMenuItems: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-workflows.util',
  () => ({ prefillWorkflows: class {} }),
);
jest.mock('src/engine/workspace-manager/workspace-manager.service', () => ({
  WorkspaceManagerService: class {},
}));
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock('src/modules/omnichannel/services/omni-workspace-deletion', () => ({
  ...jest.requireActual(
    'src/modules/omnichannel/services/omni-workspace-deletion',
  ),
  admitOmniWorkspaceDeletion: jest.fn(),
  dropOmniUnownedWorkspaceSchema: jest.fn(),
}));
jest.mock('twenty-shared/ai', () => ({ isAiModelTier: jest.fn() }));
jest.mock(
  'src/engine/core-modules/emailing-domain/jobs/emailing-domain-workspace-cleanup.job',
  () => ({
    EmailingDomainWorkspaceCleanupJob: class EmailingDomainWorkspaceCleanupJob {},
  }),
);
jest.mock(
  'src/engine/core-modules/file/jobs/file-workspace-folder-deletion.job',
  () => ({
    FileWorkspaceFolderDeletionJob: class FileWorkspaceFolderDeletionJob {},
  }),
);
jest.mock(
  'src/engine/core-modules/workspace/jobs/workspace-deletion-application-uninstall.job',
  () => ({
    WorkspaceDeletionApplicationUninstallJob: class WorkspaceDeletionApplicationUninstallJob {},
  }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service',
  () => ({ WorkspaceMigrationValidateBuildAndRunService: class {} }),
);
const admission = jest.mocked(admitOmniWorkspaceDeletion);
const drop = jest.mocked(dropOmniUnownedWorkspaceSchema);
const fixture = () => {
  const workspace = {
    id: randomUUID(),
    deletedAt: null as Date | null,
    customDomain: null,
  };
  const timestamp = new Date('2026-10-27T12:00:00.123Z');
  const effects: string[] = [];
  const effect = (name: string) =>
    jest.fn(async () => {
      effects.push(name);
    });
  admission.mockImplementation(async () => {
    effects.push('admit');
    return timestamp;
  });
  const dependencies = {
    logger: { log: jest.fn() },
    coreDataSource: {
      getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([]) })),
    },
    workspaceRepository: {
      findOne: jest.fn().mockResolvedValue(workspace),
      delete: effect('delete'),
      softDelete: effect('softDelete'),
    },
    coreEntityCacheService: { invalidate: effect('invalidate') },
    billingService: { isBillingEnabled: jest.fn(() => true) },
    billingSubscriptionService: {
      cancelSubscription: effect('cancel'),
      assertSubscriptionCanceledOrNone: effect('billingAssert'),
    },
    userWorkspaceRepository: {
      find: jest
        .fn()
        .mockResolvedValue([{ id: randomUUID(), userId: randomUUID() }]),
    },
    handleRemoveWorkspaceMember: effect('member'),
    eventEmitter: { emit: effect('event') },
    applicationLifecycleHookMessageQueueService: {
      add: effect('uninstallQueue'),
    },
    postgresAdvisoryLockService: {
      tryWithLock: jest.fn(
        async (_key: string, work: () => Promise<unknown>) => ({
          acquired: true,
          value: await work(),
        }),
      ),
    },
    applicationUninstallService: {
      runUninstallHooksForWorkspaceDeletionBestEffort: effect('hooks'),
    },
    deleteWorkspaceSyncableMetadataEntities: effect('metadata'),
    workspaceSchemaService: { deleteWorkspaceDBSchema: effect('schema') },
    workspaceCacheStorageService: { flush: effect('flush') },
    flatEntityMapsCacheService: { flushFlatEntityMaps: effect('flatFlush') },
    deleteCascadeMessageQueueService: { add: effect('cleanupQueue') },
  };
  const service: WorkspaceService = Object.assign(
    Object.create(WorkspaceService.prototype),
    dependencies,
  );
  return { service, workspace, timestamp, effects, ...dependencies };
};
beforeEach(() => jest.resetAllMocks());

describe('membership cleanup attribution and exact teardown targets', () => {
  const cleanupFixture = () => {
    const userWorkspaceRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const userWorkspaceService = {
      deleteUserWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const userRepository = {
      manager: { connection: {} },
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const coreEntityCacheService = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = Object.create(
      WorkspaceService.prototype,
    ) as WorkspaceService;
    Object.assign(service, {
      userWorkspaceRepository,
      userWorkspaceService,
      userRepository,
      coreEntityCacheService,
    });
    return {
      service,
      userWorkspaceRepository,
      userWorkspaceService,
      userRepository,
    };
  };
  it('hard teardown forwards every retained membership ID and captured actor', async () => {
    const f = fixture();
    const userId = randomUUID(),
      firstId = randomUUID(),
      secondId = randomUUID();
    f.userWorkspaceRepository.find.mockResolvedValue([
      { id: firstId, userId },
      { id: secondId, userId },
    ]);
    const identity = systemMembershipCleanupIdentity(
      f.workspace.id,
      'retained-test',
    );
    await f.service.deleteWorkspace(f.workspace.id, false, identity);
    expect(f.userWorkspaceRepository.find).toHaveBeenCalledWith({
      where: { workspaceId: f.workspace.id },
      withDeleted: true,
    });
    expect(f.handleRemoveWorkspaceMember).toHaveBeenNthCalledWith(
      1,
      f.workspace.id,
      userId,
      false,
      identity,
      firstId,
    );
    expect(f.handleRemoveWorkspaceMember).toHaveBeenNthCalledWith(
      2,
      f.workspace.id,
      userId,
      false,
      identity,
      secondId,
    );
  });
  it('soft teardown only enumerates active memberships', async () => {
    const f = fixture();
    await f.service.deleteWorkspace(
      f.workspace.id,
      true,
      systemMembershipCleanupIdentity(f.workspace.id, 'soft-test'),
    );
    expect(f.userWorkspaceRepository.find).toHaveBeenCalledWith({
      where: { workspaceId: f.workspace.id },
    });
  });
  it('removes exact retained target without disabling a user active elsewhere', async () => {
    const f = cleanupFixture();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      id = randomUUID();
    f.userWorkspaceRepository.find.mockResolvedValue([
      { id: randomUUID(), workspaceId: randomUUID(), userId },
    ]);
    f.userWorkspaceRepository.findOne.mockResolvedValue({
      id,
      workspaceId,
      userId,
      deletedAt: new Date(),
    });
    await f.service.handleRemoveWorkspaceMember(
      workspaceId,
      userId,
      false,
      systemMembershipCleanupIdentity(workspaceId, 'destroy-test'),
      id,
    );
    expect(f.userWorkspaceRepository.findOne).toHaveBeenCalledWith({
      where: { id, userId, workspaceId },
      withDeleted: true,
    });
    expect(f.userWorkspaceService.deleteUserWorkspace).toHaveBeenCalledWith({
      workspaceId,
      userWorkspaceId: id,
      softDelete: false,
      expectedUserId: userId,
      auditOperation: expect.objectContaining({
        workspaceId,
        actor: { kind: 'system', id: 'destroy-test' },
      }),
    });
    expect(f.userRepository.softDelete).not.toHaveBeenCalled();
    expect(deactivateUser).not.toHaveBeenCalled();
  });
  it('disables the core user after removing their last retained target', async () => {
    const f = cleanupFixture();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      id = randomUUID();
    f.userWorkspaceRepository.findOne.mockResolvedValue({
      id,
      workspaceId,
      userId,
      deletedAt: new Date(),
    });
    await f.service.handleRemoveWorkspaceMember(
      workspaceId,
      userId,
      false,
      systemMembershipCleanupIdentity(workspaceId, 'destroy-test'),
      id,
    );
    expect(deactivateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        auditOperations: [
          expect.objectContaining({
            workspaceId,
            actor: { kind: 'system', id: 'destroy-test' },
          }),
        ],
      }),
    );
    expect(f.userRepository.softDelete).not.toHaveBeenCalled();
    expect(
      deactivateUser.mock.calls[0][0].auditOperations[0]!.operationId,
    ).not.toBe(
      f.userWorkspaceService.deleteUserWorkspace.mock.calls[0][0].auditOperation
        .operationId,
    );
  });
  it('legacy job lookup remains active-only instead of sweeping historical rows', async () => {
    const f = cleanupFixture();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      id = randomUUID();
    f.userWorkspaceRepository.find.mockResolvedValue([
      { id, workspaceId, userId },
    ]);
    await f.service.handleRemoveWorkspaceMember(
      workspaceId,
      userId,
      false,
      systemMembershipCleanupIdentity(workspaceId, 'job-test'),
    );
    expect(f.userWorkspaceRepository.find).toHaveBeenCalledWith({
      where: { userId },
    });
    expect(f.userWorkspaceRepository.findOne).not.toHaveBeenCalled();
    expect(f.userWorkspaceService.deleteUserWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkspaceId: id, expectedUserId: userId }),
    );
  });
  it('pins the actor before target lookup awaits', async () => {
    const f = cleanupFixture();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      id = randomUUID(),
      actorId = randomUUID();
    const identity = {
      workspaceId,
      actor: { kind: 'coreUser' as const, id: actorId },
      correlationId: randomUUID(),
    };
    f.userWorkspaceRepository.find.mockImplementation(async () => {
      identity.actor.id = randomUUID();
      identity.workspaceId = randomUUID();
      return [{ id, workspaceId, userId }];
    });
    await f.service.handleRemoveWorkspaceMember(
      workspaceId,
      userId,
      false,
      identity,
    );
    expect(f.userWorkspaceService.deleteUserWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        auditOperation: expect.objectContaining({
          workspaceId,
          actor: { kind: 'coreUser', id: actorId },
        }),
      }),
    );
  });
  it('rejects foreign attribution before workspace deletion admission or target reads', async () => {
    const f = fixture();
    await expect(
      f.service.deleteWorkspace(
        f.workspace.id,
        false,
        systemMembershipCleanupIdentity(randomUUID(), 'foreign-test'),
      ),
    ).rejects.toThrow('workspace mismatch');
    expect(admission).not.toHaveBeenCalled();
    expect(f.workspaceRepository.findOne).not.toHaveBeenCalled();
  });
});

describe('workspace lifecycle owners', () => {
  it.each([true, false])(
    'refuses retained state before all effects (soft=%s)',
    async (soft) => {
      const f = fixture();
      admission.mockRejectedValueOnce(
        new Error('OMNI_WORKSPACE_DELETE_REQUIRES_CONTROLLED_PURGE'),
      );
      await expect(
        f.service.deleteWorkspace(
          f.workspace.id,
          soft,
          systemMembershipCleanupIdentity(f.workspace.id, 'test'),
        ),
      ).rejects.toThrow('CONTROLLED_PURGE');
      expect(f.effects).toEqual([]);
      expect(f.userWorkspaceRepository.find).not.toHaveBeenCalled();
      expect(f.workspace.deletedAt).toBeNull();
    },
  );
  it('invalidates and cancels billing before members and queues on soft deletion', async () => {
    const f = fixture();
    expect(
      await f.service.deleteWorkspace(
        f.workspace.id,
        true,
        systemMembershipCleanupIdentity(f.workspace.id, 'test'),
      ),
    ).toBe(f.workspace);
    expect(f.workspace.deletedAt).toEqual(f.timestamp);
    expect(f.effects).toEqual([
      'admit',
      'invalidate',
      'cancel',
      'member',
      'event',
      'uninstallQueue',
    ]);
    expect(f.workspaceRepository.softDelete).not.toHaveBeenCalled();
  });
  it('uses the admitted timestamp for hard-delete hooks before schema removal', async () => {
    const f = fixture();
    await f.service.deleteWorkspace(
      f.workspace.id,
      false,
      systemMembershipCleanupIdentity(f.workspace.id, 'test'),
    );
    expect(f.effects).toEqual([
      'admit',
      'invalidate',
      'billingAssert',
      'member',
      'hooks',
      'metadata',
      'schema',
      'flush',
      'flatFlush',
      'cleanupQueue',
      'cleanupQueue',
      'delete',
      'invalidate',
    ]);
    expect(
      f.applicationUninstallService
        .runUninstallHooksForWorkspaceDeletionBestEffort,
    ).toHaveBeenCalledWith({
      workspaceId: f.workspace.id,
      workspaceDeletedAt: f.timestamp,
    });
  });
  it.each([true, false])(
    'preserves admitted state and stops on billing failure (soft=%s)',
    async (soft) => {
      const f = fixture();
      const billing = soft
        ? f.billingSubscriptionService.cancelSubscription
        : f.billingSubscriptionService.assertSubscriptionCanceledOrNone;
      billing.mockRejectedValueOnce(new Error('billing unavailable'));
      await expect(
        f.service.deleteWorkspace(
          f.workspace.id,
          soft,
          systemMembershipCleanupIdentity(f.workspace.id, 'test'),
        ),
      ).rejects.toThrow('billing unavailable');
      expect(f.effects).toEqual(['admit', 'invalidate']);
      expect(f.workspace.deletedAt).toEqual(f.timestamp);
      expect(f.userWorkspaceRepository.find).not.toHaveBeenCalled();
    },
  );
  it('stops before metadata and schema after uninstall failure', async () => {
    const f = fixture();
    f.applicationUninstallService.runUninstallHooksForWorkspaceDeletionBestEffort.mockRejectedValueOnce(
      new Error('hooks unavailable'),
    );
    await expect(
      f.service.deleteWorkspace(
        f.workspace.id,
        false,
        systemMembershipCleanupIdentity(f.workspace.id, 'test'),
      ),
    ).rejects.toThrow('hooks unavailable');
    expect(f.effects).toEqual([
      'admit',
      'invalidate',
      'billingAssert',
      'member',
    ]);
    expect(f.workspace.deletedAt).toEqual(f.timestamp);
  });
  it('invalidates stale cache after uncertain admission without continuing cleanup', async () => {
    const f = fixture();
    const unknown = new OmniWorkspaceLifecycleOutcomeUnknownError(
      new Error('lost ACK'),
    );
    admission.mockRejectedValueOnce(unknown);
    await expect(
      f.service.deleteWorkspace(
        f.workspace.id,
        false,
        systemMembershipCleanupIdentity(f.workspace.id, 'test'),
      ),
    ).rejects.toBe(unknown);
    expect(f.effects).toEqual(['invalidate']);
    expect(f.userWorkspaceRepository.find).not.toHaveBeenCalled();
  });
  it('retains the uncertain outcome when cache invalidation also fails', async () => {
    const f = fixture();
    const unknown = new OmniWorkspaceLifecycleOutcomeUnknownError(
      new Error('lost ACK'),
    );
    const cacheError = new Error('cache unavailable');
    admission.mockRejectedValueOnce(unknown);
    f.coreEntityCacheService.invalidate.mockRejectedValueOnce(cacheError);
    const result = await f.service
      .deleteWorkspace(
        f.workspace.id,
        false,
        systemMembershipCleanupIdentity(f.workspace.id, 'test'),
      )
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(OmniWorkspaceLifecycleOutcomeUnknownError);
    expect((result as Error).cause).toMatchObject({
      errors: [unknown, cacheError],
    });
    expect(f.effects).toEqual([]);
    expect(f.userWorkspaceRepository.find).not.toHaveBeenCalled();
  });
  it('stops after admission if cache invalidation fails', async () => {
    const f = fixture();
    f.coreEntityCacheService.invalidate.mockRejectedValueOnce(
      new Error('cache unavailable'),
    );
    await expect(
      f.service.deleteWorkspace(
        f.workspace.id,
        false,
        systemMembershipCleanupIdentity(f.workspace.id, 'test'),
      ),
    ).rejects.toThrow('cache unavailable');
    expect(f.effects).toEqual(['admit']);
    expect(f.workspace.deletedAt).toEqual(f.timestamp);
  });
  it('does not record successful destruction when the actual owner refuses it', async () => {
    const f = fixture();
    admission.mockRejectedValueOnce(new Error('retained'));
    const metrics = { incrementCounterForEvent: jest.fn() };
    type Dependencies = ConstructorParameters<
      typeof DestroySoftDeletedWorkspaceJob
    >;
    const job = new DestroySoftDeletedWorkspaceJob(
      {
        exists: jest.fn().mockResolvedValue(true),
      } as unknown as Dependencies[0],
      f.service,
      metrics as unknown as Dependencies[2],
    );
    await expect(job.handle({ workspaceId: f.workspace.id })).rejects.toThrow(
      'retained',
    );
    expect(metrics.incrementCounterForEvent).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });
  it.each([true, false])(
    'preserves DDL lock before delegating schema safety (locked=%s)',
    async (locked) => {
      type Dependencies = ConstructorParameters<typeof WorkspaceSchemaService>;
      const dataSource = {} as Dependencies[1];
      const schema = new WorkspaceSchemaService(
        {} as Dependencies[0],
        dataSource,
        { get: () => locked } as unknown as Dependencies[2],
      );
      const id = randomUUID();
      if (locked) {
        await expect(schema.deleteWorkspaceDBSchema(id)).rejects.toThrow(
          'DDL changes are locked',
        );
        expect(drop).not.toHaveBeenCalled();
      } else {
        drop.mockRejectedValueOnce(new Error('retained'));
        await expect(schema.deleteWorkspaceDBSchema(id)).rejects.toThrow(
          'retained',
        );
        expect(drop).toHaveBeenCalledWith(dataSource, id);
      }
    },
  );
});
