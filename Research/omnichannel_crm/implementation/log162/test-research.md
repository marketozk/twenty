# LOG162 - план тестирования и исследовательская матрица проверок

## 1. Целевые сценарии в `crm-audit-agent-service-role-targets.postgres-spec.ts`

Набор поднимает настоящий `WorkspaceMigrationRunnerService` и настоящие обработчики
действий `agent` и `roleTarget` поверх ограниченной роли PostgreSQL (без прав владельца),
а `AgentService`, `AgentResolver`, AI-инструменты и `WorkflowVersionStepOperationsWorkspaceService`
вызываются как в рабочем коде. Действия миграции строятся в порядке
`computeOrderedMigrationActions`: `roleTarget.delete`, `agent.delete`, `agent.update`,
`agent.create`, `roleTarget.create`; `agent.update` создаётся только при непустом диффе
(`compareTwoFlatEntity`).

1. **Создание агента (`createOneAgent`)**: с `roleId` в одной транзакции создаются
   `core.agent`, `core."roleTarget"` и одна запись `roleTarget` (`create`); без `roleId`
   агент создаётся без привязки и без записей аудита.
2. **Обновление роли (`updateOneAgent`)**: назначение роли без правок агента
   (`0` действий `agent.update`) пишет `create`; повтор той же роли (id в нижнем регистре)
   вместе со сменой `label` не трогает `core."roleTarget"` и не пишет аудит; смена роли
   вместе со сменой `prompt` (`[roleTarget.delete, agent.update, roleTarget.create]`) пишет
   `delete` + `create` с общим `operationId`; снятие роли (`roleId: null`) пишет `delete`.
3. **Удаление агентов (`deleteManyAgents`)**: если у любого удаляемого агента появилась
   неучтённая привязка, транзакция откатывается до `ON DELETE CASCADE`; без неё пакет из трёх
   агентов (двое с ролями) удаляется с двумя записями `delete` и общим `operationId`.
4. **Устаревший кэш при удалении**: у агента в кэше нет привязки, а до запуска миграции в БД
   появляется привязка; `deleteOneAgent` отклоняется (`'Role assignment old target changed'`),
   агент и привязка остаются, аудита нет.
5. **Fail-closed до первого `await`**: `createOneAgent` / `updateOneAgent` с `roleId` и
   `deleteOneAgent` без `auditIdentity` отклоняются
   (`'Role mutation requires authenticated audit identity'`), вызов внутри чужого
   аудит-контекста - `'Nested role assignment audit unsupported'`; `cache.getOrRecompute`
   при этом не вызывается.
6. **Неназначаемая роль**: роль с `canBeAssignedToAgents === false` откатывает создание агента
   целиком, а смену роли вместе с правкой `prompt` - вместе с правкой (привязка и `prompt`
   прежние).
7. **Точки входа**: `AgentResolver` create/update/delete (identity из HTTP-запроса, `actor:
   workspaceMember`), `CreateAgentTool` / `UpdateAgentTool` / `DeleteAgentTool` (`actor: agent`,
   `initiator: workspaceMember`) и удаление шага workflow (`system`,
   `workflow-version-step:delete-agent-step`, затем удаление неиспользуемой агентской роли).
8. **Потеря подтверждения `COMMIT`**: `NativeTransactionOutcomeUnknownError`, `ROLLBACK` не
   отправляется, данные и аудит сохраняются, кэш (`flatRoleTargetMaps`, `rolesPermissions`)
   инвалидируется.
9. **Ошибка после подтверждённого `COMMIT`**: `CoreAuditPostCommitError` без `ROLLBACK`.
10. **Вызывающий без права писать аудит**: `pendingActivationUser` создаёт и меняет агента без
    роли; назначение роли и удаление агента отклоняются; удаление с аудируемой identity
    проходит без записей аудита.
11. **Агент другого приложения**: назначение, замена (`delete` + `create`) и удаление роли
    агента, принадлежащего другому приложению, проходят под приложением рабочего пространства
    и аудируются (`create`, `delete`, `create`, `delete`).

## 2. Unit-проверки

- `agent-tools.spec.ts`: новый случай - при наличии `context.authContext` инструменты
  передают `{ auth, agentId }`; прежние ожидания без `authContext` не изменились.
- `update-workflow-agent.tool.spec.ts`: прежние 5 случаев без изменений.

## 3. Регрессионные и граничные проверки

- 9 PostgreSQL-наборов аудита ролей, привязок и API-ключей + 2 unit-набора.
- Полная регрессия `ROB-765`.
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`,
  `check_fork_migration_sources.py` и guard unit-тесты.
