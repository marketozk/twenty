# LOG096 — independent review

Read-only reviewer: native_transaction, текущий runtime/test diff.

1. Skipped parents ранее исключались из final File readback. BEFORE INSERT trigger
   мог изменить planned File и вернуть NULL. Исправлено: читаются все planned File
   rows, полный DB JSON snapshot skipped row сравнивается с before. Реальные allskip
   и mixed trigger tests изменяют size и подтверждают rollback.
2. `id ?? randomUUID()` менял смысл explicit null только у inserts с вложениями.
   Исправлено: генерация только при undefined; null остаётся отказом, PG test добавлен.

Проверены actual returned parents, scoped same-executor writes, FILES postconditions,
mixed save/upsert poisoning и unknown COMMIT propagation. Финальный read-only
re-review подтвердил оба исправления и не нашёл новых блокеров. Тесты reviewer
не запускал; PostgreSQL/type/guard проверки выполнял root.
