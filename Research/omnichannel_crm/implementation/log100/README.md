# LOG100 — отзыв сессий с приоритетом безопасности

ROB765 In Progress. Single/bulk UserSession revoke использует strict core owner,
ordered row locks, actual UPDATE IDs и точный readback. После UPDATE создаётся
SAVEPOINT для audit. Ошибка writer или audit-trigger corruption откатывает только
часть audit и явно сигнализируется SESSION_REVOCATION_AUDIT_UNAVAILABLE. Сам revoke
остаётся. Неуспешный rollback savepoint — failure, а не фиктивный успешный отзыв.

До и после audit проверяются revokedAt/reason и неизменность остальных persisted
полей кроме штатного updatedAt. Предоставленные scope/exclusion filters сохраняют
isDefined semantics: malformed UUID отклоняется, не расширяет цель операции.
Повторный отзыв не меняет исходный reason/time и не создаёт второй success.
NULL-workspace session отзывается без выдуманной workspace audit записи.

Cache eviction выполняется независимо от audit/event/commit outcome. При сбое
mdel явно логируется SESSION_REVOCATION_CACHE_INVALIDATION_FAILED; DB revoke остаётся.
Cached authentication теперь всегда проверяет authoritative revoked state: stale
Redis не возвращает доступ, DB read failure запрещает вход. Это дополнительный DB
read на cache hit; глобальное fencing concurrent sign-in остаётся отдельной задачей.

Actor из server entrypoint: self/bulk user, credential sign-out; supersede — новый
пользователь, stop impersonation — реальный initiating user. Для текущего impersonation
sign-out initiator membership разрешается внутри savepoint без target workspace
ограничения. Недоступный initiator вызывает audit loss alert, не отменяет revoke.

Review исправления: полная проверка остальных колонок; isDefined scope filters.
Reviewer native_transaction после исправлений не нашёл новых блокеров; без edits/tests.
Refresh-token/appToken audit, account-wide session fencing и physical cleanup не
объявляются готовыми. Full HTTP/browser suites и deployment не выполнялись.
GitHub Actions и внешние сообщения не использовались.

835 tests/30 suites PASS, 15 новых PG cases, 43 targeted. 26 guards PASS, 10 migration checksums неизменны. Types: все изменённые server roots включены явно, 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed. 4 source hashes совпадают.

[Results](results.json) · [Regression](regression.log) · [Types](typecheck-differential.json) · [Review](review.md).
