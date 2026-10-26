# Вердикт: **needs_revision**

План в целом связный и сильный. Модель отказов, inbox/outbox, receipts, fencing, own ACL, аудит, fork-миграции и restore/cutover доведены до проверяемых контрактов, и почти все утверждения о коде, которые я сверил, подтвердились. Но я нашёл одну блокирующую дыру в контракте автоматизации и одну среднюю: в ней сталкиваются два правила плана. Обе достижимы штатными действиями администратора или менеджера, без выхода за модель отказов.

## Блокирующие дефекты плана

### F1. High: отправка клиенту из workflow, который запущен не событием omni, не покрыта ни бюджетом, ни scope, ни закрытой таблицей действий

**Где:** `plan/implementation-spec.md:142`, `:154`, `:418`, `:471`; `design/09-automation-contract.md:43-45`, `:53-55`, `:67`.

**Что не так.** Закрытая `OmniWorkflowActionPolicy` применяется только к исполнению «с omni reference». Проверку при publish план описывает только для `OMNICHANNEL_EVENT` и approved child target (design/09:45). Слот ответа привязан к `rootAdmissionId` (spec:154, design/09:67). При этом `SEND_OMNI_MESSAGE` задуман как обычное действие workflow (spec:471), а F-06 прямо требует сценарий «изменение этапа сделки → задача → уведомление клиенту».

**Контрпример.** Администратор публикует workflow с триггером `DATABASE_EVENT opportunity.updated` (или `WEBHOOK`/`CRON`). Шаги: `AI_AGENT` с широкой ролью приложения и включённым webSearch, затем `SEND_OMNI_MESSAGE(conversationId)`.
- Publish проходит: триггер не `OMNICHANNEL_EVENT`, по таблице действий поток не проверяется.
- При запуске omni reference нет. Значит, `AI_AGENT` работает без closed registry, с native tools и чтением чужих клиентов, то есть ровно то, что запрещает T25.
- На шаге отправки CommandService определяет класс отправителя как AI. В режиме auto правило звучит «по current auto policy и captured scope/epoch», но captured scope нет, а `rootAdmission`, по которому резервируется слот, тоже нет.

Контракт не говорит, отказ это или разрешение. Если разрешение, то возможна утечка данных других клиентов в ответ и неограниченные отправки: внешний webhook, цикл opportunity.updated → update. Если отказ, второй пример F-06 нельзя реализовать.

**Минимальная правка плана:**
- Workflow-версия, содержащая `SEND_OMNI_MESSAGE` или любую другую omni capability, считается omni-governed независимо от типа триггера. На publish/activation весь поток проверяется по `OmniWorkflowActionPolicy`.
- Executor отклоняет `SEND_OMNI_MESSAGE`, если нет серверного omni reference.
- Для триггеров без admission при старте создаётся durable root: RunIntent с `rootExecutionId = UUIDv5(workspace, triggering event/record revision, workflowId)`, trusted reference с явной service policy (scope = conversation + запись триггера) и бюджет на этот root. `OmniReplyBudget` обобщается с ключа по admission на ключ `rootKind + rootId`. Включение — через G07/G17.
- Либо явно зафиксировать для v1: отправки без admission допускаются только как G17-шаблон без AI-контента.

**Тест:** вариант T14/T25 для `DATABASE_EVENT`, `CRON`, `WEBHOOK` и `MANUAL` с `AI_AGENT`, `CODE` и `SEND_OMNI_MESSAGE`.
- publish без omni-governance отклоняется;
- scope не расширяется (X не читает Y);
- бюджет исчерпывается с видимым handoff;
- цикл update → trigger ограничен;
- обычные workflow без omni-шагов ведут себя как раньше.

### F2. Medium: штатный merge Person конфликтует с запретом generic-мутаций omni-участников и с подавлением событий

**Где:** `plan/implementation-spec.md:248` (§15.1: generic update omni Participant запрещён вне доменной команды), `:260` (§15.2: lifecycle adapter переводит только ExternalIdentity), `:311` (§15.6: omni-строки пишутся с `shouldSkipEventEmission`).

**Источник:** `common-merge-many-query-runner.service.ts:375-436`. `mergeRelatedRecordsIntoPriorityRecord` берёт `transactionScope.getRepository(alias, rolePermissionConfig)` без skip-опции и через `runMutation` переписывает все MANY_TO_ONE-связи, указывающие на сливаемую Person. Среди них `messageParticipant.personId`: у Person есть связь `messageParticipants`, см. `person.workspace-entity.ts:50`.

**Сценарий.** Менеджер штатно сливает P1 (у неё есть история Telegram) с P2. Это ровно F-03, объединение каналов на карточке. Исхода два, и оба плохие:
- guard из §15.1 срабатывает, и merge любой Person с перепиской падает целиком. Получается регрессия F-03.
- guard обойдён, и уходит generic `messageParticipant.updated` с handle/displayName/messageId omni-чата в webhook, DATABASE_EVENT workflow и SSE. Это нарушает §15.6.

План не выбирает ни один вариант.

**Минимальная правка:** в §15.2 lifecycle adapter включить перенос omni-owned строк, ссылающихся на Person/Company (messageParticipant и target associations), через `withOmniRepositoryOptions` с аудитом в том же executor. В CommonMergeMany исключить omni-owned строки из generic-миграции и передать их адаптеру. Guard §15.1 разрешает только этот адаптер.

**Тест (расширение T23):** merge Person со смешанными email- и omni-участниками.
- merge проходит;
- omni-участники перенесены, generic omni-событий 0;
- email-участники мигрируют с прежними событиями;
- rollback сохраняет обе стороны.

## Небольшие правки (не блокируют)

- **F3. Low.** Watchdog (`implementation-spec.md:482-484`) признаёт законными ожиданиями только FORM, DELAY и WAIT_FOR_EVENT. Но в upstream есть свой автоповтор шагов: `workflow-executor.workspace-service.ts:186-198` и `scheduleStepRetry` на `:751-780`, это отложенная задача в Redis с задержками `STEP_RETRY_DELAYS_MS = [1s, 5s, 15s]`. Этого пути нет ни в inventory, ни в T14. Нужно:
  - добавить путь `stepIdsToRetry` в inventory;
  - определить, что задержка повтора продлевает lease или считается durable wait, иначе возможен ложный stall;
  - зафиксировать, что номер попытки не входит в effect key. Сейчас ключ `executionId+stepId+iteration` это и так соблюдает.

  Тест: шаг с retryCount > 0 под omni reference, сбой, повтор и потеря Redis во время задержки. Ожидается один эффект и либо продолжение, либо видимый stalled.
- **Производительность.** `WorkspacePolicyState FOR SHARE` на каждом обычном чтении (§15.15) пишет в одну строку на workspace (multixact). Это не ошибка корректности, но стоит измерить в T19.

## Runtime-тесты и продуктовые gates (не дефекты плана)

- T01–T33 и T25-A…T28-A ещё не созданы и не запускались. Прохождение я не заявляю.
- Gates G01–G18 корректно блокируют только активацию и не подменяют решения владельца: роли, аккаунты, QR, провайдер ИИ, externalHumanReplyPolicy, managerReplyPolicy, бюджет и responders, queue и custodian, импорт и retention, нагрузка, backup, хостинг, изоляция тестов, разделение ролей БД, вебхуки, G17, лицензионная проверка, AGPL §13.
- Mapping native-ключей MAX и Telegram для выбранных ревизий, capability matrix и inventory функций SaleBot — проверки перед включением адаптеров и cutover.

## Что сверено в исходниках `729f6236`

Подтвердилось:
- `WorkspaceTransactionScope.getRepository(name, rolePermissionConfig, {shouldSkipEventEmission})`; `emitMutationEvent` при skip ничего не отправляет (`workspace-repository.ts:2069`).
- `saveMessagesWithinTransaction` и `saveMessageParticipants` принимают scope; глобальный lookup по `headerMessageId` объясняет namespaced-ключ из §15.10. `matchParticipants` принимает `transactionScope`. APP-канал в aggregate идёт с `targetsOnly` после commit.
- `UpgradeSequenceReader` группирует fast → slow → workspace.
- `RunWorkflowJob` ловит исключение и вызывает `endWorkflowRun(FAILED)` (`:81-94`), а `incrementTriggerMetrics` бросает ошибку на неизвестном триггере.
- `retryWorkflowRun` переводит FAILED → RUNNING и ставит задачу в очередь.
- `build-row-access-policy.util.ts` импортирует `buildRecordShareGate`.
- `computeAutomatedTriggerFromWorkflowVersion` существует.

## Покрытие чтения и ограничения

Прочитаны полностью: requirements, implementation-spec (все 491 строки), design/09, coverage, phase_1–7, design 05/06/07/08, open-questions, license-inventory, automation-source-matrix, раздел workflow в design/02. По коду смотрел точечно: ORM scope и repository, messaging save/participant, merge runner, workflow job/executor/runner, upgrade reader, row access policy.

Не читал: cross-review, DEVLOG, STATUS, аудиты и прочие отчёты рецензентов (по условию), а также integration-map, access-source, transactions-audit, research-connectors и внешние репозитории коннекторов. Поэтому утверждения о Python-коннекторах, MAX journal и Telegram history не проверял. Инструменты runtime не запускал.
