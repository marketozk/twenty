# LOG-209 Test Research

## 1. Новый комплексный PG 17 тест (`crm-audit-fk-delete-effects-coverage.postgres-spec.ts`)
Выполняется на реальном PostgreSQL 17 (`coreSchema: 'fork'`, ограниченная роль `runtimeDatabaseUrl` + `owner`), проверяя:
1. **`DESTROY_ONE` / `DESTROY_MANY` с `ON DELETE CASCADE` и `ON DELETE SET NULL` по расширенным стандартным потомкам**:
   - `company` / `person` / `opportunity` со ссылками из `noteTarget` (`CASCADE`), `taskTarget` (`CASCADE`), `timelineActivity` (`CASCADE` от `company`/`person`, `SET NULL` от `opportunity`), `attachment` (`CASCADE`, вкл. привязанный `core.file` в `FILES`-поле `file`), `calendarEventTarget` (`CASCADE`), `calendarEventParticipant` (`SET NULL`), `messageThreadTarget` (`CASCADE` для обычного не-omni email thread), `messageParticipant` (`SET NULL` для обычного не-omni email message), `agentChatThreadTarget` (`CASCADE`), `messageListMember` (`CASCADE`);
   - все дочерние эффекты записываются в `crm_audit."crmAuditEntry"` под единым `operationId` родителя с точным `resourceKind: 'crmRecord'`, `objectMetadataId`, `deletedRecord` для `CASCADE` и изменённым полем для `SET NULL`, без утечки приватных текстов;
   - для `attachment` с `FILES` создаётся `crmFile:update` + долговечное намерение `delete_filesFieldFiles`, и последующий `reconcileFilesFieldHardDeleteIntentsWithAudit` физически удаляет `core.file` с `crmFile:delete`.
2. **Отказ на omni-owned `messageThreadTarget` и `messageParticipant` (вкл. через кастомный объект!)**:
   - удаление `person` с omni-owned `messageParticipant` -> отказ `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, 0 `success` записей, данные не изменены;
   - удаление кастомного объекта `_customCase` с morph-FK в omni-owned `messageThreadTarget` -> отказ `OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND` (новая защита в `prepareNativeCrmDeleteEffects` на заблокированных `before`-строках!), 0 `success` записей, данные не изменены.
3. **`MERGE_MANY` с живыми и soft-deleted потомками (`taskTarget`, `noteTarget`, `attachment`, `timelineActivity`, `messageParticipant`, `calendarEventParticipant`)**:
   - живые потомки мигрируются (`update`), дубликаты по unique index мягко удаляются (`update` + `CASCADE delete`), soft-deleted `attachment` с `FILES` каскадно удаляется с постановкой `delete_filesFieldFiles`;
   - попытка `MERGE_MANY` при наличии omni-owned `messageThreadTarget` / `messageParticipant` отказывает fail-closed (`OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND`) и откатывает всю транзакцию.
4. **`TrashCleanupService` для мягко удалённых `company`/`person` с `noteTarget`, `taskTarget`, `attachment` (с `FILES`), `timelineActivity` и не-omni `messageParticipant`**:
   - очистка корзины успешно удаляет записи и аудирует все FK-эффекты + `crmFile:update` + `delete_filesFieldFiles` под `system:trash_cleanup` (больше не застревают как poison pill!).
5. **Изоляция прямых мутаций и fail-closed границы**:
   - прямой вызов `UPDATE`/`CREATE`/`DELETE` на `noteTarget`/`taskTarget`/`attachment` внутри `withNativeCrmAuditTransaction` (вне `prepareNativeCrmDeleteEffects` и `runInNativeCrmMergeChildScope`) по-прежнему отклоняется (`Native audit coverage excludes this object or mutation`);
   - попытка изменить не-FK поле внутри `runInNativeCrmMergeChildScope` отклоняется fail-closed;
   - транзитивный FK на `attachment`/`noteTarget` по-прежнему отклоняется (`Native delete excludes transitive foreign-key effects`);
   - непокрытая таблица (не входящая в 10 стандартных) по-прежнему отклоняется (`Native audit delete excludes referenced records outside direct FK coverage`).

## 2. Целевой прогон PG 17 тестов
1. `test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts` (новый)
2. `test/fork-migration/crm-audit-native-delete.postgres-spec.ts`
3. `test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`
4. `test/fork-migration/crm-audit-public-merge.postgres-spec.ts`
5. `test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts`
6. `test/fork-migration/crm-audit-trash-and-file-remove.postgres-spec.ts`
7. `test/fork-migration/crm-audit-public-update.postgres-spec.ts`
8. `test/fork-migration/crm-audit-post-rollback-and-health.postgres-spec.ts`
9. `test/fork-migration/omni-parent-lifecycle.postgres-spec.ts`
10. `test/fork-migration/omni-parent-destroy.postgres-spec.ts`
