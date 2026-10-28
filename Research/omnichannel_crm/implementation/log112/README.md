# LOG112 — аудит создания ролей из интерфейса и ИИ

ROB765 In Progress. GraphQL createOneRole и CreateRoleTool используют обязательный
audited вход RoleService.createAuditedRole. Existing normalization, defaults, builder,
handler и DTO conversion переиспользованы. Internal member/guest/bootstrap/seeder
остаются на прежнем createRole: системной инициализации не приписывается user actor.

До первого await фиксируются input и серверная identity. Bounded scope содержит
normalized ID/universal ID, workspace/application и scalar snapshot. Runner принимает
только одну окончательную create-role action с точным enriched ID и application;
неожиданные дополнительные/deferred actions отклоняются. Existing create handler
выполняет INSERT на том же strict core executor, что и audit. Полная строка проверяется
после INSERT и после flush. CREATE timestamps сравниваются PostgreSQL без потери
microseconds; UPDATE сохраняет точное raw snapshot comparison из LOG111.

Role/create использует прежний закрытый administrative descriptor. Boolean permissions
allowlisted, label/description/icon redacted. Ошибка SQL/handler/audit откатывает создание.
При потерянном подтверждении COMMIT нет повтора или компенсации; cache invalidation
выполняется и в этом случае. Если commit состоялся, роль и audit остаются вместе.

Fixture использует реальные service, AI tool, create/update handlers, metadata runner,
scalar mapper и PostgreSQL owner. Builder orchestration/validation, registry dispatch,
base-handler entity selection, cache и transport представлены fixture adapters;
RoleEntity — scalar EntitySchema. Полный GraphQL/HTTP/LLM и весь metadata builder
этими проверками не покрыты. Bootstrap проверен как legacy service path, не как
полная инициализация рабочего пространства.

Read-only review выявил потерю timestamp precision и late identity capture; оба
исправления проверяются негативными PG tests и actual tool barrier case. Дополнительно
проверены defaults/trim/null, generated/explicit ID, collision, final ID/application/
workspace substitution, deferred actions, failure rollback, post-flush corruption
и настоящий COMMIT с искусственно потерянным ответом.

Открыты role DELETE/assignments, остальные metadata writers и ROB766 permission fences.
Демо, образ, клиентские сообщения не менялись. GitHub Actions не используется.

1108 tests/35 suites PASS (198.532s); 54 targeted PG/descriptor + 11 existing role-tool unit tests PASS. 22 новых PG cases. 26 guards PASS; 10 migration checksums неизменны. Types 352/352 roots, 218/218 прежних диагностик, 0 новых/changed-code. 8 local/remote source hashes совпадают.

Full-server typecheck не чистый. [Результаты](results.json), [review](review.md).
