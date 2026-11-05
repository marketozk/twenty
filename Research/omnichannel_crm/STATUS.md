# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG157:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE/DELETE, назначения ролей сотрудникам, агентам и API-ключам и upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG157 закрывает атомарный аудит всех четырёх поверхностей изменения прав роли (`RolePermissionFlagService.upsertPermissionFlags`, `ObjectPermissionService.upsertObjectPermissions` / `UpsertObjectPermissionsTool`, `FieldPermissionService.upsertFieldPermissions`, `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates` / `UpsertRowLevelPermissionRulesTool`) в одной транзакции `core` / `crm_audit`: под блокировками `FOR NO KEY UPDATE` / `FOR UPDATE` / `FOR SHARE` проверяются `core.workspace`, `core.application`, `core.role` (`isEditable === true`), отсутствие снятия собственного флага `ROLES` при `canUpdateAllSettings !== true`, согласованность чтения/записи `objectPermission`, принадлежность несистемных объектов и полей (включая зеркальные поля связей) для `fieldPermission`, отсутствие каскадного удаления дочерних предикатов и групп `ON DELETE CASCADE` и принадлежность `workspaceMemberFieldMetadataId` объекту `workspaceMember` для RLS, с редактированием литерального фильтра `value` и повторной проверкой после `audit.flush()`.

3046 tests/102 suites PASS (678.027s). 128 targeted/4 suites PASS (9.811s), 11 unit/1 suite PASS (4.922s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/460 roots, baseline 250 / current 250 diagnostics, 0 новых/changed-code. Совпали 13 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG157](implementation/log157/results.json) · [исходники и ревью](implementation/log157/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget` и прав ролей (`LOG111`–`LOG113`, `LOG156`–`LOG157`) закрыт. Жизненный цикл API-ключей, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит создания, обновления и отзыва API-ключей с атомарной привязкой `roleTarget`.
[Следующая граница](implementation/log157/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–157 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
