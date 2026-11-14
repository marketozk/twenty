# LOG189 - Транзакционный аудит регистраций приложений (`core."applicationRegistration"`) и серверных переменных регистраций (`core."applicationRegistrationVariable"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts` добавлены виды ресурсов:
  - `applicationRegistration` (`values: ['universalIdentifier', 'ownerWorkspaceId', 'createdByUserId', 'sourceType', 'tarballFileId', 'logoFileId', 'latestAvailableVersion', 'isListed', 'isVetted', 'isPreInstalled']`, `redacted: ['name', 'oAuthClientId', 'oAuthClientSecretHash', 'oAuthRedirectUris', 'oAuthScopes', 'sourcePackage', 'manifest', 'logo', 'description', 'author', 'category', 'websiteUrl', 'aboutDescription', 'pricingDescription', 'termsUrl', 'emailSupport', 'issueReportUrl', 'screenshots', 'galleryImages', 'deletedAt']`, действия `['create', 'update', 'delete']`);
  - `applicationRegistrationVariable` (`values: ['applicationRegistrationId', 'type', 'isSecret', 'isRequired', 'isDeprecated']`, `redacted: ['key', 'encryptedValue', 'description', 'options']`, действия `['create', 'update', 'delete']`).
- В `workspace-domain-audit.ts` добавлены проекции `projectApplicationRegistration` и `projectApplicationRegistrationVariable`, а также транзакционные хелперы `runAuditedApplicationRegistrationCreate`, `runAuditedApplicationRegistrationUpdate`, `runAuditedApplicationRegistrationDelete` и `runAuditedApplicationRegistrationVariableSync` с блокировками `core.workspace` (`FOR NO KEY UPDATE`) и целевых строк (`FOR UPDATE`) и перепроверкой состояния после `audit.flush()`.
- В `ApplicationRegistrationService`, `ApplicationRegistrationVariableService`, `ApplicationRegistrationResolver` и `ApplicationRegistrationClaimService` интегрирован транзакционный аудит создания, обновления, ротации OAuth-секрета, подтверждения и передачи владения регистрацией, синхронизации и обновления серверных переменных, а также каскадного удаления переменных при удалении регистрации.

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
