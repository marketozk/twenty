# Следующая граница ROB-765 после LOG-173

После закрытия в `LOG-173` транзакционного аудита создания и смены локали членства (`userWorkspace` в `UserWorkspaceService.create`, `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`, `UserResolver.updateWorkspaceMemberSettings`, `GlobalWorkspaceMemberListener`, `SignInUpService`) и всех активных обновлений учётной записи (`coreUser` в `AdminPanelServerAdminService.updateServerAdminAccess`, `UserService.markEmailAsVerified`, `UserService.updateEmailFromVerificationToken`, `UserResolver.updateUserEmail`, `AuthResolver`, `SSOAuthController` и `password-update-audit.ts`) открытыми границами `ROB-765` остаются:

1. Оставшиеся административные настройки рабочего пространства и аутентификации в схеме `core` (включая настройки провайдеров входа/SSO, доменов одобренного доступа и публичных доменов, настроек безопасности `core.workspace`, вебхуков `core.webhook`).
2. Семейный отзыв refresh-токенов, in-flight fencing и конкурентный вход в `Session lifecycle`.
3. Публичный `DESTROY` / `MERGE`, реальные `recordShare` и физическое удаление файлов (`FilesFieldDeletionJob`) в общем контуре native/core аудита.
4. Полная HTTP/JWT приёмка и выкат собранного кандидата.
