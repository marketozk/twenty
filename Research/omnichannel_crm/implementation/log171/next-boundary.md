# Следующая граница ROB765 после LOG171

После закрытия в `LOG171` транзакционного аудита смены и сброса пароля (`AuthService.updatePassword`, `AuthResolver.updatePasswordViaResetToken`, `ResetPasswordService`), пакетного отзыва `refreshToken` с причиной `PASSWORD_CHANGED` (включая токены в окне `REFRESH_TOKEN_REUSE_GRACE_PERIOD`), сериализации через `acquireUserAuthenticationLock` и передачи `initiator` при отзыве сессий под имперсонацией (`UserSessionResolver`, `UserSessionService`), открытыми в `ROB-765` остаются:

1. **Оставшиеся пути `coreUser` / `userWorkspace` и общие native/core writers**:
   - Оставшиеся мутации `core."user"` / `core."userWorkspace"`, физическое удаление файлов (`FilesFieldDeletionJob`), полные публичные сценарии удаления/объединения (`DESTROY` / `MERGE`), реальные `recordShares` и оставшиеся системные writers.
2. **Сессии и токены**:
   - Family revoke при компрометации цепочки ротации, stateless application JWT и общий in-flight mutation fence.
3. **Отказы/ошибки аудита и общая доставка фоновых задач**:
   - Post-rollback `denied`/`failed` аудит для общих native путей и общая надёжная доставка фоновых очередей.
4. **Сборка, выкат и приёмка**:
   - Изолированная сборка нового кандидата после `LOG088`, полные HTTP/JWT интеграционные проверки и выкат.
