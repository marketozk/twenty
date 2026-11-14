# LOG188 - Ревью дизайна (`application`, `applicationKeyValuePair`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверка инвариантов

1. **Сокрытие чувствительных данных**:
   - Для `application` в `values` отражаются только структурные UUID-привязки и булев флаг (`defaultRoleId`, `settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId`, `healthCheckLogicFunctionId`, `autoUpgrade`), тогда как массив выданных привилегий `grantedCapabilities` хешируется в `redacted`.
   - Для `applicationKeyValuePair` в `values` отражаются только `['applicationId', 'scope']`, а `['key', 'value']` хешируются в `redacted` без утечки ключей или JSON-значений.
2. **Обратная совместимость с существующими тестами `LOG164`, `LOG165`, `LOG167`, `LOG174`**:
   - В `runAuditedApplicationDefaultRoleUpdate` проецируются только ключи из `APPLICATION_AUDIT_ALL_KEYS`, явно переданные в обновляемом payload; технические поля (`version` и др.) не порождают записей аудита.
   - В `ApplicationCapabilityResolver.grantApplicationCapabilities` контекст запроса пробрасывается через `withCrmAuditRequest`, сохраняя 2-аргументный вызов `applicationService.update` для unit-теста `application-capability.resolver.spec.ts`.
   - В `runAuditedApplicationDelete` каскадные записи `applicationKeyValuePair:delete` формируются только при наличии строк `core."keyValuePair"` для удаляемого приложения.
3. **Границы лицензий (`@license Enterprise`)**:
   - Ни один из затрагиваемых файлов не добавляет рёбер к модулям с маркером `@license Enterprise`.
