# LOG099 — аудит создания core user-session

ROB765 In Progress. Реальный UserSessionService создаёт workspace session и audit
в одной core transaction; cookie и прежний sign-in event выдаются после COMMIT.
Core userId обозначается coreUser, не workspaceMember. Имперсонация сохраняет
реального инициатора из core.userWorkspace, включая cross-workspace сценарий.
Target membership сверяется с user/workspace, активные membership rows FOR SHARE.

Новый userSession descriptor содержит exact userId/userWorkspaceId и текущую
административную область. В diff разрешены authProvider/isImpersonating/origin;
даты редактируются. Токен, hash, IP, user-agent не передаются audit writer.
Input захватывается до await, DB credential/lifecycle проверяются до и после flush.
Workspace-agnostic sessions пока сохраняют прежний путь без выдуманного tenant.

## Строгий core owner

Используется настоящий QueryRunner: start/commit/rollback и transaction hooks
сохранены. Только COMMIT исполняется через его PG connection с проверкой command tag:
TypeORM 0.3.31 query() иначе теряет различие COMMIT/ROLLBACK. Для этого SQL не вызываются
обычные BeforeQuery/AfterQuery hooks; transaction hooks остаются. Повреждённая connection
удаляется pinned releasePostgresConnection(error), который также снимает регистрацию
QueryRunner. Контракт метода проверяется до записи. Ошибка подтверждённого postcommit
hook отличима через CoreAuditPostCommitError.commitConfirmed; unknown outcome не retry.
Объединённые work/rollback/release faults сохраняют все причины.

## Проверки и границы

Fixture использует реальные UserSessionService, UserSessionEntity, TypeORM и PG.
Заменены только несвязанные DI services и минимальные FK entity definitions; полноценные
HTTP/JWT/браузерные cookie suites не выполнялись. В тестовый source snapshot добавлены
28 неизменённых session файлов HEAD одинаково для baseline/current. Исправлен неверный
путь импорта migration и fixture metadata definitions до выполнения сценариев.

Review нашёл postflush trigger gap, потерю rollback cause при release fault и неоднозначный
postcommit error. Все исправлены и проверены отдельными fault tests. Logout/revoke/cache invalidation, workspace-agnostic audit,
appToken/token-pair atomicity, metadata/role и negative audit ещё не покрыты.
Миграции, demo и внешние сообщения не менялись; GitHub Actions не используется.

820 tests/30 suites PASS, 28 новых PG cases; 26 guards, 10 unchanged migration checksums. Types 338/340 roots, 189/189 baseline diagnostics, 0 новых/changed. 5 source hashes совпадают.

[Results](results.json) · [Regression](regression.log) · [Types](typecheck-differential.json) · [Review](review.md).
