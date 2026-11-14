# Следующий участок после LOG187

После закрытия `LOG187` (транзакционный аудит привязки логотипа рабочего пространства в `FileCorePictureService` / `FileCorePictureResolver` и полного жизненного цикла переводов приложений `applicationTranslation` в `core."applicationTranslation"` через `ApplicationTranslationSyncService` и `ApplicationSyncService`) следующая открытая граница в рамках `ROB-765`:
- `LOG188`: транзакционный аудит жизненного цикла корпоративных приложений в рабочем пространстве (`core.application` `create`, `update`, `delete` в `ApplicationService`, `ApplicationDevelopmentService`, `ApplicationInstallService`, `ApplicationSyncService`, `ApplicationInstallResolver`, `ApplicationCapabilityResolver` и `SdkClientGenerationService`).
