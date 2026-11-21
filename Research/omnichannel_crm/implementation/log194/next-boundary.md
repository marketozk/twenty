# Следующий участок после LOG194

После закрытия `LOG194` (транзакционный аудит полного жизненного цикла лимитов использования рабочего пространства `usageLimit` в `core."usageLimit"` в `UsageLimitService`, `UsageLimitResolver` и `AdminPanelUsageLimitResolver`) следующая открытая граница в рамках `ROB-765`:
- `LOG195`: транзакционный аудит управления ключами подписи JWT (`signingKey` в `core."signingKey"` в `JwtKeyManagerService`, `AdminPanelSigningKeyService` и `AdminPanelResolver.revokeSigningKey` с редактированием `publicKey` и `privateKey` и сохранением `isCurrent` / `revokedAt`).
