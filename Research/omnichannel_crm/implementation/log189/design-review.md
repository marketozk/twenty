# LOG189 - Ревью дизайна (`applicationRegistration`, `applicationRegistrationVariable`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверка инвариантов

1. **Сокрытие секретов OAuth и значений серверных переменных**:
   - Для `applicationRegistration` поля `oAuthClientId`, `oAuthClientSecretHash`, `oAuthRedirectUris`, `oAuthScopes`, `name`, `sourcePackage`, `manifest`, `logo`, `description`, `author`, `category`, `websiteUrl`, `aboutDescription`, `pricingDescription`, `termsUrl`, `emailSupport`, `issueReportUrl`, `screenshots`, `galleryImages`, `deletedAt` хешируются в `redacted`.
   - Для `applicationRegistrationVariable` поля `key`, `encryptedValue`, `description`, `options` хешируются в `redacted`, а в `values` отражаются только `['applicationRegistrationId', 'type', 'isSecret', 'isRequired', 'isDeprecated']`.
2. **Атомарность и каскады**:
   - В `runAuditedApplicationRegistrationDelete` перед удалением строки `core."applicationRegistration"` блокируются все связанные строки `core."applicationRegistrationVariable"` (`ORDER BY id FOR UPDATE`), а после удаления в одной транзакции записываются `applicationRegistrationVariable:delete` и `applicationRegistration:delete` с перепроверкой отсутствия строк после `audit.flush()`.
   - В `ApplicationRegistrationService.updateFromManifest` обновление строки `core."applicationRegistration"` и синхронизация схем `core."applicationRegistrationVariable"` выполняются в одной транзакции с единым `operationId` и перепроверкой после `audit.flush()`.
3. **Обратная совместимость unit-тестов и границы `@license Enterprise`**:
   - При отсутствии `repository.manager?.connection` (в чистых unit-моках `application-registration-upsert-from-catalog.spec.ts` и `application-registration-asset-broadcast.spec.ts`) сохраняется штатный путь репозитория.
   - Ни один из затрагиваемых файлов не добавляет рёбер к модулям с маркером `@license Enterprise`.
