# LOG113 — публичное назначение роли сотруднику

Исходники: RoleResolver.updateWorkspaceMemberRole и AssignRoleToWorkspaceMemberTool
вызывают UserRoleService.assignRoleToWorkspaceMember; bulk method используется также
bootstrap/onboarding. RoleTargetService.createMany строит delete old + create new,
existing handlers используют один metadata QueryRunner. roleTarget имеет unique
(workspaceId,userWorkspaceId), но userWorkspaceId не имеет FK. Cached ранний no-op
в public service не гарантирует соответствие БД. Existing last-admin check до transaction
допускает race двух публичных запросов.

План: trusted identity публичных callers фиксировать до await. Bounded assignment scope
сохраняет resolved member/user/membership и destination role; bulk/bootstrap без scope
сохраняется. Убрать cached no-op, оставить actual repository no-op. Перед migration SQL
strict owner блокирует workspace (сериализация публичных назначений), свежие membership/
native member, destination role и actual old target. Проверяет final create/delete plan,
cached-to-actual IDs, application, tenant, assignability/self/last-admin. Existing handlers
работают на этом QueryRunner; actual DELETE/CREATE audit и post-flush check до COMMIT.
Unknown не компенсировать; cache инвалидировать в finally как для role CREATE/UPDATE.

Новый roleTarget audit resource с точным administrative descriptor; значения только
roleId/userWorkspaceId, без имени сотрудника. Тот же audit writer, не Enterprise events.
Общие capture/initiator helpers переиспользуются; connection не хранится в async scope.

Проверки: real service/tool/handlers, initial/replace/no-op, stale cache, foreign/missing
membership, changed member mapping, self/nonassignable/last-admin и concurrent demotions,
malformed/multiple/deferred actions, SQL/audit failure, post-flush corruption, lost ACK,
explicit legacy bootstrap. Global synchronization с ещё не покрытыми bulk/admin deletion
writers не заявлять; полный ROB766 authorization fence остаётся отдельным этапом.

Review уточнил: early actual no-op также требует валидации auth/workspace. Application
сверять со свежей core.application (tenant/UID/deletedAt) под SHARE до writes и после
flush у обоих CREATE owners — существующий FK только application(id), без tenant.
Workspace fence выбран FOR NO KEY UPDATE: сериализация сохраняется, FK KEY SHARE
обычных insert не блокируется. 10 application scope regressions добавлены.
