# Независимое ревью технического плана A (omnichannel CRM на Twenty)

**Вердикт: `needs_revision`.** Нужна узкая правка, архитектуру переделывать не требуется. Блокеров уровня High я не нашёл. Есть три Medium: противоречие внутри контракта и два недостающих решения. Два из трёх (F1, F3) попадают в первый этап ROB-764. Каждое исправляется одной-двумя фразами у владельца документа плюс строкой теста. После этих правок план готов к реализации при своих гейтах G01–G20 и будущих тестах T01–T33.

Вердикт означает готовность к реализации. Он не говорит о готовности к production и не подтверждает, что runtime работает: нового runtime нет, и его отсутствие я дефектом плана не считаю.

## 1. Покрытие

Прочитаны все 39 документов из `PACKET_INDEX.json`, включая индекс владельцев `plan/contracts/README.md` и три документа-владельца целиком. Прочитаны также `REVIEW_SCOPE.md`, `check_decisions.py` и `model-result.json`. Перекрёстные ссылки с якорями (`#…`) из спецификации на `sending-ui`, `access-control` и `workflow-execution` все существуют. Битых якорей нет.

| Область | Статус | Основание |
|---|---|---|
| Требования и продуктовые решения (R/F, D-xx, Q-xx, G01–G20) | Проверено | requirements, decisions, open-questions, spec §13, coverage. Требования к ИИ не урезаны до черновиков. Робот исключён. |
| Схема (spec §3) и её единственный владелец | Проверено, есть замечания | F3, F5, F6 |
| Inbox: ingress, HMAC, receipt, lease, атомарность | Проверено | spec §4, §15.10. Сверено с `workspace-data-source.ts` и `workspace-transaction-scope.type.ts` |
| Outbox, состояния Command, FIFO, echo, unknown, сверка исхода | Проверено, противоречий нет | sending-ui, decision-tables C01–C18, spec §15.7 |
| Права: tenant/row/field/stage, epochs, блокировки, control CAS, primary-чтения | Проверено | access-control, spec §7, §15.5, §15.13, §15.15, §15.17 |
| Аудит | Проверено, есть замечание | spec §6, §15.5, §15.8, design/08 — F5 |
| Производные пути чтения (timeline, search, export, SSE, files, AI-артефакты) | Проверено | spec §15.1, §15.6, §15.12. Сверены timeline-messaging и `useReplica` |
| UI и SSE | Проверено на уровне контракта и существующего SSE | `event-stream.resolver.ts`, фронтовый `OnEventSubscription.ts` |
| Коннекторы, юзерботы, cutover | Только по документам | Внешние репозитории C/H/M в пакет не входят (ограничения в §4) |
| ИИ, инструменты, governance | Проверено | workflow-execution (§2–4, turn-lifecycle, action-idempotency) |
| Workflow: триггеры, run identity, отмена, recovery | Проверено, есть замечания | F2, F8. Сверены WEBHOOK-контроллер и CRON-job |
| Вложения, edit/delete, импорт | Проверено | spec §10, §15.16, §15.23, §15.25 |
| Миграции (fork runner) | Проверено | spec §15.5, §15.19. Сверён `upgrade-sequence-reader.service.ts` |
| Restore и cutover | Проверено | spec §12, §15.4, §15.21, §15.24, §15.25 |
| Этапы 0–7, зависимости, тесты | Проверено | ROB-764→771 согласованы со spec §3 и §14 |
| Консолидация в README | Проверено | Уникальные требования не потеряны. Нарушение правила единственного владельца — F5 |
| Лицензия и Enterprise | Проверено | Импорты record-share в `build-row-access-policy.util.ts` подтверждены. Гейт G18 явный |
| Абстрактная модель | Проверено | Модель сама честно описывает свои пределы. Как доказательство я её не принимаю |

## 2. Какие исходники я реально открыл

**Целиком:**
- `twenty-orm/types/workspace-transaction-scope.type.ts`
- `twenty-orm/datasource/workspace-data-source.ts`
- `twenty-orm/workspace-orm.manager.ts`
- `workspace-event-emitter/workspace-event-emitter.ts`
- `messaging/message-participant-manager/listeners/message-participant-person.listener.ts`
- `match-participant/listeners/participant-target-person.listener.ts`
- `match-participant/jobs/reconcile-person-company-targets.job.ts`
- `core-modules/upgrade/services/upgrade-sequence-reader.service.ts`
- `core-modules/workflow/controllers/workflow-trigger.controller.ts`
- `subscriptions/event-stream.resolver.ts`
- `twenty-front/src/modules/sse-db-event/graphql/subscriptions/OnEventSubscription.ts`

**Частично:**
- `participant-target-reconciliation.service.ts`: 1–494
- `match-participant.service.ts`: 55–384
- `workflow-cron-trigger-cron.job.ts`: 55–194
- `connected-account.entity.ts`: 90–159

**Только поиском (grep):**
- все `*listener*.ts`
- `compute-target-reconciliation-operations.util.ts`
- `message-channel.entity.ts`
- `WorkflowActionType.ts`
- timeline-messaging и format-threads
- `MetadataReadability`
- все использования `useReplica`
- импорты record-share в twenty-orm
- существование классов из §15.18 и §15.21 (все найдены)
- фронт: триггеры `DATABASE_EVENT`, Retry/Run

**Не открывал** (утверждения о них — только из отчётов): тела FileByIdGuard, record-export, search, AgentRunner/Toolset, workflow executor, merge runner, миграции, фронтовые компоненты Composer и AI. Хэши исходников я не сверял.

## 3. Находки

### F1 — Medium. Повторное использование APP-сверки targets противоречит правилу «projection только из явного ребра»

**Где правило:** spec §7 (`implementation-spec.md:144`). `MessageThreadTarget` для omni — только projection канонического `ConversationTarget` с `isManuallyAssigned=true` и `isAutomaticallyAssigned=false`. Native rematch запрещён. Связь Person→Company/Opportunity доступ не расширяет.

**Где ему противоречат:** путь записи предписывает вызывать match/reconcile с обёрнутым scope. Это `workflow-execution.md:290` («match/reconcile получают только этот wrapped scope»), `phase_1_data.md:22`, `integration-map.md:25` («APP targetsOnly») и `transactions-audit-source.md:49`.

**Что показывает исходник:**
- `matchParticipants(targetsOnly)` вызывает `reconcileParticipantTargets` (`match-participant.service.ts:107–117`).
- `buildDesiredTargets` автоматически добавляет Company человека и Opportunity, где он `pointOfContact` (`participant-target-reconciliation.service.ts:386–462`). Вставка идёт с `isAutomaticallyAssigned: true` (322–330).
- Отдельно `ParticipantTargetPersonListener` (person UPDATED, появился `companyId`) запускает `ReconcilePersonCompanyTargetsJob`. Он через `reconcileTargetsForPeople` обходит **все** messageParticipant с этим `personId`, без APP-фильтра, обычным scope с эмиссией событий (`:37–92`). Этого job нет ни в одном документе плана.

**Сценарий:** у верифицированного Person появляется компания или он становится pointOfContact сделки. Тогда:
- на omni-тред создаются автоматические Company/Opportunity targets мимо `ConversationTarget`, `policyEpoch` и аудита;
- в webhook и workflow уходят сырые omni-события, хотя §15.6 и G16 их запрещают.

Если же поставить domain-only guard, откатывается смешанный email-батч. Ровно этот сбой §15.18 запрещает для listener'а участников.

**Минимальная правка:**
1. В repository-adapter и в этапе 1 явно записать: для omni `matchParticipants`/`reconcileParticipantTargets` не вызываются; projection пишет только domain link/unlink.
2. Добавить `ReconcilePersonCompanyTargetsJob`, `reconcileTargetsForPeople` и `MessageParticipantPersonListener` в writer inventory §15.18. Omni-треды отсекаются по persisted ownership **до** сверки.
3. T05/T23: Person получил companyId или стал pointOfContact → 0 изменений omni targets, 0 omni-событий, email-треды сверены как раньше.

### F2 — Medium. Аутентификация governed WEBHOOK не определена, а штатный endpoint публичный

**Контракт:** design-26 (`workflow-execution.md:130`) требует для WEBHOOK «authenticated binding + обязательный idempotency key». design-24 (`:115`) включает WEBHOOK в governed-объём.

**Исходник:** `workflow-trigger.controller.ts:50–71` стоит под `PublicEndpointGuard`, включая GET без тела, и сразу вызывает `coreWorkflowRunnerService.run` (`:144`).

**Чего нет в плане:** сущности для credential, формата подписи, ротации и отзыва, принципала вызывающего. В §3 ничего этого нет, а HMAC из §4 описан только для коннектора.

**Сценарий:** при реализации ROB-769 публичный URL запускает workflow с `SEND_OMNI_MESSAGE`, либо governance реализуют каждый по-своему.

**Минимальная правка:** в v1 явно запретить governed WEBHOOK: контроллер отказывает до runner, если версия omni-governed. Расширять — отдельным решением. Либо описать credential: сущность в §3, HMAC по модели §4, аудит, отзыв. Тест в T25-F: публичный POST/GET к governed workflow → 0 runs.

### F3 — Medium. Нет правила, в какую очередь попадает новый диалог

**Что есть в схеме:** `Conversation.queueId nullable`, и «отсутствие queueId означает private/unassigned» (`implementation-spec.md:44,71`). У `AccountBinding` нет default queue. Правила маршрутизации нового диалога в очередь нет нигде, поиск по `defaultQueue` и `queueId` это подтверждает.

**С чем конфликтует:** G08 («невидимый клиентский inbox не включается», `:253`), §15.6 (`:351`) и закрытый статус («показать в разрешённой очереди», `access-control.md:82`).

**Сценарий:** первое входящее создаёт диалог с `queueId=NULL`. Его не видит никто из тех, у кого есть QueueGrant. Durable handoff и входящие в закрытый диалог тоже некуда адресовать.

**Минимальная правка:** добавить `AccountBinding.defaultQueueId` с FK на очередь того же binding, обязательный при активации. Ingress назначает его атомарно. Неактивная очередь — активация binding запрещена. Тест в T12.

### F4 — Low. Не определён начальный режим нового диалога

Поле `mode` в §3 есть, но не сказано, с каким режимом диалог создаётся при первом входящем и откуда берётся значение. От этого зависит, ответит ли ИИ на первое сообщение.

**Правка:** route-уровневый `defaultConversationMode`, по умолчанию `human` до решения G04/G07, плюс строка в §3.

### F5 — Low. Правило единственного владельца схемы нарушено пропуском

README (`contracts/README.md:7`) объявляет §3 единственным владельцем entities и UNIQUE. При этом в §3 нет `CrmAuditEntry`, admin deletion ledger и fork migration ledger: они описаны прозой в §6, §15.5 и §15.8.

Ключ дедупликации аудита тоже не задан. Без него не реализуются «один success на операцию» и «lookup operationId» (§6, `:126–128`).

**Правка:** добавить эти строки в §3, например `UNIQUE(workspaceId, operationId, resourceKind, resourceId, action)`.

### F6 — Low. Неясно, где авторитетное назначение

Есть `Conversation.assigneeMemberId` (`:44`) и есть `ResourceAssignment` (`:69`). Какой из них источник прав, а какой проекция, не сказано. Даёт ли назначение доступ на чтение и ответ, отложено в G01, и это нормально. А вот кто из двух пишет, — техническое решение, и его нет.

**Правка:** одна фраза: «assigneeMemberId — проекция ResourceAssignment(conversation), пишется одним policy writer».

### F7 — Low. Автосоздание контакта не внесено в реестр гейтов

§4 (`:104`) и sending-ui называют автосоздание контакта «отдельной настройкой». В G01–G20 его нет, хотя §13 объявлен единой точкой учёта.

**Правка:** отдельная строка G (по умолчанию выключено).

### F8 — Low. Нет места для хранения пропусков CRON

Контракт требует «пропущенные CRON occurrences после потери Redis — видимый gap» (`workflow-execution.md:196`). Штатный CRON работает от Redis-кэша и `now` (`workflow-cron-trigger-cron.job.ts:66–120`). Где хранить последний запланированный запуск расписания, чтобы обнаружить пропуск, в §3 не указано.

**Правка:** поле `lastPlannedOccurrence` в `OmniWorkflowSubscription` и тест в T14-E.

### Замечания без статуса находки

- **SSE.** Существующий SSE — Redis pub/sub с фиксированным DTO, без курсора. Курсор и `snapshot-required` реализуемы через `DomainEvent.conversationSequence`, но стоит одной фразой назвать DomainEvent источником replay и предусмотреть отдельный тип payload.
- **Глобальная блокировка политики.** Строка `WorkspacePolicyState` берётся FOR SHARE при каждом защищённом чтении и FOR UPDATE при takeover, close, status, assignment и `takeover_on_send`. Это глобальная RW-блокировка на workspace. Гейт T19 есть, но в его критерии стоит явно включить риск голодания писателя (revoke или takeover) под потоком SHARE.
- **Общий процесс MAX.** Реализация §15.25 («provider calls только при совпадении поколений») не должна блокировать посторонних отправителей того же MAX-процесса, перечисленных по §15.24. Это квалифицируется в G11/G13.

Без замечаний: FIFO и replacement; отмена на границе провайдера; run identity и TargetClaim; отмена через `cancellationEpoch`; restore с `restoreIncarnation`; таблица отправитель×режим; reply budget; fork runner. Утверждение о группировке upgrade-последовательности подтверждено исходником.

## 4. Чем ограничен вывод

- **Внешние коннекторы.** Свойства C/H/M — идемпотентность MAX, `random_id` Telegram, окна истории 24 ч / limit 100 / 30, UNIQUE журнала MAX, `cancel` и tombstone в userbot — взяты только из `research-connectors.md`. Сами репозитории в пакете отсутствуют. Квалификация перед переносом остаётся обязательной, это записано в §8 и §15.7.
- **Живой экземпляр.** Его состояние, конфигурация, используемые функции Enterprise и SaleBot не проверялись. План сам помечает это как «не установлено».
- **Код, который я не открывал** (список в §2), принят на основании отчётов. Тела этих файлов я не проверял.
- **Хэши.** Сверка хэшей источников и документов — ответственность автора, я её не выполнял.

## 5. Итог

Все критичные домены удалось проверить на уровне контракта. Транспорт проверен только по документам, а не по коду, и на нём держится единственное существенное ограничение. Для перехода в `ready_for_implementation` достаточно закрыть F1–F3. F4–F8 можно закрыть той же правкой или при кодировании, при условии что тесты, перечисленные в находках, будут добавлены.