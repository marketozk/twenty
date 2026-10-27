# LOG-039 — durable обработка config wake-up

Статус: внутренние функции и их проверки выполнены. Готовность этапа ROB-764 не заявлена.

Исследование LOG-038 выявило отсутствие durable checkpoint у config recovery.
Существующий ConsumerReceipt относится к workflow execution и требует реальные
pinnedVersion/execution IDs. Использовать его с фиктивными UUID нельзя.

Выбрана отдельная небольшая BindingConfigWakeup для одной фиксированной служебной
задачи. Stateless повторное сканирование безопасно благодаря идемпотентности,
но теряет продвижение после crash и повторно обходит большие неподходящие префиксы.
Контракт добавлен единожды в [спецификацию §3/§15.27](../../plan/implementation-spec.md).

Кодовые точки: LOG-038 config mutation producer/closed event schema, LOG-037
resume leaf и strict workspace transaction lifecycle. Новый append-only fork step
добавляет служебную строку; предыдущие5 миграций не переписываются.

План проверки: atomically event+wakeup; no-op/replay; schema FK/check/index и drift;
bounded reconciliation оригинальных событий; restart между страницами; два worker;
expiry после audit; точный cursor; SKIP LOCKED и повторный проход; смена generation;
inactive/revoked/unknown handler; rollback/unknown COMMIT; отсутствие workflow/send.
Проверки выполнены в прежних ограниченных временных PostgreSQL/Redis ресурсах, без
изменения демо, транспорта или GitHub Actions.

## Результат

Producer атомарно создаёт event, wakeup, audit и mutation receipt. No-op/replay
не создают повторную доставку. Новые internal API: reconcile (bounded backfill
проверенных прежних событий), claim, process page и rearm завершённого прохода.
Все требуют active strict transaction и явного current authorizer; process
дополнительно проверяет history.resume. Неизвестные handler версии и inactive
binding не будят сообщения. Некорректные backfill events возвращаются списком IDs.

Page сохраняет точный DB cursor и needsRescan; занятые или изменившиеся eligible
receipts не теряются за курсором. При смене поколения проход начинается заново,
старые receipts не получают новый generation. Wakeup lock берётся последним,
checkpoint CAS проверяет owner/token/expiry после всех success audit inserts.
Claim тоже проверяет оставшееся время аренды после audit. Возобновление receipts
и checkpoint имеют один commit; потерянный COMMIT ACK не выдаётся за успех.

## Доказательства

- [Полная регрессия](tests.txt):890 Jest/35 suites PASS; [прицельный прогон](target.txt):204 PASS.
- [Сводка](verification.json):890 +26 Python guards =916 различных проверок PASS.
- [TypeScript](typecheck-differential.json), [harness](typecheck-differential.cjs):152 roots,
  146 baseline/current,0 новых и0 changed-code diagnostics. Это не полный server build.
- [Native schema](native-schema-verification.json), [generator](generator.txt): baseline diff
  пустой,10 SQL statements совпали с генератором. Up/down/up не изменил25 прежних
  таблиц и256 записей upstream upgrade history; проверка завершена rollback.
- [Исходники](source-snapshot.json) совпали по LF SHA256 с проверенными удалёнными файлами.
- [Migration guard](migration-checksums.txt), [его6 тестов](checksum-tests.txt),
  [dependency guard](dependency-guard.json), [его20 тестов](guard-tests.txt) прошли.

Первый typecheck выявил один Promise union в новом test helper; [диагностика](typecheck-initial.txt).
Добавлен async, затем полный финальный прогон и typecheck прошли. Root review
исправил точность nextAttemptAt в producer/audit и истечение lease во время claim audit.
Независимое scoped review runtime/locks/cursor без новых блокеров; новый полный
Claude cross-review не заявляется. Использованы ai-dev-workflow, behavioral-guardrails,
server-schrodinger.

## Границы и продолжение

Это scope-accepting внутренние функции, а не подключённый scheduler. Strict owner
ещё должен связать их с native workspace context и failed/denied audit только
после подтверждённого rollback. completed означает один проход; поздние blocked
receipts требуют периодического rearm. Следующий LOG-040 добавляет этот owner и
bounded housekeeping, затем продолжаем исходящие команды/outbox. Реальный grant
provider, activation, HTTP/UI и живые коннекторы остаются в своих этапах.
