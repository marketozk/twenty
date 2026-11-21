# Следующий участок после LOG195

После закрытия `LOG195` (транзакционный аудит управления ключами подписи JWT `signingKey` в `core."signingKey"` в `JwtKeyManagerService`, `AdminPanelSigningKeyService` и `AdminPanelResolver.revokeSigningKey`) следующая открытая граница в рамках `ROB-765`:
- `LOG196`: транзакционный аудит полного жизненного цикла пользовательских индексов метаданных (`indexMetadata` в `core."indexMetadata"` в `IndexMetadataService`, `IndexMetadataResolver`, `navigation-menu-item-audit.ts`, `runAuditedApplicationMetadataMigration` и fail-closed барьере `WorkspaceMigrationRunnerService.executeRun`).
