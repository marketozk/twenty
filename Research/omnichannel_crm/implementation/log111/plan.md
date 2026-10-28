# LOG111 — аудит изменения роли через metadata migration runner

Research: два production callers RoleService.updateRole — RoleResolver.updateOneRole
и UpdateRoleTool.execute. ValidateBuildAndRun строит role/update, action handler меняет
одну core.role строку; schema handler пуст. Runner сейчас после любого commit error
пытается rollback/compensation, что не соответствует strict unknown contract.

Решение: bounded automatic role-update owner. Trusted resolver/tool identity →
immutable async-local operation envelope вокруг updateRole; final migration action
проверяется по workspace/role/id/update. Тот же existing handler вызывается с QueryRunner
strict core owner. Actual row lock/before/after, safe role catalog, audit flush и
persisted postcondition входят в общий commit. Legacy metadata paths не расширяются.
RoleEntity/RoleService не импортируются в crm-audit (Enterprise dependency boundary).

Альтернативы: after-commit EventEmitter не атомарен; direct SQL из resolver обходит
builder/permissions/cache; полный generic metadata owner сразу включает schema,
foreign keys и deferred side effects. Поэтому берём автоматический role/update срез.
Существующие ROLES/self-lockout проверки сохраняются; собственный ROB766 access fence
не объявляется готовым. Role create/delete/assignment остаются последующими writers.

Проверки: реальные PG before/after против stale cache, exact actor/initiator и redaction,
concurrent updates, audit/SQL/handler failure, malformed scope/final action, deferred
refusal, input mutation while awaiting, audit trigger corruption, lost COMMIT ACK без
rollback/compensation/events, strict release/rollback. Проверить реальные runner/handler
стыки, type differential, guards/checksums, source hash, документацию и Linear.
