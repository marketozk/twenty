# Этап B: сверка исправлений R15 и всех 66 корневых причин

**Вердикт: `needs_revision`.** Все три Medium из A (F1–F3) и Low F4–F8 по существу закрыты, и средства исправления выбраны верно. При этом сами правки оставили или породили 9 проявлений уровня Low. Medium/High среди них нет. Основная семантика корней от этих Low не меняется, но B1, B2, B3 и B6 — нормативные противоречия или дыры у владельцев контрактов. Их нужно убрать до старта ROB-764 (B1, B6) и до ROB-769 (B2, B3, B4). Остальное закрывается одной-двумя фразами плюс строкой теста.

Это сверка изменений, а не новый полный проход A. Runtime-проверки не выполнялись, T01–T33 не запущены, продуктовые гейты G01–G20 (включая новый G08b) не выбраны.

## 0. Пакет и инструменты

- Я пользовался только Read/Grep/Glob и только внутри каталога пакета, в A и в B. MCP, Bash и запись не вызывал. Хук task-card не выполнял, потому что вы запретили MCP. Ручаться я могу только за собственные вызовы, аудит других сессий мне недоступен.
- Нормализация метаданных видна по тексту. В design/09 вернулись метки «H-3/N-3», «M-7», «M-13», которых в A не было. В `transactions-audit-source.md` ссылки теперь указывают на корень пакета. Технических различий, кроме правок R15, я не нашёл.
- **Ограничение доказательств:** `PACKET_INDEX.json` не пересчитан. Хэш `implementation-spec.md` в нём (`c85f943…`) совпадает с хэшем на этапе A, хотя содержимое изменилось. Хэши источников и снимок B я не сверял: инструментов для этого нет.

## 1. Проверка F1–F8 и самопроверок автора

| Проявление | Корень | Итог | Текущее доказательство |
|---|---|---|---|
| F1 | N-27, L-7 | Исправлено **не полностью**, остаток B1 | Исправлено: repository-adapter (`workflow-execution.md:290`) прямо запрещает `matchParticipants`/`reconcileParticipantTargets` (включая `targetsOnly`). В spec §15.18 (`:502`) в inventory внесены `MessageParticipantPersonListener`, `ParticipantTargetPersonListener`, `ReconcilePersonCompanyTargetsJob` и `reconcileTargetsForPeople`. Исправлены также `integration-map.md:25`, `transactions-audit-source.md:49,119–121` и `phase_1_data.md:22,50`. **Остаток:** в spec §4 (`:109`) осталось «scope-aware Message/participants/**targetsOnly** + link». |
| F2 | N-36 | Принято, остаток B4 | Есть `#webhook-auth` (`:363–371`), `OmniWebhookBinding/Credential` в §3 (`:57–58`), API (`06-api.md:116`), phase_5 (`:57`). Публичные GET/POST отказывают governed-потоку до runner. Тип WEBHOOK сохранён. Подпись покрывает idempotencyKey и сырое тело. Ключ дедупликации — `webhookBindingId + idempotencyKey`, поэтому ротация не создаёт новый root. Выпуск, ротация и отзыв идут через policy writer с аудитом. Проверка «текущий principal ∩ scope привязки ∩ G07» выполняется на start, tool, effect и dispatch. |
| F3 | N-37 | Принято, остатки B5, B6 | `AccountBinding.defaultQueueId` (`:45`), §15.27 (`:606`): binding начинает inactive. Ingress атомарно копирует очередь под порядком policy→binding→conversation. Без валидной конфигурации receipt уходит в `blocked_config` и Message не создаётся. Выключить очередь по умолчанию нельзя до выбора замены. |
| F4 | N-37 | Закрыто | `defaultConversationMode=human` (`:45`). auto/assist допускаются только после G04/G07 (`:606`). |
| F5 | N-33 | Принято, остаток B7 | `CrmAuditEntry`, `AdminDeletionLedger`, `ForkMigrationLedger` внесены в §3 (`:42–44`). Идентичность операции описана в §15.27 (`:610`). |
| F6 | N-38 | Принято, остаток B8 | `ResourceAssignment.assignmentKind` с partial UNIQUE для `primary_owner` (`:74`). `assigneeMemberId` — проекция, у неё один writer (`:608`). |
| F7 | L-2 | Закрыто | G08b (`:260`) и `autoCreatePersonEnabled=false` (`:45`). Импорт и restore Person не создают. |
| F8 | M-7 | Принято, остаток B2 | `#cron-gap` (`:375–377`). В подписке хранятся `scheduleRevision`, snapshot расписания и `lastPlannedOccurrence` (`:59`). Автоматического «догона» отправок нет. |
| Self-1 | N-2 | Закрыто | `OmniQueue UNIQUE(workspaceId,bindingId,id)` (`:76`). |
| Self-2 | N-33 | Закрыто | `OmniExecutionReference` хранит `webhookBindingId/credentialKeyId` (`:81`), потомки их наследуют. |
| Self-3 | N-6 | Закрыто **только для записи gap**, остаток B3 | Писатель gap берёт policy в режиме UPDATE (`:377`). Обычный сдвиг курсора в lock protocol не попал. |

**Исходники, перепроверенные в B:** все вызовы `reconcileParticipantTargets`, `reconcileTargetsForPeople`, `reconcileMessageThreadTargets` и `matchParticipants` по `packages/twenty-server/src`. Дополнительно нашлись вызовы из `MessagingMessageCleanerService:123,241`. Этот путь уже закрыт исключением omni в §15.1, поэтому отдельной находкой я его не считаю, но в inventory §15.18 его стоит назвать по имени. Тела `workflow-trigger.controller.ts` и `workflow-cron-trigger-cron.job.ts` я читал на этапе A.

## 2. Новые проявления на этапе B (все Low)

**B1 · N-27.** Spec §4 (`implementation-spec.md:109`) по-прежнему предписывает ingest-worker'у шаг `targetsOnly`. Это противоречит repository-adapter, §7 (`:151`) и phase_1. Исполнитель ROB-764, читающий §4, повторит исходный дефект F1.
*Правка:* заменить на «domain projection из ConversationTarget; matchParticipants/reconcile не вызываются», со ссылкой на repository-adapter.

**B2 · M-7.** В `#cron-gap` сказано: «каждое принятое occurrence продвигает cursor». Если поздний job приходит сразу за срабатыванием k, а курсор стоит на N (k > N+1, сканер ещё не прошёл), допуск сдвигает курсор на k. Промежуток N+1…k−1 после этого сканер уже не увидит, и gap теряется молча. Это нарушает инвариант «gap видим один раз».
*Правка:* срабатывание k допускается только если курсор равен предыдущему запланированному срабатыванию. Иначе в той же транзакции записывается `schedule.gap` за (cursor, k), а потом допускается k. Добавить случай в T14-E.

**B3 · N-6.** В lock protocol (`access-control.md:37`) нет `OmniWorkflowSubscription`, хотя курсор CRON при обычном допуске пишется под SHARE. Нет там и `OmniQueue`/`OmniWebhookBinding/Credential`. Self-3 покрыл только писатель gap. Конкурирующие допуски CRON, которые блокируют conversation и subscription в разном порядке, порядком не ограничены.
*Правка:* поставить subscription (а также queue и webhook-строки при FOR UPDATE) в явную позицию, например сразу после `WorkspacePolicyState` и до `AccountBinding`. Либо прямо указать, что допуск срабатывания CRON берёт policy в режиме UPDATE.

**B4 · N-36.** В `#webhook-auth` (`:371`) истечение `expiresAt` при штатной ротации приравнено к отзыву: «start/tool/effect и dispatch проверяют … expiresAt». Запуск, допущенный старым ключом, теряет эффекты после окончания overlap. Особенно это касается DELAY/WAIT/FORM, которые длятся дольше перекрытия. Видимый терминальный исход для такого запуска не определён. Кроме того, `keyId` уникален только внутри binding (`:58`), а значит путь запроса обязан нести `webhookBindingId`. В тексте это не сказано.
*Правка:* `expiresAt` ограничивает только допуск новых запросов. Отзыв (компрометация) запрещает и уже идущие запуски с `terminal_disposition=credential_revoked` и DurableHandoff. Путь запроса содержит `webhookBindingId`.

**B5 · N-2.** §15.27 запрещает выключать только очередь **по умолчанию**. При этом действует правило §3 (`:93`): «неактивная очередь не даёт доступ». Выключение любой другой очереди с открытыми неназначенными диалогами делает этих клиентов невидимыми, а G08 требует, чтобы невидимого inbox не было.
*Правка:* очередь выключается только если в ней нет открытых неназначенных диалогов, либо с атомарным переносом в замену (policy writer плюс аудит).

**B6 · N-37.** Активация binding проверяет «допустимых читателей» (`:606`), то есть QueueGrant, а QueueGrant появляется только в ROB-766 (`:93`). Критерий готовности phase_1 («входящий виден…») в ROB-764 при этом недостижим. Кроме того, не сказано, кто заново ставит в очередь receipts в `blocked_config` после исправления конфигурации.
*Правка:* в ROB-764 активация разрешена только в изолированных тестовых fixtures с синтетическим grant, реальная активация — с ROB-766. Writer, исправляющий конфигурацию, в той же транзакции переводит заблокированные receipts этого binding в retry.

**B7 · N-33.** `eventKey = workspace/operationId/resourceKind/resourceId/action` (`:610`), и конфликт key/hash «отклоняется». Если одна операция (merge, bulk) дважды меняет одну и ту же строку одним действием, второй INSERT аудита провалит всю бизнес-транзакцию.
*Правка:* один success на строку и действие собирается из итоговых before/after операции. Либо в ключ входит порядковый номер мутации. Добавить случай в T06.

**B8 · N-38** (порождено правкой F6). Появился `assignmentKind=collaborator`, но остался `ConversationMember`. У «участников» теперь два источника, и не сказано, во что пишет `changeParticipants`.
*Правка:* одна фраза, например «ConversationMember = курсор прочтения и проекция collaborator; пишет один policy writer».

**B9 · N-34.** В API (`06-api.md`) нет операций активации binding и изменения `defaultQueueId/defaultConversationMode/autoCreatePersonEnabled`. Нет и чтения записей `schedule.gap`.
*Правка:* добавить `activateBinding/updateBindingDefaults` (policy writer, expectedRevision, idempotencyKey) и запрос gaps для администратора.

**Замечание без находки.** Автосоздание Person по G08b пишет `ExternalIdentity.personId` — атрибут из каталога policy-writers. Значит, ingest в этом случае обязан брать UPDATE с начала транзакции. Это уже следует из общего правила `access-control.md:25`, но стоит добавить в T12/T10.

## 3. Статусы всех 66 корней

`closed` — закрыто в плане (closed_in_plan), содержание подтверждено текущим текстом. `reopened-Low` — открыт новым проявлением B.

| ID | Статус | Текущее доказательство |
|---|---|---|
| H-1 | closed | §15.1 `:286`, T21 |
| H-2 | closed | §15.1 `:290`, §15.21 `:545`, §15.8 `:390` |
| H-3 | closed | access-control#scope, workflow-execution design-6…16 |
| H-4 | closed | #turn-lifecycle, #action-idempotency, §3 Turn/EffectLedger |
| H-5 | closed | §15.4 `:322–328`, §15.24 `:573` |
| H-6 | closed | §15.2 `:302`, §15.7 echo `:382`, §15.24 `:571` |
| M-1 | closed | §15.3 `:314` |
| M-2 | closed | §15.3 `:314`, §15.7 command_cancel, #command-cancellation |
| M-3 | closed | §15.2 `:298` |
| M-4 | closed | §15.2 `:296` |
| M-5 | closed | §15.2 `:300` |
| M-6 | closed | §15.5 `:338`, §15.25 `:588` |
| M-7 | **reopened-Low (B2)** | #cron-gap `:377`. Остальное (design-18…28, run-identity, coverage, cancellation) подтверждено |
| M-8 | closed | §15.8 `:394` |
| M-9 | closed | §15.5 `:332`, StageRule §3 `:75` |
| M-10 | closed | §15.5 `:344` |
| M-11 | closed | §15.5 `:342`, ForkMigrationLedger `:44` |
| M-12 | closed | §4 `:111`, G08b `:260`. Замечание о lock mode в §2 |
| M-13 | closed | design-30…32 |
| M-14 | closed | design-25, design-49 |
| L-1 | closed | §3 `:97` |
| L-2 | closed | §13 с G08b `:260` |
| L-3 | closed | §15.5 `:336` |
| L-4 | closed | §15.1 `:290` |
| L-5 | closed | §15.5 `:334`, #read-authority |
| L-6 | closed | §15.5 `:346`, §15.16 `:474` |
| L-7 | closed | §15.1 `:288`, §15.18 `:502` (остаток F1 учтён в N-27) |
| N-1 | closed | §15.6 `:355`, §15.12 |
| N-2 | **reopened-Low (B5)** | Self-1 закрыт (`:76`); выключение очереди, не являющейся очередью по умолчанию, не покрыто |
| N-3 | closed | design-11, design-15 |
| N-4 | closed | §15.6 `:357` |
| N-5 | closed | §15.7, §15.25 |
| N-6 | **reopened-Low (B3)** | lock protocol `access-control.md:37` |
| N-7 | closed | §15.7 `:384`, #command-states |
| N-8a | closed | §15.9 `:404` |
| N-8b | closed | §15.7 `:382`, MessageLink `:49` |
| N-8c | closed | §15.6 `:357` |
| N-9 | closed | §15.10 `:417` |
| N-10 | closed | #takeover, #auto-admission, G06, G13b |
| N-11 | closed | §15.11 `:427` |
| N-12 | closed | §15.11 `:429` |
| N-13 | closed | §15.13, §15.18 `:489–498` |
| N-14 | closed | #sender-mode, #takeover |
| N-15 | closed (нужно будущее доказательство T19) | #epochs, #lock-protocol, §15.20 `:535` |
| N-16 | closed | §15.16 |
| N-17 | closed | §15.17 `:482` |
| N-18 | closed | §15.18 `:500` |
| N-20 | closed | #send-action |
| N-21 | closed | #control-cas, sending-ui#human-stale-view |
| N-22 | closed | §15.21 `:543`, §15.23 `:561` |
| N-23 | closed | #closed-status |
| N-24 | closed | InternalNote §3 `:64` |
| N-25 | closed | §15.23 `:559` |
| N-26 | closed | #read-authority |
| N-27 | **reopened-Low (B1)** | §7 `:151` противоречит §4 `:109` |
| N-28 | closed | sending-ui#reply |
| N-29 | closed | sending-ui#fifo |
| N-30 | closed | access-control#scope |
| N-31 | closed (нужно будущее доказательство T31) | #read-authority |
| N-32 | closed | sending-ui#timeline |
| N-33 | **reopened-Low (B7)** | §3 `:42–44,81`, §15.27 `:610` |
| N-34 | **reopened-Low (B9)** | `06-api.md` (операция `:116` есть, binding defaults и gaps нет) |
| N-35 | closed | §5 `:129`, AutomationAdmission `:63` |
| N-36 | **reopened-Low (B4)** | #webhook-auth `:363–371` |
| N-37 | **reopened-Low (B6)** | §15.27 `:606` |
| N-38 | **reopened-Low (B8)** | §15.27 `:608` |

**Итог:** 66 корней, из них 57 closed и 9 reopened-Low. Новых корней нет. Шесть из девяти Low (B2, B3, B4, B7, B8 и пропуск API B9) порождены правками R15. B1 — незавершённая правка F1. B5 и B6 — исходные правила, которые правка F3 не синхронизировала.

Статусы старых 54 корней, не затронутых R15, опираются на две вещи. Первая — свежий полный проход A по этому же снимку: он не нашёл по ним дефектов, кроме F1–F8. Вторая — в B я проверил, что их нормативный текст сохранился в текущих владельцах. Повторно в глубину я их не анализировал.

## 4. Ограничения

- Внешние коннекторы (C/H/M) и состояние живого экземпляра недоступны. Квалификация перед переносом остаётся гейтом.
- Хэши не сверялись, `PACKET_INDEX` устарел (см. §0).
- `automation-source-matrix.md` и `automation-source-hashes.json` не дополнены `workflow-trigger.controller.ts` и `workflow-cron-trigger-cron.job.ts`, хотя новые контракты на них опираются. Это пробел в производной карте, не дефект контракта.
- Риски, отмеченные в A без статуса находки (голодание писателя под SHARE, источник replay для SSE, посторонние отправители MAX), остаются квалификационными пунктами T19, T12 и G11/G13.

После исправления B1–B9 достаточно узкой проверки этих девяти мест. Полный новый проход A для этого не нужен, но и «свежим полным pass» такую проверку называть будет нельзя.