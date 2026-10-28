# LOG098 — аудит мягкого удаления и восстановления

ROB765 In Progress. Native audit kernel поддерживает soft-delete/restore для covered
standard/custom объектов. Публичные DELETE_ONE/MANY и RESTORE_ONE/MANY стандартных
Company/Person/Opportunity автоматически получают strict native owner. Public CREATE
и custom autoowner этим не включены.

Сохраняются существующие permissions, visibility, callbacks и SQL-семантика Twenty:
меняются deletedAt/updatedAt, строка остаётся в БД. Audit нормализован как update с
реальным deletedAt diff; implicit updatedAt не добавляет шум. Before lock, mutation,
readback и audit используют один executor. Подавивший требуемое состояние trigger
приводит к rollback. Nested reads DELETE/RESTORE получают scoped repository.

Actual RETURNING id запрашивается внутри независимо от selection и удаляется из
результата, если caller его не просил. Selection захватывается до первого await.
Системный actor автоматических lifecycle операций — crm-api-lifecycle; user/API/app
берутся из существующего server auth context. UPDATE actor сохранён.

## Проверяемая семантика

- Реальные public One/Many для трёх объектов; custom native lifecycle; точные IDs,
  пустая selection, caller mutation, permissions, scoped nested reads.
- Repeated soft-delete/missing target не дают success audit, если SQL не затронул
  строк. Restore уже активной строки остаётся matched SQL update: success с пустым
  changedFields. Soft-delete→restore в одном owner агрегируется first-before/last-after
  в один success с пустым diff. Это прежний контракт writer, не новый no-op filter.
- Actual PostgreSQL audit fault, caught-error poisoning, concurrency и lost COMMIT
  ACK; неизвестный исход не повторяется. Причина PG fault проверяется по всей цепочке
  cause, поскольку существующие ORM wrappers могут оборачивать её несколько раз.
- Физические rows, связанные Person и core File сохраняются; события не публикуются
  при rollback/unknown. Trigger с неправильным deletedAt откатывает операцию.

Итоги и воспроизведение: [results](results.json), [target](target.log),
[regression](regression.log), [types](typecheck-differential.json),
[source](source-snapshot.json), [review](review.md).

Первичный target выявил ошибочные тестовые ожидания: writer сохраняет matched success
с пустым diff, а PG exception может иметь несколько cause wrappers. Изучены flush и
computeTwentyOrmException; исправлены ожидания, production контракт не менялся.

Physical delete/merge и FK side effects, public CREATE/shared access, core/session/
metadata owners, negative audit и health остаются открытыми. Inherited-child event
path сохранён по коду, отдельная полнота всех inherited objects не заявляется.
Новый образ/демо не выкатывались, GitHub Actions и внешние сообщения не использовались.
