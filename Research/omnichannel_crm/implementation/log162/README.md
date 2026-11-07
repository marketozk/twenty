# LOG162 - аудит встроенных мутаций `roleTarget` в `AgentService`

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG162 закрывает последний сервис, который менял `core."roleTarget"` в обход CRM-аудита: `AgentService` (`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`).

В `role-assignment-audit.ts` добавлен закрытый однотранзакционный аудит `withAgentMetadataRoleTargetAudit` (`targetKind: 'agentMetadata'`, режимы `create`, `update`, `delete`). До запуска транзакции проверяется форма плана миграции: только действия `agent` и `roleTarget` (`create`/`delete`), `0..1` действие `agent.update` при смене роли и порядок `delete` перед `create` среди действий `roleTarget`. Внутри `runInCoreAuditTransaction` блокируются `core.workspace`, `core.application`, `core.agent`, все привязки `core."roleTarget"` затронутых агентов и роли `core.role`; `before`-образ снимается до выполнения миграции, поэтому `ON DELETE CASCADE` по `agentId` не может удалить привязку без аудита, а неучтённая привязка любого удаляемого агента откатывает транзакцию. После миграции и после записи аудита состояние сверяется повторно: точные скалярные поля и метки времени новой строки, отсутствие удалённых строк, неизменность агента и ролей.

`computeAgentFlatRoleTargetToUpdate` больше не порождает `roleTarget.update`: смена роли - `delete` + `create` под приложением миграции, повтор той же роли ничего не меняет. `AgentService` снимает `auditIdentity` до первого `await` и требует её при любом `roleId` во входе и при любом удалении агента: удаление каскадно удаляет привязку, которую снимок кэша мог не увидеть, поэтому удаление всегда идёт через аудируемую транзакцию, которая блокирует агентов `FOR UPDATE` и сверяет их привязки в БД с планом. Создание и правки агента без смены роли работают как раньше. `auditIdentity` передают `AgentResolver` (HTTP-запрос), `CreateAgentTool` / `UpdateAgentTool` / `DeleteAgentTool` (контекст инструмента; `delete_agent` без `authContext` теперь отклоняется, как инструменты ролей) и `WorkflowVersionStepOperationsWorkspaceService` (системные идентификаторы шагов workflow).

Приложение миграции осталось приложением рабочего пространства: подстановка приложения агента обходила бы запреты `FlatAgentValidatorService` на изменение стандартных агентов и `validateAgentTriggersCallerApplication` на изменение триггеров (отклонённая рекомендация 3 ревью дизайна, обоснование в [дизайне](design.md)).

3099 tests/107 suites PASS (678.24s). 181 targeted/9 PostgreSQL suites PASS (18.142s) и 18 unit/2 suites PASS, 12 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 464/465 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 10 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит записей метаданных при установке и синхронизации приложений и `defaultRoleId`](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
