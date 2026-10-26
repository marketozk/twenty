**Вердикт: needs_revision**

Архитектура в целом согласована и годится как основа. Модель отказов, inbox/outbox, fencing и генерации, единый CommandService, собственный ACL без Enterprise, отдельная схема для аудита, fork-миграции, restore и cutover проработаны и не противоречат друг другу. Ниже три дефекта средней тяжести. В каждом в контракте нет нужного правила, и в допустимой планом конфигурации получается неверный исход. Исправления точечные, переделывать архитектуру не нужно.

## Блокирующие дефекты плана

**F1. medium. Не определён root и бюджет для событий OMNICHANNEL_EVENT, кроме message.received**
- Где: `plan/implementation-spec.md:372`, `:376`, G07 `:224`; `design/09-automation-contract.md:69-77`, `:85`.
- В чём пробел: в v1 четыре вида событий. В таблице корней design/09 есть только Message, DATABASE_EVENT, CRON, WEBHOOK и MANUAL. Бюджет G07 и OmniReplyBudget привязаны к root admission. Для `conversation.created`, `assignment.changed` и `status.changed` не сказано, от какого корня они наследуют бюджет.
- Сценарий: первое входящее сообщение создаёт диалог. Владелец включил два отвечающих процесса: агента на `message.received` и workflow с SEND_OMNI_MESSAGE на `conversation.created`. Если у `conversation.created` свой корень, у него и своя квота. Клиент получает два автоответа на одно обращение, хотя бюджет равен 1. Это нарушает F-04 и смысл G07.
- Минимальная правка: добавить в design/09 §3 строки для этих событий.
  - `conversation.created`, созданный live-приёмом, наследует covered set admission того сообщения, которое его вызвало, и тратит тот же OmniReplyBudget.
  - Если диалог создан импортом или restore, план пустой.
  - Для `assignment.changed` и `status.changed`: rootKind=domain_event, sourceKey=DomainEvent.eventId. Если изменение сделал governed run, событие наследует его causation и бюджет.
- Тест: вариант T27-B. Workflow на `conversation.created` плюс агент на `message.received`, бюджет 1: ровно одна Command, второй производитель получает budget_exhausted и handoff.

**F2. medium. У governed DATABASE_EVENT нет устойчивого каталога подписок**
- Где: `design/09:72` (intent создаётся вместе с CRM mutation, штатный listener исключает этот target); `spec:485` (OmniWorkflowSubscription только для OMNICHANNEL_EVENT).
- Что в исходниках: штатный listener берёт список подписок из кеша `workflowAutomatedTriggerMaps` (`workflow-database-event-trigger.listener.ts:440-462`). Job отбрасывает версию, которая не ACTIVE (`workflow-trigger.job.ts:94`).
- В чём пробел: не указано, откуда транзакция мутации берёт список governed-подписок и чем она сериализована с publish.
- Сценарий: CRM-запись меняется одновременно с публикацией v2 (governed) поверх v1 (обычной).
  - Если транзакция мутации читает кеш, intent не создаётся.
  - Listener после commit уже видит v2 как governed и исключает её.
  - Итог: событие молча потеряно, без видимого gap.
- Минимальная правка: расширить OmniWorkflowSubscription (или аналогичный устойчивый каталог) на все типы триггеров с omni capability. Его читают под WorkspacePolicyState FOR SHARE в транзакции мутации и фиксируют в EventDispatchPlan, включая пустой план. Listener исключает target только по устойчивому признаку версии и никогда не ставит governed-версию в очередь сам.
- Тест: T14-E, publish v2 и v3 между commit мутации и срабатыванием listener: ровно один run или явный пустой план, ноль потерь без следа.

**F3. medium. Не определено, какие изменения данных считаются изменением политики (policyEpoch)**
- Где: `spec:117` (stage), `:119` (revoke: grant/assignment), `:320` (targets), `:432-434` (FOR UPDATE только для grant/role/assignment/target/merge), `:72` (команда привязки Person).
- В чём пробел: видимость зависит от данных записи. Это stage по StageRule (F-08: при переходе в недоступный этап видимость пересчитывается) и связь ExternalIdentity→Person. Ни переход stage, ни link/unlink identity не объявлены policy-мутацией. Правило «revoked ресурс попал в LLM context → turn и send блокируются» срабатывает только при расхождении policyEpoch.
- Сценарий: identity ошибочно связана с Person A, и auto turn уже прочитал данные A. Менеджер исправляет привязку на B. Epoch не меняется, захваченный scope неизменяем, поэтому turn отправляет клиенту B ответ с данными A. Аналогично со сделкой, которую переводят в этап, скрытый от service principal.
- Минимальная правка: завести в §7 и §15.15 каталог атрибутов, от которых зависит политика: stage-поля из StageRule, поля назначения, ExternalIdentity.personId, связи диалога с записями. Их изменение берёт FOR UPDATE и увеличивает epoch. Чтобы не сериализовать весь workspace, допустим отдельный scopeEpoch на ресурс или диалог, который сверяется при каждом tool и send.
- Тест: T10/T13. Unlink identity или скрытие stage во время генерации: 0 sends с данными прежнего ресурса, видимый handoff. Отрицательный контроль: без увеличения epoch тест падает.

## Некритичные дефекты (low)

- **L1. Противоречие в controlEpoch.**
  - Где: `spec:493` («сама отправка не меняет controlEpoch») против `spec:386` (takeover_on_send увеличивает его).
  - Что происходит: в режиме auto второй менеджер с тем же токеном получит conflict.
  - Правка: записать это исключение явно, плюс тест T12.
- **L2. Не определена судьба принятых человеческих Command при переключении human→auto.**
  - Где: `spec:432`, `design/06-api.md:19`.
  - Что происходит: проверка «действующей manager policy» при dispatch либо отклонит уже принятое сообщение (при require_explicit_takeover), либо пропустит его параллельно с AI.
  - Правка: setMode→auto либо отказывает при незавершённых человеческих командах, либо явно их сохраняет, плюс тест.
- **L3. Нет ограничения уникальности для InternalNote.**
  - Где: `spec:54`, поле idempotencyKey без UNIQUE.
  - Что происходит: повторный клик может создать дубль заметки.
  - Правка: UNIQUE(workspaceId, authorMemberId, idempotencyKey).
- **L4. Вложения исходящего не переходят на каноническое Message.**
  - Где: `spec:55`, правило «messageId XOR commandId».
  - Что происходит: когда Command становится Message, не описано, как вложения переходят к нему. Без этого у отправленного сообщения в истории пропадут файлы.
  - Правка: явная операция смены родителя под ACL и аудитом.
- **L5. Runbook restore может сломать расшифровку секретов.**
  - Где: `spec:511`.
  - Факт по исходникам: при пустом ENCRYPTION_KEY шифрование падает обратно на APP_SECRET (`resolve-encryption-keys-or-throw.util.ts:15-25`), а JWT тоже подписываются через APP_SECRET (`jwt-wrapper.service.ts:187-188`).
  - Что происходит: если просто заменить APP_SECRET ради ротации подписи, не расшифруются сохранённые секреты.
  - Правка: шаг runbook «сначала задать ENCRYPTION_KEY равным старому секрету, если он не задан», плюс проверка в T18.

## Будущие runtime-тесты и продуктовые gates (не блокируют план)

- Продуктовое решение для G01/G04: участник диалога без права на сделку видит в общей истории отправленные клиенту автоответы ИИ, где упомянута эта сделка. Это свойство общей переписки, а не обход ACL. Владельцу нужно явно выбрать: принять, сузить scope автоответа или ограничить читателей.
- Удаление workspace (WorkspaceService и DestroySoftDeletedWorkspaceJob) включить в inventory запретов §15.8. Общий запрет плана это уже покрывает, нужен только тест T22.
- Пропуск срабатываний CRON-триггеров после потери Redis для governed-процессов: явно записать поведение как видимый gap, тест T14-E.
- Все T01–T33 и сценарии design/09 остаются будущими проверками. Ни один тест не запускался, runtime-прохождение не заявляю.

## Что прочитано и ограничения

- **Полностью прочитаны:** requirements.md, implementation-spec.md (разделы 1–15.22, G01–G20), design/09, coverage.md, phase_1…phase_7, design 02/05/06/07/08, open-questions.md, license-inventory.md.
- **Сверено с исходниками Twenty:** `workspace-transaction-scope.type.ts`, `upgrade-sequence-reader.service.ts`, `build-row-access-policy.util.ts`, `workflow-database-event-trigger.listener.ts`, `workflow-trigger.job.ts`, `run-workflow.job.ts:81-94`, `connected-account.entity.ts`, `cleaner.workspace-service.ts`, утилиты secret-encryption и JWT. Через grep подтверждены упомянутые в плане символы: PAUSING_TOOLS и AGENT_WAIT_TOOL_NAMES, computeAutomatedTriggerFromWorkflowVersion, scheduleStepRetry, findUsableByCaller, deleteSoftDeletedRecords, EntityEventsToDbListener, PendingWakeUpDatabaseEventListener, MessageParticipantWorkspaceMemberListener. Проверенные фактические утверждения плана совпали с кодом.
- **Не читал целиком:** design/01, 03, 04; integration-map, access-source, ai-workflow-source, transactions-audit-source, automation-source-matrix (только поиск); research-connectors. Кода внешних коннекторов и юзерботов в репозитории нет, их утверждения не проверял.
- По инструкции не открывал cross-review, DEVLOG, STATUS, DOCUMENT-AUDIT и SKILLS-AUDIT.
