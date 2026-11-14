# LOG187 - Транзакционный аудит привязки логотипа рабочего пространства (`workspace.logoFileId`) и полного жизненного цикла переводов приложений (`applicationTranslation`, `core."applicationTranslation"`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - Добавлен вид ресурса `applicationTranslation` (`core."applicationTranslation"`): `values: ['applicationRegistrationId', 'locale']`, `redacted: ['messages', 'deletedAt']`, действия `['create', 'update', 'delete']`.
2. Расширен `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`:
   - Добавлены `projectApplicationTranslation` и `runAuditedApplicationTranslationSync` с блокировкой `core.workspace` (`FOR NO KEY UPDATE`) и строк `core."applicationTranslation"` (`ORDER BY id FOR UPDATE`), проверкой субъекта операции (`resolveWorkspaceDomainOperation`), записью `applicationTranslation:create`, `applicationTranslation:update`, `applicationTranslation:delete` и повторной сверкой снимков после `audit.flush()`.
3. Подключены точки входа и вызывающие сервисы:
   - `FileCorePictureResolver` (`uploadWorkspaceLogo`, `completeWorkspaceLogoUpload`) и `FileCorePictureService` (`uploadWorkspacePicture`, `completeWorkspaceLogoUpload`, `bindWorkspaceLogo`, `claimFileAsWorkspaceLogo` -> `runAuditedWorkspaceSettingsUpdate` для `logoFileId`).
   - `ApplicationSyncService.synchronizeFromManifest` и `ApplicationTranslationSyncService.syncFromManifest`.

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` (`8` тестов / `1` сьют PASS за `7.037 s`, включая новый сценарий `LOG187`).
- Полный регрессионный прогон: `3202` tests / `128` suites PASS за `714.34 s` ([`regression.log`](regression.log)).
- Guard unit tests: `33` tests PASS, `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `492/492` roots, `265/265` diagnostics, `0` новых/changed-code ([`typecheck-differential.json`](typecheck-differential.json)).
- Снимок исходников: `8` совпавших LF SHA-256 ([`source-snapshot.json`](source-snapshot.json)).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
