# LOG108 — аудит прямого ON DELETE CASCADE

ROB765 In Progress. Internal nativeAudit delete теперь поддерживает непосредственные
CASCADE и SET NULL для covered local child metadata того же workspace с простым
relation/morph FK на parent.id. PostgreSQL выполняет прежний cascade; ручные child
mutations, дополнительные child events и отдельные child permissions не добавляются.

План хранит action каждой FK column, объединяет child IDs, берёт sorted child locks
и перечитывает before-image. Конфликт CASCADE/SET NULL на одной колонке запрещён.
Для потенциально удаляемых children проверяются пустые FILES, retained omni identities/
conversation targets/native references через существующий finder с точным child
metadataId/name и отсутствие дальнейших incoming references. Root detached-parent
capability детям не передаётся. Защита действует под существующим ownership fence.

Фактические parent RETURNING IDs определяют результат: child удаляется, если хотя бы
одна его CASCADE-ссылка указывает на реально удалённого parent. Иначе применяются
только фактические SET NULL; остальные поля неизменны. Пропущенный parent не даёт
ложного child delete. Удалённые дети должны отсутствовать и получают crmRecord/delete
с deletedRecord currentWorkspaceAdministration; выжившие получают update. Несколько
каскадов одной строки агрегируются. Предварительный child update сохраняет отдельное
action event. Ошибка/пойманная ошибка откатывает весь граф; lost ACK не повторяется.

Проверяются смешанные и двойные FK, archived children, FILES/retained/transitive
refusal, skipped parent, child trigger preventing delete, audit fault, оба порядка
reparent, lost ACK и прежнее SET NULL поведение. Read-only review блокеров не нашёл;
generic retained finder проверен предыдущими тестами, новый кейс проверяет Person identity.

Ограничения: одноуровневый граф; unsupported/system children, composite/non-id/self
FK, конфликт actions, непустые FILES и actual дальнейшие references всё ещё отказываются.
Public DESTROY/MERGE не подключены; файл физически удаляется отдельной цепочкой,
для которой ещё нужен надёжный владелец выполнения и аудита. Arbitrary trigger SQL
вне заявленного покрытия. Демо, образ и внешние сообщения не затронуты; Actions нет.

998 tests/33 suites PASS (197.09s); 134 targeted/4 suites PASS. Прирост 20 PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 345/345 roots, 189/189 прежних диагностик, 0 новых/changed-code. 3 local/remote source hashes совпадают.
