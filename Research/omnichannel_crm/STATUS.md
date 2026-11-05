# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG158:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE/DELETE, назначения ролей сотрудникам, агентам и API-ключам, upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG158 закрывает атомарный аудит всех мутационных точек жизненного цикла `core."apiKey"` (`ApiKeyService.create` / `update` / `revoke`, `ApiKeyResolver.createApiKey` / `updateApiKey` / `revokeApiKey`, `ApiKeyController.create` / `update` / `remove`, `GenerateApiKeyCommand.run`) в одной транзакции `core` / `crm_audit`: при создании ключа `INSERT INTO core."apiKey"`, вставка `core."roleTarget"` и запись двух событий `crm_audit."crmAuditEntry"` (`apiKey` `create` и `roleTarget` `create`) выполняются в единой транзакции под блокировками `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR UPDATE` с проверкой `canBeAssignedToApiKeys === true` без промежуточного неаудированного состояния; при обновлении и отзыве под блокировками `FOR UPDATE` / `FOR SHARE` проверяется запрет реактивации отозванного ключа (`revokedAt === null` при `before.revokedAt !== null` -> `API_KEY_REVOKED`), обновляется `core."apiKey"` и записывается событие `apiKey` (`update`) с повторной проверкой после `audit.flush()`.

3058 tests/103 suites PASS (670.323s). 249 targeted/6 suites PASS (22.68s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 456/458 roots, baseline 238 / current 237 diagnostics, 0 новых/changed-code. Совпали 12 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG158](implementation/log158/results.json) · [исходники и ревью](implementation/log158/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG158`) закрыт. Пакетные и первичные назначения `assignRoleToManyUserWorkspace`, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит пакетного и первичного назначения ролей участникам (`assignRoleToManyUserWorkspace`).
[Следующая граница](implementation/log158/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–158 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
