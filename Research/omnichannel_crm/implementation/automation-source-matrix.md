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
