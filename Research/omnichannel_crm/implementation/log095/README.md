# LOG095 — native CREATE в общей audit transaction

ROB765 In Progress. Внутренний nativeAudit owner теперь поддерживает создание
стандартных Company/Person/Opportunity без файловых вложений. Общий runInsert
захватывает вход до await, проверяет покрытие, выполняет прежние permission/validation/
stock проверки и получает фактические INSERT RETURNING IDs. Readback читает реальные
строки с DB defaults и точными значениями; crmRecord/create имеет before:null и exact
object/record descriptor. Значения остаются полностью redacted.

Если caller не запросил id, дополнительный служебный RETURNING id не попадает в
raw/generatedMaps; identifiers содержит фактические IDs. Для пустой selection каждая
реальная вставка возвращает пустой объект в raw/generatedMaps. DO NOTHING учитывает
только реально вставленные строки; пропуски не дают create audit.

save/upsert захватывают весь input и conflict paths до existence lookup и используют
общий poisoning wrapper. Mixed create/update имеют один owner; create и последующий
update одной записи остаются разными action events. Ошибка, перехваченная caller,
не позволяет закоммитить более раннюю часть операции.

## Проверки

- 716 tests / 27 suites PASS, 160.781 s; 31 новый PostgreSQL case, 74 targeted tests.
- Три объекта, generated/explicit IDs, defaults, batch, одинаковый UUID разных
  объектов, partial/empty caller selection, mixed/fully skipped conflicts.
- Точная NUMERIC строка и timestamp микросекунды, nested JSON, redacted payload;
  mixed save/upsert, create→update, реальная FK ошибка и rollback всей операции.
- Audit failure, lost real COMMIT ACK, permissions и stock denial; event/stock
  callbacks после commit; snapshot input до quota/existence await, accessors без вызова.
- Nullable FILES не меняет core. FILES arrays, включая [], пока явно отказаны;
  trigger/default attachment не обходит отказ, исчезнувший after row откатывает INSERT.
- 20 dependency guard tests и 6 migration guard tests PASS, dependency baseline PASS;
  десять migration checksums неизменны.
- Types 333/334 roots: 189/189 existing diagnostics, 0 новых/changed. Full-server
  typecheck не чистый. Пять uploaded/local LF hashes совпадают: [results](results.json),
  [types](typecheck-differential.json), [source](source-snapshot.json).

Первичный target обнаружил оставшийся update-only descriptor guard и неправильную
таблицу параметров Jest. Guard расширен только на create/update; таблицы тестов
исправлены, весь набор повторён. После общего прогона исправлен только generic type
общего save/upsert test helper; targeted/typecheck повторены. Production validators/SQL
не замоканы. Quota и event
collaborators контролируются fixture; реальные billing limits этим не проверяются.

[Targeted](target.log) · [Regression](regression.log) · [Review](review.md).
Образ и демо не выкатывались; внешних сообщений не было; Actions не использовался.

## Следом

Native CREATE FILES: тот же File store, устойчивые parent IDs до enrich, actual-written
parent mapping при DO NOTHING, final native/File postconditions и rollback. До этого
не включать публичный CREATE. Затем сохранить public nested custom creates/shareWith/
upsert контракты; общий CRUD/merge/metadata/session/negative audit остаётся впереди.
