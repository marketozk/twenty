# Вердикт: **needs_revision**

План в целом подробный и согласованный: модель отказов, ingress, outbox, повторы, восстановление, cutover, workflow, миграции и gates G01–G18 расписаны так, что по ним можно работать. Большинство утверждений о коде на снимке `729f6236` подтвердились. Но три расхождения с реальным кодом нужно исправить в спецификации до первых правок. Одно из них блокирует production.

## Что сверено с кодом и подтвердилось

- `WorkspaceTransactionScope.getRepository(name, roleConfig, {shouldSkipEventEmission})` существует, и data source действительно передаёт этот флаг (`workspace-data-source.ts:108-121`). Флаг отключает отправку событий (`workspace-repository.ts:1395,2069`).
- `saveMessagesWithinTransaction` и `saveMessageParticipants` вызывают `getRepository` с двумя аргументами. Ищут сообщение по `headerMessageId` во всём workspace, а поток — по `messageThreadExternalId` в пределах канала. Поэтому обёртка из §15.10 и namespaced header нужны и выполнимы. `matchParticipants` принимает опциональный `transactionScope`.
- `UpgradeSequenceReaderService.getUpgradeSequence` группирует команды: fast → slow → workspace (`:39-60`). Вывод §15.5 о том, что одного нового timestamp недостаточно, верен.
- `CoreWorkflowRunnerService.run` принимает `workflowRunId`, а при hard throttle сразу создаёт запуск в статусе FAILED (`:112-148`). §15.17 это корректно учитывает. Есть cron, который подхватывает запуски в статусе NOT_STARTED.
- `TimelineMessagingService` обходит проверку прав и отдаёт `lastMessageBody` (`:61,303`). В `ApplicationMessageIngestionService` стоит `attachments: []` (`:164`).
- У `ConnectedAccount` поля `applicationId`/`connectionProviderId` допускают NULL с CASCADE, `userWorkspaceId` — NOT NULL, `transferOwnership` останавливает webhook-подписки.
- LICENSE: файлы с пометкой Enterprise подпадают под Commercial License. Для production нужна подписка, разработка и тестирование без неё разрешены (`LICENSE:732-748`). Формулировка §15.13 верна.

Утверждения о внешних коннекторах (`C/schema.sql`, уникальный ключ `bridge_journal` в MAX) в этом проходе не проверены: их исходники вне репозитория, поиск по рабочему столу не уложился в таймаут.

## Блокирующие дефекты плана

### F1 — Высокая. Enterprise-код сидит в общем ядре, а не только в row-access
**Где:** §15.13, G18, `license-inventory.md`.

План описывает проблему узко: «build-row-access-policy импортирует buildRecordShareGate». На деле:
- `workspace-repository.ts:33-76` — основной ORM, через который проходят все чтения и записи, — сам импортирует около 15 модулей с пометкой Enterprise. Среди них проверка validation rules и RLS при записи (`validateRecordsAgainstValidationRulesOrThrow`, `validateRLSPredicatesForRecords`), inherited readability, `canRolesAccessAllRecords`.
- `RecordAccessPolicyService` (Enterprise) уже стоит в штатном пути:
  - для SSE — `object-record-event-publisher.ts:34-54`;
  - для webhooks — `call-webhook-jobs.job.ts:21`;
  - для logic functions — `call-database-event-trigger-jobs.job.ts:26`;
  - ещё есть `ShareWithService` в create-many (`common-create-many-query-runner.service.ts:50-54`), `workflow-run-record-share`, `agent-chat-sharing`, а `core-engine.module.ts:75-76` регистрирует модули RLS и RecordShare.

**Сценарий:** этапы ROB-764…769 строятся и проверяются на этих путях (подавление событий, SSE, workflow, ORM-хуки). Затем manifest в начале ROB-766 или G18 перед production требует их заменить. Тесты T05/T08/T14 приходится переделывать, а выпуск в production не запланирован ни по объёму, ни по срокам. При этом §15.6 прямо полагается на то, что «обычные unrelated workflows сохраняют контракт», то есть на эти же upstream-потребители.

**Минимальная правка:**
1. Внести в license-inventory уже известный список модулей с пометкой Enterprise в общем runtime.
2. Для каждого модуля записать решение: своя замена, отключение функции (validation rules, record sharing, RLS predicates, общий доступ к чатам агента и запускам workflow) или исключение из сборки. Плюс проверить, используются ли эти функции сейчас в нашем экземпляре.
3. Перенести статическую проверку импортов/DI и тестовую сборку (файлы Enterprise исключены или бросают исключение) в CI с первого патча ROB-764, а не начинать её только в ROB-766.
4. Расширить T20: SSE, webhook, logic function и create-many для обычных объектов без Enterprise-модулей.

Сама реализация собственных прав остаётся в ROB-766. Решение D-18 не меняется.

### F2 — Средняя. `scope='WORKSPACE'` открывает omni-аккаунт штатным путям «доступен вызывающему»
**Где:** §15.11, F-08.

В коде `isConnectedAccountUsableByCaller` возвращает `true` для любого участника workspace при `scope === 'WORKSPACE'` (`is-connected-account-usable-by-caller.util.ts:10`). На этом признаке держатся:
- `findUsableByCaller` — список аккаунтов в настройках (`connected-account.resolver.ts:58`);
- `verifyUsableByCaller` — каналы и папки (`message-channel-metadata.service.ts:104,162`, `message-folder-metadata.service.ts:77`) и мутация `startChannelSync` (`channel-sync.resolver.ts:49`).

**Сценарий:** менеджер без права на binding видит handle и имя userbot-аккаунта и его канал и может запустить синхронизацию канала. Это противоречит F-08 («видимость подключённых аккаунтов») и тезису §15.1 о том, что владение connectedAccount не даёт обхода. §15.11 закрывает только изменение scope/archive/sync, но не чтение и не эти операции.

**Минимальная правка:** один из двух вариантов.
- Задать `scope='USER'` с custodian-владельцем: доступ к omni и так идёт через собственный ACL.
- Или исключить аккаунты с omni-binding из `findUsableByCaller`/`verifyUsableByCaller`/channel-sync, пока нет собственного разрешения на binding.

Тест в T08: участник без прав на binding не видит аккаунт, канал и папки через metadata-запросы, `startChannelSync` отклоняется.

### F3 — Средняя. Перепривязка участников при смене email сотрудника переписывает omni-строки и шлёт общие события
**Где:** §15.1, §15.6, §15.7.

`MessageParticipantWorkspaceMemberListener` при обновлении `userEmail` запускает `matchParticipantsForWorkspaceMembers` (`match-participant.service.ts:248-283`). Он находит всех участников с этим `workspaceMemberId` и, в отличие от `matchParticipantsForPeople` (`:320`), **не исключает APP-каналы**. Затем вызывает `updateMany` через репозиторий без `shouldSkipEventEmission`.

**Сценарий:** у менеджера, который отвечал в omni-диалогах, меняется email. Строки `messageParticipant` в omni обнуляются вне доменной команды, и генерируются UPDATED-события в webhook, workflow-триггеры и timeline. §15.7 признаёт только потерю авторства. Но это нарушает §15.1 (generic-изменения omni-строк запрещены) и §15.6 («ноль обходных вызовов»).

**Минимальная правка:**
- Добавить `MessageParticipantMatchParticipantJob` (ветка workspace member) в перечень lifecycle-писателей §15.1.
- Исключать omni/APP-участников так же, как `withoutAppChannelParticipants`, либо не заполнять `participant.workspaceMemberId` для omni.
- Тест T22/T14: смена email сотрудника даёт ноль изменений omni-участников и ноль событий.

## Неблокирующие замечания

- **F4 — Низкая.** Для `OMNICHANNEL_EVENT` точки интеграции перечислены (shared, validator, front), а для workflow-действия «Отправить в диалог» (06-api, F-06) — нет. Нужно добавить: тип действия, валидатор, executor, форму во front, явный `conversationId`, sender class по §15.14.
- **F5 — Низкая.** §5 говорит, что импорт «подавляет business CREATED/UPDATED», а §15.6 подавляет только omni-репозитории. Нужно явно записать: автосоздание Person при импорте отключено, либо его события допустимы.
- **F6 — Низкая.** В таблице §4 состояние называется `outcome_unknown`, в тексте — `unknown`. Стоит выбрать одно имя для wire-контракта.

## Не дефекты плана: тесты реализации и продуктовые gates

- **Тесты:** T01–T33 ещё не написаны и не запускались. Ключевые из них: T02/T06/T08/T13/T16 с отрицательным контролем, T20 в расширенном виде из F1, T22 с добавкой из F3, T33 (fork runner).
- **Решения владельца:** G01–G17 — роли и воронки, аккаунты, QR/onboarding, ИИ-провайдер, обе reply-политики, burst, QueueGrant, custodian, импорт и хранение, нагрузка, backup, размещение, изоляция тестов, роли БД, интеграции, служебные уведомления. Это законные gates; план не выбирает значения за владельца.
- **G18:** остаётся fail-closed gate для production. F1 требует не снимать его, а запланировать работу по нему и проверять в CI с самого начала.

**Нужно ваше решение:** вносить ли правки F1–F3 в спецификацию перед реализацией. Сверку с прежними ID замечаний сделаю после этого ответа, как и договаривались.
