# LOG091 — native audit для Company, Person и Opportunity updates

ROB765 остаётся In Progress. Внутренний opt-in распространяется со скалярных
полей Company на non-file update/updateMany трёх стандартных CRM objects.
Покрытие определяется настоящими metadata/column shapes и standard universal IDs:
составные поля, JSON, массивы, Date, точные NUMERIC strings, resolved relation FK.
Неявного разрешения custom objects, create/delete/save/upsert/merge или FILES нет.

Вход фиксируется до первого await и проверки coverage: собственный recursive
snapshot копирует descriptor values, отвергает accessors/cycles/unsupported types.
Getters не вызываются, вложенные ссылки не сохраняются. Date копируется встроенным
getTime, собственный __proto__ не меняет prototype. Undefined сохраняет существующую
семантику formatter. Audit хранит metadata field IDs без значений и пользовательских labels.

## Проверки

- **606 tests /24 suites PASS**,151.971s;27 новых PostgreSQL cases,55 targeted tests.
- Partial composite preserve/null/undefined, JSON/array/date capture, exact currency,
  одинаковый UUID в трёх objects, FK rollback, permission denial, actor spoofing.
- Single/batch root/nested getters отказаны без вызова; настоящая FILES metadata
  и неподдерживаемые типы не проходят до persistence.
-26 dependency/checksum unit tests PASS; dependency baseline PASS;10 migration
  checksums неизменны. Five uploaded/local LF SHA256 совпадают.
- Differential types329/330 roots:189/189 existing diagnostics,0 новых и0 в изменённых
  файлах. Это не clean full-server typecheck.
- Независимое read-only review сначала обнаружило accessor bypass между coverage
  и capture; исправлено snapshot-before-coverage и descriptor traversal. Повторный
  проход подтверждённых блокеров не обнаружил; reviewer тесты не запускал.

Первичные fixture failures (несуществующий Person.city) исправлены на jobTitle.
После перестановки capture-before-coverage host-realm structuredClone в Jest вызвал
7 ошибочных отказов для обычных composite/JSON/Date. Собственный descriptor snapshot
устранил несовместимость и второе чтение исходных объектов; финальные тесты проходят.

[Результаты](results.json), [регрессия](regression.log), [targeted](target.log),
[types](typecheck-differential.json), [исходники](source-snapshot.json).

## Границы

Public writers пока не подключены. FILES намеренно отказаны: следующий срез переводит
FilesFieldSync на тот же executor, исправляет authoritative batch record mapping и
добавляет отдельный core File audit с родительской областью доступа.
Далее native CRUD/merge, реальные API writers, metadata/session/negative audit.
Образ не пересобирался и не выкатывался; тесты используют LOG088 image с source overlay.
Демо, коннекторы и клиенты не затронуты. GitHub Actions не использовался.
