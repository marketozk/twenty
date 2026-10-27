# LOG-033 — атомарное применение исторического сообщения

Новый отдельный метод существующего native aggregate открывает strict workspace
transaction; bound native port вызывает прежние message/participant helpers на
том же scope, с подавлением generic events. Domain writer независимо проверяет
native postconditions и сохраняет Link, Revision, sequence/replyRevision,
DomainEvent, suppressed Root/Dispatch, audit и applied receipt.resultId=MessageLink.
Текст импортируется к существующей Person/Conversation; Thread title/updatedAt
не меняются (subject:null, прежний helper не выполняет upsert).

Поддерживается только qualified incoming complete text history_import текущего
поколения, существующая verified identity/Person/active Queue и disabled v0.
Authorizer обязателен при первом вызове и replay: проверяет текущий import grant,
qualification и связь источника с server-selected identity. Полная production ACL
здесь не реализована, fixture предоставляет явные synthetic grants. Поле автора
из wire не назначает Person или external_human. Live, outgoing, edit/delete,
placeholder, unqualified receipt и новая доставка существующего canonical key
явно отвергаются для будущей обработки; worker deferral/reconciliation ещё впереди.

## Транзакция и повтор

Порядок parent locks соответствует общему контракту, receipt блокируется последним.
После ожидания Conversation повторно читается receipt без раннего receipt lock:
два параллельных обработчика дают одно создание и один replay. Kind/version,
envelope/capture hashes, current generation/queue/policy и native ownership
проверяются. Final lease CAS выполняется после audit.flush; expiry откатывает всё.

Suppressed storage root не является AutomationAdmission: targets пусты, бюджеты0,
нет replies/consumers/AI/workflow jobs. Его представление уточнено в owner-контракте
[workflow execution](../../plan/contracts/workflow-execution.md); resultId — в
[схеме](../../plan/implementation-spec.md). Replay сверяет сохранённые native/core/
audit evidence, не перезаписывает содержимое. Произвольная порча сторонними writers
и полный будущий lifecycle не объявляются закрытыми.

Известный rollback порождает отдельный failed/denied audit. Недоступность этого
журнала видима ошибкой, а не ложным успехом. Commit/rollback/release uncertainty
остаётся Unknown; повтор сначала сверяет applied result. Класс UnknownError вынесен
в leaf без зависимостей, runner reexports тот же class для совместимости; dependency
guard не получил исключений. Старый aggregate метод целиком текстуально сохранён.

## Проверки

[Сводка](verification.json), [558 Jest](tests.txt), [guard](dependency-guard.json),
[TypeScript](typecheck-differential.json), [точный harness](typecheck-differential.cjs),
[10 исходников](source-snapshot.json). 558 Jest/23 suites +25 Python =583 PASS;
352 PG/206 unit, новые33 PG. Все5 миграций неизменны; generation не требовалась.

Реальные native таблицы/репозитории, fork schema и runtime role в отдельной БД:
accept→claim→apply→Person relation; competing replay; identity/access/hash/generation
failures; original source/capture time; 7 настоящих SQL trigger failures после
Link/Revision/Root/Event/Dispatch/Audit/applied Receipt writes; rollback всей операции
и отдельный attempt. Проверены видимость только после commit, неизменность Thread,
ноль generic events/admissions, lease expiry во время настоящего audit INSERT.
COMMIT реально исполняется PostgreSQL, затем клиентская обёртка имитирует потерянное
подтверждение; следующий replay возвращает сохранённый результат без повторных строк.
Это fault injection, не испытание реального сетевого оборудования.

Typecheck119roots:136 baseline/current,0 новых/0 changed-code diagnostics. В старом
неизменённом saveMessagesAndEnqueueContactCreation сохраняется одна baseline
TS2345 (nullable participant handle). Harness отделяет её только при совпадении
baseline file/code/message и точного текста AST method; независимое ревью дополнительно
сравнило весь прежний хвост класса. Остальные диагностики не исключаются. Полный
server typecheck и новая production-сборка не заявляются. Scoped review PASS;
новый Claude/fullarchitecture round не запускался.

## Продолжение

Полный ROB-764/T05 остаётся открыт. Далее guards cleanup/lifecycle, новые диалоги/
контакты и live admission, остальные варианты apply, outbox/recovery. UI/production
ACL/коннекторы не включены; демо прежнее. Ограниченные тестовые ресурсы переиспользованы,
GitHub Actions не использовался. Это проверенный участок реализации, не готовый
пользовательский импорт или завершённый проект.


Публикация LOG-033: `ab0a69aa1de352a9b2d12132245d77ed355ea4db`; remote SHA проверен API. Описание ROB-764 и комментарий `024f4cee-eecc-4f2f-b857-0752b76ed7a3` прочитаны обратно, все11 статусов прежние. [Метаданные](publication.json). Продолжаем LOG-034.
