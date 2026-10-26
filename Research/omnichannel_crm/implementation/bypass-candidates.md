# Кандидаты bypass — обязательный вход ROB-766

Снимок исходников 2.52 `729f6236126eddaa68d176fb766bc349b19de11d`, 26.10.2026. Автоматический поиск буквального shouldBypassPermissionChecks: true в production *.ts. Это inventory кандидатов, не утверждение о найденных уязвимостях и не завершённая классификация доступа. Динамические flags, raw SQL, QueryRunner, file/export/cache/SSE paths также подлежат отдельной проверке до patch.

Для каждой строки этап 3 фиксирует symbol/callers/auth principal, tenant/data scope, разрешённую причину обхода либо исправление, regression test. Предварительно проверенные source findings — в access-source и кроссревью. Ни одна строка автоматически не считается безопасной.

Найдено 215 совпадений в 106 файлах.

| Файл | Строки | Статус |
|---|---|---|
| `packages/twenty-server/src/database/commands/upgrade-version-command/1-21/1-21-workspace-command-1775500008000-migrate-ai-agent-text-to-json-response-format.command.ts` | 166 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/1-21/1-21-workspace-command-1775500012000-migrate-messaging-infrastructure-to-metadata.command.ts` | 369 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-15/2-15-workspace-command-1800000001000-migrate-manual-trigger-variables-to-payload.command.ts` | 61 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-20/2-20-workspace-command-1783526282685-backfill-workflow-version-to-core.command.ts` | 40 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-22/2-22-workspace-command-1783960128000-migrate-person-avatar-url-to-avatar-file.command.ts` | 95 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-22/2-22-workspace-command-1784193207000-backfill-workflow-version-core-links.command.ts` | 57 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-23/2-23-workspace-command-1784286707000-backfill-workflow-core-links.command.ts` | 55 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-28/2-28-workspace-command-1785600000000-repair-orphan-core-workflow-versions.command.ts` | 54 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-36/2-36-workspace-command-1787700000000-rewrite-is-not-null-workflow-filter-operands.command.ts` | 79, 136 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-40/2-40-workspace-command-1788960408162-backfill-core-workflow-id-on-workflow-versions.command.ts` | 42 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-41/2-41-workspace-command-1789482628000-normalize-workflow-record-crud-rich-text-fields.command.ts` | 83 | classify in ROB-766 |
| `packages/twenty-server/src/database/commands/upgrade-version-command/2-44/2-44-workspace-command-1790772993322-record-pending-form-conversations.command.ts` | 99 | classify in ROB-766 |
| `packages/twenty-server/src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service.ts` | 171 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/approved-access-domain/approved-access-domain.resolver.ts` | 79 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/auth/token/services/access-token.service.ts` | 88 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/billing/app-billing/application-recurring-charge.service.ts` | 135 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/billing/jobs/update-subscription-quantity.job.ts` | 34 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/billing/services/billing-subscription-update.service.ts` | 381 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/calendar/timeline-calendar-event.service.ts` | 70, 282, 407, 426 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/emailing-domain/services/emailing-domain.service.ts` | 174, 184 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/messaging/services/timeline-messaging.service.ts` | 61, 132, 267, 323, 436 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/record-position/services/record-position.service.ts` | 167, 191, 212, 235 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/record-share/services/record-access-policy.service.ts` | 209, 277 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/record-share/services/record-share-principal.service.ts` | 125, 161 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/record-share/services/record-share-storage.service.ts` | 304, 315 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/record-share/services/record-sharing.service.ts` | 598 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/related-person-ids/services/related-person-ids.service.ts` | 88 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/short-link/services/short-link.service.ts` | 29, 65 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/tool/tools/email-tool/email-composer.service.ts` | 321, 339 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/user/jobs/update-workspace-member-email.job.ts` | 42 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/user/services/user.service.ts` | 118, 147, 230, 253, 341, 419 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/user/services/workspace-flat-workspace-member-map-cache.service.ts` | 46 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/user/user.resolver.ts` | 454, 581 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/user-workspace/user-workspace.service.ts` | 176, 513 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/workflow/resolvers/core-workflow-run.resolver.ts` | 85 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/workflow/services/workflow-run-record-share.service.ts` | 311 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/workflow/services/workflow-version-core-sync.service.ts` | 311, 343, 366, 430 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/workspace-data-export/services/workspace-data-export-part-writer.service.ts` | 139 | classify in ROB-766 |
| `packages/twenty-server/src/engine/core-modules/workspace-invitation/workspace-invitation.resolver.ts` | 116, 189 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-actor-context.service.ts` | 120 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-chat/services/workspace-setup-chat.service.ts` | 278 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository.ts` | 52 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-history/services/agent-history-transaction.service.ts` | 23 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/message-channel/services/application-message-ingestion.service.ts` | 233 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/page-layout/services/page-layout.service.ts` | 568 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/user-role/user-role.service.ts` | 270 | classify in ROB-766 |
| `packages/twenty-server/src/engine/metadata-modules/view/services/view-query-params.service.ts` | 177 | classify in ROB-766 |
| `packages/twenty-server/src/engine/trash-cleanup/services/trash-cleanup.service.ts` | 106 | classify in ROB-766 |
| `packages/twenty-server/src/engine/twenty-orm/types/role-permission-config.type.ts` | 10 | classify in ROB-766 |
| `packages/twenty-server/src/engine/twenty-orm/utils/resolve-role-permission-config.util.ts` | 74 | classify in ROB-766 |
| `packages/twenty-server/src/modules/blocklist/repositories/blocklist.repository.ts` | 28, 56, 126 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/blocklist-manager/jobs/blocklist-reimport-calendar-events.job.ts` | 106 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service.ts` | 35, 86, 91, 140, 145 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service.ts` | 96, 161 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service.ts` | 66 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service.ts` | 64, 70, 229, 235 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service.ts` | 42, 60, 106 | classify in ROB-766 |
| `packages/twenty-server/src/modules/calendar/common/query-hooks/calendar-event/services/apply-calendar-events-visibility-restrictions.service.ts` | 100 | classify in ROB-766 |
| `packages/twenty-server/src/modules/contact-creation-manager/services/create-company-and-contact.service.ts` | 69, 75, 199 | classify in ROB-766 |
| `packages/twenty-server/src/modules/contact-creation-manager/services/create-company.service.ts` | 62, 205 | classify in ROB-766 |
| `packages/twenty-server/src/modules/contact-creation-manager/services/create-person.service.ts` | 26, 57, 89 | classify in ROB-766 |
| `packages/twenty-server/src/modules/dashboard/services/dashboard-to-page-layout-sync.service.ts` | 63 | classify in ROB-766 |
| `packages/twenty-server/src/modules/dashboard-sync/services/dashboard-sync.service.ts` | 70 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/campaign-engagement-recording.service.ts` | 36 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-batch-delivery.service.ts` | 320, 527, 539, 590, 625, 665, 681 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-delivery-feedback.service.ts` | 45 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-delivery.service.ts` | 74, 114, 194, 228, 259, 396, 484, 520 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-lifecycle.service.ts` | 73, 96, 114, 272, 296, 332 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-materialization.service.ts` | 74, 96, 208, 284, 421, 458 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-recovery.service.ts` | 50, 102 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-campaign-statistics.service.ts` | 72, 136, 171, 231 | classify in ROB-766 |
| `packages/twenty-server/src/modules/emailing/services/message-suppression.service.ts` | 96, 134, 168, 229, 272, 340, 368, 417, 557 | classify in ROB-766 |
| `packages/twenty-server/src/modules/match-participant/match-participant.service.ts` | 90, 138, 152, 373 | classify in ROB-766 |
| `packages/twenty-server/src/modules/match-participant/participant-target-reconciliation.service.ts` | 501 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-item-delete-messages.job.ts` | 60, 125, 180, 186 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-reimport-messages.job.ts` | 108 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/common/query-hooks/message/apply-messages-visibility-restrictions.service.ts` | 106 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/common/services/message-channel-sync-status.service.ts` | 458 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service.ts` | 43, 48, 53, 156, 197, 202, 207 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/drivers/inbound-email/services/inbound-email-import.service.ts` | 185, 203 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-delete-folder-messages.service.ts` | 45, 51 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-delete-group-email-messages.service.ts` | 45, 51 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service.ts` | 40 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message-list-fetch.service.ts` | 156, 368 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message.service.ts` | 67, 72, 78 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-messages-import.service.ts` | 157 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-outbound-manager/services/messaging-draft-send.service.ts` | 72, 141 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-outbound-manager/services/sent-message-record-link.service.ts` | 53 | classify in ROB-766 |
| `packages/twenty-server/src/modules/messaging/message-participant-manager/services/messaging-message-participant.service.ts` | 38 | classify in ROB-766 |
| `packages/twenty-server/src/modules/note/query-hooks/note-post-query-hook.service.ts` | 32, 57 | classify in ROB-766 |
| `packages/twenty-server/src/modules/task/query-hooks/task-post-query-hook.service.ts` | 32, 57 | classify in ROB-766 |
| `packages/twenty-server/src/modules/timeline/repositories/timeline-activity.repository.ts` | 95, 124, 177, 303 | classify in ROB-766 |
| `packages/twenty-server/src/modules/timeline/services/timeline-activity-target-query.service.ts` | 55, 114 | classify in ROB-766 |
| `packages/twenty-server/src/modules/timeline/services/timeline-activity.service.ts` | 499 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts` | 831 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-deletion/services/workflow-deletion-cleanup.workspace-service.ts` | 51 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-executor/services/workflow-run-inbox-sender.workspace-service.ts` | 37 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/mail-sender/email-workflow-action.base.ts` | 145 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run/command/delete-workflow-runs.command.ts` | 56 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run/workflow-run.workspace-service.ts` | 84, 516, 586 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/cron/jobs/workflow-clean-workflow-runs.cron.job.ts` | 144 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/workspace-services/workflow-handle-staled-runs.workspace-service.ts` | 55, 288 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/workspace-services/workflow-run-enqueue.workspace-service.ts` | 56 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/workspace-services/workflow-throttling.workspace-service.ts` | 73, 99 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workflow/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts` | 313 | classify in ROB-766 |
| `packages/twenty-server/src/modules/workspace-member/query-hooks/workspace-member-delete-one.post-query.hook.ts` | 66 | classify in ROB-766 |
