# Следующий участок после LOG191

После закрытия `LOG191` (транзакционный аудит обновлений метаданных, пакета, SDK-слоя и манифеста установленных приложений в `core.application` и создания кастомной регистрации рабочего пространства в `ApplicationService.createWorkspaceCustomApplicationRegistration`) следующая открытая граница в рамках `ROB-765`:
- `LOG192`: транзакционный аудит удаления самой записи `core.application` (`application:delete`) в `runAuditedApplicationDelete` / `ApplicationService.delete` и проверка согласованности каскадного удаления связанных сущностей.
