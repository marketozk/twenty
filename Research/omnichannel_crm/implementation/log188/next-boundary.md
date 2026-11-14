# Следующий участок после LOG188

После закрытия `LOG188` (транзакционный аудит полного жизненного цикла `core.application` `create`, `update`, `delete` и хранилища пар ключ-значение приложений `applicationKeyValuePair` в `core."keyValuePair"`) следующая открытая граница в рамках `ROB-765`:
- `LOG189`: транзакционный аудит жизненного цикла регистрации приложений, OAuth-секретов и серверных переменных регистрации (`applicationRegistration` и `applicationRegistrationVariable` в `core."applicationRegistration"` и `core."applicationRegistrationVariable"` через `ApplicationRegistrationService`, `ApplicationRegistrationResolver`, `ApplicationRegistrationVariableService` и `ApplicationRegistrationVariableResolver`).
