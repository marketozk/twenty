jest.mock("src/engine/core-modules/application/application-install/application-install.service", () => ({ApplicationInstallService: class {}}));
jest.mock("src/engine/core-modules/application/application-upgrade/application-upgrade.service", () => ({ApplicationUpgradeService: class {}}));
jest.mock("src/engine/core-modules/application/application-install/services/application-uninstall-runner.service", () => ({ApplicationUninstallRunnerService: class {}}));
jest.mock("src/engine/core-modules/application/application.service", () => ({ApplicationService: class {}}));
jest.mock("src/engine/core-modules/application/application-marketplace/marketplace-query.service", () => ({MarketplaceQueryService: class {}}));
jest.mock("src/engine/core-modules/cache-lock/cache-lock.service", () => ({CacheLockService: class {}}));
jest.mock("src/engine/core-modules/message-queue/services/message-queue.service", () => ({MessageQueueService: class {}}));
jest.mock("src/engine/core-modules/message-queue/utils/build-job-status.util", () => ({buildJobStatus: jest.fn()}));
