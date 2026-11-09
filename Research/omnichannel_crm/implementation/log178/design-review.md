# LOG178 - Независимое ревью дизайна (`skill`, `core.skill`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные аспекты

| Линза | Результат | Детали |
|---|---|---|
| Полнота схемы и проекции `skill` | `pass` | Все 7 сравниваемых свойств `SkillEntity` (`all-entity-properties-configuration-by-metadata-name.constant.ts:1200-1243`: `name`, `label`, `icon`, `description`, `content`, `isActive`, `isSystem`), а также `applicationId` и `isCustom` включены в проекцию `projectSkill`: `values: ['applicationId', 'isCustom', 'isSystem', 'isActive']`, `redacted: ['name', 'label', 'icon', 'description', 'content']`. Текст промпта (`content`) и пользовательские названия никогда не попадают в открытые `values`. |
| Активация и деактивация стандартных навыков | `pass` | `SkillService.activate` и `SkillService.deactivate` вызываются от имени `workspaceCustomFlatApplication`, но могут менять `isActive` у стандартных навыков (`twenty-standard`, `isCustom: false`). В `navigation-menu-item-audit.ts` (`mode: 'skill'`) для навыков другого приложения или с `isCustom: false` разрешается обновление исключительно поля `isActive` при условии, что приложение-владелец активно в `core.application` (`FOR NO KEY UPDATE`), тогда как удаление (`delete`) и изменение прочих полей требуют `isCustom: true` и совпадения `applicationId`. |
| Барьер каскадного удаления и неаудируемых миграций | `pass` | Включение `'skill'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` и `assertNoRemainingApplicationRoleOrPermissionMetadata` закрывает обход через неаудируемый `WorkspaceMigrationRunnerService.executeRun`, автоматически оборачивает системные миграции (`isSystemBuild: true`) в `withApplicationMetadataAudit` и блокирует `ApplicationService.delete` до аудируемого удаления всех навыков приложения. |
| Изоляция от `@license Enterprise` | `pass` | Изменяемые файлы (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`, `navigation-menu-item-audit.ts`, `application-metadata-audit.ts`, `workspace-migration-runner.service.ts`, `skill.service.ts`, `skill.resolver.ts`) не добавляют новых импортов из `twenty-shared/utils` или модулей `@license Enterprise`. |
