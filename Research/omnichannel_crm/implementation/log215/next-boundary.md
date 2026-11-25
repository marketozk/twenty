# Следующая граница после `LOG-215` (`ROB-766`)

`LOG-215` вводит только постоянную схему ядра собственных прав доступа (8 core-таблиц, форк-миграция #11, снапшот-верификатор и PG 17 тесты инвариантов). Runtime-запросы и живой `/opt/twenty-demo` в этом срезе не менялись.

## Следующий срез - `LOG-216`

1. **`engine/core-modules/crm-access/` - движок политики и primary-forced reads:**
   - `CrmAccessContext`, `CrmAccessPolicyService`, `OwnBaselineReadabilityPolicy` (без Enterprise RLS / `RecordShareModule`);
   - принудительная маршрутизация `useReplica: false` для protected context (`WorkspaceDataSourceService`, `SearchService`, `WorkspaceDataExportPartWriterService`) и чтение свежих native permissions (`rolesPermissions`, `userWorkspaceRoleMap`, `apiKeyRoleMap`, agent-role bindings) через primary executor внутри policy fence;
   - административные `PolicyMutationReceipt` writers (`Team`, `TeamMember`, `ResourceAssignment`, `ResourceGrant`, `StageRule`, `QueueGrant`) с `expectedRevision`, `policyEpoch++` и атомарным аудитом;
   - расширение `omni-workspace-deletion.ts` (`assertWorkspaceUnowned`) с учётом `core."crm*"` таблиц (находка Minor #2 из `LOG-215` ревью).
2. **Ранний micro-load `T19` по строке `omniWorkspacePolicyState`:**
   - до массового подключения ORM/UI проверить конкурентные долгие readers (`FOR SHARE`), stage/assignment/revoke (`FOR UPDATE`), таймауты и отсутствие deadlock по `G13`.
3. **После `LOG-216`:**
   - `LOG-217`: `crm-scope-predicate.ts`, `WorkspaceRepository.onBeforeExecute` / `WorkspaceSelectQueryBuilder`, nested relations / groupBy / search / export, `CrmMutationPolicyService`, `StageRule` validator, `CrmRecordRevision` CAS, `ConversationTarget` link/unlink.
   - `LOG-218`: `CrmEventAccessService` (SSE/webhook/logic-function/workflow/agent triggers), protected `FileByIdGuard`/`FileController`, `ConnectedAccount`/`MessageChannel`/`MessageFolder` metadata guards, read-only feature inventory на `/opt/twenty-demo` (§15.18) и удаление baseline Enterprise-зависимостей (`T20`).
