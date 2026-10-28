# LOG111 — аудит изменения роли через существующую metadata migration

ROB765 In Progress. Два production callers RoleService.updateRole — GraphQL resolver
и UpdateRoleTool — автоматически передают серверную audit identity. Сервис копирует
input/actingRoleIds до await и открывает bounded immutable async scope. Нет browser
operationId/actor. Request projection сохраняет API key/user/application attribution;
verified impersonation membership разрешается в coreUser initiator, tool agent сохраняет
вызывающего пользователя как initiator. Нет изменения ROLES/self-lockout проверок.

Runner проверяет окончательный план: ровно role/update, ожидаемый record ID, допустимые
поля; реальный action handler работает через QueryRunner существующего strict core
owner. Before-image читается из core.role под FOR UPDATE, а не из optimistic cache;
проверяются workspace/universalIdentifier/isEditable, after и post-flush snapshot.
Role и audit имеют один commit. SQL/handler/audit/deferred refusal откатывают роль.
Unknown COMMIT не запускает rollback/compensation и не возвращает metadata events.
Cache invalidation выполняется и после ошибки: lost ACK может означать сохранённые права.
Ошибка кэша явно логируется, первоначальный transaction error не подменяется.

Новый закрытый ресурс role/update имеет exact metadataAccess=currentWorkspaceAdministration.
Boolean permissions в allowlist; label/description/icon redacted. Protected columns
не должны меняться. Выполненный UPDATE без изменения значений оставляет пустой diff;
builder no-op без SQL не создаёт success audit. Идентичный async scope нельзя повторно
потребить, продолжить после завершения или вложить в другой role update.

Fixture использует настоящие RoleService/UpdateRoleTool, metadata runner, role handler,
planner comparator, strict PG owner и restricted DB role. Role scalar EntitySchema,
transport/cache services, builder orchestration/validation и registry dispatch представлены
изолированными fixture adapters. Полный GraphQL/HTTP/LLM/metadata graph не объявлен
проверенным. Existing role create/delete/assignments и остальные metadata writers пока
используют прежний путь. Собственные ROB766 permission fences ещё предстоят; этот срез
не заявляет мгновенную глобальную инвалидацию всех кэшей прав.

Демо/образ и клиентские сообщения не менялись; Actions не используется.
1086 tests/35 suites PASS (201.025s); 101 targeted/3 suites PASS. 32 новых сценария: 28 PG + 4 descriptor. 26 guards PASS; 10 migration checksums неизменны. Types 349/351 roots, 219/218 диагностик baseline/current, 0 новых/changed-code. 8 local/remote source hashes совпадают.

Type roots расширены metadata/role graph, поэтому baseline содержит 219 диагностик
против прежних 189 в более узком графе. Один старый unknown-error.message в изменяемом
runner заменён безопасным Error/String branch; текущих диагностик 218. Полный server
typecheck не чистый.
