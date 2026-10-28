# LOG113 — аудит назначения роли сотруднику

ROB765 In Progress. Public resolver и AI tool передают обязательную trusted identity
в UserRoleService.assignRoleToWorkspaceMember. Input и identity фиксируются до await;
identity/workspace валидируются даже при отсутствии изменения. Прежний cached no-op
заменён actual repository read; подтверждённый no-op не порождает mutation audit.
Bootstrap/bulk assignRoleToManyUserWorkspace сохраняет явный прежний путь.

Bounded assignment scope привязывает native member, core membership/user и новую роль.
Final metadata plan допускает максимум DELETE старого roleTarget + один CREATE нового;
агенты/API-key targets, extra/deferred actions не проходят. Existing migration handlers
используют strict core transaction owner, а actor/initiator и audit writer общие с
role CREATE/UPDATE. roleTarget/create/delete имеет exact administrative descriptor;
diff содержит только roleId/userWorkspaceId, без имени сотрудника.

Workspace FOR NO KEY UPDATE сериализует публичные назначения без лишнего конфликта
с обычным FK KEY SHARE. В той же транзакции проверяются свежие core membership,
native member, назначаемость destination role, actual old target и последний admin.
Member/membership/application/role удерживаются SHARE locks. Старый target сравнивается
с final plan и cache mapping, а после handlers проверяется единственное новое назначение.
INSERT timestamps сравниваются с точностью PostgreSQL. После audit flush повторно
проверяются assignment, отсутствие удалённого ID, роли, membership/member и application.
SQL/handler/audit ошибки откатывают всё; unknown COMMIT не компенсируется и не повторяется,
cache invalidation выполняется в finally.

Review дополнительно обнаружил отсутствие composite tenant FK у applicationId. Поэтому
role CREATE из LOG112 и новое assignment проверяют фактические workspace/universalIdentifier/
deletedAt приложения в core.application под SHARE до writes и после audit flush.
Это не изменение лицензирования: существующие entitlement/assignment проверки остаются.

Fixture: настоящие UserRoleService, RoleTargetService, AI tool, create/delete handlers,
metadata runner, scalar mapper и PostgreSQL owner. Metadata builder orchestration,
registry dispatch/base entity selection, workspace ORM/member lookup и cache представлены
адаптерами; core/native scalar tables синтетические. Полный HTTP/GraphQL/LLM/builder
stack и полный workspace bootstrap этими тестами не проверены.

Открытая смежная граница: UserWorkspaceService.deleteUserWorkspace удаляет roleTarget
и userWorkspace двумя отдельными запросами и не берёт workspace fence. На уровне этого
сервиса concurrent assignment может оставить orphan target; основной публичный removal
сначала удаляет native member и имеет дополнительные transfers, поэтому эксплуатация
гонки через полный публичный путь отдельно не доказана. LOG113 сериализует только
покрытые публичные назначения, не все bulk/delete writers. Полная защита последнего
администратора от удаления membership, общий role DELETE и ROB766 fences ещё предстоят.
Это следующий участок реализации; ROB765 не закрывается. Демо/образ/сообщения/Actions
не менялись.

1152 tests/36 suites PASS (201.448s); 98 targeted/2 suites + 11 existing role-tool unit tests PASS. 44 новых cases: 40 PG + 4 descriptor. 26 guards PASS; 10 migration checksums неизменны. Types 352/354 roots, 218/218 прежних диагностик, 0 новых/changed-code. 11 local/remote source hashes совпадают.

Full-server typecheck не чистый. [Результаты](results.json).
