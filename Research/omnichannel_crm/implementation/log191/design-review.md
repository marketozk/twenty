# LOG191 - Ревью дизайна

## Вердикт
`pass` (блокеров не выявлено)

## Проверка по чеклисту
1. **Соответствие архитектуре**:
   - Расширяется существующий транзакционный владелец `runAuditedApplicationSettingsUpdate` в `application-default-role-audit.ts` и `runAuditedApplicationRegistrationCreate` в `workspace-domain-audit.ts`.
2. **Обратная совместимость существующих контрактов**:
   - Неаутентифицированные вызовы `ApplicationService.update` с `defaultRoleId` по-прежнему отклоняются fail-closed (`Role mutation requires authenticated audit identity`).
   - Попутное обновление `version` при неизменном `defaultRoleId` в `runAuditedApplicationDefaultRoleUpdate` сохраняет прежнее поведение.
3. **Сокрытие чувствительных метаданных**:
   - Поля `name`, `description`, `logo`, `sourcePath`, `packageJsonChecksum`, `yarnLockChecksum`, `availablePackages`, `billing`, `grantedCapabilities`, `sdkClientCoreChecksum`, `frontComponentSharedDependenciesChecksum` и `frontComponentSharedDependenciesBuiltPath` хешируются в `redacted`, а в `values` отражаются только скалярные идентификаторы, флаги и версия (`applicationRegistrationId`, `logoFileId`, `packageJsonFileId`, `yarnLockFileId`, `version`, `isSdkLayerStale`, `autoUpgrade`, `canBeUninstalled` и др.).
4. **Граница Enterprise**:
   - Новых зависимостей на модули `@license Enterprise` не вводится.
