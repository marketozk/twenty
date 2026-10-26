# Независимое ревью технического плана omnichannel CRM (пакет r16)

## Вердикт: `needs_revision`, правка узкая

Блокеров нет: в модели отказов спецификации §1 не нашёл ни одного противоречия уровня Critical или High. Архитектура отказоустойчивости, прав, аудита, governance ИИ и workflow, импорта, restore и cutover согласована и опирается на реальные точки кода.

Правка всё же нужна. Индекс владельцев (`contracts/README.md`) требует, чтобы производные документы не задавали своей семантики. Я нашёл 3 расхождения средней тяжести между §3 (единственным владельцем сущностей) и производными API/контрактами, плюс 7 мелких. Ни одно не требует менять архитектуру. Все правятся у владельца одним проходом. ROB-764 затрагивают только F3 (поле revision у ExternalIdentity) и F4 (формулировка FK у ConversationReadCursor).

Это оценка готовности плана к реализации. Это не runtime-проверка и не разрешение на выкат: новых тестов T01–T33 нет, gates G01–G20 не выбраны, и это ожидаемо.

---

## 1. Матрица покрытия

| Область | Что прочитано | Итог |
|---|---|---|
| Требования и решения | `requirements.md`, `decisions.md`, `open-questions.md`, `coverage.md` | Покрыто. Каждое требование R и F сопоставлено с разделами спецификации и тестами T. Потерянных требований не нашёл |
| Индекс владельцев и консолидация | `contracts/README.md`, все 3 контракта целиком, спецификация §1–§15.27 целиком, `design/09` | Все якоря, на которые ссылаются спецификация и `09`, существуют. Уникальные правила при переносе не потеряны. Расхождения с владельцем: F1, F3, F5, F7 |
| Схема, inbox/outbox, надёжность транспорта | Спецификация §3–§5, §15.7, §15.16, §15.27; `sending-ui` | Покрыто. Пробелы: F1, F2, F3, F4 |
| Права: tenant, строки, поля, этапы | `access-control.md`, спецификация §7, §15.5–§15.6, §15.12–§15.15, §15.17–§15.18; `phase_3`; `access-source.md` | Покрыто; самый проработанный раздел |
| Аудит и производные пути чтения | Спецификация §6, §15.27; `design/08`; `phase_2`; `transactions-audit-source.md` | Покрыто |
| UI и коннекторы | `sending-ui#ui`, §8, §15.7, §15.25; `phase_4`; `research-connectors.md` | Контракт покрыт. Код внешних коннекторов в пакете отсутствует (см. §4) |
| ИИ, инструменты, governance workflow | `workflow-execution.md`, `access-control#scope/#sender-mode/#takeover`, `phase_5`, `ai-workflow-source.md`, `automation-source-matrix.md` | Покрыто. Пробелы: F1, F2, F8, F10 |
| Вложения, edit/delete, история | §10, §15.2, §15.16, §15.23, §15.25; `phase_6` | Покрыто |
| Миграции, restore, cutover | §12, §15.4, §15.5, §15.8, §15.19, §15.21, §15.24–§15.25; `phase_7`; `phase_0` (только как контекст) | Покрыто как runbook. Живая проверка не заявлялась |
| Этапы, зависимости, тесты | `phase_0`–`phase_7`, §11, §14, `decision-tables.md`, `check_decisions.py` (строки 1–120), `model-result.json` | Порядок согласован: 764 → 765 → 766 → (767+768) → (769+770) → 771. Зависимости этапов 4 и 6 сходятся с §14. Модель честно ограничена: 1712 случаев, `runtime_tests: false` |
| Серверные точки интеграции | См. §3 ниже | Ключевые факты плана в коде подтверждаются |
| Фронтенд | Workflow-триггеры и действия, `sse-db-event` | Точки существуют. Комментарий в §3 |

Прочитал не полностью: `bypass-candidates.md` (только заголовок и первые строки; это список кандидатов), `upstream-2.52.json` и `automation-source-hashes.json` (не читал), `check_decisions.py` после строки 120. Свёрку хешей не делал: по REVIEW_SCOPE её выполняет автор.

---

## 2. Находки

### F1 — Medium. Нет сущности версионированной политики автоматизации у владельца схемы
- **Где:** `design/06-api.md:38` (`updateAutomationPolicy`), `access-control.md:17` (`automationPolicyVersion`), `access-control.md:59` («явная route automation policy»), `workflow-execution.md:91` («automation policy ID»). При этом в таблице сущностей `implementation-spec.md:40-87` такой сущности нет. Есть только колонки `policyVersion` в Conversation, OmniRootExecution и OmniReplyBudget.
- **Сценарий:** в ROB-769 managerReplyPolicy, externalHumanReplyPolicy и externalServiceReplyPolicy, responders/maxReplies, burst/debounce, бюджеты цепочки, cron-lateness, шаблоны G17, подпись G19 и правило G20 кладут в изменяемый JSON у binding. Тогда захваченный `policyVersion` turn или бюджета ни на что неизменяемое не ссылается. Правка maxReplies на лету меняет квоту уже допущенного root, и проверка «captured version» становится декоративной.
- **Минимальная правка:** добавить в §3 сущность вроде `AutomationPolicyVersion`: `(workspaceId, policyId, version)` UNIQUE, неизменяемые settings, область действия (binding/route), state, автор публикации. Публикация атомарна с аудитом через policy writer UPDATE. Описать, какие изменения поднимают automationEpoch (сейчас это сказано только для managerReplyPolicy и pause). Связать с `updateAutomationPolicy` и G04–G07, G17, G19, G20.

### F2 — Medium. У общего root-бюджета CRM-эффектов и hops нет хранилища и правила атомарности
- **Где:** `workflow-execution.md:139` («общий конечный max CRM effects/hops… исчерпание → один durable handoff»), `workflow-execution.md:155` («явными классами общего root execution ledger»), E14 в `decision-tables.md:28`. В §3 OmniEffectLedger ключуется по execution (`implementation-spec.md:84`), а OmniReplyBudget — по reply-слотам (`:62`). Счётчика CRM-эффектов на root нет.
- **Сценарий:** два параллельных governed-потомка одного root делают CRM-мутации, которые порождают governed DATABASE_EVENT. Если глубина передаётся только в causation, ширина цикла update → trigger → update ограничена лишь локальными проверками, и гонка превышает общий лимит.
- **Минимальная правка:** определить в §3 хранение (например, колонки effectCount/maxEffects/maxHops у OmniRootExecution или OmniReplyBudget либо слоты эффектов по аналогии с replySlot). Блокировать в позиции «DispatchPlan/ReplyBudget» протокола блокировок. Расход — в одной транзакции с эффектом, по всему covered root set. Тесты T14-E/T27-D уже названы, их достаточно.

### F3 — Medium. API требует `expectedRevision` и `idempotencyKey`, которых в схеме нет
- **Где:**
  - `06-api.md:31`: linkExternalIdentity с expected revision, но у ExternalIdentity (`implementation-spec.md:46`) нет `revision`, хотя смена personId — policy writer (`access-control.md:25`).
  - `06-api.md:38`: expectedRevision у grants, queue grants, stage rules, но у ResourceGrant, QueueGrant, StageRule, Team (`:74-78`) нет revision.
  - Для idempotencyKey этих административных команд не определено хранилище. Это касается и `activateBinding` (`:22`).
  - Секрет webhook «выдаётся только создателю один раз» (`workflow-execution.md:371`, `06-api.md:119`), но поведение при потерянном ответе на создание с тем же ключом не определено. Потеря ответа входит в модель отказов §1.
- **Минимальная правка:** добавить `revision bigint` в ExternalIdentity и в policy-сущности, либо прямо сказать, что CAS идёт по `WorkspacePolicyState.epoch`. Ввести общий журнал идемпотентности policy writers (`UNIQUE(workspaceId, actor, idempotencyKey)` + payloadHash). Для создания webhook при повторе возвращать binding/keyId без секрета и требовать ротацию.

### F4 — Low. ConversationReadCursor объявляет FK, который невозможен
- **Где:** `implementation-spec.md:49` («composite workspace FK to Conversation/WorkspaceMember»). Это противоречит общему правилу `:38` («существующий FK не выдумывается»). WorkspaceMember — workspace-сущность (`modules/workspace-member/standard-objects/workspace-member.workspace-entity.ts`), и её схема зависит от workspace (`getWorkspaceSchemaName`). Из core-таблицы FK туда объявить нельзя.
- **Правка:** FK оставить только на core Conversation. workspaceMemberId проверять сервером, очистку при удалении участника описать через lifecycle. То же явно сказать про ConversationMember и про assignee.

### F5 — Low. Противоречие: можно ли отменить чужую команду
- **Где:** `implementation-spec.md:315` («Caller не может отменить чужую command») против `06-api.md:29` («current author/explicit cancel permission»).
- **Правка:** у владельца (`sending-ui#command-states`) выбрать одно правило. Например: автор, либо отдельное право `command.cancel` по G01, с аудитом. close/takeover остаются системной отменой.

### F6 — Low. В индексе API нет операций, которые нужны для активации
Нет создания OmniQueue (G08 требует очередь до activate), управления Team/TeamMember, реестра KnowledgeSource, передачи custodian (`:428`), audited-сопоставления исторического автора (`:430`), controlled purge. Семантику покрывает общий каталог policy writers, но индекс по README обязан перечислять операции. **Правка:** добавить строки в `06-api.md`.

### F7 — Low. Производные описания состояний и счётчиков отстали от владельца
`design/05-models.md:31` не содержит `blocked_config` из §15.27 (`implementation-spec.md:607`). Счётчик `conversationSequence` для DomainEvent, unread и SSE не назван в Conversation (`:47`): неясно, совпадает ли он с revision. **Правка:** синхронизировать `05-models` и явно назвать колонку.

### F8 — Low (сейчас блокируется по умолчанию). Не учтён ИИ-шаг CLASSIFY
`twenty-shared/src/workflow/types/WorkflowActionType.ts:19` содержит `CLASSIFY`. Он вызывает `AiEvaluationService` (`classify.workflow-action.ts:5`). В закрытой таблице `workflow-execution.md:71` и во всём Research он не упомянут. Неизвестный тип по умолчанию запрещён, так что сейчас это безопасно. **Правка:** явно внести CLASSIFY в таблицу как deny. Если его когда-нибудь разрешат, он должен считаться источником AI-provenance по `sender-mode`.

### F9 — Low. Неоднозначна связь SSE-курсора с policyEpoch
`sending-ui.md:74` привязывает курсор к policyEpoch. §15.15 (`implementation-spec.md:465`) говорит, что смена эпохи означает перепроверку, а не сброс, но только для export и queue cursor. При workspace-wide эпохе буквальное прочтение даёт snapshot-required на каждое назначение. **Правка:** одной фразой распространить правило «recheck, не reset» на SSE.

### F10 — Low. Не определён principal для автоматических assist-черновиков
`access-control.md:17`: «Assist дополнительно пересекает права конкретного менеджера». Для черновика по входящему в неназначенном диалоге очереди непонятно, чьи это права. **Правка:** определить (например, service principal ∩ scope диалога; видимость ограничивает AutomationArtifactScope). Там же уточнить, входят ли внутренние заметки в контекст ИИ, — это относится к G04.

---

## 3. Что я сверил в исходниках (тела файлов, которые реально читал)

| Утверждение плана | Где проверено | Итог |
|---|---|---|
| Core entities подхватываются только из `engine/core-modules` и `engine/metadata-modules` | `database/typeorm/core/core.datasource.ts:45-54` | Подтверждено |
| `getRepository` scope принимает третьим параметром `shouldSkipEventEmission` | `engine/twenty-orm/types/workspace-transaction-scope.type.ts:10-14` | Подтверждено |
| `matchParticipantsForWorkspaceMembers` не исключает APP-участников (§15.18) | `match-participant.service.ts:248-284` (фильтра нет); фильтр есть только в `:319-325` | Подтверждено: план прав, что это нужно исправлять |
| RunWorkflowJob при исключении вызывает `endWorkflowRun(FAILED)`; метрика по триггеру падает на неизвестном типе | `run-workflow.job.ts:81-94`, `:361-376` | Подтверждено |
| Блокировка ingestion в кеше на 60 с, `attachments: []`, у `headerMessageId` нет unique | `application-message-ingestion.service.ts:26`, `:88-101`, `:164` | Подтверждено |
| Поиск существующего сообщения по `headerMessageId` глобальный | `messaging-message.service.ts:83-89` | Подтверждено: префикс `omni:v1:` и явный conflict из §15.10 обоснованы |
| Поиск, экспорт и CommonBase читают с реплики | `search.service.ts:129`, `workspace-data-export-part-writer.service.ts:140`, `common-base-query-runner.service.ts:375,538` | Подтверждено |
| MessageThreadTarget поддерживает только Person, Company, Opportunity | `message-thread-target.workspace-entity.ts:11-18` | Подтверждено |
| Обычный row-policy зависит от Enterprise | `build-row-access-policy.util.ts:5,60` (`buildRecordShareGate`) | Подтверждено |
| WorkflowTriggerType — 4 значения; WorkflowActionType | `workflow-trigger.type.ts:9-14`, `WorkflowActionType.ts` | Подтверждено; нашёл CLASSIFY (F8) |
| Существование символов PAUSING_TOOLS, AGENT_WAIT_TOOL_NAMES, retryWorkflowRun, runCoreWorkflowVersion, handleStuckRunningRunsForWorkspace, computeAutomatedTriggerFromWorkflowVersion, findUsableByCaller, resolveEncryptionKeysOrThrow, схем в shared | Только grep/glob | Символы есть; тела не читал |
| ConnectedAccount в схеме core, есть `applicationId` и `connectionProviderId` | grep по `connected-account.entity.ts:29,111,121` | Подтверждено |
| Фронтенд | `workflow-trigger/constants/OtherTriggerTypes.ts` (полностью); список мест switch по триггерам и действиям; модуль `sse-db-event` | Множество switch-мест подтверждает требование статического inventory. Текущий SSE работает на record events, которые для omni подавляются. Значит, для UI диалогов нужен новый типизированный канал; §15.6 это предусматривает, но тело `sse-db-event` я не читал |

---

## 4. Ограничения вывода

- **Внешние коннекторы** (C, H, M: SaleBot-коннектор, Telegram- и MAX-юзерботы) в пакете отсутствуют. Утверждения про журналы, `random_id`, cancel tombstone, ограничения истории 24 ч / 100 / 30 и UNIQUE в MAX bridge journal проверить не могу. Это датированное исследование конкретных ревизий. План правильно требует сверить SHA и лицензии и пройти тесты T11/T28 на реальных транзакциях до переноса. Межпроцессный fencing central ↔ userbot ничем, кроме будущих тестов, не доказан.
- **Недоступные файлы:** `STATUS.md`, `current-steps.md`, `research.md`, `reuse-2.52.md`, DEVLOG, `version-and-deploy.md`, `plan/README.md`. Ссылки на них не проверены. `phase_0` не подтверждает текущее состояние живого экземпляра.
- **Явные риски, которые закрыты gates, а не план** (это не дефекты):
  - нагрузка на workspace-wide policy-строку: FOR UPDATE на каждое назначение, takeover_on_send, CRON; native permissions читаются из primary на каждый защищённый запрос — закрыто T19 с остановкой расширения;
  - бессрочная блокировка auto после неизвестного исхода human-отправки — G13b;
  - лицензия production и AGPL §13 — G18;
  - access fence при restore без внешнего журнала — G12.
- **Модель `check_decisions.py`** проверяет только абстракцию таблиц; сама она прямо признаёт, что не является runtime-доказательством.

Все критические области (схема и надёжность, права, аудит, governance ИИ и workflow, restore и cutover) я смог проверить по контрактам и основным точкам кода. Неполнота касается только внешних репозиториев коннекторов и исторических отчётов, которых нет в пакете.
