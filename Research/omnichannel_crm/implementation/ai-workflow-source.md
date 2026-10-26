# Исходники Twenty: ИИ, workflow и границы исполнения

Дата: 26.10.2026. База исследования: `729f6236126eddaa68d176fb766bc349b19de11d` (snapshot 2.52). Цель — дополнить план постоянной реализации собственной omnichannel CRM проверяемыми точками интеграции.

Это статическое исследование кода, call sites и существующих тестов. Runtime, внешние действия и тесты не запускались; исходники не менялись. На момент чтения `git diff --quiet 729f6236 HEAD -- packages/twenty-server/src/engine/metadata-modules/ai packages/twenty-server/src/modules/workflow` подтвердил совпадение исследованного runtime со snapshot. Тендерный робот не входит в это исследование или план.

Все пути ниже относительно `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\`, кроме явно обозначенных `test/`. Для компактности:

- `AI/` = `engine/metadata-modules/ai/`;
- `WF/` = `modules/workflow/`;
- `TOOL/` = `engine/core-modules/tool-provider/`.

## 1. Итог для реализации

Twenty предоставляет исполняемый агент, проверку принадлежности приложения, пересечение ролей, инструментальный registry, историю turns, атомарное владение AI stream, ожидания/continuation и workflow runner с очередью и восстановлением зависших запусков. Эти механизмы можно переиспользовать.

В исследованной цепочке **не реализован наш контракт** `conversation scope + policy version/epoch + takeover → разрешённый эффект + audit`. В частности, отмена генерации не является откатом CRUD, а блокировка внутреннего AI stream не является запретом отложенной отправки через коннектор. Отсутствует и доверенное import-origin/admission поле в общем database-event dispatch. Эти части должны стать настоящим кодом этапов данных, доступа, команд и ИИ/workflow; их нельзя считать уже доказанными возможностями Twenty.

Проверки ниже добавляются к конечным сервисам и интеграционным suites реализации. Отдельные выбрасываемые прототипы или предварительный автономный стенд не являются условием перехода к разработке.

## 2. AgentRun: принадлежность, роли, scope

| Файл и точка | Статический факт | Следствие |
|---|---|---|
| `AI/ai-agent-execution/services/agent-run.service.ts:188–195`, `run` | При application caller агент обязан принадлежать тому же приложению | Готовая application-bound граница; она не ограничивает исполнение клиентским диалогом |
| Тот же файл `:155–169` | Continued conversation требует application access token и принимает только сообщения роли user | Нельзя произвольно дописать assistant/tool историю через этот API |
| Тот же файл `:218–223` | Thread ID строится из application, agent и thread key | Ключ диалога должен назначаться доверенным серверным адаптером, а не текстом клиента |
| Тот же файл `:668–708`, `resolveRunAsContext` | `runAsWorkspaceMemberId` требует application token; user-bound токен может действовать только как связанный с ним пользователь | Пользователю нельзя подставить другого сотрудника через этот вход; application-only вызов имеет другой уровень доверия |
| Тот же файл `:440–507`, `buildRunExecutionContext` | Перечитывает агента, application и caller/member/API key; формирует agentRunRoleIds и rolePermissionConfig | Есть восстановление роли на сегмент исполнения, но не наша атомарная policy fence |
| `AI/ai-agent-execution/utils/build-agent-role-permission-config.util.ts:4–11` | Возвращает `intersectionOf` ролей caller/application/agent | Переиспользовать native coarse permissions; собственные права на диалоги применяются дополнительно |
| `AI/ai-agent-execution/services/agent-run-turn.service.ts:346–398`, `buildAgentRegistryAccess` | Получает актуальный agent role; при отсутствии роли registry access — none; ToolContext несёт authContext и rolePermissionConfig | Потеря роли не должна превращаться в unrestricted tools; собственная область разговора пока в типе отсутствует |
| `AI/ai-agent-execution/types/agent-run-execution-context.type.ts:12–31` | Контекст содержит auth/actor/role/application/conversationActor, но не conversation policy epoch | Наш trusted domain reference требуется передать через run, tool и continuation отдельно |
| `AI/ai-agent-execution/types/agent-run-spec.type.ts:5–22` | Права не сохраняются в spec: caller восстанавливает их на continuation; сохраняются instructions, capabilities, excluded tools и loading strategy | Не фиксировать вечное разрешение в prompt/spec и не считать snapshot списка инструментов действующим после revoke |

### Какие tools фактически доступны

`AI/ai-agent-execution/constants/open-ended-agent-registry-tool-categories.const.ts` включает `DATABASE_CRUD`, `ACTION`, `DASHBOARD`, `WORKFLOW`.

`AI/ai-agent-execution/services/agent-toolset.service.ts`:

- `:217–239`: catalog mode строит индекс с rolePermissionConfig/application; допустимые tool names ограничены полученным каталогом;
- `:242–261`: granted mode использует explicit grants роли агента и допускает только построенные direct tools;
- `:267–280`: тот же `isToolAllowed` используется meta-tools `learn_tools` и `execute_tool`;
- `:102–120`: предложенный tool call тоже проходит проверку доступности имени.

`AGENT_RUN_EXCLUDED_TOOL_NAMES` исключает несколько конкретных tools, включая `share_record`, но не является белым списком бизнес-действий omnichannel. Подсказка модели, исключение одного специализированного инструмента или запрет в UI не закрывают generic update/upsert/delete.

## 3. Generic mutation и свежесть прав

Подтверждённая цепочка:

```text
AgentRunTurnService.buildAgentRegistryAccess
  → AgentToolsetService / learn_tools / execute_tool
  → ToolRegistryService.resolveAndExecute
  → ToolExecutorService.dispatchDatabaseCrud
  → UpdateRecordService / UpdateManyRecordsService / Upsert / Delete
  → общий query runner / ORM
```

| Точка | Факт |
|---|---|
| `TOOL/services/tool-registry.service.ts:337–370`, `resolveAndExecute` | Получает доступный каталог, ищет entry и передаёт execution в ToolExecutorService |
| `TOOL/services/tool-executor.service.ts:216–272`, `dispatchDatabaseCrud` | Generic update/upsert/delete используют record-crud services, authContext и rolePermissionConfig |
| `engine/core-modules/record-crud/services/update-record.service.ts:71–98` | Проверяет допустимость automation update и вызывает общий query runner |
| `engine/core-modules/record-crud/utils/can-fields-be-updated-by-automation.util.ts:14–65` | Разрешённость объекта для automation либо workspace custom fields на synced object — отдельная проверка; это не conversation policy |
| `TOOL/types/tool-context.type.ts:11–24` | Есть опциональный `resolveExecutionContext`, но нет mandatory доменного scope/epoch |
| `TOOL/services/tool-registry.service.ts:53–76`, `getCatalog` | Использует `resolveExecutionContext`, если callback передан |
| `AI/ai-chat/services/chat-execution.service.ts:150–173` | Ask AI устанавливает resolver контекста |
| `AI/ai-agent-execution/services/agent-run-turn.service.ts:367–383` | AgentRun turn строит ToolContext без такого callback |

Вывод: часть native permissions перечитывается, но это не атомарный контроль отзыва `check → write`. Для omnichannel нельзя ограничиться проверкой в `AgentRunService.run()`: между запуском, генерацией, continuation и mutation могут измениться режим диалога и права сотрудника. Кроме специализированных tools, общий mutation path должен применять ту же доменную политику.

При реализации важно не передать модели возможность изменять `epoch`, `policyVersion`, ответственного, служебный статус исходящего сообщения или actor обычным generic update. Ввод модели является аргументами действия; trusted scope и системные поля формирует сервер.

## 4. Что уже атомарно, а что не является rollback

### Реальное владение внутренним AI stream

`AI/ai-agent-execution/services/agent-runner.service.ts:321–349::withClaimedConversation` получает stream claim перед исполнением.

`AI/ai-chat/services/agent-chat-stream-recovery.service.ts:103–125::tryClaimStream` делает условный update thread с `activeStreamId IS NULL`. При проигрыше claim не начинается.

`AI/ai-history/utils/build-release-stream-claim-query.util.ts:12–23` использует **одну SQL CTE**:

1. сбрасывает activeStreamId только при совпадении thread ID и своего stream ID;
2. завершает running turn только у освобождённого thread.

Вызов — `AI/ai-history/services/agent-turn-recorder.service.ts:218–247::releaseStreamClaim`. Старый владелец не должен снять новый stream claim. Это конкретный паттерн conditional ownership update, пригодный для повторного использования как инженерный подход.

### Реальная отмена генерации

`AI/ai-chat/services/agent-chat-thread-lifecycle.service.ts:34–43::cancelStream` публикует cancel в Redis-канал thread+stream. `agent-turn-stream.service.ts:143–197::runClaimed` подписывается, вызывает AbortController, завершает heartbeat и освобождает claim. При остановке пользователем очередь автоматически не flush-ится.

`AI/ai-agent-execution/services/agent-runner.service.ts:598–601` классифицирует aborted run как failed/stopped. Это результат исполнения агента, а не автоматический откат инструментов.

### Чего здесь нет

- stream claim не связан транзакционно с нашей conversation epoch;
- cancel pub/sub не может вернуть уже закоммиченную CRM mutation;
- cancel генерации не удаляет надёжно уже принятую отдельным dispatcher внешнюю команду;
- для принятого транспортом сообщения не показан механизм отмены/отзыва;
- для всей цепочки tools нет общей компенсационной транзакции.

Поэтому takeover должен самостоятельно и атомарно менять доменный epoch/режим и блокировать будущие эффекты. Отмена Twenty stream полезна для прекращения лишней работы, но не является единственной защитой.

## 5. Database events, импорт и workflow

### Текущий dispatch

`engine/workspace-event-emitter/types/workspace-event-batch.type.ts:3–9` содержит `name`, `workspaceId`, `objectMetadata`, `events`. `workspace-event-emitter.ts:42–70::emitDatabaseBatchEvent` формирует именно эти поля и вызывает EventEmitter2.

В просмотренной цепочке нет доверенных `origin`, `import`, `suppressAutomation` или omnichannel admission marker.

`WF/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts`:

- `:84–95` подписывается на все object `CREATED`;
- аналогично обрабатывает UPDATED/DELETED/DESTROYED/UPSERTED;
- `:329–345::shouldIgnoreEvent` проверяет наличие workspace/event name;
- `:483–538::resolveAdmittedEvents` применяет record-access/application-role admission;
- `:417–434` проверяет trigger filters и ставит отдельный WorkflowTriggerJob с `retryLimit: 3`.

В этом месте отсутствует проверка import-origin. Ограничение `shouldAssistantReply` на уровне AI Inbox не выключает обычные record triggers. Для нашего импорта подавление должно доходить до этой общей границы, а не существовать только в UI или в новом AI consumer.

### Dispatch и version guard

`WF/workflow-trigger/jobs/workflow-trigger.job.ts:35–117` выбирает core/legacy dispatch, проверяет существование версии, принадлежность workflow и `CoreWorkflowVersionStatus.ACTIVE`; затем вызывает CoreWorkflowRunnerService.

`utils/resolve-workflow-trigger-dispatch-mode.util.ts` выбирает core при наличии `coreWorkflowVersionId`, иначе legacy. Это совместимость версий dispatch, не origin/admission policy.

Следствие для плана: metadata версии проверяется повторно, но policy epoch клиентского диалога не сохраняется и не проверяется этой механикой.

## 6. Workflow execution context и опасная fallback-ветка

`WF/workflow-executor/services/workflow-execution-context.service.ts`:

- `:96–105`: acting-on-behalf-of-user включается только для `createdBy.source = MANUAL` с workspaceMemberId;
- `:107–130`: получает userWorkspaceRoleMap, строит rolePermissionConfig; отсутствие роли даёт FORBIDDEN;
- `:154–174`: иначе выполняет bound application либо standard application context;
- `:218–244`: при отсутствии defaultRoleId стандартного приложения ищет **Admin role** как legacy fallback.

Это штатное поведение обычного Twenty workflow, а не ошибка, которую нужно произвольно менять для всех пользователей. Но conversation-triggered run не должен после потери своего trusted context попадать в эту ветку и продолжать с более широкой областью.

`WF/workflow-executor/workspace-services/workflow-executor.workspace-service.ts:570–626::executeStep` отмечает шаг RUNNING, проверяет доступность типа/action и вызывает `workflowAction.execute` с workflowRunId/workspaceId. Собственный domain scope нужно получать по доверенному run reference и проверять на action boundary, включая record CRUD, send и code/logic-function paths, которые способны породить эффект.

`WF/workflow-executor/workflow-actions/tool-backed/tool-backed.workflow-action.ts:73–104` исполняет tool, затем сохраняет log. Запись шага/log сама по себе не доказывает транзакционную целостность нашего эффекта и audit.

## 7. Очереди, повтор и восстановление

| Точка | Что реально происходит |
|---|---|
| `WF/workflow-runner/services/core-workflow-runner.service.ts:115–163` | Создаётся workflow run; manual получает ENQUEUED, automated — NOT_STARTED; затем ставится RunWorkflowJob либо enqueue job |
| `WF/workflow-runner/workflow-run-queue/workspace-services/workflow-run-enqueue.workspace-service.ts:79–124` | Выбирает NOT_STARTED, устанавливает ENQUEUED/enqueuedAt, затем добавляет jobs |
| `WF/workflow-runner/utils/build-run-workflow-job-options.util.ts:3–9` | Job id = workflowRunId; используется duplicate handling для этого run |
| `WF/workflow-runner/workflow-run-queue/workspace-services/workflow-handle-staled-runs.workspace-service.ts:69–89` | Старые ENQUEUED возвращаются в NOT_STARTED |
| `WF/workflow-runner/workflow-run-queue/utils/get-staled-runs-find-options.util.ts:9–17` | Stale определяется ENQUEUED и старым/null enqueuedAt |
| `WF/workflow-runner/jobs/run-workflow.job.ts:230–245` | Awaited step остаётся PENDING до claim; повторная доставка уже claimed step не должна выполнить его снова |

Смена DB status и добавление BullMQ job здесь **не одна транзакция DB+Redis**. Есть механизмы восстановления, но их нельзя назвать exactly-once внешнего эффекта.

В CREATED listener не задаётся устойчивый omnichannel event ID или deterministic workflowRunId. Поэтому одинаковый job ID внутри одного run не доказывает, что повтор внешнего события не создаст второй run. Собственный durable AutomationAdmission/consumer и CommandService должны связывать внешнее событие, workflow/action ID и одну команду отправки.

### Остановка workflow не равна rollback

`WF/workflow-runner/workflow-run/workflow-run.workspace-service.ts:167–223::endWorkflowRun` под `@WithLock` фиксирует terminal status, завершает running step infos, отменяет waits и освобождает suspended agent callers. Cleanup waits/conversations — best-effort после изменения статуса.

Отмены уже исполненных CRUD, HTTP-запросов или принятой транспортом отправки в этой функции нет. Для rollback наших изменений режим human + новый epoch закрывает будущие эффекты; уже совершённые действия сохраняются в истории и аудите.

## 8. Обязательные изменения в конечной реализации

Ниже — точки patch для плана, а не утверждение, что код уже написан. Финальная схема транзакций сверяется с общей картой transaction ownership.

| Файл / граница | Изменение |
|---|---|
| Новый `modules/omnichannel/ai/conversation-agent.service.ts` | Создание серверного execution reference: workspace/conversation/actor/application, policy version, epoch, causation/input event ID. Привязка AgentRun и continuation к нему |
| Новый `modules/omnichannel/ai/conversation-tool-policy.ts` + domain CommandService | Проверка права и области конкретного диалога. Mutation, актуальный epoch и собственный audit выполняются под одной DB transaction/fence с takeover/revoke |
| `AgentRunExecutionContext`, `ToolContext`, `AgentRunTurnService`, `ToolExecutorService` | Передача trusted reference через runner/continuation/tool dispatch; отсутствие обязательного scope для omnichannel — отказ. Generic CRUD получает ту же политику и transaction context |
| Общая mutation boundary record-crud/query runner/ORM | Защита от обхода через generic update/upsert/delete, прямые API и code/logic functions. Блокировка записи служебных полей и применения stale epoch. Конкретный transaction owner — из общего исследования ORM |
| `WF/workflow-executor/services/workflow-execution-context.service.ts` и executor `executeStep` | Mandatory domain scope для conversation-triggered runs, повторная проверка перед эффектом, отсутствие перехода в standard/Admin fallback при потере scope |
| `WorkspaceEventBatch`, `WorkspaceEventEmitter`, workflow database-event listener | Серверный origin/admission contract, import suppression на общей dispatch-границе CREATED/UPDATED; внешний payload не назначает себе origin или права |
| Новый `modules/omnichannel/workflow/` admission/consumer/actions | Durable обработка события с unique consumer key и устойчивым run/command ID. Action «Отправить в диалог» использует единый CommandService |
| Собственный takeover/outbox/dispatch | Атомарная смена epoch/режима, блокировка ещё не принятых команд, проверка lease/epoch на dispatch boundary. Cancel stream — вспомогательное действие |

Только `additionalExcludedToolNames`, роли Twenty или prompt-инструкции не покрывают эти требования. При этом native providers, agent runner, role intersection, history и workflow graph не требуется заменять второй LLM-платформой.

## 9. Тесты: существующие и необходимые

### Найденные существующие suites

Пути ниже относительно корня `packages/twenty-server/`:

- `test/integration/ai/suites/agent-run-wait.integration-spec.ts`: continuation, busy conversation, последовательные waiters, восстановление dead holder, delayed wake-up;
- `test/integration/ai/suites/agent-chat-stream-state.integration-spec.ts`;
- `test/integration/ai/suites/agent-turn-context.integration-spec.ts`;
- `test/integration/graphql/suites/user-session/successful-agent-run-conversation-for-caller.integration-spec.ts`;
- `src/modules/workflow/workflow-trigger/automated-trigger/listeners/__tests__/workflow-database-event-trigger.listener.spec.ts`: role admission, отсутствующая роль/удалённое/устанавливаемое приложение, CREATED и watched fields;
- `src/modules/workflow/workflow-runner/jobs/__tests__/run-workflow.job.spec.ts`: повторная доставка claimed step и отсутствующий run;
- существующие `test/integration/graphql/suites/object-records-permissions/*` для общих read/write и related-record ограничений.

Они изучены статически, **не запущены** в этом исследовании. Они не подтверждают ещё не реализованные omnichannel epoch/import/dispatch гарантии.

### Добавить к постоянным integration suites реализации

1. Остановить настоящий generic mutation между check и write; конкурентный takeover выигрывает — stale mutation и audit не коммитятся. Проверить обратный порядок и отсутствие deadlock. Тестировать конечный сервис/транзакцию, не отдельную имитацию механизма.
2. Отозвать role/policy во время генерации и перед continuation: последующие read/mutation/send отклоняются, чужие данные не попадают в tool output.
3. Потерянный trusted scope в queued workflow/tool/function даёт отказ; standard/Admin fallback не используется для такого run.
4. Imported CREATED/UPDATED не запускают generic workflow, ИИ и отправку. Live событие после activation допускается; payload не может подделать origin.
5. Два worker, повтор ingress и crash/replay используют одного consumer и один command ID. Переисполнение workflow не означает новую отправку.
6. После takeover отменяются будущие AI actions и непереданные команды. Уже accepted внешняя отправка остаётся правдиво отражённой; неизвестный внешний результат не пересылается автоматически.
7. Scope нельзя обойти через `execute_tool`, generic CRUD, API, code/logic function или связанную запись. Системные actor/epoch/status поля не задаются аргументами модели.
8. Реальный эффект и audit commit/rollback проверяются вместе. Step log или агентский ответ «успешно» не подменяют audit совершённой mutation.

## 10. Граница подтверждённого

Подтверждены существующие роли, tool dispatch, stream ownership, cancellation, workflow admission/queues/recovery и указанные пределы. Не подтверждены runtime-настройки текущего экземпляра, работоспособность будущих omnichannel сервисов или атомарность ещё не написанной domain fence.

Закрытие этих пунктов — разработка и интеграционная проверка конечных компонентов по плану. Их нельзя помечать выполненными на основании этого статического документа.
