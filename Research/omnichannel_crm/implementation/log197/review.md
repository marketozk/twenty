# Code Review LOG-197

Проведено независимое code/security-ревью всех 15 изменённых и добавленных файлов `LOG-197`. Все найденные блокеры и мажоры исправлены и подтверждены повторными прогонами на Schrodinger:

1. **Blocker - `before: null` / `after: null` в `coreView:create` и `coreView:delete`**: исправлено в `core-workflow-and-view-audit.ts`, `navigation-menu-item-audit.ts` и `application-metadata-audit.ts`.
2. **Blocker - `operationId: randomUUID()` в `defaultSystemActorId` fallback**: добавлено в `core-workflow-and-view-audit.ts`.
3. **Blocker - parser differential в `readViewOverrideProperty`**: добавлены 4 `*UniversalIdentifier` ключа в `VIEW_OVERRIDE_PROPERTY_KEYS` и переведено условие определения legacy override с `.every(...)` на `.some(...)` в полном соответствии с `isLegacyNonAuthoredOverride`, добавлен регрессионный PostgreSQL-тест.
4. **Blocker - ребро Enterprise в `complete-view-upsert.service.ts`**: убран импорт `findFlatEntityByIdInFlatEntityMaps` в пользу прямого lookup по `flatViewMaps.universalIdentifierById` / `byUniversalIdentifier`; `check_enterprise_dependencies.py --verify-baseline` подтвердил 0 нарушений.
5. **Major - AI view tools (`create-view.tool.ts`, `update-view.tool.ts`, `delete-view.tool.ts`, `upsert-complete-view.tool.ts`)**: добавлена условная передача `auditIdentity` (и `userWorkspaceId` в `delete-view.tool.ts`) при наличии аутентификационных полей в `ToolExecuteArgs.context`, с сохранением полной обратной совместимости с `view-tools.spec.ts`.
6. **Major - целостность всех строк `core.view` и защита от `deletedAt`/`applicationId`/`objectMetadataId` мутаций**: в `runAuditedCoreViewMutation` внедрён workspace-wide snapshot `core.view FOR UPDATE OF v`, в `application-metadata-audit.ts` и `navigation-menu-item-audit.ts` добавлены проверки `deletedAt`, `applicationId` и `objectMetadataId` на выживших строках.
7. **Major - строгий guard изолированной тестовой БД и append-only runtime роль в `crm-audit-core-view-lifecycle.postgres-spec.ts`**, а также синхронный захват `getAudit` в `ViewService.updateOne`.
