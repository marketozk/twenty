# Следующий участок после LOG201

После закрытия всех продакшен-писателей `recordShare` (`LOG199` управление шарами и передача владения, `LOG200` `ShareWithService` и `WorkflowRunRecordShareService`, `LOG201` SQL CTE-писатели `AgentChatSharingService`, `AgentChatThreadParticipantService`, `AgentChatChannelGrantService`, `AgentInboxService`, `AgentRunService` и `RewriteAgentChatChannelGrantsJob`) следующая открытая граница в рамках `ROB-765`:
- `LOG202`: транзакционный аудит публичного физического удаления CRM-записей (`CommonDestroyOneQueryRunnerService`, `CommonDestroyManyQueryRunnerService` и `CommonBaseQueryRunnerService` для покрытых объектов с `withNativeCrmAuditTransaction`, проверкой отсутствия связанных файлов / непокрытых FK-эффектов и очисткой `recordShare`).
