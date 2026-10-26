# Независимое ревью технического плана A: omnichannel CRM на Twenty

## Вердикт

**ready_for_implementation**, с условиями ниже.

Блокеров (Critical/High) нет. Архитектура единая: пакетная транзакция, inbox/outbox, собственный ACL, аудит, governance ИИ/workflow, fork-миграции, restore и cutover. Она согласована с исходниками на пакетном снимке. Нашёл 4 замечания уровня Medium и 7 уровня Low. Все исправляются небольшой правкой контракта. Ни одно не мешает начать ROB-764, но каждое нужно закрыть до старта этапа, который оно затрагивает.

Вердикт означает готовность начинать реализацию с перечисленными gates и будущими T-тестами. Это не готовность к production и не проверка нового runtime: его нет, и я не считаю это дефектом плана.

## 1. Охват

| Область | Что прочитано | Сверка с исходниками | Статус |
|---|---|---|---|
| Требования, решения, G01–G20 | requirements, decisions, open-questions, spec §1, §13 | — | Полностью. Gates отделены от разработки, ни одно значение не выбрано за владельца |
| Схема | spec §3, §15.5, §15.8, 05-models | ConnectedAccount/MessageChannel — core-сущности, FK RESTRICT допустим | Полностью. См. Medium-3 и Low-5 |
| Inbox/outbox/транспорт | spec §4–5, §15.3, §15.7, §15.16, decision-tables C01–C18, 02-behavior, 06-api | `WorkspaceDataSource.transaction`/`getRepository(...,{shouldSkipEventEmission})` (`workspace-data-source.ts:74-126`), глобальный dedup по header в `messaging-message.service.ts:83-89,354-360` | Полностью |
| ACL: tenant/строки/поля/этапы | spec §7, §15.5–15.6, §15.13, §15.15, §15.17, §15.23, phase_3, access-source, bypass-candidates | Enterprise-импорт в обычном пути чтения `build-row-access-policy.util.ts:5,60`; replica в поиске `search.service.ts:125-130` | Полностью. См. Medium-1 и Medium-2 |
| Аудит | spec §6, 08-audit, phase_2, transactions-audit-source | afterCommit в памяти, ошибки подавляются (`workspace-data-source.ts:128-136`) | Полностью |
| Производные пути чтения | spec §15.1, §15.6, §15.12, §15.18 | Символы timeline/merge/trash/participants найдены | Контракт проверен. Все 215 мест обхода не открывал (это работа ROB-766) |
| UI | spec §8, phase_4 | Frontend-код не открывал | Только на уровне контракта |
| Коннекторы | spec §8, §15.7, research-connectors | Внешних репозиториев C/H/M в пакете нет | Только по документу. См. Medium-4 |
| ИИ/инструменты/workflow | spec §9, §15.3, §15.9–15.10, §15.14, §15.17–15.23, design/09, decision-tables E/P | `PAUSING_TOOLS`, `AGENT_WAIT_TOOL_NAMES`, `retryWorkflowRun`, `handleStuckRunningRunsForWorkspace`, catch→FAILED (`run-workflow.job.ts:81-94`) — найдены | Полностью |
| Вложения, edit/delete, импорт | spec §10, §15.2, §15.16, §15.23, phase_6 | — | Полностью |
| Миграции, restore, cutover | spec §12, §15.4–15.5, §15.19, §15.21, phase_7 | `resolveStartCursor` (`upgrade-sequence-runner.service.ts:249-294`), проверка декораторов (`upgrade-aware-entity-metadata.adapter.ts:348-368`) | Полностью, утверждения плана подтверждены |
| Этапы, зависимости, тесты | spec §11, §14, phase_1..7, coverage, 04-testing | — | Полностью, порядок этапов непротиворечив |
| Лицензия | 07-license-boundary, license-inventory, spec §15.13/§15.18 | 71 файл в `record-share/` с `@license` | Полностью (правовой статус не оцениваю) |
| Абстрактная модель | check_decisions.py, model-result.json | Не запускал: только чтение | Читал код. Модель проверяет только заявленную абстракцию, сценарии E/P не перебирает. Расхождений со spec нет |

Из 34 документов `PACKET_INDEX.json` прочитаны все. `upstream-2.52.json` и `automation-source-hashes.json` — частично, а хеши без Bash пересчитать нельзя.

## 2. Замечания

### Medium-1. Один общий для всего workspace fence `WorkspacePolicyState` на все чтения и все частые policy-записи
- **Сценарий.** По spec §15.15 (`implementation-spec.md:438`) каждое авторизованное чтение берёт `FOR SHARE` на одну строку workspace. Каждая запись атрибута из каталога §15.23 (`:543`) берёт `FOR UPDATE`. В каталоге stage, assignment, link/unlink identity, conversation↔CRM targets и parent-связи (NoteTarget/TaskTarget).
- **Последствие.** Перенос сделки на канбане, назначение диалога из очереди, создание задачи с target — каждое такое действие ждёт всех текущих читателей и останавливает все новые чтения workspace. Корректность сохраняется, но T19 (`:515`) стоит в ROB-771 с оговоркой «guards не снимаются ради throughput». Если T19 не пройдёт, придётся менять lock protocol (§15.9), на который опираются все этапы.
- **Минимальная правка.** Перенести микро-нагрузочный gate contention в ROB-766, до массовой интеграции kernels. Заранее записать в контракт допустимую эквивалентную альтернативу:
  - чтение: grants в предикате того же SQL-statement вместо `SHARE`-lock;
  - и/или разделённые epochs (глобальный — только для ролей и grants; на ресурс/область — для stage/assignment/targets) с тем же правилом «нет `SHARE`→`UPDATE`».

### Medium-2. Чтения с реплики не определены в контракте revoke
- **Сценарий.** Глобальный поиск читает через `{ useReplica: true }` (`search.service.ts:125-130`), workspace export тоже (`workspace-data-export-part-writer.service.ts:140`). При настроенной реплике пул выбирается так: `replicaPool ?? primaryPool` (`workspace-data-source.service.ts:86-89`). Spec требует «актуальный authoritative epoch» и `FOR SHARE` на primary (`:123`, `:438`). На standby строку заблокировать нельзя, а grants там отстают.
- **Последствие.** Отозванный менеджер видит Person/Opportunity/Message в поиске на время лага реплики. Это нарушает T10. Без реплики риска нет, но контракт этот случай не решает.
- **Минимальная правка.** Добавить норму: защищённые чтения (поиск, export, инструменты ИИ, использующие поиск) идут в primary под policy fence. Либо реплика допускается только если `pg_last_wal_replay_lsn` ≥ LSN последнего policy commit, иначе — primary. Добавить кейс с репликой в T08/T10.

### Medium-3. Нет хранилища и команды для связи диалога с CRM-записями
- **Сценарий.** §15.3 (`:275`) строит scope ИИ из «явно связанных разрешённых Company/Opportunity/Task». §15.23 (`:543`) включает conversation↔CRM targets в policy-каталог. В схеме §3 (`:40-60`) такой сущности нет, а в API 06 (`06-api.md:13-22`) нет операции link/unlink. В upstream есть `MessageThreadTarget` (`message-thread-target.workspace-entity.ts:8-19`), но только с Person/Company/Opportunity, без Task. §15.1 запрещает менять omni-ассоциации generic-путём.
- **Последствие.** Есть две несовместимые реализации: reuse `messageThreadTarget` или новая core-таблица. Привязку Task выразить негде. Создать связь из диалога (F-03) нечем, кроме запрещённого generic CRUD.
- **Минимальная правка.** Зафиксировать каноническое хранилище. Например, `messageThreadTarget` с `isManuallyAssigned` для Person/Company/Opportunity плюс core `ConversationTarget(workspaceId, conversationId, objectMetadataId, recordId)` с UNIQUE для Task и custom-объектов. Добавить доменную команду `linkConversationTarget`/`unlink` (policy UPDATE, `policyEpoch++`, audit) в 06-api и T10/T13.

### Medium-4. Посторонние отправители на тех же транспортных аккаунтах не классифицированы
- **Сценарий.** В MAX есть внешний API отправки робота, который пишет `record_external_send` в журнал bridge (`research-connectors.md:114`). Сам робот продолжает работать (D-16). Есть также Mavibot и партнёрские destinations (`:18`, `:126`). Spec знает только «external_sender/unknown provenance» и `externalHumanReplyPolicy` (`implementation-spec.md:271`, `:349`). Cutover требует «доказать одного sender» (`:210`).
- **Последствие.**
  - При политике pause каждое служебное сообщение робота ставит автоответ ИИ в этом чате на паузу.
  - «Один sender» на MAX-аккаунте с роботом недостижим буквально.
  - Владение аккаунтом в новом registry (`account_owners` UNIQUE(platform, accountId)) может конфликтовать с текущими партнёрскими destinations.
- **Минимальная правка.** Добавить в G11/G13 обязательную инвентаризацию не-CRM отправителей по каждому аккаунту. Ввести отдельный класс provenance `external_service` с доказуемой меткой из журнала userbot; он не равен external human и подчиняется отдельному правилу. Уточнить: «один sender» — это один CRM-dispatch owner на generation, а не единственный источник отправок аккаунта.

### Low-1. §4 описывает порядок блокировок иначе, чем §15.9
Ingress/worker (`:72-74`) начинает с binding, а admission читает каталог подписок под `SHARE` на policy row (`design/09:55`). Если реализовать по §4, возможен deadlock с `disableBinding` (policy UPDATE → binding).
**Правка:** в §4 явно указать policy `SHARE` первым звеном apply-транзакции.

### Low-2. Неразрешённый human `outcome_unknown` навсегда блокирует возврат в auto
Так задано в `decision-tables.md:86` и `implementation-spec.md:545`. Для MAX без status lookup это вероятно, а F-04 требует автоответов.
**Правка:** отдельная аудируемая операция `acknowledge_unresolved` с правом руководителя. Она не утверждает sent/failed, но снимает блокировку.

### Low-3. Reply в Composer есть, в Command нет
Composer поддерживает reply (`:137`), а вход Command (`:78`, `06-api.md:16`) не содержит `replyTo`.
**Правка:** добавить `replyToMessageLinkId` в payload/hash и в capability matrix — или убрать reply из v1. Попутно зафиксировать, что `expectedControlEpoch` не входит в payloadHash: после CAS-конфликта повтор с тем же ключом допустим.

### Low-4. У порядка исходящих в чате нет оракула
T11 требует «per-chat order» (`:347`), но правило не задано: ждёт ли B, пока A в pending/`outcome_unknown`?
**Правка:** FIFO по sequence создания; B уходит после `accepted` A; `outcome_unknown` не блокирует (или блокирует — выбрать явно).

### Low-5. Каталог сущностей §3 неполон
В нём нет OmniAutomationTurn, OmniEffectLedger (ключ эффекта агента), AutomationArtifactScope, CrmRecordRevision, OmniMessageRevision, QueueGrant, Policy/Team/Grant/StageRule, реестра Knowledge. Неясно, RunIntent (design/09, §15.19) — это ConsumerReceipt или отдельная таблица.
**Правка:** свести всё в таблицу §3 с UNIQUE-ключами; RunIntent = ConsumerReceipt workflow-consumer'а.

### Low-6. Workflow с не-message root не знает, как получить `conversationId`
Пример F-06 «смена этапа → уведомление»: action требует `conversationId` (`:480`), а Conversation не является workspace-объектом, и FIND_RECORDS её не найдёт.
**Правка:** правило G07 записывает `conversationId` в scope root; action берёт его как trusted-переменную root.

### Low-7. Внешний журнал изменений доступа для restore не спроектирован
Он упомянут в `:523`. Без него действует безопасный default deny: после restore все права назначаются вручную.
**Правка:** явно записать это как ожидаемый исход runbook — или спроектировать writer/хранилище журнала в ROB-771.

## 3. Что проверено и признано корректным
- Атомарность ingest: scope-executor плюс `withOmniRepositoryOptions`, запрет обычного `getRepository` и раздельные пулы подтверждены исходниками.
- Namespaced header `omni:v1:` закрывает глобальный dedup по `headerMessageId`.
- Fork migration runner верно учитывает группировку и cursor upstream-sequence и валидацию декораторов.
- Ingress/outbox/receipts дают корректный исход в каждой точке заявленной модели отказов; нет ложного ACK и нет resend по timeout.
- Takeover, `controlEpoch` и `automationEpoch` разделены; таблица sender×mode, closed и G20 непротиворечивы; общий reply budget только в commit Command.
- Workflow-governance для всех типов триггеров, `cancellationEpoch`, sticky coverage — по таблицам противоречий не нашёл.
- Принцип собственного ACL с fail-closed без Enterprise корректен; зависимость от record-share в обычном пути чтения подтверждена.

## 4. Ограничения вывода
- Внешние коннекторы и userbot (C/H/M) в пакет не входят. Утверждения о `random_id`, idempotency MAX, retention 30 дней, лимитах истории и `external_api` взяты только из research-connectors. Квалификация до переноса остаётся обязательной.
- Baseline пакета `c030e2e4…` не сверял с `729f6236…` на уровне файлов: без Bash это невозможно. Проверенные символы и строки совпадают с отчётами.
- Frontend, все 215 мест обхода и MCP/tool-provider по коду не открывал — только через отчёты.
- Документы, на которые ссылается план, но которых нет в пакете: plan/README, current-steps, reuse-2.52, research, STATUS.
- Правовой статус текущего экземпляра и Corresponding Source по AGPL §13 не оцениваю (это G18).
- Неизвестные риски: производительность единого policy fence (Medium-1), фактическая конфигурация реплики (Medium-2), состав реальных отправителей на аккаунтах (Medium-4).

Все критичные области удалось проверить на уровне контракта и ключевых call sites. Коннекторы — только по вторичному документу.

Карточку задачи не обновлял: в задании запрещены MCP-инструменты.
