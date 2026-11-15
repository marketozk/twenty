# Следующий участок после LOG190

После закрытия `LOG190` (транзакционный аудит жизненного цикла версий регистраций приложений `applicationRegistrationVersion` в `core."applicationRegistrationVersion"`, обновления ассетов регистраций в `ApplicationRegistrationAssetService` и создания экземпляров приложений `application` в `core.application`) следующая открытая граница в рамках `ROB-765`:
- `LOG191`: транзакционный аудит полного жизненного цикла остальных открытых `core`-метаданных приложений и рабочих пространств (включая аудит самой строки `core.application:delete` при `ApplicationService.delete` и синхронизацию версий/манифеста `ApplicationSyncService.syncApplication`).
