# LOG-024 — хранение сообщений, входящих событий и исходящих команд

Продолжение ROB-764 по принятому плану. Добавлены шесть core entities:
OmniMessageLink, OmniMessageRevision, OmniConversationTarget, OmniIncomingReceipt,
OmniOutgoingCommand, OmniDomainEvent. Это схема хранения, без публичного API,
приёма/отправки, workers и готовой машины переходов состояния.

## Контракты и реализация

- MessageLink связывает штатный Message Twenty с versioned native key; tenant,
  binding и conversation проверяются составным FK. Provider IDs остаются text.
- Receipt имеет уникальный ключ workspace/binding/eventId: новое generation или
  payload не создаёт вторую запись с тем же ключом. Сравнение hash и ответ conflict
  реализует будущий writer. Состояния и lease соответствуют утверждённой модели.
- Command хранит автора, неизменяемое намерение, policy provenance, reply snapshot,
  последовательность отправки, evidence приёма и данные отмены/восстановления.
  Reply, replacement и echo correlation не могут сослаться на другой диалог.
- Event хранит собственную последовательность диалога; для события вне диалога
  conversationId и sequence оба NULL. Revision и Target сохраняют ранние связи
  и ключи дедупликации для будущих writers.

Dynamic workspace Message/record/member ссылки проверяются будущими сервисами;
несуществующие core FK не добавлялись. Полные каталоги provenance/correlation
планом не закреплены: они остаются непустыми text, не выдуманными enum. Канонический
nativeMessageKey уже включает версию; отдельное поле версии не расширяет UNIQUE.
`update:false` — защита ORM-пути, не запрет прямого SQL UPDATE.

Reference/turn/root IDs пока не имеют будущих FK. Наличие поля не разрешает
автоматизацию; ROB-766/769 и activation остаются впереди. Принадлежность policy
маршруту Command также проверяет будущий writer. Тест сохранения acceptance
evidence при outcome_unknown не доказывает готовность монотонного runtime writer.

## Миграция и проверка версий

Штатный генератор сначала подтвердил пустой baseline, затем создал миграцию
`omni-1793094313685-message-persistence`. Все 56 SQL-вызовов up/down перенесены
без изменения в fork registry. Предыдущие два исходника миграций и checksum
сохранены. У прежней Conversation добавлен только UNIQUE(workspaceId,bindingId,id).

Проверка сначала валидирует весь ledger prefix/checksum/status, затем передаёт
точный prefix проверкам схемы. После up проверяется предполагаемый prefix
включая текущую миграцию, до INSERT ledger и COMMIT. Conversation проверяется
по старому snapshot до обновления и по новому после; остальные таблицы не
получили послаблений. Старый бинарник отвергает неизвестную новую запись ledger.

## Проверено

- [113 PostgreSQL tests](pg-tests.txt), включая 32 дополнительных случая к LOG-022:
  populated old-prefix upgrade/replay, empty down/up, drift, дубликаты, tenant/
  binding/conversation FK, большие ID/counters, lease/state/null/sequence checks.
- [20 dependency guard](guard-tests.txt) и [5 checksum tests](checksum-tests.txt):
  всего **138 тестов**. [Полный dependency graph](dependency-guard.json) — 0 новых
  нарушений; прежний долг остаётся, это не полное доказательство лицензии runtime.
- [Focused strict typecheck](typecheck.txt): 49 файлов с импортами. Первичный
  отказ касался выведенного UUID template type тестового helper; явный string
  исправлен, повтор прошёл. Runtime код от этого исправления не менялся.
- [Настоящая native schema](native-schema-verification.json): up/down/up,
  восстановление прежних 11 таблиц после down, сохранность остальных 10 после up
  и всех 256 строк native upgrade history.
- [Зарегистрированный upgrade/replay/readiness](registered-upgrade.json) на
  native schema прошёл; финальный generator diff пустой.
- Адресное независимое ревью entities, snapshot/ledger и тестов — PASS, без
  подтверждённых blocker/major. Claude Code и полный архитектурный круг не запускались.

Проверки выполнены в ограниченных временных PostgreSQL17/Redis containers без
внешних портов, на базовом image LOG-022 с focused SWC compilation. Новый полный
Docker image и полный server typecheck в этой порции не выполнялись.
[Хеши проверенных исходников](source-snapshot.json) · [Сводка](verification.json).

[Cleanup](cleanup.json): собственные containers/exclusive volumes/network удалены,
БД уничтожены вместе с tmpfs. Builder не запускался; неактивные исходники/кэши
сохранены. Образ, start timestamps и health действующего демо не изменились.

## Остаток этапа

Ещё нужны ранние roots/consumer receipts/dispatch plans/reply budgets и
activation/admission согласно spec §3; текущие шесть таблиц не закрывают всю
схему ROB-764. Затем — ingress persistence, атомарный Message+audit+event,
inbox/outbox/recovery и email regression. ROB-764 остаётся In Progress.
Down проверен только для пустых новых таблиц; применение его к данным удаляет
их и не является разрешённым автоматическим production rollback.

## Публикация

Код `161269d6b166cc4fe34ea85fefc47162342381d8` отправлен в текущую ветку.
[Отчёт ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-a5c2ec75).
Описание и единственный комментарий прочитаны обратно; статусы11 задач сохранены.
GitHub CI не стартовал из-за billing block аккаунта; причина подтверждена
аннотациями обоих jobs. [Метаданные и аннотации](publication.json).
