# LOG-041 — приём ручного текста в outbox

Внутренний writer реализован и проверен. ROB-764 остаётся In Progress: транспортная
отправка, live ingress, production grants и остальные acceptance пути ещё не закрыты.

Нормативные решения внесены в [sending-ui](../../plan/contracts/sending-ui.md#command-admission)
и [workflow-execution](../../plan/contracts/workflow-execution.md#human-command-event).
Переиспользуются существующие Command/Conversation/Root/Event/Dispatch таблицы,
strict native transaction owner и audit writer. Миграции не требуются.

Выбран INSERT с ON CONFLICT по actor/workspace/key до изменения счётчиков:
Conversation lock один не защищает один ключ между разными диалогами.
Raw unique violation с последующим SELECT непригоден: PostgreSQL transaction
уже aborted. Retry всей транзакции здесь не нужен. Свежая авторизация обязательна
до replay; UI CAS и open/human-or-assist проверяются для нового намерения.

Проверено: реальные member/userWorkspace, revoke/foreign/deleted; replay и hash
conflict; конкурентные одинаковые ключи между диалогами и разные ключи с одной
revision; snapshot до await; rollback каждого persistence/audit шага; unknown
COMMIT ACK; неизменность native Message и отсутствие transport/automation.
Проверки на изолированном PostgreSQL, затем scoped TypeScript differential,
dependency/migration guards и независимое ревью. GitHub Actions не используется.

Границы первого writer: только текст, disabled policy v0, injected current grants.
Нет HTTP/UI, отправляющего worker, живых сообщений или включения боевого binding.
Внутренний предел текста — 16000 UTF-16 units, максимум64000 UTF-8 bytes;
whitespace-only, NUL/управляющие символы и unpaired surrogates отклоняются.
Текст сохраняет пробелы и переносы. Это предел admission, а не обещание, что любой
канал примет такой размер: квалифицированный transport проверит свои ограничения.

## Найденное при проверке

Стандартная getWorkspaceSchemaName использует общий twenty-shared/utils barrel,
который добавляет Enterprise reachability. Dependency guard это обнаружил; новый
код использует уже проверенное вычисление base36 от validated UUID, без exemption.
Counter UPDATE возвращается через CTE SELECT: настоящий TypeORM QueryRunner
возвращает для прямого UPDATE RETURNING пару rows/count, не массив rows.
Отрицательный аудит использует EXISTS для retained membership: после повторного
вступления в workspace допустимы старые deleted и новая active membership строки.

Первый targeted run: 167 PASS / 9 suites, включая 36 PostgreSQL cases и 17 новых
unit cases. Первый scoped TypeScript: 161 roots, 146 baseline/current diagnostics,
0 новых/0 changed-code; прежний метод в изменённом aggregate идентичен baseline.
Далее добавлены граничные входные данные и concurrent membership revoke; окончательные
результаты: [1025 PASS /41 suites](tests.txt), включая37 PostgreSQL,43 contract
и17 audit/facade новых cases. Concurrent revoke подтверждён pg_blocking_pids.
[20 dependency tests](guard-tests.txt) и [6 checksum tests](checksum-tests.txt)
дают всего1051 различных PASS. [Guard](dependency-guard.json) без нарушений;
[6 миграций](migration-checksums.txt) прежние.

Финальный [TypeScript differential](typecheck-differential.json):162roots,
146 baseline/current,0 новых/0 changed-code. Старый проблемный метод совпадает
по AST и тексту; полный server typecheck/build этим не заявляется.
[Source hashes](source-snapshot.json) совпали с проверенными удалёнными исходниками;
все прежние методы aggregate неизменны. [Сводка проверки](verification.json).
Независимое scoped review admission, facade/failure audit и PG fixture без блокеров.
Замечание о COMMIT spy снято: strict runner уничтожает faulted connection,
replay получает новую. Новый полный Claude cross-review не заявляется.

Core identity fixture минимальна (user/userWorkspace поля, FK, partial unique),
WorkspaceMember создан штатной metadata/DDL и repository. Production ACL не
подменяется fixture grants. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger. Следующий LOG-042 — claim/FIFO/recovery исходящей очереди.
