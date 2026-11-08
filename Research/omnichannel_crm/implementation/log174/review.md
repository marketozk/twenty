# LOG-174 - Отчёт независимого ревью кода (`review.md`)

## 1. Вердикт

- Первичный проход: `Changes Requested` (`2 blocker`, `2 major`, `2 minor`).
- После исправления всех 6 замечаний (`C1`–`C6`): `PASS` (`0` открытых замечаний).

## 2. Проверенные файлы

- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`
- `packages/twenty-server/src/engine/core-modules/approved-access-domain/services/approved-access-domain.service.ts`
- `packages/twenty-server/src/engine/core-modules/approved-access-domain/approved-access-domain.resolver.ts`
- `packages/twenty-server/src/engine/core-modules/public-domain/public-domain.service.ts`
- `packages/twenty-server/src/engine/core-modules/public-domain/public-domain.resolver.ts`
- `packages/twenty-server/src/engine/core-modules/public-domain/crons/jobs/check-public-domains-valid-records.cron.job.ts`
- `packages/twenty-server/src/engine/core-modules/cloudflare/services/dns-cloudflare.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts`

## 3. Замечания и их закрытие

| # | Серьёзность | Находка | Решение |
|---|---|---|---|
| C1 | `blocker` | В `workspace-domain-audit.ts` и `application-authorization-and-variable-audit.ts` ветка `'actor' in identity && !('auth' in identity)` вызывала `membershipCleanupOperation`, которая требует `isUUID(correlationId)`, отвергает `workspaceMember`/`workflow` и отбрасывает `operationId` и `causationId`. | В обоих модулях построение операции переведено на `captureCrmAuditOperation` с поддержкой строковых `correlationId` / `causationId` (`requireIdentifier`), сохранением `operationId`, поддержкой `workspaceMember` / `workflow` и строгой проверкой `impersonatorUserWorkspaceId`. |
| C2 | `blocker` | В `crm-audit-workspace-domain.postgres-spec.ts` проверка обращалась к несуществующему полю `portalAudits[0].afterSnapshot`. | Заменено на проверку `portalAudits[0].redactedDiff.changedFields` (`toContain('domain')`) и отсутствия `'domain'` в `Object.keys(portalAudits[0].redactedDiff.values)`. |
| C3 | `major` | В `resolveWorkspaceDomainOperation` разрешение `impersonatorUserWorkspaceId` выполнялось после блокировки `core."user"`, `core."apiKey"` и `core.application`, из-за чего `core."user"` имперсонатора не проверялся, а `core."userWorkspace"` блокировалась повторно не по порядку. | Разрешение `actorUwId` и `impersonatorUwId` объединено на первом шаге с единой блокировкой `core."userWorkspace" ORDER BY uw.id ASC FOR KEY SHARE` до проверки `core."user"` (которая теперь включает имперсонатора), `core."apiKey"` и обоих возможных `core.application` (`actor` и `initiator`) в порядке возрастания `id`. |
| C4 | `major` | При раннем выходе или ошибке предпроверок (например, `!isWorkDomain`, `!publicDomainWithRecords`, ошибка `PUBLIC_DOMAIN_NOT_FOUND` в резолвере) `WorkspaceDomainAuditRequest` оставался непотреблённым до входа в `withExclusiveAuditScope`. | Добавлен `consumeWorkspaceDomainAuditRequest`, вызываемый на ранних проверках в `runAudited*` и в блоках `finally` всех мутирующих методов `ApprovedAccessDomainService`, `PublicDomainService` и `PublicDomainResolver.checkPublicDomainValidRecords`. |
| C5 | `minor` | В `runAuditedApprovedAccessDomainCreate` сверка `senderUserId` / `senderMemberId` пропускала не-UUID строки и не учитывала `request.expectedUserId` при вызове через OAuth-клиент (`withUser`). | Проверка усилена: `expectedSenderUserId` учитывает `request.expectedUserId`, а невалидный UUID в `senderUserId` или `senderMemberId` немедленно отвергается. |
| C6 | `minor` | Однобуквенные generic-параметры `<T>` в `workspace-domain-audit.ts` и `crm-audit-workspace-domain.postgres-spec.ts` нарушали правило `CLAUDE.md` (`descriptive generics`). | Все `<T>` переименованы в `<TResult>` и `<TEntity>`. |
