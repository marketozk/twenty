# Независимое ревью технического плана omnichannel CRM

## Вердикт: **needs_revision**

Правка нужна узкая, архитектуру менять не нужно. Блокеров уровня Critical или High я не нашёл. Найдено одно расхождение уровня Medium: в схеме нет хранилища для trusted execution reference. По правилу индекса владельцев новую сущность нельзя добавить при кодинге без правки контракта. ROB-764…768 можно начинать уже сейчас. До миграций ROB-769 нужно закрыть F1. Остальные замечания можно закрыть параллельно.

Вердикт означает готовность начать реализацию с её тестами и продуктовыми гейтами. Это не готовность к продакшену. Нового runtime нет, T01–T33 не написаны и не запускались. Отсутствие runtime я дефектом плана не считаю.

---

## 1. Покрытие областей ревью

| Область | Что прочитано | Итог |
|---|---|---|
| Требования и продуктовые решения | requirements v0.6, decisions, open-questions, coverage, §13 G01–G20 | Каждое требование привязано к разделу плана и T-тестам. Гейты не подменены значениями по умолчанию. Робот исключён. Bot API и внешние группы остаются опцией. Противоречий нет |
| Индекс владельцев и консолидация | contracts/README и три контракта-владельца целиком; все `Определение:`-ссылки из spec и design/05, 06, 09 | Все якоря существуют. Уникальные правила при переносе не потеряны. Одно расхождение в производной таблице (F3) |
| Схема (§3) | spec §3 против API, фаз и контрактов | Поля, UNIQUE и разбивка по этапам согласованы. Пробел — F1 |
| Inbox, outbox, надёжность транспорта | spec §4, §15.7, §15.16, §15.25; sending-ui; decision-tables C01–C18; 02-behavior | Сохранённый ACK, lease и fencing, outcome_unknown, FIFO, echo, поколения, tombstone отмены определены. Мелкие нестыковки — F4, F5 |
| Тенант, строки, поля, этапы | access-control целиком; spec §7, §15.5, §15.6, §15.12, §15.13, §15.15, §15.17, §15.18; phase_3; access-source | Чтение только из primary, «замороженный» снимок прав, lock protocol, policy writers, StageRule, CAS сделки, производные данные. Противоречий нет |
| Аудит и пути чтения | spec §6, §15.5, §15.8; 08-audit; phase_2; transactions-audit-source | Атомарная запись с мутацией, append-only роли, отдельная запись отказов, ACL до count и export. Пропуск before-image при bypass+skip events отражён в access-source:35 |
| UI и коннекторы | sending-ui (UI, хронология, stale-view); phase_4; research-connectors; фронтенд выборочно | Контракт полный. Код внешних юзерботов недоступен (см. §4) |
| Governance ИИ, инструментов, workflow | workflow-execution целиком; decision-tables E и P; phase_5; ai-workflow-source; automation-source-matrix | Закрытый реестр инструментов, run identity, бюджет ответов, жизненный цикл turn, отмена, OMNICHANNEL_EVENT. Пробелы — F1, F2 |
| Вложения и история | spec §10, §15.10, §15.16, §15.23, §15.25; phase_6 | Порядок ревизий, протокол страниц импорта, перенос вложения с команды на сообщение (XOR), purge-manifest. Мелочь — F6 |
| Миграции, restore, cutover | spec §12, §15.4, §15.5, §15.8, §15.19, §15.21, §15.24; phase_0, phase_7 | Fork-runner, restoreIncarnation, внешний access fence, переход на новый ключ подписи (signing rotation), единственный владелец сессии. Согласовано |
| Фазы, зависимости, тесты | §11, §14; phase_0…7 | Порядок 764→765→766→(767+768)→(769+770)→771 согласован с фазами. Тесты с отрицательными контролями заданы |
| Лицензия | 07-license-boundary, license-inventory, §15.13, G18 | Собственная реализация, manifest зависимостей, fail-closed G18, проверка AGPL §13 |

---

## 2. Что я проверил в исходниках Twenty

**Прочитано полностью или указанными диапазонами:**
- `twenty-orm/datasource/workspace-data-source.ts` (весь файл). Подтверждено: `getRepository(name, rpc, {shouldSkipEventEmission})` передаёт опцию дочерним репозиториям, `executeRawQuery` идёт через тот же executor, `afterCommit` — в памяти.
- `workspace-repository.ts:1655–1794` и `:2055–2094`. Подтверждено: `canSkipBeforeImage` при bypass+skip; `emitMutationEvent` при skip ничего не публикует.
- `run-workflow.job.ts` (весь). Подтверждено: catch → `endWorkflowRun(FAILED)` на :81–94; `incrementTriggerMetrics` с `default: throw`.
- `compute-automated-trigger-from-workflow-version.util.ts` (весь): неизвестный тип даёт `null`.
- `upgrade-sequence-reader.service.ts` (весь): шаги группируются fast → slow → workspace.
- `resolve-encryption-keys-or-throw.util.ts` (весь): `ENCRYPTION_KEY` либо `APP_SECRET`.
- `core-workflow-run.resolver.ts` (весь) и `core-workflow-runner.service.ts:45–169`.
- `message-thread-target.workspace-entity.ts`: только Person, Company, Opportunity.
- Фронтенд: `workflow-actions/constants/HumanInputActions.ts`, список файлов `workflow-trigger/` (селектор, defaults, test payload).

**Подтверждено поиском (Grep):** `PAUSING_TOOLS` и `AGENT_WAIT_TOOL_NAMES`, `useReplica: true` в SearchService и в export part writer, наличие `withoutAppChannelParticipants`, места retry и scheduleStepRetry, места SEND_CHAT_MESSAGE во фронтенде.

**Не открывал сам** (принял как наблюдения source-карт): timeline-messaging, FileByIdGuard и FileController, record-export, SSE publisher, merge runner, MCP, agent toolset, TrashCleanup. Хэши источников не сверял — это отдельная работа автора. `check_decisions.py` не читал и не запускал; `model-result.json` (1712 кейсов, 0 сбоев) — результат автора.

---

## 3. Находки

### F1 — Medium. Для TrustedExecutionReference нет сущности в §3

- **Где:** `contracts/workflow-execution.md:330` и `implementation-spec.md:559` (§15.24) требуют серверное хранилище: «Queue хранит reference ID», reference закрепляет `restoreIncarnation` и `policyEpoch`. В §3 (`implementation-spec.md:40–79`) такой таблицы нет. На неё ссылаются `OmniWorkflowRunIntent.referenceId` и `AutomationArtifactScope.referenceId`, но нигде не сказано, где хранятся сами поля: initiating principal, application и версия агента, automationEpoch, restoreIncarnation, rootEventId, activationVersion, captured ResourceScope с ревизиями рёбер. У `OmniAutomationTurn` нет `restoreIncarnation` и ссылки на reference. У non-human `OutgoingCommand` нет ссылки на reference, хотя dispatch обязан сверять captured scope (`sending-ui.md:20`).
- **Сценарий:** после restore тест T18/T29 требует отклонить старый reference с тем же числовым epoch, но с прежним `restoreIncarnation`. Реализация ROB-769 вынуждена придумать хранилище сама: JSON в очереди (это запрещено) или пересчёт из текущего состояния (тогда теряется immutable scope). По README сущности может добавлять только §3.
- **Минимальная правка:** добавить в §3 сущность `OmniExecutionReference`: неизменяемые поля из `workflow-execution.md:330` плюс `capturedResourceScope` с ревизиями рёбер, `parentReferenceId` (для потомков scope только сужается), `UNIQUE(workspaceId,id)`. Добавить `referenceId` в `OmniAutomationTurn`, в non-human `OutgoingCommand` и в `ConsumerReceipt`. Указать миграцию ROB-769.

### F2 — Low. Ручной и тестовый запуск governed workflow через `runCoreWorkflowVersion`

- **Где:** `core-workflow-run.resolver.ts:65–121` принимает любую `coreWorkflowVersionId` (включая DRAFT), `workflowRunId` от клиента и произвольный payload. Ключа идемпотентности нет. `CoreWorkflowRunnerService.run` (`:48–144`) статус версии не проверяет. В плане строка MANUAL (`workflow-execution.md:131`) требует actor + command idempotency key + hash, а runId задаётся единым UUIDv5 (`:240`). Сам резолвер в инвентарях не назван: в `automation-source-matrix.md:55` сказано только «полный call-site inventory — шаг реализации».
- **Сценарий:** администратор нажимает в редакторе «Тест» на черновике с AI_AGENT и SEND_OMNI_MESSAGE. Классификация «governed» задаётся при publish, у черновика метки нет. AI-шаг может выполниться широким principal до того, как отправка откажет. Кроме того, `workflowRunId` от клиента обходит правило run identity.
- **Почему Low:** инвариант «проверка всего flow на любом start» (`workflow-execution.md:115`) при буквальном исполнении закрывает дыру. Решение не принято только для UX и для API.
- **Правка:** явно записать: (1) для flow с omni capability, включая DRAFT, этот резолвер либо отказывает, либо требует нового `idempotencyKey` и проходит через governed MANUAL ingress; (2) `workflowRunId` от клиента для governed-запусков отклоняется; (3) кнопка «Тест» во фронтенде показывает отказ или ограничивается synthetic binding по G14. Добавить строку в T25-F.

### F3 — Low. Производная таблица расходится с владельцем по порядку блокировок

- **Где:** в `decision-tables.md:75` порядок «…dispatch/budgets → commands/receipts/turns», то есть turn идёт после Command. У владельца (`access-control.md:37`) AutomationTurn/WorkflowRunIntent → EffectLedger → Command → Receipt, плюс RouteActivation.
- **Риск:** реализатор возьмёт таблицу как шпаргалку — обратный порядок «turn ↔ command» между scanner и dispatch даёт deadlock.
- **Правка:** заменить строку ссылкой на `access-control.md#lock-protocol` или скопировать порядок дословно.

### F4 — Low. В коннекторе неясно, по какому ключу уникальна команда

- **Где:** `implementation-spec.md:361–362` задаёт `UNIQUE(ownerInstance,commandId)` для send_commands и command_cancel. А `sending-ui.md:43` опирается на то, что в коннекторе «uniqueness по commandId».
- **Сценарий:** при rollback или cutover меняется ownerInstance. Если в коннектор попадёт прежний commandId, дедупликация не сработает. Fencing по поколению это прикрывает, но restore-абзац в sending-ui опирается на более сильное свойство.
- **Правка:** выбрать одно правило — глобальная `UNIQUE(commandId)` в registry либо явная формулировка «сверка только через historical owner».

### F5 — Low. Ответ на отправку не возвращает новый controlEpoch

- **Где:** `sending-ui.md:55–57` возвращает только `replyRevision`. При `takeover_on_send` (`access-control.md:70`) controlEpoch увеличивается.
- **Сценарий:** две быстрые отправки менеджера в режиме auto. Вторая получает control conflict до прихода SSE.
- **Правка:** ответ send должен возвращать `{commandId, state, replyRevision, controlEpoch, mode}`. Добавить в T12.

### F6 — Low. Два написания origin для импорта

- **Где:** `design/02-behavior.md:64` и `phase_6_history.md:16` пишут `origin=import`. Spec §5, §15.16 и `06-api.md:64` пишут `history_import`.
- **Правка:** зафиксировать одно значение enum в JSON Schema ROB-764 и выровнять тексты.

### F7 — Low. Не определена ручная сверка outcome_unknown по доказательствам

- **Где:** `decision-tables.md:88` допускает «ручной reconciliation с evidence». В коннекторе есть `resolutions` «manual resolutions audited» (`spec:363`). В `06-api.md` нет операции, права, допустимых видов доказательств и правила, как результат доходит до Command и снимает блок auto.
- **Правка:** добавить `resolveCommandOutcome(commandId, evidenceRef)` с отдельным правом и аудитом (только journal- или provider-evidence) либо явно записать, что в v1 сверка только автоматическая.

**Чего не считаю дефектами:** гейты G01–G20 и G13b (возможная бессрочная блокировка auto); риск блокировок WorkspacePolicyState (на него стоит стоп-гейт T19); отсутствие нового runtime; незавершённый инвентарь bypass и producers (это обязательные шаги ROB-766/769 с блокировкой активации).

---

## 4. Ограничения вывода

- Внешние репозитории C, H, M (коннектор, Telegram- и MAX-юзерботы) в пакет не входят. Их свойства — `store.claim`, `random_id`, `bridge_journal`, лимиты истории 24 ч / 100 / 30, `external_api.record_external_send` — взяты из `research-connectors.md` и не проверены. План корректно требует квалифицировать их до переноса (§8, §15.7, §15.25, T11/T28). Реальная идемпотентность MAX и наличие статус-запроса в Telegram неизвестны.
- Ссылки на STATUS.md, cross-review/*, current-steps.md, DEVLOG и version-and-deploy.md ведут на файлы, которых в пакете нет. Текущее состояние живого экземпляра (демо) я не оцениваю.
- Ревью охватило все критичные домены. Тела перечисленных во втором абзаце §2 исходников я лично не читал.

Карточку задачи не обновлял: по условию ревью MCP и task-card запрещены.