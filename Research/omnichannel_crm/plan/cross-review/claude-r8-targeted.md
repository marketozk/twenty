# Целевая проверка автоматизации после R7: H-3 / N-3 / M-7 / M-13

**Вердикт: needs_revision.** Закрыт только M-7. По H-3, N-3 и M-13 в исходниках Twenty нашлись пути, которые обходят новый механизм. Это вердикт только по этим четырём темам, а не по всему проекту.

## 1. H-3: закрытый каталог инструментов, токены, без sandbox. Статус: **open**

Сама норма сформулирована правильно: неизвестный инструмент запрещён, generic token не выпускается (`09-automation-contract.md:24,35,37`, `implementation-spec.md:142`). Но в коде есть два пути, на которых механизм «запрет в executor» не срабатывает.

**H-3a. High. Шаги CODE/LOGIC_FUNCTION/HTTP в omni workflow.**
- **Что в коде.** Шаги CODE и LOGIC_FUNCTION вызывают `LogicFunctionExecutorService` (`code.workflow-action.ts`, `logic-function.workflow-action.ts`). Он выпускает обычный `generateApplicationAccessToken`, а при наличии пользователя ещё и delegated token (`logic-function-executor.service.ts:403-427`).
- **Противоречие в плане.** В `09:37` написано «omni v1 не выпускает generic application access tokens». При этом `implementation-spec.md:482` упоминает «произвольный HTTP/code step» внутри omni run, то есть такие шаги молча допускаются. Allowlist типов шагов для OMNICHANNEL_EVENT нет ни в spec, ни в source matrix.
- **Сценарий.** Администратор публикует omni workflow с шагом CODE. Входящее сообщение запускает его. Код получает токен приложения с правами всей роли, и захваченный ResourceScope диалога (`spec:264`) уже ни на что не влияет. Тот же путь открыт и для обычного workflow, который запускается как «approved workflow» из omni-агента (`09:32`).
- **Минимальная правка.** Ввести allowlist workflow actions для любого исполнения под omni execution reference, а не только по типу триггера. CODE, LOGIC_FUNCTION, HTTP_REQUEST и SEND_EMAIL запрещены в v1, пока у них нет своей capability-записи. Проверка нужна дважды: при publish (`assertVersionCanBeActivated`) и в executor перед каждым шагом. Добавить строки в source matrix.
- **Будущий oracle.** Publish omni workflow с CODE или HTTP даёт validation error. Если такой шаг подложен напрямую или пришёл из дочернего обычного workflow, executor отказывает, а spy на `generateApplicationAccessToken` показывает 0 вызовов. Контрольный случай: обычный не-omni CODE workflow работает как раньше.

**H-3b. Medium. Нативные инструменты провайдера (webSearch, xSearch).**
- **Что в коде.** Эти инструменты попадают в набор в `agent-toolset.service.ts:143-151` через `getNativeModelTools` (`ai-model-config.service.ts:42-101`) по флагу `agent.modelConfiguration.webSearch` (`agent-run-turn.service.ts:160-164`). Исполняет их сам провайдер, поэтому серверный executor и registry вызова не видят.
- **Пробел в плане.** Ни `09`, ни source matrix этот путь не перечисляют, T25-A его не покрывает.
- **Сценарий.** Агент auto с включённым webSearch отправляет поисковый запрос с текстом клиента или CRM-данными внешнему провайдеру.
- **Минимальная правка.** На omni-пути собирать набор с `nativeToolOptions = {}`. Если в конфигурации агента включён webSearch или twitterSearch, auto activation отклоняется. Добавить строку в matrix.
- **Будущий oracle.** Для агента с webSearch.enabled список отправленных в omni turn инструментов не содержит нативных имён. Если убрать фильтр, тест становится красным.

## 2. N-3: все пути pausing в runner. Статус: **open** (узко)

- **Что в коде.** Блок pausing tools собирается отдельно от registry (`agent-toolset.service.ts:123-141`): `waitTools` плюс `ask_question`, `request_form` и `propose_tool_call` по флагу `canAskHumans`. Поэтому `excludedToolNames` на эти имена вообще не действует (фильтр работает только в `:178-255`).
- **Путь workflow.** Шаг AI agent в workflow включает `canAskHumans`, если заполнены `humanInputInstructions` (`build-workflow-agent-run-spec.util.ts:18-32`). Дальше вызывается `AgentRunnerService.start` (`ai-agent.workflow-action.ts:146-153`), который всегда передаёт `createAgentWaitTools()` и `canAskHumans` из spec (`agent-runner.service.ts:529-530`).
- **Пробел в плане.** `09:39` и `spec:358` запрещают union имён и задают `pausingTools: []`, но source matrix (`automation-source-matrix.md:15-17`) не называет ни `canAskHumans`, ни шаг AI agent в workflow.
- **Противоречие.** `spec:478,480` разрешает omni workflow «legitimate WAIT/delay/form/wait-for-event» и исключает такие run из stall-сканера. Не определено, что делает шаг AI agent с `humanInputInstructions` в omni workflow: запрещён (09:39) или это допустимое ожидание (§15.19).
- **Сценарий.** Omni workflow с AI-шагом, у которого заполнено поле «вопрос человеку». Агент вызывает `ask_question`, run висит в ожидании.
- **Минимальная правка.** Под omni execution reference любой вызов AgentRunner, включая AI-шаг workflow, получает `canAskHumans = false` и пустые `waitTools`. Publish omni workflow с `humanInputInstructions` отклоняется. Явно записать, что §15.19 разрешает ожидания только на уровне шагов workflow (FORM/DELAY), а не pause агента. Добавить строки в matrix.
- **Будущий oracle.** Расширить T27-A: для omni AI-шага с `humanInputInstructions` `offeredPausingToolNames` пусто и `isPaused` = false. Если снять override, тест красный.

## 3. M-7: неизменяемый EventDispatchPlan, стабильный workflowId, lifecycle и cleaner. Статус: **closed_in_plan**

Что подтверждено по исходникам:
- **Стабильная идентичность.** consumerId и runId строятся от workflowId, версия только в payload (`09:43`, `spec:48-49,367`). Это реализуемо: `CoreWorkflowRunnerService.run` принимает `coreWorkflowVersionId` и `workflowRunId` (`core-workflow-runner.service.ts:48-59`), а `RunWorkflowJob` берёт flow из `run.state` и ищет версию по id без проверки статуса (`run-workflow.job.ts:126-148`).
- **Архивация v1 не ломает pinned target.** Активация v2 переводит v1 в ARCHIVED (`core-workflow-lifecycle.workspace-service.ts:271-292`). Это совместимо с `09:47`, потому что run исполняет сохранённый flow.
- **Cleaner.** Он удаляет только COMPLETED/FAILED (`workflow-clean-workflow-runs.job.ts:76-140`). Это закрыто правилом `09:49`: canonical intent и tombstone остаются.

**Дополнительный дефект M-7a. Medium. Штатная кнопка «Retry» обходит replayRequestId.**
- **Что в коде.** `retryWorkflowRun` (`workflow-runner.workspace-service.ts:289-375`) доступен через resolver (`workflow-trigger.resolver.ts:64`) и пункт command menu. Он переводит FAILED run в RUNNING и заново ставит в очередь упавшие шаги с тем же runId.
- **Почему защиты плана не хватает.** Fence в executor (`spec:478`) проверяет terminal disposition. Атомарная запись disposition вместе с FAILED обещана только для hard-throttle (`spec:443`). Обычная ошибка ставит native FAILED в `run-workflow.job.ts:86-94` отдельно от intent.
- **Сценарий.** Шаг с внешним эффектом упал после возможного commit. Пока disposition ещё не записан, пользователь жмёт Retry, и шаг исполняется повторно без replayRequestId. Если disposition уже записан, исполнения не будет, но native run навсегда остаётся RUNNING.
- **Минимальная правка.** Для run с omni intent `retryWorkflowRun` и command menu отклоняются либо перенаправляются в операцию replayRequest (`spec:443`). Любой native FAILED на omni run записывает disposition в той же транзакции. Добавить строку в matrix.
- **Будущий oracle.** T14-D: Retry omni run в окне до disposition и после него. Результат: 0 повторных шагов, видимый отказ или новый replayRequestId, native-статус не застревает в RUNNING.

## 4. M-13: общий бюджет root admission, burst и descendants. Статус: **open**

Общая квота, уникальный slot и запрет обхода через stepId или версию описаны последовательно (`09:55`, `spec:268`, `spec:152`). Не хватает двух вещей.

- **Burst-ответ «всё или ничего» оставляет клиента без ответа.** `09:57` требует атомарно занять slot каждого покрытого admission, без частичного commit. `spec:270` при этом обещает, что burst-тесты подтвердят отсутствие starvation.
  - **Сценарий.** maxReplies = 1. Workflow на B уже ответил и занял slot B. Turn агента, покрывающий A и B, не может получить весь набор. Ответа нет ни на A, ни на B. План не задаёт, что дальше: новый turn только на A или видимая эскалация.
  - **Минимальная правка.** Если при резервировании хотя бы один admission исчерпан, turn до dispatch заменяется новым bounded turn, который покрывает только admissions с остатком квоты. Если таких нет, видимое budget_exhausted и handoff.
  - **Будущий oracle.** T27-D: A+B, B занят workflow. Итог: один ответ, покрывающий только A, либо видимая эскалация. Молчаливого «нет ответа» быть не должно.
- **Descendants burst-turn.** `09:32` говорит о наследовании одного root admission. Для turn с набором admissions не определено, какой набор slots получает дочерний workflow или агент.
  - **Минимальная правка.** Descendant наследует зафиксированный covered set родителя, и каждая его отправка списывает slots по тому же правилу атомарности.
  - **Будущий oracle.** T27-C дополнить сценарием «дочерний workflow burst-turn».

## Мелкая документальная нестыковка

- **Low.** `06-api.md:66` описывает передачу scope через logic function, а `09:35` запрещает исполнение logic function на omni-пути. Минимальная правка: удалить упоминание logic function в `06-api.md:66` или сослаться на `09` §2.

## Прочитанные файлы

- **План.** Целиком прочитаны `Research/omnichannel_crm/design/09-automation-contract.md`, `implementation/automation-source-matrix.md`, `plan/implementation-spec.md`, `design/05-models.md`, `design/06-api.md`. Из `requirements.md` прочитаны найденные поиском фрагменты: R-06, R-10, F-04, F-06, критерии результата.
- **Исходники Twenty, pausing и агент.** Каталог `packages/twenty-server/src/`: `engine/metadata-modules/ai/ai-agent-execution/pausing-tools/constants/{pausing-tools,agent-wait-tool-names}.constant.ts`, `constants/agent-run-excluded-tool-names.const.ts`, `services/{agent-toolset,agent-run-turn,agent-runner}.service.ts` (agent-runner частично), `ai-models/services/ai-model-config.service.ts` (по поиску).
- **Исходники Twenty, токены и MCP.** `engine/core-modules/logic-function/logic-function-executor/logic-function-executor.service.ts` (фрагмент), `engine/api/mcp/services/mcp-tool-executor.service.ts`.
- **Исходники Twenty, workflow.** `modules/workflow/workflow-executor/workflow-actions/ai-agent/{utils/build-workflow-agent-run-spec.util.ts,ai-agent.workflow-action.ts}`, `modules/workflow/workflow-runner/{jobs/run-workflow.job.ts,workflow-run-queue/jobs/workflow-clean-workflow-runs.job.ts,workspace-services/workflow-runner.workspace-service.ts,services/core-workflow-runner.service.ts}`, `engine/core-modules/workflow/services/core-workflow-lifecycle.workspace-service.ts`. Плюс поиск по `canAskHumans`, `generateApplicationAccessToken` и `retryWorkflowRun`.

Отчёты прошлых ревьюеров и registry не открывал. Код не менял, карточку задачи по вашей просьбе не обновлял.
