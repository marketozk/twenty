# LOG101 — автоматический аудит обычного public CREATE

ROB765 In Progress. CREATE_ONE/MANY covered local Company/Person/Opportunity/custom
objects получают native audit owner, когда это обычный insert без upsert/nested create
и существующая sharing logic не планирует recordShare writes. One делегирует точную
проверку Many. Новый Enterprise import или обход license gate не добавляется.

ROLE_ONLY не пишет shares. OPEN_BY_DEFAULT допускается только при no-op/default sharing.
PRIVATE/INHERITED даже с []/отсутствующим shareWith не входят в cohort. Их существующий
путь сохраняется. Полное public CREATE/shared access coverage не заявляется.

Processed CREATE arguments, включая post-hook changes, копируются до ожидания
workspace execution. Admission использует этот snapshot. Legacy inherited transaction
сохраняет legacy child path; strict inherited scope требует native identity/actor proof.
Нет fallback после ошибки audited execution и самостоятельного child commit.
Проверены прежний legacy nested root и explicit native nested graph commit/rollback.

Actual INSERT rows, FILES, native snapshots и scoped result fetch/nested reads
переиспользованы. Root post-query hooks выполняются после COMMIT; unknown ACK
не вызывает повтор INSERT и не публикует postcommit hook. Fixture не включает
полный HTTP/JWT и file URL signing.

Проверки: реальные One/Many для четырёх объектов; user/API/application actors;
audit failure rollback; legacy nested/upsert compatibility; sharing admission matrix;
pre-hook nested change и mutable hook output; real lost COMMIT ACK; postcommit
visibility; actual FILES attach + audit fault rollback.

Первый lost-ACK test занял единственный pool client до backfill position query и
завис ещё до COMMIT. После сверки image/command/source mount остановлен только его
тестовый контейнер c47f609f524a. Тест задаёт явную position, проверяя нужный COMMIT
без искусственного pool starvation. Повторный target прошёл; runtime не менялся
ради исправления fixture. Демо и внешние сообщения не затронуты, Actions не используется.

854 tests/30 suites PASS (169.5s), 19 новых PG cases, 58 targeted. 26 guard tests PASS; 10 migration checksums неизменны. Types 343/343 roots, 189/189 baseline diagnostics, 0 новых и 0 в изменённых строках. Существующая Brackets type diagnostic в неизменённом методе сохранена. 4 source hashes совпадают.
