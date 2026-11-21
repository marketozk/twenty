# LOG193 - Независимое ревью дизайна

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные риски и граничные случаи
1. **Cross-workspace удаление `appTokenIdToInvalidate` в `sendInvitations`**:
   - В исходном коде `this.appTokenRepository.delete(appTokenIdToInvalidate)` не ограничивал `workspaceId` и `type`. В `LOG193` `runAuditedWorkspaceInvitationDelete` блокирует и удаляет строку только при совпадении `id`, `workspaceId` и `type IN INVITATION_APP_TOKEN_TYPES`.
2. **TOCTOU-гонка при очистке просроченных приглашений и создании нового**:
   - В исходном коде проверка активного приглашения, удаление просроченных и вставка нового выполнялись раздельными запросами без транзакции. В `LOG193` все шаги выполняются внутри одной транзакции `runAuditedWorkspaceInvitationCreate` под `FOR NO KEY UPDATE` на `core.workspace` и `FOR UPDATE` на строках данного `email`.
3. **Утечка PII и секрета приглашения**:
   - `email` и `value` (случайный 32-байтный hex-токен приглашения) помещены в `CATALOG.workspaceInvitation.redacted`, а `values` содержит только `type` и `roleId`.
4. **Побочные эффекты отправки email**:
   - Отправка писем (`emailService.send`) остаётся после `COMMIT` транзакции; сбой аудита откатывает вставку токена до отправки писем.
5. **Повторное использование `operationId` и атрибуция в `UserWorkspaceService` / `SignInUpService`**:
   - `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` передаёт `actor`, `initiator`, `impersonatorUserWorkspaceId` и `correlationId: sharedCorrelationId` без переноса чужого `operationId`.
   - `SignInUpService.signInUpWithPersonalInvitation` передаёт `coreUser` (`updatedUser.id`) уже после создания `userWorkspace`, что проходит проверку членства в `resolveWorkspaceDomainOperation`.
6. **Изоляция Enterprise**:
   - `workspace-invitation` и `workspace-domain-audit` не импортируют Enterprise-модули; изменения не затрагивают `enterprise-dependency-baseline.json`.
