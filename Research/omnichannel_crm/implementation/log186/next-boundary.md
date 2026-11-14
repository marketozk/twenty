# Следующий участок после LOG186

После закрытия `LOG186` (обновления настроек, `allowedIframeOrigins` и `isCustomDomainEnabled` в `core.workspace` через `WorkspaceService`, `WorkspaceResolver`, `CustomDomainManagerService`, `CheckCustomDomainValidRecordsCronJob`, `DnsCloudflareService` и `workspace-default-role-audit.ts`) следующая открытая граница в рамках `ROB-765`:
- `LOG187`: транзакционный аудит жизненного цикла привязок логотипа рабочего пространства (`FileCorePictureService.completeWorkspaceLogoUpload`, `FileCorePictureService.uploadWorkspacePicture`, `FileCorePictureResolver`, `AuthResolver`) и переводов приложений (`applicationTranslation` в `core."applicationTranslation"` через `ApplicationTranslationSyncService`).
