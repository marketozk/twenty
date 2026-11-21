# Следующий участок после LOG193

После закрытия `LOG193` (транзакционный аудит полного жизненного цикла приглашений рабочего пространства `workspaceInvitation` в `core."appToken"` в `WorkspaceInvitationService`, `WorkspaceInvitationResolver`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` и `SignInUpService.signInUpWithPersonalInvitation`) следующая открытая граница в рамках `ROB-765`:
- `LOG194`: транзакционный аудит полного жизненного цикла лимитов использования рабочего пространства (`usageLimit` в `core."usageLimit"` в `UsageLimitService`, `UsageLimitResolver` и `AdminPanelUsageLimitResolver`: `create`, `update`, `delete`).
