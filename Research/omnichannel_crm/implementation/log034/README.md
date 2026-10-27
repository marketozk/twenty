# LOG-034 — сохранность переписки при штатной очистке

MessagingMessageCleanerService исключает omni-owned сообщения до удаления связей,
а затем до удаления orphan Message/Thread. Thread, связанный с Conversation,
защищён даже без сообщений. Владение определяется persisted binding любого статуса,
MessageLink или Conversation, включая soft-deleted associations. SQL ошибки и
несовпадение tenant context прекращают операцию, без fallback в обычную очистку.

Blocklist job проверяет тот же ownership до прямого association delete. Удаление
папки сохраняет protected junctions, ограничивается текущим каналом и учитывает
soft-deleted ordinary associations: junction удаляется, счётчик остаётся0.
Канальная/папочная keyset pagination продвигается по полной странице до фильтрации;
защищённая первая страница не мешает обработать следующую обычную.

## Проверки

[583 Jest](tests.txt), [повтор25](target-final.txt), [сводка](verification.json),
[TypeScript](typecheck-differential.json), [harness](typecheck-differential.cjs),
[dependency guard](dependency-guard.json), [исходники](source-snapshot.json).
Всего608 distinct PASS с20 dependency и5 checksum тестами. Новые25 PostgreSQL
проверок выполняют настоящие сервисы, SQL и native FK cascade/SET NULL из standard
metadata: каждый ownership marker, emptyThread, >500/>200 protected page,
foreign-channel junction, soft-delete, workspace mismatch и rollback после
ошибки ownership query уже после предыдущего DELETE.

Fixture по умолчанию оставлен совместимым; новые проверки явно выбирают штатные
FK actions. Transaction options передаются без подмены production default;
после этого уточнения все25 тестов повторены. Первые две ошибки были нарушением
unique index тестовым seed; ограничения не ослаблялись. Предупреждения rollback
в полном логе относятся к успешным fault-injection tests, не к сбоям cleanup.
Typecheck124roots:136 baseline/current,0 новых/0 в изменённом коде. Полный server
build/typecheck не заявляется. Независимое scoped review — без блокеров.
Все5 migration source checksums неизменны.

## Границы

Это point-in-time ownership exclusion, не полный lifecycle fence. Удаление
metadata ConnectedAccount/MessageChannel/MessageFolder и гонки с binding bootstrap
ещё требуют защиты. Folder actions caller пока может удалить core folder после
сохранения protected junctions (поле folderId не имеет FK cascade); LOG-035
закрывает именно эту границу и предварительные внешние эффекты account deletion.
Обычный count API cleaner не расширялся. Полный T05/ROB-764 остаётся открыт.
Демо, HTTP, production ACL и коннекторы не активировались; Actions не запускался.
