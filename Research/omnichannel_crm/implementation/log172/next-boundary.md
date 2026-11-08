# Следующая граница ROB765 после LOG172

После закрытия в `LOG172` транзакционного аудита полного жизненного цикла (`create`, `update`, `delete`) и каскадных удалений каналов чата ИИ (`core."agentChatChannel"`) и их ролевых правил доступа (`core."agentChatChannelRole"` в `AgentChatChannelMetadataService`, `AgentChatChannelService`, `AgentChatChannelResolver`, `RoleService.deleteRole`, `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`, `runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService.executeRun`), открытыми в `ROB-765` остаются:

1. **Оставшиеся пути `coreUser` / `userWorkspace` и общие native/core writers**:
   - Оставшиеся мутации `core."user"` / `core."userWorkspace"`, физическое удаление файлов (`FilesFieldDeletionJob`), полные публичные сценарии удаления/объединения (`DESTROY` / `MERGE`), реальные `recordShares` и оставшиеся системные writers.
2. **Сессии и токены**:
   - Family revoke при компрометации цепочки ротации, stateless application JWT и общий in-flight mutation fence.
3. **Отказы/ошибки аудита и общая доставка фоновых задач**:
   - Post-rollback `denied`/`failed` аудит для общих native путей и общая надёжная доставка фоновых очередей.
4. **Сборка, выкат и приёмка**:
   - Изолированная сборка нового кандидата после `LOG088`, полные HTTP/JWT интеграционные проверки и выкат.
