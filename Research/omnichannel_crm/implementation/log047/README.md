# LOG047 — Command creation restore context

Реализована проверка допуска первого claim после восстановления БД. Старый снимок
pending/revision1 не доказывает отсутствие произошедшей внешней отправки.

Новая nullable UUID колонка createdRestoreIncarnation сохраняется admission под
policy lock и включена в безопасные audit values. Replay не relabel/backfill.
Claim с NULL/несовпадением даёт restore_reconciliation_required после current auth.
Это не transport send capability. Historical reconciliation не блокируется этим
полем; provider journal/fence и restore coordinator остаются обязательными.

Седьмая fork migration добавлена через изолированный registry: upstream cursor и
upgrade-aware decorators не используются. Полный snapshot Command проверен на
PostgreSQL; первые6 immutable migration sources и прежний aggregate не менялись.
Generated UUID default отдельно проверяется через pg_attrdef, поскольку TypeORM
скрывает его при обычной snapshot introspection.

## Проверки

- [Полный fork suite](tests.txt): 1460 тестов /61 suites.
- [20 dependency guard tests](guard-tests.txt) и [6 migration checksum tests](checksum-tests.txt).
- Всего 1486 PASS; focused прогон включён в полный и повторно не суммируется.
- [Typecheck](typecheck-differential.json): 200 roots,
  146 baseline/current diagnostics,0 новых/0 changed-code.
  Это differential проверка области, не полный server typecheck/build.
- [Dependency guard](dependency-guard.json), [7 migration sources](migration-checksums.txt),
  [совпадение исходников тестового запуска](source-snapshot.json), [сводка](verification.json).

Проверены populated prefix6→7, down/up/replay, NULL без backfill, неправильные
тип/nullability/default/extra/missing column; current grants; admission/replay,
первый claim и historical reconcile old/NULL; policy locks при admission и claim;
подмена policy/Command во время audit и AFTER UPDATE. Post-audit readback откатывает
такие изменения вместе с success audit. Прежние fault/COMMIT ambiguity, lease,
native incoming/sent и email regression тесты включены в полный прогон.

Независимое scoped review: блокеров не найдено; reviewer не запускал тесты,
его рекомендация о migrated NULL покрыта основным прогоном. Полный Claude review
не заявляется. Демо/live connectors не менялись, HTTP/cron не включены, Actions нет.

## Следующий шаг

Локальная отмена virgin pending с той же incarnation и проверенными правами;
затем общий domain-only native mutation guard. [Матрица ROB-764](../rob764-acceptance.md)
содержит оставшиеся критерии. ROB-764 остаётся In Progress.
