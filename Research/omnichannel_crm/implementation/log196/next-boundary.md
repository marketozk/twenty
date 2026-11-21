# Следующий участок после LOG196

После закрытия `LOG196` (транзакционный аудит пользовательских индексов метаданных `indexMetadata` в `core."indexMetadata"` в `IndexMetadataResolver`, `IndexMetadataService`, `index-metadata-audit.ts`, `WorkspaceMigrationRunnerService.executeRun` и `application-metadata-audit.ts`) следующая открытая граница в рамках `ROB-765`:
- `LOG197`: транзакционный аудит создания, мягкого и жёсткого удаления представлений (`coreView` `create` / `delete` / `destroy` в `ViewService`, `ViewResolver` и `ViewController`, дополняющий аудит смены владельца и видимости из `LOG169`).
