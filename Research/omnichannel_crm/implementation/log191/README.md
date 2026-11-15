# LOG191 - Транзакционный аудит обновлений метаданных, пакета, SDK-слоя и манифеста установленных приложений (`core.application`) и создания кастомной регистрации рабочего пространства

## Сводка изменений
- В `application-default-role-audit.ts`:
  - расширены `APPLICATION_AUDIT_UUID_KEYS` (`applicationRegistrationId`, `logoFileId`, `packageJsonFileId`, `yarnLockFileId`, `logicFunctionLayerId`, `primaryPublicDomainId`), `APPLICATION_AUDIT_BOOLEAN_KEYS` (`canBeUninstalled`, `isSdkLayerStale`) и добавлены `APPLICATION_AUDIT_NULLABLE_STRING_KEYS` (`version`, `description`, `logo`, `packageJsonChecksum`, `yarnLockChecksum`, `uninstallHookCompletedForRequestedAt`, `sdkClientCoreChecksum`, `frontComponentSharedDependenciesChecksum`, `frontComponentSharedDependenciesBuiltPath`), `APPLICATION_AUDIT_STRING_KEYS` (`name`, `sourceType`, `state`, `sourcePath`) и `APPLICATION_AUDIT_JSON_KEYS` (`availablePackages`, `billing`);
  - в `captureApplicationSettingsAudit` добавлена поддержка `defaultSystemActorId` для внутренних вызовов `ApplicationService.update` и `SdkClientArchiveService.markSdkLayerFresh`.
- В `ApplicationService`:
  - в `createWorkspaceCustomApplicationRegistration` подключён `runAuditedApplicationRegistrationCreate`;
  - в `update` подключён транзакционный аудит всех обновлений манифеста, пакета, логотипа и состояния SDK-слоя через `runAuditedApplicationSettingsUpdate`.
- В `SdkClientArchiveService.markSdkLayerFresh` подключён транзакционный аудит сброса `isSdkLayerStale: false`.

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
