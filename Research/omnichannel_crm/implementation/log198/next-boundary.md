# Следующий участок после LOG198

После закрытия `LOG198` (транзакционный аудит правил валидации метаданных `validationRule` в `core."validationRule"` в `ValidationRuleResolver`, `ValidationRuleService`, `CreateValidationRuleTool`, `UpdateValidationRuleTool`, `validation-rule-audit.ts`, `navigation-menu-item-audit.ts`, `application-metadata-audit.ts` и `WorkspaceMigrationRunnerService.executeRun`) следующая открытая граница в рамках `ROB-765`:
- `LOG199`: транзакционный аудит прав доступа и шаринга записей (`recordShare` в `RecordSharingResolver` и `RecordSharingService`: `setRecordGeneralAccess` и управление персональными/ролевыми шарами записей).
