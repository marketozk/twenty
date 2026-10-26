# Источники для общей модели автоматизации

26.10.2026. Исходники pinned 729f6236 прочитаны; будущие решения относятся к [единому контракту](../design/09-automation-contract.md), а не к готовой реализации. Это source matrix, не выполненные тесты. Полный inventory уточняется перед patch; перечисленные альтернативные пути обязательны.

| Файл / символ | Подтверждённая граница | Планируемое изменение | Oracle |
|---|---|---|---|
| [action-tool.provider.ts](../../../packages/twenty-server/src/engine/core-modules/tool-provider/providers/action-tool.provider.ts) — getCatalog / executeStaticTool | Роль включает raw tools | Применять closed capability registry до discovery и execution | T25-A |
| [tool-registry.service.ts](../../../packages/twenty-server/src/engine/core-modules/tool-provider/services/tool-registry.service.ts) — getCatalog / resolveSchemas / hydrateToolSet / resolveAndExecute | Каталог и несколько путей dispatch | Общая policy на всех путях; hydrate не обходит guard | T25-A/C |
| [execute-tool.tool.ts](../../../packages/twenty-server/src/engine/core-modules/tool-provider/tools/execute-tool.tool.ts) — execute | isToolAllowed опционален, далее resolveAndExecute | Обязательная проверка inner tool и reference в omni | T25-A |
| [learn-tools.tool.ts](../../../packages/twenty-server/src/engine/core-modules/tool-provider/tools/learn-tools.tool.ts) — discovery | Описание схем tools | Тот же allowlist, не только сокрытие UI | T25-A |
| [mcp-core.controller.ts](../../../packages/twenty-server/src/engine/api/mcp/controllers/mcp-core.controller.ts) — HTTP ingress | Новая request auth boundary | Не считать ordinary token продолжением omni; trusted dispatch или deny | T25-B |
| [mcp-auth.guard.ts](../../../packages/twenty-server/src/engine/api/mcp/guards/mcp-auth.guard.ts) — auth guard | Проверка обычного MCP principal | Сохранить обычную auth; не выпускать широкий token из omni | T25-B |
| [mcp-tool-executor.service.ts](../../../packages/twenty-server/src/engine/api/mcp/services/mcp-tool-executor.service.ts) — handleToolCall | ToolSet execute, runtime context undefined | Enforcement в bound dispatcher и reference, не prompt | T25-A/B |
| [code-interpreter-tool.ts](../../../packages/twenty-server/src/engine/core-modules/tool/tools/code-interpreter-tool/code-interpreter-tool.ts) — generateSandboxToken | generateApplicationAccessToken expiresIn 5m | Запретить tool/issuer для omni v1 до выдачи token | T25-B |
| [agent-runner.service.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-runner.service.ts) — turnInput | pausingTools=createAgentWaitTools отдельно от excluded names | Omni pausingTools=[] плюс union констант | T27-A |
| [pausing-tools.constant.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/pausing-tools/constants/pausing-tools.constant.ts) — PAUSING_TOOLS | Включает legacy ask_questions | Источник полного запрета auto | T27-A |
| [agent-wait-tool-names.constant.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/pausing-tools/constants/agent-wait-tool-names.constant.ts) — AGENT_WAIT_TOOL_NAMES | wait_for_event + wait_for_duration | Источник полного запрета auto | T27-A |
| [core-workflow-lifecycle.workspace-service.ts](../../../packages/twenty-server/src/engine/core-modules/workflow/services/core-workflow-lifecycle.workspace-service.ts) — publish/activate lifecycle | Меняет active/pinned version | Сериализация с admission; version не consumer key | T14-A/B |
| [run-workflow.job.ts](../../../packages/twenty-server/src/modules/workflow/workflow-runner/jobs/run-workflow.job.ts) — start/resume | Существующий runner/recovery | RunIntent как ledger; no random retry | T14-A/C |
| [workflow-clean-workflow-runs.job.ts](../../../packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/jobs/workflow-clean-workflow-runs.job.ts) — deleteOldRuns / excess cleanup | Raw SQL удаляет native runs | Canonical intent/tombstone остаётся | T14-C |

У нового кода OmniWorkflowTriggerConsumer/DispatchPlan/ReplyBudget пока нет реализации или call sites. Для него источник контракта — требования и таблицы гонок в design/09, а не выдуманный существующий метод Twenty. Сохранение Message/admission/dispatch plan должно использовать общий transaction executor; lifecycle, mutation, sender fences сохраняют общий lock order.

В прямом tool call и child execution scope только сужается; запуск из ordinary MCP не наследует automation privileges. Все клиентские отправки проходят CommandService и общий reply budget. В реализации дополнительно трассировать ToolExecutorService.dispatch и controller→toolSet construction: одной модификации ActionToolProvider недостаточно.

## Дополнено после целевого source review R8

| Источник | Факт | Планируемое изменение | Oracle |
|---|---|---|---|
| [agent-toolset.service.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-toolset.service.ts) | build: native/pausing/extra merge | Защитить итоговый набор; native options пусты, canAskHumans false, waitTools empty | T25-E/T27-A |
| [agent-run-turn.service.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-run-turn.service.ts) | run: modelConfiguration → native options | Server omni override до сборки provider request | T25-E |
| [ai-model-config.service.ts](../../../packages/twenty-server/src/engine/metadata-modules/ai/ai-models/services/ai-model-config.service.ts) | getNativeModelTools: provider-executed search | В omni v1 не выдавать provider-native tools | T25-E |
| [build-workflow-agent-run-spec.util.ts](../../../packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/ai-agent/utils/build-workflow-agent-run-spec.util.ts) | humanInputInstructions → canAskHumans | Publish rejects; runtime override для любого omni reference | T27-A |
| [ai-agent.workflow-action.ts](../../../packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/ai-agent/ai-agent.workflow-action.ts) | run agent внутри workflow | Наследовать reference и весь covered admission set | T27-A/C |
| [logic-function-executor.service.ts](../../../packages/twenty-server/src/engine/core-modules/logic-function/logic-function-executor/logic-function-executor.service.ts) | application + delegated token issuer | До issuer deny для omni v1 | T25-D |
| [code.workflow-action.ts](../../../packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/code/code.workflow-action.ts) | CODE → logic function executor | Закрытый action policy до dispatch | T25-D |
| [logic-function.workflow-action.ts](../../../packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/logic-function/logic-function.workflow-action.ts) | LOGIC_FUNCTION → executor | Закрытый action policy до dispatch | T25-D |
| [workflow-executor.workspace-service.ts](../../../packages/twenty-server/src/modules/workflow/workflow-executor/workspace-services/workflow-executor.workspace-service.ts) | executeFromStep / computeWorkflowRunStatus | Action policy на каждый step/resume и terminal finalizer | T25-D/T14-D |
| [workflow-runner.workspace-service.ts](../../../packages/twenty-server/src/modules/workflow/workflow-runner/workspace-services/workflow-runner.workspace-service.ts) | retryWorkflowRun: FAILED→RUNNING + queue | Omni deny до mutation/enqueue, ordinary regression | T14-D |
| [workflow-trigger.resolver.ts](../../../packages/twenty-server/src/engine/core-modules/workflow/resolvers/workflow-trigger.resolver.ts) | retryWorkflowRun resolver | UI не является защитой; общий server guard | T14-D |
| [RetryWorkflowRunSingleRecordCommand.tsx](../../../packages/twenty-front/src/modules/command-menu-item/engine-command/record/single-record/workflow-runs/components/RetryWorkflowRunSingleRecordCommand.tsx) | UI Retry bulk command | Отображать отдельный controlled replay, server guard обязателен | T14-D |
| [workflow-run.workspace-service.ts](../../../packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run/workflow-run.workspace-service.ts) | endWorkflowRun status writer | Native terminal + intent disposition в одной transaction | T14-D |
| [WorkflowActionType.ts](../../../packages/twenty-shared/src/workflow/types/WorkflowActionType.ts) | полный enum actions | Полная decision table: новый type default deny | T25-D |

## Дополнено после полного R8

| Источник | Факт | Изменение | Oracle |
|---|---|---|---|
| [common-merge-many-query-runner.service.ts](../../../packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts) | mergeRelatedRecordsIntoPriorityRecord → getRepository/runMutation без skip | Разделить omni-owned и ordinary строки до update/soft-delete | T23 |
| [person.workspace-entity.ts](../../../packages/twenty-server/src/modules/person/standard-objects/person.workspace-entity.ts) | messageParticipants relation | Полный lifecycle inventory зависимых ссылок | T23 |
| [workflow-database-event-trigger.listener.ts](../../../packages/twenty-server/src/modules/workflow/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts) | post-mutation event dispatch | Governed target из durable transaction ingress; native enqueue его пропускает | T14-E |
| [workflow-trigger.job.ts](../../../packages/twenty-server/src/modules/workflow/workflow-trigger/jobs/workflow-trigger.job.ts) | handle CORE/legacy dispatch | Governance marker/reference проверяется перед первым шагом, оба пути | T14-E |
| [assert-version-can-be-activated.util.ts](../../../packages/twenty-server/src/modules/workflow/workflow-trigger/utils/assert-version-can-be-activated.util.ts) | activation validation | Omni capability classification всего flow, независимо от trigger | T25-F |

WorkflowExecutor.scheduleStepRetry/stepIdsToRetry (файл уже в таблице): для omni отключены на error, publish retryCount>0 rejected; queued retry не снимает intent fence, T14-F. Все CRON/WEBHOOK/MANUAL call sites должны идти через тот же governance ingress до CoreWorkflowRunner; полный call-site inventory — обязательный шаг реализации.

## Lifecycle/restore дополнения R9

- [TrashCleanup](../../../packages/twenty-server/src/engine/trash-cleanup/services/trash-cleanup.service.ts): bypass repository hard delete; omni-owned rows исключаются, Person/Company destroy через lifecycle adapter, T22.
- [Participant FK metadata](../../../packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/compute-message-participant-standard-flat-field-metadata.util.ts): person relation SET NULL не обновляет ExternalIdentity и не заменяет audit/lifecycle.
- Restore fence и invalidation авторизационных sessions/keys — новый operational контракт spec §15.21; механизм текущих auth/session/token issuers проверяется при реализации G12, live rotation сейчас не выполнялась.

## R10 source уточнения

- WorkflowDatabaseEventTriggerListener.getDatabaseEventListeners читает workflowAutomatedTriggerMaps cache; WorkflowTriggerJob legacy path проверяет ACTIVE. Поэтому governed catalog/immutable event snapshot и dispatch обязаны быть durable (spec §15.23).
- [Encryption resolver](../../../packages/twenty-server/src/engine/core-modules/secret-encryption/utils/resolve-encryption-keys-or-throw.util.ts) и [JWT wrapper](../../../packages/twenty-server/src/engine/core-modules/jwt/services/jwt-wrapper.service.ts): legacy encryption и JWT могут использовать один APP_SECRET; restore сначала отделяет effective encryption key, затем rotation/auth checks.

## R11: конечная таблица и обязательная связь до dispatch

- `CachedWorkflowAutomatedTrigger` содержит core/legacy IDs; listener enqueue выбирает legacyWorkflowId??workflowId. Новый ingress нормализует canonical core IDs до keys/сравнений; alias не отдельный consumer.
- `WorkspaceEventEmitter.emitDatabaseBatchEvent` и WorkspaceEventBatch не содержат durable per-record reference. EventCoverageRegistry/referenceRequired требует полного producer inventory до governed activation; empty snapshot также обязателен. Sticky coverage сохраняется после ordinary publish.
- `CoreWorkflowLifecycleService` при publish архивирует прошлую версию, explicit deactivate ставит DEACTIVATED. Новый retained cancellationEpoch различает эти действия и наследуется в workflowCancellationRefs каждой Command; cancel действует на pending и remote journal, не только на runner.
- [Конечные таблицы](../plan/decision-tables.md) и T14/T28 задают ожидаемые outcomes. [Source hashes закреплённой базы](automation-source-hashes.json) проверены; это не реализация новых guards.


## Дополнительные ingress и target writers

WorkflowTriggerController (engine/core-modules/workflow/controllers/workflow-trigger.controller.ts): legacy public GET/POST, отдельный signed governed ingress по webhook-auth. WorkflowCronTriggerCronJob (modules/workflow/workflow-trigger/automated-trigger/crons/jobs/workflow-cron-trigger-cron.job.ts): Redis/now scheduling, новый PG cursor/gap по cron-gap. ParticipantTargetReconciliationService и ReconcilePersonCompanyTargetsJob: native derived targets не projector canonical ConversationTarget; persisted exclusion до mixed batch. См. spec §15.18/15.27, T05/T23/T25-F/T14-E.

WorkspaceMemberWorkspaceEntity + getWorkspaceSchemaName подтверждают dynamic workspace identity: core FK на membership не выдумывается. WorkflowActionType.CLASSIFY и ClassifyWorkflowAction вызывают AiEvaluationService; omni v1 явно deny до отдельного scoped контракта. Эти source files включены в source hashes.
