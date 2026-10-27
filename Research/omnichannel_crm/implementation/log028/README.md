# LOG-028 — native transaction, аудит и адаптер переписки

ROB-764 остаётся In Progress. Пользователь поручил непрерывно выполнять
согласованный план до проверенных критериев, обновлять документы/Linear и
commit/push; это правило внесено в CLAUDE.md. GitHub Actions не используется.

## Исследование и решение

WorkspaceDataSource.transaction использует pg PoolClient; прежний audit context
ожидал TypeORM QueryRunner. Подмена типа или вторая connection не обеспечили бы
атомарность. Выделен минимальный структурный audit executor с lifecycle;
createCrmAuditWorkspaceExecutor выполняет SQL через исходный scope. Workspace
операции проверяются на совпадение с audit operation, append-only privilege gate
и закрытый redaction catalog сохранены. Существующие QueryRunner callers совместимы.

Строгий commitOutcome включается явно через WorkspaceOrmManager/DataSource.
Прежний default сохранён для upstream callers. Lifecycle закрывается до COMMIT,
после возврата scope/repository executor нельзя использовать повторно. Потерянный
ответ COMMIT, неуспешный ROLLBACK или release дают типизированный unknown; после
попытки COMMIT нет ложного подтверждения отката и afterCommit callbacks не идут.
Проверяется также command COMMIT: PostgreSQL может вернуть ROLLBACK после
перехваченной SQL-ошибки, что не считается успешным сохранением.

withOmniRepositoryOptions сохраняет исходный scope/permissions и принудительно
отключает общие события для шести штатных messaging repositories. Для других
CRM объектов переданные options сохранены. buildOmniNativeMessageReferences
формирует reserved header из UTF-8 length-delimited tuple; входом служит уже
квалифицированный canonical key, не угадываемая identity по raw provider ID.

Первый dependency guard выявил транзитивный Enterprise путь через импорт
широкого типа WorkspaceTransactionScope. Исправление — независимый leaf lifecycle
и структурные generic adapters. Guard/его baseline не ослаблены. Сохранение
generic getRepository<T> проверяется компилятором и тестом.

## Проверки и пределы доказательства

Результаты и точные количества: [verification.json](verification.json),
[Jest](tests.txt), [dependency guard](dependency-guard.json),
[контроль миграций](checksum-tests.txt).

Native PostgreSQL тесты используют настоящий pg Pool и транзакционный runner,
минимальный scope fixture и отдельный probe вместо штатной Message. Проверены
общее соединение, атомарность/rollback, права, ошибки audit insert, stale context,
workspace mismatch, фактический COMMIT с потерей ACK и COMMIT → ROLLBACK.
Unit suite проверяет настоящий WorkspaceDataSource с mock pg client и прежний
legacy path. Helper tests проверяют options/key vectors, а не полный обход listeners.

TypeScript проверен сравнением с неизменённой базой в одинаковой среде:
[отчёт](typecheck-differential.json). В затронутых файлах ошибок нет; новых
диагностик нет. 122 исходные диагностики широкого импортируемого графа
(включая недостающие dev declarations/несовместимости baseline) сохраняются.
Три текста диагностик неизменённых файлов отличаются порядком/сокращением union;
их точные позиции, коды и исходники совпадают, различия сохранены в отчёте.
Это не полный зелёный server typecheck и не новая production-сборка.

Независимые адресные ревью native lifecycle и audit/helper границ не нашли
подтверждённых blocker/major. Claude Code и полный архитектурный круг не запускались.
Четыре миграции не изменены, новые таблицы не добавлены.

## Продолжение

До native Message acceptance нужны actual metadata/repository fixtures,
ownership/header collision guards, Conversation/Identity/MessageLink/revision/
DomainEvent writers и их закрытые audit catalogs. Apply должен брать receipt
последним и перепроверять token/generation/DB expiry. Общий импортный aggregate
не вызывается: он открывает свою транзакцию и запускает postcommit matching.

История требует immutable trusted capture context: текущий внешний envelope
правильно запрещает origin, но поздний worker не может сам объявить history_import.
Нужны также квалификация canonical key в transport adapter и запрет сторонних
APP/background rematch writers для omni-owned записей. Эти требования уже есть
в плане; выполненные helper tests их не закрывают.

applied, native Message acceptance, scheduler, HTTP, коннекторы, UI и переключение
живых каналов этим шагом не заявляются. Демо не меняется.
