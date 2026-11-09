# LOG177 - Независимое ревью дизайна (`connectionProvider` и `reportAppConnectionAuthFailure`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные аспекты

| Линза | Результат | Детали |
|---|---|---|
| Полнота схемы и проекции `connectionProvider` | `pass` | Все 9 сравниваемых свойств `ConnectionProviderEntity` (`all-entity-properties-configuration-by-metadata-name.constant.ts:1916-1960`) и `applicationId` включены в проекцию `projectConnectionProvider`: `values: ['applicationId', 'type', 'scope']`, `redacted: ['name', 'displayName', 'logo', 'oauthConfig', 'identifyAccountLogicFunctionUniversalIdentifier', 'onConnectLogicFunctionUniversalIdentifier', 'onDisconnectLogicFunctionUniversalIdentifier']`. В `UpdateConnectionProviderActionHandlerService` все свойства имеют `universalProperty: undefined`, поэтому ключи `action.update` совпадают с колонками `core."connectionProvider"`. |
| Барьер каскадного удаления и миграций | `pass` | Добавление `'connectionProvider'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` и `assertNoRemainingApplicationRoleOrPermissionMetadata` блокирует как неаудируемые миграции в `WorkspaceMigrationRunnerService.executeRun`, так и тихое каскадное удаление `ON DELETE CASCADE` при `DELETE FROM core.application` (`ApplicationService.delete`). При планируемом удалении `connectionProvider` проверяется отсутствие оставшихся ссылок в `core."connectedAccount"`. |
| Совместимость `reportAuthFailureOrThrow` с гонкой переподключения и кодами ошибок | `pass` | Предварительное чтение `lastCredentialsRefreshedAt` и повторная сверка под `FOR UPDATE` внутри `runAuditedAppConnectionAuthFailureReport` сохраняют защиту от перезаписи свежего токена устаревшим отчётом (`status: 'superseded'`, `0` записей аудита), а возврат `{ status: 'not_found' }` сохраняет штатный `ConnectionProviderException(..., ConnectionProviderExceptionCode.CONNECTION_NOT_FOUND)` для чужих, скрытых (`USER`), архивированных или отсутствующих подключений. |
| Изоляция от `@license Enterprise` | `pass` | Ни один из затронутых модулей не импортирует `@license Enterprise` файлы или общие barrels (`twenty-shared/utils` не добавляется в новые точки). |
