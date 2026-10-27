# LOG-032 — защита omni-переписки от фонового rematch/targets

MatchParticipantService и ParticipantTargetReconciliationService исключают
persisted omni-owned native records перед изменением контактов и targets.
Leaf helper проверяет MessageLink, binding любого статуса и Conversation, включая
пустые threads/удалённые associations. Запросы bounded200, tenant-scoped, ошибки
SQL и некорректные ответы закрывают путь. Идентичность workspace берётся из
обязательного текущего контекста WorkspaceOrmManager; другой transactionScope
отклоняется. Calendar branch остаётся прежним.

## Проверки

[Сводка](verification.json), [полный прогон](tests.txt), [повтор](tests-final.txt),
[типы](typecheck-differential.json), [guard](dependency-guard.json),
[исходники](source-snapshot.json). Все8 LF hashes совпали с проверенным remote overlay.
525 Jest/22 suites +20 dependency +5 checksum =550 distinct PASS.
Новые проверки:18 actual PostgreSQL +50 unit; также выполнен прежний native набор.
После полного прогона исправлены только две аннотации тестов (string[] и literaltrue),
68 затронутых тестов повторены успешно. Runtime код при этом не менялся.

Реальные native таблицы/репозитории и алгоритмы matching/reconciliation; отдельная
тестовая БД и ограниченная runtime role. Fixture расширен опционально, прежний
5-table режим сохранён. Проверены mixed batches, каждый ownership marker,
sourceRecordIds-only/targetsOnly, no-scope path, Person/Company/Opportunity,
calendar regression, rollback, tenant mismatch и отсутствие native events при
полностью защищённом batch. Подменены context/metadata/DI collaborators, не сами
алгоритмы. Полный Nest startup/продуктовый UI не проверялись этой порцией.

Typecheck115roots:136 baseline,0 new/0 changed-file. Первые12 новых диагностик
были в двух тестах и исправлены без ослабления assertions. Недостающие devtypes
lodash.chunk4.2.9/lodash4.17.24 взяты из lockfile и установлены только в изолированный
tooling; одинаковые paths применены к baseline/current,19 прежних диагностик
устранены в обеих сторонах. Repo dependencies не менялись. Полный server typecheck
и новая production-сборка не заявляются.

Dependency guard сначала выявил новые транзитивные Enterprise edges через broad
barrels; зависимости сужены, guard/baseline не ослаблены. Локальное UUID→base36
преобразование проверено на эквивалентность Twenty utility, включая nil/max,
uppercase и случайные UUID. Независимое адресное ревью PASS; Claude/fullarchitecture
round не запускался. Все5 migration sources/checksums неизменны.

## Границы

Это read-time ownership exclusion, а не полный lifecycle fence. Конкурентное
присвоение binding/identity, cleaner/blocklist/reset/account/channel delete,
generic CRUD/merge требуют следующих изменений. Полный T05 и ROB-764 остаются
открытыми. Демо и живые маршруты не менялись, тестовые ресурсы bounded/reused,
GitHub Actions не используется. Следом — атомарный domain receipt apply.
